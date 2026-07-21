"""
Tally visualization commands using OpenMC's native VTK export.

This replaces the manual VTK grid construction with OpenMC's officially
supported write_data_to_vtk() API, providing:
- Correct mesh indexing for all mesh types
- Proper multi-filter tally handling
- Reliable geometry overlay
"""

import json
import os
import sys
import tempfile

# Patch numpy for VTK compatibility (numpy 2.0 removed in1d)
import numpy as np

if not hasattr(np, "in1d"):
    np.in1d = np.isin

import vtk
from nuke_viz.plugin import arg, command
from paraview import simple

from plugins.base.lib.common import (
    COLOR_MAPS,
    GLOBAL_STYLES,
    StateHandlers,
    UIComponents,
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
)

# Import openmc for filter type checking
try:
    import openmc
except ImportError:
    openmc = None

# Use OpenMC's native API for tally export
try:
    from plugins.openmc.lib.openmc_vtk import MeshTallyData, OpenMCVTKExporter  # noqa: F401

    HAS_OPENMC_API = True
except ImportError:
    HAS_OPENMC_API = False
    print(
        "Warning: OpenMC VTK exporter not available, falling back to legacy reader", file=sys.stderr
    )


def _load_geometry(geometry_path: str, filter_graveyard: bool = True, volume_id: int = None):
    """Load geometry from h5m, xml (with dagmc reference), or vtk file."""
    if geometry_path.endswith(".h5m"):
        # If a specific volume is requested, extract it
        if volume_id is not None:
            try:
                from plugins.base.lib.dagmc import convert_h5m_volume_to_vtk

                vtk_path = convert_h5m_volume_to_vtk(geometry_path, volume_id)
                reader = simple.XMLUnstructuredGridReader(FileName=vtk_path)
                print(f"[Overlay] Extracted volume {volume_id} from {geometry_path}")
            except Exception as e:
                print(f"[Overlay] Volume extraction failed: {e}, falling back to full geometry")
                from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached

                result = convert_h5m_to_vtk_cached(
                    geometry_path, use_cache=True, do_filter_graveyard=filter_graveyard
                )
                vtk_path = result["vtk_path"]
                reader = simple.LegacyVTKReader(FileNames=[vtk_path])
        else:
            from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached

            result = convert_h5m_to_vtk_cached(
                geometry_path, use_cache=True, do_filter_graveyard=filter_graveyard
            )
            vtk_path = result["vtk_path"]
            reader = simple.LegacyVTKReader(FileNames=[vtk_path])
    elif geometry_path.endswith(".xml"):
        # Check if it's a DAGMC reference
        import xml.etree.ElementTree as ET

        try:
            tree = ET.parse(geometry_path)
            root = tree.getroot()
            dagmc_elem = root.find(".//dagmc_universe")
            if dagmc_elem is not None:
                dagmc_filename = dagmc_elem.get("filename")
                if dagmc_filename:
                    if not os.path.isabs(dagmc_filename):
                        dagmc_filename = os.path.join(
                            os.path.dirname(geometry_path), dagmc_filename
                        )
                    print(f"[Overlay] Found DAGMC reference in geometry.xml: {dagmc_filename}")
                    from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached

                    result = convert_h5m_to_vtk_cached(
                        dagmc_filename, use_cache=True, do_filter_graveyard=filter_graveyard
                    )
                    vtk_path = result["vtk_path"]
                    reader = simple.LegacyVTKReader(FileNames=[vtk_path])
                else:
                    raise ValueError("dagmc_universe element has no filename attribute")
            else:
                raise ValueError("geometry.xml does not contain a dagmc_universe reference")
        except ET.ParseError as e:
            raise ValueError(f"Failed to parse geometry XML: {e}")
    elif geometry_path.endswith(".vtk"):
        reader = simple.LegacyVTKReader(FileNames=[geometry_path])
    elif geometry_path.endswith(".vtu"):
        reader = simple.XMLUnstructuredGridReader(FileName=geometry_path)
    else:
        raise ValueError(f"Unsupported geometry format: {geometry_path}")

    reader.UpdatePipeline()
    return reader


def _setup_tally_coloring(
    display, array_name: str, array_location: str, color_map: str = "Cool to Warm"
):
    """Setup coloring for a display with proper data range."""
    if array_location == "CELLS":
        simple.ColorBy(display, ("CELLS", array_name))
    else:
        simple.ColorBy(display, ("POINTS", array_name))

    lut = simple.GetColorTransferFunction(array_name)
    lut.ApplyPreset(color_map, True)

    # Configure NaN color to be transparent
    try:
        lut.NanColor = [0.0, 0.0, 0.0, 0.0]  # Transparent black for NaN
    except Exception:
        pass

    # Get data range and rescale
    try:
        source = display.Input
        if array_location == "CELLS":
            data_array = source.CellData.GetArray(array_name)
        else:
            data_array = source.PointData.GetArray(array_name)

        if data_array:
            data_range = data_array.GetRange()
            if data_range[0] != data_range[1]:
                lut.RescaleTransferFunction(data_range[0], data_range[1])
            return data_range
    except Exception as e:
        print(f"Warning: Could not rescale transfer function: {e}", file=sys.stderr)

    return None


def _get_available_arrays(source):
    """Get list of available arrays from a source."""
    arrays = ["Solid Color"]

    try:
        cell_data = source.CellData
        for i in range(cell_data.GetNumberOfArrays()):
            arr = cell_data.GetArray(i)
            if arr and arr.GetName():
                arrays.append(f"Cell: {arr.GetName()}")
    except Exception:
        pass

    try:
        point_data = source.PointData
        for i in range(point_data.GetNumberOfArrays()):
            arr = point_data.GetArray(i)
            if arr and arr.GetName():
                arrays.append(f"Point: {arr.GetName()}")
    except Exception:
        pass

    return arrays


