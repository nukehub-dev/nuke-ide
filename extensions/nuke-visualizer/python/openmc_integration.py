#!/usr/bin/env python3
"""
OpenMC integration for NukeIDE Visualizer.
Supports loading geometry, tallies, and source distributions.

Reference: https://docs.openmc.org/
"""

import h5py
import numpy as np
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
from paraview import simple
import vtk
from vtk.util import numpy_support


@dataclass
class OpenMCTally:
    """Represents an OpenMC tally result"""
    id: int
    name: str
    scores: List[str]
    nuclides: List[str]
    filters: List[Dict[str, Any]]
    mean: np.ndarray
    std_dev: np.ndarray
    has_mesh: bool = False
    mesh_info: Optional[Dict] = None


@dataclass
class OpenMCSourceParticle:
    """Represents a source particle from source.h5"""
    position: Tuple[float, float, float]
    direction: Tuple[float, float, float]
    energy: float
    time: float
    weight: float


class OpenMCReader:
    """Reader for OpenMC output files"""
    
    def load_geometry(self, h5m_path: str):
        """
        Load OpenMC geometry (DAGMC format).
        
        Args:
            h5m_path: Path to DAGMC .h5m file
            
        Returns:
            ParaView source object
        """
        from dagmc_converter import convert_h5m_to_vtk
        vtk_path = convert_h5m_to_vtk(h5m_path)
        return simple.OpenDataFile(vtk_path)
    
    def load_statepoint(self, statepoint_file: str) -> Dict:
        """
        Load OpenMC statepoint file and return summary info.
        
        Args:
            statepoint_file: Path to statepoint.h5
            
        Returns:
            Dictionary with simulation summary information
        """
        with h5py.File(statepoint_file, 'r') as f:
            info = {
                'file': statepoint_file,
                'batches': int(f['current_batch'][()]),
                'generations_per_batch': int(f['n_realizations'][()]) if 'n_realizations' in f else 1,
            }
            
            # Get k-effective if available
            if 'k_combined' in f:
                k_eff = f['k_combined'][...]
                info['k_eff'] = float(k_eff[0])
                info['k_eff_std'] = float(k_eff[1])
            elif 'k_generation' in f:
                k_gen = f['k_generation'][...]
                info['k_eff'] = float(np.mean(k_gen))
                info['k_eff_std'] = float(np.std(k_gen))
            
            # Count tallies
            if 'tallies' in f:
                tallies_group = f['tallies']
                tally_ids = [int(key.split()[-1]) for key in tallies_group.keys() 
                            if key.startswith('tally ')]
                info['n_tallies'] = len(tally_ids)
                info['tally_ids'] = tally_ids
            else:
                info['n_tallies'] = 0
                info['tally_ids'] = []
            
            return info
    
    def list_tallies(self, statepoint_file: str) -> List[Dict]:
        """
        List all tallies in a statepoint file.
        
        Args:
            statepoint_file: Path to statepoint.h5
            
        Returns:
            List of tally metadata dictionaries
        """
        tallies = []
        
        with h5py.File(statepoint_file, 'r') as f:
            if 'tallies' not in f:
                return tallies
            
            tally_group = f['tallies']
            
            for key in tally_group.keys():
                if not key.startswith('tally '):
                    continue
                
                tally_id = int(key.split()[-1])
                tally = tally_group[key]
                
                # Get name and handle bytes
                name = tally.attrs.get('name', f'Tally {tally_id}')
                if isinstance(name, bytes):
                    name = name.decode('utf-8')
                
                # Get basic info
                tally_info = {
                    'id': tally_id,
                    'name': name,
                    'scores': [],
                    'nuclides': [],
                    'filters': [],
                    'has_mesh': False
                }
                
                # Get scores (Handle Dataset vs Attribute representation)
                if 'score' in tally:
                    val = tally['score'][()]
                    if isinstance(val, np.ndarray):
                        val = [val[()]] if val.ndim == 0 else val.tolist()
                    elif isinstance(val, (bytes, str)):
                        val = [val]
                    tally_info['scores'] = [v.decode('utf-8') if hasattr(v, 'decode') else str(v) for v in val]
                elif 'score' in tally.attrs:
                    val = tally.attrs['score']
                    val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                    tally_info['scores'] = val.split()
                
                # Get nuclides (Handle Dataset vs Attribute representation)
                if 'nuclides' in tally:
                    val = tally['nuclides'][()]
                    if isinstance(val, np.ndarray):
                        val = [val[()]] if val.ndim == 0 else val.tolist()
                    elif isinstance(val, (bytes, str)):
                        val = [val]
                    tally_info['nuclides'] = [v.decode('utf-8') if hasattr(v, 'decode') else str(v) for v in val]
                elif 'nuclides' in tally.attrs:
                    val = tally.attrs['nuclides']
                    val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                    tally_info['nuclides'] = val.split()
                
                # Check for mesh filter
                if 'filters' in tally:
                    filters_ref = tally['filters']
                    
                    if isinstance(filters_ref, h5py.Dataset):
                        filter_ids = filters_ref[...]
                        filters_location = None
                        if 'filters' in f:
                            filters_location = f['filters']
                        elif 'filters' in f['tallies']:
                            filters_location = f['tallies']['filters']
                        
                        if filters_location:
                            for fid in filter_ids.flat:
                                filter_key = f'filter {int(fid)}'
                                if filter_key in filters_location:
                                    filter_obj = filters_location[filter_key]
                                    self._parse_filter(filter_obj, tally_info, f)
                    elif isinstance(filters_ref, h5py.Group):
                        for filter_key in filters_ref.keys():
                            filter_obj = filters_ref[filter_key]
                            self._parse_filter(filter_obj, tally_info, f)
                
                tallies.append(tally_info)
        
        return tallies
    
    def _parse_filter(self, filter_obj, tally_info: dict, f=None) -> None:
        """Helper to parse a filter object and add to tally_info."""
        filter_type = 'unknown'
        if 'type' in filter_obj:
            val = filter_obj['type'][()]
            filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
        elif 'type' in filter_obj.attrs:
            val = filter_obj.attrs['type']
            filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
            
        if isinstance(filter_type, str) and filter_type.startswith("b'") and filter_type.endswith("'"):
            filter_type = filter_type[2:-1]
            
        n_bins = 0
        if 'n_bins' in filter_obj:
            n_bins = int(filter_obj['n_bins'][()])
        elif 'n_bins' in filter_obj.attrs:
            n_bins = int(filter_obj.attrs['n_bins'])
            
        filter_info = {
            'type': filter_type,
            'bins': n_bins
        }
        
        if filter_type == 'mesh':
            tally_info['has_mesh'] = True
            
            # Find the mesh ID using the bins array
            mesh_id = None
            if 'bins' in filter_obj:
                bins_data = filter_obj['bins'][()]
                if isinstance(bins_data, np.ndarray) and bins_data.size > 0:
                    mesh_id = int(bins_data.flat[0])
                else:
                    mesh_id = int(bins_data)
                    
            if mesh_id is not None and f is not None and 'tallies' in f and 'meshes' in f['tallies']:
                mesh_key = f'mesh {mesh_id}'
                if mesh_key in f['tallies']['meshes']:
                    mesh_obj = f['tallies']['meshes'][mesh_key]
                    
                    # Detect mesh type
                    if 'r_grid' in mesh_obj or 'phi_grid' in mesh_obj:
                        filter_info['mesh_type'] = 'cylindrical'
                    else:
                        filter_info['mesh_type'] = 'regular'
                    
                    # Convert tolist() ensures standard python int/float for JSON serialization
                    if 'dimension' in mesh_obj:
                        filter_info['mesh_dimensions'] = mesh_obj['dimension'][()].tolist()
                    if 'lower_left' in mesh_obj:
                        filter_info['lower_left'] = mesh_obj['lower_left'][()].tolist()
                    if 'upper_right' in mesh_obj:
                        filter_info['upper_right'] = mesh_obj['upper_right'][()].tolist()
                    if 'width' in mesh_obj:
                        filter_info['width'] = mesh_obj['width'][()].tolist()
                    elif all(k in filter_info for k in ['mesh_dimensions', 'lower_left', 'upper_right']):
                        ur = np.array(filter_info['upper_right'])
                        ll = np.array(filter_info['lower_left'])
                        dim = np.array(filter_info['mesh_dimensions'])
                        filter_info['width'] = ((ur - ll) / dim).tolist()
        
        tally_info['filters'].append(filter_info)
    
    def _parse_filter_full(self, filter_obj, f=None):
        """Parse a filter object and return full info for load_tally."""
        filter_type = 'unknown'
        if 'type' in filter_obj:
            val = filter_obj['type'][()]
            filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
        elif 'type' in filter_obj.attrs:
            val = filter_obj.attrs['type']
            filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
            
        if isinstance(filter_type, str) and filter_type.startswith("b'") and filter_type.endswith("'"):
            filter_type = filter_type[2:-1]
            
        # # print(f"[OpenMC Debug] _parse_filter_full: type={filter_type}", file=sys.stderr)
        
        n_bins = 0
        if 'n_bins' in filter_obj:
            n_bins = int(filter_obj['n_bins'][()])
        elif 'n_bins' in filter_obj.attrs:
            n_bins = int(filter_obj.attrs['n_bins'])
            
        filter_info = {
            'type': filter_type,
            'bins': n_bins
        }
        
        has_mesh = False
        mesh_info = None
        
        if filter_type == 'mesh':
            has_mesh = True
            
            # Newer OpenMC versions assign the mesh ID in the bins dataset
            mesh_id = None
            if 'bins' in filter_obj:
                bins_data = filter_obj['bins'][()]
                if isinstance(bins_data, np.ndarray) and bins_data.size > 0:
                    mesh_id = int(bins_data.flat[0])
                else:
                    mesh_id = int(bins_data)
                # print(f"[OpenMC Debug] Found mesh_id: {mesh_id}", file=sys.stderr)
            else:
                pass
                # print(f"[OpenMC Debug] No 'bins' in filter_obj, keys: {list(filter_obj.keys())}", file=sys.stderr)
                    
            if mesh_id is not None and f is not None and 'tallies' in f and 'meshes' in f['tallies']:
                mesh_key = f'mesh {mesh_id}'
                # print(f"[OpenMC Debug] Looking for mesh: {mesh_key}", file=sys.stderr)
                if mesh_key in f['tallies']['meshes']:
                    mesh_obj = f['tallies']['meshes'][mesh_key]
                    mesh_info = {}
                    
                    # Debug: show available keys
                    # print(f"[OpenMC Debug] Mesh object keys: {list(mesh_obj.keys())}", file=sys.stderr)
                    
                    # RegularMesh has dimension, lower_left, upper_right
                    if 'dimension' in mesh_obj:
                        mesh_info['mesh_type'] = 'regular'
                        mesh_info['dimensions'] = mesh_obj['dimension'][()].tolist()
                        if 'lower_left' in mesh_obj:
                            mesh_info['lower_left'] = mesh_obj['lower_left'][()].tolist()
                        if 'upper_right' in mesh_obj:
                            mesh_info['upper_right'] = mesh_obj['upper_right'][()].tolist()
                        if 'width' in mesh_obj:
                            mesh_info['width'] = mesh_obj['width'][()].tolist()
                        elif all(k in mesh_info for k in ['dimensions', 'lower_left', 'upper_right']):
                            ur = np.array(mesh_info['upper_right'])
                            ll = np.array(mesh_info['lower_left'])
                            dim = np.array(mesh_info['dimensions'])
                            mesh_info['width'] = ((ur - ll) / dim).tolist()
                    # CylindricalMesh has r_grid, phi_grid, z_grid
                    elif 'r_grid' in mesh_obj or 'phi_grid' in mesh_obj:
                        mesh_info['mesh_type'] = 'cylindrical'
                        if 'r_grid' in mesh_obj:
                            mesh_info['r_grid'] = mesh_obj['r_grid'][()].tolist()
                        if 'phi_grid' in mesh_obj:
                            mesh_info['phi_grid'] = mesh_obj['phi_grid'][()].tolist()
                        if 'z_grid' in mesh_obj:
                            mesh_info['z_grid'] = mesh_obj['z_grid'][()].tolist()
                        # Calculate dimensions for display
                        nr = len(mesh_info.get('r_grid', [])) - 1
                        nphi = len(mesh_info.get('phi_grid', [])) - 1
                        nz = len(mesh_info.get('z_grid', [])) - 1
                        mesh_info['dimensions'] = [nr, nphi, nz]
                        
                    filter_info['mesh_info'] = mesh_info
                    # print(f"[OpenMC Debug] Mesh info: type={mesh_info.get('mesh_type')}, dims={mesh_info.get('dimensions')}", file=sys.stderr)
                else:
                    pass
                    available_meshes = list(f['tallies']['meshes'].keys())
                    # print(f"[OpenMC Debug] WARNING: mesh {mesh_id} not found in meshes group", file=sys.stderr)
                    # print(f"[OpenMC Debug] Available meshes: {available_meshes}", file=sys.stderr)
            else:
                pass
                # print(f"[OpenMC Debug] WARNING: mesh_id={mesh_id}, f is None: {f is None}", file=sys.stderr)
                if f is not None:
                    pass
                    # print(f"[OpenMC Debug] 'tallies' in f: {'tallies' in f}, 'meshes' in f.get('tallies', {{}}): {'meshes' in f.get('tallies', {})}", file=sys.stderr)
                
        return filter_info, has_mesh, mesh_info
    
    def load_tally(self, statepoint_file: str, tally_id: int) -> OpenMCTally:
        """
        Load a specific tally from statepoint file.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID to load
            
        Returns:
            OpenMCTally object with results
        """
        with h5py.File(statepoint_file, 'r') as f:
            tally_path = f'tallies/tally {tally_id}'
            
            if tally_path not in f:
                raise ValueError(f"Tally {tally_id} not found in {statepoint_file}")
            
            tally = f[tally_path]
            
            # Get name
            name = tally.attrs.get('name', f'Tally {tally_id}')
            if isinstance(name, bytes):
                name = name.decode('utf-8')
            
            # Get scores
            scores = []
            if 'score' in tally:
                val = tally['score'][()]
                if isinstance(val, np.ndarray):
                    val = [val[()]] if val.ndim == 0 else val.tolist()
                elif isinstance(val, (bytes, str)):
                    val = [val]
                scores = [v.decode('utf-8') if hasattr(v, 'decode') else str(v) for v in val]
            elif 'score' in tally.attrs:
                val = tally.attrs['score']
                val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                scores = val.split()
            
            # Get nuclides
            nuclides = []
            if 'nuclides' in tally:
                val = tally['nuclides'][()]
                if isinstance(val, np.ndarray):
                    val = [val[()]] if val.ndim == 0 else val.tolist()
                elif isinstance(val, (bytes, str)):
                    val = [val]
                nuclides = [v.decode('utf-8') if hasattr(v, 'decode') else str(v) for v in val]
            elif 'nuclides' in tally.attrs:
                val = tally.attrs['nuclides']
                val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                nuclides = val.split()
            
            # Get filters
            filters = []
            has_mesh = False
            mesh_info = None
            
            if 'filters' in tally:
                filters_ref = tally['filters']
                
                if isinstance(filters_ref, h5py.Dataset):
                    filter_ids = filters_ref[...]
                    
                    filters_location = None
                    if 'filters' in f:
                        filters_location = f
                    elif 'filters' in f['tallies']:
                        filters_location = f['tallies']
                    
                    if filters_location:
                        global_filters = filters_location['filters']
                        for fid in filter_ids.flat:
                            filter_key = f'filter {int(fid)}'
                            if filter_key in global_filters:
                                filter_obj = global_filters[filter_key]
                                finfo, hmesh, minfo = self._parse_filter_full(filter_obj, f)
                                filters.append(finfo)
                                if hmesh:
                                    has_mesh = True
                                    mesh_info = minfo
                elif isinstance(filters_ref, h5py.Group):
                    for filter_key in filters_ref.keys():
                        filter_obj = filters_ref[filter_key]
                        finfo, hmesh, minfo = self._parse_filter_full(filter_obj, f)
                        filters.append(finfo)
                        if hmesh:
                            has_mesh = True
                            mesh_info = minfo
            
            # Get results robustly (using Ellipsis allows correct indexing on both 3D or 4D results)
            results = tally['results'][...]
            mean = results[..., 0]  # Mean values 
            std_dev = results[..., 1]  # Standard deviations
            
            return OpenMCTally(
                id=tally_id,
                name=name,
                scores=scores,
                nuclides=nuclides,
                filters=filters,
                mean=mean,
                std_dev=std_dev,
                has_mesh=has_mesh,
                mesh_info=mesh_info
            )
    
    def create_mesh_tally_vtu(self, tally: OpenMCTally, score_index: int = 0, 
                               nuclide_index: int = 0) -> vtk.vtkUnstructuredGrid:
        """
        Create a VTK unstructured grid from a mesh tally.
        Supports both RegularMesh and CylindricalMesh.
        
        Args:
            tally: OpenMCTally object with mesh information
            score_index: Index of score to visualize (default 0)
            nuclide_index: Index of nuclide to visualize (default 0)
            
        Returns:
            VTK unstructured grid with tally data as cell data
        """
        if not tally.has_mesh or not tally.mesh_info:
            raise ValueError("Tally does not have mesh information")
        
        mesh = tally.mesh_info
        mesh_type = mesh.get('mesh_type', 'regular')
        
        if mesh_type == 'cylindrical':
            return self._create_cylindrical_mesh_vtu(tally, score_index, nuclide_index)
        else:
            return self._create_regular_mesh_vtu(tally, score_index, nuclide_index)
    
    def _create_regular_mesh_vtu(self, tally: OpenMCTally, score_index: int = 0,
                                  nuclide_index: int = 0) -> vtk.vtkUnstructuredGrid:
        """Create VTK grid from RegularMesh."""
        mesh = tally.mesh_info
        nx, ny, nz = mesh['dimensions']
        dx, dy, dz = mesh['width']
        xmin, ymin, zmin = mesh['lower_left']
        
        # Create points
        points = vtk.vtkPoints()
        for k in range(nz + 1):
            z = zmin + k * dz
            for j in range(ny + 1):
                y = ymin + j * dy
                for i in range(nx + 1):
                    x = xmin + i * dx
                    points.InsertNextPoint(x, y, z)
        
        # Create cells (voxels)
        cells = vtk.vtkCellArray()
        for k in range(nz):
            for j in range(ny):
                for i in range(nx):
                    # Create voxel
                    voxel = vtk.vtkVoxel()
                    
                    # Get point indices for this voxel
                    p0 = (k * (ny + 1) + j) * (nx + 1) + i
                    p1 = p0 + 1
                    p2 = p0 + (nx + 1)
                    p3 = p2 + 1
                    p4 = ((k + 1) * (ny + 1) + j) * (nx + 1) + i
                    p5 = p4 + 1
                    p6 = p4 + (nx + 1)
                    p7 = p6 + 1
                    
                    voxel.GetPointIds().SetId(0, p0)
                    voxel.GetPointIds().SetId(1, p1)
                    voxel.GetPointIds().SetId(2, p2)
                    voxel.GetPointIds().SetId(3, p3)
                    voxel.GetPointIds().SetId(4, p4)
                    voxel.GetPointIds().SetId(5, p5)
                    voxel.GetPointIds().SetId(6, p6)
                    voxel.GetPointIds().SetId(7, p7)
                    
                    cells.InsertNextCell(voxel)
        
        # Create grid
        grid = vtk.vtkUnstructuredGrid()
        grid.SetPoints(points)
        grid.SetCells(vtk.VTK_VOXEL, cells)
        
        # Add tally data
        self._add_tally_data_to_grid(grid, tally, nx * ny * nz, score_index, nuclide_index)
        
        return grid
    
    def _create_cylindrical_mesh_vtu(self, tally: OpenMCTally, score_index: int = 0,
                                      nuclide_index: int = 0) -> vtk.vtkUnstructuredGrid:
        """Create VTK grid from CylindricalMesh."""
        mesh = tally.mesh_info
        
        # Get cylindrical grid parameters
        r_grid = np.array(mesh['r_grid'])
        phi_grid = np.array(mesh['phi_grid'])
        z_grid = np.array(mesh['z_grid'])
        
        nr = len(r_grid) - 1
        nphi = len(phi_grid) - 1
        nz = len(z_grid) - 1
        
        # print(f"[OpenMC] Creating cylindrical mesh: {nr} radial x {nphi} azimuthal x {nz} axial cells", file=sys.stderr)
        
        # Create points (convert cylindrical to Cartesian)
        points = vtk.vtkPoints()
        for k in range(nz + 1):
            z = z_grid[k]
            for j in range(nphi + 1):
                phi = phi_grid[j]
                for i in range(nr + 1):
                    r = r_grid[i]
                    # Convert cylindrical (r, phi, z) to Cartesian (x, y, z)
                    x = r * np.cos(phi)
                    y = r * np.sin(phi)
                    points.InsertNextPoint(x, y, z)
        
        # Create cells (wedges for cylindrical sectors)
        cells = vtk.vtkCellArray()
        for k in range(nz):
            for j in range(nphi):
                for i in range(nr):
                    # Create wedge (triangular prism)
                    wedge = vtk.vtkWedge()
                    
                    # Get point indices for this wedge
                    # Bottom face (z = k)
                    p0 = (k * (nphi + 1) + j) * (nr + 1) + i       # inner, this phi
                    p1 = p0 + 1                                       # outer, this phi
                    p2 = (k * (nphi + 1) + (j + 1)) * (nr + 1) + i  # inner, next phi
                    # Top face (z = k + 1)
                    p3 = ((k + 1) * (nphi + 1) + j) * (nr + 1) + i
                    p4 = p3 + 1
                    p5 = ((k + 1) * (nphi + 1) + (j + 1)) * (nr + 1) + i
                    
                    wedge.GetPointIds().SetId(0, p0)
                    wedge.GetPointIds().SetId(1, p1)
                    wedge.GetPointIds().SetId(2, p2)
                    wedge.GetPointIds().SetId(3, p3)
                    wedge.GetPointIds().SetId(4, p4)
                    wedge.GetPointIds().SetId(5, p5)
                    
                    cells.InsertNextCell(wedge)
        
        # Create grid
        grid = vtk.vtkUnstructuredGrid()
        grid.SetPoints(points)
        grid.SetCells(vtk.VTK_WEDGE, cells)
        
        # Add tally data
        self._add_tally_data_to_grid(grid, tally, nr * nphi * nz, score_index, nuclide_index)
        
        return grid
    
    def _add_tally_data_to_grid(self, grid: vtk.vtkUnstructuredGrid, tally: OpenMCTally,
                                 n_cells: int, score_index: int, nuclide_index: int):
        """Add tally mean and std_dev data to VTK grid as cell data."""
        # Handle multi-score/nuclide case
        n_scores = len(tally.scores) if tally.scores else 1
        n_nuclides = len(tally.nuclides) if tally.nuclides else 1
        
        mean_flat = tally.mean.flatten()
        std_flat = tally.std_dev.flatten()
        
        # Extract data for specific score and nuclide
        expected_size = n_cells * n_scores * n_nuclides
        
        if len(mean_flat) == expected_size:
            # Multi-dimensional data - need to extract correct slice
            # Reshape to (n_cells, n_scores, n_nuclides) and extract
            reshaped = mean_flat.reshape(n_cells, n_scores, n_nuclides)
            data = reshaped[:, score_index, nuclide_index]
            std_reshaped = std_flat.reshape(n_cells, n_scores, n_nuclides)
            std_data = std_reshaped[:, score_index, nuclide_index]
        else:
            # Single-dimensional data or different layout
            data = mean_flat[:n_cells]
            std_data = std_flat[:n_cells]
        
        # Create VTK arrays
        vtk_array = numpy_support.numpy_to_vtk(data)
        vtk_array.SetName('tally_mean')
        grid.GetCellData().AddArray(vtk_array)
        grid.GetCellData().SetActiveScalars('tally_mean')
        
        vtk_std = numpy_support.numpy_to_vtk(std_data)
        vtk_std.SetName('tally_std_dev')
        grid.GetCellData().AddArray(vtk_std)
    
    def load_source(self, source_file: str) -> vtk.vtkPolyData:
        """
        Load OpenMC source distribution from source.h5 and create point cloud.
        
        Args:
            source_file: Path to source.h5
            
        Returns:
            VTK polydata with source particles as points
        """
        with h5py.File(source_file, 'r') as f:
            if 'source' not in f:
                raise ValueError(f"No 'source' group found in {source_file}")
            
            source = f['source']
            n_particles = source.attrs.get('n_particles', len(source['r']['x']))
            
            # Get positions
            x = source['r']['x'][...]
            y = source['r']['y'][...]
            z = source['r']['z'][...]
            
            # Get energies if available
            if 'E' in source:
                energies = source['E'][...]
            else:
                energies = np.ones_like(x)
            
            # Get weights
            if 'wgt' in source:
                weights = source['wgt'][...]
            else:
                weights = np.ones_like(x)
            
            # Create VTK points
            vtk_points = vtk.vtkPoints()
            for i in range(min(len(x), n_particles)):
                vtk_points.InsertNextPoint(x[i], y[i], z[i])
            
            # Create polydata
            polydata = vtk.vtkPolyData()
            polydata.SetPoints(vtk_points)
            
            # Create vertices
            verts = vtk.vtkCellArray()
            for i in range(vtk_points.GetNumberOfPoints()):
                verts.InsertNextCell(1)
                verts.InsertCellPoint(i)
            polydata.SetVerts(verts)
            
            # Add energy as point data
            energy_array = numpy_support.numpy_to_vtk(energies[:vtk_points.GetNumberOfPoints()])
            energy_array.SetName('energy')
            polydata.GetPointData().AddArray(energy_array)
            
            # Add weight as point data
            weight_array = numpy_support.numpy_to_vtk(weights[:vtk_points.GetNumberOfPoints()])
            weight_array.SetName('weight')
            polydata.GetPointData().AddArray(weight_array)
            
            return polydata
    
    def visualize_tally_on_geometry(self, geometry_file: str, statepoint_file: str, 
                                     tally_id: int, score: str = None) -> Dict:
        """
        Overlay tally results on geometry.
        
        Args:
            geometry_file: Path to geometry file (.h5m or .vtk)
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID to visualize
            score: Specific score to visualize (optional)
            
        Returns:
            Dictionary with visualization objects
        """
        # Load geometry
        if geometry_file.endswith('.h5m'):
            from dagmc_converter import convert_h5m_to_vtk
            vtk_path = convert_h5m_to_vtk(geometry_file)
            geometry = simple.OpenDataFile(vtk_path)
        else:
            geometry = simple.OpenDataFile(geometry_file)
        
        # Load tally
        tally = self.load_tally(statepoint_file, tally_id)
        
        # Show geometry
        geometry_display = simple.Show(geometry)
        
        # If mesh tally, create mesh visualization
        if tally.has_mesh:
            mesh_grid = self.create_mesh_tally_vtu(tally)
            
            # Convert VTK grid to ParaView source
            # We need to write to a temporary file and read back
            import tempfile
            import os
            
            with tempfile.NamedTemporaryFile(suffix='.vtu', delete=False) as tmp:
                tmp_path = tmp.name
            
            writer = vtk.vtkXMLUnstructuredGridWriter()
            writer.SetFileName(tmp_path)
            writer.SetInputData(mesh_grid)
            writer.Write()
            
            mesh_source = simple.XMLUnstructuredGridReader(FileName=tmp_path)
            mesh_display = simple.Show(mesh_source)
            
            # Color by tally mean
            simple.ColorBy(mesh_display, ('CELLS', 'tally_mean'))
            
            # Apply color map
            lut = simple.GetColorTransferFunction('tally_mean')
            lut.ApplyPreset('Cool to Warm', True)
            
            return {
                'geometry': geometry,
                'geometry_display': geometry_display,
                'tally_source': mesh_source,
                'tally_display': mesh_display,
                'tally': tally,
                'temp_file': tmp_path
            }
        
        return {
            'geometry': geometry,
            'geometry_display': geometry_display,
            'tally': tally
        }


