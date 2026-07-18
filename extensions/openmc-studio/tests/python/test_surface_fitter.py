"""Tests for cad_conversion.surface_fitter (numpy path + pure-Python fallback)."""

import importlib
import math
import sys

import pytest

np = pytest.importorskip("numpy")

from cad_conversion import surface_fitter

# ---------------------------------------------------------------------------
# Synthetic point clouds (deterministic, generated with stdlib math)
# ---------------------------------------------------------------------------


def plane_cloud():
    """16 points on the plane z = 5."""
    return [[i * 0.5, j * 0.5, 5.0] for i in range(4) for j in range(4)]


def sphere_cloud(center=(1.0, 2.0, 3.0), radius=4.0):
    """108 points on a sphere via a theta/phi grid."""
    pts = []
    for k in range(9):
        theta = math.pi * k / 8
        for m in range(12):
            phi = 2 * math.pi * m / 12
            pts.append(
                [
                    center[0] + radius * math.sin(theta) * math.cos(phi),
                    center[1] + radius * math.sin(theta) * math.sin(phi),
                    center[2] + radius * math.cos(theta),
                ]
            )
    return pts


def cylinder_cloud(axis_xy=(1.0, 1.0), radius=2.0):
    """72 points on a z-aligned cylinder through (1, 1) with radius 2."""
    pts = []
    for m in range(12):
        ang = 2 * math.pi * m / 12
        for z in (-2.0, -1.0, 0.0, 1.0, 2.0, 3.0):
            pts.append(
                [
                    axis_xy[0] + radius * math.cos(ang),
                    axis_xy[1] + radius * math.sin(ang),
                    z,
                ]
            )
    return pts


# ---------------------------------------------------------------------------
# Plane fitting
# ---------------------------------------------------------------------------


class TestFitPlane:
    def test_fit_plane_z5(self):
        """A z=5 cloud fits a plane with normal +z and d = -5."""
        result = surface_fitter.fit_plane(plane_cloud())
        assert result is not None
        assert result.surface_type == "plane"
        assert result.coefficients[0] == pytest.approx(0.0, abs=1e-9)
        assert result.coefficients[1] == pytest.approx(0.0, abs=1e-9)
        assert result.coefficients[2] == pytest.approx(1.0, abs=1e-9)
        assert result.coefficients[3] == pytest.approx(-5.0, abs=1e-9)
        assert result.max_deviation < 1e-9
        assert result.center == pytest.approx([0.75, 0.75, 5.0])
        assert result.axis == pytest.approx([0.0, 0.0, 1.0])

    def test_fit_plane_needs_three_points(self):
        """Fewer than 3 points returns None."""
        assert surface_fitter.fit_plane([[0, 0, 0], [1, 1, 1]]) is None


# ---------------------------------------------------------------------------
# Sphere fitting
# ---------------------------------------------------------------------------


class TestFitSphere:
    def test_fit_sphere_recovers_center_and_radius(self):
        """A spherical cloud fits back the exact center and radius."""
        result = surface_fitter.fit_sphere(sphere_cloud())
        assert result is not None
        assert result.surface_type == "sphere"
        assert result.center == pytest.approx([1.0, 2.0, 3.0], abs=1e-6)
        assert result.radius == pytest.approx(4.0, abs=1e-6)
        assert result.max_deviation < 1e-6
        # coefficients are [cx, cy, cz, r]
        assert result.coefficients == pytest.approx([1.0, 2.0, 3.0, 4.0], abs=1e-6)

    def test_fit_sphere_needs_four_points(self):
        """Fewer than 4 points returns None."""
        assert surface_fitter.fit_sphere([[0, 0, 0]] * 3) is None


# ---------------------------------------------------------------------------
# Cylinder fitting
# ---------------------------------------------------------------------------


