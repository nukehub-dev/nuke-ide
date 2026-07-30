#!/usr/bin/env python3
"""OpenMC Stochastic Volume Calculation Runner.

Runs an openmc.VolumeCalculation against a model exported as XML files in a
working directory, streams progress to stderr, and prints exactly one JSON
result object to stdout.

Usage:
    python run_volume_calc.py <working_directory> --domain-type TYPE --domain-ids IDS --samples N [options]

Options:
    --domain-type TYPE        Domain type: cell, material, or universe (required)
    --domain-ids IDS          Comma-separated domain IDs (required)
    --samples N               Number of samples (required)
    --lower-left X,Y,Z        Sampling bounding box lower-left corner
    --upper-right X,Y,Z       Sampling bounding box upper-right corner
    --trigger-type TYPE       Trigger type: std_dev, variance, or rel_err
    --trigger-threshold X     Trigger threshold value
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


def _parse_vector(raw: str):
    """Parse a comma-separated 3-vector argument.

    Args:
        raw: Raw argument string like ``"-10,-10,-10"``.

    Returns:
        List of three floats.

    Raises:
        ValueError: If the argument does not contain exactly three numbers.
    """
    values = [float(v) for v in raw.split(",")]
    if len(values) != 3:
        raise ValueError(f"Expected 3 comma-separated values, got: {raw!r}")
    return values


def load_model(working_dir: Path):
    """Load materials, geometry, and settings from XML files in the working directory.

    Args:
        working_dir: Directory containing materials.xml, geometry.xml, and settings.xml.

    Returns:
        Tuple of (materials, geometry, settings).
    """
    import xml.etree.ElementTree as ET

    import openmc

    materials = openmc.Materials.from_xml("materials.xml")
    geometry = openmc.Geometry.from_xml("geometry.xml", materials)

    # Load meshes from tallies.xml (needed by settings with mesh references)
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


def run_volume_calc(args):
    """Run the stochastic volume calculation.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Dictionary with per-domain volume and atom count results.
    """
    import openmc

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    log_progress(f"Loading OpenMC model from {working_dir}")
    materials, geometry, settings = load_model(working_dir)

    # Build throw-away domains (only the IDs are used by OpenMC)
    domain_ids = [int(v) for v in args.domain_ids.split(",")]
    if args.domain_type == "cell":
        domains = [openmc.Cell(uid) for uid in domain_ids]
    elif args.domain_type == "material":
        domains = [openmc.Material(uid) for uid in domain_ids]
    else:
        domains = [openmc.Universe(uid) for uid in domain_ids]

    lower_left = _parse_vector(args.lower_left) if args.lower_left else None
    upper_right = _parse_vector(args.upper_right) if args.upper_right else None

    log_progress(
        f"Setting up volume calculation: {len(domain_ids)} {args.domain_type} domain(s), {args.samples} samples"
    )
    vol_calc = openmc.VolumeCalculation(domains, args.samples, lower_left, upper_right)

    if args.trigger_type:
        threshold = args.trigger_threshold if args.trigger_threshold is not None else 0.01
        log_progress(f"Trigger: {args.trigger_type} threshold={threshold}")
        vol_calc.set_trigger(threshold, args.trigger_type)

    settings.volume_calculations = [vol_calc]

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)

    log_progress("Running stochastic volume calculation...")
    model.calculate_volumes(apply_volumes=False, export_model_xml=False)

    log_progress("Loading results from volume_1.h5")
    vol_calc.load_results("volume_1.h5")

    results = []
    for domain_id in vol_calc.ids:
        volume = vol_calc.volumes.get(domain_id)
        atoms = vol_calc.atoms.get(domain_id, {})
        results.append(
            {
                "id": int(domain_id),
                "volume": float(volume.nominal_value) if volume is not None else 0.0,
                "stdDev": float(volume.std_dev) if volume is not None else 0.0,
                "atoms": {
                    name: {"value": float(count.nominal_value), "stdDev": float(count.std_dev)}
                    for name, count in atoms.items()
                },
            }
        )
        log_progress(
            f"  {args.domain_type} {domain_id}: volume = {results[-1]['volume']:.6g} +/- {results[-1]['stdDev']:.3g} cm3"
        )

    return {
        "success": True,
        "results": results,
        "volumeFile": str(working_dir / "volume_1.h5"),
    }


def main():
    """Entry point: parse arguments, run the calculation, print JSON result."""
    parser = argparse.ArgumentParser(description="OpenMC stochastic volume calculation runner")
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--domain-type", required=True, choices=["cell", "material", "universe"], help="Domain type"
    )
    parser.add_argument("--domain-ids", required=True, help="Comma-separated domain IDs")
    parser.add_argument("--samples", type=int, required=True, help="Number of samples")
    parser.add_argument("--lower-left", help="Bounding box lower-left as X,Y,Z")
    parser.add_argument("--upper-right", help="Bounding box upper-right as X,Y,Z")
    parser.add_argument(
        "--trigger-type", choices=["std_dev", "variance", "rel_err"], help="Trigger type"
    )
    parser.add_argument("--trigger-threshold", type=float, help="Trigger threshold value")

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
        result = run_volume_calc(args)
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
