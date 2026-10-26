#!/usr/bin/env python3
"""Tests for the native coil-sweep feature and the W7-X shape study.

The minimal profile (``pytest`` + ``numpy``) covers the pure parameter
contract, the solid-producer classification, and the geometry-service
structural gate. Full-profile cases (``build123d``/OCP) build simple closed
curves and the complete ten-body/fifty-instance shape-study document from the
committed ``w7x_coils.json`` asset.
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
import math
from pathlib import Path
from typing import Any

import curve_builder
import feature_builder as fb
import geometry_service as gs
import pytest

_EXTENSION = Path(__file__).resolve().parents[2]
_COILS_ASSET = _EXTENSION / "src" / "common" / "samples" / "w7x" / "w7x_coils.json"
_SHAPE_REFERENCE_VOLUME_M3 = 138.05
_SHAPE_DEFAULTS = {
    "width": 0.37,
    "height": 0.37,
    "tiltDeg": 8.6,
    "twistDeg": 0.0,
    "stations": 60,
}


# ---------------------------------------------------------------------------
# Minimal-profile: pure parameter contract and structural validation.
# ---------------------------------------------------------------------------


def _coil_params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {"pathCurveId": "ring", "width": 0.37, "height": 0.37}
    params.update(overrides)
    return params


def test_coil_sweep_params_apply_defaults() -> None:
    params = fb._coil_sweep_params(_coil_params(), "coil1")
    assert params == {
        "pathCurveId": "ring",
        "width": 0.37,
        "height": 0.37,
        "tiltDeg": 0.0,
        "twistDeg": 0.0,
        "stations": 60,
    }


def test_coil_sweep_params_accept_boundaries() -> None:
    for tilt, twist, stations in ((-89.0, 0.0, 8), (89.0, -1080.0, 720), (8.6, 90.0, 120)):
        params = fb._coil_sweep_params(
            _coil_params(tiltDeg=tilt, twistDeg=twist, stations=stations), "coil1"
        )
        assert params["tiltDeg"] == tilt
        assert params["twistDeg"] == twist
        assert params["stations"] == stations


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"pathCurveId": ""}, "requires a pathCurveId"),
        ({"pathCurveId": None}, "requires a pathCurveId"),
        ({"width": 0}, "positive width"),
        ({"width": -1}, "positive width"),
        ({"width": math.inf}, "positive width"),
        ({"height": 0}, "positive height"),
        ({"height": math.nan}, "positive height"),
        ({"tiltDeg": -90}, "tiltDeg"),
        ({"tiltDeg": 90}, "tiltDeg"),
        ({"tiltDeg": math.nan}, "tiltDeg"),
        ({"twistDeg": math.inf}, "twistDeg"),
        ({"stations": 7}, "stations"),
        ({"stations": 721}, "stations"),
        ({"stations": 8.5}, "stations"),
        ({"stations": "60"}, "stations"),
    ],
)
def test_coil_sweep_params_reject_bad_values(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(fb.FeatureBuilderError, match=message):
        fb._coil_sweep_params(_coil_params(**overrides), "coil1")


def test_coil_sweep_is_a_solid_producer_without_a_sketch() -> None:
    assert fb._is_solid_producer("coilSweep")
    assert not fb._is_sketch_based_solid("coilSweep")
    assert not fb._solid_feature_is_subtractive({"type": "coilSweep", "params": {}})


def _document(features: list[dict[str, Any]], curves: list[dict[str, Any]] | None = None) -> dict:
    return {
        "version": 3,
        "name": "coil-sweep",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [],
        "curves": curves
        if curves is not None
        else [
            {
                "id": "ring",
                "name": "ring",
                "source": {"kind": "points"},
                "samples": [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]],
            }
        ],
        "features": features,
    }


def _coil_feature(params: dict[str, Any], feature_id: str = "coil1") -> dict[str, Any]:
    return {
        "id": feature_id,
        "name": feature_id,
        "type": "coilSweep",
        "body": "body-1",
        "params": params,
        "dependsOn": [],
        "suppressed": False,
    }


def test_coil_sweep_ref_gate_accepts_curve_without_sketch(tmp_path: Path) -> None:
    doc = _document([_coil_feature(_coil_params())])
    assert gs._validate_document_refs(doc, tmp_path / "doc.nuke-cad") is None


def test_coil_sweep_ref_gate_rejects_missing_or_unknown_curve(tmp_path: Path) -> None:
    missing = _document([_coil_feature({"width": 0.37, "height": 0.37})])
    error = gs._validate_document_refs(missing, tmp_path / "doc.nuke-cad")
    assert error is not None and "requires a pathCurveId" in error["error"]

    unknown = _document([_coil_feature(_coil_params(pathCurveId="nope"))])
    error = gs._validate_document_refs(unknown, tmp_path / "doc.nuke-cad")
    assert error is not None and "references unknown curve 'nope'" in error["error"]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"width": 0}, "positive width"),
        ({"height": -1}, "positive height"),
        ({"tiltDeg": -90}, "tiltDeg in [-89, 89]"),
        ({"tiltDeg": 90}, "tiltDeg in [-89, 89]"),
        ({"twistDeg": math.nan}, "finite twistDeg"),
        ({"stations": 7}, "stations in [8, 720]"),
        ({"stations": 721}, "stations in [8, 720]"),
        ({"stations": 8.5}, "stations in [8, 720]"),
    ],
)
def test_coil_sweep_ref_gate_rejects_bad_params(
    tmp_path: Path, overrides: dict[str, Any], message: str
) -> None:
    doc = _document([_coil_feature(_coil_params(**overrides))])
    error = gs._validate_document_refs(doc, tmp_path / "doc.nuke-cad")
    assert error is not None
    assert message in error["error"]
    assert "sketchId" not in error["error"]


# ---------------------------------------------------------------------------
# Full-profile: OCP geometry.
# ---------------------------------------------------------------------------


def _circle_samples(radius: float, segments: int = 64) -> list[list[float]]:
    return [
        [
            radius * math.cos(2.0 * math.pi * index / segments),
            radius * math.sin(2.0 * math.pi * index / segments),
            0.0,
        ]
        for index in range(segments + 1)
    ]


def _ring_document(
    params: dict[str, Any],
    features: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    curve = {
        "id": "ring",
        "name": "ring",
        "source": {"kind": "points"},
        "samples": _circle_samples(5.0),
    }
    return _document([_coil_feature(params), *(features or [])], curves=[curve])


def _build(doc: dict[str, Any], partial: bool = False) -> dict[str, Any]:
    curve_results = curve_builder.build_curves(doc)
    if partial:
        return fb.build_document_shape_partial(
            doc, [feature["id"] for feature in doc["features"]], curve_results=curve_results
        )
    return fb.build_document_shape(doc, curve_results=curve_results)


def _status(result: dict[str, Any], feature_id: str) -> dict[str, Any]:
    return next(record for record in result["featureResults"] if record["featureId"] == feature_id)


def _ring_volume(width: float, height: float, **overrides: Any) -> float:
    pytest.importorskip("build123d", reason="build123d not installed")
    result = _build(_ring_document(_coil_params(width=width, height=height, **overrides)))
    record = _status(result, "coil1")
    assert record["status"] == "built", record.get("error")
    return float(result["shape"].volume)


def test_coil_sweep_builds_one_valid_solid() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    result = _build(_ring_document(_coil_params(width=1.0, height=1.0)))
    record = _status(result, "coil1")
    assert record["status"] == "built", record.get("error")
    solids = result["shape"].solids()
    assert len(solids) == 1
    # A 1x1 section around a radius-5 ring: 2*pi*5 ~= 31.416.
    assert result["shape"].volume == pytest.approx(2.0 * math.pi * 5.0, rel=0.005)
    assert len(result["shape"].faces()) == 6


def test_coil_sweep_width_and_height_change_volume_monotonically() -> None:
    base = _ring_volume(1.0, 1.0)
    wider = _ring_volume(2.0, 1.0)
    taller = _ring_volume(1.0, 2.0)
    both = _ring_volume(2.0, 2.0)
    assert base < wider < both
    assert base < taller < both
    assert wider == pytest.approx(2.0 * base, rel=0.005)
    assert taller == pytest.approx(2.0 * base, rel=0.005)
    assert both == pytest.approx(4.0 * base, rel=0.005)


def test_coil_sweep_tilt_respects_projected_area_and_twist_keeps_volume() -> None:
    base = _ring_volume(1.0, 1.0)
    tilted = _ring_volume(1.0, 1.0, tiltDeg=30.0)
    twisted = _ring_volume(1.0, 1.0, twistDeg=90.0, stations=24)
    assert tilted == pytest.approx(base * math.cos(math.radians(30.0)), rel=0.005)
    assert twisted == pytest.approx(base, rel=0.005)


def test_coil_sweep_station_counts_are_accepted() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    for stations in (8, 60, 720):
        result = _build(_ring_document(_coil_params(width=1.0, height=1.0, stations=stations)))
        record = _status(result, "coil1")
        assert record["status"] == "built", record.get("error")
        assert len(result["shape"].solids()) == 1


def test_coil_sweep_missing_curve_and_bad_params_fail_clearly() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    missing = _build(_ring_document(_coil_params(pathCurveId="nope")))
    record = _status(missing, "coil1")
    assert record["status"] == "failed"
    assert "path curve 'nope' is unavailable" in record["error"]

    bad_stations = _build(_ring_document(_coil_params(stations=7)))
    record = _status(bad_stations, "coil1")
    assert record["status"] == "failed"
    assert "stations" in record["error"]

    bad_width = _build(_ring_document(_coil_params(width=0)))
    record = _status(bad_width, "coil1")
    assert record["status"] == "failed"
    assert "positive width" in record["error"]


def test_pattern_over_coil_sweep() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    pattern = {
        "id": "pat",
        "name": "pat",
        "type": "linearPattern",
        "body": "body-1",
        "params": {"source": "coil1", "count": 2, "spacing": 15.0, "axis": "x"},
        "dependsOn": ["coil1"],
        "suppressed": False,
    }
    result = _build(_ring_document(_coil_params(width=1.0, height=1.0), [pattern]))
    assert _status(result, "coil1")["status"] == "built"
    assert _status(result, "pat")["status"] == "built", _status(result, "pat").get("error")
    assert len(result["shape"].solids()) == 2
    assert result["shape"].volume == pytest.approx(2.0 * 2.0 * math.pi * 5.0, rel=0.005)


def test_coil_sweep_partial_build_dispatch() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    result = _build(_ring_document(_coil_params(width=1.0, height=1.0)), partial=True)
    record = _status(result, "coil1")
    assert record["status"] == "built", record.get("error")
    assert len(result["shape"].solids()) == 1


# ---------------------------------------------------------------------------
# Full-profile: the complete W7-X native shape-study document.
# ---------------------------------------------------------------------------


def _quaternion_z(degrees: float) -> list[float]:
    half = math.radians(degrees) / 2.0
    return [0.0, 0.0, math.sin(half), math.cos(half)]


def _shape_study_document(asset: dict[str, Any]) -> dict[str, Any]:
    """Build the planner-shaped document in-test from the committed asset."""
    reference_volume = sum(shape["referenceVolumeM3"] for shape in asset["coilShapes"])
    doc: dict[str, Any] = {
        "version": 3,
        "name": "w7x-coil-shape-study",
        "units": "m",
        "displayTolerance": 0.1,
        "overlapCheck": False,
        "parameters": {
            "moduleCount": 5,
            "coilCount": 50,
            "sectionWidthM": _SHAPE_DEFAULTS["width"],
            "sectionHeightM": _SHAPE_DEFAULTS["height"],
            "sectionTiltDeg": _SHAPE_DEFAULTS["tiltDeg"],
            "twistDeg": _SHAPE_DEFAULTS["twistDeg"],
            "stations": _SHAPE_DEFAULTS["stations"],
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
        "designStudy": {
            "kind": "w7x-coil-shape-study",
            "report": {
                "moduleCount": 5,
                "coilCount": 50,
                "bodyCount": 10,
                "sectionWidthM": _SHAPE_DEFAULTS["width"],
                "sectionHeightM": _SHAPE_DEFAULTS["height"],
                "sectionTiltDeg": _SHAPE_DEFAULTS["tiltDeg"],
                "twistDeg": _SHAPE_DEFAULTS["twistDeg"],
                "stations": _SHAPE_DEFAULTS["stations"],
                "referenceVolumeM3": reference_volume,
                "summary": (
                    "10 native sweep bodies x 5 modules; approximate reference B-reps; "
                    "simulation export disabled."
                ),
            },
        },
    }
    instances: list[dict[str, Any]] = []
    for index, shape in enumerate(asset["coilShapes"]):
        curve_id = f"curve-coil-{index + 1:02d}"
        body_id = f"body-coil-{index + 1:02d}"
        doc["curves"].append(
            {
                "id": curve_id,
                "name": f"{shape['id']} centerline",
                "source": {"kind": "points"},
                "samples": shape["samples"],
            }
        )
        doc["bodies"].append({"id": body_id, "name": shape["id"], "label": shape["id"]})
        doc["features"].append(
            {
                "id": f"coil-sweep-{index + 1:02d}",
                "name": f"{shape['id']} sweep",
                "type": "coilSweep",
                "body": body_id,
                "params": {
                    "pathCurveId": curve_id,
                    "width": _SHAPE_DEFAULTS["width"],
                    "height": _SHAPE_DEFAULTS["height"],
                    "tiltDeg": _SHAPE_DEFAULTS["tiltDeg"],
                    "twistDeg": _SHAPE_DEFAULTS["twistDeg"],
                    "stations": _SHAPE_DEFAULTS["stations"],
                },
                "dependsOn": [],
                "suppressed": False,
            }
        )
        for module, transform in enumerate(shape["transforms"]):
            instances.append(
                {
                    "id": f"{shape['id']}_m{module}",
                    "part": f"body:{body_id}",
                    "placement": {
                        "position": [0.0, 0.0, 0.0],
                        "orientation": _quaternion_z(transform["rotationDeg"]),
                    },
                }
            )
    doc["assembly"] = {
        "instances": instances,
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "coil_01_m0",
    }
    return doc


def test_shape_study_document_builds_fifty_native_coils(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    asset = json.loads(_COILS_ASSET.read_text(encoding="utf-8"))
    assert asset["coilShapeCount"] == 10
    assert asset["moduleCount"] == 5
    assert len(asset["coilShapes"]) == 10
    assert all(len(shape["samples"]) == 121 for shape in asset["coilShapes"])
    assert all(len(shape["transforms"]) == 5 for shape in asset["coilShapes"])
    reference_volume = sum(shape["referenceVolumeM3"] for shape in asset["coilShapes"])
    assert reference_volume == pytest.approx(27.608505577, abs=1e-9)

    doc = _shape_study_document(asset)
    assert len(doc["curves"]) == 10
    assert len(doc["bodies"]) == 10
    assert len(doc["features"]) == 10
    assert len(doc["assembly"]["instances"]) == 50
    path = tmp_path / "w7x-coil-shape-study.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")

    result = gs.build_document(
        str(path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
        tolerance=0.1,
        length_scale=1.0,
    )
    assert result["success"] is True, result.get("error")
    assert result["solidCount"] == 50
    assert result.get("warnings") == []
    selector_map = result["selectorMap"] or {}
    assert len(selector_map) == 50
    assert "coil_01_m0/coil_01" in selector_map
    assert "coil_10_m4/coil_10" in selector_map
    tess = tmp_path / "w7x-coil-shape-study.tess.json"
    assert tess.is_file()
    assert tess.stat().st_size < 8 * 1024 * 1024

    # The 50 instances are rigid copies of the ten native bodies; the total is
    # five modules of the single-part build, within 1% of 138.05 m^3.
    single = {key: value for key, value in doc.items() if key != "assembly"}
    curve_results = curve_builder.build_curves(single)
    module_result = fb.build_document_shape(single, curve_results=curve_results)
    assert all(record["status"] == "built" for record in module_result["featureResults"])
    module_solids = module_result["shape"].solids()
    assert len(module_solids) == 10
    total = 5.0 * float(module_result["shape"].volume)
    assert total == pytest.approx(_SHAPE_REFERENCE_VOLUME_M3, rel=0.01)
    assert total == pytest.approx(5.0 * reference_volume, rel=0.02)


def test_shape_study_blocks_simulation_export(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    asset = json.loads(_COILS_ASSET.read_text(encoding="utf-8"))
    doc = _shape_study_document(asset)
    path = tmp_path / "w7x-coil-shape-study.nuke-cad"
    path.write_text(json.dumps(doc), encoding="utf-8")
    blocked = gs.build_document(
        str(path),
        output_dir=str(tmp_path / "blocked"),
        export_dagmc=True,
        export_mesh=False,
        tolerance=0.1,
    )
    assert blocked["success"] is False
    assert "Design study document" in (blocked.get("error") or "")
