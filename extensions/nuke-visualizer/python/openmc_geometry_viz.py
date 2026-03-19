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
    
    def create_vtk_geometry(self, highlight_cell_id: Optional[int] = None) -> vtk.vtkMultiBlockDataSet:
        """
        Create VTK representation of the geometry.
        
        Args:
            highlight_cell_id: Optional cell ID to highlight
            
        Returns:
            VTK MultiBlock dataset with geometry
        """
        multi_block = vtk.vtkMultiBlockDataSet()
        
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
                
                # Add highlight array if this is the highlighted cell
                highlight = vtk.vtkIntArray()
                highlight.SetName("highlight")
                highlight.SetNumberOfValues(cell_polydata.GetNumberOfCells())
                is_highlighted = 1 if highlight_cell_id == cell_id else 0
                for i in range(cell_polydata.GetNumberOfCells()):
                    highlight.SetValue(i, is_highlighted)
                cell_polydata.GetCellData().AddArray(highlight)
                
                multi_block.SetBlock(cell_count, cell_polydata)
                multi_block.GetMetaData(cell_count).Set(vtk.vtkCompositeDataSet.NAME(), f"Cell_{cell_id}")
                cell_count += 1
        
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


def visualize_geometry(geometry_file: str, port: int = 8090, highlight_cell: Optional[int] = None):
    """
    Start a visualization server for OpenMC geometry.
    
    Args:
        geometry_file: Path to geometry.xml
        port: Server port
        highlight_cell: Cell ID to highlight
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
    
    # Create VTK data
    cell_data = viz.create_vtk_geometry(highlight_cell)
    surface_data = viz.create_surface_geometry()
    
    # Write to temporary files
    with tempfile.NamedTemporaryFile(suffix='.vtm', delete=False) as tmp:
        cell_file = tmp.name
    with tempfile.NamedTemporaryFile(suffix='.vtm', delete=False) as tmp:
        surf_file = tmp.name
    
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
            
            # If highlight_cell is specified, only show that cell initially
            if highlight_cell is not None:
                cell_visibility[str(cell_id)] = (cell_id == highlight_cell)
            else:
                cell_visibility[str(cell_id)] = True  # Default all visible
        except (ValueError, IndexError):
            continue
    
    # Build surface index -> cell IDs mapping (for reverse lookup)
    surface_to_cells: Dict[int, set] = {}
    for cell in viz.cells.values():
        for surf_id in cell.surfaces.keys():
            if surf_id not in surface_to_cells:
                surface_to_cells[surf_id] = set()
            surface_to_cells[surf_id].add(cell.id)
    
    # Get all surface IDs from surface_data
    all_surf_ids = set()
    num_surf_blocks = surface_data.GetNumberOfBlocks()
    for i in range(num_surf_blocks):
        meta = surface_data.GetMetaData(i)
        if meta and meta.Has(vtk.vtkCompositeDataSet.NAME()):
            block_name = meta.Get(vtk.vtkCompositeDataSet.NAME())
            try:
                surf_id = int(block_name.split('_')[1])
                all_surf_ids.add(surf_id)
            except:
                continue
    
    # Build surface ID -> block name mapping
    surf_id_to_block = {}
    for i in range(num_surf_blocks):
        meta = surface_data.GetMetaData(i)
        if meta and meta.Has(vtk.vtkCompositeDataSet.NAME()):
            block_name = meta.Get(vtk.vtkCompositeDataSet.NAME())
            try:
                surf_id = int(block_name.split('_')[1])
                surf_id_to_block[surf_id] = block_name
            except:
                continue
    
    # Pipeline storage (non-serializable objects)
    pipeline = {
        'cell_reader': None,
        'surf_reader': None,
        'cell_extracts': {},  # cell_id -> extract filter
        'cell_displays': {},  # cell_id -> display object
        'surf_extracts': {},  # surf_id -> extract filter
        'surf_displays': {},  # surf_id -> display object
        'view': None,
        'view_widget': None,
        'cell_lut': None,
        'surf_id_to_block': surf_id_to_block,  # For looking up surface block names
    }
    
    # Load in ParaView
    cell_reader = simple.XMLMultiBlockDataReader(FileName=cell_file)
    surf_reader = simple.XMLMultiBlockDataReader(FileName=surf_file)
    pipeline['cell_reader'] = cell_reader
    pipeline['surf_reader'] = surf_reader
    
    # Hide the original readers
    simple.Hide(cell_reader)
    simple.Hide(surf_reader)
    
    view = simple.GetActiveViewOrCreate('RenderView')
    view.Background = [0.1, 0.1, 0.15]
    view.UseColorPaletteForBackground = 0
    pipeline['view'] = view
    
    # Create categorical LUT for materials (color by material instead of cell_id)
    material_lut = simple.GetColorTransferFunction('material')
    pipeline['material_lut'] = material_lut
    material_lut.InterpretValuesAsCategories = 1
    # Use distinct colors for materials
    material_lut.IndexedColors = [
        0.9, 0.3, 0.3,  # Red
        0.3, 0.9, 0.3,  # Green
        0.3, 0.3, 0.9,  # Blue
        0.9, 0.9, 0.3,  # Yellow
        0.9, 0.3, 0.9,  # Magenta
        0.3, 0.9, 0.9,  # Cyan
        0.9, 0.6, 0.3,  # Orange
        0.6, 0.3, 0.9,  # Purple
        0.9, 0.9, 0.9,  # White
        0.5, 0.5, 0.5,  # Gray
    ]
    
    # Initial render and camera reset
    simple.Render(view)
    simple.ResetCamera()
    
    # Trigger initial visibility setup (creates extracts for visible cells)
    # This is deferred to ensure state is fully initialized
    
    # State
    state.show_cells = True  # Always show cells (no checkbox needed)
    state.show_surfaces = False  # Disabled
    state.opacity = 0.7
    state.show_controls = True
    state.camera_update_counter = 0
    state.cell_info = cell_info
    state.cell_visibility = cell_visibility
    state.selected_cell_id = highlight_cell
    state.background_color_hex = "#1a1a26"  # Dark blue default
    
    def update_view(push_camera=False):
        """Update the view after state changes."""
        try:
            v = pipeline.get('view')
            view_widget = pipeline.get('view_widget')
            if v: simple.Render(v)
            if view_widget:
                if push_camera: state.camera_update_counter += 1
                else: view_widget.update()
        except Exception as e:
            print(f"Error updating view: {e}")
    
    @state.change("show_cells")
    def on_show_cells(show_cells, **kwargs):
        update_cell_visibility()
        update_view()
    
    @state.change("show_surfaces")
    def on_show_surfaces(show_surfaces, **kwargs):
        update_cell_visibility()
        update_view()
    
    @state.change("opacity")
    def on_opacity(opacity, **kwargs):
        for disp in pipeline['cell_displays'].values():
            disp.Opacity = float(opacity)
        update_view()
    
    def update_cell_visibility(visibility=None):
        """Update which cells and surfaces are visible based on cell_visibility state.
        
        Uses hard reset approach to fix wireframe flushing issues:
        1. Hide everything first (guarantees clean slate)
        2. Force render (flushes ParaView pipeline)
        3. Show only what's needed
        4. Force final render
        """
        try:
            if visibility is None:
                visibility = state.cell_visibility
                
            cell_displays = pipeline.get('cell_displays', {})
            surf_displays = pipeline.get('surf_displays', {})
            view = pipeline.get('view')
            
            # Convert keys to strings for matching
            visibility_keys = {str(k): v for k, v in visibility.items()}
            
            # Calculate what should be visible
            active_surf_ids = set()
            visible_count = 0
            visible_cell_ids = set()
            
            for cell in state.cell_info:
                cell_id = cell['id']
                cell_id_str = str(cell_id)
                is_visible = visibility_keys.get(cell_id_str, False)
                
                if is_visible and state.show_cells:
                    visible_count += 1
                    visible_cell_ids.add(cell_id)
                    # Collect surfaces for this visible cell
                    if 'surf_selectors' in cell:
                        for s_sel in cell['surf_selectors']:
                            try:
                                s_id = int(s_sel.split('_')[1])
                                active_surf_ids.add(s_id)
                            except: continue
            
            # Determine which surfaces to show
            show_all_surfaces = (visible_count == len(state.cell_info))
            surf_ids_to_show = set()
            if state.show_surfaces and visible_count > 0:
                if show_all_surfaces:
                    surf_ids_to_show = set(surf_displays.keys())
                else:
                    surf_ids_to_show = active_surf_ids
            
            # RECREATE EXTRACTS ON DEMAND - guarantees clean state
            cell_reader = pipeline['cell_reader']
            surf_reader = pipeline['surf_reader']
            surf_id_to_block = pipeline['surf_id_to_block']
            
            # STEP 1: Delete old cell extracts and displays
            for cell_id, extract in list(pipeline['cell_extracts'].items()):
                try:
                    simple.Delete(extract)
                except:
                    pass
            pipeline['cell_extracts'].clear()
            pipeline['cell_displays'].clear()
            
            # STEP 2: Delete old surface extracts and displays
            for surf_id, extract in list(pipeline['surf_extracts'].items()):
                try:
                    simple.Delete(extract)
                except:
                    pass
            pipeline['surf_extracts'].clear()
            pipeline['surf_displays'].clear()
            
            # STEP 3: Force render to flush
            view.Modified()
            simple.Render(view)
            
            # STEP 4: Create new extracts for visible cells
            for cell in state.cell_info:
                cell_id = cell['id']
                if cell_id in visible_cell_ids:
                    extract = simple.ExtractBlock(Input=cell_reader)
                    extract.Selectors = [cell['selector']]
                    pipeline['cell_extracts'][cell_id] = extract
                    
                    disp = simple.Show(extract, view)
                    disp.Representation = 'Surface'
                    disp.Opacity = float(state.opacity)
                    # Color by material instead of cell_id
                    simple.ColorBy(disp, ('CELLS', 'material'))
                    pipeline['cell_displays'][cell_id] = disp
            
            # NOTE: Surface wireframe disabled to avoid rendering issues
            # The wireframes were persisting between cell selections.
            # To re-enable, uncomment the block below and fix the flushing issue.
            
            # STEP 5: Create new extracts for visible surfaces (DISABLED)
            # for surf_id in surf_ids_to_show:
            #     if surf_id in surf_id_to_block:
            #         block_name = surf_id_to_block[surf_id]
            #         extract = simple.ExtractBlock(Input=surf_reader)
            #         extract.Selectors = [f"/Root/{block_name}"]
            #         pipeline['surf_extracts'][surf_id] = extract
            #         
            #         disp = simple.Show(extract, view)
            #         disp.Representation = 'Wireframe'
            #         disp.Opacity = 0.3
            #         disp.Ambient = 1.0
            #         disp.Diffuse = 0.0
            #         pipeline['surf_displays'][surf_id] = disp
            
            # STEP 6: Final render
            view.Modified()
            simple.Render(view)
                
        except Exception as e:
            print(f"Error updating visibility: {e}")
            import traceback
            traceback.print_exc()
    
    @state.change("cell_visibility")
    def on_cell_visibility_change(cell_visibility, **kwargs):
        """Handle cell visibility toggle."""
        update_cell_visibility(cell_visibility)
        update_view()
    
    def zoom_to_cell(cell_id):
        """Zoom camera to fit a specific cell."""
        try:
            v = pipeline.get('view')
            cell_extracts = pipeline.get('cell_extracts', {})
            if not v or cell_id not in cell_extracts:
                return False
            
            extract = cell_extracts[cell_id]
            # Get bounds of the cell
            bounds = extract.GetDataInformation().GetBounds()
            if bounds and len(bounds) >= 6:
                xmin, xmax, ymin, ymax, zmin, zmax = bounds
                # Reset camera to focus on these bounds
                v.ResetCamera(bounds)
                simple.Render(v)
                return True
        except Exception as e:
            print(f"Error zooming to cell: {e}")
        return False
    
    @state.change("selected_cell_id")
    def on_selected_cell_change(selected_cell_id, **kwargs):
        """Auto-show selected cell when dropdown changes and zoom to it."""
        if selected_cell_id is not None:
            # Show only the selected cell
            state.cell_visibility = {str(c['id']): str(c['id']) == str(selected_cell_id) 
                                      for c in state.cell_info}
            update_cell_visibility()
            # Zoom to the selected cell
            zoom_to_cell(selected_cell_id)
        else:
            # If cleared, show all cells
            state.cell_visibility = {str(c['id']): True for c in state.cell_info}
            update_cell_visibility()
        update_view(push_camera=True)
    
    @state.change("background_color_hex")
    def on_background_color_change(background_color_hex, **kwargs):
        """Handle background color change."""
        try:
            v = pipeline.get('view')
            if v and background_color_hex:
                # Convert hex to RGB
                hex_color = background_color_hex.lstrip('#')
                if len(hex_color) >= 6:
                    r = int(hex_color[0:2], 16) / 255.0
                    g = int(hex_color[2:4], 16) / 255.0
                    b = int(hex_color[4:6], 16) / 255.0
                    v.UseColorPaletteForBackground = 0
                    v.Background = [r, g, b]
                    simple.Render(v)
                    update_view()
        except Exception as e:
            print(f"Error changing background color: {e}")
    
    # Initialize extract block filter (show all cells initially)
    update_cell_visibility()
    
    # Camera functions
    def get_data_bounds():
        """Get bounds of the geometry."""
        try:
            return cell_reader.GetDataInformation().GetBounds()
        except:
            return [-1, 1, -1, 1, -1, 1]
    
    def calculate_camera_position(view_type, bounds):
        """Calculate camera position for different views."""
        xmin, xmax, ymin, ymax, zmin, zmax = bounds
        cx = (xmin + xmax) / 2
        cy = (ymin + ymax) / 2
        cz = (zmin + zmax) / 2
        dx = xmax - xmin
        dy = ymax - ymin
        dz = zmax - zmin
        diagonal = (dx*dx + dy*dy + dz*dz) ** 0.5
        distance = diagonal * 1.5 if diagonal > 0 else 5
        
        if view_type == 'isometric':
            return [cx + distance * 0.7, cy + distance * 0.7, cz + distance * 0.7], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'front':
            return [cx, cy - distance, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'back':
            return [cx, cy + distance, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'left':
            return [cx - distance, cy, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'right':
            return [cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'top':
            return [cx, cy, cz + distance], [cx, cy, cz], [0, 1, 0]
        elif view_type == 'bottom':
            return [cx, cy, cz - distance], [cx, cy, cz], [0, -1, 0]
        return [cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]
    
    @server.controller.add("reset_camera")
    def reset_camera():
        """Reset camera to default position."""
        try:
            v = pipeline.get('view')
            if v:
                simple.ResetCamera(v)
                simple.Render(v)
            update_view(push_camera=True)
            return True
        except Exception as e:
            print(f"Error resetting camera: {e}")
            return False
    
    @server.controller.add("set_camera_view")
    def set_camera_view(view_type):
        """Set camera to preset view."""
        try:
            v = pipeline.get('view')
            if not v:
                return False
            
            bounds = get_data_bounds()
            position, focal_point, view_up = calculate_camera_position(view_type, bounds)
            
            v.CameraPosition = position
            v.CameraFocalPoint = focal_point
            v.CameraViewUp = view_up
            
            simple.Render(v)
            update_view(push_camera=True)
            return True
        except Exception as e:
            print(f"Error setting camera view: {e}")
            return False
    
    @server.controller.add("toggle_controls")
    def toggle_controls():
        """Toggle control panel visibility."""
        state.show_controls = not state.show_controls
        return state.show_controls
    
    # Cell visibility controller functions
    @server.controller.add("show_all_cells")
    def show_all_cells():
        """Show all cells."""
        state.cell_visibility = {str(c['id']): True for c in state.cell_info}
        return True
    
    @server.controller.add("hide_all_cells")
    def hide_all_cells():
        """Hide all cells."""
        state.cell_visibility = {str(c['id']): False for c in state.cell_info}
        return True
    
    @server.controller.add("show_only_selected_cell")
    def show_only_selected_cell():
        """Show only the selected cell."""
        selected_id = state.selected_cell_id
        if selected_id is not None:
            state.cell_visibility = {str(c['id']): str(c['id']) == str(selected_id) for c in state.cell_info}
        return True
    
    # UI
    with VAppLayout(server) as layout:
        with vuetify.VNavigationDrawer(
            v_model=("show_controls", True),
            app=True,
            width=300,
            dark=True
        ):
            with vuetify.VContainer():
                # Header with hide button
                with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                    vuetify.VSubheader("OpenMC Geometry", classes="text-h6 pa-0")
                    with vuetify.VBtn(
                        click=toggle_controls,
                        small=True,
                        icon=True
                    ):
                        vuetify.VIcon("mdi-chevron-left")
                vuetify.VDivider(classes="mb-4")
                
                # Cell Opacity
                vuetify.VSlider(
                    label="Cell Opacity",
                    v_model=("opacity", 0.7),
                    min=0, max=1, step=0.1,
                    dense=True
                )
                
                # Cell Selection - Auto-shows when selected
                vuetify.VDivider(classes="my-4")
                
                vuetify.VSubheader("Cell Selection", classes="text-subtitle-1 mb-2")
                
                vuetify.VSelect(
                    v_model=("selected_cell_id", None),
                    items=("cell_info", []),
                    item_text="name",
                    item_value="id",
                    label="Select Cell to View",
                    dense=True,
                    outlined=True,
                    classes="mb-2",
                    clearable=True,

                )
                
                vuetify.VDivider(classes="my-4")
                
                # Camera Section
                vuetify.VSubheader("Camera", classes="text-subtitle-1 mb-2")
                
                with vuetify.VRow(dense=True):
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Reset",
                            click=reset_camera,
                            block=True,
                            small=True,
                            outlined=True,
                            classes="mb-2"
                        )
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Isometric",
                            click=lambda: set_camera_view('isometric'),
                            block=True,
                            small=True,
                            outlined=True,
                            classes="mb-2"
                        )
                
                with vuetify.VRow(dense=True):
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Front",
                            click=lambda: set_camera_view('front'),
                            block=True,
                            small=True,
                            text=True
                        )
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Side",
                            click=lambda: set_camera_view('right'),
                            block=True,
                            small=True,
                            text=True
                        )
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Top",
                            click=lambda: set_camera_view('top'),
                            block=True,
                            small=True,
                            text=True
                        )

                vuetify.VDivider(classes="my-4")

                with vuetify.VContainer(classes="ma-0 pa-0 mb-4", style="overflow: hidden;"):
                    vuetify.VSubheader("Background Color", classes="pa-0 text-body-2")
                    vuetify.VColorPicker(
                        v_model=("background_color_hex", "#1a1a26"),
                        hide_inputs=True,
                        hide_mode_switch=True,
                        show_swatches=True,
                        swatches_max_height=100,
                        mode="hexa",
                        elevation=0,
                        classes="ma-0 pa-0",
                        style="background: transparent; max-width: 100%;",
                    )

        with vuetify.VMain():
            # Toggle button when controls are hidden
            with vuetify.VContainer(
                v_if=("!show_controls",),
                classes="ma-2 pa-0",
                style="position: absolute; top: 0; left: 0; z-index: 100;"
            ):
                with vuetify.VBtn(
                    click=toggle_controls,
                    small=True,
                    fab=True,
                    color="primary"
                ):
                    vuetify.VIcon("mdi-chevron-right")
            
            # Main visualization view
            view_widget = pv_widgets.VtkRemoteView(
                view,
                interactive_ratio=1,
                style="width: 100%; height: 100%; position: absolute; top: 0; left 0;",
            )
            pipeline['view_widget'] = view_widget
            
            # Watch for camera update counter changes
            @state.change("camera_update_counter")
            def on_camera_update(camera_update_counter, **kwargs):
                try:
                    simple.Render(view)
                    view_widget.update()
                except Exception as e:
                    print(f"Warning: camera update failed: {e}")
    
    print(f"Starting OpenMC geometry server on port {port}")
    server.start(port=port, debug=False, open_browser=False)
    
    # Cleanup temp files
    try:
        os.remove(cell_file)
        os.remove(surf_file)
    except:
        pass
    
    return 0


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("Usage: python openmc_geometry_viz.py <geometry.xml> [port] [highlight_cell_id]")
        sys.exit(1)
    
    geometry_file = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8090
    highlight = int(sys.argv[3]) if len(sys.argv) > 3 else None
    
    sys.exit(visualize_geometry(geometry_file, port, highlight))
