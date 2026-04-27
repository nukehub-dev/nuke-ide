"""
OpenMC Slice Visualization Engine

Provides slice-based tally visualization with geometry clipping.
Adapts the approach from slice_dagmc_heatmap.py for integration
into the Nuke Visualizer plugin system.

Key features:
- Auto-detect geometry from statepoint folder
- High-resolution slice planes with vtkProbeFilter
- Geometry clipping via vtkSelectEnclosedPoints
- Smooth or pixelated (blocky) modes
- Optional geometry outline overlay
"""

import os
import sys
import tempfile
from typing import Dict, List, Optional, Tuple, Any
import numpy as np

# Patch numpy for VTK compatibility
if not hasattr(np, 'in1d'):
    np.in1d = np.isin

import vtk
from vtk.util.numpy_support import vtk_to_numpy

try:
    import openmc
    HAS_OPENMC = True
except ImportError:
    HAS_OPENMC = False

try:
    import pymoab.core as mbcore
    import pymoab.types as mbtypes
    HAS_PYMOAB = True
except ImportError:
    HAS_PYMOAB = False


class SliceVisualizationResult:
    """Result of slice visualization creation."""
    
    def __init__(self):
        self.heatmap_vtk_path: Optional[str] = None
        self.geometry_slice_vtk_path: Optional[str] = None
        self.combined_vtk_path: Optional[str] = None
        self.data_range: Tuple[float, float] = (0.0, 0.0)
        self.array_name: str = "flux_mean"
        self.plane: str = "z"
        self.position: float = 0.0
        self.geometry_found: bool = False
        self.graveyard_filtered: bool = False


def _build_vtk_grid_from_triangles(mb, triangles):
    """Build a VTK unstructured grid from a list of MOAB triangles."""
    if not triangles:
        return None
    
    all_verts = set()
    tri_vert_ids = []
    for tri in triangles:
        conn = mb.get_connectivity(tri)
        tri_vert_ids.append(list(conn))
        for v in conn:
            all_verts.add(v)
    
    if not all_verts:
        return None
    
    all_verts = list(all_verts)
    coords = mb.get_coords(all_verts)
    coords = np.array(coords).reshape(-1, 3)
    
    points = vtk.vtkPoints()
    for coord in coords:
        points.InsertNextPoint(coord)
    
    grid = vtk.vtkUnstructuredGrid()
    grid.SetPoints(points)
    
    vert_to_idx = {v: i for i, v in enumerate(all_verts)}
    
    for tri_conn in tri_vert_ids:
        ids = [vert_to_idx[v] for v in tri_conn]
        tri_cell = vtk.vtkTriangle()
        tri_cell.GetPointIds().SetId(0, ids[0])
        tri_cell.GetPointIds().SetId(1, ids[1])
        tri_cell.GetPointIds().SetId(2, ids[2])
        grid.InsertNextCell(tri_cell.GetCellType(), tri_cell.GetPointIds())
    
    return grid


