#!/usr/bin/env python3
"""Tests for the bubblewrap script sandbox service."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest
import sandbox_service as sandbox


@pytest.fixture(autouse=True)
def _reset_probe_cache() -> None:
    sandbox._PROBE_CACHE = None
    yield
    sandbox._PROBE_CACHE = None


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "model.py").write_text("model = None\n", encoding="utf-8")
    return root


def _request(workspace: Path, **overrides: object) -> dict[str, object]:
    request: dict[str, object] = {
        "scriptPath": str(workspace / "model.py"),
        "workspaceRoot": str(workspace),
        "outputDirectory": str(workspace / ".nuke-ide" / "ai" / "cad-scripts" / "job-1"),
    }
    request.update(overrides)
    return request


def _validated(workspace: Path, **overrides: object) -> sandbox.ValidatedRequest:
    return sandbox.validate_request(_request(workspace, **overrides))


def _probe(disable_userns: bool = True) -> sandbox.ProbeResult:
    return sandbox.ProbeResult(
        available=True,
        bwrap_path="/usr/bin/bwrap",
        version="bubblewrap 0.13.1",
        userns=True,
        disable_userns=disable_userns,
        reason=None,
        prlimit_path="/usr/bin/prlimit",
    )


def _runtime() -> sandbox.PythonRuntime:
    return sandbox.PythonRuntime(
        executable="/opt/example/bin/python3",
        binds=(("/opt/example", "/opt/example"),),
        path_entries=("/opt/example/bin", "/usr/bin", "/bin"),
    )


def _fake_bwrap(tmp_path: Path, *, help_text: str, namespace_exit: int = 0) -> Path:
    script = tmp_path / "fake-bwrap"
    script.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then\n'
        '    echo "bubblewrap 0.13.1"\n'
        "    exit 0\n"
        "fi\n"
        'if [ "$1" = "--help" ]; then\n'
        f'    echo "{help_text}"\n'
        "    exit 0\n"
        "fi\n"
        f"exit {namespace_exit}\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


FULL_HELP = " ".join(sandbox.REQUIRED_BWRAP_FLAGS) + " --disable-userns --assert-userns-disabled"


def test_probe_reports_bubblewrap_and_user_namespaces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = _fake_bwrap(tmp_path, help_text=FULL_HELP)
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: str(fake) if name == "bwrap" else "/usr/bin/prlimit"
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is True
    assert result.bwrap_path == str(fake)
    assert result.version == "bubblewrap 0.13.1"
    assert result.userns is True
    assert result.disable_userns is True
    assert result.reason is None
    assert result.to_status()["engine"] == "bubblewrap"
    assert result.to_status()["disableUserns"] is True


def test_probe_works_without_disable_userns_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = _fake_bwrap(tmp_path, help_text=" ".join(sandbox.REQUIRED_BWRAP_FLAGS))
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: str(fake) if name == "bwrap" else "/usr/bin/prlimit"
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is True
    assert result.userns is True
    assert result.disable_userns is False


def test_probe_rejects_bubblewrap_without_required_options(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = _fake_bwrap(tmp_path, help_text="--unshare-user")
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: str(fake) if name == "bwrap" else "/usr/bin/prlimit"
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is False
    assert "required options" in (result.reason or "")


def test_probe_reports_unavailable_without_user_namespaces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = _fake_bwrap(tmp_path, help_text=FULL_HELP, namespace_exit=1)
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: str(fake) if name == "bwrap" else "/usr/bin/prlimit"
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is False
    assert result.userns is False
    assert result.reason is not None
    assert "user namespaces" in result.reason.lower()


def test_probe_reports_missing_bwrap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: "/usr/bin/prlimit" if name == "prlimit" else None
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is False
    assert "not installed" in (result.reason or "")


def test_probe_reports_missing_prlimit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sandbox.shutil, "which", lambda name: "/usr/bin/bwrap" if name == "bwrap" else None
    )

    result = sandbox.probe_bwrap(force=True)

    assert result.available is False
    assert "prlimit" in (result.reason or "")


def test_probe_rejects_non_linux(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")

    result = sandbox.probe_bwrap(force=True)

    assert result.available is False
    assert "Linux" in (result.reason or "")


def test_validation_creates_the_output_directory(workspace: Path) -> None:
    validated = _validated(workspace)

    assert validated.output_directory.is_dir()
    assert (
        validated.output_directory
        == (workspace / ".nuke-ide" / "ai" / "cad-scripts" / "job-1").resolve()
    )
    assert validated.options.timeout_seconds == 120
    assert validated.options.memory_limit_mb == 4096
    assert validated.options.process_limit == 128
    assert validated.options.file_size_limit_mb == 512


def test_validation_accepts_a_staging_script_name(workspace: Path) -> None:
    staging = workspace / ".nuke-ide" / "ai" / "cad-scripts" / "proposal-1.py"
    staging.parent.mkdir(parents=True)
    staging.write_text("model = None\n", encoding="utf-8")

    validated = _validated(workspace, scriptPath=str(staging))

    assert validated.script_path == staging.resolve()


@pytest.mark.parametrize("field", ["scriptPath", "workspaceRoot", "outputDirectory"])
def test_validation_requires_absolute_paths(workspace: Path, field: str) -> None:
    with pytest.raises(sandbox.SandboxValidationError, match="absolute"):
        _validated(workspace, **{field: "relative/path"})


def test_validation_rejects_non_python_scripts(workspace: Path) -> None:
    text = workspace / "model.txt"
    text.write_text("model = None\n", encoding="utf-8")

    with pytest.raises(sandbox.SandboxValidationError, match=r"\.py"):
        _validated(workspace, scriptPath=str(text))


def test_validation_rejects_symbolic_link_scripts(workspace: Path) -> None:
    target = workspace / "target.py"
    target.write_text("model = None\n", encoding="utf-8")
    link = workspace / "model-link.py"
    link.symlink_to(target)

    with pytest.raises(sandbox.SandboxValidationError, match="symbolic link"):
        _validated(workspace, scriptPath=str(link))


def test_validation_rejects_scripts_outside_the_workspace(workspace: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.py"
    outside.write_text("model = None\n", encoding="utf-8")

    with pytest.raises(sandbox.SandboxValidationError, match="inside workspaceRoot"):
        _validated(workspace, scriptPath=str(outside))


def test_validation_rejects_non_regular_scripts(workspace: Path) -> None:
    directory = workspace / "model.py"
    directory.unlink()
    directory.mkdir()

    with pytest.raises(sandbox.SandboxValidationError, match="regular file"):
        _validated(workspace, scriptPath=str(directory))


def test_validation_rejects_output_outside_the_staging_root(workspace: Path) -> None:
    with pytest.raises(sandbox.SandboxValidationError, match="cad-scripts"):
        _validated(workspace, outputDirectory=str(workspace / "output"))


def test_validation_rejects_symbolic_link_output_directories(workspace: Path) -> None:
    real = workspace / ".nuke-ide" / "ai" / "cad-scripts-real"
    real.mkdir(parents=True)
    link = workspace / ".nuke-ide" / "ai" / "cad-scripts"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(sandbox.SandboxValidationError, match="symbolic link"):
        _validated(workspace)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("timeoutSeconds", 0),
        ("timeoutSeconds", 301),
        ("memoryLimitMb", 255),
        ("memoryLimitMb", 8193),
        ("processLimit", 15),
        ("processLimit", 513),
        ("fileSizeLimitMb", 15),
        ("fileSizeLimitMb", 1025),
        ("timeoutSeconds", "120"),
        ("processLimit", 1.5),
        ("processLimit", True),
        ("tolerance", 0),
        ("tolerance", -1),
    ],
)
def test_validation_rejects_out_of_range_limits(workspace: Path, field: str, value: object) -> None:
    with pytest.raises(sandbox.SandboxValidationError):
        _validated(workspace, **{field: value})


def test_validation_accepts_boundary_limits(workspace: Path) -> None:
    validated = _validated(
        workspace,
        timeoutSeconds=300,
        memoryLimitMb=8192,
        processLimit=512,
        fileSizeLimitMb=1024,
        tolerance=0.01,
    )

    assert validated.options.to_limits() == {
        "timeoutSeconds": 300,
        "memoryLimitMb": 8192,
        "processLimit": 512,
        "fileSizeLimitMb": 1024,
        "nofile": 256,
        "core": 0,
    }


def test_bwrap_argv_applies_the_security_policy(workspace: Path) -> None:
    validated = _validated(workspace)
    argv = sandbox.build_sandbox_argv(validated, _probe(), _runtime())

    assert argv[0] == "/usr/bin/bwrap"
    for flag in (
        "--unshare-user",
        "--disable-userns",
        "--assert-userns-disabled",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--remount-ro",
    ):
        assert flag in argv
    assert "--share-net" not in argv
    assert "--unshare-net" in argv or "--unshare-all" in argv

    bind_pairs = [
        (argv[index + 1], argv[index + 2])
        for index, value in enumerate(argv)
        if value == "--ro-bind"
    ]
    assert (str(validated.script_path), "/source/model.py") in bind_pairs
    assert ("/usr", "/usr") in bind_pairs
    assert ("/opt/example", "/opt/example") in bind_pairs

    rw_binds = [
        (argv[index + 1], argv[index + 2]) for index, value in enumerate(argv) if value == "--bind"
    ]
    assert (str(validated.output_directory), "/out") == rw_binds[0]
    assert str(validated.workspace_root) not in argv


def test_bwrap_argv_does_not_forward_host_environment(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    monkeypatch.setenv("NUKE_SANDBOX_LEAK", "do-not-forward")
    validated = _validated(workspace)
    argv = sandbox.build_sandbox_argv(validated, _probe(), _runtime())

    assert "NUKE_SANDBOX_LEAK" not in argv
    assert "do-not-forward" not in argv
    clobber = argv.index("--clearenv")
    assert clobber < argv.index("--setenv")

    setenv_pairs = {
        argv[index + 1]: argv[index + 2]
        for index, value in enumerate(argv)
        if value == "--setenv" and index + 2 < len(argv)
    }
    assert setenv_pairs["HOME"] == "/tmp"
    assert setenv_pairs["TMPDIR"] == "/tmp"
    assert setenv_pairs["PYTHONDONTWRITEBYTECODE"] == "1"
    assert setenv_pairs["PYTHONNOUSERSITE"] == "1"
    assert setenv_pairs["PATH"] == "/opt/example/bin:/usr/bin:/bin"


def test_bwrap_argv_sizes_tmpfs_and_rlimits(workspace: Path) -> None:
    validated = _validated(
        workspace,
        timeoutSeconds=90,
        memoryLimitMb=1024,
        processLimit=32,
        fileSizeLimitMb=64,
    )
    argv = sandbox.build_sandbox_argv(validated, _probe(), _runtime())

    for index, value in enumerate(argv):
        if value == "--tmpfs":
            assert argv[index - 2] == "--size"
            assert int(argv[index - 1]) > 0
    assert "/tmp" in argv
    assert "/dev/shm" in argv
    assert "/source" in argv

    assert "--cpu=100" in argv
    assert f"--as={1024 * 1024 * 1024}" in argv
    assert "--nproc=32" in argv
    assert f"--fsize={64 * 1024 * 1024}" in argv
    assert "--nofile=256" in argv
    assert "--core=0" in argv
    assert str(validated.workspace_root) not in argv


def test_bwrap_argv_runs_the_geometry_service_without_exports(workspace: Path) -> None:
    validated = _validated(workspace, tolerance=0.01)
    argv = sandbox.build_sandbox_argv(validated, _probe(), _runtime())

    assert argv[argv.index("--") + 1] == "/usr/bin/prlimit"
    command_index = len(argv) - 1 - argv[::-1].index("--")
    command = argv[command_index + 1 :]
    assert command == [
        "/opt/example/bin/python3",
        "/runner/geometry_service.py",
        "/source/model.py",
        "--no-dagmc",
        "--no-mesh",
        "--output-dir",
        "/out",
        "--script-timeout",
        "120",
        "--tolerance",
        "0.01",
    ]


def test_bwrap_argv_omits_disable_userns_when_unsupported(workspace: Path) -> None:
    validated = _validated(workspace)
    argv = sandbox.build_sandbox_argv(validated, _probe(disable_userns=False), _runtime())

    assert "--unshare-user" in argv
    assert "--disable-userns" not in argv
    assert "--assert-userns-disabled" not in argv


def test_bwrap_argv_rejects_unavailable_sandboxes(workspace: Path) -> None:
    probe = sandbox.ProbeResult(
        available=False,
        bwrap_path=None,
        version=None,
        userns=False,
        disable_userns=False,
        reason="bubblewrap (bwrap) is not installed.",
        prlimit_path=None,
    )

    with pytest.raises(sandbox.SandboxValidationError, match="not installed"):
        sandbox.build_sandbox_argv(_validated(workspace), probe, _runtime())


def test_run_sandboxed_build_reports_unavailable_sandboxes(workspace: Path) -> None:
    probe = sandbox.ProbeResult(
        available=False,
        bwrap_path=None,
        version=None,
        userns=False,
        disable_userns=False,
        reason="bubblewrap (bwrap) is not installed.",
        prlimit_path=None,
    )

    result = sandbox.run_sandboxed_build(_request(workspace), probe=probe)

    assert result["success"] is False
    assert "not installed" in result["error"]
    assert result["sandbox"]["available"] is False
    assert result["sandbox"]["engine"] == "bubblewrap"


def _install_fake_argv(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> None:
    monkeypatch.setattr(
        sandbox,
        "build_sandbox_argv",
        lambda validated, probe, runtime=None, program=None: argv,
    )


def _write_runner(tmp_path: Path, body: str) -> list[str]:
    runner = tmp_path / "fake_runner.py"
    runner.write_text(body, encoding="utf-8")
    return [sys.executable, str(runner)]


def _successful_runner(tmp_path: Path, output: Path, **payload: object) -> list[str]:
    bbox = {"min": [0, 0, 0], "max": [1, 2, 3]}
    tess = {
        "version": 1,
        "tolerance": 0.001,
        "boundingBox": bbox,
        "solids": [
            {"id": "s1", "faces": [{"triangles": [[0, 1, 2]]}, {"triangles": [[0, 1, 2]]}]},
            {"id": "s2", "faces": [{"triangles": [[0, 1, 2]]}]},
        ],
    }
    body = f"""
