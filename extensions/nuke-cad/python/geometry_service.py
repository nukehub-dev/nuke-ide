#!/usr/bin/env python3
"""Geometry service for nuke-cad.

Executes a user-authored build123d/CadQuery script or imports an existing STEP
file, normalizes the resulting object to an OCP B-rep, and emits canonical
artifacts:

    <stem>.step              canonical STEP export
    <stem>.tess.json         per-solid/per-face triangle stream for the viewport
    <stem>.h5m               DAGMC export with imprint/merge and named groups
    <stem>.msh / .e / .inp   FEM volume mesh (gmsh native, ExodusII, CalculiX)
    <stem>.mesh.report.json  mesh quality report

Progress and diagnostics are emitted on stderr. One final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).

Script convention
-----------------
For script sources, the file must define a top-level variable named ``model``
that holds the canonical geometry object. Supported types:

* ``build123d.Part``, ``build123d.Compound`` (primary)
* ``cadquery.Workplane``, ``cadquery.Assembly`` (compat)
* ``OCP.TopoDS.TopoDS_Shape`` (escape hatch)

Scripts execute in an isolated child process (timeout enforced, stdout/stderr
captured); the normalized shape is handed back as a BREP file. A ``sys.exit``
or crash in the user script is reported as a normal error result.
"""

import argparse
import json
import math
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
    brep_tool_triangulation,
    brep_tools_read,
    brep_tools_write,
    ensure_topo_ds_static_aliases,
    interface_static_set_cval,
    topods_face,
    topods_solid,
)
from region_manifest import ManifestValidationError, RegionManifest  # noqa: E402

# Document builder modules are optional; they guard their own build123d imports.
try:
    import feature_builder  # noqa: E402

    HAS_FEATURE_BUILDER = True
except Exception:
    feature_builder = None  # type: ignore
    HAS_FEATURE_BUILDER = False

try:
    import sketch_builder  # noqa: E402

    HAS_SKETCH_BUILDER = True
except Exception:
    sketch_builder = None  # type: ignore
    HAS_SKETCH_BUILDER = False

try:
    import curve_builder  # noqa: E402

    HAS_CURVE_BUILDER = True
except Exception:
    curve_builder = None  # type: ignore
    HAS_CURVE_BUILDER = False

# Result-cache sidecar (P2): pure stdlib, always importable. The zip path is
# composed from the caller-provided cache dir + document stem; a missing dir
# disables caching for that build.
try:
    import doc_cache  # noqa: E402

    HAS_DOC_CACHE = True
except Exception:
    doc_cache = None  # type: ignore
    HAS_DOC_CACHE = False

# DAGMC export is optional; failure is reported but does not break STEP/tessellation.
try:
    import dagmc_export

    HAS_DAGMC_EXPORT = True
except Exception:
    dagmc_export = None  # type: ignore
    HAS_DAGMC_EXPORT = False

# Meshing export is optional; failure is reported but does not break STEP/tessellation.
try:
    import mesh_service

    HAS_MESH_SERVICE = True
except Exception:
    mesh_service = None  # type: ignore
    HAS_MESH_SERVICE = False

# Reference resolver is optional; tessellation fingerprints are omitted without OCP.
try:
    import reference_resolver

    HAS_REFERENCE_RESOLVER = True
except Exception:
    reference_resolver = None  # type: ignore
    HAS_REFERENCE_RESOLVER = False


RESULT_MARKER = "__NUKE_RESULT__"


def _print_progress(message: str) -> None:
    """Emit a progress line on stderr."""
    print(message, file=sys.stderr, flush=True)


def _emit_result(result: dict[str, Any]) -> None:
    """Emit the stdout-JSON result line with the protocol marker."""
    print(f"{RESULT_MARKER}{json.dumps(result)}")
    sys.stdout.flush()


def _solids_in_explorer_order(shape: object) -> list[object]:
    """Return all TopoDS_Solid instances nested in ``shape`` in explorer order."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[object] = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids.append(topods_solid(TopoDS, exp.Current()))
        exp.Next()
    return solids


def _solid_indices_of(
    sub_shape: object, final_solids: list[object], partner: bool = False
) -> list[int]:
    """Return the 1-based indices of ``sub_shape``'s solids within ``final_solids``.

    By default solids match on ``IsSame`` (same TShape and Location). With
    ``partner=True`` they match on TShape identity only (``IsPartner``), which
    is needed when the final shape relocated the solids (CadQuery assemblies).
    """
    indices: list[int] = []
    for solid in _solids_in_explorer_order(sub_shape):
        for i, final in enumerate(final_solids):
            if solid.IsPartner(final) if partner else solid.IsSame(final):
                indices.append(i + 1)
                break
    return indices


def _extract_build123d_selectors(result: object) -> dict[str, list[int]]:
    """Map build123d labels to 1-based solid indices of the final shape.

    Walks the Part/Compound children tree; every node with a non-empty
    ``label`` contributes the solids it contains. Labels are only preserved
    when the model keeps its children (e.g. ``Compound(children=[...])``);
    wrapping shapes in a plain ``Compound([...])`` list discards them inside
    build123d itself.
    """
    final_solids = _solids_in_explorer_order(result.wrapped)
    selector_map: dict[str, list[int]] = {}

    def _visit(node: object) -> None:
        label = getattr(node, "label", None)
        if isinstance(label, str) and label:
            indices = _solid_indices_of(node.wrapped, final_solids)
            if indices:
                existing = selector_map.setdefault(label, [])
                for idx in indices:
                    if idx not in existing:
                        existing.append(idx)
                        existing.sort()
        for child in getattr(node, "children", None) or []:
            _visit(child)

    _visit(result)
    return selector_map


def _is_autogenerated_cq_name(name: str) -> bool:
    """Return True for the UUID names CadQuery assigns to unnamed parts."""
    import uuid

    try:
        uuid.UUID(name)
    except ValueError:
        return False
    return True


def _extract_cadquery_selectors(
    assembly: object, final_solids: list[object]
) -> dict[str, list[int]]:
    """Map CadQuery Assembly part names to 1-based solid indices of the final shape.

    Walks the assembly tree (nested assemblies included); every node with a
    user-assigned ``name`` contributes the solids its ``obj`` contains (names
    CadQuery auto-generates for unnamed parts are skipped). CadQuery's
    ``Assembly.toCompound()`` applies each part's ``Location``, so the final
    solids share TShapes with the parts but not Locations — matching is by
    TShape identity (``IsPartner``). Duplicate names merge their indices.
    """
    selector_map: dict[str, list[int]] = {}

    def _visit(node: object) -> None:
        name = getattr(node, "name", None)
        if isinstance(name, str) and name and not _is_autogenerated_cq_name(name):
            indices: list[int] = []
            for shape in getattr(node, "shapes", None) or []:
                wrapped = getattr(shape, "wrapped", None)
                if wrapped is not None:
                    indices.extend(_solid_indices_of(wrapped, final_solids, partner=True))
            if indices:
                existing = selector_map.setdefault(name, [])
                for idx in indices:
                    if idx not in existing:
                        existing.append(idx)
                        existing.sort()
        for child in getattr(node, "children", None) or []:
            _visit(child)

    _visit(assembly)
    return selector_map


def _extract_shape(result: object) -> tuple[object | None, dict[str, list[int]]]:
    """Normalize a build123d/CadQuery/OCP result to ``(topods_shape, selector_map)``.

    The selector map associates user-assigned labels/part names with the
    1-based solid indices that carry them (build123d ``label`` on Part/Compound
    children, CadQuery Assembly child names). Type errors for recognized but
    unsupported model types are raised to the caller, not swallowed.
    """
    selector_map: dict[str, list[int]] = {}

    # OCP escape hatch.
    try:
        from OCP.TopoDS import TopoDS_Shape

        if isinstance(result, TopoDS_Shape):
            return result, selector_map
    except ImportError:
        pass

    # build123d Part / Compound (Part subclasses Compound in build123d).
    try:
        import build123d as bd
    except ImportError:
        bd = None  # type: ignore

    if bd is not None and isinstance(result, bd.Shape):
        if isinstance(result, (bd.Part, bd.Compound)):
            selector_map = _extract_build123d_selectors(result)
            return result.wrapped, selector_map
        raise TypeError(
            f"Unsupported build123d model type {type(result).__name__}. "
            "Define the model as a Part or Compound of solids."
        )

    # CadQuery Workplane / Assembly.
    try:
        import cadquery as cq
    except ImportError:
        cq = None  # type: ignore

    if cq is not None:
        workplane = getattr(cq, "Workplane", None)
        assembly_type = getattr(cq, "Assembly", None)
        if workplane is not None and isinstance(result, workplane):
            vals = [v for v in result.vals() if isinstance(v, cq.Shape)]
            if not vals:
                raise TypeError(
                    "CadQuery Workplane model holds no shapes. "
                    "Define the model as a Workplane containing solids."
                )
            shape = vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
            return shape.wrapped, selector_map
        if assembly_type is not None and isinstance(result, assembly_type):
            compound = result.toCompound()
            selector_map = _extract_cadquery_selectors(
                result, _solids_in_explorer_order(compound.wrapped)
            )
            return compound.wrapped, selector_map

    return None, selector_map


def _execute_script_child(script_path: str, out_dir: str) -> dict:
    """Child-process entry point: execute the user script and dump the model.

    Runs the script with ``runpy``, normalizes ``model`` to an OCP shape,
    writes it as BREP to ``out_dir``, and returns the stdout-JSON payload
    (shape + selector map). Always returns a dict so the parent never sees a
    bare process death for ordinary script failures (including ``sys.exit``).
    """
    import runpy

    # Re-attach the TopoDS <X>_s downcast aliases removed in OCP 7.9 so user
    # scripts doing ``from build123d import *`` work on both OCP flavors.
    # No-op on OCP 7.8 and when OCP is absent (the script will fail anyway).
    ensure_topo_ds_static_aliases()

    script_file = Path(script_path).resolve()
    try:
        namespace = runpy.run_path(str(script_file), run_name="__nuke_cad_model__")
    except SystemExit as exc:
        return {
            "success": False,
            "error": f"Script called sys.exit({exc.code}) during execution",
            "traceback": traceback.format_exc(),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Script execution failed: {exc}",
            "traceback": traceback.format_exc(),
        }

    if "model" not in namespace:
        return {
            "success": False,
            "error": (
                "Script did not define a top-level 'model' variable. "
                "Assign your build123d Part/Compound or CadQuery Workplane to 'model'."
            ),
        }

    try:
        shape, selector_map = _extract_shape(namespace["model"])
    except TypeError as exc:
        return {"success": False, "error": str(exc), "traceback": traceback.format_exc()}
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to normalize 'model': {exc}",
            "traceback": traceback.format_exc(),
        }

    if shape is None:
        return {
            "success": False,
            "error": (
                "Could not extract an OCP B-rep from 'model'. "
                "Supported types: build123d Part/Compound, CadQuery Workplane, OCP TopoDS_Shape."
            ),
        }

    brep_path = Path(out_dir) / "model.brep"
    try:
        from OCP.BRepTools import BRepTools

        if not brep_tools_write(BRepTools, shape, str(brep_path)):
            return {"success": False, "error": f"Failed to write BREP handoff: {brep_path}"}
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to serialize model shape: {exc}",
            "traceback": traceback.format_exc(),
        }

    return {"success": True, "brepPath": str(brep_path), "selectorMap": selector_map}


DEFAULT_SCRIPT_TIMEOUT = 120.0


def _execute_script_isolated(
    script_file: Path, timeout: float = DEFAULT_SCRIPT_TIMEOUT
) -> tuple[object | None, dict[str, list[int]], dict | None]:
    """Execute a user script in a child process with a timeout.

    Returns ``(shape, selector_map, error)``; ``error`` is a stdout-JSON
    result dict on failure, else None. The child writes the normalized shape
    as BREP (lossless, unlike a STEP round-trip) plus the selector map.
    """
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory(prefix="nuke_cad_exec_") as tmpdir:
        cmd = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--exec-script",
            str(script_file),
            "--exec-dir",
            tmpdir,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return (
                None,
                {},
                {
                    "success": False,
                    "error": f"Script execution timed out after {timeout:g} seconds",
                    "scriptPath": str(script_file),
                },
            )

        # Forward child progress/diagnostics to our stderr.
        if proc.stderr:
            sys.stderr.write(proc.stderr)
            sys.stderr.flush()

        # The protocol payload is the last marked JSON line on stdout; the user
        # script may have printed arbitrary output before it.
        payload: dict | None = None
        for line in reversed(proc.stdout.splitlines()):
            line = line.strip()
            if not line.startswith(RESULT_MARKER):
                continue
            try:
                candidate = json.loads(line[len(RESULT_MARKER) :])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and "success" in candidate:
                payload = candidate
                break

        if payload is None:
            tail = (proc.stderr or "").strip().splitlines()[-5:]
            detail = "\n".join(tail) if tail else "no output"
            return (
                None,
                {},
                {
                    "success": False,
                    "error": (
                        f"Script process exited with code {proc.returncode} "
                        f"without a result:\n{detail}"
                    ),
                    "scriptPath": str(script_file),
                },
            )

        if not payload.get("success"):
            payload.setdefault("scriptPath", str(script_file))
            return None, {}, payload

        # Read the BREP handoff back into this process.
        try:
            from OCP.BRep import BRep_Builder
            from OCP.BRepTools import BRepTools
            from OCP.TopoDS import TopoDS_Shape

            shape = TopoDS_Shape()
            builder = BRep_Builder()
            if not brep_tools_read(BRepTools, shape, builder, payload["brepPath"]):
                raise RuntimeError(f"BREP reader failed for {payload['brepPath']}")
        except Exception as exc:
            return (
                None,
                {},
                {
                    "success": False,
                    "error": f"Failed to read script result shape: {exc}",
                    "traceback": traceback.format_exc(),
                    "scriptPath": str(script_file),
                },
            )

        selector_map = payload.get("selectorMap") or {}
        return shape, selector_map, None


def _label_color(label: str) -> tuple[float, float, float]:
    """Return a deterministic, human-readable RGB triple for a solid label.

    Stable across processes (md5, not ``hash``) with channels clamped to
    [0.25, 0.95] so faces stay visible on both dark and light viewports.
    """
    import hashlib

    digest = hashlib.md5(label.encode("utf-8")).digest()
    return tuple(0.25 + (byte / 255.0) * 0.70 for byte in digest[:3])


def _solid_names_from_selector_map(
    selector_map: dict[str, list[int]], solid_count: int
) -> list[str | None]:
    """Invert ``selector_map`` to per-solid (0-based) STEP product names.

    The first selector in sorted order wins when several selectors cover the
    same solid, so the mapping is deterministic. Uncovered solids get None.
    """
    names: list[str | None] = [None] * solid_count
    for selector in sorted(selector_map):
        for index in selector_map[selector] or []:
            if isinstance(index, int) and 1 <= index <= solid_count and names[index - 1] is None:
                names[index - 1] = selector
    return names


def _write_step_ocaf(
    shape: object,
    step_path: Path,
    solid_names: list[str | None] | None,
    face_colors: list[tuple[float, float, float] | None] | None,
) -> None:
    """Write ``shape`` to STEP with per-solid product names and face colors.

    FreeCAD ExportOCAF2 pattern adapted to the OCP API already in use: one
    free product label per explorer-order solid (``merge=false`` — solids are
    never fused), each carrying its label as the STEP product name plus a
    surface color. Raises on failure so the caller can fall back to the plain
    writer.
    """
    from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

    solids = _solids_in_explorer_order(shape)
    if not solids:
        raise RuntimeError("OCAF STEP export found no solids")

    doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for i, solid in enumerate(solids):
        label = shape_tool.NewShape()
        shape_tool.SetShape(label, solid)
        name = solid_names[i] if solid_names is not None and i < len(solid_names) else None
        color: tuple[float, float, float] | None = None
        if face_colors is not None and i < len(face_colors):
            color = face_colors[i]
        if name:
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(str(name)))
            if color is None:
                color = _label_color(str(name))
        if color is not None:
            quantity = Quantity_Color(
                float(color[0]), float(color[1]), float(color[2]), Quantity_TOC_RGB
            )
            color_tool.SetColor(label, quantity, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(doc):
        raise RuntimeError("OCAF STEP transfer failed")

    from OCP.IFSelect import IFSelect_RetDone

    if writer.Write(str(step_path)) != IFSelect_RetDone:
        raise RuntimeError(f"OCAF STEP writer failed for {step_path}")


def _write_step(
    shape: object,
    step_path: Path,
    solid_names: list[str | None] | None = None,
    face_colors: list[tuple[float, float, float] | None] | None = None,
) -> str | None:
    """Write ``shape`` to a STEP file using OCP.

    With per-solid ``solid_names``/``face_colors`` the OCAF writer is used so
    labels survive as STEP product names (plus face colors); without them the
    legacy ``STEPControl`` writer runs verbatim. Returns a warning string when
    the OCAF path fell back to the legacy writer (names dropped), else None.
    """
    wants_fidelity = bool(solid_names and any(solid_names)) or bool(
        face_colors and any(face_colors)
    )
    if wants_fidelity:
        try:
            _write_step_ocaf(shape, step_path, solid_names, face_colors)
            return None
        except Exception as exc:
            _print_progress(f"OCAF STEP export failed ({exc}); falling back to plain writer")

    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    writer = STEPControl_Writer()
    interface_static_set_cval(Interface_Static, "write.step.schema", "AP214IS")
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != 1:
        raise RuntimeError(f"STEP writer returned status {status}")
    if wants_fidelity:
        return "STEP product names were dropped (plain STEP writer fallback)"
    return None


def _read_step(step_path: Path) -> object:
    """Read a STEP file into an OCP ``TopoDS_Shape``."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP reader returned status {status} for {step_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None:
        raise RuntimeError(f"No shape transferred from {step_path}")
    return shape


