#!/usr/bin/env python3
"""Geometry service for nuke-cad.

Executes a user-authored build123d/CadQuery script, normalizes the resulting
object to an OCP B-rep, and emits canonical artifacts:

    <stem>.step              canonical STEP export
    <stem>.tess.json         per-solid/per-face triangle stream for the viewport
    <stem>.h5m               DAGMC export with imprint/merge and named groups
    <stem>.msh / .e / .inp   FEM volume mesh (gmsh native, ExodusII, CalculiX)
    <stem>.mesh.report.json  mesh quality report

Progress and diagnostics are emitted on stderr. One final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).

Script convention
-----------------
The script must define a top-level variable named ``model`` that holds the
canonical geometry object. Supported types:

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

    stem = script_file.stem
    step_path = out_dir / f"{stem}.step"
    tess_path = out_dir / f"{stem}.tess.json"
    h5m_path = out_dir / f"{stem}.h5m"
    msh_path = out_dir / f"{stem}.msh"
    exodus_path = out_dir / f"{stem}.e"
    inp_path = out_dir / f"{stem}.inp"
    vtk_path = out_dir / f"{stem}.vtk"
    mesh_report_path = out_dir / f"{stem}.mesh.report.json"

    result: dict = {
        "success": False,
        "scriptPath": str(script_file),
        "outputDirectory": str(out_dir),
        "stepPath": str(step_path),
        "tessPath": str(tess_path),
        "dagmcPath": str(h5m_path),
        "dagmcSuccess": False,
        "dagmcWarnings": [],
        "dagmcError": None,
        "meshPath": str(msh_path),
        "exodusPath": str(exodus_path),
        "inpPath": str(inp_path),
        "vtkPath": str(vtk_path),
        "meshReportPath": str(mesh_report_path),
        "meshSuccess": False,
        "meshWarnings": [],
        "meshError": None,
        "meshReport": None,
        "warnings": [],
    }

    # ------------------------------------------------------------------
    # 1. Execute user script and locate ``model``.
    # ------------------------------------------------------------------
    _print_progress(f"Executing script: {script_file}")
    try:
        import runpy

        namespace = runpy.run_path(str(script_file), run_name="__nuke_cad_model__")
    except Exception as exc:
        result["error"] = f"Script execution failed: {exc}"
        result["traceback"] = traceback.format_exc()
        return result

    if "model" not in namespace:
        result["error"] = (
            "Script did not define a top-level 'model' variable. "
            "Assign your build123d Part/Compound or CadQuery Workplane to 'model'."
        )
        return result

    raw_model = namespace["model"]

    # ------------------------------------------------------------------
    # 2. Normalize to OCP shape.
    # ------------------------------------------------------------------
    _print_progress("Normalizing to OCP B-rep")
    try:
        shape, selector_map = _extract_shape(raw_model)
    except TypeError as exc:
        result["error"] = str(exc)
        return result

    if shape is None:
        result["error"] = (
            "Could not extract an OCP B-rep from 'model'. "
            "Supported types: build123d Part/Compound, CadQuery Workplane, OCP TopoDS_Shape."
        )
        return result

    # ------------------------------------------------------------------
    # 3. Write STEP.
    # ------------------------------------------------------------------
    _print_progress(f"Writing STEP: {step_path}")
    try:
        _write_step(shape, step_path)
    except Exception as exc:
        result["error"] = str(exc)
        result["traceback"] = traceback.format_exc()
        return result

    # ------------------------------------------------------------------
    # 4. Tessellate and write viewport stream.
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
        tess_path.write_text(json.dumps(tess_data), encoding="utf-8")
    except Exception as exc:
        result["error"] = f"Failed to write tessellation stream: {exc}"
        return result

    # ------------------------------------------------------------------
    # 5. Load and validate region manifest.
    # ------------------------------------------------------------------
    manifest, manifest_warnings = _load_manifest(script_file)
    result["warnings"].extend(manifest_warnings)
    if manifest is not None:
        unknown = manifest.unknown_selectors(set(selector_map.keys()))
        if unknown:
            result["warnings"].append(
                f"Region manifest references unknown selectors: {', '.join(unknown)}"
            )
        result["regionManifest"] = manifest.to_dict()
        result["selectorMap"] = selector_map

    # ------------------------------------------------------------------
    # 6. Export DAGMC .h5m.
    # ------------------------------------------------------------------
    if export_dagmc:
        _print_progress(f"Exporting DAGMC: {h5m_path}")
        try:
            if HAS_DAGMC_EXPORT and dagmc_export is not None:
                dagmc_result = dagmc_export.convert_to_dagmc(
                    str(step_path),
                    output_path=str(h5m_path),
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
    # 7. Export FEM volume mesh.
    # ------------------------------------------------------------------
    if export_mesh:
        _print_progress(f"Exporting FEM mesh: {msh_path}")
        try:
            if HAS_MESH_SERVICE and mesh_service is not None:
                mesh_result = mesh_service.mesh_step(
                    str(step_path),
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


def main() -> None:
    parser = argparse.ArgumentParser(description="nuke-cad geometry service")
    parser.add_argument("script", help="Path to the build123d/CadQuery script")
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
