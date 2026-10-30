#!/usr/bin/env python3
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
"""Tests for material property cards (manifest block + FEM resolution).

Covers the versioned ``material_data`` table, the additive ``materials``
block in ``region_manifest``, and the manifest-first/built-ins-fallback
card resolution order in ``fem_service``. Pure Python throughout — no gmsh,
no CalculiX — so this runs in the minimal pytest profile.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import fem_service as fs
import material_data as md
import pytest
from region_manifest import CURRENT_VERSION, ManifestValidationError, RegionManifest


@pytest.fixture
def card_mesh() -> fs.MeshData:
    """Return a tiny single-tet mesh with one block (pure numpy)."""
    points = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ]
    elements = [
        {
            "tag": 1,
            "dim": 3,
            "parentTag": 1,
            "nodes": [0, 1, 2, 3],
            "block": "block_1",
        },
    ]
    return fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        {"block_1": fs.np.array([0], dtype=int)},
        {},
    )


def test_material_data_versioned() -> None:
    """The table carries a version consumers can gate on."""
    assert md.MATERIAL_DATA_VERSION == 2
    assert md.MATERIAL_FIELDS == ("E", "nu", "rho", "k", "cp", "alpha", "yield")
    assert set(md.MATERIAL_UNITS) == set(md.MATERIAL_FIELDS)


def test_builtin_card_names_match_fem_service() -> None:
    """Cards are keyed by the same names ``fem_service`` knows."""
    assert set(md.builtin_material_names()) == set(fs._builtin_materials())


def test_builtin_cards_have_full_payload() -> None:
    """Every built-in card carries the six base fields with sane values.

    ``yield`` stays optional and no built-in sets it (grade-dependent
    strengths are never defaulted); when present it must be positive.
    """
    for name in md.builtin_material_names():
        card = md.builtin_card(name)
        assert set(card) == set(md.MATERIAL_FIELDS) - {"yield"}
        assert card["E"] > 0
        assert 0 < card["nu"] < 0.5
        assert card["rho"] > 0
        assert card["k"] > 0
        assert card["cp"] > 0
        assert card["alpha"] > 0
        if "yield" in card:
            assert card["yield"] > 0


def test_builtin_card_returns_a_copy() -> None:
    """Callers cannot mutate the versioned table through the lookup."""
    card = md.builtin_card("copper")
    card["E"] = -1.0
    assert md.builtin_card("copper")["E"] > 0


def test_builtin_card_unknown_name_raises() -> None:
    """Unknown card names fail loudly."""
    with pytest.raises(KeyError):
        md.builtin_card("unobtainium")


def test_builtin_values_match_fem_service() -> None:
    """The versioned table is the single source behind the FEM built-ins."""
    for name in md.builtin_material_names():
        card = md.builtin_card(name)
        props = fs._builtin_materials()[name]
        assert props["youngsModulus"] == pytest.approx(card["E"])
        assert props["poissonsRatio"] == pytest.approx(card["nu"])
        assert props["density"] == pytest.approx(card["rho"])
        assert props["conductivity"] == pytest.approx(card["k"])
        assert props["expansion"] == pytest.approx(card["alpha"])


def test_material_data_imports_with_stdlib_only() -> None:
    """``material_data`` must not pull heavy backends (minimal profile)."""
    script = (
        "import sys; sys.path.insert(0, %r);"
        " import material_data;"
        " assert 'gmsh' not in sys.modules, 'gmsh pulled in';"
        " assert 'OCC' not in sys.modules and 'OCP' not in sys.modules;"
        " print('stdlib-only ok')"
    )
    python_dir = str(Path(md.__file__).parent)
    proc = subprocess.run(
        [sys.executable, "-c", script % python_dir],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "stdlib-only ok" in proc.stdout


def test_validate_card_accepts_partial_cards() -> None:
    """Custom cards may override a subset of fields."""
    assert md.validate_card({"E": 200e9}) == {"E": 200e9}


def test_validate_card_rejects_unknown_fields() -> None:
    """Typos (legacy long names) fail loudly instead of dropping a property."""
    with pytest.raises(ValueError, match="unknown field"):
        md.validate_card({"youngsModulus": 200e9})


def test_validate_card_rejects_non_numeric() -> None:
    """Card values must be numbers in the documented units."""
    with pytest.raises(ValueError, match="must be a number"):
        md.validate_card({"E": "stiff"})


def test_manifest_materials_block_parses() -> None:
    """A manifest with a materials block exposes cards per name."""
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "fuel", "material": "my_alloy"}],
            "materials": {"my_alloy": {"E": 200e9, "nu": 0.3, "rho": 7800.0}},
        }
    )
    assert manifest.material_card_for("my_alloy") == {"E": 200e9, "nu": 0.3, "rho": 7800.0}
    assert manifest.material_card_for("unlisted") is None


def test_manifest_without_materials_stays_valid() -> None:
    """The block is additive: legacy manifests read with empty materials."""
    manifest = RegionManifest.from_dict(
        {"version": CURRENT_VERSION, "volumes": [{"selector": "fuel", "material": "UO2"}]}
    )
    assert manifest.materials == {}
    assert manifest.material_card_for("UO2") is None
    # Round-trip stays byte-identical (no empty block injected).
    assert manifest.to_dict() == {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "fuel", "material": "UO2"}],
        "surfaces": [],
    }


def test_manifest_materials_round_trip() -> None:
    """Declared cards survive a to_dict round-trip."""
    data = {
        "version": CURRENT_VERSION,
        "materials": {"my_alloy": {"E": 200e9, "k": 20.0, "cp": 500.0}},
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.to_dict()["materials"] == data["materials"]


def test_manifest_materials_must_be_an_object() -> None:
    """A non-object materials block fails validation."""
    with pytest.raises(ManifestValidationError, match="'materials' must be an object"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "materials": ["my_alloy"]})


def test_manifest_material_card_must_be_an_object() -> None:
    """A non-object card fails validation."""
    with pytest.raises(ManifestValidationError, match="must be an object"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "materials": {"x": 7.0}})


def test_manifest_material_names_must_be_non_empty() -> None:
    """Empty material names fail validation."""
    with pytest.raises(ManifestValidationError, match="non-empty strings"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "materials": {"": {"E": 1.0}}})


def test_manifest_material_unknown_field_raises() -> None:
    """Unknown card fields fail loudly (typo guard)."""
    with pytest.raises(ManifestValidationError, match="unknown field"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "materials": {"x": {"youngsModulus": 1.0}}}
        )


def test_manifest_material_non_numeric_raises() -> None:
    """Non-numeric card values fail with the documented unit."""
    with pytest.raises(ManifestValidationError, match=r"\.E must be a number \(Pa\)"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "materials": {"x": {"E": "stiff"}}})


def test_resolve_manifest_card_wins_over_builtin() -> None:
    """Manifest-first: a manifest card shadows the built-in of the same name."""
    cards = {"structural_steel": {"E": 1.0, "nu": 0.25, "rho": 1000.0}}
    resolved = fs._resolve_materials({"block_1": "structural_steel"}, cards)
    assert resolved["block_1"]["youngsModulus"] == pytest.approx(1.0)
    assert resolved["block_1"]["poissonsRatio"] == pytest.approx(0.25)
    # Built-ins still back every other name.
    fallback = fs._resolve_materials({"block_2": "copper"}, cards)
    assert fallback["block_2"]["name"] == "Copper"


def test_resolve_custom_manifest_card() -> None:
    """A manifest-only name resolves to its card with the name as label."""
    cards = {"my_alloy": {"E": 200e9, "nu": 0.3, "rho": 7800.0, "k": 20.0}}
    resolved = fs._resolve_materials({"block_1": "my_alloy"}, cards)
    assert resolved["block_1"]["name"] == "my_alloy"
    assert resolved["block_1"]["youngsModulus"] == pytest.approx(200e9)


def test_resolve_unknown_name_raises_loudly() -> None:
    """Unlisted names keep today's behavior: ValueError, no silent default."""
    with pytest.raises(ValueError, match="Unknown material reference"):
        fs._resolve_materials({"block_1": "unobtainium"}, {"my_alloy": {"E": 1.0}})
    with pytest.raises(ValueError, match="Unknown material reference"):
        fs._resolve_materials({"block_1": "unobtainium"})


