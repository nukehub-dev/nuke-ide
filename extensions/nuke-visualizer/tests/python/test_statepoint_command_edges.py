# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Edge-case tests for the statepoint viewer commands.

``test_openmc_commands_statepoint.py`` covers the main reader paths. This
module targets the layouts that only appear in older or hand-written
statepoints: scalar score datasets, score/nuclide tables mixing bytes and
strings, attribute-based scores, group-style tally filters, non-mesh entries
under ``tallies/meshes``, runtime datasets that fail to read, and the
version-attribute variants. The ``HAS_H5PY`` guards are forced off so the
dependency-missing contract is tested in every environment.
"""

import argparse
import importlib
import json
import sys
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import statepoint as statepoint_cmds  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


# ---------------------------------------------------------------------------
# Fake h5py framework
# ---------------------------------------------------------------------------


class _FakeDataset:
    def __init__(self, data, attrs=None):
        self._data = data
        self.attrs = attrs or {}

    def __getitem__(self, key):
        if key is Ellipsis or key == ():
            return self._data
        return self._data[key]

    def __len__(self):
        return len(self._data)


class _RaisingDataset(_FakeDataset):
    def __getitem__(self, _key):
        raise RuntimeError("dataset read failed")


class _FakeGroup:
    def __init__(self, children=None, attrs=None):
        self._children = dict(children or {})
        self.attrs = dict(attrs or {})

    def __contains__(self, key):
        return key in self._children

    def __getitem__(self, key):
        return self._children[key]

    def keys(self):
        return self._children.keys()


class _FakeFile(_FakeGroup):
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


@pytest.fixture
def fake_h5py(monkeypatch):
    holder = {"file": _FakeFile({})}
    module = ModuleType("h5py")
    module.Dataset = _FakeDataset
    module.Group = _FakeGroup
    module.File = lambda _path, _mode="r": holder["file"]
    monkeypatch.setattr(statepoint_cmds, "h5py", module, raising=False)
    monkeypatch.setattr(statepoint_cmds, "np", np, raising=False)
    monkeypatch.setattr(statepoint_cmds, "HAS_H5PY", True)
    return holder


# ---------------------------------------------------------------------------
# Module import and version attribute variants
# ---------------------------------------------------------------------------


def test_statepoint_module_import_without_h5py(monkeypatch, capsys):
    try:
        with monkeypatch.context() as context:
            context.setitem(sys.modules, "h5py", None)
            module = importlib.reload(statepoint_cmds)
            assert module.HAS_H5PY is False

            args = _parse(module.cmd_statepoint_info, ["sp.h5"])
            assert module.cmd_statepoint_info(args) == 1
            assert _stdout_json(capsys) == {"error": "h5py not installed"}
    finally:
        importlib.reload(statepoint_cmds)


def test_statepoint_info_decodes_bytes_openmc_version(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({}, attrs={"openmc_version": b"0.15.1"})

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    assert _stdout_json(capsys)["version"] == "0.15.1"


def test_statepoint_info_joins_array_version_fallback(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({}, attrs={"version": np.array([0, 14, 0])})

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    assert _stdout_json(capsys)["version"] == "0.14.0"


# ---------------------------------------------------------------------------
# Runtime and tally table variants
# ---------------------------------------------------------------------------


def test_statepoint_info_skips_unreadable_runtime_dataset(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile(
        {
            "runtime": _FakeGroup(
                {
                    "total": _RaisingDataset(np.float64(1.0)),
                    "total_time": _FakeDataset(np.float64(5.0)),
                }
            )
        }
    )

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    assert _stdout_json(capsys)["runtime"]["total"] == pytest.approx(5.0)


def test_statepoint_info_mixed_score_and_nuclide_tables(fake_h5py, capsys):
    mesh = _FakeGroup(
        {
            "dimension": _FakeDataset(np.array([2, 1, 1])),
            "lower_left": _FakeDataset(np.array([0.0, 0.0, 0.0])),
            "upper_right": _FakeDataset(np.array([2.0, 1.0, 1.0])),
        }
    )
    mesh_filter = _FakeGroup(
        {
            "type": _FakeDataset(b"mesh"),
            "n_bins": _FakeDataset(2),
            "bins": _FakeDataset(np.array([7])),
        }
    )
    grouped_tally = _FakeGroup(
        {
            "score_bins": _FakeDataset(np.array([b"flux", "heating", 7], dtype=object)),
            "nuclides": _FakeDataset(np.array([b"total", "U235", 7], dtype=object)),
            "filters": _FakeGroup({"filter 1": mesh_filter}),
        }
    )
    scalar_score_tally = _FakeGroup({"score": _FakeDataset(b"flux")})
    attr_score_tally = _FakeGroup({}, attrs={"score": b"flux heating", "nuclides": "total U235"})
    tallies = _FakeGroup(
        {
            "tally 1": grouped_tally,
            "tally 2": scalar_score_tally,
            "tally 3": attr_score_tally,
            "filters": _FakeGroup({"filter 1": mesh_filter}),
            "meshes": _FakeGroup({"mesh 7": mesh, "not a mesh": _FakeGroup()}),
        }
    )
    fake_h5py["file"] = _FakeFile({"tallies": tallies})

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    result = _stdout_json(capsys)
    assert result["tallies"][0]["scores"] == ["flux", "heating", "7"]
    assert result["tallies"][0]["nuclides"] == ["total", "U235", "7"]
    assert result["tallies"][0]["hasMesh"] is True
    assert result["tallies"][0]["filters"][0]["type"] == "mesh"
    assert result["tallies"][1]["scores"] == ["flux"]
    assert result["tallies"][2]["scores"] == ["flux", "heating"]
    assert result["tallies"][2]["nuclides"] == ["total", "U235"]
    assert [mesh["id"] for mesh in result["meshes"]] == [7]


# ---------------------------------------------------------------------------
# Forced h5py absence for every statepoint command
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("handler", "argv"),
    [
        (statepoint_cmds.cmd_k_generation, ["sp.h5"]),
        (statepoint_cmds.cmd_source_data, ["sp.h5"]),
        (statepoint_cmds.cmd_energy_distribution, ["sp.h5"]),
    ],
)
def test_statepoint_commands_require_h5py(monkeypatch, capsys, handler, argv):
    monkeypatch.setattr(statepoint_cmds, "HAS_H5PY", False)
    args = _parse(handler, argv)

    assert handler(args) == 1
    assert _stdout_json(capsys) == {"error": "h5py not installed"}
