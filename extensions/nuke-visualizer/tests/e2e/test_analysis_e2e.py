"""End-to-end checks for entropy, contact dose, and decay spectra.

Entropy runs a real tiny eigenvalue model with an entropy mesh; the
depletion commands read a committed real activation result and the
OPENMC_CHAIN_FILE chain. Both paths skip cleanly in the minimal profile.
"""

import argparse
import json
from pathlib import Path

import pytest
from nuke_viz.plugin import setup_parser_for_handler
from plugins.openmc.commands import depletion as depletion_cmds
from plugins.openmc.commands import statepoint as statepoint_cmds
from visualizer_e2e_helpers import require_chain, require_cross_sections, require_openmc

pytestmark = pytest.mark.e2e

ASSET = Path(__file__).parent / "assets" / "depletion_results.h5"


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


def test_entropy_statepoint_e2e(tmp_path, capsys):
    """A real eigenvalue run writes entropy, and the reader returns it."""
    openmc = require_openmc()
    require_cross_sections()
    pytest.importorskip("h5py")

    material = openmc.Material(name="fuel")
    material.add_nuclide("U235", 1.0)
    material.set_density("g/cm3", 18.0)
    sphere = openmc.Sphere(r=6.0, boundary_type="vacuum")
    model = openmc.Model()
    model.geometry = openmc.Geometry([openmc.Cell(fill=material, region=-sphere)])
    model.settings.batches = 6
    model.settings.inactive = 2
    model.settings.particles = 100

    mesh = openmc.RegularMesh()
    mesh.lower_left = [-6.0, -6.0, -6.0]
    mesh.upper_right = [6.0, 6.0, 6.0]
    mesh.dimension = [2, 2, 2]
    model.settings.entropy_mesh = mesh
    model.export_to_xml(tmp_path)

    openmc.run(cwd=str(tmp_path), output=False)
    statepoint = tmp_path / "statepoint.6.h5"
    assert statepoint.exists()

    args = _parse(statepoint_cmds.cmd_statepoint_info, [str(statepoint)])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0
    payload = _stdout_json(capsys)

    with openmc.StatePoint(str(statepoint)) as sp:
        expected = [float(value) for value in sp.entropy]
    assert payload["nBatches"] == 6
    assert payload["nInactive"] == 2
    assert payload["entropy"] == pytest.approx(expected)
    assert payload["cmfdEntropy"] is None


def test_depletion_summary_uses_beginning_of_step_times(capsys):
    """The summary time axis starts at t=0 and keeps the final state time."""
    require_openmc()
    pytest.importorskip("vtk")
    assert ASSET.exists()

    args = _parse(depletion_cmds.cmd_depletion_summary, [str(ASSET)])
    assert depletion_cmds.cmd_depletion_summary(args) == 0
    payload = _stdout_json(capsys)

    assert payload["timeDays"][0] == pytest.approx(0.0)
    assert payload["timeDays"][-1] == pytest.approx(1.0)
    assert payload["nSteps"] == 2


def test_depletion_contact_dose_e2e(capsys):
    """Contact dose runs on a real activated material with chain data."""
    require_openmc()
    chain = require_chain()
    assert ASSET.exists()

    args = _parse(
        depletion_cmds.cmd_depletion_contact_dose,
        [str(ASSET), "4", "--by-nuclide", "--chain-file", chain],
    )
    assert depletion_cmds.cmd_depletion_contact_dose(args) == 0
    payload = _stdout_json(capsys)

    assert payload["success"] is True
    assert payload["unit"] == "Gy/h"
    assert payload["buildUp"] == pytest.approx(2.0)
    assert payload["contributingNuclides"] > 0
    assert payload["total"][-1] > 0
    assert payload["byNuclide"]
    assert payload["byNuclide"][0]["values"][-1] > 0
    assert "Bremsstrahlung" in payload["caveat"]


def test_depletion_decay_spectrum_e2e(capsys):
    """Decay-photon lines and total activity come from the real chain."""
    require_openmc()
    chain = require_chain()
    assert ASSET.exists()

    args = _parse(
        depletion_cmds.cmd_depletion_decay_spectrum,
        [str(ASSET), "4", "1", "--chain-file", chain],
    )
    assert depletion_cmds.cmd_depletion_decay_spectrum(args) == 0
    payload = _stdout_json(capsys)

    assert payload["success"] is True
    assert payload["totalActivityBq"] > 0
    assert payload["totalPhotonIntensityBq"] > 0
    assert payload["lines"]
    assert all(line["energyEv"] > 0 for line in payload["lines"][:10])
    assert payload["timeDays"] == pytest.approx(1.0)
