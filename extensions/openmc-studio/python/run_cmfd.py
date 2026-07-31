#!/usr/bin/env python3
"""
OpenMC CMFD Runner

Runs an OpenMC eigenvalue simulation with CMFD (Coarse Mesh Finite Difference)
acceleration through the C API (openmc.cmfd.CMFDRun). It is designed to be
called from the OpenMC Studio simulation runner.

CMFD has no settings.xml representation in this OpenMC version: the transport
inputs (geometry/materials/settings/tallies XML) are read from the working
directory by libopenmc on init, while the CMFD configuration is passed as JSON
on the command line. Run basics (particles/batches/inactive) are read back
from settings.xml only for reporting — libopenmc applies the XML values.

Usage:
    python run_cmfd.py <working_directory> --cmfd-config '<json>'

Options:
    --cmfd-config JSON   CMFD configuration JSON: {"mesh": {"lowerLeft": [...],
                         "upperRight": [...], "dimension": [...], "albedo": [...]},
                         "feedback": bool, "tallyBegin": int, ...} (camelCase keys
                         matching the IDE's OpenMCCmfdSettings)
    --mpi-processes N    Number of MPI processes (requires mpi4py; the launcher
                         is expected to start this script under mpirun -np N)
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def log_progress(message: str):
    """Print progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def _json_safe(obj):
    """Fallback JSON encoder for numpy scalars/arrays (without importing numpy).

    Args:
        obj: Object that failed default JSON serialization.

    Returns:
        A JSON-serializable equivalent.
    """
    if hasattr(obj, "item"):
        return obj.item()
    if hasattr(obj, "tolist"):
        return obj.tolist()
    return str(obj)


def read_run_basics(working_dir):
    """Read run mode/particles/batches from settings.xml for reporting.

    Uses only the standard library so it works before (and without) the
    openmc import. Missing values are simply omitted from the result.

    Args:
        working_dir: Path to the directory containing settings.xml.

    Returns:
        Dictionary with any of runMode, particles, batches, inactive.
    """
    import xml.etree.ElementTree as ET

    basics = {}
    settings_path = Path(working_dir) / "settings.xml"
    if not settings_path.exists():
        return basics

    root = ET.parse(settings_path).getroot()

    def _text(tag):
        elem = root.find(tag)
        return elem.text.strip() if elem is not None and elem.text else None

    run_mode = _text("run_mode")
    if run_mode:
        basics["runMode"] = run_mode
    for tag, key in (("particles", "particles"), ("batches", "batches"), ("inactive", "inactive")):
        value = _text(tag)
        if value is not None:
            try:
                basics[key] = int(value)
            except ValueError:
                pass
    return basics


def apply_cmfd_config(cmfd_run, cmfd_mesh, config):
    """Apply the JSON CMFD configuration to CMFDMesh/CMFDRun instances.

    camelCase keys mirror the IDE's OpenMCCmfdSettings; only keys present in
    the config are assigned so OpenMC defaults apply otherwise.

    Args:
        cmfd_run: openmc.cmfd.CMFDRun instance to configure.
        cmfd_mesh: openmc.cmfd.CMFDMesh instance to configure.
        config: Parsed CMFD configuration dictionary.

    Raises:
        ValueError: If the mesh specification is incomplete or the albedo
            vector is malformed.
    """
    mesh_spec = config.get("mesh") or {}
    lower_left = mesh_spec.get("lowerLeft")
    upper_right = mesh_spec.get("upperRight")
    dimension = mesh_spec.get("dimension")
    if not (lower_left and upper_right and dimension):
        raise ValueError(
            "CMFD mesh specification is incomplete: lowerLeft, upperRight, and dimension are required"
        )
    cmfd_mesh.lower_left = lower_left
    cmfd_mesh.upper_right = upper_right
    cmfd_mesh.dimension = dimension

    albedo = mesh_spec.get("albedo") or [1, 1, 1, 1, 1, 1]
    if len(albedo) != 6:
        raise ValueError(f"CMFD albedo must have 6 entries (one per face), got {len(albedo)}")
    cmfd_mesh.albedo = albedo

    cmfd_run.mesh = cmfd_mesh
    cmfd_run.feedback = bool(config.get("feedback", False))

    # Optional CMFDRun knobs (assigned only when present)
    scalar_knobs = {
        "tallyBegin": "tally_begin",
        "solverBegin": "solver_begin",
        "cmfdKtol": "cmfd_ktol",
        "stol": "stol",
        "norm": "norm",
        "downscatter": "downscatter",
        "powerMonitor": "power_monitor",
        "windowType": "window_type",
        "windowSize": "window_size",
    }
    for json_key, attr in scalar_knobs.items():
        if config.get(json_key) is not None:
            setattr(cmfd_run, attr, config[json_key])

    if config.get("gaussSeidelTolerance") is not None:
        cmfd_run.gauss_seidel_tolerance = list(config["gaussSeidelTolerance"])

    if config.get("runAdjoint"):
        cmfd_run.run_adjoint = True
        if config.get("adjointType") is not None:
            cmfd_run.adjoint_type = config["adjointType"]


