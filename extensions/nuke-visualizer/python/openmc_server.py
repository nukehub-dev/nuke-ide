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
import numpy as np

# NumPy 2.0+ compatibility: trapezoid replaces trapz
if hasattr(np, 'trapezoid'):
    _np_trapz = np.trapezoid
else:
    _np_trapz = np.trapz

# Force headless/offscreen rendering BEFORE importing vtk or paraview
os.environ['DISPLAY'] = ''
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VTK_USE_OFFSCREEN'] = '1'

# Import common utilities
from visualizer_common import (
    find_free_port, COLOR_MAPS, COLOR_MAPS_SHORT, hex_to_rgb, get_data_bounds,
    calculate_camera_position, create_update_view, create_reset_camera_controller,
    create_set_camera_view_controller, 
    create_pan_camera_controller, create_zoom_camera_controller,
    create_capture_screenshot_controller,
    save_screenshot_with_timestamp, UIComponents, StateHandlers,
    init_common_state, GLOBAL_STYLES
)

from openmc_integration import OpenMCReader

# Group structure cache
_group_structures_cache = None


def load_group_structures():
    """Load group structure definitions from multiple sources."""
    global _group_structures_cache
    
    if _group_structures_cache is not None:
        return _group_structures_cache
    
    structures = {}
    metadata = {"openmc_available": False, "sources": []}
    
    # 1. Try to load built-in OpenMC structures
    try:
        import openmc.mgxs
        for name, edges in openmc.mgxs.GROUP_STRUCTURES.items():
            structures[name] = sorted(edges, reverse=True)
        metadata["openmc_available"] = True
        metadata["sources"].append("OpenMC Built-ins")
    except ImportError:
        pass
    
    # 2. Load from YAML files
    yaml_locations = [
        (os.path.expanduser('~/.nuke-ide/group_structures.yaml'), "Global IDE Config"),
        (os.path.join(os.getcwd(), 'group_structures.yaml'), "Project Config")
    ]
    
    for yaml_path, source_name in yaml_locations:
        if os.path.exists(yaml_path):
            try:
                import yaml
                with open(yaml_path, 'r') as f:
                    data = yaml.safe_load(f)
                if data and 'structures' in data:
                    for name, info in data['structures'].items():
                        if 'boundaries_eV' in info:
                            structures[name] = sorted(info['boundaries_eV'], reverse=True)
                    metadata["sources"].append(source_name)
            except ImportError:
                print(f"[XS Plot] PyYAML not installed, skipping {yaml_path}", file=sys.stderr)
            except Exception as e:
                print(f"[XS Plot] Error loading {yaml_path}: {e}", file=sys.stderr)
    
    _group_structures_cache = (structures, metadata)
    return _group_structures_cache


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
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
        import vtk
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1
    
    port = args.port or find_free_port(8090)
    reader = OpenMCReader()
    
    try:
        # Load the tally
        tally = reader.load_tally(args.statepoint, args.tally_id)
        
        if not tally.has_mesh:
            print(f"Error: Tally {args.tally_id} is not a mesh tally", file=sys.stderr)
            return 1
        
        mesh_type = tally.mesh_info.get('mesh_type', 'regular') if tally.mesh_info else 'regular'
        print(f"[OpenMC] Loading {mesh_type} mesh for tally {args.tally_id}", file=sys.stderr)
        
        # Resolve indices
        def resolve_index(val, lst, default=0):
            if val is None:
                return default
            try:
                return int(val)
            except (ValueError, TypeError):
                if lst and val in lst:
                    return lst.index(val)
                return default
        
        score_idx = resolve_index(args.score_index, tally.scores)
        nuclide_idx = resolve_index(args.nuclide_index, tally.nuclides)
        
        # Create VTK grid
        mesh_grid = reader.create_mesh_tally_vtu(tally, score_idx, nuclide_idx)
        
        # Extract mesh info for display
        mesh_info_display = {}
        if tally.mesh_info:
            mesh = tally.mesh_info
            mesh_type = mesh.get('mesh_type', 'regular')
            
            if mesh_type == 'cylindrical':
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
                mesh_info_display = {
                    'type': 'Regular (Cartesian)',
                    'dimensions': ' × '.join(str(d) for d in mesh.get('dimensions', [])),
                    'bounds': f"({', '.join(f'{v:.3f}' for v in mesh.get('lower_left', []))}) to ({', '.join(f'{v:.3f}' for v in mesh.get('upper_right', []))})",
                    'width': ' × '.join(f'{v:.4f}' for v in mesh.get('width', []))
                }
        
        # Write to temporary file
        with tempfile.NamedTemporaryFile(suffix='.vtu', delete=False) as tmp:
            tmp_path = tmp.name
        
        writer = vtk.vtkXMLUnstructuredGridWriter()
        writer.SetFileName(tmp_path)
        writer.SetInputData(mesh_grid)
        writer.Write()
        
        # Create trame application
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Initialize common state
        init_common_state(state, theme='dark', 
                         color_by='Cell: tally_mean',
                         show_scalar_bar=True,
                         color_map=args.colormap or 'Cool to Warm')
        
        # Tally and mesh info
        state.mesh_type = mesh_info_display.get('type', 'Unknown')
        state.mesh_dimensions = mesh_info_display.get('dimensions', 'N/A')
        state.mesh_bounds = mesh_info_display.get('bounds', 'N/A')
        state.mesh_width = mesh_info_display.get('width', 'N/A')
        state.current_score = tally.scores[score_idx] if tally.scores and score_idx < len(tally.scores) else 'total'
        state.current_nuclide = tally.nuclides[nuclide_idx] if tally.nuclides and nuclide_idx < len(tally.nuclides) else 'total'
        
        # Load in ParaView
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
        
        simple.ColorBy(display, ('CELLS', 'tally_mean'))
        lut = simple.GetColorTransferFunction('tally_mean')
        lut.ApplyPreset(state.color_map, True)
        
        bg_rgb = hex_to_rgb(state.background_color_hex)
        view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        
        scalar_bar = simple.GetScalarBar(lut, view)
        if scalar_bar:
            scalar_bar.Visibility = 1
            scalar_bar.Title = 'Tally Mean'
        
        view.OrientationAxesVisibility = 1
        simple.Render(view)
        simple.ResetCamera()
        
        # Pipeline storage
        pipeline = {'source': vtk_source, 'display': display, 'view': view, 'view_widget': None}
        
        # Update view function
        update_view = create_update_view(pipeline, state, simple)
        
        # State change handlers
        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            StateHandlers.create_color_by_handler(pipeline, state, simple)(color_by, **kwargs)
            update_view()
        
        @state.change("color_map")
        def on_color_map_change(color_map, **kwargs):
            StateHandlers.create_color_map_handler(pipeline, state, simple)(color_map, **kwargs)
            update_view()
        
        @state.change("opacity")
        def on_opacity_change(opacity, **kwargs):
            StateHandlers.create_opacity_handler(pipeline)(opacity, **kwargs)
            update_view()
        
        @state.change("representation")
        def on_representation_change(representation, **kwargs):
            try:
                display.Representation = representation
                update_view()
            except Exception as e:
                print(f"Error updating representation: {e}", file=sys.stderr)
        
        @state.change("show_scalar_bar")
        def on_scalar_bar_change(show_scalar_bar, **kwargs):
            StateHandlers.create_scalar_bar_handler(pipeline, state, simple)(show_scalar_bar, **kwargs)
            update_view()
        
        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            StateHandlers.create_background_handler(pipeline, state)(background_color_hex, **kwargs)
            update_view()
        
        @state.change("show_orientation_axes")
        def on_orientation_axes_change(show_orientation_axes, **kwargs):
            StateHandlers.create_orientation_axes_handler(pipeline)(show_orientation_axes, **kwargs)
            update_view()
        
        @state.change("show_bounding_box")
        def on_bounding_box_change(show_bounding_box, **kwargs):
            try:
                # Note: CenterAxesVisibility may not be available in all ParaView versions
                pass
            except Exception as e:
                print(f"Error updating bounding box: {e}", file=sys.stderr)
        
        @state.change("show_cube_axes")
        def on_cube_axes_change(show_cube_axes, **kwargs):
            try:
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = 1 if show_cube_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating cube axes: {e}", file=sys.stderr)
        
        @state.change("point_size")
        def on_point_size_change(point_size, **kwargs):
            StateHandlers.create_point_size_handler(pipeline)(point_size, **kwargs)
            update_view()
        
        @state.change("line_width")
        def on_line_width_change(line_width, **kwargs):
            StateHandlers.create_line_width_handler(pipeline)(line_width, **kwargs)
            update_view()
        
        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            StateHandlers.create_ambient_light_handler(pipeline)(ambient_light, **kwargs)
            update_view()
        
        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            StateHandlers.create_parallel_projection_handler(pipeline, state)(parallel_projection, **kwargs)
            update_view(True)
        
        # Controllers
        reset_camera = create_reset_camera_controller(pipeline, update_view)
        set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
        pan_camera = create_pan_camera_controller(pipeline, update_view)
        zoom_camera = create_zoom_camera_controller(pipeline, update_view)
        capture_screenshot = create_capture_screenshot_controller(pipeline)
        
        def toggle_controls():
            state.show_controls = not state.show_controls
            return state.show_controls
        
        # UI
        with VAppLayout(server) as layout:
            from trame.widgets import html
            html.Style(GLOBAL_STYLES)
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True), app=True, width=300, clipped=True,
                color="#1e1e1e", dark=True
            ):
                with vuetify.VContainer(classes="pa-3"):
                    # Header
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        html.Div(f"Tally {tally.id}: {tally.name}", 
                                classes="text-subtitle-1 font-weight-medium white--text")
                        with vuetify.VBtn(click=toggle_controls, small=True, icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-2")
                    
                    # Score and Nuclide info
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        for label, value in [("Score", "current_score"), ("Nuclide", "current_nuclide")]:
                            with vuetify.VCol(cols=6, classes="pa-0 pr-1" if label == "Score" else "pa-0 pl-1"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(label, style="font-size: 10px; color: #888; text-transform: uppercase;")
                                    html.Div(f"{{{{{value}}}}}", style="font-size: 13px; color: #fff; font-weight: 500;")
                    
                    # Mesh Info
                    html.Div("Mesh Info", style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;")
                    
                    with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                        for label, value in [("Type", "mesh_type"), ("Dimensions", "mesh_dimensions")]:
                            with vuetify.VCol(cols=6, classes="pa-0 pr-1" if label == "Type" else "pa-0 pl-1"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(label, style="font-size: 10px; color: #888;")
                                    html.Div(f"{{{{{value}}}}}", style="font-size: 12px; color: #fff;")
                    
                    for label, value in [("Bounds (cm)", "mesh_bounds"), ("Cell Size", "mesh_width")]:
                        with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                            with vuetify.VCol(cols=12, classes="pa-0"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(label, style="font-size: 10px; color: #888;")
                                    html.Div(f"{{{{{value}}}}}", style="font-size: 11px if 'Bounds' in label else 12px; color: #fff;")
                    
                    vuetify.VDivider(classes="mb-4")
                    
                    # Controls
                    UIComponents.opacity_slider(vuetify)
                    UIComponents.representation_selector(vuetify)
                    UIComponents.color_by_selector(vuetify)
                    
                    with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                        UIComponents.color_map_selector(vuetify, COLOR_MAPS)
                        vuetify.VCheckbox(
                            v_model=("show_scalar_bar", True), label="Show Color Legend",
                            dense=True, classes="mb-4"
                        )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Compact toggles in a grid
                    UIComponents.compact_appearance_controls(vuetify)
                    
                    # Detail sliders
                    UIComponents.point_size_slider(vuetify)
                    UIComponents.line_width_slider(vuetify)
                    UIComponents.ambient_light_slider(vuetify)
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Screenshot Section
                    def save_screenshot():
                        save_screenshot_with_timestamp(capture_screenshot, state)
                    
                    vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn("Save Screenshot", click=save_screenshot,
                                block=True, small=True, color="primary", classes="mb-2")
                    
                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VSubheader(("screenshot_status",), classes="text-caption justify-center")
            
            with vuetify.VMain():
                # Toggle button when controls are hidden
                with vuetify.VContainer(
                    v_if=("!show_controls",), classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;"
                ):
                    with vuetify.VBtn(click=toggle_controls, small=True, fab=True, color="primary"):
                        vuetify.VIcon("mdi-chevron-right")
                
                # Camera Navigation Gadget (Top Right)
                UIComponents.create_canvas_gadget(vuetify, pan_camera, zoom_camera, reset_callback=reset_camera, view_callback=set_camera_view)
                
                view_widget = pv_widgets.VtkRemoteView(view, interactive_ratio=1, style="width: 100%; height: 100%;")
                pipeline['view_widget'] = view_widget
        
        # Add controllers
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
        
        @state.change("camera_update_counter")
        def on_camera_update(camera_update_counter, **kwargs):
            try:
                simple.Render(view)
                if pipeline.get('view_widget'):
                    pipeline['view_widget'].update()
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
        import vtk
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1
    
    port = args.port or find_free_port(8090)
    reader = OpenMCReader()
    
    try:
        # Load source data
        source_poly = reader.load_source(args.source)
        
        # Write to temporary file
        with tempfile.NamedTemporaryFile(suffix='.vtp', delete=False) as tmp:
            tmp_path = tmp.name
        
        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetFileName(tmp_path)
        writer.SetInputData(source_poly)
        writer.Write()
        
        # Create trame application
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Initialize common state
        init_common_state(state, theme='dark')
        state.point_size = 2.0
        state.color_map = 'Plasma'
        state.show_scalar_bar = True
        state.color_by = 'Point: energy'
        
        # Load in ParaView
        source_reader = simple.XMLPolyDataReader(FileName=tmp_path)
        
        # Get available arrays
        available_arrays = ['Solid Color']
        point_data = source_reader.PointData
        for i in range(point_data.GetNumberOfArrays()):
            array = point_data.GetArray(i)
            if array and array.GetName():
                available_arrays.append(f"Point: {array.GetName()}")
        
        state.available_arrays = available_arrays
        if 'Point: energy' not in available_arrays:
            state.color_by = 'Solid Color'
        
        # Create visualization
        display = simple.Show(source_reader)
        view = simple.GetActiveViewOrCreate('RenderView')
        
        display.Representation = 'Points'
        display.PointSize = state.point_size
        
        if state.color_by != 'Solid Color':
            simple.ColorBy(display, ('POINTS', 'energy'))
            lut = simple.GetColorTransferFunction('energy')
            lut.ApplyPreset('Plasma', True)
        
        bg_rgb = hex_to_rgb(state.background_color_hex)
        view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        view.OrientationAxesVisibility = 1
        
        simple.Render(view)
        simple.ResetCamera()
        
        # Pipeline storage
        pipeline = {'source': source_reader, 'display': display, 'view': view, 'view_widget': None}
        
        # Update view function
        def update_view(push_camera=False):
            try:
                simple.Render(view)
                vw = pipeline.get('view_widget')
                if vw:
                    if push_camera:
                        state.camera_update_counter = state.camera_update_counter + 1 if hasattr(state, 'camera_update_counter') else 1
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)
        
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
            StateHandlers.create_point_size_handler(pipeline)(point_size, **kwargs)
            update_view()
        
        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            StateHandlers.create_background_handler(pipeline, state)(background_color_hex, **kwargs)
            update_view()
        
        @state.change("show_orientation_axes")
        def on_orientation_axes_change(show_orientation_axes, **kwargs):
            StateHandlers.create_orientation_axes_handler(pipeline)(show_orientation_axes, **kwargs)
            update_view()
        
        @state.change("show_cube_axes")
        def on_cube_axes_change(show_cube_axes, **kwargs):
            try:
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = 1 if show_cube_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating cube axes: {e}", file=sys.stderr)
        
        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            StateHandlers.create_ambient_light_handler(pipeline)(ambient_light, **kwargs)
            update_view()
        
        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            StateHandlers.create_parallel_projection_handler(pipeline, state)(parallel_projection, **kwargs)
            update_view(True)
        
        # Controllers
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
                bounds = get_data_bounds(source_reader)
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
            state.show_controls = not state.show_controls
            return state.show_controls
        
        # Controllers
        reset_camera = create_reset_camera_controller(pipeline, update_view)
        set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
        pan_camera = create_pan_camera_controller(pipeline, update_view)
        zoom_camera = create_zoom_camera_controller(pipeline, update_view)
        capture_screenshot = create_capture_screenshot_controller(pipeline)

        # UI setup
        with VAppLayout(server) as layout:
            from trame.widgets import html
            html.Style(GLOBAL_STYLES)
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True), app=True, width=320, clipped=True,
                color="#1e1e1e", dark=True
            ):
                with vuetify.VContainer(classes="pa-4"):
                    # Header
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        vuetify.VSubheader("OpenMC Source", classes="text-h6 pa-0")
                        with vuetify.VBtn(click=toggle_controls, small=True, icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-4")
                    
                    # Particles count
                    with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"):
                        html.Div("Particles", style="font-size: 10px; color: #888; text-transform: uppercase;")
                        html.Div(str(source_poly.GetNumberOfPoints()), style="font-size: 14px; color: #fff; font-weight: 500;")
                    
                    vuetify.VDivider(classes="mb-4")
                    
                    # Projection Mode
                    vuetify.VCheckbox(
                        v_model=("parallel_projection", False),
                        label="Parallel Projection (2D/Ortho)",
                        dense=True, classes="mb-2"
                    )
                    
                    # Detail sliders
                    UIComponents.point_size_slider(vuetify, ("point_size", 2.0), max=10)
                    UIComponents.ambient_light_slider(vuetify)
                    
                    vuetify.VSelect(
                        v_model=("color_by", state.color_by),
                        items=("available_arrays",),
                        label="Color By", dense=True, outlined=True, classes="mb-4"
                    )
                    
                    UIComponents.color_map_selector_short(vuetify)
                    
                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", True),
                        label="Show Color Legend",
                        dense=True, classes="mb-4"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Compact toggles in a grid
                    UIComponents.compact_appearance_controls(vuetify)
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Screenshot Section
                    def save_screenshot():
                        save_screenshot_with_timestamp(capture_screenshot, state)
                    
                    vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn("Save Screenshot", click=save_screenshot,
                                block=True, small=True, color="primary", classes="mb-2")
                    
                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VSubheader(("screenshot_status",), classes="text-caption justify-center")
            
            with vuetify.VMain():
                # Toggle button when controls are hidden
                with vuetify.VContainer(
                    v_if=("!show_controls",), classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;"
                ):
                    with vuetify.VBtn(click=toggle_controls, small=True, fab=True, color="primary"):
                        vuetify.VIcon("mdi-chevron-right")
                
                # Camera Navigation Gadget (Top Right)
                UIComponents.create_canvas_gadget(vuetify, pan_camera, zoom_camera, reset_callback=reset_camera, view_callback=set_camera_view)
                
                view_widget = pv_widgets.VtkRemoteView(view, interactive_ratio=1, style="width: 100%; height: 100%;")
                pipeline['view_widget'] = view_widget
        
        # Add controllers
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
        
        @state.change("camera_update_counter")
        def on_camera_update(camera_update_counter, **kwargs):
            try:
                simple.Render(view)
                if pipeline.get('view_widget'):
                    pipeline['view_widget'].update()
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
    """Overlay tally on geometry with full interactive controls."""
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
        import vtk
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1
    
    port = args.port or find_free_port(8090)
    reader = OpenMCReader()
    
    try:
        viz_data = reader.visualize_tally_on_geometry(
            args.geometry, args.statepoint, args.tally_id, args.score,
            filter_graveyard=not args.no_graveyard_filter
        )
        tally = viz_data['tally']
        overlay_type = viz_data.get('overlay_type', 'none')
        
        server = get_server(client_type="vue2", port=port)
        state = server.state
        
        # Determine which display has the colored data
        # For cell/mesh_mapped tallies: geometry_display has the tally colors
        # For mesh tallies: tally_display has the mesh overlay
        has_colored_data = overlay_type in ('cell', 'mesh', 'mesh_mapped')
        
        # Determine default color array name and location
        # The integration module now provides array_location info for mesh_mapped type
        if overlay_type == 'cell':
            color_array_name = 'tally_value'
            color_array_location = 'CELLS'
        elif overlay_type == 'mesh_mapped':
            color_array_name = viz_data.get('array_name', 'tally_mean')
            # Get location from integration (default to POINTS for resampled data)
            color_array_location = viz_data.get('array_location', 'POINTS')
        else:
            color_array_name = 'tally_mean'
            color_array_location = 'CELLS'
        
        default_color_type = 'Cell' if color_array_location == 'CELLS' else 'Point'
        
        # Initialize common state
        init_common_state(state, theme='dark', 
                         opacity=1.0 if overlay_type in ('cell', 'mesh_mapped') else 0.6,
                         color_by=f'{default_color_type}: {color_array_name}' if has_colored_data else 'Solid Color',
                         show_scalar_bar=has_colored_data,
                         color_map=args.colormap or 'Cool to Warm')
        
        # Store array info for later use
        state.array_name = color_array_name
        state.array_location = color_array_location
        
        # Store tally info for display
        state.tally_id = tally.id
        state.tally_name = tally.name
        state.has_mesh = tally.has_mesh
        state.overlay_type = overlay_type
        state.current_score = args.score if args.score else (tally.scores[0] if tally.scores else 'total')
        
        # Store spatial warning if present
        spatial_warning = viz_data.get('spatial_warning')
        if spatial_warning:
            state.spatial_warning = spatial_warning
            # Output JSON warning for TypeScript backend to parse
            print(json.dumps({"type": "warning", "message": spatial_warning}), file=sys.stderr)
            print(f"[Overlay] Spatial warning: {spatial_warning}", file=sys.stderr)
        
        view = simple.GetActiveViewOrCreate('RenderView')
        bg_rgb = hex_to_rgb(state.background_color_hex)
        view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        view.OrientationAxesVisibility = 1
        
        # Get available arrays for coloring from the data source
        available_arrays = ['Solid Color']
        
        # Get the actual source data object (not the display input)
        # For cell/mesh_mapped: geometry is the final source. For mesh: tally_source has the data.
        if overlay_type in ('cell', 'mesh_mapped'):
            data_source = viz_data.get('geometry')
        else:
            data_source = viz_data.get('tally_source')
        
        if data_source:
            try:
                # Add Cell Data
                try:
                    cell_data = data_source.CellData
                    for i in range(cell_data.GetNumberOfArrays()):
                        array = cell_data.GetArray(i)
                        if array and array.GetName():
                            available_arrays.append(f"Cell: {array.GetName()}")
                except Exception as e:
                    pass
                
                # Add Point Data
                try:
                    point_data = data_source.PointData
                    for i in range(point_data.GetNumberOfArrays()):
                        array = point_data.GetArray(i)
                        if array and array.GetName():
                            available_arrays.append(f"Point: {array.GetName()}")
                except Exception as e:
                    pass
            except Exception as e:
                print(f"Warning: Could not get data arrays: {e}", file=sys.stderr)
        
        # Ensure the default color array is in the list
        default_entry = f"{default_color_type}: {color_array_name}"
        if has_colored_data and default_entry not in available_arrays:
            # If the expected array isn't found, add it to ensure it's selectable
            available_arrays.append(default_entry)
            print(f"[Overlay] Added missing default array: {default_entry}", file=sys.stderr)
        
        state.available_arrays = available_arrays
        
        simple.Render(view)
        simple.ResetCamera()
        
        # Setup pipeline
        # For cell tally: only geometry_display exists, and it has the colors
        # For mesh mapped: geometry_display has the resampled colors
        # For mesh tally (fallback): both exist, tally_display has the colors
        geometry_display = viz_data.get('geometry_display')
        tally_display = viz_data.get('tally_display')
        
        # The 'primary_display' is the one with tally colors
        primary_display = geometry_display if overlay_type in ('cell', 'mesh_mapped') else tally_display
        
        # For mesh overlay, the 'geometry' in pipeline should be tally_source for color handlers
        # For cell/mesh_mapped, it's the geometry with mapped colors
        pipeline_geometry = viz_data.get('geometry') if overlay_type in ('cell', 'mesh_mapped') else viz_data.get('tally_source')
        
        pipeline = {
            'view': view, 
            'view_widget': None,
            'source': viz_data.get('geometry') if overlay_type in ('cell', 'mesh_mapped') else viz_data.get('tally_source'),
            'display': primary_display,
            'geometry': pipeline_geometry,
            'geometry_display': geometry_display,
            'tally_source': viz_data.get('tally_source'),
            'tally_display': tally_display,
            'overlay_type': overlay_type
        }
        
        # Setup scalar bar for the initial color array
        if has_colored_data and primary_display:
            try:
                lut = simple.GetColorTransferFunction(color_array_name)
                lut.ApplyPreset(state.color_map, True)
                
                # Get data range from the correct source
                # For mesh overlay: tally_source has the data
                # For cell/mesh_mapped: geometry has the data
                if overlay_type == 'mesh':
                    data_source = viz_data.get('tally_source')
                else:
                    data_source = viz_data.get('geometry')
                
                if data_source:
                    if color_array_location == 'CELLS':
                        data_array = data_source.CellData.GetArray(color_array_name)
                    else:
                        data_array = data_source.PointData.GetArray(color_array_name)
                    
                    if data_array:
                        data_range = data_array.GetRange()
                        lut.RescaleTransferFunction(data_range[0], data_range[1])
                        print(f"[Overlay] Initial color range: [{data_range[0]:.6e}, {data_range[1]:.6e}]", file=sys.stderr)
                
                # Configure scalar bar
                scalar_bar = simple.GetScalarBar(lut, view)
                if scalar_bar:
                    scalar_bar.Visibility = 1 if state.show_scalar_bar else 0
                    scalar_bar.Title = color_array_name.replace('_', ' ').title()
            except Exception as e:
                print(f"[Overlay] Warning: Could not setup initial scalar bar: {e}", file=sys.stderr)
        
        # Force an initial render to ensure everything is properly set up
        simple.Render(view)
        
        def update_view(push_camera=False):
            try:
                simple.Render(view)
                vw = pipeline.get('view_widget')
                if vw:
                    if push_camera:
                        state.camera_update_counter = (state.camera_update_counter + 1) if hasattr(state, 'camera_update_counter') else 1
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)
        
        # State change handlers
        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            try:
                if not primary_display:
                    return
                
                if color_by == 'Solid Color':
                    simple.ColorBy(primary_display, None)
                elif color_by.startswith('Point: '):
                    array_name = color_by[7:]
                    simple.ColorBy(primary_display, ('POINTS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                    # Ensure proper data range is set
                    try:
                        if pipeline.get('geometry'):
                            data_array = pipeline['geometry'].PointData.GetArray(array_name)
                            if data_array:
                                data_range = data_array.GetRange()
                                lut.RescaleTransferFunction(data_range[0], data_range[1])
                    except Exception as e:
                        pass
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                    simple.ColorBy(primary_display, ('CELLS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                    # Ensure proper data range is set
                    try:
                        if pipeline.get('geometry'):
                            data_array = pipeline['geometry'].CellData.GetArray(array_name)
                            if data_array:
                                data_range = data_array.GetRange()
                                lut.RescaleTransferFunction(data_range[0], data_range[1])
                    except Exception as e:
                        pass
                update_view()
            except Exception as e:
                print(f"Error updating color by: {e}", file=sys.stderr)
        
        @state.change("color_map")
        def on_color_map_change(color_map, **kwargs):
            try:
                color_by = state.color_by
                if color_by == 'Solid Color' or not primary_display:
                    return
                
                array_name = None
                array_location = None
                if color_by.startswith('Point: '):
                    array_name = color_by[7:]
                    array_location = 'PointData'
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                    array_location = 'CellData'
                
                if array_name:
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(color_map, True)
                    # Preserve the current data range
                    try:
                        if pipeline.get('geometry'):
                            data = getattr(pipeline['geometry'], array_location)
                            data_array = data.GetArray(array_name)
                            if data_array:
                                data_range = data_array.GetRange()
                                lut.RescaleTransferFunction(data_range[0], data_range[1])
                    except Exception as e:
                        pass
                update_view()
            except Exception as e:
                print(f"Error updating color map: {e}", file=sys.stderr)
        
        @state.change("opacity")
        def on_opacity_change(opacity, **kwargs):
            try:
                # For cell/mesh_mapped tally: opacity affects geometry
                # For mesh tally: opacity affects the mesh overlay
                if overlay_type in ('cell', 'mesh_mapped') and geometry_display:
                    geometry_display.Opacity = float(opacity)
                elif overlay_type == 'mesh' and tally_display:
                    tally_display.Opacity = float(opacity)
                update_view()
            except Exception as e:
                print(f"Error updating opacity: {e}", file=sys.stderr)

        
        @state.change("representation")
        def on_representation_change(representation, **kwargs):
            try:
                if primary_display:
                    primary_display.Representation = representation
                update_view()
            except Exception as e:
                print(f"Error updating representation: {e}", file=sys.stderr)
        
        @state.change("show_scalar_bar")
        def on_scalar_bar_change(show_scalar_bar, **kwargs):
            try:
                color_by = state.color_by
                if color_by == 'Solid Color' or not view:
                    return
                
                array_name = None
                if color_by.startswith('Point: '):
                    array_name = color_by[7:]
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                
                if array_name:
                    lut = simple.GetColorTransferFunction(array_name)
                    scalar_bar = simple.GetScalarBar(lut, view)
                    if scalar_bar:
                        scalar_bar.Visibility = 1 if show_scalar_bar else 0
                    elif show_scalar_bar:
                        # Create scalar bar if it doesn't exist
                        scalar_bar = simple.GetScalarBar(lut, view)
                        scalar_bar.Visibility = 1
                        scalar_bar.Title = array_name.replace('_', ' ').title()
                update_view()
            except Exception as e:
                print(f"Error updating scalar bar: {e}", file=sys.stderr)
        
        @state.change("background_color_hex")
        def on_background_change(background_color_hex, **kwargs):
            try:
                rgb = hex_to_rgb(background_color_hex)
                if rgb and view:
                    try:
                        view.UseColorPaletteForBackground = 0
                    except:
                        pass
                    view.Background = rgb
                update_view()
            except Exception as e:
                print(f"Error updating background: {e}", file=sys.stderr)
        
        @state.change("show_orientation_axes")
        def on_orientation_axes_change(show_orientation_axes, **kwargs):
            try:
                if view:
                    view.OrientationAxesVisibility = 1 if show_orientation_axes else 0
                update_view()
            except Exception as e:
                print(f"Error updating orientation axes: {e}", file=sys.stderr)
        
        @state.change("show_bounding_box")
        def on_bounding_box_change(show_bounding_box, **kwargs):
            try:
                # Note: CenterAxesVisibility may not be available in all ParaView versions
                # This is typically used to show the center of the data bounds
                pass
            except Exception as e:
                print(f"Error updating bounding box: {e}", file=sys.stderr)
        
        @state.change("show_cube_axes")
        def on_cube_axes_change(show_cube_axes, **kwargs):
            try:
                val = 1 if show_cube_axes else 0
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = val
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = val
                update_view()
            except Exception as e:
                print(f"Error updating cube axes: {e}", file=sys.stderr)
        
        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            try:
                val = float(ambient_light)
                if primary_display:
                    primary_display.Ambient = val
                if overlay_type == 'mesh' and geometry_display:
                    geometry_display.Ambient = val
                update_view()
            except Exception as e:
                print(f"Error updating ambient light: {e}", file=sys.stderr)
        
        @state.change("parallel_projection")
        def on_parallel_projection_change(parallel_projection, **kwargs):
            try:
                if view:
                    view.CameraParallelProjection = 1 if parallel_projection else 0
                update_view(True)
            except Exception as e:
                print(f"Error updating projection mode: {e}", file=sys.stderr)
        
        @state.change("point_size")
        def on_point_size_change(point_size, **kwargs):
            try:
                val = float(point_size)
                if primary_display:
                    primary_display.PointSize = val
                if overlay_type == 'mesh' and geometry_display:
                    geometry_display.PointSize = val
                update_view()
            except Exception as e:
                print(f"Error updating point size: {e}", file=sys.stderr)
        
        @state.change("line_width")
        def on_line_width_change(line_width, **kwargs):
            try:
                val = float(line_width)
                if primary_display:
                    primary_display.LineWidth = val
                if overlay_type == 'mesh' and geometry_display:
                    geometry_display.LineWidth = val
                update_view()
            except Exception as e:
                print(f"Error updating line width: {e}", file=sys.stderr)
        
        # Controllers
        reset_camera = create_reset_camera_controller(pipeline, update_view)
        set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
        pan_camera = create_pan_camera_controller(pipeline, update_view)
        zoom_camera = create_zoom_camera_controller(pipeline, update_view)
        capture_screenshot = create_capture_screenshot_controller(pipeline)
        
        def toggle_controls():
            state.show_controls = not state.show_controls
            return state.show_controls

        with VAppLayout(server) as layout:
            from trame.widgets import html
            html.Style(GLOBAL_STYLES)
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True), app=True, width=320, clipped=True,
                color="#1e1e1e", dark=True
            ):
                with vuetify.VContainer(classes="pa-3"):
                    # Header with close button
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        html.Div(f"Overlay: Tally {tally.id}", 
                                classes="text-subtitle-1 font-weight-medium white--text")
                        with vuetify.VBtn(click=toggle_controls, small=True, icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-2")
                    
                    # Overlay type indicator
                    overlay_label = {
                        'cell': 'Cell Tally (on Geometry)',
                        'mesh': 'Mesh Tally (Overlay)',
                        'none': 'Geometry Only'
                    }.get(overlay_type, 'Unknown')
                    
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        with vuetify.VCol(cols=12, classes="pa-0"):
                            with html.Div(style="background: #2a3f5f; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Overlay Type", style="font-size: 10px; color: #88aaff; text-transform: uppercase;")
                                html.Div(overlay_label, style="font-size: 12px; color: #fff; font-weight: 500;")
                    
                    # Tally info
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        with vuetify.VCol(cols=12, classes="pa-0"):
                            with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                html.Div("Tally Name", style="font-size: 10px; color: #888; text-transform: uppercase;")
                                html.Div(tally.name, style="font-size: 13px; color: #fff; font-weight: 500;")
                    
                    # Score info
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        for label, value in [("Score", "current_score"), ("Type", "overlay_type")]:
                            with vuetify.VCol(cols=6, classes="pa-0 pr-1" if label == "Score" else "pa-0 pl-1"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(label, style="font-size: 10px; color: #888; text-transform: uppercase;")
                                    html.Div(f"{{{{{value}}}}}", style="font-size: 12px; color: #fff;")
                    
                    # Scores and Nuclides info
                    if tally.scores:
                        html.Div("Available Scores", style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;")
                        with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                            with vuetify.VCol(cols=12, classes="pa-0"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(", ".join(tally.scores[:5]) + ("..." if len(tally.scores) > 5 else ""), 
                                            style="font-size: 11px; color: #fff;")
                    
                    if tally.nuclides and not (len(tally.nuclides) == 1 and tally.nuclides[0] == 'total'):
                        html.Div("Nuclides", style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;")
                        with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                            with vuetify.VCol(cols=12, classes="pa-0"):
                                with html.Div(style="background: #333; border-radius: 4px; padding: 4px 8px;"):
                                    html.Div(", ".join(tally.nuclides[:5]) + ("..." if len(tally.nuclides) > 5 else ""), 
                                            style="font-size: 11px; color: #fff;")
                    
                    vuetify.VDivider(classes="mb-4")
                    
                    # Controls
                    # Opacity slider - for mesh tallies, control the mesh overlay opacity
                    # For cell tallies, control the geometry opacity
                    opacity_label = "Mesh Opacity" if overlay_type == 'mesh' else "Geometry Opacity"
                    with vuetify.VContainer(classes="pa-0"):
                        html.Div(opacity_label, style="font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 4px;")
                        UIComponents.opacity_slider(vuetify, ("opacity", 0.6 if overlay_type == 'mesh' else 1.0))
                    
                    UIComponents.representation_selector(vuetify)
                    
                    # Color by selector (for both cell and mesh tallies with colored data)
                    if has_colored_data:
                        UIComponents.color_by_selector(vuetify)
                        
                        with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                            UIComponents.color_map_selector(vuetify, COLOR_MAPS)
                            vuetify.VCheckbox(
                                v_model=("show_scalar_bar", True),
                                label="Show Color Legend",
                                dense=True, classes="mb-4"
                            )
                        
                        vuetify.VDivider(classes="my-4")
                    
                    # Compact toggles in a grid
                    UIComponents.compact_appearance_controls(vuetify)
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Detail sliders
                    UIComponents.point_size_slider(vuetify)
                    UIComponents.line_width_slider(vuetify)
                    UIComponents.ambient_light_slider(vuetify)
                    
                    vuetify.VDivider(classes="my-4")
                    
                    # Screenshot Section
                    def save_screenshot():
                        save_screenshot_with_timestamp(capture_screenshot, state)
                    
                    vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn("Save Screenshot", click=save_screenshot,
                                block=True, small=True, color="primary", classes="mb-2")
                    
                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VSubheader(("screenshot_status",), classes="text-caption justify-center")
            
            with vuetify.VMain():
                # Toggle button when controls are hidden
                with vuetify.VContainer(
                    v_if=("!show_controls",), classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;"
                ):
                    with vuetify.VBtn(click=toggle_controls, small=True, fab=True, color="primary"):
                        vuetify.VIcon("mdi-chevron-right")
                
                # Camera Navigation Gadget (Top Right)
                UIComponents.create_canvas_gadget(vuetify, pan_camera, zoom_camera, reset_callback=reset_camera, view_callback=set_camera_view)
                
                pipeline['view_widget'] = pv_widgets.VtkRemoteView(view, interactive_ratio=1, style="width: 100%; height: 100%;")
        
        # Add controllers
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
        
        @state.change("camera_update_counter")
        def on_camera_update(camera_update_counter, **kwargs):
            try:
                simple.Render(view)
                if pipeline.get('view_widget'):
                    pipeline['view_widget'].update()
            except Exception as e:
                print(f"Warning: camera update failed: {e}", file=sys.stderr)
        
        print(f"Starting OpenMC overlay server on port {port}", file=sys.stderr)
        server.start(port=port, debug=False, open_browser=False)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


def cmd_spectrum(args):
    """Get energy spectrum data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_energy_spectrum(
            args.statepoint, args.tally_id,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
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
            args.statepoint, args.tally_id, args.axis,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        serializable_data = {k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in data.items()}
        print(json.dumps(serializable_data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1


def cmd_heatmap(args):
    """Get 2D heatmap slice data."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        data = plotter.create_heatmap_slice(
            args.statepoint, args.tally_id, args.plane, args.slice_index,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        print(json.dumps(data))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_heatmap_all(args):
    """Get all 2D heatmap slices for animation."""
    try:
        from openmc_integration import OpenMCPlotter
        plotter = OpenMCPlotter()
        all_slices = plotter.create_heatmap_slice_all(
            args.statepoint, args.tally_id, args.plane,
            int(args.score_index or 0), int(args.nuclide_index or 0)
        )
        print(f"[Heatmap All] Loaded {len(all_slices)} slices", file=sys.stderr)
        print(json.dumps(all_slices))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_check(args):
    """Check if OpenMC integration is available."""
    from visualizer_common import check_openmc_dependencies
    available, message = check_openmc_dependencies()
    print(json.dumps({"available": available, "message": message}))
    return 0 if available else 1


def cmd_list_group_structures(args):
    """List available group structures."""
    try:
        structures, metadata = load_group_structures()
        result = []
        for name, boundaries in structures.items():
            result.append({
                "name": name,
                "groups": len(boundaries) - 1,
                "range_eV": [float(boundaries[-1]), float(boundaries[0])]
            })
        
        result = sorted(result, key=lambda x: x['groups'])
        print(json.dumps({"structures": result, "metadata": metadata}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_list_thermal_materials(args):
    """List available thermal scattering materials from cross_sections.xml."""
    try:
        import openmc.data
        
        cross_sections_path = args.cross_sections
        
        # Try to load cross_sections library
        try:
            if cross_sections_path:
                library = openmc.data.DataLibrary.from_xml(cross_sections_path)
            else:
                library = openmc.data.DataLibrary.from_xml()
        except Exception as e:
            print(json.dumps({"error": f"Could not load cross_sections.xml: {e}", "materials": []}))
            return 1
        
        # Get thermal scattering materials
        materials = []
        for entry in library.libraries:
            if entry.get('type') == 'thermal':
                materials.append(entry.get('material', ''))
        
        # Remove duplicates and sort
        materials = sorted(set(m for m in materials if m))
        
        print(json.dumps({"materials": materials}))
        return 0
    except ImportError:
        print(json.dumps({"error": "OpenMC not installed", "materials": []}))
        return 1
    except Exception as e:
        print(json.dumps({"error": str(e), "materials": []}))
        return 1


def cmd_depletion_summary(args):
    """Get summary of depletion results."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        summary = reader.load_summary(args.file)
        print(json.dumps(summary))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_depletion_materials(args):
    """List materials in depletion results."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        materials = reader.list_materials(args.file)
        print(json.dumps({"materials": materials}))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_depletion_data(args):
    """Get depletion data for a specific material."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        
        nuclide_filter = None
        if args.nuclides:
            nuclide_filter = [n.strip() for n in args.nuclides.split(',')]
        
        data = reader.load_material_data(args.file, args.material_index, nuclide_filter)
        summary = reader.load_summary(args.file)
        
        print(json.dumps({"summary": summary, "materialData": data}))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_geometry(args):
    """Get geometry hierarchy from OpenMC geometry file."""
    try:
        from openmc_geometry_parser import parse_geometry
        result = parse_geometry(args.file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_visualize_geometry(args):
    """Visualize OpenMC geometry in 3D."""
    try:
        from openmc_geometry_viz import visualize_geometry
        
        highlight_ids = None
        if args.highlight:
            # Handle both single int and comma-separated string
            if isinstance(args.highlight, str):
                highlight_ids = [int(x.strip()) for x in args.highlight.split(',')]
            else:
                highlight_ids = [int(args.highlight)]
                
        return visualize_geometry(args.file, args.port, highlight_ids, args.overlaps)
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_xs_plot(args):
    """Generate cross-section plot data using openmc.data."""
    try:
        import openmc
        import openmc.data
    except ImportError as e:
        print(json.dumps({"error": f"OpenMC not installed: {e}"}))
        return 1

    # Collect warnings to show to user
    warnings = []

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
        
        # Handle chain decay/buildup mode
        chain_decay = None
        if args.chain_decay:
            try:
                chain_decay = json.loads(args.chain_decay)
            except json.JSONDecodeError as e:
                print(f"Warning: Failed to parse chain decay request: {e}", file=sys.stderr)
        
        # Handle group structure for multigroup XS
        group_structure = args.group_structure if args.group_structure else 'continuous'
        
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
                    # Resonance integral = integral sigma(E) dE/E from E1 to E2
                    # For log-energy grid: integral sigma(E) d(ln E) = integral sigma(E)/E dE
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
                    # langlesigma angles = integral sigma(E) phi(E) dE / integral phi(E) dE where phi(E) = E exp(-E/kT)
                    kT = 0.0253  # eV at room temperature
                    # Only use thermal region
                    maxwell_mask = energy <= 1.0  # Up to 1 eV
                    if np.any(maxwell_mask):
                        me_energy = energy[maxwell_mask]
                        me_xs = xs[maxwell_mask]
                        # Maxwellian flux spectrum: phi(E) propto E exp(-E/kT)
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
                    
                    # 5. Integrated XS (barns*eV)
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
        
        def calculate_chain_decay(curve, parent_nuclide, decay_time, include_daughters, max_depth, xs_dir):
            """Calculate chain decay/buildup cumulative cross-sections."""
            chain_data = {
                "parentNuclide": parent_nuclide,
                "decayTime": decay_time,
                "daughterNuclides": [],
                "branchingRatios": {},
                "cumulativeXS": curve.get("xs", []),
                "contributions": {},
                "halfLives": {}
            }
            
            try:
                energy = np.array(curve.get("energy", []))
                parent_xs = np.array(curve.get("xs", []))
                
                if len(energy) == 0 or len(parent_xs) == 0:
                    return chain_data
                
                # Start with parent contribution (100% at t=0, decay over time)
                # For simplicity, assume parent decays exponentially
                # In reality, would need decay constants from nuclear data
                
                contributions = {parent_nuclide: parent_xs.copy()}
                daughter_nuclides = []
                branching_ratios = {}
                half_lives = {}
                
                # Known decay chains (simplified)
                decay_chains = {
                    'U235': ['Th231', 'Pa231', 'Ac227'],
                    'U238': ['Th234', 'Pa234', 'U234', 'Th230', 'Ra226'],
                    'Pu239': ['U235', 'Np239'],
                    'Pu240': ['U236', 'Np240'],
                    'Pu241': ['Am241', 'U237'],
                    'Th232': ['Ra228', 'Ac228', 'Th228', 'Ra224'],
                }
                
                # Get daughters for this parent
                daughters = decay_chains.get(parent_nuclide, [])
                
                if include_daughters and daughters and decay_time > 0:
                    # Load daughter nuclide data
                    for i, daughter in enumerate(daughters[:max_depth]):
                        try:
                            # Estimate branching ratio (simplified)
                            branch_frac = 1.0 / (i + 2)  # Decreasing contribution
                            branching_ratios[daughter] = branch_frac
                            
                            # Try to load daughter XS data
                            daughter_file = os.path.join(xs_dir, f"{daughter}.h5")
                            if os.path.exists(daughter_file):
                                daughter_data = openmc.data.IncidentNeutron.from_hdf5(daughter_file)
                                
                                # Get total XS (MT=1)
                                if 1 in daughter_data.reactions:
                                    reaction = daughter_data.reactions[1]
                                    if hasattr(reaction, 'xs') and reaction.xs:
                                        # Get first available temperature
                                        temp = list(reaction.xs.keys())[0]
                                        xs_data = reaction.xs[temp]
                                        
                                        if hasattr(xs_data, 'x') and hasattr(xs_data, 'y'):
                                            # Interpolate to parent energy grid
                                            daughter_xs = np.interp(
                                                energy, xs_data.x, xs_data.y,
                                                left=0, right=0
                                            )
                                            
                                            # Apply buildup factor (simplified Bateman eq)
                                            # For decay time t, fraction = 1 - exp(-lambda*t)
                                            # Using placeholder lambda = 1e-7 s^-1 (approx for many isotopes)
                                            decay_const = 1e-7 * (i + 1)  # Different for each daughter
                                            buildup = 1.0 - np.exp(-decay_const * decay_time)
                                            
                                            contributions[daughter] = daughter_xs * branch_frac * buildup
                                            daughter_nuclides.append(daughter)
                                            half_lives[daughter] = np.log(2) / decay_const
                                            
                        except Exception as e:
                            print(f"[XS Plot] Could not load daughter {daughter}: {e}", file=sys.stderr)
                            continue
                
                # Calculate cumulative XS
                cumulative = np.zeros_like(parent_xs)
                for nuc, xs in contributions.items():
                    cumulative += xs
                
                cumulative_list = cumulative.tolist()
                chain_data = {
                    "parentNuclide": parent_nuclide,
                    "decayTime": decay_time,
                    "daughterNuclides": daughter_nuclides,
                    "branchingRatios": branching_ratios,
                    "cumulativeXS": cumulative_list,
                    "contributions": {k: v.tolist() for k, v in contributions.items()},
                    "halfLives": half_lives
                }
                
                # Calculate derivative for cumulative XS if derivative calculation is enabled
                if include_derivative:
                    print(f"[XS Plot] Calculating derivative for chain decay cumulative XS", file=sys.stderr)
                    # Create a temporary curve-like dict for derivative calculation
                    temp_curve = {
                        "energy": curve.get("energy", []),
                        "xs": cumulative_list
                    }
                    chain_data["derivative"] = calculate_derivative(temp_curve)
                
                print(f"[XS Plot] Chain decay calculated: {parent_nuclide} -> {daughter_nuclides}", file=sys.stderr)
                
            except Exception as e:
                print(f"[XS Plot] Error calculating chain decay: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            
            return chain_data
        
        def calculate_multigroup_xs(curve, group_structure):
            """Calculate multigroup cross-sections by collapsing continuous data."""
            # Load group structure definitions from YAML file (or fallback to built-in)
            group_boundaries, _ = load_group_structures()
            
            mg_data = {
                "groupStructure": group_structure,
                "numGroups": 0,
                "groupBoundaries": [],
                "groupEnergies": [],
                "groupWidths": [],
                "groupXS": [],
                "weightingMethod": "flux"
            }
            
            try:
                if group_structure not in group_boundaries:
                    print(f"[XS Plot] Unknown group structure: {group_structure}", file=sys.stderr)
                    return mg_data
                
                boundaries = np.array(group_boundaries[group_structure])
                num_groups = len(boundaries) - 1
                
                energy = np.array(curve.get("energy", []))
                xs = np.array(curve.get("xs", []))
                
                if len(energy) == 0 or len(xs) == 0:
                    return mg_data
                
                # Ensure energy is sorted
                sort_idx = np.argsort(energy)
                energy = energy[sort_idx]
                xs = xs[sort_idx]
                
                # Calculate group averages
                group_xs = []
                group_energies = []
                group_widths = []
                
                for g in range(num_groups):
                    e_high = boundaries[g]
                    e_low = boundaries[g + 1]
                    group_widths.append(e_high - e_low)
                    group_energies.append(np.sqrt(e_high * e_low))  # Log-average energy
                    
                    # Find points within this energy group
                    mask = (energy >= e_low) & (energy <= e_high)
                    
                    if np.any(mask):
                        e_group = energy[mask]
                        xs_group = xs[mask]
                        
                        # Flux-weighted average (using 1/E weighting as default)
                        # This approximates typical reactor spectrum
                        flux_weight = 1.0 / e_group  # 1/E spectrum
                        
                        # Group average: integral(phi(E) * sigma(E))dE / integral phi(E)dE
                        numerator = _np_trapz(xs_group * flux_weight, e_group)
                        denominator = _np_trapz(flux_weight, e_group)
                        
                        if denominator > 0:
                            group_avg = numerator / denominator
                        else:
                            group_avg = np.mean(xs_group) if len(xs_group) > 0 else 0.0
                    else:
                        # No data in this group - interpolate
                        if len(energy) > 0:
                            e_mid = np.sqrt(e_high * e_low)
                            group_avg = np.interp(e_mid, energy, xs, left=xs[0], right=xs[-1])
                        else:
                            group_avg = 0.0
                    
                    group_xs.append(float(group_avg))
                
                mg_data = {
                    "groupStructure": group_structure,
                    "numGroups": num_groups,
                    "groupBoundaries": boundaries.tolist(),
                    "groupEnergies": group_energies,
                    "groupWidths": group_widths,
                    "groupXS": group_xs,
                    "weightingMethod": "flux"
                }
                
                print(f"[XS Plot] Multigroup XS calculated: {num_groups} groups for {curve.get('nuclide', 'unknown')}", file=sys.stderr)
                
            except Exception as e:
                print(f"[XS Plot] Error calculating multigroup XS: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            
            return mg_data
        
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
            
            # Convert barns (1e-24 cm^2) to cm^2, then multiply by atomic density
            # atomic density = density * avogadro / atomic_weight
            atomic_weight = nuc_data.atomic_weight if hasattr(nuc_data, 'atomic_weight') else 1.0
            avogadro = 6.02214076e23
            atomic_density = density * avogadro / atomic_weight  # atoms/cm^3
            
            # Macroscopic XS = N * sigma (in 1/cm)
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
                        warning_msg = f"Reaction MT={lib_reaction} ({mt_names.get(lib_reaction, 'unknown')}) not available for {lib_nuclide} in library '{lib_name}'"
                        print(f"Warning: {warning_msg}", file=sys.stderr)
                        warnings.append(warning_msg)
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
                        "label": f"{mat_name} Sigma{reaction_name} (macroscopic)",
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
                                warning_msg = f"Reaction MT={reaction_mt} ({mt_names.get(reaction_mt, 'unknown')}) not available for {nuclide_name}"
                                print(f"Warning: {warning_msg}", file=sys.stderr)
                                warnings.append(warning_msg)
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
        
        # Calculate chain decay/buildup if requested
        if chain_decay and curves:
            print(f"[XS Plot] Calculating chain decay for {len(curves)} curves", file=sys.stderr)
            parent_nuclide = chain_decay.get('parentNuclide', '')
            decay_time = chain_decay.get('decayTime', 0)
            include_daughters = chain_decay.get('includeDaughters', True)
            max_depth = chain_decay.get('maxDepth', 3)
            
            for curve in curves:
                if curve.get("nuclide") == parent_nuclide:
                    curve["chainDecay"] = calculate_chain_decay(
                        curve, parent_nuclide, decay_time, 
                        include_daughters, max_depth, xs_dir
                    )
        
        # Calculate multigroup cross-sections if requested
        if group_structure != 'continuous' and curves:
            print(f"[XS Plot] Calculating multigroup XS for {group_structure}", file=sys.stderr)
            for curve in curves:
                curve["multigroup"] = calculate_multigroup_xs(curve, group_structure)
        
        if not curves:
            error_msg = "No valid cross-section data found."
            if cross_sections_path:
                error_msg += f" Could not load from: {cross_sections_path}"
            else:
                error_msg += " Set the cross-section path in Preferences -> Nuke Visualizer, or set OPENMC_CROSS_SECTIONS environment variable."
            print(json.dumps({"error": error_msg}))
            return 1
        
        result = {
            "curves": curves,
            "temperature": temperature if not temp_comparison else None
        }
        
        if warnings:
            result["warnings"] = warnings
        
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


def cmd_materials(args):
    """Parse and return materials from materials.xml file."""
    try:
        from openmc_materials_parser import parse_materials_file
        result = parse_materials_file(args.file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_material_cell_linkage(args):
    """Get mapping of materials to cells that use them."""
    try:
        from openmc_materials_parser import get_material_cell_linkage
        result = get_material_cell_linkage(args.materials_file, args.geometry_file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_check_overlaps(args):
    """Check for geometry overlaps."""
    try:
        from overlap_integration import check_overlaps
        
        # Parse bounding box if provided
        bounds = None
        if args.bounds:
            try:
                bounds = json.loads(args.bounds)
            except json.JSONDecodeError as e:
                print(json.dumps({"error": f"Invalid bounds JSON: {e}"}))
                return 1
        
        result = check_overlaps(
            geometry_path=args.geometry,
            sample_points=args.samples,
            tolerance=args.tolerance,
            bounds=bounds,
            parallel=args.parallel
        )
        print(json.dumps(result))
        return 0 if result.get('error') is None else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"overlaps": [], "totalOverlaps": 0, "error": str(e)}))
        return 1


def cmd_overlap_viz(args):
    """Get visualization data for overlaps."""
    try:
        from overlap_integration import get_overlap_viz_data
        
        # Parse overlaps JSON
        try:
            overlaps = json.loads(args.overlaps)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid overlaps JSON: {e}"}))
            return 1
        
        result = get_overlap_viz_data(
            geometry_path=args.geometry,
            overlaps=overlaps,
            marker_size=args.marker_size
        )
        print(json.dumps(result))
        return 0 if result.get('error') is None else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"markers": [], "overlappingCellIds": [], "error": str(e)}))
        return 1


def main():
    parser = argparse.ArgumentParser(description='OpenMC visualization server for NukeIDE')
    subparsers = parser.add_subparsers(dest='command')
    
    # Info command
    info_parser = subparsers.add_parser('info', help='Get statepoint info')
    info_parser.add_argument('statepoint', help='Path to statepoint file')
    
    # List command
    list_parser = subparsers.add_parser('list', help='List tallies in statepoint')
    list_parser.add_argument('statepoint', help='Path to statepoint file')
    
    # Visualize mesh command
    mesh_parser = subparsers.add_parser('visualize-mesh', help='Visualize mesh tally')
    mesh_parser.add_argument('statepoint', help='Path to statepoint file')
    mesh_parser.add_argument('tally_id', type=int, help='Tally ID to visualize')
    mesh_parser.add_argument('--score-index', help='Score index or name')
    mesh_parser.add_argument('--nuclide-index', help='Nuclide index or name')
    mesh_parser.add_argument('--colormap', help='Color map name')
    mesh_parser.add_argument('--port', type=int, help='Server port')
    
    # Visualize source command
    source_parser = subparsers.add_parser('visualize-source', help='Visualize source distribution')
    source_parser.add_argument('source', help='Path to source.h5 file')
    source_parser.add_argument('--port', type=int, help='Server port')
    
    # Visualize overlay command
    overlay_parser = subparsers.add_parser('visualize-overlay', help='Overlay tally on geometry')
    overlay_parser.add_argument('geometry', help='Path to geometry.xml')
    overlay_parser.add_argument('statepoint', help='Path to statepoint file')
    overlay_parser.add_argument('tally_id', type=int, help='Tally ID')
    overlay_parser.add_argument('--score', help='Score name')
    overlay_parser.add_argument('--colormap', help='Color map name')
    overlay_parser.add_argument('--no-graveyard-filter', action='store_true',
                                help='Disable graveyard surface filtering (show full geometry including graveyard cube)')
    overlay_parser.add_argument('--port', type=int, help='Server port')
    
    # Spectrum command
    spectrum_parser = subparsers.add_parser('spectrum', help='Get energy spectrum data')
    spectrum_parser.add_argument('statepoint', help='Path to statepoint file')
    spectrum_parser.add_argument('tally_id', type=int, help='Tally ID')
    spectrum_parser.add_argument('--score-index', help='Score index')
    spectrum_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Spatial command
    spatial_parser = subparsers.add_parser('spatial', help='Get spatial plot data')
    spatial_parser.add_argument('statepoint', help='Path to statepoint file')
    spatial_parser.add_argument('tally_id', type=int, help='Tally ID')
    spatial_parser.add_argument('axis', choices=['x', 'y', 'z'], help='Axis for spatial plot')
    spatial_parser.add_argument('--score-index', help='Score index')
    spatial_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Heatmap command
    heatmap_parser = subparsers.add_parser('heatmap', help='Get 2D heatmap slice data')
    heatmap_parser.add_argument('statepoint', help='Path to statepoint file')
    heatmap_parser.add_argument('tally_id', type=int, help='Tally ID')
    heatmap_parser.add_argument('plane', choices=['xy', 'xz', 'yz'], help='Plane for slice')
    heatmap_parser.add_argument('slice_index', type=int, help='Slice index')
    heatmap_parser.add_argument('--score-index', help='Score index')
    heatmap_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Heatmap all command
    heatmap_all_parser = subparsers.add_parser('heatmap-all', help='Get all 2D heatmap slices')
    heatmap_all_parser.add_argument('statepoint', help='Path to statepoint file')
    heatmap_all_parser.add_argument('tally_id', type=int, help='Tally ID')
    heatmap_all_parser.add_argument('plane', choices=['xy', 'xz', 'yz'], help='Plane for slices')
    heatmap_all_parser.add_argument('--score-index', help='Score index')
    heatmap_all_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Check command
    check_parser = subparsers.add_parser('check', help='Check if OpenMC integration is available')
    
    # List group structures command
    list_groups_parser = subparsers.add_parser('list-group-structures', help='List available group structures')
    
    # List thermal materials command
    list_thermal_parser = subparsers.add_parser('list-thermal-materials', help='List available thermal scattering materials')
    list_thermal_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
    # Depletion commands
    depletion_summary_parser = subparsers.add_parser('depletion-summary', help='Get depletion summary')
    depletion_summary_parser.add_argument('file', help='Path to depletion_results.h5')
    
    depletion_materials_parser = subparsers.add_parser('depletion-materials', help='List materials in depletion results')
    depletion_materials_parser.add_argument('file', help='Path to depletion_results.h5')
    
    depletion_data_parser = subparsers.add_parser('depletion-data', help='Get depletion data for material')
    depletion_data_parser.add_argument('file', help='Path to depletion_results.h5')
    depletion_data_parser.add_argument('material_index', type=int, help='Material index')
    depletion_data_parser.add_argument('--nuclides', help='Comma-separated nuclide list')
    
    # Geometry commands
    geometry_parser = subparsers.add_parser('geometry', help='Get geometry hierarchy')
    geometry_parser.add_argument('file', help='Path to geometry.xml')
    
    visualize_geometry_parser = subparsers.add_parser('visualize-geometry', help='Visualize OpenMC geometry')
    visualize_geometry_parser.add_argument('file', help='Path to geometry.xml')
    visualize_geometry_parser.add_argument('--port', type=int, help='Server port')
    visualize_geometry_parser.add_argument('--highlight', help='Cell ID(s) to highlight (comma-separated)')
    visualize_geometry_parser.add_argument('--overlaps', help='Path to JSON file with overlap markers')
    
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
    xs_parser.add_argument('--chain-decay', help='JSON string of chain decay/buildup request')
    xs_parser.add_argument('--group-structure', help='Energy group structure name (e.g., 8-group, CASMO-8, or any custom name in group_structures.yaml)')
    
    # List Nuclides command
    nuclides_parser = subparsers.add_parser('list-nuclides', help='List available nuclides')
    nuclides_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
    # Materials command
    materials_parser = subparsers.add_parser('materials', help='Parse materials.xml file')
    materials_parser.add_argument('file', help='Path to materials.xml')
    
    # Material-cell linkage command
    linkage_parser = subparsers.add_parser('material-cell-linkage', help='Get material-cell mapping')
    linkage_parser.add_argument('materials_file', help='Path to materials.xml')
    linkage_parser.add_argument('geometry_file', help='Path to geometry.xml')
    
    # Overlap checker commands
    overlaps_parser = subparsers.add_parser('check-overlaps', help='Check for geometry overlaps')
    overlaps_parser.add_argument('geometry', help='Path to geometry.xml or Python model')
    overlaps_parser.add_argument('--samples', type=int, default=100000, help='Number of sample points')
    overlaps_parser.add_argument('--tolerance', type=float, default=1e-6, help='Numerical tolerance')
    overlaps_parser.add_argument('--bounds', help='Bounding box as JSON {"min": [x,y,z], "max": [x,y,z]}')
    overlaps_parser.add_argument('--parallel', action='store_true', help='Use parallel processing')
    
    overlap_viz_parser = subparsers.add_parser('overlap-viz', help='Get overlap visualization data')
    overlap_viz_parser.add_argument('geometry', help='Path to geometry.xml')
    overlap_viz_parser.add_argument('--overlaps', required=True, help='Overlaps JSON array')
    overlap_viz_parser.add_argument('--marker-size', type=float, default=1.0, help='Marker size in cm')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    # Route to appropriate command handler
    commands = {
        'info': cmd_info,
        'list': cmd_list,
        'visualize-mesh': cmd_visualize_mesh,
        'visualize-source': cmd_visualize_source,
        'visualize-overlay': cmd_visualize_overlay,
        'spectrum': cmd_spectrum,
        'spatial': cmd_spatial,
        'heatmap': cmd_heatmap,
        'heatmap-all': cmd_heatmap_all,
        'check': cmd_check,
        'list-group-structures': cmd_list_group_structures,
        'list-thermal-materials': cmd_list_thermal_materials,
        'depletion-summary': cmd_depletion_summary,
        'depletion-materials': cmd_depletion_materials,
        'depletion-data': cmd_depletion_data,
        'geometry': cmd_geometry,
        'visualize-geometry': cmd_visualize_geometry,
        'xs-plot': cmd_xs_plot,
        'list-nuclides': cmd_list_nuclides,
        'materials': cmd_materials,
        'material-cell-linkage': cmd_material_cell_linkage,
        'check-overlaps': cmd_check_overlaps,
        'overlap-viz': cmd_overlap_viz,
    }
    
    handler = commands.get(args.command)
    if handler:
        return handler(args)
    else:
        print(f"Unknown command: {args.command}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
