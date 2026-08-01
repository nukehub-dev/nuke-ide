"""VTK export for OpenMC output files (tracks, collision tracks, weight windows).

Each export converts the HDF5 output (read via ``output_readers``) into a VTK
file that the base visualizer's trame server (``base.serve``) can render —
polylines for particle tracks, a point cloud for collision sites, and a
rectilinear grid with one cell-data array per (bound, energy group) for weight
windows. Geometry construction is numpy-only (unit-testable); ``vtk`` is
imported lazily only for the final file write.
"""

import os
import tempfile

import numpy as np

from plugins.openmc.lib import output_readers
from plugins.openmc.lib.output_readers import OutputReaderError

try:
    import vtk
    from vtk.util import numpy_support

    HAS_VTK = True
except ImportError:
    HAS_VTK = False

# Point-data arrays carried over from track segments (JSON key -> VTK array name)
_TRACK_POINT_ARRAYS = {
    "energies": "energy",
    "times": "time",
    "weights": "weight",
    "cellIds": "cell_id",
}


def _require_vtk():
    if not HAS_VTK:
        raise OutputReaderError("vtk not installed (required for VTK export)")


def _default_output_path(input_path, suffix):
    """Default output path: a temp file next to nothing, derived from the input name."""
    base = os.path.basename(input_path.rstrip("/"))
    stem = os.path.splitext(base)[0].replace(".", "_")
    out_dir = tempfile.mkdtemp(prefix="nuke-openmc-output-")
    return os.path.join(out_dir, f"{stem}{suffix}")


def build_polylines(tracks):
    """Build polyline geometry from ``read_tracks_data()`` track dicts.

    Returns a dict with:
      - ``points``: (N, 3) float array of all polyline vertices
      - ``line_lengths``: (L,) int array with the point count of each line
      - ``point_arrays``: dict of (N,) arrays (energy, time, weight, cell_id)
      - ``line_arrays``: dict of (L,) arrays (pdg, batch, generation,
        particle_id, track_index)

    Pure numpy — no vtk required.
    """
    points = []
    line_lengths = []
    pdg_values = []
    batch_values = []
    gen_values = []
    pid_values = []
    track_index_values = []
    point_data = {key: [] for key in _TRACK_POINT_ARRAYS}

    for track_index, track in enumerate(tracks):
        for segment in track["segments"]:
            seg_points = np.asarray(segment["positions"], dtype=float)
            if seg_points.ndim != 2 or seg_points.shape[0] == 0:
                continue
            points.append(seg_points)
            n = seg_points.shape[0]
            line_lengths.append(n)
            pdg_values.append(int(segment["pdg"]))
            batch_values.append(int(track["batch"]))
            gen_values.append(int(track["generation"]))
            pid_values.append(int(track["particleId"]))
            track_index_values.append(track_index)
            for key in _TRACK_POINT_ARRAYS:
                point_data[key].append(np.asarray(segment[key]))

    if not points:
        return {
            "points": np.zeros((0, 3)),
            "line_lengths": np.zeros(0, dtype=np.int64),
            "point_arrays": {name: np.zeros(0) for name in _TRACK_POINT_ARRAYS.values()},
            "line_arrays": {
                "pdg": np.zeros(0, dtype=np.int64),
                "batch": np.zeros(0, dtype=np.int64),
                "generation": np.zeros(0, dtype=np.int64),
                "particle_id": np.zeros(0, dtype=np.int64),
                "track_index": np.zeros(0, dtype=np.int64),
            },
        }

    return {
        "points": np.concatenate(points),
        "line_lengths": np.asarray(line_lengths, dtype=np.int64),
        "point_arrays": {
            _TRACK_POINT_ARRAYS[key]: np.concatenate(values) for key, values in point_data.items()
        },
        "line_arrays": {
            "pdg": np.asarray(pdg_values, dtype=np.int64),
            "batch": np.asarray(batch_values, dtype=np.int64),
            "generation": np.asarray(gen_values, dtype=np.int64),
            "particle_id": np.asarray(pid_values, dtype=np.int64),
            "track_index": np.asarray(track_index_values, dtype=np.int64),
        },
    }


