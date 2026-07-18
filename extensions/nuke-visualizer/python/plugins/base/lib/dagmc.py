"""
DAGMC to VTK converter with MOAB-based graveyard filtering.

This module converts DAGMC .h5m files to VTK format using pymoab,
with special handling to filter out graveyard surfaces that can
obscure the actual geometry.

When pydagmc is available, it also supports:
- Multi-block VTK export with volume/material/group metadata
- Per-volume extraction for selective visualization
- Model info extraction (volumes, materials, groups)
"""

import hashlib
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


def convert_h5m_to_vtk(
    h5m_path: str, output_dir: str = None, return_count: bool = False
) -> str | tuple[str, int]:
    """
    Convert DAGMC .h5m file to VTK using pymoab.

    This function converts the DAGMC file to VTK and applies filtering
    to remove graveyard surfaces (large bounding boxes) while preserving
    the actual geometry surfaces.

    Args:
        h5m_path: Path to the input .h5m file
        output_dir: Optional directory for output file. If None, uses the same directory as input.
        return_count: If True, also return the number of triangles.

    Returns:
        Path to the generated .vtk file, or (path, triangle_count) if return_count=True.
    """
    from pymoab import core, types

    h5m_path = Path(h5m_path)
    if not h5m_path.exists():
        raise FileNotFoundError(f"DAGMC file not found: {h5m_path}")

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
    """
    Convert a single pydagmc volume to a VTK unstructured grid using numpy.

    Uses bulk MOAB queries and numpy vectorized deduplication instead of
    per-triangle Python loops for much better performance.

    Returns:
        (vtkUnstructuredGrid, num_unique_vertices, num_triangles) or None if empty.
    """
    import numpy as np
    import vtk
    from vtk.util import numpy_support

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
    """
    Convert a single DAGMC volume to VTK format.

    This extracts just the triangles belonging to a specific volume,
    creating a clean VTK file for isolated visualization.

    Args:
        h5m_path: Path to the input .h5m file
        volume_id: ID of the volume to extract
        output_path: Optional output path. If None, uses temp directory.

    Returns:
        Path to the generated .vtk file
    """
    h5m_path = Path(h5m_path)
    if not h5m_path.exists():
        raise FileNotFoundError(f"DAGMC file not found: {h5m_path}")

    # Load with pydagmc
    try:
        import pydagmc as dagmc
        from pymoab import types
    except ImportError as e:
        raise ImportError(f"pydagmc not available: {e}")

    model = dagmc.Model(str(h5m_path))

    # Get the volume to extract
    volume = model.volumes_by_id.get(volume_id)
    if volume is None:
        raise ValueError(f"Volume {volume_id} not found in {h5m_path}")

    print(f"[DAGMC] Extracting volume {volume_id} ({volume.num_triangles} triangles)...")

    group_map = {}
    for group in model.groups:
        group_name = group.name
        group_volumes = [int(v.id) for v in group.volumes]
        if group_volumes:
            group_map[group_name] = group_volumes

    result = _volume_to_grid_numpy(volume, model, types, group_map)
    if result is None:
        raise ValueError(f"Volume {volume_id} has no triangles")

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
    import vtk

    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(output_path))
    writer.SetInputData(grid)
    writer.Write()

    print(f"[DAGMC] Volume {volume_id} ({n_tris} triangles) -> {output_path}")
    return str(output_path)


