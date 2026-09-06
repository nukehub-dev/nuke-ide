"""Headless tally/source/overlay VTK conversion commands (no trame server).

Each command converts statepoint/source data to a VTK XML file that the
native tally viewer renders directly (``TallyNativeViewerWidget`` via
``FileService.read`` + ``setTallyText``). The trame
``openmc.visualize-mesh`` / ``openmc.visualize-overlay`` /
``openmc.visualize-source`` servers stay as the fallback path.
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
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
