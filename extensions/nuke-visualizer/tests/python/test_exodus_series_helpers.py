# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Helper-level tests for the Exodus-II series extractor.

``test_exodus_series.py`` covers the end-to-end series shape. This module
targets the reader seams that real Exodus files hit only on damaged or
older layouts: JSON conversion, name tables, coordinate variants, block
labels, variable indexing, and the meshio fallback failures. Both backends
are faked, so the tests run in the minimal pytest + numpy profile.
"""

import json
import sys
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from plugins.base.lib import exodus_series  # noqa: E402


def test_json_default_serializes_numpy_and_bytes():
    payload = {
        "array": np.array([1, 2]),
        "integer": np.int64(3),
        "floating": np.float32(1.5),
        "boolean": np.bool_(True),
        "bytes": b"mesh",
    }

    encoded = json.dumps(payload, default=exodus_series.json_default)

    assert json.loads(encoded) == {
        "array": [1, 2],
        "integer": 3,
        "floating": 1.5,
        "boolean": True,
        "bytes": "mesh",
    }
    with pytest.raises(TypeError, match="not JSON serializable"):
        json.dumps({"object": object()}, default=exodus_series.json_default)


def test_decimate_indices_single_point_budget():
    assert exodus_series.decimate_indices(10, 1).tolist() == [0]
    assert exodus_series.decimate_indices(1, 1).tolist() == [0]


# ---------------------------------------------------------------------------
# Dependency guards
# ---------------------------------------------------------------------------


def test_load_netcdf4_requires_flag(monkeypatch):
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", False)
    with pytest.raises(exodus_series.ExodusSeriesError, match="netCDF4 is not installed"):
        exodus_series._load_netcdf4()


def test_load_netcdf4_reports_import_failure(monkeypatch):
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", True)
    monkeypatch.setitem(sys.modules, "netCDF4", None)
    with pytest.raises(exodus_series.ExodusSeriesError, match="netCDF4 is not installed"):
        exodus_series._load_netcdf4()


def test_meshio_fallback_requires_meshio(monkeypatch):
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", False)
    with pytest.raises(exodus_series.ExodusSeriesError, match="fallback reader unavailable"):
        exodus_series._extract_via_meshio("fake.e", None, 5000)


def test_meshio_fallback_reports_import_failure(monkeypatch):
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", True)
    monkeypatch.setitem(sys.modules, "meshio", None)
    with pytest.raises(exodus_series.ExodusSeriesError, match="meshio is not installed"):
        exodus_series._extract_via_meshio("fake.e", None, 5000)


def test_meshio_fallback_reports_read_failure(monkeypatch):
    module = ModuleType("meshio")

    def _read(_path):
        raise RuntimeError("bad exodus file")

    module.read = _read
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", True)
    monkeypatch.setitem(sys.modules, "meshio", module)

    with pytest.raises(exodus_series.ExodusSeriesError, match="bad exodus file"):
        exodus_series._extract_via_meshio("fake.e", None, 5000)


# ---------------------------------------------------------------------------
# Name tables
# ---------------------------------------------------------------------------


class _RaisingVar:
    """Variable stub whose data read raises."""

    def __getitem__(self, _key):
        raise RuntimeError("unreadable variable")


class _BadSliceNames:
    """Name table that converts to an array but cannot be sliced."""

    def __array__(self, dtype=None, copy=None):
        return np.array([b"first"])

    def __getitem__(self, _key):
        raise RuntimeError("unreadable names")


class _UnconvertibleNames:
    """Name table that fails even numpy conversion."""

    def __array__(self, dtype=None, copy=None):
        raise RuntimeError("not array-like")


def test_read_names_short_table_and_padding():
    assert exodus_series._read_names(np.array([b"fuel", b"clad"]), 5) == ["fuel", "clad"]


def test_read_names_decodes_char_and_string_rows():
    chars = np.array([[b"h", b"e", b"a", b"t", b"\x00"]])
    strings = np.array([["c", "l", "a", "d", "\x00"]])

    assert exodus_series._read_names(chars, 1) == ["heat"]
    assert exodus_series._read_names(strings, 1) == ["clad"]


def test_read_names_drops_blank_rows():
    raw = np.array([[b"", b"\x00"], [b"x", b"\x00"]])
    assert exodus_series._read_names(raw, 2) == ["x"]


# ---------------------------------------------------------------------------
# Node coordinates
# ---------------------------------------------------------------------------


def test_read_nodes_accepts_two_component_coord():
    nodes = exodus_series._read_nodes({"coord": np.array([[0.0, 1.0], [2.0, 3.0], [4.0, 5.0]])}, 3)

    assert nodes.tolist() == [[0.0, 1.0, 0.0], [2.0, 3.0, 0.0], [4.0, 5.0, 0.0]]


def test_read_nodes_reports_coord_read_failure():
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not read node coordinates"):
        exodus_series._read_nodes({"coord": _RaisingVar()}, 3)


def test_read_nodes_falls_back_to_axes_and_pads_missing_z():
    nodes = exodus_series._read_nodes(
        {"coordx": np.array([1.0, 2.0, 3.0]), "coordy": np.array([4.0, 5.0, 6.0])}, 3
    )

    assert nodes.tolist() == [[1.0, 4.0, 0.0], [2.0, 5.0, 0.0], [3.0, 6.0, 0.0]]


def test_read_nodes_reports_axis_read_failure():
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not read node coordinates"):
        exodus_series._read_nodes({"coordx": np.zeros(3), "coordy": _RaisingVar()}, 3)


def test_read_nodes_rejects_length_mismatch():
    with pytest.raises(exodus_series.ExodusSeriesError, match="does not match num_nodes"):
        exodus_series._read_nodes({"coordx": np.array([1.0, 2.0])}, 3)


def test_pad_to_xyz_handles_one_dimensional_input():
    assert exodus_series._pad_to_xyz(np.array([1.0, 2.0])).tolist() == [
        [1.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
    ]
    assert exodus_series._pad_to_xyz(np.zeros((2, 0))).tolist() == [
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
    ]


# ---------------------------------------------------------------------------
# Block labels and counts
# ---------------------------------------------------------------------------


class _RaisingDim:
    def __len__(self):
        raise RuntimeError("bad dimension")


class _Dim:
    def __init__(self, size):
        self._size = size

    def __len__(self):
        return self._size


def test_read_blocks_tolerates_bad_block_count():
    blocks = exodus_series._read_blocks({"num_el_in_blk1": _RaisingDim()}, {})

    assert blocks == [{"name": "block_1", "count": 0}]


def test_read_blocks_uses_eb_names_labels():
    blocks = exodus_series._read_blocks(
        {"num_el_in_blk1": _Dim(2)},
        {"eb_names": np.array([b"fuel"])},
    )

    assert blocks == [{"name": "fuel", "count": 2}]


def test_read_blocks_ignores_unreadable_eb_names():
    blocks = exodus_series._read_blocks(
        {"num_el_in_blk1": _Dim(1)},
        {"eb_names": _RaisingVar()},
    )

    assert blocks == [{"name": "block_1", "count": 1}]


def test_read_blocks_falls_back_to_flat_element_count():
    blocks = exodus_series._read_blocks({"num_elem": _Dim(12)}, {})

    assert blocks == [{"name": "block_1", "count": 12}]


def test_read_blocks_returns_empty_when_flat_count_is_bad():
    assert exodus_series._read_blocks({"num_elem": _RaisingDim()}, {}) == []


# ---------------------------------------------------------------------------
# Variable collection
# ---------------------------------------------------------------------------


def test_collect_indexed_vars_without_name_table():
    variables = {
        "vals_nod_var1": np.array([[1.0, 2.0], [3.0, 4.0]]),
        "vals_nod_var2": np.array([5.0, 6.0]),
    }

    collected = exodus_series._collect_indexed_vars(
        variables, "num_nod_var", "name_nod_var", "vals_nod_var"
    )

    assert [name for name, _series in collected] == ["vals_nod_var1", "vals_nod_var2"]


def test_collect_indexed_vars_tolerates_unconvertible_names():
    variables = {"name_nod_var": _UnconvertibleNames(), "vals_nod_var1": np.array([1.0])}

    collected = exodus_series._collect_indexed_vars(
        variables, "num_nod_var", "name_nod_var", "vals_nod_var"
    )

    assert [name for name, _series in collected] == ["vals_nod_var1"]


def test_collect_indexed_vars_reports_name_read_failure():
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not read variable names"):
        exodus_series._collect_indexed_vars(
            {"name_nod_var": _BadSliceNames(), "vals_nod_var1": np.array([1.0])},
            "num_nod_var",
            "name_nod_var",
            "vals_nod_var",
        )


def test_collect_indexed_vars_skips_missing_value_series():
    variables = {
        "name_nod_var": np.array([b"temperature", b"density"]),
        "vals_nod_var1": np.array([300.0, 310.0]),
    }

    collected = exodus_series._collect_indexed_vars(
        variables, "num_nod_var", "name_nod_var", "vals_nod_var"
    )

    assert [name for name, _series in collected] == ["temperature"]


def test_collect_element_vars_reports_name_read_failure():
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not read variable names"):
        exodus_series._collect_element_vars({"name_elem_var": _BadSliceNames()}, {})


def test_collect_element_vars_uses_first_per_block_variant():
    variables = {
        "name_elem_var": np.array([b"stress"]),
        "vals_elem_var1eb3": np.array([1.0, 2.0]),
        "vals_elem_var1eb7": np.array([3.0, 4.0]),
    }

    collected = exodus_series._collect_element_vars(variables, {})

    assert len(collected) == 1
    assert collected[0][0] == "stress"
    assert collected[0][1].tolist() == [1.0, 2.0]


def test_collect_element_vars_skips_variable_without_any_data():
    collected = exodus_series._collect_element_vars({"name_elem_var": np.array([b"stress"])}, {})
    assert collected == []


def test_collect_element_vars_last_resort_synthetic_names():
    collected = exodus_series._collect_element_vars({"vals_elem_var7": np.array([9.0, 10.0])}, {})

    assert [name for name, _series in collected] == ["vals_elem_var7"]


def test_as_series_reports_read_failure():
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not read variable values"):
        exodus_series._as_series(_RaisingVar())


# ---------------------------------------------------------------------------
# Row selection and global ranges
# ---------------------------------------------------------------------------


def test_row_handles_scalars_empty_and_short_series():
    assert exodus_series._row(np.float64(3.0), 0).tolist() == [3.0]
    assert exodus_series._row(np.array([]), 0).tolist() == []
    assert exodus_series._row(np.zeros((1, 3)), 2).tolist() == []
    assert exodus_series._row(np.array([1.0, 2.0]), 1).tolist() == [2.0]


def test_global_range_returns_zero_for_absent_array():
    steps = [{"values": {"other": {"min": 1.0, "max": 2.0}}}, {"values": {}}]

    assert exodus_series._global_range(steps, "flux") == [0.0, 0.0]


# ---------------------------------------------------------------------------
# netCDF4 extraction fallbacks
# ---------------------------------------------------------------------------


class _FakeDataset:
    def __init__(self, dimensions, variables, close_error=False):
        self.dimensions = dimensions
        self.variables = variables
        self._close_error = close_error
        self.closed = False

    def close(self):
        self.closed = True
        if self._close_error:
            raise RuntimeError("close failed")


def _install_netcdf4(monkeypatch, dataset):
    module = ModuleType("netCDF4")
    module.Dataset = lambda _path, _mode="r": dataset
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", True)
    monkeypatch.setattr(exodus_series, "_load_netcdf4", lambda: module)
    return module


def _coords(n=3):
    return {
        "coordx": np.arange(n, dtype=float),
        "coordy": np.zeros(n),
        "coordz": np.zeros(n),
    }


def _dim(size):
    return _Dim(size)


def test_netcdf4_derives_step_count_from_time_whole(monkeypatch):
    variables = {"time_whole": np.array([10.0, 20.0]), **_coords()}
    dataset = _FakeDataset({"num_nodes": _dim(3)}, variables)
    _install_netcdf4(monkeypatch, dataset)

    payload = exodus_series._extract_via_netcdf4("series.e", None, 5000)

    assert payload["nSteps"] == 2
    assert [step["time"] for step in payload["steps"]] == [10.0, 20.0]


def test_netcdf4_falls_back_when_time_read_fails(monkeypatch):
    variables = {"time_whole": _RaisingVar(), **_coords()}
    dataset = _FakeDataset({"num_nodes": _dim(3)}, variables)
    _install_netcdf4(monkeypatch, dataset)

    payload = exodus_series._extract_via_netcdf4("series.e", None, 5000)

    assert payload["nSteps"] == 1
    assert payload["steps"][0]["time"] == 0.0


def test_netcdf4_falls_back_when_time_length_mismatches(monkeypatch):
    variables = {"time_whole": np.array([1.0, 2.0, 3.0]), **_coords()}
    dataset = _FakeDataset({"time_step": _dim(2), "num_nodes": _dim(3)}, variables)
    _install_netcdf4(monkeypatch, dataset)

    payload = exodus_series._extract_via_netcdf4("series.e", None, 5000)

    assert [step["time"] for step in payload["steps"]] == [0.0, 1.0]


def test_netcdf4_requires_nodes(monkeypatch):
    dataset = _FakeDataset({"time_step": _dim(1)}, {"time_whole": np.array([0.0])})
    _install_netcdf4(monkeypatch, dataset)

    with pytest.raises(exodus_series.ExodusSeriesError, match="has no nodes"):
        exodus_series._extract_via_netcdf4("series.e", None, 5000)


def test_netcdf4_swallows_close_failure(monkeypatch):
    variables = {"time_whole": np.array([0.0]), **_coords()}
    dataset = _FakeDataset(
        {"time_step": _dim(1), "num_nodes": _dim(3)}, variables, close_error=True
    )
    _install_netcdf4(monkeypatch, dataset)

    payload = exodus_series._extract_via_netcdf4("series.e", None, 5000)

    assert payload["nSteps"] == 1
    assert dataset.closed is True
