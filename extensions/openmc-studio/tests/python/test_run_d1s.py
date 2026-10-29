"""Unit tests for python/run_d1s.py with fake OpenMC and d1s modules."""

import json
from pathlib import Path

import pytest
import run_d1s
from shutdown_dose_fakes import FakeD1S, FakeStatePoint, FakeTally, make_openmc_module


def make_working_directory(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    (tmp_path / "settings.xml").write_text("<settings/>", encoding="utf-8")
    (tmp_path / "tallies.xml").write_text("<tallies/>", encoding="utf-8")
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


def fake_transport_module(tmp_path, d1s):
    tally = FakeTally(tally_id=7, mean=[2.0, 4.0])
    statepoint = FakeStatePoint(tmp_path / "statepoint.3.h5", tallies={7: tally})
    module = make_openmc_module(tallies=[tally])
    module.StatePoint = lambda path: FakeStatePoint(path, tallies={7: tally})
    module.d1s = d1s

    class RunningModel:
        def __init__(self):
            self.settings = type(
                "Settings", (), {"photon_transport": None, "use_decay_photons": None}
            )()
            self.tallies = [tally]
            self.run_cwd = None

        def run(self, cwd=None):
            self.run_cwd = cwd
            return statepoint.path

    model = RunningModel()
    module.Model = type(
        "BoundD1SModel",
        (),
        {"from_xml": classmethod(lambda cls, *args, **kwargs: model)},
    )
    return module, model


def test_run_d1s_applies_time_correction(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S(["Co60"])
    fake_openmc, model = fake_transport_module(tmp_path, d1s)

    result = run_d1s.run_d1s(config, str(tmp_path), openmc_module=fake_openmc, d1s_module=d1s)

    assert result["success"] is True
    assert result["summary"]["method"] == "d1s"
    assert result["summary"]["timeCorrectionFactors"]["Co60"] == 2.0
    assert result["summary"]["photonTallySummaries"][0]["parentNuclides"] == ["Co60"]
    assert result["summary"]["photonTallySummaries"][0]["summedOverParents"] is True
    assert d1s.correction_args == (7, 1, True)
    assert model.settings.use_decay_photons is True
    assert model.settings.photon_transport is True
    assert d1s.prepare_args == (["Co60"], str(chain))
    assert model.run_cwd is not None
    assert (Path(result["outputDirectory"]) / "d1s_summary.json").exists()


def test_run_d1s_keeps_parent_breakdown_when_not_summed(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["d1sSumNuclides"] = False
    d1s = FakeD1S(["Co60"])
    fake_openmc, _ = fake_transport_module(tmp_path, d1s)

    result = run_d1s.run_d1s(config, str(tmp_path), openmc_module=fake_openmc, d1s_module=d1s)

    assert d1s.correction_args == (7, 1, False)
    assert any(
        "Parent-nuclide breakdown retained" in warning for warning in result["summary"]["warnings"]
    )


def test_run_d1s_rejects_out_of_range_index(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["d1sTimeIndex"] = 10
    d1s = FakeD1S(["Co60"])
    fake_openmc, _ = fake_transport_module(tmp_path, d1s)

    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="outside the schedule"):
        run_d1s.run_d1s(config, str(tmp_path), openmc_module=fake_openmc, d1s_module=d1s)


def test_run_d1s_rejects_missing_chain(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    config = base_config(tmp_path, tmp_path / "missing.xml")
    d1s = FakeD1S(["Co60"])

    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="chain file not found"):
        run_d1s.run_d1s(config, str(tmp_path), openmc_module=make_openmc_module(), d1s_module=d1s)


def test_run_d1s_rejects_non_photon_tally(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S(["Co60"])
    fake_openmc, _ = fake_transport_module(tmp_path, d1s)
    fake_openmc.Model.from_xml = classmethod(
        lambda cls, *args, **kwargs: type(
            "M",
            (),
            {"tallies": [FakeTally(7, filters=[])], "settings": type("S", (), {})()},
        )()
    )

    with pytest.raises(run_d1s.ShutdownDoseConfigError, match="target photons"):
        run_d1s.run_d1s(config, str(tmp_path), openmc_module=fake_openmc, d1s_module=d1s)


def test_d1s_summary_is_valid_json(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    d1s = FakeD1S(["Co60"])
    fake_openmc, _ = fake_transport_module(tmp_path, d1s)

    result = run_d1s.run_d1s(config, str(tmp_path), openmc_module=fake_openmc, d1s_module=d1s)
    text = (Path(result["outputDirectory"]) / "d1s_summary.json").read_text()
    parsed = json.loads(text)
    assert parsed["summary"]["timeCorrectionFactors"]["Co60"] == 2.0
