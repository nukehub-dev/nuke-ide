#!/usr/bin/env python3
"""Minimal-profile tests for the OpenFOAM scaffolding service."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

# Ensure the service module is importable.
_SERVICE_DIR = Path(__file__).parent.parent.parent / "python"
sys.path.insert(0, str(_SERVICE_DIR))

import foam_service  # noqa: E402


def test_build_case_default_files(tmp_path: Path) -> None:
    """A default icoFoam case gets the expected dictionary files."""
    result = foam_service.build_case(
        {
            "caseDir": str(tmp_path / "case"),
            "solver": "icoFoam",
            "boundaries": [
                {"name": "inlet", "type": "inlet", "value": "(1 0 0)"},
                {"name": "outlet", "type": "outlet", "value": "0"},
                {"name": "walls", "type": "wall", "value": None},
            ],
            "writeFields": ["U", "p"],
        }
    )
    assert result["success"] is True
    case_dir = Path(result["caseDir"])
    assert (case_dir / "system" / "controlDict").exists()
    assert (case_dir / "system" / "fvSchemes").exists()
    assert (case_dir / "system" / "fvSolution").exists()
    assert (case_dir / "constant" / "transportProperties").exists()
    assert (case_dir / "0" / "U").exists()
    assert (case_dir / "0" / "p").exists()
    assert (case_dir / "0" / "T").exists() is False
    control = (case_dir / "system" / "controlDict").read_text()
    assert "application     icoFoam;" in control


def test_build_case_temperature_field(tmp_path: Path) -> None:
    """Requesting T adds a temperature field file."""
    result = foam_service.build_case(
        {
            "caseDir": str(tmp_path / "case"),
            "solver": "buoyantBoussinesqSimpleFoam",
            "writeFields": ["U", "p", "T"],
        }
    )
    assert result["success"] is True
    assert (Path(result["caseDir"]) / "0" / "T").exists()


def test_build_case_mesh_copy(tmp_path: Path) -> None:
    """A mesh directory is copied into constant/polyMesh."""
    mesh_src = tmp_path / "mesh"
    mesh_src.mkdir()
    (mesh_src / "points").write_text("points")
    result = foam_service.build_case(
        {
            "caseDir": str(tmp_path / "case"),
            "solver": "icoFoam",
            "meshPath": str(mesh_src),
            "writeFields": ["p"],
        }
    )
    assert result["success"] is True
    assert (Path(result["caseDir"]) / "constant" / "polyMesh" / "points").exists()


def test_list_solvers_cli(tmp_path: Path) -> None:
    """The CLI listSolvers operation returns the known solver set."""
    request_file = tmp_path / "request.json"
    request_file.write_text(json.dumps({"operation": "listSolvers", "caseDir": str(tmp_path)}))
    result = subprocess.run(
        [sys.executable, "-m", "foam_service", "--request", str(request_file)],
        cwd=_SERVICE_DIR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert "icoFoam" in parsed["solvers"]
    assert "simpleFoam" in parsed["solvers"]


def test_build_case_cli(tmp_path: Path) -> None:
    """The CLI buildCase operation scaffolds a case."""
    request_file = tmp_path / "request.json"
    request_file.write_text(
        json.dumps(
            {
                "operation": "buildCase",
                "caseDir": str(tmp_path / "case"),
                "solver": "simpleFoam",
                "writeFields": ["U", "p"],
            }
        )
    )
    result = subprocess.run(
        [sys.executable, "-m", "foam_service", "--request", str(request_file)],
        cwd=_SERVICE_DIR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed["success"] is True
    assert (Path(parsed["caseDir"]) / "system" / "fvSolution").exists()


def test_export_stl_missing_ocp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """STL export fails gracefully when OCP is not available."""
    step_path = tmp_path / "model.step"
    step_path.write_text("ISO-10303-21;")
    monkeypatch.setattr(foam_service, "HAS_OCP", False)
    result = foam_service.export_stl(
        {"stepPath": str(step_path), "outputDir": str(tmp_path / "stl")}
    )
    assert result["success"] is False
    assert "OCP" in result["error"]


def test_export_stl_missing_step(tmp_path: Path) -> None:
    """A nonexistent STEP file returns a structured error in any profile."""
    result = foam_service.export_stl(
        {"stepPath": str(tmp_path / "nope.step"), "outputDir": str(tmp_path / "stl")}
    )
    assert result["success"] is False
    assert "not found" in result["error"].lower()


def test_sanitize_stl_name() -> None:
    """Region names are made safe for use as file names."""
    assert foam_service._sanitize_stl_name("plasma chamber", "fb") == "plasma_chamber"
    assert foam_service._sanitize_stl_name("wall/panel", "fb") == "wall_panel"
    assert foam_service._sanitize_stl_name("../..", "fb") == "fb"
    assert foam_service._sanitize_stl_name("name", "fb") == "name"


def _requires_full_profile() -> None:
    """Skip a test if the full CAD dependency profile is unavailable."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("OCP", reason="OCP not installed")


def test_export_stl_per_solid_named(tmp_path: Path) -> None:
    """Full profile: each STEP solid becomes a named, sanitized binary STL."""
    _requires_full_profile()
    from build123d import Box, Compound, Pos, export_step

    step_path = tmp_path / "model.step"
    model = Compound([Box(10, 10, 10), Pos(20, 0, 0) * Box(10, 10, 10)])
    export_step(model, str(step_path))

    result = foam_service.export_stl(
        {
            "stepPath": str(step_path),
            "outputDir": str(tmp_path / "stl"),
            "names": {"1": "plasma chamber", "2": "wall/panel"},
        }
    )
    assert result["success"] is True, result.get("error", "")
    assert len(result["stlFiles"]) == 2
    assert {Path(p).name for p in result["stlFiles"]} == {"plasma_chamber.stl", "wall_panel.stl"}
    for stl in result["stlFiles"]:
        data = Path(stl).read_bytes()
        # Binary STL: 80-byte header + uint32 facet count + 50 bytes per facet.
        facet_count = int.from_bytes(data[80:84], "little")
        assert facet_count > 0
        assert len(data) == 84 + 50 * facet_count


def test_export_stl_default_names(tmp_path: Path) -> None:
    """Full profile: without a names map, solids are exported as solid_N."""
    _requires_full_profile()
    from build123d import Box, export_step

    step_path = tmp_path / "box.step"
    export_step(Box(5, 5, 5), str(step_path))

    result = foam_service.export_stl(
        {"stepPath": str(step_path), "outputDir": str(tmp_path / "stl")}
    )
    assert result["success"] is True, result.get("error", "")
    assert [Path(p).name for p in result["stlFiles"]] == ["solid_1.stl"]


def test_solver_default_unknown() -> None:
    """Unknown solvers fall back to a generic setup."""
    defaults = foam_service._solver_default("customSolver")
    assert defaults["application"] == "customSolver"
    assert "nu" in defaults["transport"]
