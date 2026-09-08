"""DAGMC to VTK converters with MOAB-based graveyard filtering.

Each converter turns a DAGMC ``.h5m`` file into a VTK dataset that a
client-side viewer can render directly (no trame/ParaView server):

- single-file VTK mesh (``convert_h5m_to_vtk`` / ``convert_h5m_to_vtk_cached``)
- multi-block ``.vtm`` dataset, one block per volume
  (``convert_h5m_to_multiblock_vtk``)
- per-volume ``.vtu`` extract (``convert_h5m_volume_to_vtk``)
- model metadata for a client block toggle (``get_dagmc_model_info``)
- graveyard-cell filtering for legacy VTK meshes (``filter_graveyard``)

Heavy dependencies (``pymoab``, ``pydagmc``, ``vtk``) are imported lazily
inside :func:`_load_pymoab` / :func:`_load_pydagmc` / :func:`_load_vtk` so a
missing optional dependency surfaces as a clean :class:`DagmcError` instead
of a traceback; command handlers convert these to the single-JSON-object
contract. Geometry construction is numpy-only (unit-testable without
``vtk``); ``vtk`` is used only for the final file write. Server-side
filtering limits (``max_cell_area`` / ``max_edge_length``) default to
``None`` and are derived from the mesh bounding box; explicit values keep
the historical absolute-limit behavior.

All public functions raise :class:`DagmcError` with a human-readable
message on failure. Returned shapes and VTK array names are unchanged.
"""

import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


class DagmcError(Exception):
    """Raised for all DAGMC converter failures (bad input, missing file,
    missing optional dependency, empty result)."""


try:
    import importlib.util as _importlib_util

    HAS_VTK = _importlib_util.find_spec("vtk") is not None
    HAS_PYMOAB = _importlib_util.find_spec("pymoab") is not None
    HAS_PYDAGMC = _importlib_util.find_spec("pydagmc") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_VTK = False
    HAS_PYMOAB = False
    HAS_PYDAGMC = False


def _load_vtk():
    """Lazily import ``vtk`` and return ``(vtk, numpy_support)``.

    Raises :class:`DagmcError` when vtk is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_VTK:
        raise DagmcError("vtk not installed (required for VTK export)")
    try:
        import vtk
        from vtk.util import numpy_support
    except ImportError as exc:
        raise DagmcError(f"vtk not installed (required for VTK export): {exc}") from None
    return vtk, numpy_support


def _load_pymoab():
    """Lazily import ``pymoab`` and return ``(core, types)``.

    Raises :class:`DagmcError` when pymoab is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_PYMOAB:
        raise DagmcError("pymoab not available (required for DAGMC conversion)")
    try:
        from pymoab import core, types
    except ImportError as exc:
        raise DagmcError(f"pymoab not available (required for DAGMC conversion): {exc}") from None
    return core, types


def _load_pydagmc():
    """Lazily import ``pydagmc`` and return ``(dagmc, pymoab_types)``.

    Raises :class:`DagmcError` when pydagmc (or its pymoab companion) is
    not installed so command handlers can report a clean JSON error
    instead of a traceback.
    """
    if not HAS_PYDAGMC:
        raise DagmcError("pydagmc not available (required for DAGMC volume/model inspection)")
    try:
        import pydagmc as dagmc
        from pymoab import types
    except ImportError as exc:
        raise DagmcError(
            f"pydagmc not available (required for DAGMC volume/model inspection): {exc}"
        ) from None
    return dagmc, types


def _require_h5m_path(h5m_path) -> Path:
    """Validate a DAGMC input path.

    Input: ``h5m_path`` (path to the ``.h5m`` file). Output: the path as a
    :class:`pathlib.Path`. Raises :class:`DagmcError` for an empty/invalid
    path or a missing file.
    """
    if not h5m_path or not isinstance(h5m_path, (str, os.PathLike)):
        raise DagmcError(f"invalid DAGMC file path: {h5m_path!r}")
    path = Path(h5m_path)
    if not path.is_file():
        raise DagmcError(f"DAGMC file not found: {path}")
    return path


def _require_vtk_path(vtk_path) -> Path:
    """Validate a VTK input path.

    Input: ``vtk_path`` (path to the ``.vtk`` file). Output: the path as a
    :class:`pathlib.Path`. Raises :class:`DagmcError` for an empty/invalid
    path or a missing file.
    """
    if not vtk_path or not isinstance(vtk_path, (str, os.PathLike)):
        raise DagmcError(f"invalid VTK file path: {vtk_path!r}")
    path = Path(vtk_path)
    if not path.is_file():
        raise DagmcError(f"VTK file not found: {path}")
    return path


