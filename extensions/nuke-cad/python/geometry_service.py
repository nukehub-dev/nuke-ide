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


def _write_step(shape: object, step_path: Path) -> None:
    """Write ``shape`` to a STEP file using OCP."""
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    writer = STEPControl_Writer()
    interface_static_set_cval(Interface_Static, "write.step.schema", "AP214IS")
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != 1:
        raise RuntimeError(f"STEP writer returned status {status}")


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


def _tessellate_shape(shape: object, tolerance: float) -> list[dict]:
    """Tessellate ``shape`` and return per-solid face buffers."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    _print_progress(f"Tessellating with tolerance {tolerance}")
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.5, True)

    solids: list[dict] = []
    solid_id = 1
    solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while solid_exp.More():
        solid = topods_solid(TopoDS, solid_exp.Current())
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

            faces.append(
                {
                    "faceId": face_id,
                    "nodes": nodes,
                    "triangles": triangles,
                    "hash": hash(face.TShape().__hash__()),
                }
            )
            face_id += 1
            face_exp.Next()

        solids.append({"solidId": solid_id, "faces": faces})
        solid_id += 1
        solid_exp.Next()

    return solids


def _bounding_box(shape: object) -> dict[str, list[float]]:
    """Return the axis-aligned bounding box of ``shape`` in model units."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    brep_bnd_lib_add(BRepBndLib, shape, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    return {"min": [xmin, ymin, zmin], "max": [xmax, ymax, zmax]}


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


def _process_shape(
    shape: object,
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
) -> dict:
    """Tessellate ``shape`` and write canonical artifacts.

    This is the shared backend of both script-based builds and STEP imports.
    Returns the stdout-JSON result dict.
    """
    selector_map = selector_map or {}
    paths = _artifact_paths(out_dir, stem)

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
    # 1. Write canonical STEP (skip if it would overwrite the input STEP).
    # ------------------------------------------------------------------
    try:
        if paths["step"].resolve() == source_file.resolve():
            _print_progress(f"Reusing input STEP: {paths['step']}")
        else:
            _print_progress(f"Writing STEP: {paths['step']}")
            _write_step(shape, paths["step"])
    except Exception as exc:
        result["error"] = str(exc)
        result["traceback"] = traceback.format_exc()
        return result

    # ------------------------------------------------------------------
    # 2. Tessellate and write viewport stream.
    # ------------------------------------------------------------------
    _print_progress("Tessellating B-rep")
    try:
        solids = _tessellate_shape(shape, tolerance)
    except Exception as exc:
        result["error"] = f"Tessellation failed: {exc}"
        result["traceback"] = traceback.format_exc()
        return result

    bbox = _bounding_box(shape)
    total_triangles = sum(len(face["triangles"]) for solid in solids for face in solid["faces"])
    total_faces = sum(len(solid["faces"]) for solid in solids)

    tess_data = {
        "version": 1,
        "tolerance": tolerance,
        "boundingBox": bbox,
        "solids": solids,
    }
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
    if export_dagmc:
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
    if export_mesh:
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
) -> dict:
    """Import an existing STEP file and write canonical artifacts.

    STEP imports skip DAGMC/mesh export by default (opt in explicitly);
    script builds keep them on by default. Returns the stdout-JSON result dict.
    """
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

    return _process_shape(
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
        selector_map={},
        manifest=None,
        length_scale=length_scale,
    )


def _validate_document_refs(document: dict[str, Any], source_file: Path) -> dict | None:
    """Light structural validation of a ``.nuke-cad`` document.

    The TypeScript validator is the front gate; this mirrors its supported
    feature set and required-parameter checks so the Python builder fails fast
    with a clear message instead of an unwrapped OCCT traceback.
    """
    datum_ids = {d.get("id") for d in document.get("datums", []) if isinstance(d, dict)}
    sketch_ids = {s.get("id") for s in document.get("sketches", []) if isinstance(s, dict)}
    feature_ids = {f.get("id") for f in document.get("features", []) if isinstance(f, dict)}

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
        if feature_type not in ("pad", "pocket", "revolve", "groove"):
            return {
                "success": False,
                "error": (
                    f"Feature '{fid}' has unsupported type '{feature_type}'; "
                    "expected 'pad', 'pocket', 'revolve', or 'groove'"
                ),
                "scriptPath": str(source_file),
            }

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
        else:  # revolve / groove
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

        for j, dep in enumerate(feature.get("dependsOn", [])):
            if dep not in feature_ids:
                return {
                    "success": False,
                    "error": f"Feature '{fid}' references unknown dependency '{dep}' at dependsOn[{j}]",
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
    if version != 1:
        return {
            "success": False,
            "error": f"Unsupported .nuke-cad schema version {version!r}; expected 1",
            "scriptPath": str(document_file),
        }

    ref_error = _validate_document_refs(document, document_file)
    if ref_error is not None:
        return ref_error

    _print_progress("Building document features")
    try:
        build_result = feature_builder.build_document_shape(document)
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
    if shape is None:
        return {
            "success": False,
            "error": "Document produced no solids; check feature results for failures",
            "scriptPath": str(document_file),
            "featureResults": build_result.get("featureResults", []),
        }

    wrapped = getattr(shape, "wrapped", None)
    if wrapped is None:
        return {
            "success": False,
            "error": "Document produced an unrecognized shape type",
            "scriptPath": str(document_file),
            "featureResults": build_result.get("featureResults", []),
        }

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
    )
    result["featureResults"] = build_result.get("featureResults", [])
    result["referenceResults"] = build_result.get("referenceResults", [])
    result["warnings"] = (result.get("warnings") or []) + manifest_warnings
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