import json
from pathlib import Path
output = Path({str(output)!r})
(output / "model.step").write_text("ISO-10303-21;\\n", encoding="utf-8")
(output / "model.tess.json").write_text({json.dumps(tess)!r}, encoding="utf-8")
(output / "unexpected.txt").write_text("discard me", encoding="utf-8")
print("__NUKE_RESULT__" + {json.dumps(payload)!r})
"""
    return _write_runner(tmp_path, body)


def test_run_sandboxed_build_validates_and_returns_artifacts(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    runner = _successful_runner(
        workspace,
        validated.output_directory,
        success=True,
        solidCount=2,
        faceCount=3,
        triangleCount=3,
        boundingBox={"min": [0, 0, 0], "max": [1, 2, 3]},
    )
    _install_fake_argv(monkeypatch, runner)

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is True
    assert result["solidCount"] == 2
    assert result["faceCount"] == 3
    assert result["triangleCount"] == 3
    assert result["boundingBox"] == {"min": [0.0, 0.0, 0.0], "max": [1.0, 2.0, 3.0]}
    assert Path(result["stepPath"]) == validated.output_directory / "model.step"
    assert Path(result["tessPath"]) == validated.output_directory / "model.tess.json"
    assert result["timedOut"] is False
    assert result["exitCode"] == 0
    assert result["sandbox"]["available"] is True
    assert result["sandbox"]["network"] == "none"
    assert result["sandbox"]["workspace"] == "none"
    assert result["sandbox"]["limits"]["timeoutSeconds"] == 120
    assert not (validated.output_directory / "unexpected.txt").exists()
    assert not (validated.output_directory / "request.json").exists()


def test_run_sandboxed_build_sanitizes_failures_and_discards_artifacts(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    error = f"Script execution failed: cannot read {workspace}/model.py"
    runner = _successful_runner(
        workspace,
        validated.output_directory,
        success=False,
        error=error,
        traceback=f"Traceback ... {workspace}/model.py",
    )
    _install_fake_argv(monkeypatch, runner)

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert str(workspace) not in result["error"]
    assert "<workspace>" in result["error"]
    assert "traceback" not in result
    assert not (validated.output_directory / "model.step").exists()
    assert not (validated.output_directory / "model.tess.json").exists()


def test_run_sandboxed_build_reports_missing_results(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    runner = _write_runner(workspace, "import sys\nprint('no result')\nsys.exit(3)\n")
    _install_fake_argv(monkeypatch, runner)

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert "no result" in result["error"]
    assert result["exitCode"] == 3


def test_run_sandboxed_build_reports_timeouts(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    monkeypatch.setattr(sandbox, "TIMEOUT_GRACE_SECONDS", 0.0)
    runner = _write_runner(workspace, "import time\ntime.sleep(30)\n")
    _install_fake_argv(monkeypatch, runner)

    result = sandbox.run_sandboxed_build(_request(workspace, timeoutSeconds=1), probe=_probe())

    assert result["success"] is False
    assert result["timedOut"] is True
    assert "timed out" in result["error"].lower()
    assert result["durationMs"] < 5000


def test_run_sandboxed_build_rejects_symbolic_link_artifacts(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    outside = workspace / "outside.tess.json"
    outside.write_text("{}", encoding="utf-8")
    body = f"""
