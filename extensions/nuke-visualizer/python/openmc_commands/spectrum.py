"""
Spectrum and heatmap plotting commands.
"""

import json
import sys
import numpy as np


def cmd_spectrum(args):
    """Get energy spectrum data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_energy_spectrum(
            args.statepoint, args.tally_id,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        serializable_data = {k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()}
        print(json.dumps(serializable_data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1


def cmd_spatial(args):
    """Get spatial plot data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_spatial_plot(
            args.statepoint, args.tally_id, args.axis,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        serializable_data = {k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()}
        print(json.dumps(serializable_data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1


def cmd_heatmap(args):
    """Get 2D heatmap slice data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_heatmap_slice(
            args.statepoint, args.tally_id, args.plane, args.slice_index,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        print(json.dumps(data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_heatmap_all(args):
    """Get all 2D heatmap slices for animation."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        all_slices = plotter.create_heatmap_slice_all(
            args.statepoint, args.tally_id, args.plane,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        print(f"[Heatmap All] Loaded {len(all_slices)} slices", file=sys.stderr)
        print(json.dumps(all_slices))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1
