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
from typing import Any

import numpy as np

# Patch numpy for VTK compatibility
if not hasattr(np, "in1d"):
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
        self.heatmap_vtk_path: str | None = None
        self.geometry_slice_vtk_path: str | None = None
        self.combined_vtk_path: str | None = None
        self.data_range: tuple[float, float] = (0.0, 0.0)
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


def load_dagmc_geometry(filename: str, filter_graveyard: bool | None = None):
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
        geom_dim_tag = mb.tag_get_handle(
            "GEOM_DIMENSION",
            size=1,
            tag_type=mbtypes.MB_TYPE_INTEGER,
            storage_type=mbtypes.MB_TAG_SPARSE,
            create_if_missing=False,
        )
        category_tag = mb.tag_get_handle(
            "CATEGORY",
            size=32,
            tag_type=mbtypes.MB_TYPE_OPAQUE,
            storage_type=mbtypes.MB_TAG_SPARSE,
            create_if_missing=False,
        )
        id_tag = mb.tag_get_handle(
            "GLOBAL_ID",
            size=1,
            tag_type=mbtypes.MB_TYPE_INTEGER,
            storage_type=mbtypes.MB_TAG_SPARSE,
            create_if_missing=False,
        )

        volumes = mb.get_entities_by_type_and_tag(
            root_set, mbtypes.MBENTITYSET, [category_tag], [b"Volume"]
        )

        vol_info = []
        graveyard_vol = None
        max_volume = -1

        for vol in volumes:
            try:
                vol_id = mb.tag_get_data(id_tag, [vol])[0][0]
            except Exception:
                continue

            children = mb.get_child_meshsets(vol)
            vol_tris = set()
            for child in children:
                try:
                    child_dim = mb.tag_get_data(geom_dim_tag, [child])[0][0]
                    if child_dim == 2:
                        child_tris = mb.get_entities_by_type(child, tri_type)
                        vol_tris.update(child_tris)
                except Exception:
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

        for vol_id, _vol_size, vol_tris in vol_info:
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
    mean = tally.get_values(value="mean").flatten()
    std_dev = tally.get_values(value="std_dev").flatten()

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


def create_heatmap_plane(
    tally_grid, plane: str, position: float, resolution: int = 200
) -> vtk.vtkPolyData:
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

    if plane == "z":
        x_min, x_max = bounds[0], bounds[1]
        y_min, y_max = bounds[2], bounds[3]
        plane_source.SetOrigin(x_min, y_min, position)
        plane_source.SetPoint1(x_max, y_min, position)
        plane_source.SetPoint2(x_min, y_max, position)
    elif plane == "y":
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
    print(f"[Slice] {n_inside}/{n_total} points inside geometry ({100 * n_inside / n_total:.1f}%)")

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
    threshold.SetInputArrayToProcess(
        0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_CELLS, "SelectedPoints"
    )
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

    print(
        f"[Slice] Clipped heatmap: {clipped.GetNumberOfPoints()} points, {clipped.GetNumberOfCells()} cells"
    )
    return clipped


