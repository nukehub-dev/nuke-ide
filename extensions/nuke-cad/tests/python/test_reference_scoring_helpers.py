"""Edge-case coverage for the topological fingerprint scorer helpers."""

from __future__ import annotations

import math

from reference_scoring import (
    EdgeFingerprint,
    FaceFingerprint,
    _direction_similarity_abs,
    _edge_center,
    _face_orientation_similarity,
    _is_finite_fingerprint,
    _normal_similarity,
    _normalized_ratio,
    _safe_exp_distance,
)


def _face(**overrides):
    values = {
        "surface_type": "plane",
        "area": 1.0,
        "center": (0.0, 0.0, 0.0),
        "normal": (0.0, 0.0, 1.0),
    }
    values.update(overrides)
    return FaceFingerprint(**values)


def _edge(**overrides):
    values = {
        "curve_type": "line",
        "length": 1.0,
        "start": (0.0, 0.0, 0.0),
        "end": (1.0, 0.0, 0.0),
    }
    values.update(overrides)
    return EdgeFingerprint(**values)


def test_non_finite_fingerprint_fields_are_rejected():
    assert _is_finite_fingerprint(_face(area=math.inf)) is False
    assert _is_finite_fingerprint(_face(center=(0.0, math.nan, 0.0))) is False
    assert _is_finite_fingerprint(_face(normal=None, area=math.nan)) is False
    assert (
        _is_finite_fingerprint(
            _face(axis={"origin": (0.0, 0.0, math.inf), "direction": (1.0, 0.0, 0.0)})
        )
        is False
    )
    assert (
        _is_finite_fingerprint(
            _face(axis={"origin": (0.0, 0.0, 0.0), "direction": (1.0, 0.0, 0.0)}, radius=math.inf)
        )
        is False
    )
    assert _is_finite_fingerprint(_face(minor_radius=math.nan)) is False
    assert _is_finite_fingerprint(_edge(length=math.inf)) is False
    assert _is_finite_fingerprint(_edge(start=(0.0, math.nan, 0.0))) is False
    assert _is_finite_fingerprint(_edge(center=(0.0, 0.0, math.inf))) is False
    assert _is_finite_fingerprint(object()) is False


def test_similarity_helpers_handle_zero_and_missing_directions():
    assert _safe_exp_distance(1.0, 0.0) == math.exp(-1.0 / 1e-12)
    assert _normalized_ratio(0.0, 0.0) == 1.0
    assert _normalized_ratio(-1.0, -2.0) == 1.0
    assert _normalized_ratio(1.0, 0.0) == 0.0

    assert _direction_similarity_abs(None, (1.0, 0.0, 0.0)) == 1.0
    assert _direction_similarity_abs((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)) == 1.0
    assert _direction_similarity_abs((1.0, 0.0, 0.0), (-1.0, 0.0, 0.0)) == 1.0

    assert _normal_similarity(None, (1.0, 0.0, 0.0)) == 1.0
    assert _normal_similarity((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)) == 1.0
    assert _normal_similarity((0.0, 0.0, 1.0), (0.0, 0.0, -1.0)) == 0.0


def test_edge_center_falls_back_to_the_midpoint():
    assert _edge_center(_edge(center=(1.0, 2.0, 3.0))) == (1.0, 2.0, 3.0)
    assert _edge_center(_edge(start=(0.0, 0.0, 0.0), end=(2.0, 4.0, 6.0))) == (1.0, 2.0, 3.0)


def test_face_orientation_uses_the_axis_or_the_default():
    cylinder = _face(normal=None, axis={"origin": (0.0, 0.0, 0.0), "direction": (0.0, 0.0, 1.0)})
    reversed_axis = _face(
        normal=None, axis={"origin": (0.0, 0.0, 0.0), "direction": (0.0, 0.0, -1.0)}
    )
    assert _face_orientation_similarity(cylinder, reversed_axis) == 1.0
    assert _face_orientation_similarity(_face(normal=None), _face(normal=None)) == 1.0
