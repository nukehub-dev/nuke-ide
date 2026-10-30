"""End-to-end tests for the R2S and D1S shutdown-dose drivers.

Full-profile only: each test builds a small subcritical fixed-source pincell,
exports the model XML, and runs the real driver against OpenMC. Tests skip
cleanly when OpenMC, cross sections, or a depletion chain are unavailable.

Environment:
    OPENMC_CROSS_SECTIONS  cross_sections.xml
    NUKE_E2E_CHAIN         depletion chain XML
"""

import json
import os

import pytest
from e2e_helpers import require_chain, require_cross_sections, require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e


def _build_pincell(tmp_path):
    """Build a subcritical fixed-source pincell with photon and dose tallies."""
    require_cross_sections()

    # Low-enriched UO2 with vacuum boundaries: leaky enough to stay subcritical
    # while still producing activation products.
    fuel = openmc.Material(name="fuel")
    fuel.set_density("g/cm3", 10.4)
    fuel.add_nuclide("U235", 0.007)
    fuel.add_nuclide("U238", 0.993)
    fuel.add_nuclide("O16", 2.0)
    fuel.depletable = True
    fuel.volume = 3.14159265 * 0.4**2 * 1.0

    clad = openmc.Material(name="clad")
    clad.set_density("g/cm3", 6.5)
    clad.add_element("Zr", 1.0)

    moderator = openmc.Material(name="moderator")
    moderator.set_density("g/cm3", 1.0)
    moderator.add_nuclide("H1", 2.0)
    moderator.add_nuclide("O16", 1.0)

    materials = openmc.Materials([fuel, clad, moderator])

    fuel_cyl = openmc.ZCylinder(r=0.40)
    clad_cyl = openmc.ZCylinder(r=0.50)
    box = openmc.model.RectangularPrism(1.26, 1.26, boundary_type="vacuum")
    z_lo = openmc.ZPlane(z0=-0.5, boundary_type="vacuum")
    z_hi = openmc.ZPlane(z0=0.5, boundary_type="vacuum")

    fuel_cell = openmc.Cell(name="fuel", fill=fuel, region=-fuel_cyl & +z_lo & -z_hi)
    fuel_cell.volume = fuel.volume
    clad_cell = openmc.Cell(name="clad", fill=clad, region=+fuel_cyl & -clad_cyl & +z_lo & -z_hi)
    clad_cell.volume = 3.14159265 * (0.50**2 - 0.40**2)
    moderator_cell = openmc.Cell(
        name="moderator", fill=moderator, region=+clad_cyl & -box & +z_lo & -z_hi
    )
    moderator_cell.volume = 1.26 * 1.26 - 3.14159265 * 0.50**2

    geometry = openmc.Geometry([fuel_cell, clad_cell, moderator_cell])

    settings = openmc.Settings()
    settings.run_mode = "fixed source"
    settings.particles = 200
    settings.batches = 3
    settings.source = openmc.IndependentSource(
        space=openmc.stats.Point((0.0, 0.0, 0.0)), particle="neutron"
    )

    # Dose tally: photon flux weighted by OpenMC's ICRP-116 effective-dose data.
    energy, response = openmc.data.dose_coefficients("photon", "AP", "icrp116", "effective")
    dose_tally = openmc.Tally(name="photon dose")
    dose_tally.filters = [
        openmc.ParticleFilter("photon"),
        openmc.EnergyFunctionFilter(energy, response, interpolation="log-log"),
    ]
    dose_tally.scores = ["flux"]

    # A second plain photon tally for the parent-nuclide breakdown test.
    flux_tally = openmc.Tally(name="photon flux")
    flux_tally.filters = [openmc.ParticleFilter("photon")]
    flux_tally.scores = ["flux"]

    # Two non-overlapping activation meshes (fuel region and moderator region).
    fuel_mesh = openmc.RegularMesh()
    fuel_mesh.id = 101
    fuel_mesh.lower_left = (-0.6, -0.6, -0.49)
    fuel_mesh.upper_right = (0.49, 0.6, 0.49)
    fuel_mesh.dimension = (2, 2, 1)
    moderator_mesh = openmc.RegularMesh()
    moderator_mesh.id = 102
    moderator_mesh.lower_left = (0.5, -0.6, -0.49)
    moderator_mesh.upper_right = (0.62, 0.6, 0.49)
    moderator_mesh.dimension = (2, 2, 1)
    mesh_tally = openmc.Tally(name="photon mesh flux")
    mesh_tally.filters = [openmc.ParticleFilter("photon"), openmc.MeshFilter(fuel_mesh)]
    mesh_tally.scores = ["flux"]
    second_mesh_tally = openmc.Tally(name="photon mesh flux 2")
    second_mesh_tally.filters = [openmc.ParticleFilter("photon"), openmc.MeshFilter(moderator_mesh)]
    second_mesh_tally.scores = ["flux"]

    model = openmc.Model(
        geometry=geometry,
        materials=materials,
        settings=settings,
        tallies=openmc.Tallies([dose_tally, flux_tally, mesh_tally, second_mesh_tally]),
    )
    model.export_to_xml(tmp_path)
    return {
        "working_directory": str(tmp_path),
        "cell_id": fuel_cell.id,
        "dose_tally_id": dose_tally.id,
        "flux_tally_id": flux_tally.id,
        "mesh_tally_id": mesh_tally.id,
        "second_mesh_tally_id": second_mesh_tally.id,
    }


