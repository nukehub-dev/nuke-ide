"""Headless tally/source/overlay converters for the native tally viewer.

Each export converts OpenMC statepoint/source data into a VTK XML file that
the native three.js viewer (``TallyNativeViewerWidget``) parses client-side
via ``parseNativeVtkXml`` — no trame server, no restart:

- mesh tallies -> ``.vti`` image data (``tally_mesh_to_vtk``)
- source distributions -> ``.vtp`` point cloud (``source_to_vtk``)
- overlay/slice views -> ``.vtp`` point clouds (``overlay_to_vtk``)

Data computation needs no server: statepoint parsing follows the
``tallies/tally <id>`` HDF5 layout used by ``plugins.openmc.lib.reader``
(mesh bins are x-major, ``ix + iy*nx + iz*nx*ny``), and slice resampling
is the same cell-centered trilinear sampling as
``slice_viz.sample_structured_values``.

Geometry construction is numpy-only (unit-testable without ``vtk`` or
``h5py``); ``vtk``/``h5py`` are imported lazily only for the file read and
the final file write. ``reader.py`` is deliberately NOT imported here — it
pulls in ``vtk``/``paraview`` at module top.

All public functions raise :class:`OutputReaderError` with a human-readable
message on failure; command wrappers convert these to the single-JSON-object
contract.
"""

import contextlib
import os
import sys
import tempfile

import numpy as np

from plugins.openmc.lib.output_readers import OutputReaderError

try:
    import importlib.util as _importlib_util

    HAS_VTK = _importlib_util.find_spec("vtk") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_VTK = False


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


#: Drape-manifest cache revision (folded into the cache key): bump whenever
#: the painted values change shape or scale. v2: values are true means
#: (divided by n_realizations) instead of raw sums.
_OVERLAY_GEOMETRY_CACHE_VERSION = 2


def _load_h5py():
    """Lazily import ``h5py``.

    Raises :class:`OutputReaderError` when h5py is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    try:
        import h5py
    except ImportError as exc:
        raise OutputReaderError(
            f"h5py not installed (required to read output files): {exc}"
        ) from None
    if h5py is None:
        raise OutputReaderError("h5py not installed (required to read output files)")
    return h5py


def _default_output_path(input_path, suffix):
    """Default output path: a fresh temp dir with a file named after the input.

    Inputs: ``input_path`` (path to the source HDF5 file), ``suffix`` (e.g.
    ``".vti"``). Output: absolute path string. Raises
    :class:`OutputReaderError` for an empty/invalid input path.
    """
    if not input_path or not isinstance(input_path, (str, os.PathLike)):
        raise OutputReaderError(f"invalid input path: {input_path!r}")
    base = os.path.basename(os.fspath(input_path).rstrip("/"))
    stem = os.path.splitext(base)[0].replace(".", "_")
    out_dir = tempfile.mkdtemp(prefix="nuke-openmc-tally-")
    return os.path.join(out_dir, f"{stem}{suffix}")


def _require_tally_id(value):
    """Validate a tally id. Output: the id as an ``int``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"tally_id must be an integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"tally_id must be an integer, got {value!r}") from None
    if number <= 0:
        raise OutputReaderError(f"tally_id must be a positive integer, got {value!r}")
    return number


def _require_plane(value):
    """Validate a slice plane name. Output: the lowercased plane."""
    if isinstance(value, str) and value.lower() in ("x", "y", "z"):
        return value.lower()
    raise OutputReaderError(f"plane must be one of ['x', 'y', 'z'], got {value!r}")


def _require_resolution(value):
    """Validate a slice resolution. Output: the value as an ``int``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"resolution must be a positive integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"resolution must be a positive integer, got {value!r}") from None
    if isinstance(value, float) and value != number:
        raise OutputReaderError(f"resolution must be a positive integer, got {value!r}")
    if number < 1 or number > 1024:
        raise OutputReaderError(f"resolution must be between 1 and 1024, got {value!r}")
    return number


def _require_position(value):
    """Validate a slice position in cm. Output: the value as a ``float``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"position must be a number, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"position must be a number, got {value!r}") from None
    if not np.isfinite(number):
        raise OutputReaderError(f"position must be finite, got {value!r}")
    return number


def _require_limit(name, value):
    """Validate an optional positive-int row limit (``None`` = no limit)."""
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


def _require_array_name(name):
    """Validate a VTK data-array name. Output: the name."""
    if not isinstance(name, str) or not name.strip():
        raise OutputReaderError(f"array_name must be a non-empty string, got {name!r}")
    return name


def _set_cell_array(grid, values, name):
    """Attach a flat cell-data array to a VTK dataset."""
    _, numpy_support = _load_vtk()
    vtk_array = numpy_support.numpy_to_vtk(np.ascontiguousarray(values), deep=True)
    vtk_array.SetName(name)
    grid.GetCellData().AddArray(vtk_array)


def _set_point_array(polydata, values, name):
    """Attach a flat point-data array to a vtkPolyData."""
    _, numpy_support = _load_vtk()
    vtk_array = numpy_support.numpy_to_vtk(np.ascontiguousarray(values), deep=True)
    vtk_array.SetName(name)
    polydata.GetPointData().AddArray(vtk_array)


# ---------------------------------------------------------------------------
# Mesh tallies (.vti image data)
# ---------------------------------------------------------------------------


def validate_mesh_grid(dimension, lower_left, upper_right):
    """Validate a regular mesh spec (numpy only).

    Inputs: ``dimension`` ([nx, ny, nz] positive ints), ``lower_left`` /
    ``upper_right`` (3-vectors in cm, lower < upper per axis). Output:
    ``(dims, origin, spacing)`` as int/float lists. Raises
    :class:`OutputReaderError` otherwise. Pure numpy — no vtk required.
    """
    try:
        dims = [int(d) for d in dimension]
    except (TypeError, ValueError):
        raise OutputReaderError(f"mesh dimension must hold 3 integers, got {dimension!r}") from None
    if len(dims) != 3 or min(dims) <= 0:
        raise OutputReaderError(f"mesh dimension must hold 3 positive integers, got {dimension!r}")
    try:
        lo = [float(v) for v in lower_left]
        hi = [float(v) for v in upper_right]
    except (TypeError, ValueError):
        raise OutputReaderError("mesh lower_left/upper_right must each hold 3 numbers") from None
    if len(lo) != 3 or len(hi) != 3:
        raise OutputReaderError("mesh lower_left/upper_right must each hold 3 numbers")
    if not all(np.isfinite(lo)) or not all(np.isfinite(hi)):
        raise OutputReaderError("mesh bounds must all be finite")
    if not all(h > low for low, h in zip(lo, hi, strict=True)):
        raise OutputReaderError(f"mesh requires lower_left < upper_right, got {lo} >= {hi}")
    spacing = [(hi[d] - lo[d]) / dims[d] for d in range(3)]
    return dims, lo, spacing


def build_mesh_image(dimension, lower_left, upper_right, values):
    """Build image-grid geometry for a mesh tally (numpy only).

    Inputs: ``dimension`` ([nx, ny, nz]), ``lower_left``/``upper_right``
    (grid corners in cm), ``values`` (flat cell means in OpenMC x-major
    order, ``ix + iy*nx + iz*nx*ny`` — ``prod(dims)`` entries). Output: dict
    with ``dims``, ``origin``, ``spacing`` and ``flat`` (the values as a
    contiguous float array in VTK x-fastest cell order, which matches the
    OpenMC ordering). Raises :class:`OutputReaderError` on bad geometry or a
    value count mismatch. Pure numpy — no vtk required.
    """
    dims, origin, spacing = validate_mesh_grid(dimension, lower_left, upper_right)
    try:
        flat = np.asarray(values, dtype=float).ravel()
    except (TypeError, ValueError):
        raise OutputReaderError("tally values must be numeric") from None
    expected = dims[0] * dims[1] * dims[2]
    if flat.shape[0] != expected:
        raise OutputReaderError(
            f"tally has {flat.shape[0]} values, expected {expected} "
            f"({dims[0]}x{dims[1]}x{dims[2]} mesh)"
        )
    if not np.all(np.isfinite(flat)):
        raise OutputReaderError("tally values must all be finite")
    return {"dims": dims, "origin": origin, "spacing": spacing, "flat": flat}