def create_geometry_slice(geometry_grid, plane: str, position: float) -> vtk.vtkPolyData | None:
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

    normal = {"x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}.get(plane, [0, 0, 1])

    plane_obj = vtk.vtkPlane()
    plane_obj.SetNormal(normal)
    plane_obj.SetOrigin(
        position if plane == "x" else 0,
        position if plane == "y" else 0,
        position if plane == "z" else 0,
    )

    cutter = vtk.vtkCutter()
    cutter.SetInputData(geometry_grid)
    cutter.SetCutFunction(plane_obj)
    cutter.Update()

    return cutter.GetOutput()


def write_polydata(polydata, filepath: str):
    """Write vtkPolyData to file."""
    if filepath.endswith(".vtp"):
        writer = vtk.vtkXMLPolyDataWriter()
    elif filepath.endswith(".vtk"):
        writer = vtk.vtkPolyDataWriter()
    else:
        # Default to XML PolyData format
        writer = vtk.vtkXMLPolyDataWriter()
        filepath = filepath + ".vtp"

    writer.SetFileName(filepath)
    writer.SetInputData(polydata)
    writer.Write()
    return filepath


def create_slice_visualization(
    statepoint_file: str,
    tally_id: int,
    geometry_file: str | None = None,
    plane: str = "z",
    position: float | None = None,
    resolution: int = 200,
    pixelated: bool = False,
    show_geometry: bool = True,
    output_dir: str | None = None,
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
        axis_idx = {"x": 0, "y": 2, "z": 4}[plane]
        position = (bounds[axis_idx] + bounds[axis_idx + 1]) / 2

    result.position = position

    # Create heatmap plane
    heatmap = create_heatmap_plane(tally_grid, plane, position, resolution)

    # Try to load geometry and clip
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
    score: str | None = None,
    nuclide: str | None = None,
    filter_graveyard: bool = True,
    pixelated: bool = True,
    output_dir: str | None = None,
) -> dict[str, Any]:
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

    result = convert_h5m_to_vtk_cached(
        geometry_file, use_cache=True, do_filter_graveyard=filter_graveyard
    )
    vtk_path = result["vtk_path"]

    # Read geometry (legacy VTK format)
    reader = vtk.vtkDataSetReader()
    reader.SetFileName(vtk_path)
    reader.Update()
    geom_vtk = reader.GetOutput()

    # Map values to geometry cells
    nx, ny, nz = mesh_data.dimensions
    x_min, x_max = mesh_data.bounds["x"]
    y_min, y_max = mesh_data.bounds["y"]
    z_min, z_max = mesh_data.bounds["z"]
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
                c000 * (1 - tx) * (1 - ty) * (1 - tz)
                + c001 * (1 - tx) * (1 - ty) * tz
                + c010 * (1 - tx) * ty * (1 - tz)
                + c011 * (1 - tx) * ty * tz
                + c100 * tx * (1 - ty) * (1 - tz)
                + c101 * tx * (1 - ty) * tz
                + c110 * tx * ty * (1 - tz)
                + c111 * tx * ty * tz
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
        "vtk_path": mapped_path,
        "data_range": (float(min(mesh_values.values())), float(max(mesh_values.values()))),
        "array_name": mesh_data.datasets[0],
    }


