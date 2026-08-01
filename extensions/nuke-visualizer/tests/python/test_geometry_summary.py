"""Tests for summary.h5 → XML conversion (geometry_parser.convert_summary_to_xml)
and the openmc.geometry / openmc.visualize-geometry commands' .h5 handling.

openmc itself is faked via sys.modules entries — the conversion's heavy import
is lazy, so no real OpenMC install is needed.
"""

import argparse
import json
import sys
import types
from types import SimpleNamespace

import pytest
from nuke_viz.plugin import setup_parser_for_handler
from plugins.openmc.commands import geometry as geometry_cmds
from plugins.openmc.lib.geometry_parser import convert_summary_to_xml

BASIC_GEOMETRY_XML = """<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 10" boundary="vacuum"/>
  <cell id="1" name="fuel" material="1" region="-1" universe="0"/>
</geometry>
"""

MATERIALS_XML = """<?xml version="1.0"?>
<materials>
  <material id="1" name="UO2"/>
</materials>
"""


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


def _install_fake_openmc(monkeypatch):
    """Fake openmc.Summary: writes real minimal XML on export."""
    fake_openmc = types.ModuleType("openmc")

    class FakeGeometry:
        def export_to_xml(self, path):
            with open(path, "w") as f:
                f.write(BASIC_GEOMETRY_XML)

    class FakeMaterials(list):
        def export_to_xml(self, path):
            with open(path, "w") as f:
                f.write(MATERIALS_XML)

    fake_openmc.Summary = lambda path: SimpleNamespace(
        geometry=FakeGeometry(), materials=FakeMaterials([1])
    )
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    return fake_openmc


def test_convert_summary_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError, match="File not found"):
        convert_summary_to_xml(str(tmp_path / "nope.h5"), str(tmp_path / "out"))


def test_convert_summary_missing_openmc(tmp_path, monkeypatch):
    summary = tmp_path / "summary.h5"
    summary.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "openmc", None)
    with pytest.raises(ValueError, match="openmc not installed"):
        convert_summary_to_xml(str(summary), str(tmp_path / "out"))


def test_convert_summary_writes_xml(tmp_path, monkeypatch):
    summary = tmp_path / "summary.h5"
    summary.write_bytes(b"fake")
    _install_fake_openmc(monkeypatch)

    out_dir = convert_summary_to_xml(str(summary), str(tmp_path / "out"))

    assert out_dir == str(tmp_path / "out")
    assert (tmp_path / "out" / "geometry.xml").read_text() == BASIC_GEOMETRY_XML
    assert (tmp_path / "out" / "materials.xml").read_text() == MATERIALS_XML


def test_convert_summary_rejects_non_summary(tmp_path, monkeypatch):
    summary = tmp_path / "summary.h5"
    summary.write_bytes(b"fake")
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.Summary = lambda path: (_ for _ in ()).throw(RuntimeError("not a summary"))
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    with pytest.raises(ValueError, match="summary file"):
        convert_summary_to_xml(str(summary), str(tmp_path / "out"))


def test_geometry_command_accepts_summary_h5(tmp_path, monkeypatch, capsys):
    """openmc.geometry on summary.h5 converts and parses end-to-end."""
    summary = tmp_path / "summary.h5"
    summary.write_bytes(b"fake")
    _install_fake_openmc(monkeypatch)

    args = _parse(geometry_cmds.cmd_geometry, [str(summary)])
    rc = geometry_cmds.cmd_geometry(args)

    assert rc == 0
    result = _stdout_json(capsys)
    assert "error" not in result
    assert result["totalCells"] == 1


def test_geometry_command_missing_summary_h5(tmp_path, capsys):
    """A missing .h5 surfaces as a JSON error, exit 1 — not a traceback."""
    args = _parse(geometry_cmds.cmd_geometry, [str(tmp_path / "summary.h5")])
    rc = geometry_cmds.cmd_geometry(args)

    assert rc == 1
    assert "File not found" in _stdout_json(capsys)["error"]
    assert "Traceback" not in capsys.readouterr().err
