"""End-to-end test for the ENDF commands against a real ENDF-B library.

Gated on NUKE_E2E_ENDF (point it at an ENDF-B root containing decay/, nfy/,
neutrons/ sub-directories). Verifies U235 decay (half-life ≈ 7.04e8 y), FPY
(top products present), and the neutron evaluation (MT 18 present). Skips
cleanly when the variable is unset.
"""

import os

import pytest

openmc = pytest.importorskip("openmc", reason="e2e requires the full OpenMC profile")

pytestmark = pytest.mark.e2e


def require_endf_dir():
    """Return the NUKE_E2E_ENDF library dir or skip when unset/missing."""
    path = os.environ.get("NUKE_E2E_ENDF")
    if not path:
        pytest.skip("NUKE_E2E_ENDF not set — point it at an ENDF-B library directory")
    if not os.path.isdir(path):
        pytest.skip(f"NUKE_E2E_ENDF points at a missing directory: {path}")
    return path


@pytest.mark.e2e
def test_evaluations_scan_and_u235_details():
    endf_dir = require_endf_dir()

    from plugins.openmc.commands import endf_data

    # Library scan: sub-libraries present, U235 covered in each kind
    result = endf_data.read_endf_evaluations(endf_dir)

    assert result["success"] is True
    by_name = {s["name"]: s for s in result["sublibraries"]}
    assert "decay" in by_name and "nfy" in by_name and "neutrons" in by_name

    u235 = {}
    for kind in ("decay", "nfy", "neutrons"):
        matches = [n for n in by_name[kind]["nuclides"] if n["name"] == "U235"]
        assert matches, f"U235 missing from {kind} sub-library"
        u235[kind] = matches[0]["file"]

    # Decay: half-life ≈ 7.04e8 years, alpha mode to Th231
    decay = endf_data.read_endf_detail(u235["decay"])

    assert decay["success"] is True and decay["kind"] == "decay"
    assert decay["nuclide"] == "U235"
    assert decay["halfLife"]["years"] == pytest.approx(7.04e8, rel=0.01)
    modes = {(tuple(m["modes"]), m["daughter"]): m["branchingRatio"] for m in decay["modes"]}
    assert (("alpha",), "Th231") in modes
    assert modes[(("alpha",), "Th231")] == pytest.approx(1.0)

    # FPY: thermal yields — top product Te134 present, total ≈ 2
    fpy = endf_data.read_endf_detail(u235["nfy"])

    assert fpy["success"] is True and fpy["kind"] == "nfy"
    thermal = min(fpy["energies"], key=lambda e: e["energy"])
    assert thermal["energy"] == pytest.approx(0.0253, rel=1e-3)
    assert thermal["productCount"] > 1000
    top_names = [p["nuclide"] for p in thermal["topProducts"]]
    assert top_names[0] == "Te134"
    assert "Xe138" in top_names
    assert thermal["totalYield"] == pytest.approx(2.0, rel=0.01)

    # Neutron evaluation: ZA and fission channel
    neutron = endf_data.read_endf_detail(u235["neutrons"])

    assert neutron["success"] is True and neutron["kind"] == "neutron"
    assert neutron["za"] == 92235
    mts = {r["mt"] for r in neutron["reactions"] if r["mf"] == 3}
    assert 18 in mts, "U235 must carry the (n,fission) MT 18 channel"
    assert 2 in mts and 102 in mts
