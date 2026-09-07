#!/usr/bin/env python3
"""
Shared pure-Python helpers for NukeIDE visualizer backends.

Only stdlib utilities with no trame/ParaView/vuetify dependency live here:
free-port discovery, hex color conversion, and camera-framing math. (The
trame UI framework that used to live in this module was removed when the
native viewers became primary; the headless extractors under ``plugins/``
need nothing else from here.)
"""

import socket


def find_free_port(start_port: int = 8080, max_port: int = 9000) -> int:
    """Find an available port in the given range."""
    for port in range(start_port, max_port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start_port}-{max_port}")


def verify_or_find_port(
    preferred_port: int, fallback_start: int = 8080, fallback_max: int = 9000
) -> int:
    """Verify a preferred port is free; if not, find an alternative."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("", preferred_port))
            return preferred_port
        except OSError:
            return find_free_port(fallback_start, fallback_max)


def hex_to_rgb(hex_color: str) -> list[float] | None:
    """Convert hex color to RGB list [r, g, b] with values 0-1."""
    try:
        hex_color = str(hex_color).lstrip("#")
        if len(hex_color) >= 6:
            return [
                int(hex_color[0:2], 16) / 255.0,
                int(hex_color[2:4], 16) / 255.0,
                int(hex_color[4:6], 16) / 255.0,
            ]
    except Exception:
        pass
    return None


def calculate_camera_position(
    view_type: str, bounds: list[float]
) -> tuple[list[float], list[float], list[float]]:
    """Calculate camera position, focal point, and view up based on data bounds.

    Args:
        view_type: One of 'isometric', 'front', 'back', 'left', 'right', 'top', 'bottom'
        bounds: Data bounds [xmin, xmax, ymin, ymax, zmin, zmax]

    Returns:
        Tuple of (position, focal_point, view_up)
    """
    xmin, xmax, ymin, ymax, zmin, zmax = bounds

    # Calculate center
    cx = (xmin + xmax) / 2
    cy = (ymin + ymax) / 2
    cz = (zmin + zmax) / 2

    # Calculate diagonal for distance
    dx = xmax - xmin
    dy = ymax - ymin
    dz = zmax - zmin
    diagonal = (dx * dx + dy * dy + dz * dz) ** 0.5

    # Distance factor - use 2.2 to match ParaView ResetCamera framing
    distance = diagonal * 2.2 if diagonal > 0 else 5

    view_configs = {
        "isometric": (
            [cx + distance * 0.7, cy + distance * 0.7, cz + distance * 0.7],
            [cx, cy, cz],
            [0, 0, 1],
        ),
        "front": ([cx, cy - distance, cz], [cx, cy, cz], [0, 0, 1]),
        "back": ([cx, cy + distance, cz], [cx, cy, cz], [0, 0, 1]),
        "left": ([cx - distance, cy, cz], [cx, cy, cz], [0, 0, 1]),
        "right": ([cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]),
        "top": ([cx, cy, cz + distance], [cx, cy, cz], [0, 1, 0]),
        "bottom": ([cx, cy, cz - distance], [cx, cy, cz], [0, -1, 0]),
    }

    return view_configs.get(view_type, view_configs["isometric"])
