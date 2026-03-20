#!/usr/bin/env python3
"""
Geometry Overlap Checker integration for NukeIDE.

Uses OpenMC's built-in overlap detection to find geometry errors.
Reference: https://docs.openmc.org/en/stable/pythonapi/generated/openmc.Geometry.html
"""

import json
import sys
import time
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any, Callable
from dataclasses import dataclass, asdict
import numpy as np


@dataclass
class OverlapResult:
    """Represents a detected overlap at a specific coordinate."""
    coordinates: Tuple[float, float, float]
    cell_ids: List[int]
    cell_names: List[str]
    
    def to_dict(self) -> Dict:
        return {
            'coordinates': list(self.coordinates),
            'cellIds': self.cell_ids,
            'cellNames': self.cell_names,
            'overlapCount': len(self.cell_ids)
        }


@dataclass
class OverlapProgress:
    """Progress update for overlap check."""
    checked: int
    total: int
    percentage: float
    current_overlaps: List[OverlapResult]
    complete: bool = False
    error: Optional[str] = None
    
    def to_dict(self) -> Dict:
        return {
            'checked': self.checked,
            'total': self.total,
            'percentage': self.percentage,
            'currentOverlaps': [o.to_dict() for o in self.current_overlaps],
            'complete': self.complete,
            'error': self.error
        }


@dataclass
class BoundingBox:
    """Bounding box for limiting check region."""
    min: Tuple[float, float, float]
    max: Tuple[float, float, float]
    
    def to_dict(self) -> Dict:
        return {'min': list(self.min), 'max': list(self.max)}
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'BoundingBox':
        return cls(
            min=tuple(data['min']),
            max=tuple(data['max'])
        )


