"""Particle track reader commands (tracks.h5 / tracks_p<N>.h5)."""

import json

from nuke_viz.plugin import arg, command


@command("openmc.tracks-info", help="Get particle track file summary")
@arg("file", help="Path to tracks.h5, a tracks_p*.h5 file, a directory, or a glob")
def cmd_tracks_info(args):
    """Get summary info for OpenMC particle track file(s)."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_tracks_info(args.file)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.tracks-data", help="Get particle track polylines (paginated, decimated)")
@arg("file", help="Path to tracks.h5, a tracks_p*.h5 file, a directory, or a glob")
@arg("--offset", type=int, default=0, help="Track offset for pagination")
@arg("--limit", type=int, default=100, help="Maximum number of tracks to return")
@arg("--max-points", type=int, default=1000, help="Maximum states per track segment")
@arg("--particle", help="Particle filter (neutron, photon, electron, positron, or PDG number)")
@arg("--cell", help="Comma-separated cell IDs; keep segments entering these cells")
@arg("--material", help="Comma-separated material IDs; keep segments entering these materials")
def cmd_tracks_data(args):
    """Get decimated particle track data for visualization."""
    from plugins.openmc.commands.collision_track import _parse_int_list
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_tracks_data(
            args.file,
            offset=args.offset,
            limit=args.limit,
            particle_filter=args.particle,
            max_points_per_track=args.max_points,
            cell_filter=_parse_int_list(args.cell),
            material_filter=_parse_int_list(args.material),
        )
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
