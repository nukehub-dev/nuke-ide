"""Tests for plugins.base.lib.common — UIComponents factories.

The factories only need an object with widget-factory attributes, so a
recording fake stands in for vuetify. navigation_pad/create_canvas_gadget
import ``trame.widgets.html`` lazily, which is satisfied with a fake
``trame.widgets`` module in sys.modules.

The module has numpy at its top level, so the whole test module is
skipped when numpy is unavailable.
"""

import sys
import types

import pytest

pytest.importorskip("numpy")

from plugins.base.lib.common import (  # noqa: E402
    COLOR_MAPS,
    COLOR_MAPS_SHORT,
    UIComponents,
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


@pytest.fixture
def vuetify():
    return FakeVuetify()


@pytest.fixture
def fake_trame(monkeypatch):
    """Provide a fake trame.widgets module whose html namespace records widgets."""
    html = FakeVuetify()
    widgets_mod = types.ModuleType("trame.widgets")
    widgets_mod.html = html
    trame_mod = types.ModuleType("trame")
    trame_mod.widgets = widgets_mod
    monkeypatch.setitem(sys.modules, "trame", trame_mod)
    monkeypatch.setitem(sys.modules, "trame.widgets", widgets_mod)
    return html


# ---------------------------------------------------------------------------
# Simple control factories
# ---------------------------------------------------------------------------


def test_background_color_picker(vuetify):
    picker = UIComponents.background_color_picker(vuetify)
    assert picker.tag == "VColorPicker"
    assert picker.kwargs["v_model"] == ("background_color_hex", "#1a1a26")
    assert picker.kwargs["mode"] == "hexa"

    custom = UIComponents.background_color_picker(vuetify, ("bg", "#000000"))
    assert custom.kwargs["v_model"] == ("bg", "#000000")


def test_opacity_slider_defaults_and_overrides(vuetify):
    slider = UIComponents.opacity_slider(vuetify)
    assert slider.tag == "VSlider"
    assert slider.kwargs["v_model"] == ("opacity", 1.0)
    assert slider.kwargs["min"] == 0
    assert slider.kwargs["max"] == 1
    assert slider.kwargs["classes"] == "mb-4"

    slider = UIComponents.opacity_slider(vuetify, label="Alpha", classes="mt-2", min=0.2)
    assert slider.kwargs["label"] == "Alpha"
    assert slider.kwargs["classes"] == "mt-2"
    assert slider.kwargs["min"] == 0.2


def test_point_size_slider(vuetify):
    slider = UIComponents.point_size_slider(vuetify)
    assert slider.kwargs["v_model"] == ("point_size", 2.0)
    assert slider.kwargs["min"] == 1
    assert slider.kwargs["max"] == 20


def test_line_width_slider(vuetify):
    slider = UIComponents.line_width_slider(vuetify)
    assert slider.kwargs["v_model"] == ("line_width", 1.0)
    assert slider.kwargs["min"] == 0.5
    assert slider.kwargs["max"] == 10


def test_ambient_light_slider(vuetify):
    slider = UIComponents.ambient_light_slider(vuetify)
    assert slider.kwargs["v_model"] == ("ambient_light", 0.2)
    assert slider.kwargs["label"] == "Ambient"


def test_representation_selector(vuetify):
    selector = UIComponents.representation_selector(vuetify)
    assert selector.tag == "VSelect"
    assert selector.kwargs["v_model"] == ("representation", "Surface")
    items = selector.kwargs["items"][0]
    assert "Surface With Edges" in items
    assert "Wireframe" in items


def test_color_by_selector(vuetify):
    selector = UIComponents.color_by_selector(vuetify, items_binding=("arrays",))
    assert selector.tag == "VSelect"
    assert selector.kwargs["items"] == ("arrays",)
    assert selector.kwargs["v_model"] == ("color_by", "Solid Color")


def test_color_map_selector_default_and_custom_lists(vuetify):
    selector = UIComponents.color_map_selector(vuetify)
    assert selector.kwargs["items"][0] is COLOR_MAPS

    custom = ["A", "B"]
    selector = UIComponents.color_map_selector(vuetify, color_maps=custom)
    assert selector.kwargs["items"][0] is custom


def test_color_map_selector_short_uses_short_list(vuetify):
    selector = UIComponents.color_map_selector_short(vuetify)
    assert selector.kwargs["items"][0] is COLOR_MAPS_SHORT
    assert selector.kwargs["v_model"] == ("color_map", "Plasma")


# ---------------------------------------------------------------------------
# Composite factories
# ---------------------------------------------------------------------------


def test_camera_buttons_layout_and_callbacks(vuetify):
    callbacks = {name: (lambda n=name: n) for name in ["reset", "iso", "front", "side", "top"]}
    components = UIComponents.camera_buttons(
        vuetify,
        reset_callback=callbacks["reset"],
        isometric_callback=callbacks["iso"],
        front_callback=callbacks["front"],
        side_callback=callbacks["side"],
        top_callback=callbacks["top"],
    )

    # Two rows plus five buttons are returned.
    assert len(components) == 7
    buttons = vuetify.by_tag("VBtn")
    assert [b.args[0] for b in buttons] == ["Reset", "Isometric", "Front", "Side", "Top"]
    for button, name in zip(buttons, ["reset", "iso", "front", "side", "top"], strict=True):
        assert button.kwargs["click"] is callbacks[name]


def test_camera_buttons_row_classes_kwarg(vuetify):
    components = UIComponents.camera_buttons(
        vuetify, None, None, None, None, None, row_classes="ma-1"
    )
    rows = vuetify.by_tag("VRow")
    assert rows[0].kwargs["classes"] == "ma-1"
    assert len(components) == 7


def test_appearance_toggles(vuetify):
    toggles = UIComponents.appearance_toggles(vuetify)
    assert len(toggles) == 3
    assert all(t.tag == "VCheckbox" for t in toggles)
    labels = [t.kwargs["label"] for t in toggles]
    assert labels == ["Show 3D Axis Indicator", "Show Data Bounds Outline", "Show Coordinate Grid"]


def test_compact_appearance_controls_with_and_without_camera_gadget(vuetify):
    UIComponents.compact_appearance_controls(vuetify, camera_gadget=True)
    labels = [w.kwargs["label"] for w in vuetify.by_tag("VCheckbox")]
    assert labels == ["3D Axis", "Ortho", "Bounds", "Grid", "Camera"]
    # Background color picker is included.
    assert len(vuetify.by_tag("VColorPicker")) == 1

    vuetify2 = FakeVuetify()
    UIComponents.compact_appearance_controls(vuetify2, camera_gadget=False)
    labels = [w.kwargs["label"] for w in vuetify2.by_tag("VCheckbox")]
    assert "Camera" not in labels


def test_screenshot_button(vuetify):
    callback = lambda: None  # noqa: E731
    components = UIComponents.screenshot_button(vuetify, callback)

    assert len(components) == 3
    assert components[0].tag == "VListSubheader"
    button = vuetify.by_tag("VBtn")[0]
    assert button.kwargs["click"] is callback
    assert button.kwargs["color"] == "primary"
    # The status container is bound to screenshot_status.
    status = components[2]
    assert status.tag == "VContainer"
    assert status.kwargs["v_if"] == ("screenshot_status",)


# ---------------------------------------------------------------------------
# Navigation pad / canvas gadget (need fake trame.widgets)
# ---------------------------------------------------------------------------


def test_navigation_pad_wires_all_callbacks(vuetify, fake_trame):
    events = []
    UIComponents.navigation_pad(
        vuetify,
        pan_callback=lambda direction: events.append(("pan", direction)),
        zoom_callback=lambda factor: events.append(("zoom", factor)),
        reset_callback=lambda: events.append(("reset",)),
        view_callback=lambda view: events.append(("view", view)),
    )

    # Trigger every button handler created inside the tooltips.
    for button in vuetify.by_tag("VBtn"):
        button.kwargs["click"]()

    assert ("reset",) in events
    for direction in ["up", "down", "left", "right"]:
        assert ("pan", direction) in events
    assert ("zoom", 0.85) in events
    assert ("zoom", 1.15) in events
    for view in ["isometric", "top", "front", "right"]:
        assert ("view", view) in events

    # Tooltips contain explanatory html.Div labels.
    assert len(fake_trame.by_tag("Div")) > 0


def test_navigation_pad_without_optional_callbacks(vuetify, fake_trame):
    """Without reset/view callbacks the preset row and divider are skipped."""
    UIComponents.navigation_pad(
        vuetify,
        pan_callback=lambda direction: None,
        zoom_callback=lambda factor: None,
    )
    assert vuetify.by_tag("VDivider") == []
    # Only pan/zoom buttons remain (4 pan + 2 zoom).
    assert len(vuetify.by_tag("VBtn")) == 6


def test_create_canvas_gadget(vuetify, fake_trame):
    events = []
    UIComponents.create_canvas_gadget(
        vuetify,
        pan_callback=lambda direction: events.append(("pan", direction)),
        zoom_callback=lambda factor: events.append(("zoom", factor)),
        reset_callback=lambda: events.append(("reset",)),
        view_callback=lambda view: events.append(("view", view)),
    )

    # Outer container is gated on show_camera_gadget.
    container = vuetify.by_tag("VContainer")[0]
    assert container.kwargs["v_if"] == ("show_camera_gadget",)
    assert "nuke-camera-gadget" in container.kwargs["classes"]

    # The draggable behavior script is injected as an html.Component.
    scripts = fake_trame.by_tag("Component")
    assert len(scripts) == 1
    assert "initDrag" in scripts[0].args[0]
    assert scripts[0].kwargs["is"] == "script"

    # The embedded navigation pad still works.
    for button in vuetify.by_tag("VBtn"):
        button.kwargs["click"]()
    assert ("reset",) in events
    assert ("pan", "up") in events
