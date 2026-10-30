"""Extra coverage for plugins.openmc.lib.tally_vtk.

Targets the validators, default-output-path helpers, HDF5 layout variants,
source-bank shapes, and error branches that the main tally/probe/contour
suites do not exercise. All fixtures are tiny synthetic arrays/files; no
network, no real statepoints, no rendering.
"""

import builtins
import sys

import pytest

np = pytest.importorskip("numpy")

from plugins.openmc.lib import output_readers, tally_vtk  # noqa: E402


def _err(match=None):
    return pytest.raises(output_readers.OutputReaderError, match=match)


def _freeze_tempdir(monkeypatch, tmp_path):
    """Point the converter's default-output temp dir at ``tmp_path``."""
    monkeypatch.setattr(tally_vtk.tempfile, "mkdtemp", lambda prefix=None: str(tmp_path))


def _canned_mesh_tally(values=None, dims=(2, 2, 2), lo=(0.0, 0.0, 0.0), hi=(2.0, 2.0, 2.0)):
    """Minimal read_mesh_tally() payload used by the converter entry points."""
    flat = (
        np.arange(dims[0] * dims[1] * dims[2], dtype=float)
        if values is None
        else np.asarray(values, dtype=float)
    )
    return {
        "tallyName": "Tally 1",
        "score": "flux",
        "nuclide": "total",
        "arrayName": "flux-mean",
        "stdArrayName": "flux-std",
        "relErrArrayName": "flux-rel-err",
        "dimension": list(dims),
        "lowerLeft": list(lo),
        "upperRight": list(hi),
        "values": flat,
        "stdValues": np.full(flat.shape, 0.5),
        "relErrValues": np.full(flat.shape, 0.1),
        "dataRange": [float(flat.min()), float(flat.max())],
    }


# ---------------------------------------------------------------------------
# Lazy dependency loaders + default output path
# ---------------------------------------------------------------------------


