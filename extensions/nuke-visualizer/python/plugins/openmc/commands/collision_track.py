"""Collision track reader commands (collision_track.h5)."""

import json

from nuke_viz.plugin import arg, command


def _parse_int_list(value):
    """Parse a comma-separated list of ints; returns None for empty input."""
    if not value:
        return None
    return [int(v.strip()) for v in value.split(",") if v.strip()]


@command("openmc.collision-track-info", help="Get collision track file summary")
@arg("file", help="Path to collision_track.h5 (or a directory/glob of collision track files)")
def cmd_collision_track_info(args):
    """Get summary info for an OpenMC collision track file."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_collision_track_info(args.file)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.collision-track-data", help="Get collision track events (filtered, paginated)")
@arg("file", help="Path to collision_track.h5 (or a directory/glob of collision track files)")
@arg("--offset", type=int, default=0, help="Row offset for pagination (after filtering)")
@arg("--limit", type=int, default=50000, help="Maximum number of rows to return")
@arg("--mt", help="Comma-separated event MT numbers to keep (e.g. '2,18,102')")
@arg("--cell", help="Comma-separated cell IDs to keep (e.g. '1,2,3')")
def cmd_collision_track_data(args):
    """Get collision track event data for visualization."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_collision_track_data(
            args.file,
            offset=args.offset,
            limit=args.limit,
            mt_filter=_parse_int_list(args.mt),
            cell_filter=_parse_int_list(args.cell),
        )
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
