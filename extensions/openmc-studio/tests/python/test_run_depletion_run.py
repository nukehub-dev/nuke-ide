"""Tests for run_depletion.run_depletion using a stub openmc module.

The real depletion run never executes: openmc and openmc.deplete are
replaced with recording stubs, so model loading, chain-file resolution,
power/mass calculation, solver mapping, and the burnup summary math are
all exercised without OpenMC installed. Each test runs in a tmp working
directory and restores the process CWD afterwards.
"""

import os
import sys
import types
from types import SimpleNamespace

import pytest
import run_depletion


@pytest.fixture(autouse=True)
def _restore_cwd():
    """run_depletion chdirs into the working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


# ---------------------------------------------------------------------------
# Stub builders
# ---------------------------------------------------------------------------


class FakeMaterial:
    """Fake openmc.Material with depletable/density/volume attributes."""

    def __init__(self, name, depletable=True, density=10.0, volume=100.0):
        self.name = name
        self.depletable = depletable
        self.density = density
        self.volume = volume


class RecordingIntegrator:
    """Records constructor args; integrate() can be made to fail."""

    instances = []
    fail_on_integrate = False

    def __init__(self, operator, time_steps, power=None):
        self.operator = operator
        self.time_steps = time_steps
        self.power = power
        self.integrated = False
        RecordingIntegrator.instances.append(self)

    def integrate(self):
        if RecordingIntegrator.fail_on_integrate:
            raise RuntimeError("transport failed")
        self.integrated = True


class RecordingOperator:
    """Records CoupledOperator construction."""

    instances = []

    def __init__(self, model, chain, normalization_mode="fission-q"):
        self.model = model
        self.chain = chain
        self.normalization_mode = normalization_mode
        RecordingOperator.instances.append(self)


def _install_fake_openmc(
    monkeypatch,
    materials=(),
    geometry=None,
    integrator_names=(
        "CECMIntegrator",
        "EPCRK4Integrator",
        "PredictorIntegrator",
        "SICELIIntegrator",
        "LEQIIntegrator",
    ),
):
    """Insert stub openmc/openmc.deplete modules; returns the fake openmc."""
    if geometry is None:
        geometry = SimpleNamespace(root_universe=SimpleNamespace())

    fake_openmc = types.ModuleType("openmc")

    fake_openmc.Materials = SimpleNamespace(from_xml=lambda path: list(materials))
    fake_openmc.Geometry = SimpleNamespace(from_xml=lambda path, mats: geometry)
    fake_openmc.Settings = SimpleNamespace(
        from_xml_element=lambda root, meshes: SimpleNamespace(meshes=meshes)
    )
    fake_openmc.Universe = lambda universe_id, name: SimpleNamespace(
        universe_id=universe_id, name=name
    )
    for mesh_kind in ("RegularMesh", "CylindricalMesh", "SphericalMesh"):
        setattr(
            fake_openmc,
            mesh_kind,
            SimpleNamespace(from_xml_element=lambda elem, k=mesh_kind: (k, elem.get("id"))),
        )
    fake_openmc.model = SimpleNamespace(
        Model=lambda geometry, materials, settings: SimpleNamespace(
            geometry=geometry, materials=materials, settings=settings
        )
    )

    fake_deplete = types.ModuleType("openmc.deplete")
    fake_deplete.Chain = SimpleNamespace(from_xml=lambda path: ("chain", path))
    fake_deplete.CoupledOperator = RecordingOperator
    for name in integrator_names:
        setattr(fake_deplete, name, RecordingIntegrator)
    fake_openmc.deplete = fake_deplete

    RecordingOperator.instances = []
    RecordingIntegrator.instances = []
    RecordingIntegrator.fail_on_integrate = False

    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)
    return fake_openmc


def _workdir(tmp_path, settings_xml="<settings></settings>", tallies_xml=None):
    """Create a working directory with the XML files run_depletion parses."""
    workdir = tmp_path / "model"
    workdir.mkdir()
    (workdir / "settings.xml").write_text(settings_xml)
    if tallies_xml is not None:
        (workdir / "tallies.xml").write_text(tallies_xml)
    return workdir


def _args(workdir, **overrides):
    """Build a minimal argparse-like namespace for run_depletion."""
    defaults = {
        "working_directory": str(workdir),
        "chain_file": None,
        "time_steps": "86400,86400",
        "power": 1e6,
        "power_density": None,
        "solver": "cecm",
        "operator": "coupled",
        "normalization": None,
        "substeps": 1,
        "mpi_processes": None,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.fixture()
def chain_file(tmp_path):
    """A real chain file path that passes the existence check."""
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>")
    return str(chain)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Keep chain-related environment variables from leaking between tests."""
    monkeypatch.delenv("OPENMC_CHAIN_FILE", raising=False)
    monkeypatch.delenv("OPENMC_CROSS_SECTIONS", raising=False)


# ---------------------------------------------------------------------------
# Successful runs
# ---------------------------------------------------------------------------


