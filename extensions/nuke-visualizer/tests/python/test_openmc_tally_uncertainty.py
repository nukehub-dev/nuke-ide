"""Tests for the bivariate uncertainty arrays (mean/std/rel-err).

The Python converters must emit ``<score>-std`` and ``<score>-rel-err``
next to ``<score>-mean`` with the same moments as
``output_readers._tally_score_moments``. Pure moment tests need only pytest
+ numpy; the HDF5 fixture skips without h5py and the VTK read-back tests
skip without vtk.
"""

import pytest

np = pytest.importorskip("numpy")

from plugins.openmc.lib import output_readers, tally_vtk  # noqa: E402

# 2x2x2 mesh, flux score, n_realizations = 2.  Per-bin (sum, sum_sq) pairs
# chosen so the expected moments are exact:
#   mean = sum / 2
#   std  = sqrt((sum_sq / 2 - mean**2) / (2 - 1))
#   rel  = std / |mean|
FLUX_SUMS = np.array([4.0, 24.0, 0.0, 0.0, 10.0, 20.0, -6.0, 8.0])
FLUX_SUMS_SQ = np.array([10.0, 296.0, 0.0, 8.0, 52.0, 200.0, 20.0, 34.0])
FLUX_MEAN = [2.0, 12.0, 0.0, 0.0, 5.0, 10.0, -3.0, 4.0]
FLUX_STD = [1.0, 2.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0]
# Bin 5 has zero spread; bins 2/3 are exact-zero (void) bins where OpenMC
# reports no error even though bin 3 carries a non-zero sum_sq.
FLUX_REL_ERR = [0.5, 1.0 / 6.0, 0.0, 0.0, 0.2, 0.0, 1.0 / 3.0, 0.25]

# Second score: sum = 10k, sum_sq = sum**2 / 2 + 2 -> mean 5k, std 1.
HEATING_SUMS = 10.0 * np.arange(1.0, 9.0)
HEATING_SUMS_SQ = HEATING_SUMS**2 / 2.0 + 2.0
HEATING_MEAN = [5.0 * k for k in range(1, 9)]
HEATING_REL_ERR = [1.0 / mean for mean in HEATING_MEAN]

N_REALIZATIONS = 2


