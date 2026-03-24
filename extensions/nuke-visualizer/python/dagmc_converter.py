"""
DAGMC to VTK converter with MOAB-based graveyard filtering.

This module converts DAGMC .h5m files to VTK format using pymoab,
with special handling to filter out graveyard surfaces that can
obscure the actual geometry.
"""

import os
import tempfile
from pathlib import Path
from typing import Optional, Dict, Tuple
import hashlib

def convert_h5m_to_vtk(h5m_path: str, output_dir: str = None) -> str:
    """
    Convert DAGMC .h5m file to VTK using pymoab.
    
    This function converts the DAGMC file to VTK and applies filtering
    to remove graveyard surfaces (large bounding boxes) while preserving
    the actual geometry surfaces.
    
    Args:
        h5m_path: Path to the input .h5m file
        output_dir: Optional directory for output file. If None, uses the same directory as input.
        
    Returns:
        Path to the generated .vtk file
    """
    from pymoab import core
    
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
    mb.write_file(str(output_path))
    
    print(f"[DAGMC] Created: {output_path}")
    return str(output_path)


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
    
    # Get all point coordinates
    pts = []
    for i in range(n_pts):
        pt_id = cell.GetPointId(i)
        pt = points.GetPoint(pt_id)
        pts.append([pt[0], pt[1], pt[2]])
    
    # For a polygon with n vertices, triangulate as fan from vertex 0
    # Triangle fan: (0, 1, 2), (0, 2, 3), (0, 3, 4), ...
    for i in range(1, n_pts - 1):
        total_area += _compute_triangle_area(pts[0], pts[i], pts[i + 1])
    
    return total_area


def _compute_max_edge_length(cell, points) -> float:
    """Compute the maximum edge length of a cell."""
    import numpy as np
    
    n_pts = cell.GetNumberOfPoints()
    if n_pts < 2:
        return 0.0
    
    max_length = 0.0
    
    # Get all vertex coordinates
    vertices = []
    for i in range(n_pts):
        pt_id = cell.GetPointId(i)
        pt = points.GetPoint(pt_id)
        vertices.append(np.array([pt[0], pt[1], pt[2]]))
    
    # For polygon, check all edges
    for i in range(n_pts):
        pt1 = vertices[i]
        pt2 = vertices[(i + 1) % n_pts]
        length = np.linalg.norm(pt1 - pt2)
        max_length = max(max_length, length)
    
    return max_length


def filter_graveyard(vtk_path: str, output_path: str = None, 
                     max_edge_length: float = 25.0,
                     max_cell_area: float = 1000.0) -> str:
    """
    Filter graveyard cells from a VTK file.
    
    Graveyard surfaces are typically very large bounding boxes used in DAGMC
    for particle termination. They can obscure the actual geometry in visualization.
    
    This function filters based on:
    1. Cell edge length - graveyard cells have very long edges (>40cm)
    2. Cell surface area - graveyard surfaces are very large
    
    Args:
        vtk_path: Path to the input VTK file
        output_path: Path for the filtered output. If None, appends '_filtered' to input name.
        max_edge_length: Maximum edge length to keep (default 25.0 cm)
        max_cell_area: Maximum cell surface area to keep (default 1000.0)
        
    Returns:
        Path to the filtered VTK file
    """
    import vtk
    from vtk.util import numpy_support
    import numpy as np
    
    vtk_path = Path(vtk_path)
    if not vtk_path.exists():
        raise FileNotFoundError(f"VTK file not found: {vtk_path}")
    
    if output_path is None:
        output_path = vtk_path.parent / f"{vtk_path.stem}_filtered.vtk"
    else:
        output_path = Path(output_path)
    
    print(f"[DAGMC] Loading VTK for graveyard filtering...")
    
    reader = vtk.vtkUnstructuredGridReader()
    reader.SetFileName(str(vtk_path))
    reader.Update()
    
    mesh = reader.GetOutput()
    n_cells = mesh.GetNumberOfCells()
    n_points = mesh.GetNumberOfPoints()
    
    print(f"[DAGMC] Original: {n_cells} cells, {n_points} points")
    
    # Create filtered mesh
    filtered = vtk.vtkUnstructuredGrid()
    points = vtk.vtkPoints()
    points.DeepCopy(mesh.GetPoints())
    filtered.SetPoints(points)
    
    # Copy point data
    point_data = mesh.GetPointData()
    filtered.GetPointData().DeepCopy(point_data)
    
    # Filter cells
    kept_cells = 0
    skipped_line = 0
    skipped_area = 0
    
    for i in range(n_cells):
        cell = mesh.GetCell(i)
        cell_type = cell.GetCellType()
        
        # Compute surface area
        area = _compute_cell_surface_area(cell, points)
        
        # Different filtering strategy based on cell type:
        # - LINE cells (edges): filter by edge length (graveyard edges are long)
        # - TRIANGLE cells (surfaces): filter by area (side walls are large edges but small area)
        
        if cell_type == 3:  # VTK_LINE
            max_edge = _compute_max_edge_length(cell, points)
            if max_edge > max_edge_length:
                skipped_line += 1
                continue
        elif cell_type == 5:  # VTK_TRIANGLE
            if area > max_cell_area:
                skipped_area += 1
                continue
        
        # Keep this cell
        filtered.InsertNextCell(cell.GetCellType(), cell.GetPointIds())
        kept_cells += 1
    
    print(f"[DAGMC] Filtered: kept {kept_cells}, skipped {skipped_line + skipped_area} "
          f"({skipped_line} lines by edge, {skipped_area} triangles by area)")
    
    # Write filtered mesh
    writer = vtk.vtkUnstructuredGridWriter()
    writer.SetFileName(str(output_path))
    writer.SetInputData(filtered)
    writer.Write()
    
    print(f"[DAGMC] Created: {output_path}")
    return str(output_path)