def load_dagmc_geometry(filename: str, filter_graveyard: Optional[bool] = None):
    """
    Load DAGMC geometry from h5m file.
    
    Args:
        filename: Path to .h5m file
        filter_graveyard: If True, exclude graveyard. If False, include all.
                          If None, return both and let caller decide.
    
    Returns:
        Tuple of (full_grid, physical_grid, physical_volume_grids, volume_info)
        where volume_info is a list of (vol_id, vol_size, vol_tris) tuples
    """
    if not HAS_PYMOAB:
        raise RuntimeError("pymoab is required for DAGMC geometry loading")
    
    mb = mbcore.Core()
    mb.load_file(filename)
    
    root_set = mb.get_root_set()
    tri_type = mbtypes.MBTRI
    all_triangles = list(mb.get_entities_by_type(root_set, tri_type))
    
    if not all_triangles:
        print(f"Warning: No triangles found in {filename}")
        return None, None, [], []
    
    full_grid = _build_vtk_grid_from_triangles(mb, all_triangles)
    
    # Try to identify volumes
    try:
        geom_dim_tag = mb.tag_get_handle("GEOM_DIMENSION", size=1, 
                                         tag_type=mbtypes.MB_TYPE_INTEGER,
                                         storage_type=mbtypes.MB_TAG_SPARSE, 
                                         create_if_missing=False)
        category_tag = mb.tag_get_handle("CATEGORY", size=32, 
                                         tag_type=mbtypes.MB_TYPE_OPAQUE,
                                         storage_type=mbtypes.MB_TAG_SPARSE, 
                                         create_if_missing=False)
        id_tag = mb.tag_get_handle("GLOBAL_ID", size=1, 
                                   tag_type=mbtypes.MB_TYPE_INTEGER,
                                   storage_type=mbtypes.MB_TAG_SPARSE, 
                                   create_if_missing=False)
        
        volumes = mb.get_entities_by_type_and_tag(root_set, mbtypes.MBENTITYSET, 
                                                   [category_tag], [b'Volume'])
        
        vol_info = []
        graveyard_vol = None
        max_volume = -1
        
        for vol in volumes:
            try:
                vol_id = mb.tag_get_data(id_tag, [vol])[0][0]
            except:
                continue
            
            children = mb.get_child_meshsets(vol)
            vol_tris = set()
            for child in children:
                try:
                    child_dim = mb.tag_get_data(geom_dim_tag, [child])[0][0]
                    if child_dim == 2:
                        child_tris = mb.get_entities_by_type(child, tri_type)
                        vol_tris.update(child_tris)
                except:
                    pass
            
            if vol_tris:
                verts = set()
                for tri in vol_tris:
                    for v in mb.get_connectivity(tri):
                        verts.add(v)
                coords = mb.get_coords(list(verts))
                coords = np.array(coords).reshape(-1, 3)
                dx = coords[:, 0].max() - coords[:, 0].min()
                dy = coords[:, 1].max() - coords[:, 1].min()
                dz = coords[:, 2].max() - coords[:, 2].min()
                vol_size = dx * dy * dz
                
                vol_info.append((vol_id, vol_size, vol_tris))
                
                if vol_size > max_volume:
                    max_volume = vol_size
                    graveyard_vol = vol_id
        
        vol_info.sort(key=lambda x: x[1])
        
        # Build physical grid (excluding graveyard)
        physical_triangles = set()
        physical_volume_grids = []
        
        for vol_id, vol_size, vol_tris in vol_info:
            if vol_id == graveyard_vol:
                continue
            physical_triangles.update(vol_tris)
            if vol_tris:
                vol_grid = _build_vtk_grid_from_triangles(mb, list(vol_tris))
                if vol_grid:
                    physical_volume_grids.append(vol_grid)
        
        physical_grid = _build_vtk_grid_from_triangles(mb, list(physical_triangles))
        
        return full_grid, physical_grid, physical_volume_grids, vol_info
        
    except Exception as e:
        print(f"Warning: Could not identify volumes: {e}")
        return full_grid, full_grid, [full_grid], []


