# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Helper and legacy-layout tests for the tally series reader.

``test_openmc_tally_series.py`` covers the current statepoint layout. This
module targets the validation seams and the older statepoint layouts that
store filters as tally subgroups and filter types as attributes. h5py-backed
tests skip when h5py is unavailable; the pure validation tests always run.
"""

import builtins

import pytest

np = pytest.importorskip("numpy")

from plugins.openmc.lib import output_readers, tally_series  # noqa: E402

# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def test_load_h5py_guards_none_module(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "h5py":
            return None
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(output_readers.OutputReaderError, match="h5py not installed"):
        tally_series._load_h5py()


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (True, "must be an integer"),
        (object(), "must be an integer"),
        ("abc", "must be an integer"),
        (0, "positive integer"),
        (-3, "positive integer"),
    ],
)
def test_require_tally_id_rejects_bad_values(value, message):
    with pytest.raises(output_readers.OutputReaderError, match=message):
        tally_series._require_tally_id(value)


def test_decode_string_list_handles_none_and_scalars():
    assert tally_series._decode_string_list(None) == []
    assert tally_series._decode_string_list(b"flux") == ["flux"]
    assert tally_series._decode_string_list("heating") == ["heating"]
    assert tally_series._decode_string_list(np.array([b"flux", "heating"])) == [
        "flux",
        "heating",
    ]


@pytest.mark.parametrize(
    ("values", "stds", "message"),
    [
        (["x"], [0.0], "values and stds must be numeric"),
        ([1.0], ["x"], "values and stds must be numeric"),
    ],
)
def test_aggregate_values_rejects_non_numeric_input(values, stds, message):
    with pytest.raises(output_readers.OutputReaderError, match=message):
        tally_series.aggregate_values(values, stds, "total")


def test_aggregate_values_rejects_non_numeric_volumes():
    with pytest.raises(output_readers.OutputReaderError, match="volumes must be numeric"):
        tally_series.aggregate_values([1.0], [0.0], "total", volumes=["x"])


def test_aggregate_values_rejects_zero_volume_mean():
    with pytest.raises(output_readers.OutputReaderError, match="volumes are all zero"):
        tally_series.aggregate_values([1.0, 2.0], [0.0, 0.0], "mean", volumes=[0.0, 0.0])


def test_filter_helpers_handle_missing_metadata():
    assert tally_series._filter_type(None) == ""
    assert tally_series._mesh_id(None) is None
    assert tally_series._mesh_id({}) is None


def test_mesh_cell_volumes_returns_none_for_invalid_grid():
    data = {
        "meshKind": "regular",
        "meshOnly": True,
        "dimension": [0, 1, 1],
        "lowerLeft": [0.0, 0.0, 0.0],
        "upperRight": [1.0, 1.0, 1.0],
        "values": np.array([1.0]),
    }
    assert tally_series._mesh_cell_volumes(data) is None


def test_build_series_rejects_non_numeric_times():
    with pytest.raises(output_readers.OutputReaderError, match="must be numbers"):
        tally_series.build_series(["/no/such/statepoint.1.h5"], 1, times=["zero"])


def test_build_series_rejects_non_finite_times():
    with pytest.raises(output_readers.OutputReaderError, match="finite numbers"):
        tally_series.build_series(["/no/such/statepoint.1.h5"], 1, times=[np.nan])


# ---------------------------------------------------------------------------
# h5py fixtures
# ---------------------------------------------------------------------------


def _write_statepoint(path, values=(1.0, 2.0), *, name=b"tally"):
    """Write a filter-free statepoint with one score/nuclide."""
    h5py = pytest.importorskip("h5py")
    grid = np.asarray(values, dtype=float)[:, None, None]
    n_bins, n_scores, n_nuclides = grid.shape
    n_realizations = 10
    with h5py.File(str(path), "w") as f:
        tally = f.create_group("tallies").create_group("tally 1")
        tally.attrs["name"] = np.bytes_(name)
        tally.create_dataset("score_bins", data=np.array([b"flux"], dtype="S"))
        tally.create_dataset("nuclides", data=np.array([b"total"], dtype="S"))
        tally.create_dataset("n_realizations", data=n_realizations)
        results = np.zeros((n_bins, n_scores, n_nuclides, 2))
        results[..., 0] = grid * n_realizations
        tally.create_dataset("results", data=results)


def test_build_series_accepts_single_path_and_decodes_bytes_name(tmp_path):
    pytest.importorskip("h5py")
    path = tmp_path / "statepoint.5.h5"
    _write_statepoint(path, name=b"legacy tally")

    result = tally_series.build_series(str(path), 1)

    assert result["tallyName"] == "legacy tally"
    assert result["hasMesh"] is False
    assert [step["time"] for step in result["steps"]] == [5]


def test_read_tally_bins_rejects_missing_results(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        tally = f.create_group("tallies").create_group("tally 1")
        tally.create_dataset("score_bins", data=np.array([b"flux"], dtype="S"))

    with pytest.raises(output_readers.OutputReaderError, match="has no results dataset"):
        tally_series.read_tally_bins(str(path), 1)


def test_read_tally_bins_rejects_results_not_divisible_by_bins(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        tally = f.create_group("tallies").create_group("tally 1")
        tally.create_dataset(
            "score_bins", data=np.array([b"flux", b"heating", b"fission"], dtype="S")
        )
        tally.create_dataset("nuclides", data=np.array([b"total"], dtype="S"))
        tally.create_dataset("results", data=np.ones((2, 1, 1, 2)))

    with pytest.raises(output_readers.OutputReaderError, match="not divisible into 3 scores"):
        tally_series.read_tally_bins(str(path), 1)


def test_read_tally_bins_legacy_group_filters_and_attributes(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = np.bytes_(b"legacy mesh")
        tally.create_dataset("score_bins", data=np.array([b"flux"], dtype="S"))
        tally.create_dataset("nuclides", data=np.array([b"total"], dtype="S"))
        tally.create_dataset("results", data=np.ones((2, 1, 1, 2)))

        # Older layout: filter objects live directly under the tally and
        # carry their type as a group attribute instead of a dataset.
        filters = tally.create_group("filters")
        filter_obj = filters.create_group("filter 1")
        filter_obj.attrs["type"] = np.bytes_(b"mesh")
        filter_obj.create_dataset("n_bins", data=2)
        filter_obj.create_dataset("bins", data=np.array([7]))

        mesh = tallies.create_group("meshes").create_group("mesh 7")
        mesh.create_dataset("dimension", data=np.array([2, 1, 1]))
        mesh.create_dataset("lower_left", data=np.array([0.0, 0.0, 0.0]))
        mesh.create_dataset("upper_right", data=np.array([2.0, 1.0, 1.0]))

    data = tally_series.read_tally_bins(str(path), 1)

    assert data["tallyName"] == "legacy mesh"
    assert data["hasMesh"] is True
    assert data["meshKind"] == "regular"
    assert data["meshOnly"] is True
    assert data["dimension"] == [2, 1, 1]
    assert data["values"].tolist() == [1.0, 1.0]


def test_read_tally_bins_mesh_filter_without_bins_has_no_mesh(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.create_dataset("score_bins", data=np.array([b"flux"], dtype="S"))
        tally.create_dataset("results", data=np.ones((1, 1, 1, 2)))
        filters = tallies.create_group("filters")
        filter_obj = filters.create_group("filter 1")
        filter_obj.create_dataset("type", data=np.bytes_(b"mesh"))
        tally.create_dataset("filters", data=np.array([1]))

    data = tally_series.read_tally_bins(str(path), 1)

    assert data["hasMesh"] is True
    assert data["meshKind"] is None
    assert data["meshOnly"] is True


def test_read_tally_bins_uses_first_of_multiple_meshes(tmp_path):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.create_dataset("score_bins", data=np.array([b"flux"], dtype="S"))
        tally.create_dataset("results", data=np.ones((1, 1, 1, 2)))
        filters = tallies.create_group("filters")
        for index, mesh_id in enumerate((7, 8), start=1):
            filter_obj = filters.create_group(f"filter {index}")
            filter_obj.create_dataset("type", data=np.bytes_(b"mesh"))
            filter_obj.create_dataset("bins", data=np.array([mesh_id]))
        tally.create_dataset("filters", data=np.array([1, 2]))

        meshes = tallies.create_group("meshes")
        for mesh_id, upper in ((7, 2.0), (8, 4.0)):
            mesh = meshes.create_group(f"mesh {mesh_id}")
            mesh.create_dataset("dimension", data=np.array([2, 1, 1]))
            mesh.create_dataset("lower_left", data=np.array([0.0, 0.0, 0.0]))
            mesh.create_dataset("upper_right", data=np.array([upper, 1.0, 1.0]))

    data = tally_series.read_tally_bins(str(path), 1)

    assert data["hasMesh"] is True
    assert data["meshKind"] == "regular"
    assert data["meshOnly"] is False
    assert data["upperRight"] == [2.0, 1.0, 1.0]


def test_read_tally_bins_missing_tally_lists_available(tmp_path, capsys):
    h5py = pytest.importorskip("h5py")
    path = tmp_path / "statepoint.1.h5"
    with h5py.File(str(path), "w") as f:
        f.create_group("tallies").create_group("tally 2")

    with pytest.raises(output_readers.OutputReaderError, match=r"available: \['tally 2'\]"):
        tally_series.read_tally_bins(str(path), 1)
    assert capsys.readouterr().out == ""
