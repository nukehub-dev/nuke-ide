#!/usr/bin/env python3
"""OpenMC D1S shutdown-dose driver.

Runs a direct 1-step (D1S) shutdown-dose calculation from generated model XML
plus a JSON configuration written by OpenMC Studio:

1. enable decay photons and prepare photon tallies with a parent-nuclide filter;
2. run one coupled neutron--photon transport calculation;
3. apply time correction factors to the selected photon tallies.

The driver prints one machine-readable JSON object on stdout and streams
progress markers on stderr. Heavy OpenMC imports are lazy.

Usage:
    python run_d1s.py <working_directory> --config <config.json>
"""

import argparse
import json
import math
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

from run_r2s import (
    NumpyEncoder,
    ShutdownDoseConfigError,
    collect_files,
    log_progress,
    normalize_schedule,
    summarize_tally,
)

SUMMARY_FILENAME = "d1s_summary.json"


def _import_openmc():
    """Import OpenMC and the D1S helpers lazily."""
    try:
        import openmc  # noqa: F401
        from openmc.deplete import d1s  # noqa: F401
    except ImportError as exc:
        raise ShutdownDoseConfigError(f"OpenMC 0.16 with D1S support is required: {exc}") from exc
    return openmc, d1s


def _photon_tally_ids(model, requested, openmc_module=None):
    """Resolve selected photon tally IDs, or all photon tallies when empty."""
    if openmc_module is None:
        import openmc as openmc_module

    available = [tally for tally in model.tallies if _has_photon_filter(tally, openmc_module)]
    available_ids = [tally.id for tally in available]
    if requested:
        missing = [
            tally_id
            for tally_id in requested
            if tally_id not in {tally.id for tally in model.tallies}
        ]
        if missing:
            raise ShutdownDoseConfigError(
                f"Photon tally IDs not found in tallies.xml: {', '.join(str(i) for i in missing)}"
            )
        non_photon = [tally_id for tally_id in requested if tally_id not in available_ids]
        if non_photon:
            raise ShutdownDoseConfigError(
                f"Selected tallies do not target photons: {', '.join(str(i) for i in non_photon)}. "
                "Add a particle filter with the photon bin."
            )
        return [int(tally_id) for tally_id in requested]
    if not available_ids:
        raise ShutdownDoseConfigError(
            "No photon tallies are available. Add a photon tally or the dose tally template before running D1S."
        )
    return available_ids


def _has_photon_filter(tally, openmc_module):
    """Whether a tally has a particle filter containing photons."""
    for tally_filter in tally.filters:
        if isinstance(tally_filter, openmc_module.ParticleFilter) and list(tally_filter.bins) == [
            "photon"
        ]:
            return True
    return False


def _normalize_time_index(index, count):
    """Normalize a possibly negative time index and validate the range."""
    normalized = index if index >= 0 else count + index
    if normalized < 0 or normalized >= count:
        raise ShutdownDoseConfigError(
            f"D1S time index {index} is outside the schedule (0..{count - 1})"
        )
    return normalized


