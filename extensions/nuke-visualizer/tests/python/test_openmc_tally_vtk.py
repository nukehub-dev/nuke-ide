"""Tests for plugins.openmc.lib.tally_vtk (headless tally/source/overlay export).

Pure-logic tests (mesh/source/slice builders, validators, missing-file
error paths) need only pytest + numpy. Tests that build HDF5 fixtures are
guarded by importorskip("h5py"); VTK writes are guarded by
importorskip("vtk"). Dependency-absence tests force the absence via
monkeypatch (they must pass in both the minimal and full profiles).
"""

import argparse
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import tally_vtk as tally_vtk_cmds  # noqa: E402
from plugins.openmc.lib import output_readers, tally_vtk  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


# ---------------------------------------------------------------------------
# Pure logic: mesh grid builders + validators
# ---------------------------------------------------------------------------


def test_validate_mesh_grid_ok():
    dims, origin, spacing = tally_vtk.validate_mesh_grid([2, 3, 4], [-1, -2, -3], [1, 4, 5])
    assert dims == [2, 3, 4]
    assert origin == [-1.0, -2.0, -3.0]
    assert spacing == pytest.approx([1.0, 2.0, 2.0])


def test_validate_mesh_grid_bad_dimension():
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.validate_mesh_grid([2, 0, 4], [0, 0, 0], [1, 1, 1])
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.validate_mesh_grid([2, 2], [0, 0, 0], [1, 1, 1])


def test_validate_mesh_grid_bad_bounds():
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.validate_mesh_grid([2, 2, 2], [0, 0, 0], [1, 1, 0])
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.validate_mesh_grid([2, 2, 2], [0, 0, np.inf], [1, 1, 1])


def test_build_mesh_image_ordering():
    # 2x1x1 mesh: flat x-major values stay in VTK x-fastest cell order.
    geometry = tally_vtk.build_mesh_image([2, 1, 1], [0, 0, 0], [2, 1, 1], [10.0, 20.0])
    assert geometry["dims"] == [2, 1, 1]
    assert geometry["flat"].tolist() == [10.0, 20.0]


def test_build_mesh_image_count_mismatch():
    with pytest.raises(output_readers.OutputReaderError, match="expected 8"):
        tally_vtk.build_mesh_image([2, 2, 2], [0, 0, 0], [1, 1, 1], [1.0, 2.0])


def test_build_mesh_image_non_finite():
    with pytest.raises(output_readers.OutputReaderError, match="finite"):
        tally_vtk.build_mesh_image([1, 1, 1], [0, 0, 0], [1, 1, 1], [np.nan])


def test_mesh_cell_centers_x_major():
    centers = tally_vtk.mesh_cell_centers([2, 1, 1], [0, 0, 0], [2, 1, 1])
    assert centers.tolist() == [[0.5, 0.5, 0.5], [1.5, 0.5, 0.5]]


def test_require_tally_id_rejects_bad_values():
    for bad in (0, -3, "abc", None, True):
        with pytest.raises(output_readers.OutputReaderError):
            tally_vtk._require_tally_id(bad)
    assert tally_vtk._require_tally_id("7") == 7


def test_require_plane_and_resolution():
    assert tally_vtk._require_plane("Z") == "z"
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk._require_plane("w")
    assert tally_vtk._require_resolution(200) == 200
    for bad in (0, 2048, "many", True, 2.5):
        with pytest.raises(output_readers.OutputReaderError):
            tally_vtk._require_resolution(bad)
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk._require_position(float("nan"))


# ---------------------------------------------------------------------------
# Pure logic: source builders
# ---------------------------------------------------------------------------


def test_build_source_points_ok():
    positions = [[0, 0, 0], [1, 2, 3]]
    points, arrays = tally_vtk.build_source_points(
        positions, energies=[1e6, 2e6], weights=[1.0, 0.5]
    )
    assert points.shape == (2, 3)
    assert arrays["energy"].tolist() == [1e6, 2e6]
    assert arrays["weight"].tolist() == [1.0, 0.5]


def test_build_source_points_optional_arrays():
    points, arrays = tally_vtk.build_source_points([[0, 0, 0]])
    assert points.shape == (1, 3)
    assert arrays == {}


def test_build_source_points_bad_shapes():
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.build_source_points([])
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.build_source_points([[0, 0, 0]], energies=[1.0, 2.0])
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.build_source_points([[0, 0, np.inf]])


# ---------------------------------------------------------------------------
# Pure logic: slice sampling
# ---------------------------------------------------------------------------


