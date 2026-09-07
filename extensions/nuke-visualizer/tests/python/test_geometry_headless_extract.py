"""Tests for headless CSG->mesh JSON and static-slice extractors (P3-D1).

The new extractors in ``plugins.openmc.lib.geometry_viz`` (CSG->mesh JSON
for a three.js client) and ``plugins.openmc.lib.slice_viz`` (static .vtp
slices without a server) build geometry with numpy only. These tests need
only pytest + numpy: ``vtk`` is stubbed at import time (``slice_viz``
imports it at module level for DAGMC grid building), ``openmc`` absence is
forced via ``sys.modules``, and VTK writes are exercised with recording
fake ``vtk`` modules. New ``openmc.geometry-mesh`` /
``openmc.geometry-slice-vtk`` command handlers report errors as JSON on
stdout with exit code 1 (openmc-plugin contract).
"""

import argparse
import json
import sys
from types import ModuleType, SimpleNamespace

import pytest

np = pytest.importorskip("numpy")


def _ensure_vtk_import_stub():
    """Install a bare vtk stub so the lib modules import without vtk."""
    if sys.modules.get("vtk") is None:
        vtk_stub = ModuleType("vtk")

        def _stub_getattr(name):
            dummy = type(f"vtk{name}", (), {})
            setattr(vtk_stub, name, dummy)
            return dummy

        vtk_stub.__getattr__ = _stub_getattr
        sys.modules["vtk"] = vtk_stub
        util_mod = ModuleType("vtk.util")
        numpy_support_mod = ModuleType("vtk.util.numpy_support")
        numpy_support_mod.vtk_to_numpy = lambda arr: np.asarray(arr)
        util_mod.numpy_support = numpy_support_mod
        sys.modules["vtk.util"] = util_mod
        sys.modules["vtk.util.numpy_support"] = numpy_support_mod


_ensure_vtk_import_stub()

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import geometry as geometry_cmds  # noqa: E402
from plugins.openmc.lib import (
    geometry_viz,  # noqa: E402
    slice_viz,  # noqa: E402
)


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


_GEOM_XML = """<geometry>
  <surface id="1" type="x-plane" coeffs="-5.0" boundary="transmission" />
  <surface id="2" type="x-plane" coeffs="5.0" boundary="transmission" />
  <surface id="3" type="z-cylinder" coeffs="0.0 0.0 2.0" boundary="transmission" />
  <surface id="4" type="sphere" coeffs="0.0 0.0 0.0 3.0" boundary="vacuum" />
  <cell id="1" region="-1 2" material="1" universe="0" name="box" />
  <cell id="2" region="-3" material="2" />
  <cell id="3" region="-4" material="void" />
</geometry>
"""

_BOUNDS = {"xmin": -5.0, "xmax": 5.0, "ymin": -5.0, "ymax": 5.0, "zmin": -5.0, "zmax": 5.0}


def _write_geom(tmp_path, text=_GEOM_XML):
    path = tmp_path / "geometry.xml"
    path.write_text(text)
    return str(path)


# ---------------------------------------------------------------------------
# geometry_viz validators
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", [0, 2, 65, -1, "wide", 2.5, True, None])
def test_require_segments_rejects(bad):
    with pytest.raises(geometry_viz.GeometryExtractorError, match="segments"):
        geometry_viz._require_segments(bad)


def test_require_segments_accepts():
    assert geometry_viz._require_segments(16) == 16
    assert geometry_viz._require_segments(3) == 3


def test_require_geometry_xml_path_missing(tmp_path):
    with pytest.raises(geometry_viz.GeometryExtractorError, match="not found"):
        geometry_viz._require_geometry_xml_path(str(tmp_path / "nope.xml"))


def test_require_geometry_xml_path_rejects_suffix(tmp_path):
    other = tmp_path / "model.h5m"
    other.write_bytes(b"fake")
    with pytest.raises(geometry_viz.GeometryExtractorError, match="geometry.xml"):
        geometry_viz._require_geometry_xml_path(str(other))


# ---------------------------------------------------------------------------
# geometry_viz.extract_csg_mesh
# ---------------------------------------------------------------------------


