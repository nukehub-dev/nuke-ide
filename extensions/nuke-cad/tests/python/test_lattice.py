#!/usr/bin/env python3
"""Rectangular/hexagonal lattice features (pin arrays).

Minimal-profile tests exercise the pure layout/label/validation helpers;
full-profile tests verify solid modeling semantics (disjoint fuse skip,
overlapping fuse, subtractive cuts, nesting rejection, downstream patterns,
and per-cell ``selector_map`` entries driving DAGMC groups).
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

import math
from typing import Any

import feature_builder as fb
import pytest
from doc_build_helpers import _by_id, _document, _feature, _rect_sketch


def _offsets(params: dict[str, Any]) -> list[tuple[tuple[float, float], tuple[int, int]]]:
    return fb._lattice_cell_offsets(params)


def test_lattice_offsets_rect() -> None:
    """Rect grids center on the source position with independent X/Y pitch."""
    cells = _offsets({"latticeType": "rectangular", "rows": 2, "cols": 3, "pitch": 10.0})
    assert [(row, col) for _, (row, col) in cells] == [
        (0, 0),
        (0, 1),
        (0, 2),
        (1, 0),
        (1, 1),
        (1, 2),
    ]
    positions = {(round(dx, 9), round(dy, 9)) for (dx, dy), _ in cells}
    assert positions == {
        (-10.0, -5.0),
        (0.0, -5.0),
        (10.0, -5.0),
        (-10.0, 5.0),
        (0.0, 5.0),
        (10.0, 5.0),
    }
    # pitchY defaults to pitch; the origin shifts every cell uniformly.
    shifted = _offsets(
        {
            "latticeType": "rectangular",
            "rows": 1,
            "cols": 2,
            "pitch": 4.0,
            "origin": [1.0, -2.0],
        }
    )
    assert [(round(dx, 9), round(dy, 9)) for (dx, dy), _ in shifted] == [
        (-1.0, -2.0),
        (3.0, -2.0),
    ]


def test_lattice_offsets_hex_offset() -> None:
    """Hex offset layouts stagger alternate rows (pointy-top) or columns (flat-top)."""
    pitch = 6.0
    pointy = _offsets({"latticeType": "hexagonal", "rows": 2, "cols": 2, "pitch": pitch})
    by_cell = {(row, col): (dx, dy) for (dx, dy), (row, col) in pointy}
    row_step = pitch * math.sqrt(3.0) / 2.0
    assert by_cell[(0, 0)] == pytest.approx((-pitch / 2.0, -row_step / 2.0))
    assert by_cell[(0, 1)] == pytest.approx((pitch / 2.0, -row_step / 2.0))
    # Odd rows shift by half a pitch in x.
    assert by_cell[(1, 0)] == pytest.approx((0.0, row_step / 2.0))
    assert by_cell[(1, 1)] == pytest.approx((pitch, row_step / 2.0))
    flat = _offsets(
        {
            "latticeType": "hexagonal",
            "rows": 2,
            "cols": 2,
            "pitch": pitch,
            "orientation": "flatTop",
        }
    )
    flat_by_cell = {(row, col): (dx, dy) for (dx, dy), (row, col) in flat}
    col_step = pitch * math.sqrt(3.0) / 2.0
    assert flat_by_cell[(0, 0)] == pytest.approx((-col_step / 2.0, -pitch / 2.0))
    assert flat_by_cell[(1, 1)] == pytest.approx((col_step / 2.0, pitch))


def test_lattice_offsets_hex_rings() -> None:
    """Ring layouts enumerate axial hexes with axial pointy-top placement."""
    assert fb._lattice_cell_count({"rings": 0}) == 1
    assert fb._lattice_cell_count({"rings": 1}) == 7
    assert fb._lattice_cell_count({"rings": 2}) == 19
    cells = _offsets({"latticeType": "hexagonal", "rings": 1, "pitch": 2.0})
    assert len(cells) == 7
    by_cell = {(row, col): (dx, dy) for (dx, dy), (row, col) in cells}
    # Center cell plus six neighbors in odd-r coordinates.
    assert by_cell[(0, 0)] == pytest.approx((0.0, 0.0))
    assert by_cell[(0, 1)] == pytest.approx((2.0 * math.sqrt(3.0), 0.0))
    assert by_cell[(1, 0)] == pytest.approx((math.sqrt(3.0), 3.0))
    assert len({(row, col) for _, (row, col) in cells}) == 7


def test_lattice_labels() -> None:
    """Cells label uniformly as <prefix>_r<row>c<col> in odd-r coordinates."""
    labels = fb._lattice_cell_labels(
        {"latticeType": "rectangular", "rows": 2, "cols": 2, "pitch": 1.0}, "pin"
    )
    assert labels == ["pin_r0c0", "pin_r0c1", "pin_r1c0", "pin_r1c1"]
    ring_labels = fb._lattice_cell_labels(
        {"latticeType": "hexagonal", "rings": 0, "pitch": 1.0}, "pin"
    )
    assert ring_labels == ["pin_r0c0"]
    # Prefix falls back from labelPrefix to the body label to the source name.
    source = {"id": "pin", "name": "Pin"}
    assert fb._lattice_label_prefix({"labelPrefix": "rod"}, source, "body") == "rod"
    assert fb._lattice_label_prefix({}, source, "body") == "body"
    assert fb._lattice_label_prefix({}, source, None) == "Pin"
    assert fb._lattice_label_prefix({}, {"id": "pin"}, None) == "pin"


def test_lattice_validate() -> None:
    """Param validation mirrors the schema: extents XOR, gating, pitch, cap."""
    good = {
        "source": "pin",
        "latticeType": "rectangular",
        "rows": 2,
        "cols": 3,
        "pitch": 10.0,
    }
    layout = fb._validate_lattice_params(dict(good), "lat")
    assert (layout["rows"], layout["cols"], layout["pitchY"]) == (2, 3, 10.0)
    assert layout["orientation"] == "pointyTop"
    assert layout["origin"] == (0.0, 0.0)
    bad_cases = [
        # rows/cols XOR rings
        {**good, "rings": 1},
        {**good, "rows": 2, "cols": None},
        {"source": "pin", "latticeType": "rectangular", "pitch": 1.0},
        {**good, "rows": 0},
        {**good, "rings": -1},
        # gating
        {**good, "pitchY": 2.0, "latticeType": "hexagonal"},
        {**good, "orientation": "flatTop"},
        {**good, "latticeType": "hexagonal", "orientation": "cube"},
        # numerics
        {**good, "pitch": 0.0},
        {**good, "pitch": float("inf")},
        {**good, "origin": [1.0]},
        {**good, "labelPrefix": ""},
        {**good, "scale": -1.0},
        {"source": "", **{k: v for k, v in good.items() if k != "source"}},
        {**good, "latticeType": "square"},
        # cell cap
        {**good, "rows": 51, "cols": 51},
    ]
    for bad in bad_cases:
        with pytest.raises(fb.FeatureBuilderError):
            fb._validate_lattice_params(dict(bad), "lat")


def _pin_doc(
    lattice_params: dict[str, Any],
    body_label: str | None = "assembly",
    source_type: str = "primitive",
    source_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pin source plus one lattice on a single body (primitive pin by default)."""
    bodies: list[dict[str, Any]] = [{"id": "body-1", "name": "Body 1"}]
    if body_label is not None:
        bodies[0]["label"] = body_label
    params: dict[str, Any] = {"shape": "cylinder", "dimensions": [1.0, 5.0]}
    if source_params is not None:
        params = source_params
    return _document(
        [
            _feature("pin", source_type, params),
            _feature("lat", "lattice", lattice_params),
        ],
        [],
        bodies=bodies,
    )


