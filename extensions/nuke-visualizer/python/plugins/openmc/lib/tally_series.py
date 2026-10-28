"""Tally series across statepoint files (headless, no openmc/vtk import).

Reads one tally score/nuclide selection from a set of OpenMC statepoint files
and aggregates it into the JSON payload consumed by the native tally-series
widget (``openmc.tally-series``): naturally sorted statepoint steps, per-step
aggregated value/std, a shared mesh color range, and the volume-weighting flag.

Statepoint layout follows ``tally_vtk.read_mesh_tally``: ``tallies/tally <id>``
with ``results`` holding ``[sum, sum_sq]`` moments (mean = sum / n_realizations,
sample std = sqrt((sum_sq / n - mean**2) / (n - 1))). Moments are computed with
:func:`plugins.openmc.lib.tally_vtk.tally_moments` so every native tally view
reports identical values.

``h5py`` is imported lazily inside :func:`read_tally_bins`; there is no
``openmc`` or ``vtk`` import anywhere. All public functions raise
:class:`OutputReaderError` with a human-readable message on failure; command
wrappers convert these to the single-JSON-object contract.
"""

import os
import re

import numpy as np

from plugins.openmc.lib.output_readers import OutputReaderError
from plugins.openmc.lib.tally_vtk import tally_moments, validate_mesh_grid

#: Supported aggregations across the selected score/nuclide bins.
STATISTICS = ("total", "mean", "max")

_DIGITS_RE = re.compile(r"\d+")


def _load_h5py():
    """Lazily import ``h5py``.

    Raises :class:`OutputReaderError` when h5py is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    try:
        import h5py
    except ImportError as exc:
        raise OutputReaderError(
            f"h5py not installed (required to read statepoint files): {exc}"
        ) from None
    if h5py is None:
        raise OutputReaderError("h5py not installed (required to read statepoint files)")
    return h5py


def _require_tally_id(value):
    """Validate a tally id. Output: the id as a positive ``int``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"tally_id must be an integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"tally_id must be an integer, got {value!r}") from None
    if number <= 0:
        raise OutputReaderError(f"tally_id must be a positive integer, got {value!r}")
    return number


def _require_statistic(value):
    """Validate an aggregation name. Output: the statistic string."""
    if value not in STATISTICS:
        raise OutputReaderError(f"statistic must be one of {list(STATISTICS)}, got {value!r}")
    return value


def _decode_string_list(values):
    """Decode an HDF5 string dataset to a plain ``str`` list."""
    if values is None:
        return []
    if isinstance(values, (bytes, str)):
        values = [values]
    result = []
    for value in np.asarray(values).flat:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        result.append(str(value))
    return result


def statepoint_step_index(path):
    """Numeric statepoint step encoded in a filename, or ``None``.

    ``statepoint.10.h5`` -> ``10`` and ``openmc_simulation_n2.h5`` -> ``2``:
    the last integer run of the extension-stripped basename wins (so the
    ``.h5`` suffix never contributes). Names without digits return ``None``.
    """
    if not path or not isinstance(path, (str, os.PathLike)):
        return None
    stem = os.path.splitext(os.path.basename(os.fspath(path)))[0]
    matches = _DIGITS_RE.findall(stem)
    return int(matches[-1]) if matches else None


def sort_statepoint_files(files):
    """Order statepoint paths by natural step index, then by filename.

    Inputs: ``files`` (paths in any order). Output: a new list where
    ``statepoint.2.h5`` precedes ``statepoint.10.h5`` and
    ``openmc_simulation_n2.h5`` precedes ``openmc_simulation_n10.h5``. Paths
    without a numeric suffix sort after numbered files, by basename.
    """
    paths = [os.fspath(path) for path in files]

    def key(path):
        index = statepoint_step_index(path)
        return (index if index is not None else float("inf"), os.path.basename(path))

    return sorted(paths, key=key)


