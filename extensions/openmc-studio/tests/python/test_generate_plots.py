"""Tests for generate_plots: build_plot logic and main() argparse wiring.

The real plot generation (openmc) is never exercised here; build_plot is
tested against a fake openmc module injected into sys.modules, and main() is
tested with generate_plots.run_generate_plots replaced by a stub.
"""

import json
import sys
import types

import generate_plots
import pytest


class _FakePlot:
    """Fake plot object recording constructor args and attribute assignments."""

    def __init__(self, plot_id=None, name=""):
        self.id = plot_id
        self.name = name


class _FakeCell:
    def __init__(self, cell_id=None):
        self.id = cell_id


class _FakeMaterial:
    def __init__(self, material_id=None):
        self.id = material_id


class _FakeGeometry:
    def get_all_cells(self):
        return {1: _FakeCell(1), 2: _FakeCell(2)}


def _fake_openmc():
    """Build a fake openmc module with the classes build_plot uses."""
    fake = types.ModuleType("openmc")
    fake.SlicePlot = _FakePlot
    fake.VoxelPlot = _FakePlot
    fake.SolidRayTracePlot = _FakePlot
    fake.WireframeRayTracePlot = _FakePlot
    fake.Cell = _FakeCell
    fake.Material = _FakeMaterial
    return fake


@pytest.fixture
def fake_openmc_module(monkeypatch):
    """Inject the fake openmc module into sys.modules for build_plot tests."""
    fake = _fake_openmc()
    monkeypatch.setitem(sys.modules, "openmc", fake)
    return fake


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        generate_plots.log_progress("rendering")
        captured = capsys.readouterr()
        assert captured.err == "rendering\n"
        assert captured.out == ""


class TestBuildPlot:
    def test_slice_plot(self, fake_openmc_module):
        """Slice config maps to basis, 2-value width, pixels, and png filename."""
        plot = generate_plots.build_plot(
            {
                "id": 1,
                "type": "slice",
                "basis": "xz",
                "origin": [1, 2, 3],
                "width": 20,
                "height": 30,
                "pixels": [400, 300],
                "colorBy": "cell",
            },
            _FakeGeometry(),
            [],
        )
        assert plot.basis == "xz"
        assert plot.origin == (1, 2, 3)
        assert plot.width == (20, 30)
        assert plot.pixels == (400, 300)
        assert plot.color_by == "cell"
        assert plot.filename == "plot_1.png"

    def test_voxel_plot_computes_origin_and_width_from_bounds(self, fake_openmc_module):
        """Voxel config converts lower-left/upper-right to center + 3-value width."""
        plot = generate_plots.build_plot(
            {
                "id": 2,
                "type": "voxel",
                "lowerLeft": [-10, -20, -30],
                "upperRight": [10, 20, 30],
                "voxels": [10, 20, 30],
                "colorBy": "material",
            },
            _FakeGeometry(),
            [],
        )
        assert plot.origin == (0, 0, 0)
        assert plot.width == (20, 40, 60)
        assert plot.pixels == (10, 20, 30)
        assert plot.filename == "plot_2.h5"

    def test_solid_raytrace_plot(self, fake_openmc_module):
        """Solid ray-trace config maps camera, light, and opaque domains."""
        plot = generate_plots.build_plot(
            {
                "id": 3,
                "type": "solid-raytrace",
                "cameraPosition": [10, 10, 10],
                "lookAt": [1, 2, 3],
                "horizontalFieldOfView": 50,
                "orthographicWidth": 25,
                "pixels": [800, 600],
                "lightPosition": [5, 5, 5],
                "diffuseFraction": 0.3,
                "opaqueIds": [1, 2],
                "colorBy": "material",
            },
            _FakeGeometry(),
            [],
        )
        assert plot.camera_position == (10, 10, 10)
        assert plot.look_at == (1, 2, 3)
        assert plot.horizontal_field_of_view == 50.0
        assert plot.orthographic_width == 25.0
        assert plot.pixels == (800, 600)
        assert plot.light_position == (5, 5, 5)
        assert plot.diffuse_fraction == 0.3
        assert plot.opaque_domains == [1, 2]
        assert plot.filename == "plot_3.png"

    def test_wireframe_raytrace_plot_resolves_domains(self, fake_openmc_module):
        """Wireframe domains resolve to actual cells from the geometry."""
        plot = generate_plots.build_plot(
            {
                "id": 4,
                "type": "wireframe-raytrace",
                "cameraPosition": [10, 0, 0],
                "lookAt": [0, 0, 0],
                "wireframeThickness": 2,
                "wireframeColor": [255, 0, 0],
                "wireframeIds": [1, 2],
                "colorBy": "cell",
            },
            _FakeGeometry(),
            [],
        )
        assert plot.wireframe_thickness == 2
        assert plot.wireframe_color == (255, 0, 0)
        assert [d.id for d in plot.wireframe_domains] == [1, 2]
        assert plot.filename == "plot_4.png"

    def test_color_by_coerced_to_cell_or_material(self, fake_openmc_module):
        """Non-cell/material colorBy values (temperature, density) fall back to material."""
        plot = generate_plots.build_plot(
            {
                "id": 5,
                "type": "slice",
                "basis": "xy",
                "origin": [0, 0, 0],
                "colorBy": "temperature",
            },
            _FakeGeometry(),
            [],
        )
        assert plot.color_by == "material"

    def test_unknown_type_raises(self, fake_openmc_module):
        """An unknown plot type raises ValueError."""
        with pytest.raises(ValueError, match="Unknown plot type"):
            generate_plots.build_plot({"id": 6, "type": "bogus"}, _FakeGeometry(), [])


