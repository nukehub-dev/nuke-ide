"""Tests for generate_mgxs: argparse wiring and the conversion flow with a fake openmc.

The real MGXS generation (openmc) is never exercised here; the conversion is
tested against a fake openmc module, and the real API signature is covered by
an importorskip integration test.
"""

import json
import sys
import types

import generate_mgxs
import pytest


class _FakeSettings:
    def __init__(self):
        self.exported = False

    def export_to_xml(self):
        self.exported = True


class _FakeModel:
    last_instance = None

    def __init__(self, geometry=None, materials=None, settings=None):
        self.settings = _FakeSettings()
        self.convert_calls = []
        self.random_ray_calls = 0
        _FakeModel.last_instance = self

    def convert_to_multigroup(self, **kwargs):
        self.convert_calls.append(kwargs)

    def convert_to_random_ray(self):
        self.random_ray_calls += 1


class _FakeOpenMC(types.ModuleType):
    def __init__(self):
        super().__init__("openmc")
        self.Model = _FakeModel
        self.Materials = types.SimpleNamespace(from_xml=staticmethod(lambda p: []))
        self.Geometry = types.SimpleNamespace(from_xml=staticmethod(lambda p, m: object()))
        self.Settings = types.SimpleNamespace(
            from_xml_element=staticmethod(lambda root, meshes: _FakeSettings())
        )
        self.RegularMesh = types.SimpleNamespace(from_xml_element=staticmethod(lambda e: object()))
        self.CylindricalMesh = types.SimpleNamespace(
            from_xml_element=staticmethod(lambda e: object())
        )
        self.SphericalMesh = types.SimpleNamespace(
            from_xml_element=staticmethod(lambda e: object())
        )


@pytest.fixture
def fake_openmc_module(monkeypatch):
    """Inject the fake openmc module into sys.modules."""
    fake = _FakeOpenMC()
    monkeypatch.setitem(sys.modules, "openmc", fake)
    return fake


def _write_model_xml(workdir):
    """Write minimal model XML files into a working directory."""
    (workdir / "materials.xml").write_text('<?xml version="1.0"?><materials/>')
    (workdir / "geometry.xml").write_text('<?xml version="1.0"?><geometry/>')
    (workdir / "settings.xml").write_text('<?xml version="1.0"?><settings/>')


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        generate_mgxs.log_progress("converting")
        captured = capsys.readouterr()
        assert captured.err == "converting\n"
        assert captured.out == ""


class TestCallWithSupportedKwargs:
    def test_drops_unsupported_kwargs_with_note(self, capsys):
        """Version-specific kwargs are filtered out before the call."""
        import generate_mgxs

        calls = []

        def old_api(*, method, groups):
            calls.append({"method": method, "groups": groups})
            return "ok"

        result = generate_mgxs._call_with_supported_kwargs(
            old_api, method="material_wise", groups="CASMO-2", temperatures=[300.0]
        )
        assert result == "ok"
        assert calls == [{"method": "material_wise", "groups": "CASMO-2"}]
        assert "temperatures" in capsys.readouterr().err

    def test_passes_all_when_supported(self, capsys):
        """Fully supported signatures receive every kwarg, with no note."""

        def new_api(*, method, temperatures):
            return temperatures

        import generate_mgxs

        result = generate_mgxs._call_with_supported_kwargs(
            new_api, method="material_wise", temperatures=[600.0]
        )
        assert result == [600.0]
        assert "ignores unsupported" not in capsys.readouterr().err


class TestReadModelCompatibility:
    def test_missing_files_are_compatible(self, tmp_path):
        """No XML files → nothing to object to (the load step reports it)."""
        assert generate_mgxs.read_model_compatibility(tmp_path) is None

    def test_ce_microscopic_model_is_compatible(self, tmp_path):
        """Continuous-energy + nuclide-decomposed materials pass."""
        _write_model_xml(tmp_path)
        (tmp_path / "settings.xml").write_text(
            "<settings><energy_mode>continuous-energy</energy_mode></settings>"
        )
        (tmp_path / "materials.xml").write_text(
            '<materials><material id="1" name="fuel"><nuclide name="U235" ao="1.0"/></material></materials>'
        )
        assert generate_mgxs.read_model_compatibility(tmp_path) is None

    def test_multigroup_settings_is_incompatible(self, tmp_path):
        """Multi-group settings.xml is rejected with the CE guidance."""
        _write_model_xml(tmp_path)
        (tmp_path / "settings.xml").write_text(
            "<settings><energy_mode>multi-group</energy_mode></settings>"
        )
        error = generate_mgxs.read_model_compatibility(tmp_path)
        assert error is not None
        assert "continuous-energy" in error
        assert "multigroup" in error

    def test_macroscopic_material_is_incompatible(self, tmp_path):
        """Macroscopic materials are rejected and named."""
        _write_model_xml(tmp_path)
        (tmp_path / "materials.xml").write_text(
            '<materials><material id="1" name="fuel"><macroscopic name="fuel"/></material></materials>'
        )
        error = generate_mgxs.read_model_compatibility(tmp_path)
        assert error is not None
        assert "macroscopic" in error
        assert "fuel" in error


