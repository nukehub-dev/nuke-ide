#!/usr/bin/env python3
"""
OpenMC Depletion Runner

This script runs OpenMC depletion simulations using the Python API.
It is designed to be called from the OpenMC Studio simulation runner.

Usage:
    python run_depletion.py <working_directory> [options]

Options:
    --chain-file PATH       Path to depletion chain file
    --time-steps STEPS      Comma-separated time steps in seconds
    --power POWER           Power level in Watts
    --power-density DENSITY Power density in W/g (alternative to --power)
    --solver SOLVER         Depletion solver (cecm, predictor, cf4, celi, epc_rk4, leqi, si_celi, si_leqi)
    --operator TYPE         Operator type (coupled, independent, openmc)
    --substeps N            Number of substeps per timestep
    --normalization MODE    Transport normalization mode (source-rate, fission-q, energy-deposition)
    --mpi-processes N       Number of MPI processes (for coupled operator)
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

# Canonical solver ids are the OpenMC short names from
# openmc/deplete/integrators.py `integrator_by_name` (identical in 0.15.3 and
# the dev clone). Mirrored by src/common/depletion-solvers.ts.
SOLVER_CLASS_MAP = {
    "cecm": "CECMIntegrator",
    "predictor": "PredictorIntegrator",
    "cf4": "CF4Integrator",
    "celi": "CELIIntegrator",
    "epc_rk4": "EPCRK4Integrator",
    "leqi": "LEQIIntegrator",
    "si_celi": "SICELIIntegrator",
    "si_leqi": "SILEQIIntegrator",
}

# Legacy names accepted with a deprecation warning (pre-fix UI values and
# pre-fix driver ids); never emitted.
SOLVER_ALIASES = {
    "leapfrog": "leqi",
    "predictor-corrector": "predictor",
    "si-rk4": "si_celi",
    "ce-cm": "cecm",
    "epc": "epc_rk4",
    "cecmr": "cecm",
    "epcr": "epc_rk4",
    "si-cesc": "si_celi",
}


def resolve_solver(value):
    """Map a --solver value to a canonical solver id (aliases → warning)."""
    solver = (value or "cecm").lower()
    if solver in SOLVER_CLASS_MAP:
        return solver
    if solver in SOLVER_ALIASES:
        canonical = SOLVER_ALIASES[solver]
        log_progress(f"Warning: solver '{solver}' is deprecated, use '{canonical}' instead")
        return canonical
    available = ", ".join(SOLVER_CLASS_MAP)
    raise ValueError(f"Unknown solver: {solver}. Available: {available}")


def log_progress(message: str):
    """Print progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def run_depletion(args):
    """Run an OpenMC depletion simulation.

    Loads the model from XML files in the working directory, creates the
    depletion operator and integrator, and runs the burnup calculation.

    Args:
        args: Parsed command-line arguments containing working_directory,
            chain_file, time_steps, power, power_density, solver, operator,
            substeps, normalization, and mpi_processes.

    Returns:
        Dictionary with simulation summary including time steps, burnup,
        power, solver, and operator type.

    Raises:
        FileNotFoundError: If the depletion chain file is missing.
        ValueError: If neither power nor power-density is specified.
        NotImplementedError: If the independent operator is requested.
    """
    import numpy as np
    import openmc
    import openmc.deplete

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    log_progress(f"Loading OpenMC model from {working_dir}")

    # Load the model from XML files
    try:
        import xml.etree.ElementTree as ET

        materials = openmc.Materials.from_xml("materials.xml")
        geometry = openmc.Geometry.from_xml("geometry.xml", materials)

        # Load meshes from tallies.xml first (needed for weight windows)
        meshes = {}
        if os.path.exists("tallies.xml"):
            try:
                tallies_tree = ET.parse("tallies.xml")
                tallies_root = tallies_tree.getroot()

                # Load meshes the same way OpenMC does
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

        # Load settings with meshes dictionary
        settings_tree = ET.parse("settings.xml")
        settings_root = settings_tree.getroot()
        settings = openmc.Settings.from_xml_element(settings_root, meshes)

    except Exception as e:
        log_progress(f"Error loading XML files: {e}")
        raise

    # Load depletion chain
    chain_file = args.chain_file or os.environ.get("OPENMC_CHAIN_FILE")
    if not chain_file:
        # Try to find a default chain file
        chain_file = os.environ.get("OPENMC_CROSS_SECTIONS", "").replace(".h5", "_chain.xml")
        if not os.path.exists(chain_file):
            chain_file = None

    if not chain_file or not os.path.exists(chain_file):
        raise FileNotFoundError(
            f"Depletion chain file not found: {chain_file}. "
            "Set --chain-file or OPENMC_CHAIN_FILE environment variable."
        )

    log_progress(f"Loading depletion chain from {chain_file}")

    # Parse time steps
    time_steps_str = args.time_steps
    time_steps = [float(t.strip()) for t in time_steps_str.split(",")]

    # Calculate total mass of depletable materials (needed for burnup calculation)
    total_mass_g = 0.0
    for mat in materials:
        if mat.depletable:
            # Get volume from material (assuming cm^3)
            volume = mat.volume
            if volume is None:
                log_progress(f"Warning: Material {mat.name} is depletable but has no volume set")
                continue
            # Calculate mass in grams: density (g/cm^3) * volume (cm^3)
            mass_g = mat.density * volume
            total_mass_g += mass_g
            log_progress(f"Material {mat.name}: {mass_g:.2f} g")

    # Calculate total power from power density if needed
    total_power = args.power
    if total_power is None and args.power_density is not None:
        if total_mass_g > 0:
            total_power = args.power_density * total_mass_g
            log_progress(
                f"Calculated total power from density: {total_power:.2f} W "
                f"({args.power_density} W/g * {total_mass_g:.2f} g)"
            )
        else:
            raise ValueError(
                "Power density specified but no depletable materials with volumes found"
            )

    if total_power is None:
        raise ValueError("Either --power or --power-density must be specified")

    log_progress(f"Time steps: {time_steps} seconds")
    log_progress(f"Power: {total_power:.2f} W")
    log_progress(f"Solver: {args.solver}")
    log_progress(f"Operator: {args.operator}")

    # Create the model
    if not geometry.root_universe:
        log_progress("Warning: Geometry has no root universe. Creating a dummy one for DAGMC mode.")
        root_univ = openmc.Universe(universe_id=0, name="root universe")
        geometry.root_universe = root_univ

    model = openmc.model.Model(geometry=geometry, materials=materials, settings=settings)

    # Parse structured options
    fission_q = json.loads(args.fission_q) if getattr(args, "fission_q", None) else None
    transfer_rates = (
        json.loads(args.transfer_rates) if getattr(args, "transfer_rates", None) else []
    )

    # Create the operator
    chain = openmc.deplete.Chain.from_xml(chain_file)
    if args.operator == "independent":
        operator = build_independent_operator(args, model, materials, chain, fission_q)
    else:
        log_progress("Creating CoupledOperator...")
        # Only pass W6 kwargs when enabled to keep the default call shape stable
        coupled_kwargs = {"normalization_mode": args.normalization or "fission-q"}
        if getattr(args, "diff_burnable_mats", False):
            coupled_kwargs["diff_burnable_mats"] = True
            coupled_kwargs["diff_volume_method"] = getattr(
                args, "diff_volume_method", "divide equally"
            )
        if fission_q is not None:
            coupled_kwargs["fission_q"] = fission_q
        operator = openmc.deplete.CoupledOperator(model, chain, **coupled_kwargs)

    # Create the integrator (solver) — canonical ids from
    # integrator_by_name; legacy aliases resolve with a deprecation warning
    solver = resolve_solver(args.solver)
    class_name = SOLVER_CLASS_MAP[solver]

    integrator_class = getattr(openmc.deplete, class_name, None)

    if integrator_class is None:
        raise ValueError(f"OpenMC deplete module does not have class: {class_name}")

    log_progress(f"Creating {solver.upper()} integrator...")

    # Create integrator
    integrator = integrator_class(
        operator,
        time_steps,
        power=total_power,
    )

    # Apply external transfer rates (Integrator.add_transfer_rate)
    for tr in transfer_rates:
        units = tr.get("units", "1/s")
        destination = tr.get("destinationMaterial")
        log_progress(
            f"Transfer rate: {tr['element']} from material {tr['material']} at {tr['rate']} {units}"
            + (f" to material {destination}" if destination else "")
        )
        integrator.add_transfer_rate(
            tr["material"],
            [tr["element"]],
            tr["rate"],
            transfer_rate_units=units,
            destination_material=destination,
        )

    # Run depletion
    log_progress("Starting depletion simulation...")

    try:
        # The integrate() method runs the full depletion
        integrator.integrate()
        log_progress("=" * 60)
        log_progress("Depletion simulation completed successfully!")
    except Exception as e:
        log_progress(f"Error during depletion: {e}")
        traceback.print_exc(file=sys.stderr)
        raise

    # Output summary
    log_progress("Depletion results saved to depletion_results.h5")

    # Calculate burnup for each timestep (MWd/kg)
    # Burnup = Power (W) * Time (days) / Mass (kg) / 1e6
    # Convert seconds to days: 1 day = 86400 seconds
    cumulative_time_days = np.cumsum([t / 86400.0 for t in time_steps])
    total_mass_kg = total_mass_g / 1000.0

    # Calculate burnup in MWd/kg
    burnup_mwd_kg = []
    for days in cumulative_time_days:
        # Energy in MWd: Power (W) * days / 1e6
        energy_mwd = (total_power * days) / 1e6
        # Burnup: Energy (MWd) / Mass (kg)
        burnup = energy_mwd / total_mass_kg if total_mass_kg > 0 else 0
        burnup_mwd_kg.append(burnup)

    log_progress(f"Final burnup: {burnup_mwd_kg[-1]:.2f} MWd/kg")

    # Add burnup dataset to the depletion results file for visualization
    try:
        import h5py

        with h5py.File("depletion_results.h5", "a") as f:
            # Create burnup dataset if it doesn't exist
            if "burnup" not in f:
                # Calculate burnup in MWd/kg for each timestep
                burnup_data = np.array(burnup_mwd_kg, dtype=np.float64)
                f.create_dataset("burnup", data=burnup_data)
                log_progress("Added burnup dataset to depletion_results.h5")
    except Exception as e:
        log_progress(f"Warning: Could not add burnup to HDF5: {e}")

    # Return summary (visualizer reads from depletion_results.h5 directly)
    summary = {
        "success": True,
        "timeSteps": time_steps,
        "burnupMWdPerKg": burnup_mwd_kg,
        "power": total_power,
        "solver": solver,
        "operator": args.operator,
    }

    return summary


