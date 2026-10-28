# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Headless analysis commands for the base visualizer (no server).

Registers three commands over VTK datasets:

- ``base.integrate --file <vtk> --array <cell|point:name> [--surface|--volume]``
  prints ``{total, mean, measure, measureKind, count, nanCount, association,
  array, perBlock?}``. Cell arrays integrate ``value * cell volume/area``;
  point arrays integrate lumped point volumes/areas. ``perBlock`` is added
  when a numeric block/volume-id cell array exists.
- ``base.describe --file <vtk> --array <cell|point:name>`` prints
  ``{min, q1, median, q3, max, mean, std, count, nanCount, association,
  array}`` with non-finite values excluded.
- ``base.mesh-quality --file <vtk> --output <path> [--metric
  area|min-angle|aspect|volume]`` writes a VTK dataset with the metric as
  the cell array ``mesh_quality_<metric>`` and prints
  ``{path, metric, min, max, count, arrayName}``.

VTK is imported lazily inside the readers/writers so the pure helpers stay
numpy-only and a missing dependency surfaces as one JSON error on stderr
with exit code 1, never a traceback (base-plugin contract).
"""

import json
import os
import sys

import numpy as np
from nuke_viz.plugin import arg, command

from plugins.base.lib.analysis import (
    AnalysisError,
    describe_values,
    integrate_cell_values,
    integrate_point_values,
    mesh_quality_tets,
    mesh_quality_triangles,
)

#: Input suffixes accepted by the analysis commands (VTK XML + legacy).
VTK_SUFFIXES = (".vtk", ".vtp", ".vtu", ".vti", ".vtr", ".vts")

#: Supported ``base.mesh-quality`` metrics.
MESH_QUALITY_METRICS = ("area", "min-angle", "aspect", "volume")

#: XML writer + expected dataset class per output suffix.
_XML_WRITERS = {
    ".vtp": ("vtkPolyData", "vtkXMLPolyDataWriter"),
    ".vtu": ("vtkUnstructuredGrid", "vtkXMLUnstructuredGridWriter"),
    ".vti": ("vtkImageData", "vtkXMLImageDataWriter"),
    ".vtr": ("vtkRectilinearGrid", "vtkXMLRectilinearGridWriter"),
    ".vts": ("vtkStructuredGrid", "vtkXMLStructuredGridWriter"),
}

#: Numeric cell arrays treated as per-block ids for ``perBlock`` aggregation.
_BLOCK_ARRAY_NAMES = (
    "block",
    "block_id",
    "blockid",
    "volume_id",
    "volumeid",
    "material_id",
    "materialid",
)


def _error_json(exc):
    """Print one JSON error object on stderr and return exit code 1."""
    message = str(exc) or exc.__class__.__name__
    print(json.dumps({"error": message}), file=sys.stderr)
    return 1


def _load_vtk():
    """Lazily import ``vtk`` and ``numpy_support`` or raise :class:`AnalysisError`."""
    try:
        import vtk
        from vtk.util import numpy_support
    except ImportError as exc:
        raise AnalysisError(
            f"vtk is required for analysis commands (not installed): {exc}"
        ) from None
    return vtk, numpy_support


def _require_file(path):
    """Validate a VTK input path and return its suffix."""
    if not path or not isinstance(path, str):
        raise AnalysisError("--file must be a non-empty path")
    if not os.path.isfile(path):
        raise AnalysisError(f"File not found: {path}")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in VTK_SUFFIXES:
        expected = ", ".join(VTK_SUFFIXES)
        raise AnalysisError(f"Unsupported VTK suffix '{suffix or '<none>'}' (expected: {expected})")
    return suffix


def _require_output_path(path):
    """Validate a VTK output path and return its suffix."""
    if not path or not isinstance(path, str):
        raise AnalysisError("--output must be a non-empty path")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in VTK_SUFFIXES:
        expected = ", ".join(VTK_SUFFIXES)
        raise AnalysisError(
            f"Unsupported output suffix '{suffix or '<none>'}' (expected: {expected})"
        )
    return suffix


def _read_dataset(path):
    """Read a legacy/XML VTK dataset; return ``(vtk, numpy_support, dataset)``."""
    suffix = _require_file(path)
    vtk, numpy_support = _load_vtk()
    if suffix == ".vtk":
        reader = vtk.vtkGenericDataObjectReader()
    else:
        reader = vtk.vtkXMLGenericDataObjectReader()
    reader.SetFileName(path)
    try:
        reader.Update()
        dataset = reader.GetOutput()
    except Exception as exc:
        raise AnalysisError(f"Could not read VTK file: {path} ({exc})") from None
    if dataset is None or not dataset.IsA("vtkDataSet"):
        raise AnalysisError(f"Unsupported VTK dataset in file: {path}")
    return vtk, numpy_support, dataset


def parse_array_spec(spec):
    """Parse ``cell:<name>`` / ``point:<name>``; return ``(association, name)``."""
    if not isinstance(spec, str) or ":" not in spec:
        raise AnalysisError("--array must be 'cell:<name>' or 'point:<name>'")
    association, name = spec.split(":", 1)
    association = association.strip().lower()
    name = name.strip()
    if association not in ("cell", "point"):
        raise AnalysisError(
            f"Unsupported array association '{association}' (expected cell or point)"
        )
    if not name:
        raise AnalysisError("--array is missing the array name after the association prefix")
    return association, name


def _array_values(numpy_support, attributes, name, association, expected_count):
    """Read one scalar VTK data array as a float numpy array."""
    array = attributes.GetArray(name)
    if array is None:
        available = []
        for index in range(attributes.GetNumberOfArrays()):
            candidate = attributes.GetArray(index)
            if candidate is not None and candidate.GetName():
                available.append(candidate.GetName())
        listing = ", ".join(available) if available else "<none>"
        raise AnalysisError(
            f"{association} array '{name}' not found (available numeric arrays: {listing})"
        )
    components = int(array.GetNumberOfComponents())
    if components != 1:
        raise AnalysisError(
            f"{association} array '{name}' has {components} components; expected a scalar array"
        )
    values = numpy_support.vtk_to_numpy(array).astype(float, copy=False)
    if values.size != expected_count:
        raise AnalysisError(
            f"{association} array '{name}' has {values.size} values; expected {expected_count}"
        )
    return values


def _cell_measures(vtk, numpy_support, dataset, kind):
    """VTK-computed per-cell measures: ``kind`` is ``area`` or ``volume``."""
    if not hasattr(vtk, "vtkCellSizeFilter"):
        raise AnalysisError("vtkCellSizeFilter is required to compute cell measures (VTK >= 9.1)")
    size_filter = vtk.vtkCellSizeFilter()
    size_filter.SetInputData(dataset)
    size_filter.SetComputeArea(kind == "area")
    size_filter.SetComputeVolume(kind == "volume")
    size_filter.SetComputeLength(False)
    if hasattr(size_filter, "SetComputeVertexCount"):
        size_filter.SetComputeVertexCount(False)
    size_filter.Update()
    output = size_filter.GetOutput()
    array_name = "Area" if kind == "area" else "Volume"
    array = output.GetCellData().GetArray(array_name)
    if array is None:
        raise AnalysisError(
            f"VTK could not compute cell {kind} for {dataset.GetClassName()} datasets"
        )
    values = numpy_support.vtk_to_numpy(array).astype(float, copy=False)
    if values.size != dataset.GetNumberOfCells():
        raise AnalysisError(
            f"VTK returned {values.size} cell {kind} values for {dataset.GetNumberOfCells()} cells"
        )
    return values


def _dataset_cells(dataset):
    """Return the single cell array for grid datasets / polygon-only polydata."""
    if dataset.IsA("vtkPolyData"):
        if dataset.GetNumberOfVerts() or dataset.GetNumberOfLines() or dataset.GetNumberOfStrips():
            return None
        return dataset.GetPolys()
    return dataset.GetCells()


def _point_measures(numpy_support, dataset, cell_measures):
    """Lump each cell measure evenly over its points (standard point integration)."""
    point_count = int(dataset.GetNumberOfPoints())
    if point_count == 0:
        raise AnalysisError("dataset has no points to integrate")
    lumped = np.zeros(point_count, dtype=float)
    cells = _dataset_cells(dataset)
    offsets = connectivity = None
    try:
        offsets = numpy_support.vtk_to_numpy(cells.GetOffsetsArray()).astype(np.int64)
        connectivity = numpy_support.vtk_to_numpy(cells.GetConnectivityArray()).astype(np.int64)
    except Exception:
        offsets = connectivity = None

    if (
        offsets is not None
        and connectivity is not None
        and offsets.size == cell_measures.size + 1
        and np.all(np.diff(offsets) > 0)
    ):
        if connectivity.size and (connectivity.min() < 0 or connectivity.max() >= point_count):
            raise AnalysisError("VTK cell connectivity references invalid point indices")
        counts = np.diff(offsets)
        per_point = np.repeat(cell_measures / counts, counts)
        return np.bincount(connectivity, weights=per_point, minlength=point_count)

    for index in range(cell_measures.size):
        cell = dataset.GetCell(index)
        count = int(cell.GetNumberOfPoints())
        if count <= 0:
            raise AnalysisError(f"dataset cell {index} has no points")
        share = cell_measures[index] / count
        for offset in range(count):
            lumped[cell.GetPointId(offset)] += share
    return lumped


def _find_block_array(numpy_support, dataset):
    """Return ``(name, values)`` for the first numeric block-id cell array."""
    cell_data = dataset.GetCellData()
    for index in range(cell_data.GetNumberOfArrays()):
        array = cell_data.GetArray(index)
        if array is None or not array.GetName():
            continue
        key = array.GetName().strip().lower().replace(" ", "_")
        if key not in _BLOCK_ARRAY_NAMES:
            continue
        if int(array.GetNumberOfComponents()) != 1:
            continue
        return array.GetName(), numpy_support.vtk_to_numpy(array)
    return None, None


def _block_key(value):
    """JSON-safe block id: int for integral ids, float otherwise."""
    number = float(value)
    return int(number) if number.is_integer() else number


def _per_block(blocks, values, measures):
    """Aggregate integration statistics per block id."""
    entries = []
    for block in np.unique(blocks[np.isfinite(blocks)]):
        mask = blocks == block
        try:
            stats = integrate_cell_values(values[mask], measures[mask])
        except AnalysisError:
            # A block whose values are all non-finite still gets a row so the
            # UI can show its measure instead of dropping the block silently.
            subset = measures[mask]
            stats = {
                "total": 0.0,
                "mean": 0.0,
                "measure": float(subset[np.isfinite(subset)].sum()),
                "count": 0,
                "nanCount": int(mask.sum()),
            }
        entries.append({"block": _block_key(block), **stats})
    return entries


def _integrate_dataset(vtk, numpy_support, dataset, association, name, kind, block_id):
    """Shared body of ``base.integrate`` over an already-read dataset."""
    cell_count = int(dataset.GetNumberOfCells())
    if cell_count == 0:
        raise AnalysisError("dataset has no cells to integrate")
    if kind is None:
        kind = "volume" if _has_volumetric_cells(vtk, numpy_support, dataset) else "area"
    cell_measures = _cell_measures(vtk, numpy_support, dataset, kind)
    measure_kind = "area" if kind == "area" else "volume"

    if association == "cell":
        values = _array_values(numpy_support, dataset.GetCellData(), name, "cell", cell_count)
        block_name, block_values = _find_block_array(numpy_support, dataset)
        per_block = None
        if block_id is not None:
            if block_values is None:
                raise AnalysisError(
                    "dataset has no numeric block array for --block "
                    f"(looked for: {', '.join(_BLOCK_ARRAY_NAMES)})"
                )
            mask = block_values == block_id
            if not np.any(mask):
                raise AnalysisError(f"block id {block_id} not found in cell array '{block_name}'")
            values = values[mask]
            cell_measures = cell_measures[mask]
        elif block_values is not None:
            per_block = _per_block(block_values, values, cell_measures)
        stats = integrate_cell_values(values, cell_measures)
        result = {
            "total": stats["total"],
            "mean": stats["mean"],
            "measure": stats["measure"],
            "measureKind": measure_kind,
            "count": stats["count"],
            "nanCount": stats["nanCount"],
            "association": "cell",
            "array": name,
        }
        if per_block is not None:
            result["perBlock"] = per_block
        return result

    if block_id is not None:
        raise AnalysisError("--block is only supported for cell arrays")
    point_count = int(dataset.GetNumberOfPoints())
    if point_count == 0:
        raise AnalysisError("dataset has no points to integrate")
    values = _array_values(numpy_support, dataset.GetPointData(), name, "point", point_count)
    point_measures = _point_measures(numpy_support, dataset, cell_measures)
    stats = integrate_point_values(values, point_measures)
    return {
        "total": stats["total"],
        "mean": stats["mean"],
        "measure": stats["measure"],
        "measureKind": measure_kind,
        "count": stats["count"],
        "nanCount": stats["nanCount"],
        "association": "point",
        "array": name,
    }


def _distinct_cell_types(vtk, numpy_support, dataset):
    """Distinct VTK cell-type ids in a dataset (version-tolerant)."""
    if hasattr(dataset, "GetDistinctCellTypes"):
        cell_types = vtk.vtkCellTypes()
        dataset.GetDistinctCellTypes(cell_types)
        return {
            int(cell_types.GetCellType(index)) for index in range(cell_types.GetNumberOfTypes())
        }
    getter = getattr(dataset, "GetCellTypesArray", None)
    if getter is not None:
        try:
            return set(np.unique(numpy_support.vtk_to_numpy(getter())).tolist())
        except Exception:
            pass
    return {int(dataset.GetCellType(index)) for index in range(dataset.GetNumberOfCells())}


def _homogeneous_topology(vtk, numpy_support, dataset, vtk_cell_type, width):
    """Return ``(points, connectivity)`` when every cell has the given type/width."""
    if _distinct_cell_types(vtk, numpy_support, dataset) != {vtk_cell_type}:
        return None, None
    try:
        cells = _dataset_cells(dataset)
        offsets = numpy_support.vtk_to_numpy(cells.GetOffsetsArray())
        connectivity = numpy_support.vtk_to_numpy(cells.GetConnectivityArray())
        points = numpy_support.vtk_to_numpy(dataset.GetPoints().GetData())
    except Exception:
        return None, None
    counts = np.diff(offsets)
    if counts.size != dataset.GetNumberOfCells() or not np.all(counts == width):
        return None, None
    if connectivity.size != counts.size * width:
        return None, None
    return points, connectivity.reshape(-1, width)


def _has_volumetric_cells(vtk, numpy_support, dataset):
    """True when the dataset contains any 3-D cell type (image data included)."""
    if dataset.IsA("vtkImageData"):
        return True
    volumetric = {
        vtk.VTK_TETRA,
        vtk.VTK_VOXEL,
        vtk.VTK_HEXAHEDRON,
        vtk.VTK_WEDGE,
        vtk.VTK_PYRAMID,
    }
    return bool(_distinct_cell_types(vtk, numpy_support, dataset) & volumetric)


def _cell_size_metric(vtk, numpy_support, dataset, kind):
    """Fallback cell area/volume metric for non-triangle/tet cell types."""
    values = _cell_measures(vtk, numpy_support, dataset, kind)
    if kind == "volume" and values.size and not np.any(values > 0.0):
        raise AnalysisError("cell volume is zero for every cell (surface mesh?); use --metric area")
    return values


def _vtk_quality_metric(vtk, numpy_support, dataset, metric):
    """VTK ``vtkMeshQuality`` fallback for quad/hex and mixed-cell datasets."""
    supported = {
        "min-angle": {vtk.VTK_TRIANGLE, vtk.VTK_QUAD, vtk.VTK_TETRA},
        "aspect": {
            vtk.VTK_TRIANGLE,
            vtk.VTK_QUAD,
            vtk.VTK_TETRA,
            vtk.VTK_HEXAHEDRON,
        },
    }[metric]
    unsupported = _distinct_cell_types(vtk, numpy_support, dataset) - supported
    if unsupported:
        names = ", ".join(str(cell_type) for cell_type in sorted(unsupported))
        raise AnalysisError(f"metric '{metric}' does not support VTK cell type ids: {names}")

    quality = vtk.vtkMeshQuality()
    quality.SetInputData(dataset)
    if metric == "min-angle":
        quality.SetTriangleQualityMeasureToMinAngle()
        quality.SetQuadQualityMeasureToMinAngle()
        quality.SetTetQualityMeasureToMinAngle()
    else:
        quality.SetTriangleQualityMeasureToAspectRatio()
        quality.SetQuadQualityMeasureToAspectRatio()
        quality.SetTetQualityMeasureToAspectRatio()
        # vtkMeshQuality has no hex "aspect ratio"; max aspect Frobenius is
        # the nearest aspect metric (1 is still the best possible value).
        set_hex = getattr(quality, "SetHexQualityMeasureToMaxAspectFrobenius", None)
        if set_hex is not None:
            set_hex()
    quality.Update()
    output = quality.GetOutput()
    array = output.GetCellData().GetArray("Quality")
    if array is None:
        raise AnalysisError(
            f"VTK could not compute the {metric} metric for {dataset.GetClassName()} datasets"
        )
    values = numpy_support.vtk_to_numpy(array).astype(float, copy=False)
    if values.size != dataset.GetNumberOfCells():
        raise AnalysisError(
            f"VTK returned {values.size} {metric} values for {dataset.GetNumberOfCells()} cells"
        )
    return values


def _metric_values(vtk, numpy_support, dataset, metric):
    """Compute one mesh-quality metric per cell as a float numpy array."""
    if int(dataset.GetNumberOfCells()) == 0:
        raise AnalysisError("dataset has no cells for mesh-quality")

    points, triangles = _homogeneous_topology(vtk, numpy_support, dataset, vtk.VTK_TRIANGLE, 3)
    if triangles is not None:
        triangle_keys = {
            "area": "area",
            "min-angle": "min_angle",
            "aspect": "aspect_ratio",
        }
        key = triangle_keys.get(metric)
        if key is not None:
            quality = mesh_quality_triangles(points, triangles, include_skew=False, as_lists=False)
            return quality[key]

    points, tets = _homogeneous_topology(vtk, numpy_support, dataset, vtk.VTK_TETRA, 4)
    if tets is not None:
        tet_keys = {
            "area": "surface_area",
            "aspect": "aspect_ratio",
            "volume": "volume",
        }
        key = tet_keys.get(metric)
        if key is not None:
            quality = mesh_quality_tets(points, tets, as_lists=False)
            return quality[key]

    if metric in ("area", "volume"):
        if metric == "area" and _has_volumetric_cells(vtk, numpy_support, dataset):
            raise AnalysisError("metric 'area' requires 2D cells or an all-tetrahedron mesh")
        return _cell_size_metric(vtk, numpy_support, dataset, metric)
    return _vtk_quality_metric(vtk, numpy_support, dataset, metric)


def _metric_array_name(metric):
    """Cell-array name written for a mesh-quality metric."""
    return "mesh_quality_" + metric.replace("-", "_")


def _set_cell_array(vtk, numpy_support, dataset, name, values):
    """Attach (or replace) one float cell array on the dataset."""
    array = numpy_support.numpy_to_vtk(
        np.ascontiguousarray(values, dtype=float), deep=True, array_type=vtk.VTK_DOUBLE
    )
    array.SetName(name)
    cell_data = dataset.GetCellData()
    if cell_data.GetArray(name) is not None:
        cell_data.RemoveArray(name)
    cell_data.AddArray(array)


def _write_dataset(vtk, dataset, output, suffix):
    """Write the dataset with the writer matching its class and output suffix."""
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    if suffix == ".vtk":
        writer = vtk.vtkGenericDataObjectWriter()
    else:
        expected_class, writer_name = _XML_WRITERS[suffix]
        if not dataset.IsA(expected_class):
            raise AnalysisError(
                f"Output suffix '{suffix}' requires a {expected_class} dataset, "
                f"got {dataset.GetClassName()} (use .vtk for a legacy export)"
            )
        writer = getattr(vtk, writer_name)()
    writer.SetFileName(output)
    writer.SetInputData(dataset)
    writer.Write()
    if not os.path.isfile(output):
        raise AnalysisError(f"Failed to write output VTK file: {output}")


def _finite_range(values):
    """Return ``(min, max, finite_count, non_finite_count)`` over finite entries."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        raise AnalysisError("mesh-quality metric produced no finite values")
    return (
        float(finite.min()),
        float(finite.max()),
        int(finite.size),
        int(values.size - finite.size),
    )