class TestRunDepletionSuccess:
    def test_full_run_summary_and_burnup_math(self, monkeypatch, tmp_path, chain_file, capsys):
        """A coupled run returns the summary with computed burnup values."""
        materials = [
            FakeMaterial("fuel", depletable=True, density=10.0, volume=100.0),
            FakeMaterial("water", depletable=False, density=1.0, volume=50.0),
        ]
        _install_fake_openmc(monkeypatch, materials=materials)
        workdir = _workdir(
            tmp_path,
            tallies_xml=(
                '<tallies><mesh type="regular" id="1"/><mesh type="cylindrical" id="2"/>'
                '<mesh type="spherical" id="3"/><mesh type="weird" id="4"/></tallies>'
            ),
        )

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        assert result["timeSteps"] == [86400.0, 86400.0]
        # 1000 g of fuel at 1e6 W: 1 MWd after day 1, 2 MWd after day 2.
        assert result["burnupMWdPerKg"] == [pytest.approx(1.0), pytest.approx(2.0)]
        assert result["power"] == 1e6
        assert result["solver"] == "cecm"
        assert result["operator"] == "coupled"

        # Operator and integrator were built with the parsed arguments.
        (operator,) = RecordingOperator.instances
        assert operator.chain == ("chain", chain_file)
        assert operator.normalization_mode == "fission-q"
        (integrator,) = RecordingIntegrator.instances
        assert integrator.time_steps == [86400.0, 86400.0]
        assert integrator.power == 1e6
        assert integrator.integrated is True

        err = capsys.readouterr().err
        assert "Loading OpenMC model" in err
        assert "Material fuel: 1000.00 g" in err
        assert "Final burnup: 2.00 MWd/kg" in err
        # h5py is not installed -> the burnup-append step only warns.
        assert "Could not add burnup to HDF5" in err

    def test_meshes_from_tallies_are_passed_to_settings(self, monkeypatch, tmp_path, chain_file):
        """Known mesh types load; unknown types are skipped."""
        fake_openmc = _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(
            tmp_path,
            tallies_xml=(
                '<tallies><mesh type="regular" id="1"/><mesh type="cylindrical" id="2"/>'
                '<mesh type="spherical" id="3"/><mesh type="weird" id="4"/></tallies>'
            ),
        )

        run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        settings = RecordingOperator.instances[0].model.settings
        assert settings.meshes == {
            1: ("RegularMesh", "1"),
            2: ("CylindricalMesh", "2"),
            3: ("SphericalMesh", "3"),
        }
        assert fake_openmc is not None  # stub was used, not a real import

    def test_malformed_tallies_xml_only_warns(self, monkeypatch, tmp_path, chain_file, capsys):
        """A broken tallies.xml logs a warning and continues with no meshes."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path, tallies_xml="<tallies><mesh")

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        assert "Could not load meshes" in capsys.readouterr().err

    def test_missing_root_universe_gets_dummy(self, monkeypatch, tmp_path, chain_file, capsys):
        """A geometry without a root universe receives a dummy one."""
        geometry = SimpleNamespace(root_universe=None)
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")], geometry=geometry)
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        assert geometry.root_universe.universe_id == 0
        assert "no root universe" in capsys.readouterr().err

    def test_openmc_operator_variant(self, monkeypatch, tmp_path, chain_file):
        """The 'openmc' operator also builds a CoupledOperator."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, operator="openmc")
        )

        assert result["success"] is True
        assert len(RecordingOperator.instances) == 1

    def test_explicit_normalization_is_forwarded(self, monkeypatch, tmp_path, chain_file):
        """A non-default normalization mode reaches the operator."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, normalization="source-rate")
        )

        assert RecordingOperator.instances[0].normalization_mode == "source-rate"

    @pytest.mark.parametrize(
        "solver,expected_class",
        [
            ("cecm", "CECMIntegrator"),
            ("epc", "EPCRK4Integrator"),
            ("predictor", "PredictorIntegrator"),
            ("cecmr", "CECMIntegrator"),
            ("epcr", "EPCRK4Integrator"),
            ("si-cesc", "SICELIIntegrator"),
            ("leqi", "LEQIIntegrator"),
        ],
    )
    def test_solver_name_mapping(
        self, monkeypatch, tmp_path, chain_file, solver, expected_class, capsys
    ):
        """Every documented solver maps to its integrator class."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file, solver=solver))

        assert result["success"] is True
        assert result["solver"] == solver
        assert f"Creating {solver.upper()} integrator" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Chain file resolution
# ---------------------------------------------------------------------------


