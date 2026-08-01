"""End-to-end test for build_chain.py: subset a real chain, then deplete with it.

Builds a small actinide subset chain from the CASL chain (NUKE_E2E_CHAIN),
verifies the FPY-borrow closure produces a loadable chain, and runs a real
1-step depletion against it via run_depletion.py. The ENDF-mode test is gated
on NUKE_E2E_ENDF (an ENDF-B decay/nfy/neutron(s) library directory).
"""

import os
from types import SimpleNamespace

import pytest
from e2e_helpers import require_chain, require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e

WANTED = ["U235", "U238", "U239", "Np239", "Pu239"]
EXPECTED_BORROW_PARENTS = ["Pu240", "Pu241"]


def require_endf_dir():
    """Return the NUKE_E2E_ENDF library directory or skip when unset/missing."""
    endf = os.environ.get("NUKE_E2E_ENDF")
    if not endf:
        pytest.skip(
            "NUKE_E2E_ENDF not set — point it at an ENDF-B library directory (decay/ nfy/ neutron(s)/)"
        )
    if not os.path.isdir(endf):
        pytest.skip(f"NUKE_E2E_ENDF points at a missing directory: {endf}")
    return endf


@pytest.mark.e2e
def test_subset_chain_build_and_deplete(pincell_dir, tmp_path):
    chain = require_chain()

    import build_chain
    import run_depletion

    # Step 1: build the subset chain
    out = tmp_path / "small_chain.xml"
    result = build_chain.build_chain(
        SimpleNamespace(
            from_chain=chain, from_endf=None, nuclides=",".join(WANTED), output=str(out)
        )
    )

    assert result["success"] is True
    assert result["mode"] == "subset"
    assert result["borrowParentsIncluded"] == EXPECTED_BORROW_PARENTS
    assert result["nuclideCount"] >= len(WANTED) + len(EXPECTED_BORROW_PARENTS)
    assert out.exists() and out.stat().st_size > 0

    # The built chain loads cleanly (the closures did their job)
    built = openmc.deplete.Chain.from_xml(str(out))
    built_names = {n.name for n in built.nuclides}
    assert set(WANTED) <= built_names
    assert set(EXPECTED_BORROW_PARENTS) <= built_names
    # The closure pulled in downstream products (U236 from U235 (n,gamma),
    # Am241 from Pu241 decay) and fission products (Ag109 from U235 fission)
    # so the chain is self-consistent for the depletion operator
    assert "U236" in built_names
    assert "Am241" in built_names
    assert "Ag109" in built_names

    # Step 2: run a real 1-step depletion with the built chain
    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        chain_file=str(out),
        time_steps="86400",
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
    depletion = run_depletion.run_depletion(args)

    assert depletion["success"] is True
    assert os.path.exists(pincell_dir / "depletion_results.h5")


@pytest.mark.e2e
def test_endf_chain_build_and_deplete(pincell_dir, tmp_path):
    """Build a chain from real ENDF-B sub-libraries and deplete against it.

    Chain.from_endf reads ENDF TEXT files only (decay/ nfy/ neutrons/); the
    full library build is ~100 s, so this is the slowest e2e in the suite.
    """
    endf = require_endf_dir()

    import build_chain
    import run_depletion

    # Step 1: build from ENDF (full library read, filtered to the closure of
    # the requested nuclides — same contract as subset mode)
    out = tmp_path / "endf_chain.xml"
    result = build_chain.build_chain(
        SimpleNamespace(from_chain=None, from_endf=endf, nuclides="U235,U238,O16", output=str(out))
    )

    assert result["success"] is True
    assert result["mode"] == "endf"
    assert out.exists() and out.stat().st_size > 0

    # The built chain loads and contains the requested nuclides (plus their
    # closure: decay/reaction targets and fission products)
    built = openmc.deplete.Chain.from_xml(str(out))
    built_names = {n.name for n in built.nuclides}
    assert {"U235", "U238", "O16"} <= built_names
    assert "U236" in built_names
    assert "Ag109" in built_names

    # Step 2: run a real 1-step depletion with the ENDF-built chain
    args = SimpleNamespace(
        working_directory=str(pincell_dir),
        chain_file=str(out),
        time_steps="86400",
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
    depletion = run_depletion.run_depletion(args)

    assert depletion["success"] is True
    assert os.path.exists(pincell_dir / "depletion_results.h5")