def test_extract_csg_mesh_box(tmp_path):
    mesh = geometry_viz.extract_csg_mesh(_write_geom(tmp_path), segments=8)

    assert mesh["bounds"]["xmin"] == pytest.approx(-5.1)
    assert mesh["bounds"]["xmax"] == pytest.approx(5.1)
    assert [c["id"] for c in mesh["cells"]] == [1, 2, 3]
    assert [s["id"] for s in mesh["surfaces"]] == [1, 2, 3, 4]

    box = mesh["cells"][0]
    assert box["name"] == "box"
    assert box["material"] == "1"
    assert box["surfaceIds"] == [1, 2]
    assert box["mesh"]["kind"] == "box"
    assert len(box["mesh"]["positions"]) == 8 * 3
    assert len(box["mesh"]["indices"]) == 12 * 3
    assert box["bbox"]["xmin"] == pytest.approx(-5.0)
    assert box["bbox"]["xmax"] == pytest.approx(5.0)
    assert box["bbox"]["min"] == pytest.approx(
        [box["bbox"]["xmin"], box["bbox"]["ymin"], box["bbox"]["zmin"]]
    )
    assert box["bbox"]["max"] == pytest.approx(
        [box["bbox"]["xmax"], box["bbox"]["ymax"], box["bbox"]["zmax"]]
    )


def test_extract_csg_mesh_curved_kinds(tmp_path):
    mesh = geometry_viz.extract_csg_mesh(_write_geom(tmp_path), segments=8)

    cyl = mesh["cells"][1]["mesh"]
    assert cyl["kind"] == "z-cylinder"
    assert cyl["nVertices"] == 2 * 8 + 2
    assert cyl["nTriangles"] == 8 * 4

    sph = mesh["cells"][2]["mesh"]
    assert sph["kind"] == "sphere"
    assert sph["nVertices"] == (8 + 1) * 8
    assert sph["nTriangles"] == 8 * 8 * 2

    assert mesh["stats"] == {
        "nCells": 3,
        "nSurfaces": 4,
        "nMeshed": 3,
        "nVertices": 8 + (2 * 8 + 2) + (9 * 8),
        "nTriangles": 12 + 8 * 4 + 8 * 8 * 2,
    }


def test_extract_csg_mesh_json_serializable(tmp_path):
    mesh = geometry_viz.extract_csg_mesh(_write_geom(tmp_path), segments=4)
    assert json.loads(json.dumps(mesh))["stats"]["nCells"] == 3


def test_extract_csg_mesh_unmeshed_falls_back_to_bbox(tmp_path):
    text = """<geometry>
      <surface id="5" type="plane" coeffs="0.0 0.0 1.0 5.0" boundary="transmission" />
      <cell id="9" region="-5" material="3" />
    </geometry>
    """
    mesh = geometry_viz.extract_csg_mesh(_write_geom(tmp_path, text), segments=4)
    assert mesh["cells"][0]["mesh"] is None
    assert mesh["cells"][0]["bbox"]["zmax"] == pytest.approx(10.0)
    assert mesh["stats"]["nMeshed"] == 0


def test_extract_csg_mesh_missing_file(tmp_path):
    with pytest.raises(geometry_viz.GeometryExtractorError, match="not found"):
        geometry_viz.extract_csg_mesh(str(tmp_path / "nope.xml"))


# ---------------------------------------------------------------------------
# geometry_viz.extract_csg_from_openmc_model / write_geometry_mesh_json
# ---------------------------------------------------------------------------


def _install_fake_openmc(monkeypatch):
    fake = ModuleType("openmc")

    class _FakeGeometry:
        def export_to_xml(self, path):
            with open(path, "w") as handle:
                handle.write(_GEOM_XML)

    fake.Model = SimpleNamespace
    monkeypatch.setitem(sys.modules, "openmc", fake)
    return _FakeGeometry()


def test_extract_csg_from_openmc_model_success(monkeypatch):
    geometry = _install_fake_openmc(monkeypatch)
    model = SimpleNamespace(geometry=geometry)

    mesh = geometry_viz.extract_csg_from_openmc_model(model, segments=4)

    assert mesh["stats"]["nCells"] == 3
    assert mesh["sourceFile"].endswith("geometry.xml")