@command("openmc.visualize-mesh", help="Visualize mesh tally using OpenMC native VTK export")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID to visualize")
@arg("--score", help="Score to visualize (default: first score)")
@arg("--nuclide", help="Nuclide to visualize (default: first nuclide)")
@arg("--colormap", help="Color map name")
@arg("--port", type=int, help="Server port")
def cmd_visualize_mesh(args):
    """Visualize a mesh tally using OpenMC's native VTK export."""
    try:
        from trame.app import get_server
        from trame.ui.vuetify3 import VAppLayout
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify3 as vuetify
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)

    try:
        # Export mesh tally to VTK using OpenMC's native API
        if not HAS_OPENMC_API:
            print("Error: OpenMC API not available", file=sys.stderr)
            return 1

        exporter = OpenMCVTKExporter(args.statepoint)
        mesh_data = exporter.export_mesh_tally(
            args.tally_id, score=args.score, nuclide=args.nuclide
        )

        print(f"[OpenMC] Exported mesh tally to {mesh_data.vtk_path}", file=sys.stderr)

        # Load VTK in ParaView
        vtk_source = simple.LegacyVTKReader(FileNames=[mesh_data.vtk_path])
        vtk_source.UpdatePipeline()

        # Create trame application
        server = get_server(client_type="vue3", port=port)
        state = server.state

        # Initialize common state
        init_common_state(
            state,
            theme="dark",
            color_by=f"Cell: {mesh_data.datasets[0]}",
            show_scalar_bar=True,
            color_map=args.colormap or "Cool to Warm",
        )

        # Tally info
        state.tally_id = int(mesh_data.tally_id)
        state.tally_name = str(mesh_data.tally_name)
        state.current_score = str(mesh_data.score)
        state.current_nuclide = str(mesh_data.nuclide)
        state.mesh_type = mesh_data.mesh_type
        state.mesh_dimensions = " x ".join(str(d) for d in mesh_data.dimensions)
        state.mesh_bounds = (
            (
                f"X: [{mesh_data.bounds['x'][0]:.2f}, {mesh_data.bounds['x'][1]:.2f}] cm\n"
                f"Y: [{mesh_data.bounds['y'][0]:.2f}, {mesh_data.bounds['y'][1]:.2f}] cm\n"
                f"Z: [{mesh_data.bounds['z'][0]:.2f}, {mesh_data.bounds['z'][1]:.2f}] cm"
            )
            if "x" in mesh_data.bounds
            else str(mesh_data.bounds)
        )
        state.data_range = f"[{mesh_data.data_range[0]:.6e}, {mesh_data.data_range[1]:.6e}]"

        # Get available arrays
        available_arrays = _get_available_arrays(vtk_source)
        state.available_arrays = available_arrays

        # Create visualization
        display = simple.Show(vtk_source)
        view = simple.GetActiveViewOrCreate("RenderView")

        # Setup initial coloring
        array_name = mesh_data.datasets[0]
        _setup_tally_coloring(display, array_name, "CELLS", state.color_map)

        bg_rgb = hex_to_rgb(state.background_color_hex)
        view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0

        scalar_bar = simple.GetScalarBar(simple.GetColorTransferFunction(array_name), view)
        if scalar_bar:
            scalar_bar.Visibility = 1
            scalar_bar.Title = array_name.replace("-", " ").title()

        view.OrientationAxesVisibility = 1
        simple.Render(view)
        simple.ResetCamera()

        # Pipeline storage
        pipeline = {"source": vtk_source, "display": display, "view": view, "view_widget": None}

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
            StateHandlers.create_scalar_bar_handler(pipeline, state, simple)(
                show_scalar_bar, **kwargs
            )
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
                if hasattr(view, "CubeAxesVisibility"):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, "AxesGrid"):
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
            StateHandlers.create_parallel_projection_handler(pipeline, state)(
                parallel_projection, **kwargs
            )
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
        with VAppLayout(server, theme="dark"):
            from trame.widgets import html

            html.Component(GLOBAL_STYLES, **{"is": "style"})
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True),
                width=300,
                color="#1e1e1e",
                theme="dark",
            ):
                with vuetify.VContainer(classes="pa-3"):
                    # Header
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        html.Div(
                            f"Tally {mesh_data.tally_id}: {mesh_data.tally_name}",
                            classes="text-subtitle-1 font-weight-medium text-white",
                        )
                        with vuetify.VBtn(click=toggle_controls, size="small", icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-2")

                    # Score and Nuclide info
                    with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                        for label, value in [
                            ("Score", "current_score"),
                            ("Nuclide", "current_nuclide"),
                        ]:
                            with vuetify.VCol(
                                cols=6, classes="pa-0 pr-1" if label == "Score" else "pa-0 pl-1"
                            ):
                                with html.Div(
                                    style="background: #333; border-radius: 4px; padding: 4px 8px;"
                                ):
                                    html.Div(
                                        label,
                                        style="font-size: 10px; color: #888; text-transform: uppercase;",
                                    )
                                    html.Div(
                                        f"{{{{{value}}}}}",
                                        style="font-size: 13px; color: #fff; font-weight: 500;",
                                    )

                    # Mesh Info
                    html.Div(
                        "Mesh Info",
                        style="font-size: 11px; color: #888; text-transform: uppercase; margin: 8px 0 4px 0;",
                    )

                    with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                        for label, value in [
                            ("Type", "mesh_type"),
                            ("Dimensions", "mesh_dimensions"),
                        ]:
                            with vuetify.VCol(
                                cols=6, classes="pa-0 pr-1" if label == "Type" else "pa-0 pl-1"
                            ):
                                with html.Div(
                                    style="background: #333; border-radius: 4px; padding: 4px 8px;"
                                ):
                                    html.Div(label, style="font-size: 10px; color: #888;")
                                    html.Div(
                                        f"{{{{{value}}}}}", style="font-size: 12px; color: #fff;"
                                    )

                    for label, value in [
                        ("Bounds (cm)", "mesh_bounds"),
                        ("Data Range", "data_range"),
                    ]:
                        with vuetify.VRow(dense=True, classes="ma-0 mb-1"):
                            with vuetify.VCol(cols=12, classes="pa-0"):
                                with html.Div(
                                    style="background: #333; border-radius: 4px; padding: 4px 8px;"
                                ):
                                    html.Div(label, style="font-size: 10px; color: #888;")
                                    html.Div(
                                        f"{{{{{value}}}}}", style="font-size: 11px; color: #fff;"
                                    )

                    vuetify.VDivider(classes="mb-4")

                    # Controls
                    UIComponents.opacity_slider(vuetify)
                    UIComponents.representation_selector(vuetify)
                    UIComponents.color_by_selector(vuetify)

                    with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                        UIComponents.color_map_selector(vuetify, COLOR_MAPS)
                        vuetify.VCheckbox(
                            v_model=("show_scalar_bar", True),
                            label="Show Color Legend",
                            density="compact",
                            classes="mb-4",
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

                    vuetify.VListSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn(
                        "Save Screenshot",
                        click=save_screenshot,
                        block=True,
                        size="small",
                        color="primary",
                        classes="mb-2",
                    )

                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VListSubheader(
                            ("screenshot_status",), classes="text-caption justify-center"
                        )

            with vuetify.VMain():
                # Toggle button when controls are hidden
                with vuetify.VContainer(
                    v_if=("!show_controls",),
                    classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;",
                ):
                    vuetify.VBtn(
                        icon="mdi-chevron-right",
                        click=toggle_controls,
                        size="small",
                        color="primary",
                    )

                # Camera Navigation Gadget (Top Right)
                UIComponents.create_canvas_gadget(
                    vuetify,
                    pan_camera,
                    zoom_camera,
                    reset_callback=reset_camera,
                    view_callback=set_camera_view,
                )

                view_widget = pv_widgets.VtkRemoteView(
                    view, interactive_ratio=1, style="width: 100%; height: 100%;"
                )
                pipeline["view_widget"] = view_widget

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
                if pipeline.get("view_widget"):
                    pipeline["view_widget"].update()
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


@command("openmc.visualize-overlay", help="Overlay tally on geometry (slice or full 3D)")
@arg("statepoint", help="Path to statepoint file")
@arg("tally_id", type=int, help="Tally ID")
@arg("--geometry", help="Path to geometry .h5m (auto-detected if not provided)")
@arg("--score", help="Score name")
@arg("--nuclide", help="Nuclide name")
@arg("--colormap", help="Color map name")
@arg(
    "--mode",
    choices=["slice", "full"],
    default="slice",
    help="Visualization mode: slice or full 3D overlay",
)
@arg("--plane", choices=["x", "y", "z"], default="z", help="Slice plane (for slice mode)")
@arg("--position", type=float, help="Slice position in cm (default: center)")
@arg("--resolution", type=int, default=200, help="Slice plane resolution (50/100/200/400)")
@arg("--pixelated", action="store_true", help="Use blocky pixelated look (for slice mode)")
@arg(
    "--show-geometry", action="store_true", default=True, help="Show geometry outline (slice mode)"
)
@arg("--filter-graveyard", action="store_true", help="Filter graveyard surfaces")
@arg("--with-source", action="store_true", help="Overlay source particles from statepoint")
@arg("--max-source-particles", type=int, default=5000, help="Max source particles to visualize")
@arg("--port", type=int, help="Server port")
def cmd_visualize_overlay(args):
    """Overlay tally on geometry with slice-based or full 3D visualization."""
    try:
        from trame.app import get_server
        from trame.ui.vuetify3 import VAppLayout
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify3 as vuetify
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    if not HAS_OPENMC_API:
        print("Error: OpenMC API not available", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)

    try:
        exporter = OpenMCVTKExporter(args.statepoint)
        tally = exporter.get_tally(args.tally_id)

        # Determine tally type
        has_mesh = any(isinstance(f, openmc.MeshFilter) for f in tally.filters)

        if not has_mesh:
            print(
                "Error: Overlay only supports mesh tallies. Use openmc.visualize-mesh for other types.",
                file=sys.stderr,
            )
            return 1

        # Auto-detect geometry
        geometry_path = args.geometry
        if not geometry_path or not os.path.exists(geometry_path):
            geometry_path = exporter.find_geometry_file()

        # Try statepoint directory as fallback
        if not geometry_path or not os.path.exists(geometry_path):
            sp_dir = os.path.dirname(args.statepoint)
            candidates = [
                os.path.join(sp_dir, "geometry.h5m"),
                os.path.join(sp_dir, "dagmc.h5m"),
                os.path.join(sp_dir, "geometry.xml"),
            ]
            for cand in candidates:
                if os.path.exists(cand):
                    geometry_path = cand
                    break

        if not geometry_path or not os.path.exists(geometry_path):
            print(
                "Error: Geometry file not found. Provide --geometry or ensure geometry.h5m is in the run folder.",
                file=sys.stderr,
            )
            return 1

        print(f"[Overlay] Using geometry: {geometry_path}", file=sys.stderr)
        print(f"[Overlay] Mode: {args.mode}, Plane: {args.plane}", file=sys.stderr)

        # Create server
        server = get_server(client_type="vue3", port=port)
        state = server.state

        displays = []

        if args.mode == "slice":
            # === Slice mode ===
            from plugins.openmc.lib.slice_viz import create_slice_visualization

            # Use temp directory for output files (tempfile already imported at module level)
            slice_temp_dir = tempfile.mkdtemp(prefix="openmc_slice_")

            slice_result = create_slice_visualization(
                statepoint_file=args.statepoint,
                tally_id=args.tally_id,
                geometry_file=geometry_path,
                plane=args.plane,
                position=args.position,
                resolution=args.resolution,
                pixelated=args.pixelated,
                show_geometry=args.show_geometry,
                output_dir=slice_temp_dir,
            )

            array_name = slice_result.array_name
            data_range = slice_result.data_range

            # Load heatmap using XMLPolyDataReader (proper format for PolyData)
            print(f"[Slice] Loading heatmap from: {slice_result.heatmap_vtk_path}", file=sys.stderr)
            heatmap_source = simple.XMLPolyDataReader(FileName=slice_result.heatmap_vtk_path)
            heatmap_display = simple.Show(heatmap_source)
            heatmap_display.Representation = "Surface"

            # Debug: verify data loaded
            try:
                info = heatmap_source.GetDataInformation()
                n_pts = info.GetNumberOfPoints()
                n_cells = info.GetNumberOfCells()
                print(f"[Slice] Heatmap loaded: {n_pts} points, {n_cells} cells", file=sys.stderr)
            except Exception as e:
                print(f"[Slice] Warning: Could not get heatmap info: {e}", file=sys.stderr)

            # The data is always point data from vtkProbeFilter
            array_location = "POINTS"

            _setup_tally_coloring(
                heatmap_display, array_name, array_location, args.colormap or "Cool to Warm"
            )

            # Configure NaN handling - make NaN values transparent in heatmap
            heatmap_display.MapScalars = 1
            heatmap_display.Opacity = 1.0
            # Ensure proper interpolation for NaN handling
            if hasattr(heatmap_display, "UseNanForOutOfRange"):
                heatmap_display.UseNanForOutOfRange = 1

            displays.append(("heatmap", heatmap_display, heatmap_source))

            # Load geometry slice if available (also use XMLPolyDataReader)
            if slice_result.geometry_slice_vtk_path and args.show_geometry:
                print(
                    f"[Slice] Loading geometry slice from: {slice_result.geometry_slice_vtk_path}",
                    file=sys.stderr,
                )
                geom_slice_source = simple.XMLPolyDataReader(
                    FileName=slice_result.geometry_slice_vtk_path
                )

                geom_display = simple.Show(geom_slice_source)
                geom_display.Representation = "Wireframe"
                geom_display.DiffuseColor = [0.3, 0.3, 0.3]
                geom_display.Opacity = 0.5
                displays.append(("geometry_slice", geom_display, geom_slice_source))

                # Debug: verify geometry loaded
                try:
                    info = geom_slice_source.GetDataInformation()
                    n_pts = info.GetNumberOfPoints()
                    n_cells = info.GetNumberOfCells()
                    print(
                        f"[Slice] Geometry slice loaded: {n_pts} points, {n_cells} cells",
                        file=sys.stderr,
                    )
                except Exception as e:
                    print(f"[Slice] Warning: Could not get geometry info: {e}", file=sys.stderr)

            # Get view after all Show() calls - this is the pattern used by working commands
            view = simple.GetActiveViewOrCreate("RenderView")

            # Setup scalar bar
            lut = simple.GetColorTransferFunction(array_name)
            scalar_bar = simple.GetScalarBar(lut, view)
            if scalar_bar:
                scalar_bar.Visibility = 1
                scalar_bar.Title = array_name.replace("-", " ").title()

            # Render and reset camera
            simple.Render(view)
            simple.ResetCamera()

            state.overlay_type = "slice"
            state.slice_plane = args.plane
            state.slice_position = f"{slice_result.position:.2f}"
            state.slice_resolution = str(args.resolution)
            state.pixelated = args.pixelated

        else:
            # === Full 3D mode ===
            from plugins.openmc.lib.slice_viz import create_full_overlay

            overlay_result = create_full_overlay(
                statepoint_file=args.statepoint,
                tally_id=args.tally_id,
                geometry_file=geometry_path,
                score=args.score,
                nuclide=args.nuclide,
                filter_graveyard=args.filter_graveyard,
                pixelated=args.pixelated,
            )

            array_name = overlay_result["array_name"]
            data_range = overlay_result["data_range"]

            print(
                f"[Overlay] Loading full 3D overlay from: {overlay_result['vtk_path']}",
                file=sys.stderr,
            )
            mapped_source = simple.XMLUnstructuredGridReader(FileName=overlay_result["vtk_path"])

            geom_display = simple.Show(mapped_source)
            array_location = "CELLS" if args.pixelated else "POINTS"
            _setup_tally_coloring(
                geom_display, array_name, array_location, args.colormap or "Cool to Warm"
            )
            # Make geometry semi-transparent if showing source particles
            if args.with_source:
                geom_display.Opacity = 0.6
            displays.append(("geometry", geom_display, mapped_source))

            # Debug: verify data loaded
            try:
                info = mapped_source.GetDataInformation()
                n_pts = info.GetNumberOfPoints()
                n_cells = info.GetNumberOfCells()
                print(f"[Overlay] Full 3D loaded: {n_pts} points, {n_cells} cells", file=sys.stderr)
            except Exception as e:
                print(f"[Overlay] Warning: Could not get geometry info: {e}", file=sys.stderr)

            # Get view after Show()
            view = simple.GetActiveViewOrCreate("RenderView")

            # Setup scalar bar
            lut = simple.GetColorTransferFunction(array_name)
            scalar_bar = simple.GetScalarBar(lut, view)
            if scalar_bar:
                scalar_bar.Visibility = 1
                scalar_bar.Title = array_name.replace("-", " ").title()

            state.overlay_type = "full_3d"

            # Add source particles if requested
            if args.with_source:
                try:
                    import h5py

                    with h5py.File(args.statepoint, "r") as f:
                        if "source_bank" in f:
                            source_bank = f["source_bank"]
                            n_particles = min(len(source_bank), args.max_source_particles)

                            # Create vtkPolyData for source particles
                            source_points = vtk.vtkPoints()
                            source_energy = vtk.vtkDoubleArray()
                            source_energy.SetName("energy")

                            for i in range(n_particles):
                                particle = source_bank[i]
                                source_points.InsertNextPoint(
                                    float(particle["r"]["x"]),
                                    float(particle["r"]["y"]),
                                    float(particle["r"]["z"]),
                                )
                                source_energy.InsertNextValue(float(particle["E"]))

                            source_poly = vtk.vtkPolyData()
                            source_poly.SetPoints(source_points)

                            # Add vertices so points are renderable
                            verts = vtk.vtkCellArray()
                            for i in range(n_particles):
                                verts.InsertNextCell(1)
                                verts.InsertCellPoint(i)
                            source_poly.SetVerts(verts)

                            source_poly.GetPointData().AddArray(source_energy)
                            source_poly.GetPointData().SetActiveScalars("energy")

                            # Write to temp file
                            with tempfile.NamedTemporaryFile(suffix=".vtp", delete=False) as tmp:
                                source_tmp_path = tmp.name
                            writer = vtk.vtkXMLPolyDataWriter()
                            writer.SetFileName(source_tmp_path)
                            writer.SetInputData(source_poly)
                            writer.Write()

                            # Load into ParaView
                            source_reader = simple.XMLPolyDataReader(FileName=source_tmp_path)
                            source_display = simple.Show(source_reader, view)
                            source_display.Representation = "Points"
                            source_display.PointSize = 3.0
                            source_display.Opacity = 1.0
                            simple.ColorBy(source_display, ("POINTS", "energy"))
                            lut_source = simple.GetColorTransferFunction("energy")
                            lut_source.ApplyPreset("Plasma", True)

                            displays.append(("source", source_display, source_reader))
                            state.n_source_particles = n_particles
                            print(
                                f"[Overlay] Loaded {n_particles} source particles", file=sys.stderr
                            )
                        else:
                            print(
                                "[Overlay] Warning: No source_bank in statepoint", file=sys.stderr
                            )
                except Exception as e:
                    print(
                        f"[Overlay] Warning: Could not load source particles: {e}", file=sys.stderr
                    )

        # Common view setup
        bg_rgb = hex_to_rgb("#1a1a2e")
        view.Background = bg_rgb
        view.UseColorPaletteForBackground = 0
        view.OrientationAxesVisibility = 1

        pipeline = {"view": view, "view_widget": None}

        # Common state
        state.tally_id = int(tally.id)
        state.tally_name = str(tally.name)
        state.current_score = args.score or "default"
        state.current_nuclide = args.nuclide or "total"
        state.primary_display = "geometry"
        state.array_name = array_name
        state.data_range = f"[{data_range[0]:.6e}, {data_range[1]:.6e}]"

        # Source particles state (if present)
        if args.with_source:
            state.source_opacity = 1.0
            state.source_point_size = 3.0

        simple.Render(view)
        simple.ResetCamera()

        # Determine correct color_by prefix based on array location
        if displays:
            src = displays[0][2]
            src.UpdatePipeline()
            if src.PointData.GetArray(array_name):
                color_by_prefix = "Point"
            elif src.CellData.GetArray(array_name):
                color_by_prefix = "Cell"
            else:
                color_by_prefix = "Point"

        # Initialize common state
        init_common_state(
            state,
            theme="dark",
            opacity=0.6 if args.with_source else 1.0,
            color_by=f"{color_by_prefix}: {array_name}",
            show_scalar_bar=True,
            color_map=args.colormap or "Cool to Warm",
        )

        # Available arrays
        if displays:
            available_arrays = _get_available_arrays(displays[0][2])
            state.available_arrays = available_arrays

        # Update view function
        def update_view(push_camera=False):
            try:
                simple.Render(view)
                vw = pipeline.get("view_widget")
                if vw:
                    if push_camera:
                        state.camera_update_counter = (
                            (state.camera_update_counter + 1)
                            if hasattr(state, "camera_update_counter")
                            else 1
                        )
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)

        # State change handlers
        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            try:
                # Apply color changes to all displays (heatmap or geometry)
                target_display = None
                for name, display, _source in displays:
                    if name in ("heatmap", "geometry"):
                        target_display = display
                        break

                if not target_display:
                    return

                if color_by == "Solid Color":
                    simple.ColorBy(target_display, None)
                elif color_by.startswith("Point: "):
                    array_name = color_by[7:]
                    simple.ColorBy(target_display, ("POINTS", array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                elif color_by.startswith("Cell: "):
                    array_name = color_by[6:]
                    simple.ColorBy(target_display, ("CELLS", array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                update_view()
            except Exception as e:
                print(f"Error updating color by: {e}", file=sys.stderr)

        @state.change("color_map")
        def on_color_map_change(color_map, **kwargs):
            try:
                color_by = state.color_by
                if color_by == "Solid Color":
                    return

                array_name = None
                if color_by.startswith("Point: "):
                    array_name = color_by[7:]
                elif color_by.startswith("Cell: "):
                    array_name = color_by[6:]

                if array_name:
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(color_map, True)
                update_view()
            except Exception as e:
                print(f"Error updating color map: {e}", file=sys.stderr)

        @state.change("opacity")
        def on_opacity_change(opacity, **kwargs):
            try:
                for name, display, _source in displays:
                    if name != "source":
                        display.Opacity = float(opacity)
                update_view()
            except Exception as e:
                print(f"Error updating opacity: {e}", file=sys.stderr)

        @state.change("representation")
        def on_representation_change(representation, **kwargs):
            try:
                for name, display, _source in displays:
                    if name != "source":
                        display.Representation = representation
                update_view()
            except Exception as e:
                print(f"Error updating representation: {e}", file=sys.stderr)

        # Source-specific handlers (only if source particles are present)
        if args.with_source:

            @state.change("source_opacity")
            def on_source_opacity_change(source_opacity, **kwargs):
                try:
                    for name, display, _source in displays:
                        if name == "source":
                            display.Opacity = float(source_opacity)
                    update_view()
                except Exception as e:
                    print(f"Error updating source opacity: {e}", file=sys.stderr)

            @state.change("source_point_size")
            def on_source_point_size_change(source_point_size, **kwargs):
                try:
                    for name, display, _source in displays:
                        if name == "source":
                            display.PointSize = float(source_point_size)
                    update_view()
                except Exception as e:
                    print(f"Error updating source point size: {e}", file=sys.stderr)

        @state.change("show_scalar_bar")
        def on_scalar_bar_change(show_scalar_bar, **kwargs):
            try:
                color_by = state.color_by
                if color_by == "Solid Color":
                    return

                array_name = None
                if color_by.startswith("Point: "):
                    array_name = color_by[7:]
                elif color_by.startswith("Cell: "):
                    array_name = color_by[6:]

                if array_name:
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
                if rgb and view:
                    view.UseColorPaletteForBackground = 0
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

        @state.change("ambient_light")
        def on_ambient_light_change(ambient_light, **kwargs):
            try:
                val = float(ambient_light)
                for _name, display, _source in displays:
                    display.Ambient = val
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
                print(f"Error updating projection: {e}", file=sys.stderr)

        # Controllers
        reset_camera = create_reset_camera_controller(pipeline, update_view)
        set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
        pan_camera = create_pan_camera_controller(pipeline, update_view)
        zoom_camera = create_zoom_camera_controller(pipeline, update_view)
        capture_screenshot = create_capture_screenshot_controller(pipeline)

        def toggle_controls():
            state.show_controls = not state.show_controls
            return state.show_controls

        def save_screenshot():
            save_screenshot_with_timestamp(capture_screenshot, state)

        # UI
        with VAppLayout(server, theme="dark"):
            from trame.widgets import html

            html.Component(GLOBAL_STYLES, **{"is": "style"})
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True),
                width=320,
                color="#1e1e1e",
                theme="dark",
            ):
                with vuetify.VContainer(classes="pa-4"):
                    # Header
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        html.Div(
                            f"Tally {state.tally_id}: {state.tally_name}",
                            classes="text-subtitle-1 font-weight-medium text-white",
                        )
                        with vuetify.VBtn(click=toggle_controls, size="small", icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-4")

                    # Score and Nuclide
                    if hasattr(state, "current_score"):
                        with vuetify.VRow(dense=True, classes="ma-0 mb-2"):
                            for label, value in [
                                ("Score", "current_score"),
                                ("Nuclide", "current_nuclide"),
                            ]:
                                with vuetify.VCol(
                                    cols=6, classes="pa-0 pr-1" if label == "Score" else "pa-0 pl-1"
                                ):
                                    with html.Div(
                                        style="background: #333; border-radius: 4px; padding: 4px 8px;"
                                    ):
                                        html.Div(
                                            label,
                                            style="font-size: 10px; color: #888; text-transform: uppercase;",
                                        )
                                        html.Div(
                                            f"{{{{{value}}}}}",
                                            style="font-size: 13px; color: #fff; font-weight: 500;",
                                        )

                    # Slice info (only in slice mode)
                    if args.mode == "slice":
                        with html.Div(
                            style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"
                        ):
                            html.Div(
                                "Slice",
                                style="font-size: 10px; color: #888; text-transform: uppercase;",
                            )
                            html.Div(
                                "{{slice_plane.toUpperCase()}} = {{slice_position}} cm (res: {{slice_resolution}})",
                                style="font-size: 12px; color: #fff;",
                            )

                    # Overlay type (only in full 3D mode)
                    if args.mode == "full":
                        with html.Div(
                            style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"
                        ):
                            html.Div(
                                "Mode",
                                style="font-size: 10px; color: #888; text-transform: uppercase;",
                            )
                            html.Div(
                                "Full 3D Overlay",
                                style="font-size: 13px; color: #fff; font-weight: 500;",
                            )

                    # Source particles info and controls
                    if args.with_source:
                        vuetify.VDivider(classes="mb-4")
                        with html.Div(
                            style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"
                        ):
                            html.Div(
                                "Source Particles",
                                style="font-size: 10px; color: #888; text-transform: uppercase;",
                            )
                            html.Div(
                                "{{n_source_particles}} particles",
                                style="font-size: 13px; color: #fff; font-weight: 500;",
                            )

                        with vuetify.VContainer(classes="mb-4"):
                            html.Div(
                                "Source Opacity",
                                style="font-size: 11px; color: #aaa; margin-bottom: 4px;",
                            )
                            vuetify.VSlider(
                                v_model=("source_opacity", 1.0),
                                min=0,
                                max=1,
                                step=0.01,
                                density="compact",
                                hide_details=True,
                                thumb_label=True,
                            )

                        with vuetify.VContainer(classes="mb-4"):
                            html.Div(
                                "Source Point Size",
                                style="font-size: 11px; color: #aaa; margin-bottom: 4px;",
                            )
                            vuetify.VSlider(
                                v_model=("source_point_size", 3.0),
                                min=0.5,
                                max=10,
                                step=0.5,
                                density="compact",
                                hide_details=True,
                                thumb_label=True,
                            )

                    vuetify.VDivider(classes="mb-4")

                    # Controls
                    UIComponents.opacity_slider(vuetify)
                    UIComponents.representation_selector(vuetify)
                    UIComponents.color_by_selector(vuetify)

                    with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                        UIComponents.color_map_selector(vuetify, COLOR_MAPS)
                        vuetify.VCheckbox(
                            v_model=("show_scalar_bar", True),
                            label="Show Color Legend",
                            density="compact",
                            classes="mb-4",
                        )

                    vuetify.VDivider(classes="my-4")

                    # Compact toggles
                    UIComponents.compact_appearance_controls(vuetify)

                    # Detail sliders
                    UIComponents.point_size_slider(vuetify)
                    UIComponents.line_width_slider(vuetify)
                    UIComponents.ambient_light_slider(vuetify)

                    vuetify.VDivider(classes="my-4")

                    # Export
                    vuetify.VListSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn(
                        "Save Screenshot",
                        click=save_screenshot,
                        block=True,
                        size="small",
                        color="primary",
                        classes="mb-2",
                    )

                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VListSubheader(
                            ("screenshot_status",), classes="text-caption justify-center"
                        )

            with vuetify.VMain():
                # Toggle button when controls are hidden
                with vuetify.VContainer(
                    v_if=("!show_controls",),
                    classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;",
                ):
                    vuetify.VBtn(
                        icon="mdi-chevron-right",
                        click=toggle_controls,
                        size="small",
                        color="primary",
                    )

                # Camera Navigation Gadget
                UIComponents.create_canvas_gadget(
                    vuetify,
                    pan_camera,
                    zoom_camera,
                    reset_callback=reset_camera,
                    view_callback=set_camera_view,
                )

                view_widget = pv_widgets.VtkRemoteView(
                    view, interactive_ratio=1, style="width: 100%; height: 100%;"
                )
                pipeline["view_widget"] = view_widget

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
                if pipeline.get("view_widget"):
                    pipeline["view_widget"].update()
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


# Source visualization functions (unchanged from original)
def _visualize_source_common(source_poly, port, title="OpenMC Source"):
    """Common visualization logic for source distribution."""
    try:
        from trame.app import get_server
        from trame.ui.vuetify3 import VAppLayout
        from trame.widgets import paraview as pv_widgets
        from trame.widgets import vuetify3 as vuetify
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    try:
        with tempfile.NamedTemporaryFile(suffix=".vtp", delete=False) as tmp:
            tmp_path = tmp.name

        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetFileName(tmp_path)
        writer.SetInputData(source_poly)
        writer.Write()

        server = get_server(client_type="vue3", port=port)
        state = server.state

        init_common_state(state, theme="dark")
        state.point_size = 2.0
        state.color_map = "Plasma"
        state.show_scalar_bar = True
        state.color_by = "Point: energy"

        source_reader = simple.XMLPolyDataReader(FileName=tmp_path)

        available_arrays = ["Solid Color"]
        point_data = source_reader.PointData
        for i in range(point_data.GetNumberOfArrays()):
            array = point_data.GetArray(i)
            if array and array.GetName():
                available_arrays.append(f"Point: {array.GetName()}")

        state.available_arrays = available_arrays
        if "Point: energy" not in available_arrays:
            state.color_by = "Solid Color"

        display = simple.Show(source_reader)
        view = simple.GetActiveViewOrCreate("RenderView")

        display.Representation = "Points"
        display.PointSize = state.point_size

        if state.color_by != "Solid Color":
            simple.ColorBy(display, ("POINTS", "energy"))
            lut = simple.GetColorTransferFunction("energy")
            lut.ApplyPreset("Plasma", True)

        bg_rgb = hex_to_rgb(state.background_color_hex)
        view.Background = bg_rgb if bg_rgb else [0.1, 0.1, 0.15]
        view.UseColorPaletteForBackground = 0
        view.OrientationAxesVisibility = 1

        simple.Render(view)
        simple.ResetCamera()

        pipeline = {"source": source_reader, "display": display, "view": view, "view_widget": None}

        def update_view(push_camera=False):
            try:
                simple.Render(view)
                vw = pipeline.get("view_widget")
                if vw:
                    if push_camera:
                        state.camera_update_counter = (
                            state.camera_update_counter + 1
                            if hasattr(state, "camera_update_counter")
                            else 1
                        )
                    else:
                        vw.update()
            except Exception as e:
                print(f"Error updating view: {e}", file=sys.stderr)

        @state.change("color_by")
        def on_color_by_change(color_by, **kwargs):
            try:
                if color_by == "Solid Color":
                    simple.ColorBy(display, None)
                elif color_by.startswith("Point: "):
                    array_name = color_by[7:]
                    simple.ColorBy(display, ("POINTS", array_name))
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
                if hasattr(view, "CubeAxesVisibility"):
                    view.CubeAxesVisibility = 1 if show_cube_axes else 0
                elif hasattr(view, "AxesGrid"):
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
            StateHandlers.create_parallel_projection_handler(pipeline, state)(
                parallel_projection, **kwargs
            )
            update_view(True)

        reset_camera = create_reset_camera_controller(pipeline, update_view)
        set_camera_view = create_set_camera_view_controller(pipeline, state, update_view)
        pan_camera = create_pan_camera_controller(pipeline, update_view)
        zoom_camera = create_zoom_camera_controller(pipeline, update_view)
        capture_screenshot = create_capture_screenshot_controller(pipeline)

        def toggle_controls():
            state.show_controls = not state.show_controls
            return state.show_controls

        def save_screenshot():
            save_screenshot_with_timestamp(capture_screenshot, state)

        with VAppLayout(server, theme="dark"):
            from trame.widgets import html

            html.Component(GLOBAL_STYLES, **{"is": "style"})
            with vuetify.VNavigationDrawer(
                v_model=("show_controls", True),
                width=320,
                color="#1e1e1e",
                theme="dark",
            ):
                with vuetify.VContainer(classes="pa-4"):
                    with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                        vuetify.VListSubheader(title, classes="text-h6 pa-0")
                        with vuetify.VBtn(click=toggle_controls, size="small", icon=True):
                            vuetify.VIcon("mdi-chevron-left")
                    vuetify.VDivider(classes="mb-4")

                    with html.Div(
                        style="background: #333; border-radius: 4px; padding: 4px 8px; margin-bottom: 16px;"
                    ):
                        html.Div(
                            "Particles",
                            style="font-size: 10px; color: #888; text-transform: uppercase;",
                        )
                        html.Div(
                            str(source_poly.GetNumberOfPoints()),
                            style="font-size: 14px; color: #fff; font-weight: 500;",
                        )

                    vuetify.VDivider(classes="mb-4")

                    vuetify.VCheckbox(
                        v_model=("parallel_projection", False),
                        label="Parallel Projection (2D/Ortho)",
                        density="compact",
                        classes="mb-2",
                    )

                    UIComponents.point_size_slider(vuetify, ("point_size", 2.0), max=10)
                    UIComponents.ambient_light_slider(vuetify)

                    vuetify.VSelect(
                        v_model=("color_by", state.color_by),
                        items=("available_arrays",),
                        label="Color By",
                        density="compact",
                        variant="outlined",
                        classes="mb-4",
                        theme=("sidebar_dark ? 'dark' : 'light'",),
                    )

                    UIComponents.color_map_selector_short(vuetify)

                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", True),
                        label="Show Color Legend",
                        density="compact",
                        classes="mb-4",
                    )

                    vuetify.VDivider(classes="my-4")

                    UIComponents.compact_appearance_controls(vuetify)

                    vuetify.VDivider(classes="my-4")

                    vuetify.VListSubheader("Export", classes="text-subtitle-1 mb-2")
                    vuetify.VBtn(
                        "Save Screenshot",
                        click=save_screenshot,
                        block=True,
                        size="small",
                        color="primary",
                        classes="mb-2",
                    )

                    with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                        vuetify.VListSubheader(
                            ("screenshot_status",), classes="text-caption justify-center"
                        )

            with vuetify.VMain():
                with vuetify.VContainer(
                    v_if=("!show_controls",),
                    classes="ma-2 pa-0",
                    style="position: absolute; top: 0; left: 0; z-index: 100;",
                ):
                    vuetify.VBtn(
                        icon="mdi-chevron-right",
                        click=toggle_controls,
                        size="small",
                        color="primary",
                    )

                UIComponents.create_canvas_gadget(
                    vuetify,
                    pan_camera,
                    zoom_camera,
                    reset_callback=reset_camera,
                    view_callback=set_camera_view,
                )

                view_widget = pv_widgets.VtkRemoteView(
                    view, interactive_ratio=1, style="width: 100%; height: 100%;"
                )
                pipeline["view_widget"] = view_widget

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
                if pipeline.get("view_widget"):
                    pipeline["view_widget"].update()
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


@command("openmc.visualize-source", help="Visualize source distribution")
@arg("source", help="Path to source.h5 file")
@arg("--port", type=int, help="Server port")
def cmd_visualize_source(args):
    """Visualize source distribution from source.h5 file."""
    port = args.port or find_free_port(8090)
    try:
        from plugins.openmc.lib.reader import OpenMCReader

        reader = OpenMCReader()
        source_poly = reader.load_source(args.source)
        return _visualize_source_common(source_poly, port, title="OpenMC Source")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        return 1


@command("openmc.visualize-statepoint-source", help="Visualize source from statepoint")
@arg("statepoint", help="Path to statepoint file")
@arg("--port", type=int, help="Server port")
@arg("--max-particles", type=int, default=5000, help="Max particles to visualize")
def cmd_visualize_statepoint_source(args):
    """Visualize source distribution from statepoint file."""
    try:
        import h5py
    except ImportError as e:
        print(f"Error: Required dependencies not installed: {e}", file=sys.stderr)
        return 1

    port = args.port or find_free_port(8090)
    max_particles = getattr(args, "max_particles", 5000)

    try:
        with h5py.File(args.statepoint, "r") as f:
            if "source_bank" not in f:
                print(json.dumps({"error": "No source_bank in statepoint"}), file=sys.stderr)
                return 1

            source_bank = f["source_bank"]
            n_particles = len(source_bank)

            max_viz = min(max_particles, n_particles)
            stride = n_particles // max_viz if n_particles > max_viz else 1

            points = vtk.vtkPoints()
            energies = vtk.vtkFloatArray()
            energies.SetName("energy")
            weights = vtk.vtkFloatArray()
            weights.SetName("weight")

            for i in range(0, n_particles, stride):
                if points.GetNumberOfPoints() >= max_viz:
                    break

                particle = source_bank[i]
                r = particle["r"]
                points.InsertNextPoint(float(r[0]), float(r[1]), float(r[2]))
                energies.InsertNextValue(float(particle["E"]))
                weights.InsertNextValue(float(particle["wgt"]))

            polydata = vtk.vtkPolyData()
            polydata.SetPoints(points)

            polydata.GetPointData().AddArray(energies)
            polydata.GetPointData().AddArray(weights)
            polydata.GetPointData().SetActiveScalars("energy")

            verts = vtk.vtkCellArray()
            for i in range(points.GetNumberOfPoints()):
                verts.InsertNextCell(1)
                verts.InsertCellPoint(i)
            polydata.SetVerts(verts)

        return _visualize_source_common(polydata, port, title="Source (from Statepoint)")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        return 1