@command("base.integrate", help="Integrate a scalar cell/point array over volume or area")
@arg("--file", required=True, help="Path to the input VTK dataset")
@arg("--array", required=True, help="Array spec: cell:<name> or point:<name>")
@arg("--surface", action="store_true", help="Integrate cell areas instead of volumes")
@arg("--volume", action="store_true", help="Integrate cell volumes (default for volumetric data)")
@arg("--block", type=int, help="Restrict integration to one block/volume id")
def cmd_integrate(args):
    """Integrate a cell/point array and print a JSON result on stdout."""
    try:
        association, name = parse_array_spec(args.array)
        if args.surface and args.volume:
            raise AnalysisError("--surface and --volume are mutually exclusive")
        kind = "area" if args.surface else "volume" if args.volume else None
        vtk, numpy_support, dataset = _read_dataset(args.file)
        result = _integrate_dataset(
            vtk, numpy_support, dataset, association, name, kind, args.block
        )
    except Exception as exc:
        return _error_json(exc)
    print(json.dumps(result))
    return 0


@command("base.describe", help="Describe a scalar cell/point array (min/max/quartiles/std)")
@arg("--file", required=True, help="Path to the input VTK dataset")
@arg("--array", required=True, help="Array spec: cell:<name> or point:<name>")
def cmd_describe(args):
    """Describe a cell/point array and print a JSON result on stdout."""
    try:
        association, name = parse_array_spec(args.array)
        vtk, numpy_support, dataset = _read_dataset(args.file)
        if association == "cell":
            values = _array_values(
                numpy_support,
                dataset.GetCellData(),
                name,
                "cell",
                int(dataset.GetNumberOfCells()),
            )
        else:
            values = _array_values(
                numpy_support,
                dataset.GetPointData(),
                name,
                "point",
                int(dataset.GetNumberOfPoints()),
            )
        result = {
            "association": association,
            "array": name,
            **describe_values(values),
        }
    except Exception as exc:
        return _error_json(exc)
    print(json.dumps(result))
    return 0


