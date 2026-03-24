"""
Tally visualization commands (mesh, source, overlay).
"""

import os
import sys
import json
import tempfile
from paraview import simple
import vtk

# Import common utilities
from visualizer_common import (
    find_free_port, COLOR_MAPS, COLOR_MAPS_SHORT, hex_to_rgb, get_data_bounds,
    calculate_camera_position,
    UIComponents, StateHandlers,
    init_common_state, GLOBAL_STYLES,
    create_reset_camera_controller,
    create_set_camera_view_controller, 
    create_pan_camera_controller, create_zoom_camera_controller,
    create_capture_screenshot_controller,
    save_screenshot_with_timestamp, create_update_view
)

from openmc_integration import OpenMCReader


def cmd_visualize_mesh(args):
    """Visualize a mesh tally."""
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.ui.vuetify2 import VAppLayout
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
            # Output structured warning to stdout for backend to parse
            # Using a prefix pattern that is easy to detect and parse
            warning_obj = {"type": "spatial_warning", "message": spatial_warning}
            print(f"NUKE_IDE_WARNING:{json.dumps(warning_obj)}", flush=True)
            print(f"[Overlay] Spatial warning: {spatial_warning}", file=sys.stderr, flush=True)
        
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