import json
from pathlib import Path
output = Path({str(validated.output_directory)!r})
(output / "model.step").write_text("ISO-10303-21;\\n", encoding="utf-8")
(output / "model.tess.json").symlink_to({str(outside)!r})
print("__NUKE_RESULT__" + json.dumps({{"success": True}}))
"""
    _install_fake_argv(monkeypatch, _write_runner(workspace, body))

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert "symbolic link" in result["error"]
    assert not (validated.output_directory / "model.tess.json").exists()


def test_run_sandboxed_build_rejects_hard_linked_artifacts(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    body = f"""
import json, os
from pathlib import Path
output = Path({str(validated.output_directory)!r})
(output / "model.step").write_text("ISO-10303-21;\\n", encoding="utf-8")
(output / "model.tess.json").write_text("{{}}", encoding="utf-8")
os.link(output / "model.tess.json", output / "second.tess.json")
print("__NUKE_RESULT__" + json.dumps({{"success": True}}))
"""
    _install_fake_argv(monkeypatch, _write_runner(workspace, body))

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert "hard-linked" in result["error"]


def test_run_sandboxed_build_rejects_invalid_tessellation(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    body = f"""
import json
from pathlib import Path
output = Path({str(validated.output_directory)!r})
(output / "model.step").write_text("ISO-10303-21;\\n", encoding="utf-8")
(output / "model.tess.json").write_text("not json", encoding="utf-8")
print("__NUKE_RESULT__" + json.dumps({{"success": True}}))
"""
    _install_fake_argv(monkeypatch, _write_runner(workspace, body))

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert "not valid JSON" in result["error"]


def test_run_sandboxed_build_requires_a_solid(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    tess = {
        "version": 1,
        "tolerance": 0.001,
        "boundingBox": {"min": [0, 0, 0], "max": [1, 1, 1]},
        "solids": [],
    }
    body = f"""
