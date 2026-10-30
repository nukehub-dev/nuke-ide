"""DAGMC export with imprint/merge and named material groups.

Pipeline
--------
1. Load the canonical STEP file into an OCP shape for overlap checks and
   existing-graveyard detection.
2. Sampling-based overlap check between volumes (BRepClass3d classification).
3. Load the STEP in gmsh's OpenCASCADE kernel, fragment the model volumes with
   each other so touching solids receive exact shared coincident faces, then
   optionally create and fragment a mat:graveyard bounding box in gmsh (the
   OCP boolean graveyard cut is no longer used because it re-duplicates
   coincident model-model faces). ``removeAllDuplicates`` merges duplicate
   entities.
4. Generate a 2D surface mesh in gmsh.
5. Verify every surface borders exactly 1 or 2 volumes (hard error otherwise).
6. Extract triangles, surface-to-volume adjacencies, and build a tagged
   DAGMC H5M file via pymoab.
7. Report watertightness diagnostics (edge incidence: non-manifold >2,
   hole edges == 1).

The module stays importable in the minimal pytest profile (``pytest`` +
``numpy`` only). All heavy imports are guarded with module-level flags and
function-local imports.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from ocp_compat import (  # noqa: E402
    brep_bnd_lib_add,
    interface_static_set_cval,
    topods_solid,
)

# Optional heavy dependencies. The module must remain importable without them.
try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore
    HAS_NUMPY = False

try:
    import gmsh

    HAS_GMSH = True
except ImportError:
    gmsh = None  # type: ignore
    HAS_GMSH = False

try:
    import pymoab
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    HAS_PYMOLAB = True
except ImportError:
    pymoab = None  # type: ignore
    moab_core = None  # type: ignore
    moab_types = None  # type: ignore
    HAS_PYMOLAB = False

# Pre-export validation gates are warnings-only; the export never fails
# because a gate tripped. The module stays importable without them.
try:
    import inspection_gates

    HAS_INSPECTION_GATES = True
except Exception:
    inspection_gates = None  # type: ignore
    HAS_INSPECTION_GATES = False


def _require_deps() -> None:
    """Raise a clear error if any required heavy dependency is missing."""
    missing: list[str] = []
    if not HAS_NUMPY:
        missing.append("numpy")
    if not HAS_GMSH:
        missing.append("gmsh")
    if not HAS_PYMOLAB:
        missing.append("pymoab")
    if missing:
        raise RuntimeError(f"DAGMC export requires: {', '.join(missing)}")


def _solids_from_shape(shape: Any) -> list[Any]:
    """Return all TopoDS_Solid instances nested in ``shape``."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[Any] = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids.append(topods_solid(TopoDS, exp.Current()))
        exp.Next()
    return solids