def write_mesh_vti(geometry, array_name, output_path):
    """Write a ``build_mesh_image()`` dict as a .vti file (lazy vtk).

    Inputs: ``geometry`` (a ``build_mesh_image`` dict), ``array_name``
    (cell-data array name), ``output_path`` (.vti destination). Output: the
    path string. Raises :class:`OutputReaderError` on bad input or missing
    vtk. Validators run before the vtk gate.
    """
    name = _require_array_name(array_name)
    if not isinstance(geometry, dict) or "flat" not in geometry:
        raise OutputReaderError("geometry must be a build_mesh_image dict")
    # Re-validate the value payload against the geometry. NOTE: the dict
    # carries spacing (not corners) — reconstruct the upper corner for the
    # validator; passing spacing as upper_right silently rescales the mesh.
    try:
        upper = [
            float(o) + float(s) * int(n)
            for o, s, n in zip(
                geometry.get("origin"), geometry.get("spacing"), geometry.get("dims"), strict=True
            )
        ]
    except (TypeError, ValueError):
        raise OutputReaderError("geometry dims/origin/spacing must hold numbers") from None
    image = build_mesh_image(geometry.get("dims"), geometry.get("origin"), upper, geometry["flat"])
    vtk, _ = _load_vtk()
    dims = image["dims"]

    grid = vtk.vtkImageData()
    grid.SetDimensions(dims[0] + 1, dims[1] + 1, dims[2] + 1)
    grid.SetOrigin(*image["origin"])
    grid.SetSpacing(*image["spacing"])
    _set_cell_array(grid, image["flat"], name)

    writer = vtk.vtkXMLImageDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(grid)
    writer.Write()
    return output_path


def _decode_string_list(values):
    """Decode an HDF5 string dataset/attribute to a plain str list."""
    if values is None:
        return []
    if isinstance(values, (bytes, str)):
        values = [values]
    result = []
    for v in np.asarray(values).flat:
        if isinstance(v, bytes):
            v = v.decode("utf-8")
        result.append(str(v))
    return result


def read_mesh_tally(statepoint_path, tally_id, score=None, nuclide=None):
    """Read one mesh tally from a statepoint file (lazy h5py, no openmc).

    Inputs: ``statepoint_path`` (.h5 file), ``tally_id`` (positive int),
    optional ``score``/``nuclide`` names (default: first of each). Output:
    JSON-safe dict with ``tallyName``, ``score``, ``nuclide``,
    ``arrayName`` (``"<score>-mean"``), ``dimension``, ``lowerLeft``,
    ``upperRight``, ``values`` (flat x-major means) and ``dataRange``.
    Only single regular-mesh tallies are supported; anything else raises
    :class:`OutputReaderError` with a human-readable reason.
    """
    tally_id = _require_tally_id(tally_id)
    if not os.path.isfile(statepoint_path):
        raise OutputReaderError(f"File not found: {statepoint_path}")
    h5py = _load_h5py()

    with h5py.File(statepoint_path, "r") as f:
        if "tallies" not in f:
            raise OutputReaderError(f"No tallies found in {statepoint_path}")
        tally_key = f"tally {tally_id}"
        if tally_key not in f["tallies"]:
            available = sorted(k for k in f["tallies"].keys() if k.startswith("tally "))
            raise OutputReaderError(
                f"Tally {tally_id} not found in {statepoint_path} (available: {available})"
            )
        tally = f["tallies"][tally_key]

        name = tally.attrs.get("name", f"Tally {tally_id}")
        if isinstance(name, bytes):
            name = name.decode("utf-8")

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

        # Locate the mesh filter and its mesh (mirrors reader._parse_filter).
        mesh_obj = None
        if "filters" in tally:
            filters_ref = tally["filters"]
            filter_ids = []
            if isinstance(filters_ref, h5py.Dataset):
                filter_ids = [int(v) for v in np.asarray(filters_ref[...]).flat]
                locations = [
                    loc
                    for loc in (f.get("filters"), f["tallies"].get("filters"))
                    if loc is not None
                ]
            else:
                locations, filter_ids = [filters_ref], None
            for location in locations:
                keys = (
                    [f"filter {fid}" for fid in filter_ids] if filter_ids else list(location.keys())
                )
                for key in keys:
                    if key not in location:
                        continue
                    fobj = location[key]
                    ftype = fobj["type"][()] if "type" in fobj else fobj.attrs.get("type", "")
                    if isinstance(ftype, bytes):
                        ftype = ftype.decode("utf-8")
                    if str(ftype) != "mesh":
                        continue
                    mesh_id = None
                    if "bins" in fobj:
                        mesh_id = int(np.asarray(fobj["bins"][()]).flat[0])
                    meshes = f["tallies"].get("meshes", {})
                    mesh_key = f"mesh {mesh_id}" if mesh_id is not None else None
                    if mesh_key and mesh_key in meshes:
                        mesh_obj = meshes[mesh_key]
                        break
                if mesh_obj is not None:
                    break
        if mesh_obj is None:
            raise OutputReaderError(
                f"Tally {tally_id} does not have a mesh filter — only mesh tallies can be exported"
            )
        if "r_grid" in mesh_obj or "phi_grid" in mesh_obj:
            raise OutputReaderError(
                f"Tally {tally_id} uses a cylindrical mesh — only regular meshes can be exported"
            )
        if (
            "dimension" not in mesh_obj
            or "lower_left" not in mesh_obj
            or "upper_right" not in mesh_obj
        ):
            raise OutputReaderError(f"Tally {tally_id} mesh is missing dimension/bounds datasets")
        dimension = [int(v) for v in np.asarray(mesh_obj["dimension"][()]).flat]
        lower_left = [float(v) for v in np.asarray(mesh_obj["lower_left"][()]).flat]
        upper_right = [float(v) for v in np.asarray(mesh_obj["upper_right"][()]).flat]

        if "results" not in tally:
            raise OutputReaderError(f"Tally {tally_id} has no results dataset")
        # Statepoint 'results' hold [sum, sum_sq] moments (openmc tally.py),
        # not means: divide the sum column by n_realizations (missing only
        # in synthetic fixtures, where 1 keeps values verbatim).
        n_realizations = int(tally["n_realizations"][()]) if "n_realizations" in tally else 1
        mean = np.asarray(tally["results"][..., 0], dtype=float) / max(1, n_realizations)
        n_bins = dimension[0] * dimension[1] * dimension[2]
        # Results layout: (filter bins, scores, nuclides) with the mesh
        # filter outermost; see openmc_vtk.get_cell_tally_data.
        if mean.size != n_bins * n_scores * n_nuclides:
            raise OutputReaderError(
                f"Tally {tally_id} results have {mean.size} values, expected "
                f"{n_bins * n_scores * n_nuclides} "
                f"({dimension[0]}x{dimension[1]}x{dimension[2]} mesh x "
                f"{n_scores} scores x {n_nuclides} nuclides) — multi-filter "
                "tallies cannot be exported"
            )
        reshaped = mean.reshape(n_bins, n_scores, n_nuclides)
        values = np.ascontiguousarray(reshaped[:, score_idx, nuclide_idx].ravel())

    return {
        "tallyName": str(name),
        "score": score_name,
        "nuclide": nuclide_name,
        "arrayName": f"{score_name}-mean",
        "dimension": dimension,
        "lowerLeft": lower_left,
        "upperRight": upper_right,
        "values": values,
        "dataRange": [float(np.min(values)), float(np.max(values))],
    }


def tally_mesh_to_vtk(statepoint_path, tally_id, score=None, nuclide=None, output_path=None):
    """Convert a statepoint mesh tally to a .vti image data file.

    Inputs: ``statepoint_path`` (statepoint .h5), ``tally_id``, optional
    ``score``/``nuclide``, optional ``output_path`` (.vti destination,
    default: temp file). Output: JSON-safe dict with the output path
    (``vtkPath``), tally metadata and conversion stats (``dimensions``,
    ``arrayName``, ``dataRange``, ``nCells``). Raises
    :class:`OutputReaderError` on bad input, missing files/dependencies, or
    non-mesh tallies.
    """
    data = read_mesh_tally(statepoint_path, tally_id, score=score, nuclide=nuclide)
    _load_vtk()
    geometry = build_mesh_image(
        data["dimension"], data["lowerLeft"], data["upperRight"], data["values"]
    )
    if output_path is None:
        output_path = _default_output_path(statepoint_path, ".vti")
    write_mesh_vti(geometry, data["arrayName"], output_path)
    return {
        "vtkPath": output_path,
        "sourceFile": statepoint_path,
        "tallyId": _require_tally_id(tally_id),
        "tallyName": data["tallyName"],
        "score": data["score"],
        "nuclide": data["nuclide"],
        "arrayName": data["arrayName"],
        "dimensions": data["dimension"],
        "dataRange": data["dataRange"],
        "nCells": int(geometry["flat"].shape[0]),
    }


# ---------------------------------------------------------------------------
# Source distributions (.vtp point clouds)
# ---------------------------------------------------------------------------


