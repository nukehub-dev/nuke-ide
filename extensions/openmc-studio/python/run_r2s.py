#!/usr/bin/env python3
"""OpenMC R2S shutdown-dose driver.

Runs a rigorous 2-step (R2S) shutdown-dose calculation from generated model
XML plus a JSON configuration written by OpenMC Studio:

    neutron transport -> activation -> decay photon source -> photon transport

The driver prints one machine-readable JSON object on stdout and streams
progress markers on stderr. Heavy OpenMC imports are lazy so the module can be
imported by the test suite in the minimal profile.

Usage:
    python run_r2s.py <working_directory> --config <config.json>
"""

import argparse
import copy
import json
import os
import sys
import traceback
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path

PROGRESS_PREFIX = "@@NUKE_PROGRESS@@"
SUMMARY_FILENAME = "r2s_summary.json"
MAX_TALLY_VALUES = 4096
MAX_REGION_SUMMARIES = 200


class ShutdownDoseConfigError(ValueError):
    """User-facing configuration error reported as clean JSON."""


class NumpyEncoder(json.JSONEncoder):
    """JSON encoder for numpy scalars and arrays."""

    def default(self, obj):
        try:
            import numpy as np
        except ImportError:  # pragma: no cover - numpy is a project requirement
            return super().default(obj)
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


def log_progress(step, message, fraction=None):
    """Emit a structured progress marker and a human-readable log line.

    Args:
        step: Driver stage ('neutron', 'activation', 'source', 'photon', 'done').
        message: Progress message.
        fraction: Optional completion fraction in [0, 1].
    """
    payload = {"step": step, "message": message}
    if fraction is not None:
        payload["fraction"] = max(0.0, min(1.0, float(fraction)))
    print(f"{PROGRESS_PREFIX} {json.dumps(payload)}", file=sys.stderr, flush=True)
    print(message, file=sys.stderr, flush=True)


def load_config(path):
    """Load and validate the shutdown-dose JSON configuration."""
    config_path = Path(path)
    if not config_path.exists():
        raise ShutdownDoseConfigError(f"Configuration file not found: {config_path}")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ShutdownDoseConfigError(f"Invalid configuration JSON: {exc}") from exc
    if not isinstance(config, dict):
        raise ShutdownDoseConfigError("Configuration must be a JSON object")
    return config


def _parse_timestep(value, default_unit):
    """Parse one timestep value into (value, unit)."""
    if isinstance(value, bool):
        raise ShutdownDoseConfigError("Timesteps must be positive numbers")
    if isinstance(value, (int, float)):
        parsed = float(value)
        unit = default_unit
    elif isinstance(value, str):
        text = value.strip()
        pieces = text.split()
        if len(pieces) == 1:
            parsed = float(pieces[0])
            unit = default_unit
        elif len(pieces) == 2:
            parsed = float(pieces[0])
            unit = pieces[1].lower()
        else:
            raise ShutdownDoseConfigError(f"Invalid timestep '{value}'")
    else:
        raise ShutdownDoseConfigError(f"Invalid timestep {value!r}")
    if parsed <= 0 or unit not in ("s", "min", "h", "d", "a"):
        raise ShutdownDoseConfigError(f"Invalid timestep '{value}'")
    return parsed, unit


def normalize_schedule(config):
    """Normalize timesteps and source rates into OpenMC's tuple form.

    Returns:
        (timesteps, source_rates, timestep_units) where timesteps is a list of
        (value, unit) tuples accepted by R2SManager and d1s helpers.
    """
    raw_timesteps = config.get("timesteps")
    if not isinstance(raw_timesteps, list) or len(raw_timesteps) == 0:
        raise ShutdownDoseConfigError("At least one timestep is required")

    default_unit = config.get("timestepUnits") or "s"
    if default_unit not in ("s", "min", "h", "d", "a"):
        raise ShutdownDoseConfigError(f"Unsupported timestep unit: {default_unit}")

    timesteps = [_parse_timestep(value, default_unit) for value in raw_timesteps]

    raw_rates = config.get("sourceRates")
    if isinstance(raw_rates, (int, float)) and not isinstance(raw_rates, bool):
        source_rates = [float(raw_rates)] * len(timesteps)
    elif isinstance(raw_rates, list):
        if len(raw_rates) != len(timesteps):
            raise ShutdownDoseConfigError(
                f"sourceRates has {len(raw_rates)} entries but there are {len(timesteps)} timesteps"
            )
        source_rates = [float(rate) for rate in raw_rates]
    else:
        raise ShutdownDoseConfigError("sourceRates must be a number or a list of numbers")

    for rate in source_rates:
        if rate < 0:
            raise ShutdownDoseConfigError("Source rates must be non-negative")
    return timesteps, source_rates, "s"


