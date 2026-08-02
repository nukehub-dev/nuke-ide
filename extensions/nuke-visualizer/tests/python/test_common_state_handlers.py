"""Tests for plugins.base.lib.common — state, handlers, controllers, helpers.

These tests exercise everything that can be constructed without trame,
ParaView, or VTK: state dataclasses, StateHandlers factories, camera
controllers, update/screenshot helpers, and dependency probes. ParaView
proxies and trame state objects are replaced by small fakes.

The module has numpy at its top level, so the whole test module is
skipped when numpy is unavailable.
"""

import socket
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from plugins.base.lib.common import (  # noqa: E402
    StateHandlers,
    VisualizerState,
    _register_composite_data_serializers,
    calculate_camera_position,
    check_openmc_dependencies,
    check_trame_dependencies,
    create_capture_screenshot_controller,
    create_control_panel,
    create_main_content,
    create_pan_camera_controller,
    create_reset_camera_controller,
    create_set_camera_view_controller,
    create_update_view,
    create_view_widget,
    create_zoom_camera_controller,
    find_free_port,
    get_available_arrays,
    get_data_bounds,
    init_common_state,
    save_screenshot_with_timestamp,
    update_view_widget,
)


class FakeWidget:
    """Stand-in for a vuetify widget: records construction and supports 'with'."""

    def __init__(self, tag, *args, **kwargs):
        self.tag = tag
        self.args = args
        self.kwargs = kwargs
        self.server = SimpleNamespace(state={})

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeVuetify:
    """Module stand-in whose attributes are widget factories."""

    def __init__(self):
        self.created = []

    def __getattr__(self, name):
        def factory(*args, **kwargs):
            widget = FakeWidget(name, *args, **kwargs)
            self.created.append(widget)
            return widget

        return factory

    def by_tag(self, tag):
        return [w for w in self.created if w.tag == tag]


# ---------------------------------------------------------------------------
# get_data_bounds / get_available_arrays
# ---------------------------------------------------------------------------


def test_get_data_bounds_from_source():
    """Bounds are pulled from the source's data information."""
    source = SimpleNamespace(
        GetDataInformation=lambda: SimpleNamespace(GetBounds=lambda: [0, 5, 1, 2, 3, 4])
    )
    assert get_data_bounds(source) == [0, 5, 1, 2, 3, 4]


def test_get_data_bounds_fallbacks():
    """None or broken sources yield the default unit box."""
    assert get_data_bounds(None) == [-1, 1, -1, 1, -1, 1]

    def _raise():
        raise RuntimeError("no data")

    assert get_data_bounds(SimpleNamespace(GetDataInformation=_raise)) == [-1, 1, -1, 1, -1, 1]


def _fake_array(name):
    return SimpleNamespace(GetName=lambda: name)


def _fake_array_container(arrays):
    return SimpleNamespace(
        GetNumberOfArrays=lambda: len(arrays),
        GetArray=lambda i: arrays[i],
    )


def test_get_available_arrays_collects_point_and_cell_arrays():
    """Point and cell arrays are listed with their prefixes; nameless arrays skipped."""
    source = SimpleNamespace(
        PointData=_fake_array_container([_fake_array("temp"), _fake_array("")]),
        CellData=_fake_array_container([_fake_array("density")]),
    )
    assert get_available_arrays(source) == ["Solid Color", "Point: temp", "Cell: density"]


def test_get_available_arrays_none_source():
    """A missing source yields only the Solid Color entry."""
    assert get_available_arrays(None) == ["Solid Color"]


def test_get_available_arrays_broken_source_warns(capsys):
    """A source that raises is reported and yields only Solid Color."""

    class _Bad:
        @property
        def PointData(self):
            raise RuntimeError("boom")

    assert get_available_arrays(_Bad()) == ["Solid Color"]
    assert "Could not get data arrays" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# VisualizerState / init_common_state
# ---------------------------------------------------------------------------


def test_visualizer_state_defaults():
    """The dataclass carries the documented default values."""
    state = VisualizerState()
    assert state.opacity == 1.0
    assert state.representation == "Surface"
    assert state.ui_theme == "dark"
    assert state.timestep_values == []
    assert state.available_arrays == ["Solid Color"]


def test_visualizer_state_from_defaults_overrides_known_keys_only():
    """Overrides apply to known fields; unknown keys are ignored."""
    state = VisualizerState.from_defaults(opacity=0.5, ui_theme="light", bogus="ignored")
    assert state.opacity == 0.5
    assert state.ui_theme == "light"
    assert not hasattr(state, "bogus")


def test_visualizer_state_apply_to_state():
    """apply_to_state copies every field onto the target object."""
    vs = VisualizerState.from_defaults(opacity=0.25)
    target = SimpleNamespace()
    vs.apply_to_state(target)
    assert target.opacity == 0.25
    assert target.color_map == "Cool to Warm"
    assert target.show_camera_gadget is True


def test_init_common_state_dark_theme():
    """Dark theme keeps the dark sidebar colors and applies overrides."""
    target = SimpleNamespace()
    vs = init_common_state(target, theme="dark", point_size=4.0)
    assert target.sidebar_color == "#1e1e1e"
    assert target.sidebar_dark is True
    assert target.background_color_hex == "#1a1a26"
    assert target.point_size == 4.0
    assert vs.point_size == 4.0