def test_resolve_custom_dict_passes_through() -> None:
    """Complete property dicts still pass through unchanged."""
    custom = {"name": "Foo", "youngsModulus": 1e9, "poissonsRatio": 0.25, "density": 1000}
    resolved = fs._resolve_materials({"block_1": custom}, {"my_alloy": {"E": 1.0}})
    assert resolved["block_1"] is custom


def test_resolve_needs_no_heavy_deps(monkeypatch: pytest.MonkeyPatch) -> None:
    """Card resolution is pure Python (works with the backends absent)."""
    monkeypatch.setattr(fs, "HAS_GMSH", False)
    monkeypatch.setattr(fs, "HAS_NUMPY", True)
    resolved = fs._resolve_materials({"block_1": "structural_steel"}, None)
    assert resolved["block_1"]["name"] == "Structural Steel"


def test_write_inp_with_manifest_card(card_mesh: fs.MeshData, tmp_path: Path) -> None:
    """A manifest-resolved card lands in the deck with its own values."""
    materials = fs._resolve_materials(
        {"block_1": "my_alloy"}, {"my_alloy": {"E": 123e9, "nu": 0.3, "rho": 7800.0}}
    )
    inp_path = tmp_path / "card.inp"
    fs.write_inp(card_mesh, inp_path, materials, [], {"stepType": "static"})
    text = inp_path.read_text(encoding="utf-8")
    assert "*Material, name=my_alloy" in text
    assert "123000000000, 0.3" in text


