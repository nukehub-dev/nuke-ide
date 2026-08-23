"""End-to-end: GUI-authored tokamak document -> DAGMC h5m.

The .nuke-cad fixture committed by the GUI-path vitest driver is built through
``geometry_service.build_document``, exported to an imprinted DAGMC h5m with
named material groups from the region manifest, and optionally run in OpenMC.

The tokamak model is intentionally a CAD assembly: several bodies overlap in
space (for example the TF coil frame with poloidal coils). The DAGMC export is
therefore a geometry smoke test rather than a sealed reactor model; a full
particle-transport run would need the overlaps resolved first.
"""

# *****************************************************************************
# Copyright (C) 2024 NukeHub and others.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

if not os.environ.get("NUKE_TEST_PYTHON"):
    pytest.skip(
        "NUKE_TEST_PYTHON not set — e2e requires the full-dependency Python environment",
        allow_module_level=True,
    )

openmc = pytest.importorskip("openmc", reason="e2e requires the full OpenMC profile")
pytest.importorskip("build123d", reason="e2e requires build123d")
pytest.importorskip("gmsh", reason="e2e requires gmsh")
pytest.importorskip("pymoab", reason="e2e requires pymoab")

import feature_builder  # noqa: E402
import geometry_service  # noqa: E402

_FIXTURE = Path(__file__).parent / "assets" / "tokamak_with_divertor.nuke-cad"

# The fixture is authored in millimetres (STEP/source units). The DAGMC/OpenMC
# pipeline expects centimetres, so the e2e build scales by 0.1.
_LENGTH_SCALE = 0.1

_REGIONS = {
    "version": 1,
    "volumes": [
        {"selector": "tf_coils", "name": "tf_coils", "material": "copper"},
        {"selector": "pf_coil_1", "name": "pf_coil_1", "material": "copper"},
        {"selector": "pf_case_1", "name": "pf_case_1", "material": "steel"},
        {"selector": "pf_coil_2", "name": "pf_coil_2", "material": "copper"},
        {"selector": "pf_case_2", "name": "pf_case_2", "material": "steel"},
        {"selector": "pf_coil_3", "name": "pf_coil_3", "material": "copper"},
        {"selector": "pf_case_3", "name": "pf_case_3", "material": "steel"},
        {"selector": "pf_coil_4", "name": "pf_coil_4", "material": "copper"},
        {"selector": "pf_case_4", "name": "pf_case_4", "material": "steel"},
        {"selector": "divertor", "name": "divertor", "material": "tungsten"},
        {"selector": "tf_inner_leg_1", "name": "tf_inner_leg_1", "material": "steel"},
        {"selector": "tf_inner_leg_2", "name": "tf_inner_leg_2", "material": "steel"},
        {"selector": "tf_inner_leg_3", "name": "tf_inner_leg_3", "material": "steel"},
        {"selector": "tf_inner_leg_4", "name": "tf_inner_leg_4", "material": "steel"},
        {"selector": "tf_inner_leg_5", "name": "tf_inner_leg_5", "material": "steel"},
        {"selector": "tf_inner_leg_6", "name": "tf_inner_leg_6", "material": "steel"},
        {"selector": "center_column", "name": "center_column", "material": "steel"},
        {"selector": "inboard_blanket", "name": "inboard_blanket", "material": "lithium_lead"},
        {"selector": "first_wall_inboard", "name": "first_wall_inboard", "material": "steel"},
        {"selector": "first_wall_outboard", "name": "first_wall_outboard", "material": "steel"},
        {"selector": "outboard_blanket", "name": "outboard_blanket", "material": "lithium_lead"},
        {"selector": "plasma", "name": "plasma", "material": "dt_plasma"},
    ],
}