def _require_volume_id(volume_id) -> int:
    """Validate a DAGMC volume id.

    Input: ``volume_id`` (int, or an integral string such as ``"3"``).
    Output: the id as an ``int``. Raises :class:`DagmcError` for
    non-integer or non-positive values.
    """
    if isinstance(volume_id, bool):
        raise DagmcError(f"volume_id must be a positive integer, got {volume_id!r}")
    try:
        number = int(volume_id)
    except (TypeError, ValueError):
        raise DagmcError(f"volume_id must be a positive integer, got {volume_id!r}") from None
    if isinstance(volume_id, float) and volume_id != number:
        raise DagmcError(f"volume_id must be a positive integer, got {volume_id!r}")
    if number <= 0:
        raise DagmcError(f"volume_id must be a positive integer, got {volume_id!r}")
    return number


def _require_positive_number(name, value) -> float:
    """Validate a positive-numeric converter limit.

    Input: ``name`` (limit name for messages), ``value`` (int/float budget).
    Output: the value as a ``float``. Raises :class:`DagmcError` for
    non-numeric or non-positive values. ``None`` is rejected: unlike the
    OpenMC track limits, the graveyard thresholds always need a value
    (callers pass the documented defaults).
    """
    if isinstance(value, bool):
        raise DagmcError(f"{name} must be a positive number, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise DagmcError(f"{name} must be a positive number, got {value!r}") from None
    if not number > 0:
        raise DagmcError(f"{name} must be a positive number, got {value!r}")
    return number


def convert_h5m_to_vtk(
    h5m_path: str, output_dir: str = None, return_count: bool = False
) -> str | tuple[str, int]:
    """Convert a DAGMC .h5m file to a single-file VTK mesh via pymoab.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), optional
    ``output_dir`` (destination directory, default: beside the input),
    ``return_count`` (also return the MOAB triangle count).
    Output: the ``.vtk`` path string, or ``(path, triangle_count)`` when
    ``return_count`` is true. Graveyard filtering is NOT applied here —
    see :func:`filter_graveyard` / :func:`convert_h5m_to_vtk_cached`.
    Raises :class:`DagmcError` for a bad path, a missing file, or a
    missing pymoab.
    """
    h5m_path = _require_h5m_path(h5m_path)
    core, types = _load_pymoab()

    # Determine output path
    if output_dir is None:
        output_dir = h5m_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{h5m_path.stem}.vtk"

    # Load with pymoab and convert
    print(f"[DAGMC] Converting {h5m_path.name} to VTK...")
    mb = core.Core()
    mb.load_file(str(h5m_path))

    # Count triangles from MOAB directly
    triangles = mb.get_entities_by_type(0, types.MBTRI)
    n_cells = len(triangles)

    mb.write_file(str(output_path))

    print(f"[DAGMC] Created: {output_path} ({n_cells} triangles)")
    if return_count:
        return str(output_path), n_cells
    return str(output_path)


def _volume_to_grid_numpy(volume, model, types, group_map):
    """Convert a single pydagmc volume to a VTK unstructured grid.

    Bulk MOAB queries plus numpy vectorized deduplication are used instead
    of per-triangle Python loops.

    Inputs: ``volume`` (pydagmc volume), ``model`` (pydagmc model, for
    ``model.mb`` MOAB access), ``types`` (pymoab types module, for
    ``MBTRI``), ``group_map`` (group name -> list of volume ids).
    Output: ``(vtkUnstructuredGrid, num_unique_vertices, num_triangles)``
    or ``None`` when the volume holds no triangles. Cell-data arrays are
    ``volume_id`` (int per cell), ``material`` and ``groups`` (strings).
    Raises :class:`DagmcError` when vtk is not installed.
    """
    import numpy as np

    vtk, numpy_support = _load_vtk()

    # Collect all triangle handles for this volume
    all_tris = []
    for surf in volume.surfaces:
        tris = model.mb.get_entities_by_type(surf.handle, types.MBTRI)
        if tris:
            all_tris.extend(tris)

    n_tris = len(all_tris)
    if n_tris == 0:
        return None

    # Batch-fetch all vertex coordinates (shape: [n_tris, 3, 3])
    verts = model.mb.get_connectivity(all_tris)
    coords = model.mb.get_coords(verts).reshape(n_tris, 3, 3)

    # Deduplicate vertices using numpy structured view
    coords_flat = coords.reshape(-1, 3)
    dtype = coords_flat.dtype
    coords_view = coords_flat.view(np.dtype((np.void, dtype.itemsize * 3)))
    _, unique_idx, inverse = np.unique(coords_view, return_index=True, return_inverse=True)

    unique_coords = coords_flat[unique_idx]
    tri_indices = inverse.reshape(n_tris, 3)

    # Build VTK points array from numpy (zero-copy where possible)
    points = vtk.vtkPoints()
    points.SetData(numpy_support.numpy_to_vtk(unique_coords.astype(np.float64), deep=False))

    # Build VTK cell array from numpy
    cells_np = np.empty((n_tris, 4), dtype=np.int64)
    cells_np[:, 0] = 3
    cells_np[:, 1:4] = tri_indices

    cells_vtk = numpy_support.numpy_to_vtk(cells_np.ravel(), deep=False, array_type=vtk.VTK_ID_TYPE)
    cell_array = vtk.vtkCellArray()
    cell_array.SetCells(n_tris, cells_vtk)

    # Assemble grid
    grid = vtk.vtkUnstructuredGrid()
    grid.SetPoints(points)
    grid.SetCells(vtk.VTK_TRIANGLE, cell_array)

    # Add metadata arrays using numpy bulk creation
    vol_id = int(volume.id)
    material = volume.material or "void"

    # volume_id array
    vol_id_array = numpy_support.numpy_to_vtk(np.full(n_tris, vol_id, dtype=np.int32), deep=False)
    vol_id_array.SetName("volume_id")
    grid.GetCellData().AddArray(vol_id_array)

    # material string array
    mat_array = vtk.vtkStringArray()
    mat_array.SetName("material")
    mat_array.SetNumberOfValues(n_tris)
    mat_str = str(material)
    for i in range(n_tris):
        mat_array.SetValue(i, mat_str)
    grid.GetCellData().AddArray(mat_array)

    # groups string array
    group_names = [g for g, vids in group_map.items() if vol_id in vids]
    group_str = ",".join(group_names) if group_names else ""
    group_array = vtk.vtkStringArray()
    group_array.SetName("groups")
    group_array.SetNumberOfValues(n_tris)
    for i in range(n_tris):
        group_array.SetValue(i, group_str)
    grid.GetCellData().AddArray(group_array)

    return grid, len(unique_coords), n_tris


def convert_h5m_volume_to_vtk(h5m_path: str, volume_id: int, output_path: str = None) -> str:
    """Extract a single DAGMC volume to a ``.vtu`` file via pydagmc.

    Only the triangles belonging to the requested volume are written,
    producing a clean file for isolated visualization.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), ``volume_id``
    (positive integer volume id), optional ``output_path`` (destination;
    a ``.vtk`` suffix is normalized to ``.vtu`` for the XML writer;
    default: the system temp directory).
    Output: the ``.vtu`` path string. Cell-data arrays are ``volume_id``,
    ``material`` and ``groups`` (same names as the multiblock blocks).
    Raises :class:`DagmcError` for a bad path/volume id, a missing file,
    missing pydagmc/vtk, an unknown volume, or a volume with no triangles.
    """
    h5m_path = _require_h5m_path(h5m_path)
    volume_id = _require_volume_id(volume_id)
    dagmc, types = _load_pydagmc()

    model = dagmc.Model(str(h5m_path))

    # Get the volume to extract
    volume = model.volumes_by_id.get(volume_id)
    if volume is None:
        raise DagmcError(f"Volume {volume_id} not found in {h5m_path}")

    print(f"[DAGMC] Extracting volume {volume_id} ({volume.num_triangles} triangles)...")

    group_map = {}
    for group in model.groups:
        group_name = group.name
        group_volumes = [int(v.id) for v in group.volumes]
        if group_volumes:
            group_map[group_name] = group_volumes

    result = _volume_to_grid_numpy(volume, model, types, group_map)
    if result is None:
        raise DagmcError(f"Volume {volume_id} has no triangles")

    grid, n_verts, n_tris = result
    print(f"[DAGMC]   Unique vertices: {n_verts}, Triangles: {n_tris}")

    # Determine output path
    if output_path is None:
        output_path = Path(tempfile.gettempdir()) / f"volume_{volume_id}_{h5m_path.stem}.vtu"
    else:
        output_path = Path(output_path)
        # Use .vtu extension for XML VTK format
        if output_path.suffix == ".vtk":
            output_path = output_path.with_suffix(".vtu")

    # Write to file
    vtk, _ = _load_vtk()

    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(output_path))
    writer.SetInputData(grid)
    writer.Write()

    print(f"[DAGMC] Volume {volume_id} ({n_tris} triangles) -> {output_path}")
    return str(output_path)


