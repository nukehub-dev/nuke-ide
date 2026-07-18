"""
Spectrum and heatmap plotting commands.
"""

import json
import sys

import numpy as np
from nuke_viz.plugin import arg, command


@command("openmc.spectrum", help="Get energy spectrum data")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID")
@arg("--score-index", help="Score index")
@arg("--nuclide-index", help="Nuclide index")
def cmd_spectrum(args):
    """Get energy spectrum data."""
    try:
        from plugins.openmc.lib.reader import OpenMCPlotter

        plotter = OpenMCPlotter()
        data = plotter.create_energy_spectrum(
            args.statepoint, args.tally_id, int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        serializable_data = {
            k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()
        }
        print(json.dumps(serializable_data))
        return 0
    except Exception:
        import traceback

        traceback.print_exc(file=sys.stderr)
        return 1


@command("openmc.spatial", help="Get spatial plot data")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID")
@arg("axis", choices=["x", "y", "z"], help="Axis for spatial plot")
@arg("--score-index", help="Score index")
@arg("--nuclide-index", help="Nuclide index")
def cmd_spatial(args):
    """Get spatial plot data."""
    try:
        from plugins.openmc.lib.reader import OpenMCPlotter

        plotter = OpenMCPlotter()
        data = plotter.create_spatial_plot(
            args.statepoint,
            args.tally_id,
            args.axis,
            int(args.score_index or 0),
            int(args.nuclide_index or 0),
        )
        serializable_data = {
            k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()
        }
        print(json.dumps(serializable_data))
        return 0
    except Exception:
        import traceback

        traceback.print_exc(file=sys.stderr)
        return 1


@command("openmc.heatmap", help="Get 2D heatmap slice data")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID")
@arg("plane", choices=["xy", "xz", "yz"], help="Plane for slice")
@arg("slice_index", type=int, help="Slice index")
@arg("--score-index", help="Score index")
@arg("--nuclide-index", help="Nuclide index")
def cmd_heatmap(args):
    """Get 2D heatmap slice data."""
    try:
        from plugins.openmc.lib.reader import OpenMCPlotter

        plotter = OpenMCPlotter()
        data = plotter.create_heatmap_slice(
            args.statepoint,
            args.tally_id,
            args.plane,
            args.slice_index,
            int(args.score_index or 0),
            int(args.nuclide_index or 0),
        )
        print(json.dumps(data))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.heatmap-all", help="Get all 2D heatmap slices")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID")
@arg("plane", choices=["xy", "xz", "yz"], help="Plane for slices")
@arg("--score-index", help="Score index")
@arg("--nuclide-index", help="Nuclide index")
def cmd_heatmap_all(args):
    """Get all 2D heatmap slices for animation."""
    try:
        from plugins.openmc.lib.reader import OpenMCPlotter

        plotter = OpenMCPlotter()
        all_slices = plotter.create_heatmap_slice_all(
            args.statepoint,
            args.tally_id,
            args.plane,
            int(args.score_index or 0),
            int(args.nuclide_index or 0),
        )
        print(f"[Heatmap All] Loaded {len(all_slices)} slices", file=sys.stderr)
        print(json.dumps(all_slices))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1
