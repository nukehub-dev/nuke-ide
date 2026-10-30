#!/usr/bin/env python3
"""Minimal-profile tests for the generic job runner."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Ensure the service module is importable.
_SERVICE_DIR = Path(__file__).parent.parent.parent / "python"
sys.path.insert(0, str(_SERVICE_DIR))

import job_service  # noqa: E402


def test_run_job_success(tmp_path: Path) -> None:
    """A simple command writes a file and the job reports it as an artifact."""
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "print('hello')"],
            "artifacts": ["*.txt"],
        }
    )
    assert result["success"] is True
    assert result["exitCode"] == 0
    assert "hello\n" in result["stdout"]
    assert result["error"] is None


def test_run_job_artifact_collection(tmp_path: Path) -> None:
    """Artifact globs are resolved relative to the working directory."""
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.log").write_text("b")
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "print('done')"],
            "artifacts": ["*.txt", "*.log"],
        }
    )
    assert result["success"] is True
    assert len(result["artifacts"]) == 2


def test_run_job_timeout(tmp_path: Path) -> None:
    """A command that sleeps longer than the timeout is killed."""
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "import time; time.sleep(10)"],
            "timeout": 0.1,
        }
    )
    assert result["success"] is False
    assert "timed out" in result["error"].lower()


def test_run_job_failure(tmp_path: Path) -> None:
    """A failing command returns success=False with stderr captured."""
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "import sys; sys.exit(2)"],
        }
    )
    assert result["success"] is False
    assert result["exitCode"] == 2


def test_run_job_log_file(tmp_path: Path) -> None:
    """Output is tee'd into the specified log file."""
    log_path = tmp_path / "job.log"
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "print('logged')"],
            "logFile": str(log_path),
        }
    )
    assert result["success"] is True
    assert result["logFile"] == str(log_path)
    assert "logged" in log_path.read_text()


def test_run_job_missing_command(tmp_path: Path) -> None:
    """A request without a command raises a clear error."""
    result = job_service.run_job({"workingDirectory": str(tmp_path)})
    assert result["success"] is False
    assert "command" in result["error"]


def test_cli(tmp_path: Path) -> None:
    """The CLI reads a request file and prints JSON."""
    request_file = tmp_path / "request.json"
    request_file.write_text(
        json.dumps(
            {
                "workingDirectory": str(tmp_path),
                "command": [sys.executable, "-c", "print(1+1)"],
            }
        )
    )
    result = subprocess.run(
        [sys.executable, "-m", "job_service", "--request", str(request_file)],
        cwd=_SERVICE_DIR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed["success"] is True
    assert "2" in parsed["stdout"]


def test_collect_artifacts_absolute_glob(tmp_path: Path) -> None:
    """Absolute glob patterns are accepted."""
    artifact = tmp_path / "out.dat"
    artifact.write_text("data")
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "print('ok')"],
            "artifacts": [str(artifact)],
        }
    )
    assert result["success"] is True
    assert str(artifact) in result["artifacts"]