def build_source_points(positions, energies=None, weights=None):
    """Validate/normalize source particle data (numpy only).

    Inputs: ``positions`` ((N, 3) array in cm), optional ``energies`` (eV)
    and ``weights`` ((N,) arrays). Output: ``(positions, point_arrays)``
    where ``positions`` is an (N, 3) float array and ``point_arrays`` maps
    ``"energy"``/``"weight"`` to (N,) float arrays (only for provided
    inputs). Raises :class:`OutputReaderError` for empty/non-finite
    positions or length mismatches. Pure numpy — no vtk required.
    """
    try:
        points = np.asarray(positions, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("source positions must be numeric with shape (N, 3)") from None
    if points.ndim != 2 or points.shape[1] != 3 or points.shape[0] == 0:
        raise OutputReaderError(
            f"source positions must have shape (N, 3) with N > 0, got {points.shape}"
        )
    if not np.all(np.isfinite(points)):
        raise OutputReaderError("source positions must all be finite")
    n_points = points.shape[0]
    point_arrays = {}
    for key, values in (("energy", energies), ("weight", weights)):
        if values is None:
            continue
        try:
            array = np.asarray(values, dtype=float).ravel()
        except (TypeError, ValueError):
            raise OutputReaderError(f"source {key} values must be numeric") from None
        if array.shape[0] != n_points:
            raise OutputReaderError(
                f"source {key} has length {array.shape[0]}, expected {n_points} (one value per particle)"
            )
        if not np.all(np.isfinite(array)):
            raise OutputReaderError(f"source {key} values must all be finite")
        point_arrays[key] = array
    return points, point_arrays


def write_source_vtp(positions, point_arrays, output_path):
    """Write source points as a .vtp vertex cloud (lazy vtk).

    Inputs: ``positions`` ((N, 3) array), ``point_arrays`` (name -> (N,)
    arrays, e.g. from :func:`build_source_points`), ``output_path`` (.vtp
    destination). Output: the path string. Raises
    :class:`OutputReaderError` on bad input or missing vtk. Validators run
    before the vtk gate.
    """
    points, arrays = build_source_points(
        positions,
        energies=point_arrays.get("energy") if isinstance(point_arrays, dict) else None,
        weights=point_arrays.get("weight") if isinstance(point_arrays, dict) else None,
    )
    if isinstance(point_arrays, dict):
        for key in point_arrays:
            if key not in arrays:
                raise OutputReaderError(
                    f"unsupported source array {key!r} (expected 'energy'/'weight')"
                )
    vtk, numpy_support = _load_vtk()

    vtk_points = vtk.vtkPoints()
    vtk_points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(points), deep=True))
    n_points = points.shape[0]
    verts = vtk.vtkCellArray()
    for i in range(n_points):
        verts.InsertNextCell(1)
        verts.InsertCellPoint(i)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    polydata.SetVerts(verts)
    for key, values in arrays.items():
        _set_point_array(polydata, values, key)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def _extract_compound_vectors(bank, field_names, n):
    """Extract an (N, 3) position array from a compound ``r``-style field."""
    for field in field_names:
        if field not in bank.dtype.names:
            continue
        vec = bank[field]
        if vec.dtype.names and all(c in vec.dtype.names for c in ("x", "y", "z")):
            return np.column_stack(
                [np.asarray(vec[c], dtype=float).ravel()[:n] for c in ("x", "y", "z")]
            )
        arr = np.asarray(vec, dtype=float)
        if arr.ndim == 2 and arr.shape[1] == 3:
            return arr[:n]
    return None


def read_source_points(path, limit=None):
    """Read source particle positions/energies/weights (lazy h5py).

    Inputs: ``path`` (``source.h5`` or a statepoint .h5 holding
    ``source_bank``), optional ``limit`` (max particles, None = all).
    Output: dict with ``positions`` ((N, 3) float array), ``energies`` /
    ``weights`` ((N,) float arrays or None), ``totalParticles`` and
    ``nParticles``. Raises :class:`OutputReaderError` for missing files,
    missing dependencies, or unrecognized layouts.
    """
    limit = _require_limit("limit", limit)
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")
    h5py = _load_h5py()

    with h5py.File(path, "r") as f:
        bank = None
        for key in ("source_bank", "source", "particles", "source bank"):
            if key in f and isinstance(f[key], h5py.Dataset):
                bank = f[key][...]
                break
        if bank is None:
            raise OutputReaderError(
                f"No source bank found in {path} (looked for 'source_bank', 'source', 'particles')"
            )
        total = int(bank.shape[0]) if bank.shape else 0
        if total == 0:
            raise OutputReaderError(f"No source particles found in {path} — nothing to visualize")
        n = min(total, limit) if limit is not None else total

        positions = None
        if bank.dtype.names:
            positions = _extract_compound_vectors(bank, ("r", "position", "positions", "xyz"), n)
        else:
            arr = np.asarray(bank, dtype=float)
            if arr.ndim == 2 and arr.shape[1] >= 3:
                positions = arr[:n, :3]
        if positions is None:
            raise OutputReaderError(f"Could not read particle positions from {path}")
        positions = np.ascontiguousarray(positions, dtype=float)

        energies = None
        weights = None
        if bank.dtype.names:
            names = bank.dtype.names
            energy_field = next((k for k in ("E", "energy", "energies") if k in names), None)
            weight_field = next((k for k in ("wgt", "weight", "weights", "w") if k in names), None)
            if energy_field is not None:
                energies = np.asarray(bank[energy_field], dtype=float).ravel()[:n]
            if weight_field is not None:
                weights = np.asarray(bank[weight_field], dtype=float).ravel()[:n]

    # Validate through the numpy-only builder (finite checks, shapes).
    points, arrays = build_source_points(positions, energies=energies, weights=weights)
    return {
        "positions": points,
        "energies": arrays.get("energy"),
        "weights": arrays.get("weight"),
        "totalParticles": total,
        "nParticles": int(points.shape[0]),
    }


def source_to_vtk(path, output_path=None, limit=None):
    """Convert a source file (or statepoint source bank) to a .vtp cloud.

    Inputs: ``path`` (``source.h5`` or statepoint .h5), optional
    ``output_path`` (.vtp destination, default: temp file), optional
    ``limit`` (max particles). Each particle becomes one vertex with
    per-point ``energy``/``weight`` arrays when the file carries them.
    Output: JSON-safe dict with the output path (``vtkPath``), source file
    and stats (``totalParticles``/``nParticles``/``arrays``). Raises
    :class:`OutputReaderError` on bad input, missing files/dependencies, or
    empty results.
    """
    data = read_source_points(path, limit=limit)
    _load_vtk()
    arrays = {}
    if data["energies"] is not None:
        arrays["energy"] = data["energies"]
    if data["weights"] is not None:
        arrays["weight"] = data["weights"]
    if output_path is None:
        output_path = _default_output_path(path, ".vtp")
    write_source_vtp(data["positions"], arrays, output_path)
    return {
        "vtkPath": output_path,
        "sourceFile": path,
        "totalParticles": data["totalParticles"],
        "nParticles": data["nParticles"],
        "arrays": sorted(arrays.keys()),
    }


# ---------------------------------------------------------------------------
# Overlay / slice views (.vtp point clouds)
# ---------------------------------------------------------------------------


