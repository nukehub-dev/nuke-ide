"""Tests for the advanced OpenMC 0.16 depletion controls in run_depletion.

Covers CRAM substeps, curated keff-search modifiers, external source rates,
and continuation. The openmc module is stubbed by the shared harness in
``test_run_depletion_run``; the modifier functions are exercised against fake
``openmc.lib`` cells/materials.
"""

import json
import sys
import types

import pytest
import run_depletion
from test_run_depletion_run import (
    FakeMaterial,
    RecordingIntegrator,
    RecordingOperator,
    _args,
    _install_fake_openmc,
    _workdir,
)


class FakeCell:
    def __init__(self):
        self.translation = [0.0, 0.0, 0.0]


class FakeLibMaterial:
    def __init__(self, nuclides, densities):
        self.nuclides = list(nuclides)
        self.densities = list(densities)
        self.set_calls = []

    def set_densities(self, nuclides, densities):
        self.set_calls.append((list(nuclides), list(densities)))


def _install_fake_lib(monkeypatch, cells=None, materials=None):
    fake_lib = types.ModuleType("openmc.lib")
    fake_lib.cells = cells or {}
    fake_lib.materials = materials or {}
    monkeypatch.setitem(sys.modules, "openmc.lib", fake_lib)
    sys.modules["openmc"].lib = fake_lib
    return fake_lib


@pytest.fixture()
def chain_file(tmp_path):
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>")
    return str(chain)


class TestSubsteps:
    def test_substeps_reach_the_integrator_and_summary(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file, substeps=3))

        (integrator,) = RecordingIntegrator.instances
        assert integrator.kwargs["substeps"] == 3
        assert result["substeps"] == 3
        assert result["effectiveSteps"] == 2

    def test_unsupported_substeps_is_a_clean_config_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        monkeypatch.setattr(run_depletion, "supports_integrator_option", lambda option: False)
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="CRAM substeps require OpenMC 0.16"
        ):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, substeps=2))

    def test_zero_substeps_is_a_clean_config_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="at least 1"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, substeps=0))


class TestDecayOnlySteps:
    def test_decay_only_step_runs_at_zero_power_and_adds_no_burnup(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, decay_only_steps="1")
        )

        (integrator,) = RecordingIntegrator.instances
        assert integrator.power == [1e6, 0.0]
        assert result["decayOnlySteps"] == [1]
        # Only the first day contributes energy: 1 MWd / 1 kg = 1 MWd/kg.
        assert result["burnupMWdPerKg"] == [pytest.approx(1.0), pytest.approx(1.0)]

    def test_out_of_range_decay_step_is_a_clean_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="outside the configured timeline"
        ):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file, decay_only_steps="5"))


class TestReactivityControl:
    def test_control_rod_search_registers_public_api_and_moves_the_cell(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        cell = FakeCell()
        _install_fake_lib(monkeypatch, cells={7: cell})
        workdir = _workdir(tmp_path)
        control = {
            "enabled": True,
            "parameter": "cell-translation",
            "cellId": 7,
            "axis": "z",
            "x0": 0,
            "x1": 10,
            "bracket": [-20, 20],
            "targetKeff": 1.0,
            "kTol": 1e-4,
            "sigmaFinal": 3e-4,
            "maxIterations": 40,
            "onFailure": "fail",
        }

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, reactivity_control=json.dumps(control))
        )

        (integrator,) = RecordingIntegrator.instances
        (call,) = integrator.keff_search_calls
        assert call["x0"] == 0
        assert call["x1"] == 10
        assert call["bracket"] == [-20, 20]
        assert call["kwargs"] == {"target": 1.0, "k_tol": 1e-4, "sigma_final": 3e-4, "maxiter": 40}

        call["function"](12.5)
        assert cell.translation == [0.0, 0.0, 12.5]
        assert result["reactivityControl"]["parameter"] == "cell-translation"
        assert result["reactivityControl"]["cellId"] == 7

    def test_nuclide_density_search_replaces_one_density(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        material = FakeLibMaterial(["U235", "U238"], [0.0005, 0.02])
        _install_fake_lib(monkeypatch, materials={1: material})
        workdir = _workdir(tmp_path)
        control = {
            "enabled": True,
            "parameter": "nuclide-density",
            "materialId": 1,
            "nuclide": "U235",
            "x0": 0.0005,
            "x1": 0.001,
            "bracket": [0.0001, 0.002],
        }

        run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, reactivity_control=json.dumps(control))
        )

        (integrator,) = RecordingIntegrator.instances
        (call,) = integrator.keff_search_calls
        call["function"](0.0008)
        assert material.densities == [0.0008, 0.02]
        assert material.set_calls == [(["U235", "U238"], [0.0008, 0.02])]

    def test_missing_nuclide_in_runtime_material_is_a_clean_error(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        material = FakeLibMaterial(["U238"], [0.02])
        _install_fake_lib(monkeypatch, materials={1: material})
        workdir = _workdir(tmp_path)
        control = {
            "enabled": True,
            "parameter": "nuclide-density",
            "materialId": 1,
            "nuclide": "U235",
            "x0": 0.0005,
            "x1": 0.001,
            "bracket": [0.0001, 0.002],
        }

        run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, reactivity_control=json.dumps(control))
        )
        (integrator,) = RecordingIntegrator.instances
        (call,) = integrator.keff_search_calls
        with pytest.raises(run_depletion.DepletionConfigError, match="not present in material 1"):
            call["function"](0.0008)

    def test_unsupported_keff_search_is_a_clean_config_error(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        monkeypatch.setattr(run_depletion, "supports_integrator_method", lambda method: False)
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="requires OpenMC 0.16"):
            run_depletion.run_depletion(
                _args(
                    workdir,
                    chain_file=chain_file,
                    reactivity_control=json.dumps(
                        {
                            "enabled": True,
                            "parameter": "cell-translation",
                            "cellId": 7,
                            "axis": "z",
                            "x0": 0,
                            "x1": 1,
                            "bracket": [-1, 1],
                        }
                    ),
                )
            )

    def test_warn_failure_wrapper_logs_and_continues(self, capsys):
        class Control:
            def run(self, x):
                raise ValueError("Search for keff failed to converge")

        class Integrator:
            _keff_search_control = Control()

        run_depletion.install_warn_on_search_failure(Integrator())
        assert Integrator._keff_search_control.run([1.0]) is None
        assert "reactivity search did not converge" in capsys.readouterr().err

    def test_guesses_must_lie_inside_the_bracket(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)
        control = {
            "enabled": True,
            "parameter": "cell-translation",
            "cellId": 7,
            "axis": "z",
            "x0": -5,
            "x1": 5,
            "bracket": [0, 1],
        }
        with pytest.raises(run_depletion.DepletionConfigError, match="inside the bracket"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, reactivity_control=json.dumps(control))
            )


