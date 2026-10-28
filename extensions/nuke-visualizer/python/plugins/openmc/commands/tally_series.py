"""Tally series command: one score across statepoint files (no server).

Reads the same tally/score/nuclide from a set of statepoints and prints one
JSON payload with the per-step aggregate, shared mesh color range, and the
volume-weighting flag consumed by the native tally-series widget.
"""

import json

from nuke_viz.plugin import arg, command


@command(
    "openmc.tally-series",
    help="Read one tally score across statepoint files (depletion history series)",
)
@arg(
    "--file",
    dest="files",
    action="append",
    required=True,
    help="Statepoint .h5 file (repeat once per step)",
)
@arg("--tally-id", type=int, required=True, help="Tally ID to read")
@arg("--score", help="Score to read (default: first score of the first file)")
@arg("--nuclide", help="Nuclide to read (default: first nuclide of the first file)")
@arg(
    "--statistic",
    choices=["total", "mean", "max"],
    default="total",
    help="Aggregation across the selected score/nuclide bins (default: total)",
)
@arg(
    "--time",
    dest="times",
    action="append",
    type=float,
    help="Explicit x-axis time for the matching --file (repeat once per file)",
)
def cmd_tally_series(args):
    """Read a tally score across a set of statepoint files."""
    from plugins.openmc.lib import tally_series

    try:
        result = tally_series.build_series(
            args.files,
            args.tally_id,
            score=args.score,
            nuclide=args.nuclide,
            statistic=args.statistic,
            times=args.times,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
