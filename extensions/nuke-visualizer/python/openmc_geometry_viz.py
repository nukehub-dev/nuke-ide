#!/usr/bin/env python3
"""
OpenMC Geometry 3D Visualization for NukeIDE.
Converts OpenMC CSG geometry to VTK for visualization.
"""

import xml.etree.ElementTree as ET
import numpy as np
import vtk
from vtk.util import numpy_support
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import tempfile
import os

# Import common utilities
from visualizer_common import (
    hex_to_rgb, get_data_bounds, calculate_camera_position,
    create_update_view, create_reset_camera_controller,
    create_set_camera_view_controller, UIComponents
)


@dataclass
class Surface:
    """Represents an OpenMC surface for visualization."""
    id: int
    type: str
    coefficients: List[float]
    boundary: str = 'transmission'


@dataclass
class Cell:
    """Represents an OpenMC cell for visualization."""
    id: int
    region: str
    surfaces: Dict[int, bool]  # surface_id -> is_complemented
    universe: int = 0
    name: str = ''
    material: str = ''  # Material ID or name


class OpenMCGeometryVisualizer:
    """Converts OpenMC CSG geometry to VTK for visualization."""
    
    def __init__(self):
        self.surfaces: Dict[int, Surface] = {}
        self.cells: Dict[int, Cell] = {}
        self.bounds = {
            'xmin': -10, 'xmax': 10,
            'ymin': -10, 'ymax': 10,
            'zmin': -10, 'zmax': 10
        }
    
    def parse_geometry(self, file_path: str) -> bool:
        """Parse OpenMC geometry.xml file."""
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()
            
            # Parse surfaces
            for surf_elem in root.findall('surface'):
                self._parse_surface(surf_elem)
            
            # Parse cells
            for cell_elem in root.findall('cell'):
                self._parse_cell(cell_elem)
            
            # Calculate bounds from surfaces
            self._calculate_bounds()
            
            return True
        except Exception as e:
            print(f"Error parsing geometry: {e}")
            return False
    
    def _parse_surface(self, elem: ET.Element) -> None:
        """Parse a surface element."""
        surf_id = int(elem.get('id'))
        surf_type = elem.get('type', 'unknown').lower()
        
        coeffs = []
        coeffs_attr = elem.get('coeffs', '')
        if coeffs_attr:
            coeffs = [float(x) for x in coeffs_attr.split()]
        
        boundary = elem.get('boundary', 'transmission')
        
        self.surfaces[surf_id] = Surface(
            id=surf_id,
            type=surf_type,
            coefficients=coeffs,
            boundary=boundary
        )
    
    def _parse_cell(self, elem: ET.Element) -> None:
        """Parse a cell element."""
        cell_id = int(elem.get('id'))
        region = elem.get('region', '')
        universe = int(elem.get('universe', '0'))
        name = elem.get('name', '')
        material = elem.get('material', '')
        
        # Parse region to extract surface references
        surfaces = self._parse_region(region)
        
        self.cells[cell_id] = Cell(
            id=cell_id,
            region=region,
            surfaces=surfaces,
            universe=universe,
            name=name,
            material=material
        )
    
    def _parse_region(self, region: str) -> Dict[int, bool]:
        """Parse region string to get surface references."""
        surfaces = {}
        if not region:
            return surfaces
        
        # Tokenize region
        tokens = region.replace('(', ' ( ').replace(')', ' ) ').replace('|', ' | ').replace('&', ' & ').split()
        
        for token in tokens:
            if not token or token in ('(', ')', '|', '&'):
                continue
            
            # Check for complement operator
            is_complement = False
            if token.startswith('~'):
                is_complement = True
                token = token[1:]
            
            # Check for negative surface (inside)
            if token.startswith('-'):
                is_complement = True
                token = token[1:]
            elif token.startswith('+'):
                token = token[1:]
            
            try:
                surf_id = int(token)
                surfaces[surf_id] = is_complement
            except ValueError:
                pass
        
        return surfaces
    
    def _calculate_bounds(self) -> None:
        """Calculate geometry bounds from surfaces."""
        if not self.surfaces:
            return
        
        xvals, yvals, zvals = [], [], []
        
        for surf in self.surfaces.values():
            coeffs = surf.coefficients
            
            if surf.type == 'x-plane' and len(coeffs) >= 1:
                xvals.append(coeffs[0])
            elif surf.type == 'y-plane' and len(coeffs) >= 1:
                yvals.append(coeffs[0])
            elif surf.type == 'z-plane' and len(coeffs) >= 1:
                zvals.append(coeffs[0])
            elif surf.type in ('z-cylinder', 'cylinder') and len(coeffs) >= 3:
                cx, cy, r = coeffs[0], coeffs[1], coeffs[2]
                xvals.extend([cx - r, cx + r])
                yvals.extend([cy - r, cy + r])
            elif surf.type == 'sphere' and len(coeffs) >= 4:
                cx, cy, cz, r = coeffs[0], coeffs[1], coeffs[2], coeffs[3]
                xvals.extend([cx - r, cx + r])
                yvals.extend([cy - r, cy + r])
                zvals.extend([cz - r, cz + r])
        
        if xvals:
            self.bounds['xmin'] = min(xvals) - 0.1
            self.bounds['xmax'] = max(xvals) + 0.1
        if yvals:
            self.bounds['ymin'] = min(yvals) - 0.1
            self.bounds['ymax'] = max(yvals) + 0.1
        if zvals:
            self.bounds['zmin'] = min(zvals) - 0.1
            self.bounds['zmax'] = max(zvals) + 0.1
    
    def create_vtk_geometry(self, highlight_cell_ids: Optional[List[int]] = None) -> vtk.vtkMultiBlockDataSet:
        """
        Create VTK representation of the geometry.
        
        Args:
            highlight_cell_ids: Optional list of cell IDs to highlight
            
        Returns:
            VTK MultiBlock dataset with geometry
        """
        multi_block = vtk.vtkMultiBlockDataSet()
        
        if highlight_cell_ids is None:
            highlight_cell_ids = []
            
        # Create a block for each cell
        cell_count = 0
        for cell_id, cell in self.cells.items():
            cell_polydata = self._create_cell_geometry(cell)
            if cell_polydata:
                # Add cell ID as array for identification
                cell_ids = vtk.vtkIntArray()
                cell_ids.SetName("cell_id")
                cell_ids.SetNumberOfValues(cell_polydata.GetNumberOfCells())
                for i in range(cell_polydata.GetNumberOfCells()):
                    cell_ids.SetValue(i, cell_id)
                cell_polydata.GetCellData().AddArray(cell_ids)
                
                # Add material array for coloring (use material ID if available, else 0)
                try:
                    mat_id = int(cell.material) if cell.material and cell.material != 'void' else 0
                except (ValueError, TypeError):
                    mat_id = 0
                materials = vtk.vtkIntArray()
                materials.SetName("material")
                materials.SetNumberOfValues(cell_polydata.GetNumberOfCells())
                for i in range(cell_polydata.GetNumberOfCells()):
                    materials.SetValue(i, mat_id)
                cell_polydata.GetCellData().AddArray(materials)
                
                # Add highlight array if this is one of the highlighted cells
                highlight = vtk.vtkIntArray()
                highlight.SetName("highlight")
                highlight.SetNumberOfValues(cell_polydata.GetNumberOfCells())
                is_highlighted = 1 if cell_id in highlight_cell_ids else 0
                for i in range(cell_polydata.GetNumberOfCells()):
                    highlight.SetValue(i, is_highlighted)
                cell_polydata.GetCellData().AddArray(highlight)
                
                multi_block.SetBlock(cell_count, cell_polydata)
                multi_block.GetMetaData(cell_count).Set(vtk.vtkCompositeDataSet.NAME(), f"Cell_{cell_id}")
                cell_count += 1
        
        return multi_block

    def create_markers_vtk(self, markers: List[Dict]) -> vtk.vtkMultiBlockDataSet:
        """Create VTK markers for overlap locations."""
        multi_block = vtk.vtkMultiBlockDataSet()
        
        # Calculate a reasonable radius based on geometry bounds if not provided
        default_radius = 1.0
        if self.bounds:
            diagonal = np.sqrt(
                (self.bounds['xmax'] - self.bounds['xmin'])**2 +
                (self.bounds['ymax'] - self.bounds['ymin'])**2 +
                (self.bounds['zmax'] - self.bounds['zmin'])**2
            )
            if diagonal > 0:
                default_radius = diagonal * 0.02  # 2% of diagonal
        
        for i, marker in enumerate(markers):
            coords = marker.get('coordinates', [0, 0, 0])
            radius = marker.get('radius', default_radius)
            if radius == 1.0: # If it was our default 1.0, use the dynamic one
                radius = default_radius
            
            sphere = vtk.vtkSphereSource()
            sphere.SetCenter(coords[0], coords[1], coords[2])
            sphere.SetRadius(radius)
            sphere.SetThetaResolution(16)
            sphere.SetPhiResolution(16)
            sphere.Update()
            
            multi_block.SetBlock(i, sphere.GetOutput())
            multi_block.GetMetaData(i).Set(vtk.vtkCompositeDataSet.NAME(), f"Marker_{i}")
            
        return multi_block
    
    def _create_cell_geometry(self, cell: Cell) -> Optional[vtk.vtkPolyData]:
        """Create VTK geometry for a single cell."""
        if not cell.surfaces:
            return None
        
        # Get the primary surface (first one) to determine geometry type
        primary_surf_id = list(cell.surfaces.keys())[0]
        if primary_surf_id not in self.surfaces:
            return None
        
        surf = self.surfaces[primary_surf_id]
        
        # Route to appropriate geometry creator based on surface type
        surf_creators = {
            'x-plane': lambda s: self._create_box_from_planes(
                [(s, cell.surfaces[primary_surf_id])], cell.id),
            'y-plane': lambda s: self._create_box_from_planes(
                [(s, cell.surfaces[primary_surf_id])], cell.id),
            'z-plane': lambda s: self._create_box_from_planes(
                [(s, cell.surfaces[primary_surf_id])], cell.id),
            'plane': lambda s: self._create_plane_cell(s, cell),
            'x-cylinder': lambda s: self._create_x_cylinder_geometry(s),
            'y-cylinder': lambda s: self._create_y_cylinder_geometry(s),
            'z-cylinder': lambda s: self._create_cylinder_geometry(s, cell.id),
            'cylinder': lambda s: self._create_cylinder_geometry(s, cell.id),
            'sphere': lambda s: self._create_sphere_geometry(s),
            'x-cone': lambda s: self._create_cone_geometry(s, 'x'),
            'y-cone': lambda s: self._create_cone_geometry(s, 'y'),
            'z-cone': lambda s: self._create_cone_geometry(s, 'z'),
            'x-torus': lambda s: self._create_torus_geometry(s, 'x'),
            'y-torus': lambda s: self._create_torus_geometry(s, 'y'),
            'z-torus': lambda s: self._create_torus_geometry(s, 'z'),
            'quadric': lambda s: self._create_quadric_geometry(s, cell.id),
        }
        
        if surf.type in surf_creators:
            return surf_creators[surf.type](surf)
        
        # Fallback: try to create from multiple planes if available
        planes = []
        for surf_id, is_comp in cell.surfaces.items():
            if surf_id in self.surfaces:
                s = self.surfaces[surf_id]
                if s.type in ('x-plane', 'y-plane', 'z-plane'):
                    planes.append((s, is_comp))
        
        if len(planes) >= 2:
            return self._create_box_from_planes(planes, cell.id)
        
        return None
    
    def _create_plane_cell(self, surf: Surface, cell: Cell) -> vtk.vtkPolyData:
        """Create geometry for a general plane cell."""
        # General plane: ax + by + cz = d
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        a, b, c, d = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        # Create a plane source
        plane = vtk.vtkPlaneSource()
        
        # Calculate plane center and normal
        normal = np.array([a, b, c])
        normal = normal / np.linalg.norm(normal) if np.linalg.norm(normal) > 0 else np.array([0, 0, 1])
        
        # Find a point on the plane
        if abs(a) > abs(b) and abs(a) > abs(c):
            point = np.array([d / a, 0, 0])
        elif abs(b) > abs(c):
            point = np.array([0, d / b, 0])
        else:
            point = np.array([0, 0, d / c if c != 0 else 0])
        
        # Create a large plane
        plane.SetCenter(point)
        plane.SetNormal(normal)
        plane.SetOrigin(point - 5 * normal)
        plane.SetPoint1(point + np.array([5, 0, 0]))
        plane.SetPoint2(point + np.array([0, 5, 0]))
        plane.Update()
        
        return plane.GetOutput()
    
    def _create_box_from_planes(self, planes: List[Tuple[Surface, bool]], cell_id: int) -> vtk.vtkPolyData:
        """Create a box representation from plane surfaces."""
        # Extract bounds from planes
        xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
        ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
        zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
        
        for surf, is_comp in planes:
            if surf.type == 'x-plane' and surf.coefficients:
                x = surf.coefficients[0]
                if is_comp:
                    xmin = max(xmin, x)
                else:
                    xmax = min(xmax, x)
            elif surf.type == 'y-plane' and surf.coefficients:
                y = surf.coefficients[0]
                if is_comp:
                    ymin = max(ymin, y)
                else:
                    ymax = min(ymax, y)
            elif surf.type == 'z-plane' and surf.coefficients:
                z = surf.coefficients[0]
                if is_comp:
                    zmin = max(zmin, z)
                else:
                    zmax = min(zmax, z)
        
        # Ensure valid bounds
        if xmin >= xmax:
            xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
        if ymin >= ymax:
            ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
        if zmin >= zmax:
            zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
        
        # Create a box
        cube = vtk.vtkCubeSource()
        cube.SetXLength(xmax - xmin)
        cube.SetYLength(ymax - ymin)
        cube.SetZLength(zmax - zmin)
        cube.SetCenter((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2)
        cube.Update()
        
        return cube.GetOutput()
    
    def _create_cylinder_geometry(self, surf: Surface, cell_id: int) -> vtk.vtkPolyData:
        """Create a cylinder representation."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cx, cy, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
        
        # Create a cylinder
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(zmax - zmin)
        cylinder.SetResolution(32)
        cylinder.Update()
        
        # Transform to correct position
        transform = vtk.vtkTransform()
        transform.Translate(cx, cy, (zmin + zmax) / 2)
        transform.RotateX(90)  # VTK cylinders are oriented along Y by default
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_x_cylinder_geometry(self, surf: Surface) -> vtk.vtkPolyData:
        """Create an x-aligned cylinder."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cy, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
        
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(xmax - xmin)
        cylinder.SetResolution(32)
        cylinder.Update()
        
        transform = vtk.vtkTransform()
        transform.Translate((xmin + xmax) / 2, cy, cz)
        transform.RotateZ(90)  # Rotate to align with X axis
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_y_cylinder_geometry(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a y-aligned cylinder."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cx, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
        
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(ymax - ymin)
        cylinder.SetResolution(32)
        cylinder.Update()
        
        transform = vtk.vtkTransform()
        transform.Translate(cx, (ymin + ymax) / 2, cz)
        # Y-aligned is the default, no rotation needed
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_sphere_geometry(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a sphere representation."""
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        cx, cy, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        sphere = vtk.vtkSphereSource()
        sphere.SetCenter(cx, cy, cz)
        sphere.SetRadius(r)
        sphere.SetThetaResolution(32)
        sphere.SetPhiResolution(32)
        sphere.Update()
        
        return sphere.GetOutput()
    
    def _create_cone_geometry(self, surf: Surface, axis: str) -> vtk.vtkPolyData:
        """Create a cone representation.
        
        OpenMC cone format:
        - x-cone: coeffs = (x0, y0, z0, R^2) where (x-x0)^2 = R^2 * [(y-y0)^2 + (z-z0)^2]
        - y-cone: coeffs = (x0, y0, z0, R^2) where (y-y0)^2 = R^2 * [(x-x0)^2 + (z-z0)^2]
        - z-cone: coeffs = (x0, y0, z0, R^2) where (z-z0)^2 = R^2 * [(x-x0)^2 + (y-y0)^2]
        """
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        # Parse coefficients: x0, y0, z0, R^2
        x0, y0, z0, r_squared = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        # Apex position
        apex = (x0, y0, z0)
        
        # Calculate height from bounds (extent of cone)
        if axis == 'x':
            h = max(abs(self.bounds['xmax'] - x0), abs(self.bounds['xmin'] - x0))
        elif axis == 'y':
            h = max(abs(self.bounds['ymax'] - y0), abs(self.bounds['ymin'] - y0))
        else:  # z
            h = max(abs(self.bounds['zmax'] - z0), abs(self.bounds['zmin'] - z0))
        
        # Avoid degenerate cone
        if h < 0.001:
            h = 1.0
        
        # R^2 determines the cone angle: tan(theta) = R
        # At distance h from apex, radius = h * R = h * sqrt(R^2)
        r = np.sqrt(abs(r_squared)) if r_squared > 0 else 0.5
        radius = h * r
        
        # Ensure non-zero radius
        if radius < 0.001:
            radius = 0.1
        
        cone = vtk.vtkConeSource()
        # VTK cone apex is at -height/2 from center, base at +height/2
        # We want the apex at (x0, y0, z0) pointing along the axis
        if axis == 'x':
            cone.SetCenter(x0 + h/2, y0, z0)
        elif axis == 'y':
            cone.SetCenter(x0, y0 + h/2, z0)
        else:  # z
            cone.SetCenter(x0, y0, z0 + h/2)
        
        cone.SetHeight(h)
        cone.SetRadius(radius)
        cone.SetResolution(32)
        cone.Update()
        
        # Rotate cone to align with axis
        transform = vtk.vtkTransform()
        if axis == 'x':
            transform.RotateY(90)
        elif axis == 'y':
            transform.RotateX(-90)
        # z is default orientation
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cone.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_torus_geometry(self, surf: Surface, axis: str) -> vtk.vtkPolyData:
        """Create a torus representation.
        
        OpenMC torus format: (x0, y0, z0, A, B, C)
        - (x0, y0, z0): center point
        - A: major radius (distance from center to tube center)
        - B: minor radius in the equatorial plane
        - C: minor radius along the axis of revolution
        
        For VTK we use: RingRadius = A, CrossSectionRadius = (B+C)/2
        """
        if len(surf.coefficients) < 6:
            print(f"Warning: Torus surface {surf.id} has insufficient coefficients: {surf.coefficients}")
            return vtk.vtkPolyData()
        
        # Parse center position
        cx, cy, cz = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        
        # Parse radii
        A = surf.coefficients[3]  # major radius
        B = surf.coefficients[4]  # minor radius (equatorial)
        C = surf.coefficients[5]  # minor radius (axial)
        
        # VTK uses circular cross-section, so average B and C
        R = max(A, 0.001)  # major radius (must be > 0)
        r = max((B + C) / 2, 0.001)  # minor radius (must be > 0)
        
        # Create torus using parametric function
        parametric_torus = vtk.vtkParametricTorus()
        parametric_torus.SetRingRadius(R)
        parametric_torus.SetCrossSectionRadius(r)
        
        parametric_function = vtk.vtkParametricFunctionSource()
        parametric_function.SetParametricFunction(parametric_torus)
        parametric_function.SetUResolution(50)
        parametric_function.SetVResolution(50)
        parametric_function.Update()
        
        # Transform to correct position and orientation
        transform = vtk.vtkTransform()
        transform.Translate(cx, cy, cz)
        if axis == 'x':
            transform.RotateY(90)
        elif axis == 'y':
            transform.RotateX(90)
        # z is default orientation
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(parametric_function.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_quadric_geometry(self, surf: Surface, cell_id: int) -> vtk.vtkPolyData:
        """Create geometry for a quadric surface.
        
        OpenMC quadric: Ax² + By² + Cz² + Dxy + Exz + Fyz + Gx + Hy + Iz + J = 0
        
        Common cases:
        - Cylinder (z-aligned): A=B, C=0, D=E=F=0
        - Cylinder (x-aligned): A=C, B=0, D=E=F=0  
        - Cylinder (y-aligned): B=C, A=0, D=E=F=0
        """
        if len(surf.coefficients) < 10:
            return vtk.vtkPolyData()
        
        A, B, C, D, E, F, G, H, I, J = surf.coefficients[0:10]
        
        # Determine cylinder axis based on which quadratic term is zero (or near zero)
        # For a cylinder, one axis has no quadratic term
        absA, absB, absC = abs(A), abs(B), abs(C)
        
        # Check if it's a cylinder (one quadratic coefficient is ~0)
        if absC < 0.001 and absA > 0.001 and absB > 0.001:
            # Z-aligned cylinder: Ax² + By² + Gx + Hy + J = 0
            # Convert to standard form: (x - cx)² + (y - cy)² = r²
            # Complete the square:
            # A(x + G/(2A))² + B(y + H/(2B))² = -J + G²/(4A) + H²/(4B)
            
            # Normalize to make A=B=1
            if abs(absA - absB) < 0.001:  # A ≈ B, circular cylinder
                cx = -G / (2 * A)
                cy = -H / (2 * A)
                rhs = -J / A + (G * G) / (4 * A * A) + (H * H) / (4 * A * A)
                radius = np.sqrt(max(rhs, 0.001))
                
                zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(zmax - zmin)
                cylinder.SetResolution(32)
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate(cx, cy, (zmin + zmax) / 2)
                transform.RotateX(90)  # VTK cylinders are Y-aligned by default
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        elif absA < 0.001 and absB > 0.001 and absC > 0.001:
            # X-aligned cylinder: By² + Cz² + Hy + Iz + J = 0
            if abs(absB - absC) < 0.001:
                cy = -H / (2 * B)
                cz = -I / (2 * B)
                rhs = -J / B + (H * H) / (4 * B * B) + (I * I) / (4 * B * B)
                radius = np.sqrt(max(rhs, 0.001))
                
                xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(xmax - xmin)
                cylinder.SetResolution(32)
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate((xmin + xmax) / 2, cy, cz)
                transform.RotateZ(90)  # Align with X axis
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        elif absB < 0.001 and absA > 0.001 and absC > 0.001:
            # Y-aligned cylinder: Ax² + Cz² + Gx + Iz + J = 0
            if abs(absA - absC) < 0.001:
                cx = -G / (2 * A)
                cz = -I / (2 * A)
                rhs = -J / A + (G * G) / (4 * A * A) + (I * I) / (4 * A * A)
                radius = np.sqrt(max(rhs, 0.001))
                
                ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(ymax - ymin)
                cylinder.SetResolution(32)
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate(cx, (ymin + ymax) / 2, cz)
                # Y-aligned is default, no rotation needed
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        # Fallback: create a small sphere to indicate unsupported quadric
        print(f"Warning: Unsupported quadric surface for cell {cell_id}: coeffs={surf.coefficients}")
        sphere = vtk.vtkSphereSource()
        sphere.SetCenter(0, 0, 0)
        sphere.SetRadius(0.1)
        sphere.Update()
        return sphere.GetOutput()
    
    def create_surface_geometry(self) -> vtk.vtkMultiBlockDataSet:
        """Create VTK representation of surfaces (wireframe)."""
        multi_block = vtk.vtkMultiBlockDataSet()
        
        surf_count = 0
        for surf_id, surf in self.surfaces.items():
            surf_polydata = self._create_surface_geometry(surf)
            if surf_polydata:
                # Add surface ID
                surf_ids = vtk.vtkIntArray()
                surf_ids.SetName("surface_id")
                surf_ids.SetNumberOfValues(surf_polydata.GetNumberOfCells())
                for i in range(surf_polydata.GetNumberOfCells()):
                    surf_ids.SetValue(i, surf_id)
                surf_polydata.GetCellData().AddArray(surf_ids)
                
                multi_block.SetBlock(surf_count, surf_polydata)
                multi_block.GetMetaData(surf_count).Set(vtk.vtkCompositeDataSet.NAME(), f"Surface_{surf_id}")
                surf_count += 1
        
        return multi_block
    
    def _create_surface_geometry(self, surf: Surface) -> Optional[vtk.vtkPolyData]:
        """Create VTK geometry for a single surface (wireframe)."""
        surface_creators = {
            'x-plane': lambda s: self._create_plane_surface('x', s.coefficients[0]) if s.coefficients else None,
            'y-plane': lambda s: self._create_plane_surface('y', s.coefficients[0]) if s.coefficients else None,
            'z-plane': lambda s: self._create_plane_surface('z', s.coefficients[0]) if s.coefficients else None,
            'plane': lambda s: self._create_general_plane_surface(s),
            'x-cylinder': lambda s: self._create_x_cylinder_surface(s),
            'y-cylinder': lambda s: self._create_y_cylinder_surface(s),
            'z-cylinder': lambda s: self._create_cylinder_surface(s),
            'cylinder': lambda s: self._create_cylinder_surface(s),
            'sphere': lambda s: self._create_sphere_surface(s),
            'x-cone': lambda s: self._create_cone_surface(s, 'x'),
            'y-cone': lambda s: self._create_cone_surface(s, 'y'),
            'z-cone': lambda s: self._create_cone_surface(s, 'z'),
            'x-torus': lambda s: self._create_torus_surface(s, 'x'),
            'y-torus': lambda s: self._create_torus_surface(s, 'y'),
            'z-torus': lambda s: self._create_torus_surface(s, 'z'),
            'quadric': lambda s: self._create_quadric_surface(s),
        }
        
        if surf.type in surface_creators:
            return surface_creators[surf.type](surf)
        return None
    
    def _create_general_plane_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a general plane surface."""
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        a, b, c, d = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        plane = vtk.vtkPlaneSource()
        normal = np.array([a, b, c])
        normal = normal / np.linalg.norm(normal) if np.linalg.norm(normal) > 0 else np.array([0, 0, 1])
        
        # Find a point on the plane
        if abs(a) > abs(b) and abs(a) > abs(c):
            point = np.array([d / a, 0, 0])
        elif abs(b) > abs(c):
            point = np.array([0, d / b, 0])
        else:
            point = np.array([0, 0, d / c if c != 0 else 0])
        
        # Create a large plane
        plane.SetCenter(point)
        plane.SetNormal(normal)
        plane.SetOrigin(point - 5 * normal)
        plane.SetPoint1(point + np.array([5, 0, 0]))
        plane.SetPoint2(point + np.array([0, 5, 0]))
        plane.Update()
        
        return plane.GetOutput()
    
    def _create_x_cylinder_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create an x-aligned cylinder surface."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cy, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
        
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(xmax - xmin)
        cylinder.SetResolution(32)
        cylinder.CappingOff()
        cylinder.Update()
        
        transform = vtk.vtkTransform()
        transform.Translate((xmin + xmax) / 2, cy, cz)
        transform.RotateZ(90)
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_y_cylinder_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a y-aligned cylinder surface."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cx, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
        
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(ymax - ymin)
        cylinder.SetResolution(32)
        cylinder.CappingOff()
        cylinder.Update()
        
        transform = vtk.vtkTransform()
        transform.Translate(cx, (ymin + ymax) / 2, cz)
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_sphere_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a sphere surface."""
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        cx, cy, cz, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        sphere = vtk.vtkSphereSource()
        sphere.SetCenter(cx, cy, cz)
        sphere.SetRadius(r)
        sphere.SetThetaResolution(32)
        sphere.SetPhiResolution(32)
        sphere.Update()
        
        return sphere.GetOutput()
    
    def _create_cone_surface(self, surf: Surface, axis: str) -> vtk.vtkPolyData:
        """Create a cone surface.
        
        OpenMC cone format: (x0, y0, z0, R^2)
        """
        if len(surf.coefficients) < 4:
            return vtk.vtkPolyData()
        
        x0, y0, z0, r_squared = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2], surf.coefficients[3]
        
        if axis == 'x':
            h = max(abs(self.bounds['xmax'] - x0), abs(self.bounds['xmin'] - x0))
        elif axis == 'y':
            h = max(abs(self.bounds['ymax'] - y0), abs(self.bounds['ymin'] - y0))
        else:
            h = max(abs(self.bounds['zmax'] - z0), abs(self.bounds['zmin'] - z0))
        
        if h < 0.001:
            h = 1.0
        
        r = np.sqrt(abs(r_squared)) if r_squared > 0 else 0.5
        radius = h * r
        
        if radius < 0.001:
            radius = 0.1
        
        cone = vtk.vtkConeSource()
        if axis == 'x':
            cone.SetCenter(x0 + h/2, y0, z0)
        elif axis == 'y':
            cone.SetCenter(x0, y0 + h/2, z0)
        else:
            cone.SetCenter(x0, y0, z0 + h/2)
        
        cone.SetHeight(h)
        cone.SetRadius(radius)
        cone.SetResolution(32)
        cone.CappingOff()
        cone.Update()
        
        transform = vtk.vtkTransform()
        if axis == 'x':
            transform.RotateY(90)
        elif axis == 'y':
            transform.RotateX(-90)
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cone.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_torus_surface(self, surf: Surface, axis: str) -> vtk.vtkPolyData:
        """Create a torus surface.
        
        OpenMC torus format: (x0, y0, z0, A, B, C)
        """
        if len(surf.coefficients) < 6:
            return vtk.vtkPolyData()
        
        cx, cy, cz = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        A = surf.coefficients[3]
        B = surf.coefficients[4]
        C = surf.coefficients[5]
        
        R = max(A, 0.001)
        r = max((B + C) / 2, 0.001)
        
        parametric_torus = vtk.vtkParametricTorus()
        parametric_torus.SetRingRadius(R)
        parametric_torus.SetCrossSectionRadius(r)
        
        parametric_function = vtk.vtkParametricFunctionSource()
        parametric_function.SetParametricFunction(parametric_torus)
        parametric_function.SetUResolution(50)
        parametric_function.SetVResolution(50)
        parametric_function.Update()
        
        transform = vtk.vtkTransform()
        transform.Translate(cx, cy, cz)
        if axis == 'x':
            transform.RotateY(90)
        elif axis == 'y':
            transform.RotateX(90)
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(parametric_function.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()
    
    def _create_quadric_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a quadric surface (wireframe)."""
        if len(surf.coefficients) < 10:
            return vtk.vtkPolyData()
        
        A, B, C, D, E, F, G, H, I, J = surf.coefficients[0:10]
        
        # Same logic as _create_quadric_geometry but for surface
        absA, absB, absC = abs(A), abs(B), abs(C)
        
        if absC < 0.001 and absA > 0.001 and absB > 0.001:
            # Z-aligned cylinder
            if abs(absA - absB) < 0.001:
                cx = -G / (2 * A)
                cy = -H / (2 * A)
                rhs = -J / A + (G * G) / (4 * A * A) + (H * H) / (4 * A * A)
                radius = np.sqrt(max(rhs, 0.001))
                zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(zmax - zmin)
                cylinder.SetResolution(32)
                cylinder.CappingOff()
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate(cx, cy, (zmin + zmax) / 2)
                transform.RotateX(90)
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        elif absA < 0.001 and absB > 0.001 and absC > 0.001:
            # X-aligned cylinder
            if abs(absB - absC) < 0.001:
                cy = -H / (2 * B)
                cz = -I / (2 * B)
                rhs = -J / B + (H * H) / (4 * B * B) + (I * I) / (4 * B * B)
                radius = np.sqrt(max(rhs, 0.001))
                xmin, xmax = self.bounds['xmin'], self.bounds['xmax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(xmax - xmin)
                cylinder.SetResolution(32)
                cylinder.CappingOff()
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate((xmin + xmax) / 2, cy, cz)
                transform.RotateZ(90)
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        elif absB < 0.001 and absA > 0.001 and absC > 0.001:
            # Y-aligned cylinder
            if abs(absA - absC) < 0.001:
                cx = -G / (2 * A)
                cz = -I / (2 * A)
                rhs = -J / A + (G * G) / (4 * A * A) + (I * I) / (4 * A * A)
                radius = np.sqrt(max(rhs, 0.001))
                ymin, ymax = self.bounds['ymin'], self.bounds['ymax']
                
                cylinder = vtk.vtkCylinderSource()
                cylinder.SetRadius(radius)
                cylinder.SetHeight(ymax - ymin)
                cylinder.SetResolution(32)
                cylinder.CappingOff()
                cylinder.Update()
                
                transform = vtk.vtkTransform()
                transform.Translate(cx, (ymin + ymax) / 2, cz)
                
                transform_filter = vtk.vtkTransformPolyDataFilter()
                transform_filter.SetInputData(cylinder.GetOutput())
                transform_filter.SetTransform(transform)
                transform_filter.Update()
                
                return transform_filter.GetOutput()
        
        return vtk.vtkPolyData()
    
    def _create_plane_surface(self, axis: str, value: float) -> vtk.vtkPolyData:
        """Create a plane surface for visualization."""
        # Create a plane
        plane = vtk.vtkPlaneSource()
        
        if axis == 'x':
            plane.SetOrigin(value, self.bounds['ymin'], self.bounds['zmin'])
            plane.SetPoint1(value, self.bounds['ymax'], self.bounds['zmin'])
            plane.SetPoint2(value, self.bounds['ymin'], self.bounds['zmax'])
        elif axis == 'y':
            plane.SetOrigin(self.bounds['xmin'], value, self.bounds['zmin'])
            plane.SetPoint1(self.bounds['xmax'], value, self.bounds['zmin'])
            plane.SetPoint2(self.bounds['xmin'], value, self.bounds['zmax'])
        else:  # z
            plane.SetOrigin(self.bounds['xmin'], self.bounds['ymin'], value)
            plane.SetPoint1(self.bounds['xmax'], self.bounds['ymin'], value)
            plane.SetPoint2(self.bounds['xmin'], self.bounds['ymax'], value)
        
        plane.SetXResolution(10)
        plane.SetYResolution(10)
        plane.Update()
        
        return plane.GetOutput()
    
    def _create_cylinder_surface(self, surf: Surface) -> vtk.vtkPolyData:
        """Create a cylinder surface."""
        if len(surf.coefficients) < 3:
            return vtk.vtkPolyData()
        
        cx, cy, r = surf.coefficients[0], surf.coefficients[1], surf.coefficients[2]
        zmin, zmax = self.bounds['zmin'], self.bounds['zmax']
        
        # Create a cylinder (just the surface)
        cylinder = vtk.vtkCylinderSource()
        cylinder.SetRadius(r)
        cylinder.SetHeight(zmax - zmin)
        cylinder.SetResolution(32)
        cylinder.CappingOff()
        cylinder.Update()
        
        # Transform
        transform = vtk.vtkTransform()
        transform.Translate(cx, cy, (zmin + zmax) / 2)
        transform.RotateX(90)
        
        transform_filter = vtk.vtkTransformPolyDataFilter()
        transform_filter.SetInputData(cylinder.GetOutput())
        transform_filter.SetTransform(transform)
        transform_filter.Update()
        
        return transform_filter.GetOutput()


def visualize_geometry(geometry_file: str, port: int = 8090, highlight_cells: Optional[List[int]] = None, overlaps_file: Optional[str] = None):
    """
    Start a visualization server for OpenMC geometry.
    
    Args:
        geometry_file: Path to geometry.xml
        port: Server port
        highlight_cells: List of cell IDs to highlight
        overlaps_file: Path to JSON file containing overlap markers
    """
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.widgets import html
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}")
        return 1
    
    # Parse geometry
    viz = OpenMCGeometryVisualizer()
    if not viz.parse_geometry(geometry_file):
        print("Failed to parse geometry")
        return 1
    
    # Load overlap markers if provided
    overlap_markers = []
    if overlaps_file and os.path.exists(overlaps_file):
        try:
            with open(overlaps_file, 'r') as f:
                data = json.load(f)
                overlap_markers = data.get('markers', [])
                if not overlap_markers and 'overlaps' in data:
                    # Convert from OverlapResult format to marker format
                    for o in data['overlaps']:
                        overlap_markers.append({
                            'coordinates': o['coordinates'],
                            'cellIds': o['cellIds'],
                            'radius': 1.0  # Default radius
                        })
        except Exception as e:
            print(f"Error loading overlaps: {e}")

    # Create VTK data
    cell_data = viz.create_vtk_geometry(highlight_cells)
    surface_data = viz.create_surface_geometry()
    marker_data = viz.create_markers_vtk(overlap_markers) if overlap_markers else None
    
    # Write to temporary files
    with tempfile.NamedTemporaryFile(suffix='.vtm', delete=False) as tmp:
        cell_file = tmp.name
    with tempfile.NamedTemporaryFile(suffix='.vtm', delete=False) as tmp:
        surf_file = tmp.name
    
    marker_file = None
    if marker_data:
        with tempfile.NamedTemporaryFile(suffix='.vtm', delete=False) as tmp:
            marker_file = tmp.name
        writer3 = vtk.vtkXMLMultiBlockDataWriter()
        writer3.SetFileName(marker_file)
        writer3.SetInputData(marker_data)
        writer3.Write()
    
    writer1 = vtk.vtkXMLMultiBlockDataWriter()
    writer1.SetFileName(cell_file)
    writer1.SetInputData(cell_data)
    writer1.Write()
    
    writer2 = vtk.vtkXMLMultiBlockDataWriter()
    writer2.SetFileName(surf_file)
    writer2.SetInputData(surface_data)
    writer2.Write()
    
    # Create trame server
    server = get_server(client_type="vue2", port=port)
    state = server.state
    
    # Get cell information for UI from the ACTUAL data
    cell_info = []
    cell_visibility = {}
    num_blocks = cell_data.GetNumberOfBlocks()
    for i in range(num_blocks):
        metadata = cell_data.GetMetaData(i)
        if not metadata or not metadata.Has(vtk.vtkCompositeDataSet.NAME()):
            continue
            
        block_name = metadata.Get(vtk.vtkCompositeDataSet.NAME())
        try:
            # block_name is "Cell_{cell_id}"
            cell_id = int(block_name.split('_')[1])
            cell = viz.cells.get(cell_id)
            
            cell_name = getattr(cell, 'name', '') or f"Cell {cell_id}"
            cell_material = getattr(cell, 'material_name', '') or getattr(cell, 'material', '') or 'void'
            
            # Get surface selectors for this cell
            surf_selectors = []
            if cell and cell.surfaces:
                for s_id in cell.surfaces:
                    surf_selectors.append(f"/Root/Surface_{s_id}")
            
            cell_info.append({
                'id': cell_id,
                'name': cell_name,
                'material': cell_material,
                'index': i,
                'selector': f"/Root/{block_name}",
                'surf_selectors': surf_selectors
            })
            
            # If highlight_cells are specified, only show those cells initially
            # This makes the "overlap reason" much clearer by hiding irrelevant geometry
            if highlight_cells is not None and len(highlight_cells) > 0:
                cell_visibility[str(cell_id)] = (cell_id in highlight_cells)
            else:
                cell_visibility[str(cell_id)] = True  # Default all visible
        except (ValueError, IndexError):
            continue
    
    # Pipeline storage
    pipeline = {
        'cell_reader': None,
        'surf_reader': None,
        'marker_reader': None,
        'cell_extracts': {},  # cell_id -> extract filter
        'cell_displays': {},  # cell_id -> display object
        'marker_display': None,
        'view': None,
        'view_widget': None,
        'material_lut': None,
    }
    
    # Load in ParaView
    cell_reader = simple.XMLMultiBlockDataReader(FileName=cell_file)
    pipeline['cell_reader'] = cell_reader
    simple.Hide(cell_reader)

    if marker_file:
        marker_reader = simple.XMLMultiBlockDataReader(FileName=marker_file)
        pipeline['marker_reader'] = marker_reader
        simple.Hide(marker_reader)
    
    view = simple.GetActiveViewOrCreate('RenderView')
    bg_rgb = hex_to_rgb(state.background_color_hex)
    view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
    view.UseColorPaletteForBackground = 0
    pipeline['view'] = view
    
    # Large set of distinct colors for cells
    distinct_colors = [
        [0.3, 0.5, 0.9],  # Blue
        [0.3, 0.9, 0.5],  # Green
        [0.9, 0.5, 0.3],  # Orange
        [0.9, 0.3, 0.9],  # Magenta
        [0.3, 0.9, 0.9],  # Cyan
        [0.9, 0.9, 0.3],  # Yellow
        [0.6, 0.4, 0.8],  # Purple
        [0.4, 0.8, 0.6],  # Mint
        [0.8, 0.6, 0.4],  # Brown
        [0.5, 0.5, 0.5],  # Gray
        [0.2, 0.7, 0.2],  # Dark Green
        [0.1, 0.5, 0.8],  # Royal Blue
        [0.8, 0.1, 0.5],  # Pink
        [0.8, 0.8, 0.1],  # Gold
        [0.1, 0.8, 0.8],  # Sky Blue
    ]
    pipeline['color_palette'] = distinct_colors
    
    # State
    state.opacity = 0.5  # Lower default opacity to see internal overlaps better
    state.show_controls = True
    state.show_overlaps = True if overlap_markers else False
    state.cell_info = cell_info
    state.cell_visibility = cell_visibility
    state.highlight_cell_ids = highlight_cells if highlight_cells else []
    state.selected_cell_id = highlight_cells[0] if highlight_cells else None
    state.background_color_hex = "#1a1a26"
    state.camera_update_counter = 0
    
    update_view = create_update_view(pipeline, state, simple)
    
    def update_cell_visibility(visibility=None):
        try:
            if visibility is None:
                visibility = state.cell_visibility
            
            visibility_keys = {str(k): v for k, v in visibility.items()}
            visible_cell_ids = set()
            
            for cell in state.cell_info:
                if visibility_keys.get(str(cell['id']), False):
                    visible_cell_ids.add(cell['id'])
            
            # Recreate extracts
            for cell_id, extract in list(pipeline['cell_extracts'].items()):
                simple.Delete(extract)
            pipeline['cell_extracts'].clear()
            pipeline['cell_displays'].clear()
            
            for cell in state.cell_info:
                cell_id = cell['id']
                if cell_id in visible_cell_ids:
                    extract = simple.ExtractBlock(Input=pipeline['cell_reader'])
                    extract.Selectors = [cell['selector']]
                    pipeline['cell_extracts'][cell_id] = extract
                    
                    disp = simple.Show(extract, view)
                    disp.Representation = 'Surface'
                    disp.Opacity = float(state.opacity)
                    
                    # COLORING LOGIC:
                    # Disable scalar mapping to use DiffuseColor/AmbientColor directly
                    disp.MapScalars = 0
                    
                    if cell_id in state.highlight_cell_ids:
                        # Highlight overlapping cells as RED
                        target_color = [1.0, 0.0, 0.0]  # Bright Red
                        disp.DiffuseColor = target_color
                        disp.AmbientColor = target_color
                        disp.Ambient = 0.3
                    else:
                        # Assign deterministic color from palette
                        palette = pipeline['color_palette']
                        target_color = palette[cell_id % len(palette)]
                        disp.DiffuseColor = target_color
                        disp.AmbientColor = target_color
                        disp.Ambient = 0.1
                    
                    pipeline['cell_displays'][cell_id] = disp

            # Markers visibility
            if pipeline.get('marker_reader'):
                if state.show_overlaps:
                    if not pipeline.get('marker_display'):
                        disp = simple.Show(pipeline['marker_reader'], view)
                        disp.Representation = 'Surface'
                        disp.DiffuseColor = [1.0, 1.0, 0.0]  # Bright Yellow for markers to contrast with Red cells
                        disp.Opacity = 1.0
                        disp.Ambient = 0.5
                        pipeline['marker_display'] = disp
                    else:
                        simple.Show(pipeline['marker_reader'], view)
                else:
                    if pipeline.get('marker_display'):
                        simple.Hide(pipeline['marker_reader'], view)

            simple.Render(view)
        except Exception as e:
            print(f"Error updating visibility: {e}")

    @state.change("cell_visibility")
    def on_cell_visibility_change(cell_visibility, **kwargs):
        update_cell_visibility(cell_visibility)
        update_view()

    @state.change("show_overlaps")
    def on_show_overlaps(show_overlaps, **kwargs):
        update_cell_visibility()
        update_view()

    @state.change("opacity")
    def on_opacity(opacity, **kwargs):
        for disp in pipeline['cell_displays'].values():
            disp.Opacity = float(opacity)
        update_view()

    @state.change("background_color_hex")
    def on_background_color_change(background_color_hex, **kwargs):
        rgb = hex_to_rgb(background_color_hex)
        if rgb:
            view.Background = rgb
        update_view()

    @state.change("selected_cell_id")
    def on_selected_cell_change(selected_cell_id, **kwargs):
        if selected_cell_id is not None:
            # Show ONLY the selected cell
            state.cell_visibility = {str(c['id']): (c['id'] == selected_cell_id) for c in state.cell_info}
            # Also highlight it in RED
            state.highlight_cell_ids = [selected_cell_id]
        else:
            # Show ALL cells
            state.cell_visibility = {str(c['id']): True for c in state.cell_info}
            # Clear highlights
            state.highlight_cell_ids = highlight_cells if highlight_cells else []
            
        update_cell_visibility()
        simple.ResetCamera()
        update_view(push_camera=True)

    # Initial setup
    update_cell_visibility()
    simple.ResetCamera()
    
    # Controllers
    reset_camera = create_reset_camera_controller(pipeline, update_view)
    
    def set_camera_view(view_type):
        bounds = get_data_bounds(pipeline['cell_reader'])
        pos, focal, up = calculate_camera_position(view_type, bounds)
        view.CameraPosition, view.CameraFocalPoint, view.CameraViewUp = pos, focal, up
        update_view(push_camera=True)

    # UI
    with VAppLayout(server) as layout:
        with vuetify.VNavigationDrawer(v_model=("show_controls", True), app=True, width=300, dark=True):
            with vuetify.VContainer():
                vuetify.VSubheader("OpenMC Geometry", classes="text-h6 pa-0")
                vuetify.VDivider(classes="mb-4")
                
                UIComponents.opacity_slider(vuetify, ("opacity", 0.7))
                
                if overlap_markers:
                    vuetify.VCheckbox(v_model=("show_overlaps", True), label="Show Overlap Markers", color="error")
                
                vuetify.VDivider(classes="my-4")
                vuetify.VSubheader("Cell Selection", classes="text-subtitle-1 mb-2")
                vuetify.VSelect(
                    v_model=("selected_cell_id", None),
                    items=("cell_info", []), item_text="name", item_value="id",
                    label="Select Cell to View", dense=True, outlined=True, clearable=True
                )
                
                vuetify.VDivider(classes="my-4")
                vuetify.VSubheader("Camera", classes="text-subtitle-1 mb-2")
                with vuetify.VRow(dense=True):
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn("Reset", click=reset_camera, block=True, small=True, outlined=True)
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn("Isometric", click=lambda: set_camera_view('isometric'), block=True, small=True, outlined=True)
                
                vuetify.VDivider(classes="my-4")
                UIComponents.background_color_picker(vuetify, ("background_color_hex", "#1a1a26"))

        with vuetify.VMain():
            view_widget = pv_widgets.VtkRemoteView(view, interactive_ratio=1, style="width: 100%; height: 100%;")
            state.view_widget = view_widget
            
            @state.change("camera_update_counter")
            def on_camera_update(camera_update_counter, **kwargs):
                simple.Render(view)
                view_widget.update()

    server.start(port=port, debug=False, open_browser=False)
    
    # Cleanup
    for f in [cell_file, surf_file, marker_file]:
        if f and os.path.exists(f): os.remove(f)
    
    return 0

if __name__ == '__main__':
    import sys
    import argparse
    
    parser = argparse.ArgumentParser(description='Visualize OpenMC geometry in 3D')
    parser.add_argument('geometry', help='Path to geometry.xml')
    parser.add_argument('--port', type=int, default=8090, help='Server port')
    parser.add_argument('--highlight', help='Comma-separated cell IDs to highlight')
    parser.add_argument('--overlaps', help='Path to JSON file with overlap markers')
    
    args = parser.parse_args()
    
    highlight_ids = None
    if args.highlight:
        highlight_ids = [int(x.strip()) for x in args.highlight.split(',')]
        
    sys.exit(visualize_geometry(args.geometry, args.port, highlight_ids, args.overlaps))
