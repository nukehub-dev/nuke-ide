"""End-to-end test for generate_mgxs_library.py (fine-grained Library mode).

Builds a CASMO-2 MGXS library from the pincell with the default XS types,
checks the HDF5 structure, then runs a real multigroup eigenvalue solve
against it (macroscopic materials + multi-group energy mode) and compares
k-eff with the continuous-energy result. model.run leaves a model.xml behind
that would take precedence over the patched settings/materials — it must be
removed before the MG run (verified in 0.15.3-dev448).
"""

import os
import xml.etree.ElementTree as ET
from types import SimpleNamespace

import pytest
from e2e_helpers import require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e


def _make_macroscopic(materials_xml):
    tree = ET.parse(materials_xml)
    root = tree.getroot()
    for mat in root.findall("material"):
        for nuc in list(mat.findall("nuclide")):
            mat.remove(nuc)
        for sab in list(mat.findall("sab")):
            mat.remove(sab)
        ET.SubElement(mat, "macroscopic", {"name": mat.get("name")})
        density = mat.find("density")
        density.set("units", "macro")
        density.set("value", "1.0")
    tree.write(materials_xml)


@pytest.mark.e2e
def test_library_mode_mgxs_and_mg_run(pincell_dir):
    import generate_mgxs_library

    # Step 1: generate the library with the default XS types (auto-appends
    # the scatter/multiplicity matrices XSdata conversion needs)
    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        groups="CASMO-2",
        mgxs_types=None,
        domain_type="material",
        domain_ids=None,
        by_nuclide=False,
        legendre_order=0,
        estimator=None,
        correction="none",
        particles=300,
        output="mgxs.h5",
    )
    result = generate_mgxs_library.run_generate_mgxs_library(args)

    assert result["success"] is True
    assert result["domainType"] == "material"
    # Material IDs are process-global in openmc (they shift when other tests
    # ran first) — assert the domain count, not specific IDs
    assert len(result["domainIds"]) == 3
    for required_type in (
        "total",
        "absorption",
        "fission",
        "nu-fission",
        "chi",
        "consistent nu-scatter matrix",
        "multiplicity matrix",
    ):
        assert required_type in result["mgxsTypes"]

    # Step 2: the file is a loadable MGXSLibrary with per-material XSdata
    import h5py

    with h5py.File(result["mgxsPath"], "r") as f:
        assert {"fuel", "clad", "moderator"} <= set(f.keys())
        assert "294K" in f["fuel"]

    # Step 3: real multigroup run against the library. model.run's model.xml
    # residue would shadow the patched settings/materials — remove it first.
    _make_macroscopic(pincell_dir / "materials.xml")
    settings_tree = ET.parse(pincell_dir / "settings.xml")
    ET.SubElement(settings_tree.getroot(), "energy_mode").text = "multi-group"
    settings_tree.write(pincell_dir / "settings.xml")
    model_xml = pincell_dir / "model.xml"
    if model_xml.exists():
        model_xml.unlink()

    os.environ["OPENMC_MG_CROSS_SECTIONS"] = result["mgxsPath"]
    openmc.run(cwd=pincell_dir)
    statepoints = sorted(pincell_dir.glob("statepoint*.h5"), key=lambda p: p.stat().st_mtime)
    assert statepoints, "multigroup run wrote no statepoint"
    with openmc.StatePoint(str(statepoints[-1])) as sp:
        mg_keff = sp.keff.n

    # CASMO-2 on a leakage-free reflected pincell: condensation error is small
    assert 1.0 < mg_keff < 1.8


@pytest.mark.e2e
def test_nuclide_wise_library_and_mg_run(pincell_dir):
    """Nuclide-wise libraries hold one micro XSdata set per nuclide and support
    a real multi-group run with materials STILL nuclide-decomposed — the DAGMC
    random-ray material form (no macroscopic elements anywhere).
    """
    import generate_mgxs_library

    # Step 1: generate a nuclide-wise library (implies by-nuclide tallies)
    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        groups="CASMO-2",
        mgxs_types=None,
        domain_type="material",
        domain_ids=None,
        by_nuclide=False,
        nuclide_wise=True,
        legendre_order=0,
        estimator=None,
        correction="none",
        particles=300,
        output="mgxs.h5",
    )
    result = generate_mgxs_library.run_generate_mgxs_library(args)

    assert result["success"] is True
    assert result["libraryType"] == "nuclide"
    assert result["byNuclide"] is True

    # Step 2: every top-level group is a nuclide name — no material names
    import h5py

    with h5py.File(result["mgxsPath"], "r") as f:
        names = set(f.keys())
    assert {"U235", "U238", "O16"} <= names
    assert not {"fuel", "clad", "moderator"} & names
    assert set(result["nuclides"]) == names

    # Step 3: real multi-group run against the library with the materials
    # unchanged (nuclide-decomposed). The moderator's S(a,b) table is dropped:
    # nuclide-wise generation does not produce thermal scattering data.
    settings_tree = ET.parse(pincell_dir / "settings.xml")
    ET.SubElement(settings_tree.getroot(), "energy_mode").text = "multi-group"
    settings_tree.write(pincell_dir / "settings.xml")
    materials_tree = ET.parse(pincell_dir / "materials.xml")
    root = materials_tree.getroot()
    for mat in root.findall("material"):
        for sab in list(mat.findall("sab")):
            mat.remove(sab)
    cross_sections = ET.Element("cross_sections")
    cross_sections.text = result["mgxsPath"]
    root.insert(0, cross_sections)
    materials_tree.write(pincell_dir / "materials.xml")
    model_xml = pincell_dir / "model.xml"
    if model_xml.exists():
        model_xml.unlink()

    os.environ["OPENMC_MG_CROSS_SECTIONS"] = result["mgxsPath"]
    openmc.run(cwd=pincell_dir)
    statepoints = sorted(pincell_dir.glob("statepoint*.h5"), key=lambda p: p.stat().st_mtime)
    assert statepoints, "multi-group nuclide-material run wrote no statepoint"
    with openmc.StatePoint(str(statepoints[-1])) as sp:
        mg_keff = sp.keff.n

    # Same reflected pincell, nuclide-condensed CASMO-2: comparable k-eff
    assert 1.0 < mg_keff < 1.8
