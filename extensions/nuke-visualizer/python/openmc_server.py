#!/usr/bin/env python3
"""
OpenMC visualization server for NukeIDE.
Supports mesh tally and source distribution visualization.
"""

import argparse
import json
import sys
import os
import tempfile
import socket
import numpy as np

# Force headless/offscreen rendering BEFORE importing vtk or paraview
os.environ['DISPLAY'] = ''  # Disable X11 display
os.environ['QT_QPA_PLATFORM'] = 'offscreen'  # Qt offscreen platform
os.environ['VTK_USE_OFFSCREEN'] = '1'  # VTK offscreen rendering

def find_free_port(start_port=8090, max_port=9000):
    """Find an available port in the given range."""
    for port in range(start_port, max_port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('', port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start_port}-{max_port}")


from openmc_integration import OpenMCReader


def cmd_info(args):
    """Get statepoint info."""
    reader = OpenMCReader()
    info = reader.load_statepoint(args.statepoint)
    print(json.dumps(info, indent=2))
    return 0


def cmd_list(args):
    """List tallies in statepoint file."""
    reader = OpenMCReader()
    tallies = reader.list_tallies(args.statepoint)
    print(json.dumps(tallies, indent=2))
    return 0


def cmd_visualize_mesh(args):
    """Visualize a mesh tally."""
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.widgets import html
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)
    
    reader = OpenMCReader()
    
    try:
        # Load all tallies for the selector
        all_tallies = reader.list_tallies(args.statepoint)
        mesh_tallies = [t for t in all_tallies if t.get('has_mesh', False)]
        
        # Load the specific tally
        tally = reader.load_tally(args.statepoint, args.tally_id)
        
        if not tally.has_mesh:
            print(f"Error: Tally {args.tally_id} is not a mesh tally", file=sys.stderr)
            return 1

        # Check mesh type for info
        mesh_type = tally.mesh_info.get('mesh_type', 'regular') if tally.mesh_info else 'regular'
        print(f"[OpenMC] Loading {mesh_type} mesh for tally {args.tally_id}", file=sys.stderr)

        # Helper to resolve string names to integer indices
        def resolve_index(val, lst, default=0):
            if val is None:
                return default
            try:
                return int(val)
            except (ValueError, TypeError):
                if lst and val in lst:
                    return lst.index(val)
                print(f"Warning: '{val}' not found in {lst}. Defaulting to index {default}.", file=sys.stderr)
                return default

        score_idx = resolve_index(args.score_index, tally.scores)
        nuclide_idx = resolve_index(args.nuclide_index, tally.nuclides)
        
        # Create VTK grid from tally
        mesh_grid = reader.create_mesh_tally_vtu(tally, score_idx, nuclide_idx)
        
        # Extract mesh info for display
        mesh_info_display = {}
        if tally.mesh_info:
            mesh = tally.mesh_info
            mesh_type = mesh.get('mesh_type', 'regular')
            
            if mesh_type == 'cylindrical':
                # Cylindrical mesh display
                r_grid = mesh.get('r_grid', [])
                phi_grid = mesh.get('phi_grid', [])
                z_grid = mesh.get('z_grid', [])
                nr = len(r_grid) - 1 if len(r_grid) > 1 else 0
                nphi = len(phi_grid) - 1 if len(phi_grid) > 1 else 0
                nz = len(z_grid) - 1 if len(z_grid) > 1 else 0
                
                mesh_info_display = {
                    'type': 'Cylindrical',
                    'dimensions': f"{nr} × {nphi} × {nz} (r×φ×z)",
                    'bounds': f"r: [{r_grid[0]:.3f}, {r_grid[-1]:.3f}] cm, φ: [{phi_grid[0]:.3f}, {phi_grid[-1]:.3f}] rad, z: [{z_grid[0]:.3f}, {z_grid[-1]:.3f}] cm",
                    'width': f"Δr: {(r_grid[-1]-r_grid[0])/nr:.4f} cm" if nr > 0 else "N/A"
                }
            else:
                # Regular mesh display
                mesh_info_display = {
                    'type': 'Regular (Cartesian)',
                    'dimensions': ' × '.join(str(d) for d in mesh.get('dimensions', [])),
                    'bounds': f"({', '.join(f'{v:.3f}' for v in mesh.get('lower_left', []))}) to ({', '.join(f'{v:.3f}' for v in mesh.get('upper_right', []))})",
                    'width': ' × '.join(f'{v:.4f}' for v in mesh.get('width', []))
                }
        
        # Write to temporary file
        import vtk
        from vtk.util import numpy_support
        
        with tempfile.NamedTemporaryFile(suffix='.vtu', delete=False) as tmp:
            tmp_path = tmp.name
        
        writer = vtk.vtkXMLUnstructuredGridWriter()
        writer.SetFileName(tmp_path)
        writer.SetInputData(mesh_grid)
        writer.Write()
        
        # Create trame application
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Initialize state variables
        state.opacity = 1.0
        state.representation = 'Surface'
        state.color_by = 'Cell: tally_mean'
        state.color_map = args.colormap or 'Cool to Warm'
        state.show_scalar_bar = True
        state.background_color_hex = '#1a1a26'
        state.show_orientation_axes = True
        state.show_bounding_box = False
        state.show_cube_axes = False  # Coordinate grid
        state.screenshot_status = ""
        state.camera_update_counter = 0  # Used to trigger camera updates
        
        # Appearance details
        state.point_size = 2.0
        state.line_width = 1.0
        state.ambient_light = 0.2
        state.parallel_projection = False
        
        # Tally and mesh info for display
        state.mesh_type = mesh_info_display.get('type', 'Unknown')
        state.mesh_dimensions = mesh_info_display.get('dimensions', 'N/A')
        state.mesh_bounds = mesh_info_display.get('bounds', 'N/A')
        state.mesh_width = mesh_info_display.get('width', 'N/A')
        
        # Score and nuclide info
        state.current_score = tally.scores[score_idx] if tally.scores and score_idx < len(tally.scores) else 'total'
        state.current_nuclide = tally.nuclides[nuclide_idx] if tally.nuclides and nuclide_idx < len(tally.nuclides) else 'total'
        
        # Load the data in ParaView
        vtk_source = simple.XMLUnstructuredGridReader(FileName=tmp_path)
        
        # Get available arrays
        available_arrays = ['Solid Color']
        cell_data = vtk_source.CellData
        for i in range(cell_data.GetNumberOfArrays()):
            array = cell_data.GetArray(i)
            if array:
                available_arrays.append(f"Cell: {array.GetName()}")
        
        state.available_arrays = available_arrays
        
        # Create visualization
        display = simple.Show(vtk_source)
        view = simple.GetActiveViewOrCreate('RenderView')
        
        # Set coloring
        simple.ColorBy(display, ('CELLS', 'tally_mean'))
        lut = simple.GetColorTransferFunction('tally_mean')
        lut.ApplyPreset(state.color_map, True)
        
        # Set initial background color
        view.Background = [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        
        # Configure scalar bar (color legend)
        scalar_bar = simple.GetScalarBar(lut, view)
        if scalar_bar:
            scalar_bar.Visibility = 1
            scalar_bar.Title = 'Tally Mean'
        
        # Show orientation axes
        view.OrientationAxesVisibility = 1
        
        simple.Render(view)
        simple.ResetCamera()
        
        # Define update function
        def update_view(push_camera=False):
            """Update the view - called after state changes."""
            try:
                simple.Render(view)
                vw = state.view_widget
                if vw:
                    if push_camera:
                        state.camera_update_counter = state.camera_update_counter + 1 if hasattr(state, 'camera_update_counter') else 1
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)
        
        def hex_to_rgb(hex_color):
            """Convert hex color to RGB list [r, g, b] with values 0-1."""
            hex_color = hex_color.lstrip('#')
            return [
                int(hex_color[0:2], 16) / 255.0,
                int(hex_color[2:4], 16) / 255.0,
                int(hex_color[4:6], 16) / 255.0
            ]
        
        def get_data_bounds():
            """Get the bounds of the current data."""
            try:
                return vtk_source.GetDataInformation().GetBounds()
            except:
                return [-1, 1, -1, 1, -1, 1]
        
        def calculate_camera_position(view_type, bounds):
            """Calculate camera position based on data bounds."""
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
        
        # State change handlers
        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            try:
                if color_by == 'Solid Color':
                    simple.ColorBy(display, None)
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                    simple.ColorBy(display, ('CELLS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                update_view()
            except Exception as e:
                print(f"Error updating color: {e}", file=sys.stderr)
        
        @state.change("color_map")
        def on_color_map_change(color_map, **kwargs):
            try:
                color_by = state.color_by
                if color_by != 'Solid Color':
                    if color_by.startswith('Cell: '):
                        array_name = color_by[6:]
                        lut = simple.GetColorTransferFunction(array_name)
                        lut.ApplyPreset(color_map, True)
                        update_view()
            except Exception as e:
                print(f"Error updating color map: {e}", file=sys.stderr)
        
        @state.change("opacity")
        def on_opacity_change(opacity, **kwargs):
            try:
                display.Opacity = float(opacity)
                update_view()
            except Exception as e:
                print(f"Error updating opacity: {e}", file=sys.stderr)
        
        @state.change("representation")
        def on_representation_change(representation, **kwargs):
            try:
                display.Representation = representation
                update_view()
            except Exception as e:
                print(f"Error updating representation: {e}", file=sys.stderr)
        
        @state.change("show_scalar_bar")
        def on_scalar_bar_change(show_scalar_bar, **kwargs):
            try:
                color_by = state.color_by
                if color_by == 'Solid Color':
                    return
                if color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                    lut = simple.GetColorTransferFunction(array_name)
                    scalar_bar = simple.GetScalarBar(lut, view)
                    if scalar_bar:
                        scalar_bar.Visibility = 1 if show_scalar_bar else 0
                        update_view()
            except Exception as e:
                print(f"Error updating scalar bar: {e}", file=sys.stderr)
        
        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            try:
                rgb = hex_to_rgb(background_color_hex)
                view.UseColorPaletteForBackground = 0
                view.Background = rgb
                update_view()
            except Exception as e:
                print(f"Error updating background: {e}", file=sys.stderr)
        
        @state.change("show_orientation_axes")
        def on_orientation_axes_change(show_orientation_axes, **kwargs):
            try:
                view.OrientationAxesVisibility = 1 if show_orientation_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating orientation axes: {e}", file=sys.stderr)
        
        @state.change("show_bounding_box")
        def on_bounding_box_change(show_bounding_box, **kwargs):
            try:
                # CenterAxesVisibility is often a display property
                display.CenterAxesVisibility = 1 if show_bounding_box else 0
                update_view()
            except Exception as e:
                try:
                    view.CenterAxesVisibility = 1 if show_bounding_box else 0
                    update_view()
                except:
                    print(f"Error updating bounding box: {e}", file=sys.stderr)
        
        @state.change("show_cube_axes")
        def on_cube_axes_change(show_cube_axes, **kwargs):
            try:
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = 1 if show_cube_axes else 0
                else:
                    # Try on display
                    display.CubeAxesVisibility = 1 if show_cube_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating cube axes: {e}", file=sys.stderr)
                
        @state.change("point_size")
        def on_point_size_change(point_size, **kwargs):
            try:
                display.PointSize = float(point_size)
                update_view()
            except Exception as e:
                print(f"Error updating point size: {e}", file=sys.stderr)
                
        @state.change("line_width")
        def on_line_width_change(line_width, **kwargs):
            try:
                display.LineWidth = float(line_width)
                update_view()
            except Exception as e:
                print(f"Error updating line width: {e}", file=sys.stderr)
                
        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            try:
                display.Ambient = float(ambient_light)
                update_view()
            except Exception as e:
                print(f"Error updating ambient light: {e}", file=sys.stderr)
                
        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            try:
                view.CameraParallelProjection = 1 if parallel_projection else 0
                update_view(True)
            except Exception as e:
                print(f"Error updating projection mode: {e}", file=sys.stderr)
        
        # Define camera functions BEFORE UI setup so lambdas can capture them
        def reset_camera():
            try:
                simple.ResetCamera(view)
                update_view(True)
                return True
            except Exception as e:
                print(f"Error resetting camera: {e}", file=sys.stderr)
                return False
        
        def set_camera_view(view_type):
            try:
                bounds = get_data_bounds()
                position, focal_point, view_up = calculate_camera_position(view_type, bounds)
                view.CameraPosition = position
                view.CameraFocalPoint = focal_point
                view.CameraViewUp = view_up
                update_view(True)
                return True
            except Exception as e:
                print(f"Error setting camera view: {e}", file=sys.stderr)
                return False
        
        def toggle_controls():
            """Toggle control panel visibility."""
            state.show_controls = not state.show_controls
            return state.show_controls
        
        def capture_screenshot(filename=None, width=None, height=None, transparent=False):
            """Capture screenshot of current view."""
            try:
                if not view:
                    return {'success': False, 'error': 'No view available'}
                
                # Store original settings
                original_bg = view.Background[:]
                original_size = view.ViewSize[:]
                
                try:
                    # Set transparent background if requested
                    if transparent:
                        view.Background = [0, 0, 0]
                    
                    # Set custom resolution if provided
                    if width and height:
                        view.ViewSize = [int(width), int(height)]
                    
                    # Render the view
                    simple.Render(view)
                    
                    # Generate filename if not provided
                    if not filename:
                        fd, filename = tempfile.mkstemp(suffix='.png')
                        os.close(fd)
                    
                    # Save screenshot
                    simple.SaveScreenshot(filename, view, 
                        ImageResolution=view.ViewSize,
                        TransparentBackground=transparent)
                    
                    # Read file and convert to base64
                    import base64
                    with open(filename, 'rb') as f:
                        image_data = base64.b64encode(f.read()).decode('utf-8')
                    
                    return {
                        'success': True,
                        'data': image_data,
                        'format': 'png',
                        'filename': filename
                    }
                    
                finally:
                    # Restore original settings
                    view.Background = original_bg
                    if width and height:
                        view.ViewSize = original_size
                    
            except Exception as e:
                print(f"Error capturing screenshot: {e}", file=sys.stderr)
                return {'success': False, 'error': str(e)}
        
        # UI setup
        with VAppLayout(server) as layout:
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True),
                app=True,
                width=300,
                clipped=True,
                color="#1e1e1e",
                dark=True
            ):
                with vuetify.VContainer(classes="pa-3"):
                    # Compact Header with Hide Button
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        html.Div(f"Tally {tally.id}: {tally.name}", 
                                classes="text-subtitle-1 font-weight-medium white--text")
                        with vuetify.VBtn(
                            click=toggle_controls,
                            small=True,
                            icon=True
                        ):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-2")
                    
                    # Score and Nuclide - styled as info chips
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        with vuetify.VCol(cols=6, classes="pa-0 pr-1"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Score", style="font-size: 10px; color: #888; text-transform: uppercase;")
                                html.Div("{{current_score}}", style="font-size: 13px; color: #fff; font-weight: 500;")
                        with vuetify.VCol(cols=6, classes="pa-0 pl-1"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Nuclide", style="font-size: 10px; color: #888; text-transform: uppercase;")
                                html.Div("{{current_nuclide}}", style="font-size: 13px; color: #fff; font-weight: 500;")
                    
                    # Compact Mesh Info Section
                    html.Div("Mesh Info", style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;")
                    
                    # Type and dimensions
                    with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                        with vuetify.VCol(cols=6, classes="pa-0 pr-1"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Type", style="font-size: 10px; color: #888;")
                                html.Div("{{mesh_type}}", style="font-size: 12px; color: #fff;")
                        with vuetify.VCol(cols=6, classes="pa-0 pl-1"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Dimensions", style="font-size: 10px; color: #888;")
                                html.Div("{{mesh_dimensions}}", style="font-size: 12px; color: #fff;")
                    # Bounds and cell size on separate lines
                    with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                        with vuetify.VCol(cols=12, classes="pa-0"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Bounds (cm)", style="font-size: 10px; color: #888;")
                                html.Div("{{mesh_bounds}}", style="font-size: 11px; color: #fff;")
                    with vuetify.VRow(dense=True, classes="ma-0 mb-3"):
                        with vuetify.VCol(cols=12, classes="pa-0"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Cell Size", style="font-size: 10px; color: #888;")
                                html.Div("{{mesh_width}}", style="font-size: 12px; color: #fff;")
                    
                    vuetify.VDivider(classes="mb-4")
                    
                    # Opacity Slider
                    vuetify.VSlider(
                        label="Opacity",
                        v_model=("opacity", 1.0),
                        min=0, max=1, step=0.05,
                        thumb_label=True,
                        dense=True,
                        classes="mb-4"
                    )
                    
                    # Representation Selector
                    vuetify.VSelect(
                        v_model=("representation", "Surface"),
                        items=(['Surface', 'Surface With Edges', 'Wireframe', 'Points'],),
                        label="Representation",
                        dense=True,
                        outlined=True,
                        classes="mb-4"
                    )
                    
                    # Color By Selector
                    vuetify.VSelect(
                        v_model=("color_by", "Cell: tally_mean"),
                        items=("available_arrays",),
                        label="Color By",
                        dense=True,
                        outlined=True,
                        classes="mb-4"
                    )
                    
                    # Color Map Selector - All ParaView presets
                    vuetify.VSelect(
                        v_model=("color_map", state.color_map),
                        items=(([
                            'Viridis', 'Plasma', 'Inferno', 'Magma', 'Cividis',
                            'Cool to Warm', 'Cool to Warm (Extended)', 'Warm to Cool',
                            'Black-Body Radiation', 'X Ray',
                            'Blue to Red Rainbow', 'Red to Blue Rainbow',
                            'Rainbow Desaturated', 'Rainbow Uniform',
                            'Jet', 'Hot', 'Cool',
                            'Spectral', 'RdYlBu', 'RdYlGn', 'PuOr', 'PRGn', 'BrBG',
                            'PiYG', 'RdBu', 'Seismic', 'Balance',
                            'Twilight', 'Haze', 'Earth', 'Ocean',
                        ]),),
                        label="Color Map",
                        dense=True,
                        outlined=True,
                        classes="mb-2"
                    )
                    
                    # Show Color Legend
                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", True),
                        label="Show Color Legend",
                        dense=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Camera Section
                    vuetify.VSubheader("Camera", classes="text-subtitle-1 mb-2")
                    
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=6):
                            vuetify.VBtn(
                                "Reset",
                                click=lambda: (simple.ResetCamera(view), update_view(True)),
                                block=True, small=True, outlined=True, classes="mb-2"
                            )
                        with vuetify.VCol(cols=6):
                            vuetify.VBtn(
                                "Isometric",
                                click=lambda: set_camera_view('isometric'),
                                block=True, small=True, outlined=True, classes="mb-2"
                            )
                    
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Front",
                                click=lambda: set_camera_view('front'),
                                block=True, small=True, text=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Side",
                                click=lambda: set_camera_view('right'),
                                block=True, small=True, text=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Top",
                                click=lambda: set_camera_view('top'),
                                block=True, small=True, text=True
                            )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Appearance Section
                    vuetify.VSubheader("Appearance", classes="text-subtitle-1 mb-2")
                    
                    # Background Color Picker
                    from trame.widgets import html
                    with vuetify.VRow(dense=True, align="center", classes="mb-2"):
                        with vuetify.VCol(cols=8):
                            vuetify.VSubheader("Background Color", classes="pa-0 text-body-2")
                        with vuetify.VCol(cols=4, classes="text-right"):
                            with html.Div(
                                style="display: inline-block; padding: 3px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 6px;"
                            ):
                                html.Input(
                                    type="color",
                                    value=("background_color_hex",),
                                    input="background_color_hex = $event.target.value;",
                                    style="width: 36px; height: 24px; border: 2px solid rgba(255,255,255,0.9); border-radius: 4px; cursor: pointer; padding: 0; display: block;",
                                )
                    
                    # Color presets
                    with vuetify.VRow(dense=True, classes="mb-2"):
                        colors = [
                            ("#000000", "black"),
                            ("#1a1a26", "dark blue"),
                            ("#2d3748", "navy"),
                            ("#4a5568", "slate"),
                            ("#1a202c", "dark"),
                            ("#ffffff", "white"),
                        ]
                        for hex_color, tooltip in colors:
                            with vuetify.VCol(cols=2):
                                vuetify.VBtn(
                                    "",
                                    click=lambda hex_c=hex_color: setattr(state, 'background_color_hex', hex_c),
                                    small=True, depressed=True,
                                    style=f"background-color: {hex_color}; min-width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3); box-shadow: none;",
                                    classes="mx-auto d-block"
                                )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Projection Mode
                    vuetify.VCheckbox(
                        v_model=("parallel_projection", False),
                        label="Parallel Projection (2D/Ortho)",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    # Detail sliders (Point Size, Line Width, Lighting)
                    with vuetify.VRow(dense=True, classes="mt-2"):
                        with vuetify.VCol(cols=12):
                            vuetify.VSlider(
                                v_model=("point_size", 2.0),
                                min=1, max=20, step=0.5,
                                label="Point Size",
                                dense=True, hide_details=True,
                                classes="mb-4"
                            )
                            vuetify.VSlider(
                                v_model=("line_width", 1.0),
                                min=0.5, max=10, step=0.5,
                                label="Line Width",
                                dense=True, hide_details=True,
                                classes="mb-4"
                            )
                            vuetify.VSlider(
                                v_model=("ambient_light", 0.2),
                                min=0, max=1, step=0.05,
                                label="Ambient",
                                dense=True, hide_details=True,
                                classes="mb-4"
                            )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Show 3D Axis Indicator
                    vuetify.VCheckbox(
                        v_model=("show_orientation_axes", True),
                        label="Show 3D Axis Indicator",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    # Show Data Bounds Outline
                    vuetify.VCheckbox(
                        v_model=("show_bounding_box", False),
                        label="Show Data Bounds Outline",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    # Show Coordinate Grid
                    vuetify.VCheckbox(
                        v_model=("show_cube_axes", False),
                        label="Show Coordinate Grid",
                        dense=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Screenshot Section
                    vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                    
                    def save_screenshot():
                        """Capture and save screenshot to file."""
                        from datetime import datetime
                        
                        # Generate filename with timestamp
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        filename = f"screenshot_{timestamp}.png"
                        filepath = os.path.join(os.getcwd(), filename)
                        
                        result = capture_screenshot(filename=filepath)
                        if result.get('success'):
                            print(f"Screenshot saved: {filepath}", file=sys.stderr)
                            state.screenshot_status = f"Saved: {filename}"
                        else:
                            print(f"Screenshot failed: {result.get('error')}", file=sys.stderr)
                            state.screenshot_status = f"Error: {result.get('error')}"
                    
                    vuetify.VBtn(
                        "Save Screenshot",
                        click=save_screenshot,
                        block=True,
                        small=True,
                        color="primary",
                        classes="mb-2"
                    )
                    
                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VSubheader(
                            ("screenshot_status",),
                            classes="text-caption justify-center"
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
                
                view_widget = pv_widgets.VtkRemoteView(
                    view,
                    interactive_ratio=1,
                    style="width: 100%; height: 100%;"
                )
                state.view_widget = view_widget
        
        # Add controllers after UI setup
        @server.controller.add("view_update")
        def ctrl_view_update():
            update_view()
        
        @server.controller.add("toggle_controls")
        def ctrl_toggle_controls():
            return toggle_controls()
        
        @server.controller.add("reset_camera")
        def ctrl_reset_camera():
            return reset_camera()
        
        @server.controller.add("set_camera_view")
        def ctrl_set_camera_view(view_type):
            return set_camera_view(view_type)
        
        @server.controller.add("toggle_controls")
        def ctrl_toggle_controls():
            return toggle_controls()
        
        # Watch for camera update counter changes to force view refresh
        @state.change("camera_update_counter")
        def on_camera_update(camera_update_counter, **kwargs):
            try:
                # Render the view to ensure camera changes are applied
                simple.Render(view)
                # Update the widget to refresh the view
                view_widget.update()
            except Exception as e:
                print(f"Warning: camera update failed: {e}", file=sys.stderr)
        
        print(f"Starting OpenMC mesh tally server on port {port}", file=sys.stderr)
        server.start(port=port, debug=False, open_browser=False)
        return 0
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


def cmd_visualize_source(args):
    """Visualize source distribution."""
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)
    
    reader = OpenMCReader()
    
    try:
        # Load source data
        source_poly = reader.load_source(args.source)
        
        # Write to temporary file
        import vtk
        from vtk.util import numpy_support
        
        with tempfile.NamedTemporaryFile(suffix='.vtp', delete=False) as tmp:
            tmp_path = tmp.name
        
        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetFileName(tmp_path)
        writer.SetInputData(source_poly)
        writer.Write()
        
        # Create trame application
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Initialize state variables
        state.point_size = 2.0
        state.color_map = 'Plasma'
        state.show_scalar_bar = True
        state.background_color_hex = '#1a1a26'
        state.show_orientation_axes = True
        state.camera_update_counter = 0  # Used to trigger camera updates
        
        # Appearance details
        state.ambient_light = 0.2
        state.parallel_projection = False
        
        # Load in ParaView
        source_reader = simple.XMLPolyDataReader(FileName=tmp_path)
        
        # Get available arrays
        available_arrays = ['Solid Color']
        point_data = source_reader.PointData
        for i in range(point_data.GetNumberOfArrays()):
            array = point_data.GetArray(i)
            if array:
                name = array.GetName()
                if name:
                    available_arrays.append(f"Point: {name}")
        
        state.available_arrays = available_arrays
        state.color_by = 'Point: energy' if 'Point: energy' in available_arrays else 'Solid Color'
        
        # Create visualization
        display = simple.Show(source_reader)
        view = simple.GetActiveViewOrCreate('RenderView')
        
        display.Representation = 'Points'
        display.PointSize = state.point_size
        
        if state.color_by != 'Solid Color':
            simple.ColorBy(display, ('POINTS', 'energy'))
            lut = simple.GetColorTransferFunction('energy')
            lut.ApplyPreset('Plasma', True)
        
        view.Background = [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        view.OrientationAxesVisibility = 1
        
        simple.Render(view)
        simple.ResetCamera()
        
        # Define update function
        def update_view(push_camera=False):
            try:
                simple.Render(view)
                vw = state.view_widget
                if vw:
                    if push_camera:
                        state.camera_update_counter = state.camera_update_counter + 1 if hasattr(state, 'camera_update_counter') else 1
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)
        
        def hex_to_rgb(hex_color):
            hex_color = hex_color.lstrip('#')
            return [
                int(hex_color[0:2], 16) / 255.0,
                int(hex_color[2:4], 16) / 255.0,
                int(hex_color[4:6], 16) / 255.0
            ]
        
        def get_data_bounds():
            try:
                return source_reader.GetDataInformation().GetBounds()
            except:
                return [-1, 1, -1, 1, -1, 1]
        
        def calculate_camera_position(view_type, bounds):
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
        
        # State change handlers
        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            try:
                if color_by == 'Solid Color':
                    simple.ColorBy(display, None)
                elif color_by.startswith('Point: '):
                    array_name = color_by[7:]
                    simple.ColorBy(display, ('POINTS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                update_view()
            except Exception as e:
                print(f"Error updating color: {e}", file=sys.stderr)
        
        @state.change("point_size")
        def on_point_size_change(point_size, **kwargs):
            try:
                display.PointSize = float(point_size)
                update_view()
            except Exception as e:
                print(f"Error updating point size: {e}", file=sys.stderr)
        
        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            try:
                rgb = hex_to_rgb(background_color_hex)
                view.UseColorPaletteForBackground = 0
                view.Background = rgb
                update_view()
            except Exception as e:
                print(f"Error updating background: {e}", file=sys.stderr)
        
        @state.change("show_orientation_axes")
        def on_orientation_axes_change(show_orientation_axes, **kwargs):
            try:
                view.OrientationAxesVisibility = 1 if show_orientation_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating orientation axes: {e}", file=sys.stderr)
        
        @state.change("show_cube_axes")
        def on_cube_axes_change(show_cube_axes, **kwargs):
            try:
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = 1 if show_cube_axes else 0
                else:
                    # Try on display
                    display.CubeAxesVisibility = 1 if show_cube_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating cube axes: {e}", file=sys.stderr)
                
        @state.change("point_size")
        def on_point_size_change(point_size, **kwargs):
            try:
                display.PointSize = float(point_size)
                update_view()
            except Exception as e:
                print(f"Error updating point size: {e}", file=sys.stderr)
                
        @state.change("line_width")
        def on_line_width_change(line_width, **kwargs):
            try:
                display.LineWidth = float(line_width)
                update_view()
            except Exception as e:
                print(f"Error updating line width: {e}", file=sys.stderr)
                
        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            try:
                display.Ambient = float(ambient_light)
                update_view()
            except Exception as e:
                print(f"Error updating ambient light: {e}", file=sys.stderr)
                
        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            try:
                view.CameraParallelProjection = 1 if parallel_projection else 0
                update_view(True)
            except Exception as e:
                print(f"Error updating projection mode: {e}", file=sys.stderr)
        
        # Define camera functions BEFORE UI setup so lambdas can capture them
        def reset_camera():
            try:
                simple.ResetCamera(view)
                update_view(True)
                return True
            except Exception as e:
                print(f"Error resetting camera: {e}", file=sys.stderr)
                return False
        
        def set_camera_view(view_type):
            try:
                bounds = get_data_bounds()
                position, focal_point, view_up = calculate_camera_position(view_type, bounds)
                view.CameraPosition = position
                view.CameraFocalPoint = focal_point
                view.CameraViewUp = view_up
                update_view(True)
                return True
            except Exception as e:
                print(f"Error setting camera view: {e}", file=sys.stderr)
                return False
        
        def capture_screenshot(filename=None, width=None, height=None, transparent=False):
            """Capture screenshot of current view."""
            try:
                if not view:
                    return {'success': False, 'error': 'No view available'}
                
                # Store original settings
                original_bg = view.Background[:]
                original_size = view.ViewSize[:]
                
                try:
                    # Set transparent background if requested
                    if transparent:
                        view.Background = [0, 0, 0]
                    
                    # Set custom resolution if provided
                    if width and height:
                        view.ViewSize = [int(width), int(height)]
                    
                    # Render the view
                    simple.Render(view)
                    
                    # Generate filename if not provided
                    if not filename:
                        fd, filename = tempfile.mkstemp(suffix='.png')
                        os.close(fd)
                    
                    # Save screenshot
                    simple.SaveScreenshot(filename, view, 
                        ImageResolution=view.ViewSize,
                        TransparentBackground=transparent)
                    
                    # Read file and convert to base64
                    import base64
                    with open(filename, 'rb') as f:
                        image_data = base64.b64encode(f.read()).decode('utf-8')
                    
                    return {
                        'success': True,
                        'data': image_data,
                        'format': 'png',
                        'filename': filename
                    }
                    
                finally:
                    # Restore original settings
                    view.Background = original_bg
                    if width and height:
                        view.ViewSize = original_size
                    
            except Exception as e:
                print(f"Error capturing screenshot: {e}", file=sys.stderr)
                return {'success': False, 'error': str(e)}
        
        def toggle_controls():
            """Toggle control panel visibility."""
            state.show_controls = not state.show_controls
            return state.show_controls
        
        # UI setup
        with VAppLayout(server) as layout:
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True),
                app=True,
                width=320,
                clipped=True,
                color="#1e1e1e",
                dark=True
            ):
                with vuetify.VContainer(classes="pa-4"):
                    # Header with Hide Button
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        vuetify.VSubheader("OpenMC Source", classes="text-h6 pa-0")
                        with vuetify.VBtn(
                            click=toggle_controls,
                            small=True,
                            icon=True
                        ):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-4")
                    
                    # Particles count as styled info card
                    with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"):
                        html.Div("Particles", style="font-size: 10px; color: #888; text-transform: uppercase;")
                        html.Div(str(source_poly.GetNumberOfPoints()), style="font-size: 14px; color: #fff; font-weight: 500;")
                    
                    vuetify.VDivider(classes="mb-4")
                    
                    # Projection Mode
                    vuetify.VCheckbox(
                        v_model=("parallel_projection", False),
                        label="Parallel Projection (2D/Ortho)",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    # Detail sliders (Point Size, Lighting)
                    with vuetify.VRow(dense=True, classes="mt-2"):
                        with vuetify.VCol(cols=12):
                            vuetify.VSlider(
                                label="Point Size",
                                v_model=("point_size", 2.0),
                                min=1, max=10, step=0.5,
                                thumb_label=True,
                                dense=True,
                                classes="mb-4"
                            )
                            vuetify.VSlider(
                                v_model=("ambient_light", 0.2),
                                min=0, max=1, step=0.05,
                                label="Ambient",
                                dense=True, hide_details=True,
                                classes="mb-4"
                            )
                    
                    vuetify.VSelect(
                        v_model=("color_by", state.color_by),
                        items=("available_arrays",),
                        label="Color By",
                        dense=True,
                        outlined=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VSelect(
                        v_model=("color_map", 'Plasma'),
                        items=(['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool'],),
                        label="Color Map",
                        dense=True,
                        outlined=True,
                        classes="mb-2"
                    )
                    
                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", True),
                        label="Show Color Legend",
                        dense=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Camera Section
                    vuetify.VSubheader("Camera", classes="text-subtitle-1 mb-2")
                    
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=6):
                            vuetify.VBtn(
                                "Reset",
                                click=lambda: (simple.ResetCamera(view), update_view(True)),
                                block=True, small=True, outlined=True, classes="mb-2"
                            )
                        with vuetify.VCol(cols=6):
                            vuetify.VBtn(
                                "Isometric",
                                click=lambda: set_camera_view('isometric'),
                                block=True, small=True, outlined=True, classes="mb-2"
                            )
                    
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Front",
                                click=lambda: set_camera_view('front'),
                                block=True, small=True, text=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Side",
                                click=lambda: set_camera_view('right'),
                                block=True, small=True, text=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VBtn(
                                "Top",
                                click=lambda: set_camera_view('top'),
                                block=True, small=True, text=True
                            )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Appearance Section
                    vuetify.VSubheader("Appearance", classes="text-subtitle-1 mb-2")
                    
                    # Background Color Picker
                    from trame.widgets import html
                    with vuetify.VRow(dense=True, align="center", classes="mb-2"):
                        with vuetify.VCol(cols=8):
                            vuetify.VSubheader("Background Color", classes="pa-0 text-body-2")
                        with vuetify.VCol(cols=4, classes="text-right"):
                            with html.Div(
                                style="display: inline-block; padding: 3px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 6px;"
                            ):
                                html.Input(
                                    type="color",
                                    value=("background_color_hex",),
                                    input="background_color_hex = $event.target.value;",
                                    style="width: 36px; height: 24px; border: 2px solid rgba(255,255,255,0.9); border-radius: 4px; cursor: pointer; padding: 0; display: block;",
                                )
                    
                    # Show 3D Axis Indicator
                    vuetify.VCheckbox(
                        v_model=("show_orientation_axes", True),
                        label="Show 3D Axis Indicator",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    # Show Coordinate Grid
                    vuetify.VCheckbox(
                        v_model=("show_cube_axes", False),
                        label="Show Coordinate Grid",
                        dense=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Screenshot Section
                    vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                    
                    def save_screenshot():
                        """Capture and save screenshot to file."""
                        from datetime import datetime
                        
                        # Generate filename with timestamp
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        filename = f"screenshot_{timestamp}.png"
                        filepath = os.path.join(os.getcwd(), filename)
                        
                        result = capture_screenshot(filename=filepath)
                        if result.get('success'):
                            print(f"Screenshot saved: {filepath}", file=sys.stderr)
                            state.screenshot_status = f"Saved: {filename}"
                        else:
                            print(f"Screenshot failed: {result.get('error')}", file=sys.stderr)
                            state.screenshot_status = f"Error: {result.get('error')}"
                    
                    vuetify.VBtn(
                        "Save Screenshot",
                        click=save_screenshot,
                        block=True,
                        small=True,
                        color="primary",
                        classes="mb-2"
                    )
                    
                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VSubheader(
                            ("screenshot_status",),
                            classes="text-caption justify-center"
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
                
                view_widget = pv_widgets.VtkRemoteView(
                    view,
                    interactive_ratio=1,
                    style="width: 100%; height: 100%;"
                )
                state.view_widget = view_widget
        
        # Add controllers after UI setup
        @server.controller.add("view_update")
        def ctrl_view_update():
            update_view()
        
        @server.controller.add("toggle_controls")
        def ctrl_toggle_controls():
            return toggle_controls()
        
        @server.controller.add("reset_camera")
        def ctrl_reset_camera():
            return reset_camera()
        
        @server.controller.add("set_camera_view")
        def ctrl_set_camera_view(view_type):
            return set_camera_view(view_type)
        
        # Watch for camera update counter changes to force view refresh
        @state.change("camera_update_counter")
        def on_camera_update(camera_update_counter, **kwargs):
            try:
                # Render the view to ensure camera changes are applied
                simple.Render(view)
                # Update the widget to refresh the view
                view_widget.update()
            except Exception as e:
                print(f"Warning: camera update failed: {e}", file=sys.stderr)
        
        print(f"Starting OpenMC source server on port {port}", file=sys.stderr)
        server.start(port=port, debug=False, open_browser=False)
        return 0
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


def cmd_visualize_overlay(args):
    """Overlay tally on geometry."""
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)
    
    reader = OpenMCReader()
    
    try:
        # Load tally and geometry
        viz_data = reader.visualize_tally_on_geometry(
            args.geometry, args.statepoint, args.tally_id, args.score
        )
        
        tally = viz_data['tally']
        
        # Create trame application
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Initialize state variables
        state.opacity = 0.6  # Default lower opacity for overlay
        state.representation = 'Surface'
        state.color_by = 'Cell: tally_mean' if tally.has_mesh else 'Solid Color'
        state.color_map = args.colormap or 'Cool to Warm'
        state.show_scalar_bar = True
        state.background_color_hex = '#1a1a26'
        state.show_orientation_axes = True
        state.show_bounding_box = False
        state.show_cube_axes = False
        state.camera_update_counter = 0
        
        # Appearance details
        state.ambient_light = 0.2
        state.parallel_projection = False
        
        # State change handlers
        def update_view(push_camera=False):
            try:
                view = simple.GetActiveViewOrCreate('RenderView')
                simple.Render(view)
                vw = state.view_widget
                if vw:
                    if push_camera:
                        state.camera_update_counter = state.camera_update_counter + 1
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)

        def hex_to_rgb(hex_color):
            hex_color = hex_color.lstrip('#')
            return [int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4)]

        @state.change("opacity")
        def on_opacity_change(opacity, **kwargs):
            if 'tally_display' in viz_data:
                viz_data['tally_display'].Opacity = float(opacity)
                update_view()

        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            view = simple.GetActiveViewOrCreate('RenderView')
            view.Background = hex_to_rgb(background_color_hex)
            update_view()

        @state.change("representation")
        def on_representation_change(representation, **kwargs):
            try:
                # Update all visible displays
                for key in ['tally_display', 'geom_display']:
                    if key in viz_data:
                        viz_data[key].Representation = representation
                update_view()
            except Exception as e:
                print(f"Error updating representation: {e}", file=sys.stderr)

        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            try:
                # Update all visible displays
                for key in ['tally_display', 'geom_display']:
                    if key in viz_data:
                        viz_data[key].Ambient = float(ambient_light)
                update_view()
            except Exception as e:
                print(f"Error updating ambient light: {e}", file=sys.stderr)

        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            try:
                view = simple.GetActiveViewOrCreate('RenderView')
                view.CameraParallelProjection = 1 if parallel_projection else 0
                update_view(True)
            except Exception as e:
                print(f"Error updating projection mode: {e}", file=sys.stderr)

        # UI setup (Simplified for overlay)
        with VAppLayout(server) as layout:
            with vuetify.VNavigationDrawer(v_model=("show_controls", True), app=True, width=300, dark=True):
                with vuetify.VContainer():
                    vuetify.VSubheader(f"Overlay: Tally {tally.id}")
                    vuetify.VDivider(classes="mb-4")
                    
                    vuetify.VSlider(label="Tally Opacity", v_model=("opacity", 0.6), min=0, max=1, step=0.05, dense=True)
                    
                    # Representation Selector
                    vuetify.VSelect(
                        v_model=("representation", "Surface"),
                        items=(['Surface', 'Surface With Edges', 'Wireframe', 'Points'],),
                        label="Representation",
                        dense=True,
                        outlined=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Projection Mode
                    vuetify.VCheckbox(
                        v_model=("parallel_projection", False),
                        label="Parallel Projection (2D/Ortho)",
                        dense=True,
                        classes="mb-2"
                    )
                    
                    vuetify.VSlider(
                        v_model=("ambient_light", 0.2),
                        min=0, max=1, step=0.05,
                        label="Ambient",
                        dense=True, hide_details=True,
                        classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    vuetify.VBtn("Reset Camera", click=lambda: (simple.ResetCamera(), update_view(True)), block=True, outlined=True)
            
            with vuetify.VMain():
                state.view_widget = pv_widgets.VtkRemoteView(simple.GetActiveViewOrCreate('RenderView'))

        print(f"Starting OpenMC overlay server on port {port}", file=sys.stderr)
        server.start(port=port, debug=False, open_browser=False)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

def cmd_spectrum(args):
    """Get energy spectrum data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_energy_spectrum(
            args.statepoint, 
            args.tally_id,
            int(args.score_index or 0),
            int(args.nuclide_index or 0)
        )
        
        # Convert numpy arrays to lists for JSON
        serializable_data = {k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()}
        print(json.dumps(serializable_data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1

def cmd_spatial(args):
    """Get spatial plot data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_spatial_plot(
            args.statepoint, 
            args.tally_id, 
            args.axis,
            int(args.score_index or 0),
            int(args.nuclide_index or 0)
        )
        
        # Convert numpy arrays to lists for JSON
        serializable_data = {k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()}
        print(json.dumps(serializable_data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1

def cmd_check(args):
    """Check if OpenMC integration is available."""
    available, message = check_openmc_available()
    print(json.dumps({"available": available, "message": message}))
    return 0 if available else 1


def check_openmc_available():
    """Check if OpenMC integration is available (h5py installed)."""
    try:
        import h5py
        return True, "OpenMC integration available"
    except ImportError:
        return False, "h5py not installed. Run: pip install h5py"


def main():
    parser = argparse.ArgumentParser(description='OpenMC server for NukeIDE')
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Info command
    info_parser = subparsers.add_parser('info', help='Get statepoint info')
    info_parser.add_argument('statepoint', help='Path to statepoint.h5')
    
    # List command
    list_parser = subparsers.add_parser('list', help='List tallies')
    list_parser.add_argument('statepoint', help='Path to statepoint.h5')
    
    # Visualize mesh command
    mesh_parser = subparsers.add_parser('visualize-mesh', help='Visualize mesh tally')
    mesh_parser.add_argument('statepoint', help='Path to statepoint.h5')
    mesh_parser.add_argument('tally_id', type=int, help='Tally ID')
    mesh_parser.add_argument('--port', type=int, help='Server port')
    mesh_parser.add_argument('--score-index', type=str, default='0', help='Score index or name')
    mesh_parser.add_argument('--nuclide-index', type=str, default='0', help='Nuclide index or name')
    mesh_parser.add_argument('--colormap', default='Cool to Warm', help='Color map')
    
    # Visualize source command
    source_parser = subparsers.add_parser('visualize-source', help='Visualize source')
    source_parser.add_argument('source', help='Path to source.h5')
    source_parser.add_argument('--port', type=int, help='Server port')

    # Visualize overlay command
    overlay_parser = subparsers.add_parser('visualize-overlay', help='Overlay tally on geometry')
    overlay_parser.add_argument('geometry', help='Path to geometry file')
    overlay_parser.add_argument('statepoint', help='Path to statepoint.h5')
    overlay_parser.add_argument('tally_id', type=int, help='Tally ID')
    overlay_parser.add_argument('--port', type=int, help='Server port')
    overlay_parser.add_argument('--score', help='Score name')
    overlay_parser.add_argument('--colormap', default='Cool to Warm', help='Color map')

    # Spectrum command
    spectrum_parser = subparsers.add_parser('spectrum', help='Get energy spectrum')
    spectrum_parser.add_argument('statepoint', help='Path to statepoint.h5')
    spectrum_parser.add_argument('tally_id', type=int, help='Tally ID')
    spectrum_parser.add_argument('--score-index', type=str, default='0', help='Score index or name')
    spectrum_parser.add_argument('--nuclide-index', type=str, default='0', help='Nuclide index or name')

    # Spatial plot command
    spatial_parser = subparsers.add_parser('spatial', help='Get spatial plot')
    spatial_parser.add_argument('statepoint', help='Path to statepoint.h5')
    spatial_parser.add_argument('tally_id', type=int, help='Tally ID')
    spatial_parser.add_argument('--axis', default='z', choices=['x', 'y', 'z'], help='Plot axis')
    spatial_parser.add_argument('--score-index', type=str, default='0', help='Score index or name')
    spatial_parser.add_argument('--nuclide-index', type=str, default='0', help='Nuclide index or name')
    
    # Check command
    check_parser = subparsers.add_parser('check', help='Check availability')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    commands = {
        'info': cmd_info,
        'list': cmd_list,
        'visualize-mesh': cmd_visualize_mesh,
        'visualize-source': cmd_visualize_source,
        'visualize-overlay': cmd_visualize_overlay,
        'spectrum': cmd_spectrum,
        'spatial': cmd_spatial,
        'check': cmd_check,
    }
    
    if args.command in commands:
        return commands[args.command](args)
    else:
        print(f"Unknown command: {args.command}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
