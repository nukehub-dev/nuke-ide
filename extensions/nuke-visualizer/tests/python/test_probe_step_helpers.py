"""Helper and failure-path tests for plugins.base.lib.probe and .step.

The probe sampling tests use real VTK datasets with a fake ``vtkProbeFilter``
so the rare result-validation branches (no output array, wrong tuple count,
wrong component count, missing/mismatched valid mask) run deterministically.
STEP tests force the lazy dependency probes and the cache-statistics
fallback without invoking gmsh.
"""

import sys
import types

import pytest

np = pytest.importorskip("numpy")

from plugins.base.lib import probe as probe_lib  # noqa: E402
from plugins.base.lib import step as step_lib  # noqa: E402
from plugins.base.lib.analysis import AnalysisError  # noqa: E402

# ---------------------------------------------------------------------------
# probe: numeric array and component validation
# ---------------------------------------------------------------------------


def test_numeric_values_wraps_conversion_failure():
    class Array:
        def GetNumberOfComponents(self):
            return 1

    def explode(_array):
        raise RuntimeError("not numeric")

    with pytest.raises(AnalysisError, match="not a numeric VTK array"):
        probe_lib._numeric_values(
            types.SimpleNamespace(vtk_to_numpy=explode), Array(), "point", "f"
        )


def test_numeric_values_rejects_zero_component_array():
    class Array:
        def GetNumberOfComponents(self):
            return 0

    numpy_support = types.SimpleNamespace(vtk_to_numpy=lambda array: np.array([1.0]))

    with pytest.raises(AnalysisError, match="has no components"):
        probe_lib._numeric_values(numpy_support, Array(), "cell", "c")


@pytest.mark.parametrize("component", [True, 1.5, "2"])
def test_validate_component_rejects_non_integer_values(component):
    with pytest.raises(AnalysisError, match="0-based integer"):
        probe_lib._validate_component(3, component)


def test_sample_array_values_rejects_non_finite_positions():
    pytest.importorskip("vtk")

    with pytest.raises(AnalysisError, match="positions must be finite"):
        probe_lib.sample_array_values(None, None, "point", "f", [(float("nan"), 0.0, 0.0)])


def test_build_probe_result_rejects_mismatched_series_length():
    with pytest.raises(AnalysisError, match="path samples do not match"):
        probe_lib.build_probe_result(
            "/tmp/a.vti",
            "point",
            "f",
            [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)],
            {"values": [1.0, 2.0], "valid": [True, True]},
            series=[{"distance": 0.0, "position": [0.0, 0.0, 0.0]}],
            length=1.0,
        )


# ---------------------------------------------------------------------------
# probe: vtkProbeFilter result validation
# ---------------------------------------------------------------------------


def _vtk_modules():
    vtk = pytest.importorskip("vtk")
    from vtk.util import numpy_support

    return vtk, numpy_support


def _image_with_array(vtk, numpy_support, components=1):
    image = vtk.vtkImageData()
    image.SetDimensions(3, 3, 3)
    image.SetOrigin(0.0, 0.0, 0.0)
    image.SetSpacing(1.0, 1.0, 1.0)
    values = np.arange(27 * components, dtype=float).reshape(27, components)
    array = numpy_support.numpy_to_vtk(values, deep=True)
    array.SetName("f")
    image.GetPointData().AddArray(array)
    return image


def _vtk_array(numpy_support, values):
    return numpy_support.numpy_to_vtk(np.asarray(values, dtype=float), deep=True)


class _FakeOutput:
    def __init__(self, attributes):
        self._attributes = attributes

    def GetPointData(self):
        return self._attributes


class _FakeAttributes:
    def __init__(self, arrays):
        self._arrays = arrays

    def GetArray(self, name):
        return self._arrays.get(name)


def _install_probe(monkeypatch, vtk, output=None, error=None):
    class FakeProbe:
        def SetInputData(self, data):
            pass

        def SetSourceData(self, data):
            pass

        def SetPassPointArrays(self, flag):
            pass

        def SetPassCellArrays(self, flag):
            pass

        def Update(self):
            if error is not None:
                raise error

        def GetOutput(self):
            return output

    fake_vtk = types.SimpleNamespace(
        vtkPoints=vtk.vtkPoints,
        vtkPolyData=vtk.vtkPolyData,
        vtkProbeFilter=FakeProbe,
        VTK_DOUBLE=vtk.VTK_DOUBLE,
    )
    monkeypatch.setattr(probe_lib, "_load_vtk", lambda: fake_vtk)


