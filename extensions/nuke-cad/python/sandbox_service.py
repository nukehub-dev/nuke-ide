#!/usr/bin/env python3
# *****************************************************************************
# Copyright (C) 2024 NukeHub and others.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************

"""Bubblewrap sandbox runner for user-authored nuke-cad scripts.

The service is intentionally stdlib-only at import time: it must be able to
probe the host even when the active Python environment cannot import OCP.
User scripts are executed by ``geometry_service.py`` inside a bubblewrap
sandbox; this module owns request validation, the sandbox argv policy, the
resource limits, and artifact validation.

Protocol
--------
``--probe`` prints one ``__NUKE_RESULT__`` JSON object describing bubblewrap
availability. ``--request <json-file>`` runs one sandboxed build and prints one
``__NUKE_RESULT__`` JSON result. Any failure is reported in the result object;
there is no unsandboxed fallback.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RESULT_MARKER = "__NUKE_RESULT__"

MAX_CAPTURE_BYTES = 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_TESS_PARSE_BYTES = 64 * 1024 * 1024
MAX_ERROR_CHARS = 2000
MAX_WARNINGS = 20
MAX_WARNING_CHARS = 500

PROBE_TIMEOUT_SECONDS = 10.0
TIMEOUT_GRACE_SECONDS = 5.0
CPU_LIMIT_GRACE_SECONDS = 10
KILL_GRACE_SECONDS = 1.0

DEFAULT_SCRIPT_TIMEOUT_SECONDS = 120
DEFAULT_MEMORY_LIMIT_MB = 4096
DEFAULT_PROCESS_LIMIT = 128
DEFAULT_FILE_SIZE_LIMIT_MB = 512

MIN_SCRIPT_TIMEOUT_SECONDS = 1
MAX_SCRIPT_TIMEOUT_SECONDS = 300
MIN_MEMORY_LIMIT_MB = 256
MAX_MEMORY_LIMIT_MB = 8192
MIN_PROCESS_LIMIT = 16
MAX_PROCESS_LIMIT = 512
MIN_FILE_SIZE_LIMIT_MB = 16
MAX_FILE_SIZE_LIMIT_MB = 1024

NOFILE_LIMIT = 256
TMPFS_BYTES = 256 * 1024 * 1024
DEV_SHM_BYTES = 64 * 1024 * 1024

# libseccomp actions from <seccomp.h>. The filter is default-allow so normal
# Python/OCP operation is unaffected; the denylist removes the network,
# namespace/mount, and kernel-inspection surface the sandbox never needs.
SCMP_ACT_ALLOW = 0x7FFF0000
SCMP_ACT_ERRNO_EPERM = 0x00050000 | 1
SCMP_ACT_ERRNO_ENOSYS = 0x00050000 | 38

SECCOMP_LIBRARY_NAMES = ("libseccomp.so.2", "libseccomp.so")
SECCOMP_ENOSYS_SYSCALLS = ("clone3",)

# ``execve`` stays allowed: the geometry service and its script child are
# started with it. ``execveat`` is not part of the fixed launch contract.
# ``clone3`` is forced to ENOSYS so libc falls back to ``clone``; this keeps a
# script from using the unfilterable clone3 argument block to open namespaces.
SECCOMP_DENIED_SYSCALLS = (
    # Network.
    "socket",
    "socketpair",
    "connect",
    "bind",
    "listen",
    "accept",
    "accept4",
    "sendto",
    "recvfrom",
    "sendmsg",
    "recvmsg",
    "sendmmsg",
    "recvmmsg",
    "getsockname",
    "getpeername",
    "setsockopt",
    "getsockopt",
    "shutdown",
    # Namespaces and mounts.
    "mount",
    "umount2",
    "pivot_root",
    "chroot",
    "setns",
    "unshare",
    "mount_setattr",
    "open_tree",
    "move_mount",
    "fsopen",
    "fsconfig",
    "fsmount",
    "fspick",
    "statmount",
    "listmount",
    # Kernel inspection and tracing.
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "kcmp",
    "bpf",
    "perf_event_open",
    "userfaultfd",
    "keyctl",
    "add_key",
    "request_key",
    "init_module",
    "finit_module",
    "delete_module",
    "kexec_load",
    "kexec_file_load",
    "reboot",
    "swapon",
    "swapoff",
    "acct",
    "quotactl",
    "syslog",
    "ioperm",
    "iopl",
    "open_by_handle_at",
    "name_to_handle_at",
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "seccomp",
    # The sandbox launches its fixed program with ``execve`` only.
    "execveat",
)

# Bubblewrap options the sandbox policy depends on. The probe refuses hosts
# whose bwrap does not advertise them instead of failing on every build.
REQUIRED_BWRAP_FLAGS = (
    "--unshare-all",
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--remount-ro",
    "--size",
    "--proc",
    "--dev",
    "--tmpfs",
    "--ro-bind",
    "--bind",
    "--symlink",
    "--setenv",
    "--chdir",
    "--seccomp",
)

SANDBOX_RUNNER_DIR = "/runner"
SANDBOX_SOURCE_DIR = "/source"
SANDBOX_OUTPUT_DIR = "/out"

EXPECTED_ARTIFACTS = ("model.step", "model.tess.json")

# Environment variables that leak host configuration into the sandbox. The
# child environment is rebuilt from scratch after ``--clearenv``; only the
# explicit allow-list below is forwarded.
SANDBOX_ENV_DENY_PREFIXES = (
    "AWS_",
    "AZURE_",
    "CONDA_",
    "DOCKER_",
    "GIT_",
    "GOOGLE_",
    "KUBE",
    "LD_",
    "NPM_",
    "SSH_",
    "XDG_RUNTIME_DIR",
)


class SandboxValidationError(Exception):
    """A request that cannot be executed inside the sandbox."""


class SandboxArtifactError(Exception):
    """A sandboxed build that produced missing or unsafe artifacts."""


class SeccompError(Exception):
    """A libseccomp filter that could not be built or exported."""


@dataclass
class SeccompFilter:
    """One exported cBPF filter file and the descriptor handed to bubblewrap."""

    fd: int
    path: Path | None
    version: str | None
    denied_count: int

    def close(self) -> None:
        """Close the host descriptor and remove the exported filter file."""
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1
        if self.path is not None:
            try:
                self.path.unlink()
            except OSError:
                pass
            self.path = None

    def __enter__(self) -> SeccompFilter:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


class _ScmpVersion(ctypes.Structure):
    _fields_ = [
        ("major", ctypes.c_uint),
        ("minor", ctypes.c_uint),
        ("micro", ctypes.c_uint),
    ]


def _configure_libseccomp(library: ctypes.CDLL) -> None:
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_release.restype = None
    library.seccomp_rule_add.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    library.seccomp_rule_add.restype = ctypes.c_int
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.seccomp_export_bpf.restype = ctypes.c_int
    library.seccomp_version.argtypes = []
    library.seccomp_version.restype = ctypes.POINTER(_ScmpVersion)


def _load_libseccomp() -> ctypes.CDLL | None:
    """Load libseccomp, preferring the soname resolved by the dynamic linker."""
    candidates: list[str] = []
    discovered = ctypes.util.find_library("seccomp")
    if discovered:
        candidates.append(discovered)
    candidates.extend(SECCOMP_LIBRARY_NAMES)
    for candidate in dict.fromkeys(candidates):
        try:
            library = ctypes.CDLL(candidate)
        except OSError:
            continue
        try:
            _configure_libseccomp(library)
        except AttributeError:
            continue
        return library
    return None


def _libseccomp_version(library: ctypes.CDLL) -> str | None:
    try:
        pointer = library.seccomp_version()
    except (AttributeError, ValueError):
        return None
    if not pointer:
        return None
    try:
        version = pointer.contents
    except ValueError:
        return None
    return f"{version.major}.{version.minor}.{version.micro}"


def build_seccomp_filter() -> SeccompFilter:
    """Build the default-allow cBPF denylist and export it to a private file.

    The returned filter owns an open descriptor positioned at byte 0. Call
    :meth:`SeccompFilter.close` once bubblewrap has loaded it.
    """
    library = _load_libseccomp()
    if library is None:
        raise SeccompError("libseccomp (libseccomp.so.2) is not installed.")
    context = library.seccomp_init(SCMP_ACT_ALLOW)
    if not context:
        raise SeccompError("libseccomp could not create a seccomp filter.")
    fd = -1
    path: Path | None = None
    denied = 0
    try:
        for name in SECCOMP_DENIED_SYSCALLS:
            number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number < 0:
                continue
            result = library.seccomp_rule_add(context, SCMP_ACT_ERRNO_EPERM, number, 0)
            if result < 0:
                raise SeccompError(f"libseccomp could not deny {name} (error {result}).")
            denied += 1
        for name in SECCOMP_ENOSYS_SYSCALLS:
            number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number < 0:
                continue
            result = library.seccomp_rule_add(context, SCMP_ACT_ERRNO_ENOSYS, number, 0)
            if result < 0:
                raise SeccompError(
                    f"libseccomp could not return ENOSYS for {name} (error {result})."
                )
            denied += 1
        if denied == 0:
            raise SeccompError("libseccomp resolved none of the sandbox syscall denylist.")
        fd, path_text = tempfile.mkstemp(prefix="nuke-cad-seccomp-", suffix=".bpf")
        path = Path(path_text)
        os.fchmod(fd, 0o600)
        result = library.seccomp_export_bpf(context, fd)
        if result < 0:
            raise SeccompError(f"libseccomp could not export the filter (error {result}).")
        os.lseek(fd, 0, os.SEEK_SET)
        return SeccompFilter(
            fd=fd,
            path=path,
            version=_libseccomp_version(library),
            denied_count=denied,
        )
    except BaseException:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        if path is not None:
            try:
                path.unlink()
            except OSError:
                pass
        raise
    finally:
        library.seccomp_release(context)


@dataclass(frozen=True)
class ProbeResult:
    """Host capability probe result (internal fields included)."""

    available: bool
    bwrap_path: str | None
    version: str | None
    userns: bool
    disable_userns: bool
    reason: str | None
    prlimit_path: str | None
    help_text: str = ""
    seccomp: bool = False
    seccomp_version: str | None = None

    def to_status(self) -> dict[str, Any]:
        """Return the public ``ScriptSandboxStatus`` payload."""
        status: dict[str, Any] = {
            "available": self.available,
            "engine": "bubblewrap",
            "userns": self.userns,
            "disableUserns": self.disable_userns,
            "seccomp": self.seccomp,
        }
        if self.bwrap_path:
            status["bwrapPath"] = self.bwrap_path
        if self.version:
            status["version"] = self.version
        if self.seccomp_version:
            status["seccompVersion"] = self.seccomp_version
        if self.reason:
            status["reason"] = self.reason
        return status


@dataclass(frozen=True)
class PythonRuntime:
    """The active interpreter resolved into sandbox mount destinations."""

    executable: str
    binds: tuple[tuple[str, str], ...]
    path_entries: tuple[str, ...]


@dataclass(frozen=True)
class SandboxOptions:
    """Validated resource limits for one sandboxed build."""

    tolerance: float | None
    timeout_seconds: int
    memory_limit_mb: int
    process_limit: int
    file_size_limit_mb: int

    def to_limits(self) -> dict[str, int]:
        return {
            "timeoutSeconds": self.timeout_seconds,
            "memoryLimitMb": self.memory_limit_mb,
            "processLimit": self.process_limit,
            "fileSizeLimitMb": self.file_size_limit_mb,
            "nofile": NOFILE_LIMIT,
            "core": 0,
        }


@dataclass(frozen=True)
class ValidatedRequest:
    """A request with absolute, workspace-contained filesystem paths."""

    script_path: Path
    workspace_root: Path
    output_directory: Path
    options: SandboxOptions
    job_id: str | None


@dataclass(frozen=True)
class BwrapRun:
    """Captured result of one bubblewrap process."""

    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    duration_ms: int


_PROBE_CACHE: ProbeResult | None = None


def _probe_status(available: bool, reason: str | None = None) -> ProbeResult:
    return ProbeResult(
        available=available,
        bwrap_path=None,
        version=None,
        userns=False,
        disable_userns=False,
        reason=reason,
        prlimit_path=shutil.which("prlimit") if sys.platform.startswith("linux") else None,
    )


def _run_probe_command(argv: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            argv,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _probe_userns(bwrap_path: str, flags: list[str]) -> bool:
    command = [bwrap_path, *flags]
    command += ["--ro-bind", "/usr", "/usr"]
    for target, link in (("usr/bin", "/bin"), ("usr/lib", "/lib"), ("usr/lib64", "/lib64")):
        if Path("/" + target).exists():
            command += ["--symlink", target, link]
    command += ["--proc", "/proc", "--dev", "/dev"]

    true_path = shutil.which("true") or "/usr/bin/true"
    command += ["--", true_path]
    result = _run_probe_command(command)
    return result is not None and result.returncode == 0


def probe_bwrap(*, force: bool = False) -> ProbeResult:
    """Probe bubblewrap, user namespaces, ``prlimit``, and libseccomp support.

    Results are cached for the process lifetime; ``force`` re-runs the probe
    (used by tests and by diagnostics after a host configuration change).
    """
    global _PROBE_CACHE
    if _PROBE_CACHE is not None and not force:
        return _PROBE_CACHE

    if not sys.platform.startswith("linux"):
        _PROBE_CACHE = _probe_status(
            False,
            "Sandboxed builds require Linux with bubblewrap and libseccomp; macOS and Windows are unsupported.",
        )
        return _PROBE_CACHE

    bwrap_path = shutil.which("bwrap")
    if not bwrap_path:
        _PROBE_CACHE = _probe_status(False, "bubblewrap (bwrap) is not installed.")
        return _PROBE_CACHE

    prlimit_path = shutil.which("prlimit")
    if not prlimit_path:
        _PROBE_CACHE = _probe_status(False, "prlimit is not installed.")
        return _PROBE_CACHE

    help_result = _run_probe_command([bwrap_path, "--help"])
    help_text = ""
    if help_result is not None:
        help_text = f"{help_result.stdout}\n{help_result.stderr}"

    version_result = _run_probe_command([bwrap_path, "--version"])
    version: str | None = None
    if version_result is not None and version_result.returncode == 0:
        first_line = (version_result.stdout or version_result.stderr).strip().splitlines()
        if first_line:
            version = first_line[0].strip()

    missing_flags = [flag for flag in REQUIRED_BWRAP_FLAGS if flag not in help_text]
    if missing_flags:
        reason = f"bubblewrap does not support required options: {', '.join(missing_flags)}."
        _PROBE_CACHE = ProbeResult(
            available=False,
            bwrap_path=bwrap_path,
            version=version,
            userns=False,
            disable_userns=False,
            reason=reason,
            prlimit_path=prlimit_path,
            help_text=help_text,
        )
        return _PROBE_CACHE

    try:
        seccomp_filter = build_seccomp_filter()
    except (SeccompError, OSError) as exc:
        reason = f"libseccomp is required for sandboxed builds: {exc}"
        _PROBE_CACHE = ProbeResult(
            available=False,
            bwrap_path=bwrap_path,
            version=version,
            userns=False,
            disable_userns=False,
            reason=reason,
            prlimit_path=prlimit_path,
            help_text=help_text,
        )
        return _PROBE_CACHE
    seccomp_version = seccomp_filter.version
    seccomp_filter.close()

    has_disable_userns = "--disable-userns" in help_text
    has_assert_userns = "--assert-userns-disabled" in help_text

    userns = False
    disable_userns = False
    if has_disable_userns and has_assert_userns:
        full_flags = [
            "--unshare-user",
            "--disable-userns",
            "--assert-userns-disabled",
            "--unshare-all",
            "--die-with-parent",
        ]
        if _probe_userns(bwrap_path, full_flags):
            userns = True
            disable_userns = True
    if not userns:
        userns = _probe_userns(bwrap_path, ["--unshare-user", "--unshare-all", "--die-with-parent"])

    if not userns:
        reason = (
            "Unprivileged user namespaces are unavailable; enable them or run "
            "NukeIDE in a host that permits bwrap user namespaces."
        )
        _PROBE_CACHE = ProbeResult(
            available=False,
            bwrap_path=bwrap_path,
            version=version,
            userns=False,
            disable_userns=False,
            reason=reason,
            prlimit_path=prlimit_path,
            help_text=help_text,
            seccomp=True,
            seccomp_version=seccomp_version,
        )
        return _PROBE_CACHE

    _PROBE_CACHE = ProbeResult(
        available=True,
        bwrap_path=bwrap_path,
        version=version,
        userns=True,
        disable_userns=disable_userns,
        reason=None,
        prlimit_path=prlimit_path,
        help_text=help_text,
        seccomp=True,
        seccomp_version=seccomp_version,
    )
    return _PROBE_CACHE


def _is_within(root: Path, candidate: Path) -> bool:
    return candidate == root or root in candidate.parents


def _require_string(request: dict[str, Any], field: str) -> str:
    value = request.get(field)
    if not isinstance(value, str) or not value.strip():
        raise SandboxValidationError(f"{field} must be a non-empty absolute path.")
    try:
        absolute = Path(value).is_absolute()
    except (OSError, ValueError) as exc:
        raise SandboxValidationError(f"{field} must be a valid absolute path.") from exc
    if not absolute:
        raise SandboxValidationError(f"{field} must be an absolute path.")
    return value


def _require_int(
    request: dict[str, Any],
    field: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = request.get(field, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SandboxValidationError(f"{field} must be an integer between {minimum} and {maximum}.")
    try:
        as_float = float(value)
    except (OverflowError, TypeError, ValueError):
        raise SandboxValidationError(
            f"{field} must be an integer between {minimum} and {maximum}."
        ) from None
    if not math.isfinite(as_float) or as_float != int(as_float):
        raise SandboxValidationError(f"{field} must be an integer between {minimum} and {maximum}.")
    integer = int(as_float)
    if integer < minimum or integer > maximum:
        raise SandboxValidationError(f"{field} must be between {minimum} and {maximum}.")
    return integer


def _require_tolerance(request: dict[str, Any]) -> float | None:
    value = request.get("tolerance")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SandboxValidationError("tolerance must be a positive number.")
    try:
        tolerance = float(value)
    except OverflowError:
        raise SandboxValidationError("tolerance must be a positive number.") from None
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise SandboxValidationError("tolerance must be a positive finite number.")
    return tolerance


def _safe_lstat(path: Path) -> os.stat_result:
    try:
        return os.lstat(path)
    except OSError as exc:
        raise SandboxValidationError(
            f"Cannot access {path.name}: {exc.strerror or 'not found'}."
        ) from exc


def _resolve_output_directory(workspace_root: Path, output_directory: Path) -> Path:
    allowed_root = workspace_root / ".nuke-ide" / "ai" / "cad-scripts"
    if allowed_root.is_symlink():
        raise SandboxValidationError(
            "The workspace sandbox staging directory must not be a symbolic link."
        )
    try:
        allowed_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise SandboxValidationError(
            f"Cannot create the sandbox staging directory: {exc.strerror or 'permission denied'}."
        ) from exc
    allowed_real = Path(os.path.realpath(allowed_root))
    if not _is_within(workspace_root, allowed_real):
        raise SandboxValidationError(
            "The workspace sandbox staging directory must stay inside workspaceRoot."
        )

    if output_directory.exists() or output_directory.is_symlink():
        stat_result = _safe_lstat(output_directory)
        if stat.S_ISLNK(stat_result.st_mode):
            raise SandboxValidationError("outputDirectory must not be a symbolic link.")
        if not stat.S_ISDIR(stat_result.st_mode):
            raise SandboxValidationError("outputDirectory must be a directory.")
        output_real = Path(os.path.realpath(output_directory))
    else:
        parent = output_directory.parent
        while not parent.exists() and parent != parent.parent:
            parent = parent.parent
        parent_real = Path(os.path.realpath(parent))
        try:
            relative = output_directory.relative_to(parent)
        except ValueError as exc:
            raise SandboxValidationError(
                "outputDirectory must be inside the workspace staging area."
            ) from exc
        output_real = Path(os.path.realpath(parent_real / relative))

    if not _is_within(allowed_real, output_real):
        raise SandboxValidationError(
            "outputDirectory must be inside <workspace>/.nuke-ide/ai/cad-scripts/."
        )

    try:
        output_real.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise SandboxValidationError(
            f"Cannot create the sandbox output directory: {exc.strerror or 'permission denied'}."
        ) from exc

    final_stat = _safe_lstat(output_real)
    if stat.S_ISLNK(final_stat.st_mode) or not stat.S_ISDIR(final_stat.st_mode):
        raise SandboxValidationError("outputDirectory must be a real directory.")
    return Path(os.path.realpath(output_real))


def validate_request(request: dict[str, Any]) -> ValidatedRequest:
    """Validate and normalize one ``SandboxedScriptBuildRequest``."""
    if not isinstance(request, dict):
        raise SandboxValidationError("Sandbox request must be a JSON object.")

    script_value = _require_string(request, "scriptPath")
    workspace_value = _require_string(request, "workspaceRoot")
    output_value = _require_string(request, "outputDirectory")

    try:
        workspace_path = Path(workspace_value)
        workspace_stat = _safe_lstat(workspace_path)
        if stat.S_ISLNK(workspace_stat.st_mode):
            workspace_stat = os.stat(workspace_path)
        if not stat.S_ISDIR(workspace_stat.st_mode):
            raise SandboxValidationError("workspaceRoot must be a directory.")
        workspace_real = Path(os.path.realpath(workspace_path))
    except SandboxValidationError:
        raise
    except OSError as exc:
        raise SandboxValidationError(
            f"Cannot access workspaceRoot: {exc.strerror or 'not found'}."
        ) from exc

    script_path = Path(script_value)
    if script_path.suffix.lower() != ".py":
        raise SandboxValidationError("scriptPath must point to a .py file.")
    script_stat = _safe_lstat(script_path)
    if stat.S_ISLNK(script_stat.st_mode):
        raise SandboxValidationError("scriptPath must not be a symbolic link.")
    if not stat.S_ISREG(script_stat.st_mode):
        raise SandboxValidationError("scriptPath must be a regular file.")
    script_real = Path(os.path.realpath(script_path))
    if not _is_within(workspace_real, script_real) or script_real == workspace_real:
        raise SandboxValidationError("scriptPath must be inside workspaceRoot.")

    output_real = _resolve_output_directory(workspace_real, Path(output_value))

    options = SandboxOptions(
        tolerance=_require_tolerance(request),
        timeout_seconds=_require_int(
            request,
            "timeoutSeconds",
            DEFAULT_SCRIPT_TIMEOUT_SECONDS,
            MIN_SCRIPT_TIMEOUT_SECONDS,
            MAX_SCRIPT_TIMEOUT_SECONDS,
        ),
        memory_limit_mb=_require_int(
            request,
            "memoryLimitMb",
            DEFAULT_MEMORY_LIMIT_MB,
            MIN_MEMORY_LIMIT_MB,
            MAX_MEMORY_LIMIT_MB,
        ),
        process_limit=_require_int(
            request,
            "processLimit",
            DEFAULT_PROCESS_LIMIT,
            MIN_PROCESS_LIMIT,
            MAX_PROCESS_LIMIT,
        ),
        file_size_limit_mb=_require_int(
            request,
            "fileSizeLimitMb",
            DEFAULT_FILE_SIZE_LIMIT_MB,
            MIN_FILE_SIZE_LIMIT_MB,
            MAX_FILE_SIZE_LIMIT_MB,
        ),
    )

    job_id = request.get("jobId")
    if job_id is not None and not isinstance(job_id, str):
        raise SandboxValidationError("jobId must be a string when provided.")

    return ValidatedRequest(
        script_path=script_real,
        workspace_root=workspace_real,
        output_directory=output_real,
        options=options,
        job_id=job_id,
    )


def resolve_python_runtime() -> PythonRuntime:
    """Resolve the interpreter running this service into sandbox mount paths.

    The active environment prefix is bound read-only at its real absolute path
    (bwrap creates the empty parent directories), so the interpreter keeps its
    own prefix instead of silently falling back to a system Python.
    """
    executable = Path(sys.executable)
    if not executable.is_absolute():
        executable = Path.cwd() / executable

    literal_prefix = Path(os.path.abspath(sys.prefix))
    prefix_real = Path(os.path.realpath(sys.prefix))
    base_prefix_real = Path(os.path.realpath(sys.base_prefix))

    binds: list[tuple[str, str]] = []
    for root in (prefix_real, base_prefix_real):
        if root == Path("/") or _is_within(Path("/usr"), root):
            continue
        if any(existing == str(root) for existing, _ in binds):
            continue
        binds.append((str(root), str(root)))
    # Mount parents before children so a nested prefix binding is not hidden.
    binds.sort(key=lambda entry: len(Path(entry[1]).parts))

    try:
        relative = executable.relative_to(literal_prefix)
        sandbox_executable = prefix_real / relative
    except ValueError:
        sandbox_executable = Path(os.path.realpath(executable))

    if not _is_within(Path("/usr"), sandbox_executable) and not any(
        _is_within(Path(source), sandbox_executable) for source, _ in binds
    ):
        binds.append((str(sandbox_executable), str(sandbox_executable)))

    path_entries: list[str] = []
    for _source, destination in binds:
        binary_dir = Path(destination) / "bin"
        if os.path.isdir(binary_dir):
            path_entries.append(str(binary_dir))
    path_entries.extend(["/usr/bin", "/bin"])
    unique_entries = tuple(dict.fromkeys(path_entries))

    return PythonRuntime(
        executable=str(sandbox_executable),
        binds=tuple(binds),
        path_entries=unique_entries,
    )


def _sandbox_environment(runtime: PythonRuntime) -> list[tuple[str, str]]:
    home = "/tmp"
    return [
        ("PATH", os.pathsep.join(runtime.path_entries)),
        ("HOME", home),
        ("TMPDIR", "/tmp"),
        ("XDG_CACHE_HOME", f"{home}/.cache"),
        ("XDG_CONFIG_HOME", f"{home}/.config"),
        ("XDG_DATA_HOME", f"{home}/.local/share"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONUNBUFFERED", "1"),
        ("LC_ALL", "C.UTF-8"),
        ("LANG", "C.UTF-8"),
        ("TZ", "UTC"),
        ("OMP_NUM_THREADS", "1"),
        ("OPENBLAS_NUM_THREADS", "1"),
        ("MKL_NUM_THREADS", "1"),
        ("NUMEXPR_NUM_THREADS", "1"),
    ]


def _format_float(value: float) -> str:
    return f"{value:g}"


def build_sandbox_argv(
    validated: ValidatedRequest,
    probe: ProbeResult,
    runtime: PythonRuntime | None = None,
    program: list[str] | None = None,
    *,
    seccomp_fd: int | None = None,
) -> list[str]:
    """Build the complete bubblewrap argv for one sandboxed build.

    ``program`` is an injection point for tests; production always runs the
    geometry service with the fixed argument contract. ``seccomp_fd`` is the
    open descriptor of an exported libseccomp filter; it must stay open until
    bubblewrap has started the sandbox.
    """
    if not probe.available or not probe.bwrap_path:
        raise SandboxValidationError(probe.reason or "The bubblewrap sandbox is unavailable.")
    if not probe.seccomp:
        raise SandboxValidationError(
            probe.reason or "The seccomp filter required by the bubblewrap sandbox is unavailable."
        )
    if seccomp_fd is None:
        raise SandboxValidationError(
            "Sandboxed builds require an exported seccomp filter descriptor."
        )

    runtime = runtime or resolve_python_runtime()
    prlimit_path = probe.prlimit_path or shutil.which("prlimit")
    if not prlimit_path:
        raise SandboxValidationError("prlimit is not installed.")

    argv = [probe.bwrap_path]
    if probe.disable_userns:
        argv += ["--unshare-user", "--disable-userns", "--assert-userns-disabled"]
    else:
        argv += ["--unshare-user"]
    argv += ["--unshare-all", "--die-with-parent", "--new-session"]
    # Bubblewrap installs the filter in the child after namespace and mount
    # setup, immediately before running prlimit/Python.
    argv += ["--seccomp", str(seccomp_fd)]

    argv += ["--ro-bind", "/usr", "/usr"]
    for target, link in (
        ("usr/bin", "/bin"),
        ("usr/lib", "/lib"),
        ("usr/lib64", "/lib64"),
        ("usr/sbin", "/sbin"),
    ):
        if Path("/" + target).exists():
            argv += ["--symlink", target, link]

    for etc_path in ("/etc/ld.so.cache", "/etc/passwd", "/etc/group"):
        if Path(etc_path).exists():
            argv += ["--ro-bind", etc_path, etc_path]
    argv += ["--proc", "/proc", "--dev", "/dev"]

    argv += ["--size", str(TMPFS_BYTES), "--tmpfs", "/tmp"]
    argv += ["--size", str(DEV_SHM_BYTES), "--tmpfs", "/dev/shm"]

    for source, destination in runtime.binds:
        argv += ["--ro-bind", source, destination]

    runner_dir = Path(__file__).resolve().parent
    argv += ["--ro-bind", str(runner_dir), SANDBOX_RUNNER_DIR]
    argv += ["--size", str(1024 * 1024), "--tmpfs", SANDBOX_SOURCE_DIR]
    argv += ["--ro-bind", str(validated.script_path), f"{SANDBOX_SOURCE_DIR}/model.py"]
    # Only the private, pre-validated output directory is writable. It is a
    # bind mount (not tmpfs) so the validated artifacts survive the sandbox.
    argv += ["--bind", str(validated.output_directory), SANDBOX_OUTPUT_DIR]

    argv += ["--remount-ro", "/", "--remount-ro", SANDBOX_RUNNER_DIR]
    argv += ["--remount-ro", SANDBOX_SOURCE_DIR]
    argv += ["--chdir", SANDBOX_SOURCE_DIR, "--clearenv"]
    for key, value in _sandbox_environment(runtime):
        if key.startswith(SANDBOX_ENV_DENY_PREFIXES):
            continue
        argv += ["--setenv", key, value]

    options = validated.options
    address_space_bytes = options.memory_limit_mb * 1024 * 1024
    file_size_bytes = options.file_size_limit_mb * 1024 * 1024
    # RLIMIT_CPU is a backstop, not the wall-clock timeout: the geometry
    # service and its script child both spend CPU on interpreter/OCP startup,
    # so the limit must stay above the wall bound (timeout + grace) or tiny
    # script timeouts would SIGKILL the service before it can report a result.
    cpu_seconds = max(1, int(math.ceil(options.timeout_seconds + CPU_LIMIT_GRACE_SECONDS)))
    argv += [
        "--",
        prlimit_path,
        f"--cpu={cpu_seconds}",
        f"--as={address_space_bytes}",
        f"--nproc={options.process_limit}",
        f"--fsize={file_size_bytes}",
        f"--nofile={NOFILE_LIMIT}",
        "--core=0",
        "--",
    ]

    if program is not None:
        argv += program
    else:
        argv += [
            runtime.executable,
            f"{SANDBOX_RUNNER_DIR}/geometry_service.py",
            f"{SANDBOX_SOURCE_DIR}/model.py",
            "--no-dagmc",
            "--no-mesh",
            "--output-dir",
            SANDBOX_OUTPUT_DIR,
            "--script-timeout",
            str(options.timeout_seconds),
        ]
        if options.tolerance is not None:
            argv += ["--tolerance", _format_float(options.tolerance)]
    return argv


class _CappedBuffer:
    """A byte buffer that silently discards data beyond a fixed cap."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._size = 0
        self._chunks: list[bytes] = []

    def append(self, chunk: bytes) -> None:
        if self._size >= self._limit:
            return
        remaining = self._limit - self._size
        kept = chunk[:remaining]
        self._chunks.append(kept)
        self._size += len(kept)

    def text(self) -> str:
        return b"".join(self._chunks).decode("utf-8", errors="replace")


