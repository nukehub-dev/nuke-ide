#!/usr/bin/env python3
"""
OpenMC Materials Parser for NukeIDE.
Parses materials.xml files and extracts material definitions.
"""

import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Any, Union
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Nuclide:
    """Represents a nuclide in a material."""
    name: str
    fraction: float
    fraction_type: str = 'wo'  # 'wo' (weight) or 'ao' (atomic)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'name': self.name,
            'fraction': self.fraction,
            'fractionType': self.fraction_type
        }


@dataclass
class ThermalScattering:
    """Represents S(α,β) thermal scattering data."""
    name: str
    fraction: float = 1.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'name': self.name,
            'fraction': self.fraction
        }


@dataclass
class Material:
    """Represents an OpenMC material."""
    id: int
    name: str = ''
    density: float = 0.0
    density_unit: str = 'g/cm3'  # 'g/cm3', 'kg/m3', 'atom/b-cm', 'sum'
    nuclides: List[Nuclide] = field(default_factory=list)
    thermal_scattering: List[ThermalScattering] = field(default_factory=list)
    is_depletable: bool = False
    volume: Optional[float] = None
    temperature: Optional[float] = None  # in K
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name,
            'density': self.density,
            'densityUnit': self.density_unit,
            'nuclides': [n.to_dict() for n in self.nuclides],
            'thermalScattering': [t.to_dict() for t in self.thermal_scattering],
            'isDepletable': self.is_depletable,
            'volume': self.volume,
            'temperature': self.temperature,
            'totalNuclides': len(self.nuclides)
        }


class OpenMCMaterialsParser:
    """Parser for OpenMC materials.xml files."""
    
    def __init__(self):
        self.materials: Dict[int, Material] = {}
        self.materials_list: List[Material] = []
        
    def parse(self, file_path: str) -> bool:
        """Parse a materials.xml file.
        
        Args:
            file_path: Path to materials.xml file
            
        Returns:
            True if successful, False otherwise
        """
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()
            
            # Parse each material
            for mat_elem in root.findall('material'):
                material = self._parse_material(mat_elem)
                if material:
                    self.materials[material.id] = material
                    self.materials_list.append(material)
            
            # Sort by ID
            self.materials_list.sort(key=lambda m: m.id)
            
            return True
            
        except ET.ParseError as e:
            print(f"Error parsing materials.xml: {e}")
            return False
        except FileNotFoundError:
            print(f"File not found: {file_path}")
            return False
        except Exception as e:
            print(f"Unexpected error: {e}")
            return False
    
    def _parse_material(self, elem: ET.Element) -> Optional[Material]:
        """Parse a single material element."""
        try:
            # Get material ID (required)
            mat_id = int(elem.get('id'))
            
            # Get material name (optional, defaults to empty string)
            name = elem.get('name', '')
            
            material = Material(id=mat_id, name=name)
            
            # Parse density
            density_elem = elem.find('density')
            if density_elem is not None:
                # Get density value
                value_str = density_elem.get('value', '0')
                try:
                    material.density = float(value_str)
                except ValueError:
                    # Handle "sum" or other special values
                    if value_str.lower() == 'sum':
                        material.density = 0.0
                        material.density_unit = 'sum'
                    else:
                        material.density = 0.0
                
                # Get density unit
                units = density_elem.get('units', 'g/cm3')
                material.density_unit = units
            
            # Parse nuclides
            for nuclide_elem in elem.findall('nuclide'):
                nuclide = self._parse_nuclide(nuclide_elem)
                if nuclide:
                    material.nuclides.append(nuclide)
            
            # Parse thermal scattering (S(alpha,beta))
            for sab_elem in elem.findall('sab'):
                thermal = self._parse_thermal_scattering(sab_elem)
                if thermal:
                    material.thermal_scattering.append(thermal)
            
            # Check for depletable attribute
            depletable = elem.get('depletable', 'false').lower()
            material.is_depletable = depletable in ('true', '1', 'yes')
            
            # Parse volume if present
            volume_elem = elem.find('volume')
            if volume_elem is not None:
                try:
                    material.volume = float(volume_elem.text or '0')
                except ValueError:
                    pass
            
            # Parse temperature if present
            temperature_elem = elem.find('temperature')
            if temperature_elem is not None:
                try:
                    material.temperature = float(temperature_elem.text or '0')
                except ValueError:
                    pass
            
            return material
            
        except Exception as e:
            print(f"Error parsing material: {e}")
            return None
    
    def _parse_nuclide(self, elem: ET.Element) -> Optional[Nuclide]:
        """Parse a nuclide element."""
        try:
            name = elem.get('name', '')
            if not name:
                return None
            
            # Get fraction - can be either 'wo' (weight) or 'ao' (atomic)
            fraction = 0.0
            fraction_type = 'wo'
            
            if 'wo' in elem.attrib:
                fraction = float(elem.get('wo', '0'))
                fraction_type = 'wo'
            elif 'ao' in elem.attrib:
                fraction = float(elem.get('ao', '0'))
                fraction_type = 'ao'
            
            return Nuclide(name=name, fraction=fraction, fraction_type=fraction_type)
            
        except Exception as e:
            print(f"Error parsing nuclide: {e}")
            return None
    
    def _parse_thermal_scattering(self, elem: ET.Element) -> Optional[ThermalScattering]:
        """Parse a thermal scattering (S(alpha,beta)) element."""
        try:
            name = elem.get('name', '')
            if not name:
                return None
            
            fraction = 1.0
            if 'fraction' in elem.attrib:
                fraction = float(elem.get('fraction', '1'))
            
            return ThermalScattering(name=name, fraction=fraction)
            
        except Exception as e:
            print(f"Error parsing thermal scattering: {e}")
            return None
    
    def get_material_summary(self) -> Dict[str, Any]:
        """Get summary of all materials."""
        return {
            'totalMaterials': len(self.materials_list),
            'totalNuclides': sum(len(m.nuclides) for m in self.materials_list),
            'depletableMaterials': sum(1 for m in self.materials_list if m.is_depletable),
            'materialsWithThermalScattering': sum(1 for m in self.materials_list if m.thermal_scattering),
            'materials': [m.to_dict() for m in self.materials_list]
        }
    
    def get_material(self, material_id: int) -> Optional[Material]:
        """Get a material by ID."""
        return self.materials.get(material_id)
    
    def search_materials(self, query: str) -> List[Material]:
        """Search materials by name or ID."""
        query = query.lower()
        results = []
        
        for material in self.materials_list:
            # Search by ID
            if query in str(material.id):
                results.append(material)
                continue
            
            # Search by name
            if query in material.name.lower():
                results.append(material)
                continue
            
            # Search by nuclide names
            for nuclide in material.nuclides:
                if query in nuclide.name.lower():
                    results.append(material)
                    break
        
        return results