def test_extract_csg_from_openmc_model_missing_openmc(monkeypatch):
    monkeypatch.setitem(sys.modules, "openmc", None)
    with pytest.raises(geometry_viz.GeometryExtractorError, match="openmc not installed"):
        geometry_viz.extract_csg_from_openmc_model(SimpleNamespace())


def test_extract_csg_from_openmc_model_rejects_non_model(monkeypatch):
    _install_fake_openmc(monkeypatch)
    with pytest.raises(geometry_viz.GeometryExtractorError, match="export_to_xml"):
        geometry_viz.extract_csg_from_openmc_model(object())


def test_write_geometry_mesh_json_roundtrip(tmp_path):
    mesh = geometry_viz.extract_csg_mesh(_write_geom(tmp_path), segments=4)
    out = tmp_path / "mesh.json"

    assert geometry_viz.write_geometry_mesh_json(mesh, str(out)) == str(out)
    assert json.loads(out.read_text())["stats"] == mesh["stats"]


def test_write_geometry_mesh_json_rejects_non_dict(tmp_path):
    with pytest.raises(geometry_viz.GeometryExtractorError, match="extract_csg_mesh"):
        geometry_viz.write_geometry_mesh_json({"nope": True}, str(tmp_path / "m.json"))


# ---------------------------------------------------------------------------
# slice_viz validators + build_slice_grid
# ---------------------------------------------------------------------------


def test_require_slice_plane_case_insensitive():
    assert slice_viz._require_slice_plane("Z") == "z"
    with pytest.raises(slice_viz.StaticSliceError, match="plane"):
        slice_viz._require_slice_plane("w")


@pytest.mark.parametrize("bad", [0, -1, 2048, "wide", 2.5, True, None])
def test_require_slice_resolution_rejects(bad):
    with pytest.raises(slice_viz.StaticSliceError, match="[Rr]esolution"):
        slice_viz._require_slice_resolution(bad)


def test_require_box_bounds_rejects():
    with pytest.raises(slice_viz.StaticSliceError, match="missing"):
        slice_viz._require_box_bounds({"xmin": 0})
    bad = dict(_BOUNDS, xmin=5.0, xmax=-5.0)
    with pytest.raises(slice_viz.StaticSliceError, match="xmin"):
        slice_viz._require_box_bounds(bad)


def test_build_slice_grid_z_defaults_to_center():
    grid = slice_viz.build_slice_grid(_BOUNDS, plane="z", resolution=4)

    assert grid["plane"] == "z"
    assert grid["position"] == pytest.approx(0.0)
    assert grid["dims"] == [5, 5]
    assert grid["points"].shape == (25, 3)
    assert np.all(grid["points"][:, 2] == pytest.approx(0.0))
    assert grid["points"][:, 0].min() == pytest.approx(-5.0)
    assert grid["points"][:, 0].max() == pytest.approx(5.0)


def test_build_slice_grid_plane_orientation():
    grid_x = slice_viz.build_slice_grid(_BOUNDS, plane="x", position=1.0, resolution=2)
    assert np.all(grid_x["points"][:, 0] == pytest.approx(1.0))
    assert grid_x["uRange"] == [-5.0, 5.0]
    assert grid_x["vRange"] == [-5.0, 5.0]

    grid_y = slice_viz.build_slice_grid(_BOUNDS, plane="y", position=-2.0, resolution=2)
    assert np.all(grid_y["points"][:, 1] == pytest.approx(-2.0))


# ---------------------------------------------------------------------------
# slice_viz.sample_structured_values
# ---------------------------------------------------------------------------


def test_sample_structured_values_cell_centers():
    values = np.arange(8.0).reshape(2, 2, 2)
    assert slice_viz.sample_structured_values(
        values, [0, 0, 0], [2, 2, 2], [[0.5, 0.5, 0.5]]
    ) == pytest.approx([0.0])
    assert slice_viz.sample_structured_values(
        values, [0, 0, 0], [2, 2, 2], [[1.5, 1.5, 1.5]]
    ) == pytest.approx([7.0])


def test_sample_structured_values_grid_center_is_mean():
    values = np.arange(8.0).reshape(2, 2, 2)
    assert slice_viz.sample_structured_values(
        values, [0, 0, 0], [2, 2, 2], [[1.0, 1.0, 1.0]]
    ) == pytest.approx([3.5])