import json
from pathlib import Path
output = Path({str(validated.output_directory)!r})
(output / "model.step").write_text("ISO-10303-21;\\n", encoding="utf-8")
(output / "model.tess.json").write_text({json.dumps(tess)!r}, encoding="utf-8")
print("__NUKE_RESULT__" + json.dumps({{"success": True}}))
"""
    _install_fake_argv(monkeypatch, _write_runner(workspace, body))

    result = sandbox.run_sandboxed_build(_request(workspace), probe=_probe())

    assert result["success"] is False
    assert "no solids" in result["error"].lower()


def test_run_bwrap_escalates_to_sigkill_after_a_timeout() -> None:
    started = time.monotonic()
    run = sandbox.run_bwrap([sys.executable, "-c", "import time; time.sleep(30)"], 0.2)

    assert run.timed_out is True
    assert time.monotonic() - started < 5
    assert run.exit_code is not None


def test_output_cleanup_preserves_request_files(
    monkeypatch: pytest.MonkeyPatch, workspace: Path
) -> None:
    validated = _validated(workspace)
    request_file = validated.output_directory / "request.json"
    request_file.write_text("{}", encoding="utf-8")
    runner = _successful_runner(
        workspace,
        validated.output_directory,
        success=True,
        solidCount=2,
        faceCount=3,
        triangleCount=3,
        boundingBox={"min": [0, 0, 0], "max": [1, 2, 3]},
    )
    _install_fake_argv(monkeypatch, runner)

    result = sandbox.run_sandboxed_build(
        _request(workspace), probe=_probe(), request_path=request_file
    )

    assert result["success"] is True
    assert request_file.exists()


REAL_SANDBOX = os.environ.get("NUKE_CAD_SANDBOX") == "1"


@pytest.mark.skipif(not REAL_SANDBOX, reason="set NUKE_CAD_SANDBOX=1 to run real bwrap tests")
class TestRealBubblewrap:
    @pytest.fixture(autouse=True)
    def _probe(self) -> sandbox.ProbeResult:
        probe = sandbox.probe_bwrap(force=True)
        if not probe.available:
            pytest.skip(f"bubblewrap is unavailable: {probe.reason}")
        self.probe = probe

    def _run_code(self, workspace: Path, code: str, **overrides: object) -> sandbox.BwrapRun:
        validated = _validated(workspace, **overrides)
        runtime = sandbox.resolve_python_runtime()
        argv = sandbox.build_sandbox_argv(
            validated,
            self.probe,
            runtime,
            program=[runtime.executable, "-c", code],
        )
        return sandbox.run_bwrap(argv, 30)

    def test_network_is_blocked(self, workspace: Path) -> None:
        import socket

        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        try:
            code = f"""
