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


def cmd_xs_plot(args):
    """Generate cross-section plot data using openmc.data."""
    try:
        import openmc
        import openmc.data
    except ImportError as e:
        print(json.dumps({"error": f"OpenMC not installed: {e}"}))
        return 1

    try:
        nuclides = [n.strip() for n in args.nuclides.split(',')] if args.nuclides else []
        reactions = [r.strip() for r in args.reactions.split(',')]
        temperature = float(args.temperature) if args.temperature else 294.0
        energy_min = float(args.energy_min) if args.energy_min else 1e-5
        energy_max = float(args.energy_max) if args.energy_max else 2e7
        
        # Handle temperature comparison mode
        temp_comparison = None
        if args.temp_comparison:
            temps = [float(t.strip()) for t in args.temp_comparison.split(',')]
            temp_comparison = {
                'nuclide': nuclides[0] if nuclides else 'U235',
                'reaction': int(reactions[0]) if reactions else 18,
                'temperatures': temps
            }
        
        # Handle materials (JSON string)
        materials = None
        if args.materials:
            try:
                materials = json.loads(args.materials)
            except json.JSONDecodeError as e:
                print(f"Warning: Failed to parse materials: {e}", file=sys.stderr)
        
        # Handle flux spectrum (JSON string)
        flux_spectrum = None
        if args.flux_spectrum:
            try:
                flux_spectrum = json.loads(args.flux_spectrum)
            except json.JSONDecodeError as e:
                print(f"Warning: Failed to parse flux spectrum: {e}", file=sys.stderr)
        
        # Handle library comparison mode
        library_comparison = None
        if args.library_comparison:
            try:
                library_comparison = json.loads(args.library_comparison)
            except json.JSONDecodeError as e:
                print(f"Warning: Failed to parse library comparison: {e}", file=sys.stderr)
        
        # Handle uncertainty extraction flag
        include_uncertainty = getattr(args, 'include_uncertainty', False)
        
        # Handle integral quantities calculation flag
        include_integrals = getattr(args, 'include_integrals', False)
        
        # Handle derivative/slope calculation flag
        include_derivative = getattr(args, 'include_derivative', False)
        
        # Handle thermal scattering (S(alpha,beta)) mode
        thermal_scattering = None
        if args.thermal_scattering:
            try:
                thermal_scattering = json.loads(args.thermal_scattering)
            except json.JSONDecodeError as e:
                print(f"Warning: Failed to parse thermal scattering request: {e}", file=sys.stderr)
        
        # Handle energy region preset
        if args.energy_region:
            region_ranges = {
                'thermal': (1e-5, 1),
                'resonance': (1, 1e5),
                'epithermal': (1e-3, 1e5),
                'fast': (1e5, 2e7),
                'full': (1e-5, 2e7)
            }
            if args.energy_region in region_ranges:
                energy_min, energy_max = region_ranges[args.energy_region]
        
        # Convert reaction strings to integers if they're numeric
        parsed_reactions = []
        for r in reactions:
            try:
                parsed_reactions.append(int(r))
            except ValueError:
                parsed_reactions.append(r)
        
        # Reaction names mapping
        mt_names = {
            1: 'total',
            2: 'elastic',
            18: 'fission',
            102: 'capture',
            103: '(n,p)',
            104: '(n,d)',
            105: '(n,t)',
            106: '(n,He3)',
            107: '(n,alpha)',
            16: '(n,2n)',
            17: '(n,3n)',
            22: '(n,nalpha)',
            28: '(n,np)',
            41: '(n,2np)',
        }
        
        curves = []
        reaction_rates = []
        
        # Try to load cross_sections library
        library = None
        cross_sections_path = args.cross_sections if args.cross_sections else None
        
        try:
            if cross_sections_path:
                library = openmc.data.DataLibrary.from_xml(cross_sections_path)
                print(f"[XS Plot] Loaded cross_sections.xml from: {cross_sections_path}", file=sys.stderr)
            else:
                library = openmc.data.DataLibrary.from_xml()
                print(f"[XS Plot] Loaded default cross_sections.xml", file=sys.stderr)
        except Exception as e:
            print(f"Warning: Could not load cross_sections.xml: {e}", file=sys.stderr)
        
        # Get the directory from cross_sections path for fallback file search
        xs_dir = None
        if cross_sections_path:
            xs_dir = os.path.dirname(cross_sections_path)
        elif os.environ.get('OPENMC_CROSS_SECTIONS'):
            xs_dir = os.path.dirname(os.environ.get('OPENMC_CROSS_SECTIONS'))
        
        def load_nuclide_data(nuclide_name, library, xs_dir):
            """Helper function to load nuclide data from library or file."""
            xs_file = None
            
            print(f"[XS Plot] load_nuclide_data: Looking for {nuclide_name}, xs_dir={xs_dir}", file=sys.stderr)
            
            if library:
                libraries = library.libraries
                if isinstance(libraries, dict):
                    libraries = list(libraries.values())
                else:
                    libraries = list(libraries)
                
                print(f"[XS Plot] Library has {len(libraries)} sub-libraries", file=sys.stderr)
                
                for lib in libraries:
                    tables = getattr(lib, 'tables', [])
                    if isinstance(tables, dict):
                        tables = tables.values()
                    
                    for table in tables:
                        table_name = getattr(table, 'nuclide', getattr(table, 'name', None))
                        possible_names = [
                            nuclide_name,
                            nuclide_name.replace('-', ''),
                            nuclide_name.replace('-', '_'),
                        ]
                        if table_name in possible_names:
                            xs_file = table.filename
                            print(f"[XS Plot] Found nuclide {nuclide_name} in library table: {xs_file}", file=sys.stderr)
                            break
                    if xs_file:
                        break
            
            nuc_data = None
            if xs_file and os.path.exists(xs_file):
                print(f"[XS Plot] Loading nuclide data from: {xs_file}", file=sys.stderr)
                try:
                    nuc_data = openmc.data.IncidentNeutron.from_hdf5(xs_file)
                    print(f"[XS Plot] Successfully loaded nuclide data from: {xs_file}", file=sys.stderr)
                except Exception as e:
                    print(f"[XS Plot] ERROR: Failed to load {xs_file}: {e}", file=sys.stderr)
            else:
                print(f"[XS Plot] XS file not found or not specified: xs_file={xs_file}, exists={os.path.exists(xs_file) if xs_file else 'N/A'}", file=sys.stderr)
            
            if nuc_data is None and xs_dir:
                possible_files = [
                    os.path.join(xs_dir, f"{nuclide_name}.h5"),
                    os.path.join(xs_dir, f"{nuclide_name}.hdf5"),
                    os.path.join(xs_dir, f"n-{nuclide_name}.h5"),
                    os.path.join(xs_dir, f"n-{nuclide_name}.hdf5"),
                    os.path.join(xs_dir, f"{nuclide_name.replace('-', '_')}.h5"),
                    os.path.join(xs_dir, f"{nuclide_name.replace('-', '')}.h5"),
                ]
                for pf in possible_files:
                    if os.path.exists(pf):
                        try:
                            nuc_data = openmc.data.IncidentNeutron.from_hdf5(pf)
                            break
                        except Exception as e:
                            print(f"Warning: Failed to load {pf}: {e}", file=sys.stderr)
            
            return nuc_data
        
        def extract_uncertainty_data(nuc_data, reaction_mt, temperature, energy_grid):
            """Extract uncertainty/error data for a reaction if available."""
            uncertainty = None
            
            print(f"[XS Plot] extract_uncertainty_data: MT={reaction_mt}, temp={temperature}", file=sys.stderr)
            
            try:
                if reaction_mt not in nuc_data.reactions:
                    print(f"[XS Plot] Reaction MT={reaction_mt} not found in nuc_data", file=sys.stderr)
                    return None
                
                reaction = nuc_data.reactions[reaction_mt]
                print(f"[XS Plot] Found reaction MT={reaction_mt}, type={type(reaction)}", file=sys.stderr)
                
                # Check if the reaction has uncertainty/xs_yield data
                # OpenMC stores uncertainty information in various places depending on the version
                
                # Try to get the closest temperature
                print(f"[XS Plot] Checking reaction.xs attribute: {hasattr(reaction, 'xs')}", file=sys.stderr)
                if hasattr(reaction, 'xs') and reaction.xs:
                    print(f"[XS Plot] reaction.xs type: {type(reaction.xs)}, keys: {list(reaction.xs.keys()) if hasattr(reaction.xs, 'keys') else 'N/A'}", file=sys.stderr)
                    available_temps = list(reaction.xs.keys())
                    if not available_temps:
                        return None
                    
                    temps_numeric = []
                    for t in available_temps:
                        if isinstance(t, str):
                            try:
                                temps_numeric.append(float(t.rstrip('K').rstrip('k')))
                            except:
                                continue
                        else:
                            temps_numeric.append(float(t))
                    
                    if not temps_numeric:
                        closest_temp = available_temps[0]
                    else:
                        closest_temp_idx = np.argmin(np.abs(np.array(temps_numeric) - temperature))
                        closest_temp = available_temps[closest_temp_idx]
                    
                    xs_data = reaction.xs[closest_temp]
                    print(f"[XS Plot] Got xs_data for temp {closest_temp}, type: {type(xs_data)}", file=sys.stderr)
                    
                    # Check for uncertainty in the HDF5 structure
                    # OpenMC data files may contain '_uncertainty' datasets
                    has_unc_attr = hasattr(xs_data, '_uncertainty') and xs_data._uncertainty is not None
                    if has_unc_attr:
                        std_dev = xs_data._uncertainty
                        lower = np.maximum(xs_data.y - std_dev, 1e-10)
                        upper = xs_data.y + std_dev
                        
                        uncertainty = {
                            "stdDev": std_dev.tolist(),
                            "lower": lower.tolist(),
                            "upper": upper.tolist(),
                            "relative": (std_dev / np.maximum(xs_data.y, 1e-10)).tolist()
                        }
                    
                    # Check for yield/multiplicity uncertainty (common for fission)
                    elif hasattr(reaction, 'yield_'):
                        rxn_yield = getattr(reaction, 'yield_')
                        if rxn_yield is not None and hasattr(rxn_yield, 'std_dev') and rxn_yield.std_dev is not None:
                            y = getattr(rxn_yield, 'y', xs_data.y) if hasattr(rxn_yield, 'y') else xs_data.y
                            std_dev = rxn_yield.std_dev
                            
                            uncertainty = {
                                "stdDev": std_dev.tolist(),
                                "lower": np.maximum(y - std_dev, 1e-10).tolist(),
                                "upper": (y + std_dev).tolist(),
                                "relative": (std_dev / np.maximum(y, 1e-10)).tolist()
                            }
                    
                    # Check for covariance data (more complex uncertainty representation)
                    has_cov = hasattr(nuc_data, 'covariance') and nuc_data.covariance is not None
                    
                    # Note: Most standard NNDC/OpenMC HDF5 libraries don't include uncertainty data
                    # Uncertainty data is typically available in:
                    # - ENDF/B-VIII.0 with uncertainty covariance matrices (MF=30-35)
                    # - Special uncertainty-enabled cross-section libraries
                    # - Continuous energy data with _uncertainty attributes
                    
                    if has_cov:
                        # Covariance data exists but is complex to extract
                        # Mark that it's available
                        if uncertainty:
                            uncertainty["hasCovariance"] = True
                        else:
                            uncertainty = {"hasCovariance": True}
                    
                    if uncertainty is None:
                        print(f"[XS Plot] No uncertainty data available for MT={reaction_mt} in this library", file=sys.stderr)
                    
                    return uncertainty
                
            except Exception as e:
                print(f"[XS Plot] Error extracting uncertainty: {e}", file=sys.stderr)
                return None
        
        def calculate_integral_quantities(curve):
            """Calculate integral quantities for a cross-section curve."""
            integrals = {}
            
            try:
                energy = np.array(curve["energy"])
                xs = np.array(curve["xs"])
                
                if len(energy) == 0 or len(xs) == 0:
                    return integrals
                
                # Ensure energy is sorted
                sort_idx = np.argsort(energy)
                energy = energy[sort_idx]
                xs = xs[sort_idx]
                
                # Helper function for trapezoidal integration (compatible with all NumPy versions)
                def trapz_integrate(y, x):
                    """Manual trapezoidal integration."""
                    if len(y) != len(x) or len(y) < 2:
                        return 0.0
                    dx = np.diff(x)
                    y_avg = (y[:-1] + y[1:]) / 2.0
                    return float(np.sum(y_avg * dx))
                
                # 1. Resonance Integral (0.5 eV to 1e5 eV, divided by ln(E2/E1))
                # Standard resonance integral definition
                ri_mask = (energy >= 0.5) & (energy <= 1e5)
                if np.any(ri_mask):
                    ri_energy = energy[ri_mask]
                    ri_xs = xs[ri_mask]
                    # Resonance integral = ∫ σ(E) dE/E from E1 to E2
                    # For log-energy grid: ∫ σ(E) d(ln E) = ∫ σ(E)/E dE
                    if len(ri_energy) > 1:
                        # Convert to log-energy space
                        log_e = np.log(ri_energy)
                        # Trapezoidal integration in log space
                        ri = trapz_integrate(ri_xs, log_e)
                        integrals["resonanceIntegral"] = float(ri)
                
                # 2. Thermal cross-section at 2200 m/s (0.0253 eV)
                thermal_e = 0.0253
                if np.any(energy <= thermal_e * 10):  # Check if we have thermal data
                    # Interpolate to thermal energy
                    thermal_xs = np.interp(thermal_e, energy, xs, left=xs[0], right=xs[-1])
                    integrals["thermalXS"] = float(thermal_xs)
                    
                    # 3. Maxwellian average at thermal temperature (293.6K)
                    # ⟨σ⟩ = ∫ σ(E) φ(E) dE / ∫ φ(E) dE where φ(E) = E exp(-E/kT)
                    kT = 0.0253  # eV at room temperature
                    # Only use thermal region
                    maxwell_mask = energy <= 1.0  # Up to 1 eV
                    if np.any(maxwell_mask):
                        me_energy = energy[maxwell_mask]
                        me_xs = xs[maxwell_mask]
                        # Maxwellian flux spectrum: φ(E) ∝ E exp(-E/kT)
                        flux = me_energy * np.exp(-me_energy / kT)
                        # Weighted average
                        numerator = trapz_integrate(me_xs * flux, me_energy)
                        denominator = trapz_integrate(flux, me_energy)
                        if denominator > 0:
                            integrals["maxwellianAverage"] = float(numerator / denominator)
                
                # 4. Average XS over full energy range
                if len(energy) > 1:
                    # Energy-weighted average
                    log_energy = np.log(energy)
                    avg_xs = trapz_integrate(xs, log_energy) / (log_energy[-1] - log_energy[0])
                    integrals["averageXS"] = float(avg_xs)
                    
                    # 5. Integrated XS (barns·eV)
                    integrated = trapz_integrate(xs, energy)
                    integrals["integratedXS"] = float(integrated)
                
            except Exception as e:
                print(f"[XS Plot] Error calculating integrals: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            
            return integrals
        
        def calculate_derivative(curve):
            """Calculate derivative/slope data for a cross-section curve."""
            derivative_data = {
                "dXdE": [],
                "logLogDerivative": [],
                "energy": [],
                "method": "central",
                "maxSlope": 0.0,
                "maxSlopeEnergy": 0.0
            }
            
            try:
                energy = np.array(curve["energy"])
                xs = np.array(curve["xs"])
                
                if len(energy) < 3 or len(xs) == 0:
                    return derivative_data
                
                # Ensure energy is sorted
                sort_idx = np.argsort(energy)
                energy = energy[sort_idx]
                xs = xs[sort_idx]
                
                # Calculate central differences for dXS/dE
                # Use log-space for better accuracy with wide energy ranges
                dXdE = np.zeros(len(energy))
                
                # Forward difference for first point
                dXdE[0] = (xs[1] - xs[0]) / (energy[1] - energy[0])
                
                # Central differences for interior points
                for i in range(1, len(energy) - 1):
                    # Central difference: (f(x+h) - f(x-h)) / (2h)
                    dXdE[i] = (xs[i+1] - xs[i-1]) / (energy[i+1] - energy[i-1])
                
                # Backward difference for last point
                dXdE[-1] = (xs[-1] - xs[-2]) / (energy[-1] - energy[-2])
                
                # Calculate log-log derivative: d(log XS)/d(log E) = (E/XS) * (dXS/dE)
                log_log_deriv = np.zeros(len(energy))
                with np.errstate(divide='ignore', invalid='ignore'):
                    # Avoid division by zero
                    valid_mask = (xs > 1e-30) & (energy > 0)
                    log_log_deriv[valid_mask] = (energy[valid_mask] / xs[valid_mask]) * dXdE[valid_mask]
                
                # Find maximum slope
                abs_dXdE = np.abs(dXdE)
                max_idx = np.argmax(abs_dXdE)
                max_slope = float(abs_dXdE[max_idx])
                max_slope_energy = float(energy[max_idx])
                
                derivative_data = {
                    "dXdE": dXdE.tolist(),
                    "logLogDerivative": log_log_deriv.tolist(),
                    "energy": energy.tolist(),
                    "method": "central",
                    "maxSlope": max_slope,
                    "maxSlopeEnergy": max_slope_energy
                }
                
                print(f"[XS Plot] Derivative calculated: max slope = {max_slope:.4e} at {max_slope_energy:.4e} eV", file=sys.stderr)
                
            except Exception as e:
                print(f"[XS Plot] Error calculating derivative: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            
            return derivative_data
        
        def get_xs_data_for_temp(nuc_data, reaction_mt, temperature):
            """Get XS data for a specific temperature."""
            if reaction_mt not in nuc_data.reactions:
                return None, None
            
            reaction = nuc_data.reactions[reaction_mt]
            
            if hasattr(reaction, 'xs') and reaction.xs:
                available_temps = list(reaction.xs.keys())
                if not available_temps:
                    return None, None
                
                temps_numeric = []
                for t in available_temps:
                    if isinstance(t, str):
                        try:
                            temps_numeric.append(float(t.rstrip('K').rstrip('k')))
                        except:
                            continue
                    else:
                        temps_numeric.append(float(t))
                
                if not temps_numeric:
                    closest_temp = available_temps[0]
                else:
                    closest_temp_idx = np.argmin(np.abs(np.array(temps_numeric) - temperature))
                    closest_temp = available_temps[closest_temp_idx]
                
                xs_data = reaction.xs[closest_temp]
                return xs_data.x, xs_data.y
            
            return None, None
        
        def get_available_thermal_materials(xs_dir):
            """Get list of available thermal scattering materials from cross_sections.xml."""
            import xml.etree.ElementTree as ET
            
            materials = []
            cross_sections_xml = None
            
            # Find cross_sections.xml
            if xs_dir:
                possible_paths = [
                    os.path.join(xs_dir, 'cross_sections.xml'),
                    os.path.join(xs_dir, 'cross_sections.xml'),
                ]
                for path in possible_paths:
                    if os.path.exists(path):
                        cross_sections_xml = path
                        break
            
            # Also check environment variable
            if cross_sections_xml is None and 'OPENMC_CROSS_SECTIONS' in os.environ:
                cross_sections_xml = os.environ['OPENMC_CROSS_SECTIONS']
            
            if cross_sections_xml and os.path.exists(cross_sections_xml):
                try:
                    tree = ET.parse(cross_sections_xml)
                    root = tree.getroot()
                    for lib in root.findall('library'):
                        if lib.get('type') == 'thermal':
                            mat = lib.get('materials')
                            if mat:
                                materials.append(mat)
                except Exception as e:
                    print(f"[XS Plot] Error parsing cross_sections.xml: {e}", file=sys.stderr)
            
            return materials
        
        def load_thermal_scattering_data(material_name, xs_dir):
            """Load thermal scattering (S(alpha,beta)) data for a material."""
            ts_file = None
            
            # First check if material is available in cross_sections.xml
            available_materials = get_available_thermal_materials(xs_dir)
            if available_materials and material_name not in available_materials:
                print(f"[XS Plot] Material '{material_name}' not found in cross_sections.xml", file=sys.stderr)
                print(f"[XS Plot] Available thermal materials: {', '.join(available_materials)}", file=sys.stderr)
                return None
            
            # Common thermal scattering material naming patterns
            possible_names = [
                material_name,
                material_name.replace('_', '-'),
                material_name.lower(),
                material_name.upper(),
            ]
            
            # Try to find the thermal scattering file
            if xs_dir:
                for name in possible_names:
                    for ext in ['.h5', '.hdf5']:
                        possible_file = os.path.join(xs_dir, f"{name}{ext}")
                        if os.path.exists(possible_file):
                            ts_file = possible_file
                            break
                    if ts_file:
                        break
                    
                    # Also try with thermal_ prefix
                    possible_file = os.path.join(xs_dir, f"thermal_{name}.h5")
                    if os.path.exists(possible_file):
                        ts_file = possible_file
                        break
            
            if ts_file is None:
                print(f"[XS Plot] Could not find thermal scattering file for {material_name}", file=sys.stderr)
                if available_materials:
                    print(f"[XS Plot] Available materials: {', '.join(available_materials)}", file=sys.stderr)
                return None
            
            try:
                # Load the thermal scattering data using openmc.data.ThermalScattering
                ts_data = openmc.data.ThermalScattering.from_hdf5(ts_file)
                print(f"[XS Plot] Loaded thermal scattering data from: {ts_file}", file=sys.stderr)
                return ts_data
            except Exception as e:
                print(f"[XS Plot] Error loading thermal scattering data: {e}", file=sys.stderr)
                return None
        
        def get_thermal_scattering_xs(ts_data, temperature, energy_min, energy_max):
            """Get thermal scattering cross-sections for a temperature."""
            if not hasattr(ts_data, 'kTs'):
                return None, None, None
            
            # Handle different kTs formats (dict or list)
            kTs = ts_data.kTs
            if isinstance(kTs, dict):
                available_temps = list(kTs.keys())
            elif isinstance(kTs, list):
                available_temps = kTs
            else:
                print(f"[XS Plot] Unexpected kTs type: {type(kTs)}", file=sys.stderr)
                return None, None, None
            
            if not available_temps:
                return None, None, None
            
            # Convert available temps to Kelvin for comparison
            # kTs can be in eV (divide by 8.617333e-5 to get K) or strings like "296K"
            temps_in_k = []
            for t in available_temps:
                if isinstance(t, str):
                    temps_in_k.append(float(t.rstrip('K').rstrip('k')))
                else:
                    # Assume it's in eV, convert to K
                    temps_in_k.append(float(t) / 8.617333e-5)
            
            closest_temp_idx = np.argmin(np.abs(np.array(temps_in_k) - temperature))
            closest_temp = available_temps[closest_temp_idx]
            closest_temp_k = temps_in_k[closest_temp_idx]
            
            print(f"[XS Plot] Using thermal scattering data at {closest_temp_k:.1f}K (requested {temperature}K)", file=sys.stderr)
            
            # Generate energy grid for thermal region
            # Log-uniform grid from energy_min to energy_max
            n_points = 500
            energy = np.logspace(np.log10(energy_min), np.log10(energy_max), n_points)
            
            # Get cross-sections
            inelastic_xs = np.zeros(n_points)
            elastic_xs = np.zeros(n_points)
            
            try:
                # Get temperature key for XS dictionaries (e.g., "296K")
                # Round to nearest integer and ensure we match the key format
                temp_key = f"{int(round(closest_temp_k))}K"
                
                # Try to get inelastic cross-section
                # ts_data.inelastic.xs is a dict like {'296K': Tabulated1D object}
                if hasattr(ts_data, 'inelastic') and hasattr(ts_data.inelastic, 'xs'):
                    inelastic_dict = ts_data.inelastic.xs
                    if temp_key in inelastic_dict:
                        xs_data = inelastic_dict[temp_key]
                        if hasattr(xs_data, 'x') and hasattr(xs_data, 'y'):
                            inelastic_xs = np.interp(energy, xs_data.x, xs_data.y, left=0, right=0)
                            print(f"[XS Plot] Loaded inelastic XS for {temp_key}", file=sys.stderr)
                    else:
                        # Try to find any available temperature
                        if inelastic_dict:
                            first_key = list(inelastic_dict.keys())[0]
                            xs_data = inelastic_dict[first_key]
                            if hasattr(xs_data, 'x') and hasattr(xs_data, 'y'):
                                inelastic_xs = np.interp(energy, xs_data.x, xs_data.y, left=0, right=0)
                                print(f"[XS Plot] Loaded inelastic XS using {first_key} (requested {temp_key} not found)", file=sys.stderr)
                
                # Try to get elastic cross-section
                # ts_data.elastic.xs is a dict like {'296K': CoherentElastic object}
                if hasattr(ts_data, 'elastic') and hasattr(ts_data.elastic, 'xs'):
                    elastic_dict = ts_data.elastic.xs
                    if temp_key in elastic_dict:
                        xs_data = elastic_dict[temp_key]
                        # CoherentElastic has bragg_edges and factors
                        if hasattr(xs_data, 'bragg_edges') and hasattr(xs_data, 'factors'):
                            elastic_xs = np.interp(energy, xs_data.bragg_edges, xs_data.factors, left=0, right=0)
                            print(f"[XS Plot] Loaded elastic XS for {temp_key}", file=sys.stderr)
                    else:
                        # Try to find any available temperature
                        if elastic_dict:
                            first_key = list(elastic_dict.keys())[0]
                            xs_data = elastic_dict[first_key]
                            if hasattr(xs_data, 'bragg_edges') and hasattr(xs_data, 'factors'):
                                elastic_xs = np.interp(energy, xs_data.bragg_edges, xs_data.factors, left=0, right=0)
                                print(f"[XS Plot] Loaded elastic XS using {first_key} (requested {temp_key} not found)", file=sys.stderr)
                            
            except Exception as e:
                print(f"[XS Plot] Error extracting cross-sections: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            
            return energy, inelastic_xs, elastic_xs
        
        def calculate_macroscopic_xs(nuc_data, reaction_mt, temperature, density, fraction=1.0):
            """Calculate macroscopic XS from microscopic XS."""
            energy, xs_micro = get_xs_data_for_temp(nuc_data, reaction_mt, temperature)
            if energy is None:
                return None, None
            
            # Convert barns (1e-24 cm²) to cm², then multiply by atomic density
            # atomic density = density * avogadro / atomic_weight
            atomic_weight = nuc_data.atomic_weight if hasattr(nuc_data, 'atomic_weight') else 1.0
            avogadro = 6.02214076e23
            atomic_density = density * avogadro / atomic_weight  # atoms/cm³
            
            # Macroscopic XS = N * σ (in 1/cm)
            xs_macro = xs_micro * 1e-24 * atomic_density * fraction
            
            return energy, xs_macro
        
        def calculate_reaction_rate(energy, xs, flux_energy, flux_values):
            """Calculate reaction rate by integrating XS * flux."""
            # Interpolate XS to flux energy grid
            xs_interp = np.interp(flux_energy, energy, xs, left=0, right=0)
            
            # Calculate group-wise reaction rate
            group_rates = xs_interp * flux_values
            
            # Integrate (simple trapezoidal)
            if len(flux_energy) > 1:
                # Use log-log interpolation for energy groups
                total_rate = trapz_integrate(group_rates, flux_energy)
                total_flux = trapz_integrate(flux_values, flux_energy)
                avg_xs = total_rate / total_flux if total_flux > 0 else 0
            else:
                total_rate = np.sum(group_rates)
                total_flux = np.sum(flux_values)
                avg_xs = total_rate / total_flux if total_flux > 0 else 0
            
            return total_rate, total_flux, avg_xs
        
        # Handle thermal scattering (S(alpha,beta)) mode
        if thermal_scattering:
            ts_material = thermal_scattering.get('material', 'c_Graphite')
            ts_temperature = thermal_scattering.get('temperature', 294)
            ts_temperatures = thermal_scattering.get('temperatures', [ts_temperature])
            ts_energy_range = thermal_scattering.get('energyRange', [1e-5, 10.0])
            ts_energy_min, ts_energy_max = ts_energy_range
            
            print(f"[XS Plot] Thermal scattering mode: material={ts_material}, temps={ts_temperatures}", file=sys.stderr)
            
            try:
                # Load thermal scattering data
                ts_data = load_thermal_scattering_data(ts_material, xs_dir)
                
                if ts_data is None:
                    print(json.dumps({"error": f"Could not load thermal scattering data for {ts_material}"}))
                    return 1
                
                for temp in ts_temperatures:
                    try:
                        # Get thermal scattering cross-sections
                        energy, inelastic_xs, elastic_xs = get_thermal_scattering_xs(ts_data, temp, ts_energy_min, ts_energy_max)
                        
                        if energy is None:
                            print(f"[XS Plot] No thermal scattering data at {temp}K", file=sys.stderr)
                            continue
                        
                        # Calculate total XS
                        total_xs = inelastic_xs + elastic_xs
                        
                        curve = {
                            "energy": energy.tolist(),
                            "xs": total_xs.tolist(),
                            "nuclide": ts_material,
                            "reaction": "thermal",
                            "label": f"{ts_material} Thermal Scattering @ {temp}K",
                            "temperature": temp,
                            "thermalScattering": {
                                "material": ts_material,
                                "temperature": temp,
                                "energy": energy.tolist(),
                                "inelasticXS": inelastic_xs.tolist(),
                                "elasticXS": elastic_xs.tolist(),
                                "totalXS": total_xs.tolist()
                            }
                        }
                        curves.append(curve)
                        
                        # Also add separate curves for inelastic and elastic
                        curves.append({
                            "energy": energy.tolist(),
                            "xs": inelastic_xs.tolist(),
                            "nuclide": ts_material,
                            "reaction": "thermal_inelastic",
                            "label": f"{ts_material} Inelastic @ {temp}K",
                            "temperature": temp
                        })
                        
                        curves.append({
                            "energy": energy.tolist(),
                            "xs": elastic_xs.tolist(),
                            "nuclide": ts_material,
                            "reaction": "thermal_elastic",
                            "label": f"{ts_material} Elastic @ {temp}K",
                            "temperature": temp
                        })
                        
                    except Exception as e:
                        print(f"[XS Plot] Error processing thermal scattering at {temp}K: {e}", file=sys.stderr)
                        continue
                        
            except Exception as e:
                print(f"[XS Plot] Error loading thermal scattering data: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
        
        # Handle library comparison mode
        elif library_comparison:
            libraries = library_comparison.get('libraries', [])
            lib_nuclide = library_comparison.get('nuclide', 'U235')
            lib_reaction = library_comparison.get('reaction', 18)
            lib_temperature = library_comparison.get('temperature', 294)
            
            reaction_name = mt_names.get(lib_reaction, f"MT={lib_reaction}")
            
            print(f"[XS Plot] Library comparison mode: {len(libraries)} libraries, nuclide={lib_nuclide}, reaction={lib_reaction}", file=sys.stderr)
            
            for lib in libraries:
                lib_name = lib.get('name', 'Unknown')
                lib_path = lib.get('path', '')
                
                print(f"[XS Plot] Processing library '{lib_name}' from: {lib_path}", file=sys.stderr)
                
                try:
                    # Load library-specific cross-sections
                    lib_data_library = None
                    lib_xs_dir = None
                    if lib_path:
                        try:
                            lib_data_library = openmc.data.DataLibrary.from_xml(lib_path)
                            lib_xs_dir = os.path.dirname(lib_path)
                            print(f"[XS Plot] Successfully loaded library '{lib_name}' from: {lib_path}", file=sys.stderr)
                        except Exception as e:
                            print(f"[XS Plot] ERROR: Could not load library '{lib_name}' from {lib_path}: {e}", file=sys.stderr)
                            import traceback
                            traceback.print_exc(file=sys.stderr)
                            continue
                    else:
                        # Use default library
                        lib_data_library = library
                        lib_xs_dir = xs_dir
                        print(f"[XS Plot] Using default library for '{lib_name}'", file=sys.stderr)
                    
                    # Load nuclide data from this library
                    print(f"[XS Plot] Looking for nuclide {lib_nuclide} in library '{lib_name}'...", file=sys.stderr)
                    nuc_data = load_nuclide_data(lib_nuclide, lib_data_library, lib_xs_dir)
                    if nuc_data is None:
                        print(f"[XS Plot] ERROR: Could not load nuclide {lib_nuclide} from library '{lib_name}'", file=sys.stderr)
                        continue
                    print(f"[XS Plot] Found nuclide {lib_nuclide} in library '{lib_name}'", file=sys.stderr)
                    
                    # Get XS data
                    energy, xs_values = get_xs_data_for_temp(nuc_data, lib_reaction, lib_temperature)
                    if energy is None:
                        print(f"Warning: Reaction MT={lib_reaction} not available for {lib_nuclide} in '{lib_name}'", file=sys.stderr)
                        continue
                    
                    # Filter by energy range
                    mask = (energy >= energy_min) & (energy <= energy_max)
                    energy_filtered = energy[mask]
                    xs_filtered = xs_values[mask]
                    xs_filtered = np.maximum(xs_filtered, 1e-10)
                    
                    # Extract resonance info
                    resonance_regions = []
                    if hasattr(nuc_data, 'resonances') and nuc_data.resonances:
                        res = nuc_data.resonances
                        if hasattr(res, 'resolved') and res.resolved:
                            resolved_list = res.resolved if isinstance(res.resolved, list) else [res.resolved]
                            for r in resolved_list:
                                resonance_regions.append({
                                    "type": "resolved",
                                    "energyMin": float(r.energy_min),
                                    "energyMax": float(r.energy_max)
                                })
                        if hasattr(res, 'unresolved') and res.unresolved:
                            unresolved_list = res.unresolved if isinstance(res.unresolved, list) else [res.unresolved]
                            for ur in unresolved_list:
                                resonance_regions.append({
                                    "type": "unresolved",
                                    "energyMin": float(ur.energy_min),
                                    "energyMax": float(ur.energy_max)
                                })
                    
                    curve = {
                        "energy": energy_filtered.tolist(),
                        "xs": xs_filtered.tolist(),
                        "nuclide": lib_nuclide,
                        "reaction": lib_reaction,
                        "label": f"{lib_nuclide} {reaction_name} ({lib_name})",
                        "temperature": lib_temperature,
                        "library": lib_name
                    }
                    
                    if resonance_regions:
                        curve["resonanceRegions"] = resonance_regions
                    
                    curves.append(curve)
                    print(f"[XS Plot] Added curve for '{lib_name}': {len(energy_filtered)} points", file=sys.stderr)
                    
                except Exception as e:
                    print(f"Warning: Failed to get data from library '{lib_name}': {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
        
        # Handle temperature comparison mode
        elif temp_comparison:
            nuc_data = load_nuclide_data(temp_comparison['nuclide'], library, xs_dir)
            if nuc_data is None:
                print(json.dumps({"error": f"Could not load data for {temp_comparison['nuclide']}"}))
                return 1
            
            reaction_mt = temp_comparison['reaction']
            reaction_name = mt_names.get(reaction_mt, f"MT={reaction_mt}")
            
            for temp in temp_comparison['temperatures']:
                try:
                    energy, xs_values = get_xs_data_for_temp(nuc_data, reaction_mt, temp)
                    if energy is None:
                        continue
                    
                    mask = (energy >= energy_min) & (energy <= energy_max)
                    energy_filtered = energy[mask]
                    xs_filtered = xs_values[mask]
                    xs_filtered = np.maximum(xs_filtered, 1e-10)
                    
                    curves.append({
                        "energy": energy_filtered.tolist(),
                        "xs": xs_filtered.tolist(),
                        "nuclide": temp_comparison['nuclide'],
                        "reaction": reaction_mt,
                        "label": f"{temp_comparison['nuclide']} {reaction_name} @ {temp:.0f}K",
                        "temperature": temp
                    })
                except Exception as e:
                    print(f"Warning: Failed to get data at {temp}K: {e}", file=sys.stderr)
        
        # Handle materials (mixed nuclides)
        elif materials:
            for material in materials:
                mat_name = material.get('name', 'Material')
                mat_density = material.get('density', 1.0)
                components = material.get('components', [])
                
                # Collect XS data from all components
                component_data = []
                total_fraction = 0.0
                
                for comp in components:
                    nuc_name = comp.get('nuclide')
                    fraction = comp.get('fraction', 1.0)
                    total_fraction += fraction
                    
                    nuc_data = load_nuclide_data(nuc_name, library, xs_dir)
                    if nuc_data is None:
                        print(f"Warning: Could not load {nuc_name}", file=sys.stderr)
                        continue
                    
                    component_data.append({
                        'nuclide': nuc_name,
                        'fraction': fraction,
                        'data': nuc_data
                    })
                
                # Normalize fractions
                if total_fraction > 0:
                    for comp in component_data:
                        comp['fraction'] /= total_fraction
                
                # Calculate macroscopic XS for each reaction
                for reaction_mt in parsed_reactions:
                    reaction_name = mt_names.get(reaction_mt, f"MT={reaction_mt}")
                    
                    # Find common energy grid from first component
                    if not component_data:
                        continue
                    
                    first_energy, _ = get_xs_data_for_temp(component_data[0]['data'], reaction_mt, temperature)
                    if first_energy is None:
                        continue
                    
                    # Filter by energy range first
                    mask = (first_energy >= energy_min) & (first_energy <= energy_max)
                    energy_grid = first_energy[mask]
                    
                    if len(energy_grid) == 0:
                        continue
                    
                    # Sum macroscopic XS from all components
                    macro_xs = np.zeros_like(energy_grid)
                    
                    for comp in component_data:
                        nuc_data = comp['data']
                        fraction = comp['fraction']
                        
                        energy, xs_micro = get_xs_data_for_temp(nuc_data, reaction_mt, temperature)
                        if energy is None:
                            continue
                        
                        # Interpolate to common grid
                        xs_interp = np.interp(energy_grid, energy, xs_micro, left=0, right=0)
                        
                        # Convert to macroscopic
                        atomic_weight = nuc_data.atomic_weight if hasattr(nuc_data, 'atomic_weight') else 1.0
                        avogadro = 6.02214076e23
                        atomic_density = mat_density * avogadro / atomic_weight
                        
                        macro_xs += xs_interp * 1e-24 * atomic_density * fraction
                    
                    macro_xs = np.maximum(macro_xs, 1e-15)  # Ensure positive
                    
                    curves.append({
                        "energy": energy_grid.tolist(),
                        "xs": macro_xs.tolist(),
                        "nuclide": mat_name,
                        "reaction": reaction_mt,
                        "label": f"{mat_name} Σ{reaction_name} (macroscopic)",
                        "isMacroscopic": True
                    })
                    
                    # Calculate reaction rate if flux spectrum provided
                    if flux_spectrum:
                        flux_energy = np.array(flux_spectrum.get('energy', []))
                        flux_values = np.array(flux_spectrum.get('values', []))
                        
                        if len(flux_energy) > 0 and len(flux_values) > 0:
                            rate, int_flux, avg_xs = calculate_reaction_rate(
                                energy_grid, macro_xs, flux_energy, flux_values
                            )
                            
                            reaction_rates.append({
                                "nuclide": mat_name,
                                "reaction": reaction_mt,
                                "rate": float(rate),
                                "integratedFlux": float(int_flux),
                                "avgXS": float(avg_xs)
                            })
        
        # Standard mode: individual nuclides
        else:
            for nuclide_name in nuclides:
                try:
                    print(f"[XS Plot] Looking for nuclide: {nuclide_name}", file=sys.stderr)
                    
                    nuc_data = load_nuclide_data(nuclide_name, library, xs_dir)
                    
                    if nuc_data is None:
                        print(f"[XS Plot] ERROR: Could not find cross-section data for {nuclide_name}", file=sys.stderr)
                        print(f"[XS Plot] Searched in: {xs_dir if xs_dir else 'cross_sections.xml library'}", file=sys.stderr)
                        continue
                    
                    # Extract resonance info
                    resonance_regions = []
                    resonance_params = []
                    print(f"[XS Plot] Checking resonances for {nuclide_name}...", file=sys.stderr)
                    if hasattr(nuc_data, 'resonances') and nuc_data.resonances:
                        res = nuc_data.resonances
                        print(f"[XS Plot] Found resonance object for {nuclide_name}: {type(res)}", file=sys.stderr)
                        
                        # Resolved regions
                        if hasattr(res, 'resolved') and res.resolved:
                            resolved_list = res.resolved if isinstance(res.resolved, list) else [res.resolved]
                            print(f"[XS Plot] Found {len(resolved_list)} resolved region(s)", file=sys.stderr)
                            for r in resolved_list:
                                print(f"[XS Plot] Resolved region: {r.energy_min} to {r.energy_max} eV", file=sys.stderr)
                                resonance_regions.append({
                                    "type": "resolved",
                                    "energyMin": float(r.energy_min),
                                    "energyMax": float(r.energy_max)
                                })
                                # Try to extract some parameters for key resonances
                                try:
                                    if hasattr(r, 'parameters') and r.parameters is not None:
                                        df = r.parameters
                                        print(f"[XS Plot] Resonance parameters found. Type: {type(df)}", file=sys.stderr)
                                        
                                        # Handle both Pandas DataFrame and Numpy structured array
                                        is_pandas = hasattr(df, 'iterrows')
                                        
                                        energies = df['energy'].values if is_pandas else df['energy']
                                        mask = (energies >= energy_min) & (energies <= energy_max)
                                        
                                        if is_pandas:
                                            in_range = df[mask]
                                        else:
                                            # Numpy structured array filtering
                                            in_range = df[mask]
                                            
                                        print(f"[XS Plot] {len(in_range)} resonances in plot range", file=sys.stderr)
                                        
                                        # Limit to top 100 to avoid huge JSON
                                        if len(in_range) > 100:
                                            print(f"[XS Plot] Limiting 100+ resonances to top 100", file=sys.stderr)
                                            if is_pandas:
                                                sort_col = next((c for c in ['totalWidth', 'neutronWidth', 'captureWidth'] if c in in_range.columns), 'energy')
                                                in_range = in_range.sort_values(sort_col, ascending=False).head(100)
                                            else:
                                                # Basic sort for numpy arrays
                                                sort_col = next((c for c in ['totalWidth', 'neutronWidth', 'captureWidth'] if c in in_range.dtype.names), 'energy')
                                                in_range = np.sort(in_range, order=sort_col)[-100:]
                                        
                                        if is_pandas:
                                            for _, row in in_range.iterrows():
                                                param = {"energy": float(row['energy'])}
                                                width_map = {'neutronWidth': 'neutronWidth', 'captureWidth': 'gammaWidth', 
                                                           'gammaWidth': 'gammaWidth', 'fissionWidth': 'fissionWidth', 
                                                           'totalWidth': 'totalWidth'}
                                                for col, target in width_map.items():
                                                    if col in row and not np.isnan(row[col]):
                                                        param[target] = float(row[col])
                                                resonance_params.append(param)
                                        else:
                                            for row in in_range:
                                                param = {"energy": float(row['energy'])}
                                                for col in in_range.dtype.names:
                                                    target = {'neutronWidth': 'neutronWidth', 'captureWidth': 'gammaWidth', 
                                                            'gammaWidth': 'gammaWidth', 'fissionWidth': 'fissionWidth', 
                                                            'totalWidth': 'totalWidth'}.get(col)
                                                    if target and not np.isnan(row[col]):
                                                        param[target] = float(row[col])
                                                resonance_params.append(param)
                                except Exception as e:
                                    print(f"[XS Plot] Error extracting parameters: {e}", file=sys.stderr)
                                    import traceback
                                    traceback.print_exc(file=sys.stderr)
                                    
                        # Unresolved regions
                        if hasattr(res, 'unresolved') and res.unresolved:
                            unresolved_list = res.unresolved if isinstance(res.unresolved, list) else [res.unresolved]
                            print(f"[XS Plot] Found {len(unresolved_list)} unresolved region(s)", file=sys.stderr)
                            for ur in unresolved_list:
                                resonance_regions.append({
                                    "type": "unresolved",
                                    "energyMin": float(ur.energy_min),
                                    "energyMax": float(ur.energy_max)
                                })
                    else:
                        print(f"[XS Plot] No 'resonances' attribute found in nuc_data for {nuclide_name}", file=sys.stderr)
                        # Check for URR (Unresolved Resonance Region) data
                        if hasattr(nuc_data, 'urr') and nuc_data.urr:
                            print(f"[XS Plot] Found URR data for {nuclide_name}", file=sys.stderr)
                            # Use first temperature's energy range
                            for temp, urr_table in nuc_data.urr.items():
                                if hasattr(urr_table, 'energy') and urr_table.energy is not None:
                                    energies = urr_table.energy
                                    if len(energies) > 0:
                                        energy_min_urr = float(energies[0])
                                        energy_max_urr = float(energies[-1])
                                        print(f"[XS Plot] URR energy range: {energy_min_urr} to {energy_max_urr} eV", file=sys.stderr)
                                        resonance_regions.append({
                                            "type": "unresolved",
                                            "energyMin": energy_min_urr,
                                            "energyMax": energy_max_urr
                                        })
                                    break  # Use first temperature only

                    # Get cross-section data for each reaction
                    for reaction_mt in parsed_reactions:
                        try:
                            energy, xs_values = get_xs_data_for_temp(nuc_data, reaction_mt, temperature)
                            
                            if energy is None:
                                print(f"Warning: Reaction MT={reaction_mt} not available for {nuclide_name}", file=sys.stderr)
                                continue
                            
                            # Filter by energy range
                            mask = (energy >= energy_min) & (energy <= energy_max)
                            energy_filtered = energy[mask]
                            xs_filtered = xs_values[mask]
                            
                            # Ensure positive values for log scale
                            xs_filtered = np.maximum(xs_filtered, 1e-10)
                            
                            # Get reaction name
                            reaction_name = mt_names.get(reaction_mt, f"MT={reaction_mt}")
                            
                            # Create label
                            label = f"{nuclide_name} {reaction_name}"
                            
                            curve = {
                                "energy": energy_filtered.tolist(),
                                "xs": xs_filtered.tolist(),
                                "nuclide": nuclide_name,
                                "reaction": reaction_mt,
                                "label": label
                            }
                            
                            # Add resonance info to curve
                            if resonance_regions:
                                curve["resonanceRegions"] = resonance_regions
                            # Always include resonances array (empty if no parameters)
                            curve["resonances"] = resonance_params if resonance_params else []
                            
                            # Extract uncertainty data if requested
                            print(f"[XS Plot] include_uncertainty={include_uncertainty}, checking for MT={reaction_mt}", file=sys.stderr)
                            if include_uncertainty:
                                print(f"[XS Plot] Calling extract_uncertainty_data for MT={reaction_mt}", file=sys.stderr)
                                uncertainty = extract_uncertainty_data(nuc_data, reaction_mt, temperature, energy_filtered)
                                print(f"[XS Plot] extract_uncertainty_data returned: {uncertainty is not None}", file=sys.stderr)
                                if uncertainty:
                                    curve["uncertainty"] = uncertainty
                                    print(f"[XS Plot] Added uncertainty to curve for MT={reaction_mt}", file=sys.stderr)
                                
                            curves.append(curve)
                            
                            # Calculate reaction rate if flux spectrum provided
                            if flux_spectrum:
                                flux_energy = np.array(flux_spectrum.get('energy', []))
                                flux_values = np.array(flux_spectrum.get('values', []))
                                
                                if len(flux_energy) > 0 and len(flux_values) > 0:
                                    # For microscopic XS, we need to convert to macroscopic
                                    # For now, calculate per atom reaction rate
                                    rate, int_flux, avg_xs = calculate_reaction_rate(
                                        energy_filtered, xs_filtered, flux_energy, flux_values
                                    )
                                    
                                    reaction_rates.append({
                                        "nuclide": nuclide_name,
                                        "reaction": reaction_mt,
                                        "rate": float(rate),
                                        "integratedFlux": float(int_flux),
                                        "avgXS": float(avg_xs)
                                    })
                        except Exception as e:
                            print(f"Warning: Failed to get reaction {reaction_mt} for {nuclide_name}: {e}", 
                                  file=sys.stderr)
                            continue
                            
                except Exception as e:
                    print(f"Warning: Failed to process nuclide {nuclide_name}: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    continue
        
        # Calculate integral quantities if requested
        if include_integrals and curves:
            for curve in curves:
                curve["integrals"] = calculate_integral_quantities(curve)
        
        # Calculate derivative/slope data if requested
        if include_derivative and curves:
            print(f"[XS Plot] Calculating derivatives for {len(curves)} curves", file=sys.stderr)
            for curve in curves:
                curve["derivative"] = calculate_derivative(curve)
        
        if not curves:
            error_msg = "No valid cross-section data found."
            if cross_sections_path:
                error_msg += f" Could not load from: {cross_sections_path}"
            else:
                error_msg += " Set the cross-section path in Preferences → Nuke Visualizer, or set OPENMC_CROSS_SECTIONS environment variable."
            print(json.dumps({"error": error_msg}))
            return 1
        
        result = {
            "curves": curves,
            "temperature": temperature if not temp_comparison else None
        }
        
        if reaction_rates:
            result["reactionRates"] = reaction_rates
        
        print(json.dumps(result))
        return 0
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_list_nuclides(args):
    """List available nuclides from cross_sections.xml."""
    try:
        import openmc
        import openmc.data
    except ImportError as e:
        print(json.dumps({"nuclides": [], "error": f"OpenMC not installed: {e}"}))
        return 1

    try:
        # Get the cross sections path from environment or argument
        cross_sections = args.cross_sections if args.cross_sections else None
        
        if cross_sections:
            # Load specific cross_sections.xml
            data = openmc.data.DataLibrary.from_xml(cross_sections)
        else:
            # Try to use default cross sections
            try:
                data = openmc.data.DataLibrary.open()
            except:
                # If that fails, return common nuclides
                common_nuclides = [
                    'H1', 'H2', 'He3', 'He4', 'Li6', 'Li7', 'Be9', 'B10', 'B11',
                    'C0', 'N14', 'N15', 'O16', 'O17', 'O18', 'F19', 'Na23', 'Mg24',
                    'Al27', 'Si28', 'P31', 'S32', 'Cl35', 'K39', 'Ca40', 'Sc45',
                    'Ti46', 'V51', 'Cr52', 'Mn55', 'Fe54', 'Co59', 'Ni58', 'Cu63',
                    'Ga69', 'Ge70', 'As75', 'Se76', 'Br79', 'Kr80', 'Rb85', 'Sr86',
                    'Y89', 'Zr90', 'Nb93', 'Mo96', 'Tc99', 'Ru100', 'Rh103', 'Pd104',
                    'Ag107', 'Cd110', 'In113', 'Sn114', 'Sb121', 'Te122', 'I127',
                    'Xe128', 'Cs133', 'Ba134', 'La139', 'Ce140', 'Pr141', 'Nd142',
                    'Pm147', 'Sm144', 'Eu151', 'Gd156', 'Tb159', 'Dy162', 'Ho165',
                    'Er166', 'Tm169', 'Yb168', 'Lu175', 'Hf174', 'Ta181', 'W182',
                    'Re185', 'Os190', 'Ir191', 'Pt192', 'Au197', 'Hg200', 'Tl203',
                    'Pb204', 'Bi209', 'Th232', 'Pa231', 'U234', 'U235', 'U238',
                    'Np237', 'Pu238', 'Pu239', 'Pu240', 'Pu241', 'Pu242', 'Am241',
                    'Am242', 'Am243', 'Cm244', 'Cm245', 'Cm246', 'Cm247', 'Cm248'
                ]
                print(json.dumps({"nuclides": common_nuclides}))
                return 0
        
        # Extract nuclide names from the data library
        nuclides = []
        
        # In newer OpenMC versions, data.libraries is a DataLibrary object containing dicts
        for entry in data.libraries:
            # Entry is a dict with 'path', 'type', 'materials' keys
            if isinstance(entry, dict):
                materials = entry.get('materials', [])
                if materials:
                    nuclides.extend(materials)
            else:
                # Handle old API where entry might be an object with tables
                tables = getattr(entry, 'tables', [])
                if isinstance(tables, dict):
                    tables = tables.values()
                for table in tables:
                    if hasattr(table, 'nuclide'):
                        nuclides.append(table.nuclide)
                    elif hasattr(table, 'name'):
                        nuclides.append(table.name)
        
        # Remove duplicates and sort
        nuclides = sorted(set(nuclides))
        
        print(json.dumps({"nuclides": nuclides}))
        return 0
        
    except Exception as e:
        import traceback
        print(json.dumps({"nuclides": [], "error": str(e), "traceback": traceback.format_exc()}))
        return 1


def cmd_list_thermal_materials(args):
    """List available thermal scattering materials from cross_sections.xml."""
    try:
        import xml.etree.ElementTree as ET
    except ImportError as e:
        print(json.dumps({"materials": [], "error": f"XML parsing not available: {e}"}))
        return 1

    try:
        # Get the cross sections path from environment or argument
        cross_sections = args.cross_sections if args.cross_sections else None
        
        if not cross_sections:
            # Try environment variable
            cross_sections = os.environ.get('OPENMC_CROSS_SECTIONS')
        
        if not cross_sections or not os.path.exists(cross_sections):
            print(json.dumps({"materials": [], "error": "Cross sections file not found"}))
            return 1
        
        # Parse cross_sections.xml
        tree = ET.parse(cross_sections)
        root = tree.getroot()
        
        materials = []
        for lib in root.findall('library'):
            if lib.get('type') == 'thermal':
                mat = lib.get('materials')
                if mat:
                    materials.append(mat)
        
        # Sort materials
        materials = sorted(materials)
        
        print(json.dumps({"materials": materials}))
        return 0
        
    except Exception as e:
        print(json.dumps({"materials": [], "error": str(e)}))
        return 1


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
    
    # XS Plot command
    xs_parser = subparsers.add_parser('xs-plot', help='Plot cross-sections')
    xs_parser.add_argument('--nuclides', help='Comma-separated nuclide names')
    xs_parser.add_argument('--reactions', required=True, help='Comma-separated reaction MT numbers')
    xs_parser.add_argument('--temperature', type=float, default=294.0, help='Temperature in Kelvin')
    xs_parser.add_argument('--energy-min', type=float, default=1e-5, help='Minimum energy in eV')
    xs_parser.add_argument('--energy-max', type=float, default=2e7, help='Maximum energy in eV')
    xs_parser.add_argument('--energy-region', help='Energy region preset (thermal, resonance, epithermal, fast, full)')
    xs_parser.add_argument('--cross-sections', help='Path to cross_sections.xml file')
    xs_parser.add_argument('--temp-comparison', help='Temperature comparison mode: comma-separated temperatures')
    xs_parser.add_argument('--materials', help='JSON string of materials with components')
    xs_parser.add_argument('--flux-spectrum', help='JSON string of flux spectrum for reaction rate calculation')
    xs_parser.add_argument('--library-comparison', help='JSON string of library comparison configuration')
    xs_parser.add_argument('--include-uncertainty', action='store_true', help='Include uncertainty/error data if available')
    xs_parser.add_argument('--include-integrals', action='store_true', help='Calculate and include integral quantities')
    xs_parser.add_argument('--include-derivative', action='store_true', help='Calculate and include derivative/slope data')
    xs_parser.add_argument('--thermal-scattering', help='JSON string of thermal scattering (S(alpha,beta)) request')
    
    # List Nuclides command
    nuclides_parser = subparsers.add_parser('list-nuclides', help='List available nuclides')
    nuclides_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
    # List Thermal Materials command
    thermal_parser = subparsers.add_parser('list-thermal-materials', help='List available thermal scattering materials')
    thermal_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
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
        'xs-plot': cmd_xs_plot,
        'list-nuclides': cmd_list_nuclides,
        'list-thermal-materials': cmd_list_thermal_materials,
    }
    
    if args.command in commands:
        return commands[args.command](args)
    else:
        print(f"Unknown command: {args.command}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
