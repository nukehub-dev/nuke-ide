"""Tests for the export-fidelity bundle: STEP name/color round-trip, import
flags, and pre-export validation gates.

Minimal-profile tests (inspection-gate pure helpers) run everywhere; OCP-bound
tests skip cleanly without the full CAD profile.
"""

from pathlib import Path

import inspection_gates
import pytest


def test_gates_module_imports_in_minimal_profile() -> None:
    assert inspection_gates.HAS_NUMPY is True
    assert inspection_gates.DEFAULT_MESH_DEVIATION_TOL == pytest.approx(0.05)


def test_mass_properties_clean_entry_produces_no_warnings() -> None:
    entries = [
        {
            "solidId": 1,
            "volume": 1000.0,
            "area": 600.0,
            "bbox": {"min": [-5.0, -5.0, -5.0], "max": [5.0, 5.0, 5.0]},
            "centerOfMass": [0.0, 0.0, 0.0],
        }
    ]
    assert inspection_gates.check_mass_properties(entries) == []


def test_mass_properties_flags_insane_values() -> None:
    entries = [
        {
            "solidId": 1,
            "volume": -3.0,
            "area": 0.0,
            "bbox": {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]},
            "centerOfMass": [50.0, 0.0, 0.0],
        },
        {
            "solidId": 2,
            "volume": float("nan"),
            "bbox": {"min": [1.0, 0.0, 0.0], "max": [0.0, 1.0, 1.0]},
            "centerOfMass": [0.5, 0.5, 0.5],
        },
    ]
    warnings = inspection_gates.check_mass_properties(entries)
    assert any("non-positive volume" in w for w in warnings)
    assert any("non-positive surface area" in w for w in warnings)
    assert any("outside its bounding box" in w for w in warnings)
    assert any("non-finite volume" in w for w in warnings)
    assert any("degenerate bounding box" in w for w in warnings)


def test_mass_properties_missing_keys_are_skipped_not_fatal() -> None:
    assert inspection_gates.check_mass_properties([{"solidId": 1}]) == []
    assert inspection_gates.check_mass_properties([]) == []


def test_mesh_enclosed_volume_unit_cube() -> None:
    vertices = [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
    ]
    triangles = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ]
    assert inspection_gates.mesh_enclosed_volume(vertices, triangles) == pytest.approx(1.0)
    assert inspection_gates.mesh_enclosed_volume(vertices, []) == 0.0


def test_mesh_vs_cad_flags_large_deviation_only() -> None:
    warnings = inspection_gates.check_mesh_vs_cad({1: 1000.0, 2: 1000.0}, {1: 999.0, 2: 500.0})
    assert len(warnings) == 1
    assert "Volume 2" in warnings[0]
    assert "possible overlap/gap" in warnings[0]


def test_mesh_vs_cad_skips_missing_and_degenerate_references() -> None:
    assert inspection_gates.check_mesh_vs_cad({1: 1000.0}, {}) == []
    assert inspection_gates.check_mesh_vs_cad({1: 0.0}, {1: 5.0}) == []
    assert inspection_gates.check_mesh_vs_cad({}, {1: 5.0}) == []


def test_gates_never_raise_on_garbage() -> None:
    assert inspection_gates.check_mass_properties(None) == []  # type: ignore[arg-type]
    assert inspection_gates.check_mesh_vs_cad({1: "x"}, {1: "y"}) == []  # type: ignore[dict-item]


def _requires_full_profile() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")


def test_step_name_round_trip_restores_labels(tmp_path: Path) -> None:
    """Labeled solids survive a STEP round-trip as product names + labels."""
    _requires_full_profile()
    import geometry_service

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box1.label = 'left'\n"
        "box2 = Pos(20, 0, 0) * Box(10, 10, 10)\n"
        "box2.label = 'right'\n"
        "model = Compound(children=[box1, box2])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")
    assert build_result["selectorMap"] == {"left": [1], "right": [2]}
    assert build_result.get("stepNames") == {"1": "left", "2": "right"}

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    import_result = geometry_service.import_step_file(
        build_result["stepPath"], output_dir=str(import_dir)
    )
    assert import_result["success"] is True, import_result.get("error", "")
    assert import_result["solidCount"] == 2
    # Labels restored from STEP product names (one object per solid).
    assert import_result["selectorMap"] == {"left": [1], "right": [2]}


