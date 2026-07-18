"""Tests for cad_conversion.surface_fitter conic fitters and fallbacks.

Covers fit_cone, fit_torus, fit_quadric, and the classify_and_fit dispatch
paths not exercised by test_surface_fitter.py (hints, quadric last resort,
and the best-effort warning fallback). All point clouds are synthetic and
deterministic; numpy is required.
"""

import math

import pytest

np = pytest.importorskip("numpy")

from cad_conversion import surface_fitter

# ---------------------------------------------------------------------------
# Synthetic point clouds
# ---------------------------------------------------------------------------


def cone_cloud(axis="z", apex=(0.0, 0.0, 0.0), k=0.5):
    """48 points on a cone with tan(half-angle) = k along the given axis."""
    pts = []
    for h in (1.0, 2.0, 3.0, 4.0):
        r = k * h
        for m in range(12):
            ang = 2 * math.pi * m / 12
            if axis == "z":
                p = [h, r * math.cos(ang), r * math.sin(ang)]
                order = (1, 2, 0)  # keep axis coordinate last
            elif axis == "x":
                p = [h, r * math.cos(ang), r * math.sin(ang)]
                order = (0, 1, 2)
            else:  # y
                p = [h, r * math.cos(ang), r * math.sin(ang)]
                order = (1, 0, 2)
            pts.append(
                [
                    apex[0] + p[order[0]],
                    apex[1] + p[order[1]],
                    apex[2] + p[order[2]],
                ]
            )
    return pts


def torus_cloud(axis="z", center=(0.0, 0.0, 0.0), major=5.0, minor=1.0, rotate45=False):
    """Points on a torus with the given symmetry axis (optional 45-degree tilt)."""
    pts = []
    for i in range(16):
        u = 2 * math.pi * i / 16
        for j in range(8):
            v = 2 * math.pi * j / 8
            ring = major + minor * math.cos(v)
            if axis == "z":
                p = [ring * math.cos(u), ring * math.sin(u), minor * math.sin(v)]
            elif axis == "x":
                p = [minor * math.sin(v), ring * math.cos(u), ring * math.sin(u)]
            if rotate45:
                c = math.sqrt(0.5)
                p = [c * p[0] + c * p[2], p[1], -c * p[0] + c * p[2]]
            pts.append([center[0] + p[0], center[1] + p[1], center[2] + p[2]])
    return pts


def ellipsoid_cloud(a=2.0, b=3.0, c=4.0):
    """108 points on the ellipsoid x^2/a^2 + y^2/b^2 + z^2/c^2 = 1."""
    pts = []
    for k in range(9):
        theta = math.pi * k / 8
        for m in range(12):
            phi = 2 * math.pi * m / 12
            pts.append(
                [
                    a * math.sin(theta) * math.cos(phi),
                    b * math.sin(theta) * math.sin(phi),
                    c * math.cos(theta),
                ]
            )
    return pts


# ---------------------------------------------------------------------------
# fit_cone
# ---------------------------------------------------------------------------


class TestFitCone:
    def test_z_cone_recovers_apex_and_r2(self):
        """A z-aligned cone cloud fits back apex and tan^2(half-angle)."""
        result = surface_fitter.fit_cone(cone_cloud("z", k=0.5))

        assert result is not None
        assert result.surface_type == "z-cone"
        # coefficients are [apex_x, apex_y, apex_z, r2]
        assert result.coefficients[0] == pytest.approx(0.0, abs=1e-6)
        assert result.coefficients[1] == pytest.approx(0.0, abs=1e-6)
        assert result.coefficients[2] == pytest.approx(0.0, abs=1e-6)
        assert result.coefficients[3] == pytest.approx(0.25, abs=1e-6)
        assert result.max_deviation < 1e-6
        assert result.metadata["r2"] == pytest.approx(0.25, abs=1e-6)
        assert result.metadata["half_angle_rad"] == pytest.approx(math.atan(0.5), abs=1e-6)

    def test_x_cone(self):
        """An x-aligned cone cloud is classified as x-cone."""
        result = surface_fitter.fit_cone(cone_cloud("x", apex=(1.0, 2.0, 3.0), k=1.0))

        assert result is not None
        assert result.surface_type == "x-cone"
        assert result.coefficients[0] == pytest.approx(1.0, abs=1e-6)
        assert result.coefficients[1] == pytest.approx(2.0, abs=1e-6)
        assert result.coefficients[2] == pytest.approx(3.0, abs=1e-6)
        assert result.coefficients[3] == pytest.approx(1.0, abs=1e-6)

    def test_y_cone(self):
        """A y-aligned cone cloud is classified as y-cone."""
        result = surface_fitter.fit_cone(cone_cloud("y", k=0.25))

        assert result is not None
        assert result.surface_type == "y-cone"
        assert result.coefficients[3] == pytest.approx(0.0625, abs=1e-6)

    def test_needs_eight_points(self):
        """Fewer than 8 points returns None."""
        assert surface_fitter.fit_cone([[0, 0, 0]] * 7) is None

    def test_degenerate_cloud_returns_none(self):
        """A single repeated point fits no cone."""
        assert surface_fitter.fit_cone([[1.0, 2.0, 3.0]] * 12) is None


# ---------------------------------------------------------------------------
# fit_torus
# ---------------------------------------------------------------------------


