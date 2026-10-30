"""Tests for the OCP compatibility shims (TopoDS static aliases, import hook)."""

import importlib
import sys

import ocp_compat
import pytest


class _FakeTopoDS:
    """Stand-in for OCP.TopoDS.TopoDS exposing only the OCP 7.9 (non-suffixed) names."""

    Vertex = staticmethod(lambda shape: ("Vertex", shape))
    Edge = staticmethod(lambda shape: ("Edge", shape))
    Wire = staticmethod(lambda shape: ("Wire", shape))
    Face = staticmethod(lambda shape: ("Face", shape))
    Shell = staticmethod(lambda shape: ("Shell", shape))
    Solid = staticmethod(lambda shape: ("Solid", shape))
    CompSolid = staticmethod(lambda shape: ("CompSolid", shape))
    Compound = staticmethod(lambda shape: ("Compound", shape))


def test_apply_aliases_on_fake_79_flavor() -> None:
    class Fake(_FakeTopoDS):
        pass

    assert ocp_compat._apply_topo_ds_static_aliases(Fake) is True
    for name in ocp_compat._TOPO_DS_DOWNCAST_NAMES:
        assert hasattr(Fake, f"{name}_s")
        assert getattr(Fake, f"{name}_s")("shape") == (name, "shape")


def test_apply_aliases_noop_on_fake_78_flavor() -> None:
    class Fake(_FakeTopoDS):
        pass

    for name in ocp_compat._TOPO_DS_DOWNCAST_NAMES:
        setattr(Fake, f"{name}_s", staticmethod(lambda shape, n=name: (f"{n}_s", shape)))

    assert ocp_compat._apply_topo_ds_static_aliases(Fake) is False
    # Pre-existing aliases must be left untouched.
    assert Fake.Solid_s("shape") == ("Solid_s", "shape")


def test_apply_aliases_skips_missing_base_names() -> None:
    class Fake:
        Solid = staticmethod(lambda shape: ("Solid", shape))

    assert ocp_compat._apply_topo_ds_static_aliases(Fake) is True
    assert hasattr(Fake, "Solid_s")
    assert not hasattr(Fake, "Face_s")


def test_ensure_aliases_returns_false_without_ocp(monkeypatch: pytest.MonkeyPatch) -> None:
    # Force the absence of OCP regardless of the ambient environment.
    monkeypatch.setitem(sys.modules, "OCP", None)
    monkeypatch.setitem(sys.modules, "OCP.TopoDS", None)
    assert ocp_compat.ensure_topo_ds_static_aliases() is False


def test_ensure_aliases_noop_with_real_ocp() -> None:
    pytest.importorskip("OCP")
    assert ocp_compat.ensure_topo_ds_static_aliases() is True
    from OCP import TopoDS

    for name in ocp_compat._TOPO_DS_DOWNCAST_NAMES:
        assert hasattr(TopoDS.TopoDS, f"{name}_s")


@pytest.fixture
def _uninstalled_hook(monkeypatch: pytest.MonkeyPatch):
    """Reset the one-shot hook state and clean sys.meta_path after the test."""
    monkeypatch.setattr(ocp_compat, "_build123d_hook_installed", False)
    yield
    sys.meta_path[:] = [
        finder
        for finder in sys.meta_path
        if not isinstance(finder, ocp_compat._Build123dAliasFinder)
    ]


def test_import_hook_applies_aliases_on_build123d_import(
    tmp_path, monkeypatch: pytest.MonkeyPatch, _uninstalled_hook: None
) -> None:
    calls = []
    monkeypatch.setattr(
        ocp_compat, "ensure_topo_ds_static_aliases", lambda: calls.append(True) or True
    )

    (tmp_path / "build123d.py").write_text("MARKER = 'dummy build123d'\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("build123d", None)

    ocp_compat.install_build123d_import_hook()
    ocp_compat.install_build123d_import_hook()  # idempotent: still one finder
    finders = [f for f in sys.meta_path if isinstance(f, ocp_compat._Build123dAliasFinder)]
    assert len(finders) == 1

    module = importlib.import_module("build123d")
    try:
        assert module.MARKER == "dummy build123d"
        assert len(calls) == 1
        # One-shot: the finder removed itself after firing.
        assert finders[0] not in sys.meta_path
    finally:
        sys.modules.pop("build123d", None)


def test_import_hook_ignores_other_modules(
    monkeypatch: pytest.MonkeyPatch, _uninstalled_hook: None
) -> None:
    calls = []
    monkeypatch.setattr(
        ocp_compat, "ensure_topo_ds_static_aliases", lambda: calls.append(True) or True
    )
    ocp_compat.install_build123d_import_hook()

    finder = next(f for f in sys.meta_path if isinstance(f, ocp_compat._Build123dAliasFinder))
    assert finder.find_spec("json", None) is None
    assert calls == []
