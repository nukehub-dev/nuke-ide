"""Unit tests for python/run_r2s.py with a fake R2SManager."""

import json
from pathlib import Path

import numpy as np
import pytest
import run_r2s
from shutdown_dose_fakes import (
    FakeBoundingBox,
    FakeCell,
    FakeR2SManager,
    FakeRegularMesh,
    FakeTally,
    make_openmc_module,
)


def make_working_directory(tmp_path):
    """Create the minimum XML inputs the driver validates."""
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    (tmp_path / "settings.xml").write_text("<settings/>", encoding="utf-8")
    (tmp_path / "tallies.xml").write_text("<tallies/>", encoding="utf-8")
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>", encoding="utf-8")
    return chain


def base_config(tmp_path, chain):
    return {
        "method": "r2s",
        "domainType": "cell",
        "cellIds": [1],
        "timesteps": ["2 h", 1],
        "timestepUnits": "d",
        "sourceRates": [1e15, 0],
        "chainFile": str(chain),
        "photonTimeIndices": [1],
        "photonTallyIds": [7],
        "byParentNuclide": True,
        "outputDirectory": str(tmp_path / "output"),
    }


@pytest.fixture(autouse=True)
def _reset_managers():
    FakeR2SManager.instances.clear()


def test_run_r2s_cell_based_passes_schedule_domains_and_bounding_boxes(tmp_path, monkeypatch):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["boundingBoxes"] = {"1": {"lowerLeft": [-2, -2, -2], "upperRight": [2, 2, 2]}}
    cell = FakeCell(cell_id=1, volume=10.0)
    photon_tally = FakeTally(tally_id=7)
    fake_openmc = make_openmc_module(cells=[cell], tallies=[photon_tally])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert result["success"] is True
    manager = FakeR2SManager.instances[0]
    assert manager.domains == [cell]
    assert manager.step2_args[0] == [(2.0, "h"), (1.0, "d")]
    assert manager.step2_args[1] == [1e15, 0.0]
    assert manager.step3_args[0] == [1]
    assert isinstance(manager.step3_args[1][1], FakeBoundingBox)
    assert manager.step3_args[1][1].lower_left == (-2.0, -2.0, -2.0)
    assert manager.step4_args[2] is True
    assert result["summary"]["activationRegions"] == 1
    assert result["summary"]["photonTallies"] == 1
    assert result["summary"]["photonTimeIndices"] == [1]
    summary_path = Path(result["outputDirectory"]) / "r2s_summary.json"
    assert summary_path.exists()
    assert json.loads(summary_path.read_text())["success"] is True


def test_run_r2s_mesh_based_multiple_meshes(tmp_path, monkeypatch):
    chain = make_working_directory(tmp_path)
    config = {
        "method": "r2s",
        "domainType": "mesh",
        "meshIds": [3, 4],
        "timesteps": [1],
        "timestepUnits": "d",
        "sourceRates": [1e15],
        "chainFile": str(chain),
        "photonTallyIds": [7],
        "matVolSamples": 5000,
        "outputDirectory": str(tmp_path / "output"),
    }
    meshes = {
        3: FakeRegularMesh(3, (0, 0, 0), (1, 1, 1)),
        4: FakeRegularMesh(4, (2, 0, 0), (3, 1, 1)),
    }
    monkeypatch.setattr(run_r2s, "load_meshes", lambda openmc, working_dir: meshes)
    fake_openmc = make_openmc_module(tallies=[FakeTally(tally_id=7)])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert result["success"] is True
    manager = FakeR2SManager.instances[0]
    assert [mesh.id for mesh in manager.domains] == [3, 4]
    assert manager.step1_args[1] == {"n_samples": 5000}
    assert "overlapping bounds" not in " ".join(result["summary"]["warnings"])


def test_run_r2s_warns_for_overlapping_meshes(tmp_path, monkeypatch):
    chain = make_working_directory(tmp_path)
    config = {
        "method": "r2s",
        "domainType": "mesh",
        "meshIds": [3, 4],
        "timesteps": [1],
        "sourceRates": [1e15],
        "chainFile": str(chain),
        "photonTallyIds": [7],
    }
    meshes = {
        3: FakeRegularMesh(3, (0, 0, 0), (2, 1, 1)),
        4: FakeRegularMesh(4, (1, 0, 0), (3, 1, 1)),
    }
    monkeypatch.setattr(run_r2s, "load_meshes", lambda openmc, working_dir: meshes)
    fake_openmc = make_openmc_module(tallies=[FakeTally(tally_id=7)])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert any("overlapping bounds" in warning for warning in result["summary"]["warnings"])


def test_run_r2s_rejects_missing_cell_volume(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    fake_openmc = make_openmc_module(
        cells=[FakeCell(cell_id=1, volume=None)], tallies=[FakeTally(7)]
    )

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="no volume"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)


def test_run_r2s_rejects_missing_photon_tally(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7, filters=[])])

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="target photons"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)


def test_run_r2s_rejects_missing_chain(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    config = base_config(tmp_path, tmp_path / "missing-chain.xml")

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="chain file not found"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_rejects_skipping_neutron_transport(tmp_path):
    chain = make_working_directory(tmp_path)
    config = base_config(tmp_path, chain)
    config["runNeutron"] = False

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="cannot be skipped"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_normalize_schedule_rejects_rate_length_mismatch():
    config = {"timesteps": [1, 2], "sourceRates": [1e15], "timestepUnits": "s"}
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="sourceRates"):
        run_r2s.normalize_schedule(config)


def test_summarize_tally_includes_parent_nuclides():
    from shutdown_dose_fakes import FakeParentNuclideFilter

    tally = FakeTally(
        mean=np.array([1.0, 2.0, 3.0]),
        filters=[FakeParentNuclideFilter(["Co60", "Ni65"])],
    )
    summary = run_r2s.summarize_tally(tally, time_index=2)
    assert summary["timeIndex"] == 2
    assert summary["parentNuclides"] == ["Co60", "Ni65"]
    assert summary["max"] == 3.0
