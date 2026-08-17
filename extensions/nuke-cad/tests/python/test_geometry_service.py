"""Tests for the nuke-cad geometry service."""

import json
from pathlib import Path

import geometry_service
import pytest


def test_missing_script_returns_error(tmp_path: Path) -> None:
    result = geometry_service.build_geometry(str(tmp_path / "missing.py"))
    assert result["success"] is False
    assert "Script not found" in result["error"]


def test_script_without_model_returns_error(tmp_path: Path) -> None:
    script = tmp_path / "no_model.py"
    script.write_text("x = 1\n")
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "did not define a top-level 'model'" in result["error"]


def test_build_simple_build123d_box(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    result = geometry_service.build_geometry(str(script), output_dir=str(tmp_path))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["triangleCount"] > 0

    step_path = Path(result["stepPath"])
    tess_path = Path(result["tessPath"])
    assert step_path.exists()
    assert tess_path.exists()

    tess_data = json.loads(tess_path.read_text())
    assert tess_data["version"] == 1
    assert len(tess_data["solids"]) == 1

    # DAGMC export is attempted automatically when pymoab is available.
    h5m_path = Path(result["dagmcPath"])
    if result["dagmcSuccess"]:
        assert h5m_path.exists()
    elif result["dagmcError"]:
        assert "DAGMC export" in result["dagmcError"] or "pymoab" in result["dagmcError"].lower()


def test_region_manifest_warning_for_unknown_selector(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    manifest = tmp_path / "box.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [{"selector": "nonexistent", "name": "x", "material": "M"}],
            }
        )
    )
    result = geometry_service.build_geometry(str(script), output_dir=str(tmp_path))
    assert result["success"] is True
    assert any("unknown selectors" in w.lower() for w in (result.get("warnings") or []))


def test_import_step_file(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(str(script), output_dir=str(tmp_path))
    assert build_result["success"] is True, build_result.get("error", "")

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    result = geometry_service.import_step_file(build_result["stepPath"], output_dir=str(import_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["triangleCount"] > 0

    tess_path = Path(result["tessPath"])
    assert tess_path.exists()
    tess_data = json.loads(tess_path.read_text())
    assert len(tess_data["solids"]) == 1