def load_flux_file(path):
    """Load a flux array from a .npy or delimiter-separated text file.

    Args:
        path: Path to the flux file (.npy, .csv, or whitespace-separated text).

    Returns:
        numpy.ndarray with the group fluxes.
    """
    import numpy as np

    if str(path).endswith(".npy"):
        return np.load(path)
    return np.loadtxt(path, delimiter="," if str(path).endswith(".csv") else None)


def build_independent_operator(args, model, materials, chain, fission_q):
    """Create an IndependentOperator from file inputs or a model transport solve.

    Args:
        args: Parsed command-line arguments.
        model: The loaded openmc.Model.
        materials: Loaded openmc.Materials.
        chain: Loaded openmc.deplete.Chain.
        fission_q: Optional custom fission Q dictionary.

    Returns:
        openmc.deplete.IndependentOperator instance.

    Raises:
        ValueError: If no depletable materials exist or the file inputs do not
            match the depletable material count.
    """
    import openmc

    depletable = [m for m in materials if m.depletable]
    if not depletable:
        raise ValueError("Independent operator requires at least one depletable material")

    if getattr(args, "generate_microxs", False):
        log_progress(
            "Computing multigroup fluxes and cross sections via transport solve (this may take a while)..."
        )
        fluxes, micros = openmc.deplete.get_microxs_and_flux(model, depletable, chain_file=chain)
    else:
        flux_files = (
            [f.strip() for f in args.flux_files.split(",")]
            if getattr(args, "flux_files", None)
            else []
        )
        microxs_files = (
            [f.strip() for f in args.microxs_files.split(",")]
            if getattr(args, "microxs_files", None)
            else []
        )
        if len(flux_files) != len(depletable) or len(microxs_files) != len(depletable):
            raise ValueError(
                f"Independent operator needs one flux file and one MicroXS file per depletable material "
                f"({len(depletable)} needed, got {len(flux_files)} flux and {len(microxs_files)} MicroXS files), "
                "or use --generate-microxs"
            )
        log_progress(f"Loading fluxes and MicroXS for {len(depletable)} depletable material(s)...")
        fluxes = [load_flux_file(f) for f in flux_files]
        micros = [openmc.deplete.MicroXS.from_csv(f) for f in microxs_files]

    log_progress(f"Creating IndependentOperator for {len(depletable)} depletable material(s)...")
    return openmc.deplete.IndependentOperator(
        depletable,
        fluxes,
        micros,
        chain,
        normalization_mode=args.normalization or "fission-q",
        fission_q=fission_q,
    )


