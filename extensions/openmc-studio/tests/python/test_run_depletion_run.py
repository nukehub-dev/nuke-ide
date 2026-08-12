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
        "PredictorIntegrator",
        "CF4Integrator",
        "CELIIntegrator",
        "EPCRK4Integrator",
        "LEQIIntegrator",
        "SICELIIntegrator",
        "SILEQIIntegrator",
    ),
):
    """Insert stub openmc/openmc.deplete modules; returns the fake openmc."""
    if geometry is None:
        geometry = SimpleNamespace(
            root_universe=SimpleNamespace(),
            get_all_universes=lambda: {},
        )

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
        # Distinct subclass per integrator so tests can tell which class was used
        setattr(fake_deplete, name, type(name, (RecordingIntegrator,), {}))
    fake_openmc.deplete = fake_deplete

    RecordingOperator.instances = []
    RecordingIntegrator.instances = []
    RecordingIntegrator.fail_on_integrate = False

    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)
    return fake_openmc


def _workdir(tmp_path, settings_xml="<settings></settings>", tallies_xml=None, materials_xml=None):
    """Create a working directory with the XML files run_depletion parses."""
    workdir = tmp_path / "model"
    workdir.mkdir()
    (workdir / "settings.xml").write_text(settings_xml)
    if tallies_xml is not None:
        (workdir / "tallies.xml").write_text(tallies_xml)
    if materials_xml is not None:
        (workdir / "materials.xml").write_text(materials_xml)
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
        # Force h5py absence so the burnup-append step only warns in any environment.
        monkeypatch.setitem(sys.modules, "h5py", None)
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
        # h5py is forced absent above -> the burnup-append step only warns.
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
        geometry = SimpleNamespace(root_universe=None, get_all_universes=lambda: {})
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
            ("predictor", "PredictorIntegrator"),
            ("cf4", "CF4Integrator"),
            ("celi", "CELIIntegrator"),
            ("epc_rk4", "EPCRK4Integrator"),
            ("leqi", "LEQIIntegrator"),
            ("si_celi", "SICELIIntegrator"),
            ("si_leqi", "SILEQIIntegrator"),
        ],
    )
    def test_solver_name_mapping(
        self, monkeypatch, tmp_path, chain_file, solver, expected_class, capsys
    ):
        """Every canonical solver maps to its integrator class."""
        fake = _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file, solver=solver))

        assert result["success"] is True
        assert result["solver"] == solver
        assert f"Creating {solver.upper()} integrator" in capsys.readouterr().err
        (integrator,) = RecordingIntegrator.instances
        assert isinstance(integrator, getattr(fake.deplete, expected_class))

    @pytest.mark.parametrize(
        "alias,canonical",
        [
            ("leapfrog", "leqi"),
            ("predictor-corrector", "predictor"),
            ("si-rk4", "si_celi"),
            ("epc", "epc_rk4"),
            ("cecmr", "cecm"),
            ("epcr", "epc_rk4"),
            ("si-cesc", "si_celi"),
        ],
    )
    def test_solver_legacy_aliases(
        self, monkeypatch, tmp_path, chain_file, alias, canonical, capsys
    ):
        """Legacy solver names map to canonical ids with a deprecation warning."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file, solver=alias))

        assert result["success"] is True
        assert result["solver"] == canonical
        err = capsys.readouterr().err
        assert f"solver '{alias}' is deprecated, use '{canonical}' instead" in err
        assert f"Creating {canonical.upper()} integrator" in err


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
    def test_independent_operator_requires_flux_inputs(self, monkeypatch, tmp_path, chain_file):
        """The independent operator raises ValueError without flux/MicroXS inputs."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="one flux file and one MicroXS file"):
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


# ---------------------------------------------------------------------------
# Multi-group / coupled guard and operator-construction wrapping
# ---------------------------------------------------------------------------

_MG_SETTINGS = (
    "<settings><run_mode>eigenvalue</run_mode><energy_mode>multi-group</energy_mode></settings>"
)


