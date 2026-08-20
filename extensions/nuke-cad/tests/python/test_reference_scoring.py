"""Tests for the topological fingerprint scorer (pure logic, minimal profile)."""

from __future__ import annotations

import pytest
from reference_scoring import (
    EdgeFingerprint,
    FaceFingerprint,
    MatchResult,
    match_references,
    score_fingerprint,
)


def _axis(
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    direction: tuple[float, float, float] = (0.0, 0.0, 1.0),
) -> dict[str, tuple[float, float, float]]:
    return {"origin": origin, "direction": direction}


def _face(
    *,
    surface_type: str = "plane",
    area: float = 10.0,
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    normal: tuple[float, float, float] | None = (0.0, 0.0, 1.0),
    axis: dict[str, tuple[float, float, float]] | None = None,
    radius: float | None = None,
    minor_radius: float | None = None,
    candidate_id: str | None = None,
    reference_id: str | None = None,
) -> FaceFingerprint:
    return FaceFingerprint(
        surface_type=surface_type,
        area=area,
        center=center,
        normal=normal,
        axis=axis,
        radius=radius,
        minor_radius=minor_radius,
        candidate_id=candidate_id,
        reference_id=reference_id,
    )


def _edge(
    *,
    curve_type: str = "line",
    length: float = 5.0,
    start: tuple[float, float, float] = (0.0, 0.0, 0.0),
    end: tuple[float, float, float] = (5.0, 0.0, 0.0),
    center: tuple[float, float, float] | None = None,
    candidate_id: str | None = None,
) -> EdgeFingerprint:
    return EdgeFingerprint(
        curve_type=curve_type,
        length=length,
        start=start,
        end=end,
        center=center,
        candidate_id=candidate_id,
    )


def test_face_to_dict_matches_ts_contract() -> None:
    face = _face(
        surface_type="torus",
        area=20.0,
        center=(1.0, 2.0, 3.0),
        normal=None,
        axis=_axis(origin=(0.0, 0.0, 0.0), direction=(0.0, 0.0, 1.0)),
        radius=5.0,
        minor_radius=2.0,
    )
    data = face.to_dict()
    expected_keys = {"surfaceType", "area", "center", "axis", "radius", "minorRadius"}
    assert set(data.keys()) == expected_keys
    assert data["surfaceType"] == "torus"
    assert data["minorRadius"] == 2.0
    assert data["axis"] == {"origin": (0.0, 0.0, 0.0), "direction": (0.0, 0.0, 1.0)}
    assert "candidate_id" not in data
    assert "reference_id" not in data


def test_edge_to_dict_matches_ts_contract() -> None:
    edge = _edge(curve_type="circle", length=6.28, start=(0.0, 0.0, 0.0), end=(0.0, 0.0, 0.0))
    data = edge.to_dict()
    expected_keys = {"curveType", "length", "start", "end"}
    assert set(data.keys()) == expected_keys
    assert data["curveType"] == "circle"


def test_identical_face_score_is_one() -> None:
    face = _face()
    assert score_fingerprint(face, face) == pytest.approx(1.0)


def test_identical_edge_score_is_one() -> None:
    edge = _edge()
    assert score_fingerprint(edge, edge) == pytest.approx(1.0)