def test_sample_array_values_wraps_probe_update_failure(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support)
    _install_probe(monkeypatch, vtk, error=RuntimeError("probe exploded"))

    with pytest.raises(AnalysisError, match="VTK probe failed.*probe exploded"):
        probe_lib.sample_array_values(
            image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
        )


def test_sample_array_values_requires_probe_output_array(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support)
    _install_probe(monkeypatch, vtk, output=_FakeOutput(_FakeAttributes({})))

    with pytest.raises(AnalysisError, match="returned no values"):
        probe_lib.sample_array_values(
            image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
        )


def test_sample_array_values_rejects_probe_tuple_count_mismatch(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support)
    output = _FakeOutput(_FakeAttributes({"f": _vtk_array(numpy_support, [1.0])}))
    _install_probe(monkeypatch, vtk, output=output)

    with pytest.raises(AnalysisError, match="returned 1 values for 2 points"):
        probe_lib.sample_array_values(
            image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
        )


def test_sample_array_values_rejects_probe_component_mismatch(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support, components=2)
    output = _FakeOutput(_FakeAttributes({"f": _vtk_array(numpy_support, [1.0, 2.0])}))
    _install_probe(monkeypatch, vtk, output=output)

    with pytest.raises(AnalysisError, match="returned 1 components for 2-component"):
        probe_lib.sample_array_values(
            image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
        )


def test_sample_array_values_defaults_to_all_valid_without_mask(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support)
    output = _FakeOutput(_FakeAttributes({"f": _vtk_array(numpy_support, [1.0, 2.0])}))
    _install_probe(monkeypatch, vtk, output=output)

    sampled = probe_lib.sample_array_values(
        image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
    )

    assert sampled["values"] == [1.0, 2.0]
    assert sampled["valid"] == [True, True]


def test_sample_array_values_rejects_mismatched_valid_mask(monkeypatch):
    vtk, numpy_support = _vtk_modules()
    image = _image_with_array(vtk, numpy_support)
    attributes = _FakeAttributes(
        {
            "f": _vtk_array(numpy_support, [1.0, 2.0]),
            "vtkValidPointMask": _vtk_array(numpy_support, [1.0]),
        }
    )
    _install_probe(monkeypatch, vtk, output=_FakeOutput(attributes))

    with pytest.raises(AnalysisError, match="mismatched vtkValidPointMask"):
        probe_lib.sample_array_values(
            image, numpy_support, "point", "f", [(0.5, 0.5, 0.5), (1.5, 0.5, 0.5)]
        )


# ---------------------------------------------------------------------------
# step: lazy dependency probes
# ---------------------------------------------------------------------------


def test_load_gmsh_reports_missing_dependency(monkeypatch):
    monkeypatch.setattr(step_lib, "HAS_GMSH", False)

    with pytest.raises(step_lib.StepError, match="gmsh is required"):
        step_lib._load_gmsh()


def test_load_vtk_reports_missing_dependency(monkeypatch):
    monkeypatch.setattr(step_lib, "HAS_VTK", False)

    with pytest.raises(step_lib.StepError, match="vtk not installed"):
        step_lib._load_vtk()


def test_load_vtk_wraps_import_failure(monkeypatch):
    monkeypatch.setattr(step_lib, "HAS_VTK", True)
    monkeypatch.setitem(sys.modules, "vtk", None)

    with pytest.raises(step_lib.StepError, match="required for STEP cache stats"):
        step_lib._load_vtk()


def test_load_vtk_returns_installed_module():
    vtk = pytest.importorskip("vtk")

    assert step_lib._load_vtk() is vtk


# ---------------------------------------------------------------------------
# step: cache-hit statistics fallback
# ---------------------------------------------------------------------------


def test_cached_step_keeps_zero_stats_when_vtk_import_fails(tmp_path, monkeypatch):
    """A cache hit that cannot import vtk still returns the cached path."""
    step_path = tmp_path / "bracket.step"
    step_path.write_bytes(b"ISO-10303-21 fake step content")
    cache_dir = tmp_path / "cache"
    cache_path, _ = step_lib.get_cache_path(str(step_path), str(cache_dir))
    with open(cache_path, "w") as handle:
        handle.write("not a real vtk file")
    monkeypatch.setitem(sys.modules, "vtk", None)

    result = step_lib.convert_step_to_vtk_cached(str(step_path), cache_dir=str(cache_dir))

    assert result == {
        "vtk_path": cache_path,
        "from_cache": True,
        "num_nodes": 0,
        "num_elements": 0,
    }