def create_tally_grid(statepoint_file: str, tally_id: int, pixelated: bool = False):
    """
    Create VTK structured grid from mesh tally.
    
    Args:
        statepoint_file: Path to statepoint
        tally_id: Tally ID
        pixelated: If True, keep cell data (blocky). If False, convert to point data (smooth).
    
    Returns:
        Tuple of (vtkStructuredGrid, tally_name, data_range)
    """
    if not HAS_OPENMC:
        raise RuntimeError("OpenMC is required")
    
    sp = openmc.StatePoint(statepoint_file)
    tally = sp.get_tally(id=tally_id)
    
    mesh_filter = None
    for f in tally.filters:
        if isinstance(f, openmc.MeshFilter):
            mesh_filter = f
            break
    
    if mesh_filter is None:
        raise ValueError(f"Tally {tally_id} does not have a MeshFilter")
    
    mesh = mesh_filter.mesh
    dims = mesh.dimension
    lower_left = np.array(mesh.lower_left)
    upper_right = np.array(mesh.upper_right)
    
    # Get tally data using OpenMC's ordering
    mean = tally.get_values(value='mean').flatten()
    std_dev = tally.get_values(value='std_dev').flatten()
    
    # Create structured grid
    grid = vtk.vtkStructuredGrid()
    grid.SetDimensions(dims[0] + 1, dims[1] + 1, dims[2] + 1)
    
    # Create points
    points = vtk.vtkPoints()
    x = np.linspace(lower_left[0], upper_right[0], dims[0] + 1)
    y = np.linspace(lower_left[1], upper_right[1], dims[1] + 1)
    z = np.linspace(lower_left[2], upper_right[2], dims[2] + 1)
    
    for k in range(dims[2] + 1):
        for j in range(dims[1] + 1):
            for i in range(dims[0] + 1):
                points.InsertNextPoint(x[i], y[j], z[k])
    
    grid.SetPoints(points)
    
    # Add cell data using OpenMC's flat ordering
    vtk_mean = vtk.vtkDoubleArray()
    vtk_mean.SetName("flux_mean")
    vtk_mean.SetNumberOfValues(dims[0] * dims[1] * dims[2])
    
    vtk_std = vtk.vtkDoubleArray()
    vtk_std.SetName("flux_std_dev")
    vtk_std.SetNumberOfValues(dims[0] * dims[1] * dims[2])
    
    # OpenMC uses x-major ordering: i + j*nx + k*nx*ny
    for k in range(dims[2]):
        for j in range(dims[1]):
            for i in range(dims[0]):
                idx = i + j * dims[0] + k * dims[0] * dims[1]
                vtk_mean.SetValue(idx, mean[idx])
                vtk_std.SetValue(idx, std_dev[idx])
    
    grid.GetCellData().AddArray(vtk_mean)
    grid.GetCellData().AddArray(vtk_std)
    grid.GetCellData().SetActiveScalars("flux_mean")
    
    data_range = (float(mean.min()), float(mean.max()))
    
    if pixelated:
        return grid, tally.name, data_range
    else:
        # Convert cell data to point data for smooth interpolation
        c2p = vtk.vtkCellDataToPointData()
        c2p.SetInputData(grid)
        c2p.Update()
        grid_smooth = c2p.GetOutput()
        grid_smooth.GetPointData().SetActiveScalars("flux_mean")
        return grid_smooth, tally.name, data_range


def create_heatmap_plane(tally_grid, plane: str, position: float, 
                         resolution: int = 200) -> vtk.vtkPolyData:
    """
    Create a 2D plane with interpolated tally values.
    
    Args:
        tally_grid: VTK structured grid with tally data
        plane: 'x', 'y', or 'z'
        position: Plane position in cm
        resolution: Plane resolution (default 200)
    
    Returns:
        vtkPolyData with probed tally values as point data
    """
    bounds = tally_grid.GetBounds()
    
    plane_source = vtk.vtkPlaneSource()
    
    if plane == 'z':
        x_min, x_max = bounds[0], bounds[1]
        y_min, y_max = bounds[2], bounds[3]
        plane_source.SetOrigin(x_min, y_min, position)
        plane_source.SetPoint1(x_max, y_min, position)
        plane_source.SetPoint2(x_min, y_max, position)
    elif plane == 'y':
        x_min, x_max = bounds[0], bounds[1]
        z_min, z_max = bounds[4], bounds[5]
        plane_source.SetOrigin(x_min, position, z_min)
        plane_source.SetPoint1(x_max, position, z_min)
        plane_source.SetPoint2(x_min, position, z_max)
    else:  # x
        y_min, y_max = bounds[2], bounds[3]
        z_min, z_max = bounds[4], bounds[5]
        plane_source.SetOrigin(position, y_min, z_min)
        plane_source.SetPoint1(position, y_max, z_min)
        plane_source.SetPoint2(position, y_min, z_max)
    
    plane_source.SetResolution(resolution, resolution)
    plane_source.Update()
    
    # Probe the tally grid with the plane
    probe = vtk.vtkProbeFilter()
    probe.SetInputConnection(plane_source.GetOutputPort())
    probe.SetSourceData(tally_grid)
    probe.Update()
    
    result = probe.GetOutput()
    
    # Set active scalars
    if result.GetPointData().GetArray("flux_mean"):
        result.GetPointData().SetActiveScalars("flux_mean")
    
    return result


