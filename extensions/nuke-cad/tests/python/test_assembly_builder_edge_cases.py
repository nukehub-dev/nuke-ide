#!/usr/bin/env python3
# Copyright (C) 2024 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Edge-case coverage for the nuke-cad assembly builder.

Focuses on structural validation messages, guarded import flags, source
loading failures, scale/transform branches, overlap-check fallbacks, and the
``build_assembly_shape`` error contract. Geometry stays small (single boxes)
and the full document pipeline is stubbed so the suite stays fast.
"""

from __future__ import annotations

import builtins
import copy
import importlib
import json
import sys
import types
from pathlib import Path

import assembly_builder as ab
import pytest

np = pytest.importorskip("numpy", reason="numpy is required for the assembly oracle")


def _placement(position: list[float], orientation: list[float] | None = None) -> dict:
    return {"position": position, "orientation": orientation or [0.0, 0.0, 0.0, 1.0]}


def _connector(cid: str, owner: str, origin: list[float]) -> dict:
    return {
        "id": cid,
        "instanceId": owner,
        "origin": origin,
        "xAxis": [1.0, 0.0, 0.0],
        "yAxis": [0.0, 1.0, 0.0],
    }


def _mate(mid: str, mtype: str, a: str, ca: str, b: str, cb: str) -> dict:
    return {
        "id": mid,
        "type": mtype,
        "instanceA": a,
        "connectorA": ca,
        "instanceB": b,
        "connectorB": cb,
    }


def _valid_assembly() -> dict:
    return {
        "instances": [
            {"id": "a", "part": "body:a", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "b", "part": "body:b", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("ca", "a", [0.0, 0.0, 0.0]),
            _connector("cb", "b", [0.0, 0.0, 0.0]),
        ],
        "mates": [_mate("m", "fixed", "a", "ca", "b", "cb")],
        "groundedInstanceId": "a",
    }


def _require_ocp():
    return pytest.importorskip("OCP", reason="OCP not installed")


def _box_solid(size: float = 10.0):
    _require_ocp()
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(0.0, 0.0, 0.0), gp_Pnt(size, size, size)).Shape()


def _identity() -> list[float]:
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def _body_assembly_doc(part: str = "body:base") -> dict:
    return {
        "version": 3,
        "bodies": [{"id": "base", "name": "base", "label": "base-label"}],
        "assembly": {
            "instances": [{"id": "inst", "part": part, "placement": _placement([0.0, 0.0, 0.0])}],
            "connectors": [],
            "mates": [],
            "groundedInstanceId": "inst",
        },
    }


class _Bounds:
    def __init__(self, min_point, max_point):
        self.min = min_point
        self.max = max_point


class _FakeSolid:
    def __init__(self, bounds=None, error: Exception | None = None, volume: float = 0.0):
        self._bounds = bounds or _Bounds([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        self._error = error
        self._volume = volume

    def bounding_box(self):
        return self._bounds

    def __and__(self, _other):
        if self._error is not None:
            raise self._error
        return types.SimpleNamespace(volume=self._volume)


# ---------------------------------------------------------------------------
# Import guards and scalar validation
# ---------------------------------------------------------------------------


def test_module_reload_guards_missing_builders(tmp_path: Path) -> None:
    """Absent feature/curve builders re-import to flags, never a crash."""
    original_flags = (ab.HAS_FEATURE_BUILDER, ab.HAS_CURVE_BUILDER)
    module_dir = str(Path(ab.__file__).parent.resolve())
    symlink_dir = tmp_path / "python-link"
    symlink_dir.symlink_to(module_dir, target_is_directory=True)
    original_path = list(sys.path)
    sys.path[:] = [str(symlink_dir) if entry == module_dir else entry for entry in sys.path]
    real_import = builtins.__import__

    def _blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name.split(".")[0] in {"feature_builder", "curve_builder"}:
            raise ImportError(f"blocked {name}")
        return real_import(name, globals, locals, fromlist, level)

    try:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(builtins, "__import__", _blocked_import)
            reloaded = importlib.reload(ab)
            assert reloaded.HAS_FEATURE_BUILDER is False
            assert reloaded.feature_builder is None
            assert reloaded.HAS_CURVE_BUILDER is False
            assert reloaded.curve_builder is None
            assert module_dir in sys.path
    finally:
        sys.path[:] = original_path
        importlib.reload(ab)
    assert (ab.HAS_FEATURE_BUILDER, ab.HAS_CURVE_BUILDER) == original_flags


def test_as_vec3_and_as_quaternion_reject_bad_values() -> None:
    with pytest.raises(ab.AssemblyBuildError, match=r"\[x, y, z\]"):
        ab._as_vec3([0.0, 1.0])
    with pytest.raises(ab.AssemblyBuildError, match=r"\[x, y, z\]"):
        ab._as_vec3("nope")
    with pytest.raises(ab.AssemblyBuildError, match=r"\[x, y, z\]"):
        ab._as_vec3([0.0, 1.0, float("nan")])
    with pytest.raises(ab.AssemblyBuildError, match=r"\[x, y, z, w\]"):
        ab._as_quaternion([0.0, 0.0, 1.0])
    with pytest.raises(ab.AssemblyBuildError, match=r"\[x, y, z, w\]"):
        ab._as_quaternion([0.0, 0.0, 0.0, float("inf")])


def test_placement_to_matrix_rejects_non_dict_and_bad_matrix() -> None:
    with pytest.raises(ab.AssemblyBuildError, match="placement must be an object"):
        ab.placement_to_matrix(None)
    with pytest.raises(ab.AssemblyBuildError, match="16-element array"):
        ab.placement_to_matrix({"matrix": [1.0] * 15})
    with pytest.raises(ab.AssemblyBuildError, match="16-element array"):
        ab.placement_to_matrix({"matrix": [1.0] * 15 + [float("nan")]})


def test_orthonormalize_axes_rejects_degenerate_inputs() -> None:
    with pytest.raises(ab.AssemblyBuildError, match="xAxis has zero length"):
        ab.orthonormalize_axes([0.0, 0.0, 0.0], [0.0, 1.0, 0.0])
    with pytest.raises(ab.AssemblyBuildError, match="parallel to xAxis"):
        ab.orthonormalize_axes([1.0, 0.0, 0.0], [2.0, 0.0, 0.0])
    x, y, z = ab.orthonormalize_axes([1.0, 0.0, 0.0], [0.0, 1.0, 0.0])
    assert (x, y, z) == ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])


def test_valid_scale_accepts_scalars_and_triples() -> None:
    assert ab._valid_scale(2.0) is True
    assert ab._valid_scale([1.0, 2.0, 3.0]) is True
    assert ab._valid_scale(0.0) is False
    assert ab._valid_scale(float("nan")) is False
    assert ab._valid_scale([1.0, 2.0, 0.0]) is False
    assert ab._valid_scale([1.0, 2.0]) is False
    assert ab._valid_scale("2") is False


# ---------------------------------------------------------------------------
# Structural validation
# ---------------------------------------------------------------------------


def _set_instances_object(assembly: dict) -> None:
    assembly["instances"] = {}


def _set_connectors_object(assembly: dict) -> None:
    assembly["connectors"] = {}


def _set_mates_object(assembly: dict) -> None:
    assembly["mates"] = {}


def _append_bad_instance(assembly: dict) -> None:
    assembly["instances"].append(42)


def _blank_instance_id(assembly: dict) -> None:
    assembly["instances"][0]["id"] = ""


def _duplicate_instance_id(assembly: dict) -> None:
    assembly["instances"][1]["id"] = "a"


def _blank_part(assembly: dict) -> None:
    assembly["instances"][0]["part"] = ""


def _drop_placement(assembly: dict) -> None:
    assembly["instances"][0].pop("placement")


def _bad_scale(assembly: dict) -> None:
    assembly["instances"][0]["scale"] = 0


def _drop_grounded(assembly: dict) -> None:
    assembly.pop("groundedInstanceId")


def _unknown_grounded(assembly: dict) -> None:
    assembly["groundedInstanceId"] = "ghost"


def _append_bad_connector(assembly: dict) -> None:
    assembly["connectors"].append(42)


def _blank_connector_id(assembly: dict) -> None:
    assembly["connectors"][0]["id"] = None


def _duplicate_connector_id(assembly: dict) -> None:
    assembly["connectors"][1]["id"] = "ca"


def _unknown_connector_owner(assembly: dict) -> None:
    assembly["connectors"][0]["instanceId"] = "ghost"


def _append_bad_mate(assembly: dict) -> None:
    assembly["mates"].append(42)


def _blank_mate_id(assembly: dict) -> None:
    assembly["mates"][0]["id"] = ""


def _unknown_mate_type(assembly: dict) -> None:
    assembly["mates"][0]["type"] = "weld"


def _unknown_mate_instance(assembly: dict) -> None:
    assembly["mates"][0]["instanceA"] = "ghost"


def _unknown_mate_connector(assembly: dict) -> None:
    assembly["mates"][0]["connectorA"] = "ghost"


def _connector_wrong_owner(assembly: dict) -> None:
    assembly["mates"][0]["connectorA"] = "cb"


def _self_mate(assembly: dict) -> None:
    assembly["mates"][0]["instanceB"] = "a"
    assembly["mates"][0]["connectorB"] = "ca"


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (_set_instances_object, "must be arrays"),
        (_set_connectors_object, "must be arrays"),
        (_set_mates_object, "must be arrays"),
        (_append_bad_instance, "instances\\[2\\] must be an object"),
        (_blank_instance_id, "instances\\[0\\].id"),
        (_duplicate_instance_id, "duplicate assembly instance id"),
        (_blank_part, "needs a non-empty part source"),
        (_drop_placement, "needs a placement object"),
        (_bad_scale, "scale must be positive"),
        (_drop_grounded, "groundedInstanceId must name"),
        (_unknown_grounded, "does not exist"),
        (_append_bad_connector, "connectors\\[2\\] must be an object"),
        (_blank_connector_id, "connectors\\[0\\].id"),
        (_duplicate_connector_id, "duplicate assembly connector id"),
        (_unknown_connector_owner, "references unknown instance"),
        (_append_bad_mate, "mates\\[1\\] must be an object"),
        (_blank_mate_id, "mates\\[0\\].id"),
        (_unknown_mate_type, "unknown type"),
        (_unknown_mate_instance, "references unknown instance"),
        (_unknown_mate_connector, "references unknown connector"),
        (_connector_wrong_owner, "belongs to"),
        (_self_mate, "cannot connect an instance to itself"),
    ],
)
def test_validate_assembly_structure_reports_each_problem(mutate, match) -> None:
    assembly = copy.deepcopy(_valid_assembly())
    mutate(assembly)
    with pytest.raises(ab.AssemblyBuildError, match=match):
        ab._validate_assembly_structure(assembly)


def test_validate_assembly_structure_rejects_non_object() -> None:
    with pytest.raises(ab.AssemblyBuildError, match="assembly section must be an object"):
        ab._validate_assembly_structure([])


def test_grounded_instance_can_be_mate_side_b() -> None:
    """The BFS takes the connector on whichever side is already solved."""
    assembly = {
        "instances": [
            {"id": "a", "part": "body:a", "placement": _placement([10.0, 0.0, 0.0])},
            {"id": "b", "part": "body:b", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("ca", "a", [0.0, 0.0, 0.0]),
            _connector("cb", "b", [1.0, 0.0, 0.0]),
        ],
        # Maze A is "b" and side B is the grounded "a": the solver must use
        # connectorB on the solved side and connectorA on the local side.
        "mates": [_mate("m", "fixed", "b", "cb", "a", "ca")],
        "groundedInstanceId": "a",
    }
    result = ab.solve_assembly_placement(assembly)
    # solved(a) is at x=10; connector ca sits at a's origin, connector cb at
    # b-local x=1, so the closed form places b at 10 - 1 = 9.
    assert result["placements"]["b"][3] == pytest.approx(9.0)
    assert result["placements"]["b"][7] == pytest.approx(0.0)


def test_classify_instance_source_unknown_suffix() -> None:
    assert ab.classify_instance_source("notes.txt", set(), None) == ("missing", None)
    assert ab.classify_instance_source("model.step", set(), None) == ("missing", None)


# ---------------------------------------------------------------------------
# Single-document build and source loading
# ---------------------------------------------------------------------------


def test_build_single_doc_shape_requires_feature_builder(monkeypatch) -> None:
    monkeypatch.setattr(ab, "HAS_FEATURE_BUILDER", False)
    with pytest.raises(ab.AssemblyBuildError, match="requires build123d"):
        ab._build_single_doc_shape({})


class _RaisingBuilder:
    def __init__(self, error: Exception):
        self.error = error

    def build_document_shape(self, _document, **_kwargs):
        raise self.error


def test_build_single_doc_shape_curve_guards(monkeypatch) -> None:
    monkeypatch.setattr(ab, "HAS_FEATURE_BUILDER", True)
    monkeypatch.setattr(ab, "feature_builder", _RaisingBuilder(RuntimeError("unused")))
    document = {"curves": [{"id": "c1"}]}

    monkeypatch.setattr(ab, "HAS_CURVE_BUILDER", False)
    monkeypatch.setattr(ab, "curve_builder", None)
    with pytest.raises(ab.AssemblyBuildError, match="curve builder"):
        ab._build_single_doc_shape(document)

    monkeypatch.setattr(ab, "HAS_CURVE_BUILDER", True)
    monkeypatch.setattr(
        ab,
        "curve_builder",
        types.SimpleNamespace(
            build_curves=lambda _doc: (_ for _ in ()).throw(ValueError("bad curve"))
        ),
    )
    with pytest.raises(ab.AssemblyBuildError, match="curve build failed: bad curve"):
        ab._build_single_doc_shape(document)


def test_build_single_doc_shape_preserves_and_wraps_builder_errors(monkeypatch) -> None:
    monkeypatch.setattr(ab, "HAS_FEATURE_BUILDER", True)

    original = ab.AssemblyBuildError("already structured")
    monkeypatch.setattr(ab, "feature_builder", _RaisingBuilder(original))
    with pytest.raises(ab.AssemblyBuildError, match="already structured"):
        ab._build_single_doc_shape({})

    monkeypatch.setattr(ab, "feature_builder", _RaisingBuilder(ValueError("plain failure")))
    with pytest.raises(ab.AssemblyBuildError, match="assembly part build failed: plain failure"):
        ab._build_single_doc_shape({})


def test_load_document_dict_reports_parse_and_read_errors(tmp_path: Path) -> None:
    broken = tmp_path / "broken.nuke-cad"
    broken.write_text("{", encoding="utf-8")
    with pytest.raises(ab.AssemblyBuildError, match="not valid JSON"):
        ab._load_document_dict(broken, "inst", "broken.nuke-cad")

    with pytest.raises(ab.AssemblyBuildError, match="cannot read part source"):
        ab._load_document_dict(tmp_path, "inst", "broken.nuke-cad")

    array_doc = tmp_path / "array.nuke-cad"
    array_doc.write_text("[]", encoding="utf-8")
    with pytest.raises(ab.AssemblyBuildError, match="must be a JSON object"):
        ab._load_document_dict(array_doc, "inst", "array.nuke-cad")

    good = tmp_path / "good.nuke-cad"
    good.write_text(json.dumps({"version": 3}), encoding="utf-8")
    assert ab._load_document_dict(good, "inst", "good.nuke-cad") == {"version": 3}


def test_load_exchange_solids_dispatches_each_suffix(monkeypatch, tmp_path: Path) -> None:
    import geometry_service as gs

    marker = object()
    monkeypatch.setattr(gs, "_read_step", lambda _path: marker)
    monkeypatch.setattr(gs, "_read_iges", lambda _path: marker)
    monkeypatch.setattr(gs, "_read_brep", lambda _path: marker)
    monkeypatch.setattr(ab, "_explorer_solids", lambda wrapped: [wrapped])

    for name in ("part.step", "part.stp", "part.iges", "part.igs", "part.brep"):
        path = tmp_path / name
        path.write_text("placeholder", encoding="utf-8")
        assert ab._load_exchange_solids(path, "inst", name) == [marker]


def test_load_exchange_solids_reports_failures(monkeypatch, tmp_path: Path) -> None:
    import geometry_service as gs

    with pytest.raises(ab.AssemblyBuildError, match="unsupported part source"):
        ab._load_exchange_solids(tmp_path / "part.txt", "inst", "part.txt")

    def _broken(_path):
        raise RuntimeError("reader exploded")

    monkeypatch.setattr(gs, "_read_step", _broken)
    with pytest.raises(ab.AssemblyBuildError, match="failed to read part source"):
        ab._load_exchange_solids(tmp_path / "part.step", "inst", "part.step")

    monkeypatch.setattr(gs, "_read_step", lambda _path: object())
    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [])
    with pytest.raises(ab.AssemblyBuildError, match="contains no solids"):
        ab._load_exchange_solids(tmp_path / "part.step", "inst", "part.step")


def test_scale_triple_variants() -> None:
    assert ab._scale_triple(None) == (1.0, 1.0, 1.0)
    assert ab._scale_triple(2.0) == (2.0, 2.0, 2.0)
    assert ab._scale_triple([1.0, 2.0, 3.0]) == (1.0, 2.0, 3.0)


def test_place_solid_uniform_and_general_transforms(monkeypatch) -> None:
    _require_ocp()
    import OCP.BRepBuilderAPI as bbox
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = _box_solid()

    def _extent(shape):
        bounds = Bnd_Box()
        BRepBndLib.Add_s(shape, bounds)
        return bounds.CornerMax().X() - bounds.CornerMin().X()

    assert _extent(ab._place_solid(box, _identity(), 2.0)) == pytest.approx(20.0)
    assert _extent(ab._place_solid(box, _identity(), [2.0, 1.0, 1.0])) == pytest.approx(20.0)

    class _FailedTransform:
        def __init__(self, *_args, **_kwargs):
            pass

        def IsDone(self) -> bool:
            return False

    monkeypatch.setattr(bbox, "BRepBuilderAPI_Transform", _FailedTransform)
    with pytest.raises(ab.AssemblyBuildError, match="placement transform failed"):
        ab._place_solid(box, _identity(), None)

    monkeypatch.setattr(bbox, "BRepBuilderAPI_GTransform", _FailedTransform)
    with pytest.raises(ab.AssemblyBuildError, match="placement transform failed"):
        ab._place_solid(box, _identity(), [2.0, 1.0, 1.0])


# ---------------------------------------------------------------------------
# Overlap warnings
# ---------------------------------------------------------------------------


def test_bbox_overlaps_detects_touching_and_separated_boxes() -> None:
    first = _Bounds([0.0, 0.0, 0.0], [10.0, 10.0, 10.0])
    touching = _Bounds([10.0, 10.0, 10.0], [20.0, 20.0, 20.0])
    separated = _Bounds([11.0, 0.0, 0.0], [20.0, 10.0, 10.0])
    assert ab._bbox_overlaps(first, touching) is True
    assert ab._bbox_overlaps(first, separated) is False


def test_instance_overlap_skips_uncastable_solids(monkeypatch) -> None:
    fake = types.ModuleType("build123d")

    def _raising_cast(_solid):
        raise RuntimeError("not a build123d shape")

    fake.Shape = types.SimpleNamespace(cast=_raising_cast)
    monkeypatch.setitem(sys.modules, "build123d", fake)
    assert ab._instance_overlap_warnings([("a", [object()]), ("b", [object()])]) == []


def test_instance_overlap_skips_disjoint_bounding_boxes(monkeypatch) -> None:
    fake = types.ModuleType("build123d")
    fake.Shape = types.SimpleNamespace(cast=lambda solid: solid)
    monkeypatch.setitem(sys.modules, "build123d", fake)
    first = _FakeSolid(bounds=_Bounds([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]))
    second = _FakeSolid(bounds=_Bounds([5.0, 0.0, 0.0], [6.0, 1.0, 1.0]))
    assert ab._instance_overlap_warnings([("a", [first]), ("b", [second])]) == []


def test_instance_overlap_reports_volume_and_skips_empty_compounds(monkeypatch) -> None:
    fake = types.ModuleType("build123d")
    fake.Shape = types.SimpleNamespace(cast=lambda solid: solid)
    monkeypatch.setitem(sys.modules, "build123d", fake)

    warnings = ab._instance_overlap_warnings(
        [("a", [_FakeSolid(volume=2.5)]), ("b", [_FakeSolid()])]
    )
    assert any("overlap" in warning and "2.5" in warning for warning in warnings)

    empty = _FakeSolid(error=ValueError("empty compound"))
    assert ab._instance_overlap_warnings([("a", [empty]), ("b", [_FakeSolid()])]) == []


def test_instance_overlap_uses_real_topods_solids() -> None:
    bd = pytest.importorskip("build123d")
    first = bd.Box(2, 2, 2).wrapped
    second = bd.Box(2, 2, 2).moved(bd.Location((1, 0, 0))).wrapped
    warnings = ab._instance_overlap_warnings([("a", [first]), ("b", [second])])
    assert any("volume" in warning for warning in warnings), warnings
    assert not any("check" in warning and "failed" in warning for warning in warnings), warnings


def test_instance_overlap_returns_empty_when_build123d_is_none(monkeypatch) -> None:
    real_import = builtins.__import__

    def _fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "build123d":
            return None
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", _fake_import)
    assert ab._instance_overlap_warnings([("a", [object()])]) == []


def test_instance_overlap_reraises_assembly_errors(monkeypatch) -> None:
    fake = types.ModuleType("build123d")
    fake.Shape = types.SimpleNamespace(cast=lambda solid: solid)
    monkeypatch.setitem(sys.modules, "build123d", fake)
    boom = ab.AssemblyBuildError("overlap kernel failure")
    groups = [("a", [_FakeSolid(error=boom)]), ("b", [_FakeSolid()])]
    with pytest.raises(ab.AssemblyBuildError, match="overlap kernel failure"):
        ab._instance_overlap_warnings(groups)


# ---------------------------------------------------------------------------
# build_assembly_shape contract and solid extraction
# ---------------------------------------------------------------------------


def test_build_assembly_shape_rejects_non_document_and_missing_section() -> None:
    with pytest.raises(ab.AssemblyBuildError, match="document must be a JSON object"):
        ab.build_assembly_shape([])
    with pytest.raises(ab.AssemblyBuildError, match="no assembly section"):
        ab.build_assembly_shape({"version": 3})


def test_build_assembly_shape_requires_ocp(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "OCP.BRep", None)
    with pytest.raises(ab.AssemblyBuildError, match="requires OCP"):
        ab.build_assembly_shape(_body_assembly_doc())


def test_build_assembly_shape_body_without_solids_explains_why(monkeypatch) -> None:
    _require_ocp()
    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [object()])
    monkeypatch.setattr(
        ab,
        "_build_single_doc_shape",
        lambda _doc, _dir=None: {"shape": object(), "solidBodyIds": ["other"]},
    )
    with pytest.raises(ab.AssemblyBuildError, match="may be consumed by a boolean"):
        ab.build_assembly_shape(_body_assembly_doc())

    def _with_failure(_doc, _dir=None):
        return {
            "shape": object(),
            "solidBodyIds": ["other"],
            "featureResults": [
                {
                    "featureId": "import-1",
                    "bodyId": "base",
                    "status": "failed",
                    "error": "hash changed",
                }
            ],
        }

    monkeypatch.setattr(ab, "_build_single_doc_shape", _with_failure)
    with pytest.raises(ab.AssemblyBuildError, match="hash changed"):
        ab.build_assembly_shape(_body_assembly_doc())


def test_build_assembly_shape_document_part_without_solids(monkeypatch, tmp_path: Path) -> None:
    _require_ocp()
    sub = tmp_path / "sub.nuke-cad"
    sub.write_text(json.dumps({"version": 3}), encoding="utf-8")
    doc = _body_assembly_doc(part="sub.nuke-cad")
    monkeypatch.setattr(ab, "_build_single_doc_shape", lambda _doc, _dir=None: {"shape": None})
    with pytest.raises(ab.AssemblyBuildError, match="produced no solids"):
        ab.build_assembly_shape(doc, document_dir=tmp_path)


def test_build_assembly_shape_wraps_value_errors(monkeypatch) -> None:
    _require_ocp()
    monkeypatch.setattr(
        ab,
        "_build_single_doc_shape",
        lambda _doc, _dir=None: (_ for _ in ()).throw(ValueError("bad part")),
    )
    with pytest.raises(ab.AssemblyBuildError, match="assembly instance 'inst': bad part"):
        ab.build_assembly_shape(_body_assembly_doc())


def test_solids_of_body_guards(monkeypatch) -> None:
    assert ab._solids_of_body({}, "body-1", {}) == []

    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [object(), object()])
    result = {"shape": object(), "solidBodyIds": ["body-1"]}
    assert ab._solids_of_body(result, "body-1", {"body-1": "label"}) == []


def test_solids_of_body_filters_owner_and_labels(monkeypatch) -> None:
    first, second = object(), object()
    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [first, second])
    result = {"shape": object(), "solidBodyIds": ["body-1", "body-2"]}
    pairs = ab._solids_of_body(result, "body-1", {"body-1": "plate"})
    assert pairs == [("plate", first)]


def test_body_failure_detail_skips_non_failed_records() -> None:
    assert (
        ab._body_failure_detail(
            {"featureResults": [{"bodyId": "body-1", "status": "ok", "error": "ignored"}]},
            "body-1",
        )
        is None
    )
    assert (
        ab._body_failure_detail(
            {"featureResults": [{"bodyId": "body-1", "status": "stale", "error": ""}]},
            "body-1",
        )
        is None
    )


def test_solids_of_document_guards(monkeypatch) -> None:
    assert ab._solids_of_document({}, {}) == []

    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [object(), object()])
    result = {"shape": object(), "solidBodyIds": ["body-1"]}
    assert ab._solids_of_document(result, {}) == []


def test_solids_of_document_labels_every_solid(monkeypatch) -> None:
    first, second = object(), object()
    monkeypatch.setattr(ab, "_explorer_solids", lambda _wrapped: [first, second])
    result = {"shape": object(), "solidBodyIds": ["body-1", "body-2"]}
    pairs = ab._solids_of_document(result, {"body-1": "plate", "body-2": None})
    assert pairs == [("plate", first), (None, second)]
