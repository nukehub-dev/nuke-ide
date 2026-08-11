#!/usr/bin/env python3
"""Convert a continuous-energy project to multi-group.

Runs the MGXS generation flow (``generate_mgxs.run_generate_mgxs`` — the same
driver the MGXS Generator window uses) against a working directory of
already-generated XML files, then reads the produced library with h5py and
reports the material → XS-data-name mapping the IDE needs to switch materials
to macroscopic. Progress is streamed to stderr; exactly one JSON result
object is printed to stdout.

Usage:
    python convert_to_multigroup_project.py <working_directory> [options]

Options:
    --method METHOD     Generation method: material_wise (default), stochastic_slab, infinite_medium
    --groups GROUPS     Energy group structure name (default CASMO-2)
    --particles N       Particles for the generation runs
    --output PATH       Output MGXS library path (default mgxs.h5)
    --nuclide-wise      Generate a nuclide-wise library and return a
                        nuclide -> XS-data-name mapping instead of the
                        material-wise mapping; materials stay nuclide-decomposed
"""

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import generate_mgxs


def log_progress(message: str):
    """Print a progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def read_material_names(working_dir):
    """Material names from materials.xml (standard library only).

    Args:
        working_dir: Directory containing materials.xml.

    Returns:
        List of material names in file order (empty when absent).
    """
    materials_path = Path(working_dir) / "materials.xml"
    if not materials_path.exists():
        return []
    return [
        m.get("name") or m.get("id") or "?"
        for m in ET.parse(materials_path).getroot().findall("material")
    ]


def read_xs_data_names(mgxs_path):
    """Top-level group names of an MGXS library — the XS data set names.

    In material-wise generation each material becomes one group named after
    the material (with temperature subgroups below it).

    Args:
        mgxs_path: Path to the generated mgxs.h5.

    Returns:
        List of XS data names.
    """
    import h5py

    with h5py.File(mgxs_path, "r") as f:
        return list(f.keys())


def convert_project(args):
    """Run the conversion and build the material mapping.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Dictionary with success, mgxsPath, and xsDataNames mapping.
    """
    working_dir = Path(args.working_directory).absolute()
    nuclide_wise = getattr(args, "nuclide_wise", False)

    log_progress("Step 1/2: generating the MGXS library from the CE model...")
    mgxs_args = SimpleNamespace(
        working_directory=str(working_dir),
        method=args.method,
        groups=args.groups,
        particles=args.particles,
        correction="none",
        temperatures=None,
        output=args.output,
        random_ray=False,
        nuclide_wise=nuclide_wise,
    )
    result = generate_mgxs.run_generate_mgxs(mgxs_args)
    if not result.get("success"):
        return result

    log_progress("Step 2/2: reading the library's XS data sets...")
    xs_names = set(read_xs_data_names(result["mgxsPath"]))

    if nuclide_wise:
        # Nuclide-wise generation names each XS data set after its nuclide;
        # materials stay nuclide-decomposed, so there is no material mapping
        xs_data_names = [{"nuclideName": name, "xsDataName": name} for name in sorted(xs_names)]
        return {
            "success": True,
            "mgxsPath": result["mgxsPath"],
            "libraryType": "nuclide",
            "xsDataNames": xs_data_names,
        }

    material_names = read_material_names(working_dir)
    # Material-wise generation names each XS data set after its material
    xs_data_names = [
        {"materialName": name, "xsDataName": name} for name in material_names if name in xs_names
    ]
    skipped = [name for name in material_names if name not in xs_names]
    if skipped:
        log_progress(
            f"Note: {len(skipped)} material(s) have no XS data set and stay unchanged: {', '.join(skipped)}"
        )

    return {
        "success": True,
        "mgxsPath": result["mgxsPath"],
        "libraryType": "material",
        "xsDataNames": xs_data_names,
    }


def main():
    """Entry point: parse arguments, convert, print JSON result."""
    parser = argparse.ArgumentParser(description="Convert a CE project to multi-group")
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--method",
        default="material_wise",
        choices=["material_wise", "stochastic_slab", "infinite_medium"],
        help="MGXS generation method",
    )
    parser.add_argument("--groups", default="CASMO-2", help="Energy group structure name")
    parser.add_argument("--particles", type=int, help="Particles for the generation runs")
    parser.add_argument("--output", default="mgxs.h5", help="Output MGXS library path")
    parser.add_argument(
        "--nuclide-wise",
        action="store_true",
        help="Generate a nuclide-wise library and return the nuclide mapping "
        "(materials stay nuclide-decomposed)",
    )

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
        sys.exit(1)

    try:
        result = convert_project(args)
        print(json.dumps(result))
        sys.exit(0 if result.get("success") else 1)
    except Exception as e:
        log_progress(f"FAILED: {e}")
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