def convert_h5m_to_multiblock_vtk(
    h5m_path: str, output_dir: str = None, include_graveyard: bool = False
) -> dict[str, Any]:
    """Convert a DAGMC .h5m file to a VTK multi-block ``.vtm`` via pydagmc.

    Each volume becomes a separate block with cell-data arrays for
    ``volume_id``, ``material``, and ``groups`` membership, enabling
    per-volume and per-material selection in the client viewer.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), optional
    ``output_dir`` (destination directory, default: the temp-dir
    ``nuke-visualizer/dagmc`` cache), ``include_graveyard`` (keep the
    ``material='Graveyard'`` volume, default False).
    Output: dict with ``vtm_path``, ``volume_info`` (one entry per block:
    ``id``, ``material``, ``numTriangles``, ``numVertices``, ``groups``,
    ``blockIndex``, ``selector``), ``materials`` (material name -> volume
    id list) and ``groups`` (group name -> volume id list).
    Raises :class:`DagmcError` for a bad path, a missing file, or missing
    pydagmc/vtk.
    """
    h5m_path = _require_h5m_path(h5m_path)
    dagmc, types = _load_pydagmc()
    vtk, _ = _load_vtk()

    if output_dir is None:
        output_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "dagmc"
    else:
        output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    model = dagmc.Model(str(h5m_path))

    # Collect all group info upfront
    group_map = {}  # group_name -> list of volume ids
    for group in model.groups:
        group_name = group.name
        group_volumes = [int(v.id) for v in group.volumes]
        if group_volumes:
            group_map[group_name] = group_volumes

    multi_block = vtk.vtkMultiBlockDataSet()
    volume_info = []
    material_map = {}  # material_name -> list of volume ids
    block_index = 0

    # Sort volumes by ID for consistent ordering
    sorted_volumes = sorted(model.volumes, key=lambda v: int(v.id))

    for volume in sorted_volumes:
        vol_id = int(volume.id)
        material = volume.material or "void"
        num_triangles = int(volume.num_triangles)

        # Skip graveyard unless requested
        if not include_graveyard and material and material.lower() == "graveyard":
            print(f"[DAGMC] Skipping graveyard volume {vol_id}")
            continue

        print(f"[DAGMC] Processing volume {vol_id} ({material}, {num_triangles} triangles)...")

        result = _volume_to_grid_numpy(volume, model, types, group_map)
        if result is None:
            continue

        grid, n_verts, n_tris = result

        # Add to multi-block
        multi_block.SetBlock(block_index, grid)
        multi_block.GetMetaData(block_index).Set(vtk.vtkCompositeDataSet.NAME(), f"Volume_{vol_id}")

        # Track volume info
        group_names = [g for g, vids in group_map.items() if vol_id in vids]
        volume_info.append(
            {
                "id": vol_id,
                "material": material,
                "numTriangles": num_triangles,
                "numVertices": n_verts,
                "groups": group_names,
                "blockIndex": block_index,
                "selector": f"/Root/Volume_{vol_id}",
            }
        )

        # Track material mapping
        mat_key = str(material) if material else "void"
        if mat_key not in material_map:
            material_map[mat_key] = []
        material_map[mat_key].append(vol_id)

        block_index += 1

    # Write multi-block to .vtm file
    vtm_path = output_dir / f"{h5m_path.stem}_volumes.vtm"
    writer = vtk.vtkXMLMultiBlockDataWriter()
    writer.SetFileName(str(vtm_path))
    writer.SetInputData(multi_block)
    writer.Write()

    print(f"[DAGMC] Multi-block VTK: {vtm_path} ({block_index} volumes)")

    return {
        "vtm_path": str(vtm_path),
        "volume_info": volume_info,
        "materials": material_map,
        "groups": group_map,
    }