import socket
client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
client.settimeout(1)
try:
    client.connect(("127.0.0.1", {port}))
except OSError:
    print("NETWORK_BLOCKED")
else:
    print("NETWORK_OPEN")
"""
            run = self._run_code(workspace, code)
        finally:
            server.close()

        assert run.exit_code == 0
        assert "NETWORK_BLOCKED" in run.stdout

    def test_writes_are_confined_to_the_output_and_tempfs(self, workspace: Path) -> None:
        marker = workspace / "secret.txt"
        marker.write_text("secret", encoding="utf-8")
        code = f"""
import os
from pathlib import Path
results = {{}}
for path in ["/usr/nuke-cad-write", "/source/model.py", "/nuke-cad-write"]:
    try:
        Path(path).write_text("x", encoding="utf-8")
    except OSError:
        results[path] = "blocked"
    else:
        results[path] = "WRITABLE"
for path in ["/out/write.txt", "/tmp/write.txt", "/dev/shm/write.txt"]:
    try:
        Path(path).write_text("x", encoding="utf-8")
    except OSError:
        results[path] = "blocked"
    else:
        results[path] = "writable"
workspace = {str(workspace)!r}
results["workspace"] = Path(workspace, "secret.txt").exists()
results["home"] = os.environ.get("HOME")
results["tmpdir"] = os.environ.get("TMPDIR")
print("RESULTS", results)
"""
        run = self._run_code(workspace, code)

        assert run.exit_code == 0
        assert "WRITABLE" not in run.stdout
        assert "'/out/write.txt': 'writable'" in run.stdout
        assert "'/tmp/write.txt': 'writable'" in run.stdout
        assert "'workspace': False" in run.stdout
        assert "'home': '/tmp'" in run.stdout
        assert "'tmpdir': '/tmp'" in run.stdout

    def test_home_and_workspace_contents_are_not_visible(self, workspace: Path) -> None:
        code = """