def run_cmfd(args):
    """Run an OpenMC simulation with CMFD acceleration.

    Loads the CMFD configuration from --cmfd-config, builds the CMFDMesh and
    CMFDRun objects, and executes the run through the C API. libopenmc reads
    the transport inputs from the XML files in the working directory.

    Args:
        args: Parsed command-line arguments containing working_directory,
            cmfd_config, and mpi_processes.

    Returns:
        Dictionary with success flag, statepoint path, k-eff (when
        extractable), and the applied CMFD/run configuration.

    Raises:
        ValueError: If the CMFD configuration is invalid or the run mode is
            not eigenvalue.
        FileNotFoundError: If settings.xml is missing from the working
            directory.
        ImportError: If MPI was requested but mpi4py is unavailable.
    """
    import openmc
    import openmc.cmfd

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    if not (working_dir / "settings.xml").exists():
        raise FileNotFoundError(
            f"settings.xml not found in {working_dir} — generate XML inputs first"
        )

    config = json.loads(args.cmfd_config)
    basics = read_run_basics(working_dir)

    run_mode = basics.get("runMode")
    if run_mode and run_mode != "eigenvalue":
        raise ValueError(
            f"CMFD acceleration requires eigenvalue run mode (settings.xml has '{run_mode}')"
        )

    log_progress(f"Running with CMFD acceleration in {working_dir}")
    if basics:
        log_progress(
            "Run settings: "
            + ", ".join(
                f"{k}={v}"
                for k, v in (
                    ("particles", basics.get("particles")),
                    ("batches", basics.get("batches")),
                    ("inactive", basics.get("inactive")),
                )
                if v is not None
            )
        )

    # Build the CMFD mesh and run objects
    cmfd_mesh = openmc.cmfd.CMFDMesh()
    cmfd_run = openmc.cmfd.CMFDRun()
    apply_cmfd_config(cmfd_run, cmfd_mesh, config)

    mesh_spec = config.get("mesh") or {}
    log_progress(
        f"CMFD mesh: {mesh_spec.get('dimension')} cells over "
        f"{mesh_spec.get('lowerLeft')} .. {mesh_spec.get('upperRight')}, "
        f"albedo={mesh_spec.get('albedo') or [1, 1, 1, 1, 1, 1]}"
    )
    log_progress(f"CMFD feedback: {'enabled' if config.get('feedback') else 'disabled'}")

    # MPI: the launcher starts this script under mpirun; hand the world
    # communicator to the C API (kwargs are forwarded to openmc.lib.init).
    run_kwargs = {}
    if getattr(args, "mpi_processes", None) and args.mpi_processes > 1:
        try:
            from mpi4py import MPI
        except ImportError as e:
            raise ImportError(
                "MPI requested for CMFD run but mpi4py is not available in this environment"
            ) from e
        run_kwargs["intracomm"] = MPI.COMM_WORLD
        log_progress(f"CMFD run using MPI with {args.mpi_processes} processes")

    log_progress("Starting CMFD-accelerated transport...")
    try:
        cmfd_run.run(**run_kwargs)
        log_progress("=" * 60)
        log_progress("CMFD simulation completed successfully!")
    except Exception as e:
        log_progress(f"Error during CMFD run: {e}")
        traceback.print_exc(file=sys.stderr)
        raise

    # Locate the statepoint written by the run
    statepoints = sorted(working_dir.glob("statepoint*.h5"), key=lambda p: p.stat().st_mtime)
    statepoint_path = str(statepoints[-1]) if statepoints else None
    if statepoint_path:
        log_progress(f"Statepoint written: {statepoint_path}")
    else:
        log_progress("Warning: no statepoint file found after run")

    # Best-effort k-eff extraction from the statepoint
    k_eff = None
    if statepoint_path:
        try:
            with openmc.StatePoint(statepoint_path) as sp:
                keff = sp.keff
                k_eff = {"mean": float(keff.n), "std": float(keff.s)}
            log_progress(f"Final k-effective: {k_eff['mean']:.5f} +/- {k_eff['std']:.5f}")
        except Exception as e:
            log_progress(f"Warning: could not extract k-eff from statepoint: {e}")

    return {
        "success": True,
        "statepoint": statepoint_path,
        "kEff": k_eff,
        "feedback": bool(config.get("feedback", False)),
        "run": basics,
    }


def main():
    """Main entry point for CLI usage.

    Parses arguments, runs the CMFD-accelerated simulation, and prints the
    result as JSON to stdout.
    """
    parser = argparse.ArgumentParser(
        description="Run OpenMC simulation with CMFD acceleration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_cmfd.py /path/to/simulation --cmfd-config '{"mesh": {"lowerLeft": [-10, -10, -10], "upperRight": [10, 10, 10], "dimension": [5, 5, 5]}, "feedback": true}'
        """,
    )

    parser.add_argument("working_directory", help="Directory containing XML files")
    parser.add_argument(
        "--cmfd-config",
        required=True,
        help="CMFD configuration JSON (mesh spec, albedo, feedback, CMFDRun knobs)",
    )
    parser.add_argument("--mpi-processes", type=int, help="Number of MPI processes")

    args = parser.parse_args()

    try:
        result = run_cmfd(args)
        print(json.dumps(result, default=_json_safe))
        return 0
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        error_result = {"success": False, "error": str(e)}
        print(json.dumps(error_result))
        return 1


if __name__ == "__main__":
    sys.exit(main())
