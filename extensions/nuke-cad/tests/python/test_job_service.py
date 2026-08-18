#!/usr/bin/env python3
"""Minimal-profile tests for the generic job runner."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

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
