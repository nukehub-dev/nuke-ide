"""
OpenMC VTK Export and Geometry Utilities

Industry-standard approach using OpenMC's native API for:
- Mesh tally VTK export via write_data_to_vtk()
- Statepoint loading via openmc.StatePoint
- Geometry discovery from run folders
- Cell tally mapping to geometry

This replaces the manual h5py parsing and VTK grid construction
with OpenMC's officially supported APIs.
"""

import os
import sys
import json
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any, Union
from dataclasses import dataclass, field
import numpy as np

# OpenMC is required for this module
try:
    import openmc
    HAS_OPENMC = True
except ImportError:
    HAS_OPENMC = False
    print("Warning: OpenMC Python module not available. VTK export disabled.", file=sys.stderr)


@dataclass
class TallyInfo:
    """Standardized tally information."""
    id: int
    name: str
    scores: List[str]
    nuclides: List[str]
    filters: List[Dict[str, Any]]
    has_mesh: bool = False
    mesh_type: Optional[str] = None
    mesh_dimensions: Optional[Tuple] = None
    mesh_bounds: Optional[Dict[str, Tuple[float, float]]] = None


@dataclass
class MeshTallyData:
    """Exported mesh tally data."""
    tally_id: int
    tally_name: str
    score: str
    nuclide: str
    vtk_path: str
    mesh_type: str
    dimensions: Tuple
    bounds: Dict[str, Tuple[float, float]]
    data_range: Tuple[float, float]
    datasets: List[str] = field(default_factory=list)


@dataclass
class CellTallyData:
    """Cell tally data for overlay."""
    tally_id: int
    tally_name: str
    score: str
    nuclide: str
    cell_values: Dict[int, float]
    cell_errors: Dict[int, float]


