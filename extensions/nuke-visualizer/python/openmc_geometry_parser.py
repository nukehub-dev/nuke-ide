#!/usr/bin/env python3
"""
OpenMC Geometry Parser for NukeIDE.
Parses OpenMC geometry.xml files and extracts CSG hierarchy.
"""

import xml.etree.ElementTree as ET
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field, asdict


@dataclass
class Surface:
    """Represents an OpenMC surface."""
    id: int
    type: str
    coefficients: List[float] = field(default_factory=list)
    boundary: str = 'transmission'
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'type': self.type,
            'coefficients': self.coefficients,
            'boundary': self.boundary,
            'description': self._get_description()
        }
    
    def _get_description(self) -> str:
        """Generate human-readable description."""
        coeff_str = ', '.join(f'{c:.4g}' for c in self.coefficients)
        return f"{self.type}({coeff_str})"


@dataclass
class Cell:
    """Represents an OpenMC cell."""
    id: int
    name: str = ''
    region: str = ''
    fill_type: str = 'void'
    fill_id: Optional[int] = None
    material_name: str = ''
    surfaces: List[int] = field(default_factory=list)
    temperature: Optional[float] = None
    density: Optional[float] = None
    universe: int = 0  # Universe this cell belongs to
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name or f'Cell {self.id}',
            'region': self.region,
            'fillType': self.fill_type,
            'fillId': self.fill_id,
            'materialName': self.material_name,
            'surfaces': self.surfaces,
            'temperature': self.temperature,
            'density': self.density,
            'universe': self.universe
        }


@dataclass
class Lattice:
    """Represents an OpenMC lattice."""
    id: int
    name: str = ''
    type: str = 'rect'
    lower_left: List[float] = field(default_factory=list)
    pitch: List[float] = field(default_factory=list)
    dimensions: List[int] = field(default_factory=list)
    universes: List[List[List[int]]] = field(default_factory=list)
    outer: Optional[int] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name or f'Lattice {self.id}',
            'type': self.type,
            'lowerLeft': self.lower_left,
            'pitch': self.pitch,
            'dimensions': self.dimensions,
            'universes': self.universes,
            'outer': self.outer
        }


@dataclass
class Universe:
    """Represents an OpenMC universe."""
    id: int
    name: str = ''
    cells: List[Cell] = field(default_factory=list)
    is_root: bool = False
    
    @property
    def n_cells(self) -> int:
        return len(self.cells)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name or f'Universe {self.id}',
            'isRoot': self.is_root,
            'cells': [c.to_dict() for c in self.cells],
            'nCells': self.n_cells
        }