class OverlapChecker:
    """Geometry overlap checker using OpenMC's find_overlaps()."""
    
    def __init__(self, geometry_path: str):
        """
        Initialize overlap checker.
        
        Args:
            geometry_path: Path to geometry.xml or OpenMC Python model
        """
        self.geometry_path = geometry_path
        self.geometry = None
        self._geometry_dir = Path(geometry_path).parent
        self._load_geometry()
    
    def _load_geometry(self) -> None:
        """Load geometry from XML or Python file."""
        import openmc
        
        path = Path(self.geometry_path)
        
        # Save original working directory
        original_cwd = os.getcwd()
        
        try:
            # Change to the directory containing the geometry file
            # This ensures that relative paths (like materials.xml) are resolved correctly
            os.chdir(path.parent)
            
            if path.suffix == '.py':
                # Load from Python script
                import importlib.util
                spec = importlib.util.spec_from_file_location("openmc_model", path)
                module = importlib.util.module_from_spec(spec)
                
                # Execute the script
                spec.loader.exec_module(module)
                
                # Try to find the geometry object
                if hasattr(module, 'geometry'):
                    self.geometry = module.geometry
                elif hasattr(module, 'geom'):
                    self.geometry = module.geom
                else:
                    # Try to find any Geometry object
                    for attr_name in dir(module):
                        attr = getattr(module, attr_name)
                        if isinstance(attr, openmc.Geometry):
                            self.geometry = attr
                            break
                    
                    if self.geometry is None:
                        raise ValueError(f"No OpenMC Geometry found in {path}")
            else:
                # Load from XML
                self.geometry = openmc.Geometry.from_xml(path.name)
        finally:
            # Restore original working directory
            os.chdir(original_cwd)
    
    def find_overlaps(
        self,
        sample_points: int = 100000,
        tolerance: float = 1e-6,
        bounds: Optional[BoundingBox] = None,
        parallel: bool = False,
        progress_callback: Optional[Callable[[OverlapProgress], None]] = None
    ) -> List[OverlapResult]:
        """
        Run OpenMC overlap detection.
        
        Args:
            sample_points: Number of sample points to check
            tolerance: Numerical tolerance for overlap detection
            bounds: Bounding box to limit check region (optional)
            parallel: Whether to use parallel processing
            progress_callback: Optional callback for progress updates
            
        Returns:
            List of detected overlaps
        """
        import openmc
        
        if self.geometry is None:
            raise ValueError("Geometry not loaded")
        
        # Save original working directory and change to geometry directory
        original_cwd = os.getcwd()
        os.chdir(self._geometry_dir)
        
        start_time = time.time()
        overlaps_found = []
        
        try:
            # Determine bounding box for sampling
            sampling_bounds = None
            if bounds:
                sampling_bounds = (bounds.min, bounds.max)
            
            # Use OpenMC's optimized find_overlaps method
            try:
                # OpenMC 0.13.0+ find_overlaps returns a list of (cell1, cell2, point)
                raw_overlaps = self.geometry.find_overlaps(
                    n_samples=sample_points,
                    tolerance=tolerance,
                    bbox=sampling_bounds
                )
                
                # Convert to our format
                for cell1, cell2, point in raw_overlaps:
                    overlap = OverlapResult(
                        coordinates=tuple(point.tolist()),
                        cell_ids=[cell1.id, cell2.id],
                        cell_names=[
                            getattr(cell1, 'name', f'Cell {cell1.id}'),
                            getattr(cell2, 'name', f'Cell {cell2.id}')
                        ]
                    )
                    overlaps_found.append(overlap)
                
                # Final progress update
                if progress_callback:
                    progress = OverlapProgress(
                        checked=sample_points,
                        total=sample_points,
                        percentage=100.0,
                        current_overlaps=overlaps_found,
                        complete=True
                    )
                    progress_callback(progress)
                    
            except Exception as e:
                print(f"[OverlapChecker] Warning: Built-in find_overlaps failed: {e}. Falling back to manual search.", file=sys.stderr)
                # Fallback to manual search
                overlaps_found = self._find_overlaps_manual(
                    sample_points, tolerance, bounds, progress_callback
                )
            
            elapsed = time.time() - start_time
            print(f"[OverlapChecker] Found {len(overlaps_found)} overlaps in {elapsed:.1f}s", 
                  file=sys.stderr)
            
            return overlaps_found
            
        except Exception as e:
            if progress_callback:
                progress = OverlapProgress(
                    checked=0,
                    total=sample_points,
                    percentage=0.0,
                    current_overlaps=[],
                    complete=True,
                    error=str(e)
                )
                progress_callback(progress)
            raise
        finally:
            # Restore original working directory
            os.chdir(original_cwd)

    def _find_overlaps_manual(
        self,
        sample_points: int,
        tolerance: float,
        bounds: Optional[BoundingBox],
        progress_callback: Optional[Callable[[OverlapProgress], None]]
    ) -> List[OverlapResult]:
        """Manual overlap search as a fallback."""
        overlaps_found = []
        
        # Determine bounding box
        if bounds is None:
            bbox = self.geometry.bounding_box
            if bbox is None or any(np.isinf(bbox[0])) or any(np.isinf(bbox[1])):
                bounds = BoundingBox(min=(-100.0, -100.0, -100.0), max=(100.0, 100.0, 100.0))
            else:
                bounds = BoundingBox(min=tuple(bbox[0]), max=tuple(bbox[1]))
        
        # Generate sample points
        rng = np.random.default_rng(seed=42)
        xmin, ymin, zmin = bounds.min
        xmax, ymax, zmax = bounds.max
        
        samples = rng.uniform(
            low=[xmin, ymin, zmin],
            high=[xmax, ymax, zmax],
            size=(sample_points, 3)
        )
        
        batch_size = max(1, sample_points // 100)
        root_univ = self.geometry.root_universe
        
        for i, point in enumerate(samples):
            cells_found = []
            cell_names = []
            
            try:
                # Find all cells containing this point
                # This fallback is limited as find_cell only returns one cell.
                # A true manual check would iterate through all cells.
                for cell_id, cell in root_univ.cells.items():
                    if point in cell:
                        cells_found.append(cell_id)
                        cell_names.append(getattr(cell, 'name', f'Cell {cell_id}'))
            except Exception:
                continue
                
            if len(cells_found) > 1:
                overlap = OverlapResult(
                    coordinates=tuple(point.tolist()),
                    cell_ids=cells_found,
                    cell_names=cell_names
                )
                overlaps_found.append(overlap)
            
            if progress_callback and (i + 1) % batch_size == 0:
                progress = OverlapProgress(
                    checked=i + 1,
                    total=sample_points,
                    percentage=round((i + 1) / sample_points * 100, 1),
                    current_overlaps=overlaps_found.copy(),
                    complete=False
                )
                progress_callback(progress)
                
        return overlaps_found

    def get_overlap_viz_data(
        self,
        overlaps: List[OverlapResult],
        marker_size: float = 1.0
    ) -> Dict:
        """Generate visualization data for overlaps."""
        markers = []
        overlapping_cell_ids = set()
        
        for overlap in overlaps:
            markers.append({
                'coordinates': list(overlap.coordinates),
                'cellIds': overlap.cell_ids,
                'radius': marker_size
            })
            overlapping_cell_ids.update(overlap.cell_ids)
        
        return {
            'markers': markers,
            'overlappingCellIds': list(overlapping_cell_ids)
        }


def check_overlaps(
    geometry_path: str,
    sample_points: int = 100000,
    tolerance: float = 1e-6,
    bounds: Optional[Dict] = None,
    parallel: bool = False
) -> Dict:
    """Check for overlaps in OpenMC geometry."""
    try:
        # Check if materials.xml exists in the same directory as geometry.xml
        geom_path = Path(geometry_path)
        materials_path = geom_path.parent / 'materials.xml'
        
        # If materials.xml doesn't exist, we need to create a dummy one
        created_dummy_files = []
        
        if not materials_path.exists() and geom_path.suffix != '.py':
            print(f"[OverlapChecker] Creating dummy materials.xml at {materials_path}", file=sys.stderr)
            
            # Scan geometry.xml for all referenced material IDs
            material_ids = set(['1']) # Always include 1 as default
            try:
                import xml.etree.ElementTree as ET
                tree = ET.parse(geom_path)
                root = tree.getroot()
                for cell in root.iter('cell'):
                    mat = cell.get('material')
                    if mat and mat != 'void':
                        material_ids.add(mat)
            except Exception as e:
                print(f"[OverlapChecker] Warning: Could not parse geometry.xml to find material IDs: {e}", file=sys.stderr)
            
            # Create materials.xml with all found IDs
            mats_xml = ['<?xml version="1.0"?>', '<materials>']
            for m_id in sorted(list(material_ids), key=lambda x: int(x) if x.isdigit() else x):
                mats_xml.append(f'  <material id="{m_id}" name="dummy_{m_id}">')
                mats_xml.append('    <density value="1.0" units="g/cm3"/>')
                mats_xml.append('    <nuclide name="H1" ao="1.0"/>')
                mats_xml.append('  </material>')
            mats_xml.append('</materials>')
            
            materials_path.write_text('\n'.join(mats_xml))
            created_dummy_files.append(materials_path)
        
        try:
            checker = OverlapChecker(geometry_path)
            bbox = BoundingBox.from_dict(bounds) if bounds else None
            
            overlaps = checker.find_overlaps(
                sample_points=sample_points,
                tolerance=tolerance,
                bounds=bbox,
                parallel=parallel
            )
            
            return {
                'overlaps': [o.to_dict() for o in overlaps],
                'totalOverlaps': len(overlaps),
                'samplesChecked': sample_points,
                'error': None
            }
        finally:
            # Clean up dummy files
            for f in created_dummy_files:
                try:
                    f.unlink()
                    print(f"[OverlapChecker] Cleaned up dummy file: {f}", file=sys.stderr)
                except Exception:
                    pass
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {
            'overlaps': [],
            'totalOverlaps': 0,
            'samplesChecked': 0,
            'error': str(e)
        }


def get_overlap_viz_data(
    geometry_path: str,
    overlaps: List[Dict],
    marker_size: float = 1.0
) -> Dict:
    """Get visualization data for overlaps."""
    try:
        checker = OverlapChecker(geometry_path)
        
        overlap_results = []
        for o in overlaps:
            overlap_results.append(OverlapResult(
                coordinates=tuple(o['coordinates']),
                cell_ids=o['cellIds'],
                cell_names=o.get('cellNames', [])
            ))
        
        return checker.get_overlap_viz_data(overlap_results, marker_size)
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {
            'markers': [],
            'overlappingCellIds': [],
            'error': str(e)
        }


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Check for geometry overlaps')
    parser.add_argument('geometry', help='Path to geometry.xml or model file')
    parser.add_argument('--samples', type=int, default=10000, help='Number of sample points')
    parser.add_argument('--tolerance', type=float, default=1e-6, help='Numerical tolerance')
    parser.add_argument('--output', help='Output file for results')
    
    args = parser.parse_args()
    
    def progress_callback(progress: OverlapProgress):
        print(f"Progress: {progress.percentage}% ({progress.checked}/{progress.total}) - Found {len(progress.current_overlaps)} overlaps", file=sys.stderr)
    
    checker = OverlapChecker(args.geometry)
    overlaps = checker.find_overlaps(
        sample_points=args.samples,
        tolerance=args.tolerance,
        progress_callback=progress_callback
    )
    
    result = {
        'overlaps': [o.to_dict() for o in overlaps],
        'totalOverlaps': len(overlaps)
    }
    
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
    else:
        print(json.dumps(result, indent=2))
