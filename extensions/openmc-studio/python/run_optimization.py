#!/usr/bin/env python3
"""
OpenMC Parameter Sweep Runner

This script runs OpenMC simulations with varying parameter values
to perform optimization studies and parameter sweeps.

Usage:
    python run_optimization.py <config_path> <output_dir>

Arguments:
    config_path: Path to JSON configuration file
    output_dir: Directory for output files
"""

import openmc
import json
import sys
import os
import time
from pathlib import Path
from typing import Dict, Any, Optional


def set_parameter_by_path(model: openmc.Model, path: str, value: Any) -> None:
    """
    Set a parameter by its JSON path (e.g., 'materials.0.density').
    
    Args:
        model: OpenMC model object
        path: JSON path to the parameter
        value: Value to set
    """
    parts = path.split('.')
    obj = model
    
    for part in parts[:-1]:
        if part.isdigit():
            obj = obj[int(part)]
        else:
            obj = getattr(obj, part)
    
    setattr(obj, parts[-1], value)


def get_parameter_by_path(model: openmc.Model, path: str) -> Any:
    """
    Get a parameter value by its JSON path.
    
    Args:
        model: OpenMC model object
        path: JSON path to the parameter
        
    Returns:
        The parameter value
    """
    parts = path.split('.')
    obj = model
    
    for part in parts:
        if part.isdigit():
            obj = obj[int(part)]
        else:
            obj = getattr(obj, part)
    
    return obj


def run_single_iteration(
    base_model: openmc.Model,
    params: Dict[str, Any],
    output_dir: str,
    iteration: int
) -> Dict[str, Any]:
    """
    Run a single OpenMC iteration with modified parameters.
    
    Args:
        base_model: Base OpenMC model
        params: Parameter values to apply
        output_dir: Output directory
        iteration: Iteration number
        
    Returns:
        Dictionary with results
    """
    start_time = time.time()
    
    # Create iteration directory
    iter_dir = os.path.join(output_dir, f'iteration_{iteration}')
    os.makedirs(iter_dir, exist_ok=True)
    
    try:
        # Create a copy of the model for this iteration
        model = base_model.clone()
        
        # Apply parameter modifications
        for path, value in params.items():
            set_parameter_by_path(model, path, value)
        
        # Export XML files
        model.export_to_xml(path=iter_dir)
        
        # Run simulation
        statepoint_path = model.run(output_dir=iter_dir, cwd=iter_dir)
        
        # Extract results from statepoint
        sp = openmc.StatePoint(statepoint_path)
        
        execution_time = time.time() - start_time
        
        result = {
            'iteration': iteration,
            'parameterValues': params,
            'keff': sp.keff.nominal_value,
            'keffStd': sp.keff.std_dev,
            'executionTime': execution_time,
            'success': True,
            'statepointPath': str(statepoint_path)
        }
        
        # Extract tally results if available
        tallies = {}
        for tally_id, tally in sp.tallies.items():
            if hasattr(tally, 'mean') and tally.mean.size > 0:
                tallies[str(tally_id)] = float(tally.mean)
        
        if tallies:
            result['tallies'] = tallies
        
        sp.close()
        
        return result
        
    except Exception as e:
        execution_time = time.time() - start_time
        return {
            'iteration': iteration,
            'parameterValues': params,
            'keff': None,
            'keffStd': None,
            'executionTime': execution_time,
            'success': False,
            'errorMessage': str(e),
            'statepointPath': None
        }


def run_optimization_batch(
    config_path: str,
    output_dir: str
) -> Dict[str, Any]:
    """
    Run a complete optimization batch.
    
    Args:
        config_path: Path to configuration JSON
        output_dir: Output directory
        
    Returns:
        Dictionary with batch results
    """
    # Load configuration
    with open(config_path, 'r') as f:
        config = json.load(f)
    
    base_state = config['baseState']
    sweeps = config['sweeps']
    run_id = config['runId']
    
    # Create base model from state
    materials = openmc.Materials.from_xml_string(base_state['materials'])
    geometry = openmc.Geometry.from_xml_string(base_state['geometry'])
    settings = openmc.Settings.from_xml_string(base_state['settings'])
    
    model = openmc.Model(geometry, materials, settings)
    
    # Generate all parameter combinations
    combinations = generate_parameter_combinations(sweeps)
    
    results = []
    total_iterations = len(combinations)
    
    print(f"Starting optimization run {run_id}")
    print(f"Total iterations: {total_iterations}")
    
    for i, params in enumerate(combinations, 1):
        print(f"Running iteration {i}/{total_iterations}...", flush=True)
        
        result = run_single_iteration(model, params, output_dir, i)
        results.append(result)
        
        if result['success']:
            print(f"  Completed: keff = {result['keff']:.6f} ± {result['keffStd']:.6f}")
        else:
            print(f"  Failed: {result['errorMessage']}")
    
    # Save results summary
    summary = {
        'runId': run_id,
        'totalIterations': total_iterations,
        'completedIterations': len([r for r in results if r['success']]),
        'failedIterations': len([r for r in results if not r['success']]),
        'results': results
    }
    
    summary_path = os.path.join(output_dir, 'optimization_results.json')
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    
    print(f"Optimization complete. Results saved to {summary_path}")
    
    return summary


def generate_parameter_combinations(sweeps: list) -> list:
    """
    Generate all parameter combinations from sweep definitions.
    
    Args:
        sweeps: List of sweep configurations
        
    Returns:
        List of parameter dictionaries
    """
    if not sweeps:
        return [{}]
    
    combinations = [{}]
    
    for sweep in sweeps:
        values = compute_sweep_values(sweep)
        new_combinations = []
        
        for combo in combinations:
            for value in values:
                new_combo = combo.copy()
                new_combo[sweep['variable']] = value
                new_combinations.append(new_combo)
        
        combinations = new_combinations
    
    return combinations


def compute_sweep_values(sweep: Dict[str, Any]) -> list:
    """
    Compute sweep values based on range type.
    
    Args:
        sweep: Sweep configuration
        
    Returns:
        List of values
    """
    range_type = sweep['rangeType']
    start = sweep['startValue']
    end = sweep['endValue']
    num_points = sweep['numPoints']
    
    if num_points < 2:
        return [start]
    
    if range_type == 'linear':
        step = (end - start) / (num_points - 1)
        return [start + step * i for i in range(num_points)]
    else:  # logarithmic
        import math
        log_start = math.log10(start)
        log_end = math.log10(end)
        step = (log_end - log_start) / (num_points - 1)
        return [10 ** (log_start + step * i) for i in range(num_points)]


def main():
    """Main entry point."""
    if len(sys.argv) < 3:
        print("Usage: python run_optimization.py <config_path> <output_dir>")
        sys.exit(1)
    
    config_path = sys.argv[1]
    output_dir = sys.argv[2]
    
    if not os.path.exists(config_path):
        print(f"Error: Configuration file not found: {config_path}")
        sys.exit(1)
    
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        result = run_optimization_batch(config_path, output_dir)
        print(json.dumps(result))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