def _read_step_names(step_path: Path, solid_count: int) -> dict[int, str]:
    """Best-effort per-solid STEP product names keyed by 1-based solid index.

    FreeCAD AppImportPy pattern adapted to the readers already in use: the
    CAF reader (name mode) maps free product labels — in file order — onto
    consecutive explorer-order solids. Returns {} whenever OCAF is
    unavailable, the file carries no names, or the label/solid counts do not
    line up. Never raises.
    """
    try:
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopAbs import TopAbs_SOLID
        from OCP.TopExp import TopExp_Explorer
        from OCP.XCAFDoc import XCAFDoc_DocumentTool

        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        reader.SetColorMode(True)
        if reader.ReadFile(str(step_path)) != 1:
            return {}
        doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad-import"))
        if not reader.Transfer(doc):
            return {}

        from OCP.TDF import TDF_LabelSequence

        shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        free_shapes = TDF_LabelSequence()
        shape_tool.GetFreeShapes(free_shapes)

        names: dict[int, str] = {}
        next_index = 1
        total = 0
        for i in range(1, free_shapes.Length() + 1):
            label = free_shapes.Value(i)
            product = shape_tool.GetShape_s(label)
            count = 0
            exp = TopExp_Explorer(product, TopAbs_SOLID)
            while exp.More():
                count += 1
                exp.Next()
            name_attr = TDataStd_Name()
            name: str | None = None
            if label.FindAttribute(TDataStd_Name.GetID_s(), name_attr):
                try:
                    candidate = name_attr.Get().ToExtString()
                    if candidate:
                        name = candidate
                except Exception:
                    name = None
            for _ in range(count):
                if name:
                    names[next_index] = name
                next_index += 1
            total += count

        if total != solid_count:
            return {}
        return names
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# CAD exchange: IGES / BREP / glTF / STL
#
# Read-write coverage with the OCP available in the dev env (OCP 7.8.1.2):
# IGES (IGESControl + IGESCAFControl, same OCAF name/color pattern as STEP),
# BREP (lossless native round-trip via BRepTools), glTF write
# (RWGltf_CafWriter over an XCAF document with precomputed triangulation),
# STL export (StlAPI_Writer over the tessellation route's BRepMesh settings).
# Partial-landing rule: whatever the binding lacks raises/returns a clear
# "not supported with this OCP build" error covered by error-path tests,
# never a silent fallback.
# Follow-up (not composed here): OBJ/PLY — this OCP exposes no OCP.RWObj /
# OCP.RWPly modules, so there is no trivially composable writer path.
# ---------------------------------------------------------------------------


def _unsupported_ocp_error(capability: str, exc: ImportError) -> str:
    """Format the partial-landing error for a missing OCP binding."""
    return f"{capability} is not supported with this OCP build ({exc})"


def _write_iges_ocaf(
    shape: object,
    iges_path: Path,
    solid_names: list[str | None] | None,
    face_colors: list[tuple[float, float, float] | None] | None,
) -> None:
    """Write ``shape`` to IGES with per-solid names and face colors.

    Same OCAF stack pattern as :func:`_write_step_ocaf`: one free product
    label per explorer-order solid (never fused), each carrying its label as
    the product name plus a surface color. Raises on failure so the caller
    can fall back to the plain writer.
    """
    try:
        from OCP.IGESCAFControl import IGESCAFControl_Writer
        from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("IGES export", exc))

    solids = _solids_in_explorer_order(shape)
    if not solids:
        raise RuntimeError("OCAF IGES export found no solids")

    doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for i, solid in enumerate(solids):
        label = shape_tool.NewShape()
        shape_tool.SetShape(label, solid)
        name = solid_names[i] if solid_names is not None and i < len(solid_names) else None
        color: tuple[float, float, float] | None = None
        if face_colors is not None and i < len(face_colors):
            color = face_colors[i]
        if name:
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(str(name)))
            if color is None:
                color = _label_color(str(name))
        if color is not None:
            quantity = Quantity_Color(
                float(color[0]), float(color[1]), float(color[2]), Quantity_TOC_RGB
            )
            color_tool.SetColor(label, quantity, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    writer = IGESCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(doc):
        raise RuntimeError("OCAF IGES transfer failed")
    if not writer.Write(str(iges_path)):
        raise RuntimeError(f"OCAF IGES writer failed for {iges_path}")


def _write_iges(
    shape: object,
    iges_path: Path,
    solid_names: list[str | None] | None = None,
    face_colors: list[tuple[float, float, float] | None] | None = None,
) -> str | None:
    """Write ``shape`` to an IGES file using OCP.

    With per-solid ``solid_names``/``face_colors`` the OCAF writer is used so
    labels survive as product names (plus face colors); without them the
    legacy ``IGESControl`` writer runs verbatim. Returns a warning string when
    the OCAF path fell back to the legacy writer (names dropped), else None.
    """
    wants_fidelity = bool(solid_names and any(solid_names)) or bool(
        face_colors and any(face_colors)
    )
    if wants_fidelity:
        try:
            _write_iges_ocaf(shape, iges_path, solid_names, face_colors)
            return None
        except Exception as exc:
            _print_progress(f"OCAF IGES export failed ({exc}); falling back to plain writer")

    try:
        from OCP.IGESControl import IGESControl_Writer
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("IGES export", exc))

    writer = IGESControl_Writer()
    if not writer.AddShape(shape):
        raise RuntimeError(f"IGES writer rejected the shape for {iges_path}")
    if not writer.Write(str(iges_path)):
        raise RuntimeError(f"IGES writer failed for {iges_path}")
    if wants_fidelity:
        return "IGES product names were dropped (plain IGES writer fallback)"
    return None


