"""Tests for plugins.base.lib.common — pure utility functions.

This module has numpy at its top level, so the whole test module is
skipped when numpy is unavailable.
"""

import socket

import pytest

np = pytest.importorskip('numpy')

from plugins.base.lib.common import (  # noqa: E402
    calculate_camera_position,
    find_free_port,
    hex_to_rgb,
    verify_or_find_port,
)


def test_hex_to_rgb_known_values():
    """Primary colors and arbitrary hex strings convert to 0-1 floats."""
    assert hex_to_rgb('#ff0000') == [1.0, 0.0, 0.0]
    assert hex_to_rgb('#00ff00') == [0.0, 1.0, 0.0]
    assert hex_to_rgb('#0000ff') == [0.0, 0.0, 1.0]
    # Leading '#' is optional.
    assert hex_to_rgb('ffffff') == [1.0, 1.0, 1.0]
    assert hex_to_rgb('#000000') == [0.0, 0.0, 0.0]

    rgb = hex_to_rgb('#1a1a26')
    assert rgb == pytest.approx([26 / 255, 26 / 255, 38 / 255])


def test_hex_to_rgb_ignores_extra_digits():
    """Only the first six hex digits are used."""
    assert hex_to_rgb('#ff0000ff') == [1.0, 0.0, 0.0]


def test_hex_to_rgb_invalid_returns_none():
    """Short or non-hex input yields None instead of raising."""
    assert hex_to_rgb('#fff') is None
    assert hex_to_rgb('') is None
    assert hex_to_rgb('#gggggg') is None
    assert hex_to_rgb(None) is None


def test_calculate_camera_position_front_and_back():
    """Front/back views sit on the y axis at 2.2x the diagonal."""
    bounds = [-1, 1, -1, 1, -1, 1]
    diagonal = (12 ** 0.5)
    distance = diagonal * 2.2

    pos, focal, up = calculate_camera_position('front', bounds)
    assert pos == pytest.approx([0, -distance, 0])
    assert focal == pytest.approx([0, 0, 0])
    assert up == [0, 0, 1]

    pos, _, _ = calculate_camera_position('back', bounds)
    assert pos == pytest.approx([0, distance, 0])


def test_calculate_camera_position_left_right_top_bottom():
    """Side and top/bottom views sit on the x and z axes."""
    bounds = [-1, 1, -1, 1, -1, 1]
    distance = (12 ** 0.5) * 2.2

    assert calculate_camera_position('left', bounds)[0] == pytest.approx([-distance, 0, 0])
    assert calculate_camera_position('right', bounds)[0] == pytest.approx([distance, 0, 0])

    pos, _, up = calculate_camera_position('top', bounds)
    assert pos == pytest.approx([0, 0, distance])
    assert up == [0, 1, 0]

    pos, _, up = calculate_camera_position('bottom', bounds)
    assert pos == pytest.approx([0, 0, -distance])
    assert up == [0, -1, 0]


def test_calculate_camera_position_off_center_bounds():
    """The focal point tracks the bounds center, not the origin."""
    bounds = [10, 20, -5, 5, 100, 200]
    _, focal, _ = calculate_camera_position('front', bounds)
    assert focal == pytest.approx([15.0, 0.0, 150.0])


def test_calculate_camera_position_unknown_view_falls_back_to_isometric():
    """An unrecognized view type returns the isometric configuration."""
    bounds = [-1, 1, -1, 1, -1, 1]
    assert calculate_camera_position('weird', bounds) == calculate_camera_position('isometric', bounds)


def test_calculate_camera_position_zero_diagonal():
    """Degenerate (point-like) bounds fall back to distance 5."""
    pos, focal, _ = calculate_camera_position('right', [0, 0, 0, 0, 0, 0])
    assert pos == pytest.approx([5, 0, 0])
    assert focal == pytest.approx([0, 0, 0])


def test_find_free_port_returns_bindable_port():
    """The returned port can actually be bound on this host."""
    port = find_free_port(start_port=39100, max_port=39200)
    assert 39100 <= port < 39200

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', port))  # must not raise


def test_find_free_port_skips_occupied_port():
    """An occupied port in the range is skipped over."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as blocker:
        blocker.bind(('', 0))
        occupied = blocker.getsockname()[1]

        port = find_free_port(start_port=occupied, max_port=occupied + 50)
        assert port != occupied
        assert occupied < port < occupied + 50


def test_verify_or_find_port_returns_free_preferred_port():
    """A free preferred port is used as-is."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('', 0))
        free_port = probe.getsockname()[1]

    assert verify_or_find_port(free_port) == free_port


def test_verify_or_find_port_falls_back_when_occupied():
    """An occupied preferred port triggers the fallback range search."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as blocker:
        blocker.bind(('', 0))
        occupied = blocker.getsockname()[1]

        port = verify_or_find_port(occupied, fallback_start=39200, fallback_max=39300)
        assert port != occupied
        assert 39200 <= port < 39300

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('', port))  # fallback port must be bindable
