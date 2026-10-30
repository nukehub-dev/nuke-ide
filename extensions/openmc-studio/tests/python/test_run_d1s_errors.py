"""Additional coverage for D1S driver helpers and error paths."""

import json
import sys
from types import SimpleNamespace

import pytest
import run_d1s
from shutdown_dose_fakes import (
    FakeD1S,
    FakeParticleFilter,
    FakeStatePoint,
    FakeTally,
    make_openmc_module,
)


def working_directory(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>", encoding="utf-8")
    return chain


def base_config(tmp_path, chain):
    return {
        "method": "d1s",
        "timesteps": [1],
        "timestepUnits": "d",
        "sourceRates": [1e15],
        "chainFile": str(chain),
        "photonTallyIds": [7],
        "d1sTimeIndex": -1,
        "d1sSumNuclides": True,
        "outputDirectory": str(tmp_path / "output"),
    }


class ModelWithTallies:
    def __init__(self, tallies):
        self.tallies = tallies
        self.settings = SimpleNamespace(photon_transport=None, use_decay_photons=None)

    def run(self, cwd=None):
        statepoint = cwd / "statepoint.3.h5"
        statepoint.write_text("{}", encoding="utf-8")
        return statepoint


def fake_openmc_with(tallies, d1s, run_error=None):
    module = make_openmc_module(tallies=tallies)
    module.d1s = d1s

    def from_xml(*args, **kwargs):
        model = ModelWithTallies(tallies)
        if run_error:

            def run(cwd=None):
                raise run_error

            model.run = run
        return model

    module.Model = SimpleNamespace(from_xml=from_xml)
    module.StatePoint = lambda path: FakeStatePoint(
        path, tallies={tally.id: tally for tally in tallies}
    )
    return module


def test_import_openmc_reports_missing_d1s(monkeypatch):
    monkeypatch.setitem(sys.modules, "openmc", None)
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="OpenMC 0.16"):
        run_d1s._import_openmc()


def test_import_openmc_returns_the_loaded_modules(monkeypatch):
    d1s_module = SimpleNamespace()
    fake_openmc = SimpleNamespace(deplete=SimpleNamespace(d1s=d1s_module))
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_openmc.deplete)
    monkeypatch.setitem(sys.modules, "openmc.deplete.d1s", d1s_module)
    assert run_d1s._import_openmc() == (fake_openmc, d1s_module)


def test_photon_tally_ids_defaults_to_all_photon_tallies():
    photon = FakeTally(7)
    other = FakeTally(9, filters=[])
    model = SimpleNamespace(tallies=[photon, other])
    assert run_d1s._photon_tally_ids(model, [], make_openmc_module()) == [7]


def test_photon_tally_ids_reports_missing_ids():
    model = SimpleNamespace(tallies=[FakeTally(7)])
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="not found"):
        run_d1s._photon_tally_ids(model, [99], make_openmc_module())


def test_photon_tally_ids_reports_non_photon_selection():
    model = SimpleNamespace(tallies=[FakeTally(7, filters=[])])
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="target photons"):
        run_d1s._photon_tally_ids(model, [7], make_openmc_module())


def test_photon_tally_ids_requires_a_photon_tally():
    model = SimpleNamespace(tallies=[FakeTally(7, filters=[])])
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="No photon tallies"):
        run_d1s._photon_tally_ids(model, [], make_openmc_module())


def test_has_photon_filter_ignores_other_filters():
    model = make_openmc_module()
    assert (
        run_d1s._has_photon_filter(FakeTally(filters=[FakeParticleFilter("neutron")]), model)
        is False
    )
    assert run_d1s._has_photon_filter(FakeTally(filters=[object()]), model) is False


def test_normalize_time_index_accepts_negative_and_rejects_out_of_range():
    assert run_d1s._normalize_time_index(-1, 3) == 2
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="outside the schedule"):
        run_d1s._normalize_time_index(-4, 3)
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="outside the schedule"):
        run_d1s._normalize_time_index(3, 3)


def test_run_d1s_rejects_wrong_method(tmp_path):
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="method='d1s'"):
        run_d1s.run_d1s({"method": "r2s"}, str(tmp_path), make_openmc_module(), FakeD1S())


def test_run_d1s_requires_geometry_xml(tmp_path):
    chain = tmp_path / "chain.xml"
    chain.write_text("<chain/>", encoding="utf-8")
    config = base_config(tmp_path, chain)
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="No geometry.xml"):
        run_d1s.run_d1s(config, str(tmp_path), make_openmc_module(), FakeD1S())