def aggregate_values(values, stds, statistic, volumes=None):
    """Aggregate finite tally bins into one ``(value, std, n_bins)`` triple.

    Inputs: ``values``/``stds`` (per-bin means and sample standard deviations
    for the selected score/nuclide), ``statistic`` (``"total"``, ``"mean"`` or
    ``"max"``), optional ``volumes`` (per-bin cell volumes). Volumes are only
    passed for regular-mesh tallies whose sole filter is the mesh; when given,
    totals and means are volume-weighted (``sum(mean * dV)``) and the standard
    deviation is combined in quadrature (``sqrt(sum((std * dV)**2))``). The
    unweighted paths use the same quadrature without ``dV`` (means divide the
    error by the bin count).

    Bins whose mean is non-finite (void cells) are dropped; a non-finite std
    keeps its bin but counts as zero error, so every returned number is finite.
    Output: ``(value, std, n_bins)`` where ``n_bins`` is the finite bin count.
    Raises :class:`OutputReaderError` for an unknown statistic, mismatched
    lengths, or when no finite bin remains.
    """
    statistic = _require_statistic(statistic)
    try:
        means = np.asarray(values, dtype=float).ravel()
        sigmas = np.asarray(stds, dtype=float).ravel()
    except (TypeError, ValueError):
        raise OutputReaderError("tally values and stds must be numeric") from None
    if means.size != sigmas.size:
        raise OutputReaderError(f"tally has {means.size} values but {sigmas.size} std values")

    weights = None
    if volumes is not None:
        try:
            weights = np.asarray(volumes, dtype=float).ravel()
        except (TypeError, ValueError):
            raise OutputReaderError("mesh cell volumes must be numeric") from None
        if weights.size != means.size:
            raise OutputReaderError(
                f"mesh has {weights.size} cell volumes but the tally has {means.size} bins"
            )
        if not np.all(np.isfinite(weights)) or np.any(weights < 0):
            raise OutputReaderError("mesh cell volumes must be finite and non-negative")

    finite = np.isfinite(means)
    means = means[finite]
    sigmas = np.where(np.isfinite(sigmas[finite]), sigmas[finite], 0.0)
    if weights is not None:
        weights = weights[finite]
    n_bins = int(means.size)
    if n_bins == 0:
        raise OutputReaderError("tally has no finite bins to aggregate")

    if statistic == "max":
        best = int(np.argmax(means))
        return float(means[best]), float(sigmas[best]), n_bins

    if weights is None:
        total = float(np.sum(means))
        total_std = float(np.sqrt(np.sum(sigmas**2)))
        if statistic == "total":
            return total, total_std, n_bins
        return total / n_bins, total_std / n_bins, n_bins

    volume = float(np.sum(weights))
    weighted_total = float(np.sum(means * weights))
    weighted_std = float(np.sqrt(np.sum((sigmas * weights) ** 2)))
    if statistic == "total":
        return weighted_total, weighted_std, n_bins
    if volume <= 0:
        raise OutputReaderError("mesh cell volumes are all zero — cannot weight the mean")
    return weighted_total / volume, weighted_std / volume, n_bins


# ---------------------------------------------------------------------------
# Statepoint reads
# ---------------------------------------------------------------------------


def _filter_objects(h5py, f, tally):
    """Filter groups applied to one tally, in application order.

    ``None`` marks an id listed on the tally whose group is missing from the
    file (still counts as a filter, but never as a mesh).
    """
    if "filters" not in tally:
        return []
    ref = tally["filters"]
    if isinstance(ref, h5py.Dataset):
        filter_ids = [int(v) for v in np.asarray(ref[...]).flat]
        locations = [
            loc for loc in (f.get("filters"), f["tallies"].get("filters")) if loc is not None
        ]
        objects = []
        for filter_id in filter_ids:
            key = f"filter {filter_id}"
            objects.append(next((loc[key] for loc in locations if key in loc), None))
        return objects
    # Older layout: filter subgroups stored directly on the tally.
    return [ref[key] for key in ref.keys()]


def _filter_type(filter_obj):
    """Decoded filter ``type`` string (``""`` for an unresolved filter)."""
    if filter_obj is None:
        return ""
    if "type" in filter_obj:
        value = filter_obj["type"][()]
    else:
        value = filter_obj.attrs.get("type", "")
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return str(value)


def _mesh_id(filter_obj):
    """Mesh id from a mesh filter's ``bins`` dataset (``None`` when absent)."""
    if filter_obj is None or "bins" not in filter_obj:
        return None
    bins = np.asarray(filter_obj["bins"][()]).ravel()
    return int(bins[0]) if bins.size else None