class OpenMCGeometryParser:
    """Parser for OpenMC geometry.xml files."""
    
    # Surface type mapping from OpenMC XML
    SURFACE_TYPES = {
        'sphere': 'sphere',
        'x-cylinder': 'x-cylinder',
        'y-cylinder': 'y-cylinder',
        'z-cylinder': 'z-cylinder',
        'cylinder': 'cylinder',
        'x-plane': 'x-plane',
        'y-plane': 'y-plane',
        'z-plane': 'z-plane',
        'plane': 'plane',
        'x-cone': 'x-cone',
        'y-cone': 'y-cone',
        'z-cone': 'z-cone',
        'x-torus': 'x-torus',
        'y-torus': 'y-torus',
        'z-torus': 'z-torus',
        'quadric': 'quadric',
    }
    
    def __init__(self):
        self.surfaces: Dict[int, Surface] = {}
        self.cells: Dict[int, Cell] = {}
        self.universes: Dict[int, Universe] = {}
        self.lattices: Dict[int, Lattice] = {}
        self.materials: Dict[int, str] = {}  # id -> name
        self.root_universe_id: Optional[int] = None
    
    def parse(self, file_path: str) -> Dict[str, Any]:
        """
        Parse an OpenMC geometry file.
        
        Supports:
        - geometry.xml (standard OpenMC geometry file)
        - materials.xml (for material names)
        - model XML files (combined geometry and materials)
        
        Args:
            file_path: Path to the geometry file
            
        Returns:
            Dictionary with geometry hierarchy
        """
        try:
            path = Path(file_path)
            
            if not path.exists():
                return {'error': f'File not found: {file_path}'}
            
            # Check if it's a directory (model directory)
            if path.is_dir():
                return self._parse_model_directory(path)
            
            # Parse based on file extension and name
            file_name = path.name.lower()
            
            # Reject known non-geometry files
            non_geometry_files = ['settings.xml', 'tallies.xml', 'materials.xml', 'plots.xml', 'cmfd.xml']
            if file_name in non_geometry_files:
                return {'error': f'{file_name} is not a geometry file. Please open geometry.xml instead.'}
            
            if file_name == 'geometry.xml':
                return self._parse_geometry_xml(path)
            elif file_name.endswith('.xml'):
                return self._parse_geometry_xml(path)
            elif file_name.endswith('.py'):
                return self._parse_python_model(path)
            else:
                return {'error': f'Unsupported file type: {file_name}'}
                
        except Exception as e:
            import traceback
            return {
                'error': f'Failed to parse geometry: {str(e)}',
                'details': traceback.format_exc()
            }
    
    def _parse_model_directory(self, directory: Path) -> Dict[str, Any]:
        """Parse a model directory containing geometry.xml and materials.xml."""
        geometry_file = directory / 'geometry.xml'
        materials_file = directory / 'materials.xml'
        
        # First load materials if available
        if materials_file.exists():
            self._parse_materials_xml(materials_file)
        
        # Then parse geometry
        if geometry_file.exists():
            return self._parse_geometry_xml(geometry_file)
        else:
            return {'error': f'No geometry.xml found in {directory}'}
    
    def _parse_materials_xml(self, file_path: Path) -> None:
        """Parse materials.xml to get material names."""
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()
            
            for material in root.findall('material'):
                mat_id = int(material.get('id'))
                mat_name = material.get('name', f'Material {mat_id}')
                self.materials[mat_id] = mat_name
        except Exception as e:
            print(f"Warning: Could not parse materials.xml: {e}", file=os.sys.stderr)
    
    def _parse_geometry_xml(self, file_path: Path) -> Dict[str, Any]:
        """Parse geometry.xml file."""
        tree = ET.parse(file_path)
        root = tree.getroot()
        
        # Validate that this is actually a geometry file
        # OpenMC geometry files should have <geometry> as root or contain cell/surface elements
        root_tag = root.tag.lower()
        if root_tag not in ('geometry', 'model'):
            # Check if it has any geometry elements - if not, it's not a geometry file
            has_cells = root.find('cell') is not None
            has_surfaces = root.find('surface') is not None
            has_lattices = root.find('lattice') is not None
            
            if not (has_cells or has_surfaces or has_lattices):
                return {'error': f'Not a valid geometry file. Expected <geometry> root element or geometry elements (cell, surface, lattice), but found <{root.tag}>.'}
        
        # Parse surfaces
        for surface_elem in root.findall('surface'):
            self._parse_surface(surface_elem)
        
        # Parse cells
        for cell_elem in root.findall('cell'):
            self._parse_cell(cell_elem)
        
        # Parse lattices
        for lattice_elem in root.findall('lattice'):
            self._parse_lattice(lattice_elem)
        
        # Organize cells into universes
        self._organize_universes()
        
        # Validate that we found some geometry
        if len(self.cells) == 0:
            return {'error': 'No cells found in geometry file. The file may be empty or not a valid OpenMC geometry file.'}
        
        # Build response
        return self._build_response(str(file_path))
    
    def _parse_surface(self, elem: ET.Element) -> None:
        """Parse a surface element."""
        surf_id = int(elem.get('id'))
        surf_type = elem.get('type', 'unknown').lower()
        
        # Get coefficients based on surface type
        coeffs = []
        coeffs_attr = elem.get('coeffs', '')
        if coeffs_attr:
            coeffs = [float(x) for x in coeffs_attr.split()]
        
        # Map to standard type name
        std_type = self.SURFACE_TYPES.get(surf_type, surf_type)
        
        # Get boundary condition
        boundary = elem.get('boundary', 'transmission')
        
        self.surfaces[surf_id] = Surface(
            id=surf_id,
            type=std_type,
            coefficients=coeffs,
            boundary=boundary
        )
    
    def _parse_cell(self, elem: ET.Element) -> None:
        """Parse a cell element."""
        cell_id = int(elem.get('id'))
        cell_name = elem.get('name', '')
        
        # Get region
        region = elem.get('region', '')
        
        # Get universe ID (default to 0 if not specified)
        universe_id = int(elem.get('universe', '0'))
        
        # Determine fill type and ID
        fill_type = 'void'
        fill_id = None
        material_name = ''
        
        material_attr = elem.get('material')
        fill_attr = elem.get('fill')
        
        if material_attr:
            if material_attr == 'void':
                fill_type = 'void'
            else:
                fill_type = 'material'
                fill_id = int(material_attr)
                material_name = self.materials.get(fill_id, f'Material {fill_id}')
        elif fill_attr:
            fill_type = 'universe'
            fill_id = int(fill_attr)
        
        # Extract surfaces from region
        surfaces = self._extract_surfaces_from_region(region)
        
        # Get temperature
        temperature = None
        temp_attr = elem.get('temperature')
        if temp_attr:
            try:
                temperature = float(temp_attr)
            except ValueError:
                pass
        
        # Get density
        density = None
        density_attr = elem.get('density')
        if density_attr:
            try:
                density = float(density_attr)
            except ValueError:
                pass
        
        self.cells[cell_id] = Cell(
            id=cell_id,
            name=cell_name,
            region=region,
            fill_type=fill_type,
            fill_id=fill_id,
            material_name=material_name,
            surfaces=surfaces,
            temperature=temperature,
            density=density,
            universe=universe_id
        )
    
    def _extract_surfaces_from_region(self, region: str) -> List[int]:
        """Extract surface IDs from a region string."""
        if not region:
            return []
        
        # Match signed integers (e.g., -1, 2, ~3)
        # Pattern: optional ~ or - followed by digits
        surface_ids = []
        tokens = region.replace('(', ' ').replace(')', ' ').replace('|', ' ').replace('&', ' ').split()
        
        for token in tokens:
            # Remove leading ~ (complement operator)
            if token.startswith('~'):
                token = token[1:]
            
            # Try to parse as integer
            try:
                sid = int(token)
                if sid != 0:  # 0 is not a valid surface ID
                    surface_ids.append(abs(sid))
            except ValueError:
                pass
        
        return list(set(surface_ids))  # Remove duplicates
    
    def _parse_lattice(self, elem: ET.Element) -> None:
        """Parse a lattice element."""
        lat_id = int(elem.get('id'))
        lat_name = elem.get('name', '')
        lat_type = elem.get('type', 'rect')
        
        # Get dimensions
        dimensions = []
        dims_attr = elem.get('dimension', elem.get('dimensions', ''))
        if dims_attr:
            dimensions = [int(x) for x in dims_attr.split()]
        
        # Get lower-left
        lower_left = []
        ll_attr = elem.get('lower_left', elem.get('lower-left', ''))
        if ll_attr:
            lower_left = [float(x) for x in ll_attr.split()]
        
        # Get pitch
        pitch = []
        pitch_attr = elem.get('pitch', '')
        if pitch_attr:
            pitch = [float(x) for x in pitch_attr.split()]
        
        # Get outer universe
        outer = None
        outer_attr = elem.get('outer')
        if outer_attr:
            outer = int(outer_attr)
        
        # Get universes
        universes = []
        univ_elem = elem.find('universes')
        if univ_elem is not None and univ_elem.text:
            # Parse 2D or 3D array of universe IDs
            lines = univ_elem.text.strip().split('\n')
            lattice_2d = []
            for line in lines:
                row = [int(x) for x in line.split()]
                lattice_2d.append(row)
            universes = [lattice_2d]  # Wrap in another list for 3D
        
        self.lattices[lat_id] = Lattice(
            id=lat_id,
            name=lat_name,
            type=lat_type,
            lower_left=lower_left,
            pitch=pitch,
            dimensions=dimensions,
            universes=universes,
            outer=outer
        )
    
    def _organize_universes(self) -> None:
        """Organize cells into universes."""
        # Group cells by universe
        cells_by_universe: Dict[int, List[Cell]] = {}
        
        for cell in self.cells.values():
            universe_id = cell.universe
            if universe_id not in cells_by_universe:
                cells_by_universe[universe_id] = []
            cells_by_universe[universe_id].append(cell)
        
        # Create universes
        for univ_id, cells in cells_by_universe.items():
            self.universes[univ_id] = Universe(
                id=univ_id,
                cells=cells,
                is_root=(univ_id == 0)
            )
        
        # If no universe 0, create it as root
        if 0 not in self.universes:
            self.universes[0] = Universe(id=0, is_root=True)
        
        self.root_universe_id = 0
    
    def _parse_python_model(self, file_path: Path) -> Dict[str, Any]:
        """
        Try to parse a Python model file using OpenMC's Python API.
        This requires OpenMC to be installed.
        """
        try:
            import openmc
            
            # Execute the Python file to get the geometry
            # This is a simplified approach - in practice, you'd need to handle
            # imports and execution context carefully
            
            # For safety, we'll use a restricted approach
            local_vars = {}
            global_vars = {'openmc': openmc}
            
            # Read and execute the file
            with open(file_path, 'r') as f:
                code = f.read()
            
            # Execute in isolated namespace
            exec(code, global_vars, local_vars)
            
            # Try to find geometry object
            geometry = None
            for var in local_vars.values():
                if isinstance(var, openmc.Geometry):
                    geometry = var
                    break
            
            if geometry is None:
                return {'error': 'No Geometry object found in Python file'}
            
            # Export to temporary XML and parse
            import tempfile
            import os as os_module
            
            with tempfile.TemporaryDirectory() as tmpdir:
                geometry.export_to_xml(tmpdir)
                geom_file = os_module.path.join(tmpdir, 'geometry.xml')
                mats_file = os_module.path.join(tmpdir, 'materials.xml')
                
                if os_module.path.exists(mats_file):
                    self._parse_materials_xml(Path(mats_file))
                
                return self._parse_geometry_xml(Path(geom_file))
                
        except ImportError:
            return {
                'error': 'OpenMC Python API not available. Install openmc to parse Python model files.',
                'fallback': 'Please export geometry to XML using model.geometry.export_to_xml()'
            }
        except Exception as e:
            import traceback
            return {
                'error': f'Failed to parse Python model: {str(e)}',
                'details': traceback.format_exc()
            }
    
    def _build_response(self, file_path: str) -> Dict[str, Any]:
        """Build the response dictionary."""
        return {
            'filePath': file_path,
            'universes': [u.to_dict() for u in self.universes.values()],
            'surfaces': [s.to_dict() for s in self.surfaces.values()],
            'lattices': [l.to_dict() for l in self.lattices.values()],
            'rootUniverseId': self.root_universe_id,
            'totalCells': len(self.cells),
            'totalSurfaces': len(self.surfaces),
            'totalMaterials': len(set(
                c.fill_id for c in self.cells.values() 
                if c.fill_type == 'material' and c.fill_id is not None
            ))
        }


def parse_geometry(file_path: str) -> Dict[str, Any]:
    """
    Parse OpenMC geometry file and return hierarchy.
    
    Args:
        file_path: Path to geometry file (XML or Python)
        
    Returns:
        Dictionary with geometry hierarchy or error
    """
    parser = OpenMCGeometryParser()
    return parser.parse(file_path)


# CLI interface
if __name__ == '__main__':
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python openmc_geometry_parser.py <geometry.xml>")
        print("       python openmc_geometry_parser.py <model_directory>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    result = parse_geometry(file_path)
    
    print(json.dumps(result, indent=2))
