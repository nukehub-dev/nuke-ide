#!/usr/bin/env python3
"""
DAGMC 3D Visualization for NukeIDE.

Converts DAGMC .h5m files to a multi-block VTK dataset and serves
an interactive Trame viewer with volume, material, and group selection.
"""

from pathlib import Path

import vtk  # noqa: F401  # eager probe: importing this module must fail when VTK is unavailable

from plugins.base.lib.common import (
    DISTINCT_COLORS,
    GLOBAL_STYLES,
    StateHandlers,
    UIComponents,
    check_trame_dependencies,
    create_capture_screenshot_controller,
    create_pan_camera_controller,
    create_reset_camera_controller,
    create_set_camera_view_controller,
    create_update_view,
    create_zoom_camera_controller,
    find_free_port,
    hex_to_rgb,
    init_common_state,
    save_screenshot_with_timestamp,
    verify_or_find_port,
)
from plugins.base.lib.dagmc import convert_h5m_to_multiblock_vtk

# Minimal theme-neutral CSS for DAGMC-specific UI
DAGMC_STYLES = """
    .dagmc-vol-list {
        max-height: 160px;
        overflow-y: auto;
    }
    .dagmc-vol-list::-webkit-scrollbar { width: 5px; }
    .dagmc-vol-list::-webkit-scrollbar-thumb {
        background: rgba(128,128,128,0.35);
        border-radius: 3px;
    }
    .dagmc-stat { font-size: 0.7rem; opacity: 0.65; }
"""