def clip_heatmap_to_geometry(heatmap_plane, physical_volumes):
    """
    Clip heatmap plane to only keep points inside any physical volume.
    Uses a lenient threshold to keep cells where at least one point is inside.
    
    Args:
        heatmap_plane: vtkPolyData with probed values
        physical_volumes: List of vtkUnstructuredGrid volumes
    
    Returns:
        Clipped vtkPolyData
    """
    if not physical_volumes:
        return heatmap_plane
    
    combined_mask = None
    
    for vol_grid in physical_volumes:
        if vol_grid is None or vol_grid.GetNumberOfCells() == 0:
            continue
        
        # Convert to polydata for vtkSelectEnclosedPoints
        geom_filter = vtk.vtkGeometryFilter()
        geom_filter.SetInputData(vol_grid)
        geom_filter.Update()
        geometry_poly = geom_filter.GetOutput()
        
        enclosed = vtk.vtkSelectEnclosedPoints()
        enclosed.SetInputData(heatmap_plane)
        enclosed.SetSurfaceData(geometry_poly)
        enclosed.SetTolerance(0.0)
        enclosed.Update()
        
        result = enclosed.GetOutput()
        inside_arr = result.GetPointData().GetArray("SelectedPoints")
        if inside_arr is None:
            continue
        
        inside = vtk_to_numpy(inside_arr)
        
        if combined_mask is None:
            combined_mask = inside.astype(bool)
        else:
            combined_mask = combined_mask | inside.astype(bool)
    
    if combined_mask is None:
        return heatmap_plane
    
    # Count how many points are inside
    n_inside = int(combined_mask.sum())
    n_total = len(combined_mask)
    print(f"[Slice] {n_inside}/{n_total} points inside geometry ({100*n_inside/n_total:.1f}%)")
    
    if n_inside == 0:
        print("[Slice] Warning: No points inside geometry, returning unclipped heatmap")
        return heatmap_plane
    
    # Create mask array
    mask_array = vtk.vtkIntArray()
    mask_array.SetName("SelectedPoints")
    for val in combined_mask.astype(int):
        mask_array.InsertNextValue(val)
    
    heatmap_plane.GetPointData().AddArray(mask_array)
    
    # Point data to cell data for thresholding
    pt2cell = vtk.vtkPointDataToCellData()
    pt2cell.SetInputData(heatmap_plane)
    pt2cell.Update()
    
    # Threshold: keep cells where ANY point is inside (> 0 instead of >= 0.5)
    # This is more lenient and keeps cells on the boundary
    threshold = vtk.vtkThreshold()
    threshold.SetInputData(pt2cell.GetOutput())
    threshold.SetLowerThreshold(0.01)  # Very lenient: keep if any point is inside
    threshold.SetUpperThreshold(2.0)
    threshold.SetInputArrayToProcess(0, 0, 0, 
                                      vtk.vtkDataObject.FIELD_ASSOCIATION_CELLS, 
                                      "SelectedPoints")
    threshold.Update()
    
    # Check if threshold produced output
    thresh_output = threshold.GetOutput()
    if thresh_output.GetNumberOfCells() == 0:
        print("[Slice] Warning: Threshold removed all cells, returning unclipped heatmap")
        return heatmap_plane
    
    # Convert back to polydata
    geom_filter = vtk.vtkGeometryFilter()
    geom_filter.SetInputData(thresh_output)
    geom_filter.Update()
    
    clipped = geom_filter.GetOutput()
    
    if clipped.GetNumberOfPoints() == 0:
        print("[Slice] Warning: Clipped output is empty, returning unclipped heatmap")
        return heatmap_plane
    
    # Cell data back to point data for smooth rendering
    cell2pt = vtk.vtkCellDataToPointData()
    cell2pt.SetInputData(clipped)
    cell2pt.Update()
    clipped = cell2pt.GetOutput()
    
    # Set active scalars
    if clipped.GetPointData().GetArray("flux_mean"):
        clipped.GetPointData().SetActiveScalars("flux_mean")
    elif clipped.GetCellData().GetArray("flux_mean"):
        clipped.GetCellData().SetActiveScalars("flux_mean")
    
    print(f"[Slice] Clipped heatmap: {clipped.GetNumberOfPoints()} points, {clipped.GetNumberOfCells()} cells")
    return clipped