def _sew_faces_to_solids(shape: object) -> object:
    """Sew loose IGES faces into closed shells and rebuild solids from them.

    IGES is a surface format: readers deliver unsewn faces, so the exchange
    pipeline (which works per-solid) would see an empty model. Sewing plus
    one ``BRepBuilderAPI_MakeSolid`` per shell restores the solids without
    any boolean fuse. Returns a compound of the rebuilt solids, or the sewed
    shape unchanged when no closed shell is found (open sheets stay faces).
    """
    try:
        from OCP.BRep import BRep_Builder
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
        from OCP.TopAbs import TopAbs_SHELL
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS, TopoDS_Compound
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("IGES import", exc))

    sewing = BRepBuilderAPI_Sewing()
    sewing.Add(shape)
    sewing.Perform()
    sewed = sewing.SewedShape()

    shell_downcast = getattr(TopoDS, "Shell_s", None) or TopoDS.Shell
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    made = 0
    exp = TopExp_Explorer(sewed, TopAbs_SHELL)
    while exp.More():
        maker = BRepBuilderAPI_MakeSolid()
        maker.Add(shell_downcast(exp.Current()))
        if maker.IsDone():
            solid = maker.Solid()
            if not solid.IsNull():
                builder.Add(compound, solid)
                made += 1
        exp.Next()
    return compound if made > 0 else sewed


def _read_iges(iges_path: Path) -> object:
    """Read an IGES file into an OCP ``TopoDS_Shape``."""
    try:
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.IGESControl import IGESControl_Reader
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("IGES import", exc))

    reader = IGESControl_Reader()
    status = reader.ReadFile(str(iges_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"IGES reader returned status {status} for {iges_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None:
        raise RuntimeError(f"No shape transferred from {iges_path}")
    if not _solids_in_explorer_order(shape):
        shape = _sew_faces_to_solids(shape)
    return shape


def _xcaf_free_shape_names(doc_main: object, solid_count: int) -> dict[int, str]:
    """Map free product labels of an XCAF document onto explorer-order solids.

    Shared walk for the IGESCAF reader (the STEP reader keeps its own inline
    copy): labels in file order map onto consecutive 1-based solid indices.
    Returns {} whenever the label/solid counts do not line up. Never raises.
    """
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_LabelSequence
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc_main)
    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)

    names: dict[int, str] = {}
    next_index = 1
    total = 0
    for i in range(1, free_shapes.Length() + 1):
        label = free_shapes.Value(i)
        product = shape_tool.GetShape_s(label)
        count = len(_solids_in_explorer_order(product))
        if count == 0:
            # IGES products arrive as loose faces; sew them the same way the
            # reader does so per-label solid counts line up.
            try:
                count = len(_solids_in_explorer_order(_sew_faces_to_solids(product)))
            except Exception:
                count = 0
        name_attr = TDataStd_Name()
        name: str | None = None
        if label.FindAttribute(TDataStd_Name.GetID_s(), name_attr):
            try:
                candidate = name_attr.Get().ToExtString()
                if candidate:
                    name = candidate
            except Exception:
                name = None
        for _ in range(count):
            if name:
                names[next_index] = name
            next_index += 1
        total += count

    if total != solid_count:
        return {}
    return names


def _read_iges_names(iges_path: Path, solid_count: int) -> dict[int, str]:
    """Best-effort per-solid IGES product names keyed by 1-based solid index.

    Same OCAF stack pattern as :func:`_read_step_names`. Returns {} whenever
    OCAF is unavailable, the file carries no names, or the label/solid counts
    do not line up. Never raises.
    """
    try:
        from OCP.IGESCAFControl import IGESCAFControl_Reader
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDocStd import TDocStd_Document

        reader = IGESCAFControl_Reader()
        reader.SetNameMode(True)
        reader.SetColorMode(True)
        if reader.ReadFile(str(iges_path)) != 1:
            return {}
        doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad-import"))
        if not reader.Transfer(doc):
            return {}
        return _xcaf_free_shape_names(doc.Main(), solid_count)
    except Exception:
        return {}


def import_iges_file(
    iges_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = False,
    add_graveyard: bool = True,
    export_mesh: bool = False,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    length_scale: float = 1.0,
    merge: bool = False,
    expand_compound: bool = True,
    one_object_per_solid: bool = True,
) -> dict:
    """Import an existing IGES file and write canonical artifacts.

    Same contract as :func:`import_step_file`: ``merge`` is False by default
    (imported solids are never fused), compounds are always expanded, and the
    pipeline always yields one object per solid for DAGMC. IGES product names
    written by :func:`_write_iges` are restored into the returned
    ``selectorMap`` (best-effort; missing names simply stay absent).

    IGES imports skip DAGMC/mesh export by default (opt in explicitly).
    Returns the stdout-JSON result dict.
    """
    if not expand_compound or not one_object_per_solid:
        raise ValueError(
            "nuke-cad IGES import always expands compounds to one object per solid "
            "(required by the DAGMC pipeline); expand_compound=False / "
            "one_object_per_solid=False are not supported"
        )
    iges_file = Path(iges_path).resolve()
    if not iges_file.exists():
        return {"success": False, "error": f"IGES file not found: {iges_path}"}

    if output_dir is None:
        output_dir = iges_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Reading IGES: {iges_file}")
    try:
        shape = _read_iges(iges_file)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read IGES file: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(iges_file),
        }

    warnings: list[str] = []
    if merge:
        try:
            shape = _fuse_solids(shape)
        except Exception as exc:
            warnings.append(f"IGES merge requested but the fuse failed; kept unfused solids: {exc}")

    selector_map: dict[str, list[int]] = {}
    try:
        solid_count = len(_solids_in_explorer_order(shape))
        for index, name in _read_iges_names(iges_file, solid_count).items():
            selector_map.setdefault(name, [])
            if index not in selector_map[name]:
                selector_map[name].append(index)
                selector_map[name].sort()
    except Exception:
        selector_map = {}

    result = _process_shape(
        shape,
        iges_file,
        out_dir,
        iges_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map=selector_map,
        manifest=None,
        length_scale=length_scale,
    )
    if warnings:
        result["warnings"] = (result.get("warnings") or []) + warnings
    return result


def _write_brep(shape: object, brep_path: Path) -> None:
    """Write ``shape`` to a native BREP file (lossless round-trip)."""
    try:
        from OCP.BRepTools import BRepTools
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("BREP export", exc))
    if not brep_tools_write(BRepTools, shape, str(brep_path)):
        raise RuntimeError(f"BREP writer failed for {brep_path}")


def _read_brep(brep_path: Path) -> object:
    """Read a native BREP file into an OCP ``TopoDS_Shape``."""
    try:
        from OCP.BRep import BRep_Builder
        from OCP.BRepTools import BRepTools
        from OCP.TopoDS import TopoDS_Shape
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("BREP import", exc))
    shape = TopoDS_Shape()
    builder = BRep_Builder()
    if not brep_tools_read(BRepTools, shape, builder, str(brep_path)):
        raise RuntimeError(f"BREP reader failed for {brep_path}")
    return shape


def import_brep_file(
    brep_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = False,
    add_graveyard: bool = True,
    export_mesh: bool = False,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    length_scale: float = 1.0,
    merge: bool = False,
    expand_compound: bool = True,
    one_object_per_solid: bool = True,
) -> dict:
    """Import an existing BREP file and write canonical artifacts.

    Same contract as :func:`import_step_file` except names: the native BREP
    format carries no product names, so the returned ``selectorMap`` is always
    empty. ``merge`` is False by default; compounds are always expanded to one
    object per solid for DAGMC. BREP imports skip DAGMC/mesh export by default
    (opt in explicitly). Returns the stdout-JSON result dict.
    """
    if not expand_compound or not one_object_per_solid:
        raise ValueError(
            "nuke-cad BREP import always expands compounds to one object per solid "
            "(required by the DAGMC pipeline); expand_compound=False / "
            "one_object_per_solid=False are not supported"
        )
    brep_file = Path(brep_path).resolve()
    if not brep_file.exists():
        return {"success": False, "error": f"BREP file not found: {brep_path}"}

    if output_dir is None:
        output_dir = brep_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Reading BREP: {brep_file}")
    try:
        shape = _read_brep(brep_file)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read BREP file: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(brep_file),
        }

    warnings: list[str] = []
    if merge:
        try:
            shape = _fuse_solids(shape)
        except Exception as exc:
            warnings.append(f"BREP merge requested but the fuse failed; kept unfused solids: {exc}")

    result = _process_shape(
        shape,
        brep_file,
        out_dir,
        brep_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map={},
        manifest=None,
        length_scale=length_scale,
    )
    if warnings:
        result["warnings"] = (result.get("warnings") or []) + warnings
    return result