def get_dagmc_model_info(h5m_path: str) -> dict[str, Any]:
    """Extract model metadata from a DAGMC .h5m file via pydagmc.

    The result carries the complete block meta a client needs for a
    volume/material/group toggle without opening the converted dataset:
    every volume entry holds its ``id``, ``name``, ``selector``, material
    name and group names; ``materials``/``groups`` map each name to its
    volume ids. Volume ``name``/``selector`` follow the multiblock naming
    convention (``Volume_<id>`` / ``/Root/Volume_<id>``), so entries
    correlate with :func:`convert_h5m_to_multiblock_vtk` blocks by id.

    Input: ``h5m_path`` (path to the ``.h5m`` file).
    Output: dict with ``volumes`` (``id``, ``name``, ``selector``,
    ``material``, ``numTriangles``, ``numSurfaces``, ``boundingBox``,
    ``groups``), ``materials`` (name -> ``volumeCount``/``volumeIds``),
    ``groups`` (name -> ``volumeCount``/``volumeIds``; empty groups are
    dropped), ``surfaces`` (``id``, ``numTriangles``,
    ``forwardVolumes``/``reverseVolumes``) and ``fileInfo``.
    Raises :class:`DagmcError` for a bad path, a missing file, or missing
    pydagmc.
    """
    h5m_path = _require_h5m_path(h5m_path)
    dagmc, _ = _load_pydagmc()

    model = dagmc.Model(str(h5m_path))

    # Group membership upfront so each volume can list its group names.
    group_map: dict[str, list[int]] = {}  # group_name -> list of volume ids
    for group in model.groups:
        group_volumes = [int(v.id) for v in group.volumes]
        if group_volumes:
            group_map[group.name] = group_volumes

    # Volumes
    volumes = []
    for vol in sorted(model.volumes, key=lambda v: int(v.id)):
        vol_id = int(vol.id)
        try:
            bbox = vol.bounding_box
            bbox_list = [bbox[0][0], bbox[0][1], bbox[1][0], bbox[1][1], bbox[2][0], bbox[2][1]]
        except Exception:
            bbox_list = None

        volumes.append(
            {
                "id": vol_id,
                "name": f"Volume_{vol_id}",
                "selector": f"/Root/Volume_{vol_id}",
                "material": vol.material or "void",
                "numTriangles": int(vol.num_triangles),
                "numSurfaces": len(list(vol.surfaces)) if hasattr(vol, "surfaces") else 0,
                "boundingBox": bbox_list,
                "groups": [g for g, vids in group_map.items() if vol_id in vids],
            }
        )

    # Materials
    materials = {}
    for mat_name, vols in model.volumes_by_material.items():
        materials[mat_name] = {"volumeCount": len(vols), "volumeIds": [int(v.id) for v in vols]}

    # Groups
    groups = {}
    for group in model.groups:
        group_name = group.name
        group_volumes = [int(v.id) for v in group.volumes]
        if group_volumes:
            groups[group_name] = {"volumeCount": len(group_volumes), "volumeIds": group_volumes}

    # Surfaces
    surfaces = []
    for surf in sorted(model.surfaces, key=lambda s: int(s.id)):
        surfaces.append(
            {
                "id": int(surf.id),
                "numTriangles": int(surf.num_triangles) if hasattr(surf, "num_triangles") else 0,
                "forwardVolumes": [int(v.id) for v in surf.forward_volumes]
                if hasattr(surf, "forward_volumes")
                else [],
                "reverseVolumes": [int(v.id) for v in surf.reverse_volumes]
                if hasattr(surf, "reverse_volumes")
                else [],
            }
        )

    # File info
    stat = h5m_path.stat()
    file_info = {
        "path": str(h5m_path),
        "name": h5m_path.name,
        "sizeBytes": stat.st_size,
        "sizeMb": round(stat.st_size / (1024 * 1024), 2),
    }

    return {
        "volumes": volumes,
        "materials": materials,
        "groups": groups,
        "surfaces": surfaces,
        "fileInfo": file_info,
    }