def test_run_fem_unknown_card_name_fails_loudly(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Unknown names fail through the public API as a structured error."""
    points = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    elements = [{"tag": 1, "dim": 3, "parentTag": 1, "nodes": [0, 1, 2, 3], "block": "block_1"}]
    mesh = fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        {"block_1": fs.np.array([0], dtype=int)},
        {},
    )
    monkeypatch.setattr(fs, "_require_deps", lambda: None)
    monkeypatch.setattr(fs, "_read_gmsh_mesh", lambda _path: mesh)
    msh = tmp_path / "mesh.msh"
    msh.write_text("stub", encoding="utf-8")
    result = fs.run_fem(
        str(msh),
        output_dir=str(tmp_path),
        materials={"block_1": "unobtainium"},
        material_cards={"my_alloy": {"E": 1.0}},
    )
    assert result["success"] is False
    assert "Unknown material reference" in result["error"]


def test_run_fem_threads_manifest_cards(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """``material_cards`` flows from ``run_fem`` into the written deck."""
    points = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    elements = [{"tag": 1, "dim": 3, "parentTag": 1, "nodes": [0, 1, 2, 3], "block": "block_1"}]
    mesh = fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        {"block_1": fs.np.array([0], dtype=int)},
        {},
    )
    monkeypatch.setattr(fs, "_require_deps", lambda: None)
    monkeypatch.setattr(fs, "_read_gmsh_mesh", lambda _path: mesh)
    msh = tmp_path / "mesh.msh"
    msh.write_text("stub", encoding="utf-8")
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "block_1", "material": "my_alloy"}],
            "materials": {"my_alloy": {"E": 123e9, "nu": 0.3, "rho": 7800.0}},
        }
    )
    result = fs.run_fem(
        str(msh),
        output_dir=str(tmp_path),
        materials={"block_1": "my_alloy"},
        material_cards=manifest.materials,
        run=False,
    )
    assert result["success"] is True, result.get("error", "")
    text = Path(result["inpPath"]).read_text(encoding="utf-8")
    assert "*Material, name=my_alloy" in text


def test_cli_list_materials_still_lists_builtins() -> None:
    """``--list-materials`` keeps reporting every built-in key."""
    script = Path(__file__).parents[2] / "python" / "fem_service.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--list-materials"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert set(data) == set(md.builtin_material_names())
    assert data["structural_steel"]["name"] == "Structural Steel"
