"""Tests for run_volume_calc: vector parsing, log_progress, and main() argparse wiring.

The real volume calculation (openmc) is never exercised here; main() is
tested with run_volume_calc.run_volume_calc replaced by a stub, and argparse
error paths raise SystemExit before any openmc import happens.
"""

import json
import sys
import types

import pytest
import run_volume_calc


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        run_volume_calc.log_progress("sampling")
        captured = capsys.readouterr()
        assert captured.err == "sampling\n"
        assert captured.out == ""

    def test_writes_multiple_lines(self, capsys):
        """Each call appends one line to stderr."""
        run_volume_calc.log_progress("a")
        run_volume_calc.log_progress("b")
        assert capsys.readouterr().err == "a\nb\n"


class TestParseVector:
    def test_parses_three_comma_separated_values(self):
        """A well-formed vector string parses to three floats."""
        assert run_volume_calc._parse_vector("-10,-5.5,2e3") == [-10.0, -5.5, 2000.0]

    def test_rejects_wrong_length(self):
        """A vector with the wrong number of components raises ValueError."""
        with pytest.raises(ValueError):
            run_volume_calc._parse_vector("1,2")

    def test_rejects_non_numeric(self):
        """A non-numeric component raises ValueError."""
        with pytest.raises(ValueError):
            run_volume_calc._parse_vector("1,x,3")


class TestMainArgparse:
    def test_no_arguments_exits_with_code_2(self, monkeypatch):
        """Missing working_directory and required flags is an argparse error."""
        monkeypatch.setattr(sys, "argv", ["run_volume_calc.py"])
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_missing_required_flags_exits_with_code_2(self, monkeypatch):
        """--domain-type, --domain-ids, and --samples are all required."""
        monkeypatch.setattr(sys, "argv", ["run_volume_calc.py", "/tmp"])
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_invalid_domain_type_exits_with_code_2(self, monkeypatch):
        """An unknown --domain-type is rejected by argparse choices."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                "/tmp",
                "--domain-type",
                "bogus",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_missing_working_directory_returns_json_error(self, monkeypatch, capsys):
        """A nonexistent working directory yields a JSON error object, exit 0."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                "/nonexistent-dir-xyz",
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "not found" in result["error"].lower()

    def test_success_path_prints_single_json_object(self, monkeypatch, capsys, tmp_path):
        """main() prints exactly one JSON object with the stubbed run results."""
        expected = {
            "success": True,
            "results": [{"id": 1, "volume": 42.0, "stdDev": 0.1, "atoms": {}}],
        }
        monkeypatch.setattr(run_volume_calc, "run_volume_calc", lambda args: expected)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "material",
                "--domain-ids",
                "1,2",
                "--samples",
                "1000",
                "--trigger-type",
                "std_dev",
                "--trigger-threshold",
                "0.01",
            ],
        )
        run_volume_calc.main()
        out_lines = capsys.readouterr().out.strip().splitlines()
        assert len(out_lines) == 1
        assert json.loads(out_lines[0]) == expected

    def test_exception_returns_json_error(self, monkeypatch, capsys, tmp_path):
        """An exception in the run function yields success=false with traceback."""

        def boom(args):
            raise RuntimeError("kaboom")

        monkeypatch.setattr(run_volume_calc, "run_volume_calc", boom)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "kaboom" in result["error"]
        assert "traceback" in result


class TestOpenMCIntegration:
    def test_volume_calculation_api(self):
        """openmc.VolumeCalculation accepts the arguments the script passes."""
        openmc = pytest.importorskip("openmc")

        cell = openmc.Cell(1)
        vol = openmc.VolumeCalculation([cell], 100, [-1.0, -1.0, -1.0], [1.0, 1.0, 1.0])
        vol.set_trigger(0.01, "std_dev")
        assert vol.ids == [1]
        assert vol.domain_type == "cell"


