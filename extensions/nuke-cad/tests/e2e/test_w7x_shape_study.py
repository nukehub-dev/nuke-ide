#!/usr/bin/env python3
"""End-to-end: native W7-X coil shape study.

The production planner lives in TypeScript (`src/common/w7x-shape-study.ts`);
this test rebuilds the equivalent document from the committed centerline asset
and runs the real backend. It needs no external STEP: the ten centerlines and
reference metrics are committed metadata derived from the MIT-licensed model.

It proves the self-contained shape study builds 50 native coil solids (10
editable bodies x 5 modules) with zero warnings, total volume within 1% of the
reference imported coils, and that simulation export stays blocked.
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

pytest.importorskip("build123d", reason="the native coil shape study needs build123d/OCP")

_EXTENSION = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_EXTENSION / "python"))
_ASSET = _EXTENSION / "src" / "common" / "samples" / "w7x" / "w7x_coils.json"
_DISPLAY_TOLERANCE = 0.1
_W7X_REFERENCE_VOLUME_M3 = 138.042527885  # 5 x the ten-shape reference sum
_DEFAULTS = {"width": 0.37, "height": 0.37, "tiltDeg": 8.6, "twistDeg": 0.0, "stations": 60}


def _quaternion_z(degrees: float) -> list[float]:
    half = math.radians(degrees) / 2.0
    return [0.0, 0.0, math.sin(half), math.cos(half)]


def _shape_study_document(asset: dict, name: str = "w7x-shape-study-e2e") -> dict:
    doc: dict = {
        "version": 3,
        "name": name,
        "units": "m",
        "displayTolerance": _DISPLAY_TOLERANCE,
        "overlapCheck": False,
        "parameters": {
            "moduleCount": 5,
            "coilCount": 50,
            "sectionWidth": _DEFAULTS["width"],
            "sectionHeight": _DEFAULTS["height"],
        },
        "datums": [
            {"id": "datum-xy", "kind": "XY", "name": "XY Plane"},
            {"id": "datum-yz", "kind": "YZ", "name": "YZ Plane"},
            {"id": "datum-xz", "kind": "XZ", "name": "XZ Plane"},
        ],
        "bodies": [],
        "sketches": [],
        "features": [],
        "curves": [],
    }
    body_ids: list[str] = []
    for index, shape in enumerate(asset["coilShapes"], start=1):
        label = shape["id"]
        curve_id = f"curve-coil-{index:02d}"
        body_id = f"body-coil-{index:02d}"
        body_ids.append(body_id)
        doc["curves"].append(
            {
                "id": curve_id,
                "name": f"{label} centerline",
                "source": {"kind": "points"},
                "samples": shape["samples"],
            }
        )
        doc["bodies"].append({"id": body_id, "name": label, "label": label})
        doc["features"].append(
            {
                "id": f"coil-sweep-{index:02d}",
                "name": f"{label} sweep",
                "type": "coilSweep",
                "body": body_id,
                "params": {"pathCurveId": curve_id, **_DEFAULTS},
                "suppressed": False,
                "dependsOn": [],
            }
        )

    instances: list[dict] = []
    for shape_index, shape in enumerate(asset["coilShapes"]):
        for module, angle in enumerate((0.0, 72.0, 144.0, 216.0, 288.0)):
            instances.append(
                {
                    "id": f"{shape['id']}_m{module}",
                    "part": f"body:{body_ids[shape_index]}",
                    "placement": {"position": [0.0, 0.0, 0.0], "orientation": _quaternion_z(angle)},
                }
            )
    doc["assembly"] = {
        "instances": instances,
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "coil_01_m0",
    }
    doc["designStudy"] = {
        "kind": "w7x-coil-shape-study",
        "report": {
            "moduleCount": 5,
            "coilCount": 50,
            "bodyCount": 10,
            "sectionWidthM": _DEFAULTS["width"],
            "sectionHeightM": _DEFAULTS["height"],
            "sectionTiltDeg": _DEFAULTS["tiltDeg"],
            "twistDeg": _DEFAULTS["twistDeg"],
            "stations": _DEFAULTS["stations"],
            "referenceVolumeM3": round(
                sum(shape["referenceVolumeM3"] for shape in asset["coilShapes"]), 9
            ),
            "summary": "Native coil shape study: 10 editable sweep bodies across 5 modules.",
        },
    }
    return doc


def test_native_shape_study_builds_and_blocks_simulation_export(tmp_path: Path) -> None:
    import curve_builder
    import feature_builder as fb
    import geometry_service as gs

    asset = json.loads(_ASSET.read_text(encoding="utf-8"))
    assert len(asset["coilShapes"]) == 10
    assert asset["source"]["sourceHash"] == (
        "384d025207b7d6ccc00bef364611526ef0c3093b091f6f4005fb8586ae4f34e3"
    )
    doc = _shape_study_document(asset)
    path = tmp_path / "w7x-shape-study.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")

    curves = curve_builder.build_curves(doc)
    own = fb.build_document_shape(doc, curves, document_dir=tmp_path)
    assert own["shape"] is not None
    assert len(own["shape"].solids()) == 10
    module_volume = own["shape"].volume
    reference_module_volume = sum(shape["referenceVolumeM3"] for shape in asset["coilShapes"])
    assert abs(module_volume / reference_module_volume - 1) < 0.01
    assert abs(module_volume * 5 / _W7X_REFERENCE_VOLUME_M3 - 1) < 0.01
    assert own.get("warnings") == []

    started = time.perf_counter()
    result = gs.build_document(
        str(path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
        tolerance=_DISPLAY_TOLERANCE,
        length_scale=1.0,
    )
    elapsed = time.perf_counter() - started

    assert result["success"] is True, result.get("error")
    assert result["solidCount"] == 50
    assert result.get("warnings") == []
    assert len(result["selectorMap"]) == 50
    assert "coil_01_m0/coil_01" in result["selectorMap"]
    assert "coil_10_m4/coil_10" in result["selectorMap"]
    tess = tmp_path / "w7x-shape-study.tess.json"
    assert tess.is_file()
    assert tess.stat().st_size < 8 * 1024 * 1024
    assert elapsed < 60, f"native shape study build took {elapsed:.1f}s"

    blocked = gs.build_document(
        str(path),
        output_dir=str(tmp_path / "blocked"),
        export_dagmc=True,
        export_mesh=False,
        tolerance=_DISPLAY_TOLERANCE,
        length_scale=1.0,
    )
    assert blocked["success"] is False
    assert "Design study document" in (blocked.get("error") or "")