def parse_materials_file(file_path: str) -> Dict[str, Any]:
    """Parse a materials.xml file and return summary.
    
    Args:
        file_path: Path to materials.xml file
        
    Returns:
        Dictionary with material summary or error
    """
    parser = OpenMCMaterialsParser()
    
    if not parser.parse(file_path):
        return {'error': 'Failed to parse materials.xml'}
    
    return parser.get_material_summary()


def get_material_cell_linkage(materials_path: str, geometry_path: str) -> Dict[str, Any]:
    """Get mapping of materials to cells that use them.
    
    Args:
        materials_path: Path to materials.xml file
        geometry_path: Path to geometry.xml file
        
    Returns:
        Dictionary mapping material IDs to list of cells
    """
    try:
        # Parse materials
        materials_parser = OpenMCMaterialsParser()
        if not materials_parser.parse(materials_path):
            return {'error': 'Failed to parse materials.xml'}
        
        # Parse geometry
        import xml.etree.ElementTree as ET
        
        tree = ET.parse(geometry_path)
        root = tree.getroot()
        
        # Build material ID to name mapping
        material_names = {m.id: m.name for m in materials_parser.materials_list}
        
        # Find cells that reference each material
        material_cells: Dict[int, List[Dict]] = {}
        
        for cell_elem in root.findall('cell'):
            cell_id = int(cell_elem.get('id'))
            cell_name = cell_elem.get('name', '')
            material_attr = cell_elem.get('material')
            universe_id = int(cell_elem.get('universe', '0'))
            
            if material_attr and material_attr != 'void':
                try:
                    mat_id = int(material_attr)
                    if mat_id not in material_cells:
                        material_cells[mat_id] = []
                    
                    material_cells[mat_id].append({
                        'id': cell_id,
                        'name': cell_name or f'Cell {cell_id}',
                        'universe': universe_id
                    })
                except ValueError:
                    pass  # Skip non-integer material references
        
        # Convert to response format
        result = {
            'linkage': {
                str(mat_id): cells for mat_id, cells in material_cells.items()
            },
            'materialNames': material_names
        }
        
        return result
        
    except Exception as e:
        return {'error': str(e)}


if __name__ == '__main__':
    import sys
    import json
    
    if len(sys.argv) < 2:
        print("Usage: python openmc_materials_parser.py <materials.xml>")
        sys.exit(1)
    
    result = parse_materials_file(sys.argv[1])
    print(json.dumps(result, indent=2))