class TestExternalSourceRates:
    def test_rate_row_reaches_add_external_source_rate(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)
        rates = [
            {
                "material": 1,
                "composition": [
                    {"name": "U235", "weightPercent": 90},
                    {"name": "U238", "weightPercent": 10},
                ],
                "rate": -1e-6,
                "units": "g/s",
                "timesteps": [0, 1],
            }
        ]

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, external_source_rates=json.dumps(rates))
        )

        (integrator,) = RecordingIntegrator.instances
        assert integrator.external_source_rate_calls == [
            {
                "material": 1,
                "composition": {"U235": 90.0, "U238": 10.0},
                "rate": -1e-6,
                "rate_units": "g/s",
                "timesteps": [0, 1],
            }
        ]
        assert result["externalSourceRates"] == rates

    def test_timestep_index_beyond_the_run_is_a_clean_error(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)
        rates = [
            {
                "material": 1,
                "composition": [{"name": "U235", "weightPercent": 100}],
                "rate": 1,
                "units": "g/s",
                "timesteps": [5],
            }
        ]
        with pytest.raises(run_depletion.DepletionConfigError, match="references timestep 5"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, external_source_rates=json.dumps(rates))
            )

    def test_empty_composition_is_a_clean_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)
        rates = [{"material": 1, "composition": [], "rate": 1}]
        with pytest.raises(run_depletion.DepletionConfigError, match="empty composition"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, external_source_rates=json.dumps(rates))
            )


class TestContinuation:
    def test_previous_results_reach_the_operator_and_integrator(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        sentinel = object()
        monkeypatch.setattr(run_depletion, "load_previous_results", lambda path: sentinel)
        previous = tmp_path / "depletion_results.h5"
        previous.write_text("h5")
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(
                workdir,
                chain_file=chain_file,
                continue_from_results=str(previous),
                continue_timesteps=True,
            )
        )

        (operator,) = RecordingOperator.instances
        assert operator.kwargs["prev_results"] is sentinel
        (integrator,) = RecordingIntegrator.instances
        assert integrator.kwargs["continue_timesteps"] is True
        assert result["continueFromResults"] == str(previous)
        assert result["continueTimesteps"] is True

    def test_missing_previous_results_file_is_a_clean_error(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="Previous depletion results file not found"
        ):
            run_depletion.run_depletion(
                _args(
                    workdir,
                    chain_file=chain_file,
                    continue_from_results=str(tmp_path / "missing.h5"),
                )
            )

    def test_continue_timesteps_without_a_file_is_a_clean_error(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="needs a previous depletion results file"
        ):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, continue_timesteps=True)
            )

    def test_continuation_schedule_mismatch_is_actionable(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        monkeypatch.setattr(run_depletion, "load_previous_results", lambda path: object())

        class RejectingIntegrator(RecordingIntegrator):
            def __init__(self, operator, time_steps, power=None, **kwargs):
                if kwargs.get("continue_timesteps"):
                    raise ValueError("previous timesteps do not match")
                super().__init__(operator, time_steps, power=power, **kwargs)

        sys.modules["openmc.deplete"].CECMIntegrator = RejectingIntegrator
        previous = tmp_path / "depletion_results.h5"
        previous.write_text("h5")
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="must begin with the previous run"
        ):
            run_depletion.run_depletion(
                _args(
                    workdir,
                    chain_file=chain_file,
                    continue_from_results=str(previous),
                    continue_timesteps=True,
                )
            )