class OpenMCVTKExporter:
    """
    Export OpenMC tallies to VTK using OpenMC's native API.
    
    This is the industry-recommended approach as it:
    1. Uses OpenMC's official write_data_to_vtk() for mesh tallies
    2. Handles all mesh types (Regular, Cylindrical, Rectilinear, Spherical)
    3. Correctly handles multi-filter tallies via get_reshaped_data()
    4. Eliminates manual grid construction bugs
    """
    
    def __init__(self, statepoint_path: str):
        if not HAS_OPENMC:
            raise RuntimeError("OpenMC Python module is required but not available")
        
        self.statepoint_path = statepoint_path
        self.statepoint = openmc.StatePoint(statepoint_path)
        self._tallies_cache: Dict[int, openmc.Tally] = {}
        self._mesh_cache: Dict[int, openmc.MeshBase] = {}
    
    def list_tallies(self) -> List[TallyInfo]:
        """List all tallies in the statepoint."""
        tallies = []
        for tally_id, tally in self.statepoint.tallies.items():
            info = self._extract_tally_info(tally)
            tallies.append(info)
            self._tallies_cache[tally_id] = tally
        return tallies
    
    def get_tally(self, tally_id: int) -> openmc.Tally:
        """Get a tally by ID, with caching."""
        if tally_id not in self._tallies_cache:
            self._tallies_cache[tally_id] = self.statepoint.tallies[tally_id]
        return self._tallies_cache[tally_id]
    
    def export_mesh_tally(
        self,
        tally_id: int,
        score: Optional[str] = None,
        nuclide: Optional[str] = None,
        output_dir: Optional[str] = None,
        filename: Optional[str] = None
    ) -> MeshTallyData:
        """
        Export a mesh tally to VTK using OpenMC's native write_data_to_vtk().
        
        Args:
            tally_id: Tally ID
            score: Score to export (default: first score)
            nuclide: Nuclide to export (default: first nuclide or 'total')
            output_dir: Directory for output (default: same as statepoint)
            filename: Output filename (default: auto-generated)
            
        Returns:
            MeshTallyData with path and metadata
        """
        tally = self.get_tally(tally_id)
        
        # Find mesh filter
        mesh_filter = self._get_mesh_filter(tally)
        if mesh_filter is None:
            raise ValueError(f"Tally {tally_id} does not have a mesh filter")
        
        mesh = mesh_filter.mesh
        
        # Resolve score and nuclide indices
        score_idx, score_name = self._resolve_score(tally, score)
        nuclide_idx, nuclide_name = self._resolve_nuclide(tally, nuclide)
        
        # Extract data for this score/nuclide combination
        # Use get_reshaped_data with expand_dims for proper multi-dimensional handling
        data = tally.get_reshaped_data(expand_dims=True).squeeze()
        
        # The shape should be (mesh_dims..., n_scores, n_nuclides) or similar
        # We need to extract the specific score and nuclide
        # Build indexing dynamically based on data shape
        indices = [slice(None)] * data.ndim
        
        # Find score and nuclide axes (typically last two)
        score_axis = None
        nuclide_axis = None
        
        # The tally mean shape from StatePoint is (filter_bins..., n_scores, n_nuclides)
        # After squeeze, we need to identify which axes are scores and nuclides
        shape = data.shape
        
        # Try to match mesh dimensions to shape
        mesh_dims = tuple(mesh.dimension)
        if len(shape) >= 2:
            # Last two axes are typically scores and nuclides
            if shape[-2] == len(tally.scores):
                score_axis = -2
            if shape[-1] == len(tally.nuclides):
                nuclide_axis = -1
        
        if score_axis is not None:
            indices[score_axis] = score_idx
        if nuclide_axis is not None:
            indices[nuclide_axis] = nuclide_idx
        
        # Extract the data for this score/nuclide
        extracted_data = data[tuple(indices)]
        
        # Ensure shape matches mesh dimensions
        if extracted_data.shape != mesh_dims:
            # Try reshaping if total size matches
            if extracted_data.size == np.prod(mesh_dims):
                extracted_data = extracted_data.reshape(mesh_dims)
            else:
                raise ValueError(
                    f"Data shape {extracted_data.shape} does not match mesh dimensions {mesh_dims}"
                )
        
        # Determine output path
        if output_dir is None:
            output_dir = os.path.dirname(self.statepoint_path)
        
        if filename is None:
            filename = f"tally_{tally_id}_{score_name}_{nuclide_name}.vtk"
        
        output_path = os.path.join(output_dir, filename)
        
        # Export using OpenMC's native method
        # Provide datasets dict with meaningful names
        datasets = {
            f'{score_name}-mean': extracted_data,
        }
        
        # Also export std_dev if available
        if hasattr(tally, 'std_dev') and tally.std_dev is not None:
            std_data = tally.get_reshaped_data(value='std_dev', expand_dims=True).squeeze()
            std_extracted = std_data[tuple(indices)]
            if std_extracted.shape != mesh_dims:
                std_extracted = std_extracted.reshape(mesh_dims)
            datasets[f'{score_name}-std-dev'] = std_extracted
        
        mesh.write_data_to_vtk(output_path, datasets=datasets)
        
        # Get data range
        data_range = (float(extracted_data.min()), float(extracted_data.max()))
        
        # Get mesh bounds
        bounds = self._get_mesh_bounds(mesh)
        
        return MeshTallyData(
            tally_id=tally_id,
            tally_name=tally.name,
            score=score_name,
            nuclide=nuclide_name,
            vtk_path=output_path,
            mesh_type=type(mesh).__name__,
            dimensions=mesh_dims,
            bounds=bounds,
            data_range=data_range,
            datasets=list(datasets.keys())
        )
    
    def export_all_mesh_tallies(
        self,
        output_dir: Optional[str] = None
    ) -> List[MeshTallyData]:
        """Export all mesh tallies in the statepoint."""
        results = []
        for tally_id, tally in self.statepoint.tallies.items():
            if any(isinstance(f, openmc.MeshFilter) for f in tally.filters):
                for score in tally.scores:
                    for nuclide in tally.nuclides:
                        try:
                            data = self.export_mesh_tally(
                                tally_id, score=score, nuclide=nuclide,
                                output_dir=output_dir
                            )
                            results.append(data)
                        except Exception as e:
                            print(f"Warning: Failed to export tally {tally_id} {score}/{nuclide}: {e}", 
                                  file=sys.stderr)
        return results
    
    def get_cell_tally_data(
        self,
        tally_id: int,
        score: Optional[str] = None,
        nuclide: Optional[str] = None
    ) -> CellTallyData:
        """
        Extract cell tally data for overlay on geometry.
        
        Returns cell IDs mapped to tally values.
        """
        tally = self.get_tally(tally_id)
        
        # Find cell filter
        cell_filter = None
        for f in tally.filters:
            if isinstance(f, openmc.CellFilter):
                cell_filter = f
                break
        
        if cell_filter is None:
            raise ValueError(f"Tally {tally_id} does not have a cell filter")
        
        # Resolve score and nuclide
        score_idx, score_name = self._resolve_score(tally, score)
        nuclide_idx, nuclide_name = self._resolve_nuclide(tally, nuclide)
        
        # Get cell bins
        cell_ids = cell_filter.bins
        
        # Extract data
        # tally.mean shape: (n_filter_bins, n_scores, n_nuclides)
        mean = tally.mean
        std_dev = tally.std_dev if hasattr(tally, 'std_dev') else None
        
        cell_values = {}
        cell_errors = {}
        
        for i, cell_id in enumerate(cell_ids):
            # Extract value for this cell, score, nuclide
            if mean.ndim == 3:
                value = mean[i, score_idx, nuclide_idx]
                error = std_dev[i, score_idx, nuclide_idx] if std_dev is not None else 0.0
            elif mean.ndim == 2:
                value = mean[i, score_idx]
                error = std_dev[i, score_idx] if std_dev is not None else 0.0
            else:
                value = mean[i]
                error = std_dev[i] if std_dev is not None else 0.0
            
            cell_values[int(cell_id)] = float(value)
            cell_errors[int(cell_id)] = float(error)
        
        return CellTallyData(
            tally_id=tally_id,
            tally_name=tally.name,
            score=score_name,
            nuclide=nuclide_name,
            cell_values=cell_values,
            cell_errors=cell_errors
        )
    
    def find_geometry_file(self, run_dir: Optional[str] = None) -> Optional[str]:
        """
        Find the geometry file associated with this statepoint.
        
        Searches in order:
        1. Same directory as statepoint for geometry.h5m
        2. Same directory for geometry.xml
        3. Parent directories
        """
        if run_dir is None:
            run_dir = os.path.dirname(self.statepoint_path)
        
        # Search for geometry files
        candidates = [
            os.path.join(run_dir, 'geometry.h5m'),
            os.path.join(run_dir, 'geometry.xml'),
        ]
        
        # Also search parent directories
        parent = run_dir
        for _ in range(3):  # Search up to 3 levels up
            candidates.extend([
                os.path.join(parent, 'geometry.h5m'),
                os.path.join(parent, 'geometry.xml'),
            ])
            parent = os.path.dirname(parent)
        
        for path in candidates:
            if os.path.exists(path):
                return path
        
        return None
    
    def _get_mesh_filter(self, tally: openmc.Tally) -> Optional[openmc.MeshFilter]:
        """Get the mesh filter from a tally."""
        for f in tally.filters:
            if isinstance(f, openmc.MeshFilter):
                return f
        return None
    
    def _resolve_score(self, tally: openmc.Tally, score: Optional[str]) -> Tuple[int, str]:
        """Resolve score index and name."""
        scores = tally.scores
        if not scores:
            return 0, 'total'
        
        if score is None:
            return 0, scores[0]
        
        try:
            idx = scores.index(score)
            return idx, score
        except ValueError:
            # Try matching case-insensitively
            for i, s in enumerate(scores):
                if s.lower() == score.lower():
                    return i, s
            print(f"Warning: Score '{score}' not found in tally, using first score '{scores[0]}'", 
                  file=sys.stderr)
            return 0, scores[0]
    
    def _resolve_nuclide(self, tally: openmc.Tally, nuclide: Optional[str]) -> Tuple[int, str]:
        """Resolve nuclide index and name."""
        nuclides = tally.nuclides
        if not nuclides:
            return 0, 'total'
        
        if nuclide is None:
            return 0, nuclides[0]
        
        try:
            idx = nuclides.index(nuclide)
            return idx, nuclide
        except ValueError:
            print(f"Warning: Nuclide '{nuclide}' not found in tally, using first nuclide '{nuclides[0]}'", 
                  file=sys.stderr)
            return 0, nuclides[0]
    
    def _extract_tally_info(self, tally: openmc.Tally) -> TallyInfo:
        """Extract standardized tally info."""
        has_mesh = False
        mesh_type = None
        mesh_dims = None
        mesh_bounds = None
        
        for f in tally.filters:
            if isinstance(f, openmc.MeshFilter):
                has_mesh = True
                mesh = f.mesh
                mesh_type = type(mesh).__name__
                mesh_dims = tuple(mesh.dimension)
                mesh_bounds = self._get_mesh_bounds(mesh)
                break
        
        filters_info = []
        for f in tally.filters:
            f_info = {'type': type(f).__name__}
            if hasattr(f, 'bins'):
                f_info['bins'] = len(f.bins) if hasattr(f.bins, '__len__') else 1
            filters_info.append(f_info)
        
        return TallyInfo(
            id=tally.id,
            name=tally.name,
            scores=list(tally.scores),
            nuclides=list(tally.nuclides),
            filters=filters_info,
            has_mesh=has_mesh,
            mesh_type=mesh_type,
            mesh_dimensions=mesh_dims,
            mesh_bounds=mesh_bounds
        )
    
    def create_structured_grid(self, tally_id: int, pixelated: bool = False) -> Tuple[Any, str, Tuple[float, float]]:
        """
        Create a VTK structured grid directly from mesh tally data.
        
        This is used by the slice visualization engine instead of
        writing to a file via write_data_to_vtk().
        
        Args:
            tally_id: Tally ID
            pixelated: If True, keep cell data. If False, convert to point data.
        
        Returns:
            Tuple of (vtkStructuredGrid, tally_name, data_range)
        """
        import vtk
        
        tally = self.get_tally(tally_id)
        mesh_filter = self._get_mesh_filter(tally)
        if mesh_filter is None:
            raise ValueError(f"Tally {tally_id} does not have a mesh filter")
        
        mesh = mesh_filter.mesh
        dims = mesh.dimension
        lower_left = np.array(mesh.lower_left)
        upper_right = np.array(mesh.upper_right)
        
        # Get tally data
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

    def _get_mesh_bounds(self, mesh: openmc.MeshBase) -> Dict[str, Tuple[float, float]]:
        """Get mesh spatial bounds."""
        bounds = {}
        
        if hasattr(mesh, 'lower_left') and hasattr(mesh, 'upper_right'):
            ll = mesh.lower_left
            ur = mesh.upper_right
            bounds['x'] = (float(ll[0]), float(ur[0]))
            bounds['y'] = (float(ll[1]), float(ur[1]))
            bounds['z'] = (float(ll[2]), float(ur[2]))
        elif hasattr(mesh, 'r_grid') and hasattr(mesh, 'z_grid'):
            # Cylindrical mesh
            r_grid = mesh.r_grid
            z_grid = mesh.z_grid
            bounds['r'] = (float(r_grid[0]), float(r_grid[-1]))
            bounds['z'] = (float(z_grid[0]), float(z_grid[-1]))
            # Phi is always 0 to 2*pi for full cylinder
            bounds['phi'] = (0.0, 2 * np.pi)
        
        return bounds


