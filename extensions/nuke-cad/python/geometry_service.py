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
* ``cadquery.Workplane`` (compat)
* ``OCP.TopoDS.TopoDS_Shape`` (escape hatch)
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from ocp_compat import (  # noqa: E402
    brep_bnd_lib_add,
    brep_tool_triangulation,
    interface_static_set_cval,
    topods_face,
    topods_solid,
)
from region_manifest import ManifestValidationError, RegionManifest  # noqa: E402

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


def _print_progress(message: str) -> None:
    """Emit a progress line on stderr."""
    print(message, file=sys.stderr, flush=True)


def _extract_shape(result: object) -> tuple[object | None, dict[str, list[int]]]:
    """Normalize a build123d/CadQuery/OCP result to ``(topods_shape, selector_map)``.

    The selector map associates user-assigned labels/part names with the
    1-based solid indices that carry them. Label extraction is best-effort:
    build123d objects expose labels, CadQuery objects do not.
    """
    selector_map: dict[str, list[int]] = {}

    # OCP escape hatch.
    try:
        from OCP.TopoDS import TopoDS_Shape

        if isinstance(result, TopoDS_Shape):
            return result, selector_map
    except Exception:
        pass

    # build123d Part / Compound / Assembly.
    try:
        import build123d as bd

        if isinstance(result, (bd.Part, bd.Compound)):
            labels = getattr(result, "labels", None) or {}
            for label, indices in labels.items():
                # build123d labels are 0-based internally; expose 1-based externally.
                selector_map[label] = [(i + 1) for i in indices]
            return result.wrapped, selector_map

        if isinstance(result, bd.Assembly):
            # Assemblies are not directly supported; flattening is future work.
            raise TypeError(
                "build123d Assembly is not supported. Define the model as a Part or Compound."
            )
    except Exception:
        pass

    # CadQuery Workplane / Assembly.
    try:
        import cadquery as cq

        if isinstance(result, cq.Workplane):
            shape = result.val()
            return shape.wrapped, selector_map
        if hasattr(result, "obj") and result.obj is not None:
            return result.obj.wrapped, selector_map
    except Exception:
        pass

    return None, selector_map


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
) -> dict:
    """Execute ``script_path`` and write canonical artifacts.

    Returns the stdout-JSON result dict.
    """
    script_file = Path(script_path).resolve()
    if not script_file.exists():
        return {"success": False, "error": f"Script not found: {script_path}"}

    if output_dir is None:
        output_dir = script_file.parent
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Execute user script and locate ``model``.
    # ------------------------------------------------------------------
    _print_progress(f"Executing script: {script_file}")
    try:
        import runpy

        namespace = runpy.run_path(str(script_file), run_name="__nuke_cad_model__")
    except Exception as exc:
        return {
            "success": False,
            "error": f"Script execution failed: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(script_file),
        }

    if "model" not in namespace:
        return {
            "success": False,
            "error": (
                "Script did not define a top-level 'model' variable. "
                "Assign your build123d Part/Compound or CadQuery Workplane to 'model'."
            ),
            "scriptPath": str(script_file),
        }

    raw_model = namespace["model"]

    # ------------------------------------------------------------------
    # 2. Normalize to OCP shape.
    # ------------------------------------------------------------------
    _print_progress("Normalizing to OCP B-rep")
    try:
        shape, selector_map = _extract_shape(raw_model)
    except TypeError as exc:
        return {"success": False, "error": str(exc), "scriptPath": str(script_file)}

    if shape is None:
        return {
            "success": False,
            "error": (
                "Could not extract an OCP B-rep from 'model'. "
                "Supported types: build123d Part/Compound, CadQuery Workplane, OCP TopoDS_Shape."
            ),
            "scriptPath": str(script_file),
        }

    # ------------------------------------------------------------------
    # 3. Load manifest and process shape.
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
    )
    result["warnings"] = (result.get("warnings") or []) + manifest_warnings
    return result


def import_step_file(
    step_path: str,
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
) -> dict:
    """Import an existing STEP file and write canonical artifacts.

    Returns the stdout-JSON result dict.
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
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="nuke-cad geometry service")
    parser.add_argument("script", help="Path to the build123d/CadQuery script or STEP file")
    parser.add_argument("--from-step", action="store_true", help="Treat the input as a STEP file")
    parser.add_argument("--output-dir", default=None, help="Directory for output artifacts")
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.001,
        help="BRepMesh faceting tolerance (default: 0.001)",
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
    args = parser.parse_args()

    if args.from_step:
        result = import_step_file(
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
        )
    print(json.dumps(result))
    sys.stdout.flush()
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
