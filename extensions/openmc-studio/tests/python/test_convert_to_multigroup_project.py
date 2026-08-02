"""Tests for convert_to_multigroup_project: XML/h5 readers and the main flow.

The MGXS generation itself is never exercised here; run_generate_mgxs is
monkeypatched, and the h5 reader is tested against real files via the h5py
fixture.
"""

import json
import sys
import types

import convert_to_multigroup_project as convert
import pytest


@pytest.fixture
def h5py():
    return pytest.importorskip("h5py")


class TestReadMaterialNames:
    def test_reads_names_in_order(self, tmp_path):
        (tmp_path / "materials.xml").write_text(
            '<materials><material id="1" name="fuel"/><material id="2" name="clad"/>'
            '<material id="3"/></materials>'
        )
        assert convert.read_material_names(tmp_path) == ["fuel", "clad", "3"]

    def test_missing_file_returns_empty(self, tmp_path):
        assert convert.read_material_names(tmp_path) == []


class TestReadXsDataNames:
    def test_top_level_groups(self, tmp_path, h5py):
        path = tmp_path / "mgxs.h5"
        with h5py.File(path, "w") as f:
            for name in ("fuel", "41", "Graveyard"):
                f.create_group(f"{name}/294K")
                f.create_group(f"{name}/kTs")
        assert set(convert.read_xs_data_names(path)) == {"fuel", "41", "Graveyard"}


def _args(tmp_path, **overrides):
    defaults = {
        "working_directory": str(tmp_path),
        "method": "material_wise",
        "groups": "CASMO-2",
        "particles": 100,
        "output": "mgxs.h5",
    }
    defaults.update(overrides)
    return types.SimpleNamespace(**defaults)


def _write_model(tmp_path):
    (tmp_path / "materials.xml").write_text(
        '<materials><material id="1" name="fuel"/><material id="2" name="clad"/></materials>'
    )


def _write_library(tmp_path, group_names, h5py):
    path = tmp_path / "mgxs.h5"
    with h5py.File(path, "w") as f:
        for name in group_names:
            f.create_group(f"{name}/294K")
    return path


class TestConvertProject:
    def test_mapping_intersects_materials_with_library(self, monkeypatch, tmp_path, h5py):
        """Materials with an XS data group map to their own name; others are skipped."""
        _write_model(tmp_path)
        lib = _write_library(tmp_path, ["fuel"], h5py)
        monkeypatch.setattr(
            convert.generate_mgxs,
            "run_generate_mgxs",
            lambda args: {"success": True, "mgxsPath": str(lib)},
        )

        result = convert.convert_project(_args(tmp_path))

        assert result["success"] is True
        assert result["mgxsPath"] == str(lib)
        assert result["xsDataNames"] == [{"materialName": "fuel", "xsDataName": "fuel"}]

    def test_generation_failure_passthrough(self, monkeypatch, tmp_path):
        """A failed generation returns the failure dict without reading any library."""
        _write_model(tmp_path)
        monkeypatch.setattr(
            convert.generate_mgxs,
            "run_generate_mgxs",
            lambda args: {
                "success": False,
                "error": "MGXS generation requires a continuous-energy model",
            },
        )

        result = convert.convert_project(_args(tmp_path))

        assert result["success"] is False
        assert "continuous-energy" in result["error"]


class TestMain:
    def test_missing_working_directory_exits_1(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["convert_to_multigroup_project.py", "/nonexistent-xyz"])
        with pytest.raises(SystemExit) as exc:
            convert.main()
        assert exc.value.code == 1
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False

    def test_success_path_prints_json_and_exits_0(self, monkeypatch, tmp_path, capsys, h5py):
        _write_model(tmp_path)
        lib = _write_library(tmp_path, ["fuel", "clad"], h5py)
        monkeypatch.setattr(
            convert.generate_mgxs,
            "run_generate_mgxs",
            lambda args: {"success": True, "mgxsPath": str(lib)},
        )
        monkeypatch.setattr(sys, "argv", ["convert_to_multigroup_project.py", str(tmp_path)])

        with pytest.raises(SystemExit) as exc:
            convert.main()

        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is True
        assert result["xsDataNames"] == [
            {"materialName": "fuel", "xsDataName": "fuel"},
            {"materialName": "clad", "xsDataName": "clad"},
        ]

    def test_run_exception_exits_1_with_clean_json(self, monkeypatch, tmp_path, capsys):
        _write_model(tmp_path)

        def boom(args):
            raise RuntimeError("Start tag expected")

        monkeypatch.setattr(convert.generate_mgxs, "run_generate_mgxs", boom)
        monkeypatch.setattr(sys, "argv", ["convert_to_multigroup_project.py", str(tmp_path)])

        with pytest.raises(SystemExit) as exc:
            convert.main()

        assert exc.value.code == 1
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert result["error"] == "Start tag expected"
