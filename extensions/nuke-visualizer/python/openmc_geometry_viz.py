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
        
        # Parse region to extract surface references
        surfaces = self._parse_region(region)
        
        self.cells[cell_id] = Cell(
            id=cell_id,
            region=region,
            surfaces=surfaces,
            universe=universe
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
        # For now, create a simple representation based on cell's surfaces
        # This is a simplified approach - full CSG rendering requires complex Boolean operations
        
        if not cell.surfaces:
            return None
        
        # Try to create a bounding box representation
        # In a full implementation, this would do proper CSG operations
        
        # For cells with planes, create a box
        planes = []
        for surf_id, is_comp in cell.surfaces.items():
            if surf_id in self.surfaces:
                surf = self.surfaces[surf_id]
                if surf.type in ('x-plane', 'y-plane', 'z-plane'):
                    planes.append((surf, is_comp))
        
        if len(planes) >= 2:
            return self._create_box_from_planes(planes, cell.id)
        
        # For cells with cylinders, create a cylindrical representation
        cylinders = []
        for surf_id, is_comp in cell.surfaces.items():
            if surf_id in self.surfaces:
                surf = self.surfaces[surf_id]
                if surf.type in ('z-cylinder', 'cylinder'):
                    cylinders.append((surf, is_comp))
        
        if cylinders:
            return self._create_cylinder_geometry(cylinders[0][0], cell.id)
        
        return None
    
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
        """Create VTK geometry for a single surface."""
        if surf.type == 'x-plane' and surf.coefficients:
            return self._create_plane_surface('x', surf.coefficients[0])
        elif surf.type == 'y-plane' and surf.coefficients:
            return self._create_plane_surface('y', surf.coefficients[0])
        elif surf.type == 'z-plane' and surf.coefficients:
            return self._create_plane_surface('z', surf.coefficients[0])
        elif surf.type in ('z-cylinder', 'cylinder') and len(surf.coefficients) >= 3:
            return self._create_cylinder_surface(surf)
        return None
    
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
    
    # Pipeline storage (non-serializable objects)
    pipeline = {
        'cell_display': None,
        'surf_display': None,
        'view': None,
        'view_widget': None,
    }
    
    # Load in ParaView
    cell_reader = simple.XMLMultiBlockDataReader(FileName=cell_file)
    surf_reader = simple.XMLMultiBlockDataReader(FileName=surf_file)
    
    # Show cells
    cell_display = simple.Show(cell_reader)
    cell_display.Representation = 'Surface'
    pipeline['cell_display'] = cell_display
    
    # Color by cell ID
    simple.ColorBy(cell_display, ('CELLS', 'cell_id'))
    cell_lut = simple.GetColorTransferFunction('cell_id')
    
    # Show surfaces as wireframe
    surf_display = simple.Show(surf_reader)
    surf_display.Representation = 'Wireframe'
    surf_display.Opacity = 0.3
    pipeline['surf_display'] = surf_display
    
    view = simple.GetActiveViewOrCreate('RenderView')
    view.Background = [0.1, 0.1, 0.15]
    view.UseColorPaletteForBackground = 0
    pipeline['view'] = view
    
    simple.Render(view)
    simple.ResetCamera()
    
    # State
    state.show_cells = True
    state.show_surfaces = True
    state.opacity = 1.0
    state.show_controls = True
    state.camera_update_counter = 0
    
    def update_view(push_camera=False):
        """Update the view after state changes."""
        try:
            v = pipeline.get('view')
            view_widget = pipeline.get('view_widget')
            
            if v:
                simple.Render(v)
            
            if view_widget:
                if push_camera:
                    state.camera_update_counter += 1
                else:
                    view_widget.update()
        except Exception as e:
            print(f"Error updating view: {e}")
    
    @state.change("show_cells")
    def on_show_cells(show_cells, **kwargs):
        cell_disp = pipeline.get('cell_display')
        if cell_disp:
            cell_disp.Visibility = 1 if show_cells else 0
            update_view()
    
    @state.change("show_surfaces")
    def on_show_surfaces(show_surfaces, **kwargs):
        surf_disp = pipeline.get('surf_display')
        if surf_disp:
            surf_disp.Visibility = 1 if show_surfaces else 0
            update_view()
    
    @state.change("opacity")
    def on_opacity(opacity, **kwargs):
        cell_disp = pipeline.get('cell_display')
        if cell_disp:
            cell_disp.Opacity = float(opacity)
            update_view()
    
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
                
                vuetify.VCheckbox(
                    v_model=("show_cells", True),
                    label="Show Cells",
                    dense=True
                )
                
                vuetify.VCheckbox(
                    v_model=("show_surfaces", True),
                    label="Show Surfaces (Wireframe)",
                    dense=True
                )
                
                vuetify.VSlider(
                    label="Cell Opacity",
                    v_model=("opacity", 1.0),
                    min=0, max=1, step=0.1,
                    dense=True
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