def test_sample_regular_slice_center():
    # Uniform 2x2x2 grid: every sample equals the cell value.
    values = np.full((2, 2, 2), 3.0)
    sampled = tally_vtk.sample_regular_slice(values, [0, 0, 0], [2, 2, 2], plane="z", resolution=4)
    assert sampled["plane"] == "z"
    assert sampled["position"] == pytest.approx(1.0)
    assert sampled["points"].shape == (25, 3)
    assert np.all(sampled["points"][:, 2] == pytest.approx(1.0))
    assert np.all(sampled["values"] == pytest.approx(3.0))


def test_sample_regular_slice_trilinear():
    # 2x1x1 grid with values 0 and 10: the mid-plane sample interpolates.
    values = np.zeros((2, 1, 1))
    values[0, 0, 0] = 0.0
    values[1, 0, 0] = 10.0
    sampled = tally_vtk.sample_regular_slice(
        values, [0, 0, 0], [2, 1, 1], plane="x", position=1.0, resolution=1
    )
    assert sampled["values"].tolist() == pytest.approx([5.0, 5.0, 5.0, 5.0])


def test_sample_regular_slice_bad_input():
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.sample_regular_slice(np.zeros((0, 1, 1)), [0, 0, 0], [1, 1, 1])
    with pytest.raises(output_readers.OutputReaderError):
        tally_vtk.sample_regular_slice(np.zeros((2, 2, 2)), [0, 0, 0], [1, 1, 1], plane="w")


def test_write_overlay_vtp_validators_before_vtk_gate(monkeypatch):
    """Length mismatches fail before vtk is even probed."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="one value per point"):
        tally_vtk.write_overlay_vtp([[0, 0, 0]], [1.0, 2.0], "flux-mean", "/tmp/x.vtp")
    with pytest.raises(output_readers.OutputReaderError, match="array_name"):
        tally_vtk.write_overlay_vtp([[0, 0, 0]], [1.0], "  ", "/tmp/x.vtp")


# ---------------------------------------------------------------------------
# Error paths: missing files / missing dependencies
# ---------------------------------------------------------------------------


def test_tally_mesh_missing_file():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        tally_vtk.tally_mesh_to_vtk("/no/such/statepoint.h5", 1)


def test_source_missing_file():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        tally_vtk.source_to_vtk("/no/such/source.h5")


def test_overlay_bad_mode():
    with pytest.raises(output_readers.OutputReaderError, match="mode must be"):
        tally_vtk.overlay_to_vtk("/no/such.h5", 1, mode="banana")


def test_tally_mesh_missing_h5py_forced(monkeypatch, tmp_path):
    """With h5py unavailable, statepoint reads report the missing dep."""
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "statepoint.1.h5"
    fake.write_bytes(b"fake")
    with pytest.raises(output_readers.OutputReaderError, match="h5py"):
        tally_vtk.read_mesh_tally(str(fake), 1)


def test_tally_mesh_missing_vtk_forced(monkeypatch):
    """With vtk unavailable, the writer gate reports the missing dep."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="vtk"):
        tally_vtk.write_mesh_vti(
            {"dims": [1, 1, 1], "origin": [0, 0, 0], "spacing": [1, 1, 1], "flat": [1.0]},
            "flux-mean",
            "/tmp/x.vti",
        )


# ---------------------------------------------------------------------------
# Command handlers: stdout-JSON errors, exit 1
# ---------------------------------------------------------------------------


def test_cmd_tally_mesh_vtk_missing_file(capsys):
    args = _parse(tally_vtk_cmds.cmd_tally_mesh_vtk, ["--tally-id", "1", "/no/such.h5"])
    rc = tally_vtk_cmds.cmd_tally_mesh_vtk(args)
    assert rc == 1
    assert _stdout_json(capsys)["error"]


def test_cmd_tally_mesh_vtk_bad_tally_id(capsys, tmp_path):
    fake = tmp_path / "sp.h5"
    fake.write_bytes(b"fake")
    args = _parse(tally_vtk_cmds.cmd_tally_mesh_vtk, ["--tally-id", "0", str(fake)])
    rc = tally_vtk_cmds.cmd_tally_mesh_vtk(args)
    assert rc == 1
    assert "tally_id" in _stdout_json(capsys)["error"]


def test_cmd_source_vtk_missing_file(capsys):
    args = _parse(tally_vtk_cmds.cmd_source_vtk, ["/no/such.h5"])
    rc = tally_vtk_cmds.cmd_source_vtk(args)
    assert rc == 1
    assert _stdout_json(capsys)["error"]


def test_cmd_overlay_vtk_missing_file(capsys):
    args = _parse(
        tally_vtk_cmds.cmd_overlay_vtk, ["--tally-id", "2", "--mode", "full", "/no/such.h5"]
    )
    rc = tally_vtk_cmds.cmd_overlay_vtk(args)
    assert rc == 1
    assert _stdout_json(capsys)["error"]


