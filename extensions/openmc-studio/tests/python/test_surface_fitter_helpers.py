"""Edge-case and error-path tests for cad_conversion.surface_fitter.

Targets the numerical failure branches (singular fits, non-positive radii,
zero gradients) and the y-axis torus classification. Real numpy is used and
its least-squares/SVD entry points are monkeypatched per test; no CAD kernel
or mesh file is involved.
"""

import math

import pytest

np = pytest.importorskip("numpy")

from cad_conversion import surface_fitter

# ---------------------------------------------------------------------------
# Point clouds
# ---------------------------------------------------------------------------


def sphere_cloud():
    return [[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]]


def cylinder_cloud():
    pts = []
    for m in range(12):
        ang = 2 * math.pi * m / 12
        for z in (-1.0, 0.0, 1.0):
            pts.append([2.0 * math.cos(ang), 2.0 * math.sin(ang), z])
    return pts


def torus_cloud_y(major=5.0, minor=1.0):
    """Points on a y-axis torus (ring in the x-z plane)."""
    pts = []
    for i in range(16):
        u = 2 * math.pi * i / 16
        for j in range(8):
            v = 2 * math.pi * j / 8
            ring = major + minor * math.cos(v)
            pts.append([ring * math.cos(u), minor * math.sin(v), ring * math.sin(u)])
    return pts


def arbitrary_cloud(count=12):
    return [[float(i), float(i % 3), float(i % 5)] for i in range(count)]


# ---------------------------------------------------------------------------
# fit_sphere / fit_cylinder failure paths
# ---------------------------------------------------------------------------


def test_fit_sphere_returns_none_when_least_squares_fails(monkeypatch):
    def boom(*args, **kwargs):
        raise np.linalg.LinAlgError("SVD did not converge")

    monkeypatch.setattr(surface_fitter.np.linalg, "lstsq", boom)
    assert surface_fitter.fit_sphere(sphere_cloud()) is None


def test_fit_cylinder_skips_non_finite_radius(monkeypatch):
    """A NaN circle radius rejects the candidate axis instead of returning it."""
    monkeypatch.setattr(
        surface_fitter.np.linalg,
        "lstsq",
        lambda A, b, rcond=None: (np.array([0.0, 0.0, float("nan")]),),
    )
    assert surface_fitter.fit_cylinder(cylinder_cloud()) is None


def test_fit_cylinder_skips_axis_after_least_squares_error(monkeypatch):
    def boom(*args, **kwargs):
        raise np.linalg.LinAlgError("singular matrix")

    monkeypatch.setattr(surface_fitter.np.linalg, "lstsq", boom)
    assert surface_fitter.fit_cylinder(cylinder_cloud()) is None


def test_fit_general_cylinder_returns_none_for_too_few_points():
    assert surface_fitter.fit_general_cylinder([[0.0, 0.0, 0.0]] * 5) is None


# ---------------------------------------------------------------------------
# fit_cone failure paths
# ---------------------------------------------------------------------------


def test_fit_cone_returns_none_when_least_squares_fails(monkeypatch):
    def boom(*args, **kwargs):
        raise np.linalg.LinAlgError("singular matrix")

    monkeypatch.setattr(surface_fitter.np.linalg, "lstsq", boom)
    assert surface_fitter.fit_cone(arbitrary_cloud(8)) is None


# ---------------------------------------------------------------------------
# fit_torus failure paths and axis classification
# ---------------------------------------------------------------------------


def test_fit_torus_rejects_non_finite_major_radius(monkeypatch):
    monkeypatch.setattr(
        surface_fitter.np.linalg,
        "lstsq",
        lambda A, b, rcond=None: (np.array([float("nan"), 0.0, 0.0]),),
    )
    assert surface_fitter.fit_torus(torus_cloud_y()) is None


def test_fit_torus_rejects_non_positive_minor_radius_squared(monkeypatch):
    """A negative minor-radius squared discards the torus fit."""
    results = iter(
        [
            np.array([0.0, 0.0, -25.0]),  # major radius R = 5
            np.array([0.0, -1.0]),  # r_minor^2 = -1 + 0
        ]
    )
    monkeypatch.setattr(
        surface_fitter.np.linalg, "lstsq", lambda A, b, rcond=None: (next(results),)
    )
    assert surface_fitter.fit_torus(torus_cloud_y()) is None


def test_fit_torus_classifies_y_axis():
    """A torus whose symmetry axis is y maps to y-torus."""
    result = surface_fitter.fit_torus(torus_cloud_y(major=4.0, minor=0.5))

    assert result is not None
    assert result.surface_type == "y-torus"
    assert result.coefficients[3] == pytest.approx(4.0, abs=1e-3)
    assert result.coefficients[4] == pytest.approx(0.5, abs=1e-3)
    assert result.center == pytest.approx([0.0, 0.0, 0.0], abs=1e-3)


def test_fit_torus_returns_none_when_least_squares_fails(monkeypatch):
    def boom(*args, **kwargs):
        raise np.linalg.LinAlgError("singular matrix")

    monkeypatch.setattr(surface_fitter.np.linalg, "lstsq", boom)
    assert surface_fitter.fit_torus(torus_cloud_y()) is None


# ---------------------------------------------------------------------------
# fit_quadric sign canonicalization and degenerate gradients
# ---------------------------------------------------------------------------


def _fake_svd_returning(coeffs):
    def fake_svd(M, full_matrices=False):
        return None, np.array([1.0]), np.array([np.asarray(coeffs, dtype=float)])

    return fake_svd


def test_fit_quadric_flips_near_degenerate_negative_coefficients(monkeypatch):
    """A zero quadratic sum with a negative first term is sign-flipped."""
    coeffs = np.zeros(10)
    coeffs[6] = -1.0  # only the linear x term, first nonzero is negative
    monkeypatch.setattr(surface_fitter.np.linalg, "svd", _fake_svd_returning(coeffs))

    result = surface_fitter.fit_quadric(arbitrary_cloud())

    assert result is not None
    assert result.coefficients[6] == pytest.approx(1.0)
    assert result.coefficients[0] == pytest.approx(0.0)


def test_fit_quadric_uses_raw_value_when_gradient_vanishes(monkeypatch):
    """A constant quadric has a zero gradient; its raw residual is used."""
    coeffs = np.zeros(10)
    coeffs[9] = 1.0
    monkeypatch.setattr(surface_fitter.np.linalg, "svd", _fake_svd_returning(coeffs))

    result = surface_fitter.fit_quadric(arbitrary_cloud())

    assert result is not None
    assert result.coefficients[9] == pytest.approx(1.0)
    assert result.max_deviation == pytest.approx(1.0)


def test_fit_quadric_returns_none_when_svd_fails(monkeypatch):
    def boom(*args, **kwargs):
        raise np.linalg.LinAlgError("SVD did not converge")

    monkeypatch.setattr(surface_fitter.np.linalg, "svd", boom)
    assert surface_fitter.fit_quadric(arbitrary_cloud()) is None