def _compute_triangle_area(p0, p1, p2) -> float:
    """Compute area of a triangle given three points."""
    import numpy as np

    # Vector from p0 to p1
    v0 = np.array([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])
    # Vector from p0 to p2
    v1 = np.array([p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]])

    # Cross product
    cross = np.cross(v0, v1)
    # Area is half the magnitude
    return 0.5 * np.linalg.norm(cross)


def _compute_cell_surface_area(cell, points) -> float:
    """Compute the total surface area of a cell (triangle or polygon fan)."""
    import numpy as np

    n_pts = cell.GetNumberOfPoints()
    if n_pts < 3:
        return 0.0

    total_area = 0.0
    pt0 = np.array(points.GetPoint(cell.GetPointId(0)))

    # For a polygon with n vertices, triangulate as fan from vertex 0
    # Triangle fan: (0, 1, 2), (0, 2, 3), (0, 3, 4), ...
    for i in range(1, n_pts - 1):
        pt1 = np.array(points.GetPoint(cell.GetPointId(i)))
        pt2 = np.array(points.GetPoint(cell.GetPointId(i + 1)))
        total_area += _compute_triangle_area(pt0, pt1, pt2)

    return total_area


def _compute_max_edge_length(cell, points) -> float:
    """Compute the maximum edge length of a cell."""
    import numpy as np

    n_pts = cell.GetNumberOfPoints()
    if n_pts < 2:
        return 0.0

    max_length = 0.0

    for i in range(n_pts):
        pt1 = np.array(points.GetPoint(cell.GetPointId(i)))
        pt2 = np.array(points.GetPoint(cell.GetPointId((i + 1) % n_pts)))
        length = np.linalg.norm(pt1 - pt2)
        if length > max_length:
            max_length = length

    return max_length


# Bump whenever the graveyard-filter derivation changes: the value feeds the
# conversion cache key so stale filtered files are never reused.
FILTER_VERSION = 2