class TestMultigroupCoupledGuard:
    def test_multi_group_coupled_is_a_clean_config_error(self, monkeypatch, tmp_path):
        """MG project + coupled operator fails before any openmc import."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path, settings_xml=_MG_SETTINGS)

        with pytest.raises(
            run_depletion.DepletionConfigError,
            match="Coupled depletion requires continuous-energy mode",
        ):
            run_depletion.run_depletion(_args(workdir))

    def test_multi_group_openmc_operator_is_also_blocked(self, monkeypatch, tmp_path):
        """The 'openmc' operator path builds a CoupledOperator too — same guard."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path, settings_xml=_MG_SETTINGS)

        with pytest.raises(run_depletion.DepletionConfigError, match="multi-group"):
            run_depletion.run_depletion(_args(workdir, operator="openmc"))

    def test_multi_group_independent_passes_the_guard(self, monkeypatch, tmp_path, chain_file):
        """The independent operator is allowed in multi-group mode."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        sentinel_operator = SimpleNamespace()
        monkeypatch.setattr(
            run_depletion, "build_independent_operator", lambda *a, **k: sentinel_operator
        )
        workdir = _workdir(tmp_path, settings_xml=_MG_SETTINGS)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, operator="independent")
        )

        assert result["success"] is True
        assert result["operator"] == "independent"
        (integrator,) = RecordingIntegrator.instances
        assert integrator.operator is sentinel_operator

    def test_operator_construction_errors_are_wrapped(self, monkeypatch, tmp_path, chain_file):
        """A failure inside operator construction surfaces as a clean config error."""
        fake_openmc = _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        fake_openmc.deplete.Chain = SimpleNamespace(
            from_xml=lambda path: (_ for _ in ()).throw(RuntimeError("Start tag expected"))
        )
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError,
            match="Failed to create the depletion operator: Start tag expected",
        ):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

    def test_ce_mode_mg_library_reference_falls_back_to_env(
        self, monkeypatch, tmp_path, chain_file, capsys
    ):
        """CE mode with an MG library in materials.xml clears it for openmc.config."""

        class FakeMaterials(list):
            pass

        mats = FakeMaterials([FakeMaterial("fuel")])
        mats.cross_sections = "/data/mgxs.h5"
        fake_openmc = _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        fake_openmc.Materials = SimpleNamespace(from_xml=lambda path: mats)
        monkeypatch.setenv("OPENMC_CROSS_SECTIONS", "/data/cross_sections.xml")
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        assert mats.cross_sections is None
        assert "is not a CE library" in capsys.readouterr().err

    def test_multi_group_generate_microxs_is_a_clean_config_error(self, monkeypatch, tmp_path):
        """MG project + independent + --generate-microxs needs CE mode."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path, settings_xml=_MG_SETTINGS)

        with pytest.raises(
            run_depletion.DepletionConfigError,
            match="MicroXS generation requires continuous-energy mode",
        ):
            run_depletion.run_depletion(
                _args(workdir, operator="independent", generate_microxs=True)
            )

    def test_macroscopic_depletable_is_a_clean_config_error(self, monkeypatch, tmp_path):
        """A depletable macroscopic material can never deplete (any mode)."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(
            tmp_path,
            materials_xml=(
                '<materials><material id="1" name="fuel" depletable="true">'
                '<macroscopic name="fuel"/></material></materials>'
            ),
        )

        with pytest.raises(
            run_depletion.DepletionConfigError,
            match="Depletion requires nuclide-decomposed materials",
        ):
            run_depletion.run_depletion(_args(workdir))


# ---------------------------------------------------------------------------
# DAGMC depletion sync
# ---------------------------------------------------------------------------


class FakeDAGMCCell:
    """Fake openmc.DAGMCCell (cell_id + fill)."""

    def __init__(self, cell_id=None, fill=None):
        self.id = cell_id
        self.fill = fill


class FakeDAGMCUniverse:
    """Fake openmc.DAGMCUniverse: id + cells dict + add_cell."""

    def __init__(self, uid):
        self.id = uid
        self.cells = {}

    def add_cell(self, cell):
        self.cells[cell.id] = cell


def _dagmc_geometry(universe, paths_called):
    """Fake geometry carrying one DAGMC universe."""

    def determine_paths():
        paths_called.append(True)

    return SimpleNamespace(
        root_universe=SimpleNamespace(),
        get_all_universes=lambda: {universe.id: universe},
        determine_paths=determine_paths,
    )


def _dagmc_model(fake_openmc, geometry, materials, sync_error=None):
    """Fake Model with init_lib/sync/finalize tracking."""

    class FakeModel:
        def __init__(self, geometry, materials, settings):
            self.geometry = geometry
            self.materials = materials
            self.settings = settings
            self.lib_initialized = False
            self.lib_finalized = False
            self.upstream_sync_called = False

        def init_lib(self, output=False):
            self.lib_initialized = True

        def finalize_lib(self):
            self.lib_finalized = True

        def sync_dagmc_universes(self):
            self.upstream_sync_called = True
            if sync_error is not None:
                raise sync_error
            # Upstream success: populate nothing else needed here; tests that
            # exercise the success path pre-fill via their own fake lib too.

    fake_openmc.model = SimpleNamespace(Model=FakeModel)
    return FakeModel


def _fake_lib(monkeypatch, cell_fills):
    """Install a fake openmc.lib; cell_fills maps cell_id -> fill (material-like or None)."""
    fake_lib = types.ModuleType("openmc.lib")
    fake_lib.is_initialized = True
    fake_lib.dagmc = SimpleNamespace(dagmc_universe_cell_ids=lambda uid: sorted(cell_fills))
    fake_lib.cells = {cid: SimpleNamespace(fill=fill) for cid, fill in cell_fills.items()}
    monkeypatch.setitem(sys.modules, "openmc.lib", fake_lib)
    # A real `import openmc.lib` also sets the attribute on the parent package
    sys.modules["openmc"].lib = fake_lib
    return fake_lib


class TestDagmcDepletionSync:
    """DAGMC models must be synchronized before CoupledOperator creation."""

    def _materials(self):
        mats = [FakeMaterial("mat_0"), FakeMaterial("mat_1")]
        mats[0].id = 1
        mats[1].id = 2
        return mats

    def test_upstream_sync_failure_falls_back_to_lib_enumeration(
        self, monkeypatch, tmp_path, chain_file, capsys
    ):
        """pymoab-layout .h5m breaks sync_dagmc_universes; lib fallback populates cells."""
        universe = FakeDAGMCUniverse(1)
        paths_called = []
        geometry = _dagmc_geometry(universe, paths_called)
        materials = self._materials()
        fake_openmc = _install_fake_openmc(monkeypatch, materials=materials, geometry=geometry)
        fake_openmc.DAGMCUniverse = FakeDAGMCUniverse
        fake_openmc.DAGMCCell = FakeDAGMCCell
        _dagmc_model(fake_openmc, geometry, materials, sync_error=KeyError("values"))
        _fake_lib(monkeypatch, {10: SimpleNamespace(id=1), 11: SimpleNamespace(id=2)})
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        # Cells came from the lib fallback with fills resolved by material id
        assert set(universe.cells) == {10, 11}
        assert universe.cells[10].fill is materials[0]
        assert universe.cells[11].fill is materials[1]
        assert paths_called == [True]
        # init_lib/finalize_lib bracket the sync even on failure
        model = RecordingOperator.instances[0].model
        assert model.lib_initialized and model.lib_finalized and model.upstream_sync_called
        assert "falling back to direct lib cell enumeration" in capsys.readouterr().err

    def test_upstream_sync_success_skips_the_fallback(self, monkeypatch, tmp_path, chain_file):
        """When sync_dagmc_universes works, no lib enumeration is needed."""
        universe = FakeDAGMCUniverse(1)
        paths_called = []
        geometry = _dagmc_geometry(universe, paths_called)
        materials = self._materials()
        fake_openmc = _install_fake_openmc(monkeypatch, materials=materials, geometry=geometry)
        fake_openmc.DAGMCUniverse = FakeDAGMCUniverse
        fake_openmc.DAGMCCell = FakeDAGMCCell

        def populate(model):
            universe.add_cell(FakeDAGMCCell(cell_id=10, fill=materials[0]))

        model_cls = _dagmc_model(fake_openmc, geometry, materials)
        # Emulate the upstream sync populating the universe
        original_sync = model_cls.sync_dagmc_universes

        def sync_and_populate(self):
            original_sync(self)
            populate(self)

        model_cls.sync_dagmc_universes = sync_and_populate
        # No openmc.lib installed: reaching the fallback would raise
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        assert set(universe.cells) == {10}
        assert paths_called == [True]

    def test_already_synchronized_universe_skips_lib_entirely(
        self, monkeypatch, tmp_path, chain_file
    ):
        """A geometry.xml that already carries DAGMC cell overrides needs no init_lib."""
        universe = FakeDAGMCUniverse(1)
        materials = self._materials()
        universe.add_cell(FakeDAGMCCell(cell_id=10, fill=materials[0]))
        paths_called = []
        geometry = _dagmc_geometry(universe, paths_called)
        fake_openmc = _install_fake_openmc(monkeypatch, materials=materials, geometry=geometry)
        fake_openmc.DAGMCUniverse = FakeDAGMCUniverse
        fake_openmc.DAGMCCell = FakeDAGMCCell
        _dagmc_model(fake_openmc, geometry, materials)
        # No openmc.lib installed: any lib access would raise
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        assert result["success"] is True
        model = RecordingOperator.instances[0].model
        assert model.lib_initialized is False
        assert paths_called == []  # instances already valid on synced models

    def test_non_dagmc_models_never_touch_lib(self, monkeypatch, tmp_path, chain_file):
        """Plain CSG models skip the whole DAGMC path (no openmc.lib import)."""
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

        # Success despite openmc.lib being unimportable with the stub openmc
        assert result["success"] is True
