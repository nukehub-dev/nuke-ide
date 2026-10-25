#!/usr/bin/env python3
"""Tests for the nuke-cad assembly builder (Wave B1 backend).

Pure placement-math tests run in the minimal pytest profile (pytest + numpy
only); geometry tests (same-document composition, STEP product names, DAGMC
smoke, v3 round-trip) skip unless OCP + build123d are importable. Tests for
dependency-absence guards force the absence via monkeypatched ``sys.modules``
entries rather than assuming the ambient environment.
"""

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

from __future__ import annotations

import json
import subprocess
import sys
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


def _chain_assembly() -> dict:
    """Grounded base -> mid -> tip chain with unit-spaced connectors."""
    return {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "mid", "part": "body:mid", "placement": _placement([50.0, 0.0, 0.0])},
            {"id": "tip", "part": "body:tip", "placement": _placement([99.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("c-base", "base", [1.0, 0.0, 0.0]),
            _connector("c-mid-in", "mid", [0.0, 0.0, 0.0]),
            _connector("c-mid-out", "mid", [0.0, 2.0, 0.0]),
            _connector("c-tip", "tip", [0.0, 0.0, 0.0]),
        ],
        "mates": [
            _mate("m1", "fixed", "base", "c-base", "mid", "c-mid-in"),
            _mate("m2", "fixed", "mid", "c-mid-out", "tip", "c-tip"),
        ],
        "groundedInstanceId": "base",
    }


def _oracle_placement(frame_a: tuple, frame_b: tuple) -> list[float]:
    """Independent numpy oracle for R = Ra.RbT, t = pa - R.pb."""
    origin_a, xa, ya, za = (np.asarray(v, dtype=float) for v in frame_a)
    origin_b, xb, yb, zb = (np.asarray(v, dtype=float) for v in frame_b)
    ra = np.column_stack([xa, ya, za])
    rb = np.column_stack([xb, yb, zb])
    rot = ra @ rb.T
    pos = origin_a - rot @ origin_b
    return [
        float(rot[0, 0]),
        float(rot[0, 1]),
        float(rot[0, 2]),
        float(pos[0]),
        float(rot[1, 0]),
        float(rot[1, 1]),
        float(rot[1, 2]),
        float(pos[1]),
        float(rot[2, 0]),
        float(rot[2, 1]),
        float(rot[2, 2]),
        float(pos[2]),
        0.0,
        0.0,
        0.0,
        1.0,
    ]


# ---------------------------------------------------------------------------
# Pure placement math (minimal profile)
# ---------------------------------------------------------------------------


def test_grounded_keeps_stored_placement() -> None:
    assembly = _chain_assembly()
    result = ab.solve_assembly_placement(assembly)
    assert result["placements"]["base"] == pytest.approx(
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    )
    assert result["warnings"] == []


def test_grounded_first_bfs_chain() -> None:
    """Mid solves from base, tip from mid's *solved* frame (not stored)."""
    result = ab.solve_assembly_placement(_chain_assembly())
    mid = result["placements"]["mid"]
    tip = result["placements"]["tip"]
    # m1: frameA (1,0,0)/I in world, frameB origin at mid-local origin.
    assert mid[3:4] == pytest.approx([1.0])
    assert mid[7] == pytest.approx(0.0) and mid[11] == pytest.approx(0.0)
    # m2: mid's solved placement moves c-mid-out to (1,2,0); tip lands there.
    assert tip[3] == pytest.approx(1.0)
    assert tip[7] == pytest.approx(2.0)
    assert tip[11] == pytest.approx(0.0)


def test_solved_pose_matches_oracle_with_rotated_frame() -> None:
    """Closed form vs the numpy oracle on a non-trivial connector orientation."""
    assembly = {
        "instances": [
            {"id": "a", "part": "body:x", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "b", "part": "body:y", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            {
                "id": "ca",
                "instanceId": "a",
                "origin": [3.0, -1.0, 2.0],
                "xAxis": [0.0, 1.0, 0.0],
                "yAxis": [-1.0, 0.0, 0.0],
            },
            _connector("cb", "b", [0.5, 0.5, 0.5]),
        ],
        "mates": [_mate("m", "fixed", "a", "ca", "b", "cb")],
        "groundedInstanceId": "a",
    }
    result = ab.solve_assembly_placement(assembly)
    frame_a = ([3.0, -1.0, 2.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    frame_b = ([0.5, 0.5, 0.5], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
    assert result["placements"]["b"] == pytest.approx(_oracle_placement(frame_a, frame_b))


def test_unmated_nongrounded_keeps_stored_placement() -> None:
    assembly = _chain_assembly()
    assembly["instances"].append(
        {"id": "free", "part": "body:free", "placement": _placement([7.0, 8.0, 9.0])}
    )
    result = ab.solve_assembly_placement(assembly)
    assert result["placements"]["free"][3] == pytest.approx(7.0)
    assert result["placements"]["free"][7] == pytest.approx(8.0)
    assert result["placements"]["free"][11] == pytest.approx(9.0)


def test_one_mate_per_pair_rejected() -> None:
    assembly = _chain_assembly()
    assembly["mates"].append(_mate("m3", "revolute", "base", "c-base", "mid", "c-mid-in"))
    with pytest.raises(ab.AssemblyBuildError, match="one mate per part pair"):
        ab.solve_assembly_placement(assembly)


def test_negative_dof_is_warning_never_fatal() -> None:
    assembly = {
        "instances": [
            {"id": "a", "part": "body:a", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "b", "part": "body:b", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "c", "part": "body:c", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("ca1", "a", [0.0, 0.0, 0.0]),
            _connector("ca2", "a", [1.0, 0.0, 0.0]),
            _connector("cb1", "b", [0.0, 0.0, 0.0]),
            _connector("cb2", "b", [1.0, 0.0, 0.0]),
            _connector("cc1", "c", [0.0, 0.0, 0.0]),
        ],
        "mates": [
            _mate("m1", "fixed", "a", "ca1", "b", "cb1"),
            _mate("m2", "fixed", "b", "cb2", "c", "cc1"),
            _mate("m3", "revolute", "a", "ca2", "c", "cc1"),
        ],
        "groundedInstanceId": "a",
    }
    assert ab.count_assembly_dof(3, ["fixed", "fixed", "revolute"]) == 6 * 2 - (6 + 6 + 5)
    result = ab.solve_assembly_placement(assembly)
    assert len(result["placements"]) == 3  # solved, not fatal
    assert any("over-constrained" in warning for warning in result["warnings"])


def test_matrix_placement_accepted_and_validated() -> None:
    good = {
        "matrix": [1.0, 0.0, 0.0, 4.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    }
    assert ab.placement_to_matrix(good)[3] == pytest.approx(4.0)
    with pytest.raises(ab.AssemblyBuildError, match="last row"):
        ab.placement_to_matrix({"matrix": [1.0] * 15 + [2.0]})
    with pytest.raises(ab.AssemblyBuildError, match="zero-length"):
        ab.placement_to_matrix(_placement([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]))


def test_missing_source_error_names_instance_and_source() -> None:
    doc = {
        "version": 3,
        "name": "ghost",
        "parameters": {},
        "datums": [],
        "bodies": [],
        "sketches": [],
        "features": [],
        "curves": [],
        "assembly": {
            "instances": [
                {"id": "phantom", "part": "ghost.step", "placement": _placement([0.0, 0.0, 0.0])}
            ],
            "connectors": [],
            "mates": [],
            "groundedInstanceId": "phantom",
        },
    }
    with pytest.raises(ab.AssemblyBuildError, match="phantom"):
        ab.build_assembly_shape(doc)
    try:
        ab.build_assembly_shape(doc)
    except ab.AssemblyBuildError as exc:
        assert "ghost.step" in str(exc)
    else:  # pragma: no cover - the match above already guards
        raise AssertionError("expected AssemblyBuildError")


def test_classify_resolution_order(tmp_path: Path) -> None:
    body_ids = {"plate", "block"}
    assert ab.classify_instance_source("body:plate", body_ids, tmp_path) == ("body", "plate")
    assert ab.classify_instance_source("block", body_ids, tmp_path) == ("body", "block")
    sub = tmp_path / "sub.nuke-cad"
    sub.write_text("{}")
    assert ab.classify_instance_source("sub.nuke-cad", body_ids, tmp_path) == (
        "document",
        str(tmp_path / "sub.nuke-cad"),
    )
    step = tmp_path / "part.step"
    step.write_text("not a step")
    assert ab.classify_instance_source("part.step", body_ids, tmp_path) == (
        "exchange",
        str(tmp_path / "part.step"),
    )
    # Same-document body wins over any file reading.
    assert ab.classify_instance_source("plate", body_ids, tmp_path) == ("body", "plate")
    assert ab.classify_instance_source("body:missing", body_ids, tmp_path) == ("missing", None)
    assert ab.classify_instance_source("absent.step", body_ids, tmp_path) == ("missing", None)


def test_overlap_check_degrades_without_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "build123d", None)
    assert ab._instance_overlap_warnings([("a", [object()])]) == []


# ---------------------------------------------------------------------------
# Geometry (full profile: OCP + build123d)
# ---------------------------------------------------------------------------


def _require_full_profile() -> None:
    pytest.importorskip("OCP", reason="OCP not installed")
    pytest.importorskip("build123d", reason="build123d not installed")


def _box_doc(name: str, bodies: list[tuple[str, str, float]]) -> dict:
    """Single-part doc with one sketch+pad box per (body id, label, size).

    Boxes span ``[0, size]^3`` (pad of a corner-at-origin rect sketch).
    Sketch+pad is used instead of primitives because the backend document
    validator only mirrors the classic feature set.
    """
    doc: dict = {
        "version": 3,
        "name": name,
        "parameters": {},
        "datums": [{"id": "datum-xy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": bid, "name": bid, "label": label} for bid, label, _ in bodies],
        "sketches": [],
        "features": [],
        "curves": [],
    }
    for bid, _, size in bodies:
        doc["sketches"].append(
            {
                "id": f"sk-{bid}",
                "name": f"sk-{bid}",
                "datumId": "datum-xy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0.0, "y": 0.0},
                    {"id": "p2", "type": "point", "x": size, "y": 0.0},
                    {"id": "p3", "type": "point", "x": size, "y": size},
                    {"id": "p4", "type": "point", "x": 0.0, "y": size},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            }
        )
        doc["features"].append(
            {
                "id": f"pad-{bid}",
                "name": f"pad-{bid}",
                "type": "pad",
                "body": bid,
                "sketchId": f"sk-{bid}",
                "params": {"length": size},
                "suppressed": False,
                "dependsOn": [],
            }
        )
    return doc


def _solid_bounds(result: dict) -> list[tuple[list[float], list[float]]]:
    solids = json.loads(Path(result["tessPath"]).read_text(encoding="utf-8"))["solids"]
    bounds = []
    for solid in solids:
        nodes = [node for face in solid["faces"] for node in face["nodes"]]
        xs = [node[0] for node in nodes]
        ys = [node[1] for node in nodes]
        zs = [node[2] for node in nodes]
        bounds.append(([min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]))
    return bounds


def test_build_same_doc_bodies_selector_keys_and_pose(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    doc = _box_doc("two-box", [("base", "base-solid", 10.0), ("arm", "arm-solid", 4.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "arm", "part": "body:arm", "placement": _placement([50.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("c-base", "base", [10.0, 0.0, 0.0]),
            _connector("c-arm", "arm", [0.0, 0.0, 0.0]),
        ],
        "mates": [_mate("m1", "fixed", "base", "c-base", "arm", "c-arm")],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "asm.nuke-cad"
    path.write_text(json.dumps(doc))
    result = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out"), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error")
    assert result["selectorMap"] == {"base/base-solid": [1], "arm/arm-solid": [2]}
    assert result["solidInstanceIds"] == ["base", "arm"]
    bounds = _solid_bounds(result)
    assert bounds[0][0][0] == pytest.approx(0.0, abs=0.2)  # base box spans [0, 10]^3
    assert bounds[0][1][0] == pytest.approx(10.0, abs=0.2)
    # Arm (4 mm box) solved to x=10: spans [10, 14], not its stored [50, 54].
    assert bounds[1][0][0] == pytest.approx(10.0, abs=0.3)
    assert bounds[1][1][0] == pytest.approx(14.0, abs=0.3)


def test_step_product_names_use_colon(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    doc = _box_doc("named", [("base", "base-solid", 10.0), ("arm", "arm-solid", 4.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "arm", "part": "body:arm", "placement": _placement([30.0, 0.0, 0.0])},
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "asm.nuke-cad"
    path.write_text(json.dumps(doc))
    result = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out"), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error")
    assert result["stepNames"] == {"1": "base:base-solid", "2": "arm:arm-solid"}
    names = gs._read_step_names(Path(result["stepPath"]), 2)
    assert names == {1: "base:base-solid", 2: "arm:arm-solid"}


def test_relative_document_part_and_step_part(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    sub = _box_doc("sub", [("core", "core-solid", 6.0)])
    (tmp_path / "sub.nuke-cad").write_text(json.dumps(sub))
    doc = _box_doc("main", [("base", "base-solid", 10.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "core", "part": "sub.nuke-cad", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("c-base", "base", [5.0, 0.0, 0.0]),
            _connector("c-core", "core", [0.0, 0.0, 0.0]),
        ],
        "mates": [_mate("m1", "fixed", "base", "c-base", "core", "c-core")],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "asm.nuke-cad"
    path.write_text(json.dumps(doc))
    result = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out"), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error")
    assert result["selectorMap"] == {"base/base-solid": [1], "core/core-solid": [2]}

    # Reuse the written STEP as an exchange-file instance source.
    step_source = Path(result["stepPath"])
    doc2 = _box_doc("main2", [("base", "base-solid", 10.0)])
    parts_dir = tmp_path / "asm2.parts"
    parts_dir.mkdir()
    doc2["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {
                "id": "imp",
                "part": f"asm2.parts/{step_source.name}",
                "placement": _placement([100.0, 0.0, 0.0]),
            },
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "base",
    }
    path2 = tmp_path / "asm2.nuke-cad"
    path2.write_text(json.dumps(doc2))
    step_copy = parts_dir / step_source.name
    step_copy.write_bytes(step_source.read_bytes())
    result2 = gs.build_assembly(
        str(path2), output_dir=str(tmp_path / "out2"), export_dagmc=False, export_mesh=False
    )
    assert result2["success"] is True, result2.get("error")
    # The reused STEP carries both placed solids of the first build.
    assert result2["solidInstanceIds"] == ["base", "imp", "imp"]


def test_dagmc_smoke(tmp_path: Path) -> None:
    _require_full_profile()
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    import geometry_service as gs

    doc = _box_doc("dagmc", [("base", "base-solid", 10.0), ("arm", "arm-solid", 4.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "arm", "part": "body:arm", "placement": _placement([30.0, 0.0, 0.0])},
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "asm.nuke-cad"
    path.write_text(json.dumps(doc))
    result = gs.build_assembly(str(path), output_dir=str(tmp_path / "out"), export_mesh=False)
    assert result["success"] is True, result.get("error")
    assert result["dagmcSuccess"] is True, result.get("dagmcError")
    assert Path(result["dagmcPath"]).exists()


def test_absent_assembly_builds_byte_identical(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    doc = _box_doc("plain", [("base", "base-solid", 10.0)])
    path = tmp_path / "plain.nuke-cad"
    path.write_text(json.dumps(doc))
    via_assembly = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out-a"), export_dagmc=False, export_mesh=False
    )
    via_document = gs.build_document(
        str(path), output_dir=str(tmp_path / "out-b"), export_dagmc=False, export_mesh=False
    )
    assert via_assembly["success"] is True and via_document["success"] is True
    assert (
        Path(via_assembly["stepPath"]).read_bytes() == Path(via_document["stepPath"]).read_bytes()
    )
    assert via_assembly["solidCount"] == via_document["solidCount"]


def test_build_document_dispatches_grounded_assembly_minimal(tmp_path: Path, monkeypatch) -> None:
    """Routing is light enough to verify without OCP/build123d."""
    import geometry_service as gs

    (tmp_path / "model.step").write_text("dummy", encoding="utf-8")
    doc = {
        "version": 3,
        "name": "imported",
        "parameters": {},
        "datums": [{"id": "datum-xy", "kind": "XY", "name": "XY"}],
        "bodies": [],
        "sketches": [],
        "features": [],
        "curves": [],
        "assembly": {
            "instances": [
                {
                    "id": "instance-1",
                    "part": "./model.step",
                    "placement": {"position": [0.0, 0.0, 0.0], "orientation": [0.0, 0.0, 0.0, 1.0]},
                }
            ],
            "connectors": [],
            "mates": [],
            "groundedInstanceId": "instance-1",
        },
    }
    path = tmp_path / "imported.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")

    calls: list[str] = []

    def fake_assembly(*_args, **_kwargs):
        calls.append("assembly")
        return {"success": True, "routed": "assembly"}

    monkeypatch.setattr(gs, "build_assembly", fake_assembly)
    assert (
        gs.build_document(
            str(path), output_dir=str(tmp_path / "full"), export_dagmc=False, export_mesh=False
        )["routed"]
        == "assembly"
    )
    assert (
        gs.build_document_partial(
            str(path),
            [],
            output_dir=str(tmp_path / "partial"),
            export_dagmc=False,
            export_mesh=False,
        )["routed"]
        == "assembly"
    )
    assert calls == ["assembly", "assembly"]


def test_build_document_dispatches_grounded_assembly(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    doc = _box_doc("asm", [("base", "base-solid", 10.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])}
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "asm.nuke-cad"
    path.write_text(json.dumps(doc))
    # The viewport's `--from-document` path (build_document) must route a
    # grounded assembly through the instance builder, or imported assemblies
    # would build as empty single-part documents.
    via_document = gs.build_document(
        str(path), output_dir=str(tmp_path / "out-doc"), export_dagmc=False, export_mesh=False
    )
    via_assembly = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out-asm"), export_dagmc=False, export_mesh=False
    )
    assert via_document["success"] is True, via_document.get("error")
    assert via_assembly["success"] is True, via_assembly.get("error")
    assert via_document["solidInstanceIds"] == ["base"]
    assert via_document["selectorMap"] == via_assembly["selectorMap"] == {"base/base-solid": [1]}

    # The open-after-restart path uses the partial RPC with an empty dirty set;
    # it must also fall back to the assembly pipeline.
    via_partial = gs.build_document_partial(
        str(path),
        [],
        output_dir=str(tmp_path / "out-partial"),
        export_dagmc=False,
        export_mesh=False,
    )
    assert via_partial["success"] is True, via_partial.get("error")
    assert via_partial["solidInstanceIds"] == ["base"]


def test_v3_round_trip_and_from_assembly_cli(tmp_path: Path) -> None:
    _require_full_profile()
    doc = _box_doc("roundtrip", [("base", "base-solid", 10.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "base", "part": "body:base", "placement": _placement([0.0, 0.0, 0.0])}
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "base",
    }
    path = tmp_path / "roundtrip.nuke-cad"
    path.write_text(json.dumps(doc))
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 3
    service = Path(ab.__file__).parent / "geometry_service.py"
    proc = subprocess.run(
        [sys.executable, str(service), "--from-assembly", str(path), "--no-dagmc", "--no-mesh"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert (tmp_path / "roundtrip.step").exists()


def test_negative_dof_overconstrained_build_warns(tmp_path: Path) -> None:
    _require_full_profile()
    import geometry_service as gs

    doc = _box_doc("oc", [("a", "a-solid", 10.0), ("b", "b-solid", 4.0), ("c", "c-solid", 2.0)])
    doc["assembly"] = {
        "instances": [
            {"id": "a", "part": "body:a", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "b", "part": "body:b", "placement": _placement([0.0, 0.0, 0.0])},
            {"id": "c", "part": "body:c", "placement": _placement([0.0, 0.0, 0.0])},
        ],
        "connectors": [
            _connector("ca1", "a", [0.0, 0.0, 0.0]),
            _connector("ca2", "a", [1.0, 0.0, 0.0]),
            _connector("cb1", "b", [0.0, 0.0, 0.0]),
            _connector("cb2", "b", [1.0, 0.0, 0.0]),
            _connector("cc1", "c", [0.0, 0.0, 0.0]),
        ],
        "mates": [
            _mate("m1", "fixed", "a", "ca1", "b", "cb1"),
            _mate("m2", "fixed", "b", "cb2", "c", "cc1"),
            _mate("m3", "revolute", "a", "ca2", "c", "cc1"),
        ],
        "groundedInstanceId": "a",
    }
    path = tmp_path / "oc.nuke-cad"
    path.write_text(json.dumps(doc))
    result = gs.build_assembly(
        str(path), output_dir=str(tmp_path / "out"), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error")
    assert any("over-constrained" in warning for warning in result["warnings"])