def sample_trilinear_values(values_3d, lower_left, upper_right, points):
    """Trilinear-sample a cell-centered regular grid at arbitrary points.

    Same cell-centered lattice math as :func:`sample_regular_slice`:
    cell centers are the sample lattice, out-of-grid coordinates clamp to
    the edge cells. Inputs: ``values_3d`` ((nx, ny, nz) cell means),
    ``lower_left``/``upper_right`` (grid corners in cm), ``points``
    ((N, 3) sample coordinates). Output: ``(N,)`` float array. Raises
    :class:`OutputReaderError` on bad input. Pure numpy.
    """
    try:
        grid = np.asarray(values_3d, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("values_3d must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise OutputReaderError(f"values_3d must have shape (nx, ny, nz), got {grid.shape}")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise OutputReaderError("lower_left/upper_right must each hold 3 numbers") from None
    if np.any(~np.isfinite(lo)) or np.any(~np.isfinite(hi)) or np.any(hi <= lo):
        raise OutputReaderError("lower_left/upper_right must be finite with lower < upper")
    try:
        pts = np.asarray(points, dtype=float).reshape(-1, 3)
    except (TypeError, ValueError):
        raise OutputReaderError("points must be numeric with shape (N, 3)") from None
    if pts.shape[0] == 0:
        raise OutputReaderError("points must hold at least one point")
    if not np.all(np.isfinite(pts)):
        raise OutputReaderError("points must all be finite")

    nx, ny, nz = grid.shape
    spacing = (hi - lo) / np.array([nx, ny, nz], dtype=float)
    frac = (pts - lo) / spacing - 0.5
    for d, count in enumerate((nx, ny, nz)):
        frac[:, d] = np.clip(frac[:, d], 0.0, count - 1.0)
    i0 = np.floor(frac).astype(np.int64)
    i1 = np.minimum(i0 + 1, np.array([nx - 1, ny - 1, nz - 1]))
    t = frac - i0
    c000 = grid[i0[:, 0], i0[:, 1], i0[:, 2]]
    c001 = grid[i0[:, 0], i0[:, 1], i1[:, 2]]
    c010 = grid[i0[:, 0], i1[:, 1], i0[:, 2]]
    c011 = grid[i0[:, 0], i1[:, 1], i1[:, 2]]
    c100 = grid[i1[:, 0], i0[:, 1], i0[:, 2]]
    c101 = grid[i1[:, 0], i0[:, 1], i1[:, 2]]
    c110 = grid[i1[:, 0], i1[:, 1], i0[:, 2]]
    c111 = grid[i1[:, 0], i1[:, 1], i1[:, 2]]
    tx, ty, tz = t[:, 0], t[:, 1], t[:, 2]
    return np.ascontiguousarray(
        c000 * (1 - tx) * (1 - ty) * (1 - tz)
        + c001 * (1 - tx) * (1 - ty) * tz
        + c010 * (1 - tx) * ty * (1 - tz)
        + c011 * (1 - tx) * ty * tz
        + c100 * tx * (1 - ty) * (1 - tz)
        + c101 * tx * (1 - ty) * tz
        + c110 * tx * ty * (1 - tz)
        + c111 * tx * ty * tz,
        dtype=float,
    )


def sample_nearest_values(values_3d, lower_left, upper_right, points):
    """Nearest-cell sample a cell-centered regular grid at arbitrary points.

    Same lattice as :func:`sample_trilinear_values` but without blending:
    each point takes the value of the cell whose center is closest
    (out-of-grid coordinates clamp to the edge cells). Inputs/outputs mirror
    :func:`sample_trilinear_values`. Pure numpy.
    """
    try:
        grid = np.asarray(values_3d, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("values_3d must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise OutputReaderError(f"values_3d must have shape (nx, ny, nz), got {grid.shape}")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise OutputReaderError("lower_left/upper_right must each hold 3 numbers") from None
    if np.any(~np.isfinite(lo)) or np.any(~np.isfinite(hi)) or np.any(hi <= lo):
        raise OutputReaderError("lower_left/upper_right must be finite with lower < upper")
    try:
        pts = np.asarray(points, dtype=float).reshape(-1, 3)
    except (TypeError, ValueError):
        raise OutputReaderError("points must be numeric with shape (N, 3)") from None
    if pts.shape[0] == 0:
        raise OutputReaderError("points must hold at least one point")
    if not np.all(np.isfinite(pts)):
        raise OutputReaderError("points must all be finite")

    nx, ny, nz = grid.shape
    spacing = (hi - lo) / np.array([nx, ny, nz], dtype=float)
    idx = np.clip(
        np.floor((pts - lo) / spacing).astype(np.int64), 0, np.array([nx - 1, ny - 1, nz - 1])
    )
    return np.ascontiguousarray(grid[idx[:, 0], idx[:, 1], idx[:, 2]], dtype=float)


def sample_regular_slice(
    values_3d, lower_left, upper_right, plane="z", position=None, resolution=200, pixelated=False
):
    """Sample a cell-centered regular grid on a slice plane.

    Same sampling math as ``slice_viz.sample_structured_values``: cell
    centers are the sample lattice, out-of-grid coordinates clamp to the
    edge cells. Inputs: ``values_3d`` ((nx, ny, nz) cell means),
    ``lower_left``/``upper_right`` (grid corners in cm), ``plane``
    (``"x"``/``"y"``/``"z"``), ``position`` (plane offset in cm, default:
    grid center), ``resolution`` (points per in-plane axis),
    ``pixelated`` (nearest-cell values showing actual mesh cells instead
    of trilinear interpolation, default False). Output: dict
    with ``plane``, ``position``, ``resolution``, ``points`` ((M, 3) float
    array, row-major over the (u, v) grid) and ``values`` ((M,) float
    array). Raises :class:`OutputReaderError` on bad input. Pure numpy.
    """
    plane = _require_plane(plane)
    resolution = _require_resolution(resolution)
    try:
        grid = np.asarray(values_3d, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("values_3d must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise OutputReaderError(f"values_3d must have shape (nx, ny, nz), got {grid.shape}")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise OutputReaderError("lower_left/upper_right must each hold 3 numbers") from None
    if np.any(~np.isfinite(lo)) or np.any(~np.isfinite(hi)) or np.any(hi <= lo):
        raise OutputReaderError("lower_left/upper_right must be finite with lower < upper")

    nx, ny, nz = grid.shape
    axis = {"x": 0, "y": 1, "z": 2}[plane]
    if position is None:
        position = float((lo[axis] + hi[axis]) / 2)
    position = _require_position(position)

    in_plane = {"x": (1, 2), "y": (0, 2), "z": (0, 1)}[plane]
    u = np.linspace(lo[in_plane[0]], hi[in_plane[0]], resolution + 1)
    v = np.linspace(lo[in_plane[1]], hi[in_plane[1]], resolution + 1)
    uu, vv = np.meshgrid(u, v, indexing="xy")
    points = np.zeros((uu.size, 3))
    points[:, axis] = position
    points[:, in_plane[0]] = uu.ravel()
    points[:, in_plane[1]] = vv.ravel()

    if pixelated:
        values = sample_nearest_values(grid, lo, hi, points)
    else:
        values = sample_trilinear_values(grid, lo, hi, points)
    return {
        "plane": plane,
        "position": position,
        "resolution": resolution,
        "points": points,
        "values": np.ascontiguousarray(values, dtype=float),
    }


#: Quads per slice-grid side cap: the surface stays fully covered (whole
#: quads are kept or dropped on a grid lattice — never a triangle subset,
#: which would punch holes) while the triangle soup stays interactive.
SLICE_SURFACE_MAX_SIDE = 320


def slice_surface_quads(resolution):
    """Quad ids over a slice sample lattice, decimated for display.

    Inputs: ``resolution`` (sample points per in-plane axis; the lattice
    holds ``(resolution+1)^2`` row-major points). Output: ``(M, 4)`` int
    array of point ids, one quad per kept grid cell. Lattices wider than
    ``SLICE_SURFACE_MAX_SIDE`` cells decimate by whole grid steps so
    coverage stays complete; small lattices keep every cell. Pure numpy.
    """
    side = int(resolution) + 1
    if side < 2:
        raise OutputReaderError(f"slice resolution must be positive, got {resolution!r}")
    step = max(1, -(-(side - 1) // SLICE_SURFACE_MAX_SIDE))
    iu0, iv0 = np.meshgrid(np.arange(0, side - 1, step), np.arange(0, side - 1, step))
    iu1 = np.minimum(iu0 + step, side - 1)
    iv1 = np.minimum(iv0 + step, side - 1)
    return np.stack(
        [
            (iu0 + side * iv0).ravel(),
            (iu1 + side * iv0).ravel(),
            (iu1 + side * iv1).ravel(),
            (iu0 + side * iv1).ravel(),
        ],
        axis=1,
    )


def write_overlay_vtp(points, values, array_name, output_path, quads=None):
    """Write overlay/slice samples as a .vtp vertex cloud (lazy vtk).

    Inputs: ``points`` ((N, 3) array), ``values`` ((N,) array),
    ``array_name`` (point-data array name), ``output_path`` (.vtp
    destination), optional ``quads`` ((M, 4) int array of point ids — one
    quad per grid cell, turning the cloud into a shadeable surface while
    keeping per-point values for smooth interpolation). Output: the path
    string. Raises :class:`OutputReaderError` on bad input, length
    mismatches, out-of-range quad ids, or missing vtk. Validators run
    before the vtk gate.
    """
    try:
        pts = np.asarray(points, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("points must be numeric with shape (N, 3)") from None
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape[0] == 0:
        raise OutputReaderError(f"points must have shape (N, 3) with N > 0, got {pts.shape}")
    if not np.all(np.isfinite(pts)):
        raise OutputReaderError("points must all be finite")
    name = _require_array_name(array_name)
    try:
        vals = np.asarray(values, dtype=float).ravel()
    except (TypeError, ValueError):
        raise OutputReaderError("values must be numeric with one entry per point") from None
    if vals.shape[0] != pts.shape[0]:
        raise OutputReaderError(
            f"values has length {vals.shape[0]}, expected {pts.shape[0]} (one value per point)"
        )
    if not np.all(np.isfinite(vals)):
        raise OutputReaderError("values must all be finite")

    quad_ids = None
    if quads is not None:
        try:
            quad_ids = np.asarray(quads, dtype=np.int64).reshape(-1, 4)
        except (TypeError, ValueError):
            raise OutputReaderError("quads must hold (M, 4) point ids") from None
        if quad_ids.shape[0] == 0:
            raise OutputReaderError("quads must hold at least one quad")
        if quad_ids.min() < 0 or quad_ids.max() >= pts.shape[0]:
            raise OutputReaderError(f"quad ids must lie in [0, {pts.shape[0] - 1}]")

    vtk, numpy_support = _load_vtk()
    vtk_points = vtk.vtkPoints()
    vtk_points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(pts), deep=True))
    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    if quad_ids is None:
        verts = vtk.vtkCellArray()
        for i in range(pts.shape[0]):
            verts.InsertNextCell(1)
            verts.InsertCellPoint(int(i))
        polydata.SetVerts(verts)
    else:
        polys = vtk.vtkCellArray()
        for quad in quad_ids:
            polys.InsertNextCell(4)
            for point_id in quad:
                polys.InsertCellPoint(int(point_id))
        polydata.SetPolys(polys)
    _set_point_array(polydata, vals, name)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def mesh_cell_centers(dimension, lower_left, upper_right):
    """Cell-center coordinates of a regular mesh (numpy only).

    Inputs: ``dimension`` ([nx, ny, nz]), ``lower_left``/``upper_right``.
    Output: (M, 3) float array in x-major order
    (``ix + iy*nx + iz*nx*ny``), matching the flat tally ordering. Pure
    numpy — no vtk required.
    """
    dims, origin, spacing = validate_mesh_grid(dimension, lower_left, upper_right)
    axes = [np.asarray(origin[d]) + (np.arange(dims[d]) + 0.5) * spacing[d] for d in range(3)]
    xx, yy, zz = np.meshgrid(axes[0], axes[1], axes[2], indexing="ij")
    # Fortran (first-index-fastest) ravel matches the x-major flat tally
    # order; C-order ravel would transpose x/y (and x/z on cubic meshes).
    return np.column_stack([xx.ravel(order="F"), yy.ravel(order="F"), zz.ravel(order="F")])


def overlay_to_vtk(
    statepoint_path,
    tally_id,
    score=None,
    nuclide=None,
    mode="slice",
    plane="z",
    position=None,
    resolution=200,
    output_path=None,
    pixelated=False,
):
    """Convert a mesh tally to an overlay/slice .vtp file (no server).

    Inputs: ``statepoint_path``, ``tally_id``, optional
    ``score``/``nuclide``, ``mode`` (``"slice"`` resamples the tally on a
    plane; ``"full"`` writes mesh cell centers), ``plane``/``position``/
    ``resolution`` (slice mode), optional ``output_path`` (.vtp destination,
    default: temp file), ``pixelated`` (nearest-cell slice values showing
    actual mesh cells instead of trilinear interpolation, default False).
    This static extract carries the same tally values
    and renders natively as a round-point cloud. Output: JSON-safe dict with the output path
    (``vtkPath``), mode/plane/position, ``arrayName``, ``nPoints`` and
    ``dataRange``. Raises :class:`OutputReaderError` on bad input, missing
    files/dependencies, or non-mesh tallies.
    """
    if mode not in ("slice", "full"):
        raise OutputReaderError(f"mode must be 'slice' or 'full', got {mode!r}")
    data = read_mesh_tally(statepoint_path, tally_id, score=score, nuclide=nuclide)
    _load_vtk()
    dims = data["dimension"]
    lo = np.asarray(data["lowerLeft"], dtype=float)
    hi = np.asarray(data["upperRight"], dtype=float)

    if mode == "slice":
        grid = np.asarray(data["values"], dtype=float).reshape(dims, order="F")
        sampled = sample_regular_slice(
            grid, lo, hi, plane=plane, position=position, resolution=resolution, pixelated=pixelated
        )
        points, values = sampled["points"], sampled["values"]
        meta = {
            "plane": sampled["plane"],
            "position": sampled["position"],
            "resolution": sampled["resolution"],
        }
    else:
        plane = _require_plane(plane)
        points = mesh_cell_centers(dims, lo, hi)
        values = np.ascontiguousarray(np.asarray(data["values"], dtype=float).ravel())
        meta = {
            "plane": plane,
            "position": float(
                (lo[{"x": 0, "y": 1, "z": 2}[plane]] + hi[{"x": 0, "y": 1, "z": 2}[plane]]) / 2
            ),
            "resolution": 0,
        }

    if output_path is None:
        output_path = _default_output_path(statepoint_path, ".vtp")
    quads = slice_surface_quads(sampled["resolution"]) if mode == "slice" else None
    write_overlay_vtp(points, values, data["arrayName"], output_path, quads=quads)
    return {
        "vtkPath": output_path,
        "sourceFile": statepoint_path,
        "tallyId": _require_tally_id(tally_id),
        "tallyName": data["tallyName"],
        "mode": mode,
        "plane": meta["plane"],
        "position": meta["position"],
        "resolution": meta["resolution"],
        "arrayName": data["arrayName"],
        "nPoints": int(values.shape[0]),
        "dataRange": [float(np.min(values)), float(np.max(values))],
    }


def _overlay_geometry_cache_dir(
    h5m_path, statepoint_path, tally_id, score, nuclide, graveyard, smooth=False
):
    """Manifest cache entry for one draped overlay conversion.

    Inputs: same selector set as :func:`overlay_geometry_to_vtk` (plus the
    ``smooth`` interpolation flag). Output:
    ``(manifest_path, hit)`` inside the temp-dir ``nuke-visualizer``
    ``dagmc-overlay`` cache; the hash folds the geometry + statepoint
    identity (name, size, mtime) plus the tally selectors, the
    interpolation mode, and the converter version, so stale manifests are
    never reused.
    """
    import hashlib
    import tempfile
    from pathlib import Path

    cache_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "dagmc-overlay"
    cache_dir.mkdir(parents=True, exist_ok=True)
    h5m_stat = Path(h5m_path).stat()
    sp_stat = Path(statepoint_path).stat()
    hash_input = (
        f"{Path(h5m_path).name}:{h5m_stat.st_size}:{h5m_stat.st_mtime}:"
        f"{Path(statepoint_path).name}:{sp_stat.st_size}:{sp_stat.st_mtime}:"
        f"{tally_id}:{score}:{nuclide}:{'graveyard' if graveyard else 'nograveyard'}:"
        f"{'smooth' if smooth else 'pixelated'}:"
        f"v{_OVERLAY_GEOMETRY_CACHE_VERSION}"
    )
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]
    manifest_dir = cache_dir / f"{Path(h5m_path).stem}_{file_hash}_overlay"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    # The converter names the manifest `<stem>_volumes.vtm` inside the
    # output dir; expect exactly that so hits are found.
    manifest_path = manifest_dir / f"{Path(h5m_path).stem}_volumes.vtm"
    return str(manifest_path), manifest_path.is_file()


def overlay_geometry_to_vtk(
    statepoint_path,
    h5m_path,
    tally_id,
    score=None,
    nuclide=None,
    include_graveyard=False,
    output_dir=None,
    use_cache=True,
    smooth=False,
):
    """Map a mesh tally onto DAGMC geometry volumes (true 3D overlay).

    Each DAGMC volume keeps its triangulated surface. In ``pixelated``
    mode (``smooth=False``, the default) every triangle is colored by
    sampling the regular tally mesh at the triangle centroid (nearest
    cell, OpenMC x-major order — the same lookup the slice resampler
    uses), so the drape shows actual mesh-cell values. In ``smooth`` mode
    the tally mesh is trilinearly interpolated at the surface vertices
    and stored as point data, so the client GPU blends values between
    mesh cells. The result is a multiblock ``.vtm`` the native DAGMC
    viewer renders with volume isolation and instant color-by on the tally
    array (``Point: <array>`` when smooth, ``Cell: <array>`` when
    pixelated). Out-of-mesh samples clamp to the nearest edge cell.

    Inputs: ``statepoint_path`` (.h5 file), ``h5m_path`` (DAGMC geometry),
    ``tally_id`` (positive int), optional ``score``/``nuclide`` (default:
    first of each), ``include_graveyard`` (keep the termination volume,
    default False), optional ``output_dir`` (manifest destination; default:
    a hash-keyed entry in the temp-dir overlay cache, reused when
    ``use_cache`` and still valid), ``use_cache`` (default True),
    ``smooth`` (trilinear vertex interpolation, default False).
    Output: JSON-safe dict with the output path (``vtkPath``), ``mode``
    ``"geometry"``, ``arrayName``, ``arrayAssociation`` (``"point"`` when
    smooth, ``"cell"`` otherwise), ``nVolumes`` and ``dataRange``. Raises
    :class:`OutputReaderError` for bad inputs, missing files/dependencies,
    non-mesh tallies, or non-finite values.
    """
    import os

    data = read_mesh_tally(statepoint_path, tally_id, score=score, nuclide=nuclide)
    if not os.path.isfile(h5m_path):
        raise OutputReaderError(f"DAGMC file not found: {h5m_path}")
    grid = build_mesh_image(
        data["dimension"], data["lowerLeft"], data["upperRight"], data["values"]
    )
    dims, origin, spacing = grid["dims"], np.asarray(grid["origin"]), np.asarray(grid["spacing"])
    flat = grid["flat"]
    values_3d = np.asarray(data["values"], dtype=float).reshape(dims, order="F")
    lo = np.asarray(data["lowerLeft"], dtype=float)
    hi = np.asarray(data["upperRight"], dtype=float)
    array_name = data["arrayName"]

    cell_sampler = None
    point_sampler = None
    if smooth:

        def point_sampler(volume_id, material, vertices):
            return array_name, sample_trilinear_values(values_3d, lo, hi, vertices)

    else:

        def cell_sampler(volume_id, material, centroids):
            over = (np.asarray(centroids, dtype=float) - origin) / spacing
            idx = np.clip(np.floor(over).astype(int), 0, np.array(dims) - 1)
            flat_idx = idx[:, 0] + dims[0] * (idx[:, 1] + dims[1] * idx[:, 2])
            return array_name, flat[flat_idx]

    from plugins.base.lib.dagmc import convert_h5m_to_multiblock_vtk

    if output_dir is None and use_cache:
        manifest_path, hit = _overlay_geometry_cache_dir(
            h5m_path,
            statepoint_path,
            tally_id,
            data["score"],
            data["nuclide"],
            include_graveyard,
            smooth,
        )
        if hit:
            import re

            with open(manifest_path, encoding="utf-8", errors="replace") as handle:
                cached_volumes = len(re.findall(r"<DataSet\b", handle.read()))
            return {
                "vtkPath": manifest_path,
                "sourceFile": statepoint_path,
                "geometryFile": str(h5m_path),
                "tallyId": _require_tally_id(tally_id),
                "tallyName": data["tallyName"],
                "mode": "geometry",
                "arrayName": array_name,
                "arrayAssociation": "point" if smooth else "cell",
                "nVolumes": cached_volumes,
                "fromCache": True,
                "dataRange": data["dataRange"],
            }
        output_dir = os.path.dirname(manifest_path)

    # The openmc stdout-JSON contract is strict (the whole stdout must
    # parse): the base converter's progress prints go to stderr here so the
    # command stdout carries only the final JSON object.
    with contextlib.redirect_stdout(sys.stderr):
        result = convert_h5m_to_multiblock_vtk(
            str(h5m_path),
            output_dir=output_dir,
            include_graveyard=include_graveyard,
            cell_sampler=cell_sampler,
            point_sampler=point_sampler,
        )
    association = result.get("sampledAssociation") or ("point" if smooth else "cell")
    return {
        "vtkPath": result["vtm_path"],
        "sourceFile": statepoint_path,
        "geometryFile": str(h5m_path),
        "tallyId": _require_tally_id(tally_id),
        "tallyName": data["tallyName"],
        "mode": "geometry",
        "arrayName": result["sampledArray"] or array_name,
        "arrayAssociation": association,
        "nVolumes": len(result["volume_info"]),
        "fromCache": False,
        "dataRange": data["dataRange"],
    }


# ---------------------------------------------------------------------------
# Line probes (flux profiles along a segment)
# ---------------------------------------------------------------------------

#: Probe sample-count bounds: at least the two endpoints; capped so the JSON
#: series stays interactive in the data-half table.
LINE_PROBE_MIN_POINTS = 2
LINE_PROBE_MAX_POINTS = 100000


def _require_probe_point(name, value):
    """Validate a probe endpoint. Output: ``[x, y, z]`` floats in cm."""
    try:
        point = [float(v) for v in value]
    except (TypeError, ValueError):
        raise OutputReaderError(f"{name} must hold 3 numbers (x y z in cm)") from None
    if len(point) != 3:
        raise OutputReaderError(f"{name} must hold 3 numbers (x y z in cm), got {value!r}")
    if isinstance(value, bool) or not all(np.isfinite(point)):
        raise OutputReaderError(f"{name} coordinates must all be finite, got {value!r}")
    return point


def _require_npoints(value):
    """Validate a probe sample count. Output: the value as an ``int``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"npoints must be an integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"npoints must be an integer, got {value!r}") from None
    if isinstance(value, float) and value != number:
        raise OutputReaderError(f"npoints must be an integer, got {value!r}")
    if number < LINE_PROBE_MIN_POINTS or number > LINE_PROBE_MAX_POINTS:
        raise OutputReaderError(
            f"npoints must be between {LINE_PROBE_MIN_POINTS} and {LINE_PROBE_MAX_POINTS}, "
            f"got {value!r}"
        )
    return number


def build_line_probe_points(p0, p1, npoints):
    """Build evenly spaced sample points along a probe segment (numpy only).

    Inputs: ``p0``/``p1`` (segment endpoints in cm), ``npoints`` (sample
    count, endpoints included). Output: dict with ``p0``, ``p1``,
    ``npoints``, ``points`` ((N, 3) float array), ``distances`` ((N,) float
    array from ``p0`` in cm) and ``length`` (segment length in cm). Raises
    :class:`OutputReaderError` on bad input (a zero-length segment is
    rejected — a probe needs a direction). Pure numpy — no vtk required.
    """
    start = _require_probe_point("p0", p0)
    end = _require_probe_point("p1", p1)
    count = _require_npoints(npoints)
    start_arr = np.asarray(start, dtype=float)
    end_arr = np.asarray(end, dtype=float)
    length = float(np.linalg.norm(end_arr - start_arr))
    if not np.isfinite(length) or length <= 0.0:
        raise OutputReaderError(
            f"probe endpoints must differ (zero-length segment {start} -> {end})"
        )
    fractions = np.linspace(0.0, 1.0, count)
    points = start_arr[None, :] + fractions[:, None] * (end_arr - start_arr)[None, :]
    return {
        "p0": start,
        "p1": end,
        "npoints": count,
        "points": np.ascontiguousarray(points, dtype=float),
        "distances": np.ascontiguousarray(fractions * length, dtype=float),
        "length": length,
    }


def sample_line_probe(values_3d, lower_left, upper_right, p0, p1, npoints, smooth=True):
    """Sample a cell-centered regular grid along a line segment.

    The probe lattice comes from :func:`build_line_probe_points`; the values
    reuse the overlay samplers — :func:`sample_trilinear_values` when
    ``smooth`` (blended between mesh cells, the overlay slice default) or
    :func:`sample_nearest_values` otherwise (actual mesh-cell values, the
    overlay ``pixelated`` convention). Output: dict with ``p0``, ``p1``,
    ``npoints``, ``smooth``, ``points`` ((N, 3) float array), ``distances``
    ((N,) float array from ``p0`` in cm), ``length`` and ``values`` ((N,)
    float array). Raises :class:`OutputReaderError` on bad input. Pure
    numpy.
    """
    probe = build_line_probe_points(p0, p1, npoints)
    sampler = sample_trilinear_values if smooth else sample_nearest_values
    values = sampler(values_3d, lower_left, upper_right, probe["points"])
    return {**probe, "smooth": bool(smooth), "values": np.ascontiguousarray(values, dtype=float)}


def write_probe_vtp(points, values, array_name, output_path):
    """Write probe samples as a .vtp polyline path (lazy vtk).

    Inputs: ``points`` ((N, 3) array, N >= 2), ``values`` ((N,) array),
    ``array_name`` (point-data array name), ``output_path`` (.vtp
    destination). The points join into one polyline cell so the path draws
    in-scene with per-point values for coloring. Output: the path string.
    Raises :class:`OutputReaderError` on bad input, length mismatches, or
    missing vtk. Validators run before the vtk gate.
    """
    try:
        pts = np.asarray(points, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("points must be numeric with shape (N, 3)") from None
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape[0] < LINE_PROBE_MIN_POINTS:
        raise OutputReaderError(
            f"points must have shape (N, 3) with N >= {LINE_PROBE_MIN_POINTS}, got {pts.shape}"
        )
    if not np.all(np.isfinite(pts)):
        raise OutputReaderError("points must all be finite")
    name = _require_array_name(array_name)
    try:
        vals = np.asarray(values, dtype=float).ravel()
    except (TypeError, ValueError):
        raise OutputReaderError("values must be numeric with one entry per point") from None
    if vals.shape[0] != pts.shape[0]:
        raise OutputReaderError(
            f"values has length {vals.shape[0]}, expected {pts.shape[0]} (one value per point)"
        )
    if not np.all(np.isfinite(vals)):
        raise OutputReaderError("values must all be finite")

    vtk, numpy_support = _load_vtk()
    vtk_points = vtk.vtkPoints()
    vtk_points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(pts), deep=True))
    lines = vtk.vtkCellArray()
    lines.InsertNextCell(int(pts.shape[0]))
    for i in range(pts.shape[0]):
        lines.InsertCellPoint(int(i))

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    polydata.SetLines(lines)
    _set_point_array(polydata, vals, name)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def line_probe(
    statepoint_path,
    tally_id,
    p0,
    p1,
    npoints=100,
    score=None,
    nuclide=None,
    smooth=True,
    output_path=None,
    write_vtp=False,
):
    """Sample a mesh tally along a line segment (flux profile probe).

    Inputs: ``statepoint_path`` (.h5 file), ``tally_id`` (positive int),
    ``p0``/``p1`` (segment endpoints in cm), ``npoints`` (sample count),
    optional ``score``/``nuclide`` (default: first of each), ``smooth``
    (trilinear interpolation, default True; False samples nearest cells —
    the overlay ``pixelated`` convention), optional ``output_path`` (.vtp
    destination for the probe-path polyline) and ``write_vtp`` (write the
    polyline to a default temp path when no ``output_path`` is given).
    Output: JSON-safe dict with the tally metadata, the sampled ``series``
    (``distance``/``position``/``value`` per point), ``dataRange`` and the
    ``vtkPath`` when a polyline was written. Raises
    :class:`OutputReaderError` on bad input, missing files/dependencies, or
    non-mesh tallies.
    """
    # Validate the probe geometry before the (expensive) tally read — the
    # same fail-fast order the overlay converter uses for its mode flag.
    build_line_probe_points(p0, p1, npoints)
    data = read_mesh_tally(statepoint_path, tally_id, score=score, nuclide=nuclide)
    dims = data["dimension"]
    lo = np.asarray(data["lowerLeft"], dtype=float)
    hi = np.asarray(data["upperRight"], dtype=float)
    grid = np.asarray(data["values"], dtype=float).reshape(dims, order="F")
    sampled = sample_line_probe(grid, lo, hi, p0, p1, npoints, smooth=smooth)
    points = sampled["points"]
    distances = sampled["distances"]
    values = sampled["values"]

    vtk_path = None
    if output_path is not None or write_vtp:
        _load_vtk()
        if output_path is None:
            output_path = _default_output_path(statepoint_path, ".vtp")
        write_probe_vtp(points, values, data["arrayName"], output_path)
        vtk_path = output_path

    return {
        "sourceFile": statepoint_path,
        "tallyId": _require_tally_id(tally_id),
        "tallyName": data["tallyName"],
        "score": data["score"],
        "nuclide": data["nuclide"],
        "arrayName": data["arrayName"],
        "p0": sampled["p0"],
        "p1": sampled["p1"],
        "npoints": sampled["npoints"],
        "smooth": sampled["smooth"],
        "length": sampled["length"],
        "series": [
            {
                "distance": float(distances[i]),
                "position": [float(points[i, 0]), float(points[i, 1]), float(points[i, 2])],
                "value": float(values[i]),
            }
            for i in range(sampled["npoints"])
        ],
        "dataRange": [float(np.min(values)), float(np.max(values))],
        "vtkPath": vtk_path,
    }


# ---------------------------------------------------------------------------
# Contour / iso-surfaces over the regular tally grid
# ---------------------------------------------------------------------------

#: Iso-value count cap per contour call: every iso adds a full surface to
#: one .vtp, so unbounded lists would bloat the viewer tab.
CONTOUR_MAX_ISO_VALUES = 8

#: Kuhn triangulation of a lattice cube into 6 tetrahedra: each axis
#: permutation gives one tet (origin + three cumulative axis steps), so
#: shared cube faces always split along the same diagonal and neighboring
#: cubes agree on the surface.
_CONTOUR_TETS = (
    ((0, 0, 0), (1, 0, 0), (1, 1, 0), (1, 1, 1)),
    ((0, 0, 0), (1, 0, 0), (1, 0, 1), (1, 1, 1)),
    ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 1, 1)),
    ((0, 0, 0), (0, 1, 0), (0, 1, 1), (1, 1, 1)),
    ((0, 0, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1)),
    ((0, 0, 0), (0, 0, 1), (0, 1, 1), (1, 1, 1)),
)

#: The six edges of a tetrahedron as corner-index pairs.
_CONTOUR_TET_EDGES = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))


def _require_iso_value(value):
    """Validate one iso value. Output: the value as a ``float``."""
    if isinstance(value, bool):
        raise OutputReaderError(f"iso values must be numbers, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OutputReaderError(f"iso values must be numbers, got {value!r}") from None
    if not np.isfinite(number):
        raise OutputReaderError(f"iso values must all be finite, got {value!r}")
    return number


def _require_iso_values(value):
    """Validate an iso-value list. Output: ``list[float]`` (1..cap entries)."""
    if value is None or isinstance(value, (bool, str, bytes)):
        raise OutputReaderError(f"iso values must hold 1-{CONTOUR_MAX_ISO_VALUES} numbers")
    try:
        items = list(value)
    except TypeError:
        raise OutputReaderError(
            f"iso values must hold 1-{CONTOUR_MAX_ISO_VALUES} numbers, got {value!r}"
        ) from None
    if not items:
        raise OutputReaderError("at least one iso value is required")
    if len(items) > CONTOUR_MAX_ISO_VALUES:
        raise OutputReaderError(
            f"at most {CONTOUR_MAX_ISO_VALUES} iso values per call, got {len(items)}"
        )
    return [_require_iso_value(entry) for entry in items]


def _polygonize_tet(corner_values, iso):
    """Triangulate one tetrahedron at an iso value (numpy-free core).

    Inputs: ``corner_values`` (4 floats), ``iso`` (float). Output: list of
    triangles, each a triple of tet-edge pairs ``(a, b)`` whose crossing
    becomes a surface vertex. A corner counts as inside at ``value >= iso``.
    One corner in (or out) yields one triangle; two in yield a quad split
    into two triangles; zero/four yield nothing. Pure python.
    """
    inside = [value >= iso for value in corner_values]
    n_inside = sum(inside)
    if n_inside == 0 or n_inside == 4:
        return []

    def crossing(a, b):
        return (a, b) if ((a, b) in _CONTOUR_TET_EDGES) else (b, a)

    if n_inside == 1:
        (sole,) = [i for i in range(4) if inside[i]]
        rest = [i for i in range(4) if not inside[i]]
        return [tuple(crossing(sole, other) for other in rest)]
    if n_inside == 3:
        (sole,) = [i for i in range(4) if not inside[i]]
        rest = [i for i in range(4) if inside[i]]
        return [tuple(crossing(sole, other) for other in rest)]
    inner = [i for i in range(4) if inside[i]]
    outer = [i for i in range(4) if not inside[i]]
    quad = [crossing(a, b) for a in inner for b in outer]
    return [(quad[0], quad[1], quad[2]), (quad[0], quad[2], quad[3])]


def _require_contour_grid(values_3d, lower_left, upper_right):
    """Validate the contour lattice. Output: ``(grid, lo, hi)`` arrays."""
    try:
        grid = np.asarray(values_3d, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("values_3d must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise OutputReaderError(f"values_3d must have shape (nx, ny, nz), got {grid.shape}")
    if min(grid.shape) < 2:
        raise OutputReaderError(
            f"mesh is too coarse for contouring (needs 2+ cells per axis, got {list(grid.shape)})"
        )
    if not np.all(np.isfinite(grid)):
        raise OutputReaderError("tally values must all be finite")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise OutputReaderError("lower_left/upper_right must each hold 3 numbers") from None
    if np.any(~np.isfinite(lo)) or np.any(~np.isfinite(hi)) or np.any(hi <= lo):
        raise OutputReaderError("lower_left/upper_right must be finite with lower < upper")
    return grid, lo, hi


def extract_iso_surface(values_3d, lower_left, upper_right, iso, smooth=True):
    """Extract one iso-surface from a cell-centered regular grid (numpy only).

    The sample lattice is the cell centers (the same lattice the overlay
    samplers use); each lattice cube splits into 6 tetrahedra
    (:data:`_CONTOUR_TETS`) whose straddling edges become surface vertices.
    When ``smooth`` (the overlay slice default) vertices interpolate
    linearly along the edge; otherwise they snap to the edge midpoint (the
    overlay ``pixelated`` convention — same topology, blockier positions).
    Output: dict with ``iso``, ``smooth``, ``points`` ((N, 3) float array)
    and ``triangles`` ((M, 3) int array; empty when the iso misses the data
    range). Raises :class:`OutputReaderError` on bad input. Pure numpy
    apart from the tet loop — no vtk required.
    """
    grid, lo, hi = _require_contour_grid(values_3d, lower_left, upper_right)
    iso = _require_iso_value(iso)
    nx, ny, nz = (int(v) for v in grid.shape)
    spacing = (hi - lo) / np.array([nx, ny, nz], dtype=float)
    axes = [lo[d] + (np.arange(grid.shape[d]) + 0.5) * spacing[d] for d in range(3)]

    points: list = []
    triangles: list = []
    edge_verts: dict = {}

    def vertex(corner_a, corner_b, value_a, value_b):
        """Crossing vertex for one lattice edge (deduplicated by corner pair)."""
        key = (corner_a, corner_b) if corner_a <= corner_b else (corner_b, corner_a)
        hit = edge_verts.get(key)
        if hit is not None:
            return hit
        point_a = np.array([axes[0][corner_a[0]], axes[1][corner_a[1]], axes[2][corner_a[2]]])
        point_b = np.array([axes[0][corner_b[0]], axes[1][corner_b[1]], axes[2][corner_b[2]]])
        if smooth and value_b != value_a:
            fraction = (iso - value_a) / (value_b - value_a)
            vertex_point = point_a + fraction * (point_b - point_a)
        else:
            vertex_point = 0.5 * (point_a + point_b)
        edge_verts[key] = len(points)
        points.append(vertex_point)
        return len(points) - 1

    for i in range(nx - 1):
        for j in range(ny - 1):
            for k in range(nz - 1):
                for tet in _CONTOUR_TETS:
                    corners = [(i + di, j + dj, k + dk) for di, dj, dk in tet]
                    values = [float(grid[c]) for c in corners]
                    for tri_edges in _polygonize_tet(values, iso):
                        triangles.append(
                            [
                                vertex(corners[a], corners[b], values[a], values[b])
                                for a, b in tri_edges
                            ]
                        )
    return {
        "iso": iso,
        "smooth": bool(smooth),
        "points": np.ascontiguousarray(points, dtype=float).reshape(-1, 3),
        "triangles": np.ascontiguousarray(triangles, dtype=np.int64).reshape(-1, 3),
    }


def extract_iso_surfaces(values_3d, lower_left, upper_right, iso_values, smooth=True):
    """Extract several iso-surfaces in one call (numpy only).

    Runs :func:`extract_iso_surface` per value over the same lattice and
    concatenates the results (triangle ids re-based). Output: dict with
    ``isoValues``, ``smooth``, ``points`` ((N, 3)), ``triangles`` ((M, 3))
    and ``values`` ((N,) per-point iso values for coloring). Isos that miss
    the data range contribute nothing — a call whose every iso misses
    yields zero triangles. Raises :class:`OutputReaderError` on bad input.
    """
    isos = _require_iso_values(iso_values)
    grid, lo, hi = _require_contour_grid(values_3d, lower_left, upper_right)
    point_blocks = []
    triangle_blocks = []
    value_blocks = []
    base = 0
    for iso in isos:
        surface = extract_iso_surface(grid, lo, hi, iso, smooth=smooth)
        count = surface["points"].shape[0]
        if count == 0:
            continue
        point_blocks.append(surface["points"])
        triangle_blocks.append(surface["triangles"] + base)
        value_blocks.append(np.full((count,), iso, dtype=float))
        base += count
    if not point_blocks:
        return {
            "isoValues": isos,
            "smooth": bool(smooth),
            "points": np.zeros((0, 3), dtype=float),
            "triangles": np.zeros((0, 3), dtype=np.int64),
            "values": np.zeros((0,), dtype=float),
        }
    return {
        "isoValues": isos,
        "smooth": bool(smooth),
        "points": np.ascontiguousarray(np.vstack(point_blocks), dtype=float).reshape(-1, 3),
        "triangles": np.ascontiguousarray(np.vstack(triangle_blocks), dtype=np.int64).reshape(
            -1, 3
        ),
        "values": np.ascontiguousarray(np.concatenate(value_blocks), dtype=float),
    }


def write_contour_vtp(points, triangles, values, array_name, output_path):
    """Write iso-surface triangles as a .vtp file (lazy vtk).

    Inputs: ``points`` ((N, 3) array, N > 0), ``triangles`` ((M, 3) int
    array of point ids, M > 0), ``values`` ((N,) per-point values for
    coloring), ``array_name`` (point-data array name), ``output_path``
    (.vtp destination). Output: the path string. Raises
    :class:`OutputReaderError` on bad input, id mismatches, or missing
    vtk. Validators run before the vtk gate.
    """
    try:
        pts = np.asarray(points, dtype=float)
    except (TypeError, ValueError):
        raise OutputReaderError("points must be numeric with shape (N, 3)") from None
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape[0] == 0:
        raise OutputReaderError(f"points must have shape (N, 3) with N > 0, got {pts.shape}")
    if not np.all(np.isfinite(pts)):
        raise OutputReaderError("points must all be finite")
    try:
        tris = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    except (TypeError, ValueError):
        raise OutputReaderError("triangles must hold (M, 3) point ids") from None
    if tris.shape[0] == 0:
        raise OutputReaderError("triangles must hold at least one triangle")
    if tris.min() < 0 or tris.max() >= pts.shape[0]:
        raise OutputReaderError(f"triangle ids must lie in [0, {pts.shape[0] - 1}]")
    name = _require_array_name(array_name)
    try:
        vals = np.asarray(values, dtype=float).ravel()
    except (TypeError, ValueError):
        raise OutputReaderError("values must be numeric with one entry per point") from None
    if vals.shape[0] != pts.shape[0]:
        raise OutputReaderError(
            f"values has length {vals.shape[0]}, expected {pts.shape[0]} (one value per point)"
        )
    if not np.all(np.isfinite(vals)):
        raise OutputReaderError("values must all be finite")

    vtk, numpy_support = _load_vtk()
    vtk_points = vtk.vtkPoints()
    vtk_points.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(pts), deep=True))
    polys = vtk.vtkCellArray()
    for tri in tris:
        polys.InsertNextCell(3)
        for point_id in tri:
            polys.InsertCellPoint(int(point_id))

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    polydata.SetPolys(polys)
    _set_point_array(polydata, vals, name)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def tally_contour(
    statepoint_path,
    tally_id,
    iso_values,
    score=None,
    nuclide=None,
    smooth=True,
    output_path=None,
):
    """Extract iso-surfaces from a mesh tally into a .vtp file (no server).

    Inputs: ``statepoint_path`` (.h5 file), ``tally_id`` (positive int),
    ``iso_values`` (1..8 iso values in tally units), optional
    ``score``/``nuclide`` (default: first of each), ``smooth``
    (interpolated edge crossings, default True; False snaps to edge
    midpoints — the overlay ``pixelated`` convention), optional
    ``output_path`` (.vtp destination, default: temp file). Output:
    JSON-safe dict with the output path (``vtkPath``), tally metadata, the
    ``isoValues``, ``smooth``, ``nPoints``/``nTriangles`` and ``dataRange``
    (min/max iso). Raises :class:`OutputReaderError` on bad input, missing
    files/dependencies, non-mesh tallies, or isos that all miss the data.
    """
    # Validate the iso list before the (expensive) tally read — the same
    # fail-fast order the probe uses for its segment geometry.
    isos = _require_iso_values(iso_values)
    data = read_mesh_tally(statepoint_path, tally_id, score=score, nuclide=nuclide)
    dims = data["dimension"]
    lo = np.asarray(data["lowerLeft"], dtype=float)
    hi = np.asarray(data["upperRight"], dtype=float)
    grid = np.asarray(data["values"], dtype=float).reshape(dims, order="F")
    surfaces = extract_iso_surfaces(grid, lo, hi, isos, smooth=smooth)
    if surfaces["triangles"].shape[0] == 0:
        raise OutputReaderError(
            f"iso values {isos} do not intersect tally {data['tallyName']!r} "
            f"(data range {data['dataRange']})"
        )
    _load_vtk()
    if output_path is None:
        output_path = _default_output_path(statepoint_path, ".vtp")
    write_contour_vtp(
        surfaces["points"],
        surfaces["triangles"],
        surfaces["values"],
        data["arrayName"],
        output_path,
    )
    return {
        "vtkPath": output_path,
        "sourceFile": statepoint_path,
        "tallyId": _require_tally_id(tally_id),
        "tallyName": data["tallyName"],
        "score": data["score"],
        "nuclide": data["nuclide"],
        "arrayName": data["arrayName"],
        "isoValues": surfaces["isoValues"],
        "smooth": surfaces["smooth"],
        "nPoints": int(surfaces["points"].shape[0]),
        "nTriangles": int(surfaces["triangles"].shape[0]),
        "dataRange": [float(min(isos)), float(max(isos))],
    }
