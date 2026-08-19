"""Tests for the OCP-bound fingerprint extractor/resolver.

The OCP-dependent specs are skipped in the minimal pytest profile via
``pytest.importorskip('OCP')``.  The import-cleanliness test at the bottom
forces OCP absence so the module-level guard is verified even on full envs.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest
from reference_resolver import HAS_OCP


def _axis(
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    direction: tuple[float, float, float] = (0.0, 0.0, 1.0),
) -> dict[str, tuple[float, float, float]]:
    return {"origin": origin, "direction": direction}


def _make_box(width: float, depth: float, height: float) -> Any:
    pytest.importorskip("build123d")
    from build123d import Box

    return Box(width, depth, height).wrapped


def _make_cylinder(radius: float, height: float) -> Any:
    pytest.importorskip("build123d")
    from build123d import Cylinder

    return Cylinder(radius=radius, height=height).wrapped


def _make_torus(major_radius: float, minor_radius: float) -> Any:
    pytest.importorskip("build123d")
    from build123d import Torus

    return Torus(major_radius=major_radius, minor_radius=minor_radius).wrapped


def _translate_shape(shape: Any, dx: float, dy: float, dz: float) -> Any:
    pytest.importorskip("OCP")
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Trsf, gp_Vec

    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(dx, dy, dz))
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_extract_face_fingerprints_from_box() -> None:
    import numpy as np
    from reference_resolver import extract_face_fingerprints

    shape = _make_box(2.0, 3.0, 4.0)
    faces = extract_face_fingerprints(shape)
    assert len(faces) == 6
    assert all(f.surface_type == "plane" for f in faces)

    areas = sorted(f.area for f in faces)
    expected = sorted([6.0, 6.0, 8.0, 8.0, 12.0, 12.0])
    np.testing.assert_allclose(areas, expected, rtol=0.01)

    right_faces = [f for f in faces if np.isclose(f.area, 12.0) and np.isclose(f.center[0], 1.0)]
    assert len(right_faces) == 1
    assert right_faces[0].normal is not None
    assert np.isclose(abs(np.dot(right_faces[0].normal, (1.0, 0.0, 0.0))), 1.0)

    # Opposite faces are distinct candidates despite equal area.
    left_faces = [f for f in faces if np.isclose(f.area, 12.0) and np.isclose(f.center[0], -1.0)]
    assert len(left_faces) == 1
    assert right_faces[0].candidate_id != left_faces[0].candidate_id


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_extract_face_fingerprints_from_cylinder() -> None:
    import numpy as np
    from reference_resolver import extract_face_fingerprints

    shape = _make_cylinder(1.0, 2.0)
    faces = extract_face_fingerprints(shape)
    assert len(faces) == 3

    by_type = {f.surface_type: f for f in faces}
    assert "cylinder" in by_type
    assert "plane" in by_type

    cyl = by_type["cylinder"]
    assert np.isclose(cyl.area, 2.0 * np.pi * 1.0 * 2.0, rtol=0.01)
    assert cyl.axis is not None
    assert np.isclose(abs(np.dot(cyl.axis["direction"], (0.0, 0.0, 1.0))), 1.0)
    assert cyl.radius is not None
    assert np.isclose(cyl.radius, 1.0, rtol=0.01)

    caps = [f for f in faces if f.surface_type == "plane"]
    assert len(caps) == 2
    for cap in caps:
        assert np.isclose(cap.area, np.pi * 1.0**2, rtol=0.01)
        assert cap.normal is not None
        assert np.isclose(abs(np.dot(cap.normal, (0.0, 0.0, 1.0))), 1.0)


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_extract_face_fingerprints_from_torus() -> None:
    import numpy as np
    from reference_resolver import extract_face_fingerprints

    shape = _make_torus(5.0, 1.0)
    faces = extract_face_fingerprints(shape)
    assert len(faces) == 1
    torus = faces[0]
    assert torus.surface_type == "torus"
    assert torus.axis is not None
    assert np.isclose(torus.radius, 5.0, rtol=0.01)
    assert np.isclose(torus.minor_radius, 1.0, rtol=0.01)


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_extract_edge_fingerprints_from_box() -> None:
    import numpy as np
    from reference_resolver import extract_edge_fingerprints

    shape = _make_box(2.0, 3.0, 4.0)
    edges = extract_edge_fingerprints(shape)
    assert len(edges) == 12

    lengths = sorted(e.length for e in edges)
    expected = sorted([2.0] * 4 + [3.0] * 4 + [4.0] * 4)
    np.testing.assert_allclose(lengths, expected, rtol=0.01)

    assert all(e.curve_type == "line" for e in edges)


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_resolve_translated_box_round_trip() -> None:
    from reference_resolver import extract_face_fingerprints, resolve_references

    box_a = _make_box(2.0, 3.0, 4.0)
    refs = extract_face_fingerprints(box_a)
    largest_ref = refs[0]

    box_b = _translate_shape(box_a, 1.0, 0.0, 0.0)
    result = resolve_references(
        [largest_ref],
        box_b,
        tolerance_scale=5.0,
        ambiguity_margin=0.05,
    )
    assert len(result.matches) == 1
    assert result.matches[0].status == "matched"
    assert result.matches[0].score > 0.9


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_resolve_box_face_against_cylinder_is_broken() -> None:
    from reference_resolver import extract_face_fingerprints, resolve_references

    box = _make_box(2.0, 3.0, 4.0)
    ref = extract_face_fingerprints(box)[0]

    cylinder = _make_cylinder(1.0, 2.0)
    result = resolve_references(
        [ref],
        cylinder,
        tolerance_scale=1.0,
        ambiguity_margin=0.05,
    )
    # The two identical planar caps make any planar match ambiguous; the
    # cylindrical face is a different type and scores 0.
    assert result.matches[0].status in ("unmatched", "ambiguous")
    assert result.matches[0].score < 0.7


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_candidate_ids_are_deterministic() -> None:
    from reference_resolver import extract_face_fingerprints

    shape = _make_box(2.0, 3.0, 4.0)
    first = extract_face_fingerprints(shape)
    second = extract_face_fingerprints(shape)
    assert [f.candidate_id for f in first] == [f.candidate_id for f in second]
    assert first[0].candidate_id == "face_0001"


@pytest.mark.skipif(not HAS_OCP, reason="OCP not available")
def test_extraction_guard_skips_bad_entities(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failing per-entity extractor must not abort the whole extraction."""
    from reference_resolver import _extract_face_fingerprint, extract_face_fingerprints

    shape = _make_box(2.0, 3.0, 4.0)
    call_count = 0
    original = _extract_face_fingerprint

    def _bad_extractor(face: Any) -> Any:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return None
        return original(face)

    monkeypatch.setattr(
        "reference_resolver._extract_face_fingerprint",
        _bad_extractor,
    )
    warnings: list[str] = []
    faces = extract_face_fingerprints(shape, warnings=warnings)
    # One face was skipped; extraction must still complete for the remaining 5.
    assert len(faces) == 5
    assert len(warnings) >= 1


def test_imports_cleanly_when_ocp_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """The resolver module must import without OCP and surface clear errors."""
    import importlib

    for modname in list(sys.modules):
        if modname == "OCP" or modname.startswith("OCP."):
            monkeypatch.setitem(sys.modules, modname, None)

    for modname in list(sys.modules):
        if modname in ("reference_resolver", "reference_scoring"):
            monkeypatch.delitem(sys.modules, modname, raising=False)

    import reference_resolver

    importlib.reload(reference_resolver)
    assert reference_resolver.HAS_OCP is False
    with pytest.raises(RuntimeError, match="requires OCP"):
        reference_resolver.extract_face_fingerprints(None)
    with pytest.raises(RuntimeError, match="requires OCP"):
        reference_resolver.extract_edge_fingerprints(None)
    with pytest.raises(RuntimeError, match="requires OCP"):
        reference_resolver.resolve_references([], None)