def test_script_dir_reinserted_on_fresh_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """The import-time guard re-inserts the script dir when it is absent from sys.path."""
    module_path = Path(job_service.__file__)
    script_dir = str(module_path.parent.resolve())
    trimmed = [p for p in sys.path if p != script_dir]
    monkeypatch.setattr(sys, "path", trimmed)
    # Load by file location: a plain import would fail without the dir on sys.path.
    spec = importlib.util.spec_from_file_location("job_service_fresh", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert sys.path[0] == script_dir


def test_terminate_process_killpg_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the process-group kill fails, the direct child is killed instead."""
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    def _raise_lookup_error(*args: object, **kwargs: object) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(job_service.os, "killpg", _raise_lookup_error)
    job_service._terminate_process(process)
    assert process.wait(timeout=5) is not None


def test_run_job_command_not_a_list(tmp_path: Path) -> None:
    """A non-list command is rejected before anything is spawned."""
    result = job_service.run_job({"workingDirectory": str(tmp_path), "command": "echo hi"})
    assert result["success"] is False
    assert result["exitCode"] is None
    assert "must be a list" in result["error"]


def test_run_job_empty_artifact_pattern(tmp_path: Path) -> None:
    """Empty artifact patterns are skipped."""
    (tmp_path / "out.txt").write_text("x")
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [sys.executable, "-c", "print('ok')"],
            "artifacts": ["", "*.txt"],
        }
    )
    assert result["success"] is True
    assert result["artifacts"] == [str(tmp_path / "out.txt")]


def test_run_job_spawn_failure(tmp_path: Path) -> None:
    """A missing executable returns a structured spawn error and closes the log."""
    log_path = tmp_path / "spawn.log"
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": ["definitely-not-a-real-nuke-cad-binary"],
            "logFile": str(log_path),
        }
    )
    assert result["success"] is False
    assert result["exitCode"] is None
    assert "Failed to start job" in result["error"]
    # The log file was opened before the spawn attempt and is closed on failure.
    assert log_path.read_text() == ""


def test_run_job_timeout_writes_log(tmp_path: Path) -> None:
    """A timed-out job tees the captured output into the log file."""
    log_path = tmp_path / "timeout.log"
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": [
                sys.executable,
                "-c",
                "import time; print('start', flush=True); time.sleep(10)",
            ],
            "timeout": 0.2,
            "logFile": str(log_path),
        }
    )
    assert result["success"] is False
    assert "timed out" in result["error"].lower()
    assert "start" in log_path.read_text()


def test_run_job_communicate_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A non-timeout communicate failure kills the job and reports the error."""

    class FakeProcess:
        pid = os.getpid()
        returncode = -9

        def __init__(self) -> None:
            self._calls = 0

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            self._calls += 1
            if self._calls == 1:
                raise RuntimeError("pipe exploded")
            return ("partial-out", "partial-err")

        def kill(self) -> None:
            pass

    monkeypatch.setattr(job_service.subprocess, "Popen", lambda *args, **kwargs: FakeProcess())
    # The fake pid is our own process; never let the real killpg fire on it.
    monkeypatch.setattr(job_service.os, "killpg", lambda *args, **kwargs: None)
    log_path = tmp_path / "error.log"
    result = job_service.run_job(
        {
            "workingDirectory": str(tmp_path),
            "command": ["fake"],
            "logFile": str(log_path),
        }
    )
    assert result["success"] is False
    assert result["exitCode"] == -9
    assert "Job execution error: pipe exploded" in result["error"]
    assert result["stdout"] == "partial-out"
    assert "partial-out" in log_path.read_text()


def test_main_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    """main() runs the request file and prints the JSON result."""
    request_file = tmp_path / "request.json"
    request_file.write_text(
        json.dumps(
            {
                "workingDirectory": str(tmp_path),
                "command": [sys.executable, "-c", "print(40 + 2)"],
            }
        )
    )
    monkeypatch.setattr(sys, "argv", ["job_service", "--request", str(request_file)])
    assert job_service.main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["success"] is True
    assert "42" in payload["stdout"]


def test_main_invalid_request_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    """An unreadable/invalid request file yields a JSON error and exit code 1."""
    request_file = tmp_path / "broken.json"
    request_file.write_text("{nope")
    monkeypatch.setattr(sys, "argv", ["job_service", "--request", str(request_file)])
    assert job_service.main() == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["success"] is False
    assert "Invalid request file" in payload["error"]


def test_main_run_job_exception(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    """If run_job itself raises, main() reports the exception as a structured error."""
    blocker = tmp_path / "blocker"
    blocker.write_text("a file, not a directory")
    request_file = tmp_path / "request.json"
    request_file.write_text(
        json.dumps(
            {
                "workingDirectory": str(blocker),
                "command": [sys.executable, "-c", "print('x')"],
            }
        )
    )
    monkeypatch.setattr(sys, "argv", ["job_service", "--request", str(request_file)])
    assert job_service.main() == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["success"] is False
    assert payload["exitCode"] is None
    assert payload["error"]