def _format_triangles(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def visualize_dagmc(
    h5m_file: str, port: int = None, theme: str = "dark", highlight_volumes: list[int] | None = None
) -> int:
    h5m_path = Path(h5m_file)
    if not h5m_path.exists():
        print(f"Error: File not found: {h5m_file}")
        return 1

    success, errors = check_trame_dependencies()
    if not success:
        print("Error: Missing dependencies")
        for error in errors:
            print(f"  - {error}")
        return 1

    try:
        from paraview import simple
        from trame.app import get_server
        from trame.ui.vuetify3 import VAppLayout
        from trame.widgets import html
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify3 as vuetify
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}")
        return 1

    # Convert H5M to multi-block VTK
    print(f"[DAGMC-Viz] Converting {h5m_path.name}...")
    try:
        conversion_result = convert_h5m_to_multiblock_vtk(str(h5m_path), include_graveyard=False)
    except ImportError as e:
        print(f"Error: pydagmc required: {e}")
        return 1
    except Exception as e:
        print(f"Error converting DAGMC file: {e}")
        import traceback

        traceback.print_exc()
        return 1

    vtm_path = conversion_result["vtm_path"]
    volume_info = conversion_result["volume_info"]
    materials = conversion_result["materials"]
    groups = conversion_result["groups"]

    if not volume_info:
        print("Error: No volumes found in DAGMC file")
        return 1

    total_tris = sum(v["numTriangles"] for v in volume_info)
    print(
        f"[DAGMC-Viz] Loaded {len(volume_info)} volumes, {len(materials)} materials, {len(groups)} groups"
    )

    # Assign deterministic distinct colors
    palette = DISTINCT_COLORS
    for v in volume_info:
        color = palette[v["id"] % len(palette)]
        v["color"] = color
        v["color_hex"] = (
            f"#{int(color[0] * 255):02x}{int(color[1] * 255):02x}{int(color[2] * 255):02x}"
        )
        v["tri_str"] = _format_triangles(v["numTriangles"])

    group_list = sorted(groups.keys())

    # Create trame server
    actual_port = port or find_free_port()
    actual_port = verify_or_find_port(actual_port)
    print(f"ACTUAL_PORT: {actual_port}")
    server = get_server(client_type="vue3", port=actual_port)
    state = server.state

    # Initialize common state (this sets sidebar_color, sidebar_dark, background_color_hex)
    init_common_state(state, theme=theme)

    # DAGMC-specific state
    state.dagmc_title = h5m_path.name
    state.selected_volume_ids = highlight_volumes if highlight_volumes else []
    state.selected_groups = []
    state.color_by = "Solid Color"
    state.color_map = "Cool to Warm"
    state.available_arrays = ["Solid Color", "Cell: volume_id", "Cell: material", "Cell: groups"]
    state.model_stats = f"{len(volume_info)} volumes · {_format_triangles(total_tris)} triangles · {len(groups)} groups"

    # Pre-format items for VAutocomplete (custom slot expects id, name, subtitle, color)
    state.volume_items = [
        {
            "id": v["id"],
            "name": f"Vol {v['id']} — {v['material']}",
            "subtitle": f"{v['tri_str']} triangles",
            "color": v["color_hex"],
        }
        for v in volume_info
    ]
    state.group_items = [
        {
            "id": g,
            "name": g,
            "subtitle": f"{len(groups.get(g, []))} volumes",
            "color": f"#{int(palette[i % len(palette)][0] * 255):02x}{int(palette[i % len(palette)][1] * 255):02x}{int(palette[i % len(palette)][2] * 255):02x}",
        }
        for i, g in enumerate(group_list)
    ]

    # Pipeline storage
    pipeline = {
        "reader": None,
        "extracts": {},
        "colorby_extract": None,
        "clip_filter": None,
        "original_reader": None,
        "view": None,
        "view_widget": None,
        "volume_displays": {},
    }

    # Load in ParaView
    reader = simple.XMLMultiBlockDataReader(FileName=vtm_path)
    pipeline["reader"] = reader
    pipeline["original_reader"] = reader
    simple.Hide(reader)

    view = simple.GetActiveViewOrCreate("RenderView")
    bg_rgb = hex_to_rgb(state.background_color_hex)
    view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
    view.UseColorPaletteForBackground = 0
    pipeline["view"] = view

    update_view = create_update_view(pipeline, state, simple)

    def update_volume_visibility():
        """Update visibility. Supports both Solid Color and ColorBy modes."""
        try:
            visible_vol_ids = set()
            selected_vol_ids = state.selected_volume_ids
            if selected_vol_ids and len(selected_vol_ids) > 0:
                for vid in selected_vol_ids:
                    visible_vol_ids.add(int(vid))
            else:
                selected_grps = state.selected_groups
                if selected_grps and len(selected_grps) > 0:
                    for grp in selected_grps:
                        for vid in groups.get(grp, []):
                            visible_vol_ids.add(vid)
                else:
                    for v in volume_info:
                        visible_vol_ids.add(v["id"])

            # Clear existing extracts and displays
            for _vol_id, extract in list(pipeline["extracts"].items()):
                try:
                    simple.Hide(extract, view)
                    simple.Delete(extract)
                except Exception:
                    pass
            pipeline["extracts"].clear()

            if pipeline.get("colorby_extract"):
                try:
                    simple.Hide(pipeline["colorby_extract"], view)
                    simple.Delete(pipeline["colorby_extract"])
                except Exception:
                    pass
                pipeline["colorby_extract"] = None

            pipeline["volume_displays"].clear()
            current_reader = pipeline.get("reader")
            color_by = state.color_by

            if color_by == "Solid Color":
                # One ExtractBlock per visible volume with distinct diffuse color
                for v in volume_info:
                    vol_id = v["id"]
                    if vol_id not in visible_vol_ids:
                        continue
                    extract = simple.ExtractBlock(Input=current_reader)
                    extract.Selectors = [v["selector"]]
                    pipeline["extracts"][vol_id] = extract

                    disp = simple.Show(extract, view)
                    disp.Representation = state.representation
                    disp.Opacity = float(state.opacity)
                    disp.PointSize = float(state.point_size)
                    disp.LineWidth = float(state.line_width)
                    disp.Ambient = float(state.ambient_light)
                    disp.MapScalars = 0
                    disp.DiffuseColor = v["color"]
                    disp.AmbientColor = v["color"]
                    pipeline["volume_displays"][vol_id] = disp
            else:
                # Single ExtractBlock + ColorBy LUT
                selectors = [v["selector"] for v in volume_info if v["id"] in visible_vol_ids]
                if selectors:
                    extract = simple.ExtractBlock(Input=current_reader)
                    extract.Selectors = selectors
                    pipeline["colorby_extract"] = extract

                    disp = simple.Show(extract, view)
                    disp.Representation = state.representation
                    disp.Opacity = float(state.opacity)
                    disp.PointSize = float(state.point_size)
                    disp.LineWidth = float(state.line_width)
                    disp.Ambient = float(state.ambient_light)

                    if color_by.startswith("Cell: "):
                        array_name = color_by[6:]
                        simple.ColorBy(disp, ("CELLS", array_name))
                        lut = simple.GetColorTransferFunction(array_name)
                        lut.ApplyPreset(state.color_map, True)
                    elif color_by.startswith("Point: "):
                        array_name = color_by[7:]
                        simple.ColorBy(disp, ("POINTS", array_name))
                        lut = simple.GetColorTransferFunction(array_name)
                        lut.ApplyPreset(state.color_map, True)

                    pipeline["volume_displays"]["colorby"] = disp

            simple.Render(view)
        except Exception as e:
            print(f"Error updating volume visibility: {e}")
            import traceback

            traceback.print_exc()

    @state.change("selected_volume_ids")
    def on_selected_volumes_change(selected_volume_ids, **kwargs):
        if selected_volume_ids and len(selected_volume_ids) > 0:
            state.selected_groups = []
        update_volume_visibility()
        update_view(push_camera=True)

    @state.change("selected_groups")
    def on_selected_groups_change(selected_groups, **kwargs):
        if selected_groups and len(selected_groups) > 0:
            state.selected_volume_ids = []
        update_volume_visibility()
        update_view(push_camera=True)

    def update_scalar_bar_visibility():
        """Show/hide scalar bar based on current color_by and show_scalar_bar state."""
        try:
            color_by = state.color_by
            view_ref = pipeline.get("view")
            if not view_ref:
                return

            known_arrays = ["volume_id", "material", "groups"]

            if color_by == "Solid Color":
                # Hide all scalar bars when in solid color mode
                for array_name in known_arrays:
                    try:
                        lut = simple.GetColorTransferFunction(array_name)
                        scalar_bar = simple.GetScalarBar(lut, view_ref)
                        if scalar_bar:
                            scalar_bar.Visibility = 0
                    except Exception:
                        pass
                return

            array_name = None
            if color_by.startswith("Cell: "):
                array_name = color_by[6:]
            elif color_by.startswith("Point: "):
                array_name = color_by[7:]

            if array_name:
                lut = simple.GetColorTransferFunction(array_name)
                scalar_bar = simple.GetScalarBar(lut, view_ref)
                if scalar_bar:
                    scalar_bar.Visibility = int(state.show_scalar_bar)
        except Exception as e:
            print(f"Error updating scalar bar visibility: {e}")

    @state.change("color_by")
    def on_color_by_change(color_by, **kwargs):
        update_volume_visibility()
        update_scalar_bar_visibility()
        update_view(push_camera=True)

    @state.change("show_scalar_bar")
    def on_show_scalar_bar_change(show_scalar_bar, **kwargs):
        update_scalar_bar_visibility()
        update_view()

    @state.change("color_map")
    def on_color_map_change(color_map, **kwargs):
        try:
            color_by = state.color_by
            if color_by == "Solid Color":
                return
            disp = pipeline["volume_displays"].get("colorby")
            if not disp:
                return
            array_name = None
            if color_by.startswith("Cell: "):
                array_name = color_by[6:]
            elif color_by.startswith("Point: "):
                array_name = color_by[7:]
            if array_name:
                lut = simple.GetColorTransferFunction(array_name)
                lut.ApplyPreset(color_map, True)
                update_view()
        except Exception as e:
            print(f"Error updating color map: {e}")

    @state.change("opacity")
    def on_opacity_change(opacity, **kwargs):
        for disp in pipeline["volume_displays"].values():
            if disp and hasattr(disp, "Opacity"):
                disp.Opacity = float(opacity)
        update_view()

    @state.change("representation")
    def on_representation_change(representation, **kwargs):
        for disp in pipeline["volume_displays"].values():
            if disp and hasattr(disp, "Representation"):
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
                if hasattr(view, "CenterAxesVisibility"):
                    view.CenterAxesVisibility = bool(show_bounding_box)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating bounding box: {e}")

    @state.change("show_cube_axes")
    def on_show_cube_axes_change(show_cube_axes, **kwargs):
        try:
            if view:
                if hasattr(view, "CubeAxesVisibility"):
                    view.CubeAxesVisibility = bool(show_cube_axes)
                elif hasattr(view, "AxesGrid"):
                    view.AxesGrid.Visibility = bool(show_cube_axes)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating cube axes: {e}")

    @state.change("point_size")
    def on_point_size_change(point_size, **kwargs):
        for disp in pipeline["volume_displays"].values():
            if disp and hasattr(disp, "PointSize"):
                disp.PointSize = float(point_size)
        update_view()

    @state.change("line_width")
    def on_line_width_change(line_width, **kwargs):
        for disp in pipeline["volume_displays"].values():
            if disp and hasattr(disp, "LineWidth"):
                disp.LineWidth = float(line_width)
        update_view()

    @state.change("ambient_light")
    def on_ambient_light_change(ambient_light, **kwargs):
        for disp in pipeline["volume_displays"].values():
            if disp and hasattr(disp, "Ambient"):
                disp.Ambient = float(ambient_light)
        update_view()

    @state.change("parallel_projection")
    def on_parallel_projection_change(parallel_projection, **kwargs):
        StateHandlers.create_parallel_projection_handler(pipeline, state)(
            parallel_projection, **kwargs
        )
        update_view(push_camera=True)

    @state.change(
        "clip_enabled",
        "clip_origin_x",
        "clip_origin_y",
        "clip_origin_z",
        "clip_normal_x",
        "clip_normal_y",
        "clip_normal_z",
        "clip_invert",
    )
    def on_clip_change(
        clip_enabled,
        clip_origin_x,
        clip_origin_y,
        clip_origin_z,
        clip_normal_x,
        clip_normal_y,
        clip_normal_z,
        clip_invert,
        **kwargs,
    ):
        try:
            original_reader = pipeline.get("original_reader")
            if not original_reader:
                return

            existing_clip = pipeline.get("clip_filter")
            if existing_clip:
                simple.Delete(existing_clip)
                pipeline["clip_filter"] = None

            if clip_enabled:
                clip = simple.Clip(Input=original_reader)
                clip.ClipType = "Plane"
                clip.ClipType.Origin = [
                    float(clip_origin_x),
                    float(clip_origin_y),
                    float(clip_origin_z),
                ]
                clip.ClipType.Normal = [
                    float(clip_normal_x),
                    float(clip_normal_y),
                    float(clip_normal_z),
                ]
                clip.Invert = bool(clip_invert)
                pipeline["clip_filter"] = clip
                pipeline["reader"] = clip
            else:
                pipeline["reader"] = original_reader

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

    def select_all_volumes():
        state.selected_volume_ids = []
        state.selected_groups = []
        update_volume_visibility()
        update_view()

    def clear_selection():
        state.selected_volume_ids = []
        state.selected_groups = []
        update_volume_visibility()
        update_view()

    def toggle_controls():
        state.show_controls = not state.show_controls
        return state.show_controls

    # UI
    with VAppLayout(server, theme=("sidebar_dark ? 'dark' : 'light'",)):
        html.Component(GLOBAL_STYLES + DAGMC_STYLES, **{"is": "style"})

        with vuetify.VNavigationDrawer(
            v_model=("show_controls", True),
            width=300,
            color=("sidebar_color", "#1e1e1e"),
            theme=("sidebar_dark ? 'dark' : 'light'",),
        ):
            with vuetify.VContainer(classes="pa-2"):
                # Header
                with vuetify.VRow(classes="ma-0", align="center", justify="space-between"):
                    vuetify.VListSubheader("DAGMC", classes="text-subtitle-2 pa-0 font-weight-bold")
                    with vuetify.VBtn(click=toggle_controls, icon=True, size="x-small"):
                        vuetify.VIcon("mdi-chevron-left", size="x-small")
                vuetify.VListSubheader(
                    "{{ dagmc_title }}", classes="text-caption pa-0 text-truncate"
                )
                vuetify.VListSubheader(
                    "{{ model_stats }}", classes="text-caption pa-0 dagmc-stat mb-1"
                )

                vuetify.VDivider(classes="my-2")

                # Color By
                UIComponents.color_by_selector(vuetify, classes="mb-2")
                with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",), classes="pa-0 ma-0"):
                    UIComponents.color_map_selector(vuetify, classes="mb-2")

                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", False),
                        label="Show Color Legend",
                        density="compact",
                        classes="mb-4",
                    )
                vuetify.VDivider(classes="my-2")

                # Volume Selection
                vuetify.VListSubheader("Volumes")
                with vuetify.VAutocomplete(
                    v_model=("selected_volume_ids", []),
                    items=("volume_items", []),
                    item_title="name",
                    item_value="id",
                    label="Search & select volumes",
                    multiple=True,
                    density="compact",
                    variant="outlined",
                    clearable=True,
                    hide_selected=True,
                    auto_select_first=False,
                    prepend_inner_icon="mdi-magnify",
                    classes="mb-2",
                ):
                    with vuetify.Template(v_slot_item="{ props, item }"):
                        with vuetify.VListItem(
                            v_bind="props",
                            title="{{ item.raw.name }}",
                            subtitle="{{ item.raw.subtitle }}",
                        ):
                            with vuetify.Template(v_slot_prepend="{ item }"):
                                vuetify.VIcon(
                                    "mdi-circle",
                                    size="small",
                                    v_bind_style="{ color: item.raw.color }",
                                )

                    with vuetify.Template(v_slot_selection="{ item, index }"):
                        with vuetify.VChip(
                            size="x-small",
                            closable=True,
                            v_bind_style="{ borderLeft: '3px solid ' + item.raw.color + ' !important' }",
                            classes="ma-1",
                            click_close="selected_volume_ids.splice(index, 1); set('selected_volume_ids', [...selected_volume_ids])",
                        ):
                            html.Span("{{ item.raw.name }}")

                with vuetify.VRow(dense=True, classes="mb-2"):
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Clear",
                            click=lambda: setattr(state, "selected_volume_ids", []),
                            block=True,
                            size="x-small",
                            variant="text",
                            disabled=("selected_volume_ids.length === 0",),
                        )
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "All",
                            click=lambda: setattr(
                                state, "selected_volume_ids", [c["id"] for c in state.volume_items]
                            ),
                            block=True,
                            size="x-small",
                            variant="text",
                        )
                # Collapsible secondary sections
                with vuetify.VExpansionPanels(
                    v_model=("expanded_panels", []), multiple=True, variant="flat"
                ):
                    # Groups
                    with vuetify.VExpansionPanel():
                        with vuetify.VExpansionPanelTitle():
                            html.Div("Groups")
                        with vuetify.VExpansionPanelText():
                            with vuetify.VAutocomplete(
                                v_model=("selected_groups", []),
                                items=("group_items", []),
                                item_title="name",
                                item_value="id",
                                label="Search & select groups",
                                multiple=True,
                                density="compact",
                                variant="outlined",
                                clearable=True,
                                hide_selected=True,
                                auto_select_first=False,
                                prepend_inner_icon="mdi-magnify",
                                classes="mb-2",
                            ):
                                with vuetify.Template(v_slot_item="{ props, item }"):
                                    with vuetify.VListItem(
                                        v_bind="props",
                                        title="{{ item.raw.name }}",
                                        subtitle="{{ item.raw.subtitle }}",
                                    ):
                                        with vuetify.Template(v_slot_prepend="{ item }"):
                                            vuetify.VIcon(
                                                "mdi-circle",
                                                size="small",
                                                v_bind_style="{ color: item.raw.color }",
                                            )

                                with vuetify.Template(v_slot_selection="{ item, index }"):
                                    with vuetify.VChip(
                                        size="x-small",
                                        closable=True,
                                        v_bind_style="{ borderLeft: '3px solid ' + item.raw.color + ' !important' }",
                                        classes="ma-1",
                                        click_close="selected_groups.splice(index, 1); set('selected_groups', [...selected_groups])",
                                    ):
                                        html.Span("{{ item.raw.name }}")

                            with vuetify.VRow(dense=True, classes="mb-2"):
                                with vuetify.VCol(cols=6):
                                    vuetify.VBtn(
                                        "Clear",
                                        click=lambda: setattr(state, "selected_groups", []),
                                        block=True,
                                        size="x-small",
                                        variant="text",
                                        disabled=("selected_groups.length === 0",),
                                    )
                                with vuetify.VCol(cols=6):
                                    vuetify.VBtn(
                                        "All",
                                        click=lambda: setattr(
                                            state,
                                            "selected_groups",
                                            [c["id"] for c in state.group_items],
                                        ),
                                        block=True,
                                        size="x-small",
                                        variant="text",
                                    )
                vuetify.VDivider(classes="my-2 mb-2")
                vuetify.VListSubheader("Display", classes="text-subtitle-1 mb-2")
                UIComponents.representation_selector(vuetify, classes="mb-2")
                UIComponents.opacity_slider(vuetify, classes="mb-2")

                vuetify.VDivider(classes="my-2")

                # Clipping Section
                vuetify.VListSubheader("Clipping", classes="text-subtitle-1 mb-2")

                vuetify.VCheckbox(
                    v_model=("clip_enabled", False),
                    label="Enable Clip Plane",
                    density="compact",
                    classes="mb-2",
                )

                with vuetify.VContainer(v_if=("clip_enabled",), classes="pl-4"):
                    vuetify.VListSubheader("Origin", classes="text-caption pa-0")
                    with vuetify.VRow(dense=True):
                        for axis in ["x", "y", "z"]:
                            with vuetify.VCol(cols=4):
                                vuetify.VTextField(
                                    v_model=(f"clip_origin_{axis}", 0.0),
                                    label=axis.upper(),
                                    type="number",
                                    density="compact",
                                    variant="outlined",
                                )

                    vuetify.VListSubheader("Normal", classes="text-caption pa-0 mt-2")
                    with vuetify.VRow(dense=True):
                        for axis, default in [("x", 1.0), ("y", 0.0), ("z", 0.0)]:
                            with vuetify.VCol(cols=4):
                                vuetify.VTextField(
                                    v_model=(f"clip_normal_{axis}", default),
                                    label=axis.upper(),
                                    type="number",
                                    density="compact",
                                    variant="outlined",
                                )

                    vuetify.VCheckbox(
                        v_model=("clip_invert", False),
                        label="Invert Clip",
                        density="compact",
                        classes="mt-2",
                    )
                vuetify.VDivider(classes="my-2")

                UIComponents.compact_appearance_controls(vuetify)
                UIComponents.point_size_slider(vuetify, classes="mb-2 mt-2")
                UIComponents.line_width_slider(vuetify, classes="mb-2")
                UIComponents.ambient_light_slider(vuetify, classes="mb-2")

                # Export
                def save_screenshot():
                    save_screenshot_with_timestamp(capture_screenshot, state)

                vuetify.VListSubheader("Export")
                vuetify.VBtn(
                    "Screenshot",
                    click=save_screenshot,
                    block=True,
                    size="x-small",
                    color="primary",
                    classes="mb-1",
                )
                with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center pa-0"):
                    vuetify.VListSubheader(
                        ("screenshot_status",), classes="text-caption justify-center pa-0"
                    )

        # Main content
        with vuetify.VMain(style="position: relative;"):
            with vuetify.VContainer(
                v_if=("!show_controls",),
                classes="ma-2 pa-0",
                style="position: absolute; top: 0; left: 0; z-index: 100;",
            ):
                vuetify.VBtn(
                    icon="mdi-chevron-right", click=toggle_controls, size="small", color="primary"
                )

            UIComponents.create_canvas_gadget(
                vuetify,
                pan_camera,
                zoom_camera,
                reset_callback=reset_camera,
                view_callback=set_camera_view,
            )

            with vuetify.VContainer(
                fluid=True,
                classes="pa-0 ma-0 fill-height",
                style="height: 100vh; width: 100%; position: relative;",
            ):
                view_widget = pv_widgets.VtkRemoteView(
                    view, interactive_ratio=1, style="width: 100%; height: 100%;"
                )
                pipeline["view_widget"] = view_widget

                @server.controller.add("view_update")
                def view_update():
                    view_widget.update()

                @state.change("camera_update_counter")
                def on_camera_update(camera_update_counter, **kwargs):
                    try:
                        simple.Render(view)
                        view_widget.update()
                    except Exception as e:
                        print(f"Camera update error: {e}")

                @state.change("appearance_update")
                def on_appearance_update(appearance_update, **kwargs):
                    try:
                        simple.Render(view)
                        view_widget.update()
                    except Exception as e:
                        print(f"Appearance update error: {e}")

    # Initial render
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
        server.start(
            port=actual_port, host="0.0.0.0", open_browser=False, show_connection_info=False
        )
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        import traceback

        traceback.print_exc()
        return 1

    return 0
