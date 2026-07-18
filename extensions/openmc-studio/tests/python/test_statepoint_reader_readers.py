"""Tests for statepoint_reader readers using stub openmc/h5py modules.

openmc and h5py are not installed in the test environment, so the reader
functions are exercised against lightweight stubs inserted into sys.modules.
The stubs mimic only the small API surface the readers actually use
(StatePoint, deplete.Results, h5py.File); no real HDF5 files are parsed.
"""

import json
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

import statepoint_reader
from statepoint_reader import (
    compare_statepoints,
    read_depletion_results,
    read_statepoint,
)

# ---------------------------------------------------------------------------
# Stub builders
# ---------------------------------------------------------------------------


class FakeFilter:
    """Fake tally filter exposing a bins list."""

    def __init__(self, bins):
        self.bins = bins


class FakeTally:
    """Fake openmc Tally with mean/std_dev arrays and optional filters."""

    def __init__(self, name="flux_tally", mean=None, std=None, filters=None):
        self.name = name
        self.scores = ["flux"]
        self.nuclides = ["total"]
        self.mean = np.array(mean if mean is not None else [[1.0, 2.0]])
        self.std_dev = np.array(std if std is not None else [[0.1, 0.2]])
        self.filters = filters if filters is not None else [FakeFilter([1, 2, 3])]


class FakeStatePoint:
    """Fake openmc.StatePoint for an eigenvalue run with one tally."""

    run_mode = "eigenvalue"

    def __init__(self, path):
        self.path = path
        self.k_combined = SimpleNamespace(nominal_value=1.05, std_dev=0.002)
        self.n_batches = 150
        self.n_inactive = 50
        self.n_particles = 10000
        self.k_generation = [
            SimpleNamespace(nominal_value=1.04, std_dev=0.01),
            SimpleNamespace(nominal_value=1.05),
            1.06,
        ]
        self.tallies = {1: FakeTally()}
        self.version = (0, 14, 0)
        self.date_and_time = "2024-01-02 03:04:05"
        self.entropy = [3.5, 3.6]
        self.source = [object(), object()]
        self.closed = False

    def close(self):
        self.closed = True


def _install_statepoint_stubs(monkeypatch, sp_factory=None, h5py_file=None):
    """Insert stub openmc/h5py modules into sys.modules."""
    fake_openmc = types.ModuleType("openmc")
    if sp_factory is not None:
        fake_openmc.StatePoint = sp_factory
    fake_h5py = types.ModuleType("h5py")
    if h5py_file is not None:
        fake_h5py.File = h5py_file
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "h5py", fake_h5py)
    return fake_openmc


# ---------------------------------------------------------------------------
# read_statepoint
# ---------------------------------------------------------------------------