def normalize_photon_time_indices(config, n_times):
    """Validate and normalize requested photon time indices."""
    raw = config.get("photonTimeIndices")
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) == 0:
        raise ShutdownDoseConfigError("photonTimeIndices must contain at least one index")
    indices = []
    for index in raw:
        if isinstance(index, bool) or not isinstance(index, int):
            raise ShutdownDoseConfigError("photonTimeIndices must contain only integers")
        normalized = index if index >= 0 else n_times + index
        if normalized < 0 or normalized >= n_times:
            raise ShutdownDoseConfigError(
                f"Photon time index {index} is outside the schedule (0..{n_times - 1})"
            )
        if normalized not in indices:
            indices.append(normalized)
    return indices


def parse_bounding_boxes(config):
    """Parse bounding-box overrides into plain (lower, upper) pairs.

    Returns:
        dict[int, tuple[tuple[float, ...], tuple[float, ...]]]
    """
    raw = config.get("boundingBoxes") or {}
    if not isinstance(raw, dict):
        raise ShutdownDoseConfigError("boundingBoxes must be an object keyed by cell ID")
    boxes = {}
    for key, value in raw.items():
        try:
            cell_id = int(key)
        except (TypeError, ValueError) as exc:
            raise ShutdownDoseConfigError(f"Invalid bounding-box cell ID: {key}") from exc
        lower = value.get("lowerLeft") if isinstance(value, dict) else None
        upper = value.get("upperRight") if isinstance(value, dict) else None
        if not (
            isinstance(lower, list)
            and isinstance(upper, list)
            and len(lower) == 3
            and len(upper) == 3
        ):
            raise ShutdownDoseConfigError(
                f"Bounding box for cell {cell_id} must have lowerLeft and upperRight with three values"
            )
        if any(float(upper[i]) <= float(lower[i]) for i in range(3)):
            raise ShutdownDoseConfigError(
                f"Bounding box for cell {cell_id} has an upper-right corner at or below the lower-left corner"
            )
        boxes[cell_id] = (
            tuple(float(value) for value in lower),
            tuple(float(value) for value in upper),
        )
    return boxes


def _is_photon_tally(tally, openmc_module=None):
    """Whether a tally has a particle filter containing photons."""
    if openmc_module is None:
        import openmc as openmc_module

    for tally_filter in tally.filters:
        if isinstance(tally_filter, openmc_module.ParticleFilter) and list(tally_filter.bins) == [
            "photon"
        ]:
            return True
    return False


def select_photon_tallies(model, tally_ids, openmc_module=None):
    """Select and deep-copy photon tallies for the photon transport model.

    Args:
        model: The neutron model loaded from XML.
        tally_ids: Requested tally IDs (empty/None selects every photon tally).
        openmc_module: Optional injected OpenMC module for tests.

    Returns:
        A new openmc.Tallies object with independent tally copies.
    """
    openmc = openmc_module
    available = list(model.tallies)
    by_id = {tally.id: tally for tally in available}
    requested = [int(tally_id) for tally_id in (tally_ids or [])]
    if not requested:
        requested = [tally.id for tally in available if _is_photon_tally(tally, openmc)]

    selected = []
    missing = []
    non_photon = []
    for tally_id in requested:
        tally = by_id.get(tally_id)
        if tally is None:
            missing.append(tally_id)
            continue
        if not _is_photon_tally(tally, openmc):
            non_photon.append(tally_id)
            continue
        selected.append(copy.deepcopy(tally))

    if missing:
        raise ShutdownDoseConfigError(
            f"Photon tally IDs not found in tallies.xml: {', '.join(str(i) for i in missing)}"
        )
    if non_photon:
        raise ShutdownDoseConfigError(
            f"Selected tallies do not target photons: {', '.join(str(i) for i in non_photon)}. "
            "Add a particle filter with the photon bin."
        )
    if not selected:
        raise ShutdownDoseConfigError(
            "No photon tallies are available. Add a photon tally or the dose tally template before running R2S."
        )
    return openmc.Tallies(selected) if openmc is not None else selected


