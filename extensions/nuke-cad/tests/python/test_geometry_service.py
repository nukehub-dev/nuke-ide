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


def test_sys_exit_in_script_is_reported_not_fatal(tmp_path: Path) -> None:
    """sys.exit() in a user script must not kill the service; it is an error result."""
    script = tmp_path / "bail.py"
    script.write_text("import sys\nsys.exit(3)\n")
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "sys.exit(3)" in result["error"]


def test_script_timeout_is_reported(tmp_path: Path) -> None:
    """A hung user script is killed after the timeout and reported as an error."""
    script = tmp_path / "hang.py"
    script.write_text("import time\nwhile True:\n    time.sleep(0.1)\n")
    result = geometry_service.build_geometry(str(script), script_timeout=2.0)
    assert result["success"] is False
    assert "timed out" in result["error"]


def test_script_stdout_noise_does_not_corrupt_protocol(tmp_path: Path) -> None:
    """User prints on stdout must not break result parsing."""
    script = tmp_path / "noisy.py"
    script.write_text('print("hello from user script")\nprint({"not": "protocol"})\n')
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
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True
    assert any("unknown selectors" in w.lower() for w in (result.get("warnings") or []))


def test_labeled_compound_selector_map(tmp_path: Path) -> None:
    """build123d labels on Compound children resolve to 1-based solid indices."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box1.label = 'left'\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "box2.label = 'right'\n"
        "model = Compound(children=[box1, box2])\n"
    )
    manifest = tmp_path / "boxes.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [
                    {"selector": "left", "name": "left_block", "material": "mat1"},
                    {"selector": "right", "name": "right_block", "material": "mat2"},
                ],
            }
        )
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["selectorMap"] == {"left": [1], "right": [2]}
    assert not any("unknown selectors" in w.lower() for w in (result.get("warnings") or []))


def test_unsupported_build123d_type_error_reaches_user(tmp_path: Path) -> None:
    """A non-Part/Compound build123d model must produce a specific error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "sketch.py"
    script.write_text("from build123d import *\nmodel = Solid.make_box(5, 5, 5)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is False
    assert "Unsupported build123d model type" in result["error"]


def test_import_step_file(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
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

    # STEP imports skip DAGMC/mesh export by default.
    assert result["dagmcSuccess"] is False
    assert Path(result["dagmcPath"]).exists() is False
    assert result["meshSuccess"] is False
    assert Path(result["meshPath"]).exists() is False


def test_import_step_file_export_opt_in(tmp_path: Path) -> None:
    """Explicitly requesting DAGMC export on a STEP import must produce the H5M."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    result = geometry_service.import_step_file(
        build_result["stepPath"],
        output_dir=str(import_dir),
        export_dagmc=True,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")
    assert Path(result["dagmcPath"]).exists()