class TestReadStatepoint:
    def test_success_full_eigenvalue(self, monkeypatch, tmp_path):
        """A full eigenvalue statepoint yields k-eff, batches, and tallies."""
        _install_statepoint_stubs(monkeypatch, sp_factory=FakeStatePoint)
        f = tmp_path / "statepoint.100.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is True
        assert result["fileName"] == "statepoint.100.h5"
        assert result["fileSizeMB"] == 0.0
        assert result["kEff"] == {"value": 1.05, "stdDev": 0.002}
        assert result["batches"] == 150
        assert result["inactiveBatches"] == 50
        assert result["particles"] == 10000

        by_batch = result["kEffectiveByBatch"]
        # Uncertainties objects with/without std_dev and plain floats all work.
        assert by_batch[0] == {"batch": 1, "value": 1.04, "stdDev": 0.01}
        assert by_batch[1] == {"batch": 2, "value": 1.05, "stdDev": 0.0}
        assert by_batch[2] == {"batch": 3, "value": 1.06, "stdDev": 0.0}

        assert result["runMode"] == "eigenvalue"
        assert result["version"] == "(0, 14, 0)"
        assert result["date"] == "2024-01-02 03:04:05"
        assert result["entropy"] == [3.5, 3.6]
        assert result["sourceParticles"] == 2

        (tally,) = result["tallies"]
        assert tally["id"] == 1
        assert tally["name"] == "flux_tally"
        assert tally["scores"] == ["flux"]
        assert tally["nuclides"] == ["total"]
        assert tally["mean"] == [1.0, 2.0]
        assert tally["stdDev"] == [0.1, 0.2]
        assert tally["totalBins"] == 2
        assert tally["filters"] == [{"type": "FakeFilter", "bins": 3}]

    def test_success_non_eigenvalue_has_no_keff(self, monkeypatch, tmp_path):
        """A fixed-source run produces no kEff/batch keys."""

        class FixedSourceSP(FakeStatePoint):
            run_mode = "fixed source"

        _install_statepoint_stubs(monkeypatch, sp_factory=FixedSourceSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is True
        assert "kEff" not in result
        assert "kEffectiveByBatch" not in result
        assert result["runMode"] == "fixed source"

    def test_missing_optional_attributes(self, monkeypatch, tmp_path):
        """A bare statepoint object still produces a success dict."""

        class BareSP:
            run_mode = "eigenvalue"
            k_combined = SimpleNamespace(nominal_value=0.99, std_dev=0.01)
            k_generation = None
            tallies = {}

            def __init__(self, path):
                pass

            def close(self):
                pass

        _install_statepoint_stubs(monkeypatch, sp_factory=BareSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is True
        assert "batches" not in result
        assert "kEffectiveByBatch" not in result
        assert result["tallies"] == []
        assert result["runMode"] == "eigenvalue"
        assert result["version"] == "unknown"
        assert result["date"] is None

    def test_flaky_metadata_falls_back(self, monkeypatch, tmp_path):
        """Metadata attributes that raise fall back to safe defaults."""

        class FlakySP(FakeStatePoint):
            def __init__(self, path):
                # Deliberately skip super().__init__: the property overrides
                # below conflict with the instance attributes it sets.
                self.k_combined = SimpleNamespace(nominal_value=1.05, std_dev=0.002)
                self.n_batches = 150
                self.n_inactive = 50
                self.n_particles = 10000
                self.k_generation = None
                self.tallies = {}
                self._run_mode_calls = 0

            @property
            def run_mode(self):
                # First access (eigenvalue check) works, later access raises.
                self._run_mode_calls += 1
                if self._run_mode_calls == 1:
                    return "eigenvalue"
                raise RuntimeError("run_mode unavailable")

            @property
            def version(self):
                raise RuntimeError("version unavailable")

            @property
            def date_and_time(self):
                raise RuntimeError("date unavailable")

            @property
            def entropy(self):
                raise RuntimeError("entropy unavailable")

            @property
            def source(self):
                raise RuntimeError("source unavailable")

        _install_statepoint_stubs(monkeypatch, sp_factory=FlakySP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is True
        assert result["runMode"] == "unknown"
        assert result["version"] == "unknown"
        assert result["date"] is None
        assert "entropy" not in result
        assert "sourceParticles" not in result

    def test_tally_read_error_is_captured(self, monkeypatch, tmp_path):
        """A tally whose mean raises lands in the tally's error field."""

        class BadTally:
            name = "bad"
            scores = ["flux"]
            nuclides = ["total"]

            @property
            def mean(self):
                raise RuntimeError("sum not loaded")

        class SP(FakeStatePoint):
            def __init__(self, path):
                super().__init__(path)
                self.tallies = {4: BadTally()}

        _install_statepoint_stubs(monkeypatch, sp_factory=SP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is True
        assert result["tallies"][0]["error"] == "sum not loaded"
        assert "mean" not in result["tallies"][0]

    def test_tally_scalar_mean_and_missing_attrs(self, monkeypatch, tmp_path):
        """Scalar means and missing tally attrs use list/scalar fallbacks."""

        class ScalarTally:
            # No name/scores/nuclides/filters attributes at all.
            mean = 2.5
            std_dev = 0.5

        class SP(FakeStatePoint):
            def __init__(self, path):
                super().__init__(path)
                self.tallies = {7: ScalarTally()}

        _install_statepoint_stubs(monkeypatch, sp_factory=SP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        (tally,) = result["tallies"]
        assert tally["name"] is None
        assert tally["scores"] == []
        assert tally["nuclides"] == ["total"]
        assert tally["mean"] == [2.5]
        assert tally["stdDev"] == [0.5]
        assert tally["totalBins"] == 1
        assert "filters" not in tally

    def test_not_hdf5_suffix_rejected(self, monkeypatch, tmp_path):
        """A non-.h5 suffix is rejected before openmc is used."""
        _install_statepoint_stubs(monkeypatch, sp_factory=FakeStatePoint)
        f = tmp_path / "statepoint.txt"
        f.write_bytes(b"fake")
        result = read_statepoint(str(f))
        assert result["success"] is False
        assert result["error"].startswith("Not an HDF5 file:")

    def test_corrupted_hdf5_oserror(self, monkeypatch, tmp_path):
        """A 'bad object header' OSError yields the corruption message."""

        class CorruptSP:
            def __init__(self, path):
                raise OSError("bad object header version number")

        _install_statepoint_stubs(monkeypatch, sp_factory=CorruptSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is False
        assert "corrupted" in result["error"]
        assert "traceback" in result

    def test_unopenable_hdf5_oserror(self, monkeypatch, tmp_path):
        """An 'Unable to open' OSError yields the cannot-open message."""

        class UnopenableSP:
            def __init__(self, path):
                raise OSError("Unable to open file (file signature not found)")

        _install_statepoint_stubs(monkeypatch, sp_factory=UnopenableSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is False
        assert result["error"].startswith("Cannot open HDF5 file:")

    def test_generic_oserror(self, monkeypatch, tmp_path):
        """Any other OSError yields the generic HDF5 error message."""

        class OSErrorSP:
            def __init__(self, path):
                raise OSError("disk quota exceeded")

        _install_statepoint_stubs(monkeypatch, sp_factory=OSErrorSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is False
        assert result["error"].startswith("HDF5 error: disk quota exceeded")

    def test_generic_exception(self, monkeypatch, tmp_path):
        """A non-OSError failure yields the generic read-failure message."""

        class ValueErrorSP:
            def __init__(self, path):
                raise ValueError("weird statepoint")

        _install_statepoint_stubs(monkeypatch, sp_factory=ValueErrorSP)
        f = tmp_path / "sp.h5"
        f.write_bytes(b"fake")

        result = read_statepoint(str(f))

        assert result["success"] is False
        assert result["error"] == "Failed to read statepoint: weird statepoint"
        assert "traceback" in result


# ---------------------------------------------------------------------------
# read_depletion_results
# ---------------------------------------------------------------------------


class FakeDepletionMaterial:
    """Fake depletion material with nuclides and densities."""

    def __init__(self, mid=1, name="fuel"):
        self.id = mid
        self.name = name

    def get_nuclides(self):
        return ["U235", "Xe135"]

    def get_nuclide_densities(self):
        return {"U235": SimpleNamespace(percent=1.0e24), "Xe135": 5.0e18}


class FakeDepletionStep:
    """One time step of a fake openmc.deplete.Results."""

    def __init__(self, k=(1.0, 0.01), mat_to_name=None):
        self.k = k
        self.mat_to_name = mat_to_name if mat_to_name is not None else {"1": "fuel"}
        self._material = FakeDepletionMaterial()

    def get_material(self, mat_id):
        if mat_id == "ghost":
            return None
        return self._material


class FakeDepletionResults:
    """Fake openmc.deplete.Results with three time steps."""

    def __init__(self, steps=None):
        self._steps = steps if steps is not None else [FakeDepletionStep() for _ in range(3)]

    @classmethod
    def from_hdf5(cls, path):
        return cls()

    def __len__(self):
        return len(self._steps)

    def __iter__(self):
        return iter(self._steps)

    def __getitem__(self, idx):
        return self._steps[idx]

    def get_times(self, time_units="s"):
        return np.array([0.0, 86400.0, 172800.0])

    def get_keff(self, time_units="s"):
        return (np.array([0.0, 86400.0, 172800.0]), [[1.0, 0.01], [1.01], 1.02])

    def get_atoms(self, mat, nuc, nuc_units="atoms", time_units="s"):
        if nuc == "Xe135":
            raise RuntimeError("no atoms endpoint")
        if nuc == "zero":
            return (np.array([0.0, 1.0, 2.0]), np.array([0.0, 0.0, 0.0]))
        return (np.array([0.0, 1.0, 2.0]), np.array([1.0e24, 9.0e23, 8.0e23]))


class FakeH5File:
    """Context-manager fake for h5py.File with numpy-array datasets."""

    def __init__(self, datasets):
        self._datasets = datasets

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def __contains__(self, key):
        return key in self._datasets

    def __getitem__(self, key):
        return self._datasets[key]


def _install_depletion_stubs(monkeypatch, results_factory=None, h5py_file=None):
    """Insert stub openmc/openmc.deplete/h5py modules into sys.modules."""
    fake_openmc = types.ModuleType("openmc")
    fake_deplete = types.ModuleType("openmc.deplete")
    if results_factory is not None:
        fake_deplete.Results = results_factory
    fake_openmc.deplete = fake_deplete
    fake_h5py = types.ModuleType("h5py")
    if h5py_file is not None:
        fake_h5py.File = h5py_file
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)
    monkeypatch.setitem(sys.modules, "h5py", fake_h5py)
    return fake_openmc


class TestReadDepletionResults:
    def test_success_full(self, monkeypatch, tmp_path):
        """Time steps, burnup, k-eff, and nuclide evolution are extracted."""
        h5 = FakeH5File({"burnup": np.array([0.5, 1.0])})
        _install_depletion_stubs(
            monkeypatch,
            results_factory=FakeDepletionResults,
            h5py_file=lambda path, mode: h5,
        )
        f = tmp_path / "depletion_results.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert result["fileName"] == "depletion_results.h5"
        assert result["timeSteps"] == [0.0, 86400.0, 172800.0]
        # The burnup dataset misses the initial step, so 0.0 is prepended.
        assert result["burnupSteps"] == [0.0, 0.5, 1.0]
        assert result["finalBurnup"] == 1.0

        keff = result["keff"]
        # Rows: [nominal, std], single-element row, and a scalar row.
        assert keff[0] == {"value": 1.0, "stdDev": 0.01}
        assert keff[1] == {"value": 1.01, "stdDev": 0.0}
        assert keff[2] == {"value": 1.02, "stdDev": 0.0}

        assert result["numberOfMaterials"] == 1
        mat = result["materials"]["1"]
        assert mat["name"] == "fuel"
        u235 = mat["nuclides"]["U235"]
        assert u235["initial"] == 1.0e24
        assert u235["final"] == 8.0e23
        assert u235["min"] == 8.0e23
        assert u235["max"] == 1.0e24
        assert u235["concentrations"] == [1.0e24, 9.0e23, 8.0e23]
        # Xe135 fell back to per-step get_nuclide_densities extraction.
        xe135 = mat["nuclides"]["Xe135"]
        assert xe135["concentrations"] == [5.0e18, 5.0e18, 5.0e18]

    def test_burnup_without_initial_gap(self, monkeypatch, tmp_path):
        """A full-length burnup dataset is used as-is."""
        h5 = FakeH5File({"burnup": np.array([0.1, 0.5, 1.0])})
        _install_depletion_stubs(
            monkeypatch,
            results_factory=FakeDepletionResults,
            h5py_file=lambda path, mode: h5,
        )
        f = tmp_path / "depletion_results.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["burnupSteps"] == [0.1, 0.5, 1.0]
        assert result["finalBurnup"] == 1.0

    def test_no_burnup_dataset(self, monkeypatch, tmp_path):
        """Without a burnup dataset, no burnup keys are produced."""
        _install_depletion_stubs(
            monkeypatch,
            results_factory=FakeDepletionResults,
            h5py_file=lambda path, mode: FakeH5File({}),
        )
        f = tmp_path / "depletion_results.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert "burnupSteps" not in result
        assert "finalBurnup" not in result

    def test_h5py_failure_is_swallowed(self, monkeypatch, tmp_path):
        """An h5py failure only skips the burnup extraction."""

        def bad_h5(path, mode):
            raise OSError("h5 blew up")

        _install_depletion_stubs(
            monkeypatch, results_factory=FakeDepletionResults, h5py_file=bad_h5
        )
        f = tmp_path / "depletion_results.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert "burnupSteps" not in result

    def test_get_times_list_and_empty(self, monkeypatch, tmp_path):
        """Plain-list and empty get_times results are both handled."""

        class ListTimes(FakeDepletionResults):
            def get_times(self, time_units="s"):
                return [0.0, 100.0]

        _install_depletion_stubs(monkeypatch, results_factory=ListTimes)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")
        result = read_depletion_results(str(f))
        assert result["timeSteps"] == [0.0, 100.0]

        class EmptyTimes(FakeDepletionResults):
            def get_times(self, time_units="s"):
                return []

        _install_depletion_stubs(monkeypatch, results_factory=EmptyTimes)
        result = read_depletion_results(str(f))
        assert "timeSteps" not in result

    def test_keff_fallback_to_per_step_k(self, monkeypatch, tmp_path):
        """When get_keff fails, k is read from each result step."""

        class NoKeffResults(FakeDepletionResults):
            def __init__(self):
                steps = [
                    FakeDepletionStep(k=[1.0, 0.005]),
                    FakeDepletionStep(k=1.01),
                    FakeDepletionStep(k=None),
                ]

                # A step whose k access raises yields a 0.0 entry.
                class BadK:
                    mat_to_name = {"1": "fuel"}

                    def get_material(self, mid):
                        return FakeDepletionMaterial()

                    @property
                    def k(self):
                        raise RuntimeError("no k")

                super().__init__(steps=steps + [BadK()])

            def get_keff(self, time_units="s"):
                raise RuntimeError("no keff endpoint")

        _install_depletion_stubs(monkeypatch, results_factory=NoKeffResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert result["keff"] == [
            {"value": 1.0, "stdDev": 0.005},
            {"value": 1.01, "stdDev": 0.0},
            {"value": 0.0, "stdDev": 0.0},
            {"value": 0.0, "stdDev": 0.0},
        ]

    def test_keff_fallback_all_zero_omitted(self, monkeypatch, tmp_path):
        """A fallback where every k is zero produces no keff key."""

        class ZeroKResults(FakeDepletionResults):
            def __init__(self):
                super().__init__(steps=[FakeDepletionStep(k=None)])

            def get_keff(self, time_units="s"):
                raise RuntimeError("no keff endpoint")

        _install_depletion_stubs(monkeypatch, results_factory=ZeroKResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert "keff" not in result

    def test_atoms_fallback_with_missing_nuclide(self, monkeypatch, tmp_path):
        """The per-step fallback records 0.0 for absent nuclides."""

        class SparseMaterial(FakeDepletionMaterial):
            def get_nuclides(self):
                return ["U235", "Pu239"]

            def get_nuclide_densities(self):
                return {"U235": 1.0e24}

        class SparseStep(FakeDepletionStep):
            def __init__(self):
                super().__init__()
                self._material = SparseMaterial()

        class SparseResults(FakeDepletionResults):
            def __init__(self):
                super().__init__(steps=[SparseStep(), SparseStep()])

            def get_atoms(self, mat, nuc, nuc_units="atoms", time_units="s"):
                raise RuntimeError("no atoms endpoint")

        _install_depletion_stubs(monkeypatch, results_factory=SparseResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        nucs = result["materials"]["1"]["nuclides"]
        assert nucs["U235"]["concentrations"] == [1.0e24, 1.0e24]
        # Pu239 is absent from every step's densities -> all zeros -> omitted.
        assert "Pu239" not in nucs

    def test_get_material_none_skips_material(self, monkeypatch, tmp_path):
        """Materials whose lookup returns None are skipped silently."""

        class GhostStep(FakeDepletionStep):
            def __init__(self):
                super().__init__(mat_to_name={"ghost": "ghost_mat"})

        class GhostResults(FakeDepletionResults):
            def __init__(self):
                super().__init__(steps=[GhostStep()])

        _install_depletion_stubs(monkeypatch, results_factory=GhostResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert result["materials"] == {}
        assert result["numberOfMaterials"] == 0

    def test_material_without_name_uses_id(self, monkeypatch, tmp_path):
        """A material with an empty mapping/fallback name displays its id."""

        class NamelessMaterial(FakeDepletionMaterial):
            def __init__(self):
                super().__init__(mid=7, name="")

        class NamelessStep(FakeDepletionStep):
            def __init__(self):
                super().__init__(mat_to_name={"7": ""})
                self._material = NamelessMaterial()

        class NamelessResults(FakeDepletionResults):
            def __init__(self):
                super().__init__(steps=[NamelessStep()])

        _install_depletion_stubs(monkeypatch, results_factory=NamelessResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["materials"]["7"]["name"] == "7"

    def test_first_result_failure_sets_nuclide_error(self, monkeypatch, tmp_path):
        """If the first result cannot be read, nuclideError is recorded."""

        class ExplodingResults(FakeDepletionResults):
            def __getitem__(self, idx):
                raise RuntimeError("no first result")

        _install_depletion_stubs(monkeypatch, results_factory=ExplodingResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is True
        assert result["nuclideError"] == "no first result"
        assert result["materials"] == {}

    def test_per_step_material_lookup_failure_gives_zero(self, monkeypatch, tmp_path):
        """A failing per-step get_material yields 0.0 concentrations."""

        class FlakyStep(FakeDepletionStep):
            def __init__(self, fail):
                super().__init__()
                self._fail = fail

            def get_material(self, mat_id):
                if self._fail:
                    raise RuntimeError("step corrupt")
                return self._material

        class FlakyResults(FakeDepletionResults):
            def __init__(self):
                super().__init__(steps=[FlakyStep(False), FlakyStep(True)])

            def get_atoms(self, mat, nuc, nuc_units="atoms", time_units="s"):
                raise RuntimeError("no atoms endpoint")

        _install_depletion_stubs(monkeypatch, results_factory=FlakyResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        nucs = result["materials"]["1"]["nuclides"]
        assert nucs["U235"]["concentrations"] == [1.0e24, 0.0]

    def test_oserror_from_hdf5(self, monkeypatch, tmp_path):
        """An OSError from Results.from_hdf5 yields the HDF5 error dict."""

        class OSErrorResults:
            @classmethod
            def from_hdf5(cls, path):
                raise OSError("truncated file")

        _install_depletion_stubs(monkeypatch, results_factory=OSErrorResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is False
        assert result["error"] == "HDF5 error: truncated file"
        assert "traceback" in result

    def test_generic_exception(self, monkeypatch, tmp_path):
        """A non-OSError failure yields the generic depletion error dict."""

        class ValueErrorResults:
            @classmethod
            def from_hdf5(cls, path):
                raise ValueError("bogus results")

        _install_depletion_stubs(monkeypatch, results_factory=ValueErrorResults)
        f = tmp_path / "d.h5"
        f.write_bytes(b"fake")

        result = read_depletion_results(str(f))

        assert result["success"] is False
        assert result["error"] == "Failed to read depletion results: bogus results"


# ---------------------------------------------------------------------------
# compare_statepoints (read_statepoint stubbed at module level)
# ---------------------------------------------------------------------------


def _sp_result(name, keff=None, tallies=None):
    """Build a synthetic successful read_statepoint result."""
    result = {"success": True, "fileName": name, "filePath": f"/tmp/{name}"}
    if keff is not None:
        result["kEff"] = {"value": keff[0], "stdDev": keff[1]}
    if tallies is not None:
        result["tallies"] = tallies
    return result


class TestCompareStatepoints:
    def test_comparison_statistics(self, monkeypatch):
        """k-eff stats and shared tallies are computed across files."""
        fake_results = {
            "a.h5": _sp_result(
                "a.h5",
                keff=(1.0, 0.01),
                tallies=[{"id": 1, "mean": [10.0]}, {"id": 2, "mean": [5.0]}],
            ),
            "b.h5": _sp_result(
                "b.h5",
                keff=(1.02, 0.01),
                tallies=[{"id": 1, "mean": [11.0]}],
            ),
            "c.h5": {"success": False, "error": "missing"},
        }
        monkeypatch.setattr(statepoint_reader, "read_statepoint", lambda path: fake_results[path])

        result = compare_statepoints(["a.h5", "b.h5", "c.h5"])

        assert result["success"] is True
        assert len(result["statepoints"]) == 2
        assert result["errors"] == [{"file": "c.h5", "error": "missing"}]

        keff = result["comparison"]["kEff"]
        assert keff["values"] == [1.0, 1.02]
        assert keff["mean"] == pytest.approx(1.01)
        assert keff["min"] == 1.0
        assert keff["max"] == 1.02
        assert keff["range"] == pytest.approx(0.02)

        tallies = result["comparison"]["tallies"]
        # Tally 1 is shared by both files; tally 2 only appears in a.h5.
        assert set(tallies) == {"tally_1", "tally_2"}
        assert [e["file"] for e in tallies["tally_1"]] == ["a.h5", "b.h5"]
        assert [e["file"] for e in tallies["tally_2"]] == ["a.h5"]
        assert tallies["tally_1"][0]["tally"]["mean"] == [10.0]

    def test_statepoints_without_keff_are_skipped(self, monkeypatch):
        """Files lacking kEff do not contribute to the k-eff statistics."""
        fake_results = {
            "a.h5": _sp_result("a.h5", keff=(1.0, 0.01)),
            "b.h5": _sp_result("b.h5"),
        }
        monkeypatch.setattr(statepoint_reader, "read_statepoint", lambda path: fake_results[path])

        result = compare_statepoints(["a.h5", "b.h5"])

        assert result["success"] is True
        assert result["comparison"]["kEff"]["values"] == [1.0]

    def test_no_keff_anywhere_omits_keff_block(self, monkeypatch):
        """With no kEff values at all, the comparison has no kEff key."""
        fake_results = {"a.h5": _sp_result("a.h5"), "b.h5": _sp_result("b.h5")}
        monkeypatch.setattr(statepoint_reader, "read_statepoint", lambda path: fake_results[path])

        result = compare_statepoints(["a.h5", "b.h5"])

        assert result["success"] is True
        assert "kEff" not in result["comparison"]

    def test_single_success_has_empty_comparison(self, monkeypatch):
        """One readable file yields success but no comparison content."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda path: (
                _sp_result("a.h5", keff=(1.0, 0.01))
                if path == "a.h5"
                else {"success": False, "error": "missing"}
            ),
        )

        result = compare_statepoints(["a.h5", "b.h5"])

        assert result["success"] is True
        assert result["comparison"] == {}
        assert len(result["errors"]) == 1


# ---------------------------------------------------------------------------
# main() CLI
# ---------------------------------------------------------------------------


class TestMain:
    def test_no_arguments_prints_help_and_exits_1(self, monkeypatch, capsys):
        """Bare invocation prints usage and exits 1."""
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 1
        assert "usage" in capsys.readouterr().out.lower()

    def test_single_file_success_exits_0(self, monkeypatch, capsys):
        """A readable single file prints its JSON and exits 0."""
        monkeypatch.setattr(
            statepoint_reader, "read_statepoint", lambda p: _sp_result("a.h5", (1.0, 0.01))
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "a.h5", "--json"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert out["fileName"] == "a.h5"

    def test_single_file_failure_exits_1(self, monkeypatch, capsys):
        """An unreadable single file exits 1."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: {"success": False, "error": "missing"},
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "a.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 1

    def test_multiple_files_combined_result(self, monkeypatch, capsys):
        """Multiple files without --compare produce a combined report."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: _sp_result(p, (1.0, 0.01)) if p == "a.h5" else {"success": False},
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "a.h5", "b.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert out["success"] is True
        assert len(out["statepoints"]) == 1
        assert out["errors"] == [{"file": "b.h5", "error": None}]

    def test_multiple_files_all_fail_exits_1(self, monkeypatch, capsys):
        """When every file fails, the combined report exits 1."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: {"success": False, "error": "missing"},
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "a.h5", "b.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 1

    def test_multiple_files_with_stats(self, monkeypatch, capsys):
        """--stats on multiple files adds the statisticalTests block."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: _sp_result(p, (1.0, 0.01)),
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "a.h5", "b.h5", "--stats"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert "statisticalTests" in out
        assert out["statisticalTests"]["kEffective"]["weightedMean"] == pytest.approx(1.0)

    def test_compare_with_stats(self, monkeypatch, capsys):
        """--compare with --stats embeds stats in the comparison report."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: _sp_result(p, (1.0, 0.01), [{"id": 1, "mean": [5.0], "stdDev": [0.1]}]),
        )
        monkeypatch.setattr(
            sys, "argv", ["statepoint_reader.py", "--compare", "a.h5", "b.h5", "--stats"]
        )
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert "comparison" in out
        assert "statisticalTests" in out

    def test_compare_without_stats_has_no_stats_block(self, monkeypatch, capsys):
        """--compare alone omits the statisticalTests block."""
        monkeypatch.setattr(
            statepoint_reader, "read_statepoint", lambda p: _sp_result(p, (1.0, 0.01))
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "--compare", "a.h5", "b.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert "statisticalTests" not in out

    def test_depletion_dispatch(self, monkeypatch, capsys):
        """--depletion routes to read_depletion_results."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_depletion_results",
            lambda p: {"success": True, "fileName": p},
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "--depletion", "d.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        assert json.loads(capsys.readouterr().out)["fileName"] == "d.h5"

    def test_convergence_dispatch_success(self, monkeypatch, capsys):
        """--convergence reads the statepoint then analyzes convergence."""
        sp = _sp_result("a.h5", (1.0, 0.01))
        sp["kEffectiveByBatch"] = [{"batch": i + 1, "value": 1.0} for i in range(12)]
        monkeypatch.setattr(statepoint_reader, "read_statepoint", lambda p: sp)
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "--convergence", "a.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 0
        out = json.loads(capsys.readouterr().out)
        assert out["success"] is True
        assert out["statepoint"] == "a.h5"
        assert out["converged"] is True

    def test_convergence_dispatch_read_failure(self, monkeypatch, capsys):
        """--convergence with an unreadable file propagates the failure."""
        monkeypatch.setattr(
            statepoint_reader,
            "read_statepoint",
            lambda p: {"success": False, "error": "missing"},
        )
        monkeypatch.setattr(sys, "argv", ["statepoint_reader.py", "--convergence", "a.h5"])
        with pytest.raises(SystemExit) as exc:
            statepoint_reader.main()
        assert exc.value.code == 1
