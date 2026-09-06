# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Headless Exodus-II time-series extractor (no trame/ParaView server).

Reads a transient Exodus-II file (``.e``) via ``netCDF4`` (preferred) or
``meshio`` (single-step fallback) and emits a JSON-safe dict describing the
whole time series: per-step mesh snapshots plus nodal/cell variable
summaries. The native time-slider viewer renders this payload client-side,
replacing the ``base.serve`` ``reader.TimestepValues`` -> ``view.ViewTime``
slider.

JSON shape (contract for the native viewer)::

    {
        "sourceFile": "<path>",
        "nSteps": 3,
        "arrays": [
            {"name": "temperature", "location": "node", "range": [300.0, 900.0]}
        ],
        "steps": [
            {
                "index": 0,
                "time": 0.0,
                "mesh": {
                    "nNodes": 8,
                    "nElements": 1,
                    "nodes": [[x, y, z], ...],  # decimated to max_points
                    "blocks": [{"name": "block_1", "count": 1}],
                },
                "values": {
                    "temperature": {
                        "min": 300.0, "max": 300.0, "mean": 300.0,
                        "count": 8, "samples": [300.0, ...],  # decimated
                    },
                },
            },
        ],
    }

``location`` is ``"node"``, ``"cell"``, or ``"global"``. ``range`` is the
global min/max across all steps. ``samples`` are evenly decimated values
(first and last always kept) bounded by ``max_samples`` so large transient
files stay under the client point budget without a server round-trip.

Heavy dependencies (``netCDF4``, ``meshio``) are imported lazily so a
missing optional dependency surfaces as a clean :class:`ExodusSeriesError`
instead of a traceback; command handlers convert these to the
single-JSON-object contract. No trame/paraview imports.

All public functions raise :class:`ExodusSeriesError` with a human-readable
message on failure.
"""

import os

import numpy as np

try:
    import importlib.util as _importlib_util

    HAS_NETCDF4 = _importlib_util.find_spec("netCDF4") is not None
    HAS_MESHIO = _importlib_util.find_spec("meshio") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_NETCDF4 = False
    HAS_MESHIO = False

#: File suffixes accepted as Exodus-II series input.
EXODUS_SUFFIXES = (".e", ".exo", ".exoii", ".exodus", ".ex2", ".nc", ".cdf")

#: Default cap for decimated mesh nodes stored per step.
DEFAULT_MAX_POINTS = 5000

#: Default cap for decimated per-array samples stored per step.
DEFAULT_MAX_SAMPLES = 128


class ExodusSeriesError(Exception):
    """Raised for all Exodus series extractor failures (bad input, missing
    file, missing optional dependency, unexpected layout)."""


def json_default(obj):
    """``json.dumps(default=...)`` hook for numpy scalar/array types."""
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8")
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def decimate_indices(n, max_points):
    """Indices into a sequence of length ``n`` with at most ``max_points`` entries.

    Evenly strided and always includes the first and last index. Returns
    every index when ``n`` fits or ``max_points`` is not positive.
    """
    n = int(n)
    if n <= 0:
        return np.zeros(0, dtype=int)
    if not max_points or max_points <= 0 or n <= int(max_points):
        return np.arange(n)
    max_points = int(max_points)
    if max_points == 1:
        return np.zeros(1, dtype=int)
    stride = max(1, int(np.ceil((n - 1) / (max_points - 1))))
    idx = np.arange(0, n - 1, stride)
    return np.append(idx, n - 1)


def summarize_values(values, max_samples=DEFAULT_MAX_SAMPLES):
    """Summarize one variable array as a JSON-safe stats dict."""
    flat = np.asarray(values, dtype=float).ravel()
    flat = flat[np.isfinite(flat)]
    if flat.size == 0:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "count": 0, "samples": []}
    idx = decimate_indices(flat.size, max_samples)
    return {
        "min": float(np.min(flat)),
        "max": float(np.max(flat)),
        "mean": float(np.mean(flat)),
        "count": int(flat.size),
        "samples": [float(v) for v in flat[idx]],
    }


def _require_series_path(path):
    """Validate the input path; return its absolute string form."""
    if not isinstance(path, str) or not path:
        raise ExodusSeriesError("Exodus series path must be a non-empty string")
    if not os.path.isfile(path):
        raise ExodusSeriesError(f"Exodus file not found: {path}")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in EXODUS_SUFFIXES:
        expected = ", ".join(EXODUS_SUFFIXES)
        raise ExodusSeriesError(
            f"Unsupported Exodus suffix '{suffix or '<none>'}' (expected one of: {expected})"
        )
    return os.path.abspath(path)


def _require_max_steps(value):
    """Validate the optional max-steps cap (None means all steps)."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ExodusSeriesError("max_steps must be a positive integer or omitted")
    return value


