"""Pytest configuration for the openmc-studio end-to-end suite.

These tests run REAL OpenMC simulations against the extension's run drivers.
They only run in the full-dependency profile (openmc installed, cross sections
available); every test skips cleanly in the minimal pytest+numpy profile.

Environment (no defaults — tests skip when these are unset):
    OPENMC_CROSS_SECTIONS  Path to cross_sections.xml (required for model runs)
    NUKE_E2E_CHAIN         Path to a depletion chain (required for depletion e2e)
"""

import os
import sys

import pytest
from e2e_helpers import require_cross_sections, require_openmc

# Driver modules live in python/ (same convention as tests/python/conftest.py)
_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)

# The openmc executable must be discoverable for Model.run() — put the running
# interpreter's bin directory first on PATH (the full profile runs pytest with
# the environment python, so its sibling openmc binary is found).
_BIN_DIR = os.path.dirname(sys.executable)
if os.path.exists(os.path.join(_BIN_DIR, "openmc")) and _BIN_DIR not in os.environ.get(
    "PATH", ""
).split(os.pathsep):
    os.environ["PATH"] = _BIN_DIR + os.pathsep + os.environ.get("PATH", "")


@pytest.fixture(autouse=True)
def _restore_cwd():
    """Drivers chdir into their working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


@pytest.fixture()
def pincell_model():
    """A tiny 3-cell pincell model (fuel/clad/moderator, reflective on all
    sides): 300 particles, 4 inactive + 8 active batches — runs in seconds.

    Geometry: fuel r=0.40, clad r=0.50, pitch 1.26, height 1.0.
    """
    require_cross_sections()
    openmc = require_openmc()

    # Materials (explicit O16: the NNDC library has no O18, and element
    # expansion would require it)
    fuel = openmc.Material(name="fuel")
    fuel.set_density("g/cm3", 10.4)
    fuel.add_nuclide("U235", 0.03)
    fuel.add_nuclide("U238", 0.97)
    fuel.add_nuclide("O16", 2.0)
    fuel.depletable = True
    fuel.volume = 3.14159265 * 0.40**2 * 1.0

    clad = openmc.Material(name="clad")
    clad.set_density("g/cm3", 6.5)
    clad.add_element("Zr", 1.0)

    moderator = openmc.Material(name="moderator")
    moderator.set_density("g/cm3", 1.0)
    moderator.add_element("H", 2.0)
    moderator.add_nuclide("O16", 1.0)
    moderator.add_s_alpha_beta("c_H_in_H2O")

    materials = openmc.Materials([fuel, clad, moderator])

    # Geometry: 3-cell pincell, reflective on all sides (infinite lattice,
    # k_eff ~ 1); volume calc uses explicit bounds so z stays measurable
    fuel_cyl = openmc.ZCylinder(r=0.40)
    clad_cyl = openmc.ZCylinder(r=0.50)
    box = openmc.model.RectangularPrism(1.26, 1.26, boundary_type="reflective")
    z_lo = openmc.ZPlane(z0=-0.5, boundary_type="reflective")
    z_hi = openmc.ZPlane(z0=0.5, boundary_type="reflective")

    fuel_cell = openmc.Cell(name="fuel", fill=fuel, region=-fuel_cyl & +z_lo & -z_hi)
    clad_cell = openmc.Cell(name="clad", fill=clad, region=+fuel_cyl & -clad_cyl & +z_lo & -z_hi)
    moderator_cell = openmc.Cell(
        name="moderator", fill=moderator, region=+clad_cyl & -box & +z_lo & -z_hi
    )

    geometry = openmc.Geometry([fuel_cell, clad_cell, moderator_cell])

    # Settings: tiny eigenvalue run
    settings = openmc.Settings()
    settings.run_mode = "eigenvalue"
    settings.particles = 300
    settings.inactive = 4
    settings.batches = 12
    settings.source = openmc.IndependentSource(space=openmc.stats.Point((0.0, 0.0, 0.0)))

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)
    model.pincell_cell_ids = (fuel_cell.id, clad_cell.id, moderator_cell.id)
    return model


@pytest.fixture()
def pincell_dir(pincell_model, tmp_path):
    """Export the pincell model XML into a temp working directory."""
    pincell_model.export_to_xml(tmp_path)
    return tmp_path
