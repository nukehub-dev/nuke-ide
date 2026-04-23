#!/usr/bin/env python3
"""
DAGMC 3D Visualization for NukeIDE.

Converts DAGMC .h5m files to a multi-block VTK dataset and serves
an interactive Trame viewer with volume, material, and group selection.
"""

import os
import sys
import json
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Any

import vtk

from plugins.base.lib.common import (
    find_free_port, check_trame_dependencies,
    hex_to_rgb, get_data_bounds, calculate_camera_position,
    create_update_view, create_reset_camera_controller,
    create_set_camera_view_controller,
    create_pan_camera_controller, create_zoom_camera_controller,
    UIComponents, init_common_state, StateHandlers,
    create_capture_screenshot_controller, save_screenshot_with_timestamp,
    GLOBAL_STYLES, DISTINCT_COLORS
)
from plugins.base.lib.dagmc import convert_h5m_to_multiblock_vtk, get_dagmc_model_info


def visualize_dagmc(h5m_file: str, port: int = None, theme: str = 'dark',
                    highlight_volumes: Optional[List[int]] = None) -> int:
    """
    Start an interactive visualization server for a DAGMC .h5m file.

    Args:
        h5m_file: Path to the DAGMC .h5m file
        port: Server port (auto-selected if None)
        theme: UI theme ('dark' or 'light')
        highlight_volumes: Optional list of volume IDs to highlight initially

    Returns:
        Exit code (0 for success, 1 for error)
    """
    h5m_path = Path(h5m_file)
    if not h5m_path.exists():
        print(f"Error: File not found: {h5m_file}")
        return 1

    # Check dependencies
    success, errors = check_trame_dependencies()
    if not success:
        print("Error: Missing dependencies")
        for error in errors:
            print(f"  - {error}")
        return 1

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

    # Convert H5M to multi-block VTK with metadata
    print(f"[DAGMC-Viz] Converting {h5m_path.name}...")
    try:
        conversion_result = convert_h5m_to_multiblock_vtk(str(h5m_path), include_graveyard=False)
    except ImportError as e:
        print(f"Error: pydagmc required for DAGMC visualization: {e}")
        return 1
    except Exception as e:
        print(f"Error converting DAGMC file: {e}")
        import traceback
        traceback.print_exc()
        return 1

    vtm_path = conversion_result['vtm_path']
    volume_info = conversion_result['volume_info']
    materials = conversion_result['materials']
    groups = conversion_result['groups']

    if not volume_info:
        print("Error: No volumes found in DAGMC file")
        return 1

    print(f"[DAGMC-Viz] Loaded {len(volume_info)} volumes, {len(materials)} materials, {len(groups)} groups")

    # Prepare selection lists for UI
    material_list = sorted(materials.keys())
    group_list = sorted(groups.keys())

    # Create trame server
    actual_port = port or find_free_port()
    server = get_server(client_type="vue2", port=actual_port)
    state = server.state
    ctrl = server.controller

    # Initialize common state
    init_common_state(state, theme=theme)

    # DAGMC-specific state
    state.dagmc_title = h5m_path.name
    state.volume_info = volume_info
    state.material_list = material_list
    state.group_list = group_list
    state.volume_visibility = {str(v['id']): True for v in volume_info}
    state.selected_volume_ids = highlight_volumes if highlight_volumes else []
    state.selected_materials = []
    state.selected_groups = []
    state.show_all_volumes = True
    state.show_volume_colors = True
    # Pre-format items for Vuetify selectors (expects {text, value} objects)
    state.volume_items = [
        {'text': f"Vol {v['id']} — {v['material']} ({v['numTriangles']} tris)", 'value': v['id']}
        for v in volume_info
    ]
    state.material_items = [
        {'text': f"{m} ({len(materials.get(m, []))} volumes)", 'value': m}
        for m in material_list
    ]
    state.group_items = [
        {'text': f"{g} ({len(groups.get(g, []))} volumes)", 'value': g}
        for g in group_list
    ]

    # Pipeline storage
    pipeline = {
        'reader': None,
        'extract': None,
        'clip_filter': None,
        'original_reader': None,
        'view': None,
        'view_widget': None,
        'volume_displays': {},  # vol_id -> display object
        'color_palette': DISTINCT_COLORS,
    }

    # Load in ParaView
    reader = simple.XMLMultiBlockDataReader(FileName=vtm_path)
    pipeline['reader'] = reader
    pipeline['original_reader'] = reader
    simple.Hide(reader)

    view = simple.GetActiveViewOrCreate('RenderView')
    bg_rgb = hex_to_rgb(state.background_color_hex)
    view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
    view.UseColorPaletteForBackground = 0
    pipeline['view'] = view

    # Create update view function
    update_view = create_update_view(pipeline, state, simple)

    def update_volume_visibility(visibility=None):
        """Update which volumes are visible based on current selection state."""
        try:
            if visibility is None:
                visibility = state.volume_visibility

            # Determine which volumes should be visible
            visible_vol_ids = set()

            # If specific volumes are selected via volume tab
            selected_vol_ids = state.selected_volume_ids
            if selected_vol_ids and len(selected_vol_ids) > 0:
                for vid in selected_vol_ids:
                    visible_vol_ids.add(int(vid))
            else:
                # Check material selection
                selected_mats = state.selected_materials
                if selected_mats and len(selected_mats) > 0:
                    for mat in selected_mats:
                        for vid in materials.get(mat, []):
                            visible_vol_ids.add(vid)
                else:
                    # Check group selection
                    selected_grps = state.selected_groups
                    if selected_grps and len(selected_grps) > 0:
                        for grp in selected_grps:
                            for vid in groups.get(grp, []):
                                visible_vol_ids.add(vid)
                    else:
                        # Nothing specifically selected - show all
                        for v in volume_info:
                            visible_vol_ids.add(v['id'])

            # Clear existing extracts and displays
            existing_extract = pipeline.get('extract')
            if existing_extract:
                simple.Hide(existing_extract, view)
                simple.Delete(existing_extract)
                pipeline['extract'] = None
            pipeline['volume_displays'].clear()

            # Show visible volumes using ExtractBlock
            if visible_vol_ids:
                selectors = []
                for v in volume_info:
                    if v['id'] in visible_vol_ids:
                        selectors.append(v['selector'])

                if selectors:
                    current_reader = pipeline.get('reader')
                    extract = simple.ExtractBlock(Input=current_reader)
                    extract.Selectors = selectors
                    pipeline['extract'] = extract

                    disp = simple.Show(extract, view)
                    disp.Representation = state.representation
                    disp.Opacity = float(state.opacity)
                    disp.PointSize = float(state.point_size)
                    disp.LineWidth = float(state.line_width)
                    disp.Ambient = float(state.ambient_light)

                    # Try to color by volume_id array if available
                    try:
                        disp.ColorArrayName = ['CELLS', 'volume_id']
                        disp.LookupTable = simple.GetColorTransferFunction('volume_id')
                        disp.LookupTable.ApplyPreset('Cool to Warm', True)
                    except Exception:
                        disp.MapScalars = 0
                        disp.DiffuseColor = [0.8, 0.8, 0.8]

                    pipeline['volume_displays']['extract'] = disp

            simple.Render(view)
        except Exception as e:
            print(f"Error updating volume visibility: {e}")
            import traceback
            traceback.print_exc()

    @state.change("volume_visibility")
    def on_volume_visibility_change(volume_visibility, **kwargs):
        update_volume_visibility(volume_visibility)
        update_view()

    @state.change("selected_volume_ids")
    def on_selected_volumes_change(selected_volume_ids, **kwargs):
        # Clear material and group selections when volume selection changes
        if selected_volume_ids and len(selected_volume_ids) > 0:
            state.selected_materials = []
            state.selected_groups = []
        update_volume_visibility()
        update_view(push_camera=True)

    @state.change("selected_materials")
    def on_selected_materials_change(selected_materials, **kwargs):
        # Clear volume and group selections when material selection changes
        if selected_materials and len(selected_materials) > 0:
            state.selected_volume_ids = []
            state.selected_groups = []
        update_volume_visibility()
        update_view(push_camera=True)

    @state.change("selected_groups")
    def on_selected_groups_change(selected_groups, **kwargs):
        # Clear volume and material selections when group selection changes
        if selected_groups and len(selected_groups) > 0:
            state.selected_volume_ids = []
            state.selected_materials = []
        update_volume_visibility()
        update_view(push_camera=True)

    @state.change("opacity")
    def on_opacity_change(opacity, **kwargs):
        for disp in pipeline['volume_displays'].values():
            if disp and hasattr(disp, 'Opacity'):
                disp.Opacity = float(opacity)
        update_view()

    @state.change("representation")
    def on_representation_change(representation, **kwargs):
        for disp in pipeline['volume_displays'].values():
            if disp and hasattr(disp, 'Representation'):
                disp.Representation = representation
        update_view()

    @state.change("background_color_hex")
    def on_background_color_change(background_color_hex, **kwargs):
        rgb = hex_to_rgb(background_color_hex)
        if rgb:
            view.Background = rgb
        update_view()

    @state.change("show_orientation_axes")
    def on_show_orientation_axes_change(show_orientation_axes, **kwargs):
        StateHandlers.create_orientation_axes_handler(pipeline)(show_orientation_axes, **kwargs)
        update_view()

    @state.change("show_bounding_box")
    def on_show_bounding_box_change(show_bounding_box, **kwargs):
        try:
            if view:
                if hasattr(view, 'CenterAxesVisibility'):
                    view.CenterAxesVisibility = bool(show_bounding_box)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating bounding box: {e}")

    @state.change("show_cube_axes")
    def on_show_cube_axes_change(show_cube_axes, **kwargs):
        try:
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
        for disp in pipeline['volume_displays'].values():
            if disp and hasattr(disp, 'PointSize'):
                disp.PointSize = float(point_size)
        update_view()

    @state.change("line_width")
    def on_line_width_change(line_width, **kwargs):
        for disp in pipeline['volume_displays'].values():
            if disp and hasattr(disp, 'LineWidth'):
                disp.LineWidth = float(line_width)
        update_view()

    @state.change("ambient_light")
    def on_ambient_light_change(ambient_light, **kwargs):
        for disp in pipeline['volume_displays'].values():
            if disp and hasattr(disp, 'Ambient'):
                disp.Ambient = float(ambient_light)
        update_view()

    @state.change("parallel_projection")
    def on_parallel_projection_change(parallel_projection, **kwargs):
        StateHandlers.create_parallel_projection_handler(pipeline, state)(parallel_projection, **kwargs)
        update_view(push_camera=True)

    @state.change("clip_enabled", "clip_origin_x", "clip_origin_y", "clip_origin_z",
                  "clip_normal_x", "clip_normal_y", "clip_normal_z", "clip_invert")
    def on_clip_change(clip_enabled, clip_origin_x, clip_origin_y, clip_origin_z,
                       clip_normal_x, clip_normal_y, clip_normal_z, clip_invert, **kwargs):
        try:
            original_reader = pipeline.get('original_reader')
            if not original_reader:
                return

            # Remove existing clip
            existing_clip = pipeline.get('clip_filter')
            if existing_clip:
                simple.Delete(existing_clip)
                pipeline['clip_filter'] = None

            if clip_enabled:
                clip = simple.Clip(Input=original_reader)
                clip.ClipType = 'Plane'
                clip.ClipType.Origin = [float(clip_origin_x), float(clip_origin_y), float(clip_origin_z)]
                clip.ClipType.Normal = [float(clip_normal_x), float(clip_normal_y), float(clip_normal_z)]
                clip.Invert = bool(clip_invert)

                pipeline['clip_filter'] = clip
                pipeline['reader'] = clip
            else:
                pipeline['reader'] = original_reader

            # Re-run visibility update with new reader
            update_volume_visibility()
            update_view()
        except Exception as e:
            print(f"Error updating clip: {e}")

    # Camera controllers
    reset_camera = create_reset_camera_controller(pipeline, update_view)
    set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
    pan_camera = create_pan_camera_controller(pipeline, update_view)
    zoom_camera = create_zoom_camera_controller(pipeline, update_view)
    capture_screenshot = create_capture_screenshot_controller(pipeline)

    @server.controller.add("toggle_controls")
    def toggle_controls():
        state.show_controls = not state.show_controls
        return state.show_controls

    def select_all_volumes():
        state.selected_volume_ids = []
        state.selected_materials = []
        state.selected_groups = []
        update_volume_visibility()
        update_view()

    def clear_selection():
        state.selected_volume_ids = []
        state.selected_materials = []
        state.selected_groups = []
        update_volume_visibility()
        update_view()

    # UI setup
    with VAppLayout(server) as layout:
        html.Style(GLOBAL_STYLES)

        with vuetify.VNavigationDrawer(
            v_model=("show_controls", True),
            app=True, width=320, clipped=True,
            color=("sidebar_color", "#1e1e1e"),
            dark=("sidebar_dark", True)
        ):
            with vuetify.VContainer(classes="pa-4"):
                # Header
                with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                    vuetify.VSubheader("DAGMC Viewer", classes="text-h6 pa-0")
                    with vuetify.VBtn(click=toggle_controls, small=True, icon=True):
                        vuetify.VIcon("mdi-chevron-left")
                vuetify.VDivider(classes="mb-2")

                # File info
                with vuetify.VContainer(classes="text-caption pa-0 text-truncate mb-2"):
                    html.Div("{{ dagmc_title }}")

                vuetify.VDivider(classes="mb-2")

                # Volume selector
                vuetify.VSubheader("Volumes", classes="text-subtitle-2 mb-1")
                vuetify.VSelect(
                    v_model=("selected_volume_ids", []),
                    items=("volume_items", []),
                    item_text="text",
                    item_value="value",
                    label="Select volumes to show",
                    multiple=True,
                    dense=True,
                    outlined=True,
                    classes="mb-2"
                )

                vuetify.VDivider(classes="my-2")

                # Material selector
                vuetify.VSubheader("Materials", classes="text-subtitle-2 mb-1")
                vuetify.VSelect(
                    v_model=("selected_materials", []),
                    items=("material_items", []),
                    item_text="text",
                    item_value="value",
                    label="Select materials to show",
                    multiple=True,
                    dense=True,
                    outlined=True,
                    classes="mb-2"
                )

                vuetify.VDivider(classes="my-2")

                # Group selector
                vuetify.VSubheader("Groups", classes="text-subtitle-2 mb-1")
                vuetify.VSelect(
                    v_model=("selected_groups", []),
                    items=("group_items", []),
                    item_text="text",
                    item_value="value",
                    label="Select groups to show",
                    multiple=True,
                    dense=True,
                    outlined=True,
                    classes="mb-2"
                )

                vuetify.VDivider(classes="my-2")

                # Selection actions
                with vuetify.VRow(dense=True, classes="mt-1 mb-2"):
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Show All", click=select_all_volumes,
                            small=True, block=True, text=True
                        )
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Clear", click=clear_selection,
                            small=True, block=True, text=True
                        )

                vuetify.VDivider(classes="my-2")

                # Display Controls (same as base viewer)
                vuetify.VSubheader("Display", classes="text-subtitle-2 mb-1")
                UIComponents.opacity_slider(vuetify)
                UIComponents.representation_selector(vuetify)

                vuetify.VDivider(classes="my-2")

                # Clip Plane
                vuetify.VSubheader("Clipping", classes="text-subtitle-2 mb-1")
                vuetify.VCheckbox(
                    v_model=("clip_enabled", False),
                    label="Enable Clip Plane",
                    dense=True, classes="mb-1"
                )
                with vuetify.VContainer(v_if=("clip_enabled",), classes="pl-2"):
                    vuetify.VSubheader("Origin", classes="text-caption pa-0")
                    with vuetify.VRow(dense=True):
                        for axis in ['x', 'y', 'z']:
                            with vuetify.VCol(cols=4):
                                vuetify.VTextField(
                                    v_model=(f"clip_origin_{axis}", 0.0),
                                    label=axis.upper(), type="number",
                                    dense=True, outlined=True
                                )
                    vuetify.VSubheader("Normal", classes="text-caption pa-0 mt-1")
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
                        dense=True, classes="mt-1"
                    )

                vuetify.VDivider(classes="my-2")

                # Appearance
                UIComponents.compact_appearance_controls(vuetify)
                UIComponents.point_size_slider(vuetify)
                UIComponents.line_width_slider(vuetify)
                UIComponents.ambient_light_slider(vuetify)

                vuetify.VDivider(classes="my-2")

                # Export
                def save_screenshot():
                    save_screenshot_with_timestamp(capture_screenshot, state)

                vuetify.VSubheader("Export", classes="text-subtitle-2 mb-1")
                vuetify.VBtn("Save Screenshot", click=save_screenshot,
                             block=True, small=True, color="primary", classes="mb-2")

                with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                    vuetify.VSubheader(("screenshot_status",), classes="text-caption justify-center")

        # Main content area
        with vuetify.VMain():
            with vuetify.VContainer(
                v_if=("!show_controls",),
                classes="ma-2 pa-0",
                style="position: absolute; top: 0; left: 0; z-index: 100;"
            ):
                with vuetify.VBtn(click=toggle_controls, small=True, fab=True, color="primary"):
                    vuetify.VIcon("mdi-chevron-right")

            # Camera Navigation Gadget
            UIComponents.create_canvas_gadget(vuetify, pan_camera, zoom_camera,
                                               reset_callback=reset_camera, view_callback=set_camera_view)

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

    # Initial visibility update
    update_volume_visibility()
    simple.ResetCamera()
    simple.Render(view)

    url = f"http://127.0.0.1:{actual_port}"
    print("=" * 60)
    print(f"Starting DAGMC visualizer server on {url}")
    print(f"  Volumes: {len(volume_info)}")
    print(f"  Materials: {len(materials)}")
    print(f"  Groups: {len(groups)}")
    print("=" * 60)

    try:
        server.start(port=actual_port, host='0.0.0.0', open_browser=False, show_connection_info=False)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        import traceback
        traceback.print_exc()
        return 1

    return 0