def filter_graveyard(
    vtk_path: str,
    output_path: str = None,
    max_edge_length: float = None,
    max_cell_area: float = None,
) -> str:
    """Filter graveyard cells from a VTK file.

    Graveyard surfaces are typically very large bounding boxes used in DAGMC
    for particle termination. They can obscure the actual geometry in visualization.

    Filtering uses numpy vectorized operations over the mesh connectivity:
    1. Triangle cells (type 5) larger than ``max_cell_area`` are dropped.
    2. Line cells (type 3) longer than ``max_edge_length`` are dropped.
    All other cell types are always kept.

    A ``None`` limit is derived from the mesh itself: the graveyard box is on
    the order of the whole-model bounding box, while real facets are orders
    of magnitude smaller, so triangles larger than ``bbox_surface / 100``
    (lines longer than ``bbox_diagonal / 100``) are dropped. Absolute limits
    such as the historical 100.0/1000.0 silently eat real geometry on
    millimeter-scale models (a tokamak lost 97% of its facets), which is why
    derivation is the default. If derivation would drop more than 90% of the
    mesh (e.g. a single-box model whose faces ARE the geometry), only cells
    bigger than a full bounding-box face are dropped instead.

    Inputs: ``vtk_path`` (legacy ``.vtk`` unstructured-grid file),
    optional ``output_path`` (default: ``<stem>_filtered.vtk`` beside the
    input), ``max_edge_length`` / ``max_cell_area`` (explicit limits win;
    default None derives from the mesh bbox as above).
    Output: the filtered ``.vtk`` path string. When nothing is filtered
    (or the mesh is empty) the input is copied to the output path.
    Raises :class:`DagmcError` for a bad path, a missing file, invalid
    limits, or missing vtk.
    """
    import numpy as np

    vtk_path = _require_vtk_path(vtk_path)
    if max_edge_length is not None:
        max_edge_length = _require_positive_number("max_edge_length", max_edge_length)
    if max_cell_area is not None:
        max_cell_area = _require_positive_number("max_cell_area", max_cell_area)
    vtk, numpy_support = _load_vtk()

    if output_path is None:
        output_path = vtk_path.parent / f"{vtk_path.stem}_filtered.vtk"
    else:
        output_path = Path(output_path)

    print("[DAGMC] Loading VTK for graveyard filtering...")

    reader = vtk.vtkUnstructuredGridReader()
    reader.SetFileName(str(vtk_path))
    reader.Update()

    mesh = reader.GetOutput()
    n_cells = mesh.GetNumberOfCells()
    n_points = mesh.GetNumberOfPoints()

    print(f"[DAGMC] Original: {n_cells} cells, {n_points} points")

    if n_cells == 0:
        if str(output_path) != str(vtk_path):
            shutil.copy2(vtk_path, output_path)
        return str(output_path)

    # Vectorized cell filtering using numpy
    points = numpy_support.vtk_to_numpy(mesh.GetPoints().GetData())  # (n_points, 3)
    cell_types = numpy_support.vtk_to_numpy(mesh.GetCellTypesArray())  # (n_cells,)

    cell_array = mesh.GetCells()
    offsets = numpy_support.vtk_to_numpy(cell_array.GetOffsetsArray())  # (n_cells + 1,)
    connectivity = numpy_support.vtk_to_numpy(cell_array.GetConnectivityArray())  # flat

    keep = np.ones(n_cells, dtype=bool)

    # Derive scale-relative limits when the caller passes None (the default):
    # the graveyard box spans the whole model, so anything on the order of
    # the bounding box is graveyard while real facets are far smaller.
    derive = max_cell_area is None or max_edge_length is None
    if derive:
        if points.shape[0] == 0:
            raise DagmcError(f"cannot derive filter limits: mesh '{vtk_path}' has no points")
        extents = points.max(axis=0) - points.min(axis=0)
        bbox_surface = float(
            2.0 * (extents[0] * extents[1] + extents[1] * extents[2] + extents[2] * extents[0])
        )
        bbox_diagonal = float(np.linalg.norm(extents))
    tri_area_limit = max_cell_area if max_cell_area is not None else bbox_surface / 100.0
    edge_limit = max_edge_length if max_edge_length is not None else bbox_diagonal / 100.0

    # Process triangles (type 5) in bulk
    tri_mask = cell_types == 5
    n_tris = int(tri_mask.sum())
    if n_tris > 0:
        tri_offsets = offsets[:-1][tri_mask]
        tri_idx = tri_offsets[:, None] + np.arange(3, dtype=np.int64)
        tri_pts = connectivity[tri_idx]  # (n_tris, 3)

        p0 = points[tri_pts[:, 0]]
        p1 = points[tri_pts[:, 1]]
        p2 = points[tri_pts[:, 2]]

        areas = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1)
        keep[tri_mask] = areas <= tri_area_limit

    # Process lines (type 3) in bulk
    line_mask = cell_types == 3
    n_lines = int(line_mask.sum())
    if n_lines > 0:
        line_offsets = offsets[:-1][line_mask]
        line_idx = line_offsets[:, None] + np.arange(2, dtype=np.int64)
        line_pts = connectivity[line_idx]  # (n_lines, 2)

        p0 = points[line_pts[:, 0]]
        p1 = points[line_pts[:, 1]]

        lengths = np.linalg.norm(p1 - p0, axis=1)
        keep[line_mask] = lengths <= edge_limit

    if derive and int(keep.sum()) < max(10, int(0.1 * n_cells)):
        # Derivation would wipe the mesh (e.g. a single-box model whose faces
        # ARE the geometry): keep everything except cells bigger than a full
        # bounding-box face, which only a surrounding box can exceed.
        print(
            f"[DAGMC] Derived limits would keep only {int(keep.sum())}/{n_cells} cells; "
            "falling back to bounding-box-face limits."
        )
        keep = np.ones(n_cells, dtype=bool)
        if n_tris > 0:
            keep[tri_mask] = areas <= bbox_surface / 6.0
        if n_lines > 0:
            keep[line_mask] = lengths <= bbox_diagonal

    skipped_area = int((tri_mask & ~keep).sum())
    skipped_line = int((line_mask & ~keep).sum())
    kept_cells = int(keep.sum())

    print(
        f"[DAGMC] Filtered: keeping {kept_cells}, skipping {skipped_line + skipped_area} "
        f"({skipped_line} lines by edge, {skipped_area} triangles by area)"
    )

    if kept_cells == n_cells:
        # Nothing was filtered; just copy to output path
        if str(output_path) != str(vtk_path):
            shutil.copy2(vtk_path, output_path)
        return str(output_path)

    # Use vtkExtractCells for efficient bulk extraction (avoids DeepCopy + per-cell InsertNextCell)
    kept_ids = np.nonzero(keep)[0].astype(np.int64)

    selection = vtk.vtkSelection()
    node = vtk.vtkSelectionNode()
    node.SetFieldType(vtk.vtkSelectionNode.CELL)
    node.SetContentType(vtk.vtkSelectionNode.INDICES)
    id_array = numpy_support.numpy_to_vtk(kept_ids, deep=False)
    node.SetSelectionList(id_array)
    selection.AddNode(node)

    extract = vtk.vtkExtractSelection()
    extract.SetInputData(0, mesh)
    extract.SetInputData(1, selection)
    extract.Update()

    filtered = vtk.vtkUnstructuredGrid.SafeDownCast(extract.GetOutput())

    # Write filtered mesh
    writer = vtk.vtkUnstructuredGridWriter()
    writer.SetFileName(str(output_path))
    writer.SetInputData(filtered)
    writer.Write()

    print(f"[DAGMC] Created: {output_path}")
    return str(output_path)