class TestFitCylinder:
    def test_fit_cylinder_recovers_axis_and_radius(self):
        """A z-aligned cylindrical cloud fits back radius 2 and axis z."""
        result = surface_fitter.fit_cylinder(cylinder_cloud())
        assert result is not None
        assert result.surface_type == "cylinder"
        assert result.radius == pytest.approx(2.0, abs=1e-6)
        assert abs(result.axis[2]) == pytest.approx(1.0, abs=1e-6)
        assert result.axis[0] == pytest.approx(0.0, abs=1e-6)
        assert result.axis[1] == pytest.approx(0.0, abs=1e-6)
        assert result.max_deviation < 1e-6
        # The center's in-plane coordinates sit on the cylinder axis.
        assert result.center[0] == pytest.approx(1.0, abs=1e-6)
        assert result.center[1] == pytest.approx(1.0, abs=1e-6)

    def test_fit_cylinder_needs_six_points(self):
        """Fewer than 6 points returns None."""
        assert surface_fitter.fit_cylinder([[0, 0, 0]] * 5) is None

    def test_fit_general_cylinder_alias(self):
        """fit_general_cylinder delegates to fit_cylinder."""
        result = surface_fitter.fit_general_cylinder(cylinder_cloud())
        assert result is not None
        assert result.surface_type == "cylinder"
        assert result.radius == pytest.approx(2.0, abs=1e-6)


# ---------------------------------------------------------------------------
# classify_and_fit dispatcher
# ---------------------------------------------------------------------------


class TestClassifyAndFit:
    def test_plane_hint(self):
        """A 'Plane' hint on a flat cloud yields a plane."""
        result = surface_fitter.classify_and_fit(plane_cloud(), "Plane")
        assert result is not None
        assert result.surface_type == "plane"

    def test_sphere_hint(self):
        """A 'Sphere' hint on a spherical cloud yields a sphere."""
        result = surface_fitter.classify_and_fit(sphere_cloud(), "Sphere")
        assert result is not None
        assert result.surface_type == "sphere"

    def test_cylinder_hint(self):
        """A 'Cylinder' hint on a cylindrical cloud yields a cylinder."""
        result = surface_fitter.classify_and_fit(cylinder_cloud(), "Cylinder")
        assert result is not None
        assert result.surface_type == "cylinder"

    def test_unknown_hint_tries_plane_first(self):
        """Without a hint, a flat cloud is classified as a plane."""
        result = surface_fitter.classify_and_fit(plane_cloud())
        assert result is not None
        assert result.surface_type == "plane"

    def test_too_few_points_returns_none(self):
        """Fewer than 3 points returns None."""
        assert surface_fitter.classify_and_fit([[0, 0, 0], [1, 1, 1]]) is None


# ---------------------------------------------------------------------------
# Pure-Python fallback (numpy blocked)
# ---------------------------------------------------------------------------


def test_pure_python_fallback_when_numpy_blocked():
    """With numpy blocked, HAS_NUMPY is False and fit_plane still works."""
    real_numpy = sys.modules.get("numpy")
    sys.modules["numpy"] = None
    try:
        importlib.reload(surface_fitter)
        assert surface_fitter.HAS_NUMPY is False
        assert surface_fitter.np is None

        # The pure-Python branch fits a plane through the first 3 points.
        result = surface_fitter.fit_plane([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
        assert result is not None
        assert result.surface_type == "plane"
        assert result.coefficients == pytest.approx([0.0, 0.0, 1.0, 0.0])
        # The fallback hardcodes max_deviation instead of computing it.
        assert result.max_deviation == 0.001
        assert result.center == pytest.approx([1 / 3, 1 / 3, 0.0])

        # numpy-only fitters refuse to run without numpy.
        assert surface_fitter.fit_sphere(sphere_cloud()) is None
        assert surface_fitter.fit_cylinder(cylinder_cloud()) is None
    finally:
        if real_numpy is not None:
            sys.modules["numpy"] = real_numpy
        else:
            sys.modules.pop("numpy", None)
        importlib.reload(surface_fitter)

    # Module state is restored for subsequent tests.
    assert surface_fitter.HAS_NUMPY is True