def _write_gltf(
    shape: object,
    gltf_path: Path,
    solid_names: list[str | None] | None = None,
    face_colors: list[tuple[float, float, float] | None] | None = None,
    tolerance: float = 0.001,
    binary: bool | None = None,
) -> None:
    """Write ``shape`` to glTF (.gltf JSON or .glb binary) using OCP.

    glTF is a mesh+color exchange format: the shape is tessellated with the
    same ``BRepMesh_IncrementalMesh`` settings as :func:`_tessellate_shape`
    (no new mesher), then written from an XCAF document carrying one labeled,
    optionally named and surface-colored product per explorer-order solid.
    ``binary`` defaults to True for a ``.glb`` suffix, False otherwise.
    """
    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.Message import Message_ProgressRange
        from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
        from OCP.RWGltf import RWGltf_CafWriter
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TColStd import TColStd_IndexedDataMapOfStringString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("glTF export", exc))
    if not hasattr(RWGltf_CafWriter, "Perform"):
        raise RuntimeError(_unsupported_ocp_error("glTF export", ImportError("RWGltf_CafWriter")))

    if binary is None:
        binary = gltf_path.suffix.lower() == ".glb"

    solids = _solids_in_explorer_order(shape)
    if not solids:
        raise RuntimeError("glTF export found no solids")

    # Triangulation data must be precomputed within the shapes.
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.5, True)

    doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad"))
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for i, solid in enumerate(solids):
        label = shape_tool.NewShape()
        shape_tool.SetShape(label, solid)
        name = solid_names[i] if solid_names is not None and i < len(solid_names) else None
        color: tuple[float, float, float] | None = None
        if face_colors is not None and i < len(face_colors):
            color = face_colors[i]
        if name:
            TDataStd_Name.Set_s(label, TCollection_ExtendedString(str(name)))
            if color is None:
                color = _label_color(str(name))
        if color is not None:
            quantity = Quantity_Color(
                float(color[0]), float(color[1]), float(color[2]), Quantity_TOC_RGB
            )
            color_tool.SetColor(label, quantity, XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    writer = RWGltf_CafWriter(TCollection_AsciiString(str(gltf_path)), bool(binary))
    if not writer.Perform(doc, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise RuntimeError(f"glTF writer failed for {gltf_path}")


def _read_gltf(gltf_path: Path) -> object:
    """Read a glTF file into an OCP ``TopoDS_Shape``.

    Always raises today (partial-landing rule): the shipped OCP's
    ``RWGltf_CafReader`` exposes no document read API, so glTF is write-only
    here. The error states that plainly instead of failing silently.
    """
    try:
        from OCP.RWGltf import RWGltf_CafReader
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("glTF import", exc))
    readable = any(
        hasattr(RWGltf_CafReader, name)
        for name in ("ReadFile", "ReadStream", "Perform", "Transfer", "Document")
    )
    if not readable:
        raise RuntimeError(
            "glTF import is not supported with this OCP build "
            "(RWGltf_CafReader exposes no document read API)"
        )
    raise RuntimeError(
        "glTF import is not supported with this OCP build "
        "(no reader implementation for the available RWGltf API)"
    )


def import_gltf_file(
    gltf_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
) -> dict:
    """Import an existing glTF file and write canonical artifacts.

    Always returns a structured not-supported error today (see
    :func:`_read_gltf`); the entry point exists so callers and error-path
    tests share one contract once an OCP reader API lands.
    """
    gltf_file = Path(gltf_path).resolve()
    if not gltf_file.exists():
        return {"success": False, "error": f"glTF file not found: {gltf_path}"}

    if output_dir is None:
        output_dir = gltf_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Reading glTF: {gltf_file}")
    try:
        shape = _read_gltf(gltf_file)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read glTF file: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(gltf_file),
        }

    return _process_shape(
        shape,
        gltf_file,
        out_dir,
        gltf_file.stem,
        tolerance=tolerance,
        export_dagmc=False,
        export_mesh=False,
        selector_map={},
        manifest=None,
    )


def _require_stl_modules() -> tuple:
    """Import the STL writer binding pair or raise the not-supported error."""
    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.StlAPI import StlAPI_Writer
    except ImportError as exc:
        raise RuntimeError(_unsupported_ocp_error("STL export", exc))
    return BRepMesh_IncrementalMesh, StlAPI_Writer


def _write_stl(
    shape: object,
    stl_path: Path,
    tolerance: float = 0.001,
    binary: bool = True,
) -> None:
    """Write ``shape`` facets to an STL file using OCP.

    Exact-facet export through the existing tessellation route: the shape is
    meshed with the same ``BRepMesh_IncrementalMesh`` settings as
    :func:`_tessellate_shape` (no new mesher), so the STL facet count matches
    the viewport tessellation triangle count at the same tolerance.
    """
    BRepMesh_IncrementalMesh, StlAPI_Writer = _require_stl_modules()

    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.5, True)
    writer = StlAPI_Writer()
    writer.ASCIIMode = not binary
    if not writer.Write(shape, str(stl_path)):
        raise RuntimeError(f"STL writer failed for {stl_path}")


def export_stl_file(
    source_path: str,
    output_path: str | None = None,
    tolerance: float = 0.001,
    binary: bool = True,
) -> dict:
    """Export the exact facets of a CAD file (STEP/IGES/BREP) to STL.

    The source format is dispatched by file extension; the facets come from
    :func:`_write_stl`, i.e. the tessellation route, not a new mesher.
    Returns the stdout-JSON result dict with ``stlPath`` on success.
    """
    source_file = Path(source_path).resolve()
    if not source_file.exists():
        return {"success": False, "error": f"CAD file not found: {source_path}"}

    stl_path = (
        Path(output_path).resolve() if output_path is not None else source_file.with_suffix(".stl")
    )
    suffix = source_file.suffix.lower()
    if suffix not in (".step", ".stp", ".iges", ".igs", ".brep"):
        return {
            "success": False,
            "error": (
                f"Unsupported exchange extension '{source_file.suffix}': "
                "STL export accepts .step/.stp, .iges/.igs, and .brep"
            ),
            "sourcePath": str(source_file),
        }
    try:
        # Capability probe before any reader so a missing binding reports the
        # not-supported error instead of a misleading reader failure.
        _require_stl_modules()
        if suffix in (".step", ".stp"):
            shape = _read_step(source_file)
        elif suffix in (".iges", ".igs"):
            shape = _read_iges(source_file)
        else:
            shape = _read_brep(source_file)
        _print_progress(f"Writing STL: {stl_path}")
        _write_stl(shape, stl_path, tolerance=tolerance, binary=binary)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to export STL: {exc}",
            "traceback": traceback.format_exc(),
            "sourcePath": str(source_file),
        }
    return {"success": True, "sourcePath": str(source_file), "stlPath": str(stl_path)}


def _fuse_solids(shape: object) -> object:
    """Fuse every explorer-order solid of ``shape`` into one (``merge=true``).

    Raises on failure; callers fall back to the unfused shape with a warning.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

    solids = _solids_in_explorer_order(shape)
    if len(solids) < 2:
        return shape
    fused: object = solids[0]
    for other in solids[1:]:
        operation = BRepAlgoAPI_Fuse(fused, other)
        operation.Build()
        if not operation.IsDone():
            raise RuntimeError("BRepAlgoAPI_Fuse failed")
        fused = operation.Shape()
    return fused


def _tessellate_shape(
    shape: object, tolerance: float, body_ids: list[str] | None = None
) -> list[dict]:
    """Tessellate ``shape`` and return per-solid face and edge buffers.

    Each face entry includes a geometric ``fingerprint`` (surface type, area,
    centroid, normal/axis/radius) when OCP is available. Each edge entry
    carries a polyline approximation and an edge fingerprint for viewport
    edge picking.

    When ``body_ids`` is provided (document builds), each solid entry also
    carries the ``bodyId`` of the body that produced it, enabling viewport
    picking to bind face/edge picks to the owning body's current tip feature.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    _print_progress(f"Tessellating with tolerance {tolerance}")
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.5, True)

    solids: list[dict] = []
    solid_id = 1
    solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while solid_exp.More():
        solid = topods_solid(TopoDS, solid_exp.Current())
        body_id = (
            body_ids[solid_id - 1]
            if body_ids is not None and solid_id - 1 < len(body_ids)
            else None
        )

        faces: list[dict] = []
        face_id = 1
        face_exp = TopExp_Explorer(solid, TopAbs_FACE)
        while face_exp.More():
            face = topods_face(TopoDS, face_exp.Current())
            loc = face.Location()
            tri = brep_tool_triangulation(BRep_Tool, face, loc)
            if tri is None or tri.NbTriangles() == 0:
                face_id += 1
                face_exp.Next()
                continue

            trsf = loc.Transformation()
            nodes: list[list[float]] = []
            for i in range(1, tri.NbNodes() + 1):
                pnt = tri.Node(i)
                pnt.Transform(trsf)
                nodes.append([pnt.X(), pnt.Y(), pnt.Z()])

            triangles: list[list[int]] = []
            for i in range(1, tri.NbTriangles() + 1):
                t = tri.Triangle(i)
                triangles.append([t.Value(1) - 1, t.Value(2) - 1, t.Value(3) - 1])

            face_entry: dict[str, Any] = {
                "faceId": face_id,
                "nodes": nodes,
                "triangles": triangles,
                "hash": hash(face.TShape().__hash__()),
            }
            if HAS_REFERENCE_RESOLVER and reference_resolver is not None:
                fp = reference_resolver._extract_face_fingerprint(face)
                if fp is not None:
                    face_entry["fingerprint"] = _face_fingerprint_to_json(fp)

            faces.append(face_entry)
            face_id += 1
            face_exp.Next()

        edges: list[dict] = []
        edge_id = 1
        edge_exp = TopExp_Explorer(solid, TopAbs_EDGE)
        while edge_exp.More():
            edge = TopoDS.Edge_s(edge_exp.Current())
            curve = BRepAdaptor_Curve(edge)
            try:
                qf = GCPnts_QuasiUniformDeflection(curve, tolerance)
            except Exception:
                edge_exp.Next()
                continue
            if not qf.IsDone() or qf.NbPoints() < 2:
                edge_exp.Next()
                continue
            points: list[list[float]] = []
            for i in range(1, qf.NbPoints() + 1):
                pnt = qf.Value(i)
                points.append([pnt.X(), pnt.Y(), pnt.Z()])
            if len(points) < 2:
                edge_exp.Next()
                continue
            edge_entry: dict[str, Any] = {
                "edgeId": edge_id,
                "points": points,
            }
            if body_id is not None:
                edge_entry["bodyId"] = body_id
            if HAS_REFERENCE_RESOLVER and reference_resolver is not None:
                fp = reference_resolver._extract_edge_fingerprint(edge)
                if fp is not None:
                    edge_entry["fingerprint"] = _edge_fingerprint_to_json(fp)
            edges.append(edge_entry)
            edge_id += 1
            edge_exp.Next()

        solid_entry: dict[str, Any] = {"solidId": solid_id, "faces": faces, "edges": edges}
        if body_id is not None:
            solid_entry["bodyId"] = body_id
        try:
            solid_entry["properties"] = _solid_properties(solid)
        except Exception:
            pass
        solids.append(solid_entry)
        solid_id += 1
        solid_exp.Next()

    return solids


def _face_fingerprint_to_json(fp: dict[str, Any]) -> dict[str, Any]:
    """Convert a snake_case face fingerprint dict to the TS contract shape."""
    data: dict[str, Any] = {
        "surfaceType": fp["surface_type"],
        "area": fp["area"],
        "center": fp["center"],
    }
    if fp.get("normal") is not None:
        data["normal"] = fp["normal"]
    if fp.get("axis") is not None:
        data["axis"] = fp["axis"]
    if fp.get("radius") is not None:
        data["radius"] = fp["radius"]
    if fp.get("minor_radius") is not None:
        data["minorRadius"] = fp["minor_radius"]
    return data


def _edge_fingerprint_to_json(fp: dict[str, Any]) -> dict[str, Any]:
    """Convert a snake_case edge fingerprint dict to the TS contract shape."""
    data: dict[str, Any] = {
        "curveType": fp["curve_type"],
        "length": fp["length"],
        "start": fp["start"],
        "end": fp["end"],
    }
    if fp.get("center") is not None:
        data["center"] = fp["center"]
    return data


