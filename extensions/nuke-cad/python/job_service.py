#!/usr/bin/env python3
"""Generic job runner for nuke-cad solver hooks.

Implements a small declarative run-layer: a working directory, a command, an
optional environment overlay, artifact globs, and a timeout.  Progress and
diagnostics are emitted on stderr; one final JSON object is printed on stdout.

Request schema (JSON object):
    workingDirectory (str): directory to run in (created if missing).
    command (list[str]): command + arguments (required).
    env (dict[str, str] | None): extra environment variables.
    artifacts (list[str] | None): glob patterns for output files to report.
    timeout (float | None): seconds; None means no timeout.
    logFile (str | None): path to tee stdout/stderr into.

Result payload (JSON object):
    success (bool): True only when the process exits with code 0.
    exitCode (int | None): process return code (None when the job never
        started, e.g. missing command or spawn failure).
    artifacts (list[str]): absolute paths matching the artifact globs.
    logFile (str | None): the logFile request field, echoed back.
    stdout (str): captured standard output.
    stderr (str): captured standard error.
    error (str | None): human-readable failure reason; None on success.

This is intentionally simple (local subprocess only).  Remote/SSH/container
submit is the planned future extension and will use the same request schema so
frontends do not need redesigning.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))


def _print_progress(message: str) -> None:
    """Emit a progress line on stderr."""
    print(message, file=sys.stderr, flush=True)


def _write_log(log_stream: Any, stdout: str, stderr: str) -> None:
    """Write captured output to the log stream and close it."""
    log_stream.write(stdout)
    log_stream.write(stderr)
    log_stream.close()


def _terminate_process(process: subprocess.Popen) -> None:
    """Kill a timed-out/erring job, including its whole process group on POSIX.

    The child is spawned with ``start_new_session=True``, so on POSIX it leads
    its own process group and ``os.killpg`` also kills any grandchildren it
    spawned (solver wrappers routinely fork workers).  On Windows there is no
    process-group kill; fall back to killing the direct child only.
    """
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass
    process.kill()


def _collect_artifacts(root: Path, patterns: list[str]) -> list[str]:
    """Return absolute paths of files under ``root`` matching any glob pattern."""
    found: list[str] = []
    for pattern in patterns:
        if not pattern:
            continue
        if os.path.isabs(pattern):
            candidates = [Path(pattern)]
        else:
            candidates = list(root.rglob(pattern))
        for candidate in candidates:
            if candidate.is_file():
                found.append(str(candidate.resolve()))
    # Deduplicate while preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for p in found:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


def run_job(request: dict[str, Any]) -> dict[str, Any]:
    """Run a declarative job and return a structured result.

    Request fields:
        workingDirectory (str): directory to run in (created if missing).
        command (list[str]): command + arguments.
        env (dict[str, str] | None): extra environment variables.
        artifacts (list[str] | None): glob patterns for output files to report.
        timeout (float | None): seconds; None means no timeout.
        logFile (str | None): path to tee stderr/stdout into.

    Returns:
        dict with ``success``, ``exitCode``, ``artifacts``, ``logFile``,
        ``stdout``, ``stderr``, ``error``.
    """
    working_directory = Path(request.get("workingDirectory", os.getcwd())).resolve()
    working_directory.mkdir(parents=True, exist_ok=True)

    command = request.get("command")
    if not command:
        return {
            "success": False,
            "exitCode": None,
            "artifacts": [],
            "logFile": request.get("logFile"),
            "stdout": "",
            "stderr": "",
            "error": "Job request must include a 'command' list.",
        }
    if not isinstance(command, list):
        return {
            "success": False,
            "exitCode": None,
            "artifacts": [],
            "logFile": request.get("logFile"),
            "stdout": "",
            "stderr": "",
            "error": "Job 'command' must be a list of strings.",
        }

    env_overlay = request.get("env") or {}
    env = {**os.environ, **env_overlay}

    artifacts = request.get("artifacts") or []
    timeout = request.get("timeout")
    if timeout is not None:
        timeout = float(timeout)

    log_file_path = request.get("logFile")
    log_stream = None
    if log_file_path:
        log_path = Path(log_file_path).resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_stream = open(log_path, "w", encoding="utf-8")

    _print_progress(f"Running job in {working_directory}: {' '.join(command)}")

    try:
        process = subprocess.Popen(
            command,
            cwd=working_directory,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            # New session so a timeout can kill the whole process group.
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        if log_stream:
            log_stream.close()
        return {
            "success": False,
            "exitCode": None,
            "artifacts": [],
            "logFile": log_file_path,
            "stdout": "",
            "stderr": "",
            "error": f"Failed to start job: {exc}",
        }

    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_process(process)
        stdout, stderr = process.communicate()
        if log_stream:
            _write_log(log_stream, stdout, stderr)
        return {
            "success": False,
            "exitCode": process.returncode,
            "artifacts": _collect_artifacts(working_directory, artifacts),
            "logFile": log_file_path,
            "stdout": stdout,
            "stderr": stderr,
            "error": f"Job timed out after {timeout} seconds",
        }
    except Exception as exc:  # noqa: BLE001
        _terminate_process(process)
        stdout, stderr = process.communicate()
        if log_stream:
            _write_log(log_stream, stdout, stderr)
        return {
            "success": False,
            "exitCode": process.returncode,
            "artifacts": _collect_artifacts(working_directory, artifacts),
            "logFile": log_file_path,
            "stdout": stdout,
            "stderr": stderr,
            "error": f"Job execution error: {exc}",
        }

    stdout_text = stdout or ""
    stderr_text = stderr or ""
    if log_stream:
        _write_log(log_stream, stdout_text, stderr_text)

    found_artifacts = _collect_artifacts(working_directory, artifacts)
    _print_progress(
        f"Job finished with exit code {process.returncode}; "
        f"collected {len(found_artifacts)} artifact(s)"
    )

    return {
        "success": process.returncode == 0,
        "exitCode": process.returncode,
        "artifacts": found_artifacts,
        "logFile": log_file_path,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "error": None
        if process.returncode == 0
        else f"Process exited with code {process.returncode}",
    }


def main() -> int:
    """CLI entry point: read a JSON request file and run the job."""
    parser = argparse.ArgumentParser(description="Run a declarative nuke-cad job.")
    parser.add_argument("--request", required=True, help="Path to JSON request file.")
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    try:
        with open(request_path, encoding="utf-8") as f:
            request = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "error": f"Invalid request file: {exc}"}))
        return 1

    try:
        result = run_job(request)
    except Exception as exc:  # noqa: BLE001
        _print_progress(traceback.format_exc())
        result = {
            "success": False,
            "exitCode": None,
            "artifacts": [],
            "logFile": request.get("logFile"),
            "stdout": "",
            "stderr": "",
            "error": str(exc),
        }

    print(json.dumps(result))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
