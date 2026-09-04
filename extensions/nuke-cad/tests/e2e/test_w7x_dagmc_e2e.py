"""End-to-end: W7X stellarator coil document -> DAGMC h5m -> OpenMC -> drift check.

A single W7X modular coil — a 0.37 m square section swept along the committed
``w7x_coil_centerline.json`` (a 256-point closed centerline traced from one of
the fifty reference 4-face coil solids) — is circular-patterned around z and
pushed through the full simulation pipeline: ``geometry_service.build_document``
exports an imprinted DAGMC h5m with named material groups, the h5m runs a real
OpenMC fixed-source calculation, and the built solids are drift-checked
per-solid against the reference W7X STEP (fifty 4-face coil solids).

Unlike the overlapping tokamak assembly, the patterned coil set has no
intentional overlaps (adjacent-coil pitch at the coil-set radius is ~1.8 m
against the 0.37 m section) and ``add_graveyard=True`` seals the void, so the
OpenMC run asserts ZERO lost particles.

Environment gates (all skip cleanly):

* ``NUKE_TEST_PYTHON`` — full-dependency env (module-level, tokamak pattern).
* ``NUKE_CAD_W7X_GATE=1`` — opt-in double gate. The x50 circular pattern is a
  sequential boolean fuse (``feature_builder._apply_pattern_or_mirror`` fuses
  each patterned copy with ``result = result + instance``), measured at 2711 s
  for the full x50 document in the large-model profile, so the full gate costs
  roughly an hour end to end. It never runs in CI or a default full-profile
  pass.
* ``NUKE_CAD_W7X_GATE_COUNT`` (default 50) — pattern-count override so a
  count=3 smoke run finishes in minutes. Count-dependent assertions derive the
  count from this variable.
* ``NUKE_E2E_W7X_STEP`` — path to the reference STEP (developer-local; never
  committed). Required by the drift test only.
* ``OPENMC_CROSS_SECTIONS`` — cross-section library (required by the OpenMC
  run test only).

Units: the centerline is in meters, so the DAGMC/OpenMC export uses
``length_scale=100.0`` to bring the model into centimeters (the pipeline's
expected unit). The document (and the scaled reference STEP it was traced
from) sits at R ~ 14.6 m, so the graveyard bbox of the produced h5m spans
several thousand centimeters across; the export test asserts that empirical
span to catch a missing length_scale (which would shrink it 100x).

Reference coil shapes: the reference W7-X STEP holds fifty 4-face coil
solids — 10 distinct coil shapes, each appearing as 5 congruent module copies.
The document patterns ONE traced coil, so the drift test matches our coil's
shape by nearest reference volume and compares per-solid against those 5
same-shape references.
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
# LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
# ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
# THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

if not os.environ.get("NUKE_TEST_PYTHON"):
    pytest.skip(
        "NUKE_TEST_PYTHON not set — e2e requires the full-dependency Python environment",
        allow_module_level=True,
    )

if os.environ.get("NUKE_CAD_W7X_GATE") != "1":
    pytest.skip(
        "NUKE_CAD_W7X_GATE not set — the x50 W7X gate is opt-in (the sequential "
        "boolean fuse of the circular pattern is measured at ~45 min); set "
        "NUKE_CAD_W7X_GATE=1 (and optionally NUKE_CAD_W7X_GATE_COUNT for a partial count)",
        allow_module_level=True,
    )

openmc = pytest.importorskip("openmc", reason="e2e requires the full OpenMC profile")
pytest.importorskip("build123d", reason="e2e requires build123d")
pytest.importorskip("gmsh", reason="e2e requires gmsh")
pytest.importorskip("pymoab", reason="e2e requires pymoab")

import build123d as bd  # noqa: E402
import curve_builder  # noqa: E402
import feature_builder  # noqa: E402
import geometry_service  # noqa: E402

_FIXTURE = Path(__file__).parent / "assets" / "w7x_coil_centerline.json"
_COUNT = int(os.environ.get("NUKE_CAD_W7X_GATE_COUNT", "50"))

# The document is authored in meters (the centerline asset is in meters). The
# DAGMC/OpenMC pipeline expects centimetres, so the export scales by 100.
_LENGTH_SCALE = 100.0

_REGIONS = {
    "version": 1,
    "volumes": [{"selector": "coil", "name": "w7x_coils", "material": "copper"}],
}

# Volume drift tolerance vs the reference STEP, fixed from measured drift:
# measured max per-solid volume drift of the swept coil against the five
# same-shape reference 4-face coils is ~0.03 % (the reference set spans 10
# distinct shapes; the comparison is shape-matched, see the drift test).
# Tolerance is max(2x measured, 1 %) = 1 %.
_VOLUME_DRIFT_TOLERANCE = 0.01

# Bbox-dims drift tolerance vs the reference STEP, fixed from measured drift.
# The swept coil matches the reference on volume (~0.03 %), centerline length
# (~0.4 %) and centroid radius (~0.2 %), but the reference tube's cross-section
# is wound with a different twist convention than the Frenet frame, so the
# transverse envelope of the (strongly non-planar) coil drifts by ~10 %
# between the two. Measured max aligned-bbox dim drift is ~10 %; tolerance is
# max(2x measured, 2 %) = 20 %. Volume, length and radius are the
# drift-sensitive metrics here.
_DIMS_DRIFT_TOLERANCE = 0.20


def _w7x_document(count: int) -> dict:
    """One coil section swept along the committed centerline, circular x count."""
    samples = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    half = 0.37 / 2.0
    rectangle = {
        "id": "section",
        "name": "coil section",
        "datumId": "datum-xy",
        "primitives": [
            {"id": "p1", "type": "point", "x": -half, "y": -half},
            {"id": "p2", "type": "point", "x": half, "y": -half},
            {"id": "p3", "type": "point", "x": half, "y": half},
            {"id": "p4", "type": "point", "x": -half, "y": half},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    return {
        "version": 3,
        "name": "w7x-scale",
        "parameters": {},
        "bodies": [{"id": "coil-body", "label": "coil", "name": "coil"}],
        "datums": [{"id": "datum-xy", "kind": "XY", "offset": 0.0}],
        "sketches": [rectangle],
        "curves": [
            {
                "id": "w7x",
                "name": "coil centerline",
                "source": {"kind": "points"},
                "samples": [list(p) for p in samples],
            }
        ],
        "features": [
            {
                "id": "coil-sweep",
                "name": "coil sweep",
                "type": "sweep",
                "body": "coil-body",
                "sketchId": "section",
                "params": {"pathCurveId": "w7x", "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "coil-pattern",
                "name": f"circular pattern x{count}",
                "type": "circularPattern",
                "body": "coil-body",
                "params": {"source": "coil-sweep", "count": count, "angle": 360.0, "axis": "z"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    }


def _build_w7x_h5m(work: Path) -> Path:
    """Build the W7X document -> STEP -> h5m; return the h5m path."""
    doc = work / "w7x_gate.nuke-cad"
    doc.write_text(json.dumps(_w7x_document(_COUNT)), encoding="utf-8")
    manifest = work / "w7x_gate.regions.json"
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
    assert len(selector_map["coil"]) == _COUNT, selector_map

    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")
    h5m_path = Path(result["dagmcPath"])
    assert h5m_path.exists()
    return h5m_path


@pytest.fixture(scope="module")
def w7x_h5m(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The imprinted DAGMC h5m for the patterned W7X document (built once)."""
    return _build_w7x_h5m(Path(tmp_path_factory.mktemp("w7x_dagmc")))


