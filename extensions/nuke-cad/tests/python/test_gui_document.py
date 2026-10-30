#!/usr/bin/env python3
"""Full-profile tests for the GUI-authored pincell fixture.

These tests exercise the committed .nuke-cad document produced by the GUI-path
vitest driver, proving it flows through geometry_service.build_document to a
valid B-rep with the expected selector map.
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
from pathlib import Path

import geometry_service
import pytest

_FIXTURE_DIR = Path(__file__).parent.parent / "e2e" / "assets"
_PINCELL_DOC = _FIXTURE_DIR / "gui_pincell.nuke-cad"


def _load_fixture() -> dict:
    assert _PINCELL_DOC.exists(), f"GUI pincell fixture not found: {_PINCELL_DOC}"
    return json.loads(_PINCELL_DOC.read_text(encoding="utf-8"))


def test_gui_pincell_fixture_is_valid_json() -> None:
    doc = _load_fixture()
    assert doc.get("version") == 3
    assert doc.get("name") == "pincell"
    assert isinstance(doc.get("curves"), list)
    body_labels = {b.get("label") for b in doc.get("bodies", [])}
    assert "fuel" in body_labels
    assert "clad" in body_labels
    assert "moderator" in body_labels
    for feature in doc.get("features", []):
        assert "body" in feature


def test_build_document_from_gui_pincell_fixture(tmp_path: Path) -> None:
    """The committed GUI pincell document builds successfully and exposes the
    expected labeled solids."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc_path = tmp_path / "gui_pincell.nuke-cad"
    doc_path.write_text(_PINCELL_DOC.read_text(encoding="utf-8"), encoding="utf-8")

    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 3, result["solidCount"]
    selector_map = result.get("selectorMap") or {}
    # Features are processed in topological order (sorted here because there are
    # no dependencies): clad -> fuel -> moderator.
    assert selector_map.get("clad") == [1], selector_map
    assert selector_map.get("fuel") == [2], selector_map
    assert selector_map.get("moderator") == [3], selector_map
    assert Path(result["stepPath"]).exists()
    assert Path(result["tessPath"]).exists()
    assert all(r["status"] == "built" for r in result["featureResults"])


def _rect_primitives(x0: float, y0: float, x1: float, y1: float) -> list:
    return [
        {"id": "p1", "type": "point", "x": x0, "y": y0},
        {"id": "p2", "type": "point", "x": x1, "y": y0},
        {"id": "p3", "type": "point", "x": x1, "y": y1},
        {"id": "p4", "type": "point", "x": x0, "y": y1},
        {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
        {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
        {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
        {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
    ]


def test_build_document_forwards_warnings_and_consumed_bodies(tmp_path: Path) -> None:
    """Cross-body overlap warnings and boolean-consumed body ids from the feature
    builder reach the document-build RPC response."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = {
        "version": 2,
        "name": "overlap",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [
            {"id": "body-a", "name": "A"},
            {"id": "body-b", "name": "B"},
            {"id": "body-c", "name": "C"},
        ],
        "sketches": [
            {
                "id": "rect-a",
                "name": "a",
                "datumId": "dxy",
                "primitives": _rect_primitives(0.0, 0.0, 10.0, 10.0),
                "constraints": [],
            },
            {
                "id": "rect-b",
                "name": "b",
                "datumId": "dxy",
                "primitives": _rect_primitives(30.0, 30.0, 35.0, 35.0),
                "constraints": [],
            },
            {
                "id": "rect-c",
                "name": "c",
                "datumId": "dxy",
                "primitives": _rect_primitives(5.0, 5.0, 15.0, 15.0),
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "pad-a",
                "name": "a",
                "type": "pad",
                "sketchId": "rect-a",
                "body": "body-a",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pad-b",
                "name": "b",
                "type": "pad",
                "sketchId": "rect-b",
                "body": "body-b",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pad-c",
                "name": "c",
                "type": "pad",
                "sketchId": "rect-c",
                "body": "body-c",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "cut",
                "name": "cut",
                "type": "booleanCut",
                "body": "body-a",
                "params": {"targetBody": "body-a", "toolBodies": ["body-b"]},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    }
    doc_path = tmp_path / "overlap.nuke-cad"
    doc_path.write_text(json.dumps(doc), encoding="utf-8")

    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error", "")
    # body-b is consumed by the boolean cut and excluded from the assembly.
    assert result["consumedBodies"] == ["body-b"]
    # body-a and body-c overlap and are not merged: reported as a warning.
    overlap_warnings = [w for w in result.get("warnings", []) if "overlap" in w]
    assert overlap_warnings, result.get("warnings", [])
    assert any("body-a" in w and "body-c" in w for w in overlap_warnings)