def _bounding_box(shape: object) -> dict[str, list[float]]:
    """Return the axis-aligned bounding box of ``shape`` in model units."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    brep_bnd_lib_add(BRepBndLib, shape, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    return {"min": [xmin, ymin, zmin], "max": [xmax, ymax, zmax]}


def _solid_properties(solid: object) -> dict[str, Any]:
    """Return selection-panel mass properties (volume, area, bbox, center of mass)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    volume_props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, volume_props)
    surface_props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(solid, surface_props)

    box = Bnd_Box()
    box.SetGap(0.0)
    brep_bnd_lib_add(BRepBndLib, solid, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()

    com = volume_props.CentreOfMass()
    return {
        "volume": float(volume_props.Mass()),
        "area": float(surface_props.Mass()),
        "bbox": {
            "min": [float(xmin), float(ymin), float(zmin)],
            "max": [float(xmax), float(ymax), float(zmax)],
        },
        "centerOfMass": [float(com.X()), float(com.Y()), float(com.Z())],
    }


def _load_manifest(script_path: Path) -> tuple[RegionManifest | None, list[str]]:
    """Load and validate the sidecar region manifest if it exists."""
    manifest_path = script_path.with_suffix(".regions.json")
    if not manifest_path.exists():
        return None, []

    warnings: list[str] = []
    try:
        manifest = RegionManifest.from_file(manifest_path)
        return manifest, warnings
    except ManifestValidationError as exc:
        warnings.append(f"Invalid region manifest: {exc}")
        return None, warnings


def _artifact_paths(out_dir: Path, stem: str) -> dict[str, Path]:
    """Return canonical artifact paths for a given output directory and stem."""
    return {
        "step": out_dir / f"{stem}.step",
        "tess": out_dir / f"{stem}.tess.json",
        "h5m": out_dir / f"{stem}.h5m",
        "msh": out_dir / f"{stem}.msh",
        "exodus": out_dir / f"{stem}.e",
        "inp": out_dir / f"{stem}.inp",
        "vtk": out_dir / f"{stem}.vtk",
        "mesh_report": out_dir / f"{stem}.mesh.report.json",
    }


def _curve_bounding_box(points: list[list[float]]) -> dict[str, list[float]]:
    """Return the axis-aligned bounding box of a point list."""
    if not points:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    return {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}


def _merge_bounding_boxes(
    a: dict[str, list[float]], b: dict[str, list[float]]
) -> dict[str, list[float]]:
    return {
        "min": [min(a["min"][i], b["min"][i]) for i in range(3)],
        "max": [max(a["max"][i], b["max"][i]) for i in range(3)],
    }


def _curve_tess_entry(curve_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Build the frontend tessellation entry for a single curve."""
    return {
        "id": curve_id,
        "name": result.get("name", curve_id),
        "points": result["points"],
        "closed": result["closed"],
    }


def _process_shape(
    shape: object | None,
    source_file: Path,
    out_dir: Path,
    stem: str,
    tolerance: float = 0.001,
    export_dagmc: bool = True,
    add_graveyard: bool = True,
    export_mesh: bool = True,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    selector_map: dict[str, list[int]] | None = None,
    manifest: RegionManifest | None = None,
    length_scale: float = 1.0,
    body_ids: list[str] | None = None,
    curve_results: dict[str, dict[str, Any]] | None = None,
) -> dict:
    """Tessellate ``shape`` and write canonical artifacts.

    This is the shared backend of both script-based builds and STEP imports.
    Returns the stdout-JSON result dict. When ``shape`` is ``None`` and
    ``curve_results`` is provided, only the curve tessellation is produced.
    """
    selector_map = selector_map or {}
    curve_results = curve_results or {}
    paths = _artifact_paths(out_dir, stem)
    has_solids = shape is not None

    result: dict = {
        "success": False,
        "scriptPath": str(source_file),
        "outputDirectory": str(out_dir),
        "stepPath": str(paths["step"]),
        "tessPath": str(paths["tess"]),
        "dagmcPath": str(paths["h5m"]),
        "dagmcSuccess": False,
        "dagmcWarnings": [],
        "dagmcError": None,
        "meshPath": str(paths["msh"]),
        "exodusPath": str(paths["exodus"]),
        "inpPath": str(paths["inp"]),
        "vtkPath": str(paths["vtk"]),
        "meshReportPath": str(paths["mesh_report"]),
        "meshSuccess": False,
        "meshWarnings": [],
        "meshError": None,
        "meshReport": None,
        "warnings": [],
        "selectorMap": selector_map,
    }

    # ------------------------------------------------------------------
    # 1. Write canonical STEP (skip if it would overwrite the input STEP
    #    or if there is no solid geometry).
    # ------------------------------------------------------------------
    if has_solids:
        try:
            if paths["step"].resolve() == source_file.resolve():
                _print_progress(f"Reusing input STEP: {paths['step']}")
            else:
                _print_progress(f"Writing STEP: {paths['step']}")
                solid_names: list[str | None] | None = None
                try:
                    solid_total = len(_solids_in_explorer_order(shape))
                    solid_names = _solid_names_from_selector_map(selector_map, solid_total)
                except Exception:
                    solid_names = None
                step_warning = _write_step(shape, paths["step"], solid_names=solid_names)
                if step_warning:
                    result["warnings"].append(step_warning)
                if solid_names and any(solid_names):
                    result["stepNames"] = {
                        str(i + 1): name for i, name in enumerate(solid_names) if name
                    }
        except Exception as exc:
            result["error"] = str(exc)
            result["traceback"] = traceback.format_exc()
            return result

    # ------------------------------------------------------------------
    # 2. Tessellate and write viewport stream.
    # ------------------------------------------------------------------
    solids: list[dict] = []
    if has_solids:
        _print_progress("Tessellating B-rep")
        try:
            solids = _tessellate_shape(shape, tolerance, body_ids=body_ids)
        except Exception as exc:
            result["error"] = f"Tessellation failed: {exc}"
            result["traceback"] = traceback.format_exc()
            return result

    bbox: dict[str, list[float]] | None = None
    if has_solids:
        bbox = _bounding_box(shape)
    for _curve_id, curve_result in curve_results.items():
        curve_bbox = _curve_bounding_box(curve_result["points"])
        bbox = curve_bbox if bbox is None else _merge_bounding_boxes(bbox, curve_bbox)
    if bbox is None:
        bbox = {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}

    total_triangles = sum(len(face["triangles"]) for solid in solids for face in solid["faces"])
    total_faces = sum(len(solid["faces"]) for solid in solids)

    tess_data: dict[str, Any] = {
        "version": 1,
        "tolerance": tolerance,
        "boundingBox": bbox,
        "solids": solids,
    }
    if curve_results:
        tess_data["curves"] = [
            _curve_tess_entry(curve_id, curve_result)
            for curve_id, curve_result in curve_results.items()
        ]
    try:
        paths["tess"].write_text(json.dumps(tess_data), encoding="utf-8")
    except Exception as exc:
        result["error"] = f"Failed to write tessellation stream: {exc}"
        return result

    # ------------------------------------------------------------------
    # 3. Apply region manifest (script builds only; STEP has no selectors).
    # ------------------------------------------------------------------
    if manifest is not None:
        unknown = manifest.unknown_selectors(set(selector_map.keys()))
        if unknown:
            result["warnings"].append(
                f"Region manifest references unknown selectors: {', '.join(unknown)}"
            )
        result["regionManifest"] = manifest.to_dict()
        result["selectorMap"] = selector_map

    # ------------------------------------------------------------------
    # 4. Export DAGMC .h5m.
    # ------------------------------------------------------------------
    if export_dagmc and has_solids:
        _print_progress(f"Exporting DAGMC: {paths['h5m']}")
        try:
            if HAS_DAGMC_EXPORT and dagmc_export is not None:
                dagmc_result = dagmc_export.convert_to_dagmc(
                    str(paths["step"]),
                    output_path=str(paths["h5m"]),
                    manifest=manifest,
                    selector_map=selector_map,
                    faceting_tolerance=tolerance,
                    length_scale=length_scale,
                    add_graveyard=add_graveyard,
                )
                result["dagmcSuccess"] = dagmc_result.get("success", False)
                result["dagmcWarnings"] = dagmc_result.get("warnings", [])
                result["dagmcError"] = dagmc_result.get("error")
                if dagmc_result.get("warnings"):
                    result["warnings"].extend(dagmc_result["warnings"])
            else:
                result["dagmcError"] = "DAGMC export module is unavailable"
        except Exception as exc:
            result["dagmcError"] = str(exc)
            result["dagmcWarnings"].append(traceback.format_exc())
            result["warnings"].append(f"DAGMC export skipped: {exc}")

    # ------------------------------------------------------------------
    # 5. Export FEM volume mesh.
    # ------------------------------------------------------------------
    if export_mesh and has_solids:
        _print_progress(f"Exporting FEM mesh: {paths['msh']}")
        try:
            if HAS_MESH_SERVICE and mesh_service is not None:
                mesh_result = mesh_service.mesh_step(
                    str(paths["step"]),
                    output_dir=str(out_dir),
                    output_stem=stem,
                    manifest=manifest,
                    selector_map=selector_map,
                    engine=mesh_engine,
                    mesh_size=mesh_size,
                    min_size=mesh_min_size,
                    max_size=mesh_max_size,
                    order=mesh_order,
                )
                result["meshSuccess"] = mesh_result.get("success", False)
                result["meshWarnings"] = mesh_result.get("warnings", [])
                result["meshError"] = mesh_result.get("error")
                result["meshReport"] = mesh_result.get("report")
                if mesh_result.get("warnings"):
                    result["warnings"].extend(mesh_result["warnings"])
            else:
                result["meshError"] = "Meshing service module is unavailable"
        except Exception as exc:
            result["meshError"] = str(exc)
            result["meshWarnings"].append(traceback.format_exc())
            result["warnings"].append(f"FEM mesh export skipped: {exc}")

    result.update(
        {
            "success": True,
            "solidCount": len(solids),
            "faceCount": total_faces,
            "triangleCount": total_triangles,
            "boundingBox": bbox,
        }
    )
    _print_progress(f"Done: {len(solids)} solids, {total_faces} faces, {total_triangles} triangles")
    return result


def build_geometry(
    script_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = True,
    add_graveyard: bool = True,
    export_mesh: bool = True,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    script_timeout: float = DEFAULT_SCRIPT_TIMEOUT,
    length_scale: float = 1.0,
) -> dict:
    """Execute ``script_path`` and write canonical artifacts.

    The user script runs in an isolated child process (timeout enforced,
    stdout/stderr captured); ``sys.exit`` or a crash in the script is reported
    as a normal error result. Returns the stdout-JSON result dict.
    """
    script_file = Path(script_path).resolve()
    if not script_file.exists():
        return {"success": False, "error": f"Script not found: {script_path}"}

    if output_dir is None:
        output_dir = script_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Execute the user script in a child process and read back the model.
    # ------------------------------------------------------------------
    _print_progress(f"Executing script: {script_file}")
    shape, selector_map, error = _execute_script_isolated(script_file, timeout=script_timeout)
    if error is not None:
        return error

    # ------------------------------------------------------------------
    # 2. Load manifest and process shape.
    # ------------------------------------------------------------------
    manifest, manifest_warnings = _load_manifest(script_file)
    result = _process_shape(
        shape,
        script_file,
        out_dir,
        script_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map=selector_map,
        manifest=manifest,
        length_scale=length_scale,
    )
    result["warnings"] = (result.get("warnings") or []) + manifest_warnings
    return result


def import_step_file(
    step_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = False,
    add_graveyard: bool = True,
    export_mesh: bool = False,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    length_scale: float = 1.0,
    merge: bool = False,
    expand_compound: bool = True,
    one_object_per_solid: bool = True,
) -> dict:
    """Import an existing STEP file and write canonical artifacts.

    Import-flag parity with the FreeCAD AppImportPy pattern: ``merge`` is
    False by default (imported solids are never fused), compounds are always
    expanded, and the pipeline always yields one object per solid for DAGMC.
    STEP product names written by :func:`_write_step` are restored into the
    returned ``selectorMap`` (best-effort; missing names simply stay absent).

    STEP imports skip DAGMC/mesh export by default (opt in explicitly);
    script builds keep them on by default. Returns the stdout-JSON result dict.
    """
    if not expand_compound or not one_object_per_solid:
        raise ValueError(
            "nuke-cad STEP import always expands compounds to one object per solid "
            "(required by the DAGMC pipeline); expand_compound=False / "
            "one_object_per_solid=False are not supported"
        )
    step_file = Path(step_path).resolve()
    if not step_file.exists():
        return {"success": False, "error": f"STEP file not found: {step_path}"}

    if output_dir is None:
        output_dir = step_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Reading STEP: {step_file}")
    try:
        shape = _read_step(step_file)
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read STEP file: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(step_file),
        }

    warnings: list[str] = []
    if merge:
        try:
            shape = _fuse_solids(shape)
        except Exception as exc:
            warnings.append(f"STEP merge requested but the fuse failed; kept unfused solids: {exc}")

    selector_map: dict[str, list[int]] = {}
    try:
        solid_count = len(_solids_in_explorer_order(shape))
        for index, name in _read_step_names(step_file, solid_count).items():
            selector_map.setdefault(name, [])
            if index not in selector_map[name]:
                selector_map[name].append(index)
                selector_map[name].sort()
    except Exception:
        selector_map = {}

    result = _process_shape(
        shape,
        step_file,
        out_dir,
        step_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map=selector_map,
        manifest=None,
        length_scale=length_scale,
    )
    if warnings:
        result["warnings"] = (result.get("warnings") or []) + warnings
    return result


def _migrate_v1_to_v2(document: dict[str, Any]) -> dict[str, Any]:
    """Migrate a v1 ``.nuke-cad`` document to v2 in memory.

    Mirrors the TypeScript migration: every pad/revolve becomes its own body,
    pockets/grooves target the nearest preceding additive body, and feature-level
    labels move to bodies. The original document dict is not modified.
    """
    features = [dict(f) for f in document.get("features", []) if isinstance(f, dict)]
    bodies: list[dict[str, Any]] = []
    body_id_for_feature: dict[str, str] = {}

    solid_creators = {"pad", "revolve"}
    solid_modifiers = {"pocket", "groove"}

    for feature in features:
        if feature.get("type") not in solid_creators:
            continue
        body_id = f"body-{feature['id']}"
        label = feature.pop("label", None)
        bodies.append(
            {
                "id": body_id,
                "name": feature.get("name", feature["id"]),
                "label": label if isinstance(label, str) and label else None,
            }
        )
        body_id_for_feature[feature["id"]] = body_id

    for feature in features:
        if feature.get("type") not in solid_modifiers:
            continue
        feature.pop("label", None)
        body_id: str | None = None
        for dep in feature.get("dependsOn", []):
            if dep in body_id_for_feature:
                body_id = body_id_for_feature[dep]
                break
        if body_id is None:
            index = next((i for i, f in enumerate(features) if f.get("id") == feature["id"]), -1)
            for i in range(index - 1, -1, -1):
                preceding = features[i]
                if (
                    preceding.get("type") in solid_creators
                    and preceding["id"] in body_id_for_feature
                ):
                    body_id = body_id_for_feature[preceding["id"]]
                    break
        feature["body"] = body_id or "body-default"

    for feature in features:
        if feature.get("type") in solid_creators:
            feature["body"] = body_id_for_feature[feature["id"]]
        if "body" not in feature:
            feature["body"] = "body-default"

    if any(f.get("body") == "body-default" for f in features) and not any(
        b["id"] == "body-default" for b in bodies
    ):
        bodies.append({"id": "body-default", "name": "Default Body"})

    migrated = dict(document)
    migrated["version"] = 2
    migrated["bodies"] = bodies
    migrated["features"] = features
    return migrated


def _migrate_v2_to_v3(document: dict[str, Any]) -> dict[str, Any]:
    """Migrate a v2 ``.nuke-cad` document to v3 in memory.

    Mirrors the TypeScript migration: adds an empty ``curves`` array.
    The original document dict is not modified.
    """
    migrated = dict(document)
    migrated["version"] = 3
    migrated["curves"] = []
    return migrated


def _validate_document_refs(document: dict[str, Any], source_file: Path) -> dict | None:
    """Light structural validation of a ``.nuke-cad`` document.

    The TypeScript validator is the front gate; this mirrors its supported
    feature set and required-parameter checks so the Python builder fails fast
    with a clear message instead of an unwrapped OCCT traceback.
    """
    datum_ids = {d.get("id") for d in document.get("datums", []) if isinstance(d, dict)}
    body_ids = {b.get("id") for b in document.get("bodies", []) if isinstance(b, dict)}
    sketch_ids = {s.get("id") for s in document.get("sketches", []) if isinstance(s, dict)}
    feature_ids = {f.get("id") for f in document.get("features", []) if isinstance(f, dict)}
    curve_ids = {c.get("id") for c in document.get("curves", []) if isinstance(c, dict)}

    for i, sketch in enumerate(document.get("sketches", [])):
        if not isinstance(sketch, dict):
            continue
        datum_id = sketch.get("datumId")
        if datum_id not in datum_ids:
            return {
                "success": False,
                "error": f"Document references unknown datum '{datum_id}' at sketches[{i}].datumId",
                "scriptPath": str(source_file),
            }

    for i, feature in enumerate(document.get("features", [])):
        if not isinstance(feature, dict):
            continue
        fid = feature.get("id", f"[{i}]")
        feature_type = feature.get("type")
        if feature_type not in (
            "pad",
            "pocket",
            "revolve",
            "groove",
            "sweep",
            "pipe",
            "loft",
            "helicalSweep",
            "fillet",
            "chamfer",
            "draft",
            "shell",
            "linearPattern",
            "circularPattern",
            "mirror",
            "hole",
            "booleanFuse",
            "booleanCut",
            "booleanCommon",
        ):
            return {
                "success": False,
                "error": (f"Feature '{fid}' has unsupported type '{feature_type}'"),
                "scriptPath": str(source_file),
            }

        body_id = feature.get("body")
        if not isinstance(body_id, str) or not body_id:
            return {
                "success": False,
                "error": f"Feature '{fid}' requires a body",
                "scriptPath": str(source_file),
            }
        if body_id not in body_ids:
            return {
                "success": False,
                "error": f"Feature '{fid}' references unknown body '{body_id}'",
                "scriptPath": str(source_file),
            }

        if feature_type in ("booleanFuse", "booleanCut", "booleanCommon"):
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            target_body = params.get("targetBody")
            if not isinstance(target_body, str) or not target_body or target_body not in body_ids:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' ({feature_type}) requires a valid targetBody",
                    "scriptPath": str(source_file),
                }
            tool_bodies = params.get("toolBodies")
            if not isinstance(tool_bodies, list) or not tool_bodies:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' ({feature_type}) requires a non-empty toolBodies list",
                    "scriptPath": str(source_file),
                }
            for j, tool in enumerate(tool_bodies):
                if not isinstance(tool, str) or tool not in body_ids:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' references unknown tool body '{tool}' at toolBodies[{j}]",
                        "scriptPath": str(source_file),
                    }
            continue

        if feature_type in ("fillet", "chamfer", "draft", "shell"):
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            if feature_type in ("fillet", "chamfer"):
                edges = params.get("edges")
                if not isinstance(edges, list) or not edges:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' ({feature_type}) requires a non-empty edges list",
                        "scriptPath": str(source_file),
                    }
            else:
                faces = params.get("faces")
                if not isinstance(faces, list) or not faces:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' ({feature_type}) requires a non-empty faces list",
                        "scriptPath": str(source_file),
                    }
            if feature_type == "fillet":
                radius = params.get("radius")
                if (
                    not isinstance(radius, (int, float))
                    or isinstance(radius, bool)
                    or not math.isfinite(radius)
                    or radius <= 0
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (fillet) requires a positive radius",
                        "scriptPath": str(source_file),
                    }
            elif feature_type == "chamfer":
                distance = params.get("distance")
                distances = params.get("distances")
                angle = params.get("angle")
                has_distance = (
                    isinstance(distance, (int, float))
                    and not isinstance(distance, bool)
                    and math.isfinite(distance)
                    and distance > 0
                )
                has_distances = (
                    isinstance(distances, (list, tuple))
                    and len(distances) == 2
                    and all(
                        isinstance(d, (int, float))
                        and not isinstance(d, bool)
                        and math.isfinite(d)
                        and d > 0
                        for d in distances
                    )
                )
                has_angle = (
                    isinstance(angle, (int, float))
                    and not isinstance(angle, bool)
                    and math.isfinite(angle)
                    and 0 < angle < 90
                )
                if not (has_distance or has_distances):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (chamfer) requires distance or distances",
                        "scriptPath": str(source_file),
                    }
                if has_distances and (distance is not None or angle is not None):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (chamfer) distances is mutually exclusive with distance/angle",
                        "scriptPath": str(source_file),
                    }
                if angle is not None and not has_angle:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (chamfer) angle must be in (0, 90) degrees",
                        "scriptPath": str(source_file),
                    }
            elif feature_type == "draft":
                pull_direction = params.get("pullDirection")
                if (
                    not isinstance(pull_direction, (list, tuple))
                    or len(pull_direction) != 3
                    or not all(
                        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                        for v in pull_direction
                    )
                    or (
                        pull_direction[0] == 0 and pull_direction[1] == 0 and pull_direction[2] == 0
                    )
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (draft) requires a non-zero pullDirection [x, y, z]",
                        "scriptPath": str(source_file),
                    }
                angle = params.get("angle")
                if (
                    not isinstance(angle, (int, float))
                    or isinstance(angle, bool)
                    or not math.isfinite(angle)
                    or angle <= -90
                    or angle >= 90
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (draft) requires angle in (-90, 90) degrees",
                        "scriptPath": str(source_file),
                    }
            elif feature_type == "shell":
                thickness = params.get("thickness")
                if (
                    not isinstance(thickness, (int, float))
                    or isinstance(thickness, bool)
                    or not math.isfinite(thickness)
                    or thickness <= 0
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (shell) requires a positive thickness",
                        "scriptPath": str(source_file),
                    }
            continue

        if feature_type in ("linearPattern", "circularPattern", "mirror", "hole"):
            continue

        if feature_type == "loft":
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            section_sketch_ids = params.get("sectionSketchIds")
            if not isinstance(section_sketch_ids, list) or len(section_sketch_ids) < 2:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' (loft) requires at least 2 section sketches",
                    "scriptPath": str(source_file),
                }
            seen_sections: set[str] = set()
            for j, section_id in enumerate(section_sketch_ids):
                if not isinstance(section_id, str) or not section_id:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' section sketch id at sectionSketchIds[{j}] must be a non-empty string",
                        "scriptPath": str(source_file),
                    }
                if section_id in seen_sections:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' references duplicate section sketch '{section_id}'",
                        "scriptPath": str(source_file),
                    }
                seen_sections.add(section_id)
                if section_id not in sketch_ids:
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' references unknown sketch '{section_id}' at sectionSketchIds[{j}]",
                        "scriptPath": str(source_file),
                    }
            ruled = params.get("ruled", False)
            if not isinstance(ruled, bool):
                return {
                    "success": False,
                    "error": f"Feature '{fid}' (loft) requires ruled to be a boolean",
                    "scriptPath": str(source_file),
                }
            continue

        if feature_type in ("sweep", "pipe"):
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            path_curve_id = params.get("pathCurveId")
            if not isinstance(path_curve_id, str) or not path_curve_id:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' ({feature_type}) requires a pathCurveId",
                    "scriptPath": str(source_file),
                }
            if path_curve_id not in curve_ids:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' references unknown curve '{path_curve_id}'",
                    "scriptPath": str(source_file),
                }
            orientation = params.get("orientation", "frenet")
            if orientation not in ("frenet", "fixedBinormal"):
                return {
                    "success": False,
                    "error": f"Feature '{fid}' ({feature_type}) requires orientation 'frenet' or 'fixedBinormal'",
                    "scriptPath": str(source_file),
                }
            if orientation == "fixedBinormal":
                binormal = params.get("binormal")
                if (
                    not isinstance(binormal, (list, tuple))
                    or len(binormal) != 3
                    or not all(
                        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                        for v in binormal
                    )
                    or (binormal[0] == 0 and binormal[1] == 0 and binormal[2] == 0)
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' ({feature_type}) requires a non-zero binormal [x, y, z]",
                        "scriptPath": str(source_file),
                    }
            if feature_type == "pipe":
                radius = params.get("radius")
                if (
                    not isinstance(radius, (int, float))
                    or isinstance(radius, bool)
                    or not math.isfinite(radius)
                    or radius <= 0
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (pipe) requires a positive radius",
                        "scriptPath": str(source_file),
                    }
                continue

        sketch_id = feature.get("sketchId")
        if not isinstance(sketch_id, str) or not sketch_id:
            return {
                "success": False,
                "error": f"Feature '{fid}' ({feature_type}) requires a sketchId",
                "scriptPath": str(source_file),
            }
        if sketch_id not in sketch_ids:
            return {
                "success": False,
                "error": f"Feature '{fid}' references unknown sketch '{sketch_id}'",
                "scriptPath": str(source_file),
            }

        params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
        if feature_type in ("pad", "pocket"):
            length = params.get("length")
            if (
                not isinstance(length, (int, float))
                or isinstance(length, bool)
                or not math.isfinite(length)
                or length <= 0
            ):
                return {
                    "success": False,
                    "error": f"Feature '{fid}' ({feature_type}) requires a positive length",
                    "scriptPath": str(source_file),
                }
        elif feature_type in ("revolve", "groove"):
            axis = params.get("axis")
            if axis not in ("x", "y", "z"):
                return {
                    "success": False,
                    "error": (f"Feature '{fid}' ({feature_type}) requires axis 'x', 'y', or 'z'"),
                    "scriptPath": str(source_file),
                }
            angle = params.get("angle")
            if (
                not isinstance(angle, (int, float))
                or isinstance(angle, bool)
                or not math.isfinite(angle)
                or angle <= 0
                or angle > 360
            ):
                return {
                    "success": False,
                    "error": (f"Feature '{fid}' ({feature_type}) requires angle in (0, 360]"),
                    "scriptPath": str(source_file),
                }
        elif feature_type == "helicalSweep":
            axis = params.get("axis")
            if axis not in ("X", "Y", "Z"):
                return {
                    "success": False,
                    "error": (f"Feature '{fid}' (helicalSweep) requires axis 'X', 'Y', or 'Z'"),
                    "scriptPath": str(source_file),
                }
            for name in ("startRadius", "pitch", "turns"):
                value = params.get(name)
                if (
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    or value <= 0
                ):
                    return {
                        "success": False,
                        "error": (f"Feature '{fid}' (helicalSweep) requires a positive {name}"),
                        "scriptPath": str(source_file),
                    }
            orientation = params.get("orientation", "fixedBinormal")
            if orientation not in ("frenet", "fixedBinormal"):
                return {
                    "success": False,
                    "error": (
                        f"Feature '{fid}' (helicalSweep) requires orientation 'frenet' or 'fixedBinormal'"
                    ),
                    "scriptPath": str(source_file),
                }
            # Unlike sweep, the binormal may be omitted (it defaults to the axis
            # unit vector); when present it must be a non-zero vector.
            if orientation == "fixedBinormal" and params.get("binormal") is not None:
                binormal = params.get("binormal")
                if (
                    not isinstance(binormal, (list, tuple))
                    or len(binormal) != 3
                    or not all(
                        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                        for v in binormal
                    )
                    or (binormal[0] == 0 and binormal[1] == 0 and binormal[2] == 0)
                ):
                    return {
                        "success": False,
                        "error": f"Feature '{fid}' (helicalSweep) requires a non-zero binormal [x, y, z]",
                        "scriptPath": str(source_file),
                    }
            left_handed = params.get("leftHanded", False)
            if not isinstance(left_handed, bool):
                return {
                    "success": False,
                    "error": f"Feature '{fid}' (helicalSweep) requires leftHanded to be a boolean",
                    "scriptPath": str(source_file),
                }

        for j, dep in enumerate(feature.get("dependsOn", [])):
            if dep not in feature_ids:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' references unknown dependency '{dep}' at dependsOn[{j}]",
                    "scriptPath": str(source_file),
                }

    for i, curve in enumerate(document.get("curves", [])):
        if not isinstance(curve, dict):
            return {
                "success": False,
                "error": f"Curve[{i}] must be an object",
                "scriptPath": str(source_file),
            }
        cid = curve.get("id", f"[{i}]")
        samples = curve.get("samples", [])
        if not isinstance(samples, list) or len(samples) < 4:
            return {
                "success": False,
                "error": f"Curve '{cid}' must have at least 4 samples",
                "scriptPath": str(source_file),
            }
        for j, point in enumerate(samples):
            if not isinstance(point, (list, tuple)) or len(point) != 3:
                return {
                    "success": False,
                    "error": f"Curve '{cid}' sample[{j}] must be [x, y, z]",
                    "scriptPath": str(source_file),
                }
            if not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in point
            ):
                return {
                    "success": False,
                    "error": f"Curve '{cid}' sample[{j}] must contain finite numbers",
                    "scriptPath": str(source_file),
                }

    return None


def build_document(
    document_path: str,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = True,
    add_graveyard: bool = True,
    export_mesh: bool = True,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    length_scale: float = 1.0,
) -> dict:
    """Build geometry from a ``.nuke-cad`` document and write canonical artifacts.

    Mirrors ``build_geometry`` in signature and behavior. The built shape is fed
    through ``_process_shape`` verbatim so STEP, tessellation, DAGMC, and mesh
    artifacts are identical to script builds. Per-feature status is returned in
    ``featureResults``.
    """
    document_file = Path(document_path).resolve()
    if not document_file.exists():
        return {"success": False, "error": f"Document not found: {document_path}"}

    if (
        not HAS_FEATURE_BUILDER
        or not HAS_SKETCH_BUILDER
        or feature_builder is None
        or sketch_builder is None
    ):
        return {
            "success": False,
            "error": "Document build requires build123d, which is not available in the active Python environment",
            "scriptPath": str(document_file),
        }

    if output_dir is None:
        output_dir = document_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Loading document: {document_file}")
    try:
        with document_file.open("r", encoding="utf-8") as fh:
            document = json.load(fh)
    except json.JSONDecodeError as exc:
        return {
            "success": False,
            "error": f"Failed to parse .nuke-cad document: {exc}",
            "scriptPath": str(document_file),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read document: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(document_file),
        }

    if not isinstance(document, dict):
        return {
            "success": False,
            "error": ".nuke-cad document must be a JSON object",
            "scriptPath": str(document_file),
        }

    version = document.get("version")
    if version not in (1, 2, 3):
        return {
            "success": False,
            "error": f"Unsupported .nuke-cad schema version {version!r}; expected 1, 2, or 3",
            "scriptPath": str(document_file),
        }

    if version == 1:
        document = _migrate_v1_to_v2(document)
    if document.get("version") == 2:
        document = _migrate_v2_to_v3(document)

    ref_error = _validate_document_refs(document, document_file)
    if ref_error is not None:
        return ref_error

    curves = document.get("curves", [])
    has_curves = isinstance(curves, list) and len(curves) > 0

    # Curves are built before features so sweep/pipe features can consume the
    # fitted path wires; curves are independent of features, so the reorder is
    # safe. The tess `curves` stream is still populated when a feature build
    # fails because curve results are computed here, ahead of the feature loop.
    curve_results: dict[str, dict[str, Any]] = {}
    if has_curves:
        if not HAS_CURVE_BUILDER or curve_builder is None:
            return {
                "success": False,
                "error": "Document contains curves but the curve builder (OCP) is not available",
                "scriptPath": str(document_file),
            }
        _print_progress("Building curves")
        try:
            curve_results = curve_builder.build_curves(document)
        except curve_builder.CurveBuildError as exc:
            return {
                "success": False,
                "error": str(exc),
                "scriptPath": str(document_file),
            }
        except Exception as exc:
            return {
                "success": False,
                "error": f"Curve build failed: {exc}",
                "traceback": traceback.format_exc(),
                "scriptPath": str(document_file),
            }

    _print_progress("Building document features")
    try:
        build_result = feature_builder.build_document_shape(document, curve_results=curve_results)
    except (feature_builder.FeatureBuilderError, sketch_builder.SketchError) as exc:
        return {
            "success": False,
            "error": str(exc),
            "scriptPath": str(document_file),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Document build failed: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(document_file),
        }

    shape = build_result.get("shape")
    if shape is None and not has_curves:
        return {
            "success": False,
            "error": "Document produced no solids; check feature results for failures",
            "scriptPath": str(document_file),
            "featureResults": build_result.get("featureResults", []),
            "referenceResults": build_result.get("referenceResults", []),
            "consumedBodies": build_result.get("consumedBodies", []),
            "warnings": build_result.get("warnings", []),
        }

    wrapped = getattr(shape, "wrapped", None) if shape is not None else None

    manifest, manifest_warnings = _load_manifest(document_file)
    result = _process_shape(
        wrapped,
        document_file,
        out_dir,
        document_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map=build_result.get("selectorMap", {}),
        manifest=manifest,
        length_scale=length_scale,
        body_ids=build_result.get("solidBodyIds"),
        curve_results=curve_results,
    )
    result["featureResults"] = build_result.get("featureResults", [])
    result["referenceResults"] = build_result.get("referenceResults", [])
    result["consumedBodies"] = build_result.get("consumedBodies", [])
    result["warnings"] = (
        (result.get("warnings") or []) + build_result.get("warnings", []) + manifest_warnings
    )
    return result


def build_document_partial(
    document_path: str,
    feature_ids: list[str] | None,
    cache_dir: str | None = None,
    output_dir: str | None = None,
    tolerance: float = 0.001,
    export_dagmc: bool = True,
    add_graveyard: bool = True,
    export_mesh: bool = True,
    mesh_engine: str = "gmsh",
    mesh_size: float | None = None,
    mesh_min_size: float | None = None,
    mesh_max_size: float | None = None,
    mesh_order: int = 1,
    length_scale: float = 1.0,
) -> dict:
    """Rebuild only ``feature_ids`` of a ``.nuke-cad`` document via the P2 result cache.

    Mirrors :func:`build_document` in validation, migration, curve handling,
    and artifact emission; only the feature execution differs (TS-planned
    dirty closure through ``feature_builder.build_document_shape_partial``,
    clean predecessors restored from cached B-rep blobs). The zip sidecar
    resolves inside ``cache_dir`` under the document stem
    (``<stem>.nuke-cache.zip``); without a usable dir every feature executes.
    Returns the stdout-JSON result dict with the unified
    tessellation and per-feature results.
    """
    document_file = Path(document_path).resolve()
    if not document_file.exists():
        return {"success": False, "error": f"Document not found: {document_path}"}

    if (
        not HAS_FEATURE_BUILDER
        or not HAS_SKETCH_BUILDER
        or feature_builder is None
        or sketch_builder is None
    ):
        return {
            "success": False,
            "error": "Document build requires build123d, which is not available in the active Python environment",
            "scriptPath": str(document_file),
        }

    if output_dir is None:
        output_dir = document_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    _print_progress(f"Loading document: {document_file}")
    try:
        with document_file.open("r", encoding="utf-8") as fh:
            document = json.load(fh)
    except json.JSONDecodeError as exc:
        return {
            "success": False,
            "error": f"Failed to parse .nuke-cad document: {exc}",
            "scriptPath": str(document_file),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to read document: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(document_file),
        }

    if not isinstance(document, dict):
        return {
            "success": False,
            "error": ".nuke-cad document must be a JSON object",
            "scriptPath": str(document_file),
        }

    version = document.get("version")
    if version not in (1, 2, 3):
        return {
            "success": False,
            "error": f"Unsupported .nuke-cad schema version {version!r}; expected 1, 2, or 3",
            "scriptPath": str(document_file),
        }

    if version == 1:
        document = _migrate_v1_to_v2(document)
    if document.get("version") == 2:
        document = _migrate_v2_to_v3(document)

    ref_error = _validate_document_refs(document, document_file)
    if ref_error is not None:
        return ref_error

    curves = document.get("curves", [])
    has_curves = isinstance(curves, list) and len(curves) > 0

    # Curves are built before features so sweep/pipe features can consume the
    # fitted path wires; curves are independent of features, so the reorder is
    # safe. The tess `curves` stream is still populated when a feature build
    # fails because curve results are computed here, ahead of the feature loop.
    curve_results: dict[str, dict[str, Any]] = {}
    if has_curves:
        if not HAS_CURVE_BUILDER or curve_builder is None:
            return {
                "success": False,
                "error": "Document contains curves but the curve builder (OCP) is not available",
                "scriptPath": str(document_file),
            }
        _print_progress("Building curves")
        try:
            curve_results = curve_builder.build_curves(document)
        except curve_builder.CurveBuildError as exc:
            return {
                "success": False,
                "error": str(exc),
                "scriptPath": str(document_file),
            }
        except Exception as exc:
            return {
                "success": False,
                "error": f"Curve build failed: {exc}",
                "traceback": traceback.format_exc(),
                "scriptPath": str(document_file),
            }

    # The zip sidecar lives beside the document; the TS-provided cache dir
    # selects the directory (normally the document's own). Best-effort:
    # without a usable path the partial path simply executes everything.
    cache_path: str | None = None
    if cache_dir and HAS_DOC_CACHE and doc_cache is not None:
        try:
            cache_path = str(Path(cache_dir) / f"{document_file.stem}.nuke-cache.zip")
        except Exception:
            cache_path = None
    _print_progress("Building document features (partial)")
    try:
        build_result = feature_builder.build_document_shape_partial(
            document,
            list(feature_ids or []),
            curve_results=curve_results,
            cache_path=cache_path,
        )
    except (feature_builder.FeatureBuilderError, sketch_builder.SketchError) as exc:
        return {
            "success": False,
            "error": str(exc),
            "scriptPath": str(document_file),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Document build failed: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(document_file),
        }

    shape = build_result.get("shape")
    if shape is None and not has_curves:
        return {
            "success": False,
            "error": "Document produced no solids; check feature results for failures",
            "scriptPath": str(document_file),
            "featureResults": build_result.get("featureResults", []),
            "referenceResults": build_result.get("referenceResults", []),
            "consumedBodies": build_result.get("consumedBodies", []),
            "warnings": build_result.get("warnings", []),
        }

    wrapped = getattr(shape, "wrapped", None) if shape is not None else None

    manifest, manifest_warnings = _load_manifest(document_file)
    result = _process_shape(
        wrapped,
        document_file,
        out_dir,
        document_file.stem,
        tolerance=tolerance,
        export_dagmc=export_dagmc,
        add_graveyard=add_graveyard,
        export_mesh=export_mesh,
        mesh_engine=mesh_engine,
        mesh_size=mesh_size,
        mesh_min_size=mesh_min_size,
        mesh_max_size=mesh_max_size,
        mesh_order=mesh_order,
        selector_map=build_result.get("selectorMap", {}),
        manifest=manifest,
        length_scale=length_scale,
        body_ids=build_result.get("solidBodyIds"),
        curve_results=curve_results,
    )
    result["featureResults"] = build_result.get("featureResults", [])
    result["referenceResults"] = build_result.get("referenceResults", [])
    result["consumedBodies"] = build_result.get("consumedBodies", [])
    result["warnings"] = (
        (result.get("warnings") or []) + build_result.get("warnings", []) + manifest_warnings
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="nuke-cad geometry service")
    parser.add_argument(
        "script",
        nargs="?",
        default=None,
        help="Path to the build123d/CadQuery script, STEP file, or .nuke-cad document",
    )
    parser.add_argument("--from-step", action="store_true", help="Treat the input as a STEP file")
    parser.add_argument(
        "--from-document", action="store_true", help="Treat the input as a .nuke-cad document"
    )
    parser.add_argument("--output-dir", default=None, help="Directory for output artifacts")
    parser.add_argument(
        "--partial-feature-ids",
        default=None,
        help=(
            "Comma-separated feature ids for a partial --from-document rebuild; "
            "clean predecessors reuse the P2 result cache at --cache-dir"
        ),
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help=(
            "Result-cache directory for partial document rebuilds "
            "(passed through opaquely; cache policy is owned by the TS orchestrator)"
        ),
    )
    # Internal child-process entry point used by build_geometry for isolated
    # script execution; not part of the public CLI.
    parser.add_argument("--exec-script", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--exec-dir", default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.001,
        help="BRepMesh faceting tolerance (default: 0.001)",
    )
    parser.add_argument(
        "--dagmc",
        action="store_true",
        help="Enable DAGMC .h5m export for --from-step imports (off by default there)",
    )
    parser.add_argument(
        "--no-dagmc",
        action="store_true",
        help="Skip DAGMC .h5m export",
    )
    parser.add_argument(
        "--no-graveyard",
        action="store_true",
        help="Do not auto-create a mat:graveyard bounding volume",
    )
    parser.add_argument(
        "--mesh",
        action="store_true",
        help="Enable FEM volume mesh export for --from-step imports (off by default there)",
    )
    parser.add_argument(
        "--no-mesh",
        action="store_true",
        help="Skip FEM volume mesh export",
    )
    parser.add_argument(
        "--mesh-engine",
        default="gmsh",
        choices=["gmsh", "netgen"],
        help="Volume meshing engine (default: gmsh)",
    )
    parser.add_argument("--mesh-size", type=float, default=None, help="Global target element size")
    parser.add_argument("--mesh-min-size", type=float, default=None, help="Minimum element size")
    parser.add_argument("--mesh-max-size", type=float, default=None, help="Maximum element size")
    parser.add_argument("--mesh-order", type=int, default=1, help="Element order (1 or 2)")
    parser.add_argument(
        "--length-scale",
        type=float,
        default=1.0,
        help="Scale factor applied to exported mesh vertices (default: 1.0; model units are cm)",
    )
    parser.add_argument(
        "--script-timeout",
        type=float,
        default=DEFAULT_SCRIPT_TIMEOUT,
        help=f"User script execution timeout in seconds (default: {DEFAULT_SCRIPT_TIMEOUT:g})",
    )
    args = parser.parse_args()

    if args.exec_script is not None:
        # Child-process mode: emit the protocol payload and exit.
        result = _execute_script_child(args.exec_script, args.exec_dir or ".")
        _emit_result(result)
        sys.exit(0 if result.get("success") else 1)

    if args.script is None:
        parser.error("the following arguments are required: script")

    if args.from_step:
        # STEP imports skip DAGMC/mesh export unless explicitly requested.
        result = import_step_file(
            args.script,
            output_dir=args.output_dir,
            tolerance=args.tolerance,
            export_dagmc=args.dagmc and not args.no_dagmc,
            add_graveyard=not args.no_graveyard,
            export_mesh=args.mesh and not args.no_mesh,
            mesh_engine=args.mesh_engine,
            mesh_size=args.mesh_size,
            mesh_min_size=args.mesh_min_size,
            mesh_max_size=args.mesh_max_size,
            mesh_order=args.mesh_order,
            length_scale=args.length_scale,
        )
    elif args.from_document:
        if args.partial_feature_ids is not None:
            result = build_document_partial(
                args.script,
                [fid.strip() for fid in args.partial_feature_ids.split(",") if fid.strip()],
                cache_dir=args.cache_dir,
                output_dir=args.output_dir,
                tolerance=args.tolerance,
                export_dagmc=not args.no_dagmc,
                add_graveyard=not args.no_graveyard,
                export_mesh=not args.no_mesh,
                mesh_engine=args.mesh_engine,
                mesh_size=args.mesh_size,
                mesh_min_size=args.mesh_min_size,
                mesh_max_size=args.mesh_max_size,
                mesh_order=args.mesh_order,
                length_scale=args.length_scale,
            )
        else:
            result = build_document(
                args.script,
                output_dir=args.output_dir,
                tolerance=args.tolerance,
                export_dagmc=not args.no_dagmc,
                add_graveyard=not args.no_graveyard,
                export_mesh=not args.no_mesh,
                mesh_engine=args.mesh_engine,
                mesh_size=args.mesh_size,
                mesh_min_size=args.mesh_min_size,
                mesh_max_size=args.mesh_max_size,
                mesh_order=args.mesh_order,
                length_scale=args.length_scale,
            )
    else:
        result = build_geometry(
            args.script,
            output_dir=args.output_dir,
            tolerance=args.tolerance,
            export_dagmc=not args.no_dagmc,
            add_graveyard=not args.no_graveyard,
            export_mesh=not args.no_mesh,
            mesh_engine=args.mesh_engine,
            mesh_size=args.mesh_size,
            mesh_min_size=args.mesh_min_size,
            mesh_max_size=args.mesh_max_size,
            mesh_order=args.mesh_order,
            script_timeout=args.script_timeout,
            length_scale=args.length_scale,
        )
    _emit_result(result)
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
