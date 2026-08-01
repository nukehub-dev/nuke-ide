"""End-to-end tests for the openmc-studio run drivers against REAL OpenMC.

Each test builds a tiny pincell (see conftest.py), invokes a driver in-process
exactly the way the extension's backend does, and checks the physical result.
Full-profile only: every test skips without openmc/cross sections.
"""

import json
import os
from types import SimpleNamespace

import pytest
from e2e_helpers import require_chain, require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e

KEFF_RANGE = (0.2, 2.5)


def _read_keff(statepoint_path):
    with openmc.StatePoint(str(statepoint_path)) as sp:
        return sp.keff.n


# ---------------------------------------------------------------------------
# run_cmfd.py
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_run_cmfd_e2e(pincell_dir):
    import run_cmfd

    config = {
        "mesh": {
            "lowerLeft": [-0.63, -0.63, -0.5],
            "upperRight": [0.63, 0.63, 0.5],
            "dimension": [2, 2, 1],
            "albedo": [1, 1, 1, 1, 0, 0],
        },
        "feedback": True,
    }
    args = SimpleNamespace(
        working_directory=str(pincell_dir), cmfd_config=json.dumps(config), mpi_processes=None
    )

    result = run_cmfd.run_cmfd(args)

    assert result["success"] is True
    assert result["statepoint"] is not None and os.path.exists(result["statepoint"])
    assert result["kEff"] is not None
    assert KEFF_RANGE[0] < result["kEff"]["mean"] < KEFF_RANGE[1]
    assert result["feedback"] is True
    assert result["run"]["particles"] == 300


# ---------------------------------------------------------------------------
# run_depletion.py
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_run_depletion_e2e(pincell_dir):
    chain = require_chain()

    import run_depletion

    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        chain_file=chain,
        time_steps="86400,86400",
        power=1.0,
        power_density=None,
        solver="predictor",
        operator="coupled",
        substeps=1,
        normalization="fission-q",
        mpi_processes=None,
        flux_files=None,
        microxs_files=None,
        generate_microxs=False,
        transfer_rates=None,
        fission_q=None,
        diff_burnable_mats=False,
        diff_volume_method="divide equally",
    )

    result = run_depletion.run_depletion(args)

    assert result["success"] is True
    assert result["timeSteps"] == [86400.0, 86400.0]
    assert os.path.exists(pincell_dir / "depletion_results.h5")
    # Fuel was marked depletable by the operator path
    assert result["burnupMWdPerKg"][-1] > 0


@pytest.mark.e2e
def test_run_depletion_multigroup_coupled_clean_error_e2e(tmp_path):
    """Multi-group project + coupled operator exits 1 with clean JSON (no traceback).

    Regression test for the lxml 'Start tag expected' crash from
    DataLibrary.from_xml(<mgxs.h5>) inside CoupledOperator.
    """
    import subprocess
    import sys
    from pathlib import Path

    (tmp_path / "settings.xml").write_text(
        '<?xml version="1.0"?>\n<settings>\n  <run_mode>eigenvalue</run_mode>\n'
        "  <energy_mode>multi-group</energy_mode>\n</settings>\n"
    )
    script = Path(__file__).parents[2] / "python" / "run_depletion.py"
    proc = subprocess.run(
        [sys.executable, str(script), str(tmp_path), "--time-steps", "1", "--power", "1"],
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 1
    result = json.loads(proc.stdout)
    assert result["success"] is False
    assert "Coupled depletion requires continuous-energy mode" in result["error"]
    assert "Traceback" not in proc.stderr


# ---------------------------------------------------------------------------
# run_keff_search.py
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_run_keff_search_e2e(pincell_model, pincell_dir):
    import run_keff_search

    # k-eff vs fuel density saturates above ~5 g/cm3 for this lattice, so
    # search the steep region: measure k at 2.5 g/cm3 as the target and
    # bracket [1.0, 4.0]
    fuel = [m for m in pincell_model.materials if m.name == "fuel"][0]
    fuel.set_density("g/cm3", 2.5)
    baseline_dir = pincell_dir / "baseline"
    baseline_dir.mkdir(exist_ok=True)
    sp = pincell_model.run(cwd=baseline_dir)
    target = _read_keff(sp)

    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        parameter="fuel.density",
        target=target,
        initial_guess=None,
        bracket="1.0,4.0",
        method="bisect",
        tol=0.05,
    )

    result = run_keff_search.run_search(args)

    assert result["success"] is True
    assert result["method"] == "bisect"
    # The search must land near the 2.5 g/cm3 the target was measured at
    # (loose bound: root finding on Monte-Carlo-noisy k is statistics-limited)
    assert abs(result["convergedValue"] - 2.5) < 1.0
    # Convergence property: the final k-eff matches the target within noise
    assert result["finalKeff"] == pytest.approx(target, abs=0.05)
    assert len(result["iterations"]) >= 2
    assert (pincell_dir / "keff_search_result.json").exists() is False  # written only by main()


# ---------------------------------------------------------------------------
# run_volume_calc.py
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_run_volume_calc_e2e(pincell_dir, pincell_model):
    import math

    import run_volume_calc

    fuel_id, clad_id, moderator_id = pincell_model.pincell_cell_ids
    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        domain_type="cell",
        domain_ids=f"{fuel_id},{clad_id},{moderator_id}",
        samples=5000,
        lower_left="-0.63,-0.63,-0.5",
        upper_right="0.63,0.63,0.5",
        trigger_type=None,
        trigger_threshold=None,
    )

    result = run_volume_calc.run_volume_calc(args)

    assert result["success"] is True
    volumes = {entry["id"]: entry["volume"] for entry in result["results"]}
    expected = {
        fuel_id: math.pi * 0.40**2 * 1.0,
        clad_id: math.pi * (0.50**2 - 0.40**2) * 1.0,
        moderator_id: 1.26**2 * 1.0 - math.pi * 0.50**2 * 1.0,
    }
    for cell_id, analytic in expected.items():
        assert cell_id in volumes, f"cell {cell_id} missing from volume results"
        assert volumes[cell_id] == pytest.approx(analytic, rel=0.10)


# ---------------------------------------------------------------------------
# generate_mgxs.py
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_generate_mgxs_e2e(pincell_dir):
    import generate_mgxs

    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        method="material_wise",
        groups="CASMO-2",
        particles=300,
        correction="none",
        temperatures=None,
        output="mgxs.h5",
        random_ray=False,
    )

    result = generate_mgxs.run_generate_mgxs(args)

    assert result["success"] is True
    mgxs_path = pincell_dir / "mgxs.h5"
    assert mgxs_path.exists() and mgxs_path.stat().st_size > 0


# ---------------------------------------------------------------------------
# Collision-track output (files the visualizer reads)
# ---------------------------------------------------------------------------


@pytest.mark.e2e
def test_collision_track_output_e2e(pincell_model, pincell_dir):
    """Run with collision tracking enabled and assert collision_track.h5.

    Deep reader validation belongs to the nuke-visualizer suite; here we
    prove the run produces the artifact the readers consume.
    """
    pincell_model.settings.collision_track = {"max_collisions": 50}
    pincell_model.export_to_xml(pincell_dir)

    sp = pincell_model.run(cwd=pincell_dir)
    assert os.path.exists(sp)

    ct = pincell_dir / "collision_track.h5"
    assert ct.exists() and ct.stat().st_size > 0

    import h5py

    with h5py.File(ct, "r") as f:
        assert len(f.keys()) > 0