def test_step_import_defaults_are_merge_free_and_expanded(tmp_path: Path) -> None:
    """Default import flags: merge=false, compounds expanded, per-solid objects."""
    _requires_full_profile()
    import inspect

    import geometry_service

    sig = inspect.signature(geometry_service.import_step_file)
    assert sig.parameters["merge"].default is False
    assert sig.parameters["expand_compound"].default is True
    assert sig.parameters["one_object_per_solid"].default is True

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "model = Compound([Box(10, 10, 10), Pos(20, 0, 0) * Box(10, 10, 10)])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    result = geometry_service.import_step_file(build_result["stepPath"], output_dir=str(import_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2


def test_step_import_merge_fuses_overlapping_solids(tmp_path: Path) -> None:
    """merge=True fuses overlapping solids; the default keeps them separate."""
    _requires_full_profile()
    import geometry_service

    script = tmp_path / "overlap.py"
    script.write_text(
        "from build123d import *\n"
        "model = Compound([Box(10, 10, 10), Pos(5, 0, 0) * Box(10, 10, 10)])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    plain_dir = tmp_path / "plain"
    plain_dir.mkdir()
    plain = geometry_service.import_step_file(build_result["stepPath"], output_dir=str(plain_dir))
    assert plain["success"] is True, plain.get("error", "")
    assert plain["solidCount"] == 2

    merged_dir = tmp_path / "merged"
    merged_dir.mkdir()
    merged = geometry_service.import_step_file(
        build_result["stepPath"], output_dir=str(merged_dir), merge=True
    )
    assert merged["success"] is True, merged.get("error", "")
    assert merged["solidCount"] == 1


def test_step_import_rejects_collapsed_expansion_flags(tmp_path: Path) -> None:
    """expand_compound=False / one_object_per_solid=False are unsupported."""
    _requires_full_profile()
    import geometry_service

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    with pytest.raises(ValueError, match="one object per solid"):
        geometry_service.import_step_file(build_result["stepPath"], expand_compound=False)
    with pytest.raises(ValueError, match="one object per solid"):
        geometry_service.import_step_file(build_result["stepPath"], one_object_per_solid=False)


def test_unlabeled_export_keeps_legacy_writer(tmp_path: Path) -> None:
    """Models without labels take the legacy STEPControl path (no stepNames)."""
    _requires_full_profile()
    import geometry_service

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert "stepNames" not in result
    assert result["selectorMap"] == {}


def test_label_color_is_deterministic_and_visible() -> None:
    import geometry_service

    first = geometry_service._label_color("fuel")
    assert first == geometry_service._label_color("fuel")
    assert first != geometry_service._label_color("clad")
    for channel in first:
        assert 0.25 <= channel <= 0.95


def test_solid_names_from_selector_map_first_sorted_selector_wins() -> None:
    import geometry_service

    names = geometry_service._solid_names_from_selector_map({"b": [1, 2], "a": [2]}, 2)
    assert names == ["b", "a"]
    assert geometry_service._solid_names_from_selector_map({}, 2) == [None, None]


def test_dagmc_export_reports_inspection_gates_warnings_only(tmp_path: Path) -> None:
    """Gates ride along as warnings; the export result shape is unchanged."""
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    _requires_full_profile()
    import dagmc_export
    import geometry_service

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    result = dagmc_export.convert_to_dagmc(
        build_result["stepPath"],
        output_path=str(tmp_path / "box.h5m"),
        add_graveyard=False,
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert "inspectionGates" in result
    assert set(result["inspectionGates"]) == {"massProperties", "meshDeviation"}
    # A clean box trips neither gate.
    assert result["inspectionGates"]["massProperties"] == []
    assert result["inspectionGates"]["meshDeviation"] == []