def test_lattice_build_origin_applied_once() -> None:
    """The in-plane origin shifts cells exactly once (no double application).

    A 1x2 pitch-10 lattice with origin [5, 0] lands one cell exactly on the
    source position, so the center cell is attributed rather than rebuilt:
    two solids total. Applying the origin twice would miss the source and
    build three.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc(
        {
            "source": "pin",
            "latticeType": "rectangular",
            "rows": 1,
            "cols": 2,
            "pitch": 10.0,
            "origin": [5.0, 0.0],
        }
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat"]["status"] == "built"
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 2
    selector = result["selectorMap"]
    assert selector.get("assembly_r0c0") == [1]
    assert selector.get("assembly_r0c1") == [2]


def test_lattice_build_disjoint() -> None:
    """Disjoint pincells take the flat-Compound path with per-cell solids."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc(
        {"source": "pin", "latticeType": "rectangular", "rows": 2, "cols": 2, "pitch": 10.0}
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat"]["status"] == "built"
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 5
    selector = result["selectorMap"]
    # Body-level entry is unchanged (all body solids); per-cell entries each
    # point at that cell's own solid.
    assert selector.get("assembly") == [1, 2, 3, 4, 5]
    for label in ("assembly_r0c0", "assembly_r0c1", "assembly_r1c0", "assembly_r1c1"):
        assert label in selector, selector
    cell_indices = [
        selector[label][0] for label in sorted(selector) if label.startswith("assembly_r")
    ]
    assert sorted(cell_indices) == [2, 3, 4, 5]
    assert len(set(cell_indices)) == 4


