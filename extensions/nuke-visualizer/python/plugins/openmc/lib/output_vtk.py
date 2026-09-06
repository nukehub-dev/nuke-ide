"""VTK export for OpenMC output files (tracks, collision tracks, weight windows, voxel plots).

Each export converts an HDF5 output (read via ``output_readers``) into a VTK
file that the base visualizer's trame server (``base.serve``) can render:

- particle tracks -> ``.vtp`` polylines (``tracks_to_vtk`` / ``build_polylines``)
- collision sites -> ``.vtp`` point cloud
  (``collision_track_to_vtk`` / ``build_collision_points``)
- weight windows -> ``.vtr`` rectilinear grid, one cell-data array per
  (bound, energy group) (``weight_windows_to_vtk`` / ``weight_window_grid``)
- voxel plots -> ``.vti`` image data (``voxel_to_vtk`` / ``voxel_image_geometry``)

Geometry construction is numpy-only (unit-testable without ``vtk``); ``vtk``
is imported lazily inside :func:`_load_vtk` only for the final file write.
Server-side limits/decimation live in ``output_readers`` and are preserved:
``max_tracks``/``limit`` paginate server-side and each track segment is
decimated to ``max_points_per_track`` states (endpoints preserved).

All public functions raise :class:`OutputReaderError` with a human-readable
message on failure; command wrappers convert these to the single-JSON-object
contract. Returned dict shapes and VTK array names are unchanged.
"""

import os
import tempfile

import numpy as np

from plugins.openmc.lib import output_readers
from plugins.openmc.lib.output_readers import OutputReaderError

try:
    import importlib.util as _importlib_util

    HAS_VTK = _importlib_util.find_spec("vtk") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_VTK = False

# Point-data arrays carried over from track segments (JSON key -> VTK array name)
_TRACK_POINT_ARRAYS = {
    "energies": "energy",
    "times": "time",
    "weights": "weight",
    "cellIds": "cell_id",
}