def _drain_stream(stream: Any, buffer: _CappedBuffer) -> None:
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            buffer.append(chunk)
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def _signal_process_group(process: subprocess.Popen[bytes], sig: int) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, sig)
        else:  # pragma: no cover - Windows is not a supported sandbox host
            process.send_signal(sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def run_bwrap(
    argv: list[str],
    timeout_seconds: float,
    *,
    pass_fds: tuple[int, ...] = (),
) -> BwrapRun:
    """Run bubblewrap with bounded capture and SIGTERM/SIGKILL escalation.

    ``timeout_seconds`` is the hard wall-clock bound. SIGTERM is sent to the
    sandbox process group first; if the process survives ``KILL_GRACE_SECONDS``
    it is killed with SIGKILL. Either way the sandbox namespace disappears, so
    no sandboxed process can outlive the call. ``pass_fds`` keeps the exported
    seccomp filter descriptor open across the ``exec``.
    """
    start = time.monotonic()
    process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        close_fds=True,
        pass_fds=tuple(pass_fds),
    )
    assert process.stdout is not None
    assert process.stderr is not None
    stdout = _CappedBuffer(MAX_CAPTURE_BYTES)
    stderr = _CappedBuffer(MAX_CAPTURE_BYTES)
    readers = [
        threading.Thread(target=_drain_stream, args=(process.stdout, stdout), daemon=True),
        threading.Thread(target=_drain_stream, args=(process.stderr, stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()

    timed_out = False
    exit_code: int | None
    try:
        exit_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        _signal_process_group(process, signal.SIGTERM)
        try:
            exit_code = process.wait(timeout=KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            _signal_process_group(process, signal.SIGKILL)
            try:
                exit_code = process.wait(timeout=KILL_GRACE_SECONDS * 5)
            except subprocess.TimeoutExpired:
                exit_code = None

    for reader in readers:
        reader.join(timeout=KILL_GRACE_SECONDS * 5)
    for stream in (process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass

    duration_ms = int(round((time.monotonic() - start) * 1000))
    return BwrapRun(
        exit_code=exit_code,
        stdout=stdout.text(),
        stderr=stderr.text(),
        timed_out=timed_out,
        duration_ms=duration_ms,
    )


def _parse_result_payload(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith(RESULT_MARKER):
            continue
        try:
            payload = json.loads(line[len(RESULT_MARKER) :])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _remove_entry(path: Path) -> None:
    try:
        stat_result = os.lstat(path)
    except FileNotFoundError:
        return
    except OSError:
        return
    try:
        if stat.S_ISDIR(stat_result.st_mode) and not stat.S_ISLNK(stat_result.st_mode):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)
    except OSError:
        pass


def _clean_known_artifacts(output_directory: Path) -> None:
    for name in EXPECTED_ARTIFACTS:
        _remove_entry(output_directory / name)


def _discard_unexpected(output_directory: Path, before: set[str], preserve: set[str]) -> None:
    try:
        entries = list(os.scandir(output_directory))
    except OSError:
        return
    for entry in entries:
        if entry.name in before or entry.name in preserve:
            continue
        if entry.name in EXPECTED_ARTIFACTS:
            continue
        _remove_entry(Path(entry.path))


def _stat_artifact(path: Path, max_bytes: int) -> os.stat_result:
    try:
        stat_result = os.lstat(path)
    except OSError as exc:
        raise SandboxArtifactError(f"Missing sandbox artifact: {path.name}.") from exc
    if stat.S_ISLNK(stat_result.st_mode):
        raise SandboxArtifactError(f"Sandbox artifact must not be a symbolic link: {path.name}.")
    if not stat.S_ISREG(stat_result.st_mode):
        raise SandboxArtifactError(f"Sandbox artifact must be a regular file: {path.name}.")
    if stat_result.st_nlink != 1:
        raise SandboxArtifactError(f"Sandbox artifact must not be hard-linked: {path.name}.")
    if stat_result.st_size <= 0:
        raise SandboxArtifactError(f"Sandbox artifact is empty: {path.name}.")
    if stat_result.st_size > max_bytes:
        raise SandboxArtifactError(f"Sandbox artifact exceeds the size limit: {path.name}.")
    return stat_result


def _finite_vector(value: Any) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 3:
        return None
    numbers: list[float] = []
    for entry in value:
        if isinstance(entry, bool) or not isinstance(entry, (int, float)):
            return None
        try:
            number = float(entry)
        except OverflowError:
            return None
        if not math.isfinite(number):
            return None
        numbers.append(number)
    return numbers


def _bounding_box(value: Any) -> dict[str, list[float]] | None:
    if not isinstance(value, dict):
        return None
    minimum = _finite_vector(value.get("min"))
    maximum = _finite_vector(value.get("max"))
    if minimum is None or maximum is None:
        return None
    if any(low > high for low, high in zip(minimum, maximum, strict=True)):
        return None
    return {"min": minimum, "max": maximum}


def _tessellation_metrics(path: Path) -> tuple[int, int, int, dict[str, list[float]]] | None:
    """Parse a bounded tessellation stream and derive authoritative metrics."""
    try:
        stat_result = os.lstat(path)
    except OSError:
        return None
    if stat_result.st_size > MAX_TESS_PARSE_BYTES:
        return None
    try:
        with path.open("r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, UnicodeError):
        raise SandboxArtifactError("Sandbox tessellation is not valid JSON.") from None
    if not isinstance(data, dict):
        raise SandboxArtifactError("Sandbox tessellation has an invalid payload.")
    solids = data.get("solids")
    if not isinstance(solids, list) or not solids:
        raise SandboxArtifactError("Sandbox tessellation contains no solids.")
    face_count = 0
    triangle_count = 0
    for solid in solids:
        if not isinstance(solid, dict):
            raise SandboxArtifactError("Sandbox tessellation contains an invalid solid.")
        faces = solid.get("faces")
        if not isinstance(faces, list):
            raise SandboxArtifactError("Sandbox tessellation contains an invalid solid.")
        for face in faces:
            if not isinstance(face, dict) or not isinstance(face.get("triangles"), list):
                raise SandboxArtifactError("Sandbox tessellation contains an invalid face.")
            face_count += 1
            triangle_count += len(face["triangles"])
    bounding_box = _bounding_box(data.get("boundingBox"))
    if bounding_box is None:
        raise SandboxArtifactError("Sandbox tessellation has an invalid bounding box.")
    if triangle_count <= 0:
        raise SandboxArtifactError("Sandbox tessellation contains no triangles.")
    return len(solids), face_count, triangle_count, bounding_box


def _payload_metrics(payload: dict[str, Any]) -> tuple[int, int, int, dict[str, list[float]]]:
    try:
        solid_count = int(payload.get("solidCount"))
        face_count = int(payload.get("faceCount", 0))
        triangle_count = int(payload.get("triangleCount"))
    except (TypeError, ValueError, OverflowError):
        raise SandboxArtifactError("Sandbox build reported invalid geometry counts.") from None
    bounding_box = _bounding_box(payload.get("boundingBox"))
    if bounding_box is None:
        raise SandboxArtifactError("Sandbox build reported an invalid bounding box.")
    if solid_count < 1:
        raise SandboxArtifactError("Sandbox build produced no solids.")
    if triangle_count <= 0:
        raise SandboxArtifactError("Sandbox build produced no triangles.")
    return solid_count, max(face_count, 0), triangle_count, bounding_box


def _sanitize_text(text: str, roots: list[tuple[Path, str]]) -> str:
    """Replace host paths and cap an error/warning string for RPC transport."""
    if not isinstance(text, str):
        return ""
    sanitized = text
    for root, label in roots:
        if not root:
            continue
        try:
            value = str(root)
        except OSError:
            continue
        if value and value != "/":
            sanitized = sanitized.replace(value, label)
    sanitized = re.sub(
        r"(?<![\w.])/(?:home|root|Users|tmp|var|opt|srv|mnt|media)(?:/[^\s:'\"]*)?",
        "<path>",
        sanitized,
    )
    sanitized = sanitized.strip()
    return sanitized[:MAX_ERROR_CHARS]


def _sanitize_warnings(
    warnings: Any,
    roots: list[tuple[Path, str]],
) -> list[str]:
    if not isinstance(warnings, list):
        return []
    result: list[str] = []
    for warning in warnings[:MAX_WARNINGS]:
        if isinstance(warning, str) and warning.strip():
            result.append(_sanitize_text(warning, roots)[:MAX_WARNING_CHARS])
    return result


def _sandbox_info(probe: ProbeResult, options: SandboxOptions) -> dict[str, Any]:
    info: dict[str, Any] = {
        "available": probe.available,
        "engine": "bubblewrap",
        "network": "none",
        "workspace": "none",
        "writable": [SANDBOX_OUTPUT_DIR, "/tmp", "/dev/shm"],
        "limits": options.to_limits(),
        "seccomp": probe.seccomp,
    }
    if probe.version:
        info["version"] = probe.version
    if probe.seccomp_version:
        info["seccompVersion"] = probe.seccomp_version
    info["disableUserns"] = probe.disable_userns
    return info


def _default_options() -> SandboxOptions:
    return SandboxOptions(
        tolerance=None,
        timeout_seconds=DEFAULT_SCRIPT_TIMEOUT_SECONDS,
        memory_limit_mb=DEFAULT_MEMORY_LIMIT_MB,
        process_limit=DEFAULT_PROCESS_LIMIT,
        file_size_limit_mb=DEFAULT_FILE_SIZE_LIMIT_MB,
    )


def _error_result(
    message: str,
    *,
    probe: ProbeResult,
    options: SandboxOptions,
    timed_out: bool = False,
    exit_code: int | None = None,
    duration_ms: int = 0,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "success": False,
        "error": message,
        "durationMs": duration_ms,
        "timedOut": timed_out,
        "exitCode": exit_code,
        "sandbox": _sandbox_info(probe, options),
    }
    if warnings:
        result["warnings"] = warnings
    return result


def run_sandboxed_build(
    request: dict[str, Any],
    *,
    probe: ProbeResult | None = None,
    request_path: Path | None = None,
    seccomp: SeccompFilter | None = None,
) -> dict[str, Any]:
    """Validate and run one sandboxed script build.

    ``seccomp`` is an injection point for tests. Production builds and exports
    a fresh filter here; the filter passed or created is closed before return.
    """
    probe = probe or probe_bwrap()
    options = _default_options()
    if not probe.available:
        return _error_result(
            probe.reason or "The bubblewrap sandbox is unavailable.",
            probe=probe,
            options=options,
        )
    if not probe.seccomp:
        return _error_result(
            probe.reason or "The seccomp filter required by the bubblewrap sandbox is unavailable.",
            probe=probe,
            options=options,
        )

    try:
        validated = validate_request(request)
        options = validated.options
    except SandboxValidationError as exc:
        return _error_result(str(exc), probe=probe, options=options)

    output_directory = validated.output_directory
    preserve = {request_path.name} if request_path is not None else set()
    _clean_known_artifacts(output_directory)
    try:
        before = {entry.name for entry in os.scandir(output_directory)}
    except OSError:
        before = set()

    roots = [
        (validated.workspace_root, "<workspace>"),
        (output_directory, "<output>"),
        (Path(sys.prefix), "<python>"),
        (Path(sys.base_prefix), "<python>"),
        (Path.home(), "<home>"),
    ]

    def sanitize(text: str) -> str:
        return _sanitize_text(text, roots)

    try:
        seccomp_filter = seccomp if seccomp is not None else build_seccomp_filter()
    except (SeccompError, OSError) as exc:
        return _error_result(
            sanitize(f"Sandboxed build requires a seccomp filter: {exc}"),
            probe=probe,
            options=options,
        )

    try:
        try:
            argv = build_sandbox_argv(validated, probe, seccomp_fd=seccomp_filter.fd)
        except (SandboxValidationError, OSError) as exc:
            return _error_result(sanitize(str(exc)), probe=probe, options=options)

        try:
            run = run_bwrap(
                argv,
                validated.options.timeout_seconds + TIMEOUT_GRACE_SECONDS,
                pass_fds=(seccomp_filter.fd,),
            )
        except (OSError, ValueError) as exc:
            _clean_known_artifacts(output_directory)
            return _error_result(
                sanitize(f"Sandboxed build could not start: {exc}"),
                probe=probe,
                options=options,
            )
    finally:
        seccomp_filter.close()

    if run.timed_out:
        _clean_known_artifacts(output_directory)
        _discard_unexpected(output_directory, before, preserve)
        return _error_result(
            f"Sandboxed build timed out after {validated.options.timeout_seconds} seconds.",
            probe=probe,
            options=options,
            timed_out=True,
            exit_code=run.exit_code,
            duration_ms=run.duration_ms,
        )

    payload = _parse_result_payload(run.stdout)
    if payload is None:
        _clean_known_artifacts(output_directory)
        stderr_lines = run.stderr.strip().splitlines()
        detail = sanitize("\n".join(stderr_lines[-5:]))
        message = f"Sandboxed build produced no result (exit code {run.exit_code})."
        if detail:
            message = f"{message} {detail}"
        _discard_unexpected(output_directory, before, preserve)
        return _error_result(
            message,
            probe=probe,
            options=options,
            exit_code=run.exit_code,
            duration_ms=run.duration_ms,
        )

    warnings = _sanitize_warnings(payload.get("warnings"), roots)
    if payload.get("success") is not True:
        _clean_known_artifacts(output_directory)
        _discard_unexpected(output_directory, before, preserve)
        raw_error = payload.get("error")
        message = sanitize(raw_error) if isinstance(raw_error, str) else ""
        if not message:
            message = "Sandboxed build failed."
        script_timed_out = isinstance(raw_error, str) and raw_error.startswith(
            "Script execution timed out after"
        )
        return _error_result(
            message,
            probe=probe,
            options=options,
            timed_out=script_timed_out,
            exit_code=run.exit_code,
            duration_ms=run.duration_ms,
            warnings=warnings,
        )

    max_artifact_bytes = validated.options.file_size_limit_mb * 1024 * 1024
    step_path = output_directory / "model.step"
    tess_path = output_directory / "model.tess.json"
    try:
        _stat_artifact(step_path, max_artifact_bytes)
        _stat_artifact(tess_path, max_artifact_bytes)
        metrics = _tessellation_metrics(tess_path)
        if metrics is None:
            metrics = _payload_metrics(payload)
    except SandboxArtifactError as exc:
        _clean_known_artifacts(output_directory)
        _discard_unexpected(output_directory, before, preserve)
        return _error_result(
            sanitize(str(exc)),
            probe=probe,
            options=options,
            exit_code=run.exit_code,
            duration_ms=run.duration_ms,
            warnings=warnings,
        )

    _discard_unexpected(output_directory, before, preserve)
    solid_count, face_count, triangle_count, bounding_box = metrics
    result: dict[str, Any] = {
        "success": True,
        "solidCount": solid_count,
        "faceCount": face_count,
        "triangleCount": triangle_count,
        "boundingBox": bounding_box,
        "tessPath": str(tess_path),
        "stepPath": str(step_path),
        "durationMs": run.duration_ms,
        "timedOut": False,
        "exitCode": run.exit_code,
        "sandbox": _sandbox_info(probe, options),
    }
    if warnings:
        result["warnings"] = warnings
    return result


def _read_request_file(path: Path) -> dict[str, Any]:
    try:
        stat_result = os.lstat(path)
    except OSError as exc:
        raise SandboxValidationError(f"Cannot read the sandbox request: {exc.strerror}.") from exc
    if stat.S_ISLNK(stat_result.st_mode) or not stat.S_ISREG(stat_result.st_mode):
        raise SandboxValidationError("Sandbox request must be a regular file.")
    if stat_result.st_size > MAX_REQUEST_BYTES:
        raise SandboxValidationError("Sandbox request is too large.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise SandboxValidationError("Sandbox request is not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise SandboxValidationError("Sandbox request must be a JSON object.")
    return payload


def _emit(result: dict[str, Any]) -> None:
    print(f"{RESULT_MARKER}{json.dumps(result)}")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="nuke-cad bubblewrap script sandbox")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="Report bubblewrap availability")
    mode.add_argument("--request", default=None, help="Run one JSON sandbox request")
    args = parser.parse_args(argv)

    if args.probe:
        _emit(probe_bwrap().to_status())
        return 0

    request_path = Path(args.request)
    try:
        request = _read_request_file(request_path)
    except SandboxValidationError as exc:
        probe = probe_bwrap()
        _emit(_error_result(str(exc), probe=probe, options=_default_options()))
        return 1

    result = run_sandboxed_build(request, request_path=request_path)
    _emit(result)
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