@command("base.mesh-quality", help="Write a VTK dataset with a mesh-quality cell array")
@arg("--file", required=True, help="Path to the input VTK dataset")
@arg("--output", required=True, help="Path for the output VTK dataset (.vtp/.vtu/.vtk/...)")
@arg(
    "--metric",
    choices=MESH_QUALITY_METRICS,
    default="aspect",
    help="Quality metric to compute (default: aspect)",
)
def cmd_mesh_quality(args):
    """Compute a mesh-quality metric, write it as a cell array, print JSON."""
    try:
        _require_file(args.file)
        suffix = _require_output_path(args.output)
        vtk, numpy_support, dataset = _read_dataset(args.file)
        values = _metric_values(vtk, numpy_support, dataset, args.metric)
        array_name = _metric_array_name(args.metric)
        _set_cell_array(vtk, numpy_support, dataset, array_name, values)
        minimum, maximum, finite_count, non_finite_count = _finite_range(values)
        _write_dataset(vtk, dataset, args.output, suffix)
        result = {
            "path": os.path.abspath(args.output),
            "metric": args.metric,
            "min": minimum,
            "max": maximum,
            "count": finite_count,
            "nonFiniteCount": non_finite_count,
            "arrayName": array_name,
        }
    except Exception as exc:
        return _error_json(exc)
    print(json.dumps(result))
    return 0
