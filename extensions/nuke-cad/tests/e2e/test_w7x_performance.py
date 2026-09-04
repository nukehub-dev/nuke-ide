#!/usr/bin/env python3
"""Gated performance measurement for a W7X-scale document build.

Builds the W7X-scale display document — one 0.37 m square section swept along
the committed ``w7x_coil_centerline.json``, circular-patterned x50 — and
records wall-clock timings for:

* ``feature_builder.build_document_shape`` (pure shape rebuild; the pattern
  instances are fused by boolean union, which dominates)
* ``geometry_service._tessellate_shape`` (faceting + per-face extraction at
  the display tolerance)
* tessellation JSON serialization + file write
* ``geometry_service.build_document`` (end-to-end rebuild, the cost the
  edit-rebuild loop pays)

The document is the large-model counterpart to the tokamak fixture in
``test_tokamak_performance.py``: ~50 coil solids from B-spline sweep faces,
comparable in tessellated size to the W7X reference STEP import. The pattern
count defaults to 50 (the W7X coil count) and can be overridden with
``NUKE_CAD_W7X_PERF_COUNT`` for quicker partial measurements.

The x50 build fuses 50 swept coils through boolean union and takes tens of
minutes — far beyond the tokamak performance test's runtime — so on top of the
usual ``NUKE_TEST_PYTHON`` gate this module is opt-in via
``NUKE_CAD_W7X_PERF=1`` (same spirit as the OpenMC-run e2e gates): it never
runs in CI or a default full-profile pass, only when explicitly requested.

The test is skipped in the minimal pytest profile and only executes in a
full-dependency environment. No optimization work is performed here; the test
just prints the numbers.
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
import os
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

if not os.environ.get("NUKE_TEST_PYTHON"):
    pytest.skip(
        "NUKE_TEST_PYTHON not set — performance tests require the full-dependency Python environment",
        allow_module_level=True,
    )

if os.environ.get("NUKE_CAD_W7X_PERF") != "1":
    pytest.skip(
        "NUKE_CAD_W7X_PERF not set — the x50 W7X-scale build is opt-in (tens of minutes); "
        "set NUKE_CAD_W7X_PERF=1 (and optionally NUKE_CAD_W7X_PERF_COUNT for a partial count)",
        allow_module_level=True,
    )

pytest.importorskip("build123d", reason="performance tests require build123d")

import curve_builder  # noqa: E402
import feature_builder  # noqa: E402
import geometry_service  # noqa: E402

_FIXTURE = Path(__file__).parent / "assets" / "w7x_coil_centerline.json"
_COUNT = int(os.environ.get("NUKE_CAD_W7X_PERF_COUNT", "50"))
# Display faceting tolerance, matching viewport-only document builds.
_TOLERANCE = 0.01


def _w7x_document(count: int) -> dict:
    """One coil section swept along the committed centerline, circular x50."""
    samples = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    half = 0.37 / 2.0
    rectangle = {
        "id": "section",
        "name": "coil section",
        "datumId": "datum-xy",
        "primitives": [
            {"id": "p1", "type": "point", "x": -half, "y": -half},
            {"id": "p2", "type": "point", "x": half, "y": -half},
            {"id": "p3", "type": "point", "x": half, "y": half},
            {"id": "p4", "type": "point", "x": -half, "y": half},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    return {
        "version": 3,
        "name": "w7x-scale",
        "parameters": {},
        "bodies": [{"id": "coil-body", "label": "coil", "name": "coil"}],
        "datums": [{"id": "datum-xy", "kind": "XY", "offset": 0.0}],
        "sketches": [rectangle],
        "curves": [
            {
                "id": "w7x",
                "name": "coil centerline",
                "source": {"kind": "points"},
                "samples": [list(p) for p in samples],
            }
        ],
        "features": [
            {
                "id": "coil-sweep",
                "name": "coil sweep",
                "type": "sweep",
                "body": "coil-body",
                "sketchId": "section",
                "params": {"pathCurveId": "w7x", "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "coil-pattern",
                "name": "circular pattern x50",
                "type": "circularPattern",
                "body": "coil-body",
                "params": {"source": "coil-sweep", "count": count, "angle": 360.0, "axis": "z"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    }


def test_w7x_scale_document_build_performance(tmp_path: Path) -> None:
    """Profile the W7X-scale rebuild/tessellation/serialization times."""
    doc_path = tmp_path / "w7x_scale.nuke-cad"
    doc_path.write_text(json.dumps(_w7x_document(_COUNT)), encoding="utf-8")
    raw_doc = json.loads(doc_path.read_text(encoding="utf-8"))

    # 1. Pure shape rebuild (pattern union dominates).
    start = time.perf_counter()
    curve_results = curve_builder.build_curves(raw_doc)
    build_result = feature_builder.build_document_shape(raw_doc, curve_results=curve_results)
    build_elapsed = time.perf_counter() - start
    assert build_result["shape"] is not None, build_result.get("featureResults")
    solid_count = len(build_result["shape"].solids())
    print(f"w7x_x{_COUNT} build_document_shape: {build_elapsed:.3f}s ({solid_count} solids)")

    # 2. Tessellation at the display tolerance.
    start = time.perf_counter()
    solids = geometry_service._tessellate_shape(
        build_result["shape"].wrapped,
        _TOLERANCE,
        body_ids=build_result.get("solidBodyIds"),
    )
    tess_elapsed = time.perf_counter() - start
    face_count = sum(len(s["faces"]) for s in solids)
    triangle_count = sum(len(f["triangles"]) for s in solids for f in s["faces"])
    fingerprint_count = sum(1 for s in solids for f in s["faces"] if "fingerprint" in f)
    print(
        f"w7x_x{_COUNT} _tessellate_shape:    {tess_elapsed:.3f}s ({face_count} faces, {triangle_count} tris)"
    )
    print(f"w7x_x{_COUNT} faces with fingerprint: {fingerprint_count}/{face_count}")

    # 3. Tessellation JSON serialization + write.
    tess_data = {
        "version": 1,
        "tolerance": _TOLERANCE,
        "boundingBox": geometry_service._bounding_box(build_result["shape"].wrapped),
        "solids": solids,
    }
    start = time.perf_counter()
    doc_path.with_name("w7x_scale.tess.json").write_text(json.dumps(tess_data), encoding="utf-8")
    write_elapsed = time.perf_counter() - start
    mb = doc_path.with_name("w7x_scale.tess.json").stat().st_size / 1e6
    print(f"w7x_x{_COUNT} tess json write:      {write_elapsed:.3f}s ({mb:.1f} MB)")

    # 4. End-to-end rebuild (what the edit-rebuild loop pays).
    start = time.perf_counter()
    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
        add_graveyard=True,
        tolerance=_TOLERANCE,
    )
    full_elapsed = time.perf_counter() - start
    assert result["success"] is True, result.get("error", "")
    print(f"w7x_x{_COUNT} build_document (total): {full_elapsed:.3f}s")
