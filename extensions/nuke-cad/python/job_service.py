#!/usr/bin/env python3
"""Generic job runner for nuke-cad solver hooks.

Implements a small declarative run-layer: a working directory, a command, an
optional environment overlay, artifact globs, and a timeout.  Progress and
diagnostics are emitted on stderr; one final JSON object is printed on stdout.

This is intentionally simple (local subprocess only).  Remote/SSH/container
submit is the planned future extension and will use the same request schema so
frontends do not need redesigning.
"""

from __future__ import annotations

import argparse
import json
import os
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

    stdout_buffer: list[str] = []
    stderr_buffer: list[str] = []

    try:
        process = subprocess.Popen(
            command,
            cwd=working_directory,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except Exception as exc:  # noqa: BLE001
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
        process.kill()
        stdout, stderr = process.communicate()
        stdout_buffer.append(stdout)
        stderr_buffer.append(stderr)
        if log_stream:
            log_stream.write(stdout)
            log_stream.write(stderr)
            log_stream.close()
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
        process.kill()
        stdout, stderr = process.communicate()
        stdout_buffer.append(stdout)
        stderr_buffer.append(stderr)
        if log_stream:
            log_stream.write(stdout)
            log_stream.write(stderr)
            log_stream.close()
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
        log_stream.write(stdout_text)
        log_stream.write(stderr_text)
        log_stream.close()

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
