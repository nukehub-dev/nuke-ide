"""Tests for plugins.openmc.commands basic/depletion/spectrum/geometry handlers.

Handlers import their lib modules lazily, so success paths are exercised by
injecting fake lib modules into sys.modules, and failure paths force heavy
dependency absence (h5py/vtk/openmc) via monkeypatch so they run identically
with or without those packages installed. Error objects are printed as JSON
on stdout.
"""

import argparse
import json
import sys
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import basic as basic_cmds  # noqa: E402
from plugins.openmc.commands import depletion as depletion_cmds  # noqa: E402
from plugins.openmc.commands import geometry as geometry_cmds  # noqa: E402
from plugins.openmc.commands import spectrum as spectrum_cmds  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


def _install_fake_module(monkeypatch, name, **attrs):
    module = ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    return module


# ---------------------------------------------------------------------------
# basic.openmc.info / openmc.list
# ---------------------------------------------------------------------------


def test_cmd_info_success(monkeypatch, capsys):
    reader = type(
        "OpenMCReader",
        (),
        {"load_statepoint": lambda self, path: {"file": path, "tallies": 3}},
    )
    _install_fake_module(monkeypatch, "plugins.openmc.lib.reader", OpenMCReader=reader)

    args = _parse(basic_cmds.cmd_info, ["sp.h5"])
    assert basic_cmds.cmd_info(args) == 0
    assert _stdout_json(capsys) == {"file": "sp.h5", "tallies": 3}


def test_cmd_list_success(monkeypatch, capsys):
    reader = type(
        "OpenMCReader",
        (),
        {"list_tallies": lambda self, path: [{"id": 1}, {"id": 2}]},
    )
    _install_fake_module(monkeypatch, "plugins.openmc.lib.reader", OpenMCReader=reader)

    args = _parse(basic_cmds.cmd_list, ["sp.h5"])
    assert basic_cmds.cmd_list(args) == 0
    assert _stdout_json(capsys) == [{"id": 1}, {"id": 2}]


def test_cmd_info_reader_unavailable(monkeypatch):
    """Without h5py the real reader import raises ImportError, which propagates."""
    monkeypatch.setitem(sys.modules, "h5py", None)
    monkeypatch.delitem(sys.modules, "plugins.openmc.lib.reader", raising=False)
    args = _parse(basic_cmds.cmd_info, ["sp.h5"])
    with pytest.raises(ImportError):
        basic_cmds.cmd_info(args)


def test_cmd_list_reader_unavailable(monkeypatch):
    monkeypatch.setitem(sys.modules, "h5py", None)
    monkeypatch.delitem(sys.modules, "plugins.openmc.lib.reader", raising=False)
    args = _parse(basic_cmds.cmd_list, ["sp.h5"])
    with pytest.raises(ImportError):
        basic_cmds.cmd_list(args)


# ---------------------------------------------------------------------------
# basic.openmc.check
# ---------------------------------------------------------------------------


def test_cmd_check_openmc_missing(capsys):
    """openmc is not installed here, so the check reports unavailability."""
    args = _parse(basic_cmds.cmd_check, [])
    rc = basic_cmds.cmd_check(args)

    if "openmc" not in sys.modules:
        assert rc == 1
        assert _stdout_json(capsys)["available"] is False


def test_cmd_check_openmc_available(monkeypatch, capsys):
    fake_openmc = ModuleType("openmc")
    fake_openmc.__version__ = "0.15.0"
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)

    args = _parse(basic_cmds.cmd_check, [])
    assert basic_cmds.cmd_check(args) == 0
    assert _stdout_json(capsys) == {"available": True, "version": "0.15.0"}


def test_cmd_check_openmc_without_version(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "openmc", ModuleType("openmc"))

    args = _parse(basic_cmds.cmd_check, [])
    assert basic_cmds.cmd_check(args) == 0
    assert _stdout_json(capsys) == {"available": True, "version": "unknown"}


# ---------------------------------------------------------------------------
# depletion commands
# ---------------------------------------------------------------------------


def _fake_depletion_reader(recorder):
    class OpenMCDepletionReader:
        def load_summary(self, path):
            recorder.append(("load_summary", path))
            return {"days": [0, 10]}

        def list_materials(self, path):
            recorder.append(("list_materials", path))
            return [1, 2]

        def load_material_data(self, path, mat_index, nuclides):
            recorder.append(("load_material_data", path, mat_index, nuclides))
            return {"atoms": {"U235": [1.0, 0.9]}}

    return OpenMCDepletionReader