def _load_vtk():
    """Lazily import ``vtk`` and return ``(vtk, numpy_support)``.

    Raises :class:`OutputReaderError` when vtk is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_VTK:
        raise OutputReaderError("vtk not installed (required for VTK export)")
    try:
        import vtk
        from vtk.util import numpy_support
    except ImportError as exc:
        raise OutputReaderError(f"vtk not installed (required for VTK export): {exc}") from None
    return vtk, numpy_support


def _require_vtk():
    """Ensure vtk is importable; returns ``(vtk, numpy_support)`` when it is."""
    return _load_vtk()


def _require_positive(name, value):
    """Validate an optional positive-int conversion limit.

    ``None`` means "no limit" and is passed through. Returns the value as an
    ``int``. Raises :class:`OutputReaderError` for non-integer or
    non-positive values.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise OutputReaderError(f"{name} must be a positive integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"{name} must be a positive integer, got {value!r}") from None
    if number <= 0:
        raise OutputReaderError(f"{name} must be a positive integer, got {value!r}")
    return number


def _default_output_path(input_path, suffix):
    """Default output path: a fresh temp dir with a file named after the input.

    Inputs: ``input_path`` (path to the source HDF5 file), ``suffix`` (e.g.
    ``".vtp"``). Output: absolute path string. Raises
    :class:`OutputReaderError` for an empty/invalid input path.
    """
    if not input_path or not isinstance(input_path, (str, os.PathLike)):
        raise OutputReaderError(f"invalid input path: {input_path!r}")
    base = os.path.basename(os.fspath(input_path).rstrip("/"))
    stem = os.path.splitext(base)[0].replace(".", "_")
    out_dir = tempfile.mkdtemp(prefix="nuke-openmc-output-")
    return os.path.join(out_dir, f"{stem}{suffix}")


def build_polylines(tracks):
    """Build polyline geometry from ``read_tracks_data()`` track dicts.

    Input: list of track dicts (``segments`` with ``positions`` plus the
    ``energies``/``times``/``weights``/``cellIds`` per-state arrays).
    Output: dict with ``points`` ((N, 3) float array of all polyline
    vertices), ``line_lengths`` ((L,) int array with the point count of each
    line), ``point_arrays`` (dict of (N,) arrays: energy, time, weight,
    cell_id) and ``line_arrays`` (dict of (L,) arrays: pdg, batch,
    generation, particle_id, track_index).

    Segments with no positions are skipped. Raises :class:`OutputReaderError`
    when the track list or any segment is malformed. Pure numpy — no vtk
    required.
    """
    if not isinstance(tracks, (list, tuple)):
        raise OutputReaderError(
            f"tracks must be a list of track dicts, got {type(tracks).__name__}"
        )
    points = []
    line_lengths = []
    pdg_values = []
    batch_values = []
    gen_values = []
    pid_values = []
    track_index_values = []
    point_data = {key: [] for key in _TRACK_POINT_ARRAYS}

    for track_index, track in enumerate(tracks):
        if not isinstance(track, dict) or not isinstance(track.get("segments"), (list, tuple)):
            raise OutputReaderError(f"track {track_index} is missing 'segments'")
        try:
            batch = int(track["batch"])
            generation = int(track["generation"])
            particle_id = int(track["particleId"])
        except (KeyError, TypeError, ValueError):
            raise OutputReaderError(
                f"track {track_index} is missing integer batch/generation/particleId"
            ) from None
        for segment in track["segments"]:
            if not isinstance(segment, dict) or "positions" not in segment:
                raise OutputReaderError(f"track {track_index} has a segment missing 'positions'")
            try:
                pdg = int(segment["pdg"])
            except (KeyError, TypeError, ValueError):
                raise OutputReaderError(
                    f"track {track_index} has a segment missing integer 'pdg'"
                ) from None
            try:
                seg_points = np.asarray(segment["positions"], dtype=float)
            except (TypeError, ValueError):
                raise OutputReaderError(
                    f"track {track_index} segment has non-numeric positions"
                ) from None
            if seg_points.ndim != 2 or seg_points.shape[0] == 0:
                continue
            if seg_points.shape[1] != 3:
                raise OutputReaderError(
                    f"track {track_index} segment positions must have 3 columns, "
                    f"got shape {seg_points.shape}"
                )
            n = seg_points.shape[0]
            arrays = {}
            for key in _TRACK_POINT_ARRAYS:
                if key not in segment:
                    raise OutputReaderError(f"track {track_index} segment is missing {key!r}")
                try:
                    arrays[key] = np.asarray(segment[key])
                except (TypeError, ValueError):
                    raise OutputReaderError(
                        f"track {track_index} segment has non-numeric {key!r}"
                    ) from None
                if arrays[key].shape[0] != n:
                    raise OutputReaderError(
                        f"track {track_index} segment {key!r} has length "
                        f"{arrays[key].shape[0]}, expected {n} (one value per position)"
                    )
            points.append(seg_points)
            line_lengths.append(n)
            pdg_values.append(pdg)
            batch_values.append(batch)
            gen_values.append(generation)
            pid_values.append(particle_id)
            track_index_values.append(track_index)
            for key in _TRACK_POINT_ARRAYS:
                point_data[key].append(arrays[key])

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


def build_collision_points(collisions):
    """Validate/normalize a ``read_collision_track_data()`` collisions dict.

    Input: dict with ``positions`` ((N, 3) list) plus flat per-collision
    arrays (energies, energyLosses, times, weights, eventMt, cellIds, ...).
    Output: ``(positions, point_arrays)`` where ``positions`` is an (N, 3)
    float array and ``point_arrays`` maps every other key to an (N,) array.
    Raises :class:`OutputReaderError` when positions are missing/empty or a
    per-collision array has a mismatched length. Pure numpy — no vtk required.
    """
    if not isinstance(collisions, dict) or "positions" not in collisions:
        raise OutputReaderError("collision data is missing 'positions'")
    try:
        positions = np.asarray(collisions["positions"], dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("collision positions are non-numeric") from None
    if positions.ndim != 2 or positions.shape[1] != 3 or positions.shape[0] == 0:
        raise OutputReaderError("No collisions left after filtering — nothing to visualize")
    n_points = positions.shape[0]
    point_arrays = {}
    for key, values in collisions.items():
        if key == "positions":
            continue
        try:
            array = np.asarray(values)
        except (TypeError, ValueError):
            raise OutputReaderError(f"collision array {key!r} is non-numeric") from None
        if array.shape[0] != n_points:
            raise OutputReaderError(
                f"collision array {key!r} has length {array.shape[0]}, "
                f"expected {n_points} (one value per collision)"
            )
        point_arrays[key] = array
    return positions, point_arrays


def _set_array(dataset_attributes, values, name):
    """Attach a numpy array to a VTK point/cell data collection."""
    _, numpy_support = _load_vtk()
    vtk_array = numpy_support.numpy_to_vtk(np.ascontiguousarray(values), deep=True)
    vtk_array.SetName(name)
    dataset_attributes.AddArray(vtk_array)


def _write_polyline_vtp(geometry, output_path):
    """Write the ``build_polylines()`` output as a vtkPolyData .vtp file."""
    vtk, numpy_support = _load_vtk()
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

    Inputs: ``path`` (tracks.h5 file, directory, or glob — see
    ``output_readers.read_tracks_data``), optional ``output_path`` (.vtp
    destination, default: temp file), ``particle_filter``/``cell_filter``/
    ``material_filter`` segment filters, ``max_tracks`` (server-side track
    limit, None = no limit) and ``max_points_per_track`` (per-segment
    decimation budget, endpoints preserved).
    Output: JSON-safe dict with the output path (``vtkPath``), source files,
    and conversion stats (``totalTracks``/``convertedTracks``/``nLines``/
    ``nPoints``). Raises :class:`OutputReaderError` on bad limits, missing
    files, or empty results.
    """
    max_tracks = _require_positive("max_tracks", max_tracks)
    max_points_per_track = _require_positive("max_points_per_track", max_points_per_track)
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

    Inputs: ``path`` (collision_track.h5 file, directory, or glob),
    optional ``output_path`` (.vtp destination, default: temp file),
    ``mt_filter``/``cell_filter`` row filters, ``limit`` (server-side
    collision limit, None = no limit). Each collision site becomes one vertex
    with per-point arrays for energy, energy loss, time, weight, event MT,
    cell/nuclide/material IDs, and the particle code.
    Output: JSON-safe dict with the output path and stats
    (``totalCollisions``/``matchedCollisions``/``nPoints``). Raises
    :class:`OutputReaderError` on a bad limit, missing files, or empty
    results.
    """
    limit = _require_positive("limit", limit)
    _require_vtk()
    data = output_readers.read_collision_track_data(
        path, offset=0, limit=limit, mt_filter=mt_filter, cell_filter=cell_filter
    )
    positions, point_arrays = build_collision_points(data["collisions"])
    vtk, numpy_support = _load_vtk()

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

    for key, values in point_arrays.items():
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

    Inputs: ``mesh`` (regular-mesh dict with ``dimension``, ``lower_left``
    and ``upper_right``/``width``), ``window`` (weight-window dict with
    ``energyBounds``/``lowerBounds``/``upperBounds``).
    Output: ``(axes, arrays)`` where ``axes`` are the three rectilinear axis
    coordinate arrays (len n+1 each) and ``arrays`` maps ``lower_g<i>`` /
    ``upper_g<i>`` names to flat cell-data arrays (x-fastest VTK order).
    Bounds come from the file flat in C-order with shape
    ``(n_energy, nz, ny, nx)`` — see ``output_readers.read_weight_windows``.
    Raises :class:`OutputReaderError` on non-regular meshes or mismatched
    bound sizes.
    """
    if not isinstance(mesh, dict) or "dimension" not in mesh:
        raise OutputReaderError("Weight window mesh is missing 'dimension' (not a regular mesh?)")
    try:
        nx, ny, nz = (int(d) for d in mesh["dimension"])
    except (TypeError, ValueError):
        raise OutputReaderError(
            f"Weight window mesh has an invalid dimension: {mesh.get('dimension')!r}"
        ) from None
    if len(mesh["dimension"]) != 3 or min(nx, ny, nz) <= 0:
        raise OutputReaderError(
            f"Weight window mesh has an invalid dimension: {mesh.get('dimension')!r}"
        )
    try:
        lower_left = np.asarray(mesh["lower_left"], dtype=float)
    except (KeyError, TypeError, ValueError):
        raise OutputReaderError("Weight window mesh is missing a numeric 'lower_left'") from None
    if lower_left.shape != (3,):
        raise OutputReaderError("Weight window mesh 'lower_left' must have 3 values")
    if "upper_right" in mesh:
        try:
            upper_right = np.asarray(mesh["upper_right"], dtype=float)
        except (TypeError, ValueError):
            raise OutputReaderError("Weight window mesh has a non-numeric 'upper_right'") from None
    elif "width" in mesh:
        try:
            upper_right = lower_left + np.asarray(mesh["width"], dtype=float) * [nx, ny, nz]
        except (TypeError, ValueError):
            raise OutputReaderError("Weight window mesh has a non-numeric 'width'") from None
    else:
        raise OutputReaderError("Weight window mesh has neither 'upper_right' nor 'width'")
    if upper_right.shape != (3,):
        raise OutputReaderError("Weight window mesh bounds must have 3 values")

    axes = [np.linspace(lower_left[d], upper_right[d], n + 1) for d, n in enumerate((nx, ny, nz))]

    try:
        energy_bounds = np.asarray(window["energyBounds"], dtype=float)
        lower = np.asarray(window["lowerBounds"], dtype=float)
        upper = np.asarray(window["upperBounds"], dtype=float)
    except (KeyError, TypeError, ValueError):
        raise OutputReaderError(
            "Weight window is missing numeric energy/lower/upper bounds"
        ) from None
    n_energy = energy_bounds.shape[0] - 1
    if n_energy < 1:
        raise OutputReaderError("Weight window 'energyBounds' must hold at least 2 values")
    expected = n_energy * nx * ny * nz
    if lower.size != expected or upper.size != expected:
        raise OutputReaderError(
            f"Weight window bounds have size {lower.size}/{upper.size}, "
            f"expected {expected} ({n_energy} groups x {nx}x{ny}x{nz} mesh)"
        )
    lower = lower.reshape(n_energy, nz, ny, nx)
    upper = upper.reshape(n_energy, nz, ny, nx)

    arrays = {}
    for group in range(n_energy):
        # C-order ravel of (nz, ny, nx) is x-fastest — VTK cell order
        arrays[f"lower_g{group}"] = lower[group].ravel()
        arrays[f"upper_g{group}"] = upper[group].ravel()
    return axes, arrays


def weight_windows_to_vtk(path, output_path=None, mesh_id=None):
    """Convert weight_windows.h5 to a .vtr rectilinear grid.

    Inputs: ``path`` (weight_windows.h5 file), optional ``output_path`` (.vtr
    destination, default: temp file), optional ``mesh_id`` (anchors
    multi-mesh files to the chosen mesh — windows on other meshes are
    skipped; default: the first window's mesh).
    Output: JSON-safe dict with the output path, anchor ``meshId``,
    ``dimensions``, converted/skipped window ids, and cell-array names. One
    cell-data array per (bound, energy group): ``lower_g<i>`` and
    ``upper_g<i>`` (prefixed with ``ww<id>_`` when the file holds several
    windows on the anchor mesh). The trame viewer's color-by selector then
    acts as the energy-group and lower/upper toggle. All converted windows
    must share the anchor mesh. Raises :class:`OutputReaderError` when no
    windows (or no windows on the anchor mesh) are found.
    """
    if mesh_id is not None:
        try:
            mesh_id = int(mesh_id)
        except (TypeError, ValueError):
            raise OutputReaderError(f"mesh_id must be an integer, got {mesh_id!r}") from None
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
    if not converted:
        raise OutputReaderError(
            f"No weight windows on mesh {anchor_id} in {path} — nothing to visualize"
        )

    vtk, numpy_support = _load_vtk()
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


def voxel_image_geometry(info):
    """Pure-numpy image geometry from a ``read_voxel_info()`` dict.

    Input: info dict with ``dimensions`` ([nx, ny, nz] voxel counts),
    ``voxelWidth`` ([wx, wy, wz] spacings) and ``lowerLeft`` ([x0, y0, z0]
    origin). Output: ``(dimensions_plus_one, origin, spacing)`` — point
    dimensions for ``vtkImageData.SetDimensions`` plus origin/spacing triples.
    Raises :class:`OutputReaderError` on missing keys, wrong shapes, or
    non-positive dimensions/widths. Pure numpy — no vtk required.
    """
    if not isinstance(info, dict):
        raise OutputReaderError(f"voxel info must be a dict, got {type(info).__name__}")
    for key in ("dimensions", "voxelWidth", "lowerLeft"):
        if key not in info:
            raise OutputReaderError(f"voxel info is missing {key!r}")
    try:
        dims = [int(d) for d in info["dimensions"]]
        spacing = [float(w) for w in info["voxelWidth"]]
        origin = [float(v) for v in info["lowerLeft"]]
    except (TypeError, ValueError):
        raise OutputReaderError("voxel info dimensions/widths/origin must be numeric") from None
    if len(dims) != 3 or len(spacing) != 3 or len(origin) != 3:
        raise OutputReaderError("voxel info dimensions/widths/origin must each have 3 values")
    if min(dims) <= 0:
        raise OutputReaderError(f"voxel dimensions must be positive, got {dims}")
    if min(spacing) <= 0:
        raise OutputReaderError(f"voxel widths must be positive, got {spacing}")
    return [d + 1 for d in dims], origin, spacing


def voxel_to_vtk(path, output_path=None):
    """Convert an OpenMC voxel plot HDF5 file to a .vti image data file.

    Inputs: ``path`` (voxel plot .h5 file), optional ``output_path`` (.vti
    destination, default: temp file). Replicates
    ``openmc.plots.voxel_to_vtk`` without requiring openmc: grid geometry
    comes from the file attributes (``num_voxels``, ``voxel_width``,
    ``lower_left``); the ``data`` dataset (nz, ny, nx, x-fastest) becomes the
    cell-data array ``id``.
    Output: JSON-safe dict with the output path, source file, ``dimensions``
    and ``idRange``. Raises :class:`OutputReaderError` on missing files,
    non-voxel files, or geometry/data mismatches.
    """
    _require_vtk()
    info = output_readers.read_voxel_info(path)

    dims_plus_one, origin, spacing = voxel_image_geometry(info)
    nx, ny, nz = info["dimensions"]
    with output_readers.h5py.File(path, "r") as f:
        ids = f["data"][...]
    ids = np.ascontiguousarray(ids.ravel())
    if ids.size != nx * ny * nz:
        raise OutputReaderError(
            f"Voxel data has {ids.size} values, expected {nx * ny * nz} "
            f"({nx}x{ny}x{nz} grid) in {path}"
        )

    vtk, _ = _load_vtk()
    grid = vtk.vtkImageData()
    grid.SetDimensions(*dims_plus_one)
    grid.SetOrigin(*origin)
    grid.SetSpacing(*spacing)
    _set_array(grid.GetCellData(), ids, "id")

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

    Input: ``path`` to a legacy (``.vtk``) or XML (``.vti``/``.vtr``/
    ``.vtp``/``.vtu``/``.vts``) file.
    Output: JSON-safe dict with the dataset ``type``, point/cell counts,
    ``bounds``, per-array metadata (name, association — 'point' or 'cell',
    component count, value range) and, for image data, ``dimensions``/
    ``spacing``/``origin``. Raises :class:`OutputReaderError` for
    unsupported extensions, missing files, or unreadable datasets.
    """
    ext = os.path.splitext(os.fspath(path))[1].lower() if path else ""
    if ext not in (".vtk", ".vti", ".vtr", ".vtp", ".vtu", ".vts"):
        raise OutputReaderError(f"Unsupported VTK file extension: {ext or path}")
    vtk, _ = _load_vtk()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    if ext == ".vtk":
        reader = vtk.vtkGenericDataObjectReader()
    else:
        reader = vtk.vtkXMLGenericDataObjectReader()
    reader.SetFileName(os.fspath(path))
    try:
        reader.Update()
        dataset = reader.GetOutput()
    except Exception as exc:
        raise OutputReaderError(f"Could not read VTK file: {path} ({exc})") from None
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