def read_tally_bins(path, tally_id, score=None, nuclide=None):
    """Read one tally's selected score/nuclide bins from a statepoint file.

    Inputs: ``path`` (statepoint ``.h5``), ``tally_id`` (positive int),
    optional ``score``/``nuclide`` names (default: first of each). Output:
    JSON-safe dict with ``tallyName``, ``score``, ``nuclide``, flat ``values``
    (means) and ``stds`` (sample standard deviations) for the selection, plus
    mesh metadata: ``hasMesh`` (any mesh filter), ``meshKind``
    (``"regular"``/``"cylindrical"``/``"unstructured"``/``None``), ``meshOnly``
    (exactly one filter and it is the mesh) and, for regular meshes,
    ``dimension``/``lowerLeft``/``upperRight``. Raises
    :class:`OutputReaderError` for missing files, missing dependencies, a
    missing tally/score/nuclide, or an unreadable results layout.
    """
    tally_id = _require_tally_id(tally_id)
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")
    h5py = _load_h5py()

    with h5py.File(path, "r") as f:
        if "tallies" not in f:
            raise OutputReaderError(f"No tallies found in {path}")
        tally_key = f"tally {tally_id}"
        if tally_key not in f["tallies"]:
            available = sorted(k for k in f["tallies"].keys() if k.startswith("tally "))
            raise OutputReaderError(
                f"Tally {tally_id} not found in {path} (available: {available})"
            )
        tally = f["tallies"][tally_key]

        name = tally.attrs.get("name", f"Tally {tally_id}")
        if isinstance(name, bytes):
            name = name.decode("utf-8")
        else:
            name = str(name)

        scores = _decode_string_list(tally["score_bins"][()] if "score_bins" in tally else None)
        nuclides = _decode_string_list(tally["nuclides"][()] if "nuclides" in tally else None)
        score_name = score or (scores[0] if scores else "total")
        nuclide_name = nuclide or (nuclides[0] if nuclides else "total")
        if scores and score_name not in scores:
            raise OutputReaderError(
                f"Score {score_name!r} not in tally {tally_id} (available: {scores})"
            )
        if nuclides and nuclide_name not in nuclides:
            raise OutputReaderError(
                f"Nuclide {nuclide_name!r} not in tally {tally_id} (available: {nuclides})"
            )
        score_idx = scores.index(score_name) if scores else 0
        nuclide_idx = nuclides.index(nuclide_name) if nuclides else 0
        n_scores = len(scores) or 1
        n_nuclides = len(nuclides) or 1

        if "results" not in tally:
            raise OutputReaderError(f"Tally {tally_id} has no results dataset")
        n_realizations = int(tally["n_realizations"][()]) if "n_realizations" in tally else 1
        mean, std, _rel_err = tally_moments(tally["results"][...], n_realizations)
        # Results are (filter bins, scores, nuclides) with [sum, sum_sq] as the
        # last axis; the filter-bin product is whatever the leading axes hold.
        if mean.size % (n_scores * n_nuclides) != 0:
            raise OutputReaderError(
                f"Tally {tally_id} results have {mean.size} values, which is not "
                f"divisible into {n_scores} scores x {n_nuclides} nuclides"
            )
        n_filter_bins = mean.size // (n_scores * n_nuclides)
        selector = (slice(None), score_idx, nuclide_idx)
        values = np.asarray(
            mean.reshape(n_filter_bins, n_scores, n_nuclides)[selector], dtype=float
        ).ravel()
        stds = np.asarray(
            std.reshape(n_filter_bins, n_scores, n_nuclides)[selector], dtype=float
        ).ravel()

        filter_objects = _filter_objects(h5py, f, tally)
        has_mesh = False
        mesh_obj = None
        for filter_obj in filter_objects:
            if _filter_type(filter_obj) != "mesh":
                continue
            has_mesh = True
            if mesh_obj is not None:
                continue
            mesh_id = _mesh_id(filter_obj)
            mesh_key = f"mesh {mesh_id}" if mesh_id is not None else None
            meshes = f["tallies"].get("meshes", {})
            if mesh_key and mesh_key in meshes:
                mesh_obj = meshes[mesh_key]

        mesh_kind = None
        dimension = None
        lower_left = None
        upper_right = None
        if mesh_obj is not None:
            if "r_grid" in mesh_obj or "phi_grid" in mesh_obj:
                mesh_kind = "cylindrical"
            elif all(key in mesh_obj for key in ("dimension", "lower_left", "upper_right")):
                mesh_kind = "regular"
                dimension = [int(v) for v in np.asarray(mesh_obj["dimension"][()]).flat]
                lower_left = [float(v) for v in np.asarray(mesh_obj["lower_left"][()]).flat]
                upper_right = [float(v) for v in np.asarray(mesh_obj["upper_right"][()]).flat]
            else:
                mesh_kind = "unstructured"

    return {
        "tallyName": name,
        "score": score_name,
        "nuclide": nuclide_name,
        "values": values,
        "stds": stds,
        "hasMesh": has_mesh,
        "meshKind": mesh_kind,
        "meshOnly": bool(has_mesh and len(filter_objects) == 1),
        "dimension": dimension,
        "lowerLeft": lower_left,
        "upperRight": upper_right,
    }


