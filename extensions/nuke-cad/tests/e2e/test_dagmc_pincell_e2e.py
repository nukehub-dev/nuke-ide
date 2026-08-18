"""End-to-end: pincell STEP -> DAGMC h5m (imprinting export) -> real OpenMC run.

M2 acceptance criterion of the nuke-cad extension plan: a labeled build123d
pincell is exported to STEP by the geometry service, converted to h5m by the
imprinting DAGMC export (named ``mat:<name>`` groups from the region manifest,
auto-created graveyard), and run in OpenMC with zero lost particles.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

# Env gates (repo convention: no machine-specific defaults; skip cleanly).
if not os.environ.get("NUKE_TEST_PYTHON"):
    pytest.skip(
        "NUKE_TEST_PYTHON not set — e2e requires the full-dependency Python environment",
        allow_module_level=True,
    )
_XS = os.environ.get("OPENMC_CROSS_SECTIONS")
if not _XS:
    pytest.skip(
        "OPENMC_CROSS_SECTIONS not set — point it at a cross_sections.xml "
        "(see openmc.org data libraries)",
        allow_module_level=True,
    )
if not os.path.exists(_XS):
    pytest.skip(f"OPENMC_CROSS_SECTIONS points at a missing file: {_XS}", allow_module_level=True)

openmc = pytest.importorskip("openmc", reason="e2e requires the full OpenMC profile")
pytest.importorskip("build123d", reason="e2e requires build123d")
pytest.importorskip("gmsh", reason="e2e requires gmsh")
pytest.importorskip("pymoab", reason="e2e requires pymoab")

import geometry_service  # noqa: E402

# Pincell proportions (fuel r=0.40, clad r=0.50, pitch 1.26, height 1.0) match
# the openmc-studio e2e CSG pincell. The STEP round-trip is unit-agnostic — the
# authored numbers pass through to the h5m, so OpenMC reads them as cm.
PINCELL_SCRIPT = """\
from build123d import *

fuel = Cylinder(radius=0.40, height=1.0)
fuel.label = "fuel"
clad = Cylinder(radius=0.50, height=1.0) - Cylinder(radius=0.40, height=1.0)
clad.label = "clad"
moderator = Box(1.26, 1.26, 1.0) - Cylinder(radius=0.50, height=1.0)
moderator.label = "moderator"
model = Compound(children=[fuel, clad, moderator])
"""

REGIONS = {
    "version": 1,
    "volumes": [
        {"selector": "fuel", "name": "fuel", "material": "fuel"},
        {"selector": "clad", "name": "clad", "material": "clad"},
        {"selector": "moderator", "name": "moderator", "material": "moderator"},
    ],
}


def _build_pincell_h5m(work: Path) -> Path:
    """Run the geometry service script -> STEP -> h5m pipeline; return the h5m path."""
    script = work / "pincell.py"
    script.write_text(PINCELL_SCRIPT)
    manifest = work / "pincell.regions.json"
    manifest.write_text(json.dumps(REGIONS))

    result = geometry_service.build_geometry(
        str(script),
        output_dir=str(work),
        export_dagmc=True,
        export_mesh=False,
        add_graveyard=True,
        tolerance=0.01,
    )
    assert result["success"] is True, result.get("error", "")

    selector_map = result.get("selectorMap") or {}
    assert set(selector_map) == {"fuel", "clad", "moderator"}, selector_map
    indices = [idx for ids in selector_map.values() for idx in ids]
    assert len(indices) == len(set(indices)) == 3, selector_map

    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")
    h5m_path = Path(result["dagmcPath"])
    assert h5m_path.exists()
    return h5m_path


def _h5m_group_names(h5m_path: Path) -> set[str]:
    """Return the mat:<name> group names in the h5m file."""
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    mb.load_file(str(h5m_path))

    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    name_tag = mb.tag_get_handle(moab_types.NAME_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)

    groups = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Group"]
    )
    names: set[str] = set()
    for gset in groups:
        if mb.tag_get_data(gdim_tag, gset)[0][0] != 4:
            continue
        raw = mb.tag_get_data(name_tag, gset)[0][0]
        names.add(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
    return names


def _build_openmc_model(h5m_path: Path):
    """Build the OpenMC model: DAGMC universe from the h5m, materials bound by
    manifest name (mat:fuel -> material 'fuel'). The mat:graveyard volume is
    OpenMC's vacuum terminator and needs no material."""
    fuel = openmc.Material(name="fuel")
    fuel.set_density("g/cm3", 10.4)
    fuel.add_nuclide("U235", 0.03)
    fuel.add_nuclide("U238", 0.97)
    fuel.add_nuclide("O16", 2.0)

    clad = openmc.Material(name="clad")
    clad.set_density("g/cm3", 6.5)
    clad.add_element("Zr", 1.0)

    moderator = openmc.Material(name="moderator")
    moderator.set_density("g/cm3", 1.0)
    moderator.add_element("H", 2.0)
    moderator.add_nuclide("O16", 1.0)
    moderator.add_s_alpha_beta("c_H_in_H2O")

    materials = openmc.Materials([fuel, clad, moderator])
    geometry = openmc.Geometry(openmc.DAGMCUniverse(str(h5m_path)))

    settings = openmc.Settings()
    settings.run_mode = "eigenvalue"
    settings.particles = 300
    settings.inactive = 4
    settings.batches = 12
    settings.source = openmc.IndependentSource(space=openmc.stats.Point((0.0, 0.0, 0.0)))
    # Zero-lost-particles contract: the first lost particle aborts the run
    # (max_lost_particles=1 dominates rel_max_lost_particles for this run size).
    settings.max_lost_particles = 1

    return openmc.Model(geometry=geometry, materials=materials, settings=settings)


