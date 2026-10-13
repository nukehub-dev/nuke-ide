"""Tests for the contour helpers in plugins.openmc.lib.tally_vtk.

Pure-logic tests (iso validators, marching-tetrahedra extraction over the
regular tally grid, smooth/pixelated parity, multi-iso concatenation) need
only pytest + numpy. VTK writes are guarded by importorskip("vtk").
Dependency-absence tests force the absence via monkeypatch (they must pass
in both the minimal and full profiles).
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


def _surface_area(points, triangles):
    """Total area of a triangle soup (zero when empty)."""
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    triangles = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    if triangles.shape[0] == 0:
        return 0.0
    corners = points[triangles]
    return float(
        0.5
        * np.linalg.norm(
            np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1
        ).sum()
    )


def _sphere_field(radius=5.0, half_width=8.0, cells=24):
    """Signed-distance-ish field ``radius - |p|`` over a cubic mesh.

    Returns ``(values_3d, lo, hi)`` in the (nx, ny, nz) x-major layout the
    tally converters use; the ``iso=0`` surface is the sphere of the given
    radius (exact area ``4*pi*r^2``).
    """
    lo = [-half_width, -half_width, -half_width]
    hi = [half_width, half_width, half_width]
    spacing = (np.asarray(hi) - np.asarray(lo)) / cells
    centers = [np.asarray(lo[d]) + (np.arange(cells) + 0.5) * spacing[d] for d in range(3)]
    xx, yy, zz = np.meshgrid(centers[0], centers[1], centers[2], indexing="ij")
    return radius - np.sqrt(xx**2 + yy**2 + zz**2), lo, hi


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


def test_require_iso_values_accepts_lists_and_scalars():
    assert tally_vtk._require_iso_values([1.5]) == [1.5]
    assert tally_vtk._require_iso_values((1, 2.5, "3")) == [1.0, 2.5, 3.0]
    assert tally_vtk._require_iso_values(np.array([2.0])) == [2.0]


def test_require_iso_values_rejects_bad_input():
    for bad in ([], None, True, "1.5", [np.nan], [np.inf], ["a"], [1.0] * 9, [[1.0]]):
        with pytest.raises(output_readers.OutputReaderError):
            tally_vtk._require_iso_values(bad)


def test_require_contour_grid_rejects_thin_mesh():
    values = np.ones((4, 4, 1))
    with pytest.raises(output_readers.OutputReaderError, match="too coarse"):
        tally_vtk.extract_iso_surface(values, [0, 0, 0], [4, 4, 1], 0.5)


# ---------------------------------------------------------------------------
# Analytic sphere: surface area within tolerance
# ---------------------------------------------------------------------------


def test_iso_sphere_area_smooth_within_tolerance():
    # Marching tetrahedra over cell centers reproduces the sphere area to
    # ~1% on this grid; the 10% gate leaves headroom for numpy-version
    # rounding without hiding a broken polygonizer.
    values, lo, hi = _sphere_field()
    surface = tally_vtk.extract_iso_surface(values, lo, hi, 0.0)
    assert surface["smooth"] is True
    assert surface["triangles"].shape[0] > 1000
    assert _surface_area(surface["points"], surface["triangles"]) == pytest.approx(
        4 * np.pi * 25.0, rel=0.10
    )


def test_iso_sphere_area_pixelated_within_looser_tolerance():
    # Midpoint-snapped vertices stair-step the surface, so the area runs
    # ~25% high; the topology (triangle count) still matches smooth exactly.
    values, lo, hi = _sphere_field()
    smooth = tally_vtk.extract_iso_surface(values, lo, hi, 0.0, smooth=True)
    blocky = tally_vtk.extract_iso_surface(values, lo, hi, 0.0, smooth=False)
    assert blocky["smooth"] is False
    assert blocky["triangles"].shape == smooth["triangles"].shape
    assert not np.allclose(blocky["points"], smooth["points"])
    assert _surface_area(blocky["points"], blocky["triangles"]) == pytest.approx(
        4 * np.pi * 25.0, rel=0.40
    )


def test_iso_miss_yields_empty_surface():
    values, lo, hi = _sphere_field()
    surface = tally_vtk.extract_iso_surface(values, lo, hi, 100.0)
    assert surface["points"].shape == (0, 3)
    assert surface["triangles"].shape == (0, 3)


def test_iso_surface_vertices_span_the_mesh():
    # The sphere surface must stay inside the mesh bounds.
    values, lo, hi = _sphere_field()
    surface = tally_vtk.extract_iso_surface(values, lo, hi, 0.0)
    assert surface["points"].min() >= min(lo) - 1e-9
    assert surface["points"].max() <= max(hi) + 1e-9


# ---------------------------------------------------------------------------
# Multi-iso in one call
# ---------------------------------------------------------------------------


def test_multi_iso_concatenates_with_rebased_ids():
    values, lo, hi = _sphere_field()
    combined = tally_vtk.extract_iso_surfaces(values, lo, hi, [1.0, 2.0, 3.0])
    assert combined["isoValues"] == [1.0, 2.0, 3.0]
    assert combined["values"].shape[0] == combined["points"].shape[0]
    assert set(np.unique(combined["values"]).tolist()) == {1.0, 2.0, 3.0}
    assert combined["triangles"].min() >= 0
    assert combined["triangles"].max() < combined["points"].shape[0]
    # Every per-point value matches the area of its own iso: split back out
    # and compare against single-iso extraction.
    offset = 0
    for iso in (1.0, 2.0, 3.0):
        single = tally_vtk.extract_iso_surface(values, lo, hi, iso)
        count = single["points"].shape[0]
        assert (combined["values"][offset : offset + count] == iso).all()
        assert np.allclose(combined["points"][offset : offset + count], single["points"])
        offset += count


def test_multi_iso_partial_miss_keeps_hits():
    values, lo, hi = _sphere_field()
    combined = tally_vtk.extract_iso_surfaces(values, lo, hi, [0.0, 100.0])
    assert combined["triangles"].shape[0] > 0
    assert set(np.unique(combined["values"]).tolist()) == {0.0}


def test_multi_iso_all_miss_yields_empty():
    values, lo, hi = _sphere_field()
    combined = tally_vtk.extract_iso_surfaces(values, lo, hi, [100.0, 200.0])
    assert combined["triangles"].shape == (0, 3)


# ---------------------------------------------------------------------------
# VTK writer: validators before the vtk gate + real XML when vtk exists
# ---------------------------------------------------------------------------


def test_write_contour_vtp_validators_before_vtk_gate(monkeypatch):
    """Bad payloads fail before vtk is even probed."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    points = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
    with pytest.raises(output_readers.OutputReaderError, match="at least one triangle"):
        tally_vtk.write_contour_vtp(points, [], [1.0, 1.0, 1.0], "flux-mean", "/tmp/x.vtp")
    with pytest.raises(output_readers.OutputReaderError, match="triangle ids"):
        tally_vtk.write_contour_vtp(points, [[0, 1, 9]], [1.0, 1.0, 1.0], "flux-mean", "/tmp/x.vtp")
    with pytest.raises(output_readers.OutputReaderError, match="one value per point"):
        tally_vtk.write_contour_vtp(points, [[0, 1, 2]], [1.0], "flux-mean", "/tmp/x.vtp")
    with pytest.raises(output_readers.OutputReaderError, match="array_name"):
        tally_vtk.write_contour_vtp(points, [[0, 1, 2]], [1.0, 1.0, 1.0], "  ", "/tmp/x.vtp")