def _set_array(dataset_attributes, values, name):
    """Attach a numpy array to a VTK point/cell data collection."""
    vtk_array = numpy_support.numpy_to_vtk(np.ascontiguousarray(values), deep=True)
    vtk_array.SetName(name)
    dataset_attributes.AddArray(vtk_array)


def _write_polyline_vtp(geometry, output_path):
    """Write the ``build_polylines()`` output as a vtkPolyData .vtp file."""
    points = vtk.vtkPoints()
    points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(geometry["points"]), deep=True))

    lines = vtk.vtkCellArray()
    offset = 0
    for length in geometry["line_lengths"]:
        line = vtk.vtkPolyLine()
        line.GetPointIds().SetNumberOfIds(int(length))
        for i in range(int(length)):
            line.GetPointIds().SetId(i, offset + i)
        lines.InsertNextCell(line)
        offset += int(length)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)

    for name, values in geometry["point_arrays"].items():
        _set_array(polydata.GetPointData(), values, name)
    for name, values in geometry["line_arrays"].items():
        _set_array(polydata.GetCellData(), values, name)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def tracks_to_vtk(
    path,
    output_path=None,
    particle_filter=None,
    cell_filter=None,
    material_filter=None,
    max_tracks=1000,
    max_points_per_track=1000,
):
    """Convert OpenMC track file(s) to a .vtp polyline file for the visualizer.

    Returns a JSON-safe dict with the output path and conversion stats.
    """
    _require_vtk()
    data = output_readers.read_tracks_data(
        path,
        offset=0,
        limit=max_tracks,
        particle_filter=particle_filter,
        max_points_per_track=max_points_per_track,
        cell_filter=cell_filter,
        material_filter=material_filter,
    )

    geometry = build_polylines(data["tracks"])
    if geometry["points"].shape[0] == 0:
        raise OutputReaderError("No track segments left after filtering — nothing to visualize")

    if output_path is None:
        output_path = _default_output_path(path, ".vtp")
    _write_polyline_vtp(geometry, output_path)

    return {
        "vtkPath": output_path,
        "sourceFiles": data["files"],
        "totalTracks": data["totalTracks"],
        "convertedTracks": data["returnedTracks"],
        "nLines": int(geometry["line_lengths"].shape[0]),
        "nPoints": int(geometry["points"].shape[0]),
    }


def collision_track_to_vtk(path, output_path=None, mt_filter=None, cell_filter=None, limit=200000):
    """Convert an OpenMC collision track file to a .vtp point cloud.

    Each collision site becomes one vertex with per-point arrays for energy,
    energy loss, time, weight, event MT, cell/nuclide/material IDs, and the
    particle code. Returns a JSON-safe dict with the output path and stats.
    """
    _require_vtk()
    data = output_readers.read_collision_track_data(
        path, offset=0, limit=limit, mt_filter=mt_filter, cell_filter=cell_filter
    )
    collisions = data["collisions"]
    positions = np.asarray(collisions["positions"], dtype=float)
    if positions.ndim != 2 or positions.shape[0] == 0:
        raise OutputReaderError("No collisions left after filtering — nothing to visualize")

    points = vtk.vtkPoints()
    points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(positions), deep=True))

    n_points = positions.shape[0]
    verts = vtk.vtkCellArray()
    for i in range(n_points):
        verts.InsertNextCell(1)
        verts.InsertCellPoint(i)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetVerts(verts)

    for key, values in collisions.items():
        if key == "positions":
            continue
        _set_array(polydata.GetPointData(), np.asarray(values), key)

    if output_path is None:
        output_path = _default_output_path(path, ".vtp")
    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()

    return {
        "vtkPath": output_path,
        "sourceFiles": data["files"],
        "totalCollisions": data["totalCollisions"],
        "matchedCollisions": data["matchedCollisions"],
        "nPoints": int(n_points),
    }