def get_cache_path(
    h5m_path: str, cache_dir: str = None, filtered: bool = False
) -> tuple[str, bool]:
    """
    Get the cached VTK path for an H5M file.

    Args:
        h5m_path: Path to the H5M file
        cache_dir: Optional cache directory. Uses system temp dir if None.
        filtered: Whether this is a filtered (graveyard removed) version

    Returns:
        Tuple of (cache_vtk_path, exists)
    """
    h5m_path = Path(h5m_path)

    if cache_dir is None:
        # Use system temp directory for cross-platform support
        cache_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "dagmc"
    else:
        cache_dir = Path(cache_dir)

    cache_dir.mkdir(parents=True, exist_ok=True)

    # Compute hash based on file content (first 1MB) + modification time + filter setting.
    # FILTER_VERSION invalidates entries written by older filter derivations.
    stat = h5m_path.stat()
    filter_flag = "filtered" if filtered else "unfiltered"
    hash_input = f"{h5m_path.name}:{stat.st_size}:{stat.st_mtime}:{filter_flag}:v{FILTER_VERSION}"
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    suffix = "_filtered" if filtered else "_raw"
    cache_path = cache_dir / f"{h5m_path.stem}_{file_hash}{suffix}.vtk"

    return str(cache_path), cache_path.exists()


def convert_h5m_to_vtk_cached(
    h5m_path: str,
    use_cache: bool = True,
    cache_dir: str = None,
    do_filter_graveyard: bool = True,
    max_cell_area: float = None,
    max_edge_length: float = None,
) -> dict:
    """Convert H5M to VTK with caching and optional graveyard filtering.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), ``use_cache``
    (default True), optional ``cache_dir`` (default: the temp-dir
    ``nuke-visualizer/dagmc`` cache), ``do_filter_graveyard`` (default
    True), ``max_cell_area`` / ``max_edge_length`` (default None: derived
    from the mesh bbox by :func:`filter_graveyard`) — explicit limits are
    forwarded to :func:`filter_graveyard` unchanged.
    Output: dict with ``vtk_path``, ``from_cache``, ``original_cells``
    and ``filtered_cells``.
    Raises :class:`DagmcError` for a bad path, a missing file, invalid
    limits, or missing pymoab/vtk.
    """
    h5m_path = _require_h5m_path(h5m_path)

    result = {"vtk_path": None, "from_cache": False, "original_cells": 0, "filtered_cells": 0}

    # Check cache first (separate cache for filtered vs unfiltered)
    if use_cache:
        cache_path, exists = get_cache_path(str(h5m_path), cache_dir, filtered=do_filter_graveyard)
        if exists:
            print(
                f"[DAGMC] Using cached VTK ({'filtered' if do_filter_graveyard else 'unfiltered'}): {cache_path}"
            )
            result["vtk_path"] = cache_path
            result["from_cache"] = True
            return result
    else:
        cache_path = None

    # Convert H5M to VTK (returns path + triangle count from MOAB)
    if cache_path:
        vtk_path, n_cells = convert_h5m_to_vtk(
            str(h5m_path), output_dir=Path(cache_path).parent, return_count=True
        )
    else:
        vtk_path, n_cells = convert_h5m_to_vtk(str(h5m_path), return_count=True)

    result["original_cells"] = n_cells

    # Filter graveyard if requested
    if do_filter_graveyard:
        filtered_path = filter_graveyard(
            vtk_path, cache_path, max_cell_area=max_cell_area, max_edge_length=max_edge_length
        )
        result["vtk_path"] = filtered_path

        # Count filtered cells using VTK (much smaller dataset after filtering)
        vtk, _ = _load_vtk()

        reader = vtk.vtkUnstructuredGridReader()
        reader.SetFileName(filtered_path)
        reader.Update()
        result["filtered_cells"] = reader.GetOutput().GetNumberOfCells()
    else:
        # Copy to cache location for unfiltered version
        if cache_path and str(vtk_path) != str(cache_path):
            shutil.copy2(vtk_path, cache_path)
            result["vtk_path"] = cache_path
        else:
            result["vtk_path"] = vtk_path
        result["filtered_cells"] = result["original_cells"]

    return result