def test_sample_structured_values_rejects_bad_shapes():
    with pytest.raises(slice_viz.StaticSliceError, match="nx, ny, nz"):
        slice_viz.sample_structured_values(np.zeros((2, 2)), [0, 0, 0], [1, 1, 1], [[0, 0, 0]])


# ---------------------------------------------------------------------------
# slice_viz.extract_geometry_section
# ---------------------------------------------------------------------------


def _section_cells():
    return [
        {"cellId": 1, "bounds": dict(_BOUNDS, zmin=-1.0, zmax=1.0)},
        {"cellId": 2, "bounds": dict(_BOUNDS, zmin=2.0, zmax=3.0)},
    ]


def test_extract_geometry_section_default_position():
    section = slice_viz.extract_geometry_section(_section_cells(), plane="z")

    assert section["position"] == pytest.approx(1.0)
    assert section["nCells"] == 2
    assert section["nSections"] == 1
    assert section["cells"][0]["cellId"] == 1
    assert section["cells"][0]["corners"][0] == [
        pytest.approx(-5.0),
        pytest.approx(-5.0),
        pytest.approx(1.0),
    ]


def test_extract_geometry_section_explicit_position():
    section = slice_viz.extract_geometry_section(_section_cells(), plane="z", position=2.5)
    assert section["nSections"] == 1
    assert section["cells"][0]["cellId"] == 2


def test_extract_geometry_section_accepts_id_alias():
    section = slice_viz.extract_geometry_section(
        [{"id": 7, "bounds": _BOUNDS}], plane="x", position=0.0
    )
    assert section["cells"][0]["cellId"] == 7
    assert len(section["cells"][0]["corners"]) == 4


def test_extract_geometry_section_rejects_empty():
    with pytest.raises(slice_viz.StaticSliceError, match="non-empty"):
        slice_viz.extract_geometry_section([], plane="z")


# ---------------------------------------------------------------------------
# slice_viz VTK writers (recording fake vtk; validators run before the gate)
# ---------------------------------------------------------------------------


def _install_fake_slice_vtk(monkeypatch):
    recorded = {"points": [], "values": [], "cell_ids": [], "loops": 0}
    vtk_mod = ModuleType("vtk")

    class _Points:
        def InsertNextPoint(self, x, y, z):
            recorded["points"].append((x, y, z))

    class _DoubleArray:
        def SetName(self, name):
            recorded["array_name"] = name

        def InsertNextValue(self, value):
            recorded["values"].append(value)

    class _IntArray:
        def SetName(self, name):
            recorded["cell_array_name"] = name

        def SetNumberOfValues(self, n):
            recorded["n_cell_values"] = n

        def SetValue(self, i, value):
            recorded["cell_ids"].append(value)

    class _CellArray:
        def InsertNextCell(self, n):
            recorded["loops"] += 1

        def InsertCellPoint(self, i):
            pass

    class _Ids:
        def SetNumberOfIds(self, n):
            pass

        def SetId(self, i, value):
            pass

    class _PolyLine:
        def GetPointIds(self):
            return _Ids()

    class _Attributes:
        def AddArray(self, array):
            pass

        def SetActiveScalars(self, name):
            recorded["active"] = name

    class _PolyData:
        def __init__(self):
            self._point_data = _Attributes()
            self._cell_data = _Attributes()

        def SetPoints(self, points):
            pass

        def SetVerts(self, verts):
            recorded["verts"] = True

        def SetLines(self, lines):
            recorded["lines"] = True

        def GetPointData(self):
            return self._point_data

        def GetCellData(self):
            return self._cell_data

    class _Writer:
        def SetFileName(self, path):
            recorded["path"] = path

        def SetInputData(self, data):
            pass

        def Write(self):
            recorded["wrote"] = True

    vtk_mod.vtkPoints = _Points
    vtk_mod.vtkDoubleArray = _DoubleArray
    vtk_mod.vtkIntArray = _IntArray
    vtk_mod.vtkCellArray = _CellArray
    vtk_mod.vtkPolyLine = _PolyLine
    vtk_mod.vtkPolyData = _PolyData
    vtk_mod.vtkXMLPolyDataWriter = _Writer
    monkeypatch.setitem(sys.modules, "vtk", vtk_mod)
    return recorded