def test_depletion_summary_success(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.reader",
        OpenMCDepletionReader=_fake_depletion_reader([]),
    )
    args = _parse(depletion_cmds.cmd_depletion_summary, ["depletion_results.h5"])
    assert depletion_cmds.cmd_depletion_summary(args) == 0
    assert _stdout_json(capsys) == {"days": [0, 10]}


def test_depletion_materials_success(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.reader",
        OpenMCDepletionReader=_fake_depletion_reader([]),
    )
    args = _parse(depletion_cmds.cmd_depletion_materials, ["depletion_results.h5"])
    assert depletion_cmds.cmd_depletion_materials(args) == 0
    assert _stdout_json(capsys) == {"materials": [1, 2]}


def test_depletion_data_parses_nuclide_filter(monkeypatch, capsys):
    recorder = []
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.reader",
        OpenMCDepletionReader=_fake_depletion_reader(recorder),
    )
    args = _parse(
        depletion_cmds.cmd_depletion_data,
        ["depletion_results.h5", "3", "--nuclides", "U235, U238 ,Pu239"],
    )
    assert depletion_cmds.cmd_depletion_data(args) == 0

    assert ("load_material_data", "depletion_results.h5", 3, ["U235", "U238", "Pu239"]) in recorder
    result = _stdout_json(capsys)
    assert result["summary"] == {"days": [0, 10]}
    assert result["materialData"] == {"atoms": {"U235": [1.0, 0.9]}}


def test_depletion_data_without_nuclide_filter(monkeypatch, capsys):
    recorder = []
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.reader",
        OpenMCDepletionReader=_fake_depletion_reader(recorder),
    )
    args = _parse(depletion_cmds.cmd_depletion_data, ["depletion_results.h5", "0"])
    assert depletion_cmds.cmd_depletion_data(args) == 0
    assert ("load_material_data", "depletion_results.h5", 0, None) in recorder


def test_depletion_summary_error_returns_json(capsys):
    """The real reader import fails (h5py missing); the error becomes JSON."""
    args = _parse(depletion_cmds.cmd_depletion_summary, ["depletion_results.h5"])
    rc = depletion_cmds.cmd_depletion_summary(args)

    assert rc == 1
    assert "error" in _stdout_json(capsys)


def test_depletion_materials_error_returns_json(capsys):
    args = _parse(depletion_cmds.cmd_depletion_materials, ["depletion_results.h5"])
    assert depletion_cmds.cmd_depletion_materials(args) == 1
    assert "error" in _stdout_json(capsys)


def test_depletion_data_error_returns_json(capsys):
    args = _parse(depletion_cmds.cmd_depletion_data, ["depletion_results.h5", "1"])
    assert depletion_cmds.cmd_depletion_data(args) == 1
    assert "error" in _stdout_json(capsys)


# ---------------------------------------------------------------------------
# spectrum commands
# ---------------------------------------------------------------------------


class _FakePlotter:
    def create_energy_spectrum(self, sp, tally_id, score_idx, nuclide_idx):
        return {
            "energies": np.array([1.0, 2.0]),
            "values": np.array([0.5, 0.6]),
            "tally": tally_id,
            "indices": (score_idx, nuclide_idx),
        }

    def create_spatial_plot(self, sp, tally_id, axis, score_idx, nuclide_idx):
        return {"axis": axis, "positions": np.array([0.0, 1.0])}

    def create_heatmap_slice(self, sp, tally_id, plane, slice_index, score_idx, nuclide_idx):
        return {"plane": plane, "slice": slice_index, "data": [[1, 2], [3, 4]]}

    def create_heatmap_slice_all(self, sp, tally_id, plane, score_idx, nuclide_idx):
        return [{"slice": 0}, {"slice": 1}]


@pytest.fixture
def fake_plotter_module(monkeypatch):
    return _install_fake_module(
        monkeypatch, "plugins.openmc.lib.reader", OpenMCPlotter=_FakePlotter
    )


def test_spectrum_serializes_numpy_arrays(fake_plotter_module, capsys):
    args = _parse(spectrum_cmds.cmd_spectrum, ["sp.h5", "4"])
    assert spectrum_cmds.cmd_spectrum(args) == 0

    result = _stdout_json(capsys)
    assert result["energies"] == [1.0, 2.0]
    assert result["values"] == [0.5, 0.6]
    assert result["tally"] == 4
    assert result["indices"] == [0, 0]  # default indices


def test_spectrum_honors_index_arguments(fake_plotter_module, capsys):
    args = _parse(
        spectrum_cmds.cmd_spectrum, ["sp.h5", "4", "--score-index", "2", "--nuclide-index", "1"]
    )
    assert spectrum_cmds.cmd_spectrum(args) == 0
    assert _stdout_json(capsys)["indices"] == [2, 1]


