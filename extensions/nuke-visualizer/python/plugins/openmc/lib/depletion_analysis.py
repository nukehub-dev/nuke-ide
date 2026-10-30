"""Depletion post-processing helpers for the depletion viewer.

Contact dose rates and decay-photon spectra come from OpenMC's own
``openmc.deplete.Results`` / ``openmc.Material`` APIs so the viewer never
re-implements activation or decay physics. The helpers here only shape the
OpenMC results into JSON-safe series for the frontend.
"""

import math
import os
from contextlib import contextmanager

CONTACT_DOSE_UNITS = {"absorbed-air": "Gy/h", "effective": "Sv/h"}


class DepletionAnalysisError(Exception):
    """Actionable depletion post-processing error."""


def resolve_chain_file(chain_file=None):
    """Resolve an explicit chain file or OPENMC_CHAIN_FILE.

    Returns ``None`` when neither is set so the caller can fall back to
    ``openmc.config['chain_file']`` (which OpenMC may derive from
    ``cross_sections.xml``).
    """
    candidate = chain_file or os.environ.get("OPENMC_CHAIN_FILE")
    if not candidate:
        return None
    path = os.path.abspath(os.path.expanduser(str(candidate)))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Depletion chain file not found: {path}")
    return path


@contextmanager
def depletion_results(file_path, chain_file=None):
    """Open depletion results while a chain file is active.

    Yields ``(results, chain_file)``. The chain is required because decay
    photon spectra and contact dose rates read the chain's photon source
    data; without it OpenMC raises a generic DataError later.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"Depletion results file not found: {file_path}")

    import openmc
    from openmc.deplete import Results

    chain = resolve_chain_file(chain_file)
    if chain is None:
        configured = openmc.config.get("chain_file")
        chain = str(configured) if configured else None
    if not chain:
        raise DepletionAnalysisError(
            "No depletion chain file configured. Set OPENMC_CHAIN_FILE, pass --chain-file, "
            "or point OpenMC at a chain file before loading decay data."
        )
    if not os.path.isfile(chain):
        raise FileNotFoundError(f"Depletion chain file not found: {chain}")

    with openmc.config.patch("chain_file", chain):
        yield Results(file_path), chain


def _step_time_seconds(step):
    """Beginning-of-step time in seconds (OpenMC's time-series convention)."""
    time = step.time
    return float(time[0]) if time is not None else 0.0


def _is_finite_number(value):
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def summarize_contact_dose(
    results, material_index, dose_quantity="absorbed-air", build_up=2.0, by_nuclide=False
):
    """Compute contact dose rates for one material at every depletion state.

    Parameters
    ----------
    results : openmc.deplete.Results
        Loaded depletion results (a list of ``StepResult`` objects).
    material_index : int
        OpenMC material ID present in the results.
    dose_quantity : {'absorbed-air', 'effective'}
        Dose quantity passed to ``Material.get_photon_contact_dose_rate``.
    build_up : float
        Photon build-up factor (default 2.0 per the FISPACT-II manual).
    by_nuclide : bool
        Include the per-nuclide contributions in the response.
    """
    if dose_quantity not in CONTACT_DOSE_UNITS:
        raise ValueError(f"Unsupported dose quantity: {dose_quantity}")
    if not _is_finite_number(build_up) or float(build_up) <= 0.0:
        raise ValueError("Build-up factor must be a positive number")

    times = []
    totals = []
    contributions = {}
    material_name = f"material {material_index}"
    volume = None
    n_states = len(results)

    for step_index, step in enumerate(results):
        material = step.get_material(str(material_index))
        material_name = material.name or material_name
        volume = material.volume
        values = material.get_photon_contact_dose_rate(
            dose_quantity=dose_quantity,
            build_up=float(build_up),
            by_nuclide=True,
        )
        times.append(_step_time_seconds(step))
        for nuclide, value in values.items():
            series = contributions.setdefault(nuclide, [0.0] * n_states)
            series[step_index] = float(value) if _is_finite_number(value) else 0.0
        totals.append(sum(value for value in values.values() if _is_finite_number(value)))

    contributing = sum(1 for values in contributions.values() if any(v > 0.0 for v in values))
    payload = {
        "success": True,
        "materialIndex": int(material_index),
        "materialName": material_name,
        "volume": float(volume) if _is_finite_number(volume) else None,
        "doseQuantity": dose_quantity,
        "unit": CONTACT_DOSE_UNITS[dose_quantity],
        "buildUp": float(build_up),
        "timeSeconds": times,
        "timeDays": [value / 86400.0 for value in times],
        "total": [float(value) for value in totals],
        "contributingNuclides": contributing,
        "caveat": (
            "Contact dose is a slab-geometry approximation with a build-up factor; "
            "it does not include Bremsstrahlung and only covers unstable nuclides "
            "with decay-photon data in the chain file."
        ),
    }

    if by_nuclide:
        rows = [
            {"nuclide": nuclide, "values": [float(value) for value in values]}
            for nuclide, values in contributions.items()
            if any(value > 0.0 for value in values)
        ]
        rows.sort(key=lambda row: row["values"][-1] if row["values"] else 0.0, reverse=True)
        payload["byNuclide"] = rows

    if contributing == 0:
        payload["emptyReason"] = (
            "No unstable nuclides with decay-photon data were found for this material. "
            "Check that the depletion chain includes photon source data."
        )

    return payload


def decimate_series(x_values, y_values, max_points=2000):
    """Down-sample a curve to at most ``max_points`` while keeping the ends."""
    x_values = list(x_values)
    y_values = list(y_values)
    n_points = len(x_values)
    if n_points <= max_points or max_points < 2:
        return x_values, y_values
    stride = (n_points - 1) / (max_points - 1)
    indices = sorted({int(round(i * stride)) for i in range(max_points)})
    return [x_values[i] for i in indices], [y_values[i] for i in indices]


def _distribution_parts(distribution, weight=1.0):
    """Flatten a Univariate distribution into discrete lines / continuous curves."""
    lines = []
    curves = []

    if hasattr(distribution, "distribution") and hasattr(distribution, "probability"):
        for probability, component in zip(
            distribution.probability, distribution.distribution, strict=False
        ):
            component_lines, component_curves = _distribution_parts(
                component, weight * float(probability)
            )
            lines.extend(component_lines)
            curves.extend(component_curves)
        return lines, curves

    x_values = [float(value) for value in getattr(distribution, "x", [])]
    p_values = [float(value) for value in getattr(distribution, "p", [])]
    if not x_values or not p_values:
        return lines, curves

    if hasattr(distribution, "interpolation"):
        curve_x, curve_y = decimate_series(x_values, [value * weight for value in p_values])
        curves.append({"energyEv": curve_x, "intensityPerEv": curve_y})
    else:
        lines.extend(
            {"energyEv": energy, "intensity": probability * weight}
            for energy, probability in zip(x_values, p_values, strict=False)
        )
    return lines, curves


def summarize_decay_spectrum(results, material_index, time_index):
    """Return the decay-photon spectrum for one material at one time index."""
    if time_index < 0 or time_index >= len(results):
        raise IndexError(f"Time index {time_index} is out of range [0, {max(len(results) - 1, 0)}]")

    step = results[time_index]
    material = step.get_material(str(material_index))
    activity_bq = float(material.get_activity(units="Bq"))
    distribution = material.get_decay_photon_energy(units="Bq", volume=material.volume)

    lines, curves = ([], []) if distribution is None else _distribution_parts(distribution)
    lines.sort(key=lambda line: line["energyEv"])
    total_intensity = float(distribution.integral()) if distribution is not None else 0.0
    time_seconds = _step_time_seconds(step)

    if curves and lines:
        kind = "mixture"
    elif curves:
        kind = "continuous"
    else:
        kind = "discrete"

    payload = {
        "success": True,
        "materialIndex": int(material_index),
        "materialName": material.name or f"material {material_index}",
        "volume": float(material.volume) if _is_finite_number(material.volume) else None,
        "timeIndex": int(time_index),
        "timeSeconds": time_seconds,
        "timeDays": time_seconds / 86400.0,
        "totalActivityBq": activity_bq,
        "totalPhotonIntensityBq": total_intensity,
        "kind": kind,
        "lines": lines,
        "curves": curves,
    }
    if not lines and not curves:
        payload["emptyReason"] = (
            "No decay-photon lines were found for this material at this time. "
            "Check that the depletion chain includes photon source data."
        )
    return payload
