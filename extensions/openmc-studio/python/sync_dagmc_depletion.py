#!/usr/bin/env python3
"""Synchronize DAGMC universes for depletion.

Runs the documented ``Model.init_lib()`` → ``Model.sync_dagmc_universes()`` →
``Model.finalize_lib()`` sequence (openmc/model/model.py:494) so every DAGMC
cell gets an explicit material assignment in the exported geometry.xml. This
differentiates materials for burnup tracking: the exported geometry.xml gains
nested ``<cell>`` overrides inside each ``<dagmc_universe>`` element.

IMPORTANT: this rewrites geometry.xml in the working directory. It does NOT
modify the DAGMC .h5m file itself.

Usage:
    python sync_dagmc_depletion.py <working_directory>
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def log_progress(message: str):
    """Print a progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def run_sync(working_directory: str):
    """Run the DAGMC synchronization sequence.

    Args:
        working_directory: Directory containing the model XML files
            (materials.xml, geometry.xml with a dagmc_universe, and geometry.h5m).

    Returns:
        Dictionary with the synchronized cell and material counts.
    """
    import openmc

    working_dir = Path(working_directory).absolute()
    os.chdir(working_dir)

    log_progress(f"Loading model from {working_dir}")
    model = openmc.Model.from_xml(
        geometry="geometry.xml", materials="materials.xml", settings="settings.xml"
    )

    dagmc_universes = [
        u
        for u in model.geometry.get_all_universes().values()
        if isinstance(u, openmc.DAGMCUniverse)
    ]
    if not dagmc_universes:
        raise ValueError("No DAGMC universes found in geometry.xml")

    log_progress(
        f"Found {len(dagmc_universes)} DAGMC universe(s); initializing C API (init_lib)..."
    )
    model.init_lib(output=False)

    try:
        log_progress("Synchronizing DAGMC universes (sync_dagmc_universes)...")
        model.sync_dagmc_universes()
    finally:
        log_progress("Finalizing C API (finalize_lib)...")
        model.finalize_lib()

    cell_count = sum(len(univ.cells) for univ in dagmc_universes)
    log_progress(
        f"Synchronized {cell_count} DAGMC cell(s); exporting geometry.xml with cell overrides"
    )
    model.export_to_xml()

    material_names = sorted(
        {
            cell.fill.name
            for univ in dagmc_universes
            for cell in univ.cells.values()
            if cell.fill is not None
        }
    )

    return {
        "success": True,
        "cellCount": cell_count,
        "materialCount": len(material_names),
        "materialNames": material_names,
        "geometryXml": str(working_dir / "geometry.xml"),
    }


def main():
    """Entry point: parse arguments, run the sync, print JSON result."""
    parser = argparse.ArgumentParser(
        description="Synchronize DAGMC universes for depletion (init_lib → sync_dagmc_universes → finalize_lib)"
    )
    parser.add_argument("working_directory", help="Directory containing the model XML files")

    args = parser.parse_args()

    if not Path(args.working_directory).is_dir():
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Working directory not found: {args.working_directory}",
                }
            )
        )
        sys.exit(0)

    try:
        result = run_sync(args.working_directory)
        print(json.dumps(result))
    except ImportError as e:
        print(
            json.dumps(
                {"success": False, "error": f"Missing dependency: {e}. Please install openmc."}
            )
        )
        sys.exit(0)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(0)


if __name__ == "__main__":
    main()