def _require_max_points(value):
    """Validate the per-step decimation budget."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ExodusSeriesError("max_points must be a positive integer")
    return value


def _require_backend():
    """Raise unless at least one Exodus reader backend is importable."""
    if not HAS_NETCDF4 and not HAS_MESHIO:
        raise ExodusSeriesError(
            "Neither netCDF4 nor meshio is installed "
            "(required for Exodus series extraction; "
            "conda install -c conda-forge netcdf4 meshio)"
        )


def _load_netcdf4():
    """Lazily import ``netCDF4``; raise :class:`ExodusSeriesError` when absent."""
    if not HAS_NETCDF4:
        raise ExodusSeriesError("netCDF4 is not installed (required for Exodus time-series reads)")
    try:
        import netCDF4
    except ImportError as exc:
        raise ExodusSeriesError(f"netCDF4 is not installed: {exc}") from None
    return netCDF4


def _read_names(raw, count):
    """Decode ``count`` Exodus variable names from a char or string array."""
    names = []
    arr = np.asarray(raw)
    for i in range(count):
        if i >= len(arr):
            break
        row = arr[i]
        if isinstance(row, bytes):
            names.append(row.decode("utf-8", errors="replace").strip())
            continue
        chars = np.asarray(row).ravel()
        text = ""
        for ch in chars:
            if isinstance(ch, bytes):
                text += ch.decode("utf-8", errors="replace")
            else:
                text += str(ch)
        # NetCDF pads names with nulls; numpy str conversion may add empties.
        names.append(text.replace("\x00", "").strip())
    return [name for name in names if name]


def _extract_via_netcdf4(path, max_steps, max_points):
    """Extract the full series with the netCDF4 (Exodus-II layout) reader."""
    netcdf4 = _load_netcdf4()
    try:
        dataset = netcdf4.Dataset(path, "r")
    except Exception as exc:
        raise ExodusSeriesError(f"Could not open Exodus file '{path}': {exc}") from None
    try:
        dims = dataset.dimensions
        variables = dataset.variables

        def dim_len(name):
            dim = dims.get(name)
            return None if dim is None else len(dim)

        n_steps = dim_len("time_step")
        times = None
        if "time_whole" in variables:
            try:
                times = np.asarray(variables["time_whole"][:], dtype=float).ravel()
            except Exception:
                times = None
        if n_steps is None:
            n_steps = int(len(times)) if times is not None else 1
        if times is None or len(times) != n_steps:
            times = np.arange(n_steps, dtype=float)
        if max_steps is not None:
            n_steps = min(n_steps, max_steps)
            times = times[:n_steps]

        n_nodes = dim_len("num_nodes") or 0
        if n_nodes <= 0:
            raise ExodusSeriesError(f"Exodus file '{path}' has no nodes (missing num_nodes)")

        nodes = _read_nodes(variables, n_nodes)
        node_idx = decimate_indices(n_nodes, max_points)
        decimated_nodes = [[float(x), float(y), float(z)] for x, y, z in nodes[node_idx]]

        blocks = _read_blocks(dims, variables)
        n_elements = sum(block["count"] for block in blocks)

        nodal = _collect_indexed_vars(variables, "num_nod_var", "name_nod_var", "vals_nod_var")
        cellular = _collect_element_vars(variables, dims)
        globals_ = _collect_indexed_vars(variables, "num_glo_var", "name_glo_var", "vals_glo_var")

        steps = []
        for index in range(n_steps):
            values = {}
            for name, series in nodal:
                values[name] = summarize_values(_row(series, index))
            for name, series in cellular:
                values[name] = summarize_values(_row(series, index))
            for name, series in globals_:
                values[name] = summarize_values(_row(series, index))
            steps.append(
                {
                    "index": index,
                    "time": float(times[index]),
                    "mesh": {
                        "nNodes": int(n_nodes),
                        "nElements": int(n_elements),
                        "nodes": decimated_nodes,
                        "blocks": blocks,
                    },
                    "values": values,
                }
            )

        arrays = []
        for name, _series in nodal:
            arrays.append(
                {
                    "name": name,
                    "location": "node",
                    "range": _global_range(steps, name),
                }
            )
        for name, _series in cellular:
            arrays.append(
                {
                    "name": name,
                    "location": "cell",
                    "range": _global_range(steps, name),
                }
            )
        for name, _series in globals_:
            arrays.append(
                {
                    "name": name,
                    "location": "global",
                    "range": _global_range(steps, name),
                }
            )
        return {"sourceFile": path, "nSteps": int(n_steps), "arrays": arrays, "steps": steps}
    finally:
        try:
            dataset.close()
        except Exception:
            pass


def _read_nodes(variables, n_nodes):
    """Read node coordinates as an (n, 3) float array (z defaults to 0)."""
    if "coord" in variables:
        try:
            coords = np.asarray(variables["coord"][:], dtype=float)
            if coords.ndim == 2 and coords.shape[0] == n_nodes:
                return _pad_to_xyz(coords)
        except Exception as exc:
            raise ExodusSeriesError(f"Could not read node coordinates: {exc}") from None
    axes = []
    for name in ("coordx", "coordy", "coordz"):
        if name in variables:
            try:
                axes.append(np.asarray(variables[name][:], dtype=float).ravel()[:n_nodes])
            except Exception as exc:
                raise ExodusSeriesError(f"Could not read node coordinates: {exc}") from None
        else:
            axes.append(np.zeros(n_nodes))
    stacked = np.column_stack(axes[:3])
    if stacked.shape[0] != n_nodes:
        raise ExodusSeriesError("Node coordinate length does not match num_nodes")
    return stacked


def _pad_to_xyz(coords):
    """Pad 1D/2D coordinates out to xyz triples."""
    coords = np.asarray(coords, dtype=float)
    if coords.ndim == 1:
        coords = coords.reshape(-1, 1)
    n, width = coords.shape
    if width >= 3:
        return coords[:, :3]
    padded = np.zeros((n, 3))
    padded[:, :width] = coords
    return padded


def _read_blocks(dims, variables):
    """Summarize element blocks as [{name, count}] without full connectivity."""
    blocks = []
    index = 1
    while True:
        count_dim = dims.get(f"num_el_in_blk{index}")
        if count_dim is None:
            break
        try:
            count = int(len(count_dim))
        except Exception:
            count = 0
        label = None
        names_var = variables.get("eb_names")
        if names_var is not None:
            try:
                labels = _read_names(names_var[:], index)
                if len(labels) >= index:
                    label = labels[index - 1]
            except Exception:
                label = None
        blocks.append({"name": label or f"block_{index}", "count": count})
        index += 1
    # Fallback for files that only carry a flat element count.
    if not blocks:
        total = dims.get("num_elem")
        if total is not None:
            try:
                blocks.append({"name": "block_1", "count": int(len(total))})
            except Exception:
                pass
    return blocks


def _collect_indexed_vars(variables, count_dim, names_var, values_prefix):
    """Collect ``vals_<kind><i>`` series paired with their declared names."""
    names_raw = variables.get(names_var)
    count = 0
    if names_raw is not None:
        try:
            count = len(np.asarray(names_raw))
        except Exception:
            count = 0
    if count <= 0:
        # Tolerate files that carry values without a name table.
        index = 1
        found = []
        while f"{values_prefix}{index}" in variables:
            found.append((f"{values_prefix}{index}", variables[f"{values_prefix}{index}"]))
            index += 1
        return [(name, _as_series(var)) for name, var in found]
    try:
        names = _read_names(names_raw[:], count)
    except Exception as exc:
        raise ExodusSeriesError(f"Could not read variable names '{names_var}': {exc}") from None
    collected = []
    for position, name in enumerate(names, start=1):
        var = variables.get(f"{values_prefix}{position}")
        if var is None:
            continue
        collected.append((name, _as_series(var)))
    return collected


def _collect_element_vars(variables, dims):
    """Collect element variables (``vals_elem_var<i>`` and per-block variants)."""
    collected = []
    names_raw = variables.get("name_elem_var")
    names = []
    if names_raw is not None:
        try:
            names = _read_names(names_raw[:], len(np.asarray(names_raw)))
        except Exception as exc:
            raise ExodusSeriesError(
                f"Could not read variable names 'name_elem_var': {exc}"
            ) from None
    for position, name in enumerate(names, start=1):
        # Prefer the plain variable; fall back to the first per-block variant.
        var = variables.get(f"vals_elem_var{position}")
        if var is None:
            matches = sorted(
                key for key in variables if key.startswith(f"vals_elem_var{position}eb")
            )
            if not matches:
                continue
            var = variables[matches[0]]
        collected.append((name, _as_series(var)))
    if not collected:
        # Last resort: any vals_elem_var* variable under a synthetic name.
        for key in sorted(variables):
            if key.startswith("vals_elem_var"):
                collected.append((key, _as_series(variables[key])))
    return collected


def _as_series(var):
    """Materialize one variable's full time series as a float array."""
    try:
        return np.asarray(var[:], dtype=float)
    except Exception as exc:
        raise ExodusSeriesError(f"Could not read variable values: {exc}") from None