def test_run_d1s_requires_chain_setting(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    config = base_config(tmp_path, tmp_path / "chain.xml")
    del config["chainFile"]
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="chain file is required"):
        run_d1s.run_d1s(config, str(tmp_path), make_openmc_module(), FakeD1S())


def test_run_d1s_reports_model_load_failure(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    module = make_openmc_module()
    module.Model = SimpleNamespace(from_xml=lambda: (_ for _ in ()).throw(RuntimeError("bad xml")))
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="Could not load the model"):
        run_d1s.run_d1s(config, str(tmp_path), module, FakeD1S())


def test_run_d1s_requires_radionuclides(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S()
    d1s.nuclides = []
    d1s.get_radionuclides = lambda model, chain_file=None: []
    module = fake_openmc_with([FakeTally(7)], d1s)
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="No radionuclides"):
        run_d1s.run_d1s(config, str(tmp_path), module, d1s)


def test_run_d1s_reports_transport_failure(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S()
    module = fake_openmc_with([FakeTally(7)], d1s, run_error=RuntimeError("transport boom"))
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="D1S transport failed"):
        run_d1s.run_d1s(config, str(tmp_path), module, d1s)


def test_run_d1s_reports_time_correction_failure(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S()
    d1s.time_correction_factors = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("no factors")
    )
    module = fake_openmc_with([FakeTally(7)], d1s)
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="time correction factors"):
        run_d1s.run_d1s(config, str(tmp_path), module, d1s)


def test_run_d1s_records_missing_statepoint_tally(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S()
    module = fake_openmc_with([FakeTally(7)], d1s)
    module.StatePoint = lambda path: FakeStatePoint(path, tallies={})
    result = run_d1s.run_d1s(config, str(tmp_path), module, d1s)
    assert result["summary"]["photonTallies"] == 0
    assert any("not present" in warning for warning in result["summary"]["warnings"])


def test_run_d1s_reports_dose_peak_for_selected_tally(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["doseTallyId"] = 7
    d1s = FakeD1S()
    module = fake_openmc_with([FakeTally(7, mean=[2.0, 4.0])], d1s)
    result = run_d1s.run_d1s(config, str(tmp_path), module, d1s)
    assert result["summary"]["dose"] == {
        "tallyId": 7,
        "timeIndex": 1,
        "peak": 8.0,
        "mean": 6.0,
    }


def test_run_d1s_dose_ignores_infinite_bins(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["doseTallyId"] = 7
    d1s = FakeD1S()
    module = fake_openmc_with([FakeTally(7, mean=[float("inf"), 2.0])], d1s)
    result = run_d1s.run_d1s(config, str(tmp_path), module, d1s)
    assert result["summary"]["dose"]["peak"] == 4.0
    assert result["summary"]["dose"]["mean"] == 4.0


def test_run_d1s_reports_statepoint_read_failure(tmp_path):
    chain = working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S()
    module = fake_openmc_with([FakeTally(7)], d1s)
    module.StatePoint = lambda path: (_ for _ in ()).throw(RuntimeError("bad statepoint"))
    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="Could not correct"):
        run_d1s.run_d1s(config, str(tmp_path), module, d1s)


def test_main_reports_config_errors(monkeypatch, capsys, tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["run_d1s.py", str(tmp_path), "--config", str(config_path)])
    monkeypatch.setattr(
        run_d1s,
        "run_d1s",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            run_d1s.ShutdownDoseConfigError("bad config")
        ),
    )
    assert run_d1s.main() == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload == {"success": False, "error": "bad config"}


def test_main_prints_success(monkeypatch, capsys, tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["run_d1s.py", str(tmp_path), "--config", str(config_path)])
    monkeypatch.setattr(run_d1s, "run_d1s", lambda *args, **kwargs: {"success": True})
    assert run_d1s.main() == 0
    assert json.loads(capsys.readouterr().out) == {"success": True}


def test_main_reports_unexpected_errors(monkeypatch, capsys, tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["run_d1s.py", str(tmp_path), "--config", str(config_path)])
    monkeypatch.setattr(
        run_d1s,
        "run_d1s",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("unexpected")),
    )
    assert run_d1s.main() == 1
    assert json.loads(capsys.readouterr().out) == {"success": False, "error": "unexpected"}