def weight_window_grid(mesh, window):
    """Pure-numpy grid geometry for one weight window on a regular mesh.

    Returns ``(axes, arrays)`` where ``axes`` are the three rectilinear axis
    coordinate arrays (len n+1 each) and ``arrays`` maps ``lower_g<i>`` /
    ``upper_g<i>`` names to flat cell-data arrays (x-fastest VTK order).
    Bounds come from the file flat in C-order with shape
    ``(n_energy, nz, ny, nx)`` — see ``output_readers.read_weight_windows``.
    """
    nx, ny, nz = (int(d) for d in mesh["dimension"])
    lower_left = np.asarray(mesh["lower_left"], dtype=float)
    if "upper_right" in mesh:
        upper_right = np.asarray(mesh["upper_right"], dtype=float)
    elif "width" in mesh:
        upper_right = lower_left + np.asarray(mesh["width"], dtype=float) * [nx, ny, nz]
    else:
        raise OutputReaderError("Weight window mesh has neither 'upper_right' nor 'width'")

    axes = [np.linspace(lower_left[d], upper_right[d], n + 1) for d, n in enumerate((nx, ny, nz))]

    energy_bounds = np.asarray(window["energyBounds"], dtype=float)
    n_energy = energy_bounds.shape[0] - 1
    lower = np.asarray(window["lowerBounds"], dtype=float).reshape(n_energy, nz, ny, nx)
    upper = np.asarray(window["upperBounds"], dtype=float).reshape(n_energy, nz, ny, nx)

    arrays = {}
    for group in range(n_energy):
        # C-order ravel of (nz, ny, nx) is x-fastest — VTK cell order
        arrays[f"lower_g{group}"] = lower[group].ravel()
        arrays[f"upper_g{group}"] = upper[group].ravel()
    return axes, arrays


def weight_windows_to_vtk(path, output_path=None, mesh_id=None):
    """Convert weight_windows.h5 to a .vtr rectilinear grid.

    One cell-data array per (bound, energy group): ``lower_g<i>`` and
    ``upper_g<i>``. The trame viewer's color-by selector then acts as the
    energy-group and lower/upper toggle. All weight windows must share the
    first window's mesh; windows on other meshes are skipped (reported in the
    result). Returns a JSON-safe dict.
    """
    _require_vtk()
    data = output_readers.read_weight_windows(path)
    if not data["weightWindows"]:
        raise OutputReaderError(f"No weight windows found in {path}")

    meshes = {mesh["id"]: mesh for mesh in data["meshes"]}
    first = data["weightWindows"][0]
    # Anchor mesh: the requested one, else the first window's mesh. Windows on
    # other meshes are skipped (reported in the result).
    anchor_id = mesh_id if mesh_id is not None else first["meshId"]
    mesh = meshes.get(anchor_id)
    if mesh is None or "dimension" not in mesh:
        raise OutputReaderError(
            f"Mesh {anchor_id} for weight window {first['id']} is missing or not "
            "a regular mesh — only regular-mesh weight windows can be exported"
        )

    arrays = {}
    converted = []
    skipped = []
    for window in data["weightWindows"]:
        if window["meshId"] != anchor_id:
            skipped.append(window["id"])
            continue
        axes, window_arrays = weight_window_grid(mesh, window)
        prefix = "" if len(data["weightWindows"]) == 1 else f"ww{window['id']}_"
        for name, values in window_arrays.items():
            arrays[prefix + name] = values
        converted.append(window["id"])

    grid = vtk.vtkRectilinearGrid()
    grid.SetDimensions(len(axes[0]), len(axes[1]), len(axes[2]))
    grid.SetXCoordinates(numpy_support.numpy_to_vtk(np.ascontiguousarray(axes[0]), deep=True))
    grid.SetYCoordinates(numpy_support.numpy_to_vtk(np.ascontiguousarray(axes[1]), deep=True))
    grid.SetZCoordinates(numpy_support.numpy_to_vtk(np.ascontiguousarray(axes[2]), deep=True))
    for name, values in arrays.items():
        _set_array(grid.GetCellData(), values, name)

    if output_path is None:
        output_path = _default_output_path(path, ".vtr")
    writer = vtk.vtkXMLRectilinearGridWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(grid)
    writer.Write()

    return {
        "vtkPath": output_path,
        "sourceFile": data["file"],
        "meshId": anchor_id,
        "dimensions": [int(d) for d in mesh["dimension"]],
        "convertedWindows": converted,
        "skippedWindows": skipped,
        "arrays": sorted(arrays.keys()),
    }


