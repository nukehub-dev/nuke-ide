# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Tests for the headless Exodus-II series extractor (P5).

``plugins.base.lib.exodus_series`` reads transient ``.e`` files via
``netCDF4`` (preferred) or ``meshio`` (single-step fallback) and emits the
series JSON consumed by the native time-slider viewer. These tests need only
pytest + numpy: both reader backends are faked with ``sys.modules`` stubs,
and dependency-absence guards force the absence via the module-level
``HAS_*`` flags so they pass in both dependency profiles. The
``base.exodus-series`` command handler reports errors as JSON on stderr with
exit code 1 (base-plugin contract).
"""

import argparse
import json
import sys
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.base.commands import exodus as exodus_cmds  # noqa: E402
from plugins.base.lib import exodus_series  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error(capsys):
    """Extract and JSON-decode the single {"error": ...} stderr line."""
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f"expected JSON error on stderr, got: {err!r}"
    return json.loads(err)["error"]


class _Dim:
    """Minimal netCDF dimension stub (only len() is used)."""

    def __init__(self, size):
        self._size = size

    def __len__(self):
        return self._size


class _FakeDataset:
    """Canned 3-step Exodus layout: 4 nodes, 1 block of 2 elements."""

    def __init__(self, path, mode="r"):
        self.dimensions = {
            "time_step": _Dim(3),
            "num_nodes": _Dim(4),
            "num_nod_var": _Dim(1),
            "num_elem": _Dim(2),
            "num_el_in_blk1": _Dim(2),
            "num_glo_var": _Dim(1),
        }
        self.variables = {
            "time_whole": np.array([0.0, 1.0, 2.0]),
            "coordx": np.array([0.0, 1.0, 0.0, 1.0]),
            "coordy": np.array([0.0, 0.0, 1.0, 1.0]),
            "coordz": np.array([0.0, 0.0, 0.0, 0.0]),
            "name_nod_var": np.array([b"temperature"]),
            "vals_nod_var1": np.array(
                [
                    [300.0, 300.0, 300.0, 300.0],
                    [400.0, 410.0, 420.0, 430.0],
                    [800.0, 850.0, 900.0, 880.0],
                ]
            ),
            "name_elem_var": np.array([b"stress"]),
            "vals_elem_var1": np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]),
            "name_glo_var": np.array([b"keff"]),
            "vals_glo_var1": np.array([1.0, 1.001, 0.999]),
        }
        self.closed = False

    def close(self):
        self.closed = True


def _install_fake_netcdf4(monkeypatch):
    """Force netCDF4 presence with a canned-Dataset stub module."""
    module = ModuleType("netCDF4")
    module.Dataset = _FakeDataset
    monkeypatch.setitem(sys.modules, "netCDF4", module)
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", True)
    return module


def _install_fake_meshio(monkeypatch):
    """Force the meshio fallback with a single-quad stub mesh."""
    module = ModuleType("meshio")

    class _Cells:
        def __init__(self, cell_type, data):
            self.type = cell_type
            self.data = data

    class _Mesh:
        points = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]])
        cells = [_Cells("quad", np.array([[0, 1, 2]]))]
        point_data = {"temperature": np.array([300.0, 310.0, 320.0])}
        cell_data = {"stress": [np.array([5.0])]}

    module.read = lambda path: _Mesh()
    monkeypatch.setitem(sys.modules, "meshio", module)
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", False)
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", True)
    return module


def _write_series_file(tmp_path, suffix=".e"):
    path = tmp_path / f"series{suffix}"
    path.write_bytes(b"fake-exodus")
    return str(path)


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["", None, 0, 123, True])
def test_require_series_path_rejects_non_strings(bad):
    with pytest.raises(exodus_series.ExodusSeriesError, match="non-empty string"):
        exodus_series._require_series_path(bad)


def test_require_series_path_missing(tmp_path):
    with pytest.raises(exodus_series.ExodusSeriesError, match="not found"):
        exodus_series._require_series_path(str(tmp_path / "nope.e"))


def test_require_series_path_rejects_suffix(tmp_path):
    other = tmp_path / "model.h5m"
    other.write_bytes(b"fake")
    with pytest.raises(exodus_series.ExodusSeriesError, match="suffix"):
        exodus_series._require_series_path(str(other))


@pytest.mark.parametrize("bad", [0, -2, True, "3", 2.5])
def test_require_max_steps_rejects(bad):
    with pytest.raises(exodus_series.ExodusSeriesError, match="max_steps"):
        exodus_series._require_max_steps(bad)


def test_require_max_steps_accepts():
    assert exodus_series._require_max_steps(None) is None
    assert exodus_series._require_max_steps(4) == 4


@pytest.mark.parametrize("bad", [0, -1, True, "8", 2.5, None])
def test_require_max_points_rejects(bad):
    with pytest.raises(exodus_series.ExodusSeriesError, match="max_points"):
        exodus_series._require_max_points(bad)


# ---------------------------------------------------------------------------
# Pure math helpers (numpy only)
# ---------------------------------------------------------------------------


def test_decimate_indices_keeps_endpoints():
    idx = exodus_series.decimate_indices(101, 11)
    assert len(idx) <= 11
    assert idx[0] == 0
    assert idx[-1] == 100
    assert len(set(idx.tolist())) == len(idx)


def test_decimate_indices_passthrough():
    assert exodus_series.decimate_indices(5, 10).tolist() == [0, 1, 2, 3, 4]
    assert exodus_series.decimate_indices(0, 10).size == 0


def test_summarize_values_stats_and_samples():
    summary = exodus_series.summarize_values(np.array([1.0, 2.0, 3.0, 4.0]), max_samples=2)
    assert summary["min"] == 1.0
    assert summary["max"] == 4.0
    assert summary["mean"] == pytest.approx(2.5)
    assert summary["count"] == 4
    assert summary["samples"] == [1.0, 4.0]


def test_summarize_values_skips_non_finite():
    summary = exodus_series.summarize_values(np.array([np.nan, 2.0, np.inf]))
    assert summary["count"] == 1
    assert summary["min"] == 2.0
    empty = exodus_series.summarize_values(np.array([np.nan]))
    assert empty["count"] == 0
    assert empty["samples"] == []


# ---------------------------------------------------------------------------
# Backend guards
# ---------------------------------------------------------------------------


def test_extract_requires_a_backend(tmp_path, monkeypatch):
    path = _write_series_file(tmp_path)
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", False)
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", False)
    with pytest.raises(exodus_series.ExodusSeriesError, match="netCDF4.*meshio"):
        exodus_series.extract_exodus_series(path)


def test_extract_validates_before_backend(tmp_path, monkeypatch):
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", False)
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", False)
    with pytest.raises(exodus_series.ExodusSeriesError, match="not found"):
        exodus_series.extract_exodus_series(str(tmp_path / "nope.e"))


# ---------------------------------------------------------------------------
# netCDF4 path (faked)
# ---------------------------------------------------------------------------


def test_extract_netcdf4_series_shape(tmp_path, monkeypatch):
    _install_fake_netcdf4(monkeypatch)
    result = exodus_series.extract_exodus_series(_write_series_file(tmp_path))
    assert result["nSteps"] == 3
    assert [step["time"] for step in result["steps"]] == [0.0, 1.0, 2.0]
    assert [step["index"] for step in result["steps"]] == [0, 1, 2]
    by_name = {entry["name"]: entry for entry in result["arrays"]}
    assert by_name["temperature"]["location"] == "node"
    assert by_name["temperature"]["range"] == [300.0, 900.0]
    assert by_name["stress"]["location"] == "cell"
    assert by_name["stress"]["range"] == [1.0, 6.0]
    assert by_name["keff"]["location"] == "global"
    first = result["steps"][0]
    assert first["mesh"]["nNodes"] == 4
    assert first["mesh"]["nElements"] == 2
    assert first["mesh"]["blocks"] == [{"name": "block_1", "count": 2}]
    assert first["values"]["temperature"]["mean"] == pytest.approx(300.0)
    assert result["steps"][2]["values"]["temperature"]["max"] == pytest.approx(900.0)


def test_extract_netcdf4_decimation_and_step_cap(tmp_path, monkeypatch):
    _install_fake_netcdf4(monkeypatch)
    result = exodus_series.extract_exodus_series(
        _write_series_file(tmp_path), max_steps=2, max_points=2
    )
    assert result["nSteps"] == 2
    for step in result["steps"]:
        assert len(step["mesh"]["nodes"]) == 2
        assert step["mesh"]["nodes"][0][0] == pytest.approx(0.0)
        assert step["mesh"]["nodes"][-1][0] == pytest.approx(1.0)
        assert len(step["values"]["temperature"]["samples"]) <= exodus_series.DEFAULT_MAX_SAMPLES


def test_extract_netcdf4_open_failure(tmp_path, monkeypatch):
    module = ModuleType("netCDF4")

    def _boom(path, mode="r"):
        raise OSError("not a netcdf file")

    module.Dataset = _boom
    monkeypatch.setitem(sys.modules, "netCDF4", module)
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", True)
    with pytest.raises(exodus_series.ExodusSeriesError, match="Could not open"):
        exodus_series.extract_exodus_series(_write_series_file(tmp_path))


def test_extract_result_is_json_safe(tmp_path, monkeypatch):
    _install_fake_netcdf4(monkeypatch)
    result = exodus_series.extract_exodus_series(_write_series_file(tmp_path))
    assert json.loads(json.dumps(result, default=exodus_series.json_default))["nSteps"] == 3


# ---------------------------------------------------------------------------
# meshio fallback (faked)
# ---------------------------------------------------------------------------


def test_extract_meshio_single_step(tmp_path, monkeypatch):
    _install_fake_meshio(monkeypatch)
    result = exodus_series.extract_exodus_series(_write_series_file(tmp_path))
    assert result["nSteps"] == 1
    (step,) = result["steps"]
    assert step["time"] == 0.0
    assert step["mesh"]["nNodes"] == 3
    assert step["mesh"]["nElements"] == 1
    by_name = {entry["name"]: entry for entry in result["arrays"]}
    assert by_name["temperature"]["location"] == "node"
    assert by_name["stress"]["location"] == "cell"


# ---------------------------------------------------------------------------
# base.exodus-series command (stderr JSON contract)
# ---------------------------------------------------------------------------


def test_command_missing_file(capsys):
    args = _parse(exodus_cmds.cmd_exodus_series, ["--file", "/no/such/series.e"])
    assert exodus_cmds.cmd_exodus_series(args) == 1
    assert _stderr_error(capsys)


def test_command_missing_backend(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(exodus_series, "HAS_NETCDF4", False)
    monkeypatch.setattr(exodus_series, "HAS_MESHIO", False)
    args = _parse(exodus_cmds.cmd_exodus_series, ["--file", _write_series_file(tmp_path)])
    assert exodus_cmds.cmd_exodus_series(args) == 1
    assert "netCDF4" in _stderr_error(capsys)


def test_command_success_stdout_json(tmp_path, monkeypatch, capsys):
    _install_fake_netcdf4(monkeypatch)
    args = _parse(exodus_cmds.cmd_exodus_series, ["--file", _write_series_file(tmp_path)])
    assert exodus_cmds.cmd_exodus_series(args) == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["nSteps"] == 3
    assert payload["steps"][0]["mesh"]["nNodes"] == 4
    assert "error" not in payload
