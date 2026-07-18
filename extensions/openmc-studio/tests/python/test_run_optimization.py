"""Tests for run_optimization.

run_optimization.py has a top-level ``import openmc`` (and evaluates
``openmc.Model`` in function annotations at def time), so a stub ``openmc``
module is inserted into sys.modules before every import. This keeps the
suite green in environments without OpenMC installed.
"""

import sys
import types
from types import SimpleNamespace

import pytest


@pytest.fixture()
def ro():
    """Import run_optimization with a stubbed openmc module; restore after."""
    stub = types.ModuleType("openmc")
    # Only openmc.Model is needed at import time (function annotations).
    stub.Model = type("Model", (), {})

    sentinel = object()
    old_openmc = sys.modules.get("openmc", sentinel)
    old_ro = sys.modules.get("run_optimization", sentinel)

    sys.modules["openmc"] = stub
    sys.modules.pop("run_optimization", None)
    import run_optimization

    yield run_optimization

    if old_openmc is sentinel:
        sys.modules.pop("openmc", None)
    else:
        sys.modules["openmc"] = old_openmc
    if old_ro is sentinel:
        sys.modules.pop("run_optimization", None)
    else:
        sys.modules["run_optimization"] = old_ro


class TestComputeSweepValues:
    def test_linear_range(self, ro):
        """Linear ranges step evenly from start to end, inclusive."""
        sweep = {"rangeType": "linear", "startValue": 0.0, "endValue": 10.0, "numPoints": 5}
        assert ro.compute_sweep_values(sweep) == pytest.approx([0.0, 2.5, 5.0, 7.5, 10.0])

    def test_linear_range_descending(self, ro):
        """Linear ranges also work from high to low."""
        sweep = {"rangeType": "linear", "startValue": 5.0, "endValue": 1.0, "numPoints": 3}
        assert ro.compute_sweep_values(sweep) == pytest.approx([5.0, 3.0, 1.0])

    def test_log_range(self, ro):
        """Logarithmic ranges are evenly spaced in log10 space."""
        sweep = {"rangeType": "logarithmic", "startValue": 1.0, "endValue": 100.0, "numPoints": 3}
        assert ro.compute_sweep_values(sweep) == pytest.approx([1.0, 10.0, 100.0])

    def test_log_range_spans_decades(self, ro):
        """Log ranges across several decades hit the geometric midpoints."""
        sweep = {"rangeType": "log", "startValue": 1e-3, "endValue": 1e3, "numPoints": 5}
        values = ro.compute_sweep_values(sweep)
        assert values[0] == pytest.approx(1e-3)
        assert values[2] == pytest.approx(1.0)
        assert values[-1] == pytest.approx(1e3)

    def test_single_point_returns_start(self, ro):
        """numPoints < 2 collapses to just the start value."""
        for n in (0, 1):
            sweep = {"rangeType": "linear", "startValue": 3.0, "endValue": 9.0, "numPoints": n}
            assert ro.compute_sweep_values(sweep) == [3.0]


class TestGenerateParameterCombinations:
    def test_empty_sweeps(self, ro):
        """No sweeps produce a single empty parameter dict."""
        assert ro.generate_parameter_combinations([]) == [{}]

    def test_single_sweep(self, ro):
        """One sweep yields one dict per value."""
        sweeps = [
            {
                "variable": "density",
                "rangeType": "linear",
                "startValue": 1.0,
                "endValue": 3.0,
                "numPoints": 3,
            }
        ]
        combos = ro.generate_parameter_combinations(sweeps)
        assert combos == [{"density": 1.0}, {"density": 2.0}, {"density": 3.0}]

    def test_cartesian_product_of_two_sweeps(self, ro):
        """Two sweeps produce the full cartesian product in order."""
        sweeps = [
            {
                "variable": "a",
                "rangeType": "linear",
                "startValue": 0.0,
                "endValue": 1.0,
                "numPoints": 2,
            },
            {
                "variable": "b",
                "rangeType": "linear",
                "startValue": 10.0,
                "endValue": 30.0,
                "numPoints": 3,
            },
        ]
        combos = ro.generate_parameter_combinations(sweeps)
        assert len(combos) == 6
        assert combos[0] == {"a": 0.0, "b": 10.0}
        assert combos[-1] == {"a": 1.0, "b": 30.0}
        assert {(c["a"], c["b"]) for c in combos} == {
            (0.0, 10.0),
            (0.0, 20.0),
            (0.0, 30.0),
            (1.0, 10.0),
            (1.0, 20.0),
            (1.0, 30.0),
        }


class TestParameterByPath:
    def test_get_nested_attribute(self, ro):
        """Dot paths traverse plain object attributes."""
        model = SimpleNamespace(settings=SimpleNamespace(batches=100))
        assert ro.get_parameter_by_path(model, "settings.batches") == 100

    def test_get_with_numeric_index(self, ro):
        """Numeric path parts index into lists."""
        mat = SimpleNamespace(density=10.0)
        model = SimpleNamespace(materials=[mat])
        assert ro.get_parameter_by_path(model, "materials.0.density") == 10.0

    def test_set_nested_attribute(self, ro):
        """set_parameter_by_path overwrites the target attribute."""
        mat = SimpleNamespace(density=10.0)
        model = SimpleNamespace(materials=[mat], settings=SimpleNamespace(batches=100))
        ro.set_parameter_by_path(model, "materials.0.density", 5.5)
        assert model.materials[0].density == 5.5
        ro.set_parameter_by_path(model, "settings.batches", 250)
        assert ro.get_parameter_by_path(model, "settings.batches") == 250

    def test_set_top_level_attribute(self, ro):
        """A single-part path sets an attribute on the model itself."""
        model = SimpleNamespace(name="base")
        ro.set_parameter_by_path(model, "name", "modified")
        assert model.name == "modified"


class TestMain:
    def test_missing_arguments_exits_with_usage(self, ro, monkeypatch, capsys):
        """Fewer than 2 CLI args prints usage and exits 1."""
        monkeypatch.setattr(sys, "argv", ["run_optimization.py"])
        with pytest.raises(SystemExit) as exc:
            ro.main()
        assert exc.value.code == 1
        assert "Usage" in capsys.readouterr().out

    def test_nonexistent_config_exits_with_error(self, ro, monkeypatch, capsys, tmp_path):
        """A missing config file prints an error and exits 1."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_optimization.py",
                str(tmp_path / "nope.json"),
                str(tmp_path / "out"),
            ],
        )
        with pytest.raises(SystemExit) as exc:
            ro.main()
        assert exc.value.code == 1
        assert "not found" in capsys.readouterr().out