def get_geometry_bounds(geometry_file: str) -> dict[str, tuple[float, float]] | None:
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
            "x": (bounds[0], bounds[1]),
            "y": (bounds[2], bounds[3]),
            "z": (bounds[4], bounds[5]),
        }
    except Exception as e:
        print(f"Warning: Could not get geometry bounds: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Static slice extractors (trame-to-frontend migration, P3-D1).
#
# These functions produce plain .vtp files for heatmap/geometry-slice use
# cases WITHOUT starting a server (replacing the tallySliceView server
# need). Grid construction and value sampling are numpy-only (unit-testable
# without vtk); ``vtk`` is imported lazily inside _load_slice_vtk only for
# the final file write, mirroring the output_vtk.py writer path. Existing
# behavior above is unchanged.
#
# Errors raise StaticSliceError (OutputReaderError-compatible: a single
# message string; command wrappers convert these to the single-JSON-object
# contract).
# ---------------------------------------------------------------------------


class StaticSliceError(Exception):
    """Raised for all static-slice extractor failures (bad input, missing
    file, missing optional dependency, empty result)."""


_SLICE_PLANES = ("x", "y", "z")
_MAX_SLICE_RESOLUTION = 1024


def _require_slice_plane(plane) -> str:
    """Validate a slice plane name.

    Input: ``plane`` (``"x"``, ``"y"`` or ``"z"``, case-insensitive).
    Output: the lowercased plane. Raises :class:`StaticSliceError` for
    anything else.
    """
    if isinstance(plane, str) and plane.lower() in _SLICE_PLANES:
        return plane.lower()
    raise StaticSliceError(f"plane must be one of {list(_SLICE_PLANES)}, got {plane!r}")


def _require_slice_resolution(value) -> int:
    """Validate a slice plane resolution.

    Input: ``value`` (grid points per in-plane axis, 1-1024). Output: the
    value as an ``int``. Raises :class:`StaticSliceError` for non-integer
    or out-of-range values.
    """
    if isinstance(value, bool):
        raise StaticSliceError(f"resolution must be a positive integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise StaticSliceError(f"resolution must be a positive integer, got {value!r}") from None
    if isinstance(value, float) and value != number:
        raise StaticSliceError(f"resolution must be a positive integer, got {value!r}")
    if number < 1 or number > _MAX_SLICE_RESOLUTION:
        raise StaticSliceError(
            f"resolution must be between 1 and {_MAX_SLICE_RESOLUTION}, got {value!r}"
        )
    return number


def _require_slice_position(value) -> float:
    """Validate a slice position in cm.

    Input: ``value`` (finite number). Output: the value as a ``float``.
    Raises :class:`StaticSliceError` for non-numeric or non-finite values.
    """
    if isinstance(value, bool):
        raise StaticSliceError(f"position must be a number, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise StaticSliceError(f"position must be a number, got {value!r}") from None
    if not np.isfinite(number):
        raise StaticSliceError(f"position must be finite, got {value!r}")
    return number


def _require_box_bounds(bounds) -> dict:
    """Validate an axis-aligned bounding box dict.

    Input: ``bounds`` (dict with ``xmin``/``xmax``/``ymin``/``ymax``/
    ``zmin``/``zmax`` finite numbers, min < max per axis). Output: the
    bounds as 6 floats. Raises :class:`StaticSliceError` otherwise.
    """
    if not isinstance(bounds, dict):
        raise StaticSliceError(f"bounds must be a dict, got {type(bounds).__name__}")
    required = ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")
    for key in required:
        if key not in bounds:
            raise StaticSliceError(f"bounds is missing {key!r}")
    try:
        values = {key: float(bounds[key]) for key in required}
    except (TypeError, ValueError):
        raise StaticSliceError("bounds values must be numeric") from None
    for key in required:
        if not np.isfinite(values[key]):
            raise StaticSliceError(f"bounds {key!r} must be finite, got {bounds[key]!r}")
    for lo, hi in (("xmin", "xmax"), ("ymin", "ymax"), ("zmin", "zmax")):
        if not values[lo] < values[hi]:
            raise StaticSliceError(f"bounds require {lo} < {hi}, got {values[lo]} >= {values[hi]}")
    return values


def _require_points_array(points):
    """Validate a point cloud array.

    Input: ``points`` (array-like with shape ``(N, 3)``, N > 0, all
    finite). Output: the points as a float ``(N, 3)`` array. Raises
    :class:`StaticSliceError` otherwise.
    """
    try:
        array = np.asarray(points, dtype=float)
    except (TypeError, ValueError):
        raise StaticSliceError("points must be numeric with shape (N, 3)") from None
    if array.ndim != 2 or array.shape[1] != 3 or array.shape[0] == 0:
        raise StaticSliceError(f"points must have shape (N, 3) with N > 0, got {array.shape}")
    if not np.all(np.isfinite(array)):
        raise StaticSliceError("points must all be finite")
    return array


def _require_array_name(name) -> str:
    """Validate a VTK data-array name.

    Input: ``name`` (non-empty string). Output: the name. Raises
    :class:`StaticSliceError` otherwise.
    """
    if not isinstance(name, str) or not name.strip():
        raise StaticSliceError(f"array_name must be a non-empty string, got {name!r}")
    return name


def _slice_default_output_path(stem: str, suffix: str = ".vtp") -> str:
    """Default output path: a fresh temp dir with a file named after a stem.

    Inputs: ``stem`` (base file name), ``suffix`` (e.g. ``".vtp"``).
    Output: absolute path string. Raises :class:`StaticSliceError` for an
    empty/invalid stem. Mirrors output_vtk._default_output_path.
    """
    import os
    import tempfile

    if not stem or not isinstance(stem, (str, os.PathLike)):
        raise StaticSliceError(f"invalid output stem: {stem!r}")
    base = os.path.basename(os.fspath(stem).rstrip("/"))
    name = os.path.splitext(base)[0].replace(".", "_") or "slice"
    out_dir = tempfile.mkdtemp(prefix="nuke-openmc-slice-")
    return os.path.join(out_dir, f"{name}{suffix}")


def _load_slice_vtk():
    """Lazily import ``vtk`` and return the module.

    Raises :class:`StaticSliceError` when vtk is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    try:
        import vtk
    except ImportError as exc:
        raise StaticSliceError(f"vtk not installed (required for slice export): {exc}") from None
    if vtk is None:
        raise StaticSliceError("vtk not installed (required for slice export)")
    return vtk


def build_slice_grid(
    bounds: dict, plane: str = "z", position: float | None = None, resolution: int = 200
) -> dict:
    """Build a regular sampling grid on a slice plane (numpy only).

    Inputs: ``bounds`` (6-float bounds dict, see :func:`_require_box_bounds`),
    ``plane`` (``"x"``/``"y"``/``"z"``), ``position`` (plane offset in cm
    along the plane normal; default: the bounds center), ``resolution``
    (points per in-plane axis).
    Output: dict with ``plane``, ``position``, ``resolution``,
    ``dims`` ([nu, nv] point counts), ``origin``/``uAxis``/``vAxis``
    (plain lists), ``uRange``/``vRange`` and ``points`` (float ``(M, 3)``
    numpy array, row-major over the (u, v) grid). Raises
    :class:`StaticSliceError` on bad input. Pure numpy — no vtk required.
    """
    box = _require_box_bounds(bounds)
    plane = _require_slice_plane(plane)
    resolution = _require_slice_resolution(resolution)

    axis_index = {"x": 0, "y": 1, "z": 2}[plane]
    lo_key, hi_key = (
        ("xmin", "xmax")
        if plane == "x"
        else (("ymin", "ymax") if plane == "y" else ("zmin", "zmax"))
    )
    if position is None:
        position = (box[lo_key] + box[hi_key]) / 2
    position = _require_slice_position(position)

    in_plane = {"x": ("y", "z"), "y": ("x", "z"), "z": ("x", "y")}[plane]
    u_lo, u_hi = box[f"{in_plane[0]}min"], box[f"{in_plane[0]}max"]
    v_lo, v_hi = box[f"{in_plane[1]}min"], box[f"{in_plane[1]}max"]
    u = np.linspace(u_lo, u_hi, resolution + 1)
    v = np.linspace(v_lo, v_hi, resolution + 1)
    uu, vv = np.meshgrid(u, v, indexing="xy")

    points = np.zeros((uu.size, 3))
    normal_pos = np.full(uu.size, position)
    if plane == "x":
        points[:, 0] = normal_pos
        points[:, 1] = uu.ravel()
        points[:, 2] = vv.ravel()
    elif plane == "y":
        points[:, 0] = uu.ravel()
        points[:, 1] = normal_pos
        points[:, 2] = vv.ravel()
    else:
        points[:, 0] = uu.ravel()
        points[:, 1] = vv.ravel()
        points[:, 2] = normal_pos

    origin = [0.0, 0.0, 0.0]
    origin[axis_index] = position
    origin[(axis_index + 1) % 3] = u_lo
    origin[(axis_index + 2) % 3] = v_lo
    u_axis = [0.0, 0.0, 0.0]
    u_axis[(axis_index + 1) % 3] = 1.0
    v_axis = [0.0, 0.0, 0.0]
    v_axis[(axis_index + 2) % 3] = 1.0

    return {
        "plane": plane,
        "position": position,
        "resolution": resolution,
        "dims": [resolution + 1, resolution + 1],
        "origin": origin,
        "uAxis": u_axis,
        "vAxis": v_axis,
        "uRange": [float(u_lo), float(u_hi)],
        "vRange": [float(v_lo), float(v_hi)],
        "points": points,
    }


def sample_structured_values(values, lower_left, upper_right, points):
    """Trilinear-sample a cell-centered structured grid (numpy only).

    Inputs: ``values`` (``(nx, ny, nz)`` array of cell means),
    ``lower_left``/``upper_right`` (3-vectors in cm), ``points``
    (``(M, 3)`` sample locations). Output: float ``(M,)`` sampled values
    (coordinates outside the grid clamp to the edge cells). Raises
    :class:`StaticSliceError` on shape mismatches or empty grids. Pure
    numpy — no vtk/openmc required.
    """
    try:
        grid = np.asarray(values, dtype=float)
    except (TypeError, ValueError):
        raise StaticSliceError("values must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise StaticSliceError(f"values must have shape (nx, ny, nz), got {grid.shape}")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise StaticSliceError("lower_left/upper_right must each hold 3 numbers") from None
    if np.any(~np.isfinite(lo)) or np.any(~np.isfinite(hi)) or np.any(hi <= lo):
        raise StaticSliceError("lower_left/upper_right must be finite with lower < upper")
    pts = _require_points_array(points)

    nx, ny, nz = grid.shape
    spacing = (hi - lo) / np.array([nx, ny, nz], dtype=float)
    # Cell-centered coordinates: continuous index of the lower corner sample.
    frac = (pts - lo) / spacing - 0.5
    frac[:, 0] = np.clip(frac[:, 0], 0.0, nx - 1.0)
    frac[:, 1] = np.clip(frac[:, 1], 0.0, ny - 1.0)
    frac[:, 2] = np.clip(frac[:, 2], 0.0, nz - 1.0)
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
    return (
        c000 * (1 - tx) * (1 - ty) * (1 - tz)
        + c001 * (1 - tx) * (1 - ty) * tz
        + c010 * (1 - tx) * ty * (1 - tz)
        + c011 * (1 - tx) * ty * tz
        + c100 * tx * (1 - ty) * (1 - tz)
        + c101 * tx * (1 - ty) * tz
        + c110 * tx * ty * (1 - tz)
        + c111 * tx * ty * tz
    )


def write_slice_vtp(points, values, array_name: str, output_path: str | None = None) -> str:
    """Write sampled slice points as a .vtp vertex cloud (lazy vtk).

    Inputs: ``points`` (``(N, 3)`` array), ``values`` (``(N,)`` array),
    ``array_name`` (point-data array name), ``output_path`` (.vtp
    destination, default: temp file). Output: the path string. Raises
    :class:`StaticSliceError` on bad input, length mismatches, or missing
    vtk. Validators run before the vtk gate.
    """
    import os

    pts = _require_points_array(points)
    name = _require_array_name(array_name)
    try:
        vals = np.asarray(values, dtype=float).ravel()
    except (TypeError, ValueError):
        raise StaticSliceError("values must be numeric with one entry per point") from None
    if vals.shape[0] != pts.shape[0]:
        raise StaticSliceError(
            f"values has length {vals.shape[0]}, expected {pts.shape[0]} (one value per point)"
        )
    if not np.all(np.isfinite(vals)):
        raise StaticSliceError("values must all be finite")

    vtk = _load_slice_vtk()

    vtk_points = vtk.vtkPoints()
    for point in pts:
        vtk_points.InsertNextPoint(float(point[0]), float(point[1]), float(point[2]))

    vtk_values = vtk.vtkDoubleArray()
    vtk_values.SetName(name)
    for value in vals:
        vtk_values.InsertNextValue(float(value))

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    verts = vtk.vtkCellArray()
    for i in range(pts.shape[0]):
        verts.InsertNextCell(1)
        verts.InsertCellPoint(int(i))
    polydata.SetVerts(verts)
    polydata.GetPointData().AddArray(vtk_values)
    polydata.GetPointData().SetActiveScalars(name)

    if output_path is None:
        output_path = _slice_default_output_path(f"slice_{name}")
    elif not isinstance(output_path, (str, os.PathLike)):
        raise StaticSliceError(f"invalid output path: {output_path!r}")
    output_path = os.fspath(output_path)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path


def extract_regular_slice(
    values_3d,
    lower_left,
    upper_right,
    plane: str = "z",
    position: float | None = None,
    array_name: str = "flux_mean",
    resolution: int = 200,
    output_path: str | None = None,
) -> dict:
    """Build, sample and write a static heatmap slice (no server).

    Inputs: ``values_3d`` (``(nx, ny, nz)`` cell means),
    ``lower_left``/``upper_right`` (grid corners in cm), ``plane``,
    ``position`` (default: grid center), ``array_name``, ``resolution``,
    ``output_path`` (default: temp file). Output: JSON-safe dict with
    ``vtkPath``, ``arrayName``, ``plane``, ``position``, ``resolution``,
    ``nPoints`` and ``dataRange``. Raises :class:`StaticSliceError` on bad
    input or missing vtk.
    """
    name = _require_array_name(array_name)
    resolution = _require_slice_resolution(resolution)
    try:
        grid = np.asarray(values_3d, dtype=float)
    except (TypeError, ValueError):
        raise StaticSliceError("values_3d must be a numeric 3D array") from None
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise StaticSliceError(f"values_3d must have shape (nx, ny, nz), got {grid.shape}")
    try:
        lo = np.asarray(lower_left, dtype=float).reshape(3)
        hi = np.asarray(upper_right, dtype=float).reshape(3)
    except (TypeError, ValueError):
        raise StaticSliceError("lower_left/upper_right must each hold 3 numbers") from None

    bounds = {
        "xmin": float(lo[0]),
        "xmax": float(hi[0]),
        "ymin": float(lo[1]),
        "ymax": float(hi[1]),
        "zmin": float(lo[2]),
        "zmax": float(hi[2]),
    }
    grid_info = build_slice_grid(bounds, plane=plane, position=position, resolution=resolution)
    sampled = sample_structured_values(grid, lo, hi, grid_info["points"])
    vtk_path = write_slice_vtp(grid_info["points"], sampled, name, output_path)
    return {
        "vtkPath": vtk_path,
        "arrayName": name,
        "plane": grid_info["plane"],
        "position": grid_info["position"],
        "resolution": grid_info["resolution"],
        "nPoints": int(sampled.shape[0]),
        "dataRange": [float(np.min(sampled)), float(np.max(sampled))],
    }


def extract_geometry_section(cells: list, plane: str = "z", position: float | None = None) -> dict:
    """Intersect cell bounding boxes with a plane (numpy only, no server).

    Inputs: ``cells`` (list of ``{"cellId": int, "bounds": {...}}`` — ``"id"``
    is accepted as an alias for ``"cellId"``; bounds validated per
    :func:`_require_box_bounds`), ``plane``, ``position`` (default: union
    center of all cell boxes). Output: JSON-safe dict with ``plane``,
    ``position``, ``cells`` (one entry per intersecting cell: ``cellId``
    plus 4 ``corners`` in cm) and ``nSections``. Raises
    :class:`StaticSliceError` for an empty cell list or bad input. Pure
    numpy — no vtk required.
    """
    plane = _require_slice_plane(plane)
    if not isinstance(cells, (list, tuple)) or len(cells) == 0:
        raise StaticSliceError("cells must be a non-empty list of cell bounding boxes")

    entries = []
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict):
            raise StaticSliceError(f"cell {index} must be a dict with 'cellId' and 'bounds'")
        cell_id = cell.get("cellId", cell.get("id"))
        if isinstance(cell_id, bool):
            raise StaticSliceError(f"cell {index} has a non-integer cellId: {cell_id!r}")
        try:
            cell_id = int(cell_id)
        except (TypeError, ValueError):
            raise StaticSliceError(f"cell {index} has a non-integer cellId: {cell_id!r}") from None
        if "bounds" not in cell:
            raise StaticSliceError(f"cell {index} is missing 'bounds'")
        entries.append({"cellId": cell_id, "bounds": _require_box_bounds(cell["bounds"])})

    axis = {"x": ("xmin", "xmax"), "y": ("ymin", "ymax"), "z": ("zmin", "zmax")}[plane]
    if position is None:
        lo = min(entry["bounds"][axis[0]] for entry in entries)
        hi = max(entry["bounds"][axis[1]] for entry in entries)
        position = (lo + hi) / 2
    position = _require_slice_position(position)

    sections = []
    for entry in entries:
        box = entry["bounds"]
        if not box[axis[0]] <= position <= box[axis[1]]:
            continue
        if plane == "x":
            corners = [
                [position, box["ymin"], box["zmin"]],
                [position, box["ymax"], box["zmin"]],
                [position, box["ymax"], box["zmax"]],
                [position, box["ymin"], box["zmax"]],
            ]
        elif plane == "y":
            corners = [
                [box["xmin"], position, box["zmin"]],
                [box["xmax"], position, box["zmin"]],
                [box["xmax"], position, box["zmax"]],
                [box["xmin"], position, box["zmax"]],
            ]
        else:
            corners = [
                [box["xmin"], box["ymin"], position],
                [box["xmax"], box["ymin"], position],
                [box["xmax"], box["ymax"], position],
                [box["xmin"], box["ymax"], position],
            ]
        sections.append({"cellId": entry["cellId"], "corners": corners})

    return {
        "plane": plane,
        "position": position,
        "cells": sections,
        "nCells": len(entries),
        "nSections": len(sections),
    }


def write_section_vtp(section: dict, output_path: str | None = None) -> str:
    """Write a geometry section as closed-rectangle polylines (lazy vtk).

    Inputs: ``section`` (an :func:`extract_geometry_section` dict),
    ``output_path`` (.vtp destination, default: temp file). Each section
    becomes one closed 4-corner polyline with a ``cell_id`` cell-data
    array. Output: the path string. Raises :class:`StaticSliceError` for a
    malformed section, an empty section, or missing vtk. Validators run
    before the vtk gate.
    """
    import os

    if not isinstance(section, dict) or not isinstance(section.get("cells"), (list, tuple)):
        raise StaticSliceError("section must be an extract_geometry_section dict")
    cells = section["cells"]
    if len(cells) == 0:
        raise StaticSliceError("section has no intersecting cells — nothing to visualize")
    points = []
    line_lengths = []
    cell_ids = []
    for index, entry in enumerate(cells):
        if not isinstance(entry, dict) or "corners" not in entry or "cellId" not in entry:
            raise StaticSliceError(f"section cell {index} is missing 'cellId'/'corners'")
        try:
            corners = np.asarray(entry["corners"], dtype=float)
        except (TypeError, ValueError):
            raise StaticSliceError(f"section cell {index} has non-numeric corners") from None
        if corners.shape != (4, 3):
            raise StaticSliceError(
                f"section cell {index} corners must have shape (4, 3), got {corners.shape}"
            )
        if not np.all(np.isfinite(corners)):
            raise StaticSliceError(f"section cell {index} corners must all be finite")
        # Closed loop: repeat the first corner.
        points.append(np.vstack([corners, corners[0:1]]))
        line_lengths.append(5)
        try:
            cell_ids.append(int(entry["cellId"]))
        except (TypeError, ValueError):
            raise StaticSliceError(
                f"section cell {index} has a non-integer cellId: {entry['cellId']!r}"
            ) from None

    vtk = _load_slice_vtk()

    all_points = np.vstack(points)
    vtk_points = vtk.vtkPoints()
    for point in all_points:
        vtk_points.InsertNextPoint(float(point[0]), float(point[1]), float(point[2]))

    lines = vtk.vtkCellArray()
    offset = 0
    for length in line_lengths:
        line = vtk.vtkPolyLine()
        line.GetPointIds().SetNumberOfIds(int(length))
        for i in range(int(length)):
            line.GetPointIds().SetId(i, offset + i)
        lines.InsertNextCell(line)
        offset += int(length)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(vtk_points)
    polydata.SetLines(lines)

    vtk_cell_ids = vtk.vtkIntArray()
    vtk_cell_ids.SetName("cell_id")
    vtk_cell_ids.SetNumberOfValues(len(cell_ids))
    for i, cell_id in enumerate(cell_ids):
        vtk_cell_ids.SetValue(i, cell_id)
    polydata.GetCellData().AddArray(vtk_cell_ids)

    if output_path is None:
        output_path = _slice_default_output_path("geometry_section")
    elif not isinstance(output_path, (str, os.PathLike)):
        raise StaticSliceError(f"invalid output path: {output_path!r}")
    output_path = os.fspath(output_path)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.Write()
    return output_path
