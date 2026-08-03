"""Tests for read_mgxs_data_names.py."""

import json
from pathlib import Path

import pytest

h5py = pytest.importorskip("h5py")

import read_mgxs_data_names as reader


def test_read_mapping_returns_top_level_groups(tmp_path: Path):
    """The mapping contains one entry per top-level HDF5 group."""
    mgxs_path = tmp_path / "mgxs.h5"
    with h5py.File(mgxs_path, "w") as f:
        f.create_group("mat_0")
        f.create_group("mat_1")

    success, mapping, error = reader.read_mapping(str(mgxs_path))

    assert success is True
    assert error is None
    assert mapping == [
        {"materialName": "mat_0", "xsDataName": "mat_0"},
        {"materialName": "mat_1", "xsDataName": "mat_1"},
    ]


def test_read_mapping_missing_file(tmp_path: Path):
    """A missing library returns a clear error."""
    success, mapping, error = reader.read_mapping(str(tmp_path / "missing.h5"))

    assert success is False
    assert mapping is None
    assert "not found" in error


def test_main_prints_json(capsys, tmp_path: Path):
    """The CLI entry point prints a JSON result object."""
    mgxs_path = tmp_path / "mgxs.h5"
    with h5py.File(mgxs_path, "w") as f:
        f.create_group("fuel")

    import sys

    orig_argv = sys.argv
    try:
        sys.argv = ["read_mgxs_data_names.py", str(mgxs_path)]
        reader.main()
    finally:
        sys.argv = orig_argv

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result["success"] is True
    assert result["xsDataNames"] == [{"materialName": "fuel", "xsDataName": "fuel"}]
