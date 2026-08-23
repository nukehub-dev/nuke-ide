#!/usr/bin/env python3
"""Gated performance measurement for the tokamak document build.

Runs the tokamak fixture through the full pipeline and records wall-clock
 timings for:

* ``feature_builder.build_document_shape`` (pure rebuild)
* ``geometry_service.build_document`` tessellation
  (``export_dagmc=False``, ``export_mesh=False``)
* ``dagmc_export.convert_to_dagmc`` imprinted h5m export

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

pytest.importorskip("build123d", reason="performance tests require build123d")
pytest.importorskip("gmsh", reason="performance tests require gmsh")
pytest.importorskip("pymoab", reason="performance tests require pymoab")

import feature_builder  # noqa: E402
import geometry_service  # noqa: E402
from dagmc_export import convert_to_dagmc  # noqa: E402

_FIXTURE = Path(__file__).parent / "assets" / "tokamak_with_divertor.nuke-cad"
_LENGTH_SCALE = 0.1
_FACETING_TOLERANCE = 2.0


def test_tokamak_document_build_performance(tmp_path: Path) -> None:
    """Profile the tokamak rebuild/tessellation/DAGMC-export times."""
    doc = tmp_path / "tokamak_with_divertor.nuke-cad"
    doc.write_text(_FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")

    # 1. Pure shape rebuild.
    raw_doc = json.loads(doc.read_text(encoding="utf-8"))
    start = time.perf_counter()
    shape_result = feature_builder.build_document_shape(raw_doc)
    shape_elapsed = time.perf_counter() - start
    assert shape_result["shape"] is not None
    assert len(shape_result["shape"].solids()) == 22
    print(f"tokamak build_document_shape: {shape_elapsed:.3f}s")

    # 2. Tessellation + STEP output (no DAGMC, no mesh).
    start = time.perf_counter()
    result = geometry_service.build_document(
        str(doc),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
        add_graveyard=True,
        tolerance=_FACETING_TOLERANCE,
        length_scale=_LENGTH_SCALE,
    )
    tess_elapsed = time.perf_counter() - start
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 22, result["solidCount"]
    print(f"tokamak build_document (tessellation): {tess_elapsed:.3f}s")

    # 3. DAGMC export from the generated STEP.
    step_path = Path(result["stepPath"])
    selector_map = result.get("selectorMap", {})
    start = time.perf_counter()
    dagmc_result = convert_to_dagmc(
        str(step_path),
        output_path=str(tmp_path / "tokamak_with_divertor.h5m"),
        manifest=None,
        selector_map=selector_map,
        faceting_tolerance=_FACETING_TOLERANCE,
        length_scale=_LENGTH_SCALE,
        auto_adjust_tolerance=False,
        add_graveyard=False,
    )
    dagmc_elapsed = time.perf_counter() - start
    assert dagmc_result["success"] is True, dagmc_result.get("error", "")
    print(f"tokamak convert_to_dagmc: {dagmc_elapsed:.3f}s")
    print(f"tokamak DAGMC triangles: {dagmc_result.get('triangle_count')}")
    print(f"tokamak DAGMC volumes:   {dagmc_result.get('solid_count')}")
