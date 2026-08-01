"""Tests for plugins.openmc.commands.nuclear_data (nuclear data inspector).

openmc.data and h5py are replaced with recording fakes so the library summary
and nuclide detail paths run without OpenMC installed (heavy imports are lazy
inside the functions, so patching sys.modules works). Command-level tests
check the JSON-on-stdout / exit-code contract.
"""

import argparse
import json
import sys
import types
from types import SimpleNamespace

import pytest
from nuke_viz.plugin import setup_parser_for_handler
from plugins.openmc.commands import nuclear_data


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
# Fake h5py
# ---------------------------------------------------------------------------


class FakeH5File(dict):
    """Dict-backed stand-in for an open h5py.File (context manager)."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_fake_h5py(monkeypatch, per_file):
    """Install a fake h5py module; per_file maps path -> nuclide-group dict."""
    fake_h5py = types.ModuleType("h5py")

    def fake_file(path, mode):
        assert mode == "r"
        if str(path) not in per_file:
            raise OSError(f"no such file: {path}")
        return FakeH5File({"Nu": per_file[str(path)]})

    fake_h5py.File = fake_file
    monkeypatch.setitem(sys.modules, "h5py", fake_h5py)
    return fake_h5py


def test_cheap_metadata_reads_group_keys(monkeypatch):
    _install_fake_h5py(
        monkeypatch,
        {
            "/data/U235.h5": {
                "kTs": {"294K": {}, "600K": {}},
                "reactions": {"r1": {}, "r2": {}, "r3": {}},
            }
        },
    )
    temps, count = nuclear_data._cheap_file_metadata("/data/U235.h5")
    assert temps == ["294K", "600K"]
    assert count == 3


def test_cheap_metadata_tolerates_missing_groups(monkeypatch):
    _install_fake_h5py(monkeypatch, {"/data/C12.h5": {}})
    temps, count = nuclear_data._cheap_file_metadata("/data/C12.h5")
    assert temps == [] and count == 0


# ---------------------------------------------------------------------------
# Fake openmc / openmc.data
# ---------------------------------------------------------------------------


def _install_fake_openmc_data(monkeypatch, library_entries=(), config_path=None):
    fake_openmc = types.ModuleType("openmc")
    fake_data = types.ModuleType("openmc.data")
    fake_data.DataLibrary = SimpleNamespace(
        from_xml=lambda path: SimpleNamespace(libraries=list(library_entries))
    )
    fake_data.REACTION_NAME = {2: "(n,elastic)", 18: "(n,fission)", 102: "(n,gamma)"}
    fake_openmc.data = fake_data
    fake_openmc.config = {"cross_sections": config_path}
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.data", fake_data)
    return fake_data


# ---------------------------------------------------------------------------
# read_data_library
# ---------------------------------------------------------------------------


def test_library_summary(monkeypatch, tmp_path):
    xs = tmp_path / "cross_sections.xml"
    xs.write_text("<cross_sections/>")
    (tmp_path / "U235.h5").write_bytes(b"fake")
    (tmp_path / "U238.h5").write_bytes(b"fake")
    entries = [
        {"path": str(tmp_path / "U235.h5"), "type": "neutron", "materials": ["U235"]},
        {"path": str(tmp_path / "U238.h5"), "type": "neutron", "materials": ["U238"]},
        {"path": str(tmp_path / "chain.xml"), "type": "depletion_chain", "materials": []},
    ]
    _install_fake_openmc_data(monkeypatch, entries)
    _install_fake_h5py(
        monkeypatch,
        {
            str(tmp_path / "U235.h5"): {"kTs": {"294K": {}}, "reactions": {"a": {}, "b": {}}},
            str(tmp_path / "U238.h5"): {"kTs": {}, "reactions": {"a": {}}},
        },
    )

    result = nuclear_data.read_data_library(str(xs))

    assert result["success"] is True
    assert result["nuclideCount"] == 2
    assert result["libraryPath"] == str(xs)
    by_name = {n["name"]: n for n in result["nuclides"]}
    assert by_name["U235"]["temperatureCount"] == 1
    assert by_name["U235"]["reactionCount"] == 2
    assert by_name["U238"]["reactionCount"] == 1


def test_library_resolves_config_path(monkeypatch, tmp_path):
    xs = tmp_path / "cross_sections.xml"
    xs.write_text("<cross_sections/>")
    _install_fake_openmc_data(monkeypatch, [], config_path=str(xs))
    result = nuclear_data.read_data_library(None)
    assert result["success"] is True and result["nuclideCount"] == 0


def test_library_missing_path_and_file(monkeypatch, tmp_path):
    _install_fake_openmc_data(monkeypatch, [], config_path=None)
    with pytest.raises(ValueError, match="openmc.config"):
        nuclear_data.read_data_library(None)
    with pytest.raises(FileNotFoundError, match="not found"):
        nuclear_data.read_data_library(str(tmp_path / "nope.xml"))


# ---------------------------------------------------------------------------
# read_nuclide_detail
# ---------------------------------------------------------------------------


def test_nuclide_detail(monkeypatch, tmp_path):
    h5 = tmp_path / "U235.h5"
    h5.write_bytes(b"fake")
    fake_data = _install_fake_openmc_data(monkeypatch)
    fake_data.IncidentNeutron = SimpleNamespace(
        from_hdf5=lambda path: SimpleNamespace(
            name="U235",
            temperatures=["294K"],
            reactions={18: object(), 2: object(), 102: object()},
            fission_energy=SimpleNamespace(),
        )
    )

    result = nuclear_data.read_nuclide_detail(str(h5))

    assert result["success"] is True
    assert result["name"] == "U235"
    assert result["fission"] is True
    assert result["reactionCount"] == 3
    assert result["reactions"] == [
        {"mt": 2, "label": "(n,elastic)"},
        {"mt": 18, "label": "(n,fission)"},
        {"mt": 102, "label": "(n,gamma)"},
    ]


def test_nuclide_missing_file(monkeypatch, tmp_path):
    with pytest.raises(FileNotFoundError, match="not found"):
        nuclear_data.read_nuclide_detail(str(tmp_path / "nope.h5"))


# ---------------------------------------------------------------------------
# Command contract (single JSON on stdout, exit code)
# ---------------------------------------------------------------------------


def test_library_command_success_and_error_json(monkeypatch, tmp_path, capsys):
    xs = tmp_path / "cross_sections.xml"
    xs.write_text("<cross_sections/>")
    _install_fake_openmc_data(monkeypatch, [], config_path=str(xs))

    args = _parse(nuclear_data.cmd_nuclear_data_library, [])
    assert nuclear_data.cmd_nuclear_data_library(args) == 0
    payload = _stdout_json(capsys)
    assert payload["success"] is True

    args = _parse(
        nuclear_data.cmd_nuclear_data_library, ["--cross-sections", str(tmp_path / "nope.xml")]
    )
    assert nuclear_data.cmd_nuclear_data_library(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False
    assert "not found" in payload["error"]


def test_nuclide_command_success_and_error_json(monkeypatch, tmp_path, capsys):
    h5 = tmp_path / "U235.h5"
    h5.write_bytes(b"fake")
    fake_data = _install_fake_openmc_data(monkeypatch)
    fake_data.IncidentNeutron = SimpleNamespace(
        from_hdf5=lambda path: SimpleNamespace(
            name="U235", temperatures=["294K"], reactions={18: object()}, fission_energy=None
        )
    )

    args = _parse(nuclear_data.cmd_nuclear_data_nuclide, [str(h5)])
    assert nuclear_data.cmd_nuclear_data_nuclide(args) == 0
    payload = _stdout_json(capsys)
    assert payload["success"] is True
    assert payload["fission"] is True  # MT 18 marks fission even without fission_energy

    args = _parse(nuclear_data.cmd_nuclear_data_nuclide, [str(tmp_path / "nope.h5")])
    assert nuclear_data.cmd_nuclear_data_nuclide(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False
    assert "not found" in payload["error"]


# ---------------------------------------------------------------------------
# Integration: real API surface (skipped when openmc/h5py are absent)
# ---------------------------------------------------------------------------


def test_data_api_surface_matches_assumptions():
    pytest.importorskip("openmc")
    import inspect

    import openmc.data

    assert inspect.signature(openmc.data.DataLibrary.from_xml).parameters.get("path") is not None
    assert hasattr(openmc.data, "IncidentNeutron")
    assert hasattr(openmc.data.IncidentNeutron, "from_hdf5")
    assert 18 in openmc.data.REACTION_NAME
    assert isinstance(openmc.config.get("cross_sections"), (type(None), __import__("pathlib").Path))
