#!/usr/bin/env python3
"""End-to-end: generated W7-X imported-body project.

The production planners live in TypeScript (`src/common/w7x-generator.ts` and
`src/common/w7x-study.ts`); this test rebuilds the equivalent documents from the
committed assets and the external reference STEP, then runs the real backend. It
is the full-profile counterpart to the pure plan tests and proves the 15
imported bodies load as 55 exact solids for the valid generator, and that the
experimental 4/6-module studies build 45/65 solids while rejecting simulation
export.

Gates:

* ``NUKE_E2E_W7X_STEP`` — absolute path to the developer-local reference STEP.
  The STEP is never committed.
* ``build123d``/OCP — the module skips cleanly in the minimal profile.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

_STEP = os.environ.get("NUKE_E2E_W7X_STEP")
if not _STEP:
    pytest.skip(
        "NUKE_E2E_W7X_STEP not set — the W7-X generator e2e needs the developer-local reference STEP",
        allow_module_level=True,
    )

pytest.importorskip("build123d", reason="the W7-X generator e2e requires build123d/OCP")

_EXTENSION = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_EXTENSION / "python"))
_ASSET = _EXTENSION / "src" / "common" / "samples" / "w7x" / "w7x_geometry.json"
_STUDY_ASSET = _EXTENSION / "src" / "common" / "samples" / "w7x" / "w7x_study.json"
_DISPLAY_TOLERANCE = 0.1


def _quaternion_z(degrees: float) -> list[float]:
    import math

    half = math.radians(degrees) / 2.0
    return [0.0, 0.0, math.sin(half), math.cos(half)]


def _source_digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _module_angles(module_count: int) -> tuple[float, ...]:
    return tuple(index * 360.0 / module_count for index in range(module_count))


def _generated_document(
    asset: dict,
    step: Path,
    digest: str,
    size: int,
    *,
    module_count: int = 5,
    design_study: dict | None = None,
) -> dict:
    doc: dict = {
        "version": 3,
        "name": f"w7x-{'study' if design_study else 'generator'}-{module_count}-e2e",
        "units": "m",
        "displayTolerance": _DISPLAY_TOLERANCE,
        "overlapCheck": False,
        "parameters": {},
        **({"designStudy": design_study} if design_study is not None else {}),
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
    for index, shape in enumerate(asset["coilShapes"]):
        body_id = f"body-coil-{index + 1:02d}"
        body_ids.append(body_id)
        doc["bodies"].append({"id": body_id, "name": shape["id"], "label": shape["id"]})
        doc["features"].append(
            {
                "id": f"import-coil-{index + 1:02d}",
                "name": shape["id"],
                "type": "import",
                "body": body_id,
                "params": {
                    "sourcePath": str(step),
                    "sourceHash": digest,
                    "sourceSize": size,
                    "sourceFormat": "step",
                    "sourceUnit": "m",
                    "selection": {
                        "mode": "solids",
                        "solids": [
                            {
                                "index": shape["representativeIndex"],
                                "signature": shape["signature"],
                            }
                        ],
                    },
                    "maxSolids": 100,
                },
                "suppressed": False,
                "dependsOn": [],
            }
        )
    for shell in asset["shells"]:
        body_id = f"body-{shell['label']}"
        body_ids.append(body_id)
        doc["bodies"].append({"id": body_id, "name": shell["label"], "label": shell["label"]})
        doc["features"].append(
            {
                "id": f"import-{shell['label']}",
                "name": shell["label"],
                "type": "import",
                "body": body_id,
                "params": {
                    "sourcePath": str(step),
                    "sourceHash": digest,
                    "sourceSize": size,
                    "sourceFormat": "step",
                    "sourceUnit": "m",
                    "selection": {
                        "mode": "solids",
                        "solids": [{"index": shell["index"], "signature": shell["signature"]}],
                    },
                    "maxSolids": 100,
                },
                "suppressed": False,
                "dependsOn": [],
            }
        )

    instances: list[dict] = []
    for shape_index, shape in enumerate(asset["coilShapes"]):
        for module, angle in enumerate(_module_angles(module_count)):
            instances.append(
                {
                    "id": f"{shape['id']}_m{module}",
                    "part": f"body:{body_ids[shape_index]}",
                    "placement": {"position": [0.0, 0.0, 0.0], "orientation": _quaternion_z(angle)},
                }
            )
    for shell, body_id in zip(asset["shells"], body_ids[len(asset["coilShapes"]) :], strict=True):
        instances.append(
            {
                "id": shell["label"],
                "part": f"body:{body_id}",
                "placement": {"position": [0.0, 0.0, 0.0], "orientation": [0.0, 0.0, 0.0, 1.0]},
            }
        )
    doc["assembly"] = {
        "instances": instances,
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "coil_01_m0",
    }
    return doc


def test_generated_w7x_document_builds_fifty_five_solids(tmp_path: Path) -> None:
    import geometry_service as gs

    asset = json.loads(_ASSET.read_text(encoding="utf-8"))
    step = Path(_STEP)
    assert step.is_file(), f"NUKE_E2E_W7X_STEP is not a file: {step}"
    digest, size = _source_digest(step)
    assert size == asset["source"]["sourceSize"]
    assert digest == asset["source"]["sourceHash"]
    assert len(asset["coilShapes"]) == 10
    assert len(asset["shells"]) == 5
    assert asset["expectedSolidCount"] == 55

    doc = _generated_document(asset, step, digest, size)
    path = tmp_path / "w7x-generator.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")
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
    assert result["solidCount"] == 55
    assert result.get("warnings") == []
    assert result["selectorMap"]
    assert len(result["selectorMap"]) == 55
    assert "coil_01_m0/coil_01" in result["selectorMap"]
    assert "plasma/plasma" in result["selectorMap"]
    assert "vessel/vessel" in result["selectorMap"]
    tess = tmp_path / "w7x-generator.tess.json"
    assert tess.is_file()
    assert tess.stat().st_size < 20 * 1024 * 1024
    assert elapsed < 180, f"W7-X generator build took {elapsed:.1f}s"


@pytest.mark.parametrize("module_count", [4, 6])
def test_coil_study_builds_and_blocks_simulation_export(tmp_path: Path, module_count: int) -> None:
    import geometry_service as gs

    asset = json.loads(_ASSET.read_text(encoding="utf-8"))
    study_asset = json.loads(_STUDY_ASSET.read_text(encoding="utf-8"))
    step = Path(_STEP)
    digest, size = _source_digest(step)
    assert digest == asset["source"]["sourceHash"]
    assert size == asset["source"]["sourceSize"]
    report = next(
        report for report in study_asset["reports"] if report["moduleCount"] == module_count
    )

    doc = _generated_document(
        asset,
        step,
        digest,
        size,
        module_count=module_count,
        design_study={"kind": "w7x-coil-study", "report": report},
    )
    path = tmp_path / f"w7x-study-{module_count}.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")
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

    expected_solids = module_count * 10 + 5
    assert result["success"] is True, result.get("error")
    assert result["solidCount"] == expected_solids
    assert result.get("warnings") == []
    assert len(result["selectorMap"]) == expected_solids
    assert f"coil_01_m{module_count - 1}/coil_01" in result["selectorMap"]
    assert "plasma/plasma" in result["selectorMap"]
    tess = tmp_path / f"w7x-study-{module_count}.tess.json"
    assert tess.is_file()
    assert tess.stat().st_size < 20 * 1024 * 1024
    assert elapsed < 180, f"W7-X {module_count}-module study build took {elapsed:.1f}s"

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