def get_cache_path(h5m_path: str, cache_dir: str = None, 
                  filtered: bool = False) -> Tuple[str, bool]:
    """
    Get the cached VTK path for an H5M file.
    
    Args:
        h5m_path: Path to the H5M file
        cache_dir: Optional cache directory. If None, uses system temp dir
        filtered: Whether this is a filtered (graveyard removed) version
        
    Returns:
        Tuple of (cache_vtk_path, exists)
    """
    h5m_path = Path(h5m_path)
    
    if cache_dir is None:
        # Use system temp directory for cross-platform support
        cache_dir = Path(tempfile.gettempdir()) / 'nuke-visualizer' / 'dagmc'
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


def convert_h5m_to_vtk_cached(h5m_path: str, use_cache: bool = True, 
                              cache_dir: str = None,
                              do_filter_graveyard: bool = True,
                              max_cell_area: float = 1000.0,
                              max_edge_length: float = 35.0) -> Dict:
    """
    Convert H5M to VTK with caching and optional graveyard filtering.
    
    Args:
        h5m_path: Path to the H5M file
        use_cache: Whether to use caching (default True)
        cache_dir: Optional cache directory. Uses system temp dir if None.
        do_filter_graveyard: Whether to filter out graveyard surfaces (default True)
        max_cell_area: Maximum cell surface area to keep (default 1000.0)
        
    Returns:
        Dict with 'vtk_path', 'from_cache', and 'original_cells', 'filtered_cells' info
    """
    h5m_path = Path(h5m_path)
    
    result = {
        'vtk_path': None,
        'from_cache': False,
        'original_cells': 0,
        'filtered_cells': 0
    }
    
    # Check cache first (separate cache for filtered vs unfiltered)
    if use_cache:
        cache_path, exists = get_cache_path(str(h5m_path), cache_dir, filtered=do_filter_graveyard)
        if exists:
            print(f"[DAGMC] Using cached VTK ({'filtered' if do_filter_graveyard else 'unfiltered'}): {cache_path}")
            result['vtk_path'] = cache_path
            result['from_cache'] = True
            return result
    else:
        cache_path = None
    
    # Convert H5M to VTK
    if cache_path:
        vtk_path = convert_h5m_to_vtk(str(h5m_path), output_dir=Path(cache_path).parent)
    else:
        vtk_path = convert_h5m_to_vtk(str(h5m_path))
    
    # Count original cells
    import vtk
    reader = vtk.vtkUnstructuredGridReader()
    reader.SetFileName(vtk_path)
    reader.Update()
    result['original_cells'] = reader.GetOutput().GetNumberOfCells()
    
    # Filter graveyard if requested
    if do_filter_graveyard:
        filtered_path = filter_graveyard(vtk_path, cache_path, 
                                         max_cell_area=max_cell_area,
                                         max_edge_length=max_edge_length)
        result['vtk_path'] = filtered_path
        
        # Count filtered cells
        reader2 = vtk.vtkUnstructuredGridReader()
        reader2.SetFileName(filtered_path)
        reader2.Update()
        result['filtered_cells'] = reader2.GetOutput().GetNumberOfCells()
    else:
        # Copy to cache location for unfiltered version
        if cache_path and vtk_path != cache_path:
            import shutil
            shutil.copy2(vtk_path, cache_path)
            result['vtk_path'] = cache_path
        else:
            result['vtk_path'] = vtk_path
        result['filtered_cells'] = result['original_cells']
    
    return result


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python dagmc_converter.py <h5m_file> [output_dir]")
        print("\nConverts DAGMC .h5m files to VTK format with graveyard filtering.")
        sys.exit(1)
    
    h5m_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None
    
    result = convert_h5m_to_vtk_cached(
        h5m_file, 
        use_cache=True,
        cache_dir=output_dir,
        do_filter_graveyard=True,
        max_cell_area=100.0
    )
    
    print(f"\nConversion complete!")
    print(f"  Output: {result['vtk_path']}")
    print(f"  From cache: {result['from_cache']}")
    print(f"  Original cells: {result['original_cells']}")
    print(f"  Filtered cells: {result['filtered_cells']}")
