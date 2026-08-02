#!/usr/bin/env python3
"""OpenMC MGXS Library Generator.

Wraps ``Model.convert_to_multigroup()`` to generate a multi-group cross
section library from a model exported as XML files, optionally followed by
``Model.convert_to_random_ray()``. Progress is streamed to stderr; exactly
one JSON result object is printed to stdout.

Usage:
    python generate_mgxs.py <working_directory> [options]

Options:
    --method METHOD           Generation method: material_wise (default), stochastic_slab, infinite_medium
    --groups GROUPS           Energy group structure name (default CASMO-2)
    --particles N             Particles for the generation runs (default 2000)
    --correction CORRECTION   Transport correction: P0 or none (default none)
    --temperatures TEMPS      Comma-separated temperatures in K for MGXS generation
    --output PATH             Output MGXS library path (default mgxs.h5)
    --random-ray              Also convert the model to random ray and re-export settings.xml
"""

import argparse
import json
import os
import sys
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path


def log_progress(message: str):
    """Print a progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def read_model_compatibility(working_dir: Path):
    """Check the model is continuous-energy with nuclide-decomposed materials.

    MGXS generation runs continuous-energy transport solves with per-nuclide
    reaction tallies. A multi-group settings.xml or macroscopic materials
    cannot work — and in DAGMC/C-API runs libopenmc fatals with a C-level
    exit that bypasses Python exceptions entirely, so this must be guarded
    BEFORE the openmc import (standard library only).

    Args:
        working_dir: Directory containing settings.xml and materials.xml.

    Returns:
        Error message string when incompatible, else None.
    """
    settings_path = working_dir / "settings.xml"
    if settings_path.exists():
        elem = ET.parse(settings_path).getroot().find("energy_mode")
        if elem is not None and elem.text and elem.text.strip() == "multi-group":
            return (
                "MGXS generation requires a continuous-energy model with "
                "nuclide-decomposed materials (this model is multigroup)."
            )
    materials_path = working_dir / "materials.xml"
    if materials_path.exists():
        names = [
            m.get("name") or m.get("id") or "?"
            for m in ET.parse(materials_path).getroot().findall("material")
            if m.find("macroscopic") is not None
        ]
        if names:
            return (
                "MGXS generation requires a continuous-energy model with "
                f"nuclide-decomposed materials (this model has macroscopic materials: {', '.join(names)})."
            )
    return None


def load_model(working_dir: Path):
    """Load materials, geometry, and settings from XML files in the working directory.

    Args:
        working_dir: Directory containing materials.xml, geometry.xml, and settings.xml.

    Returns:
        Tuple of (materials, geometry, settings).
    """
    import openmc

    materials = openmc.Materials.from_xml("materials.xml")
    geometry = openmc.Geometry.from_xml("geometry.xml", materials)

    meshes = {}
    tallies_path = working_dir / "tallies.xml"
    if tallies_path.exists():
        try:
            tallies_root = ET.parse(tallies_path).getroot()
            for mesh_elem in tallies_root.findall("mesh"):
                mesh_type = mesh_elem.get("type")
                mesh_id = int(mesh_elem.get("id"))
                if mesh_type == "regular":
                    mesh = openmc.RegularMesh.from_xml_element(mesh_elem)
                elif mesh_type == "cylindrical":
                    mesh = openmc.CylindricalMesh.from_xml_element(mesh_elem)
                elif mesh_type == "spherical":
                    mesh = openmc.SphericalMesh.from_xml_element(mesh_elem)
                else:
                    continue
                meshes[mesh_id] = mesh
        except Exception as e:
            log_progress(f"Warning: Could not load meshes from tallies.xml: {e}")

    settings_root = ET.parse(working_dir / "settings.xml").getroot()
    settings = openmc.Settings.from_xml_element(settings_root, meshes)

    return materials, geometry, settings


def _call_with_supported_kwargs(fn, **kwargs):
    """Call fn with only the kwargs its signature accepts (version tolerance).

    Post-0.15.3 ``convert_to_multigroup`` gained ``temperatures`` and
    ``overwrite_mgxs_library``; release 0.15.3 rejects them. Dropped keys are
    reported instead of crashing on old versions.
    """
    import inspect

    params = inspect.signature(fn).parameters.values()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params):
        return fn(**kwargs)
    supported = {p.name for p in params}
    accepted = {key: value for key, value in kwargs.items() if key in supported}
    dropped = sorted(set(kwargs) - set(accepted))
    if dropped:
        log_progress(
            f"Note: this OpenMC version ignores unsupported convert kwargs: {', '.join(dropped)}"
        )
    return fn(**accepted)


def run_generate_mgxs(args):
    """Generate the MGXS library (and optionally convert to random ray).

    Args:
        args: Parsed command-line arguments.

    Returns:
        Dictionary with the output library path and conversion details.
    """
    import openmc

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    log_progress(f"Loading OpenMC model from {working_dir}")
    materials, geometry, settings = load_model(working_dir)

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)

    temperatures = None
    if args.temperatures:
        temperatures = [float(t.strip()) for t in args.temperatures.split(",")]

    correction = args.correction if args.correction != "none" else None

    convert_kwargs = {
        "method": args.method,
        "groups": args.groups,
        "mgxs_path": args.output,
        "overwrite_mgxs_library": True,
        "correction": correction,
        "temperatures": temperatures,
    }
    if args.particles:
        convert_kwargs["nparticles"] = args.particles

    log_progress(
        f"Generating MGXS library: method={args.method}, groups={args.groups}, output={args.output}"
    )
    log_progress("This runs continuous-energy Monte Carlo simulations and may take a while...")
    _call_with_supported_kwargs(model.convert_to_multigroup, **convert_kwargs)
    log_progress(f"MGXS library written to {args.output}")

    random_ray_applied = False
    if args.random_ray:
        log_progress("Converting model to random ray...")
        model.convert_to_random_ray()
        model.settings.export_to_xml()
        random_ray_applied = True
        log_progress("Random ray settings exported to settings.xml")

    return {
        "success": True,
        "mgxsPath": str(working_dir / args.output),
        "method": args.method,
        "groups": args.groups,
        "randomRayApplied": random_ray_applied,
    }


def main():
    """Entry point: parse arguments, generate the library, print JSON result."""
    parser = argparse.ArgumentParser(description="OpenMC MGXS library generator")
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--method",
        default="material_wise",
        choices=["material_wise", "stochastic_slab", "infinite_medium"],
        help="MGXS generation method",
    )
    parser.add_argument(
        "--groups", default="CASMO-2", help="Energy group structure name (e.g. CASMO-2, XMAS-172)"
    )
    parser.add_argument("--particles", type=int, help="Particles for the generation runs")
    parser.add_argument(
        "--correction", default="none", choices=["none", "P0"], help="Transport correction"
    )
    parser.add_argument("--temperatures", help="Comma-separated temperatures in K")
    parser.add_argument("--output", default="mgxs.h5", help="Output MGXS library path")
    parser.add_argument(
        "--random-ray", action="store_true", help="Also convert the model to random ray"
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
        sys.exit(0)

    # Semantic guard, before any openmc import: MGXS generation is a
    # continuous-energy, per-nuclide workflow
    incompatible = read_model_compatibility(Path(args.working_directory))
    if incompatible:
        log_progress(f"FAILED: {incompatible}")
        print(json.dumps({"success": False, "error": incompatible}))
        sys.exit(1)

    try:
        result = run_generate_mgxs(args)
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