def test_spectrum_error_returns_1(capsys):
    args = _parse(spectrum_cmds.cmd_spectrum, ["sp.h5", "1"])
    assert spectrum_cmds.cmd_spectrum(args) == 1


def test_spatial_success(fake_plotter_module, capsys):
    args = _parse(spectrum_cmds.cmd_spatial, ["sp.h5", "2", "y", "--score-index", "1"])
    assert spectrum_cmds.cmd_spatial(args) == 0

    result = _stdout_json(capsys)
    assert result["axis"] == "y"
    assert result["positions"] == [0.0, 1.0]


def test_spatial_error_returns_1(capsys):
    args = _parse(spectrum_cmds.cmd_spatial, ["sp.h5", "2", "x"])
    assert spectrum_cmds.cmd_spatial(args) == 1


def test_heatmap_success(fake_plotter_module, capsys):
    args = _parse(spectrum_cmds.cmd_heatmap, ["sp.h5", "2", "xz", "5"])
    assert spectrum_cmds.cmd_heatmap(args) == 0
    result = _stdout_json(capsys)
    assert result["plane"] == "xz"
    assert result["slice"] == 5


def test_heatmap_error_returns_json(capsys):
    args = _parse(spectrum_cmds.cmd_heatmap, ["sp.h5", "2", "xy", "0"])
    assert spectrum_cmds.cmd_heatmap(args) == 1
    assert "error" in _stdout_json(capsys)


def test_heatmap_all_success(fake_plotter_module, capsys):
    args = _parse(spectrum_cmds.cmd_heatmap_all, ["sp.h5", "2", "yz"])
    assert spectrum_cmds.cmd_heatmap_all(args) == 0
    assert _stdout_json(capsys) == [{"slice": 0}, {"slice": 1}]


def test_heatmap_all_error_returns_json(capsys):
    args = _parse(spectrum_cmds.cmd_heatmap_all, ["sp.h5", "2", "xy"])
    assert spectrum_cmds.cmd_heatmap_all(args) == 1
    assert "error" in _stdout_json(capsys)


# ---------------------------------------------------------------------------
# geometry.openmc.geometry (real parser, no heavy deps)
# ---------------------------------------------------------------------------


def test_geometry_command_success(tmp_path, capsys):
    geom = tmp_path / "geometry.xml"
    geom.write_text(
        '<geometry><surface id="1" type="sphere" coeffs="0 0 0 5"/>'
        '<cell id="1" material="void" region="-1"/></geometry>'
    )
    args = _parse(geometry_cmds.cmd_geometry, [str(geom)])
    assert geometry_cmds.cmd_geometry(args) == 0
    assert "error" not in _stdout_json(capsys)


def test_geometry_command_missing_file(tmp_path, capsys):
    args = _parse(geometry_cmds.cmd_geometry, [str(tmp_path / "nope.xml")])
    assert geometry_cmds.cmd_geometry(args) == 1
    assert "error" in _stdout_json(capsys)


def test_geometry_command_unexpected_exception(monkeypatch, capsys):
    """A parser that raises (instead of returning an error dict) is caught."""

    def _boom(path):
        raise RuntimeError("parser exploded")

    _install_fake_module(monkeypatch, "plugins.openmc.lib.geometry_parser", parse_geometry=_boom)
    args = _parse(geometry_cmds.cmd_geometry, ["geom.xml"])
    assert geometry_cmds.cmd_geometry(args) == 1
    assert _stdout_json(capsys)["error"] == "parser exploded"


# ---------------------------------------------------------------------------
# geometry.openmc.visualize-geometry
# ---------------------------------------------------------------------------


def test_visualize_geometry_highlight_parsing(monkeypatch):
    captured = {}

    def fake_visualize(file, port, highlight_ids, overlaps):
        captured.update(file=file, port=port, highlight_ids=highlight_ids, overlaps=overlaps)
        return 0

    _install_fake_module(
        monkeypatch, "plugins.openmc.lib.geometry_viz", visualize_geometry=fake_visualize
    )

    args = _parse(
        geometry_cmds.cmd_visualize_geometry,
        ["geom.xml", "--port", "8901", "--highlight", "4, 5,6", "--overlaps", "ov.json"],
    )
    assert geometry_cmds.cmd_visualize_geometry(args) == 0
    assert captured == {
        "file": "geom.xml",
        "port": 8901,
        "highlight_ids": [4, 5, 6],
        "overlaps": "ov.json",
    }