def load_meshes(openmc, working_dir):
    """Load every mesh definition from tallies.xml and settings.xml.

    Mesh objects that are not referenced by a tally are otherwise dropped by
    OpenMC's XML reader, so R2S activation meshes are read directly from the
    generated files.

    Returns:
        dict[int, openmc.MeshBase]
    """
    import xml.etree.ElementTree as ET

    meshes = {}
    for filename in ("tallies.xml", "settings.xml"):
        path = Path(working_dir) / filename
        if not path.exists():
            continue
        root = ET.parse(path).getroot()
        for element in root.iter("mesh"):
            mesh_id = element.get("id")
            mesh_type = element.get("type", "regular")
            if mesh_id is None:
                continue
            try:
                mesh_id_int = int(mesh_id)
            except ValueError:
                continue
            if mesh_id_int in meshes:
                continue
            if mesh_type == "regular":
                meshes[mesh_id_int] = openmc.RegularMesh.from_xml_element(element)
            elif mesh_type == "cylindrical":
                meshes[mesh_id_int] = openmc.CylindricalMesh.from_xml_element(element)
            elif mesh_type == "spherical":
                meshes[mesh_id_int] = openmc.SphericalMesh.from_xml_element(element)
    return meshes


def resolve_cell_domains(openmc, model, config):
    """Resolve and validate cell-based activation domains.

    Args:
        openmc: Imported OpenMC module.
        model: Model loaded from XML.
        config: Shutdown-dose configuration.

    Returns:
        (cells, bounding_boxes) where bounding_boxes maps cell ID to an
        openmc.BoundingBox. Bounding boxes are derived from the cell when the
        configuration has no override.
    """
    cell_ids = config.get("cellIds") or []
    if not cell_ids:
        raise ShutdownDoseConfigError("Select at least one activation cell")

    all_cells = model.geometry.get_all_cells()
    boxes = parse_bounding_boxes(config)
    domains = []
    resolved_boxes = {}
    missing = []
    for raw_id in cell_ids:
        cell_id = int(raw_id)
        cell = all_cells.get(cell_id)
        if cell is None:
            missing.append(cell_id)
            continue
        if cell.fill is None or not hasattr(cell.fill, "get_nuclides"):
            raise ShutdownDoseConfigError(
                f"Cell {cell_id} is not filled with a material; R2S activation requires material-filled cells"
            )
        if cell.volume is None or cell.volume <= 0:
            raise ShutdownDoseConfigError(
                f"Cell {cell_id} has no volume. Enter the cell volume in OpenMC Studio "
                "(or run a volume calculation) before running R2S."
            )
        if cell_id in boxes:
            lower, upper = boxes[cell_id]
            resolved_boxes[cell_id] = openmc.BoundingBox(lower, upper)
        else:
            try:
                resolved_boxes[cell_id] = cell.bounding_box
            except Exception as exc:  # noqa: BLE001 - report the concrete CSG failure
                raise ShutdownDoseConfigError(
                    f"Cell {cell_id} has no computable bounding box ({exc}). "
                    "Set an explicit bounding box override in the Shutdown Dose wizard."
                ) from exc
        domains.append(cell)

    if missing:
        raise ShutdownDoseConfigError(
            f"Activation cell IDs not found in geometry.xml: {', '.join(str(i) for i in missing)}"
        )
    return domains, resolved_boxes


def resolve_mesh_domains(openmc, working_dir, config):
    """Resolve mesh-based activation domains and warn about overlap."""
    mesh_ids = config.get("meshIds") or []
    if not mesh_ids:
        raise ShutdownDoseConfigError("Select at least one activation mesh")
    available = load_meshes(openmc, working_dir)
    domains = []
    missing = []
    for raw_id in mesh_ids:
        mesh_id = int(raw_id)
        mesh = available.get(mesh_id)
        if mesh is None:
            missing.append(mesh_id)
        else:
            domains.append(mesh)
    if missing:
        raise ShutdownDoseConfigError(
            f"Activation mesh IDs not found in tallies.xml/settings.xml: {', '.join(str(i) for i in missing)}"
        )
    return domains, mesh_overlap_warnings(domains)