def _mesh_cell_volumes(data):
    """Uniform cell volume for a volume-weighted tally, else ``None``.

    Volume weighting applies only to regular meshes whose sole filter is the
    mesh and whose selected bin count matches the mesh cells.
    """
    if data["meshKind"] != "regular" or not data["meshOnly"]:
        return None
    try:
        dims, _origin, spacing = validate_mesh_grid(
            data["dimension"], data["lowerLeft"], data["upperRight"]
        )
    except OutputReaderError:
        return None
    if dims[0] * dims[1] * dims[2] != data["values"].size:
        return None
    return np.full(data["values"].size, float(np.prod(spacing)))


def build_series(files, tally_id, score=None, nuclide=None, statistic="total", times=None):
    """Read one tally score across statepoint files as a JSON-safe series.

    Inputs: ``files`` (statepoint paths; repeatable ``--file``),
    ``tally_id``, optional ``score``/``nuclide`` (default: first of the first
    file, then required in every file), ``statistic`` (``total``/``mean``/
    ``max``), optional ``times`` (explicit x-axis values paired 1:1 with
    ``files``; input order is preserved). Without ``times`` the files are
    sorted naturally by statepoint step, ``time`` is the filename suffix (else
    the 0-based step index), and ``timeLabel`` is ``"Statepoint step"``; with
    ``times`` it is ``"Time"`` and the counts must match.

    Output: the tally-series payload (``files``, ``tallyId``, ``tallyName``,
    ``score``, ``nuclide``, ``statistic``, ``timeLabel``, ``steps``,
    ``range``, optional ``viewRange``, ``hasMesh``, ``volumeWeighted``).
    ``viewRange`` is the global min/max of the finite mesh cell means (omitted
    when no step has a mesh filter — the shared 3D color range). Raises
    :class:`OutputReaderError` for empty inputs, mismatched ``--time`` counts,
    missing files/tallies/scores/nuclides, and zero finite bins.
    """
    statistic = _require_statistic(statistic)
    tally_id = _require_tally_id(tally_id)
    if isinstance(files, (str, os.PathLike)):
        files = [files]
    paths = [os.path.abspath(os.fspath(path)) for path in (files or []) if path]
    if not paths:
        raise OutputReaderError("No statepoint files given")

    if times is None:
        explicit_times = None
        ordered = sort_statepoint_files(paths)
        time_label = "Statepoint step"
    else:
        try:
            explicit_times = [float(time) for time in times]
        except (TypeError, ValueError):
            raise OutputReaderError("--time values must be numbers") from None
        if not all(np.isfinite(explicit_times)):
            raise OutputReaderError("--time values must be finite numbers")
        if len(explicit_times) != len(paths):
            raise OutputReaderError(
                f"--time count ({len(explicit_times)}) does not match --file count ({len(paths)})"
            )
        ordered = paths
        time_label = "Time"

    first = read_tally_bins(ordered[0], tally_id, score=score, nuclide=nuclide)
    resolved_score = first["score"]
    resolved_nuclide = first["nuclide"]

    steps = []
    has_mesh = False
    volume_weighted = True
    view_lo = float("inf")
    view_hi = float("-inf")
    for index, path in enumerate(ordered):
        data = (
            first
            if index == 0
            else read_tally_bins(path, tally_id, score=resolved_score, nuclide=resolved_nuclide)
        )
        volumes = _mesh_cell_volumes(data)
        value, std, n_bins = aggregate_values(
            data["values"], data["stds"], statistic, volumes=volumes
        )

        if data["hasMesh"]:
            has_mesh = True
            finite = data["values"][np.isfinite(data["values"])]
            if finite.size:
                view_lo = min(view_lo, float(np.min(finite)))
                view_hi = max(view_hi, float(np.max(finite)))
        # The flag reports actual weighting: a regular mesh-only tally whose
        # bin count does not match the mesh cells falls back to unweighted.
        if volumes is None:
            volume_weighted = False

        if explicit_times is not None:
            time = explicit_times[index]
        else:
            step_index = statepoint_step_index(path)
            time = step_index if step_index is not None else index

        steps.append(
            {
                "index": index,
                "time": time,
                "file": path,
                "fileName": os.path.basename(path),
                "value": value,
                "std": std,
                "nBins": n_bins,
            }
        )

    step_values = [step["value"] for step in steps]
    result = {
        "files": ordered,
        "tallyId": tally_id,
        "tallyName": first["tallyName"],
        "score": resolved_score,
        "nuclide": resolved_nuclide,
        "statistic": statistic,
        "timeLabel": time_label,
        "steps": steps,
        "range": [float(min(step_values)), float(max(step_values))],
    }
    if has_mesh:
        result["viewRange"] = [view_lo, view_hi]
    result["hasMesh"] = has_mesh
    result["volumeWeighted"] = bool(has_mesh and volume_weighted)
    return result