def _row(series, index):
    """One time-step row of a variable series (scalars broadcast as-is)."""
    arr = np.asarray(series)
    if arr.ndim == 0:
        return arr.reshape(1)
    if arr.ndim == 1:
        if len(arr) == 0:
            return arr
        # 1D series are either per-step globals or a single step's field.
        return np.asarray([arr[index]]) if index < len(arr) else arr[:0]
    if index >= arr.shape[0]:
        return np.zeros(0)
    return arr[index]


def _global_range(steps, name):
    """Global [min, max] of one array across all steps."""
    lo = float("inf")
    hi = float("-inf")
    for step in steps:
        summary = step["values"].get(name)
        if not summary:
            continue
        lo = min(lo, summary["min"])
        hi = max(hi, summary["max"])
    if lo == float("inf"):
        return [0.0, 0.0]
    return [float(lo), float(hi)]


def _extract_via_meshio(path, max_steps, max_points):
    """Single-step fallback via meshio (no transient support)."""
    if not HAS_MESHIO:
        raise ExodusSeriesError("meshio is not installed (fallback reader unavailable)")
    try:
        import meshio
    except ImportError as exc:
        raise ExodusSeriesError(f"meshio is not installed: {exc}") from None
    try:
        mesh = meshio.read(path)
    except Exception as exc:
        raise ExodusSeriesError(f"Could not read Exodus file '{path}' with meshio: {exc}") from None
    points = _pad_to_xyz(np.asarray(mesh.points, dtype=float))
    n_nodes = points.shape[0]
    node_idx = decimate_indices(n_nodes, max_points)
    decimated_nodes = [[float(x), float(y), float(z)] for x, y, z in points[node_idx]]
    blocks = []
    n_elements = 0
    for cell_block in mesh.cells:
        count = len(cell_block.data)
        blocks.append({"name": getattr(cell_block, "type", "block"), "count": int(count)})
        n_elements += count
    values = {}
    arrays = []
    for name, data in (mesh.point_data or {}).items():
        summary = summarize_values(np.asarray(data, dtype=float))
        values[str(name)] = summary
        arrays.append(
            {"name": str(name), "location": "node", "range": [summary["min"], summary["max"]]}
        )
    for name, groups in (mesh.cell_data or {}).items():
        stacked = (
            np.concatenate([np.asarray(group, dtype=float).ravel() for group in groups])
            if groups
            else np.zeros(0)
        )
        summary = summarize_values(stacked)
        values[str(name)] = summary
        arrays.append(
            {"name": str(name), "location": "cell", "range": [summary["min"], summary["max"]]}
        )
    step = {
        "index": 0,
        "time": 0.0,
        "mesh": {
            "nNodes": int(n_nodes),
            "nElements": int(n_elements),
            "nodes": decimated_nodes,
            "blocks": blocks,
        },
        "values": values,
    }
    void_steps = max_steps is not None and max_steps < 1
    steps = [] if void_steps else [step]
    return {"sourceFile": path, "nSteps": len(steps), "arrays": arrays, "steps": steps}


def extract_exodus_series(path, max_steps=None, max_points=DEFAULT_MAX_POINTS):
    """Extract an Exodus-II time series to a JSON-safe dict (no server).

    Validators run before any heavy import so bad input fails fast even
    when no reader backend is installed. Prefers ``netCDF4`` (full
    transient support); falls back to ``meshio`` (single step at t=0).
    """
    source = _require_series_path(path)
    cap = _require_max_steps(max_steps)
    budget = _require_max_points(max_points)
    _require_backend()
    if HAS_NETCDF4:
        return _extract_via_netcdf4(source, cap, budget)
    return _extract_via_meshio(source, cap, budget)
