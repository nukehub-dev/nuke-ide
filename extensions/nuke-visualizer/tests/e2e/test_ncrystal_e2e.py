"""End-to-end test for the NCrystal commands against real NCrystal.

Loads Al_sg225.ncmat;temp=300K, checks info detail and XS sampling (non-
trivial curve, sane values at thermal energies). Skips cleanly when NCrystal
is not installed (minimal profile).
"""

import pytest

NCrystal = pytest.importorskip("NCrystal", reason="e2e requires the full NCrystal profile")

pytestmark = pytest.mark.e2e


@pytest.mark.e2e
def test_ncrystal_materials_lists_stdlib():
    from plugins.openmc.commands import ncrystal_data

    result = ncrystal_data.read_ncrystal_materials()

    assert result["success"] is True
    assert result["materialCount"] > 100  # the stdlib ships ~150 .ncmat files
    names = [m["name"] for m in result["materials"]]
    assert "Al_sg225.ncmat" in names


@pytest.mark.e2e
def test_aluminium_info_and_xs():
    from plugins.openmc.commands import ncrystal_data

    # Info: composition, temperature, structure present
    info = ncrystal_data.read_ncrystal_info("Al_sg225.ncmat;temp=300K")

    assert info["success"] is True
    assert info["temperature"] == pytest.approx(300.0)
    assert info["density"] == pytest.approx(2.70, abs=0.01)
    assert len(info["composition"]) == 1
    assert info["composition"][0]["element"] == "Al"
    assert info["structure"]["spacegroup"] == pytest.approx(225.0)

    # XS sampling: non-trivial curves, sane thermal values
    xs = ncrystal_data.read_ncrystal_xs("Al_sg225.ncmat;temp=300K", emin=1e-5, emax=1e7, points=400)

    assert xs["success"] is True
    assert len(xs["energies"]) == 400
    # Thermal absorption for Al ~ 0.23 barn at 0.0253 eV (1/v behavior)
    thermal_idx = min(range(len(xs["energies"])), key=lambda i: abs(xs["energies"][i] - 0.0253))
    assert xs["absorption"][thermal_idx] == pytest.approx(0.231, rel=0.05)
    # Scattering is non-constant across the range (Bragg edges below ~100 meV)
    assert max(xs["scatter"]) > min(xs["scatter"]) * 1.5
    # High-energy absorption is tiny
    assert xs["absorption"][-1] < 1e-3
