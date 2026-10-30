# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Pure probe helpers for the base visualizer.

Backs the headless ``base.probe`` command. This module never imports ``vtk``
at module import time: coordinate parsing, sample-count clamping and
polyline sampling are plain numpy helpers that run in the minimal
pytest + numpy profile. :func:`sample_array_values` lazily imports vtk only
when it actually probes a dataset, so a missing dependency raises
:class:`AnalysisError` instead of an ``ImportError`` traceback.

Conventions:

- Positions are ``(x, y, z)`` tuples; parsed helpers return plain Python
  values so results are JSON-safe by construction.
- A probe miss (point outside the dataset, or a non-finite sampled tuple)
  is data, not an error: the sample reports ``value: None`` and
  ``valid: False``. Only bad input (syntax, unknown array, component out of
  range) raises :class:`AnalysisError`.
- ``vtkProbeFilter`` handles both associations: it interpolates source
  point arrays and copies the containing source cell tuple for cell arrays
  (sampled cell arrays land in the output point data).
"""

import math

import numpy as np

from plugins.base.lib.analysis import AnalysisError

#: Default number of samples along a ``--path`` polyline.
DEFAULT_SAMPLES = 100

#: Inclusive bounds for ``--path`` sample counts.
MIN_SAMPLES = 2
MAX_SAMPLES = 10000

#: Internal array name used when the requested array shares its name with an
#: array in the other point/cell association (see :func:`_probe_source`).
_PROBE_ARRAY_NAME = "__nuke_probe_value__"


def _load_vtk():
    """Lazily import ``vtk`` or raise :class:`AnalysisError`."""
    try:
        import vtk
    except ImportError as exc:
        raise AnalysisError(f"vtk is required for base.probe (not installed): {exc}") from None
    return vtk


def _parse_coordinates(text, label, minimum):
    """Parse ``"x,y,z;x,y,z;..."`` text into a list of 3-tuples."""
    if not isinstance(text, str) or not text.strip():
        raise AnalysisError(f"--{label} must be 'x,y,z;x,y,z' coordinates")
    positions = []
    for chunk in text.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [part.strip() for part in chunk.split(",")]
        if len(parts) != 3:
            raise AnalysisError(
                f"--{label} entry {len(positions) + 1} must be 'x,y,z' (got '{chunk}')"
            )
        try:
            position = tuple(float(part) for part in parts)
        except ValueError:
            raise AnalysisError(
                f"--{label} entry {len(positions) + 1} must be numeric (got '{chunk}')"
            ) from None
        if not all(math.isfinite(value) for value in position):
            raise AnalysisError(
                f"--{label} entry {len(positions) + 1} must be finite (got '{chunk}')"
            )
        positions.append(position)
    if len(positions) < minimum:
        raise AnalysisError(f"--{label} needs at least {minimum} point(s)")
    return positions


def parse_points(text):
    """Parse ``--points`` coordinates (one or more ``x,y,z`` entries).

    Empty entries (a trailing semicolon, for example) are ignored. Every
    entry must contain exactly three finite numbers. Raises
    :class:`AnalysisError` on bad syntax.
    """
    return _parse_coordinates(text, "points", 1)


def parse_path(text):
    """Parse a ``--path`` polyline (at least two ``x,y,z`` points)."""
    return _parse_coordinates(text, "path", 2)


def sample_count(value=None):
    """Return a valid ``--samples`` count: default 100, clamped to ``2..10000``.

    ``value`` may be ``None`` (use the default), a number, or a numeric
    string (argparse hands command-line values over as strings). Fractional,
    non-numeric or non-finite values raise :class:`AnalysisError`; numeric
    values outside the supported range are clamped rather than rejected.
    """
    if value is None:
        return DEFAULT_SAMPLES
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise AnalysisError(f"--samples must be an integer (got '{value}')") from None
    if not math.isfinite(number) or not number.is_integer():
        raise AnalysisError(f"--samples must be an integer (got '{value}')")
    return int(min(max(number, MIN_SAMPLES), MAX_SAMPLES))


def path_samples(points, count=None):
    """Sample ``count`` evenly spaced positions along a polyline.

    ``points`` is a sequence of at least two ``(x, y, z)`` positions. Samples
    are spaced evenly by cumulative arc length, so ``distance`` is measured
    along the whole polyline rather than along a single segment. Returns
    ``(samples, length)`` where ``samples`` is a JSON-safe list of
    ``{"distance", "position"}`` dicts and ``length`` is the total polyline
    length. A degenerate (zero-length) polyline returns every sample at its
    first point with distance 0.
    """
    positions = np.asarray(points, dtype=float)
    if positions.ndim != 2 or positions.shape[1] != 3 or positions.shape[0] < 2:
        raise AnalysisError("--path needs at least two 3-D points")
    if not np.all(np.isfinite(positions)):
        raise AnalysisError("--path points must be finite")
    samples = sample_count(count)

    vectors = np.diff(positions, axis=0)
    segment_lengths = np.linalg.norm(vectors, axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(segment_lengths)))
    length = float(cumulative[-1])
    if length <= 0.0:
        first = [float(axis) for axis in positions[0]]
        return [{"distance": 0.0, "position": first} for _ in range(samples)], length

    distances = np.linspace(0.0, length, samples)
    indices = np.searchsorted(cumulative, distances, side="right") - 1
    indices = np.clip(indices, 0, segment_lengths.size - 1)

    fractions = np.zeros_like(distances)
    nonzero = segment_lengths[indices] > 0.0
    fractions[nonzero] = (distances[nonzero] - cumulative[indices[nonzero]]) / segment_lengths[
        indices[nonzero]
    ]
    fractions = np.clip(fractions, 0.0, 1.0)
    sampled = positions[indices] + vectors[indices] * fractions[:, None]

    return (
        [
            {"distance": float(distance), "position": [float(axis) for axis in position]}
            for distance, position in zip(distances, sampled, strict=True)
        ],
        length,
    )


def _attributes(dataset, association):
    """Return the point or cell data attributes of a VTK dataset."""
    return dataset.GetCellData() if association == "cell" else dataset.GetPointData()


def _array_names(attributes):
    """Names of the arrays present in one VTK data-attributes object."""
    names = []
    for index in range(attributes.GetNumberOfArrays()):
        array = attributes.GetArray(index)
        if array is not None and array.GetName():
            names.append(array.GetName())
    return names


def _find_array(dataset, association, name):
    """Return the requested array from the requested association."""
    attributes = _attributes(dataset, association)
    array = attributes.GetArray(name)
    if array is None:
        available = ", ".join(_array_names(attributes)) or "<none>"
        raise AnalysisError(
            f"{association} array '{name}' not found (available arrays: {available})"
        )
    return array


def _numeric_values(numpy_support, array, association, name):
    """Read a VTK array as an ``(n, components)`` float numpy array."""
    try:
        values = numpy_support.vtk_to_numpy(array)
    except Exception as exc:
        raise AnalysisError(
            f"{association} array '{name}' is not a numeric VTK array ({exc})"
        ) from None
    components = int(array.GetNumberOfComponents())
    if components < 1:
        raise AnalysisError(f"{association} array '{name}' has no components")
    return np.asarray(values, dtype=float).reshape(-1, components)


def _validate_component(components, component):
    """Validate ``--component`` against the array width; return it normalized."""
    if component is None:
        return None
    if isinstance(component, bool) or not isinstance(component, (int, np.integer)):
        raise AnalysisError(f"--component must be a 0-based integer (got '{component}')")
    component = int(component)
    if components == 1:
        if component != 0:
            raise AnalysisError(
                f"--component {component} is out of range for a single-component array (use 0)"
            )
        return component
    if component < 0 or component >= components:
        raise AnalysisError(
            f"--component {component} is out of range for an array with {components} components"
        )
    return component


def _reduce_components(values, component):
    """Collapse ``(n, components)`` values to one value per tuple."""
    if component is not None:
        return values[:, component]
    if values.shape[1] == 1:
        return values[:, 0]
    return np.linalg.norm(values, axis=1)


def _probe_source(dataset, association, name, array):
    """Return ``(source, output_name)`` for the probe filter.

    ``vtkProbeFilter`` copies sampled cell arrays into the output point data
    by name, so a cell array that shares its name with a point array would
    be shadowed by the point array. In that rare case the requested array is
    deep-copied under an internal name on a shallow dataset copy, keeping
    the caller's dataset untouched and the output unambiguous.
    """
    other = _attributes(dataset, "point" if association == "cell" else "cell")
    if other.GetArray(name) is None:
        return dataset, name
    source = dataset.NewInstance()
    source.ShallowCopy(dataset)
    renamed = array.NewInstance()
    renamed.DeepCopy(array)
    renamed.SetName(_PROBE_ARRAY_NAME)
    _attributes(source, association).AddArray(renamed)
    return source, _PROBE_ARRAY_NAME


def sample_array_values(dataset, numpy_support, association, name, positions, component=None):
    """Sample one point/cell array at 3-D positions with ``vtkProbeFilter``.

    Returns a JSON-safe dict ``{"values": [...], "valid": [...],
    "dataRange": [min, max] | None}`` aligned with ``positions``. A sample
    is invalid (``value`` is ``None``) when VTK's ``vtkValidPointMask``
    marks it outside the dataset or the sampled tuple is non-finite.

    ``component`` selects one component of a multi-component array
    (0-based); without it multi-component arrays use the L2 magnitude and
    single-component arrays use their only value (``--component 0`` is
    accepted there, any other component is an error). ``dataRange`` is the
    finite range of the same quantity over the whole source array, or
    ``None`` when it has no finite values.

    ``vtkProbeFilter`` is used for both associations: it interpolates
    point arrays and copies the containing cell tuple for cell arrays
    (sampled cell arrays land in the output point data). VTK is imported
    lazily so a missing dependency raises :class:`AnalysisError`.
    """
    vtk = _load_vtk()
    if association not in ("cell", "point"):
        raise AnalysisError(
            f"Unsupported array association '{association}' (expected cell or point)"
        )
    coordinates = np.asarray(positions, dtype=float)
    if coordinates.ndim != 2 or coordinates.shape[1] != 3 or coordinates.shape[0] == 0:
        raise AnalysisError("probe positions must be a non-empty (n, 3) array")
    if not np.all(np.isfinite(coordinates)):
        raise AnalysisError("probe positions must be finite")

    array = _find_array(dataset, association, name)
    source_values = _numeric_values(numpy_support, array, association, name)
    components = source_values.shape[1]
    component = _validate_component(components, component)
    reduced_source = _reduce_components(source_values, component)
    finite = reduced_source[np.isfinite(reduced_source)]
    data_range = [float(finite.min()), float(finite.max())] if finite.size else None

    source, output_name = _probe_source(dataset, association, name, array)

    points = vtk.vtkPoints()
    points.SetData(
        numpy_support.numpy_to_vtk(
            np.ascontiguousarray(coordinates), deep=True, array_type=vtk.VTK_DOUBLE
        )
    )
    cloud = vtk.vtkPolyData()
    cloud.SetPoints(points)

    probe = vtk.vtkProbeFilter()
    probe.SetInputData(cloud)
    probe.SetSourceData(source)
    probe.SetPassPointArrays(True)
    probe.SetPassCellArrays(True)
    try:
        probe.Update()
    except Exception as exc:
        raise AnalysisError(f"VTK probe failed for {association} array '{name}': {exc}") from None

    output = probe.GetOutput()
    point_data = output.GetPointData() if output is not None else None
    sampled = point_data.GetArray(output_name) if point_data is not None else None
    if sampled is None:
        raise AnalysisError(
            f"VTK probe returned no values for {association} array '{name}' "
            f"({dataset.GetClassName()} source)"
        )
    sampled_values = np.asarray(numpy_support.vtk_to_numpy(sampled), dtype=float)
    if sampled_values.ndim == 1:
        sampled_values = sampled_values.reshape(-1, 1)
    if sampled_values.shape[0] != coordinates.shape[0]:
        raise AnalysisError(
            f"VTK probe returned {sampled_values.shape[0]} values for {coordinates.shape[0]} points"
        )
    if sampled_values.shape[1] != components:
        raise AnalysisError(
            f"VTK probe returned {sampled_values.shape[1]} components for "
            f"{components}-component {association} array '{name}'"
        )

    mask_array = point_data.GetArray("vtkValidPointMask")
    if mask_array is None:
        mask = np.ones(coordinates.shape[0], dtype=bool)
    else:
        mask = np.asarray(numpy_support.vtk_to_numpy(mask_array)) != 0
        if mask.size != coordinates.shape[0]:
            raise AnalysisError("VTK probe returned a mismatched vtkValidPointMask")

    reduced = _reduce_components(sampled_values, component)
    valid = mask & np.isfinite(reduced)
    return {
        "values": [float(value) if valid[index] else None for index, value in enumerate(reduced)],
        "valid": [bool(flag) for flag in valid],
        "dataRange": data_range,
    }


def build_probe_result(file_path, association, name, positions, sampled, series=None, length=None):
    """Assemble the JSON-safe ``base.probe`` result object.

    ``sampled`` is the dict returned by :func:`sample_array_values`.
    ``series``/``length`` are the path-mode outputs of :func:`path_samples`;
    when given, ``series`` rows repeat the sampled value/validity next to
    each cumulative ``distance`` and the object gains a ``length`` key.
    ``dataRange`` is omitted when the source array has no finite values.
    """
    values = list(sampled.get("values", []))
    valid = list(sampled.get("valid", []))
    if len(values) != len(positions) or len(valid) != len(positions):
        raise AnalysisError("sampled values do not match the probe point count")

    points = [
        {
            "position": [float(axis) for axis in position],
            "value": values[index],
            "valid": bool(valid[index]),
        }
        for index, position in enumerate(positions)
    ]
    result = {
        "file": file_path,
        "array": name,
        "association": association,
        "points": points,
    }
    data_range = sampled.get("dataRange")
    if data_range is not None:
        result["dataRange"] = [float(data_range[0]), float(data_range[1])]

    if series is not None:
        if length is None:
            raise AnalysisError("path probe is missing its polyline length")
        if len(series) != len(points):
            raise AnalysisError("path samples do not match the probe point count")
        result["series"] = [
            {
                "distance": float(sample["distance"]),
                "position": points[index]["position"],
                "value": points[index]["value"],
                "valid": points[index]["valid"],
            }
            for index, sample in enumerate(series)
        ]
        result["length"] = float(length)
    return result
