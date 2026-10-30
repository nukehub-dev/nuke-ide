# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Headless dataset export command for the base visualizer (no server).

Registers one command over VTK datasets:

- ``base.export --file <vtk> --output <path> --format csv|vtk|gltf
  [--array <cell|point:name>] [--block <id>]`` writes the requested export
  and prints one JSON object ``{path, format, rows?, arrays?}`` on stdout.

CSV writes one row per tuple with a 0-based ``tuple`` column followed by the
selected association's arrays (point data by default, cell data for
cell-only datasets; or just the picked array plus coordinates when
``--array`` is given). VTK writes the same dataset, preferring XML output
suffixes; glTF writes the dataset surface when the installed VTK exposes a
headless glTF writer. ``--block`` restricts the export to cells carrying that
block/volume id.

VTK is imported lazily inside the handler so a missing dependency surfaces as
one JSON error on stderr with exit code 1, never a traceback (base-plugin
contract). The pure CSV/format helpers live in ``plugins/base/lib/export.py``.
"""

import json
import os
import sys

import numpy as np
from nuke_viz.plugin import arg, command

from plugins.base.lib.export import (
    ExportError,
    default_extension,
    export_csv_payload,
    parse_array_spec,
    validate_export_format,
    validate_output_extension,
)

#: Input suffixes accepted by the export command (VTK XML + legacy).
VTK_SUFFIXES = (".vtk", ".vtp", ".vtu", ".vti", ".vtr", ".vts")

#: XML input suffixes reused when ``--output`` has no extension.
_XML_SUFFIXES = (".vtp", ".vtu", ".vti", ".vtr", ".vts")

#: XML writer + expected dataset class per output suffix.
_XML_WRITERS = {
    ".vtp": ("vtkPolyData", "vtkXMLPolyDataWriter"),
    ".vtu": ("vtkUnstructuredGrid", "vtkXMLUnstructuredGridWriter"),
    ".vti": ("vtkImageData", "vtkXMLImageDataWriter"),
    ".vtr": ("vtkRectilinearGrid", "vtkXMLRectilinearGridWriter"),
    ".vts": ("vtkStructuredGrid", "vtkXMLStructuredGridWriter"),
}

#: Numeric cell arrays treated as per-block ids for ``--block``.
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
    """Lazily import ``vtk`` and ``numpy_support`` or raise :class:`ExportError`."""
    try:
        import vtk
        from vtk.util import numpy_support
    except ImportError as exc:
        raise ExportError(f"vtk is required for export commands (not installed): {exc}") from None
    return vtk, numpy_support


def _require_input(path):
    """Validate a VTK input path and return its lowercase suffix."""
    if not path or not isinstance(path, str):
        raise ExportError("--file must be a non-empty path")
    if not os.path.isfile(path):
        raise ExportError(f"File not found: {path}")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in VTK_SUFFIXES:
        expected = ", ".join(VTK_SUFFIXES)
        raise ExportError(f"Unsupported VTK suffix '{suffix or '<none>'}' (expected: {expected})")
    return suffix


def _read_dataset(path):
    """Read a legacy/XML VTK dataset; return ``(vtk, numpy_support, dataset)``."""
    suffix = _require_input(path)
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
        raise ExportError(f"Could not read VTK file: {path} ({exc})") from None
    if dataset is None or not dataset.IsA("vtkDataSet"):
        raise ExportError(f"Unsupported VTK dataset in file: {path}")
    return vtk, numpy_support, dataset


def _resolve_output_path(path, format_name, input_path):
    """Validate ``--output``, appending a matching default suffix when missing."""
    if not isinstance(path, str) or not path.strip():
        raise ExportError("--output must be a non-empty path")
    suffix = os.path.splitext(path)[1].lower()
    if not suffix:
        if format_name == "vtk":
            input_suffix = os.path.splitext(input_path)[1].lower() if input_path else ""
            suffix = input_suffix if input_suffix in _XML_SUFFIXES else ".vtk"
        else:
            suffix = default_extension(format_name)
        path += suffix
    validate_output_extension(path, format_name)
    return path


def _attributes(dataset, association):
    """Return the point or cell data attributes for one association."""
    if association == "point":
        return dataset.GetPointData()
    if association == "cell":
        return dataset.GetCellData()
    raise ExportError(f"Unsupported array association '{association}' (expected cell or point)")


def _array_names(attributes):
    """Named arrays present on one attribute set."""
    names = []
    for index in range(attributes.GetNumberOfArrays()):
        array = attributes.GetArray(index)
        if array is not None and array.GetName():
            names.append(array.GetName())
    return names


def _read_array(numpy_support, dataset, association, name):
    """Read one numeric VTK array as ``(flat values, components)``."""
    attributes = _attributes(dataset, association)
    array = attributes.GetArray(name)
    if array is None:
        available = _array_names(attributes)
        listing = ", ".join(available) if available else "<none>"
        raise ExportError(f"{association} array '{name}' not found (available arrays: {listing})")

    components = max(1, int(array.GetNumberOfComponents()))
    tuple_count = int(array.GetNumberOfTuples())
    expected = int(
        dataset.GetNumberOfPoints() if association == "point" else dataset.GetNumberOfCells()
    )
    if tuple_count != expected:
        raise ExportError(
            f"{association} array '{name}' has {tuple_count} tuples; expected {expected}"
        )
    try:
        values = np.asarray(numpy_support.vtk_to_numpy(array)).reshape(-1)
    except Exception:
        raise ExportError(f"{association} array '{name}' is not a numeric VTK array") from None
    if values.size != tuple_count * components:
        raise ExportError(
            f"{association} array '{name}' has {values.size} values; "
            f"expected {tuple_count * components}"
        )
    return values, components


def _default_association(dataset):
    """Pick the array association exported when ``--array`` is omitted."""
    if _array_names(dataset.GetPointData()):
        return "point"
    if _array_names(dataset.GetCellData()):
        return "cell"
    raise ExportError("dataset has no point or cell arrays to export")


def _find_block_array(numpy_support, dataset):
    """Return ``(name, values)`` candidates for the cell block-id array."""
    cell_data = dataset.GetCellData()
    candidates = []
    for index in range(cell_data.GetNumberOfArrays()):
        array = cell_data.GetArray(index)
        if array is None or not array.GetName():
            continue
        key = array.GetName().strip().lower().replace(" ", "_")
        if key not in _BLOCK_ARRAY_NAMES:
            continue
        if int(array.GetNumberOfComponents()) != 1:
            continue
        try:
            values = np.asarray(numpy_support.vtk_to_numpy(array)).reshape(-1)
        except Exception:
            continue
        if values.size != dataset.GetNumberOfCells():
            continue
        candidates.append((array.GetName(), values))
    return candidates


def _block_cell_mask(numpy_support, dataset, block_id):
    """Return ``(mask, array_name)`` for cells carrying ``block_id``."""
    candidates = _find_block_array(numpy_support, dataset)
    if not candidates:
        looked_for = ", ".join(_BLOCK_ARRAY_NAMES)
        raise ExportError(
            f"dataset has no numeric block array for --block (looked for: {looked_for})"
        )
    for name, values in candidates:
        mask = values == block_id
        if np.any(mask):
            return mask, name
    tried = ", ".join(name for name, _ in candidates)
    raise ExportError(f"block id {block_id} not found in cell array(s): {tried}")


def _points_of_cells(dataset, cell_mask):
    """Point mask for the points referenced by the selected cells."""
    mask = np.zeros(int(dataset.GetNumberOfPoints()), dtype=bool)
    for cell_id in np.flatnonzero(cell_mask):
        cell = dataset.GetCell(int(cell_id))
        if cell is None:
            continue
        point_ids = cell.GetPointIds()
        for index in range(point_ids.GetNumberOfIds()):
            mask[point_ids.GetId(index)] = True
    return mask


def _mask_array(values, components, mask):
    """Subset a flat array's tuples by ``mask``; return a flat numpy array."""
    array = np.asarray(values)
    if array.size == 0:
        return array
    return array.reshape(-1, components)[mask].reshape(-1)