class TestMainCompatibilityGuard:
    def test_multigroup_model_exits_1_with_clean_json(self, tmp_path, monkeypatch, capsys):
        """The guard fires before any openmc import: exit 1 + error JSON."""
        _write_model_xml(tmp_path)
        (tmp_path / "settings.xml").write_text(
            "<settings><energy_mode>multi-group</energy_mode></settings>"
        )
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py", str(tmp_path)])

        with pytest.raises(SystemExit) as exc:
            generate_mgxs.main()

        assert exc.value.code == 1
        result = json.loads(capsys.readouterr().out)
        assert result["success"] is False
        assert "continuous-energy" in result["error"]
        assert "multigroup" in result["error"]

    def test_macroscopic_model_exits_1_with_clean_json(self, tmp_path, monkeypatch, capsys):
        """Macroscopic materials are rejected even in continuous-energy mode."""
        _write_model_xml(tmp_path)
        (tmp_path / "materials.xml").write_text(
            '<materials><material id="1" name="fuel"><macroscopic name="fuel"/></material></materials>'
        )
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py", str(tmp_path)])

        with pytest.raises(SystemExit) as exc:
            generate_mgxs.main()

        assert exc.value.code == 1
        result = json.loads(capsys.readouterr().out)
        assert result["success"] is False
        assert "macroscopic" in result["error"]


class TestRunGenerateMgxs:
    def test_convert_kwargs(self, fake_openmc_module, tmp_path):
        """convert_to_multigroup receives method/groups/correction/temperatures/particles/output."""
        _write_model_xml(tmp_path)
        args = types.SimpleNamespace(
            working_directory=str(tmp_path),
            method="stochastic_slab",
            groups="XMAS-172",
            particles=5000,
            correction="P0",
            temperatures="300,600",
            output="mgxs.h5",
            random_ray=False,
        )
        result = generate_mgxs.run_generate_mgxs(args)

        assert result["success"] is True
        assert result["mgxsPath"] == str(tmp_path / "mgxs.h5")
        call = _FakeModel.last_instance.convert_calls[0]
        assert call["method"] == "stochastic_slab"
        assert call["groups"] == "XMAS-172"
        assert call["nparticles"] == 5000
        assert call["correction"] == "P0"
        assert call["temperatures"] == [300.0, 600.0]
        assert call["mgxs_path"] == "mgxs.h5"
        assert call["overwrite_mgxs_library"] is True
        assert _FakeModel.last_instance.random_ray_calls == 0

    def test_correction_none_maps_to_none(self, fake_openmc_module, tmp_path):
        """--correction none maps to Python None (no correction)."""
        _write_model_xml(tmp_path)
        args = types.SimpleNamespace(
            working_directory=str(tmp_path),
            method="material_wise",
            groups="CASMO-2",
            particles=None,
            correction="none",
            temperatures=None,
            output="mgxs.h5",
            random_ray=False,
        )
        generate_mgxs.run_generate_mgxs(args)
        call = _FakeModel.last_instance.convert_calls[0]
        assert call["correction"] is None
        assert "nparticles" not in call

    def test_random_ray_conversion_exports_settings(self, fake_openmc_module, tmp_path):
        """--random-ray triggers convert_to_random_ray and settings.xml re-export."""
        _write_model_xml(tmp_path)
        args = types.SimpleNamespace(
            working_directory=str(tmp_path),
            method="material_wise",
            groups="CASMO-2",
            particles=None,
            correction="none",
            temperatures=None,
            output="mgxs.h5",
            random_ray=True,
        )
        result = generate_mgxs.run_generate_mgxs(args)

        assert result["randomRayApplied"] is True
        assert _FakeModel.last_instance.random_ray_calls == 1
        assert _FakeModel.last_instance.settings.exported is True


class TestMainArgparse:
    def test_no_arguments_exits_with_code_2(self, monkeypatch):
        """Missing working_directory is an argparse error."""
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py"])
        with pytest.raises(SystemExit) as exc:
            generate_mgxs.main()
        assert exc.value.code == 2

    def test_invalid_method_exits_with_code_2(self, monkeypatch):
        """An unknown --method is rejected by argparse choices."""
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py", "/tmp", "--method", "bogus"])
        with pytest.raises(SystemExit) as exc:
            generate_mgxs.main()
        assert exc.value.code == 2

    def test_missing_working_directory_returns_json_error(self, monkeypatch, capsys):
        """A nonexistent working directory yields a JSON error object, exit 0."""
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py", "/nonexistent-dir-xyz"])
        with pytest.raises(SystemExit) as exc:
            generate_mgxs.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "not found" in result["error"].lower()

    def test_success_path_prints_single_json_object(self, monkeypatch, capsys, tmp_path):
        """main() prints exactly one JSON object with the stubbed run results."""
        expected = {"success": True, "mgxsPath": "/tmp/mgxs.h5"}
        monkeypatch.setattr(generate_mgxs, "run_generate_mgxs", lambda args: expected)
        monkeypatch.setattr(sys, "argv", ["generate_mgxs.py", str(tmp_path), "--groups", "CASMO-2"])
        generate_mgxs.main()
        out_lines = capsys.readouterr().out.strip().splitlines()
        assert len(out_lines) == 1
        assert json.loads(out_lines[0]) == expected


class TestOpenMCIntegration:
    def test_convert_signatures_accept_script_kwargs(self):
        """The real conversion methods accept the kwargs the script passes."""
        openmc = pytest.importorskip("openmc")
        import inspect

        mg_params = inspect.signature(openmc.Model.convert_to_multigroup).parameters
        # Version-stable kwargs every supported OpenMC accepts; version-specific
        # extras (temperatures, overwrite_mgxs_library) are filtered by the
        # driver's _call_with_supported_kwargs — covered by its own tests.
        for expected in ("method", "groups", "correction", "mgxs_path"):
            assert expected in mg_params

        rr_params = inspect.signature(openmc.Model.convert_to_random_ray).parameters
        assert "self" in rr_params