def mesh_overlap_warnings(domains):
    """Warn about overlapping regular-mesh bounds (OpenMC assumes disjoint)."""
    warnings = []
    regular = [mesh for mesh in domains if getattr(mesh, "lower_left", None) is not None]
    for i, first in enumerate(regular):
        for second in regular[i + 1 :]:
            overlap = all(
                min(first.upper_right[axis], second.upper_right[axis])
                > max(first.lower_left[axis], second.lower_left[axis])
                for axis in range(3)
            )
            if overlap:
                warnings.append(
                    f"Meshes {first.id} and {second.id} have overlapping bounds; "
                    "R2S treats their elements as independent activation regions."
                )
    return warnings


def build_photon_model(openmc, neutron_model, tally_ids):
    """Build the photon transport model with copied, independent photon tallies."""
    tallies = select_photon_tallies(neutron_model, tally_ids, openmc)
    photon_model = openmc.Model(
        geometry=copy.copy(neutron_model.geometry),
        materials=copy.copy(neutron_model.materials),
        settings=copy.copy(neutron_model.settings),
        tallies=tallies,
        plots=copy.copy(neutron_model.plots),
    )
    photon_model.settings.photon_transport = True
    return photon_model


def _finite_array(values):
    """Return a finite, flattened numpy array."""
    import numpy as np

    array = np.asarray(values, dtype=float).ravel()
    return array[np.isfinite(array)]


def summarize_tally(tally, time_index=None):
    """Build a compact chart-friendly summary for one tally."""
    import numpy as np

    mean = np.asarray(tally.mean, dtype=float).ravel()
    finite = _finite_array(mean)
    summary = {
        "tallyId": int(tally.id),
        "name": tally.name,
        "scores": [str(score) for score in tally.scores],
        "bins": int(mean.size),
        "mean": [float(value) for value in mean[:MAX_TALLY_VALUES]],
        "min": float(finite.min()) if finite.size else None,
        "max": float(finite.max()) if finite.size else None,
        "sum": float(finite.sum()) if finite.size else None,
    }
    if time_index is not None:
        summary["timeIndex"] = int(time_index)
    try:
        std_dev = np.asarray(tally.std_dev, dtype=float).ravel()
        summary["stdDev"] = [float(value) for value in std_dev[:MAX_TALLY_VALUES]]
    except Exception:  # noqa: BLE001 - std_dev is unavailable for some derived tallies
        pass

    for tally_filter in tally.filters:
        if type(tally_filter).__name__.endswith("ParentNuclideFilter"):
            summary["parentNuclides"] = [str(bin) for bin in tally_filter.bins]
            break
    return summary


def summarize_activation(depletion_results, activation_materials, chain_file=None):
    """Summarize activity and decay heat over the activation schedule."""
    if depletion_results is None or not activation_materials:
        return None, None, []

    warnings = []
    times = None
    total_activity = None
    total_heat = None
    by_region = []
    for material in activation_materials:
        try:
            act_times, activity = depletion_results.get_activity(
                material, units="Bq", chain_file=chain_file
            )
        except Exception as exc:  # noqa: BLE001 - activity needs chain decay data
            warnings.append(f"Could not compute activity for {material.name or material.id}: {exc}")
            continue
        try:
            _, decay_heat = depletion_results.get_decay_heat(material, units="W")
        except Exception as exc:  # noqa: BLE001 - decay heat needs decay data
            warnings.append(
                f"Could not compute decay heat for {material.name or material.id}: {exc}"
            )
            decay_heat = [0.0] * len(activity)
        activity = [float(value) for value in activity]
        decay_heat = [float(value) for value in decay_heat]
        times = [float(value) for value in act_times]
        total_activity = (
            [a + b for a, b in zip(total_activity, activity, strict=False)]
            if total_activity is not None
            else activity
        )
        total_heat = (
            [a + b for a, b in zip(total_heat, decay_heat, strict=False)]
            if total_heat is not None
            else decay_heat
        )
        if len(by_region) < MAX_REGION_SUMMARIES:
            by_region.append(
                {"region": material.name or f"Material {material.id}", "totalBq": activity}
            )
        elif len(by_region) == MAX_REGION_SUMMARIES:
            warnings.append(
                f"Activity summary truncated to the first {MAX_REGION_SUMMARIES} activation regions"
            )

    activity_summary = None
    if times is not None and total_activity is not None:
        activity_summary = {"timesSeconds": times, "totalBq": total_activity, "byRegion": by_region}
    heat_summary = None
    if times is not None and total_heat is not None:
        heat_summary = {"timesSeconds": times, "totalW": total_heat}
    return activity_summary, heat_summary, warnings