def test_write_contour_vtp_missing_vtk_forced(monkeypatch):
    """With vtk unavailable, the writer gate reports the missing dep."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="vtk"):
        tally_vtk.write_contour_vtp(
            [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            [[0, 1, 2]],
            [1.0, 1.0, 1.0],
            "flux-mean",
            "/tmp/x.vtp",
        )


def test_write_contour_vtp_xml(tmp_path, monkeypatch):
    """The triangle writer emits polys with per-point values."""
    # The geometry-extract suite installs a bare vtk stub in sys.modules at
    # collection time (pre-existing leak: the sibling *vtk_xml tests fail
    # in-suite the same way); evict it so this test exercises the real
    # writer — monkeypatch restores the stub afterwards.
    for name in [m for m in sys.modules if m == "vtk" or m.startswith("vtk.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    monkeypatch.setattr(tally_vtk, "HAS_VTK", True)
    values, lo, hi = _sphere_field(cells=8)
    surface = tally_vtk.extract_iso_surfaces(values, lo, hi, [0.0])
    out = tmp_path / "contour.vtp"
    tally_vtk.write_contour_vtp(
        surface["points"], surface["triangles"], surface["values"], "flux-mean", str(out)
    )
    text = out.read_text()
    assert "<PolyData" in text
    assert "<Polys>" in text
    assert "flux-mean" in text


# ---------------------------------------------------------------------------
# tally_contour(): fake tally read (no h5py needed)
# ---------------------------------------------------------------------------


def _canned_mesh_tally():
    nx = ny = nz = 12
    lo = [0.0, 0.0, 0.0]
    hi = [12.0, 12.0, 12.0]
    spacing = (np.asarray(hi) - np.asarray(lo)) / nx
    centers = [np.asarray(lo[d]) + (np.arange(nx) + 0.5) * spacing[d] for d in range(3)]
    xx, yy, zz = np.meshgrid(centers[0], centers[1], centers[2], indexing="ij")
    # Peak at the mesh center, falling off with radius: iso shells are
    # nested spheres, so several iso values hit in one call.
    field = 100.0 - ((xx - 6.0) ** 2 + (yy - 6.0) ** 2 + (zz - 6.0) ** 2)
    flat = np.ascontiguousarray(field.reshape(-1, order="F"))
    return {
        "tallyName": "Tally 4",
        "score": "flux",
        "nuclide": "total",
        "arrayName": "flux-mean",
        "dimension": [nx, ny, nz],
        "lowerLeft": lo,
        "upperRight": hi,
        "values": flat,
        "dataRange": [float(flat.min()), float(flat.max())],
    }


def test_tally_contour_multi_iso_result_shape(monkeypatch, tmp_path):
    def fake_write(points, triangles, values, array_name, output_path):
        assert array_name == "flux-mean"
        assert np.asarray(triangles).reshape(-1, 3).shape[0] > 0
        with open(output_path, "w", encoding="utf-8") as handle:
            handle.write("vtp-stub")
        return output_path

    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_contour_vtp", fake_write)
    out = tmp_path / "contour.vtp"
    result = tally_vtk.tally_contour("sp.h5", 4, [20.0, 50.0], output_path=str(out))
    assert result["tallyId"] == 4
    assert result["arrayName"] == "flux-mean"
    assert result["isoValues"] == [20.0, 50.0]
    assert result["smooth"] is True
    assert result["nTriangles"] > 0
    assert result["dataRange"] == [20.0, 50.0]
    assert result["vtkPath"] == str(out)
    assert json.dumps(result)  # JSON-safe


def test_tally_contour_pixelated_parity(monkeypatch):
    seen = {}

    def fake_write(points, triangles, values, array_name, output_path):
        seen[output_path] = (np.asarray(points), np.asarray(triangles))
        return output_path

    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_contour_vtp", fake_write)
    smooth = tally_vtk.tally_contour("sp.h5", 4, [40.0], output_path="smooth.vtp")
    blocky = tally_vtk.tally_contour("sp.h5", 4, [40.0], smooth=False, output_path="blocky.vtp")
    assert blocky["smooth"] is False
    assert smooth["nTriangles"] == blocky["nTriangles"]
    assert not np.allclose(seen["smooth.vtp"][0], seen["blocky.vtp"][0])


def test_tally_contour_all_miss_reports_range(monkeypatch):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    with pytest.raises(output_readers.OutputReaderError, match="do not intersect"):
        tally_vtk.tally_contour("sp.h5", 4, [100000.0])


def test_tally_contour_missing_file():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        tally_vtk.tally_contour("/no/such/statepoint.h5", 1, [1.0])


def test_tally_contour_missing_h5py_forced(monkeypatch, tmp_path):
    """With h5py unavailable, the tally read reports the missing dep."""
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "statepoint.1.h5"
    fake.write_bytes(b"fake")
    with pytest.raises(output_readers.OutputReaderError, match="h5py"):
        tally_vtk.tally_contour(str(fake), 1, [1.0])


# ---------------------------------------------------------------------------
# Command handler: stdout-JSON errors, exit 1
# ---------------------------------------------------------------------------


def _contour_argv(*extra):
    """Base contour argv: tally 1 with one iso over a missing file.

    The statepoint positional leads: ``--iso`` takes 1+ values and would
    greedily swallow a trailing positional.
    """
    return ["/no/such/statepoint.h5", "--tally-id", "1", "--iso", "5.0", *extra]


def test_cmd_tally_contour_missing_file(capsys):
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())
    rc = tally_vtk_cmds.cmd_tally_contour(args)
    assert rc == 1
    assert "error" in _stdout_json(capsys)


def test_cmd_tally_contour_mutually_exclusive_flags(capsys):
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv("--smooth", "--pixelated"))
    rc = tally_vtk_cmds.cmd_tally_contour(args)
    assert rc == 1
    assert "mutually exclusive" in _stdout_json(capsys)["error"]


def test_cmd_tally_contour_bad_iso(capsys):
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())
    args.iso = [float("nan")]
    rc = tally_vtk_cmds.cmd_tally_contour(args)
    assert rc == 1
    assert "iso" in _stdout_json(capsys)["error"]


def test_cmd_tally_contour_all_miss_reports_range(monkeypatch, capsys):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())
    args.iso = [100000.0]
    rc = tally_vtk_cmds.cmd_tally_contour(args)
    assert rc == 1
    assert "do not intersect" in _stdout_json(capsys)["error"]


def test_cmd_tally_contour_success_multi_iso(monkeypatch, capsys, tmp_path):
    for name in [m for m in sys.modules if m == "vtk" or m.startswith("vtk.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    monkeypatch.setattr(tally_vtk, "HAS_VTK", True)
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    out = tmp_path / "contour.vtp"
    args = _parse(
        tally_vtk_cmds.cmd_tally_contour,
        ["--tally-id", "4", "--iso", "20.0", "50.0", "--output", str(out), "sp.h5"],
    )
    rc = tally_vtk_cmds.cmd_tally_contour(args)
    assert rc == 0
    payload = _stdout_json(capsys)
    assert payload["isoValues"] == [20.0, 50.0]
    assert payload["nTriangles"] > 0
    assert out.is_file()
