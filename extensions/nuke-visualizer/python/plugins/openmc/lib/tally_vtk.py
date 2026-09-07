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

import os
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
    dims, origin, spacing = validate_mesh_grid(
        geometry.get("dims"), geometry.get("origin"), geometry.get("spacing")
    )
    # Re-validate the value payload against the geometry.
    image = build_mesh_image(
        dims,
        origin,
        [o + s * n for o, s, n in zip(origin, spacing, dims, strict=True)],
        geometry["flat"],
    )
    vtk, _ = _load_vtk()

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
        mean = np.asarray(tally["results"][..., 0], dtype=float)
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


def sample_regular_slice(
    values_3d, lower_left, upper_right, plane="z", position=None, resolution=200
):
    """Trilinear-sample a cell-centered regular grid on a slice plane.

    Same sampling math as ``slice_viz.sample_structured_values``: cell
    centers are the sample lattice, out-of-grid coordinates clamp to the
    edge cells. Inputs: ``values_3d`` ((nx, ny, nz) cell means),
    ``lower_left``/``upper_right`` (grid corners in cm), ``plane``
    (``"x"``/``"y"``/``"z"``), ``position`` (plane offset in cm, default:
    grid center), ``resolution`` (points per in-plane axis). Output: dict
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

    spacing = (hi - lo) / np.array([nx, ny, nz], dtype=float)
    frac = (points - lo) / spacing - 0.5
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
    values = (
        c000 * (1 - tx) * (1 - ty) * (1 - tz)
        + c001 * (1 - tx) * (1 - ty) * tz
        + c010 * (1 - tx) * ty * (1 - tz)
        + c011 * (1 - tx) * ty * tz
        + c100 * tx * (1 - ty) * (1 - tz)
        + c101 * tx * (1 - ty) * tz
        + c110 * tx * ty * (1 - tz)
        + c111 * tx * ty * tz
    )
    return {
        "plane": plane,
        "position": position,
        "resolution": resolution,
        "points": points,
        "values": np.ascontiguousarray(values, dtype=float),
    }


def write_overlay_vtp(points, values, array_name, output_path):
    """Write overlay/slice samples as a .vtp vertex cloud (lazy vtk).

    Inputs: ``points`` ((N, 3) array), ``values`` ((N,) array),
    ``array_name`` (point-data array name), ``output_path`` (.vtp
    destination). Output: the path string. Raises
    :class:`OutputReaderError` on bad input, length mismatches, or missing
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
    verts = vtk.vtkCellArray()
    for i in range(pts.shape[0]):
        verts.InsertNextCell(1)
        verts.InsertCellPoint(int(i))
    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    polydata.SetVerts(verts)
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
    return np.column_stack([xx.ravel(order="C"), yy.ravel(order="C"), zz.ravel(order="C")])


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
):
    """Convert a mesh tally to an overlay/slice .vtp file (no server).

    Inputs: ``statepoint_path``, ``tally_id``, optional
    ``score``/``nuclide``, ``mode`` (``"slice"`` resamples the tally on a
    plane; ``"full"`` writes mesh cell centers), ``plane``/``position``/
    ``resolution`` (slice mode), optional ``output_path`` (.vtp destination,
    default: temp file). Full-3D geometry draping needs DAGMC and stays in
    the trame ``visualize-overlay`` server; this static extract carries the
    same tally values. Output: JSON-safe dict with the output path
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
            grid, lo, hi, plane=plane, position=position, resolution=resolution
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
    write_overlay_vtp(points, values, data["arrayName"], output_path)
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