class OpenMCPlotter:
    """Helper class for creating OpenMC-specific visualizations"""
    
    @staticmethod
    def create_energy_spectrum(statepoint_file: str, tally_id: int, 
                                score_index: int = 0, nuclide_index: int = 0) -> Dict[str, np.ndarray]:
        """
        Extract energy spectrum from an energy-filtered tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            score_index: Index of score to extract
            nuclide_index: Index of nuclide to extract
            
        Returns:
            Dictionary with 'energy_bins' and 'values' arrays
        """
        with h5py.File(statepoint_file, 'r') as f:
            tally_path = f'tallies/tally {tally_id}'
            
            if tally_path not in f:
                raise ValueError(f"Tally {tally_id} not found")
            
            tally = f[tally_path]
            
            # Find energy filter
            if 'filters' not in tally:
                raise ValueError("Tally has no filters")
            
            # Tally results shape: (bins, ..., n_scores, n_nuclides, 3) where 3 is (sum, sum_sq, n)
            # or just (bins, n_scores, n_nuclides, 2) where 2 is (mean, std_dev)
            
            filters_group = tally['filters']
            energy_filter = None
            filter_idx = -1
            
            # Find which filter is the energy filter
            all_filters = []
            if isinstance(filters_group, h5py.Dataset):
                # Older format or reference format
                filter_ids = filters_group[...]
                global_filters = f['filters'] if 'filters' in f else f['tallies']['filters']
                for fid in filter_ids.flat:
                    all_filters.append(global_filters[f'filter {int(fid)}'])
            else:
                for k in sorted(filters_group.keys()):
                    all_filters.append(filters_group[k])

            for i, filter_obj in enumerate(all_filters):
                filter_type = 'unknown'
                if 'type' in filter_obj:
                    val = filter_obj['type'][()]
                    filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                elif 'type' in filter_obj.attrs:
                    val = filter_obj.attrs['type']
                    filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                
                if isinstance(filter_type, str) and filter_type.startswith("b'") and filter_type.endswith("'"):
                    filter_type = filter_type[2:-1]

                if filter_type in ('energy', 'energyout'):
                    energy_filter = filter_obj
                    filter_idx = i
                    break
            
            if energy_filter is None:
                raise ValueError("No energy filter found in tally")
            
            # Get energy bins
            bins = energy_filter['bins'][...]
            
            # Get results
            results = tally['results'][...]
            mean = results[..., 0]
            std_dev = results[..., 1]
            
            # The mean array has shape (filter1_bins, filter2_bins, ..., n_scores, n_nuclides)
            # We need to isolate the energy filter axis and the requested score/nuclide
            n_filters = len(all_filters)
            n_scores = results.shape[-3] if results.ndim > 2 else 1
            n_nuclides = results.shape[-2] if results.ndim > 2 else 1
            
            # Reshape to 1D for easier indexing if needed, but ParaView/OpenMC 
            # usually has (f1, f2, ..., scores, nuclides)
            # For simplicity, if it's not already 1D + scores + nuclides, we flatten others
            # but usually a spectrum tally only has ONE filter (energy).
            
            if mean.ndim == 3: # (energy_bins, n_scores, n_nuclides)
                values = mean[:, score_index, nuclide_index]
                errors = std_dev[:, score_index, nuclide_index]
            else:
                # Flatten everything except scores and nuclides
                flat_mean = mean.reshape(-1, n_scores, n_nuclides)
                flat_std = std_dev.reshape(-1, n_scores, n_nuclides)
                values = flat_mean[:, score_index, nuclide_index]
                errors = flat_std[:, score_index, nuclide_index]
            
            return {
                'energy_bins': bins,
                'values': values,
                'std_dev': errors
            }
    
    @staticmethod
    def create_spatial_plot(statepoint_file: str, tally_id: int,
                            axis: str = 'z', score_index: int = 0,
                            nuclide_index: int = 0) -> Dict[str, np.ndarray]:
        """
        Create 1D spatial plot from a mesh tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            axis: Axis to plot along ('x', 'y', or 'z')
            score_index: Index of score to plot
            nuclide_index: Index of nuclide to plot
            
        Returns:
            Dictionary with axis positions and values
        """
        reader = OpenMCReader()
        tally = reader.load_tally(statepoint_file, tally_id)
        
        if not tally.has_mesh or not tally.mesh_info:
            raise ValueError("Tally is not a mesh tally")
        
        mesh = tally.mesh_info
        nx, ny, nz = mesh['dimensions']
        
        # Calculate cell centers for RegularMesh
        if mesh.get('mesh_type') == 'regular':
            dx, dy, dz = mesh['width']
            x_centers = np.linspace(mesh['lower_left'][0] + dx/2, mesh['upper_right'][0] - dx/2, nx)
            y_centers = np.linspace(mesh['lower_left'][1] + dy/2, mesh['upper_right'][1] - dy/2, ny)
            z_centers = np.linspace(mesh['lower_left'][2] + dz/2, mesh['upper_right'][2] - dz/2, nz)
        else:
            # For CylindricalMesh, use grids
            r_grid = np.array(mesh['r_grid'])
            phi_grid = np.array(mesh['phi_grid'])
            z_grid = np.array(mesh['z_grid'])
            x_centers = (r_grid[:-1] + r_grid[1:]) / 2 # Actually R centers
            y_centers = (phi_grid[:-1] + phi_grid[1:]) / 2 # Actually Phi centers
            z_centers = (z_grid[:-1] + z_grid[1:]) / 2
        
        # Isolate Single Score/Nuclide
        n_scores = len(tally.scores) if tally.scores else 1
        n_nuclides = len(tally.nuclides) if tally.nuclides else 1
        
        mean_flat = tally.mean.flatten()
        expected_size = nx * ny * nz * n_scores * n_nuclides
        
        if len(mean_flat) == expected_size:
            reshaped = mean_flat.reshape(nz, ny, nx, n_scores, n_nuclides)
            data_3d = reshaped[:, :, :, score_index, nuclide_index]
        else:
            # Fallback for unexpected shapes
            data_3d = mean_flat[:nx*ny*nz].reshape(nz, ny, nx)
        
        # Sum over other axes to get 1D distribution
        if axis == 'x':
            values = data_3d.sum(axis=(0, 1))  # Sum over z and y
            positions = x_centers
        elif axis == 'y':
            values = data_3d.sum(axis=(0, 2))  # Sum over z and x
            positions = y_centers
        else:  # z
            values = data_3d.sum(axis=(1, 2))  # Sum over y and x
            positions = z_centers
        
        return {
            'positions': positions,
            'values': values,
            'axis': axis
        }
    
    @staticmethod
    def create_heatmap_slice(
        statepoint_file: str,
        tally_id: int,
        plane: str = 'xy',
        slice_index: int = 0,
        score_index: int = 0,
        nuclide_index: int = 0
    ) -> Dict[str, Any]:
        """
        Create a 2D heatmap slice from a 3D mesh tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            plane: Slice plane ('xy', 'xz', or 'yz')
            slice_index: Index of the slice in the third dimension
            score_index: Index of score to extract
            nuclide_index: Index of nuclide to extract
            
        Returns:
            Dictionary with 2D values array and axis coordinates
        """
        reader = OpenMCReader()
        tally = reader.load_tally(statepoint_file, tally_id)
        
        if not tally.has_mesh or not tally.mesh_info:
            raise ValueError("Tally is not a mesh tally")
        
        mesh = tally.mesh_info
        
        # Only support regular (Cartesian) meshes for heatmaps
        if mesh.get('mesh_type') == 'cylindrical':
            raise ValueError("Cylindrical meshes not yet supported for 2D heatmaps")
        
        nx, ny, nz = mesh['dimensions']
        dx, dy, dz = mesh['width']
        xmin, ymin, zmin = mesh['lower_left']
        xmax, ymax, zmax = mesh['upper_right']
        
        # Calculate cell centers for each axis
        x_centers = np.linspace(xmin + dx/2, xmax - dx/2, nx)
        y_centers = np.linspace(ymin + dy/2, ymax - dy/2, ny)
        z_centers = np.linspace(zmin + dz/2, zmax - dz/2, nz)
        
        # Isolate Single Score/Nuclide
        n_scores = len(tally.scores) if tally.scores else 1
        n_nuclides = len(tally.nuclides) if tally.nuclides else 1
        
        mean_flat = tally.mean.flatten()
        std_flat = tally.std_dev.flatten()
        expected_size = nx * ny * nz * n_scores * n_nuclides
        
        if len(mean_flat) == expected_size:
            # Reshape to (nx, ny, nz, n_scores, n_nuclides) - note OpenMC ordering
            reshaped = mean_flat.reshape(nx, ny, nz, n_scores, n_nuclides)
            data_3d = reshaped[:, :, :, score_index, nuclide_index]
            std_reshaped = std_flat.reshape(nx, ny, nz, n_scores, n_nuclides)
            std_3d = std_reshaped[:, :, :, score_index, nuclide_index]
        else:
            # Fallback for unexpected shapes
            data_3d = mean_flat[:nx*ny*nz].reshape(nx, ny, nz)
            std_3d = std_flat[:nx*ny*nz].reshape(nx, ny, nz)
        
        # Extract 2D slice based on plane
        if plane == 'xy':
            # Slice perpendicular to z-axis
            if slice_index < 0 or slice_index >= nz:
                raise ValueError(f"Slice index {slice_index} out of range [0, {nz-1}]")
            values_2d = data_3d[:, :, slice_index].T  # Transpose for correct orientation
            std_2d = std_3d[:, :, slice_index].T
            x_coords = x_centers.tolist()
            y_coords = y_centers.tolist()
            x_label = 'X [cm]'
            y_label = 'Y [cm]'
            slice_label = 'Z'
            slice_position = float(z_centers[slice_index])
            total_slices = nz
        elif plane == 'xz':
            # Slice perpendicular to y-axis
            if slice_index < 0 or slice_index >= ny:
                raise ValueError(f"Slice index {slice_index} out of range [0, {ny-1}]")
            values_2d = data_3d[:, slice_index, :].T
            std_2d = std_3d[:, slice_index, :].T
            x_coords = x_centers.tolist()
            y_coords = z_centers.tolist()
            x_label = 'X [cm]'
            y_label = 'Z [cm]'
            slice_label = 'Y'
            slice_position = float(y_centers[slice_index])
            total_slices = ny
        elif plane == 'yz':
            # Slice perpendicular to x-axis
            if slice_index < 0 or slice_index >= nx:
                raise ValueError(f"Slice index {slice_index} out of range [0, {nx-1}]")
            values_2d = data_3d[slice_index, :, :].T
            std_2d = std_3d[slice_index, :, :].T
            x_coords = y_centers.tolist()
            y_coords = z_centers.tolist()
            x_label = 'Y [cm]'
            y_label = 'Z [cm]'
            slice_label = 'X'
            slice_position = float(x_centers[slice_index])
            total_slices = nx
        else:
            raise ValueError(f"Invalid plane '{plane}'. Must be 'xy', 'xz', or 'yz'")
        
        return {
            'values': values_2d.tolist(),
            'std_dev': std_2d.tolist(),
            'x_coords': x_coords,
            'y_coords': y_coords,
            'x_label': x_label,
            'y_label': y_label,
            'plane': plane,
            'slice_index': slice_index,
            'total_slices': total_slices,
            'slice_position': slice_position,
            'slice_label': slice_label,
            'mesh_dimensions': [nx, ny, nz]
        }

    @staticmethod
    def create_heatmap_slice_all(
        statepoint_file: str,
        tally_id: int,
        plane: str = 'xy',
        score_index: int = 0,
        nuclide_index: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Create all 2D heatmap slices from a 3D mesh tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            plane: Slice plane ('xy', 'xz', or 'yz')
            score_index: Index of score to extract
            nuclide_index: Index of nuclide to extract
            
        Returns:
            List of dictionaries, each with 2D values array and axis coordinates
        """
        reader = OpenMCReader()
        tally = reader.load_tally(statepoint_file, tally_id)
        
        if not tally.has_mesh or not tally.mesh_info:
            raise ValueError("Tally is not a mesh tally")
        
        mesh = tally.mesh_info
        
        # Only support regular (Cartesian) meshes for heatmaps
        if mesh.get('mesh_type') == 'cylindrical':
            raise ValueError("Cylindrical meshes not yet supported for 2D heatmaps")
        
        nx, ny, nz = mesh['dimensions']
        dx, dy, dz = mesh['width']
        xmin, ymin, zmin = mesh['lower_left']
        xmax, ymax, zmax = mesh['upper_right']
        
        # Calculate cell centers for each axis
        x_centers = np.linspace(xmin + dx/2, xmax - dx/2, nx)
        y_centers = np.linspace(ymin + dy/2, ymax - dy/2, ny)
        z_centers = np.linspace(zmin + dz/2, zmax - dz/2, nz)
        
        # Isolate Single Score/Nuclide
        n_scores = len(tally.scores) if tally.scores else 1
        n_nuclides = len(tally.nuclides) if tally.nuclides else 1
        
        mean_flat = tally.mean.flatten()
        std_flat = tally.std_dev.flatten()
        expected_size = nx * ny * nz * n_scores * n_nuclides
        
        if len(mean_flat) == expected_size:
            reshaped = mean_flat.reshape(nx, ny, nz, n_scores, n_nuclides)
            data_3d = reshaped[:, :, :, score_index, nuclide_index]
            std_reshaped = std_flat.reshape(nx, ny, nz, n_scores, n_nuclides)
            std_3d = std_reshaped[:, :, :, score_index, nuclide_index]
        else:
            data_3d = mean_flat[:nx*ny*nz].reshape(nx, ny, nz)
            std_3d = std_flat[:nx*ny*nz].reshape(nx, ny, nz)
        
        slices = []
        
        if plane == 'xy':
            total_slices = nz
            for slice_index in range(nz):
                values_2d = data_3d[:, :, slice_index].T
                std_2d = std_3d[:, :, slice_index].T
                slices.append({
                    'values': values_2d.tolist(),
                    'std_dev': std_2d.tolist(),
                    'x_coords': x_centers.tolist(),
                    'y_coords': y_centers.tolist(),
                    'x_label': 'X [cm]',
                    'y_label': 'Y [cm]',
                    'plane': plane,
                    'slice_index': slice_index,
                    'total_slices': total_slices,
                    'slice_position': float(z_centers[slice_index]),
                    'slice_label': 'Z',
                    'mesh_dimensions': [nx, ny, nz]
                })
        elif plane == 'xz':
            total_slices = ny
            for slice_index in range(ny):
                values_2d = data_3d[:, slice_index, :].T
                std_2d = std_3d[:, slice_index, :].T
                slices.append({
                    'values': values_2d.tolist(),
                    'std_dev': std_2d.tolist(),
                    'x_coords': x_centers.tolist(),
                    'y_coords': z_centers.tolist(),
                    'x_label': 'X [cm]',
                    'y_label': 'Z [cm]',
                    'plane': plane,
                    'slice_index': slice_index,
                    'total_slices': total_slices,
                    'slice_position': float(y_centers[slice_index]),
                    'slice_label': 'Y',
                    'mesh_dimensions': [nx, ny, nz]
                })
        elif plane == 'yz':
            total_slices = nx
            for slice_index in range(nx):
                values_2d = data_3d[slice_index, :, :].T
                std_2d = std_3d[slice_index, :, :].T
                slices.append({
                    'values': values_2d.tolist(),
                    'std_dev': std_2d.tolist(),
                    'x_coords': y_centers.tolist(),
                    'y_coords': z_centers.tolist(),
                    'x_label': 'Y [cm]',
                    'y_label': 'Z [cm]',
                    'plane': plane,
                    'slice_index': slice_index,
                    'total_slices': total_slices,
                    'slice_position': float(x_centers[slice_index]),
                    'slice_label': 'X',
                    'mesh_dimensions': [nx, ny, nz]
                })
        else:
            raise ValueError(f"Invalid plane '{plane}'. Must be 'xy', 'xz', or 'yz'")
        
        return slices


class OpenMCDepletionReader:
    """Reader for OpenMC depletion results from depletion_results.h5"""
    
    @staticmethod
    def load_summary(file_path: str) -> Dict[str, Any]:
        """
        Load summary information from depletion results.
        
        Args:
            file_path: Path to depletion_results.h5
            
        Returns:
            Dictionary with summary information
        """
        with h5py.File(file_path, 'r') as f:
            # Get number of materials from 'materials' group
            if 'materials' in f:
                n_materials = len(list(f['materials'].keys()))
            else:
                n_materials = 0
            
            # Get time data - depletion time is in seconds
            # Use 'time' dataset which has [start, end] in days for each step
            if 'time' in f:
                time_data = f['time'][()]  # Shape: (n_steps, 2) - [start, end] days
                n_steps = time_data.shape[0]
                # Use end time of each step
                time_days = time_data[:, 1].tolist()
                time_seconds = [t * 24 * 3600 for t in time_days]
            elif 'depletion time' in f:
                # Fallback to depletion time in seconds
                dep_time = f['depletion time'][()]
                n_steps = len(dep_time)
                time_seconds = dep_time.tolist()
                time_days = [t / (24 * 3600) for t in time_seconds]
            else:
                n_steps = 0
                time_days = []
                time_seconds = []
            
            # Get burnup if available
            burnup = None
            if 'burnup' in f:
                burnup = f['burnup'][()].tolist()
            
            # Get source rate if available
            source_rate = None
            if 'source_rate' in f:
                source_rate = f['source_rate'][()].tolist()
            
            # Get nuclide list from 'nuclides' group
            nuclides = []
            if 'nuclides' in f:
                nuclides = list(f['nuclides'].keys())
            
            # Get number array shape: (n_steps, n_materials, n_nuclides)
            n_nuclides = 0
            if 'number' in f:
                n_nuclides = f['number'].shape[2] if len(f['number'].shape) > 2 else 0
            
            return {
                'nMaterials': n_materials,
                'nSteps': n_steps,
                'nNuclides': n_nuclides or len(nuclides),
                'timePoints': time_seconds,
                'timeDays': time_days,
                'burnup': burnup,
                'sourceRate': source_rate,
                'nuclides': nuclides
            }
    
    @staticmethod
    def list_materials(file_path: str) -> List[Dict[str, Any]]:
        """
        List all materials in depletion results.
        
        Args:
            file_path: Path to depletion_results.h5
            
        Returns:
            List of material information dictionaries
        """
        materials = []
        with h5py.File(file_path, 'r') as f:
            if 'materials' not in f:
                return materials
                
            for key in sorted(f['materials'].keys()):
                try:
                    mat_idx = int(key)
                    mat_group = f['materials'][key]
                    
                    # Get material name if available
                    name = f'material {mat_idx}'
                    if 'name' in mat_group.attrs:
                        name = mat_group.attrs['name']
                        if isinstance(name, bytes):
                            name = name.decode('utf-8')
                    
                    # Get volume if available (in attrs or dataset)
                    volume = None
                    if 'volume' in mat_group.attrs:
                        volume = float(mat_group.attrs['volume'])
                    elif 'volume' in mat_group:
                        volume = float(mat_group['volume'][()])
                    
                    # Get number density array shape
                    number_shape = None
                    if 'number' in f:
                        number_shape = f['number'].shape
                    
                    # Get initial atoms from the number array
                    initial_atoms = None
                    if number_shape and len(number_shape) == 3:
                        # number[time_step, material_index, nuclide_index]
                        # Find material index (0-based from materials group order)
                        mat_order = sorted([int(k) for k in f['materials'].keys()])
                        mat_array_idx = mat_order.index(mat_idx)
                        initial_atoms = float(np.sum(f['number'][0, mat_array_idx, :]))
                    
                    materials.append({
                        'index': mat_idx,
                        'name': name,
                        'volume': volume,
                        'initialAtoms': initial_atoms
                    })
                except (ValueError, KeyError) as e:
                    # Skip invalid entries
                    print(f"[DepletionReader] Warning: Could not read material {key}: {e}", file=sys.stderr)
                    continue
        
        return materials
    
    @staticmethod
    def load_material_data(
        file_path: str,
        material_index: int,
        nuclide_filter: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Load depletion data for a specific material.
        
        Args:
            file_path: Path to depletion_results.h5
            material_index: Material index to load
            nuclide_filter: Optional list of nuclides to include (all if None)
            
        Returns:
            Dictionary with material depletion data
        """
        with h5py.File(file_path, 'r') as f:
            # Check that materials group exists
            if 'materials' not in f:
                raise ValueError(f"No 'materials' group found in {file_path}")
            
            mat_key = str(material_index)
            if mat_key not in f['materials']:
                raise ValueError(f"Material {material_index} not found in {file_path}")
            
            # Get material info from materials group
            mat_group = f['materials'][mat_key]
            
            # Get material name if available
            name = f'material {material_index}'
            if 'name' in mat_group.attrs:
                name = mat_group.attrs['name']
                if isinstance(name, bytes):
                    name = name.decode('utf-8')
            
            # Get volume if available
            volume = None
            if 'volume' in mat_group.attrs:
                volume = float(mat_group.attrs['volume'])
            elif 'volume' in mat_group:
                volume = float(mat_group['volume'][()])
            
            # Get nuclide names from 'nuclides' group
            if 'nuclides' not in f:
                raise ValueError(f"No 'nuclides' group found in {file_path}")
            
            nuclide_names = list(f['nuclides'].keys())
            n_nuclides = len(nuclide_names)
            
            # Get number array: (n_steps, n_materials, n_nuclides)
            if 'number' not in f:
                raise ValueError(f"No 'number' dataset found in {file_path}")
            
            number_data = f['number'][()]  # Shape: (steps, materials, nuclides)
            n_steps = number_data.shape[0]
            
            # Find material index in the array
            mat_order = sorted([int(k) for k in f['materials'].keys()])
            if material_index not in mat_order:
                raise ValueError(f"Material {material_index} not in materials list")
            mat_array_idx = mat_order.index(material_index)
            
            # Extract concentrations for this material: (steps, nuclides)
            concentrations = number_data[:, mat_array_idx, :]  # Shape: (steps, nuclides)
            
            # Filter nuclides if requested
            if nuclide_filter:
                indices = [i for i, n in enumerate(nuclide_names) if n in nuclide_filter]
                nuclide_names = [nuclide_names[i] for i in indices]
                concentrations = concentrations[:, indices]
            
            # Build nuclide data
            nuclide_data = []
            for i, nuclide in enumerate(nuclide_names):
                conc = concentrations[:, i].tolist()
                
                nuclide_data.append({
                    'nuclide': nuclide,
                    'concentrations': conc,
                    'massGrams': None  # Mass not directly available in this format
                })
            
            # Calculate totals
            total_atoms = np.sum(concentrations, axis=1).tolist()
            
            # Calculate activity and decay heat
            activity_data = OpenMCDepletionReader._calculate_activity(
                nuclide_names, concentrations, f
            )
            
            return {
                'material': {
                    'index': material_index,
                    'name': name,
                    'volume': volume,
                    'initialAtoms': total_atoms[0] if total_atoms else None
                },
                'nuclides': nuclide_data,
                'totalAtoms': total_atoms,
                'totalMass': None,  # Not directly available
                'activity': activity_data
            }
    
    @staticmethod
    def _calculate_activity(
        nuclide_names: List[str],
        concentrations: np.ndarray,
        h5_file: h5py.File
    ) -> Dict[str, Any]:
        """
        Calculate activity and decay heat for nuclides.
        
        Args:
            nuclide_names: List of nuclide names
            concentrations: Concentration array (steps, nuclides) in atoms/barn-cm
            h5_file: Open h5py file handle
            
        Returns:
            Dictionary with activity data per nuclide and totals
        """
        n_steps = concentrations.shape[0]
        n_nuclides = len(nuclide_names)
        
        # Try to get decay data from chain file
        half_lives = {}
        decay_energies = {}
        
        # Common nuclide half-lives (in seconds) and decay energies (in MeV)
        # Data from ENDF/B-VIII.0 decay sublibrary
        decay_data = {
            # Fission products
            'Xe135': {'half_life': 32904.0, 'decay_energy': 0.427},  # 9.14 hours
            'I135': {'half_life': 23688.0, 'decay_energy': 0.515},   # 6.58 hours
            'Cs137': {'half_life': 951984960.0, 'decay_energy': 0.514},  # 30.17 years
            'Cs134': {'half_life': 6528768.0, 'decay_energy': 1.064},    # 2.06 years
            'Sr90': {'half_life': 908556672.0, 'decay_energy': 0.546},   # 28.8 years
            'Kr85': {'half_life': 33906240.0, 'decay_energy': 0.251},    # 10.76 years
            'Pm147': {'half_life': 9126000.0, 'decay_energy': 0.069},    # 2.62 years
            'Sm151': {'half_life': 2822400.0, 'decay_energy': 0.006},    # 90 years (approx)
            'Eu154': {'half_life': 272160000.0, 'decay_energy': 0.949},  # 8.6 years
            'Ru106': {'half_life': 11085120.0, 'decay_energy': 0.039},   # 128 days
            'Ce144': {'half_life': 2491200.0, 'decay_energy': 0.082},    # 28.9 days
            'Zr95': {'half_life': 5538240.0, 'decay_energy': 0.196},     # 64 days
            'Nb95': {'half_life': 345600.0, 'decay_energy': 0.253},      # 4 days
            'Mo99': {'half_life': 237600.0, 'decay_energy': 0.787},      # 2.75 days
            'Tc99_m1': {'half_life': 21600.0, 'decay_energy': 0.391},    # 6 hours
            'Ba140': {'half_life': 1108800.0, 'decay_energy': 0.481},    # 12.8 days
            'La140': {'half_life': 145152.0, 'decay_energy': 1.577},     # 1.68 days
            
            # Actinides
            'U235': {'half_life': 2.221e17, 'decay_energy': 4.679},      # 7.04e8 years (alpha)
            'U238': {'half_life': 1.409e17, 'decay_energy': 4.270},      # 4.47e9 years (alpha)
            'Pu239': {'half_life': 7.605e11, 'decay_energy': 5.245},     # 24110 years (alpha)
            'Pu240': {'half_life': 2.071e11, 'decay_energy': 5.256},     # 6560 years (alpha)
            'Pu241': {'half_life': 13674240.0, 'decay_energy': 0.006},   # 14.4 years (beta)
            'Pu242': {'half_life': 1.183e13, 'decay_energy': 4.984},     # 3.75e5 years (alpha)
            'Am241': {'half_life': 1.365e10, 'decay_energy': 5.637},     # 432 years (alpha)
            'Am242_m1': {'half_life': 56400.0, 'decay_energy': 0.687},   # 15.7 hours
            'Am243': {'half_life': 2.325e11, 'decay_energy': 5.439},     # 7370 years
            'Cm242': {'half_life': 1401600.0, 'decay_energy': 6.216},    # 162 days
            'Cm244': {'half_life': 56851200.0, 'decay_energy': 5.902},   # 18.1 years
            'Np239': {'half_life': 203040.0, 'decay_energy': 0.438},     # 2.35 days
        }
        
        # Get volume from file if available (convert from barn-cm to cm³)
        volume_cm3 = 1.0  # Default assumption
        
        # Calculate activity for each nuclide
        # Activity A = λ * N where λ = ln(2) / T_1/2
        # Note: concentrations from OpenMC depletion are already total number of atoms
        # (from the 'number' dataset which has shape [time_steps, materials, nuclides])
        LN2 = 0.69314718056
        
        nuclide_activity = []
        total_activity_bq = np.zeros(n_steps)
        total_activity_ci = np.zeros(n_steps)
        total_decay_heat = np.zeros(n_steps)
        
        for i, nuclide in enumerate(nuclide_names):
            # Check for exact match first
            decay_info = decay_data.get(nuclide)
            
            # Try without metastable state indicator if not found
            if not decay_info and '_m1' in nuclide:
                decay_info = decay_data.get(nuclide.replace('_m1', ''))
            if not decay_info and '_m' in nuclide:
                base_name = nuclide.split('_')[0]
                decay_info = decay_data.get(base_name)
            
            if decay_info:
                half_life = decay_info['half_life']  # seconds
                decay_energy = decay_info['decay_energy']  # MeV per decay
                
                # Decay constant λ (1/s)
                decay_constant = LN2 / half_life
                
                # Number of atoms at each timestep (already total atoms from 'number' dataset)
                N = concentrations[:, i]  # atoms
                
                # Activity in Becquerels (decays/second)
                activity_bq = N * decay_constant
                
                # Activity in Curies (1 Ci = 3.7e10 Bq)
                activity_ci = activity_bq / 3.7e10
                
                # Decay heat in Watts
                # 1 eV = 1.602e-19 J, 1 MeV = 1.602e-13 J
                # Power = Activity * Energy per decay
                decay_heat_w = activity_bq * decay_energy * 1.602e-13
                
                nuclide_activity.append({
                    'nuclide': nuclide,
                    'halfLife': half_life,
                    'activityBq': activity_bq.tolist(),
                    'activityCi': activity_ci.tolist(),
                    'decayHeat': decay_heat_w.tolist()
                })
                
                total_activity_bq += activity_bq
                total_activity_ci += activity_ci
                total_decay_heat += decay_heat_w
        
        return {
            'nuclides': nuclide_activity,
            'totalActivityBq': total_activity_bq.tolist(),
            'totalActivityCi': total_activity_ci.tolist(),
            'totalDecayHeat': total_decay_heat.tolist()
        }


def check_openmc_available() -> Tuple[bool, str]:
    """
    Check if OpenMC Python module is available.
    
    Returns:
        Tuple of (is_available, message)
    """
    try:
        import h5py
        return True, "h5py available for reading OpenMC files"
    except ImportError:
        return False, "h5py not installed. Run: pip install h5py"


# CLI interface for testing
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python openmc_integration.py <statepoint.h5> [tally_id]")
        print("\nChecking OpenMC reader availability:")
        available, msg = check_openmc_available()
        print(f"  {msg}")
        sys.exit(0 if available else 1)
    
    statepoint_file = sys.argv[1]
    
    reader = OpenMCReader()
    
    # Load statepoint info
    print(f"Loading statepoint: {statepoint_file}")
    info = reader.load_statepoint(statepoint_file)
    print(f"\nSimulation Info:")
    print(f"  Batches: {info['batches']}")
    if 'k_eff' in info:
        print(f"  k-effective: {info['k_eff']:.5f} ± {info['k_eff_std']:.5f}")
    print(f"  Tallies: {info['n_tallies']}")
    
    # List tallies
    if info['n_tallies'] > 0:
        print(f"\nTallies:")
        tallies = reader.list_tallies(statepoint_file)
        for t in tallies:
            print(f"  Tally {t['id']}: {t['name']}")
            print(f"    Scores: {', '.join(t['scores'])}")
            print(f"    Nuclides: {', '.join(t['nuclides'])}")
            print(f"    Has mesh: {t['has_mesh']}")
    
    # Load specific tally if requested
    if len(sys.argv) > 2 and info['n_tallies'] > 0:
        tally_id = int(sys.argv[2])
        print(f"\nLoading tally {tally_id}...")
        tally = reader.load_tally(statepoint_file, tally_id)
        print(f"Loaded tally: {tally.name}")
        print(f"  Mean shape: {tally.mean.shape}")
        print(f"  Mean range: [{tally.mean.min():.6e}, {tally.mean.max():.6e}]")
        
        if tally.has_mesh:
            print(f"  Mesh dimensions: {tally.mesh_info['dimensions']}")