def test_identical_reference_matches() -> None:
    face = _face()
    result = match_references([face], [face], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert isinstance(result, MatchResult)
    assert len(result.matches) == 1
    assert result.matches[0].status == "matched"
    assert result.matches[0].score == pytest.approx(1.0)
    assert result.matches[0].candidate_id == face.candidate_id


def test_translated_center_lowers_score() -> None:
    ref = _face()
    cand = _face(center=(0.5, 0.0, 0.0))
    score = score_fingerprint(ref, cand, tolerance_scale=1.0)
    assert 0.0 < score < 1.0


def test_opposite_normal_faces_score_low() -> None:
    ref = _face(normal=(0.0, 0.0, 1.0))
    cand = _face(normal=(0.0, 0.0, -1.0))
    score = score_fingerprint(ref, cand)
    # Identical except opposite normal: orientation component is 0.
    assert score == pytest.approx(0.8)


def test_flipped_axis_cylinders_score_high() -> None:
    ref = _face(
        surface_type="cylinder", normal=None, axis=_axis(direction=(0.0, 0.0, 1.0)), radius=2.0
    )
    cand = _face(
        surface_type="cylinder", normal=None, axis=_axis(direction=(0.0, 0.0, -1.0)), radius=2.0
    )
    score = score_fingerprint(ref, cand)
    assert score == pytest.approx(1.0)


def test_wrong_surface_type_is_unmatched() -> None:
    ref = _face(surface_type="plane")
    cand = _face(surface_type="cylinder", axis=_axis(), radius=2.0)
    assert score_fingerprint(ref, cand) == pytest.approx(0.0)
    result = match_references([ref], [cand], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "unmatched"


def test_wrong_curve_type_is_unmatched() -> None:
    ref = _edge(curve_type="line")
    cand = _edge(curve_type="circle", center=(2.5, 0.0, 0.0))
    assert score_fingerprint(ref, cand) == pytest.approx(0.0)
    result = match_references([ref], [cand], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "unmatched"


def test_two_identical_candidates_are_ambiguous() -> None:
    ref = _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0))
    cands = [
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), candidate_id="f1"),
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), candidate_id="f2"),
    ]
    result = match_references([ref], cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "ambiguous"
    assert result.matches[0].score == pytest.approx(1.0)


def test_no_near_candidate_is_unmatched() -> None:
    ref = _face(area=100.0, center=(0.0, 0.0, 0.0))
    # Opposite normal (orientation = 0), tiny area, and far away.
    cands = [
        _face(
            area=1.0,
            center=(100.0, 0.0, 0.0),
            normal=(0.0, 0.0, -1.0),
            candidate_id="far",
        )
    ]
    result = match_references([ref], cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "unmatched"
    assert result.matches[0].candidate_id is None


def test_margin_edge_cases() -> None:
    ref = _face(area=10.0, center=(0.0, 0.0, 0.0))
    runner_distance = 0.2231435513
    cands = [
        _face(area=10.0, center=(0.0, 0.0, 0.0), candidate_id="best"),
        _face(
            area=10.0,
            center=(runner_distance, 0.0, 0.0),
            candidate_id="runner",
        ),
    ]

    # Gap == margin -> ambiguous.
    result = match_references([ref], cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "ambiguous"

    # Gap > margin -> matched.
    result = match_references([ref], cands, tolerance_scale=1.0, ambiguity_margin=0.01)
    assert result.matches[0].status == "matched"
    assert result.matches[0].candidate_id == "best"


def test_threshold_edge_cases() -> None:
    ref = _face(area=10.0, center=(0.0, 0.0, 0.0))
    cand = _face(area=10.0, center=(10.0, 0.0, 0.0), candidate_id="boundary")
    result = match_references(
        [ref],
        [cand],
        tolerance_scale=10.0,
        ambiguity_margin=0.05,
    )
    assert result.matches[0].status == "matched"

    far = _face(
        area=1.0,
        center=(100.0, 0.0, 0.0),
        normal=(0.0, 0.0, -1.0),
        candidate_id="far",
    )
    result = match_references([ref], [far], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "unmatched"


def test_one_to_one_assigns_distinct_candidates() -> None:
    refs = [
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), reference_id="r1"),
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), reference_id="r2"),
    ]
    cands = [
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), candidate_id="f1"),
        _face(area=12.0, center=(0.0, 0.0, 0.0), normal=(0.0, 0.0, 1.0), candidate_id="f2"),
    ]
    result = match_references(refs, cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    ids = {m.candidate_id for m in result.matches}
    assert len(ids) == 2
    assert None not in ids


def test_one_to_one_leaves_second_ref_without_candidate() -> None:
    refs = [
        _face(area=12.0, center=(0.0, 0.0, 0.0), reference_id="r1"),
        _face(area=12.0, center=(0.0, 0.0, 0.0), reference_id="r2"),
    ]
    cands = [_face(area=12.0, center=(0.0, 0.0, 0.0), candidate_id="only")]
    result = match_references(refs, cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    statuses = {m.status for m in result.matches}
    assert statuses == {"matched", "unmatched"}
    assigned = [m for m in result.matches if m.status == "matched"]
    assert len(assigned) == 1
    unassigned = [m for m in result.matches if m.status == "unmatched"]
    assert len(unassigned) == 1


def test_match_result_helpers() -> None:
    ref = _face()
    cands = [
        _face(candidate_id="a"),
        _face(candidate_id="b"),
    ]
    result = match_references([ref], cands, tolerance_scale=1.0, ambiguity_margin=0.05)
    assert len(result.broken()) == 1
    assert len(result.matched()) == 0


def test_radius_similarity_contributes() -> None:
    ref = _face(surface_type="cylinder", axis=_axis(), radius=5.0)
    same = _face(surface_type="cylinder", axis=_axis(), radius=5.0)
    different = _face(surface_type="cylinder", axis=_axis(), radius=8.0)
    assert score_fingerprint(ref, same) > score_fingerprint(ref, different)


def test_torus_minor_radius_contributes() -> None:
    ref = _face(surface_type="torus", axis=_axis(), radius=5.0, minor_radius=1.0)
    same = _face(surface_type="torus", axis=_axis(), radius=5.0, minor_radius=1.0)
    different = _face(surface_type="torus", axis=_axis(), radius=5.0, minor_radius=2.0)
    assert score_fingerprint(ref, same) > score_fingerprint(ref, different)


def test_empty_reference_list_returns_empty_result() -> None:
    result = match_references([], [], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches == []


def test_empty_candidate_list_is_unmatched() -> None:
    result = match_references([_face()], [], tolerance_scale=1.0, ambiguity_margin=0.05)
    assert result.matches[0].status == "unmatched"
    assert result.matches[0].score == 0.0


def test_mismatched_fingerprint_kinds_score_zero() -> None:
    face = _face()
    edge = _edge()
    assert score_fingerprint(face, edge) == pytest.approx(0.0)


def test_non_finite_values_score_zero() -> None:
    ref = _face()
    nan_face = _face(center=(float("nan"), 0.0, 0.0))
    inf_face = _face(area=float("inf"))
    assert score_fingerprint(ref, nan_face) == pytest.approx(0.0)
    assert score_fingerprint(ref, inf_face) == pytest.approx(0.0)


def test_circle_orientation_is_ignored() -> None:
    """Closed curves have start == end, so direction similarity is skipped."""
    ref = _edge(curve_type="circle", length=6.28, start=(0.0, 0.0, 0.0), end=(0.0, 0.0, 0.0))
    cand = _edge(curve_type="circle", length=6.28, start=(0.0, 0.0, 0.0), end=(0.0, 0.0, 0.0))
    assert score_fingerprint(ref, cand) == pytest.approx(1.0)


def test_ellipse_orientation_is_ignored() -> None:
    ref = _edge(curve_type="ellipse", length=10.0, start=(0.0, 0.0, 0.0), end=(0.0, 0.0, 0.0))
    cand = _edge(curve_type="ellipse", length=10.0, start=(0.0, 0.0, 0.0), end=(0.0, 0.0, 0.0))
    assert score_fingerprint(ref, cand) == pytest.approx(1.0)


def test_non_finite_edge_values_score_zero() -> None:
    ref = _edge()
    nan_edge = _edge(start=(float("nan"), 0.0, 0.0))
    assert score_fingerprint(ref, nan_edge) == pytest.approx(0.0)