def _load_summary(result):
    path = os.path.join(result["outputDirectory"], "r2s_summary.json")
    if not os.path.exists(path):
        path = os.path.join(result["outputDirectory"], "d1s_summary.json")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def test_cell_based_r2s_e2e(tmp_path):
    """Cell-based R2S with a dose tally and parent-nuclide breakdown."""
    chain = require_chain()
    fixture = _build_pincell(tmp_path)

    import run_r2s

    config = {
        "method": "r2s",
        "domainType": "cell",
        "cellIds": [fixture["cell_id"]],
        "timesteps": ["1 d"],
        "timestepUnits": "s",
        "sourceRates": [1e15],
        "chainFile": chain,
        "photonTimeIndices": [1],
        "photonTallyIds": [fixture["dose_tally_id"], fixture["flux_tally_id"]],
        "doseTallyId": fixture["dose_tally_id"],
        "byParentNuclide": True,
        "outputDirectory": str(tmp_path / "r2s-output"),
    }

    result = run_r2s.run_r2s(config, fixture["working_directory"])

    assert result["success"] is True
    assert os.path.isdir(result["outputDirectory"])
    assert result["statepoint"] and os.path.exists(result["statepoint"])
    summary = result["summary"]
    assert summary["method"] == "r2s"
    assert summary["activationRegions"] == 1
    assert summary["photonTallies"] == 2
    assert summary["photonTimeIndices"] == [1]
    assert summary["dose"] is not None and summary["dose"]["peak"] > 0
    assert summary["activity"] is not None and summary["activity"]["totalBq"][-1] > 0
    assert summary["decayHeat"] is not None and summary["decayHeat"]["totalW"][-1] > 0
    assert any(tally.get("parentNuclides") for tally in summary["photonTallySummaries"])
    assert _load_summary(result)["success"] is True


def test_mesh_based_r2s_e2e(tmp_path):
    """Mesh-based R2S with two non-overlapping activation meshes."""
    chain = require_chain()
    fixture = _build_pincell(tmp_path)

    import run_r2s

    config = {
        "method": "r2s",
        "domainType": "mesh",
        "meshIds": [101, 102],
        "timesteps": [1],
        "timestepUnits": "d",
        "sourceRates": [1e15],
        "chainFile": chain,
        "photonTimeIndices": [1],
        "photonTallyIds": [fixture["mesh_tally_id"], fixture["second_mesh_tally_id"]],
        "matVolSamples": 2000,
        "outputDirectory": str(tmp_path / "r2s-mesh-output"),
    }

    result = run_r2s.run_r2s(config, fixture["working_directory"])

    assert result["success"] is True
    summary = result["summary"]
    assert summary["method"] == "r2s"
    assert summary["activationRegions"] > 1
    assert summary["photonTallies"] == 2
    assert summary["photonTimeIndices"] == [1]


def test_d1s_e2e(tmp_path):
    """D1S applies time correction factors to a real photon tally."""
    chain = require_chain()
    fixture = _build_pincell(tmp_path)

    import run_d1s

    config = {
        "method": "d1s",
        "timesteps": ["1 d"],
        "timestepUnits": "s",
        "sourceRates": [1e15],
        "chainFile": chain,
        "photonTallyIds": [fixture["dose_tally_id"], fixture["flux_tally_id"]],
        "doseTallyId": fixture["dose_tally_id"],
        "d1sTimeIndex": -1,
        "d1sSumNuclides": True,
        "outputDirectory": str(tmp_path / "d1s-output"),
    }

    result = run_d1s.run_d1s(config, fixture["working_directory"])

    assert result["success"] is True
    assert result["statepoint"] and os.path.exists(result["statepoint"])
    summary = result["summary"]
    assert summary["method"] == "d1s"
    assert summary["photonTallies"] == 2
    assert summary["timeCorrectionFactors"]
    assert all(value > 0 for value in summary["timeCorrectionFactors"].values())
    assert summary["dose"] is not None and summary["dose"]["peak"] > 0
    assert all(tally.get("parentNuclides") for tally in summary["photonTallySummaries"])
    assert _load_summary(result)["success"] is True