import os
from pathlib import Path
home = Path(os.environ["HOME"])
print("HOME_EXISTS", home.exists())
print("HOME_ENTRIES", sorted(entry.name for entry in home.iterdir()) if home.exists() else [])
"""
        run = self._run_code(workspace, code)

        assert run.exit_code == 0
        assert ".bashrc" not in run.stdout
        assert ".ssh" not in run.stdout

    def test_timeout_kills_the_sandbox(self, workspace: Path) -> None:
        validated = _validated(workspace, timeoutSeconds=1)
        runtime = sandbox.resolve_python_runtime()
        argv = sandbox.build_sandbox_argv(
            validated,
            self.probe,
            runtime,
            program=[runtime.executable, "-c", "import time; time.sleep(30)"],
        )

        run = sandbox.run_bwrap(argv, 1.0)

        assert run.timed_out is True
        assert run.duration_ms < 10000

    def test_memory_limit_is_enforced(self, workspace: Path) -> None:
        code = """
try:
    data = bytearray(700 * 1024 * 1024)
    for index in range(0, len(data), 4096):
        data[index] = 1
except MemoryError:
    print("MEMORY_BLOCKED")
else:
    print("MEMORY_OPEN")
"""
        run = self._run_code(workspace, code, memoryLimitMb=256)

        assert "MEMORY_OPEN" not in run.stdout

    def test_process_limit_is_enforced(self, workspace: Path) -> None:
        code = """