def create_geometry_slice(geometry_grid, plane: str, position: float) -> Optional[vtk.vtkPolyData]:
    """
    Create a slice through geometry at specified plane and position.
    
    Args:
        geometry_grid: VTK unstructured grid of geometry
        plane: 'x', 'y', or 'z'
        position: Slice position in cm
    
    Returns:
        vtkPolyData of sliced geometry outline, or None
    """
    if geometry_grid is None:
        return None
    
    normal = {
        'x': [1, 0, 0],
        'y': [0, 1, 0],
        'z': [0, 0, 1]
    }.get(plane, [0, 0, 1])
    
    plane_obj = vtk.vtkPlane()
    plane_obj.SetNormal(normal)
    plane_obj.SetOrigin(
        position if plane == 'x' else 0,
        position if plane == 'y' else 0,
        position if plane == 'z' else 0
    )
    
    cutter = vtk.vtkCutter()
    cutter.SetInputData(geometry_grid)
    cutter.SetCutFunction(plane_obj)
    cutter.Update()
    
    return cutter.GetOutput()


def write_polydata(polydata, filepath: str):
    """Write vtkPolyData to file."""
    if filepath.endswith('.vtp'):
        writer = vtk.vtkXMLPolyDataWriter()
    elif filepath.endswith('.vtk'):
        writer = vtk.vtkPolyDataWriter()
    else:
        # Default to XML PolyData format
        writer = vtk.vtkXMLPolyDataWriter()
        filepath = filepath + '.vtp'
    
    writer.SetFileName(filepath)
    writer.SetInputData(polydata)
    writer.Write()
    return filepath


def create_slice_visualization(
    statepoint_file: str,
    tally_id: int,
    geometry_file: Optional[str] = None,
    plane: str = 'z',
    position: Optional[float] = None,
    resolution: int = 200,
    pixelated: bool = False,
    show_geometry: bool = True,
    output_dir: Optional[str] = None
) -> SliceVisualizationResult:
    """
    Create a slice visualization of tally data on geometry.
    
    Args:
        statepoint_file: Path to statepoint file
        tally_id: Tally ID to visualize
        geometry_file: Path to geometry .h5m file (auto-detected if None)
        plane: Slice plane ('x', 'y', 'z')
        position: Slice position in cm (default: center of geometry bounds)
        resolution: Plane resolution (50, 100, 200, 400)
        pixelated: If True, use blocky cell data. If False, smooth interpolation.
        show_geometry: If True, overlay geometry slice outline
        output_dir: Directory for temp files
    
    Returns:
        SliceVisualizationResult with paths to generated VTK files
    """
    result = SliceVisualizationResult()
    result.plane = plane
    
    if output_dir is None:
        output_dir = os.path.dirname(statepoint_file)
    
    # Create tally grid
    tally_grid, tally_name, data_range = create_tally_grid(
        statepoint_file, tally_id, pixelated=pixelated
    )
    result.data_range = data_range
    
    # Determine slice position
    if position is None:
        bounds = tally_grid.GetBounds()
        axis_idx = {'x': 0, 'y': 2, 'z': 4}[plane]
        position = (bounds[axis_idx] + bounds[axis_idx + 1]) / 2
    
    result.position = position
    
    # Create heatmap plane
    heatmap = create_heatmap_plane(tally_grid, plane, position, resolution)
    
    # Try to load geometry and clip
    geometry_grid = None
    geometry_slice = None
    
    if geometry_file and os.path.exists(geometry_file):
        try:
            full_grid, physical_grid, physical_volumes, vol_info = load_dagmc_geometry(
                geometry_file, filter_graveyard=False
            )
            
            if physical_grid and physical_volumes:
                # Create geometry slice for wireframe outline (do NOT clip heatmap)
                # The reference implementation keeps the full plane; NaN values outside
                # the mesh are transparent in ParaView
                if show_geometry:
                    geometry_slice = create_geometry_slice(physical_grid, plane, position)
                
                result.geometry_found = True
                result.graveyard_filtered = False
            elif full_grid:
                if show_geometry:
                    geometry_slice = create_geometry_slice(full_grid, plane, position)
                result.geometry_found = True
                
        except Exception as e:
            print(f"Warning: Could not process geometry: {e}", file=sys.stderr)
    
    # Write output files
    suffix = f"_tally{tally_id}_{plane}{position:.2f}_res{resolution}"
    if pixelated:
        suffix += "_pixelated"
    
    heatmap_path = os.path.join(output_dir, f"slice_heatmap{suffix}.vtp")
    write_polydata(heatmap, heatmap_path)
    result.heatmap_vtk_path = heatmap_path
    
    if geometry_slice and geometry_slice.GetNumberOfPoints() > 0:
        geom_path = os.path.join(output_dir, f"slice_geometry{suffix}.vtp")
        write_polydata(geometry_slice, geom_path)
        result.geometry_slice_vtk_path = geom_path
    
    return result


