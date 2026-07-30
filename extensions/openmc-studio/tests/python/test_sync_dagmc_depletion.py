"""Tests for sync_dagmc_depletion: the init_lib → sync → finalize_lib job.

The real openmc C API is never exercised; the sequence is tested against a
fake openmc module recording the calls, and the real API shape is covered by
an importorskip integration test.
"""

import json
import sys
import types

import pytest
import sync_dagmc_depletion


class _FakeCell:
    def __init__(self, name, fill=None):
        self.name = name
        self.fill = fill


class _FakeMaterial:
    def __init__(self, name):
        self.name = name


class _FakeDAGMCUniverse:
    def __init__(self, cells):
        self.cells = cells


class _FakeGeometry:
    def __init__(self, universes):
        self._universes = universes

    def get_all_universes(self):
        return self._universes


class _FakeModel:
    last_instance = None

    def __init__(self, universes):
        self.geometry = _FakeGeometry(universes)
        self.calls = []
        _FakeModel.last_instance = self

    def init_lib(self, output=True):
        self.calls.append("init_lib")

    def sync_dagmc_universes(self):
        self.calls.append("sync_dagmc_universes")

    def finalize_lib(self):
        self.calls.append("finalize_lib")

    def export_to_xml(self):
        self.calls.append("export_to_xml")


def _fake_openmc(universes):
    fake = types.ModuleType("openmc")
    fake.DAGMCUniverse = _FakeDAGMCUniverse
    fake.Model = types.SimpleNamespace(
        from_xml=staticmethod(lambda **kwargs: _FakeModel(universes))
    )
    return fake


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        sync_dagmc_depletion.log_progress("syncing")
        captured = capsys.readouterr()
        assert captured.err == "syncing\n"
        assert captured.out == ""


class TestRunSync:
    def test_documented_sequence_and_result(self, monkeypatch, tmp_path):
        """init_lib → sync_dagmc_universes → finalize_lib runs in order and the result reports cells."""
        cells = {
            1: _FakeCell("c1", _FakeMaterial("fuel")),
            2: _FakeCell("c2", _FakeMaterial("water")),
            3: _FakeCell("c3", None),
        }
        universes = {1: _FakeDAGMCUniverse(cells)}
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc(universes))

        result = sync_dagmc_depletion.run_sync(str(tmp_path))

        assert result["success"] is True
        assert result["cellCount"] == 3
        assert result["materialCount"] == 2
        assert result["materialNames"] == ["fuel", "water"]
        calls = _FakeModel.last_instance.calls
        assert calls == ["init_lib", "sync_dagmc_universes", "finalize_lib", "export_to_xml"]

    def test_finalize_runs_even_when_sync_raises(self, monkeypatch, tmp_path):
        """finalize_lib is called even when sync_dagmc_universes raises."""
        cells = {1: _FakeCell("c1", None)}
        universes = {1: _FakeDAGMCUniverse(cells)}
        fake = _fake_openmc(universes)

        def boom(self):
            self.calls.append("sync_dagmc_universes")
            raise RuntimeError("sync failed")

        monkeypatch.setattr(_FakeModel, "sync_dagmc_universes", boom)
        monkeypatch.setitem(sys.modules, "openmc", fake)

        with pytest.raises(RuntimeError, match="sync failed"):
            sync_dagmc_depletion.run_sync(str(tmp_path))

        assert _FakeModel.last_instance.calls == [
            "init_lib",
            "sync_dagmc_universes",
            "finalize_lib",
        ]

    def test_no_dagmc_universes_raises(self, monkeypatch, tmp_path):
        """A geometry without DAGMC universes yields a clear error."""
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc({}))
        with pytest.raises(ValueError, match="No DAGMC universes"):
            sync_dagmc_depletion.run_sync(str(tmp_path))


class TestMainArgparse:
    def test_missing_working_directory_returns_json_error(self, monkeypatch, capsys):
        """A nonexistent working directory yields a JSON error object, exit 0."""
        monkeypatch.setattr(sys, "argv", ["sync_dagmc_depletion.py", "/nonexistent-dir-xyz"])
        with pytest.raises(SystemExit) as exc:
            sync_dagmc_depletion.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "not found" in result["error"].lower()

    def test_no_arguments_exits_with_code_2(self, monkeypatch):
        """Missing working_directory is an argparse error."""
        monkeypatch.setattr(sys, "argv", ["sync_dagmc_depletion.py"])
        with pytest.raises(SystemExit) as exc:
            sync_dagmc_depletion.main()
        assert exc.value.code == 2

    def test_exception_returns_json_error(self, monkeypatch, capsys, tmp_path):
        """An exception in the sync yields success=false with traceback."""

        def boom(directory):
            raise RuntimeError("kaboom")

        monkeypatch.setattr(sync_dagmc_depletion, "run_sync", boom)
        monkeypatch.setattr(sys, "argv", ["sync_dagmc_depletion.py", str(tmp_path)])
        with pytest.raises(SystemExit) as exc:
            sync_dagmc_depletion.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "kaboom" in result["error"]


class TestOpenMCIntegration:
    def test_real_api_shape(self):
        """The real OpenMC API exposes the methods the script calls."""
        openmc = pytest.importorskip("openmc")
        import inspect

        assert hasattr(openmc.Model, "init_lib")
        assert hasattr(openmc.Model, "sync_dagmc_universes")
        assert hasattr(openmc.Model, "finalize_lib")
        assert hasattr(openmc.Model, "from_xml")

        dagmc_params = inspect.signature(openmc.DAGMCUniverse.__init__).parameters
        for expected in ("filename", "auto_geom_ids", "auto_mat_ids"):
            assert expected in dagmc_params
        assert hasattr(openmc.DAGMCUniverse, "add_material_override")