# ---------------------------------------------------------------------------
# Full run flow with a fake openmc
# ---------------------------------------------------------------------------


def _ufloat(value, std):
    return types.SimpleNamespace(nominal_value=value, std_dev=std)


class _FakeVolumeCalc:
    """Records construction/trigger and serves canned results."""

    instances = []

    def __init__(self, domains, samples, lower_left, upper_right):
        self.domains = domains
        self.samples = samples
        self.lower_left = lower_left
        self.upper_right = upper_right
        self.trigger = None
        _FakeVolumeCalc.instances.append(self)

    def set_trigger(self, threshold, trigger_type):
        self.trigger = (threshold, trigger_type)

    def load_results(self, path):
        self.results_file = path
        self.ids = [1, 2]
        self.volumes = {1: _ufloat(10.5, 0.1), 2: _ufloat(20.0, 0.2)}
        self.atoms = {1: {"U235": _ufloat(1e24, 1e20)}, 2: {}}


class _FakeModel:
    instances = []

    def __init__(self, geometry=None, materials=None, settings=None):
        self.geometry = geometry
        self.materials = materials
        self.settings = settings
        self.calculate_kwargs = None
        _FakeModel.instances.append(self)

    def calculate_volumes(self, **kwargs):
        self.calculate_kwargs = kwargs


class _FakeDomain:
    def __init__(self, uid):
        self.id = uid


def _fake_openmc_volume(tmp_path):
    fake = types.ModuleType("openmc")
    fake.Materials = types.SimpleNamespace(from_xml=lambda path: [])
    fake.Geometry = types.SimpleNamespace(from_xml=lambda path, mats: object())
    fake.Settings = types.SimpleNamespace(
        from_xml_element=lambda root, meshes: types.SimpleNamespace(
            meshes=meshes, volume_calculations=None
        )
    )
    for kind in ("RegularMesh", "CylindricalMesh", "SphericalMesh"):
        setattr(
            fake,
            kind,
            types.SimpleNamespace(from_xml_element=lambda elem, k=kind: (k, elem.get("id"))),
        )
    fake.Cell = _FakeDomain
    fake.Material = _FakeDomain
    fake.Universe = _FakeDomain
    fake.VolumeCalculation = _FakeVolumeCalc
    fake.Model = _FakeModel
    _FakeVolumeCalc.instances = []
    _FakeModel.instances = []
    return fake


def _write_model(tmp_path, tallies_xml=None):
    (tmp_path / "materials.xml").write_text("<materials/>")
    (tmp_path / "geometry.xml").write_text("<geometry/>")
    (tmp_path / "settings.xml").write_text("<settings/>")
    if tallies_xml is not None:
        (tmp_path / "tallies.xml").write_text(tallies_xml)


def _vc_args(tmp_path, **overrides):
    defaults = {
        "working_directory": str(tmp_path),
        "domain_type": "cell",
        "domain_ids": "1,2",
        "samples": 1000,
        "lower_left": None,
        "upper_right": None,
        "trigger_type": None,
        "trigger_threshold": None,
    }
    defaults.update(overrides)
    return types.SimpleNamespace(**defaults)