def _build_tokamak_h5m(work: Path) -> Path:
    """Build the committed tokamak document -> STEP -> h5m; return the h5m path."""
    doc = work / "tokamak_with_divertor.nuke-cad"
    doc.write_text(_FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
    manifest = work / "tokamak_with_divertor.regions.json"
    manifest.write_text(json.dumps(_REGIONS))

    result = geometry_service.build_document(
        str(doc),
        output_dir=str(work),
        export_dagmc=True,
        export_mesh=False,
        add_graveyard=True,
        tolerance=2.0,
        length_scale=_LENGTH_SCALE,
    )
    assert result["success"] is True, result.get("error", "")

    selector_map = result.get("selectorMap") or {}
    expected = {entry["selector"] for entry in _REGIONS["volumes"]}
    assert expected.issubset(set(selector_map)), selector_map

    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")
    h5m_path = Path(result["dagmcPath"])
    assert h5m_path.exists()
    return h5m_path


def _plasma_source_point() -> tuple[float, float, float]:
    """Return a point inside the plasma chamber, in scaled (cm) units."""
    doc = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    result = feature_builder.build_document_shape(doc)
    selector_map = result["selectorMap"]
    plasma_idx = selector_map["plasma"][0]
    plasma = result["shape"].solids()[plasma_idx - 1]
    bbox = plasma.bounding_box()
    # Pick the centroid of the bbox, shifted slightly off the symmetry plane (y=0)
    # so the source is unambiguously inside the half-model plasma volume.
    cx = (bbox.min.X + bbox.max.X) / 2.0
    cy = (bbox.min.Y + bbox.max.Y) / 2.0
    cz = (bbox.min.Z + bbox.max.Z) / 2.0
    return (cx * _LENGTH_SCALE, cy * _LENGTH_SCALE * 0.5, cz * _LENGTH_SCALE)


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


def test_dagmc_tokamak_export_groups(tmp_path: Path) -> None:
    """The imprinting export names material groups from the region manifest."""
    h5m_path = _build_tokamak_h5m(tmp_path)

    groups = _h5m_group_names(h5m_path)
    for entry in _REGIONS["volumes"]:
        assert f"mat:{entry['name']}" in groups, groups
    assert "mat:graveyard" in groups, groups


def _material_for_name(name: str) -> openmc.Material:
    """Create a material whose OpenMC name matches the DAGMC volume group name.

    DAGMC binds materials by name: ``mat:<volume_name>`` in the h5m must match
    a Material.name in the model. Composition is representative/non-fissile.
    """
    mat = openmc.Material(name=name)
    if name in {"tf_coils", "pf_coil_1", "pf_coil_2", "pf_coil_3", "pf_coil_4"}:
        mat.set_density("g/cm3", 8.96)
        mat.add_element("Cu", 1.0)
    elif name == "divertor":
        mat.set_density("g/cm3", 19.3)
        mat.add_element("W", 1.0)
    elif name in {"inboard_blanket", "outboard_blanket"}:
        mat.set_density("g/cm3", 9.5)
        mat.add_element("Pb", 1.0)
        mat.add_element("Li", 0.1)
    elif name == "plasma":
        mat.set_density("g/cm3", 1e-6)
        mat.add_nuclide("H2", 0.5)
        mat.add_nuclide("H3", 0.5)
    else:
        mat.set_density("g/cm3", 7.8)
        mat.add_element("Fe", 1.0)
    return mat


def test_dagmc_tokamak_openmc_run(tmp_path: Path) -> None:
    """The exported tokamak h5m runs a real OpenMC fixed-source calculation.

    This test is gated on ``OPENMC_CROSS_SECTIONS`` and is expected to exercise
    the full transport stack. The tokamak fixture is an overlapping CAD assembly
    (the reference STEP also produces lost particles when converted to DAGMC),
    so the assertion here is that the run completes and produces a statepoint,
    not that zero particles are lost.
    """
    xs = os.environ.get("OPENMC_CROSS_SECTIONS")
    if not xs:
        pytest.skip(
            "OPENMC_CROSS_SECTIONS not set — point it at a cross_sections.xml "
            "(see openmc.org data libraries)"
        )
    if not os.path.exists(xs):
        pytest.skip(f"OPENMC_CROSS_SECTIONS points at a missing file: {xs}")

    h5m_path = _build_tokamak_h5m(tmp_path)

    # One material per DAGMC volume group; names must match the manifest volume
    # names exactly so OpenMC can bind ``mat:<name>`` to ``Material(name=name)``.
    materials = openmc.Materials(
        [_material_for_name(entry["name"]) for entry in _REGIONS["volumes"]]
    )
    geometry = openmc.Geometry(openmc.DAGMCUniverse(str(h5m_path)))

    settings = openmc.Settings()
    # No fissile material is present in the tokamak, so a fixed-source neutron
    # run is used to exercise the transport stack.
    settings.run_mode = "fixed source"
    settings.particles = 500
    settings.batches = 10
    # DT fusion neutron source inside the plasma chamber, away from the symmetry plane.
    sx, sy, sz = _plasma_source_point()
    settings.source = openmc.IndependentSource(
        particle="neutron",
        space=openmc.stats.Point((sx, sy, sz)),
        energy=openmc.stats.Discrete([14.0e6], [1.0]),
    )
    # The overlapping schematic geometry generates some lost particles; allow a
    # modest number so the run can reach a statepoint rather than aborting on
    # the first one.
    settings.max_lost_particles = 1000

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    model.export_to_xml(str(run_dir))

    openmc_exe = Path(os.environ.get("NUKE_TEST_PYTHON", sys.executable)).parent / "openmc"
    assert openmc_exe.exists(), f"openmc executable not found at {openmc_exe}"
    import subprocess

    proc = subprocess.run(
        [str(openmc_exe)],
        cwd=str(run_dir),
        capture_output=True,
        text=True,
        timeout=1800,
    )
    assert proc.returncode == 0, (
        f"openmc exited with {proc.returncode}\n"
        f"stdout tail:\n{proc.stdout[-2000:]}\nstderr tail:\n{proc.stderr[-2000:]}"
    )

    statepoints = sorted(run_dir.glob("statepoint.*.h5"))
    assert statepoints, "no statepoint produced"