def test_write_slice_vtp_validators_run_before_vtk_gate(monkeypatch):
    """Length mismatches fail with a data error even when vtk is missing."""
    monkeypatch.setitem(sys.modules, "vtk", None)
    with pytest.raises(slice_viz.StaticSliceError, match="one value per point"):
        slice_viz.write_slice_vtp([[0, 0, 0], [1, 0, 0]], [1.0], "flux")
    with pytest.raises(slice_viz.StaticSliceError, match="array_name"):
        slice_viz.write_slice_vtp([[0, 0, 0]], [1.0], "  ")


def test_write_slice_vtp_missing_vtk(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "vtk", None)
    with pytest.raises(slice_viz.StaticSliceError, match="vtk not installed"):
        slice_viz.write_slice_vtp([[0, 0, 0]], [1.0], "flux", str(tmp_path / "s.vtp"))


def test_write_slice_vtp_golden_fake_vtk(monkeypatch, tmp_path):
    recorded = _install_fake_slice_vtk(monkeypatch)
    out = tmp_path / "slice.vtp"

    assert slice_viz.write_slice_vtp([[0, 0, 0], [1, 2, 3]], [1.5, 2.5], "flux", str(out)) == str(
        out
    )

    assert recorded["points"] == [(0.0, 0.0, 0.0), (1.0, 2.0, 3.0)]
    assert recorded["values"] == [1.5, 2.5]
    assert recorded["array_name"] == "flux"
    assert recorded["active"] == "flux"
    assert recorded["verts"] is True
    assert recorded["path"] == str(out)


def test_extract_regular_slice_golden_fake_vtk(monkeypatch, tmp_path):
    _install_fake_slice_vtk(monkeypatch)
    out = tmp_path / "heat.vtp"

    result = slice_viz.extract_regular_slice(
        [[[7.0]]],
        [0, 0, 0],
        [2, 2, 2],
        plane="z",
        array_name="flux",
        resolution=1,
        output_path=str(out),
    )

    assert result["vtkPath"] == str(out)
    assert result["arrayName"] == "flux"
    assert result["plane"] == "z"
    assert result["position"] == pytest.approx(1.0)
    assert result["nPoints"] == 4
    assert result["dataRange"] == [7.0, 7.0]


def test_write_section_vtp_empty_section(monkeypatch):
    monkeypatch.setitem(sys.modules, "vtk", None)
    section = {"plane": "z", "position": 99.0, "cells": [], "nCells": 1, "nSections": 0}
    with pytest.raises(slice_viz.StaticSliceError, match="no intersecting cells"):
        slice_viz.write_section_vtp(section)


def test_write_section_vtp_golden_fake_vtk(monkeypatch, tmp_path):
    recorded = _install_fake_slice_vtk(monkeypatch)
    section = slice_viz.extract_geometry_section(
        [{"cellId": 5, "bounds": _BOUNDS}], plane="z", position=0.0
    )
    out = tmp_path / "section.vtp"

    assert slice_viz.write_section_vtp(section, str(out)) == str(out)

    assert len(recorded["points"]) == 5  # closed loop repeats the first corner
    assert recorded["points"][0] == recorded["points"][-1]
    assert recorded["loops"] == 1
    assert recorded["cell_ids"] == [5]
    assert recorded["cell_array_name"] == "cell_id"
    assert recorded["lines"] is True


# ---------------------------------------------------------------------------
# openmc.geometry-mesh / openmc.geometry-slice-vtk commands (stdout JSON)
# ---------------------------------------------------------------------------


def test_geometry_mesh_command_success_stdout(monkeypatch, capsys):
    mesh = {"sourceFile": "geometry.xml", "cells": [], "stats": {"nCells": 0}}
    captured = {}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        extract_csg_mesh=lambda path, segments=16: (
            captured.update(path=path, segments=segments) or mesh
        ),
        write_geometry_mesh_json=lambda mesh_arg, out: captured.update(out=out) or out,
    )

    args = _parse(geometry_cmds.cmd_geometry_mesh, ["--file", "geometry.xml"])
    assert geometry_cmds.cmd_geometry_mesh(args) == 0
    assert _stdout_json(capsys)["stats"] == {"nCells": 0}
    assert captured == {"path": "geometry.xml", "segments": 16}