def create_full_overlay(
    statepoint_file: str,
    tally_id: int,
    geometry_file: str,
    score: Optional[str] = None,
    nuclide: Optional[str] = None,
    filter_graveyard: bool = True,
    pixelated: bool = True,
    output_dir: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create full 3D geometry overlay (non-sliced) with cell-mapped tally data.
    This uses the old approach but with improved value mapping.
    
    Returns dict with:
        vtk_path: Path to mapped geometry VTU file
        data_range: Tuple of (min, max) values
        array_name: Name of the tally array
    """
    from plugins.openmc.lib.openmc_vtk import OpenMCVTKExporter
    
    exporter = OpenMCVTKExporter(statepoint_file)
    mesh_data = exporter.export_mesh_tally(tally_id, score=score, nuclide=nuclide)
    
    # Get raw data (not volume-normalized)
    raw_tally = exporter.get_tally(tally_id)
    raw_data = raw_tally.mean.flatten()
    mesh = raw_tally.filters[0].mesh
    
    # Build lookup using mesh.indices
    mesh_values = {}
    for flat_idx, (ix_1, iy_1, iz_1) in enumerate(mesh.indices):
        ix = ix_1 - 1
        iy = iy_1 - 1
        iz = iz_1 - 1
        if flat_idx < len(raw_data):
            mesh_values[(ix, iy, iz)] = float(raw_data[flat_idx])
    
    # Load geometry
    from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached
    result = convert_h5m_to_vtk_cached(geometry_file, use_cache=True,
                                       do_filter_graveyard=filter_graveyard)
    vtk_path = result['vtk_path']
    
    # Read geometry (legacy VTK format)
    reader = vtk.vtkDataSetReader()
    reader.SetFileName(vtk_path)
    reader.Update()
    geom_vtk = reader.GetOutput()
    
    # Map values to geometry cells
    nx, ny, nz = mesh_data.dimensions
    x_min, x_max = mesh_data.bounds['x']
    y_min, y_max = mesh_data.bounds['y']
    z_min, z_max = mesh_data.bounds['z']
    dx = (x_max - x_min) / nx
    dy = (y_max - y_min) / ny
    dz = (z_max - z_min) / nz
    
    geom_points = geom_vtk.GetPoints()
    n_cells = geom_vtk.GetNumberOfCells()
    n_points = geom_vtk.GetNumberOfPoints()
    
    if pixelated:
        # Cell-centered mapping (blocky/pixelated look)
        mapped_array = vtk.vtkDoubleArray()
        mapped_array.SetName(mesh_data.datasets[0])
        mapped_array.SetNumberOfValues(n_cells)
        
        for i in range(n_cells):
            cell = geom_vtk.GetCell(i)
            n_pts = cell.GetNumberOfPoints()
            center = [0.0, 0.0, 0.0]
            for j in range(n_pts):
                pt = geom_points.GetPoint(cell.GetPointId(j))
                center[0] += pt[0]
                center[1] += pt[1]
                center[2] += pt[2]
            center[0] /= n_pts
            center[1] /= n_pts
            center[2] /= n_pts
            
            ix = int((center[0] - x_min) / dx)
            iy = int((center[1] - y_min) / dy)
            iz = int((center[2] - z_min) / dz)
            ix = max(0, min(ix, nx - 1))
            iy = max(0, min(iy, ny - 1))
            iz = max(0, min(iz, nz - 1))
            
            val = mesh_values.get((ix, iy, iz), 0.0)
            mapped_array.SetValue(i, val)
        
        geom_vtk.GetCellData().AddArray(mapped_array)
        geom_vtk.GetCellData().SetActiveScalars(mesh_data.datasets[0])
    else:
        # Vertex-interpolated mapping (smooth look)
        # Build 3D value grid
        value_grid = np.zeros((nx, ny, nz))
        for (ix, iy, iz), val in mesh_values.items():
            if 0 <= ix < nx and 0 <= iy < ny and 0 <= iz < nz:
                value_grid[ix, iy, iz] = val
        
        # Create coordinate arrays for interpolation
        x_coords = np.linspace(x_min + dx/2, x_max - dx/2, nx)
        y_coords = np.linspace(y_min + dy/2, y_max - dy/2, ny)
        z_coords = np.linspace(z_min + dz/2, z_max - dz/2, nz)
        
        mapped_array = vtk.vtkDoubleArray()
        mapped_array.SetName(mesh_data.datasets[0])
        mapped_array.SetNumberOfValues(n_points)
        
        for i in range(n_points):
            pt = geom_points.GetPoint(i)
            x, y, z = pt[0], pt[1], pt[2]
            
            # Trilinear interpolation
            # Find surrounding mesh cell indices
            ix0 = int((x - x_min) / dx)
            iy0 = int((y - y_min) / dy)
            iz0 = int((z - z_min) / dz)
            
            ix0 = max(0, min(ix0, nx - 1))
            iy0 = max(0, min(iy0, ny - 1))
            iz0 = max(0, min(iz0, nz - 1))
            
            ix1 = min(ix0 + 1, nx - 1)
            iy1 = min(iy0 + 1, ny - 1)
            iz1 = min(iz0 + 1, nz - 1)
            
            # Compute interpolation weights
            tx = ((x - x_min) / dx) - ix0
            ty = ((y - y_min) / dy) - iy0
            tz = ((z - z_min) / dz) - iz0
            
            tx = max(0.0, min(1.0, tx))
            ty = max(0.0, min(1.0, ty))
            tz = max(0.0, min(1.0, tz))
            
            # Sample 8 corner values
            c000 = value_grid[ix0, iy0, iz0]
            c001 = value_grid[ix0, iy0, iz1]
            c010 = value_grid[ix0, iy1, iz0]
            c011 = value_grid[ix0, iy1, iz1]
            c100 = value_grid[ix1, iy0, iz0]
            c101 = value_grid[ix1, iy0, iz1]
            c110 = value_grid[ix1, iy1, iz0]
            c111 = value_grid[ix1, iy1, iz1]
            
            # Trilinear interpolation
            val = (
                c000 * (1-tx) * (1-ty) * (1-tz) +
                c001 * (1-tx) * (1-ty) * tz +
                c010 * (1-tx) * ty * (1-tz) +
                c011 * (1-tx) * ty * tz +
                c100 * tx * (1-ty) * (1-tz) +
                c101 * tx * (1-ty) * tz +
                c110 * tx * ty * (1-tz) +
                c111 * tx * ty * tz
            )
            
            mapped_array.SetValue(i, float(val))
        
        geom_vtk.GetPointData().AddArray(mapped_array)
        geom_vtk.GetPointData().SetActiveScalars(mesh_data.datasets[0])
    
    # Write mapped geometry
    if output_dir is None:
        output_dir = os.path.dirname(statepoint_file)
    
    mapped_path = os.path.join(output_dir, f"overlay_tally{tally_id}.vtu")
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(mapped_path)
    writer.SetInputData(geom_vtk)
    writer.Write()
    
    return {
        'vtk_path': mapped_path,
        'data_range': (float(min(mesh_values.values())), float(max(mesh_values.values()))),
        'array_name': mesh_data.datasets[0]
    }


def get_geometry_bounds(geometry_file: str) -> Optional[Dict[str, Tuple[float, float]]]:
    """Get geometry bounds from DAGMC file.
    
    Returns dict with x, y, z ranges, or None if file not found.
    """
    if not geometry_file or not os.path.exists(geometry_file):
        return None
    
    try:
        full_grid, physical_grid, physical_volumes, vol_info = load_dagmc_geometry(
            geometry_file, filter_graveyard=False
        )
        
        grid = physical_grid or full_grid
        if grid is None:
            return None
            
        bounds = grid.GetBounds()
        return {
            'x': (bounds[0], bounds[1]),
            'y': (bounds[2], bounds[3]),
            'z': (bounds[4], bounds[5])
        }
    except Exception as e:
        print(f"Warning: Could not get geometry bounds: {e}", file=sys.stderr)
        return None