def convert_h5m_to_multiblock_vtk(
    h5m_path: str, output_dir: str = None, include_graveyard: bool = False
) -> dict[str, Any]:
    """
    Convert DAGMC .h5m to a VTK multi-block dataset using pydagmc.

    Each volume becomes a separate block in the multi-block dataset,
    with metadata arrays for volume_id, material, and group membership.
    This enables per-volume and per-material selection in ParaView/Trame.

    Args:
        h5m_path: Path to the input .h5m file
        output_dir: Optional directory for output file. If None, uses temp directory.
        include_graveyard: Whether to include the graveyard volume (material='Graveyard')

    Returns:
        Dict with 'vtm_path', 'volume_info', 'materials', 'groups'
    """
    import vtk

    h5m_path = Path(h5m_path)
    if not h5m_path.exists():
        raise FileNotFoundError(f"DAGMC file not found: {h5m_path}")

    try:
        import pydagmc as dagmc
        from pymoab import types
    except ImportError as e:
        raise ImportError(f"pydagmc not available: {e}")

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
    """
    Extract metadata from a DAGMC .h5m file using pydagmc.

    Args:
        h5m_path: Path to the input .h5m file

    Returns:
        Dict with 'volumes', 'materials', 'groups', 'surfaces', 'fileInfo'
    """
    h5m_path = Path(h5m_path)
    if not h5m_path.exists():
        raise FileNotFoundError(f"DAGMC file not found: {h5m_path}")

    try:
        import pydagmc as dagmc
    except ImportError as e:
        raise ImportError(f"pydagmc not available: {e}")

    model = dagmc.Model(str(h5m_path))

    # Volumes
    volumes = []
    for vol in sorted(model.volumes, key=lambda v: int(v.id)):
        try:
            bbox = vol.bounding_box
            bbox_list = [bbox[0][0], bbox[0][1], bbox[1][0], bbox[1][1], bbox[2][0], bbox[2][1]]
        except Exception:
            bbox_list = None

        volumes.append(
            {
                "id": int(vol.id),
                "material": vol.material or "void",
                "numTriangles": int(vol.num_triangles),
                "numSurfaces": len(list(vol.surfaces)) if hasattr(vol, "surfaces") else 0,
                "boundingBox": bbox_list,
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


def filter_graveyard(
    vtk_path: str,
    output_path: str = None,
    max_edge_length: float = 25.0,
    max_cell_area: float = 1000.0,
) -> str:
    """
    Filter graveyard cells from a VTK file.

    Graveyard surfaces are typically very large bounding boxes used in DAGMC
    for particle termination. They can obscure the actual geometry in visualization.

    This function filters based on:
    1. Cell edge length - graveyard cells have very long edges (>40cm)
    2. Cell surface area - graveyard surfaces are very large

    Uses numpy vectorized operations for high performance on large meshes.

    Args:
        vtk_path: Path to the input VTK file
        output_path: Path for the filtered output. If None, appends '_filtered' to input name.
        max_edge_length: Maximum edge length to keep (default 25.0 cm)
        max_cell_area: Maximum cell surface area to keep (default 1000.0)

    Returns:
        Path to the filtered VTK file
    """
    import numpy as np
    import vtk
    from vtk.util import numpy_support

    vtk_path = Path(vtk_path)
    if not vtk_path.exists():
        raise FileNotFoundError(f"VTK file not found: {vtk_path}")

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
        keep[tri_mask] = areas <= max_cell_area

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
        keep[line_mask] = lengths <= max_edge_length

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

    # Compute hash based on file content (first 1MB) + modification time + filter setting
    stat = h5m_path.stat()
    filter_flag = "filtered" if filtered else "unfiltered"
    hash_input = f"{h5m_path.name}:{stat.st_size}:{stat.st_mtime}:{filter_flag}"
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    suffix = "_filtered" if filtered else "_raw"
    cache_path = cache_dir / f"{h5m_path.stem}_{file_hash}{suffix}.vtk"

    return str(cache_path), cache_path.exists()


def convert_h5m_to_vtk_cached(
    h5m_path: str,
    use_cache: bool = True,
    cache_dir: str = None,
    do_filter_graveyard: bool = True,
    max_cell_area: float = 1000.0,
    max_edge_length: float = 35.0,
) -> dict:
    """
    Convert H5M to VTK with caching and optional graveyard filtering.

    Args:
        h5m_path: Path to the H5M file
        use_cache: Whether to use caching (default True)
        cache_dir: Optional cache directory. Uses system temp dir if None.
        do_filter_graveyard: Whether to filter out graveyard surfaces (default True)
        max_cell_area: Maximum cell surface area to keep (default 1000.0)
        max_edge_length: Maximum edge length to keep (default 35.0)

    Returns:
        Dict with 'vtk_path', 'from_cache', and 'original_cells', 'filtered_cells' info
    """
    h5m_path = Path(h5m_path)

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
        import vtk

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
            max_cell_area=100.0,
        )

        print("\nConversion complete!")
        print(f"  Output: {result['vtk_path']}")
        print(f"  From cache: {result['from_cache']}")
        print(f"  Original cells: {result['original_cells']}")
        print(f"  Filtered cells: {result['filtered_cells']}")
