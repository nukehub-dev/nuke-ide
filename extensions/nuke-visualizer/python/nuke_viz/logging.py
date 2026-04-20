"""
Structured logging utilities for NukeIDE Python backends.

Provides helpers for emitting structured messages that the Node backend
can detect and route to the frontend.
"""

import json
import sys


def warning(message: str, warning_type: str = "generic", **extra) -> None:
    """Emit a structured warning message to stdout.

    The Node backend listens for lines prefixed with NUKE_IDE_WARNING:
    and forwards them to the frontend.

    Args:
        message: Human-readable warning message.
        warning_type: Category of warning (e.g., 'spatial_warning').
        **extra: Additional JSON-serializable fields.
    """
    payload = {"type": warning_type, "message": message, **extra}
    print(f"NUKE_IDE_WARNING:{json.dumps(payload)}", flush=True)


def info(message: str) -> None:
    """Emit an info message to stderr (won't pollute JSON stdout)."""
    print(f"[NukeViz] {message}", file=sys.stderr, flush=True)


def error(message: str) -> None:
    """Emit an error message to stderr."""
    print(f"[NukeViz] ERROR: {message}", file=sys.stderr, flush=True)