def test_lattice_build_hex_rings_dagmc_groups() -> None:
    """Hex-ring pincells map to distinct solids; groups form per cell downstream."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc({"source": "pin", "latticeType": "hexagonal", "rings": 1, "pitch": 10.0})
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat"]["status"] == "built"
    assert result["shape"] is not None
    # Six ring cells plus the original pin: the center cell reproduces the
    # source exactly, so it is attributed rather than rebuilt.
    assert len(result["shape"].solids()) == 7
    selector = result["selectorMap"]
    assert selector.get("assembly") == [1, 2, 3, 4, 5, 6, 7]
    cell_labels = sorted(k for k in selector if k.startswith("assembly_r"))
    assert len(cell_labels) == 7
    assert selector["assembly_r0c0"] == [1]
    assert selector["assembly_r0c1"] != selector["assembly_r0c0"]
    assert len({tuple(selector[label]) for label in cell_labels}) == 7
    # Every per-cell key is a valid region-manifest selector: an explicit
    # volume entry per cell resolves with no unknown selectors, which is what
    # the DAGMC export cuts per-cell groups from.
    pytest.importorskip("region_manifest", reason="region_manifest not installed")
    import region_manifest

    manifest = region_manifest.RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [
                {"selector": label, "name": label, "material": "fuel"}
                for label in ("assembly", *cell_labels)
            ],
        }
    )
    assert manifest.unknown_selectors(set(selector)) == []
    assert manifest.missing_material_volumes() == []


def test_lattice_build_overlapping_fuses() -> None:
    """Overlapping cells fuse through the shared union path instead of compounding."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc(
        {"source": "pin", "latticeType": "rectangular", "rows": 1, "cols": 3, "pitch": 1.0}
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat"]["status"] == "built"
    assert result["shape"] is not None
    assert len(result["shape"].solids()) < 4
    selector = result["selectorMap"]
    assert "assembly_r0c0" in selector and "assembly_r0c2" in selector