def test_visualize_geometry_single_int_highlight(monkeypatch):
    captured = {}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        visualize_geometry=lambda file, port, highlight_ids, overlaps: (
            captured.update(highlight_ids=highlight_ids) or 0
        ),
    )

    args = _parse(geometry_cmds.cmd_visualize_geometry, ["geom.xml", "--highlight", "7"])
    assert geometry_cmds.cmd_visualize_geometry(args) == 0
    assert captured["highlight_ids"] == [7]


def test_visualize_geometry_no_highlight(monkeypatch):
    captured = {}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        visualize_geometry=lambda file, port, highlight_ids, overlaps: (
            captured.update(highlight_ids=highlight_ids) or 0
        ),
    )

    args = _parse(geometry_cmds.cmd_visualize_geometry, ["geom.xml"])
    assert geometry_cmds.cmd_visualize_geometry(args) == 0
    assert captured["highlight_ids"] is None


def test_visualize_geometry_integer_highlight(monkeypatch):
    """A non-string highlight value (int) is wrapped in a list directly."""
    from types import SimpleNamespace

    captured = {}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        visualize_geometry=lambda file, port, highlight_ids, overlaps: (
            captured.update(highlight_ids=highlight_ids) or 0
        ),
    )

    args = SimpleNamespace(file="geom.xml", port=None, highlight=9, overlaps=None)
    assert geometry_cmds.cmd_visualize_geometry(args) == 0
    assert captured["highlight_ids"] == [9]


def test_visualize_geometry_error_returns_json(monkeypatch, capsys):
    def _boom(file, port, highlight_ids, overlaps):
        raise RuntimeError("viz exploded")

    _install_fake_module(monkeypatch, "plugins.openmc.lib.geometry_viz", visualize_geometry=_boom)

    args = _parse(geometry_cmds.cmd_visualize_geometry, ["geom.xml"])
    assert geometry_cmds.cmd_visualize_geometry(args) == 1
    assert _stdout_json(capsys)["error"] == "viz exploded"


def test_visualize_geometry_library_unavailable(monkeypatch, capsys):
    """Without vtk the real geometry_viz import fails; the error becomes JSON."""
    monkeypatch.setitem(sys.modules, "vtk", None)
    monkeypatch.delitem(sys.modules, "plugins.openmc.lib.geometry_viz", raising=False)
    args = _parse(geometry_cmds.cmd_visualize_geometry, ["geom.xml"])
    assert geometry_cmds.cmd_visualize_geometry(args) == 1
    assert "error" in _stdout_json(capsys)


# ---------------------------------------------------------------------------
# geometry.openmc.check-overlaps / overlap-viz
# ---------------------------------------------------------------------------


def test_check_overlaps_invalid_bounds_json(capsys):
    args = _parse(geometry_cmds.cmd_check_overlaps, ["geom.xml", "--bounds", "{not json"])
    assert geometry_cmds.cmd_check_overlaps(args) == 1
    assert "Invalid bounds JSON" in _stdout_json(capsys)["error"]


def test_check_overlaps_success(monkeypatch, capsys):
    captured = {}

    def fake_check(**kwargs):
        captured.update(kwargs)
        return {"overlaps": [], "totalOverlaps": 0, "error": None}

    _install_fake_module(monkeypatch, "plugins.openmc.lib.overlap", check_overlaps=fake_check)

    args = _parse(
        geometry_cmds.cmd_check_overlaps,
        [
            "geom.xml",
            "--samples",
            "500",
            "--tolerance",
            "0.001",
            "--bounds",
            '{"min": [0,0,0], "max": [1,1,1]}',
            "--parallel",
        ],
    )
    assert geometry_cmds.cmd_check_overlaps(args) == 0
    assert captured == {
        "geometry_path": "geom.xml",
        "sample_points": 500,
        "tolerance": pytest.approx(0.001),
        "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
        "parallel": True,
    }
    assert _stdout_json(capsys)["totalOverlaps"] == 0


def test_check_overlaps_error_result_returns_1(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.overlap",
        check_overlaps=lambda **kwargs: {"overlaps": [], "totalOverlaps": 0, "error": "boom"},
    )
    args = _parse(geometry_cmds.cmd_check_overlaps, ["geom.xml"])
    assert geometry_cmds.cmd_check_overlaps(args) == 1
    assert _stdout_json(capsys)["error"] == "boom"


def test_check_overlaps_defaults(monkeypatch, capsys):
    captured = {}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.overlap",
        check_overlaps=lambda **kwargs: captured.update(kwargs) or {"error": None},
    )
    args = _parse(geometry_cmds.cmd_check_overlaps, ["geom.xml"])
    assert geometry_cmds.cmd_check_overlaps(args) == 0
    assert captured["sample_points"] == 100000
    assert captured["tolerance"] == pytest.approx(1e-6)
    assert captured["bounds"] is None
    assert captured["parallel"] is False


