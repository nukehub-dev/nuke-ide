"""
Geometry analysis and visualization commands.
"""

import json
import os

from nuke_viz.plugin import arg, command


@command("openmc.geometry", help="Get geometry hierarchy")
@arg("file", help="Path to geometry.xml or summary.h5")
def cmd_geometry(args):
    """Get geometry hierarchy from OpenMC geometry file."""
    try:
        from plugins.openmc.lib.geometry_parser import parse_geometry

        path = _resolve_geometry_path(args.file)
        result = parse_geometry(path)
        print(json.dumps(result))
        return 0 if "error" not in result else 1
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


def _resolve_geometry_path(file_path: str) -> str:
    """Resolve a geometry input for the parse/visualize pipeline.

    summary.h5 is converted to geometry.xml + materials.xml in a temp
    directory (returned as the directory so material names load); anything
    else passes through unchanged.
    """
    if file_path.lower().endswith(".h5"):
        import tempfile

        from plugins.openmc.lib.geometry_parser import convert_summary_to_xml

        original_dir = os.path.dirname(os.path.abspath(file_path))
        return convert_summary_to_xml(
            file_path, tempfile.mkdtemp(prefix="nuke-summary-"), original_dir=original_dir
        )
    return file_path


@command("openmc.check-overlaps", help="Check for geometry overlaps")
@arg("geometry", help="Path to geometry.xml or Python model")
@arg("--samples", type=int, default=100000, help="Number of sample points")
@arg("--tolerance", type=float, default=1e-6, help="Numerical tolerance")
@arg("--bounds", help="Bounding box as JSON")
@arg("--parallel", action="store_true", help="Use parallel processing")
def cmd_check_overlaps(args):
    """Check for geometry overlaps."""
    try:
        from plugins.openmc.lib.overlap import check_overlaps

        # Parse bounding box if provided
        bounds = None
        if args.bounds:
            try:
                bounds = json.loads(args.bounds)
            except json.JSONDecodeError as e:
                print(json.dumps({"error": f"Invalid bounds JSON: {e}"}))
                return 1

        result = check_overlaps(
            geometry_path=args.geometry,
            sample_points=args.samples,
            tolerance=args.tolerance,
            bounds=bounds,
            parallel=args.parallel,
        )
        print(json.dumps(result))
        return 0 if result.get("error") is None else 1
    except Exception as e:
        print(json.dumps({"overlaps": [], "totalOverlaps": 0, "error": str(e)}))
        return 1


@command("openmc.overlap-viz", help="Get overlap visualization data")
@arg("geometry", help="Path to geometry.xml")
@arg("--overlaps", required=True, help="Overlaps JSON array")
@arg("--marker-size", type=float, default=1.0, help="Marker size in cm")
def cmd_overlap_viz(args):
    """Get visualization data for overlaps."""
    try:
        from plugins.openmc.lib.overlap import get_overlap_viz_data

        # Parse overlaps JSON
        try:
            overlaps = json.loads(args.overlaps)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid overlaps JSON: {e}"}))
            return 1

        result = get_overlap_viz_data(
            geometry_path=args.geometry, overlaps=overlaps, marker_size=args.marker_size
        )
        print(json.dumps(result))
        return 0 if result.get("error") is None else 1
    except Exception as e:
        print(json.dumps({"markers": [], "overlappingCellIds": [], "error": str(e)}))
        return 1


@command("openmc.geometry-bounds", help="Get geometry bounds from DAGMC file")
@arg("geometry", help="Path to geometry .h5m file")
def cmd_geometry_bounds(args):
    """Get geometry bounds from DAGMC file."""
    try:
        from plugins.openmc.lib.slice_viz import get_geometry_bounds

        bounds = get_geometry_bounds(args.geometry)
        if bounds is None:
            print(json.dumps({"error": "Could not load geometry bounds"}))
            return 1
        print(json.dumps(bounds))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.geometry-mesh", help="Extract CSG geometry as three.js-ready mesh JSON")
@arg("--file", required=True, help="Path to geometry.xml or summary.h5")
@arg("--out", help="Write mesh JSON to this file (otherwise printed on stdout)")
@arg("--segments", type=int, default=16, help="Tessellation segments per curved surface (3-64)")
def cmd_geometry_mesh(args):
    """Extract OpenMC CSG geometry as mesh JSON without starting a server."""
    try:
        segments = args.segments
        if isinstance(segments, bool):
            print(json.dumps({"error": "segments must be an integer"}))
            return 1
        try:
            segments = int(segments)
        except (TypeError, ValueError):
            print(json.dumps({"error": f"segments must be an integer, got {args.segments!r}"}))
            return 1
        if segments < 3 or segments > 64:
            print(json.dumps({"error": f"segments must be between 3 and 64, got {segments}"}))
            return 1

        from plugins.openmc.lib.geometry_viz import extract_csg_mesh, write_geometry_mesh_json

        path = _resolve_geometry_path(args.file)
        if os.path.isdir(path):
            path = os.path.join(path, "geometry.xml")

        mesh = extract_csg_mesh(path, segments=segments)
        if args.out:
            mesh_path = write_geometry_mesh_json(mesh, args.out)
            print(
                json.dumps(
                    {
                        "meshPath": mesh_path,
                        "sourceFile": mesh["sourceFile"],
                        "stats": mesh["stats"],
                    }
                )
            )
        else:
            print(json.dumps(mesh))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.geometry-slice-vtk", help="Write a static CSG section slice as .vtp (no server)")
@arg("--file", required=True, help="Path to geometry.xml or summary.h5")
@arg("--plane", choices=["x", "y", "z"], default="z", help="Slice plane")
@arg("--position", type=float, help="Slice position in cm (default: bounds center)")
@arg("--out", help="Output .vtp path (default: temp file)")
def cmd_geometry_slice_vtk(args):
    """Write a static geometry section slice as a plain VTK file."""
    try:
        from plugins.openmc.lib.geometry_viz import extract_csg_mesh
        from plugins.openmc.lib.slice_viz import extract_geometry_section, write_section_vtp

        path = _resolve_geometry_path(args.file)
        if os.path.isdir(path):
            path = os.path.join(path, "geometry.xml")

        mesh = extract_csg_mesh(path)
        cells = [{"cellId": cell["id"], "bounds": cell["bbox"]} for cell in mesh["cells"]]
        section = extract_geometry_section(cells, plane=args.plane, position=args.position)
        vtk_path = write_section_vtp(section, args.out)
        print(
            json.dumps(
                {
                    "vtkPath": vtk_path,
                    "sourceFile": mesh["sourceFile"],
                    "plane": section["plane"],
                    "position": section["position"],
                    "nCells": section["nCells"],
                    "nSections": section["nSections"],
                }
            )
        )
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