def main():
    """Main entry point for CLI usage.

    Parses arguments, runs the depletion simulation, and prints the
    result as JSON to stdout.
    """
    parser = argparse.ArgumentParser(
        description="Run OpenMC depletion simulation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_depletion.py /path/to/simulation --chain-file /path/to/chain.xml --time-steps 86400,86400 --power 1e6
        """,
    )

    parser.add_argument("working_directory", help="Directory containing XML files")
    parser.add_argument("--chain-file", help="Path to depletion chain XML file")
    parser.add_argument("--time-steps", required=True, help="Comma-separated time steps in seconds")
    parser.add_argument("--power", type=float, help="Power level in Watts")
    parser.add_argument(
        "--power-density", type=float, help="Power density in W/g (alternative to --power)"
    )
    parser.add_argument(
        "--solver",
        default="cecm",
        choices=list(SOLVER_CLASS_MAP) + list(SOLVER_ALIASES),
        help="Depletion solver method (OpenMC integrator short name; legacy names map with a warning)",
    )
    parser.add_argument(
        "--operator",
        default="coupled",
        choices=["coupled", "independent", "openmc"],
        help="Depletion operator type",
    )
    parser.add_argument("--substeps", type=int, default=1, help="Number of substeps per timestep")
    parser.add_argument(
        "--normalization",
        default="fission-q",
        choices=["source-rate", "fission-q", "energy-deposition"],
        help="Transport normalization mode",
    )
    parser.add_argument("--mpi-processes", type=int, help="Number of MPI processes")
    parser.add_argument(
        "--flux-files",
        help="Comma-separated flux file paths for the independent operator (one per depletable material)",
    )
    parser.add_argument(
        "--microxs-files",
        help="Comma-separated MicroXS CSV file paths for the independent operator (one per depletable material)",
    )
    parser.add_argument(
        "--generate-microxs",
        action="store_true",
        help="Compute fluxes and micro cross sections from the model via a transport solve",
    )
    parser.add_argument(
        "--transfer-rates",
        help='JSON list of transfer rates: [{"material": 1, "element": "U", "rate": 1e-5, "units": "1/s", "destinationMaterial": 2}]',
    )
    parser.add_argument(
        "--fission-q",
        help='JSON dict of custom fission Q values per nuclide [eV]: {"U235": 2.02e8}',
    )
    parser.add_argument(
        "--diff-burnable-mats",
        action="store_true",
        help="Distinguish burnable materials that share the same composition (higher memory/runtime cost)",
    )
    parser.add_argument(
        "--diff-volume-method",
        choices=["divide equally", "match cell"],
        default="divide equally",
        help="How volumes are assigned to differentiated materials",
    )

    args = parser.parse_args()

    try:
        result = run_depletion(args)
        print(json.dumps(result))
        return 0
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        error_result = {"success": False, "error": str(e)}
        print(json.dumps(error_result))
        return 1


if __name__ == "__main__":
    sys.exit(main())