class TestChainFileResolution:
    def test_env_chain_file_is_used(self, monkeypatch, tmp_path, chain_file):
        """OPENMC_CHAIN_FILE provides the chain when --chain-file is absent."""
        monkeypatch.setenv("OPENMC_CHAIN_FILE", chain_file)
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir))

        assert result["success"] is True
        assert RecordingOperator.instances[0].chain == ("chain", chain_file)

    def test_cross_sections_derived_chain(self, monkeypatch, tmp_path):
        """OPENMC_CROSS_SECTIONS derives a sibling *_chain.xml when it exists."""
        xs = tmp_path / "cross_sections.h5"
        xs.write_bytes(b"x")
        derived = tmp_path / "cross_sections_chain.xml"
        derived.write_text("<depletion_chain/>")
        monkeypatch.setenv("OPENMC_CROSS_SECTIONS", str(xs))
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir))

        assert result["success"] is True
        assert RecordingOperator.instances[0].chain == ("chain", str(derived))

    def test_missing_chain_file_raises(self, monkeypatch, tmp_path):
        """Without any chain source, a FileNotFoundError is raised."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(FileNotFoundError, match="Depletion chain file not found: None"):
            run_depletion.run_depletion(_args(workdir))

    def test_derived_chain_missing_raises(self, monkeypatch, tmp_path):
        """A cross-sections env var without the derived chain file raises."""
        monkeypatch.setenv("OPENMC_CROSS_SECTIONS", str(tmp_path / "cross_sections.h5"))
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(FileNotFoundError, match="Depletion chain file not found"):
            run_depletion.run_depletion(_args(workdir))

    def test_explicit_chain_file_must_exist(self, monkeypatch, tmp_path):
        """A nonexistent --chain-file raises FileNotFoundError."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(FileNotFoundError, match="Depletion chain file not found"):
            run_depletion.run_depletion(_args(workdir, chain_file="/no/such/chain.xml"))


# ---------------------------------------------------------------------------
# Power handling
# ---------------------------------------------------------------------------


class TestPowerHandling:
    def test_power_density_computes_total_power(self, monkeypatch, tmp_path, chain_file, capsys):
        """--power-density multiplies by the total depletable mass."""
        materials = [
            FakeMaterial("fuel", depletable=True, density=10.0, volume=100.0),
            FakeMaterial("fuel2", depletable=True, density=5.0, volume=100.0),
        ]
        _install_fake_openmc(monkeypatch, materials=materials)
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, power=None, power_density=2.0)
        )

        # (1000 g + 500 g) * 2 W/g = 3000 W.
        assert result["power"] == 3000.0
        assert RecordingIntegrator.instances[0].power == 3000.0
        assert "Calculated total power from density" in capsys.readouterr().err

    def test_depletable_material_without_volume_is_skipped(
        self, monkeypatch, tmp_path, chain_file, capsys
    ):
        """A depletable material with no volume warns and is excluded."""
        materials = [
            FakeMaterial("fuel", depletable=True, density=10.0, volume=100.0),
            FakeMaterial("novol", depletable=True, density=10.0, volume=None),
        ]
        _install_fake_openmc(monkeypatch, materials=materials)
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, power=None, power_density=2.0)
        )

        assert result["power"] == 2000.0
        assert "novol is depletable but has no volume set" in capsys.readouterr().err

    def test_power_density_without_mass_raises(self, monkeypatch, tmp_path, chain_file):
        """Power density with zero depletable mass is a ValueError."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("water", depletable=False)])
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="no depletable materials with volumes"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, power=None, power_density=2.0)
            )

    def test_no_power_at_all_raises(self, monkeypatch, tmp_path, chain_file):
        """Neither --power nor --power-density is a ValueError."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="Either --power or --power-density"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, power=None))


# ---------------------------------------------------------------------------
# Operator / solver failures
# ---------------------------------------------------------------------------


class TestOperatorAndSolverFailures:
    def test_independent_operator_not_implemented(self, monkeypatch, tmp_path, chain_file):
        """The independent operator raises NotImplementedError."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(NotImplementedError, match="Independent operator"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, operator="independent")
            )

    def test_unknown_solver_raises(self, monkeypatch, tmp_path, chain_file):
        """An unmapped solver name is a ValueError listing the choices."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="Unknown solver: bogus"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, solver="bogus"))

    def test_missing_integrator_class_raises(self, monkeypatch, tmp_path, chain_file):
        """A solver whose integrator class is absent is a ValueError."""
        _install_fake_openmc(
            monkeypatch,
            materials=[FakeMaterial("fuel")],
            integrator_names=("CECMIntegrator",),
        )
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="does not have class: LEQIIntegrator"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, solver="leqi"))

    def test_integrate_failure_propagates(self, monkeypatch, tmp_path, chain_file, capsys):
        """A transport failure during integrate() re-raises after logging."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        RecordingIntegrator.fail_on_integrate = True
        workdir = _workdir(tmp_path)

        with pytest.raises(RuntimeError, match="transport failed"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert "Error during depletion: transport failed" in capsys.readouterr().err

    def test_xml_load_failure_propagates(self, monkeypatch, tmp_path, capsys):
        """A materials.xml parse failure is logged and re-raised."""
        fake_openmc = _install_fake_openmc(monkeypatch)
        fake_openmc.Materials = SimpleNamespace(
            from_xml=lambda path: (_ for _ in ()).throw(RuntimeError("bad xml"))
        )
        workdir = _workdir(tmp_path)

        with pytest.raises(RuntimeError, match="bad xml"):
            run_depletion.run_depletion(_args(workdir, chain_file="ignored"))

        assert "Error loading XML files: bad xml" in capsys.readouterr().err
