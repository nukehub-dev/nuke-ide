"""Tests for run_optimization's iteration driver and batch orchestration.

Uses the same stubbed-openmc import pattern as test_run_optimization.py:
openmc is replaced with a stub module before import, and StatePoint /
from_xml_string entry points are filled in per test. No real OpenMC run
ever executes.
"""

import json
import os
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")


@pytest.fixture()
def ro():
    """Import run_optimization with a stubbed openmc module; restore after."""
    stub = types.ModuleType("openmc")
    # Only openmc.Model is needed at import time (function annotations).
    stub.Model = type("Model", (), {})

    sentinel = object()
    old_openmc = sys.modules.get("openmc", sentinel)
    old_ro = sys.modules.get("run_optimization", sentinel)

    sys.modules["openmc"] = stub
    sys.modules.pop("run_optimization", None)
    import run_optimization

    yield run_optimization

    if old_openmc is sentinel:
        sys.modules.pop("openmc", None)
    else:
        sys.modules["openmc"] = old_openmc
    if old_ro is sentinel:
        sys.modules.pop("run_optimization", None)
    else:
        sys.modules["run_optimization"] = old_ro


# ---------------------------------------------------------------------------
# run_single_iteration
# ---------------------------------------------------------------------------


class FakeTally:
    """Fake statepoint tally holding a 0-d numpy mean."""

    def __init__(self, mean):
        self.mean = np.array(mean)


class FakeStatePoint:
    """Fake openmc.StatePoint with keff and a tallies mapping."""

    def __init__(self, path, keff=1.02, std=0.003, tallies=None):
        self.path = path
        self.keff = SimpleNamespace(nominal_value=keff, std_dev=std)
        self.tallies = tallies if tallies is not None else {1: FakeTally(2.5)}
        self.closed = False

    def close(self):
        self.closed = True


class FakeModel:
    """Fake base model that clones itself and records export/run calls."""

    fail_on_clone = False

    def __init__(self):
        self.settings = SimpleNamespace(batches=100)
        self.exported_to = None
        self.ran_in = None

    def clone(self):
        if FakeModel.fail_on_clone:
            raise RuntimeError("clone boom")
        return FakeModel()

    def export_to_xml(self, path=None):
        self.exported_to = path

    def run(self, output_dir=None, cwd=None):
        self.ran_in = cwd
        return os.path.join(cwd, "statepoint.100.h5")


class TestRunSingleIteration:
    def test_success_extracts_keff_and_tallies(self, ro, monkeypatch, tmp_path):
        """A successful iteration reports keff, tallies, and the sp path."""
        monkeypatch.setattr(ro.openmc, "StatePoint", FakeStatePoint, raising=False)
        base = FakeModel()

        result = ro.run_single_iteration(base, {"settings.batches": 50}, str(tmp_path), 3)

        assert result["success"] is True
        assert result["iteration"] == 3
        assert result["parameterValues"] == {"settings.batches": 50}
        assert result["keff"] == 1.02
        assert result["keffStd"] == 0.003
        assert result["tallies"] == {"1": 2.5}
        assert result["executionTime"] >= 0.0
        assert result["statepointPath"].endswith("statepoint.100.h5")
        # The iteration directory was created and used for export and run.
        iter_dir = tmp_path / "iteration_3"
        assert iter_dir.is_dir()

    def test_empty_and_sized_tallies_filtered(self, ro, monkeypatch, tmp_path):
        """Tallies with empty means are excluded from the results."""
        tallies = {1: FakeTally(2.5), 2: SimpleNamespace(mean=np.array([]))}
        monkeypatch.setattr(
            ro.openmc,
            "StatePoint",
            lambda path: FakeStatePoint(path, tallies=tallies),
            raising=False,
        )

        result = ro.run_single_iteration(FakeModel(), {}, str(tmp_path), 1)

        assert result["tallies"] == {"1": 2.5}

    def test_no_tallies_omits_key(self, ro, monkeypatch, tmp_path):
        """A statepoint without usable tallies produces no tallies key."""
        monkeypatch.setattr(
            ro.openmc,
            "StatePoint",
            lambda path: FakeStatePoint(path, tallies={}),
            raising=False,
        )

        result = ro.run_single_iteration(FakeModel(), {}, str(tmp_path), 1)

        assert "tallies" not in result

    def test_parameter_changes_applied_to_clone(self, ro, monkeypatch, tmp_path):
        """set_parameter_by_path runs against the cloned model."""
        monkeypatch.setattr(ro.openmc, "StatePoint", FakeStatePoint, raising=False)
        seen = {}

        original_clone = FakeModel.clone

        def spy_clone(self):
            model = original_clone(self)
            seen["model"] = model
            return model

        monkeypatch.setattr(FakeModel, "clone", spy_clone)

        ro.run_single_iteration(FakeModel(), {"settings.batches": 250}, str(tmp_path), 1)

        assert seen["model"].settings.batches == 250

    def test_failure_returns_error_result(self, ro, monkeypatch, tmp_path):
        """A clone failure yields a failure result with the error message."""
        FakeModel.fail_on_clone = True
        try:
            result = ro.run_single_iteration(FakeModel(), {"a": 1}, str(tmp_path), 2)
        finally:
            FakeModel.fail_on_clone = False

        assert result["success"] is False
        assert result["iteration"] == 2
        assert result["parameterValues"] == {"a": 1}
        assert result["keff"] is None
        assert result["keffStd"] is None
        assert result["errorMessage"] == "clone boom"
        assert result["statepointPath"] is None