def run_d1s(config, working_directory, openmc_module=None, d1s_module=None):
    """Run a D1S calculation and return a JSON-serializable result.

    Args:
        config: Shutdown-dose configuration dictionary.
        working_directory: Directory containing the generated model XML.
        openmc_module: Optional injected OpenMC module for unit tests.
        d1s_module: Optional injected D1S module for unit tests.
    """
    if config.get("method") != "d1s":
        raise ShutdownDoseConfigError("run_d1s.py requires method='d1s'")

    openmc, d1s = (openmc_module, d1s_module)
    if openmc is None or d1s is None:
        openmc, d1s = _import_openmc()

    working_directory = Path(working_directory).resolve()
    if not (working_directory / "geometry.xml").exists():
        raise ShutdownDoseConfigError(
            f"No geometry.xml in {working_directory}; generate the model XML before running D1S"
        )
    chain_file = config.get("chainFile")
    if not chain_file:
        raise ShutdownDoseConfigError("A depletion chain file is required for D1S")
    if not Path(chain_file).exists():
        raise ShutdownDoseConfigError(f"Depletion chain file not found: {chain_file}")

    timesteps, source_rates, timestep_units = normalize_schedule(config)
    requested_ids = [int(tally_id) for tally_id in (config.get("photonTallyIds") or [])]

    os.chdir(working_directory)
    log_progress("d1s", "Loading model from XML", 0.02)
    try:
        model = openmc.Model.from_xml()
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"Could not load the model XML: {exc}") from exc

    tally_ids = _photon_tally_ids(model, requested_ids, openmc)
    model.settings.use_decay_photons = True
    model.settings.photon_transport = True

    warnings = []
    log_progress("d1s", "Finding radionuclides and preparing photon tallies", 0.08)
    try:
        nuclides = d1s.get_radionuclides(model, chain_file)
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"Could not determine D1S radionuclides: {exc}") from exc
    if not nuclides:
        raise ShutdownDoseConfigError(
            "No radionuclides are produced by the current materials and chain. "
            "Check the chain file and material compositions."
        )
    d1s.prepare_tallies(model, nuclides, chain_file)

    output_root = Path(config.get("outputDirectory") or working_directory)
    output_root.mkdir(parents=True, exist_ok=True)
    output_dir = output_root / f"d1s_{datetime.now().strftime('%Y-%m-%dT%H-%M-%S')}"
    output_dir.mkdir(parents=True, exist_ok=True)

    log_progress("d1s", "Running coupled neutron-photon transport", 0.15)
    try:
        with openmc.config.patch("chain_file", chain_file):
            statepoint_path = model.run(cwd=output_dir)
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"D1S transport failed: {exc}") from exc

    count = len(timesteps) + 1
    index = _normalize_time_index(int(config.get("d1sTimeIndex", -1)), count)
    try:
        factors = d1s.time_correction_factors(nuclides, timesteps, source_rates, timestep_units)
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(
            f"Could not compute D1S time correction factors: {exc}"
        ) from exc

    log_progress("d1s", "Applying time correction factors", 0.9)
    tally_summaries = []
    time_correction_factors = {}
    try:
        with openmc.StatePoint(str(statepoint_path)) as statepoint:
            for tally_id in tally_ids:
                tally = statepoint.tallies.get(tally_id)
                if tally is None:
                    warnings.append(f"Tally {tally_id} was not present in the D1S statepoint")
                    continue
                corrected = d1s.apply_time_correction(
                    tally,
                    factors,
                    index,
                    bool(config.get("d1sSumNuclides", True)),
                )
                summary = summarize_tally(corrected)
                summary["parentNuclides"] = [str(nuclide) for nuclide in nuclides]
                summary["summedOverParents"] = bool(config.get("d1sSumNuclides", True))
                tally_summaries.append(summary)
    except ShutdownDoseConfigError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"Could not correct the D1S tallies: {exc}") from exc

    for nuclide in nuclides:
        values = factors.get(nuclide)
        if values is not None:
            time_correction_factors[str(nuclide)] = float(values[index])
    if not config.get("d1sSumNuclides", True):
        warnings.append(
            "Parent-nuclide breakdown retained; the corrected tally still carries the ParentNuclideFilter."
        )

    dose = None
    dose_tally_id = config.get("doseTallyId")
    if dose_tally_id is not None:
        matching = [
            summary for summary in tally_summaries if summary["tallyId"] == int(dose_tally_id)
        ]
        if matching:
            finite = [value for value in matching[-1]["mean"] if math.isfinite(value)]
            if finite:
                dose = {
                    "tallyId": int(dose_tally_id),
                    "timeIndex": index,
                    "peak": max(finite),
                    "mean": sum(finite) / len(finite),
                }

    summary = {
        "method": "d1s",
        "timesteps": config.get("timesteps", []),
        "sourceRates": source_rates,
        "photonTimeIndices": [index],
        "activationRegions": None,
        "photonTallies": len({summary["tallyId"] for summary in tally_summaries}),
        "photonTallySummaries": tally_summaries,
        "timeCorrectionFactors": time_correction_factors,
        "dose": dose,
        "warnings": warnings,
    }

    result = {
        "success": True,
        "outputDirectory": str(output_dir),
        "summary": summary,
        "files": collect_files(output_dir),
        "statepoint": str(statepoint_path),
    }
    (output_dir / SUMMARY_FILENAME).write_text(
        json.dumps(result, cls=NumpyEncoder, indent=2), encoding="utf-8"
    )
    log_progress("done", f"D1S calculation complete: {output_dir}", 1.0)
    return result


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Run an OpenMC D1S shutdown-dose calculation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_d1s.py /path/to/model --config /path/to/shutdown-dose.json
        """,
    )
    parser.add_argument("working_directory", help="Directory containing the generated model XML")
    parser.add_argument("--config", required=True, help="Shutdown-dose configuration JSON")
    args = parser.parse_args()

    try:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        result = run_d1s(config, args.working_directory)
        print(json.dumps(result, cls=NumpyEncoder))
        return 0
    except ShutdownDoseConfigError as exc:
        log_progress("done", f"FAILED: {exc}")
        print(json.dumps({"success": False, "error": str(exc)}))
        return 1
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
