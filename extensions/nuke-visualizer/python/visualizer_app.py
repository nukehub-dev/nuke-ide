#!/usr/bin/env python3
"""
Visualizer visualization server for NukeIDE.
Enhanced with interactive control panel for opacity, color maps, clipping, etc.
"""

import sys
import os
import argparse
from pathlib import Path

# Force headless/offscreen rendering BEFORE importing vtk or paraview
os.environ['DISPLAY'] = ''
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VTK_USE_OFFSCREEN'] = '1'

# Import common utilities
from visualizer_common import (
    find_free_port, check_trame_dependencies, COLOR_MAPS,
    init_common_state, VisualizerState, UIComponents, StateHandlers,
    create_update_view, create_reset_camera_controller,
    create_set_camera_view_controller, 
    create_pan_camera_controller, create_zoom_camera_controller,
    create_capture_screenshot_controller,
    save_screenshot_with_timestamp, hex_to_rgb, get_available_arrays,
    GLOBAL_STYLES
)


def create_app(file_path=None, port=None, theme='dark'):
    """Create trame application with interactive control panel."""
    
    # Import trame modules
    try:
        from trame.app import get_server
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify2 as vuetify
        from trame.widgets import html
        from trame.ui.vuetify2 import VAppLayout
        from paraview import simple
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}")
        sys.exit(1)
    
    server = get_server(client_type="vue2")
    state = server.state
    
    # Initialize common state
    init_common_state(state, theme=theme)
    
    # Store non-serializable VTK objects in pipeline dict
    pipeline = {'source': None, 'display': None, 'view': None, 
                'clip_filter': None, 'original_source': None, 'view_widget': None}
    
    # ParaView pipeline setup
    reader = None
    title = "Default View"
    
    if file_path and os.path.exists(file_path):
        file_ext = Path(file_path).suffix.lower()
        title = Path(file_path).name
        print(f"Loading file: {file_path} (type: {file_ext})")
        
        try:
            if file_ext in ['.vtk', '.vtu', '.vtp', '.vts', '.vtr', '.pvtu', '.pvtp']:
                reader = simple.OpenDataFile(file_path)
            elif file_ext == '.stl':
                reader = simple.STLReader(FileNames=[file_path])
            elif file_ext == '.ply':
                reader = simple.PLYReader(FileNames=[file_path])
            elif file_ext == '.obj':
                reader = simple.OBJReader(FileName=file_path)
            else:
                reader = simple.OpenDataFile(file_path)
            print(f"Loaded file: {file_path}")
        except Exception as e:
            print(f"Warning: Could not load file {file_path}: {e}")
    
    # Create default visualization if no file
    if reader is None:
        print("Creating default sphere visualization")
        reader = simple.Sphere()
        reader.ThetaResolution = 32
        reader.PhiResolution = 32
    
    pipeline['source'] = reader
    pipeline['original_source'] = reader
    
    # Get available data arrays
    state.available_arrays = get_available_arrays(reader)
    print(f"Available arrays: {state.available_arrays}")
    
    # Check for timesteps
    try:
        if hasattr(reader, 'TimestepValues') and reader.TimestepValues:
            timesteps = list(reader.TimestepValues)
            if len(timesteps) > 1:
                state.timestep_values = timesteps
                state.has_timesteps = True
                state.current_timestep = 0
                print(f"Detected {len(timesteps)} timesteps")
    except Exception as e:
        print(f"Could not detect timesteps: {e}")
    
    # Create visualization pipeline
    display = simple.Show(reader)
    view = simple.GetActiveViewOrCreate('RenderView')
    
    # Set initial background color
    initial_bg = hex_to_rgb(state.background_color_hex)
    print(f"Setting initial background color: {initial_bg}")
    view.Background = initial_bg if initial_bg else [0.1, 0.1, 0.15]
    
    pipeline['display'] = display
    pipeline['view'] = view
    
    display.Representation = state.representation
    display.Opacity = state.opacity
    
    simple.Render(view)
    simple.ResetCamera()
    
    # Create update view function
    update_view = create_update_view(pipeline, state, simple)
    
    # Define state change handlers using common handlers
    @state.change("opacity")
    def on_opacity_change(opacity, **kwargs):
        StateHandlers.create_opacity_handler(pipeline)(opacity, **kwargs)
        update_view()
    
    @state.change("representation")
    def on_representation_change(representation, **kwargs):
        StateHandlers.create_representation_handler(pipeline, state)(representation, **kwargs)
        update_view()
    
    @state.change("color_by")
    def on_color_by_change(color_by, **kwargs):
        StateHandlers.create_color_by_handler(pipeline, state, simple)(color_by, **kwargs)
        update_view()
    
    @state.change("color_map")
    def on_color_map_change(color_map, **kwargs):
        StateHandlers.create_color_map_handler(pipeline, state, simple)(color_map, **kwargs)
        update_view()
    
    @state.change("show_scalar_bar")
    def on_scalar_bar_change(show_scalar_bar, **kwargs):
        StateHandlers.create_scalar_bar_handler(pipeline, state, simple)(show_scalar_bar, **kwargs)
        update_view()
    
    @state.change("background_color_hex")
    def on_background_color_hex_change(background_color_hex, **kwargs):
        StateHandlers.create_background_handler(pipeline, state)(background_color_hex, **kwargs)
        update_view()
    
    @state.change("show_orientation_axes")
    def on_show_orientation_axes_change(show_orientation_axes, **kwargs):
        StateHandlers.create_orientation_axes_handler(pipeline)(show_orientation_axes, **kwargs)
        update_view()
    
    @state.change("show_bounding_box")
    def on_show_bounding_box_change(show_bounding_box, **kwargs):
        try:
            view = pipeline.get('view')
            display = pipeline.get('display')
            if view:
                if hasattr(view, 'CenterAxesVisibility'):
                    view.CenterAxesVisibility = bool(show_bounding_box)
                if display and hasattr(display, 'UseOutline'):
                    display.UseOutline = bool(show_bounding_box)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating bounding box: {e}")
    
    @state.change("show_cube_axes")
    def on_show_cube_axes_change(show_cube_axes, **kwargs):
        try:
            view = pipeline.get('view')
            if view:
                if hasattr(view, 'CubeAxesVisibility'):
                    view.CubeAxesVisibility = bool(show_cube_axes)
                elif hasattr(view, 'AxesGrid'):
                    view.AxesGrid.Visibility = bool(show_cube_axes)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating cube axes: {e}")
    
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
        update_view(push_camera=True)
    
    @state.change("current_timestep")
    def on_timestep_change(current_timestep, **kwargs):
        try:
            source = pipeline.get('source')
            if source and state.has_timesteps and hasattr(source, 'TimestepValues'):
                timesteps = source.TimestepValues
                if timesteps and 0 <= current_timestep < len(timesteps):
                    view = pipeline.get('view')
                    if view:
                        view.ViewTime = timesteps[current_timestep]
                        update_view()
        except Exception as e:
            print(f"Error updating timestep: {e}")
    
    @state.change("clip_enabled", "clip_origin_x", "clip_origin_y", "clip_origin_z",
                  "clip_normal_x", "clip_normal_y", "clip_normal_z", "clip_invert")
    def on_clip_change(clip_enabled, clip_origin_x, clip_origin_y, clip_origin_z,
                       clip_normal_x, clip_normal_y, clip_normal_z, clip_invert, **kwargs):
        try:
            original_source = pipeline.get('original_source')
            if not original_source:
                return
            
            # Remove existing clip
            existing_clip = pipeline.get('clip_filter')
            if existing_clip:
                simple.Delete(existing_clip)
                pipeline['clip_filter'] = None
            
            if clip_enabled:
                clip = simple.Clip(Input=original_source)
                clip.ClipType = 'Plane'
                clip.ClipType.Origin = [float(clip_origin_x), float(clip_origin_y), float(clip_origin_z)]
                clip.ClipType.Normal = [float(clip_normal_x), float(clip_normal_y), float(clip_normal_z)]
                clip.Invert = bool(clip_invert)
                
                pipeline['clip_filter'] = clip
                pipeline['source'] = clip
                
                display = simple.Show(clip)
                simple.Hide(original_source)
                display.Representation = state.representation
                display.Opacity = state.opacity
                pipeline['display'] = display
            else:
                simple.Show(original_source)
                pipeline['source'] = original_source
                pipeline['display'] = simple.GetDisplayProperties(original_source)
            
            update_view()
        except Exception as e:
            print(f"Error updating clip: {e}")
    
    # Controller functions
    reset_camera = create_reset_camera_controller(pipeline, update_view)
    set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
    pan_camera = create_pan_camera_controller(pipeline, update_view)
    zoom_camera = create_zoom_camera_controller(pipeline, update_view)
    capture_screenshot = create_capture_screenshot_controller(pipeline)
    
    @server.controller.add("toggle_controls")
    def toggle_controls():
        state.show_controls = not state.show_controls
        return state.show_controls
    
    # UI setup
    with VAppLayout(server) as layout:
        # Custom CSS for better UI aesthetics
        html.Style(GLOBAL_STYLES)
        
        with vuetify.VNavigationDrawer(
            v_model=("show_controls", True),
            app=True, width=320, clipped=True,
            color=("sidebar_color", "#1e1e1e"),
            dark=("sidebar_dark", True)
        ):
            with vuetify.VContainer(classes="pa-4"):
                # Header with Hide Button
                with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                    vuetify.VSubheader("Display Controls", classes="text-h6 pa-0")
                    with vuetify.VBtn(click=toggle_controls, small=True, icon=True):
                        vuetify.VIcon("mdi-chevron-left")
                vuetify.VDivider(classes="mb-4")
                
                # Opacity Slider
                UIComponents.opacity_slider(vuetify)
                
                # Representation Selector
                UIComponents.representation_selector(vuetify)
                
                # Color By Selector
                UIComponents.color_by_selector(vuetify)
                
                # Color Map Selector (only shown when coloring by array)
                with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                    UIComponents.color_map_selector(vuetify, COLOR_MAPS)
                    
                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", False),
                        label="Show Color Legend",
                        dense=True, classes="mb-4"
                    )
                
                vuetify.VDivider(classes="my-4")
                
                # Clipping Section
                vuetify.VSubheader("Clipping", classes="text-subtitle-1 mb-2")
                
                vuetify.VCheckbox(
                    v_model=("clip_enabled", False),
                    label="Enable Clip Plane",
                    dense=True, classes="mb-2"
                )
                
                with vuetify.VContainer(v_if=("clip_enabled",), classes="pl-4"):
                    vuetify.VSubheader("Origin", classes="text-caption pa-0")
                    with vuetify.VRow(dense=True):
                        for axis in ['x', 'y', 'z']:
                            with vuetify.VCol(cols=4):
                                vuetify.VTextField(
                                    v_model=(f"clip_origin_{axis}", 0.0),
                                    label=axis.upper(), type="number",
                                    dense=True, outlined=True
                                )
                    
                    vuetify.VSubheader("Normal", classes="text-caption pa-0 mt-2")
                    with vuetify.VRow(dense=True):
                        for axis, default in [('x', 1.0), ('y', 0.0), ('z', 0.0)]:
                            with vuetify.VCol(cols=4):
                                vuetify.VTextField(
                                    v_model=(f"clip_normal_{axis}", default),
                                    label=axis.upper(), type="number",
                                    dense=True, outlined=True
                                )
                    
                    vuetify.VCheckbox(
                        v_model=("clip_invert", False),
                        label="Invert Clip",
                        dense=True, classes="mt-2"
                    )
                
                vuetify.VDivider(classes="my-4")
                
                # Compact toggles in a grid
                UIComponents.compact_appearance_controls(vuetify)
                                
                # Detail sliders
                UIComponents.point_size_slider(vuetify)
                UIComponents.line_width_slider(vuetify)
                UIComponents.ambient_light_slider(vuetify)
                
                vuetify.VDivider(classes="my-4")
                
                # Time Navigation Section
                with vuetify.VContainer(v_if=("has_timesteps",)):
                    vuetify.VSubheader("Time Navigation", classes="text-subtitle-1 mb-2")
                    
                    with vuetify.VRow(dense=True, align="center"):
                        for btn, action in [
                            ("|<<", lambda: setattr(state, 'current_timestep', 0)),
                            ("<", lambda: setattr(state, 'current_timestep', max(0, state.current_timestep - 1))),
                            (">", lambda: setattr(state, 'current_timestep', min(len(state.timestep_values) - 1, state.current_timestep + 1))),
                            (">>|", lambda: setattr(state, 'current_timestep', len(state.timestep_values) - 1))
                        ]:
                            with vuetify.VCol(cols=3):
                                vuetify.VBtn(btn, click=action, small=True, text=True)
                    
                    vuetify.VSlider(
                        v_model=("current_timestep", 0),
                        min=0, max=("len(timestep_values) - 1",), step=1,
                        thumb_label=True, dense=True, classes="mt-2"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                
                # Screenshot Section
                def save_screenshot():
                    save_screenshot_with_timestamp(capture_screenshot, state)
                
                vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                vuetify.VBtn("Save Screenshot", click=save_screenshot,
                             block=True, small=True, color="primary", classes="mb-2")
                
                with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                    vuetify.VSubheader(("screenshot_status",), classes="text-caption justify-center")
        
        # Main content area
        with vuetify.VMain():
            # Toggle button when controls are hidden
            with vuetify.VContainer(
                v_if=("!show_controls",),
                classes="ma-2 pa-0",
                style="position: absolute; top: 0; left: 0; z-index: 100;"
            ):
                with vuetify.VBtn(click=toggle_controls, small=True, fab=True, color="primary"):
                    vuetify.VIcon("mdi-chevron-right")
            
            # Camera Navigation Gadget (Top Right)
            UIComponents.create_canvas_gadget(vuetify, pan_camera, zoom_camera, reset_callback=reset_camera, view_callback=set_camera_view)
            
            # Main visualization view
            view_widget = pv_widgets.VtkRemoteView(
                view, interactive_ratio=1,
                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;"
            )
            pipeline['view_widget'] = view_widget
            
            @server.controller.add("view_update")
            def view_update():
                view_widget.update()
            
            @state.change("camera_update_counter")
            def on_camera_update(camera_update_counter, **kwargs):
                try:
                    simple.Render(view)
                    view_widget.update()
                except Exception as e:
                    print(f"Warning: camera update failed: {e}")
            
            @state.change("appearance_update")
            def on_appearance_update(appearance_update, **kwargs):
                try:
                    simple.Render(view)
                    view_widget.update()
                except Exception as e:
                    print(f"Warning: appearance update failed: {e}")
    
    return server, port


def main():
    parser = argparse.ArgumentParser(description='Visualizer visualization server for NukeIDE')
    parser.add_argument('--port', type=int, default=None, help='Port to run server on')
    parser.add_argument('--file', type=str, help='File to load')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Host to report in URL')
    parser.add_argument('--theme', type=str, default='dark', choices=['dark', 'light'])
    args = parser.parse_args()
    
    print("=" * 60)
    print("NukeIDE Visualizer Server")
    print("=" * 60)
    
    # Check dependencies
    success, errors = check_trame_dependencies()
    if not success:
        print("=" * 60)
        print("ERROR: Missing dependencies")
        print("=" * 60)
        for error in errors:
            print(f"  - {error}")
        print("=" * 60)
        sys.exit(1)
    
    port = args.port or find_free_port()
    
    try:
        server, actual_port = create_app(args.file, port, theme=args.theme)
    except Exception as e:
        print(f"Failed to create application: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    url = f"http://{args.host}:{port}"
    print("=" * 60)
    print(f"Starting visualizer server on {url}")
    print("=" * 60)
    print(f"Press Ctrl+C to stop")
    print("=" * 60)
    
    try:
        server.start(port=port, host='0.0.0.0', open_browser=False, show_connection_info=False)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
