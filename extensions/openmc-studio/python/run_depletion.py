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
    --solver SOLVER         Depletion solver (cecm, epc, predictor, cecmr, epcr, si-cesc, leqi)
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


def log_progress(message: str):
    """Print progress message to stderr for real-time communication."""
    print(f"{message}", file=sys.stderr, flush=True)


def run_depletion(args):
    """Run OpenMC depletion simulation."""
    import openmc
    import openmc.deplete
    import numpy as np

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    log_progress(f"Loading OpenMC model from {working_dir}")

    # Load the model from XML files
    try:
        import xml.etree.ElementTree as ET
        
        materials = openmc.Materials.from_xml('materials.xml')
        geometry = openmc.Geometry.from_xml('geometry.xml', materials)
        
        # Load meshes from tallies.xml first (needed for weight windows)
        meshes = {}
        if os.path.exists('tallies.xml'):
            try:
                tallies_tree = ET.parse('tallies.xml')
                tallies_root = tallies_tree.getroot()
                
                # Load meshes the same way OpenMC does
                for mesh_elem in tallies_root.findall('mesh'):
                    mesh_type = mesh_elem.get('type')
                    mesh_id = int(mesh_elem.get('id'))
                    
                    if mesh_type == 'regular':
                        mesh = openmc.RegularMesh.from_xml_element(mesh_elem)
                    elif mesh_type == 'cylindrical':
                        mesh = openmc.CylindricalMesh.from_xml_element(mesh_elem)
                    elif mesh_type == 'spherical':
                        mesh = openmc.SphericalMesh.from_xml_element(mesh_elem)
                    else:
                        continue
                    
                    meshes[mesh_id] = mesh
                    
            except Exception as e:
                log_progress(f"Warning: Could not load meshes from tallies.xml: {e}")
        
        # Load settings with meshes dictionary
        settings_tree = ET.parse('settings.xml')
        settings_root = settings_tree.getroot()
        settings = openmc.Settings.from_xml_element(settings_root, meshes)
        
    except Exception as e:
        log_progress(f"Error loading XML files: {e}")
        raise

    # Load depletion chain
    chain_file = args.chain_file or os.environ.get('OPENMC_DEPLETION_CHAIN')
    if not chain_file:
        # Try to find a default chain file
        chain_file = os.environ.get('OPENMC_CROSS_SECTIONS', '').replace('.h5', '_chain.xml')
        if not os.path.exists(chain_file):
            chain_file = None

    if not chain_file or not os.path.exists(chain_file):
        raise FileNotFoundError(
            f"Depletion chain file not found: {chain_file}. "
            "Set --chain-file or OPENMC_DEPLETION_CHAIN environment variable."
        )

    log_progress(f"Loading depletion chain from {chain_file}")

    # Parse time steps
    time_steps_str = args.time_steps
    time_steps = [float(t.strip()) for t in time_steps_str.split(',')]

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
            log_progress(f"Calculated total power from density: {total_power:.2f} W "
                        f"({args.power_density} W/g * {total_mass_g:.2f} g)")
        else:
            raise ValueError("Power density specified but no depletable materials with volumes found")
    
    if total_power is None:
        raise ValueError("Either --power or --power-density must be specified")

    log_progress(f"Time steps: {time_steps} seconds")
    log_progress(f"Power: {total_power:.2f} W")
    log_progress(f"Solver: {args.solver}")
    log_progress(f"Operator: {args.operator}")

    # Create the model
    model = openmc.model.Model(geometry=geometry, materials=materials, settings=settings)

    # Create the operator
    if args.operator == 'coupled':
        log_progress("Creating CoupledOperator...")
        chain = openmc.deplete.Chain.from_xml(chain_file)
        operator = openmc.deplete.CoupledOperator(
            model,
            chain,
            normalization_mode=args.normalization or 'fission-q'
        )
    elif args.operator == 'independent':
        log_progress("Creating IndependentOperator...")
        # For independent operator, we need to provide flux data
        raise NotImplementedError(
            "Independent operator requires pre-computed flux data. "
            "Use 'coupled' operator instead."
        )
    else:  # openmc (default)
        log_progress("Creating OpenMC operator...")
        chain = openmc.deplete.Chain.from_xml(chain_file)
        operator = openmc.deplete.CoupledOperator(
            model,
            chain,
            normalization_mode=args.normalization or 'fission-q'
        )

    # Create the integrator (solver)
    # Map solver names to OpenMC integrator class names
    solver_name_map = {
        'cecm': 'CECMIntegrator',
        'epc': 'EPCIntegrator',
        'predictor': 'PredictorIntegrator',
        'cecmr': 'CECMRIntegrator',
        'epcr': 'EPCRIntegrator',
        'si-cesc': 'SICESCIntegrator',
        'leqi': 'LEQIIntegrator',
    }
    
    solver = args.solver or 'cecm'
    class_name = solver_name_map.get(solver.lower())
    
    if class_name is None:
        available_solvers = list(solver_name_map.keys())
        raise ValueError(f"Unknown solver: {solver}. Available: {available_solvers}")
    
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
        with h5py.File('depletion_results.h5', 'a') as f:
            # Create burnup dataset if it doesn't exist
            if 'burnup' not in f:
                # Calculate burnup in MWd/kg for each timestep
                burnup_data = np.array(burnup_mwd_kg, dtype=np.float64)
                f.create_dataset('burnup', data=burnup_data)
                log_progress(f"Added burnup dataset to depletion_results.h5")
    except Exception as e:
        log_progress(f"Warning: Could not add burnup to HDF5: {e}")

    # Return summary (visualizer reads from depletion_results.h5 directly)
    summary = {
        'success': True,
        'timeSteps': time_steps,
        'burnupMWdPerKg': burnup_mwd_kg,
        'power': total_power,
        'solver': solver,
        'operator': args.operator
    }

    return summary


def main():
    parser = argparse.ArgumentParser(
        description='Run OpenMC depletion simulation',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_depletion.py /path/to/simulation --chain-file /path/to/chain.xml --time-steps 86400,86400 --power 1e6
        """
    )

    parser.add_argument('working_directory', help='Directory containing XML files')
    parser.add_argument('--chain-file', help='Path to depletion chain XML file')
    parser.add_argument('--time-steps', required=True, help='Comma-separated time steps in seconds')
    parser.add_argument('--power', type=float, help='Power level in Watts')
    parser.add_argument('--power-density', type=float, help='Power density in W/g (alternative to --power)')
    parser.add_argument('--solver', default='cecm',
                        choices=['cecm', 'epc', 'predictor', 'cecmr', 'epcr', 'si-cesc', 'leqi'],
                        help='Depletion solver method')
    parser.add_argument('--operator', default='coupled',
                        choices=['coupled', 'independent', 'openmc'],
                        help='Depletion operator type')
    parser.add_argument('--substeps', type=int, default=1,
                        help='Number of substeps per timestep')
    parser.add_argument('--normalization', default='fission-q',
                        choices=['source-rate', 'fission-q', 'energy-deposition'],
                        help='Transport normalization mode')
    parser.add_argument('--mpi-processes', type=int,
                        help='Number of MPI processes')

    args = parser.parse_args()

    try:
        result = run_depletion(args)
        print(json.dumps(result))
        return 0
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        error_result = {
            'success': False,
            'error': str(e)
        }
        print(json.dumps(error_result))
        return 1


if __name__ == '__main__':
    sys.exit(main())
