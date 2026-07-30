"""VTK conversion commands for OpenMC output files (tracks, collision
tracks, weight windows). Output files are rendered by the base visualizer's
trame server (base.serve)."""

import json

from nuke_viz.plugin import arg, command


def _parse_int_list(value):
    """Parse a comma-separated list of ints; returns None for empty input."""
    if not value:
        return None
    return [int(v.strip()) for v in value.split(",") if v.strip()]


@command("openmc.tracks-vtk", help="Convert particle tracks to VTK polylines (.vtp)")
@arg("file", help="Path to tracks.h5, a tracks_p*.h5 file, a directory, or a glob")
@arg("--output", help="Output .vtp path (default: temp file)")
@arg("--particle", help="Particle filter (neutron, photon, electron, positron, or PDG number)")
@arg("--cell", help="Comma-separated cell IDs; keep segments entering these cells")
@arg("--material", help="Comma-separated material IDs; keep segments entering these materials")
@arg("--max-tracks", type=int, default=1000, help="Maximum number of tracks to convert")
@arg("--max-points", type=int, default=1000, help="Maximum states per track segment")
def cmd_tracks_vtk(args):
    """Convert OpenMC track file(s) to a VTK polyline file."""
    from plugins.openmc.lib import output_vtk

    try:
        result = output_vtk.tracks_to_vtk(
            args.file,
            output_path=args.output,
            particle_filter=args.particle,
            cell_filter=_parse_int_list(args.cell),
            material_filter=_parse_int_list(args.material),
            max_tracks=args.max_tracks,
            max_points_per_track=args.max_points,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.collision-vtk", help="Convert collision tracks to a VTK point cloud (.vtp)")
@arg("file", help="Path to collision_track.h5 (or a directory/glob of collision track files)")
@arg("--output", help="Output .vtp path (default: temp file)")
@arg("--mt", help="Comma-separated event MT numbers to keep (e.g. '2,18,102')")
@arg("--cell", help="Comma-separated cell IDs to keep (e.g. '1,2,3')")
@arg("--limit", type=int, default=200000, help="Maximum number of collision sites to convert")
def cmd_collision_vtk(args):
    """Convert an OpenMC collision track file to a VTK point cloud."""
    from plugins.openmc.lib import output_vtk

    try:
        result = output_vtk.collision_track_to_vtk(
            args.file,
            output_path=args.output,
            mt_filter=_parse_int_list(args.mt),
            cell_filter=_parse_int_list(args.cell),
            limit=args.limit,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.weight-windows-vtk", help="Convert weight windows to a VTK grid (.vtr)")
@arg("file", help="Path to weight_windows.h5")
@arg("--output", help="Output .vtr path (default: temp file)")
def cmd_weight_windows_vtk(args):
    """Convert an OpenMC weight windows file to a VTK rectilinear grid."""
    from plugins.openmc.lib import output_vtk

    try:
        result = output_vtk.weight_windows_to_vtk(args.file, output_path=args.output)
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.voxel-vtk", help="Convert a voxel plot (.h5) to VTK image data (.vti)")
@arg("file", help="Path to a voxel plot .h5 file")
@arg("--output", help="Output .vti path (default: temp file)")
def cmd_voxel_vtk(args):
    """Convert an OpenMC voxel plot HDF5 file to VTK image data."""
    from plugins.openmc.lib import output_vtk

    try:
        result = output_vtk.voxel_to_vtk(args.file, output_path=args.output)
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.vtk-info", help="Inspect a VTK file (arrays, ranges, dimensions)")
@arg("file", help="Path to a .vtk/.vti/.vtr/.vtp/.vtu/.vts file")
def cmd_vtk_info(args):
    """Get array and geometry metadata for a VTK file."""
    from plugins.openmc.lib import output_vtk

    try:
        result = output_vtk.read_vtk_info(args.file)
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