class TestFitTorus:
    def test_z_torus_recovers_radii(self):
        """A z-aligned torus cloud fits back major and minor radii."""
        result = surface_fitter.fit_torus(torus_cloud("z", major=5.0, minor=1.0))

        assert result is not None
        assert result.surface_type == "z-torus"
        # coefficients are [cx, cy, cz, major, minor, 0]
        assert result.coefficients[0] == pytest.approx(0.0, abs=1e-3)
        assert result.coefficients[1] == pytest.approx(0.0, abs=1e-3)
        assert result.coefficients[2] == pytest.approx(0.0, abs=1e-3)
        assert result.coefficients[3] == pytest.approx(5.0, abs=1e-3)
        assert result.coefficients[4] == pytest.approx(1.0, abs=1e-3)
        assert result.coefficients[5] == 0.0
        assert result.max_deviation < 1e-3
        assert result.metadata["major_radius"] == pytest.approx(5.0, abs=1e-3)
        assert result.metadata["minor_radius"] == pytest.approx(1.0, abs=1e-3)

    def test_x_torus(self):
        """An x-aligned torus cloud is classified as x-torus."""
        result = surface_fitter.fit_torus(
            torus_cloud("x", center=(1.0, 2.0, 3.0), major=4.0, minor=0.5)
        )

        assert result is not None
        assert result.surface_type == "x-torus"
        assert result.coefficients[0] == pytest.approx(1.0, abs=1e-3)
        assert result.coefficients[1] == pytest.approx(2.0, abs=1e-3)
        assert result.coefficients[2] == pytest.approx(3.0, abs=1e-3)
        assert result.coefficients[3] == pytest.approx(4.0, abs=1e-3)
        assert result.coefficients[4] == pytest.approx(0.5, abs=1e-3)

    def test_needs_ten_points(self):
        """Fewer than 10 points returns None."""
        assert surface_fitter.fit_torus([[0, 0, 0]] * 9) is None

    def test_tilted_torus_returns_none(self):
        """A torus not aligned with a coordinate axis cannot be represented."""
        assert surface_fitter.fit_torus(torus_cloud("z", rotate45=True)) is None


# ---------------------------------------------------------------------------
# fit_quadric
# ---------------------------------------------------------------------------


class TestFitQuadric:
    def test_ellipsoid_recovers_coefficients(self):
        """An ellipsoid cloud fits the normalized quadric coefficients."""
        result = surface_fitter.fit_quadric(ellipsoid_cloud(2.0, 3.0, 4.0))

        assert result is not None
        assert result.surface_type == "quadric"
        assert len(result.coefficients) == 10
        # Normalized so the largest coefficient magnitude is 1: j = -1.
        c = result.coefficients
        assert c[0] == pytest.approx(0.25, abs=1e-6)
        assert c[1] == pytest.approx(1 / 9, abs=1e-6)
        assert c[2] == pytest.approx(1 / 16, abs=1e-6)
        assert c[3] == pytest.approx(0.0, abs=1e-6)
        assert c[4] == pytest.approx(0.0, abs=1e-6)
        assert c[5] == pytest.approx(0.0, abs=1e-6)
        assert c[6] == pytest.approx(0.0, abs=1e-6)
        assert c[7] == pytest.approx(0.0, abs=1e-6)
        assert c[8] == pytest.approx(0.0, abs=1e-6)
        assert c[9] == pytest.approx(-1.0, abs=1e-6)
        assert result.max_deviation < 1e-6
        assert "singular_value" in result.metadata

    def test_needs_ten_points(self):
        """Fewer than 10 points returns None."""
        assert surface_fitter.fit_quadric([[0, 0, 0]] * 9) is None


# ---------------------------------------------------------------------------
# classify_and_fit dispatch paths
# ---------------------------------------------------------------------------


class TestClassifyAndFitDispatch:
    def test_cone_hint(self):
        """A 'Cone' hint on a conical cloud yields a cone type."""
        result = surface_fitter.classify_and_fit(cone_cloud("z", k=0.5), "Cone")
        assert result is not None
        assert result.surface_type == "z-cone"

    def test_torus_hint(self):
        """A 'Torus' hint on a toroidal cloud yields a torus type."""
        result = surface_fitter.classify_and_fit(torus_cloud("z"), "Torus")
        assert result is not None
        assert result.surface_type == "z-torus"

    def test_sphere_hint_falls_back_to_plane(self):
        """A 'Sphere' hint on a flat cloud still ends up as a plane."""
        cloud = [[i * 0.5, j * 0.5, 5.0] for i in range(4) for j in range(4)]
        result = surface_fitter.classify_and_fit(cloud, "Sphere")
        assert result is not None
        assert result.surface_type == "plane"

    def test_ellipsoid_falls_through_to_quadric(self):
        """A cloud fitting no analytic primitive uses the quadric fallback."""
        result = surface_fitter.classify_and_fit(ellipsoid_cloud(), tolerance=0.01)
        assert result is not None
        assert result.surface_type == "quadric"

    def test_best_fit_gets_warning_when_nothing_converges(self):
        """With an impossible tolerance, the best fit returns with a warning."""
        # Irrational noise on a plane: no primitive or quadric fits to 1e-9.
        cloud = []
        for i in range(5):
            for j in range(5):
                z = 5.0 + 0.01 * math.sin(i * 12.3 + j * 7.7)
                cloud.append([i * 0.5, j * 0.5, z])

        result = surface_fitter.classify_and_fit(cloud, tolerance=1e-9)

        assert result is not None
        assert result.surface_type == "plane"
        assert result.warning is not None
        assert "approximated as" in result.warning