def test_init_common_state_light_theme():
    """Light theme switches sidebar and background colors."""
    target = SimpleNamespace()
    init_common_state(target, theme="light")
    assert target.sidebar_color == "#f5f5f5"
    assert target.sidebar_dark is False
    assert target.background_color_hex == "#ffffff"
    assert target.ui_theme == "light"


# ---------------------------------------------------------------------------
# Port helpers — exhausted-range error path
# ---------------------------------------------------------------------------


def test_find_free_port_raises_when_range_exhausted():
    """A fully occupied range raises RuntimeError."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as blocker:
        blocker.bind(("", 0))
        occupied = blocker.getsockname()[1]

        with pytest.raises(RuntimeError, match="No free port"):
            find_free_port(start_port=occupied, max_port=occupied + 1)


# ---------------------------------------------------------------------------
# StateHandlers
# ---------------------------------------------------------------------------


def test_opacity_handler_sets_display_opacity():
    display = SimpleNamespace()
    handler = StateHandlers.create_opacity_handler({"display": display})
    handler(0.4)
    assert display.Opacity == pytest.approx(0.4)


def test_opacity_handler_missing_display_is_noop():
    StateHandlers.create_opacity_handler({})(0.4)  # must not raise


def test_opacity_handler_bad_value_reports_error(capsys):
    handler = StateHandlers.create_opacity_handler({"display": SimpleNamespace()})
    handler("not-a-number")
    assert "Error updating opacity" in capsys.readouterr().out


def test_representation_handler_updates_display_and_state_counter():
    display = SimpleNamespace()
    state = SimpleNamespace(appearance_update=3)
    handler = StateHandlers.create_representation_handler({"display": display}, state)
    handler("Wireframe")
    assert display.Representation == "Wireframe"
    assert state.appearance_update == 4


def test_representation_handler_initializes_missing_counter():
    display = SimpleNamespace()
    state = SimpleNamespace()
    StateHandlers.create_representation_handler({"display": display}, state)("Points")
    assert state.appearance_update == 1


def test_representation_handler_missing_display_is_noop():
    StateHandlers.create_representation_handler({}, SimpleNamespace())("Points")


def test_background_handler_sets_rgb_background():
    view = SimpleNamespace()
    handler = StateHandlers.create_background_handler({"view": view})
    handler("#ff0000")
    assert view.Background == [1.0, 0.0, 0.0]
    assert view.UseColorPaletteForBackground == 0


def test_background_handler_invalid_hex_leaves_view_untouched():
    view = SimpleNamespace()
    StateHandlers.create_background_handler({"view": view})("#zzzzzz")
    assert not hasattr(view, "Background")


def test_background_handler_tolerates_palette_failure():
    """A view that rejects UseColorPaletteForBackground still gets Background set."""

    class _View:
        def __setattr__(self, name, value):
            if name == "UseColorPaletteForBackground":
                raise RuntimeError("unsupported")
            super().__setattr__(name, value)

    view = _View()
    StateHandlers.create_background_handler({"view": view})("#00ff00")
    assert view.Background == [0.0, 1.0, 0.0]


def test_background_handler_missing_view_is_noop():
    StateHandlers.create_background_handler({})("#ff0000")


class _FakeLut:
    def __init__(self):
        self.presets = []

    def ApplyPreset(self, name, flag):
        self.presets.append((name, flag))


class _FakeSimple:
    """Records ParaView simple-module calls."""

    def __init__(self):
        self.color_by_calls = []
        self.luts = {}

    def ColorBy(self, display, value):
        self.color_by_calls.append(value)

    def GetColorTransferFunction(self, array_name):
        return self.luts.setdefault(array_name, _FakeLut())

    def GetScalarBar(self, lut, view):
        return self.scalar_bar


def test_color_by_handler_solid_color():
    simple = _FakeSimple()
    display = SimpleNamespace(scalar_coloring_calls=[])
    display.SetScalarColoring = lambda *args: display.scalar_coloring_calls.append(args)
    pipeline = {"display": display, "view": SimpleNamespace()}
    StateHandlers.create_color_by_handler(pipeline, SimpleNamespace(), simple)("Solid Color")
    # ColorBy(display, None) is broken in ParaView 6.1 without a current
    # association, so the handler resets via SetScalarColoring directly.
    assert display.scalar_coloring_calls == [(None, 0)]
    assert simple.color_by_calls == []


def test_color_by_handler_point_and_cell_arrays_apply_preset():
    simple = _FakeSimple()
    state = SimpleNamespace(color_map="Viridis")
    pipeline = {"display": SimpleNamespace(), "view": SimpleNamespace()}
    handler = StateHandlers.create_color_by_handler(pipeline, state, simple)

    handler("Point: temperature")
    assert simple.color_by_calls[-1] == ("POINTS", "temperature")
    assert simple.luts["temperature"].presets == [("Viridis", True)]

    handler("Cell: density")
    assert simple.color_by_calls[-1] == ("CELLS", "density")
    assert simple.luts["density"].presets == [("Viridis", True)]


def test_color_by_handler_missing_pipeline_is_noop():
    simple = _FakeSimple()
    StateHandlers.create_color_by_handler({}, SimpleNamespace(), simple)("Point: x")
    assert simple.color_by_calls == []


def test_color_map_handler_solid_color_is_noop():
    simple = _FakeSimple()
    state = SimpleNamespace(color_by="Solid Color")
    StateHandlers.create_color_map_handler({}, state, simple)("Jet")
    assert simple.luts == {}


def test_color_map_handler_applies_preset_for_array():
    simple = _FakeSimple()
    state = SimpleNamespace(color_by="Point: temperature")
    StateHandlers.create_color_map_handler({}, state, simple)("Jet")
    assert simple.luts["temperature"].presets == [("Jet", True)]


def test_scalar_bar_handler_toggles_visibility():
    simple = _FakeSimple()
    simple.scalar_bar = SimpleNamespace()
    state = SimpleNamespace(color_by="Cell: density")
    pipeline = {"view": SimpleNamespace()}
    handler = StateHandlers.create_scalar_bar_handler(pipeline, state, simple)

    handler(True)
    assert simple.scalar_bar.Visibility is True
    handler(False)
    assert simple.scalar_bar.Visibility is False


def test_scalar_bar_handler_noop_for_solid_color_or_missing_view():
    simple = _FakeSimple()
    simple.scalar_bar = SimpleNamespace()
    handler = StateHandlers.create_scalar_bar_handler(
        {"view": SimpleNamespace()}, SimpleNamespace(color_by="Solid Color"), simple
    )
    handler(True)
    assert not hasattr(simple.scalar_bar, "Visibility")

    handler = StateHandlers.create_scalar_bar_handler(
        {}, SimpleNamespace(color_by="Point: x"), simple
    )
    handler(True)
    assert not hasattr(simple.scalar_bar, "Visibility")


def test_scalar_bar_handler_none_scalar_bar_is_noop():
    simple = _FakeSimple()
    simple.scalar_bar = None
    state = SimpleNamespace(color_by="Point: x")
    StateHandlers.create_scalar_bar_handler({"view": SimpleNamespace()}, state, simple)(True)


def test_orientation_axes_handler():
    view = SimpleNamespace()
    handler = StateHandlers.create_orientation_axes_handler({"view": view})
    handler(1)
    assert view.OrientationAxesVisibility is True
    handler(0)
    assert view.OrientationAxesVisibility is False
    StateHandlers.create_orientation_axes_handler({})(True)  # no view: no-op


def test_point_size_line_width_ambient_handlers():
    display = SimpleNamespace()
    pipeline = {"display": display}
    StateHandlers.create_point_size_handler(pipeline)(3.5)
    StateHandlers.create_line_width_handler(pipeline)(2.5)
    StateHandlers.create_ambient_light_handler(pipeline)(0.6)
    assert display.PointSize == pytest.approx(3.5)
    assert display.LineWidth == pytest.approx(2.5)
    assert display.Ambient == pytest.approx(0.6)

    # Missing displays are no-ops.
    StateHandlers.create_point_size_handler({})(3.5)
    StateHandlers.create_line_width_handler({})(2.5)
    StateHandlers.create_ambient_light_handler({})(0.6)


def test_parallel_projection_handler_toggles_camera_and_counter():
    view = SimpleNamespace()
    state = SimpleNamespace(camera_update_counter=0)
    handler = StateHandlers.create_parallel_projection_handler({"view": view}, state)
    handler(True)
    assert view.CameraParallelProjection == 1
    assert state.camera_update_counter == 1
    handler(False)
    assert view.CameraParallelProjection == 0
    assert state.camera_update_counter == 2


def test_parallel_projection_handler_state_without_counter():
    view = SimpleNamespace()
    StateHandlers.create_parallel_projection_handler({"view": view}, SimpleNamespace())(True)
    assert view.CameraParallelProjection == 1


# ---------------------------------------------------------------------------
# Camera controllers
# ---------------------------------------------------------------------------


def _camera_view():
    return SimpleNamespace(
        CameraPosition=[0.0, -10.0, 0.0],
        CameraFocalPoint=[0.0, 0.0, 0.0],
        CameraViewUp=[0.0, 0.0, 1.0],
    )


def test_reset_camera_controller_without_view_still_pushes_update():
    calls = []
    reset = create_reset_camera_controller({}, lambda push_camera: calls.append(push_camera))
    assert reset() is True
    assert calls == [True]


def test_reset_camera_controller_with_view_fails_without_paraview(capsys):
    """paraview is not installed here, so the render path reports failure."""
    reset = create_reset_camera_controller({"view": SimpleNamespace()}, lambda push_camera: None)
    assert reset() is False
    assert "Error resetting camera" in capsys.readouterr().out


def test_set_camera_view_controller_without_view_returns_false():
    set_view = create_set_camera_view_controller({}, SimpleNamespace(), lambda push_camera: None)
    assert set_view("front") is False


def test_set_camera_view_controller_sets_camera_then_fails_on_render():
    """Camera attributes are assigned before the paraview import fails."""
    view = SimpleNamespace()
    source = SimpleNamespace(
        GetDataInformation=lambda: SimpleNamespace(GetBounds=lambda: [-1, 1, -1, 1, -1, 1])
    )
    pipeline = {"view": view, "source": source}
    updates = []
    set_view = create_set_camera_view_controller(
        pipeline, SimpleNamespace(), lambda push_camera: updates.append(push_camera)
    )

    assert set_view("right") is False  # paraview missing -> render fails
    distance = (12**0.5) * 2.2
    assert view.CameraPosition == pytest.approx([distance, 0, 0])
    assert view.CameraFocalPoint == pytest.approx([0, 0, 0])
    assert view.CameraViewUp == [0, 0, 1]


def test_set_camera_view_controller_uses_original_source_fallback():
    """pipeline['original_source'] is used when 'source' is absent."""
    view = SimpleNamespace()
    updates = []
    set_view = create_set_camera_view_controller(
        {"view": view, "original_source": None},
        SimpleNamespace(),
        lambda push_camera: updates.append(push_camera),
    )
    assert set_view("weird-view") is False
    # Unknown view type falls back to isometric around the default bounds.
    expected = calculate_camera_position("isometric", [-1, 1, -1, 1, -1, 1])
    assert view.CameraPosition == pytest.approx(expected[0])


def test_pan_camera_controller_moves_position_and_focal():
    view = _camera_view()
    updates = []
    pan = create_pan_camera_controller({"view": view}, lambda push_camera: updates.append(True))

    assert pan("up") is True
    assert updates == [True]
    # Focal point and position move together.
    assert np.allclose(np.array(view.CameraPosition) - np.array(view.CameraFocalPoint), [0, -10, 0])
    assert np.linalg.norm(view.CameraFocalPoint) > 0


def test_pan_camera_controller_all_directions_and_unknown():
    for direction in ["up", "down", "left", "right"]:
        view = _camera_view()
        pan = create_pan_camera_controller({"view": view}, lambda push_camera: None)
        assert pan(direction) is True
        assert np.linalg.norm(view.CameraFocalPoint) == pytest.approx(10 * 0.15)

    view = _camera_view()
    pan = create_pan_camera_controller({"view": view}, lambda push_camera: None)
    assert pan("diagonal") is True
    # Unknown direction: no movement.
    assert view.CameraFocalPoint == pytest.approx([0, 0, 0])


def test_pan_camera_controller_degenerate_view_vector():
    """Zero camera distance uses the default view vector and step 1.0."""
    view = SimpleNamespace(
        CameraPosition=[1.0, 2.0, 3.0],
        CameraFocalPoint=[1.0, 2.0, 3.0],
        CameraViewUp=[0.0, 0.0, 1.0],
    )
    pan = create_pan_camera_controller({"view": view}, lambda push_camera: None)
    assert pan("right") is True
    assert not np.allclose(view.CameraFocalPoint, [1.0, 2.0, 3.0])


def test_pan_camera_controller_without_view_returns_false():
    pan = create_pan_camera_controller({}, lambda push_camera: None)
    assert pan("up") is False


def test_zoom_camera_controller_perspective_dollies():
    view = _camera_view()
    zoom = create_zoom_camera_controller({"view": view}, lambda push_camera: None)
    assert zoom(0.5) is True
    assert view.CameraPosition == pytest.approx([0, -5, 0])
    assert view.CameraFocalPoint == pytest.approx([0, 0, 0])


def test_zoom_camera_controller_parallel_scales():
    view = _camera_view()
    view.CameraParallelProjection = 1
    view.CameraParallelScale = 4.0
    zoom = create_zoom_camera_controller({"view": view}, lambda push_camera: None)
    assert zoom(2.0) is True
    assert view.CameraParallelScale == pytest.approx(8.0)
    assert view.CameraPosition == pytest.approx([0, -10, 0])  # unchanged


def test_zoom_camera_controller_without_view_returns_false():
    zoom = create_zoom_camera_controller({}, lambda push_camera: None)
    assert zoom(0.5) is False


def test_capture_screenshot_controller_without_view():
    capture = create_capture_screenshot_controller({})
    result = capture()
    assert result["success"] is False
    assert "No view available" in result["error"]


def test_capture_screenshot_controller_restores_view_on_failure():
    """Without paraview the capture fails, but background/size are restored."""
    view = SimpleNamespace(Background=[0.1, 0.2, 0.3], ViewSize=[800, 600])
    capture = create_capture_screenshot_controller({"view": view})
    result = capture(width=1024, height=768, transparent=True)

    assert result["success"] is False
    assert result["error"]
    assert view.Background == [0.1, 0.2, 0.3]
    assert view.ViewSize == [800, 600]


# ---------------------------------------------------------------------------
# create_update_view
# ---------------------------------------------------------------------------


def test_update_view_renders_and_updates_widget():
    render_calls = []

    class _Simple:
        @staticmethod
        def Render(view):
            render_calls.append(view)

    view = SimpleNamespace()
    widget = SimpleNamespace(update=lambda: render_calls.append("widget"))
    pipeline = {"view": view, "view_widget": widget}
    update = create_update_view(pipeline, SimpleNamespace(), _Simple)

    update()
    assert render_calls == [view, "widget"]


def test_update_view_push_camera_increments_counter():
    class _Simple:
        @staticmethod
        def Render(view):
            pass

    state = SimpleNamespace(
        camera_update_counter=0, view_widget=SimpleNamespace(update=lambda: None)
    )
    update = create_update_view({"view": SimpleNamespace()}, state, _Simple)
    update(push_camera=True)
    assert state.camera_update_counter == 1


def test_update_view_tolerates_render_failure(capsys):
    class _Simple:
        @staticmethod
        def Render(view):
            raise RuntimeError("render failed")

    update = create_update_view({"view": SimpleNamespace()}, SimpleNamespace(), _Simple)
    update()
    assert "Error updating view" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# create_view_widget / update_view_widget
# ---------------------------------------------------------------------------


def test_create_view_widget_defaults_to_local(monkeypatch):
    monkeypatch.delenv("NUKE_VISUALIZER_RENDER_MODE", raising=False)
    widget = create_view_widget(FakeVuetify(), SimpleNamespace(), "myView")
    assert widget.tag == "VtkRemoteLocalView"
    assert widget.kwargs["namespace"] == "myView"
    assert widget.kwargs["mode"] == ("myViewMode", "local")
    assert widget.kwargs["disable_auto_switch"] is True
    assert widget.kwargs["interactive_ratio"] == 1
    # The initial mode is written to state (VtkRemoteLocalView does not do it).
    assert widget.server.state["myViewMode"] == "local"
    # The namespace is stashed so update helpers can find the mode variable.
    assert widget._nuke_view_namespace == "myView"


def test_create_view_widget_reads_env(monkeypatch):
    monkeypatch.setenv("NUKE_VISUALIZER_RENDER_MODE", "remote")
    widget = create_view_widget(FakeVuetify(), SimpleNamespace(), "myView")
    assert widget.kwargs["mode"] == ("myViewMode", "remote")


def test_create_view_widget_ignores_invalid_env(monkeypatch):
    monkeypatch.setenv("NUKE_VISUALIZER_RENDER_MODE", "bogus")
    widget = create_view_widget(FakeVuetify(), SimpleNamespace(), "myView")
    assert widget.kwargs["mode"] == ("myViewMode", "local")


def test_create_view_widget_explicit_mode_overrides_env(monkeypatch):
    monkeypatch.setenv("NUKE_VISUALIZER_RENDER_MODE", "remote")
    widget = create_view_widget(FakeVuetify(), SimpleNamespace(), "myView", default_mode="local")
    assert widget.kwargs["mode"] == ("myViewMode", "local")


# ---------------------------------------------------------------------------
# _register_composite_data_serializers
# ---------------------------------------------------------------------------


def _stub_trame_vtk(monkeypatch, serializers):
    """Put a fake trame_vtk serializers package into sys.modules."""
    initialized = []

    def serialize(parent, data, obj_id, context, depth):
        return ("serialized", data)

    monkeypatch.setitem(
        sys.modules,
        "trame_vtk.modules.vtk.serializers",
        SimpleNamespace(initialize_serializers=lambda: initialized.append(True)),
    )
    monkeypatch.setitem(
        sys.modules,
        "trame_vtk.modules.vtk.serializers.registry",
        SimpleNamespace(SERIALIZERS=serializers),
    )
    monkeypatch.setitem(
        sys.modules,
        "trame_vtk.modules.vtk.serializers.serialize",
        SimpleNamespace(serialize=serialize),
    )
    return initialized


class _FakeGeometryFilter:
    def __init__(self):
        self.input = None

    def SetInputDataObject(self, obj):
        self.input = obj

    def Update(self):
        pass

    def GetOutput(self):
        return "polydata"


def test_register_composite_data_serializers_missing_trame_vtk(monkeypatch):
    # Force the absence so the test passes even where trame-vtk is installed.
    monkeypatch.setitem(sys.modules, "trame_vtk", None)
    monkeypatch.setitem(sys.modules, "trame_vtk.modules.vtk.serializers", None)
    _register_composite_data_serializers()  # must not raise


def test_register_composite_data_serializers_registers(monkeypatch):
    serializers = {}
    initialized = _stub_trame_vtk(monkeypatch, serializers)
    monkeypatch.setitem(
        sys.modules,
        "vtkmodules.vtkFiltersGeometry",
        SimpleNamespace(vtkCompositeDataGeometryFilter=_FakeGeometryFilter),
    )

    _register_composite_data_serializers()

    assert initialized == [True]
    assert set(serializers) == {"vtkPartitionedDataSetCollection", "vtkPartitionedDataSet"}
    # The serializer flattens composite input to polydata and delegates.
    assert serializers["vtkPartitionedDataSet"](None, "composite", "id", None, 0) == (
        "serialized",
        "polydata",
    )


def test_register_composite_data_serializers_already_registered(monkeypatch):
    existing = object()
    serializers = {"vtkPartitionedDataSetCollection": existing}
    initialized = _stub_trame_vtk(monkeypatch, serializers)

    _register_composite_data_serializers()

    assert initialized == [True]
    assert serializers == {"vtkPartitionedDataSetCollection": existing}


def _recording_widget():
    calls = []
    widget = SimpleNamespace(
        update=lambda: calls.append("update"),
        update_image=lambda: calls.append("image"),
        update_geometry=lambda: calls.append("geometry"),
    )
    return widget, calls


def test_update_view_widget_pushes_geometry_in_local_mode():
    widget, calls = _recording_widget()
    widget._nuke_view_namespace = "myView"
    update_view_widget(widget, SimpleNamespace(myViewMode="local"))
    assert calls == ["geometry"]


def test_update_view_widget_pushes_image_in_remote_mode():
    widget, calls = _recording_widget()
    widget._nuke_view_namespace = "myView"
    update_view_widget(widget, SimpleNamespace(myViewMode="remote"))
    assert calls == ["image"]


def test_update_view_widget_falls_back_to_update():
    calls = []
    widget = SimpleNamespace(update=lambda: calls.append("update"))
    update_view_widget(widget, SimpleNamespace())
    assert calls == ["update"]


# ---------------------------------------------------------------------------
# save_screenshot_with_timestamp
# ---------------------------------------------------------------------------


def test_save_screenshot_with_timestamp_success(tmp_path):
    state = SimpleNamespace(screenshot_status="")
    capture = lambda filename=None: {"success": True}  # noqa: E731

    save_screenshot_with_timestamp(capture, state, directory=str(tmp_path))
    assert state.screenshot_status.startswith("Saved: screenshot_")
    assert state.screenshot_status.endswith(".png")


def test_save_screenshot_with_timestamp_failure(tmp_path):
    state = SimpleNamespace(screenshot_status="")
    capture = lambda filename=None: {"success": False, "error": "boom"}  # noqa: E731

    save_screenshot_with_timestamp(capture, state, directory=str(tmp_path))
    assert state.screenshot_status == "Error: boom"


# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------


def test_check_trame_dependencies_missing_in_this_env():
    """trame and paraview are not installed here, so both errors are reported."""
    ok, errors = check_trame_dependencies()
    if "trame" not in sys.modules and "paraview" not in sys.modules:
        assert ok is False
        assert len(errors) == 2


def test_check_trame_dependencies_with_fakes(monkeypatch):
    """With trame.app and paraview.simple importable, the check passes."""
    fake_trame = types.ModuleType("trame")
    fake_trame_app = types.ModuleType("trame.app")
    fake_trame.app = fake_trame_app
    fake_paraview = types.ModuleType("paraview")
    fake_paraview_simple = types.ModuleType("paraview.simple")
    fake_paraview.simple = fake_paraview_simple
    monkeypatch.setitem(sys.modules, "trame", fake_trame)
    monkeypatch.setitem(sys.modules, "trame.app", fake_trame_app)
    monkeypatch.setitem(sys.modules, "paraview", fake_paraview)
    monkeypatch.setitem(sys.modules, "paraview.simple", fake_paraview_simple)

    ok, errors = check_trame_dependencies()
    assert ok is True
    assert errors == []


def test_check_trame_dependencies_broken_trame_install(monkeypatch):
    """trame imports but trame.app does not → broken-install hint, not 'not installed'.

    This is the pip/conda clobbering case: a fake top-level trame without
    __path__ makes `import trame.app` fail while `import trame` succeeds.
    """
    fake_trame = types.ModuleType("trame")
    fake_paraview = types.ModuleType("paraview")
    fake_paraview_simple = types.ModuleType("paraview.simple")
    fake_paraview.simple = fake_paraview_simple
    monkeypatch.setitem(sys.modules, "trame", fake_trame)
    monkeypatch.delitem(sys.modules, "trame.app", raising=False)
    monkeypatch.setitem(sys.modules, "paraview", fake_paraview)
    monkeypatch.setitem(sys.modules, "paraview.simple", fake_paraview_simple)

    ok, errors = check_trame_dependencies()
    assert ok is False
    assert len(errors) == 1
    assert "broken" in errors[0]
    assert "trame.app" in errors[0]


def test_check_openmc_dependencies_missing_in_this_env():
    """Missing packages of the "openmc" group are reported with their install hints."""
    ok, message = check_openmc_dependencies()
    missing = [name for name in ("h5py", "openmc", "numpy") if name not in sys.modules]
    if missing:
        assert ok is False
        for name in missing:
            assert name in message
    if "openmc" not in sys.modules:
        assert "https://shimwell.github.io/wheels" in message


def test_check_openmc_dependencies_with_fakes(monkeypatch):
    """With h5py, openmc and numpy importable, the check passes."""
    for name in ("h5py", "openmc", "numpy"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))

    ok, message = check_openmc_dependencies()
    assert ok is True
    assert "available" in message


# ---------------------------------------------------------------------------
# Layout helpers
# ---------------------------------------------------------------------------


def test_create_control_panel_theme_colors():
    vuetify = FakeVuetify()
    drawer = create_control_panel(vuetify, server=SimpleNamespace(), theme="dark", width=300)
    assert drawer.tag == "VNavigationDrawer"
    assert drawer.kwargs["color"] == "#1e1e1e"
    assert drawer.kwargs["theme"] == "dark"
    assert drawer.kwargs["width"] == 300
    assert drawer.kwargs["v_model"] == ("show_controls", True)
    # Vuetify 3 removed the app/clipped props from VNavigationDrawer.
    assert "app" not in drawer.kwargs
    assert "clipped" not in drawer.kwargs

    drawer = create_control_panel(vuetify, server=SimpleNamespace(), theme="light")
    assert drawer.kwargs["color"] == "#f5f5f5"
    assert drawer.kwargs["theme"] == "light"


def test_create_main_content_builds_toggle_and_view_widget(monkeypatch):
    # create_render_mode_toggle lazily imports trame.widgets.html; stub it so
    # the test passes both with and without trame installed.
    monkeypatch.setitem(sys.modules, "trame.widgets", SimpleNamespace(html=FakeVuetify()))

    vuetify = FakeVuetify()
    pv_widgets = FakeVuetify()
    view = SimpleNamespace()

    components, view_widget = create_main_content(vuetify, pv_widgets, view, lambda: None)

    assert len(components) == 2
    assert view_widget.tag == "VtkRemoteLocalView"
    assert view_widget.args[0] is view
    assert view_widget.kwargs["interactive_ratio"] == 1
    assert view_widget.kwargs["namespace"] == "view"
    assert view_widget.kwargs["mode"] == ("viewMode", "local")
    assert view_widget.kwargs["disable_auto_switch"] is True
    # The render-mode toggle drives the same <namespace>Mode state variable.
    toggles = vuetify.by_tag("VBtnToggle")
    assert len(toggles) == 1
    assert toggles[0].kwargs["v_model"] == ("viewMode", "local")
    # The toggle button is an icon button (Vuetify 3 icon prop, no child VIcon).
    toggle = vuetify.by_tag("VBtn")[0]
    assert toggle.kwargs["icon"] == "mdi-chevron-right"
    assert toggle.kwargs["size"] == "small"
    assert vuetify.by_tag("VIcon") == []


# ---------------------------------------------------------------------------
# StateHandlers error paths and remaining branches
# ---------------------------------------------------------------------------


def _raising_display():
    """A display that raises on any attribute set / method call."""

    class _Display:
        def __setattr__(self, name, value):
            raise RuntimeError("display broken")

        def __getattr__(self, name):
            if name.startswith("_"):
                raise AttributeError(name)
            return lambda *a, **k: (_ for _ in ()).throw(RuntimeError("display broken"))

    return _Display()


def test_representation_handler_error_is_reported(capsys):
    """A failing display logs the representation error instead of raising."""
    handler = StateHandlers.create_representation_handler(
        {"display": _raising_display()}, SimpleNamespace(appearance_update=0)
    )
    handler("Surface")
    assert "Error updating representation" in capsys.readouterr().out


def test_background_handler_error_is_reported(capsys):
    """A failing view logs the background error instead of raising."""
    handler = StateHandlers.create_background_handler({"view": _raising_display()})
    handler("#ff0000")
    assert "Error updating background" in capsys.readouterr().out


def test_color_by_handler_error_is_reported(capsys):
    """A failing display logs the color-by error instead of raising."""
    handler = StateHandlers.create_color_by_handler(
        {"display": _raising_display(), "view": object()},
        SimpleNamespace(color_map="viridis"),
        SimpleNamespace(),
    )
    handler("Solid Color")
    assert "Error updating color by" in capsys.readouterr().out


def test_color_map_handler_cell_branch_and_error(capsys):
    """Cell: color-by resolves the array name; a failing LUT logs the error."""
    state = SimpleNamespace(color_by="Cell: cell_id")
    lut = SimpleNamespace(ApplyPreset=lambda cmap, opaque: None)
    simple = SimpleNamespace(GetColorTransferFunction=lambda name: lut)
    handler = StateHandlers.create_color_map_handler({}, state, simple)
    handler("magma")  # no raise — Cell branch applies the preset

    broken_simple = SimpleNamespace(
        GetColorTransferFunction=lambda name: (_ for _ in ()).throw(RuntimeError("no lut"))
    )
    handler = StateHandlers.create_color_map_handler({}, state, broken_simple)
    handler("magma")
    assert "Error updating color map" in capsys.readouterr().out


def test_scalar_bar_handler_shows_bar_and_error(capsys):
    """Point: color-by makes the scalar bar visible; a failing view logs the error."""
    scalar_bar = SimpleNamespace(Visibility=False)
    simple = SimpleNamespace(
        GetColorTransferFunction=lambda name: ("lut", name),
        GetScalarBar=lambda lut, view: scalar_bar,
    )
    state = SimpleNamespace(color_by="Point: energy")
    handler = StateHandlers.create_scalar_bar_handler({"view": object()}, state, simple)
    handler(True)
    assert scalar_bar.Visibility is True

    broken_simple = SimpleNamespace(
        GetColorTransferFunction=lambda name: (_ for _ in ()).throw(RuntimeError("no lut"))
    )
    handler = StateHandlers.create_scalar_bar_handler({"view": object()}, state, broken_simple)
    handler(True)
    assert "Error updating scalar bar" in capsys.readouterr().out


def test_small_handlers_error_paths(capsys):
    """orientation-axes / point-size / line-width / ambient errors are logged, not raised."""
    handler = StateHandlers.create_orientation_axes_handler({"view": _raising_display()})
    handler(True)
    handler = StateHandlers.create_point_size_handler({"display": _raising_display()})
    handler(2.0)
    handler = StateHandlers.create_line_width_handler({"display": _raising_display()})
    handler(3.0)
    handler = StateHandlers.create_ambient_light_handler({"display": _raising_display()})
    handler(0.5)
    out = capsys.readouterr().out
    assert "Error updating orientation axes" in out
    assert "Error updating point size" in out
    assert "Error updating line width" in out
    assert "Error updating ambient light" in out


def test_parallel_projection_handler_success_and_error(capsys):
    """Toggling projection bumps the counter; a failing view logs the error."""
    state = SimpleNamespace(camera_update_counter=0)
    view = SimpleNamespace(CameraParallelProjection=0)
    handler = StateHandlers.create_parallel_projection_handler({"view": view}, state)
    handler(True)
    assert view.CameraParallelProjection == 1
    assert state.camera_update_counter == 1

    handler = StateHandlers.create_parallel_projection_handler(
        {"view": _raising_display()}, SimpleNamespace(camera_update_counter=0)
    )
    handler(True)
    assert "Error updating projection mode" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Camera controllers
# ---------------------------------------------------------------------------


def test_set_camera_view_success(monkeypatch):
    """A successful set-camera-view resets and renders via paraview.simple."""
    calls = []
    fake_simple = types.ModuleType("paraview.simple")
    fake_simple.ResetCamera = lambda view: calls.append("reset")
    fake_simple.Render = lambda view: calls.append("render")
    fake_paraview = types.ModuleType("paraview")
    fake_paraview.simple = fake_simple
    monkeypatch.setitem(sys.modules, "paraview", fake_paraview)
    monkeypatch.setitem(sys.modules, "paraview.simple", fake_simple)

    view = SimpleNamespace(CameraPosition=None, CameraFocalPoint=None, CameraViewUp=None)
    pipeline = {"view": view, "source": None}
    updates = []
    set_view = create_set_camera_view_controller(
        pipeline, SimpleNamespace(), lambda **kw: updates.append(kw)
    )

    assert set_view("iso") is True
    assert calls == ["reset", "render"]
    assert updates == [{"push_camera": True}]


def test_pan_camera_error_returns_false(capsys):
    """A failing update function converts to a logged error + False."""
    view = SimpleNamespace(
        CameraPosition=(1, 0, 0), CameraFocalPoint=(0, 0, 0), CameraViewUp=(0, 0, 1)
    )

    def bad_update(**kwargs):
        raise RuntimeError("push failed")

    pan = create_pan_camera_controller({"view": view}, bad_update)
    assert pan("up") is False
    assert "Pan error" in capsys.readouterr().out


def test_zoom_camera_projection_branches_and_error(capsys):
    """Parallel scales the projection; perspective dollies; failures return False."""
    updates = []
    parallel_view = SimpleNamespace(CameraParallelProjection=1, CameraParallelScale=1.0)
    zoom = create_zoom_camera_controller({"view": parallel_view}, lambda **kw: updates.append(kw))
    assert zoom(2.0) is True
    assert parallel_view.CameraParallelScale == 2.0

    persp_view = SimpleNamespace(
        CameraParallelProjection=0, CameraPosition=(2, 0, 0), CameraFocalPoint=(0, 0, 0)
    )
    zoom = create_zoom_camera_controller({"view": persp_view}, lambda **kw: updates.append(kw))
    assert zoom(2.0) is True
    assert persp_view.CameraPosition == [4.0, 0.0, 0.0]

    def bad_update(**kwargs):
        raise RuntimeError("push failed")

    zoom = create_zoom_camera_controller({"view": persp_view}, bad_update)
    assert zoom(2.0) is False
    assert "Zoom error" in capsys.readouterr().out


def test_capture_screenshot_success(monkeypatch, tmp_path):
    """Screenshot renders, saves via paraview.simple, and returns base64 png data."""
    out_file = tmp_path / "shot.png"

    def save_screenshot(filename, view, **kwargs):
        with open(filename, "wb") as f:
            f.write(b"png-bytes")

    fake_simple = types.ModuleType("paraview.simple")
    fake_simple.Render = lambda view: None
    fake_simple.SaveScreenshot = save_screenshot
    fake_paraview = types.ModuleType("paraview")
    fake_paraview.simple = fake_simple
    monkeypatch.setitem(sys.modules, "paraview", fake_paraview)
    monkeypatch.setitem(sys.modules, "paraview.simple", fake_simple)

    view = SimpleNamespace(Background=[1, 1, 1], ViewSize=[800, 600])
    capture = create_capture_screenshot_controller({"view": view})
    result = capture(filename=str(out_file), width=1024, height=768, transparent=True)

    import base64

    assert result["success"] is True
    assert base64.b64decode(result["data"]) == b"png-bytes"
    assert result["format"] == "png"
    # View state restored afterwards
    assert view.Background == [1, 1, 1]
    assert view.ViewSize == [800, 600]

    # No filename → a temp file is created and reported
    result = capture()
    assert result["success"] is True
    assert result["filename"].endswith(".png")


def test_capture_screenshot_no_view_returns_error():
    capture = create_capture_screenshot_controller({})
    result = capture()
    assert result["success"] is False
    assert "No view available" in result["error"]


# ---------------------------------------------------------------------------
# Install hints
# ---------------------------------------------------------------------------


def test_install_hint_variants():
    from plugins.base.lib.common import _install_hint

    assert _install_hint({"name": "vtk", "installCommand": "custom cmd"}) == "custom cmd"
    assert _install_hint({"name": "vtk", "condaOnly": True}) == "conda install -c conda-forge vtk"
    assert (
        _install_hint({"name": "pkg", "extraIndexUrl": "https://idx"})
        == "pip install --extra-index-url https://idx pkg"
    )
    assert _install_hint({"name": "pkg"}) == "pip install pkg"
