"""Tests for the line-probe helpers in plugins.openmc.lib.tally_vtk.

Pure-logic tests (probe lattice, validators, smooth/pixelated sampling
parity with the overlay samplers) need only pytest + numpy. VTK writes are
guarded by importorskip("vtk"). Dependency-absence tests force the absence
via monkeypatch (they must pass in both the minimal and full profiles).
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


def _linear_grid(dims=(4, 5, 6), lo=(0.0, 0.0, 0.0), hi=(4.0, 5.0, 6.0)):
    """Cell-centered linear field f(x,y,z) = 2x + 3y + 5z + 7 over a mesh.

    Returns ``(values_3d, lo, hi)`` with ``values_3d`` in the (nx, ny, nz)
    x-major layout the tally converters use.
    """
    nx, ny, nz = dims
    lo_arr = np.asarray(lo, dtype=float)
    hi_arr = np.asarray(hi, dtype=float)
    spacing = (hi_arr - lo_arr) / np.array([nx, ny, nz], dtype=float)
    centers = [lo_arr[d] + (np.arange(dims[d]) + 0.5) * spacing[d] for d in range(3)]
    xx, yy, zz = np.meshgrid(centers[0], centers[1], centers[2], indexing="ij")
    return 2.0 * xx + 3.0 * yy + 5.0 * zz + 7.0, list(lo), list(hi)


def _analytic(x, y, z):
    return 2.0 * x + 3.0 * y + 5.0 * z + 7.0


# ---------------------------------------------------------------------------
# Pure logic: probe lattice
# ---------------------------------------------------------------------------


def test_build_line_probe_points_endpoints_and_distances():
    probe = tally_vtk.build_line_probe_points([0, 0, 0], [3, 4, 0], 6)
    assert probe["p0"] == [0.0, 0.0, 0.0]
    assert probe["p1"] == [3.0, 4.0, 0.0]
    assert probe["npoints"] == 6
    assert probe["length"] == pytest.approx(5.0)
    # Endpoints included, spacing uniform, distances measured from p0.
    assert probe["points"][0].tolist() == pytest.approx([0.0, 0.0, 0.0])
    assert probe["points"][-1].tolist() == pytest.approx([3.0, 4.0, 0.0])
    assert probe["distances"].tolist() == pytest.approx([0.0, 1.0, 2.0, 3.0, 4.0, 5.0])


def test_build_line_probe_points_two_points():
    probe = tally_vtk.build_line_probe_points([1, 2, 3], [4, 5, 6], 2)
    assert probe["points"].tolist() == [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]


def test_require_probe_point_rejects_bad_values():
    for bad in ([0, 0], [0, 0, 0, 0], ["a", 0, 0], [0, np.nan, 0], [0, 0, np.inf], None, True):
        with pytest.raises(output_readers.OutputReaderError):
            tally_vtk._require_probe_point("p0", bad)


def test_require_npoints_bounds():
    assert tally_vtk._require_npoints(2) == 2
    assert tally_vtk._require_npoints("100") == 100
    for bad in (0, 1, -5, 100001, "many", True, 2.5, None):
        with pytest.raises(output_readers.OutputReaderError):
            tally_vtk._require_npoints(bad)


def test_zero_length_segment_rejected():
    with pytest.raises(output_readers.OutputReaderError, match="zero-length"):
        tally_vtk.build_line_probe_points([1, 2, 3], [1, 2, 3], 10)


# ---------------------------------------------------------------------------
# Sampling: analytic linear field + overlay-sampler parity
# ---------------------------------------------------------------------------


def test_sample_line_probe_smooth_matches_trilinear_sampler():
    values, lo, hi = _linear_grid()
    probe = tally_vtk.build_line_probe_points([0, 0, 0], [4, 5, 6], 21)
    sampled = tally_vtk.sample_line_probe(values, lo, hi, [0, 0, 0], [4, 5, 6], 21)
    assert sampled["smooth"] is True
    expected = tally_vtk.sample_trilinear_values(values, lo, hi, probe["points"])
    assert sampled["values"].tolist() == pytest.approx(expected.tolist())


def test_sample_line_probe_pixelated_matches_nearest_sampler():
    values, lo, hi = _linear_grid()
    probe = tally_vtk.build_line_probe_points([0, 0, 0], [4, 5, 6], 21)
    sampled = tally_vtk.sample_line_probe(values, lo, hi, [0, 0, 0], [4, 5, 6], 21, smooth=False)
    assert sampled["smooth"] is False
    expected = tally_vtk.sample_nearest_values(values, lo, hi, probe["points"])
    assert sampled["values"].tolist() == expected.tolist()


def test_sample_line_probe_linear_field_exact():
    # A trilinear sampler reproduces a linear field exactly: the smooth
    # probe of an analytic linear field must match at 1e-9. The probe stays
    # inside the cell-center lattice (edge coordinates clamp to the edge
    # cells by design, like the overlay samplers).
    values, lo, hi = _linear_grid()
    sampled = tally_vtk.sample_line_probe(values, lo, hi, [0.5, 0.5, 0.5], [3.5, 4.5, 5.5], 51)
    points = sampled["points"]
    analytic = [_analytic(x, y, z) for x, y, z in points.tolist()]
    assert sampled["values"].tolist() == pytest.approx(analytic, abs=1e-9)


def test_sample_line_probe_pixelated_matches_overlay_cell_lookup():
    # Pixelated probes show actual mesh cells (the overlay ``pixelated``
    # convention): probing a tiny segment starting at each cell center
    # recovers the flat x-major values in order.
    dims = [2, 2, 1]
    lo, hi = [0.0, 0.0, 0.0], [2.0, 2.0, 1.0]
    flat = np.arange(4, dtype=float)
    values = flat.reshape(dims, order="F")
    centers = tally_vtk.mesh_cell_centers(dims, lo, hi)
    for row, expected in zip(centers.tolist(), flat.tolist(), strict=True):
        start = [row[0] - 0.01, row[1], row[2]]
        sampled = tally_vtk.sample_line_probe(values, lo, hi, start, row, 2, smooth=False)
        assert sampled["values"][-1] == pytest.approx(expected)


def test_sample_line_probe_degenerate_segment_rejected():
    values, lo, hi = _linear_grid()
    with pytest.raises(output_readers.OutputReaderError, match="zero-length"):
        tally_vtk.sample_line_probe(values, lo, hi, [1, 1, 1], [1, 1, 1], 10)


# ---------------------------------------------------------------------------
# VTK writer: validators before the vtk gate + real XML when vtk exists
# ---------------------------------------------------------------------------


def test_write_probe_vtp_validators_before_vtk_gate(monkeypatch):
    """Bad payloads fail before vtk is even probed."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="one value per point"):
        tally_vtk.write_probe_vtp(
            [[0, 0, 0], [1, 0, 0]], [1.0, 2.0, 3.0], "flux-mean", "/tmp/x.vtp"
        )
    with pytest.raises(output_readers.OutputReaderError, match="N >= 2"):
        tally_vtk.write_probe_vtp([[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp")
    with pytest.raises(output_readers.OutputReaderError, match="array_name"):
        tally_vtk.write_probe_vtp([[0, 0, 0], [1, 0, 0]], [1.0, 2.0], "  ", "/tmp/x.vtp")


def test_write_probe_vtp_missing_vtk_forced(monkeypatch):
    """With vtk unavailable, the writer gate reports the missing dep."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="vtk"):
        tally_vtk.write_probe_vtp([[0, 0, 0], [1, 0, 0]], [1.0, 2.0], "flux-mean", "/tmp/x.vtp")


def test_write_probe_vtp_xml(tmp_path, monkeypatch):
    """The polyline writer emits one line cell with per-point values."""
    # The geometry-extract suite installs a bare vtk stub in sys.modules at
    # collection time (pre-existing leak: the sibling *vtk_xml tests fail
    # in-suite the same way); evict it so this test exercises the real
    # writer — monkeypatch restores the stub afterwards.
    for name in [m for m in sys.modules if m == "vtk" or m.startswith("vtk.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    vtk = pytest.importorskip("vtk")
    assert vtk is not None
    monkeypatch.setattr(tally_vtk, "HAS_VTK", True)
    out = tmp_path / "probe.vtp"
    tally_vtk.write_probe_vtp(
        [[0, 0, 0], [1, 0, 0], [2, 0, 0]], [10.0, 20.0, 30.0], "flux-mean", str(out)
    )
    text = out.read_text()
    assert "<PolyData" in text
    assert "<Lines>" in text
    assert "flux-mean" in text


# ---------------------------------------------------------------------------
# line_probe(): fake tally read (no h5py needed)
# ---------------------------------------------------------------------------


def _canned_mesh_tally(values=None):
    return {
        "tallyName": "Tally 4",
        "score": "flux",
        "nuclide": "total",
        "arrayName": "flux-mean",
        "dimension": [2, 2, 2],
        "lowerLeft": [0.0, 0.0, 0.0],
        "upperRight": [2.0, 2.0, 2.0],
        "values": np.arange(8, dtype=float) if values is None else values,
        "dataRange": [0.0, 7.0],
    }


def test_line_probe_series_json_shape(monkeypatch):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    result = tally_vtk.line_probe("sp.h5", 4, [0, 0, 0], [2, 2, 2], npoints=5)
    assert result["tallyId"] == 4
    assert result["arrayName"] == "flux-mean"
    assert result["npoints"] == 5
    assert result["smooth"] is True
    assert result["vtkPath"] is None
    assert len(result["series"]) == 5
    first, last = result["series"][0], result["series"][-1]
    assert first["distance"] == pytest.approx(0.0)
    assert first["position"] == pytest.approx([0.0, 0.0, 0.0])
    assert last["distance"] == pytest.approx(result["length"])
    assert last["position"] == pytest.approx([2.0, 2.0, 2.0])
    assert json.dumps(result)  # JSON-safe
    lo, hi = min(r["value"] for r in result["series"]), max(r["value"] for r in result["series"])
    assert result["dataRange"] == pytest.approx([lo, hi])


def test_line_probe_pixelated_matches_nearest(monkeypatch):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    smooth = tally_vtk.line_probe("sp.h5", 4, [0, 0, 0], [2, 2, 2], npoints=9)
    blocky = tally_vtk.line_probe("sp.h5", 4, [0, 0, 0], [2, 2, 2], npoints=9, smooth=False)
    assert blocky["smooth"] is False
    assert {r["value"] for r in blocky["series"]} <= {float(v) for v in range(8)}
    assert any(
        a["value"] != b["value"] for a, b in zip(smooth["series"], blocky["series"], strict=True)
    )


def test_line_probe_missing_file():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        tally_vtk.line_probe("/no/such/statepoint.h5", 1, [0, 0, 0], [1, 1, 1])


def test_line_probe_missing_h5py_forced(monkeypatch, tmp_path):
    """With h5py unavailable, the tally read reports the missing dep."""
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "statepoint.1.h5"
    fake.write_bytes(b"fake")
    with pytest.raises(output_readers.OutputReaderError, match="h5py"):
        tally_vtk.line_probe(str(fake), 1, [0, 0, 0], [1, 1, 1])


# ---------------------------------------------------------------------------
# Command handler: stdout-JSON errors, exit 1
# ---------------------------------------------------------------------------


def test_cmd_line_probe_missing_file(capsys):
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        ["--tally-id", "1", "--p0", "0", "0", "0", "--p1", "1", "1", "1", "/no/such.h5"],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 1
    assert "error" in _stdout_json(capsys)


def test_cmd_line_probe_mutually_exclusive_flags(capsys):
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        [
            "--tally-id",
            "1",
            "--p0",
            "0",
            "0",
            "0",
            "--p1",
            "1",
            "1",
            "1",
            "--smooth",
            "--pixelated",
            "/no/such.h5",
        ],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 1
    assert "mutually exclusive" in _stdout_json(capsys)["error"]


def test_cmd_line_probe_bad_npoints(capsys):
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        [
            "--tally-id",
            "1",
            "--p0",
            "0",
            "0",
            "0",
            "--p1",
            "1",
            "1",
            "1",
            "--npoints",
            "1",
            "/no/such.h5",
        ],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 1
    assert "npoints" in _stdout_json(capsys)["error"]


def test_cmd_line_probe_zero_length_segment(capsys, monkeypatch):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        ["--tally-id", "4", "--p0", "1", "1", "1", "--p1", "1", "1", "1", "sp.h5"],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 1
    assert "zero-length" in _stdout_json(capsys)["error"]


def test_cmd_line_probe_success_series(monkeypatch, capsys):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        [
            "--tally-id",
            "4",
            "--p0",
            "0",
            "0",
            "0",
            "--p1",
            "2",
            "2",
            "2",
            "--npoints",
            "5",
            "sp.h5",
        ],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 0
    payload = _stdout_json(capsys)
    assert payload["tallyId"] == 4
    assert len(payload["series"]) == 5
    assert payload["vtkPath"] is None


def test_cmd_line_probe_write_vtp_missing_vtk_forced(monkeypatch, capsys):
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    args = _parse(
        tally_vtk_cmds.cmd_tally_line_probe,
        ["--tally-id", "4", "--p0", "0", "0", "0", "--p1", "2", "2", "2", "--write-vtp", "sp.h5"],
    )
    rc = tally_vtk_cmds.cmd_tally_line_probe(args)
    assert rc == 1
    assert "vtk" in _stdout_json(capsys)["error"]