class TestRunVolumeCalcFlow:
    def test_full_run_shapes_results(self, monkeypatch, tmp_path):
        """Domains, trigger, model run, and result JSON shaping end to end."""
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_volume(tmp_path))
        _write_model(tmp_path)

        result = run_volume_calc.run_volume_calc(
            _vc_args(
                tmp_path,
                lower_left="-1,-1,-1",
                upper_right="1,1,1",
                trigger_type="rel_err",
                trigger_threshold=0.05,
            )
        )

        assert result["success"] is True
        (vol_calc,) = _FakeVolumeCalc.instances
        assert [d.id for d in vol_calc.domains] == [1, 2]
        assert vol_calc.samples == 1000
        assert vol_calc.lower_left == [-1.0, -1.0, -1.0]
        assert vol_calc.upper_right == [1.0, 1.0, 1.0]
        assert vol_calc.trigger == (0.05, "rel_err")
        assert vol_calc.results_file == "volume_1.h5"
        # Settings received the volume calculation; model ran with volumes not applied
        (model,) = _FakeModel.instances
        assert model.settings.volume_calculations == [vol_calc]
        assert model.calculate_kwargs == {"apply_volumes": False, "export_model_xml": False}
        # Result shaping: nominal/std pairs and per-nuclide atoms
        assert result["results"][0] == {
            "id": 1,
            "volume": 10.5,
            "stdDev": pytest.approx(0.1),
            "atoms": {"U235": {"value": 1e24, "stdDev": 1e20}},
        }
        assert result["results"][1]["atoms"] == {}
        assert result["volumeFile"].endswith("volume_1.h5")

    @pytest.mark.parametrize("domain_type", ["cell", "material", "universe"])
    def test_domain_types(self, monkeypatch, tmp_path, domain_type):
        """Each domain type builds throw-away domains with the requested IDs."""
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_volume(tmp_path))
        _write_model(tmp_path)

        result = run_volume_calc.run_volume_calc(
            _vc_args(tmp_path, domain_type=domain_type, domain_ids="3")
        )

        assert result["success"] is True
        (vol_calc,) = _FakeVolumeCalc.instances
        assert [d.id for d in vol_calc.domains] == [3]

    def test_trigger_threshold_defaults(self, monkeypatch, tmp_path, capsys):
        """A trigger type without a threshold uses the 0.01 default."""
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_volume(tmp_path))
        _write_model(tmp_path)

        run_volume_calc.run_volume_calc(_vc_args(tmp_path, trigger_type="std_dev"))

        (vol_calc,) = _FakeVolumeCalc.instances
        assert vol_calc.trigger == (0.01, "std_dev")
        assert "threshold=0.01" in capsys.readouterr().err


class TestLoadModelMeshes:
    def test_mesh_types_loaded_and_unknown_skipped(self, monkeypatch, tmp_path):
        """regular/cylindrical/spherical meshes load; unknown types are skipped."""
        fake = _fake_openmc_volume(tmp_path)
        monkeypatch.setitem(sys.modules, "openmc", fake)
        _write_model(
            tmp_path,
            tallies_xml=(
                '<tallies><mesh type="regular" id="1"/><mesh type="cylindrical" id="2"/>'
                '<mesh type="spherical" id="3"/><mesh type="weird" id="4"/></tallies>'
            ),
        )

        materials, geometry, settings = run_volume_calc.load_model(tmp_path)

        assert set(settings.meshes) == {1, 2, 3}
        assert settings.meshes[1][0] == "RegularMesh"
        assert settings.meshes[3][0] == "SphericalMesh"

    def test_corrupt_tallies_warns_and_continues(self, monkeypatch, tmp_path, capsys):
        """A broken tallies.xml logs a warning but the model still loads."""
        monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_volume(tmp_path))
        _write_model(tmp_path, tallies_xml="<tallies><mesh")

        materials, geometry, settings = run_volume_calc.load_model(tmp_path)

        assert settings.meshes == {}
        assert "Could not load meshes" in capsys.readouterr().err


class TestMainVolumeErrorPaths:
    def test_import_error_returns_missing_dependency_json(self, monkeypatch, capsys, tmp_path):
        """Forced openmc absence yields the missing-dependency JSON, exit 0."""
        monkeypatch.setitem(sys.modules, "openmc", None)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "10",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "Missing dependency" in result["error"]

    def test_generic_error_returns_traceback_json(self, monkeypatch, capsys, tmp_path):
        """A run failure yields the error JSON with a traceback, exit 0."""

        def boom(args):
            raise RuntimeError("volume run failed")

        monkeypatch.setattr(run_volume_calc, "run_volume_calc", boom)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "10",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert result["error"] == "volume run failed"
        assert "traceback" in result
