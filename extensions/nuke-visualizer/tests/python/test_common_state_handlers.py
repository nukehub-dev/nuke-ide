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
    create_zoom_camera_controller,
    find_free_port,
    get_available_arrays,
    get_data_bounds,
    init_common_state,
    save_screenshot_with_timestamp,
)


class FakeWidget:
    """Stand-in for a vuetify widget: records construction and supports 'with'."""

    def __init__(self, tag, *args, **kwargs):
        self.tag = tag
        self.args = args
        self.kwargs = kwargs

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
    pipeline = {"display": SimpleNamespace(), "view": SimpleNamespace()}
    StateHandlers.create_color_by_handler(pipeline, SimpleNamespace(), simple)("Solid Color")
    assert simple.color_by_calls == [None]


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


def test_create_main_content_builds_toggle_and_view_widget():
    vuetify = FakeVuetify()
    pv_widgets = FakeVuetify()
    view = SimpleNamespace()

    components, view_widget = create_main_content(vuetify, pv_widgets, view, lambda: None)

    assert len(components) == 2
    assert view_widget.tag == "VtkRemoteView"
    assert view_widget.args[0] is view
    assert view_widget.kwargs["interactive_ratio"] == 1
    # The toggle button is an icon button (Vuetify 3 icon prop, no child VIcon).
    toggle = vuetify.by_tag("VBtn")[0]
    assert toggle.kwargs["icon"] == "mdi-chevron-right"
    assert toggle.kwargs["size"] == "small"
    assert vuetify.by_tag("VIcon") == []
