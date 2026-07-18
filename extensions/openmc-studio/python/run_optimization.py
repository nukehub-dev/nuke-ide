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

import json
import os
import sys
import time
from typing import Any

import openmc


def set_parameter_by_path(model: openmc.Model, path: str, value: Any) -> None:
    """Set a model parameter by its dot-separated path.

    Traverses the OpenMC model hierarchy using dot notation and
    numeric indices (e.g., 'materials.0.density') to locate the
    target attribute and overwrite its value.

    Args:
        model: OpenMC model object to modify.
        path: Dot-separated path to the parameter (e.g., 'materials.0.density').
        value: New value to assign.
    """
    parts = path.split(".")
    obj = model

    for part in parts[:-1]:
        if part.isdigit():
            obj = obj[int(part)]
        else:
            obj = getattr(obj, part)

    setattr(obj, parts[-1], value)


def get_parameter_by_path(model: openmc.Model, path: str) -> Any:
    """Get a model parameter value by its dot-separated path.

    Traverses the OpenMC model hierarchy using dot notation and
    numeric indices (e.g., 'settings.batches') to retrieve the
    target attribute value.

    Args:
        model: OpenMC model object to query.
        path: Dot-separated path to the parameter.

    Returns:
        The current value of the specified parameter.
    """
    parts = path.split(".")
    obj = model

    for part in parts:
        if part.isdigit():
            obj = obj[int(part)]
        else:
            obj = getattr(obj, part)

    return obj


def run_single_iteration(
    base_model: openmc.Model, params: dict[str, Any], output_dir: str, iteration: int
) -> dict[str, Any]:
    """Run a single OpenMC iteration with modified parameters.

    Clones the base model, applies the requested parameter changes,
    exports XML, runs the simulation, and extracts k-effective and
    tally results from the generated statepoint.

    Args:
        base_model: Base OpenMC model to clone.
        params: Mapping of parameter paths to values to apply.
        output_dir: Root output directory for all iterations.
        iteration: Iteration index (used for naming the sub-directory).

    Returns:
        Dictionary with iteration results including keff, std dev,
        execution time, success flag, and statepoint path.
    """
    start_time = time.time()

    # Create iteration directory
    iter_dir = os.path.join(output_dir, f"iteration_{iteration}")
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
            "iteration": iteration,
            "parameterValues": params,
            "keff": sp.keff.nominal_value,
            "keffStd": sp.keff.std_dev,
            "executionTime": execution_time,
            "success": True,
            "statepointPath": str(statepoint_path),
        }

        # Extract tally results if available
        tallies = {}
        for tally_id, tally in sp.tallies.items():
            if hasattr(tally, "mean") and tally.mean.size > 0:
                tallies[str(tally_id)] = float(tally.mean)

        if tallies:
            result["tallies"] = tallies

        sp.close()

        return result

    except Exception as e:
        execution_time = time.time() - start_time
        return {
            "iteration": iteration,
            "parameterValues": params,
            "keff": None,
            "keffStd": None,
            "executionTime": execution_time,
            "success": False,
            "errorMessage": str(e),
            "statepointPath": None,
        }


def run_optimization_batch(config_path: str, output_dir: str) -> dict[str, Any]:
    """Run a complete parameter-sweep (optimization) batch.

    Loads the sweep configuration, builds the base OpenMC model from
    serialized XML state, generates all parameter combinations, and
    runs each iteration sequentially. Results are written to
    'optimization_results.json' in the output directory.

    Args:
        config_path: Path to the JSON configuration file defining sweeps.
        output_dir: Directory for iteration sub-folders and summary JSON.

    Returns:
        Dictionary with batch summary including runId, total/completed/failed
        iteration counts, and per-iteration results.
    """
    # Load configuration
    with open(config_path) as f:
        config = json.load(f)

    base_state = config["baseState"]
    sweeps = config["sweeps"]
    run_id = config["runId"]

    # Create base model from state
    materials = openmc.Materials.from_xml_string(base_state["materials"])
    geometry = openmc.Geometry.from_xml_string(base_state["geometry"])
    settings = openmc.Settings.from_xml_string(base_state["settings"])

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

        if result["success"]:
            print(f"  Completed: keff = {result['keff']:.6f} ± {result['keffStd']:.6f}")
        else:
            print(f"  Failed: {result['errorMessage']}")

    # Save results summary
    summary = {
        "runId": run_id,
        "totalIterations": total_iterations,
        "completedIterations": len([r for r in results if r["success"]]),
        "failedIterations": len([r for r in results if not r["success"]]),
        "results": results,
    }

    summary_path = os.path.join(output_dir, "optimization_results.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"Optimization complete. Results saved to {summary_path}")

    return summary


def generate_parameter_combinations(sweeps: list) -> list:
    """Generate the Cartesian product of all sweep parameter values.

    Args:
        sweeps: List of sweep configurations, each with a 'variable' key.

    Returns:
        List of dictionaries, where each dictionary maps variable names
        to a specific value for one iteration.
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
                new_combo[sweep["variable"]] = value
                new_combinations.append(new_combo)

        combinations = new_combinations

    return combinations


def compute_sweep_values(sweep: dict[str, Any]) -> list:
    """Compute sweep values based on range type (linear or logarithmic).

    Args:
        sweep: Sweep configuration with keys 'rangeType', 'startValue',
            'endValue', and 'numPoints'.

    Returns:
        List of computed values spanning from start to end.
    """
    range_type = sweep["rangeType"]
    start = sweep["startValue"]
    end = sweep["endValue"]
    num_points = sweep["numPoints"]

    if num_points < 2:
        return [start]

    if range_type == "linear":
        step = (end - start) / (num_points - 1)
        return [start + step * i for i in range(num_points)]
    else:  # logarithmic
        import math

        log_start = math.log10(start)
        log_end = math.log10(end)
        step = (log_end - log_start) / (num_points - 1)
        return [10 ** (log_start + step * i) for i in range(num_points)]


def main():
    """Main entry point for CLI usage.

    Validates arguments, loads the sweep configuration, and dispatches
    to run_optimization_batch.
    """
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


if __name__ == "__main__":
    main()