def test_check_overlaps_unexpected_exception(monkeypatch, capsys):
    """An exception inside the handler yields the overlaps-shaped error dict."""
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.overlap",
        check_overlaps=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("unexpected")),
    )
    args = _parse(geometry_cmds.cmd_check_overlaps, ["geom.xml"])
    assert geometry_cmds.cmd_check_overlaps(args) == 1
    result = _stdout_json(capsys)
    assert result["overlaps"] == []
    assert result["error"] == "unexpected"


def test_overlap_viz_invalid_json(capsys):
    args = _parse(geometry_cmds.cmd_overlap_viz, ["geom.xml", "--overlaps", "[oops"])
    assert geometry_cmds.cmd_overlap_viz(args) == 1
    assert "Invalid overlaps JSON" in _stdout_json(capsys)["error"]


def test_overlap_viz_success(monkeypatch, capsys):
    captured = {}

    def fake_viz(geometry_path, overlaps, marker_size):
        captured.update(geometry_path=geometry_path, overlaps=overlaps, marker_size=marker_size)
        return {"markers": [], "overlappingCellIds": []}

    _install_fake_module(monkeypatch, "plugins.openmc.lib.overlap", get_overlap_viz_data=fake_viz)

    overlaps_json = '[{"coordinates": [1,2,3], "cellIds": [1,2]}]'
    args = _parse(
        geometry_cmds.cmd_overlap_viz,
        ["geom.xml", "--overlaps", overlaps_json, "--marker-size", "2.5"],
    )
    assert geometry_cmds.cmd_overlap_viz(args) == 0
    assert captured["marker_size"] == pytest.approx(2.5)
    assert captured["overlaps"] == [{"coordinates": [1, 2, 3], "cellIds": [1, 2]}]


def test_overlap_viz_error_result_returns_1(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.overlap",
        get_overlap_viz_data=lambda **kwargs: {"markers": [], "error": "bad geometry"},
    )
    args = _parse(geometry_cmds.cmd_overlap_viz, ["geom.xml", "--overlaps", "[]"])
    assert geometry_cmds.cmd_overlap_viz(args) == 1
    assert _stdout_json(capsys)["error"] == "bad geometry"


def test_overlap_viz_unexpected_exception(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.overlap",
        get_overlap_viz_data=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("kaboom")),
    )
    args = _parse(geometry_cmds.cmd_overlap_viz, ["geom.xml", "--overlaps", "[]"])
    assert geometry_cmds.cmd_overlap_viz(args) == 1
    result = _stdout_json(capsys)
    assert result["markers"] == []
    assert result["error"] == "kaboom"


# ---------------------------------------------------------------------------
# geometry.openmc.geometry-bounds
# ---------------------------------------------------------------------------


def test_geometry_bounds_success(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.slice_viz",
        get_geometry_bounds=lambda path: {"x": [-5, 5], "y": [-5, 5], "z": [0, 10]},
    )
    args = _parse(geometry_cmds.cmd_geometry_bounds, ["model.h5m"])
    assert geometry_cmds.cmd_geometry_bounds(args) == 0
    assert _stdout_json(capsys)["z"] == [0, 10]


def test_geometry_bounds_none_result(monkeypatch, capsys):
    _install_fake_module(
        monkeypatch, "plugins.openmc.lib.slice_viz", get_geometry_bounds=lambda path: None
    )
    args = _parse(geometry_cmds.cmd_geometry_bounds, ["model.h5m"])
    assert geometry_cmds.cmd_geometry_bounds(args) == 1
    assert "Could not load geometry bounds" in _stdout_json(capsys)["error"]


def test_geometry_bounds_exception(monkeypatch, capsys):
    def _boom(path):
        raise RuntimeError("cannot read h5m")

    _install_fake_module(monkeypatch, "plugins.openmc.lib.slice_viz", get_geometry_bounds=_boom)
    args = _parse(geometry_cmds.cmd_geometry_bounds, ["model.h5m"])
    assert geometry_cmds.cmd_geometry_bounds(args) == 1
    assert _stdout_json(capsys)["error"] == "cannot read h5m"


def test_geometry_bounds_library_unavailable(capsys):
    """The real slice_viz imports vtk at module level, which fails here."""
    args = _parse(geometry_cmds.cmd_geometry_bounds, ["model.h5m"])
    assert geometry_cmds.cmd_geometry_bounds(args) == 1
    assert "error" in _stdout_json(capsys)