# Built lazily (not as a fixture) so a test that will skip on its env gates
# never pays the pattern-fuse build: fixtures run before the test body's skip.
_SHAPE_RESULT: dict | None = None


def _w7x_shape() -> dict:
    """The built document shape, shared by the drift and OpenMC tests."""
    global _SHAPE_RESULT
    if _SHAPE_RESULT is None:
        doc = _w7x_document(_COUNT)
        curve_results = curve_builder.build_curves(doc)
        result = feature_builder.build_document_shape(doc, curve_results=curve_results)
        assert result["shape"] is not None, result.get("featureResults")
        assert len(result["shape"].solids()) == _COUNT
        _SHAPE_RESULT = result
    return _SHAPE_RESULT


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


def _h5m_group_span(h5m_path: Path, group_name: str) -> float:
    """Return the largest bbox axis span (in h5m units) of a material group."""
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
    target = None
    for gset in groups:
        if mb.tag_get_data(gdim_tag, gset)[0][0] != 4:
            continue
        raw = mb.tag_get_data(name_tag, gset)[0][0]
        name = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        if name == group_name:
            target = gset
            break
    assert target is not None, f"group {group_name} not found in {h5m_path}"

    # The h5m is a surface mesh and a DAGMC group reaches its triangles only
    # through contained entity sets (volume sets holding surface sets), which
    # get_entities_by_dimension recursion does not traverse — walk the
    # containment graph (member sets plus parent/child links) and gather each
    # visited set's own surface elements.
    work = [target]
    visited = set()
    tris = []
    while work:
        current = work.pop()
        if current in visited:
            continue
        visited.add(current)
        tris.extend(mb.get_entities_by_dimension(current, 2, False))
        work.extend(mb.get_entities_by_type(current, moab_types.MBENTITYSET))
        work.extend(mb.get_child_meshsets(current))
    assert len(tris) > 0, f"group {group_name} has no surface elements"
    verts = mb.get_connectivity(tris)
    coords = mb.get_coords(verts).reshape(-1, 3)
    spans = coords.max(axis=0) - coords.min(axis=0)
    return float(spans.max())