def _coordinates(vtk, numpy_support, dataset, association):
    """Point coordinates or cell centers as an ``(n, 3)`` float array."""
    count = int(
        dataset.GetNumberOfPoints() if association == "point" else dataset.GetNumberOfCells()
    )
    if count == 0:
        return np.zeros((0, 3), dtype=float)

    if association == "point":
        points = dataset.GetPoints()
        if points is None:
            raise ExportError("dataset has no point coordinates")
        raw = points.GetData()
        source = "point coordinates"
    else:
        centers = vtk.vtkCellCenters()
        centers.SetInputData(dataset)
        centers.Update()
        centers_dataset = centers.GetOutput()
        if centers_dataset is None or centers_dataset.GetPoints() is None:
            raise ExportError("could not compute cell-center coordinates")
        raw = centers_dataset.GetPoints().GetData()
        source = "cell-center coordinates"

    coordinates = np.asarray(numpy_support.vtk_to_numpy(raw), dtype=float)
    if coordinates.ndim != 2 or coordinates.shape[1] < 3 or coordinates.shape[0] != count:
        raise ExportError(
            f"{source} do not match the dataset tuples "
            f"(got shape {coordinates.shape}, expected ({count}, 3))"
        )
    return coordinates[:, :3]


def _write_text(path, text):
    """Write UTF-8 text, creating the parent directory when needed."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def _export_csv(vtk, numpy_support, dataset, output, array_spec, block_id):
    """Write the CSV export and return its JSON result."""
    if array_spec is not None:
        association, name = array_spec
        _read_array(numpy_support, dataset, association, name)
        names = [name]
    else:
        association = _default_association(dataset)
        names = _array_names(_attributes(dataset, association))

    cell_mask = None
    point_mask = None
    if block_id is not None:
        cell_mask, _ = _block_cell_mask(numpy_support, dataset, block_id)
        if association == "cell":
            tuple_mask = cell_mask
        else:
            point_mask = _points_of_cells(dataset, cell_mask)
            tuple_mask = point_mask
    else:
        tuple_mask = None

    tuple_count = int(
        dataset.GetNumberOfPoints() if association == "point" else dataset.GetNumberOfCells()
    )
    if tuple_mask is not None:
        tuple_indices = np.flatnonzero(tuple_mask)
    else:
        tuple_indices = np.arange(tuple_count)

    extra_columns = [("tuple", tuple_indices)]
    if array_spec is not None:
        coordinates = _coordinates(vtk, numpy_support, dataset, association)
        if cell_mask is not None and association == "cell":
            coordinates = coordinates[cell_mask]
        elif point_mask is not None:
            coordinates = coordinates[point_mask]
        extra_columns.extend(
            [
                ("x", coordinates[:, 0]),
                ("y", coordinates[:, 1]),
                ("z", coordinates[:, 2]),
            ]
        )

    arrays = []
    for name in names:
        values, components = _read_array(numpy_support, dataset, association, name)
        if tuple_mask is not None:
            values = _mask_array(values, components, tuple_mask)
        arrays.append({"name": name, "values": values, "components": components})

    payload = export_csv_payload(arrays, extra_columns)
    _write_text(output, payload["csv"])
    return {
        "path": os.path.abspath(output),
        "format": "csv",
        "rows": payload["rows"],
        "arrays": payload["arrays"],
    }


def _extract_block(vtk, numpy_support, dataset, block_id):
    """Extract the cells carrying ``block_id`` into an unstructured grid."""
    cell_mask, _ = _block_cell_mask(numpy_support, dataset, block_id)
    ids = vtk.vtkIdList()
    for cell_id in np.flatnonzero(cell_mask):
        ids.InsertNextId(int(cell_id))
    extract = vtk.vtkExtractCells()
    extract.SetInputData(dataset)
    extract.SetCellList(ids)
    extract.Update()
    output = extract.GetOutput()
    if output is None or int(output.GetNumberOfCells()) == 0:
        raise ExportError(f"block id {block_id} produced no cells")
    if hasattr(vtk, "vtkCleanUnstructuredGrid"):
        clean = vtk.vtkCleanUnstructuredGrid()
        clean.SetInputData(output)
        clean.Update()
        output = clean.GetOutput()
    return output


def _keep_only_array(dataset, association, name):
    """Drop every point/cell array except the picked one."""
    attributes = _attributes(dataset, association)
    if attributes.GetArray(name) is None:
        available = _array_names(attributes)
        listing = ", ".join(available) if available else "<none>"
        raise ExportError(f"{association} array '{name}' not found (available arrays: {listing})")
    for other_association in ("point", "cell"):
        target = _attributes(dataset, other_association)
        for array_name in _array_names(target):
            if other_association != association or array_name != name:
                target.RemoveArray(array_name)


def _write_dataset(vtk, dataset, output):
    """Write the dataset with the writer matching its class and output suffix."""
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    suffix = os.path.splitext(output)[1].lower()
    if suffix == ".vtk":
        writer = vtk.vtkGenericDataObjectWriter()
    else:
        expected_class, writer_name = _XML_WRITERS[suffix]
        if not dataset.IsA(expected_class):
            raise ExportError(
                f"Output suffix '{suffix}' requires a {expected_class} dataset, "
                f"got {dataset.GetClassName()} (use .vtk for a legacy export)"
            )
        writer = getattr(vtk, writer_name)()
    writer.SetFileName(output)
    writer.SetInputData(dataset)
    writer.Write()
    if not os.path.isfile(output):
        raise ExportError(f"Failed to write output VTK file: {output}")


def _export_vtk(vtk, numpy_support, dataset, output, array_spec, block_id):
    """Write the VTK export and return its JSON result."""
    if block_id is not None:
        dataset = _extract_block(vtk, numpy_support, dataset, block_id)
    arrays = None
    if array_spec is not None:
        association, name = array_spec
        _keep_only_array(dataset, association, name)
        arrays = [name]
    _write_dataset(vtk, dataset, output)
    result = {"path": os.path.abspath(output), "format": "vtk"}
    if arrays is not None:
        result["arrays"] = arrays
    return result


def _surface_polydata(vtk, dataset):
    """Return a polydata surface for a dataset (geometry filter when needed)."""
    if dataset.IsA("vtkPolyData"):
        surface = dataset
    else:
        geometry = vtk.vtkGeometryFilter()
        geometry.SetInputData(dataset)
        geometry.Update()
        surface = geometry.GetOutput()
    if surface is None or (
        int(surface.GetNumberOfPolys()) == 0 and int(surface.GetNumberOfStrips()) == 0
    ):
        raise ExportError("dataset has no surface polygons to export as glTF")
    return surface


def _gltf_writer_class(vtk):
    """Return ``(class, kind)`` for a polydata-capable glTF writer, or ``(None, None)``.

    ``vtkGLTFWriter`` is the headless writer (VTK >= 9.5) but expects a
    CityGML-style nested multiblock; ``vtkGLTFExporter`` only helps when the
    installed build exposes a direct data input (newer signatures). The scene
    exporter's render-window input is never used: converters must not create
    render windows.
    """
    writer_class = getattr(vtk, "vtkGLTFWriter", None)
    if writer_class is not None:
        return writer_class, "writer"
    exporter_class = getattr(vtk, "vtkGLTFExporter", None)
    if exporter_class is not None and hasattr(exporter_class(), "SetInputData"):
        return exporter_class, "exporter"
    return None, None


def _export_gltf(vtk, numpy_support, dataset, output, block_id):
    """Write the glTF export and return its JSON result."""
    writer_class, kind = _gltf_writer_class(vtk)
    if writer_class is None:
        raise ExportError(
            "glTF export is not available in this VTK build "
            "(no polydata-capable vtkGLTFWriter/vtkGLTFExporter)"
        )
    if block_id is not None:
        dataset = _extract_block(vtk, numpy_support, dataset, block_id)
    surface = _surface_polydata(vtk, dataset)
    triangles = vtk.vtkTriangleFilter()
    triangles.SetInputData(surface)
    triangles.Update()
    triangulated = triangles.GetOutput()
    if triangulated is None or int(triangulated.GetNumberOfPolys()) == 0:
        raise ExportError("dataset has no surface polygons to export as glTF")

    if kind == "exporter":
        exporter = writer_class()
        exporter.SetFileName(output)
        exporter.SetInputData(triangulated)
        exporter.Write()
    else:
        normals = vtk.vtkPolyDataNormals()
        normals.SetInputData(triangulated)
        normals.ComputePointNormalsOn()
        normals.SplittingOff()
        normals.Update()
        shaded = normals.GetOutput()
        if shaded is not None:
            triangulated = shaded
        # vtkGLTFWriter walks a multiblock of buildings, each a multiblock of
        # polydata pieces; a flat multiblock dereferences a null building.
        piece = vtk.vtkMultiBlockDataSet()
        piece.SetNumberOfBlocks(1)
        piece.SetBlock(0, triangulated)
        blocks = vtk.vtkMultiBlockDataSet()
        blocks.SetNumberOfBlocks(1)
        blocks.SetBlock(0, piece)
        writer = writer_class()
        writer.SetFileName(output)
        writer.SetInputData(blocks)
        if hasattr(writer, "SetInlineData"):
            writer.SetInlineData(True)
        if hasattr(writer, "SetSaveNormal"):
            writer.SetSaveNormal(True)
        writer.Write()

    if not os.path.isfile(output):
        raise ExportError(f"Failed to write glTF output: {output}")
    return {"path": os.path.abspath(output), "format": "gltf"}


@command("base.export", help="Export a VTK dataset as CSV, VTK, or glTF")
@arg("--file", required=True, help="Path to the input VTK dataset")
@arg("--output", required=True, help="Path for the exported file")
@arg("--format", default="csv", help="Export format: csv, vtk, or gltf (default: csv)")
@arg("--array", help="Array spec: cell:<name> or point:<name>")
@arg("--block", type=int, help="Restrict export to one block/volume id")
def cmd_export(args):
    """Export a VTK dataset and print one JSON result on stdout."""
    try:
        format_name = validate_export_format(args.format)
        output = _resolve_output_path(args.output, format_name, args.file)
        array_spec = parse_array_spec(args.array) if args.array else None
        if format_name == "gltf" and array_spec is not None:
            raise ExportError(
                "--array is not supported for glTF export (glTF stores geometry only)"
            )
        vtk, numpy_support, dataset = _read_dataset(args.file)
        if format_name == "csv":
            result = _export_csv(vtk, numpy_support, dataset, output, array_spec, args.block)
        elif format_name == "vtk":
            result = _export_vtk(vtk, numpy_support, dataset, output, array_spec, args.block)
        else:
            result = _export_gltf(vtk, numpy_support, dataset, output, args.block)
    except Exception as exc:
        return _error_json(exc)
    print(json.dumps(result))
    return 0