import os
import time
children = 0
for _ in range(60):
    try:
        pid = os.fork()
    except OSError:
        break
    if pid == 0:
        time.sleep(2)
        os._exit(0)
    children += 1
print("CHILDREN", children)
"""
        run = self._run_code(workspace, code, processLimit=16)

        assert run.exit_code == 0
        assert "CHILDREN" in run.stdout
        children = int(run.stdout.split("CHILDREN", 1)[1].split()[0])
        assert children < 60

    def test_end_to_end_geometry_build(self, workspace: Path) -> None:
        if importlib.util.find_spec("OCP") is None or importlib.util.find_spec("build123d") is None:
            pytest.skip("the active interpreter has no OCP/build123d CAD toolchain")
        (workspace / "model.py").write_text(
            "from build123d import Box\n\nmodel = Box(10, 20, 30)\n", encoding="utf-8"
        )

        result = sandbox.run_sandboxed_build(
            _request(workspace, tolerance=0.01, timeoutSeconds=120),
            probe=self.probe,
        )

        assert result["success"] is True
        assert result["solidCount"] >= 1
        assert result["triangleCount"] > 0
        assert Path(result["stepPath"]).is_file()
        assert Path(result["tessPath"]).is_file()
        assert stat.S_ISREG(os.lstat(result["stepPath"]).st_mode)