def export_statepoint_tallies(
    statepoint_path: str,
    output_dir: Optional[str] = None,
    tally_ids: Optional[List[int]] = None
) -> Dict[str, List[MeshTallyData]]:
    """
    Convenience function to export all mesh tallies from a statepoint.
    
    Returns:
        Dict with 'mesh_tallies' and 'errors' keys
    """
    exporter = OpenMCVTKExporter(statepoint_path)
    
    if output_dir is None:
        output_dir = os.path.dirname(statepoint_path)
    
    os.makedirs(output_dir, exist_ok=True)
    
    results = []
    errors = []
    
    tallies = exporter.list_tallies()
    
    for tally_info in tallies:
        if not tally_info.has_mesh:
            continue
        
        if tally_ids is not None and tally_info.id not in tally_ids:
            continue
        
        try:
            for score in tally_info.scores:
                for nuclide in tally_info.nuclides:
                    data = exporter.export_mesh_tally(
                        tally_info.id,
                        score=score,
                        nuclide=nuclide,
                        output_dir=output_dir
                    )
                    results.append(data)
        except Exception as e:
            errors.append(f"Tally {tally_info.id}: {e}")
    
    return {
        'mesh_tallies': results,
        'errors': errors
    }


if __name__ == '__main__':
    # CLI test
    import argparse
    parser = argparse.ArgumentParser(description='Export OpenMC tallies to VTK')
    parser.add_argument('statepoint', help='Path to statepoint file')
    parser.add_argument('--output-dir', help='Output directory')
    parser.add_argument('--tally-id', type=int, help='Specific tally ID to export')
    args = parser.parse_args()
    
    exporter = OpenMCVTKExporter(args.statepoint)
    
    print(f"Statepoint: {args.statepoint}")
    print(f"Tallies:")
    for info in exporter.list_tallies():
        print(f"  Tally {info.id}: {info.name}")
        print(f"    Scores: {info.scores}")
        print(f"    Has mesh: {info.has_mesh}")
        if info.has_mesh:
            print(f"    Mesh type: {info.mesh_type}")
            print(f"    Dimensions: {info.mesh_dimensions}")
    
    if args.tally_id:
        data = exporter.export_mesh_tally(args.tally_id, output_dir=args.output_dir)
        print(f"\nExported to: {data.vtk_path}")
        print(f"Data range: {data.data_range}")
