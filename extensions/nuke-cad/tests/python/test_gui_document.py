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
    assert doc.get("version") == 2
    assert doc.get("name") == "pincell"
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