# ---------------------------------------------------------------------------
# run_optimization_batch
# ---------------------------------------------------------------------------


def _write_config(tmp_path, sweeps):
    """Write a minimal optimization config JSON and return its path."""
    config = {
        "runId": "run-42",
        "baseState": {"materials": "<m/>", "geometry": "<g/>", "settings": "<s/>"},
        "sweeps": sweeps,
    }
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config))
    return str(config_path)


def _install_batch_stubs(ro, monkeypatch):
    """Fill in the from_xml_string constructors and Model on the stub."""
    monkeypatch.setattr(
        ro.openmc,
        "Materials",
        SimpleNamespace(from_xml_string=lambda s: ("materials", s)),
        raising=False,
    )
    monkeypatch.setattr(
        ro.openmc,
        "Geometry",
        SimpleNamespace(from_xml_string=lambda s: ("geometry", s)),
        raising=False,
    )
    monkeypatch.setattr(
        ro.openmc,
        "Settings",
        SimpleNamespace(from_xml_string=lambda s: ("settings", s)),
        raising=False,
    )
    monkeypatch.setattr(ro.openmc, "Model", lambda g, m, s: FakeModel(), raising=False)
    monkeypatch.setattr(ro.openmc, "StatePoint", FakeStatePoint, raising=False)


class TestRunOptimizationBatch:
    def test_batch_writes_summary(self, ro, monkeypatch, tmp_path, capsys):
        """A two-point sweep runs both iterations and writes the summary."""
        _install_batch_stubs(ro, monkeypatch)
        config_path = _write_config(
            tmp_path,
            [
                {
                    "variable": "settings.batches",
                    "rangeType": "linear",
                    "startValue": 100.0,
                    "endValue": 200.0,
                    "numPoints": 2,
                }
            ],
        )
        out_dir = str(tmp_path / "out")

        summary = ro.run_optimization_batch(config_path, out_dir)

        assert summary["runId"] == "run-42"
        assert summary["totalIterations"] == 2
        assert summary["completedIterations"] == 2
        assert summary["failedIterations"] == 0
        assert len(summary["results"]) == 2
        assert summary["results"][0]["parameterValues"] == {"settings.batches": 100.0}
        assert summary["results"][1]["parameterValues"] == {"settings.batches": 200.0}

        # The summary JSON was persisted alongside the iteration folders.
        summary_file = tmp_path / "out" / "optimization_results.json"
        persisted = json.loads(summary_file.read_text())
        assert persisted["runId"] == "run-42"
        assert (tmp_path / "out" / "iteration_1").is_dir()
        assert (tmp_path / "out" / "iteration_2").is_dir()

        out = capsys.readouterr().out
        assert "Starting optimization run run-42" in out
        assert "Total iterations: 2" in out
        assert "Completed: keff = 1.020000 ± 0.003000" in out
        assert "Optimization complete." in out

    def test_batch_counts_failed_iterations(self, ro, monkeypatch, tmp_path, capsys):
        """Iterations that fail are counted and reported in the summary."""
        _install_batch_stubs(ro, monkeypatch)
        config_path = _write_config(
            tmp_path,
            [
                {
                    "variable": "x",
                    "rangeType": "linear",
                    "startValue": 0.0,
                    "endValue": 2.0,
                    "numPoints": 3,
                }
            ],
        )

        original = ro.run_single_iteration

        def flaky(model, params, output_dir, iteration):
            if params["x"] == 1.0:
                return {
                    "iteration": iteration,
                    "parameterValues": params,
                    "keff": None,
                    "keffStd": None,
                    "executionTime": 0.0,
                    "success": False,
                    "errorMessage": "transport blew up",
                    "statepointPath": None,
                }
            return original(model, params, output_dir, iteration)

        monkeypatch.setattr(ro, "run_single_iteration", flaky)

        summary = ro.run_optimization_batch(config_path, str(tmp_path / "out"))

        assert summary["totalIterations"] == 3
        assert summary["completedIterations"] == 2
        assert summary["failedIterations"] == 1
        assert "Failed: transport blew up" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# main() success/exception paths
# ---------------------------------------------------------------------------


class TestMainDispatch:
    def test_success_prints_summary_json(self, ro, monkeypatch, capsys, tmp_path):
        """A valid config path runs the batch and prints the summary."""
        config_path = _write_config(tmp_path, [])
        monkeypatch.setattr(
            ro, "run_optimization_batch", lambda c, o: {"runId": "run-42", "results": []}
        )
        monkeypatch.setattr(
            sys, "argv", ["run_optimization.py", config_path, str(tmp_path / "out")]
        )

        ro.main()

        out = json.loads(capsys.readouterr().out)
        assert out == {"runId": "run-42", "results": []}
        # The output directory is created even for a stubbed batch.
        assert (tmp_path / "out").is_dir()

    def test_batch_exception_exits_1(self, ro, monkeypatch, capsys, tmp_path):
        """A batch exception prints an error to stderr and exits 1."""
        config_path = _write_config(tmp_path, [])

        def boom(c, o):
            raise ValueError("bad config")

        monkeypatch.setattr(ro, "run_optimization_batch", boom)
        monkeypatch.setattr(
            sys, "argv", ["run_optimization.py", config_path, str(tmp_path / "out")]
        )

        with pytest.raises(SystemExit) as exc:
            ro.main()

        assert exc.value.code == 1
        assert "Error: bad config" in capsys.readouterr().err