def test_w7x_dagmc_export_groups(w7x_h5m: Path) -> None:
    """The imprinting export names material groups and seals a cm-scale graveyard."""
    groups = _h5m_group_names(w7x_h5m)
    assert "mat:w7x_coils" in groups, groups
    assert "mat:graveyard" in groups, groups

    # length_scale=100 must turn the ~35 m scaled machine into a several-thousand-cm
    # span (measured 3613 cm for the x50 gate). A forgotten scale shows up here
    # as a ~36-unit span (100x too small).
    span = _h5m_group_span(w7x_h5m, "mat:graveyard")
    assert 2700.0 < span < 4520.0, f"graveyard span {span:.1f} cm is not machine-scale"


_LOST_PARTICLE_PATTERNS = (
    "Could not find the cell containing particle",
    "could not be located in any cell and it did not leak",
    "Lost particle after reflection",
    "Lost a ray",
)


def _count_lost_particles(stderr: str) -> int:
    """Count lost-particle warnings in OpenMC stderr output."""
    count = 0
    for pattern in _LOST_PARTICLE_PATTERNS:
        count += len(re.findall(re.escape(pattern), stderr))
    return count


def test_w7x_openmc_run_zero_lost(w7x_h5m: Path) -> None:
    """The exported W7X h5m runs a real OpenMC fixed-source calculation with zero lost.

    The patterned coil set has no intentional overlaps and the graveyard seals
    the void, so — unlike the overlapping tokamak assembly — the settled bound
    is zero lost particles. ``max_lost_particles`` is left at its default so the
    run aborts fast if the geometry is broken.
    """
    xs = os.environ.get("OPENMC_CROSS_SECTIONS")
    if not xs:
        pytest.skip(
            "OPENMC_CROSS_SECTIONS not set — point it at a cross_sections.xml "
            "(see openmc.org data libraries)"
        )
    if not os.path.exists(xs):
        pytest.skip(f"OPENMC_CROSS_SECTIONS points at a missing file: {xs}")

    # One copper material; its name must match the DAGMC volume group name so
    # OpenMC can bind ``mat:w7x_coils`` to ``Material(name="w7x_coils")``.
    material = openmc.Material(name="w7x_coils")
    material.set_density("g/cm3", 8.96)
    material.add_element("Cu", 1.0)
    materials = openmc.Materials([material])
    geometry = openmc.Geometry(openmc.DAGMCUniverse(str(w7x_h5m)))

    settings = openmc.Settings()
    settings.run_mode = "fixed source"
    settings.particles = 500
    settings.batches = 10
    # 14 MeV point source inside coil solid 0, placed at its bbox center.
    shape = _w7x_shape()
    selector_map = shape["selectorMap"]
    coil_idx = selector_map["coil"][0]
    coil = shape["shape"].solids()[coil_idx - 1]
    bbox = coil.bounding_box()
    sx = (bbox.min.X + bbox.max.X) / 2.0 * _LENGTH_SCALE
    sy = (bbox.min.Y + bbox.max.Y) / 2.0 * _LENGTH_SCALE
    sz = (bbox.min.Z + bbox.max.Z) / 2.0 * _LENGTH_SCALE
    settings.source = openmc.IndependentSource(
        particle="neutron",
        space=openmc.stats.Point((sx, sy, sz)),
        energy=openmc.stats.Discrete([14.0e6], [1.0]),
    )

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)
    run_dir = Path(w7x_h5m).parent / "run"
    run_dir.mkdir(exist_ok=True)
    model.export_to_xml(str(run_dir))

    openmc_exe = Path(os.environ.get("NUKE_TEST_PYTHON", sys.executable)).parent / "openmc"
    assert openmc_exe.exists(), f"openmc executable not found at {openmc_exe}"

    proc = subprocess.run(
        [str(openmc_exe)],
        cwd=str(run_dir),
        capture_output=True,
        text=True,
        timeout=1800,
    )
    lost = _count_lost_particles(proc.stderr)
    assert proc.returncode == 0, (
        f"openmc exited with {proc.returncode} ({lost} lost particles)\n"
        f"stdout tail:\n{proc.stdout[-2000:]}\nstderr tail:\n{proc.stderr[-2000:]}"
    )
    assert lost == 0, f"{lost} lost particles detected in openmc stderr:\n{proc.stderr[-2000:]}"

    statepoints = sorted(run_dir.glob("statepoint.*.h5"))
    assert statepoints, "no statepoint produced"