def test_cmd_source_vtk_missing_h5py_forced(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "source.h5"
    fake.write_bytes(b"fake")
    args = _parse(tally_vtk_cmds.cmd_source_vtk, [str(fake)])
    rc = tally_vtk_cmds.cmd_source_vtk(args)
    assert rc == 1
    assert "h5py" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# h5py-backed reads (guarded) + vtk writes (guarded)
# ---------------------------------------------------------------------------


def _write_statepoint_fixture(path):
    """Minimal statepoint layout: tally 1, 2x2x2 regular mesh, one score/nuclide."""
    h5py = pytest.importorskip("h5py")
    nx = ny = nz = 2
    values = np.arange(nx * ny * nz, dtype=float)
    with h5py.File(path, "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = "mesh flux"
        tally.create_dataset("score_bins", data=np.array([b"flux"]))
        tally.create_dataset("nuclides", data=np.array([b"total"]))
        tally.create_dataset("filters", data=np.array([1]))
        results = np.zeros((nx * ny * nz, 1, 1, 2))
        results[..., 0] = values.reshape(nx * ny * nz, 1, 1)
        tally.create_dataset("results", data=results)
        filters = tallies.create_group("filters")
        mesh_filter = filters.create_group("filter 1")
        mesh_filter.create_dataset("type", data=np.bytes_(b"mesh"))
        mesh_filter.create_dataset("bins", data=np.array([7]))
        meshes = tallies.create_group("meshes")
        mesh = meshes.create_group("mesh 7")
        mesh.create_dataset("dimension", data=np.array([nx, ny, nz]))
        mesh.create_dataset("lower_left", data=np.array([-1.0, -2.0, -3.0]))
        mesh.create_dataset("upper_right", data=np.array([1.0, 2.0, 3.0]))


def test_read_mesh_tally_fixture(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    data = tally_vtk.read_mesh_tally(str(sp), 1)
    assert data["tallyName"] == "mesh flux"
    assert data["score"] == "flux"
    assert data["arrayName"] == "flux-mean"
    assert data["dimension"] == [2, 2, 2]
    assert data["values"].tolist() == list(range(8))
    assert data["dataRange"] == [0.0, 7.0]


def test_read_mesh_tally_unknown_tally(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    with pytest.raises(output_readers.OutputReaderError, match="Tally 9 not found"):
        tally_vtk.read_mesh_tally(str(sp), 9)


def test_read_mesh_tally_unknown_score(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    with pytest.raises(output_readers.OutputReaderError, match="Score 'heating'"):
        tally_vtk.read_mesh_tally(str(sp), 1, score="heating")


def test_tally_mesh_to_vtk_xml(tmp_path):
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    out = tmp_path / "tally.vti"
    result = tally_vtk.tally_mesh_to_vtk(str(sp), 1, output_path=str(out))
    assert result["vtkPath"] == str(out)
    assert result["nCells"] == 8
    text = out.read_text()
    assert "<VTKFile" in text and "ImageData" in text and "flux-mean" in text


def test_source_to_vtk_xml(tmp_path):
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    h5py = pytest.importorskip("h5py")
    src = tmp_path / "source.h5"
    dtype = np.dtype(
        [
            ("r", [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]),
            ("E", "<f8"),
            ("wgt", "<f8"),
        ]
    )
    bank = np.zeros(4, dtype=dtype)
    bank["r"]["x"] = [0.0, 1.0, 2.0, 3.0]
    bank["r"]["y"] = [0.0, 0.0, 0.0, 0.0]
    bank["r"]["z"] = [0.0, 0.0, 0.0, 0.0]
    bank["E"] = [1e6, 2e6, 3e6, 4e6]
    bank["wgt"] = [1.0, 1.0, 1.0, 1.0]
    with h5py.File(str(src), "w") as f:
        f.create_dataset("source_bank", data=bank)
    out = tmp_path / "source.vtp"
    result = tally_vtk.source_to_vtk(str(src), output_path=str(out), limit=3)
    assert result["nParticles"] == 3
    assert result["totalParticles"] == 4
    assert result["arrays"] == ["energy", "weight"]
    text = out.read_text()
    assert "<VTKFile" in text and "PolyData" in text


def test_overlay_slice_to_vtk_xml(tmp_path):
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    out = tmp_path / "overlay.vtp"
    result = tally_vtk.overlay_to_vtk(
        str(sp), 1, mode="slice", plane="z", resolution=4, output_path=str(out)
    )
    assert result["mode"] == "slice"
    assert result["nPoints"] == 25
    assert "<VTKFile" in out.read_text()


def test_overlay_full_to_vtk_xml(tmp_path):
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint_fixture(str(sp))
    out = tmp_path / "overlay_full.vtp"
    result = tally_vtk.overlay_to_vtk(str(sp), 1, mode="full", output_path=str(out))
    assert result["mode"] == "full"
    assert result["nPoints"] == 8
    assert result["dataRange"] == [0.0, 7.0]
