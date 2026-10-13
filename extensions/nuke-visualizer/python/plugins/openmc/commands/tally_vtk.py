"""Headless tally/source/overlay VTK conversion commands (no trame server).

Each command converts statepoint/source data to a VTK XML file that the
native tally viewer renders directly (``TallyNativeViewerWidget`` via
``FileService.read`` + ``setTallyText``) — no trame server.
"""

import json

from nuke_viz.plugin import arg, command


@command("openmc.tally-mesh-vtk", help="Convert a statepoint mesh tally to VTK image data (.vti)")
@arg("file", help="Path to statepoint .h5 file")
@arg("--tally-id", type=int, required=True, help="Tally ID to convert")
@arg("--score", help="Score to convert (default: first score)")
@arg("--nuclide", help="Nuclide to convert (default: first nuclide)")
@arg("--output", help="Output .vti path (default: temp file)")
def cmd_tally_mesh_vtk(args):
    """Convert a statepoint mesh tally to a VTK image data file."""
    from plugins.openmc.lib import tally_vtk

    try:
        result = tally_vtk.tally_mesh_to_vtk(
            args.file,
            args.tally_id,
            score=args.score,
            nuclide=args.nuclide,
            output_path=args.output,
        )
        # Numpy arrays are not JSON serializable — the converter returns
        # plain lists, but stay defensive for future fields.
        from plugins.openmc.lib.output_readers import json_default

        print(json.dumps(result, default=json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.source-vtk",
    help="Convert a source file (or statepoint source bank) to VTK points (.vtp)",
)
@arg("file", help="Path to source.h5 or a statepoint .h5 file")
@arg("--output", help="Output .vtp path (default: temp file)")
@arg("--limit", type=int, help="Maximum number of particles to convert (default: all)")
def cmd_source_vtk(args):
    """Convert source particles to a VTK point cloud."""
    from plugins.openmc.lib import tally_vtk

    try:
        result = tally_vtk.source_to_vtk(args.file, output_path=args.output, limit=args.limit)
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.overlay-geometry-vtk",
    help="Map a mesh tally onto DAGMC geometry volumes (multiblock .vtm, no server)",
)
@arg("file", help="Path to statepoint .h5 file")
@arg("--h5m", required=True, help="Path to the DAGMC .h5m geometry file")
@arg("--tally-id", type=int, required=True, help="Tally ID to convert")
@arg("--score", help="Score to convert (default: first score)")
@arg("--nuclide", help="Nuclide to convert (default: first nuclide)")
@arg(
    "--include-graveyard",
    action="store_true",
    help="Keep the Graveyard termination volume",
)
@arg("--output-dir", help="Manifest output directory (default: hash-keyed cache)")
@arg("--no-cache", action="store_true", help="Skip the manifest cache")
@arg(
    "--smooth",
    action="store_true",
    help="Trilinearly interpolate tally values at surface vertices (point data)",
)
def cmd_overlay_geometry_vtk(args):
    """Map a mesh tally onto DAGMC volumes (true 3D overlay)."""
    from plugins.openmc.lib import tally_vtk

    try:
        result = tally_vtk.overlay_geometry_to_vtk(
            args.file,
            args.h5m,
            args.tally_id,
            score=args.score,
            nuclide=args.nuclide,
            include_graveyard=args.include_graveyard,
            output_dir=args.output_dir,
            use_cache=not args.no_cache,
            smooth=args.smooth,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.overlay-vtk",
    help="Convert a mesh tally to an overlay/slice VTK cloud (.vtp, no server)",
)
@arg("file", help="Path to statepoint .h5 file")
@arg("--tally-id", type=int, required=True, help="Tally ID to convert")
@arg("--score", help="Score to convert (default: first score)")
@arg("--nuclide", help="Nuclide to convert (default: first nuclide)")
@arg(
    "--mode",
    choices=["slice", "full"],
    default="slice",
    help="Slice resample or full cell-center cloud",
)
@arg("--plane", choices=["x", "y", "z"], default="z", help="Slice plane (slice mode)")
@arg("--position", type=float, help="Slice position in cm (default: grid center)")
@arg("--resolution", type=int, default=200, help="Slice points per in-plane axis (1-1024)")
@arg("--output", help="Output .vtp path (default: temp file)")
@arg(
    "--pixelated",
    action="store_true",
    help="Nearest-cell slice values (actual mesh cells) instead of trilinear interpolation",
)
def cmd_overlay_vtk(args):
    """Convert a mesh tally to a static overlay/slice point cloud."""
    from plugins.openmc.lib import tally_vtk

    try:
        result = tally_vtk.overlay_to_vtk(
            args.file,
            args.tally_id,
            score=args.score,
            nuclide=args.nuclide,
            mode=args.mode,
            plane=args.plane,
            position=args.position,
            resolution=args.resolution,
            output_path=args.output,
            pixelated=args.pixelated,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.tally-line-probe",
    help="Sample a mesh tally along a line segment (flux profile probe)",
)
@arg("file", help="Path to statepoint .h5 file")
@arg("--tally-id", type=int, required=True, help="Tally ID to probe")
@arg("--score", help="Score to probe (default: first score)")
@arg("--nuclide", help="Nuclide to probe (default: first nuclide)")
@arg(
    "--p0",
    nargs=3,
    type=float,
    required=True,
    metavar=("X0", "Y0", "Z0"),
    help="Probe start point in cm (x y z)",
)
@arg(
    "--p1",
    nargs=3,
    type=float,
    required=True,
    metavar=("X1", "Y1", "Z1"),
    help="Probe end point in cm (x y z)",
)
@arg("--npoints", type=int, default=100, help="Samples along the segment (2-100000, default 100)")
@arg(
    "--smooth",
    action="store_true",
    help="Trilinear interpolation between mesh cells (the default)",
)
@arg(
    "--pixelated",
    action="store_true",
    help="Nearest-cell values (actual mesh cells) instead of trilinear interpolation",
)
@arg("--output", help="Output .vtp path for the probe-path polyline (default: series only)")
@arg(
    "--write-vtp",
    action="store_true",
    help="Write the probe-path polyline to a default temp path",
)
def cmd_tally_line_probe(args):
    """Sample a mesh tally along a line segment."""
    from plugins.openmc.lib import tally_vtk

    try:
        if args.smooth and args.pixelated:
            raise ValueError("--smooth and --pixelated are mutually exclusive")
        result = tally_vtk.line_probe(
            args.file,
            args.tally_id,
            args.p0,
            args.p1,
            npoints=args.npoints,
            score=args.score,
            nuclide=args.nuclide,
            smooth=not args.pixelated,
            output_path=args.output,
            write_vtp=args.write_vtp,
        )
        from plugins.openmc.lib.output_readers import json_default

        print(json.dumps(result, default=json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