def _solid_stats(solid) -> tuple[float, tuple[float, float, float], float, float]:
    """Return (centroid radius, sorted bbox dims, volume, azimuth) for a solid."""
    bb = solid.bounding_box()
    dims = tuple(sorted((bb.max.X - bb.min.X, bb.max.Y - bb.min.Y, bb.max.Z - bb.min.Z)))
    center = solid.center()
    radius = math.hypot(center.X, center.Y)
    azimuth = math.atan2(center.Y, center.X)
    return radius, dims, solid.volume, azimuth


def test_w7x_drift_vs_reference_step() -> None:
    """Our patterned coil solids match the reference STEP's 4-face coils.

    The reference file holds 55 solids; the coil set is exactly the fifty
    4-face ones (selected by face count, not index). The fifty coils are 10
    distinct shapes with 5 congruent module copies each, while the document
    patterns ONE traced coil, so per-solid metrics are compared against the
    same-shape references: our coil's shape is matched by nearest reference
    volume, and every one of our solids is checked against every same-shape
    reference solid — centroid radius within 1 %, bbox dimensions within
    ``_DIMS_DRIFT_TOLERANCE`` (compared after rotating the reference into our
    azimuth: the wavy coils are far from z-axisymmetric, so axis-aligned bbox
    dims are only comparable in the same orientation), volume within
    ``_VOLUME_DRIFT_TOLERANCE``. The full sets must each be strictly ordered
    by centroid azimuth.
    """
    step_path = os.environ.get("NUKE_E2E_W7X_STEP")
    if not step_path:
        pytest.skip(
            "NUKE_E2E_W7X_STEP not set — point it at the reference W7X STEP "
            "(developer-local; never committed)"
        )
    if not os.path.exists(step_path):
        pytest.skip(f"NUKE_E2E_W7X_STEP points at a missing file: {step_path}")

    from build123d import import_step

    ours = _w7x_shape()["shape"].solids()
    assert len(ours) == _COUNT

    reference = import_step(step_path)
    ref_coils = [s for s in reference.solids() if len(s.faces()) == 4]
    assert len(ref_coils) == 50, f"expected 50 4-face coil solids, got {len(ref_coils)}"

    ours_sorted = sorted((_solid_stats(s) for s in ours), key=lambda t: t[3])
    ref_entries = sorted(((_solid_stats(s), s) for s in ref_coils), key=lambda entry: entry[0][3])
    azimuths_ours = [t[3] for t in ours_sorted]
    azimuths_ref = [entry[0][3] for entry in ref_entries]
    assert all(b > a for a, b in zip(azimuths_ours, azimuths_ours[1:], strict=False))
    assert all(b > a for a, b in zip(azimuths_ref, azimuths_ref[1:], strict=False))

    # Unit scale: the STEP importer's unit handling has varied across OCCT
    # builds. Find the power-of-ten scale (ref units per document unit) that
    # best aligns our coil volume with a reference volume — the true scale
    # matches a same-shape reference to ~0.03 %, while any other power-of-ten
    # candidate is orders of magnitude off — and require that sanity bound so
    # a genuinely mismatched unit is caught rather than silently absorbed.
    our_volume = ours_sorted[0][2]
    ref_volumes = [entry[0][2] for entry in ref_entries]

    def _unit_drift(unit: float) -> float:
        our_volume_in_ref_units = our_volume * unit**3
        return min(abs(our_volume_in_ref_units - rv) / rv for rv in ref_volumes)

    unit = min((1e-3, 1.0, 1e3), key=_unit_drift)
    assert _unit_drift(unit) < 0.05, (
        f"best unit scale {unit:g} leaves {_unit_drift(unit):.2%} volume mismatch — units changed?"
    )
    inv_unit = 1.0 / unit

    # Shape match: our coil was traced from one reference coil, so its nearest
    # reference volume identifies its shape; the machine has 5 modules, so each
    # of the 10 distinct coil shapes appears as 5 congruent copies (copies
    # agree on volume to ~1e-6; the closest distinct shapes sit ~2.8e-4 apart).
    nearest_ref = min(ref_entries, key=lambda entry: abs(entry[0][2] - our_volume * unit**3))
    same_shape = [
        entry
        for entry in ref_entries
        if abs(entry[0][2] - nearest_ref[0][2]) / nearest_ref[0][2] < 1e-4
    ]
    assert len(same_shape) == 5, f"expected 5 same-shape coils, got {len(same_shape)}"

    # Same-shape reference copies sit at different azimuths, and the coils are
    # far from z-axisymmetric, so an axis-aligned bbox is only meaningful when
    # both solids are compared in the SAME azimuthal orientation: rotate each
    # reference solid into our solid's azimuth before comparing bbox dims
    # (radius/volume are rotation-invariant and compared directly).
    def _aligned_dims(solid, angle: float) -> tuple[float, float, float]:
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
        from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf

        trsf = gp_Trsf()
        trsf.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(0.0, 0.0, 1.0)), angle)
        rotated = BRepBuilderAPI_Transform(solid.wrapped, trsf, True).Shape()
        bb = bd.Solid(rotated).bounding_box()
        return tuple(sorted((bb.max.X - bb.min.X, bb.max.Y - bb.min.Y, bb.max.Z - bb.min.Z)))

    max_radius_drift = max_dim_drift = max_volume_drift = 0.0
    for our_radius, our_dims, our_volume, our_azimuth in ours_sorted:
        for (ref_radius, _, ref_volume, ref_azimuth), ref_solid in same_shape:
            ref_radius *= inv_unit
            ref_volume *= inv_unit**3
            ref_dims = tuple(
                d * inv_unit for d in _aligned_dims(ref_solid, our_azimuth - ref_azimuth)
            )
            max_radius_drift = max(max_radius_drift, abs(our_radius - ref_radius) / ref_radius)
            max_dim_drift = max(
                max_dim_drift,
                max(abs(a - b) / b for a, b in zip(our_dims, ref_dims, strict=True)),
            )
            max_volume_drift = max(max_volume_drift, abs(our_volume - ref_volume) / ref_volume)

    assert max_radius_drift < 0.01, f"centroid radius drift {max_radius_drift:.4%}"
    assert max_dim_drift < _DIMS_DRIFT_TOLERANCE, (
        f"bbox dimension drift {max_dim_drift:.4%} exceeds {_DIMS_DRIFT_TOLERANCE:.4%}"
    )
    assert max_volume_drift < _VOLUME_DRIFT_TOLERANCE, (
        f"volume drift {max_volume_drift:.4%} exceeds {_VOLUME_DRIFT_TOLERANCE:.4%}"
    )