def _solid_bounding_box(solid: Any) -> tuple[float, float, float, float, float, float]:
    """Return the axis-aligned bounding box of a single solid."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    brep_bnd_lib_add(BRepBndLib, solid, bbox)
    return bbox.Get()


def _bbox_overlaps(
    a: tuple[float, float, float, float, float, float],
    b: tuple[float, float, float, float, float, float],
    padding: float = 1e-6,
) -> bool:
    """Check whether two axis-aligned bounding boxes overlap (with padding)."""
    return all(a[i] <= b[i + 3] + padding and a[i + 3] >= b[i] - padding for i in range(3))


def _check_volume_overlaps(
    shape: Any,
    skip_vol_ids: set[int] | None = None,
    samples_per_volume: int = 8,
    grid_divisions: int = 4,
) -> dict[str, Any]:
    """Sampling-based overlap check between volumes (BRepClass3d classification).

    For each volume, up to ``samples_per_volume`` interior points are found by
    classifying a uniform bbox grid against the volume itself; each candidate
    pair (overlapping bboxes) is then checked by classifying one volume's
    interior samples against the other. Volumes in ``skip_vol_ids`` (1-based,
    e.g. a graveyard built by boolean cut) are excluded.

    Returns ``{"checkedVolumes", "overlappingPairs", "samplesPerVolume"}``.
    Limitation: volumes whose interior grid samples cannot be found (extremely
    thin or pathological shapes) are effectively skipped for that pair.
    """
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    solids = _solids_from_shape(shape)
    n = len(solids)
    report: dict[str, Any] = {
        "checkedVolumes": n,
        "overlappingPairs": [],
        "samplesPerVolume": samples_per_volume,
    }
    if n < 2:
        return report
    skip = skip_vol_ids or set()

    def _inside(solid: Any, x: float, y: float, z: float) -> bool:
        classifier = BRepClass3d_SolidClassifier(solid, gp_Pnt(x, y, z), 1e-6)
        return bool(classifier.State() == TopAbs_IN)

    bboxes = [_solid_bounding_box(s) for s in solids]

    interior: list[list[tuple[float, float, float]]] = []
    for solid, (xmin, ymin, zmin, xmax, ymax, zmax) in zip(solids, bboxes, strict=True):
        points: list[tuple[float, float, float]] = []
        done = False
        for i in range(grid_divisions):
            for j in range(grid_divisions):
                for k in range(grid_divisions):
                    x = xmin + (i + 0.5) / grid_divisions * (xmax - xmin)
                    y = ymin + (j + 0.5) / grid_divisions * (ymax - ymin)
                    z = zmin + (k + 0.5) / grid_divisions * (zmax - zmin)
                    if _inside(solid, x, y, z):
                        points.append((x, y, z))
                        if len(points) >= samples_per_volume:
                            done = True
                            break
                if done:
                    break
            if done:
                break
        interior.append(points)

    pairs: list[list[int]] = []
    for i in range(n):
        if (i + 1) in skip:
            continue
        for j in range(i + 1, n):
            if (j + 1) in skip:
                continue
            if not _bbox_overlaps(bboxes[i], bboxes[j]):
                continue
            if any(_inside(solids[j], *p) for p in interior[i]) or any(
                _inside(solids[i], *p) for p in interior[j]
            ):
                pairs.append([i + 1, j + 1])
    report["overlappingPairs"] = pairs
    return report


def _collect_step_names(file_path: str) -> set[str]:
    """Best-effort collection of product/assembly names from a STEP file via CAF."""
    names: set[str] = set()
    try:
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_LabelSequence
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_DocumentTool

        doc = TDocStd_Document("doc")
        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        if reader.ReadFile(file_path) != 1:
            return names
        reader.Transfer(doc)

        shape_tool = XCAFDoc_DocumentTool.ShapeTool(doc.Main())
        free_shapes = TDF_LabelSequence()
        shape_tool.GetFreeShapes(free_shapes)

        def _collect(label: Any) -> None:
            name_attr = TDataStd_Name()
            if label.FindAttribute(TDataStd_Name.GetID(), name_attr):
                try:
                    name = name_attr.Get().PrintToString()
                    if name:
                        names.add(name)
                except Exception:
                    pass
            children = TDF_LabelSequence()
            shape_tool.GetComponents(label, children)
            for i in range(1, children.Length() + 1):
                _collect(children.Value(i))
            subshapes = TDF_LabelSequence()
            shape_tool.GetSubShapes(label, subshapes)
            for i in range(1, subshapes.Length() + 1):
                _collect(subshapes.Value(i))

        for i in range(1, free_shapes.Length() + 1):
            _collect(free_shapes.Value(i))
    except Exception:
        pass
    return names


def _detect_existing_graveyard(shape: Any, file_path: str) -> tuple[bool, int | None]:
    """Detect whether ``shape`` already contains an explicitly named graveyard.

    Detection is **opt-in only**: a STEP product/assembly name must contain the
    word "graveyard". The previous volume-ratio + containment heuristic has been
    removed because it misidentified large model envelopes as graveyards.

    Returns ``(detected, graveyard_index)``. ``graveyard_index`` is the 0-based
    index of the existing graveyard solid in the original solid list, or
    ``None`` if a name was found but the solid could not be matched.
    """
    solids = _solids_from_shape(shape)

    try:
        names = _collect_step_names(file_path)
        if not any("graveyard" in n.lower() for n in names):
            return False, None
    except Exception:
        return False, None

    # Try to match the named graveyard to the largest solid. This is only a
    # convenience for assigning the mat:graveyard tag; it is not a heuristic.
    if len(solids) == 0:
        return True, None
    if len(solids) == 1:
        return True, 0

    try:

        def _box_volume(bbox: tuple[float, ...]) -> float:
            return (
                max(0.0, bbox[3] - bbox[0])
                * max(0.0, bbox[4] - bbox[1])
                * max(0.0, bbox[5] - bbox[2])
            )

        bboxes = [_solid_bounding_box(s) for s in solids]
        largest = max(range(len(solids)), key=lambda i: _box_volume(bboxes[i]))
        return True, largest
    except Exception:
        return True, None


def _write_step(shape: Any, step_path: Path) -> None:
    """Write ``shape`` to a STEP file using OCP."""
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    writer = STEPControl_Writer()
    interface_static_set_cval(Interface_Static, "write.step.schema", "AP214IS")
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != 1:
        raise RuntimeError(f"STEP writer returned status {status}")


def _load_shape(step_path: str) -> Any:
    """Load a STEP file into a TopoDS_Shape."""
    from OCP.STEPControl import STEPControl_Reader

    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != 1:
        raise RuntimeError(f"Failed to read STEP file, status={status}")
    reader.TransferRoot()
    return reader.OneShape()


def _fallback_material_name(vol_id: int) -> str:
    """Positional fallback group name (openmc-studio convention: mat:mat_<id-1>)."""
    return f"mat:mat_{vol_id - 1}"


def _most_specific_selector(
    vol_id: int,
    selector_map: dict[str, list[int]] | None,
) -> str | None:
    """Return the most specific selector covering a 1-based volume ID.

    Specificity is the index-list length: a per-cell entry (one solid, e.g. a
    lattice ``<prefix>_r<row>c<col>`` cell) beats the body-level entry (all
    body solids) covering the same volume. Ties keep dict order (first wins),
    so documents with disjoint selectors resolve exactly as before.
    """
    if not selector_map:
        return None
    best: str | None = None
    best_size: int | None = None
    for selector, indices in selector_map.items():
        if vol_id in indices:
            size = len(indices)
            if best is None or (best_size is not None and size < best_size):
                best = selector
                best_size = size
    return best


def _volume_name_from_manifest(
    vol_id: int,
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    graveyard_vol_ids: set[int],
) -> str:
    """Return the DAGMC material name for a 1-based volume ID."""
    if vol_id in graveyard_vol_ids:
        return "mat:graveyard"

    selector: str | None = None
    if manifest is not None and selector_map:
        selector = _most_specific_selector(vol_id, selector_map)

    if selector is not None and manifest is not None:
        for entry in manifest.volumes:
            if entry.get("selector") == selector:
                name = entry.get("name") or selector
                return f"mat:{name}"

    return _fallback_material_name(vol_id)


def _gmsh_volume_signature(
    tag: int,
) -> tuple[
    float, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]
]:
    """Return a geometric signature for a gmsh volume.

    The signature combines the OCC mass (volume) and the bounding-box center,
    min corner, and max corner. This is stable across gmsh tag renumbering
    after ``removeAllDuplicates``.
    """
    mass = float(gmsh.model.occ.getMass(3, tag))
    bbox = gmsh.model.getBoundingBox(3, tag)
    center = (
        (bbox[0] + bbox[3]) / 2.0,
        (bbox[1] + bbox[4]) / 2.0,
        (bbox[2] + bbox[5]) / 2.0,
    )
    return (mass, center, (bbox[0], bbox[1], bbox[2]), (bbox[3], bbox[4], bbox[5]))


def _signatures_match(
    a: tuple[
        float, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]
    ],
    b: tuple[
        float, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]
    ],
    diag: float,
) -> bool:
    """Return True if two gmsh volume signatures describe the same volume."""
    vol_tol = 1e-6 * max(abs(a[0]), abs(b[0]), 1.0)
    coord_tol = 1e-6 * max(diag, 1.0)
    if abs(a[0] - b[0]) > vol_tol:
        return False
    for i in range(3):
        if abs(a[1][i] - b[1][i]) > coord_tol:
            return False
        if abs(a[2][i] - b[2][i]) > coord_tol:
            return False
        if abs(a[3][i] - b[3][i]) > coord_tol:
            return False
    return True


# ---------------------------------------------------------------------------
# Pre-export diagnostics + staged imprint recovery.
#
# Message convention: '<WHAT> (<WHERE>): <EFFECT>. Fix: <ACTION>.'
# Every fallback is REPORTED (warning + ``imprintStages`` log); recovery never
# modifies the model — it only retries the gmsh imprint at a different
# tolerance or without the graveyard fragment.
# ---------------------------------------------------------------------------

#: Ordered imprint stages for the ``imprintStages`` result key.
IMPRINT_STAGE_ORDER = ("S0", "S1", "S2", "S3", "S4")

#: Upper bound (model units) for the S2 tolerance relaxation.
IMPRINT_RELAXED_TOLERANCE_CAP = 1e-4

#: Fallback model tolerance when gmsh reports none.
IMPRINT_BASE_TOLERANCE_FALLBACK = 1e-7


class _ImprintStageError(RuntimeError):
    """One imprint stage failed; the orchestrator may retry another stage."""


def make_diagnostic(
    code: str,
    severity: str,
    bodies: list[str] | None = None,
    surfaces: list[int] | None = None,
    detail: str = "",
    hint: str = "",
) -> dict[str, Any]:
    """Build one structured ``diagnostics`` entry (pure; no heavy deps)."""
    return {
        "code": code,
        "severity": severity,
        "bodies": list(bodies or []),
        "surfaces": list(surfaces or []),
        "detail": detail,
        "hint": hint,
    }


def _volume_label(
    vol_id: int,
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
) -> str:
    """Return a human-readable label for a 1-based pre-fragment volume ID."""
    if selector_map:
        selector = _most_specific_selector(vol_id, selector_map)
        if selector is not None:
            if manifest is not None:
                for entry in manifest.volumes:
                    if entry.get("selector") == selector:
                        return str(entry.get("name") or selector)
            return selector
    return f"volume {vol_id}"


def overlap_diagnostic(
    vol_a: int,
    vol_b: int,
    label_a: str | None = None,
    label_b: str | None = None,
) -> tuple[dict[str, Any], str]:
    """Build the overlap diagnostic entry + convention message (pure)."""
    name_a = label_a or f"volume {vol_a}"
    name_b = label_b or f"volume {vol_b}"
    detail = f"Overlap {name_a}/{name_b}: export would double-count volume."
    hint = "Fuse in Model Outline or separate bodies"
    entry = make_diagnostic("overlap", "warning", bodies=[name_a, name_b], detail=detail, hint=hint)
    return entry, f"{detail} Fix: {hint}."


def sense_error_message(surface_tag: int, volumes: list[int], stage: str) -> str:
    """Build the hard-error message for a surface with no valid sense (pure)."""
    vols = ", ".join(str(v) for v in volumes) if volumes else "none"
    return (
        f"Surface {surface_tag} has no valid sense (volumes [{vols}]): "
        f"imprint failed at {stage}. Not exported."
    )


def seal_error_message(open_edge_count: int, hint: str) -> str:
    """Build the fail-fast message for a leaking facet mesh (pure)."""
    return (
        f"Seal check failed ({open_edge_count} open edges): "
        f"the facet mesh has holes and would leak particles. Fix: {hint}."
    )


def imprint_relax_message(previous_tolerance: float, relaxed_tolerance: float) -> str:
    """Build the REPORTED S2 fallback message (pure)."""
    return (
        f"Imprint S2 tolerance relaxed {previous_tolerance:.0e} -> {relaxed_tolerance:.0e} "
        f"(reported): fragment recovered at relaxed tolerance. "
        f"Fix: accept warning or tighten CAD gaps."
    )


def graveyard_skipped_message() -> str:
    """Build the REPORTED S3 fallback message (pure)."""
    return (
        "Imprint S3 model-only fallback (reported, graveyardSkipped): "
        "exported without graveyard fragmentation. "
        "Fix: accept warning or repair the graveyard seam."
    )


def _stage_entry(
    stage: str,
    tolerance: float | None,
    volumes_in: int,
    volumes_out: int | None,
    status: str,
    note: str = "",
) -> dict[str, Any]:
    """Build one ``imprintStages`` entry (pure)."""
    entry: dict[str, Any] = {
        "stage": stage,
        "tolerance": tolerance,
        "volumesIn": volumes_in,
        "volumesOut": volumes_out,
        "status": status,
    }
    if note:
        entry["note"] = note
    return entry


def _read_imprint_tolerance() -> float:
    """Return the current gmsh model tolerance (fallback when gmsh is absent)."""
    try:
        if gmsh is not None:
            return float(gmsh.option.getNumber("Geometry.Tolerance"))
    except Exception:
        pass
    return IMPRINT_BASE_TOLERANCE_FALLBACK


def _apply_imprint_tolerance(value: float) -> None:
    """Set the gmsh model tolerance (no-op when gmsh is absent)."""
    if gmsh is None:
        return
    gmsh.option.setNumber("Geometry.Tolerance", float(value))


def _relaxed_imprint_tolerance(base_tolerance: float) -> float:
    """Return the capped 10x S2 retry tolerance (pure)."""
    try:
        relaxed = float(base_tolerance) * 10.0
    except (TypeError, ValueError):
        relaxed = IMPRINT_BASE_TOLERANCE_FALLBACK * 10.0
    return min(relaxed, IMPRINT_RELAXED_TOLERANCE_CAP)


def _safe_volume_count() -> int | None:
    """Return the current gmsh volume count, or None when unmeasurable."""
    try:
        if gmsh is None:
            return None
        return len(gmsh.model.getEntities(3))
    except Exception:
        return None


def _last_ok_imprint_stage(stage_log: list[dict[str, Any]]) -> str:
    """Return the most recent successful/recovered stage label (pure)."""
    for entry in reversed(stage_log):
        if entry.get("status") in ("ok", "recovered"):
            stage = str(entry.get("stage", "S1"))
            return stage if stage in IMPRINT_STAGE_ORDER else "S1"
    return "S1"


def _report_imprint_fallbacks(
    stage_log: list[dict[str, Any]],
    reported_upto: int,
    warnings: list[str],
    diagnostics: list[dict[str, Any]],
) -> int:
    """Append REPORTED warnings for S2/S3 fallbacks; return new count (pure scan).

    Every fallback is surfaced exactly once (tracked by ``reported_upto``);
    the model itself is never modified.
    """
    for entry in stage_log[reported_upto:]:
        stage = entry.get("stage")
        status = entry.get("status")
        if stage == "S2" and status == "ok":
            previous = entry.get("previousTolerance")
            current = entry.get("tolerance")
            try:
                message = imprint_relax_message(float(previous), float(current))
            except (TypeError, ValueError):
                message = (
                    "Imprint S2 tolerance relaxed (reported): fragment recovered "
                    "at relaxed tolerance. Fix: accept warning or tighten CAD gaps."
                )
            warnings.append(f"[DAGMC] {message}")
            diagnostics.append(
                make_diagnostic(
                    "imprint",
                    "warning",
                    detail=message,
                    hint="Accept warning or tighten CAD gaps.",
                )
            )
        elif stage == "S3" and status == "recovered":
            message = graveyard_skipped_message()
            warnings.append(f"[DAGMC] {message}")
            diagnostics.append(
                make_diagnostic(
                    "imprint",
                    "warning",
                    bodies=["mat:graveyard"],
                    detail=message,
                    hint="Accept warning or repair the graveyard seam.",
                )
            )
    return len(stage_log)


def _fragment_track_and_map(
    input_tags: list[tuple[int, int]],
    input_to_pre: dict[int, int],
    diag: float,
) -> dict[int, int]:
    """Run one fragment + removeAllDuplicates + signature-track pass.

    ``fragment`` splits volumes at intersections (e.g. overlapping boxes or
    model/graveyard boundaries). The returned ``fragment_map`` lists, for each
    input entity, the output entities it produced; because object and tool are
    the same list, an output piece may appear under several inputs. We first
    resolve each old output piece to a pre-fragment index by matching its
    geometric signature to the input signatures and fall back to the
    ``fragment_map`` candidates when the signature is ambiguous. Then
    ``removeAllDuplicates`` may renumber tags, so we match the surviving current
    tags to those old output pieces by signature.

    Raises on any binding failure; the staged orchestrator
    (:func:`_fragment_and_track`) decides whether to retry.
    """
    if not input_tags:
        return {}

    # Pre-fragment signatures for every input tag.
    input_signatures: dict[int, tuple] = {}
    for _dim, tag in input_tags:
        tag = int(tag)
        input_signatures[tag] = _gmsh_volume_signature(tag)

    # Map each pre-index back to the input tag(s) that carry it.
    pre_to_input_tags: dict[int, list[int]] = {}
    for tag, pre in input_to_pre.items():
        pre_to_input_tags.setdefault(pre, []).append(tag)

    _, fragment_map = gmsh.model.occ.fragment(input_tags, input_tags)
    gmsh.model.occ.synchronize()

    # Collect candidate pre-indices for every old output piece. A piece may be
    # listed under multiple inputs (e.g. the graveyard contains the model).
    candidates: dict[int, set[int]] = {}
    old_output_signatures: dict[int, tuple] = {}
    for input_index, outputs in enumerate(fragment_map):
        if input_index >= len(input_tags):
            continue
        input_tag = int(input_tags[input_index][1])
        pre_index = input_to_pre.get(input_tag)
        if pre_index is None:
            continue
        for dim, tag in outputs:
            if int(dim) != 3:
                continue
            tag = int(tag)
            candidates.setdefault(tag, set()).add(pre_index)
            old_output_signatures[tag] = _gmsh_volume_signature(tag)

    # If fragment produced no 3D outputs (e.g. single untouched volume), the
    # inputs themselves are the outputs.
    if not old_output_signatures:
        for _dim, tag in input_tags:
            tag = int(tag)
            old_output_signatures[tag] = _gmsh_volume_signature(tag)
            if tag in input_to_pre:
                candidates[tag] = {input_to_pre[tag]}

    gmsh.model.occ.removeAllDuplicates()
    gmsh.model.occ.synchronize()

    current_tags = gmsh.model.getEntities(3)
    if not current_tags:
        raise RuntimeError("No volumes remain after imprint/merge")

    # Resolve each old output piece to a single pre-index.
    old_output_to_pre: dict[int, int] = {}
    for old_tag, old_sig in old_output_signatures.items():
        cands = candidates.get(old_tag)
        if not cands:
            raise RuntimeError(
                f"Post-fragment volume {old_tag} has no candidate pre-fragment index; "
                "material/selector binding cannot be trusted."
            )

        matching_pres: list[int] = []
        for pre in cands:
            for itag in pre_to_input_tags.get(pre, []):
                if _signatures_match(old_sig, input_signatures[itag], diag):
                    matching_pres.append(pre)
                    break

        if len(matching_pres) == 1:
            chosen_pre = matching_pres[0]
        elif len(matching_pres) > 1:
            # Multiple inputs match geometrically; pick the smallest pre-index
            # for a deterministic tie-break.
            chosen_pre = min(matching_pres)
        else:
            # New piece (e.g. an overlap intersection): fall back to the
            # fragment_map candidate with the smallest pre-index.
            chosen_pre = min(cands)

        old_output_to_pre[old_tag] = chosen_pre

    # Match current tags to old output pieces by geometric signature.
    current_to_pre: dict[int, int] = {}
    used_old_tags: set[int] = set()
    for _dim, tag in current_tags:
        tag = int(tag)
        signature = _gmsh_volume_signature(tag)
        matches: list[int] = []
        for old_tag, old_sig in old_output_signatures.items():
            if _signatures_match(signature, old_sig, diag):
                matches.append(old_tag)

        if len(matches) == 1:
            old_tag = matches[0]
        elif len(matches) > 1:
            # Pick the old tag whose pre-index matches this current tag's own
            # pre-index hint, if any.
            fragment_hint = old_output_to_pre.get(tag)
            hinted = [m for m in matches if old_output_to_pre.get(m) == fragment_hint]
            if len(hinted) == 1:
                old_tag = hinted[0]
            else:
                raise RuntimeError(
                    f"Post-fragment volume {tag} is ambiguous: matches old output "
                    f"pieces {matches}; material/selector binding cannot be trusted."
                )
        else:
            raise RuntimeError(
                f"Post-fragment volume {tag} matches no old output piece; "
                "material/selector binding cannot be trusted."
            )

        if old_tag in used_old_tags:
            raise RuntimeError(
                f"Post-fragment volumes {tag} and another volume both match old "
                f"output piece {old_tag}; material/selector binding cannot be trusted."
            )
        used_old_tags.add(old_tag)

        pre_index = old_output_to_pre.get(old_tag)
        if pre_index is None:
            raise RuntimeError(
                f"Post-fragment volume {tag} (old piece {old_tag}) has no known "
                "pre-fragment index; material/selector binding cannot be trusted."
            )
        current_to_pre[tag] = pre_index

    return current_to_pre


def _fragment_and_track(
    input_tags: list[tuple[int, int]],
    input_to_pre: dict[int, int],
    diag: float,
    *,
    tolerance: float | None = None,
    stage_log: list[dict[str, Any]] | None = None,
    graveyard_pre: set[int] | None = None,
) -> dict[int, int]:
    """Fragment ``input_tags`` with staged imprint recovery.

    Stages (each validated; every fallback REPORTED via ``stage_log``):
    S0 fragment at model tolerance, S1 ``removeAllDuplicates`` re-validation,
    S2 capped tolerance-relaxed refragment (10x, single retry), S3 model-only
    fallback that drops the ``graveyard_pre`` inputs (gmsh-fragment-only rule
    unchanged — the graveyard is never OCP-cut), S4 hard fail with the stage
    log. Retries reuse the original inputs; stale-tag failures surface as S4
    rather than risking a wrong material binding. The model is never modified.

    ``stage_log`` (appended in place) feeds the ``imprintStages`` result key;
    callers surface S2/S3 entries through :func:`_report_imprint_fallbacks`.
    """
    if not input_tags:
        return {}

    log: list[dict[str, Any]] = stage_log if stage_log is not None else []
    base_tol = float(tolerance) if tolerance is not None else _read_imprint_tolerance()
    volumes_in = len(input_tags)
    last_error = "unknown error"

    # S0 fragment + S1 removeAllDuplicates at model tolerance.
    try:
        mapping = _fragment_track_and_map(input_tags, input_to_pre, diag)
        volumes_out = _safe_volume_count()
        log.append(_stage_entry("S0", base_tol, volumes_in, volumes_out, "ok"))
        log.append(_stage_entry("S1", base_tol, volumes_in, volumes_out, "ok"))
        return mapping
    except Exception as exc:
        last_error = str(exc)
        volumes_out = _safe_volume_count()
        log.append(_stage_entry("S0", base_tol, volumes_in, volumes_out, "failed", last_error))
        log.append(
            _stage_entry(
                "S1", base_tol, volumes_in, volumes_out, "skipped", "S0 failed; see S0 note"
            )
        )

    # S2 tolerance-relaxed refragment (single capped retry).
    relaxed_tol = _relaxed_imprint_tolerance(base_tol)
    saved_tol = _read_imprint_tolerance()
    try:
        _apply_imprint_tolerance(relaxed_tol)
        try:
            mapping = _fragment_track_and_map(input_tags, input_to_pre, diag)
            volumes_out = _safe_volume_count()
            s2_entry = _stage_entry(
                "S2",
                relaxed_tol,
                volumes_in,
                volumes_out,
                "ok",
                f"tolerance relaxed {base_tol:.0e} -> {relaxed_tol:.0e}",
            )
            s2_entry["previousTolerance"] = base_tol
            log.append(s2_entry)
            return mapping
        except Exception as exc:
            last_error = str(exc)
            volumes_out = _safe_volume_count()
            s2_entry = _stage_entry(
                "S2", relaxed_tol, volumes_in, volumes_out, "failed", last_error
            )
            s2_entry["previousTolerance"] = base_tol
            log.append(s2_entry)
    finally:
        _apply_imprint_tolerance(saved_tol)

    # S3 model-only fallback: drop the graveyard inputs and re-imprint.
    grave = set(graveyard_pre or set())
    model_only_tags = [
        (dim, tag) for dim, tag in input_tags if input_to_pre.get(int(tag)) not in grave
    ]
    if grave and model_only_tags and len(model_only_tags) < len(input_tags):
        model_pre = {int(tag): input_to_pre[int(tag)] for _, tag in model_only_tags}
        try:
            mapping = _fragment_track_and_map(model_only_tags, model_pre, diag)
            volumes_out = _safe_volume_count()
            log.append(
                _stage_entry(
                    "S3",
                    base_tol,
                    len(model_only_tags),
                    volumes_out,
                    "recovered",
                    "graveyardSkipped: fragmented model volumes only",
                )
            )
            return mapping
        except Exception as exc:
            last_error = str(exc)
            volumes_out = _safe_volume_count()
            log.append(
                _stage_entry(
                    "S3", base_tol, len(model_only_tags), volumes_out, "failed", last_error
                )
            )

    # S4 hard fail with the stage log; the model is left unmodified.
    stage_summary = "; ".join(f"{e.get('stage')}:{e.get('status')}" for e in log)
    log.append(_stage_entry("S4", base_tol, volumes_in, _safe_volume_count(), "failed", last_error))
    raise RuntimeError(
        f"Imprint failed at S4 with no further fallback (stages {stage_summary}); "
        f"model left unmodified. Last error: {last_error}"
    )


def _mesh_volumes_by_tag(
    vertices: Any, face_triangles: dict[int, Any], face_to_volumes: dict[int, list[int]]
) -> dict[int, float]:
    """Return the enclosed mesh volume per gmsh volume tag.

    Each volume's boundary is the union of its adjacent faces' triangles
    (shared faces legitimately count toward both neighbors), integrated with
    the divergence theorem. Failures yield an empty dict; never raises.
    """
    volumes: dict[int, float] = {}
    if inspection_gates is None:
        return volumes
    try:
        vol_faces: dict[int, list[int]] = {}
        for face_tag, vols in face_to_volumes.items():
            if face_tag not in face_triangles:
                continue
            for vol in vols:
                vol_faces.setdefault(int(vol), []).append(face_tag)
        for vol_id, face_tags in vol_faces.items():
            parts = [face_triangles[tag] for tag in face_tags if tag in face_triangles]
            if not parts:
                continue
            if HAS_NUMPY and np is not None:
                stacked = np.concatenate(parts, axis=0)
            else:
                stacked = [tri for part in parts for tri in part]
            volumes[vol_id] = inspection_gates.mesh_enclosed_volume(vertices, stacked)
    except Exception:
        return {}
    return volumes


def _extract_gmsh_surface_mesh(
    warnings: list[str],
) -> tuple[np.ndarray, dict[int, np.ndarray], dict[int, list[int]], dict[int, int]]:
    """Extract gmsh surface mesh data.

    Returns ``(vertices, face_triangles, face_to_volumes, gmsh_to_dense)``
    where ``vertices`` is a dense (N, 3) float64 array, ``face_triangles`` maps
    gmsh face tag to a (M, 3) int32 triangle index array into ``vertices``,
    ``face_to_volumes`` maps face tag to adjacent 1-based volume tags, and
    ``gmsh_to_dense`` maps original gmsh node tag to dense 0-based vertex index.
    """
    if np is None:
        raise RuntimeError("numpy is required")
    if gmsh is None:
        raise RuntimeError("gmsh is required")

    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    gmsh_to_dense: dict[int, int] = {}
    dense_coords: list[list[float]] = []
    for tag, x, y, z in zip(node_tags, coords[0::3], coords[1::3], coords[2::3], strict=True):
        gmsh_to_dense[int(tag)] = len(dense_coords)
        dense_coords.append([float(x), float(y), float(z)])

    vertices = np.array(dense_coords, dtype=np.float64)

    face_triangles: dict[int, np.ndarray] = {}
    face_to_volumes: dict[int, list[int]] = {}

    faces = gmsh.model.getEntities(2)
    for dim, tag in faces:
        tag = int(tag)
        up, _ = gmsh.model.getAdjacencies(dim, tag)
        face_to_volumes[tag] = [int(v) for v in up]

        elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim, tag)
        triangles: list[list[int]] = []
        for etype, etags, nodes in zip(elem_types, elem_tags, elem_node_tags, strict=True):
            if int(etype) != 2:  # Not a 3-node triangle
                continue
            for i in range(len(etags)):
                tri_nodes = nodes[i * 3 : (i + 1) * 3]
                triangles.append([gmsh_to_dense[int(n)] for n in tri_nodes])

        if not triangles:
            warnings.append(f"Face {tag} has no triangles; skipping.")
            # Drop empty faces so downstream MOAB bookkeeping never references
            # a surface meshset that does not exist.
            face_to_volumes.pop(tag, None)
            continue

        face_triangles[tag] = np.array(triangles, dtype=np.int32)

    return vertices, face_triangles, face_to_volumes, gmsh_to_dense


def _build_moab_model(
    vertices: np.ndarray,
    face_triangles: dict[int, np.ndarray],
    face_to_volumes: dict[int, list[int]],
    material_names: dict[int, str],
    faceting_tolerance: float,
) -> Any:
    """Build a pymoab Core with the DAGMC tags and return it."""
    if moab_core is None or moab_types is None:
        raise RuntimeError("pymoab is required")

    mb = moab_core.Core()
    tag_cat = mb.tag_get_handle(
        moab_types.CATEGORY_TAG_NAME,
        moab_types.CATEGORY_TAG_SIZE,
        moab_types.MB_TYPE_OPAQUE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_name = mb.tag_get_handle(
        moab_types.NAME_TAG_NAME,
        moab_types.NAME_TAG_SIZE,
        moab_types.MB_TYPE_OPAQUE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_gdim = mb.tag_get_handle(
        moab_types.GEOM_DIMENSION_TAG_NAME,
        1,
        moab_types.MB_TYPE_INTEGER,
        moab_types.MB_TAG_DENSE,
        create_if_missing=True,
    )
    tag_gid = mb.tag_get_handle(moab_types.GLOBAL_ID_TAG_NAME)
    tag_sense = mb.tag_get_handle(
        "GEOM_SENSE_2",
        2,
        moab_types.MB_TYPE_HANDLE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_facet_tol = mb.tag_get_handle(
        "FACETING_TOL",
        1,
        moab_types.MB_TYPE_DOUBLE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )

    moab_verts = mb.create_vertices(vertices)

    surface_sets: dict[int, Any] = {}
    surf_id = 1
    for face_tag in sorted(face_triangles.keys()):
        sset = mb.create_meshset()
        mb.tag_set_data(tag_gid, sset, surf_id)
        mb.tag_set_data(tag_gdim, sset, 2)
        mb.tag_set_data(tag_cat, sset, "Surface")
        surface_sets[face_tag] = sset

        tri_idx = face_triangles[face_tag]
        for a, b, c in tri_idx:
            tri_verts = (moab_verts[int(a)], moab_verts[int(b)], moab_verts[int(c)])
            mb_tri = mb.create_element(moab_types.MBTRI, tri_verts)
            mb.add_entity(sset, mb_tri)
        surf_id += 1

    # Build volume sets from all adjacent volume IDs.
    all_vol_ids: set[int] = set()
    for vols in face_to_volumes.values():
        all_vol_ids.update(vols)

    volume_sets: dict[int, Any] = {}
    for vol_id in sorted(all_vol_ids):
        vset = mb.create_meshset()
        mb.tag_set_data(tag_gid, vset, vol_id)
        mb.tag_set_data(tag_gdim, vset, 3)
        mb.tag_set_data(tag_cat, vset, "Volume")
        volume_sets[vol_id] = vset

    # Parent-child surface links.
    for face_tag, vols in face_to_volumes.items():
        sset = surface_sets[face_tag]
        for vol_id in vols:
            if vol_id in volume_sets:
                mb.add_parent_child(volume_sets[vol_id], sset)

    # Material groups.
    for vol_id in sorted(volume_sets.keys()):
        mat_name = material_names.get(vol_id)
        if mat_name is None:
            mat_name = _fallback_material_name(vol_id)
        gset = mb.create_meshset()
        mb.tag_set_data(tag_cat, gset, "Group")
        mb.tag_set_data(tag_gdim, gset, 4)
        mb.tag_set_data(tag_name, gset, mat_name)
        mb.tag_set_data(tag_gid, gset, vol_id)
        mb.add_entity(gset, volume_sets[vol_id])

    # GEOM_SENSE_2 tags.
    for face_tag, vols in face_to_volumes.items():
        sset = surface_sets.get(face_tag)
        if sset is None:
            continue
        if len(vols) == 2 and vols[0] in volume_sets and vols[1] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
        elif len(vols) >= 1 and vols[0] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
        else:
            continue
        mb.tag_set_data(tag_sense, sset, sense_data)

    root = mb.get_root_set()
    mb.tag_set_data(tag_facet_tol, root, float(faceting_tolerance))

    return mb


def _offending_senses(
    face_triangles: dict[int, Any], face_to_volumes: dict[int, list[int]]
) -> list[tuple[int, list[int]]]:
    """Return ``(surface_tag, adjacent_volumes)`` for surfaces bordering != 1-2 volumes (pure)."""
    offending: list[tuple[int, list[int]]] = []
    for face_tag in sorted(face_triangles.keys()):
        vols = list(face_to_volumes.get(face_tag, []))
        if len(vols) not in (1, 2):
            offending.append((face_tag, vols))
    return offending


def _verify_surface_senses(
    face_triangles: dict[int, Any],
    face_to_volumes: dict[int, list[int]],
    stage: str | None = None,
) -> None:
    """Verify every exported surface borders exactly 1 or 2 volumes.

    Anything else is a hard error (DAGMC cannot interpret it); the message
    names each offending surface with its adjacent volume IDs and the imprint
    stage so the failure is diagnosable. An empty ``face_triangles`` is also
    a hard error because it means the export produced no usable surfaces.
    """
    if not face_triangles:
        raise RuntimeError("Surface sense verification failed: no exported faces")
    offending = _offending_senses(face_triangles, face_to_volumes)
    if offending:
        parts = []
        for face_tag, vols in offending:
            vols_text = ", ".join(str(v) for v in vols)
            parts.append(
                f"surface {face_tag} (adjacent volumes: {len(vols)}) volumes [{vols_text}]"
            )
        message = (
            "DAGMC surface sense verification failed: every surface must border "
            "exactly 1 or 2 volumes. Offending surfaces: " + "; ".join(parts) + "."
        )
        if stage is not None:
            message += f" Imprint failed at {stage}. Not exported."
        raise RuntimeError(message)


def _watertight_check(mb: Any, surface_sets: dict[int, Any], warnings: list[str]) -> dict[str, Any]:
    """Return edge-to-triangle incidence statistics for the faceted model.

    The watertightness criterion for DAGMC is holes: an edge shared by only
    one triangle is a boundary edge matched by no neighboring surface, i.e. a
    leak. Edges shared by more than two triangles occur legitimately at
    imprint seams (three or more surfaces meet there) and are reported as a
    diagnostic count, not flagged as defects. ``sealed`` is True when no hole
    edges exist.
    """
    edge_to_tris: dict[tuple[int, int], set[Any]] = {}
    for sset in surface_sets.values():
        tris = mb.get_entities_by_type(sset, moab_types.MBTRI)
        for tri in tris:
            verts = mb.get_connectivity(tri)
            for i in range(3):
                a, b = int(verts[i]), int(verts[(i + 1) % 3])
                edge = tuple(sorted((a, b)))
                edge_to_tris.setdefault(edge, set()).add(tri)

    counts = [len(tris) for tris in edge_to_tris.values()]
    histogram: dict[str, int] = {}
    for c in counts:
        histogram[str(c)] = histogram.get(str(c), 0) + 1

    non_manifold = sum(1 for c in counts if c > 2)
    hole_edges = sum(1 for c in counts if c == 1)
    if hole_edges:
        warnings.append(
            f"Found {hole_edges} edges shared by only one triangle; "
            "the facet mesh has holes and is not watertight."
        )

    return {
        "totalEdges": len(edge_to_tris),
        "edgeHistogram": histogram,
        "nonManifoldEdges": non_manifold,
        "holeEdges": hole_edges,
        "sealed": hole_edges == 0,
    }


def convert_to_dagmc(
    step_path: str,
    output_path: str | None = None,
    manifest: Any | None = None,
    selector_map: dict[str, list[int]] | None = None,
    faceting_tolerance: float = 0.001,
    length_scale: float = 1.0,
    auto_adjust_tolerance: bool = True,
    add_graveyard: bool = True,
    existing_graveyard_vol_ids: set[int] | None = None,
) -> dict[str, Any]:
    """Convert a canonical STEP file to a DAGMC .h5m file.

    Args:
        step_path: Input STEP file path.
        output_path: Output .h5m file path. If None, uses a sibling path.
        manifest: Optional ``RegionManifest`` instance for named material groups.
        selector_map: Mapping from selector name to list of 1-based volume IDs.
        faceting_tolerance: Mesh tolerance for faceting.
        length_scale: Scale factor applied to mesh vertices.
        auto_adjust_tolerance: Whether to auto-adjust tolerance for large models.
        add_graveyard: Whether to auto-create a mat:graveyard bounding volume.
        existing_graveyard_vol_ids: Optional explicit set of 1-based volume IDs
            to treat as graveyard (opt-in, overrides auto-detection). This is
            the preferred way to flag an existing graveyard because the removed
            volume-ratio heuristic could misidentify large model envelopes.

    Returns:
        Dict with ``success``, ``output_path``, ``warnings``, ``error``,
        ``solid_count``, ``surface_count``, ``triangle_count``,
        ``watertight`` metrics, the ``overlapCheck`` report, structured
        ``diagnostics`` (``[{code, severity, bodies, surfaces, detail, hint}]``),
        the ``imprintStages`` log (``[{stage, tolerance, volumesIn,
        volumesOut, status}]``), and the ``sealCheck`` summary
        (``{sealed, openEdgeCount, hint}``). Every imprint fallback is
        REPORTED; the model itself is never modified.
    """
    result: dict[str, Any] = {
        "success": False,
        "output_path": output_path,
        "warnings": [],
        "error": None,
        "diagnostics": [],
        "imprintStages": [],
        "sealCheck": None,
    }

    try:
        _require_deps()
    except RuntimeError as e:
        result["error"] = str(e)
        return result

    step_file = Path(step_path).resolve()
    if not step_file.exists():
        result["error"] = f"STEP file not found: {step_path}"
        return result

    if output_path is None:
        output_path = str(step_file.with_suffix(".h5m"))
    out_path = Path(output_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result["output_path"] = str(out_path)

    if selector_map is None:
        selector_map = {}

    warnings: list[str] = []
    diagnostics: list[dict[str, Any]] = []
    imprint_stages: list[dict[str, Any]] = []
    seal_check: dict[str, Any] | None = None
    gmsh_initialized = False

    try:
        # ------------------------------------------------------------------
        # 1. Load STEP for overlap check and existing-graveyard detection.
        # ------------------------------------------------------------------
        shape = _load_shape(str(step_file))
        graveyard_vol_ids: set[int] = set()
        has_existing_graveyard = False
        if add_graveyard:
            existing_gy_index: int | None = None
            if existing_graveyard_vol_ids:
                has_existing_graveyard = True
                # Prefer the smallest explicit ID as the canonical pre-fragment
                # graveyard index; all explicit IDs are tagged mat:graveyard.
                existing_gy_index = min(existing_graveyard_vol_ids) - 1
                graveyard_vol_ids.update(existing_graveyard_vol_ids)
                warnings.append(
                    "Existing graveyard volume(s) flagged by caller; skipping auto-creation."
                )
            else:
                has_existing_graveyard, detected_index = _detect_existing_graveyard(
                    shape, str(step_file)
                )
                if has_existing_graveyard:
                    existing_gy_index = detected_index
                    if existing_gy_index is not None:
                        graveyard_vol_ids.add(existing_gy_index + 1)
                        warnings.append(
                            "Existing graveyard volume detected; skipping auto-creation."
                        )
                    else:
                        warnings.append(
                            "Existing graveyard name found but could not be matched to a solid; "
                            "material tag may need manual correction."
                        )

        # Overlap check on the pre-fragment volumes (1-based explorer order,
        # the same indexing convention as the selector map and graveyard IDs).
        overlap_report: dict[str, Any] = {
            "checkedVolumes": 0,
            "overlappingPairs": [],
            "samplesPerVolume": 0,
        }
        try:
            overlap_report = _check_volume_overlaps(shape, skip_vol_ids=graveyard_vol_ids)
            for pair in overlap_report["overlappingPairs"]:
                entry, message = overlap_diagnostic(
                    pair[0],
                    pair[1],
                    _volume_label(pair[0], manifest, selector_map),
                    _volume_label(pair[1], manifest, selector_map),
                )
                diagnostics.append(entry)
                warnings.append(f"[DAGMC] {message}")
        except Exception as exc:
            warnings.append(f"Overlap check skipped: {exc}")

        # Pre-export gate 1: mass-property sanity (volume/COM sanity per
        # solid). Warnings only — never fatal.
        mass_gate_warnings: list[str] = []
        if HAS_INSPECTION_GATES and inspection_gates is not None:
            try:
                mass_gate_warnings = inspection_gates.check_solid_mass_properties(shape)
                warnings.extend(mass_gate_warnings)
            except Exception as exc:
                warnings.append(f"Mass-property gate skipped: {exc}")

        # ------------------------------------------------------------------
        # 2. gmsh imprint/merge, optional graveyard, and surface mesh.
        # ------------------------------------------------------------------
        gmsh.initialize()
        gmsh_initialized = True
        gmsh.option.setNumber("General.Terminal", 0)

        gmsh.open(str(step_file))
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(3)
        if not volumes:
            raise RuntimeError("No volumes found in STEP file")

        # Geometric scale for signature matching tolerance.
        bbox = gmsh.model.getBoundingBox(-1, -1)
        diag = sum((bbox[i + 3] - bbox[i]) ** 2 for i in range(3)) ** 0.5

        # Track pre-fragment identities (1-based input tags) through gmsh's
        # imprint/merge and optional graveyard insertion. ``_fragment_and_track``
        # survives tag renumbering after ``removeAllDuplicates`` by matching
        # geometric signatures (volume + bbox).
        input_to_pre: dict[int, int] = {}
        for _dim, tag in volumes:
            tag = int(tag)
            input_to_pre[tag] = tag

        post_to_pre = _fragment_and_track(volumes, input_to_pre, diag, stage_log=imprint_stages)
        reported_upto = _report_imprint_fallbacks(imprint_stages, 0, warnings, diagnostics)

        # Optional auto-created graveyard: add a bounding box in gmsh and
        # fragment again. This preserves model-model shared faces because the
        # graveyard is never routed through an OCP boolean cut.
        gy_pre_index: int | None = None
        if add_graveyard and not has_existing_graveyard:
            xmin, ymin, zmin, xmax, ymax, zmax = bbox
            dx = xmax - xmin
            dy = ymax - ymin
            dz = zmax - zmin
            max_dim = max(dx, dy, dz)
            padding = max(1.0, 0.1 * max_dim)

            gy_xmin = xmin - padding
            gy_ymin = ymin - padding
            gy_zmin = zmin - padding
            gy_tag = gmsh.model.occ.addBox(
                gy_xmin,
                gy_ymin,
                gy_zmin,
                dx + 2 * padding,
                dy + 2 * padding,
                dz + 2 * padding,
            )
            gmsh.model.occ.synchronize()

            gy_pre_index = len(volumes) + 1
            graveyard_vol_ids = {gy_pre_index}

            current_tags = gmsh.model.getEntities(3)
            input_to_pre = {int(tag): pre for tag, pre in post_to_pre.items()}
            input_to_pre[gy_tag] = gy_pre_index

            post_to_pre = _fragment_and_track(
                current_tags,
                input_to_pre,
                diag,
                stage_log=imprint_stages,
                graveyard_pre={gy_pre_index} if gy_pre_index is not None else None,
            )
            reported_upto = _report_imprint_fallbacks(
                imprint_stages, reported_upto, warnings, diagnostics
            )
            warnings.append("Auto-created graveyard volume around model (mat:graveyard).")

        tol = faceting_tolerance
        if auto_adjust_tolerance:
            bbox = gmsh.model.getBoundingBox(-1, -1)
            diag = sum((bbox[i + 3] - bbox[i]) ** 2 for i in range(3)) ** 0.5
            if diag > 100 and tol < 1.0:
                old_tol = tol
                tol = max(tol, min(diag / 200, 10.0))
                warnings.append(
                    f"Faceting tolerance auto-adjusted from {old_tol:.4f} to {tol:.4f} "
                    f"for large model (diagonal {diag:.1f})"
                )

        # Size field: interpret ``tol`` as a rough target mesh edge length.
        # Curved surfaces are refined based on curvature. This is a pragmatic
        # mapping from faceting tolerance to gmsh's length-field API. The min
        # length floor stays within an order of magnitude below ``tol``: a
        # smaller floor lets curvature refinement emit needle facets (aspect
        # >100:1) that DAGMC ray firing intermittently misses, causing
        # sporadic "no intersection" lost particles at large model scale.
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", tol / 10.0)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", max(tol * 10.0, 0.1))
        gmsh.option.setNumber("Mesh.CharacteristicLengthFromCurvature", 1)
        gmsh.option.setNumber("Mesh.MinimumCirclePoints", 12)
        gmsh.option.setNumber("Mesh.MinimumCurvePoints", 3)

        gmsh.model.mesh.generate(2)

        # Guard against a silent no-op mesh generation (can happen when gmsh
        # considers the geometry invalid but does not raise).
        mesh_node_tags, _, _ = gmsh.model.mesh.getNodes()
        if len(mesh_node_tags) == 0:
            raise RuntimeError("gmsh surface mesh generation produced no nodes")

        vertices, face_triangles, face_to_volumes, _ = _extract_gmsh_surface_mesh(warnings)
        if not face_triangles:
            raise RuntimeError("No surface triangles were generated for the model")

        all_vol_ids = {v for vols in face_to_volumes.values() for v in vols}
        if not all_vol_ids:
            raise RuntimeError("No volumes were found after surface mesh extraction")

        # Pre-export gate 2: mesh-vs-CAD deviation as an overlap/gap
        # detector. Per-volume mesh volumes (divergence theorem over each
        # volume's boundary faces) are compared against the CAD masses from
        # the OCC kernel; large deviations suggest imprint/merge artifacts or
        # under-resolved facets. Warnings only — never fatal.
        mesh_gate_warnings: list[str] = []
        if HAS_INSPECTION_GATES and inspection_gates is not None:
            try:
                mesh_volumes = _mesh_volumes_by_tag(vertices, face_triangles, face_to_volumes)
                cad_volumes: dict[int, float] = {}
                for _dim, tag in gmsh.model.getEntities(3):
                    try:
                        cad_volumes[int(tag)] = float(gmsh.model.occ.getMass(3, int(tag)))
                    except Exception:
                        continue
                # Report under pre-fragment indices so manifest selectors and
                # graveyard IDs line up with the names in other warnings.
                cad_by_pre = {post_to_pre.get(tag, tag): vol for tag, vol in cad_volumes.items()}
                mesh_by_pre = {post_to_pre.get(tag, tag): vol for tag, vol in mesh_volumes.items()}
                mesh_gate_warnings = inspection_gates.check_mesh_vs_cad(cad_by_pre, mesh_by_pre)
                warnings.extend(mesh_gate_warnings)
            except Exception as exc:
                warnings.append(f"Mesh-vs-CAD deviation gate skipped: {exc}")
        else:
            mesh_gate_warnings = []

        gmsh.finalize()
        gmsh_initialized = False

        # ------------------------------------------------------------------
        # 4. Verify surface senses before building the MOAB model. A sense
        #    failure stays a hard error, but the message names the surface,
        #    its volumes, and the imprint stage.
        # ------------------------------------------------------------------
        imprint_stage = _last_ok_imprint_stage(imprint_stages)
        try:
            _verify_surface_senses(face_triangles, face_to_volumes, stage=imprint_stage)
        except RuntimeError as exc:
            bad_surfaces = [tag for tag, _ in _offending_senses(face_triangles, face_to_volumes)]
            diagnostics.append(
                make_diagnostic(
                    "sense",
                    "error",
                    surfaces=bad_surfaces,
                    detail=str(exc),
                    hint="Inspect open edges (sealCheck.openEdgeCount) and re-run imprint.",
                )
            )
            raise

        # ------------------------------------------------------------------
        # 5. Build MOAB model. Material names are resolved through the
        #    pre-fragment volume index so manifest selectors and graveyard
        #    IDs (both pre-fragment 1-based) bind correctly.
        # ------------------------------------------------------------------
        material_names = {}
        for vol_id in {v for vols in face_to_volumes.values() for v in vols}:
            pre_index = post_to_pre.get(vol_id, vol_id)
            material_names[vol_id] = _volume_name_from_manifest(
                pre_index, manifest, selector_map, graveyard_vol_ids
            )

        if length_scale != 1.0:
            vertices *= length_scale

        mb = _build_moab_model(
            vertices,
            face_triangles,
            face_to_volumes,
            material_names,
            tol,
        )

        # Re-fetch surface meshsets from MOAB for watertight check.
        cat_tag = mb.tag_get_handle(
            moab_types.CATEGORY_TAG_NAME,
            moab_types.CATEGORY_TAG_SIZE,
            moab_types.MB_TYPE_OPAQUE,
            moab_types.MB_TAG_SPARSE,
            create_if_missing=True,
        )
        gdim_tag = mb.tag_get_handle(
            moab_types.GEOM_DIMENSION_TAG_NAME,
            1,
            moab_types.MB_TYPE_INTEGER,
            moab_types.MB_TAG_DENSE,
            create_if_missing=True,
        )
        all_sets = mb.get_entities_by_type_and_tag(
            mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Surface"]
        )
        surface_sets = {
            i: s for i, s in enumerate(all_sets) if mb.tag_get_data(gdim_tag, s)[0][0] == 2
        }
        watertight = _watertight_check(mb, surface_sets, warnings)

        # Seal-check fail-fast with repair hints: stop before writing a
        # leaking h5m. Never silent — the failure is REPORTED in diagnostics.
        seal_hint = "Inspect open edges (sealCheck.openEdgeCount) and close gaps before export"
        seal_check = {
            "sealed": bool(watertight.get("sealed", False)),
            "openEdgeCount": int(watertight.get("holeEdges", 0)),
            "hint": seal_hint,
        }
        if not seal_check["sealed"]:
            detail = seal_error_message(seal_check["openEdgeCount"], seal_hint)
            diagnostics.append(make_diagnostic("seal", "error", detail=detail, hint=seal_hint))
            raise RuntimeError(detail)

        mb.write_file(str(out_path))

        result.update(
            {
                "success": True,
                "solid_count": len({v for vols in face_to_volumes.values() for v in vols}),
                "surface_count": len(face_triangles),
                "triangle_count": int(sum(len(t) for t in face_triangles.values())),
                "warnings": warnings,
                "watertight": watertight,
                "overlapCheck": overlap_report,
                "diagnostics": diagnostics,
                "imprintStages": imprint_stages,
                "sealCheck": seal_check,
                "inspectionGates": {
                    "massProperties": mass_gate_warnings,
                    "meshDeviation": mesh_gate_warnings,
                },
            }
        )

    except Exception as e:
        result["error"] = f"DAGMC export failed: {e}"
        result["traceback"] = traceback.format_exc()
        result["warnings"] = warnings
        result["diagnostics"] = diagnostics
        result["imprintStages"] = imprint_stages
        result["sealCheck"] = seal_check
        if gmsh_initialized:
            try:
                gmsh.finalize()
            except Exception:
                pass

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="nuke-cad DAGMC export service")
    parser.add_argument("step", help="Path to the input STEP file")
    parser.add_argument("--output", default=None, help="Output .h5m file path")
    parser.add_argument("--tolerance", type=float, default=0.001, help="Faceting tolerance")
    parser.add_argument(
        "--no-auto-tolerance",
        action="store_true",
        help="Keep the requested tolerance instead of relaxing it to diagonal/200",
    )
    parser.add_argument("--no-graveyard", action="store_true", help="Do not auto-create graveyard")
    args = parser.parse_args()

    res = convert_to_dagmc(
        args.step,
        output_path=args.output,
        faceting_tolerance=args.tolerance,
        auto_adjust_tolerance=not args.no_auto_tolerance,
        add_graveyard=not args.no_graveyard,
    )
    print(json.dumps(res))
    sys.stdout.flush()
    sys.exit(0 if res.get("success") else 1)