def test_load_vtk_reports_import_failure(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", True)
    monkeypatch.setitem(sys.modules, "vtk", None)
    with _err("vtk not installed"):
        tally_vtk._load_vtk()


def test_load_h5py_reports_none_module(monkeypatch):
    """An import that binds None (a broken install) still reports cleanly."""
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "h5py":
            return None
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with _err("h5py not installed"):
        tally_vtk._load_h5py()


def test_default_output_path_builds_flat_stem(monkeypatch, tmp_path):
    _freeze_tempdir(monkeypatch, tmp_path)
    out = tally_vtk._default_output_path(tmp_path / "statepoint.10.h5", ".vti")
    assert out == str(tmp_path / "statepoint_10.vti")


def test_default_output_path_rejects_invalid_input():
    for bad in (None, "", 3, 3.5):
        with _err("invalid input path"):
            tally_vtk._default_output_path(bad, ".vti")


# ---------------------------------------------------------------------------
# Small validators
# ---------------------------------------------------------------------------


def test_require_position_rejects_bool_and_unparsable():
    with _err("position must be a number"):
        tally_vtk._require_position(True)
    with _err("position must be a number"):
        tally_vtk._require_position("not-a-number")
    assert tally_vtk._require_position("1.5") == 1.5


def test_require_limit_rejects_bad_values():
    assert tally_vtk._require_limit("limit", None) is None
    assert tally_vtk._require_limit("limit", "3") == 3
    for bad in (True, "three", 0, -2):
        with _err("limit must be a positive integer"):
            tally_vtk._require_limit("limit", bad)


def test_tally_moments_rejects_non_numeric_and_empty_moments():
    with _err("tally results must be numeric"):
        tally_vtk.tally_moments([["a"]], 10)
    with _err(r"must hold \[sum, sum_sq\]"):
        tally_vtk.tally_moments(np.zeros((0,)), 10)


def test_validate_extra_arrays_rejects_non_numeric_values():
    with _err("std values must be numeric"):
        tally_vtk._validate_extra_arrays(2, {"std": ["a", "b"]}, "cell")


def test_validate_mesh_grid_rejects_unparsable_and_short_vectors():
    with _err("3 integers"):
        tally_vtk.validate_mesh_grid(["x", 2, 3], [0, 0, 0], [1, 1, 1])
    with _err("3 numbers"):
        tally_vtk.validate_mesh_grid([2, 2, 2], ["a", 0, 0], [1, 1, 1])
    with _err("3 numbers"):
        tally_vtk.validate_mesh_grid([2, 2, 2], [0, 0], [1, 1, 1])


def test_build_mesh_image_rejects_non_numeric_values():
    with _err("tally values must be numeric"):
        tally_vtk.build_mesh_image([1, 1, 1], [0, 0, 0], [1, 1, 1], ["a"])


def test_write_mesh_vti_rejects_bad_geometry_dicts(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with _err("build_mesh_image dict"):
        tally_vtk.write_mesh_vti(None, "flux", "/tmp/x.vti")
    with _err("dims/origin/spacing must hold numbers"):
        tally_vtk.write_mesh_vti(
            {"dims": ["x", 1, 1], "origin": [0, 0, 0], "spacing": [1, 1, 1], "flat": [1.0]},
            "flux",
            "/tmp/x.vti",
        )


def test_decode_string_list_handles_none_bytes_and_scalars():
    assert tally_vtk._decode_string_list(None) == []
    assert tally_vtk._decode_string_list(b"flux") == ["flux"]
    assert tally_vtk._decode_string_list(["flux", b"heating"]) == ["flux", "heating"]


# ---------------------------------------------------------------------------
# Sampler validators
# ---------------------------------------------------------------------------


def test_sample_trilinear_rejects_bad_inputs():
    grid = np.ones((2, 2, 2))
    with _err("numeric 3D"):
        tally_vtk.sample_trilinear_values([["a"]], [0, 0, 0], [1, 1, 1], [[0.5, 0.5, 0.5]])
    with _err(r"shape \(nx, ny, nz\)"):
        tally_vtk.sample_trilinear_values(np.ones((2, 2)), [0, 0, 0], [1, 1, 1], [[0, 0, 0]])
    with _err("3 numbers"):
        tally_vtk.sample_trilinear_values(grid, [0, 0], [1, 1, 1], [[0, 0, 0]])
    with _err("lower < upper"):
        tally_vtk.sample_trilinear_values(grid, [0, 0, 0], [0, 1, 1], [[0, 0, 0]])
    with _err(r"shape \(N, 3\)"):
        tally_vtk.sample_trilinear_values(grid, [0, 0, 0], [1, 1, 1], ["a"])
    with _err("at least one point"):
        tally_vtk.sample_trilinear_values(grid, [0, 0, 0], [1, 1, 1], np.zeros((0, 3)))
    with _err("points must all be finite"):
        tally_vtk.sample_trilinear_values(grid, [0, 0, 0], [1, 1, 1], [[np.nan, 0, 0]])


def test_sample_nearest_rejects_bad_inputs():
    grid = np.ones((2, 2, 2))
    with _err("numeric 3D"):
        tally_vtk.sample_nearest_values([["a"]], [0, 0, 0], [1, 1, 1], [[0.5, 0.5, 0.5]])
    with _err(r"shape \(nx, ny, nz\)"):
        tally_vtk.sample_nearest_values(np.ones((2, 2)), [0, 0, 0], [1, 1, 1], [[0, 0, 0]])
    with _err("3 numbers"):
        tally_vtk.sample_nearest_values(grid, [0, 0], [1, 1, 1], [[0, 0, 0]])
    with _err("lower < upper"):
        tally_vtk.sample_nearest_values(grid, [0, 0, 0], [0, 1, 1], [[0, 0, 0]])
    with _err(r"shape \(N, 3\)"):
        tally_vtk.sample_nearest_values(grid, [0, 0, 0], [1, 1, 1], ["a"])
    with _err("at least one point"):
        tally_vtk.sample_nearest_values(grid, [0, 0, 0], [1, 1, 1], np.zeros((0, 3)))
    with _err("points must all be finite"):
        tally_vtk.sample_nearest_values(grid, [0, 0, 0], [1, 1, 1], [[np.inf, 0, 0]])


def test_sample_regular_slice_rejects_bad_grid_and_bounds():
    with _err("numeric 3D"):
        tally_vtk.sample_regular_slice([["a"]], [0, 0, 0], [1, 1, 1])
    with _err("3 numbers"):
        tally_vtk.sample_regular_slice(np.ones((2, 2, 2)), [0, 0], [1, 1, 1])
    with _err("lower < upper"):
        tally_vtk.sample_regular_slice(np.ones((2, 2, 2)), [0, 0, 0], [1, 1, 0])


# ---------------------------------------------------------------------------
# VTK writer validators (fail before the vtk gate)
# ---------------------------------------------------------------------------


def test_write_overlay_vtp_rejects_bad_payloads(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with _err(r"shape \(N, 3\)"):
        tally_vtk.write_overlay_vtp([["a"]], [1.0], "flux", "/tmp/x.vtp")
    with _err("N > 0"):
        tally_vtk.write_overlay_vtp([], [], "flux", "/tmp/x.vtp")
    with _err("points must all be finite"):
        tally_vtk.write_overlay_vtp([[np.nan, 0, 0]], [1.0], "flux", "/tmp/x.vtp")
    with _err("values must be numeric"):
        tally_vtk.write_overlay_vtp([[0, 0, 0]], ["a"], "flux", "/tmp/x.vtp")
    with _err("values must all be finite"):
        tally_vtk.write_overlay_vtp([[0, 0, 0]], [np.inf], "flux", "/tmp/x.vtp")


def test_write_probe_vtp_rejects_bad_payloads(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with _err(r"shape \(N, 3\)"):
        tally_vtk.write_probe_vtp([["a"], ["b"]], [1.0, 2.0], "flux", "/tmp/x.vtp")
    with _err("points must all be finite"):
        tally_vtk.write_probe_vtp([[0, 0, 0], [np.nan, 0, 0]], [1.0, 2.0], "flux", "/tmp/x.vtp")
    with _err("values must be numeric"):
        tally_vtk.write_probe_vtp([[0, 0, 0], [1, 0, 0]], ["a", "b"], "flux", "/tmp/x.vtp")
    with _err("values must all be finite"):
        tally_vtk.write_probe_vtp([[0, 0, 0], [1, 0, 0]], [1.0, np.nan], "flux", "/tmp/x.vtp")


def test_require_iso_value_rejects_bool():
    with _err("iso values must be numbers"):
        tally_vtk._require_iso_value(True)


def test_require_iso_values_rejects_non_iterable():
    with _err("hold 1-8 numbers"):
        tally_vtk._require_iso_values(5)


def test_require_contour_grid_rejects_bad_inputs():
    with _err("numeric 3D"):
        tally_vtk._require_contour_grid([["a"]], [0, 0, 0], [1, 1, 1])
    with _err(r"shape \(nx, ny, nz\)"):
        tally_vtk._require_contour_grid(np.ones((2, 2)), [0, 0, 0], [1, 1, 1])
    with _err("tally values must all be finite"):
        tally_vtk._require_contour_grid(
            np.array([[[np.nan, 1.0], [1.0, 1.0]], [[1.0, 1.0], [1.0, 1.0]]]),
            [0, 0, 0],
            [2, 2, 2],
        )
    with _err("3 numbers"):
        tally_vtk._require_contour_grid(np.ones((2, 2, 2)), [0, 0], [1, 1, 1])
    with _err("lower < upper"):
        tally_vtk._require_contour_grid(np.ones((2, 2, 2)), [0, 0, 0], [0, 1, 1])


def test_write_contour_vtp_rejects_bad_payloads(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    points = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
    triangles = [[0, 1, 2]]
    with _err(r"shape \(N, 3\)"):
        tally_vtk.write_contour_vtp(
            [["a"], ["b"], ["c"]], triangles, [1.0] * 3, "flux", "/tmp/x.vtp"
        )
    with _err("N > 0"):
        tally_vtk.write_contour_vtp([], triangles, [], "flux", "/tmp/x.vtp")
    with _err("points must all be finite"):
        tally_vtk.write_contour_vtp(
            [[0, 0, 0], [1, 0, 0], [np.nan, 1, 0]], triangles, [1.0] * 3, "flux", "/tmp/x.vtp"
        )
    with _err("triangles must hold"):
        tally_vtk.write_contour_vtp(points, [["a"]], [1.0] * 3, "flux", "/tmp/x.vtp")
    with _err("values must be numeric"):
        tally_vtk.write_contour_vtp(points, triangles, ["a", "b", "c"], "flux", "/tmp/x.vtp")
    with _err("values must all be finite"):
        tally_vtk.write_contour_vtp(points, triangles, [1.0, np.inf, 1.0], "flux", "/tmp/x.vtp")


# ---------------------------------------------------------------------------
# Default output paths on the converter entry points
# ---------------------------------------------------------------------------


def test_tally_mesh_to_vtk_uses_default_temp_path(monkeypatch, tmp_path):
    _freeze_tempdir(monkeypatch, tmp_path)
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_mesh_vti", lambda *a, **k: a[2])
    result = tally_vtk.tally_mesh_to_vtk("statepoint.1.h5", 1)
    assert result["vtkPath"] == str(tmp_path / "statepoint_1.vti")
    assert result["nCells"] == 8


def test_overlay_to_vtk_uses_default_temp_path(monkeypatch, tmp_path):
    _freeze_tempdir(monkeypatch, tmp_path)
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_overlay_vtp", lambda *a, **k: a[3])
    result = tally_vtk.overlay_to_vtk("statepoint.1.h5", 1, mode="full")
    assert result["vtkPath"] == str(tmp_path / "statepoint_1.vtp")
    assert result["nPoints"] == 8


def test_line_probe_write_vtp_uses_default_temp_path(monkeypatch, tmp_path):
    _freeze_tempdir(monkeypatch, tmp_path)
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_probe_vtp", lambda *a, **k: a[3])
    result = tally_vtk.line_probe(
        "statepoint.1.h5", 1, [0, 0, 0], [2, 2, 2], npoints=5, write_vtp=True
    )
    assert result["vtkPath"] == str(tmp_path / "statepoint_1.vtp")
    assert len(result["series"]) == 5


def test_tally_contour_uses_default_temp_path(monkeypatch, tmp_path):
    _freeze_tempdir(monkeypatch, tmp_path)
    monkeypatch.setattr(tally_vtk, "read_mesh_tally", lambda *a, **k: _canned_mesh_tally())
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_contour_vtp", lambda *a, **k: a[4])
    result = tally_vtk.tally_contour("statepoint.1.h5", 1, [3.5])
    assert result["vtkPath"] == str(tmp_path / "statepoint_1.vtp")
    assert result["nTriangles"] > 0


# ---------------------------------------------------------------------------
# Source bank / source writer branches
# ---------------------------------------------------------------------------


def _write_source_bank(path, data, key="source_bank"):
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "w") as f:
        f.create_dataset(key, data=data)


def test_build_source_points_rejects_non_numeric_inputs():
    with _err("source positions must be numeric"):
        tally_vtk.build_source_points([["a", 0, 0]])
    with _err("source energy values must be numeric"):
        tally_vtk.build_source_points([[0, 0, 0]], energies=["a"])
    with _err("source weight values must be numeric"):
        tally_vtk.build_source_points([[0, 0, 0]], weights=[object()])


def test_build_source_points_rejects_non_finite_energy():
    with _err("source energy values must all be finite"):
        tally_vtk.build_source_points([[0, 0, 0]], energies=[np.nan])


def test_read_source_points_no_bank(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "source.h5"
    _write_source_bank(path, np.zeros(3), key="unrelated")
    with _err("No source bank found"):
        tally_vtk.read_source_points(str(path))


def test_read_source_points_empty_bank(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "source.h5"
    _write_source_bank(path, np.zeros((0,), dtype=[("r", "<f8", (3,))]))
    with _err("No source particles found"):
        tally_vtk.read_source_points(str(path))


def test_read_source_points_plain_matrix(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "source.h5"
    _write_source_bank(path, np.arange(12, dtype=float).reshape(4, 3))
    data = tally_vtk.read_source_points(str(path), limit=3)
    assert data["nParticles"] == 3
    assert data["totalParticles"] == 4
    assert data["positions"].tolist() == [[0, 1, 2], [3, 4, 5], [6, 7, 8]]
    assert data["energies"] is None and data["weights"] is None


def test_read_source_points_unusable_layout(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "source.h5"
    _write_source_bank(path, np.arange(5, dtype=float))
    with _err("Could not read particle positions"):
        tally_vtk.read_source_points(str(path))


def test_extract_compound_vectors_plain_vector_field_and_missing():
    bank = np.zeros(3, dtype=[("pos", "<f8", (3,))])
    bank["pos"] = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
    vectors = tally_vtk._extract_compound_vectors(bank, ("r", "pos"), 2)
    assert vectors.tolist() == [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    assert tally_vtk._extract_compound_vectors(bank, ("r",), 2) is None


def test_write_source_vtp_rejects_unknown_array():
    with _err("unsupported source array 'bogus'"):
        tally_vtk.write_source_vtp(
            [[0, 0, 0], [1, 1, 1]], {"energy": [1.0, 2.0], "bogus": [0.0, 0.0]}, "/tmp/x.vtp"
        )


def test_source_to_vtk_uses_default_temp_path(monkeypatch, tmp_path):
    pytest.importorskip("h5py")
    _freeze_tempdir(monkeypatch, tmp_path)
    path = tmp_path / "source.h5"
    _write_source_bank(path, np.arange(9, dtype=float).reshape(3, 3))
    monkeypatch.setattr(tally_vtk, "_load_vtk", lambda: (None, None))
    monkeypatch.setattr(tally_vtk, "write_source_vtp", lambda *a, **k: a[2])
    result = tally_vtk.source_to_vtk(str(path))
    assert result["vtkPath"] == str(tmp_path / "source.vtp")
    assert result["nParticles"] == 3


# ---------------------------------------------------------------------------
# read_mesh_tally(): statepoint layout variants
# ---------------------------------------------------------------------------


def _write_valid_statepoint(path, *, tally_name="mesh flux", nuclides=(b"total",)):
    h5py = pytest.importorskip("h5py")
    values = np.arange(8, dtype=float)
    with h5py.File(str(path), "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = tally_name
        tally.create_dataset("score_bins", data=np.array([b"flux"]))
        tally.create_dataset("nuclides", data=np.array(list(nuclides)))
        tally.create_dataset("filters", data=np.array([1]))
        results = np.zeros((8, 1, 1, 2))
        results[..., 0] = values.reshape(8, 1, 1)
        tally.create_dataset("results", data=results)
        filters = tallies.create_group("filters")
        mesh_filter = filters.create_group("filter 1")
        mesh_filter.create_dataset("type", data=np.bytes_(b"mesh"))
        mesh_filter.create_dataset("bins", data=np.array([7]))
        meshes = tallies.create_group("meshes")
        mesh = meshes.create_group("mesh 7")
        mesh.create_dataset("dimension", data=np.array([2, 2, 2]))
        mesh.create_dataset("lower_left", data=np.array([-1.0, -2.0, -3.0]))
        mesh.create_dataset("upper_right", data=np.array([1.0, 2.0, 3.0]))


def test_read_mesh_tally_missing_tallies_group(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        f.create_group("statepoint")
    with _err("No tallies found"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_decodes_byte_name(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path, tally_name=np.bytes_(b"raw flux"))
    assert tally_vtk.read_mesh_tally(str(path), 1)["tallyName"] == "raw flux"


def test_read_mesh_tally_unknown_nuclide(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    with _err("Nuclide 'uranium'"):
        tally_vtk.read_mesh_tally(str(path), 1, nuclide="uranium")


def test_read_mesh_tally_filters_group_layout(tmp_path):
    """Legacy/group-shaped filters (not a dataset of ids) are walked."""
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        tally = f["tallies"]["tally 1"]
        del tally["filters"]
        filters = tally.create_group("filters")
        mesh_filter = filters.create_group("filter 1")
        mesh_filter.create_dataset("type", data=np.bytes_(b"mesh"))
        mesh_filter.create_dataset("bins", data=np.array([7]))
    data = tally_vtk.read_mesh_tally(str(path), 1)
    assert data["dimension"] == [2, 2, 2]
    assert data["values"].tolist() == list(range(8))


def test_read_mesh_tally_skips_missing_filter_ids(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        tally = f["tallies"]["tally 1"]
        del tally["filters"]
        # The missing id leads so the mesh filter (which breaks the loop)
        # does not short-circuit the skip branch.
        tally.create_dataset("filters", data=np.array([2, 1]))
    assert tally_vtk.read_mesh_tally(str(path), 1)["dimension"] == [2, 2, 2]


def test_read_mesh_tally_non_mesh_filter_reports_missing_mesh(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        del f["tallies"]["filters"]["filter 1"]["type"]
        f["tallies"]["filters"]["filter 1"].create_dataset("type", data=np.bytes_(b"cell"))
    with _err("does not have a mesh filter"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_without_filters_reports_missing_mesh(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        del f["tallies"]["tally 1"]["filters"]
    with _err("does not have a mesh filter"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_rejects_cylindrical_mesh(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        f["tallies"]["meshes"]["mesh 7"].create_dataset("r_grid", data=np.zeros(3))
    with _err("cylindrical mesh"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_mesh_missing_bounds(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        del f["tallies"]["meshes"]["mesh 7"]["upper_right"]
    with _err("missing dimension/bounds"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_missing_results(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        del f["tallies"]["tally 1"]["results"]
    with _err("no results dataset"):
        tally_vtk.read_mesh_tally(str(path), 1)


def test_read_mesh_tally_results_size_mismatch(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    _write_valid_statepoint(path)
    h5py = pytest.importorskip("h5py")
    with h5py.File(str(path), "r+") as f:
        tally = f["tallies"]["tally 1"]
        del tally["results"]
        tally.create_dataset("results", data=np.zeros((2, 1, 1, 2)))
    with _err("multi-filter tallies cannot be exported"):
        tally_vtk.read_mesh_tally(str(path), 1)