def collect_files(output_dir, limit=500):
    """List output files relative to the run directory."""
    files = []
    for path in sorted(Path(output_dir).rglob("*")):
        if path.is_file():
            files.append(str(path.relative_to(output_dir)))
            if len(files) >= limit:
                break
    return files


def find_last_photon_statepoint(output_dir):
    """Return the last photon-transport statepoint path, if any."""
    candidates = sorted(Path(output_dir).glob("photon_transport/time_*/statepoint.*.h5"))
    return str(candidates[-1]) if candidates else None


def run_r2s(config, working_directory, openmc_module=None):
    """Run an R2S calculation and return a JSON-serializable result.

    Args:
        config: Shutdown-dose configuration dictionary.
        working_directory: Directory containing the generated model XML.
        openmc_module: Optional injected OpenMC module for unit tests.
    """
    if config.get("method") != "r2s":
        raise ShutdownDoseConfigError("run_r2s.py requires method='r2s'")
    if config.get("runNeutron") is False:
        raise ShutdownDoseConfigError(
            "Neutron transport cannot be skipped for a new R2S run; leave runNeutron enabled"
        )

    openmc = openmc_module
    if openmc is None:
        try:
            import openmc  # noqa: F401
            import openmc.deplete  # noqa: F401
        except ImportError as exc:
            raise ShutdownDoseConfigError(
                f"OpenMC with depletion support is required for R2S: {exc}"
            ) from exc

    working_directory = Path(working_directory).resolve()
    if not (working_directory / "geometry.xml").exists():
        raise ShutdownDoseConfigError(
            f"No geometry.xml in {working_directory}; generate the model XML before running R2S"
        )
    chain_file = config.get("chainFile")
    if chain_file and not Path(chain_file).exists():
        raise ShutdownDoseConfigError(f"Depletion chain file not found: {chain_file}")
    if not chain_file:
        raise ShutdownDoseConfigError("A depletion chain file is required for R2S activation")

    timesteps, source_rates, timestep_units = normalize_schedule(config)
    n_times = len(timesteps) + 1
    photon_time_indices = normalize_photon_time_indices(config, n_times)

    output_root = Path(config.get("outputDirectory") or working_directory)
    output_root.mkdir(parents=True, exist_ok=True)
    output_dir = output_root / f"r2s_{datetime.now().strftime('%Y-%m-%dT%H-%M-%S')}"
    output_dir.mkdir(parents=True, exist_ok=True)

    os.chdir(working_directory)
    log_progress("neutron", "Loading model from XML", 0.02)
    try:
        model = openmc.Model.from_xml()
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"Could not load the model XML: {exc}") from exc

    method = "mesh-based" if (config.get("domainType") or "cell") == "mesh" else "cell-based"
    warnings = []
    bounding_boxes = None
    if method == "cell-based":
        domains, bounding_boxes = resolve_cell_domains(openmc, model, config)
    else:
        domains, warnings = resolve_mesh_domains(openmc, working_directory, config)

    if config.get("runPhoton", True):
        photon_model = build_photon_model(openmc, model, config.get("photonTallyIds") or [])
    else:
        photon_model = None

    # Photon tallies in the neutron transport solve would only warn and score
    # zero, so keep only non-photon tallies on the neutron model. The photon
    # model above owns independent copies of the selected photon tallies.
    neutron_tallies = [tally for tally in model.tallies if not _is_photon_tally(tally, openmc)]
    model.tallies = openmc.Tallies(neutron_tallies)

    manager = openmc.deplete.R2SManager(model, domains, photon_model=photon_model)

    run_kwargs = {}
    if config.get("runPhoton", True):
        run_kwargs.setdefault("output", False)
    micro_kwargs = {"run_kwargs": run_kwargs}
    mat_vol_kwargs = {}
    if config.get("matVolSamples"):
        mat_vol_kwargs["n_samples"] = int(config["matVolSamples"])

    chain_context = openmc.config.patch("chain_file", chain_file) if chain_file else nullcontext()
    try:
        with chain_context:
            log_progress("neutron", "Running neutron transport and cross-section generation", 0.05)
            manager.step1_neutron_transport(
                output_dir / "neutron_transport",
                mat_vol_kwargs=mat_vol_kwargs or None,
                micro_kwargs=micro_kwargs,
            )

            log_progress("activation", "Running activation calculation", 0.3)
            manager.step2_activation(
                timesteps,
                source_rates,
                timestep_units,
                output_dir / "activation",
            )

            if config.get("runPhoton", True):
                log_progress("source", "Building decay photon sources", 0.55)
                manager.step3_photon_source(
                    photon_time_indices,
                    bounding_boxes,
                    output_dir / "photon_transport",
                )
                log_progress("photon", "Running photon transport", 0.7)
                manager.step4_photon_transport(
                    output_dir / "photon_transport",
                    run_kwargs=run_kwargs,
                    by_parent_nuclide=bool(config.get("byParentNuclide")),
                )
            else:
                warnings.append(
                    "Photon transport was disabled; only activation results were produced."
                )
    except ShutdownDoseConfigError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ShutdownDoseConfigError(f"R2S calculation failed: {exc}") from exc

    neutron_tally_summaries = [
        summarize_tally(tally) for tally in manager.results.get("neutron_tallies", [])
    ]
    photon_tallies = manager.results.get("photon_tallies", {})
    photon_indices = sorted(photon_tallies.keys()) if photon_tallies else []
    tally_summaries = []
    for time_index in photon_indices:
        for tally in photon_tallies[time_index]:
            tally_summaries.append(summarize_tally(tally, time_index))

    activation_materials = manager.results.get("activation_materials")
    activation_regions = (
        len(activation_materials) if activation_materials is not None else len(domains)
    )
    activity_context = (
        openmc.config.patch("chain_file", chain_file) if chain_file else nullcontext()
    )
    with activity_context:
        activity, decay_heat, activity_warnings = summarize_activation(
            manager.results.get("depletion_results"), activation_materials, chain_file
        )
    warnings.extend(activity_warnings)

    dose = None
    dose_tally_id = config.get("doseTallyId")
    if dose_tally_id is not None:
        matching = [
            summary for summary in tally_summaries if summary["tallyId"] == int(dose_tally_id)
        ]
        if matching:
            finite = [value for value in matching[-1]["mean"] if value == value]
            if finite:
                dose = {
                    "tallyId": int(dose_tally_id),
                    "timeIndex": matching[-1].get("timeIndex"),
                    "peak": max(finite),
                    "mean": sum(finite) / len(finite),
                }

    summary = {
        "method": "r2s",
        "timesteps": config.get("timesteps", []),
        "sourceRates": source_rates,
        "photonTimeIndices": photon_indices,
        "activationRegions": activation_regions,
        "photonTallies": len({summary["tallyId"] for summary in tally_summaries}),
        "photonTallySummaries": tally_summaries,
        "neutronTallies": len({summary["tallyId"] for summary in neutron_tally_summaries}),
        "neutronTallySummaries": neutron_tally_summaries,
        "dose": dose,
        "activity": activity,
        "decayHeat": decay_heat,
        "warnings": warnings,
    }

    result = {
        "success": True,
        "outputDirectory": str(output_dir),
        "summary": summary,
        "files": collect_files(output_dir),
        "statepoint": find_last_photon_statepoint(output_dir),
    }
    (output_dir / SUMMARY_FILENAME).write_text(
        json.dumps(result, cls=NumpyEncoder, indent=2), encoding="utf-8"
    )
    log_progress("done", f"R2S calculation complete: {output_dir}", 1.0)
    return result


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Run an OpenMC R2S shutdown-dose calculation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_r2s.py /path/to/model --config /path/to/shutdown-dose.json
        """,
    )
    parser.add_argument("working_directory", help="Directory containing the generated model XML")
    parser.add_argument("--config", required=True, help="Shutdown-dose configuration JSON")
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        result = run_r2s(config, args.working_directory)
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