def test_geometry_mesh_command_writes_out(monkeypatch, capsys, tmp_path):
    mesh = {"sourceFile": "g.xml", "cells": [], "stats": {"nCells": 0}}
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        extract_csg_mesh=lambda path, segments=16: mesh,
        write_geometry_mesh_json=lambda mesh_arg, out: out,
    )
    out = str(tmp_path / "mesh.json")

    args = _parse(geometry_cmds.cmd_geometry_mesh, ["--file", "g.xml", "--out", out])
    assert geometry_cmds.cmd_geometry_mesh(args) == 0
    assert _stdout_json(capsys) == {"meshPath": out, "sourceFile": "g.xml", "stats": {"nCells": 0}}


def test_geometry_mesh_command_rejects_bad_segments(capsys):
    args = _parse(geometry_cmds.cmd_geometry_mesh, ["--file", "g.xml", "--segments", "2"])
    assert geometry_cmds.cmd_geometry_mesh(args) == 1
    assert "segments" in _stdout_json(capsys)["error"]


def test_geometry_mesh_command_extractor_error(monkeypatch, capsys):
    def _boom(path, segments=16):
        raise geometry_viz.GeometryExtractorError("bad xml")

    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.geometry_viz",
        extract_csg_mesh=_boom,
        write_geometry_mesh_json=lambda mesh_arg, out: out,
    )

    args = _parse(geometry_cmds.cmd_geometry_mesh, ["--file", "g.xml"])
    assert geometry_cmds.cmd_geometry_mesh(args) == 1
    assert _stdout_json(capsys)["error"] == "bad xml"


def test_geometry_mesh_command_missing_file_real_extractor(capsys):
    """Validators fire before any heavy work: a missing file is JSON, exit 1."""
    args = _parse(geometry_cmds.cmd_geometry_mesh, ["--file", "/no/such/geometry.xml"])
    assert geometry_cmds.cmd_geometry_mesh(args) == 1
    assert "error" in _stdout_json(capsys)


def test_geometry_mesh_command_file_required():
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(geometry_cmds.cmd_geometry_mesh, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args([])
    assert excinfo.value.code == 2


def test_geometry_slice_vtk_command_success(monkeypatch, capsys):
    mesh = {"sourceFile": "g.xml", "cells": [{"id": 1, "bbox": dict(_BOUNDS)}]}
    seen = {}
    _install_fake_module(
        monkeypatch, "plugins.openmc.lib.geometry_viz", extract_csg_mesh=lambda path: mesh
    )
    _install_fake_module(
        monkeypatch,
        "plugins.openmc.lib.slice_viz",
        extract_geometry_section=lambda cells, plane="z", position=None: (
            seen.update(cells=cells, plane=plane, position=position)
            or {"plane": plane, "position": 0.0, "nCells": 1, "nSections": 1}
        ),
        write_section_vtp=lambda section, out: seen.update(out=out) or "/tmp/section.vtp",
    )

    args = _parse(
        geometry_cmds.cmd_geometry_slice_vtk,
        ["--file", "g.xml", "--plane", "x", "--position", "1.5"],
    )
    assert geometry_cmds.cmd_geometry_slice_vtk(args) == 0
    result = _stdout_json(capsys)
    assert result["vtkPath"] == "/tmp/section.vtp"
    assert result["plane"] == "x"
    assert result["nCells"] == 1
    assert result["nSections"] == 1
    assert seen["cells"] == [{"cellId": 1, "bounds": dict(_BOUNDS)}]
    assert seen["position"] == pytest.approx(1.5)


def test_geometry_slice_vtk_command_missing_file(capsys):
    args = _parse(geometry_cmds.cmd_geometry_slice_vtk, ["--file", "/no/such/geometry.xml"])
    assert geometry_cmds.cmd_geometry_slice_vtk(args) == 1
    assert "error" in _stdout_json(capsys)


def test_geometry_slice_vtk_command_plane_default_and_choices():
    args = _parse(geometry_cmds.cmd_geometry_slice_vtk, ["--file", "g.xml"])
    assert args.plane == "z"

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(geometry_cmds.cmd_geometry_slice_vtk, parser)
    with pytest.raises(SystemExit):
        parser.parse_args(["--file", "g.xml", "--plane", "w"])