def test_lattice_build_subtractive() -> None:
    """A pocket source cuts one hole per cell and still registers cell labels."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "hole-feature",
                "pocket",
                {"length": 6.0},
                "small",
            ),
            _feature(
                "lat",
                "lattice",
                {
                    "source": "hole-feature",
                    "latticeType": "rectangular",
                    "rows": 1,
                    "cols": 2,
                    "pitch": 4.0,
                },
            ),
        ],
        [
            _rect_sketch(20.0, 20.0, "rect"),
            _rect_sketch(1.0, 1.0, "small", dx=2.0, dy=2.0),
        ],
        bodies=[{"id": "body-1", "name": "Body 1", "label": "plate"}],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat"]["status"] == "built", _by_id(result)["lat"]
    selector = result["selectorMap"]
    assert "plate_r0c0" in selector and "plate_r0c1" in selector


def test_lattice_rejects_nesting() -> None:
    """Lattice-of-lattice (and pattern/mirror sources) fail with a clear error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc(
        {"source": "pin", "latticeType": "rectangular", "rows": 1, "cols": 2, "pitch": 10.0}
    )
    doc["features"].append(
        _feature(
            "lat2",
            "lattice",
            {"source": "lat", "latticeType": "rectangular", "rows": 1, "cols": 2, "pitch": 10.0},
        )
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lat2"]["status"] == "failed"
    assert "nest" in _by_id(result)["lat2"]["error"].lower()


def test_lattice_output_feeds_downstream_pattern() -> None:
    """The lattice tool shape is pattern/mirror-eligible (no nesting involved)."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pin_doc(
        {"source": "pin", "latticeType": "rectangular", "rows": 1, "cols": 2, "pitch": 10.0}
    )
    doc["features"].append(
        _feature(
            "pat",
            "linearPattern",
            {"source": "lat", "count": 2, "spacing": 30.0, "axis": "x"},
        )
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["pat"]["status"] == "built", _by_id(result)["pat"]
    assert result["shape"] is not None
    # Three lattice solids plus one moved two-cell copy.
    assert len(result["shape"].solids()) == 5


def test_lattice_dagmc_group_names(tmp_path: Any) -> None:
    """The imprinted DAGMC export carries one material group per lattice cell.

    Drives ``dagmc_export.convert_to_dagmc`` directly: ``geometry_service``
    document validation does not know newer feature types yet, but the built
    shape plus its ``selector_map`` flow into the imprint path unchanged.
    """
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    pytest.importorskip("region_manifest", reason="region_manifest not installed")
    import dagmc_export
    import region_manifest

    doc = _pin_doc(
        {"source": "pin", "latticeType": "rectangular", "rows": 1, "cols": 2, "pitch": 10.0}
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    selector = result["selectorMap"]
    step_path = tmp_path / "lattice.step"
    bd.export_step(result["shape"], str(step_path))
    manifest = region_manifest.RegionManifest.from_dict(
        {
            "version": 1,
            # Per-cell volumes only: the body-level "assembly" selector would
            # match every solid first (first-match-wins in the exporter), so
            # per-cell groups form exactly when the manifest lists the cells.
            "volumes": [
                {"selector": label, "name": label, "material": "fuel"}
                for label in ("assembly_r0c0", "assembly_r0c1")
            ],
        }
    )
    dagmc_result = dagmc_export.convert_to_dagmc(
        str(step_path),
        output_path=str(tmp_path / "lattice.h5m"),
        manifest=manifest,
        # Cell entries only: the exporter resolves each volume through the
        # first matching selector, so the body-level "assembly" entry (all
        # solids) would shadow the cells. Prefer-most-specific resolution is
        # a dagmc_export.py follow-up; the per-cell indices asserted above
        # are what the lattice backend delivers for it.
        selector_map={k: v for k, v in selector.items() if k != "assembly"},
        add_graveyard=False,
    )
    assert dagmc_result["success"] is True, dagmc_result.get("error", "")
    groups = _load_h5m_groups(tmp_path / "lattice.h5m")
    assert "mat:assembly_r0c0" in groups
    assert "mat:assembly_r0c1" in groups


def _load_h5m_groups(h5m_path: Any) -> dict[str, list[str]]:
    """Return a dict mapping group material names to their volume names."""
    from pathlib import Path

    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    mb.load_file(str(Path(h5m_path)))

    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    name_tag = mb.tag_get_handle(moab_types.NAME_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)
    sets = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Group"]
    )
    result: dict[str, list[str]] = {}
    for gset in sets:
        if mb.tag_get_data(gdim_tag, gset)[0][0] != 4:
            continue
        raw_name = mb.tag_get_data(name_tag, gset)[0][0]
        mat_name = raw_name.decode("utf-8") if isinstance(raw_name, bytes) else str(raw_name)
        volumes = mb.get_entities_by_type(gset, moab_types.MBENTITYSET)
        vol_names = []
        for vset in volumes:
            raw_cat = mb.tag_get_data(cat_tag, vset)[0][0]
            vname = raw_cat.decode("utf-8") if isinstance(raw_cat, bytes) else str(raw_cat)
            vol_names.append(vname)
        result[mat_name] = vol_names
    return result
