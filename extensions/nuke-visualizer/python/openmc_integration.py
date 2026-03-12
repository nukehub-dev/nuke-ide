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
            
        print(f"[OpenMC Debug] _parse_filter_full: type={filter_type}", file=sys.stderr)
        
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
                print(f"[OpenMC Debug] Found mesh_id: {mesh_id}", file=sys.stderr)
            else:
                print(f"[OpenMC Debug] No 'bins' in filter_obj, keys: {list(filter_obj.keys())}", file=sys.stderr)
                    
            if mesh_id is not None and f is not None and 'tallies' in f and 'meshes' in f['tallies']:
                mesh_key = f'mesh {mesh_id}'
                print(f"[OpenMC Debug] Looking for mesh: {mesh_key}", file=sys.stderr)
                if mesh_key in f['tallies']['meshes']:
                    mesh_obj = f['tallies']['meshes'][mesh_key]
                    mesh_info = {}
                    
                    # Debug: show available keys
                    print(f"[OpenMC Debug] Mesh object keys: {list(mesh_obj.keys())}", file=sys.stderr)
                    
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
                    print(f"[OpenMC Debug] Mesh info: type={mesh_info.get('mesh_type')}, dims={mesh_info.get('dimensions')}", file=sys.stderr)
                else:
                    available_meshes = list(f['tallies']['meshes'].keys())
                    print(f"[OpenMC Debug] WARNING: mesh {mesh_id} not found in meshes group", file=sys.stderr)
                    print(f"[OpenMC Debug] Available meshes: {available_meshes}", file=sys.stderr)
            else:
                print(f"[OpenMC Debug] WARNING: mesh_id={mesh_id}, f is None: {f is None}", file=sys.stderr)
                if f is not None:
                    print(f"[OpenMC Debug] 'tallies' in f: {'tallies' in f}, 'meshes' in f.get('tallies', {{}}): {'meshes' in f.get('tallies', {})}", file=sys.stderr)
                
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
        
        print(f"[OpenMC] Creating cylindrical mesh: {nr} radial x {nphi} azimuthal x {nz} axial cells", file=sys.stderr)
        
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
                                score: str = 'flux') -> Dict[str, np.ndarray]:
        """
        Extract energy spectrum from an energy-filtered tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            score: Score to extract (default 'flux')
            
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
            
            filters_group = tally['filters']
            energy_filter = None
            
            for filter_key in filters_group.keys():
                filter_obj = filters_group[filter_key]
                filter_type = filter_obj.attrs.get('type', '')
                if isinstance(filter_type, bytes):
                    filter_type = filter_type.decode('utf-8')
                
                if filter_type == 'energy':
                    energy_filter = filter_obj
                    break
            
            if energy_filter is None:
                raise ValueError("No energy filter found in tally")
            
            # Get energy bins
            bins = energy_filter['bins'][...]
            
            # Get results
            results = tally['results'][...]
            mean = results[..., 0]
            
            return {
                'energy_bins': bins,
                'values': mean.flatten(),
                'std_dev': results[..., 1].flatten()
            }
    
    @staticmethod
    def create_spatial_plot(statepoint_file: str, tally_id: int,
                            axis: str = 'z') -> Dict[str, np.ndarray]:
        """
        Create 1D spatial plot from a mesh tally.
        
        Args:
            statepoint_file: Path to statepoint.h5
            tally_id: Tally ID
            axis: Axis to plot along ('x', 'y', or 'z')
            
        Returns:
            Dictionary with axis positions and values
        """
        reader = OpenMCReader()
        tally = reader.load_tally(statepoint_file, tally_id)
        
        if not tally.has_mesh:
            raise ValueError("Tally is not a mesh tally")
        
        mesh = tally.mesh_info
        nx, ny, nz = mesh['dimensions']
        dx, dy, dz = mesh['width']
        
        # Calculate cell centers
        x_centers = np.linspace(
            mesh['lower_left'][0] + dx/2,
            mesh['upper_right'][0] - dx/2,
            nx
        )
        y_centers = np.linspace(
            mesh['lower_left'][1] + dy/2,
            mesh['upper_right'][1] - dy/2,
            ny
        )
        z_centers = np.linspace(
            mesh['lower_left'][2] + dz/2,
            mesh['upper_right'][2] - dz/2,
            nz
        )
        
        # Isolate Single Score/Nuclide
        mean_flat = tally.mean.flatten()
        n_scores = len(tally.scores) if tally.scores else 1
        n_nuclides = len(tally.nuclides) if tally.nuclides else 1
        
        if len(mean_flat) == nx * ny * nz * n_scores * n_nuclides:
            data = mean_flat[0::n_scores]
            if n_nuclides > 1:
                data = data[0::n_nuclides]
        else:
            data = mean_flat[:nx * ny * nz]
        
        # Reshape mean array
        mean_3d = data.reshape((nz, ny, nx))
        
        # Sum over other axes
        if axis == 'x':
            values = mean_3d.sum(axis=(0, 1))  # Sum over y and z
            positions = x_centers
        elif axis == 'y':
            values = mean_3d.sum(axis=(0, 2))  # Sum over x and z
            positions = y_centers
        else:  # z
            values = mean_3d.sum(axis=(1, 2))  # Sum over x and y
            positions = z_centers
        
        return {
            'positions': positions,
            'values': values,
            'axis': axis
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