# Marker segment in the multiblock cache key: reuses the get_cache_path
# ``name:size:mtime:flag:vFILTER_VERSION`` pattern so content changes and
# filter-derivation bumps invalidate multiblock entries in step.
MULTIBLOCK_CACHE_MARKER = "multiblock"


def get_multiblock_cache_path(
    h5m_path: str, cache_dir: str = None, include_graveyard: bool = False
) -> tuple[str, bool]:
    """Get the cached multiblock manifest path for an H5M file.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), optional
    ``cache_dir`` (default: the temp-dir ``nuke-visualizer/dagmc`` cache),
    ``include_graveyard`` (keeps the ``Graveyard`` volume; cached
    separately).
    Output: ``(manifest_path, exists)`` where the manifest is
    ``<stem>_volumes.vtm`` inside the hash subdirectory
    ``<stem>_<hash>_multiblock``. The hash reuses the
    :func:`get_cache_path` key pattern (file name, size, mtime, and
    ``FILTER_VERSION``) plus the multiblock marker, so stale manifests are
    never reused. A hit is simply an existing manifest file.
    Raises :class:`DagmcError` for a bad path or a missing file.
    """
    h5m_path = _require_h5m_path(h5m_path)

    if cache_dir is None:
        cache_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "dagmc"
    else:
        cache_dir = Path(cache_dir)

    cache_dir.mkdir(parents=True, exist_ok=True)

    stat = h5m_path.stat()
    grave_flag = "graveyard" if include_graveyard else "nograveyard"
    hash_input = (
        f"{h5m_path.name}:{stat.st_size}:{stat.st_mtime}:"
        f"{MULTIBLOCK_CACHE_MARKER}-{grave_flag}:v{FILTER_VERSION}"
    )
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    manifest_dir = cache_dir / f"{h5m_path.stem}_{file_hash}_multiblock"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"{h5m_path.stem}_volumes.vtm"

    return str(manifest_path), manifest_path.is_file()


def convert_h5m_to_multiblock_vtk_cached(
    h5m_path: str,
    use_cache: bool = True,
    cache_dir: str = None,
    include_graveyard: bool = False,
) -> dict:
    """Convert H5M to a multiblock ``.vtm`` with manifest caching.

    Inputs: ``h5m_path`` (path to the ``.h5m`` file), ``use_cache``
    (default True), optional ``cache_dir`` (default: the temp-dir
    ``nuke-visualizer/dagmc`` cache), ``include_graveyard`` (default
    False).
    Output: dict with ``vtm_path``, ``from_cache``, ``volume_info``,
    ``materials`` and ``groups``. On a cache hit the manifest exists
    already, so ``volume_info``/``materials``/``groups`` are empty (the
    client reads block structure from the manifest and toggles from
    ``dagmc.info``).
    Raises :class:`DagmcError` for a bad path, a missing file, or missing
    pydagmc/vtk.
    """
    h5m_path = _require_h5m_path(h5m_path)

    manifest_path, exists = get_multiblock_cache_path(
        str(h5m_path), cache_dir, include_graveyard=include_graveyard
    )
    if use_cache and exists:
        print(f"[DAGMC] Using cached multiblock: {manifest_path}")
        return {
            "vtm_path": manifest_path,
            "from_cache": True,
            "volume_info": [],
            "materials": {},
            "groups": {},
        }

    result = convert_h5m_to_multiblock_vtk(
        str(h5m_path),
        output_dir=str(Path(manifest_path).parent),
        include_graveyard=include_graveyard,
    )
    result["from_cache"] = False
    return result


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python dagmc_converter.py <h5m_file> [output_dir] [--volume VOLUME_ID]")
        print("\nConverts DAGMC .h5m files to VTK format with graveyard filtering.")
        print("\nOptions:")
        print("  --volume VOLUME_ID  Extract only a specific volume")
        sys.exit(1)

    h5m_file = sys.argv[1]
    output_dir = None
    volume_id = None

    # Parse arguments
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--volume" and i + 1 < len(sys.argv):
            volume_id = int(sys.argv[i + 1])
            i += 2
        else:
            output_dir = sys.argv[i]
            i += 1

    if volume_id is not None:
        # Single volume extraction
        output_path = convert_h5m_volume_to_vtk(h5m_file, volume_id)
        print("\nVolume extraction complete!")
        print(f"  Output: {output_path}")
    else:
        # Full model conversion
        result = convert_h5m_to_vtk_cached(
            h5m_file,
            use_cache=True,
            cache_dir=output_dir,
            do_filter_graveyard=True,
        )

        print("\nConversion complete!")
        print(f"  Output: {result['vtk_path']}")
        print(f"  From cache: {result['from_cache']}")
        print(f"  Original cells: {result['original_cells']}")
        print(f"  Filtered cells: {result['filtered_cells']}")