def test_dagmc_pincell_export_groups(tmp_path: Path) -> None:
    """The imprinting export names material groups from the region manifest."""
    h5m_path = _build_pincell_h5m(tmp_path)

    groups = _h5m_group_names(h5m_path)
    assert "mat:fuel" in groups, groups
    assert "mat:clad" in groups, groups
    assert "mat:moderator" in groups, groups
    assert "mat:graveyard" in groups, groups


def test_dagmc_pincell_openmc_run_zero_lost_particles(tmp_path: Path) -> None:
    """The exported pincell h5m runs a real OpenMC eigenvalue calculation with
    zero lost particles."""
    h5m_path = _build_pincell_h5m(tmp_path)

    model = _build_openmc_model(h5m_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    shutil.copy(h5m_path, run_dir / "geometry.h5m")
    model.geometry = openmc.Geometry(openmc.DAGMCUniverse(str(run_dir / "geometry.h5m")))
    model.export_to_xml(str(run_dir))

    openmc_exe = shutil.which("openmc")
    assert openmc_exe is not None, "openmc executable not found on PATH"
    proc = subprocess.run(
        [openmc_exe],
        cwd=str(run_dir),
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, (
        f"openmc exited with {proc.returncode}\n"
        f"stdout tail:\n{proc.stdout[-2000:]}\nstderr tail:\n{proc.stderr[-2000:]}"
    )

    # Zero lost particles: no lost-particle warnings, no particle restart files
    # (each lost particle writes particle_<batch>_<id>.h5 by default).
    lost_lines = [line for line in proc.stdout.splitlines() if "lost" in line.lower()]
    assert lost_lines == [], f"lost-particle warnings in output: {lost_lines[:5]}"
    restart_files = sorted(run_dir.glob("particle_*.h5"))
    assert restart_files == [], f"lost-particle restart files written: {restart_files}"

    statepoints = sorted(run_dir.glob("statepoint.*.h5"))
    assert statepoints, "no statepoint produced"
    with openmc.StatePoint(str(statepoints[-1])) as sp:
        keff = sp.keff.nominal_value
    # The 1-cm-tall pincell with a vacuum (graveyard) boundary is extremely
    # leaky: the equivalent CSG model with identical vacuum bounds gives
    # k-eff ~= 0.0076 with ~99.7% leakage. Wide plausibility band.
    assert 0.001 < keff < 2.5, f"implausible k-eff: {keff}"