class TestMainArgparse:
    def test_missing_plots_config_exits_with_code_2(self, monkeypatch):
        """--plots-config is required."""
        monkeypatch.setattr(sys, "argv", ["generate_plots.py", "/tmp"])
        with pytest.raises(SystemExit) as exc:
            generate_plots.main()
        assert exc.value.code == 2

    def test_missing_working_directory_returns_json_error(self, monkeypatch, capsys, tmp_path):
        """A nonexistent working directory yields a JSON error object, exit 0."""
        config = tmp_path / "plots.json"
        config.write_text("[]")
        monkeypatch.setattr(
            sys,
            "argv",
            ["generate_plots.py", "/nonexistent-dir-xyz", "--plots-config", str(config)],
        )
        with pytest.raises(SystemExit) as exc:
            generate_plots.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False

    def test_missing_config_file_returns_json_error(self, monkeypatch, capsys, tmp_path):
        """A nonexistent plots config file yields a JSON error object, exit 0."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["generate_plots.py", str(tmp_path), "--plots-config", str(tmp_path / "nope.json")],
        )
        with pytest.raises(SystemExit) as exc:
            generate_plots.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "not found" in result["error"].lower()

    def test_success_path_prints_single_json_object(self, monkeypatch, capsys, tmp_path):
        """main() prints exactly one JSON object with the stubbed run results."""
        config = tmp_path / "plots.json"
        config.write_text('[{"id": 1, "type": "slice"}]')
        expected = {
            "success": True,
            "files": [{"plotId": 1, "type": "slice", "path": "/tmp/plot_1.png", "kind": "png"}],
        }
        monkeypatch.setattr(generate_plots, "run_generate_plots", lambda args: expected)
        monkeypatch.setattr(
            sys, "argv", ["generate_plots.py", str(tmp_path), "--plots-config", str(config)]
        )
        generate_plots.main()
        out_lines = capsys.readouterr().out.strip().splitlines()
        assert len(out_lines) == 1
        assert json.loads(out_lines[0]) == expected


class TestOpenMCIntegration:
    def test_plot_classes_accept_script_arguments(self):
        """The openmc plot classes accept the constructor args the script passes."""
        openmc = pytest.importorskip("openmc")

        slice_plot = openmc.SlicePlot(plot_id=1, name="test")
        slice_plot.basis = "xy"
        slice_plot.origin = (0, 0, 0)
        slice_plot.width = (10, 10)
        slice_plot.pixels = (100, 100)

        solid = openmc.SolidRayTracePlot(plot_id=2, name="solid")
        solid.camera_position = (1, 0, 0)
        solid.look_at = (0, 0, 0)
        solid.horizontal_field_of_view = 70
        solid.opaque_domains = [1]

        wireframe = openmc.WireframeRayTracePlot(plot_id=3, name="wire")
        wireframe.wireframe_thickness = 1

        assert slice_plot.id == 1
        assert solid.id == 2
        assert wireframe.id == 3