# ---------------------------------------------------------------------------
# Voxel plots (.h5 → .vti) and VTK file inspection
# ---------------------------------------------------------------------------


def voxel_to_vtk(path, output_path=None):
    """Convert an OpenMC voxel plot HDF5 file to a .vti image data file.

    Replicates ``openmc.plots.voxel_to_vtk`` without requiring openmc: grid
    geometry comes from the file attributes (``num_voxels``, ``voxel_width``,
    ``lower_left``); the ``data`` dataset (nz, ny, nx, x-fastest) becomes the
    cell-data array ``id``. Returns a JSON-safe dict.
    """
    _require_vtk()
    info = output_readers.read_voxel_info(path)

    nx, ny, nz = info["dimensions"]
    with output_readers.h5py.File(path, "r") as f:
        ids = f["data"][...]

    grid = vtk.vtkImageData()
    grid.SetDimensions(nx + 1, ny + 1, nz + 1)
    grid.SetOrigin(*info["lowerLeft"])
    grid.SetSpacing(*info["voxelWidth"])
    _set_array(grid.GetCellData(), np.ascontiguousarray(ids.ravel()), "id")

    if output_path is None:
        output_path = _default_output_path(path, ".vti")
    writer = vtk.vtkXMLImageDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(grid)
    writer.Write()

    return {
        "vtkPath": output_path,
        "sourceFile": path,
        "dimensions": info["dimensions"],
        "idRange": info["idRange"],
    }


def read_vtk_info(path):
    """Inspect a VTK file: dataset shape plus point/cell data array metadata.

    Handles legacy (``.vtk``) and XML (``.vti``/``.vtr``/``.vtp``/``.vtu``/
    ``.vts``) files. Returns a JSON-safe dict with per-array name, association
    ('point' or 'cell'), component count, and value range.
    """
    _require_vtk()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    ext = os.path.splitext(path)[1].lower()
    if ext == ".vtk":
        reader = vtk.vtkGenericDataObjectReader()
    elif ext in (".vti", ".vtr", ".vtp", ".vtu", ".vts"):
        reader = vtk.vtkXMLGenericDataObjectReader()
    else:
        raise OutputReaderError(f"Unsupported VTK file extension: {ext or path}")
    reader.SetFileName(path)
    reader.Update()
    dataset = reader.GetOutput()
    if dataset is None:
        raise OutputReaderError(f"Could not read VTK file: {path}")

    def _arrays(attributes, association):
        result = []
        for i in range(attributes.GetNumberOfArrays()):
            array = attributes.GetArray(i)
            if array is None or not array.GetName():
                continue
            result.append(
                {
                    "name": array.GetName(),
                    "association": association,
                    "components": int(array.GetNumberOfComponents()),
                    "range": [float(v) for v in array.GetRange(-1)],
                }
            )
        return result

    arrays = _arrays(dataset.GetPointData(), "point") + _arrays(dataset.GetCellData(), "cell")

    info = {
        "file": path,
        "type": dataset.GetClassName(),
        "nPoints": int(dataset.GetNumberOfPoints()),
        "nCells": int(dataset.GetNumberOfCells()),
        "bounds": [float(v) for v in dataset.GetBounds()],
        "arrays": arrays,
    }
    if dataset.IsA("vtkImageData"):
        info["dimensions"] = [int(d) for d in dataset.GetDimensions()]
        info["spacing"] = [float(s) for s in dataset.GetSpacing()]
        info["origin"] = [float(o) for o in dataset.GetOrigin()]
    return info