def _write_uncertainty_fixture(path):
    """Statepoint with two scores whose moments are known analytically."""
    h5py = pytest.importorskip("h5py")
    with h5py.File(path, "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = "mesh flux"
        tally.create_dataset("score_bins", data=np.array([b"flux", b"heating"]))
        tally.create_dataset("nuclides", data=np.array([b"total"]))
        tally.create_dataset("filters", data=np.array([1]))
        tally.create_dataset("n_realizations", data=N_REALIZATIONS)
        results = np.zeros((8, 2, 1, 2), dtype=float)
        results[:, 0, 0, 0] = FLUX_SUMS
        results[:, 0, 0, 1] = FLUX_SUMS_SQ
        results[:, 1, 0, 0] = HEATING_SUMS
        results[:, 1, 0, 1] = HEATING_SUMS_SQ
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


def _read_vtk_arrays(path, association):
    """Read array names and values from a written .vti/.vtp via vtk."""
    vtk = pytest.importorskip("vtk")
    from vtk.util import numpy_support

    reader = vtk.vtkXMLPolyDataReader() if path.suffix == ".vtp" else vtk.vtkXMLImageDataReader()
    reader.SetFileName(str(path))
    reader.Update()
    data = (
        reader.GetOutput().GetPointData()
        if association == "point"
        else reader.GetOutput().GetCellData()
    )
    names = [data.GetArrayName(i) for i in range(data.GetNumberOfArrays())]
    values = {
        name: np.array(numpy_support.vtk_to_numpy(data.GetArray(name)), dtype=float)
        for name in names
    }
    return names, values


def _group(results, n_realizations):
    """Tiny stand-in for an h5py tally group (for the reader helper)."""

    class Group:
        def __init__(self):
            self._data = {
                "results": results,
                "n_realizations": np.asarray(n_realizations),
            }

        def __contains__(self, key):
            return key in self._data

        def __getitem__(self, key):
            return self._data[key]

    return Group()


# ---------------------------------------------------------------------------
# Pure moments
# ---------------------------------------------------------------------------


def test_tally_moments_match_output_reader_formula():
    results = np.zeros((3, 2, 1, 2), dtype=float)
    results[..., 0] = np.array([4.0, 24.0, 0.0, 10.0, 20.0, -6.0]).reshape(3, 2, 1)
    results[..., 1] = np.array([10.0, 296.0, 8.0, 52.0, 200.0, 20.0]).reshape(3, 2, 1)

    mean, std, rel_err = tally_vtk.tally_moments(results, 4)
    # The reader helper expects the h5py layout: (bins * nuclides, scores, 2).
    reader_results = results.reshape(3, 2, 2)
    for score_index in range(2):
        expected_mean, expected_std = output_readers._tally_score_moments(
            _group(reader_results, 4), score_index
        )
        expected_rel = np.zeros_like(expected_std)
        nonzero = np.abs(expected_mean) > 0
        expected_rel[nonzero] = expected_std[nonzero] / np.abs(expected_mean[nonzero])
        np.testing.assert_allclose(mean[:, score_index, 0], expected_mean.ravel())
        np.testing.assert_allclose(std[:, score_index, 0], expected_std.ravel())
        np.testing.assert_allclose(rel_err[:, score_index, 0], expected_rel.ravel())


def test_tally_moments_analytic_values():
    results = np.zeros((8, 1, 1, 2), dtype=float)
    results[..., 0] = FLUX_SUMS.reshape(8, 1, 1)
    results[..., 1] = FLUX_SUMS_SQ.reshape(8, 1, 1)
    mean, std, rel_err = tally_vtk.tally_moments(results, N_REALIZATIONS)
    np.testing.assert_allclose(mean.ravel(), FLUX_MEAN)
    np.testing.assert_allclose(std.ravel(), FLUX_STD)
    np.testing.assert_allclose(rel_err.ravel(), FLUX_REL_ERR)


def test_tally_moments_guards():
    # One bin with n = 4: sqrt((412/4 - 10**2) / (4 - 1)) = 1, rel = 0.1.
    four = np.array([[[[40.0, 412.0]]]])
    mean, std, rel_err = tally_vtk.tally_moments(four, 4)
    assert mean.ravel().tolist() == [10.0]
    assert std.ravel().tolist() == [1.0]
    assert rel_err.ravel().tolist() == [0.1]

    # A single realization has no sample variance even if sum_sq is present
    # (synthetic fixtures write sum_sq = 0 anyway).
    results = np.array([[[[5.0, 999.0]]]])
    mean, std, rel_err = tally_vtk.tally_moments(results, 1)
    assert mean.ravel().tolist() == [5.0]
    assert std.ravel().tolist() == [0.0]
    assert rel_err.ravel().tolist() == [0.0]

    # Exact-zero (void) bins ignore a stray sum_sq — the reader's guard.
    zero = np.array([[[[0.0, 8.0]]]])
    _, std_zero, rel_zero = tally_vtk.tally_moments(zero, N_REALIZATIONS)
    assert std_zero.ravel().tolist() == [0.0]
    assert rel_zero.ravel().tolist() == [0.0]

    # A non-finite mean carries no error information.
    bad = np.array([[[[np.nan, 1.0]]]])
    _, std_bad, rel_bad = tally_vtk.tally_moments(bad, N_REALIZATIONS)
    assert std_bad.ravel().tolist() == [0.0]
    assert rel_bad.ravel().tolist() == [0.0]

    with pytest.raises(output_readers.OutputReaderError, match="sum, sum_sq"):
        tally_vtk.tally_moments(np.asarray(1.0), 2)
    with pytest.raises(output_readers.OutputReaderError, match="n_realizations"):
        tally_vtk.tally_moments(np.zeros((3, 1, 2)), "many")

    # Older/synthetic results without a sum-of-squares column still yield
    # means; the uncertainty companions stay 0.
    sums_only = np.array([[[[3.0]]], [[[6.0]]]])
    mean_only, std_only, rel_only = tally_vtk.tally_moments(sums_only, N_REALIZATIONS)
    np.testing.assert_allclose(mean_only.ravel(), [1.5, 3.0])
    assert std_only.ravel().tolist() == [0.0, 0.0]
    assert rel_only.ravel().tolist() == [0.0, 0.0]


# ---------------------------------------------------------------------------
# Statepoint read
# ---------------------------------------------------------------------------


def test_read_mesh_tally_emits_uncertainty_arrays(tmp_path):
    pytest.importorskip("h5py")
    statepoint = tmp_path / "statepoint.2.h5"
    _write_uncertainty_fixture(str(statepoint))

    data = tally_vtk.read_mesh_tally(str(statepoint), 1)
    assert data["arrayName"] == "flux-mean"
    assert data["stdArrayName"] == "flux-std"
    assert data["relErrArrayName"] == "flux-rel-err"
    np.testing.assert_allclose(data["values"], FLUX_MEAN)
    np.testing.assert_allclose(data["stdValues"], FLUX_STD)
    np.testing.assert_allclose(data["relErrValues"], FLUX_REL_ERR)
    assert data["values"].shape == data["stdValues"].shape == data["relErrValues"].shape
    assert data["dataRange"] == [min(FLUX_MEAN), max(FLUX_MEAN)]


def test_read_mesh_tally_selects_score_moments(tmp_path):
    pytest.importorskip("h5py")
    statepoint = tmp_path / "statepoint.2.h5"
    _write_uncertainty_fixture(str(statepoint))

    data = tally_vtk.read_mesh_tally(str(statepoint), 1, score="heating")
    assert data["arrayName"] == "heating-mean"
    np.testing.assert_allclose(data["values"], HEATING_MEAN)
    np.testing.assert_allclose(data["stdValues"], np.ones(8))
    np.testing.assert_allclose(data["relErrValues"], HEATING_REL_ERR)


# ---------------------------------------------------------------------------
# VTK output: mean, std and rel-err together
# ---------------------------------------------------------------------------


def test_tally_mesh_to_vtk_writes_uncertainty_arrays(tmp_path):
    pytest.importorskip("vtk")
    pytest.importorskip("h5py")
    statepoint = tmp_path / "statepoint.2.h5"
    _write_uncertainty_fixture(str(statepoint))
    out = tmp_path / "tally.vti"

    result = tally_vtk.tally_mesh_to_vtk(str(statepoint), 1, output_path=str(out))
    assert result["arrayName"] == "flux-mean"
    assert result["stdArrayName"] == "flux-std"
    assert result["relErrArrayName"] == "flux-rel-err"

    names, values = _read_vtk_arrays(out, "cell")
    assert names == ["flux-mean", "flux-std", "flux-rel-err"]
    np.testing.assert_allclose(values["flux-mean"], FLUX_MEAN)
    np.testing.assert_allclose(values["flux-std"], FLUX_STD)
    np.testing.assert_allclose(values["flux-rel-err"], FLUX_REL_ERR)


def test_overlay_full_writes_uncertainty_arrays(tmp_path):
    pytest.importorskip("vtk")
    pytest.importorskip("h5py")
    statepoint = tmp_path / "statepoint.2.h5"
    _write_uncertainty_fixture(str(statepoint))
    out = tmp_path / "overlay_full.vtp"

    result = tally_vtk.overlay_to_vtk(str(statepoint), 1, mode="full", output_path=str(out))
    assert result["nPoints"] == 8
    names, values = _read_vtk_arrays(out, "point")
    assert names == ["flux-mean", "flux-std", "flux-rel-err"]
    np.testing.assert_allclose(values["flux-mean"], FLUX_MEAN)
    np.testing.assert_allclose(values["flux-std"], FLUX_STD)
    np.testing.assert_allclose(values["flux-rel-err"], FLUX_REL_ERR)


def test_overlay_slice_samples_uncertainty_on_the_mean_lattice(tmp_path):
    pytest.importorskip("vtk")
    pytest.importorskip("h5py")
    statepoint = tmp_path / "statepoint.2.h5"
    _write_uncertainty_fixture(str(statepoint))
    out = tmp_path / "overlay_slice.vtp"

    # Pixelated slice below the grid clamps to the bottom cell layer; the
    # 2x2 lattice order is (x0,y0), (x1,y0), (x0,y1), (x1,y1).
    result = tally_vtk.overlay_to_vtk(
        str(statepoint),
        1,
        mode="slice",
        plane="z",
        position=-3.0,
        resolution=1,
        pixelated=True,
        output_path=str(out),
    )
    assert result["nPoints"] == 4
    names, values = _read_vtk_arrays(out, "point")
    assert names == ["flux-mean", "flux-std", "flux-rel-err"]
    np.testing.assert_allclose(values["flux-mean"], [2.0, 12.0, 0.0, 0.0])
    np.testing.assert_allclose(values["flux-std"], [1.0, 2.0, 0.0, 0.0])
    np.testing.assert_allclose(values["flux-rel-err"], [0.5, 1.0 / 6.0, 0.0, 0.0])


# ---------------------------------------------------------------------------
# Writer validation
# ---------------------------------------------------------------------------


def test_write_overlay_vtp_rejects_bad_extra_arrays(monkeypatch):
    """Extra-array validation runs before the vtk gate."""
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="one value per point"):
        tally_vtk.write_overlay_vtp(
            [[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp", extra_arrays={"flux-std": [1.0, 2.0]}
        )
    with pytest.raises(output_readers.OutputReaderError, match="finite"):
        tally_vtk.write_overlay_vtp(
            [[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp", extra_arrays={"flux-std": [np.nan]}
        )
    with pytest.raises(output_readers.OutputReaderError, match="duplicate"):
        tally_vtk.write_overlay_vtp(
            [[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp", extra_arrays={"flux-mean": [1.0]}
        )
    with pytest.raises(output_readers.OutputReaderError, match="array_name"):
        tally_vtk.write_overlay_vtp(
            [[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp", extra_arrays={" ": [1.0]}
        )
    with pytest.raises(output_readers.OutputReaderError, match="map array names"):
        tally_vtk.write_overlay_vtp(
            [[0, 0, 0]], [1.0], "flux-mean", "/tmp/x.vtp", extra_arrays=[("flux-std", [1.0])]
        )


def test_write_mesh_vti_rejects_bad_extra_arrays(monkeypatch):
    monkeypatch.setattr(tally_vtk, "HAS_VTK", False)
    geometry = {
        "dims": [1, 1, 1],
        "origin": [0.0, 0.0, 0.0],
        "spacing": [1.0, 1.0, 1.0],
        "flat": [1.0],
    }
    with pytest.raises(output_readers.OutputReaderError, match="one value per cell"):
        tally_vtk.write_mesh_vti(
            geometry, "flux-mean", "/tmp/x.vti", extra_arrays={"flux-std": [1.0, 2.0]}
        )
    with pytest.raises(output_readers.OutputReaderError, match="duplicate"):
        tally_vtk.write_mesh_vti(
            geometry, "flux-mean", "/tmp/x.vti", extra_arrays={"flux-mean": [1.0]}
        )
