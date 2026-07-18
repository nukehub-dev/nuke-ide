"""Tests for cad_conversion.surface_extractor.

The pure _apply_scale helper and the gmsh sampling fallback run directly.
The CadQuery/OCC exact-extraction path is exercised by reloading the module
with fake cadquery/OCP modules in sys.modules (same reload pattern as the
numpy-block test in test_surface_fitter.py).
"""

import importlib
import math
import sys
import types
from types import SimpleNamespace

import pytest
from cad_conversion import gmsh_utils, surface_extractor
from cad_conversion.core import SurfaceFitResult

# ---------------------------------------------------------------------------
# _apply_scale (pure)
# ---------------------------------------------------------------------------


def _result(stype, coeffs, center=None, radius=None):
    return SurfaceFitResult(
        surface_type=stype,
        coefficients=list(coeffs),
        max_deviation=0.0,
        center=center,
        radius=radius,
    )


class TestApplyScale:
    def test_unit_factor_one_is_noop(self):
        """A unit factor of 1.0 leaves everything untouched."""
        r = _result("sphere", [1, 2, 3, 4], center=[1, 2, 3], radius=4.0)
        surface_extractor._apply_scale(r, 1.0)
        assert r.coefficients == [1, 2, 3, 4]
        assert r.center == [1, 2, 3]
        assert r.radius == 4.0

    def test_plane_scales_only_d(self):
        """Plane scaling multiplies the offset, not the normal."""
        r = _result("plane", [0, 0, 1, -5])
        surface_extractor._apply_scale(r, 2.0)
        assert r.coefficients == [0, 0, 1, -10]

    def test_sphere_scales_center_and_radius(self):
        """Sphere scaling multiplies all four coefficients."""
        r = _result("sphere", [1, 2, 3, 4], center=[1, 2, 3], radius=4.0)
        surface_extractor._apply_scale(r, 10.0)
        assert r.coefficients == [10, 20, 30, 40]
        assert r.center == [10, 20, 30]
        assert r.radius == 40.0

    @pytest.mark.parametrize("stype", ["cylinder", "x-cylinder", "y-cylinder", "z-cylinder"])
    def test_cylinder_scales_point_and_radius_not_axis(self, stype):
        """Cylinder scaling leaves the axis vector untouched."""
        r = _result(stype, [1, 2, 3, 0, 0, 1, 5])
        surface_extractor._apply_scale(r, 2.0)
        assert r.coefficients == [2, 4, 6, 0, 0, 1, 10]

    @pytest.mark.parametrize("stype", ["x-cone", "y-cone", "z-cone"])
    def test_cone_scales_apex_not_r2(self, stype):
        """Cone scaling multiplies the apex but keeps r2 dimensionless."""
        r = _result(stype, [1, 2, 3, 0.25])
        surface_extractor._apply_scale(r, 2.0)
        assert r.coefficients == [2, 4, 6, 0.25]

    @pytest.mark.parametrize("stype", ["x-torus", "y-torus", "z-torus"])
    def test_torus_scales_all_coefficients(self, stype):
        """Torus scaling multiplies center and both radii."""
        r = _result(stype, [1, 2, 3, 10, 2, 0.0])
        surface_extractor._apply_scale(r, 3.0)
        assert r.coefficients == [3, 6, 9, 30, 6, 0.0]

    def test_quadric_scales_linear_and_constant_terms(self):
        """Quadric scaling divides linear terms by s and the constant by s^2."""
        r = _result("quadric", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        surface_extractor._apply_scale(r, 2.0)
        assert r.coefficients == [1, 2, 3, 4, 5, 6, 3.5, 4.0, 4.5, 2.5]

    def test_unknown_type_keeps_coefficients(self):
        """Unrecognized surface types keep coefficients but scale metadata."""
        r = _result("mystery", [1, 2, 3], center=[1, 1, 1], radius=2.0)
        surface_extractor._apply_scale(r, 4.0)
        assert r.coefficients == [1, 2, 3]
        assert r.center == [4, 4, 4]
        assert r.radius == 8.0


# ---------------------------------------------------------------------------
# Sampling fallback (no CadQuery in this environment)
# ---------------------------------------------------------------------------


class TestSamplingFallback:
    def test_too_few_points_returns_none(self, monkeypatch):
        """Fewer than 3 sampled points cannot fit anything."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "plane")
        monkeypatch.setattr(
            gmsh_utils, "get_surface_points", lambda d, t, tol: ([[0, 0, 0]], "plane")
        )

        assert surface_extractor.extract_surface_from_entity(2, 1) is None

    def test_fit_result_is_scaled(self, monkeypatch):
        """A successful fit is scaled by the unit factor."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "Plane")
        points = [[i * 0.5, j * 0.5, 5.0] for i in range(4) for j in range(4)]
        monkeypatch.setattr(gmsh_utils, "get_surface_points", lambda d, t, tol: (points, "Plane"))

        result = surface_extractor.extract_surface_from_entity(2, 1, unit_factor=2.0)

        assert result is not None
        assert result.surface_type == "plane"
        assert result.coefficients[3] == pytest.approx(-10.0, abs=1e-9)
        assert result.center == pytest.approx([1.5, 1.5, 10.0])

    def test_unfittable_points_return_none(self, monkeypatch):
        """When classify_and_fit finds nothing, None propagates."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "Unknown")
        monkeypatch.setattr(
            gmsh_utils,
            "get_surface_points",
            lambda d, t, tol: ([[0, 0, 0], [1, 1, 1], [2, 2, 2]], "Unknown"),
        )
        monkeypatch.setattr(surface_extractor, "classify_and_fit", lambda *a, **k: None)

        assert surface_extractor.extract_surface_from_entity(2, 1) is None

    def test_get_file_path_from_gmsh_is_none(self):
        """The gmsh file-path helper is a documented stub returning None."""
        assert surface_extractor._get_file_path_from_gmsh() is None


# ---------------------------------------------------------------------------
# extract_all_surfaces
# ---------------------------------------------------------------------------


class TestExtractAllSurfaces:
    def test_collects_fittable_boundary_faces(self, monkeypatch):
        """Signed boundary faces produce (tag, orientation, result) triples."""
        monkeypatch.setattr(
            gmsh_utils,
            "get_boundary",
            lambda *a, **k: [(2, 5), (2, -7), (1, 3)],
        )
        fits = {5: _result("plane", [0, 0, 1, -4])}
        monkeypatch.setattr(
            surface_extractor,
            "extract_surface_from_entity",
            lambda dim, tag, tol, uf, fp: fits.get(tag),
        )

        results = surface_extractor.extract_all_surfaces(3, 1)

        assert len(results) == 1
        signed_tag, orientation, fit = results[0]
        assert signed_tag == 5
        # Positive signed tag maps to the '-' half-space.
        assert orientation == "-"
        assert fit.surface_type == "plane"


# ---------------------------------------------------------------------------
# OCC exact extraction (fake cadquery + OCP, module reloaded)
# ---------------------------------------------------------------------------


class _FakeVec:
    def __init__(self, x, y, z):
        self._xyz = (x, y, z)

    def X(self):
        return self._xyz[0]

    def Y(self):
        return self._xyz[1]

    def Z(self):
        return self._xyz[2]


class _FakeAxis:
    def __init__(self, location, direction):
        self._location = location
        self._direction = direction

    def Location(self):
        return self._location

    def Direction(self):
        return self._direction


def _plane_surf(normal=(0, 0, 1), location=(1, 2, 3)):
    """Fake BRepAdaptor_Surface for a plane."""
    return SimpleNamespace(
        GetType=lambda: "PLANE",
        Plane=lambda: SimpleNamespace(
            Location=lambda: _FakeVec(*location),
            Axis=lambda: SimpleNamespace(Direction=lambda: _FakeVec(*normal)),
        ),
    )


def _cylinder_surf(direction=(1, 0, 0), location=(0, 0, 0), radius=2.0):
    return SimpleNamespace(
        GetType=lambda: "CYLINDER",
        Cylinder=lambda: SimpleNamespace(
            Axis=lambda: _FakeAxis(_FakeVec(*location), _FakeVec(*direction)),
            Radius=lambda: radius,
        ),
    )


def _cone_surf(direction=(0, 0, 1), location=(0, 0, 0), semi_angle=0.5):
    return SimpleNamespace(
        GetType=lambda: "CONE",
        Cone=lambda: SimpleNamespace(
            Axis=lambda: _FakeAxis(_FakeVec(*location), _FakeVec(*direction)),
            SemiAngle=lambda: semi_angle,
        ),
    )


def _sphere_surf(location=(1, 1, 1), radius=5.0):
    return SimpleNamespace(
        GetType=lambda: "SPHERE",
        Sphere=lambda: SimpleNamespace(Location=lambda: _FakeVec(*location), Radius=lambda: radius),
    )


def _torus_surf(direction=(0, 1, 0), location=(0, 0, 0), major=10.0, minor=2.0):
    return SimpleNamespace(
        GetType=lambda: "TORUS",
        Torus=lambda: SimpleNamespace(
            Axis=lambda: _FakeAxis(_FakeVec(*location), _FakeVec(*direction)),
            MajorRadius=lambda: major,
            MinorRadius=lambda: minor,
        ),
    )


def _install_fake_occ(monkeypatch, surfaces):
    """Insert fake cadquery/OCP modules serving the given per-face surfaces."""
    geomabs = types.ModuleType("OCP.GeomAbs")
    geomabs.GeomAbs_Plane = "PLANE"
    geomabs.GeomAbs_Cylinder = "CYLINDER"
    geomabs.GeomAbs_Cone = "CONE"
    geomabs.GeomAbs_Sphere = "SPHERE"
    geomabs.GeomAbs_Torus = "TORUS"

    class FakeBRepAdaptorSurface:
        def __init__(self, face):
            self._surf = surfaces[face]

        def __getattr__(self, name):
            return getattr(self._surf, name)

    class FakeExplorer:
        def __init__(self, shape, what):
            self._items = list(surfaces)
            self._i = 0

        def More(self):
            return self._i < len(self._items)

        def Current(self):
            return self._items[self._i]

        def Next(self):
            self._i += 1

    class FakeImportResult:
        def val(self):
            return SimpleNamespace(wrapped="COMPOUND")

    cadquery = types.ModuleType("cadquery")
    cadquery.importers = SimpleNamespace(
        importStep=lambda path: FakeImportResult(),
        importBrep=lambda path: FakeImportResult(),
    )

    ocp = types.ModuleType("OCP")
    brepadaptor = types.ModuleType("OCP.BRepAdaptor")
    brepadaptor.BRepAdaptor_Surface = FakeBRepAdaptorSurface
    topabs = types.ModuleType("OCP.TopAbs")
    topabs.TopAbs_FACE = "FACE"
    topexp = types.ModuleType("OCP.TopExp")
    topexp.TopExp_Explorer = FakeExplorer
    topods = types.ModuleType("OCP.TopoDS")
    topods.TopoDS = SimpleNamespace(Face_s=staticmethod(lambda f: f))

    modules = {
        "cadquery": cadquery,
        "OCP": ocp,
        "OCP.BRepAdaptor": brepadaptor,
        "OCP.GeomAbs": geomabs,
        "OCP.TopAbs": topabs,
        "OCP.TopExp": topexp,
        "OCP.TopoDS": topods,
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)


@pytest.fixture()
def occ_extractor(monkeypatch):
    """Reload surface_extractor with fake cadquery/OCP so HAS_CADQUERY is True.

    The module is reloaded back to its original (no-cadquery) state after
    the test, and the OCC parameter cache is cleared on entry.
    """
    saved = {
        name: sys.modules.get(name)
        for name in (
            "cadquery",
            "OCP",
            "OCP.BRepAdaptor",
            "OCP.GeomAbs",
            "OCP.TopAbs",
            "OCP.TopExp",
            "OCP.TopoDS",
        )
    }
    yield surface_extractor
    # Restore whatever was in sys.modules before the test and reload back.
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module
    importlib.reload(surface_extractor)


class TestOccExactExtraction:
    def test_has_cadquery_after_reload(self, occ_extractor, monkeypatch):
        """With fake cadquery/OCP present, HAS_CADQUERY flips on at import."""
        _install_fake_occ(monkeypatch, {})
        importlib.reload(surface_extractor)
        try:
            assert surface_extractor.HAS_CADQUERY is True
        finally:
            surface_extractor._occ_cache.clear()

    def test_plane_extraction_and_orientation_flip(self, occ_extractor, monkeypatch):
        """Plane normals with negative z are flipped to the canonical side."""
        _install_fake_occ(monkeypatch, {"f1": _plane_surf(normal=(0, 0, -1), location=(0, 0, 3))})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            assert params is not None
            # params[0] is unused; face tags are 1-based.
            plane = params[1]
            assert plane.surface_type == "plane"
            assert plane.coefficients == pytest.approx([0, 0, 1, 3])
            assert plane.center == [0, 0, 3]
            assert plane.axis == [0, 0, -1]
        finally:
            surface_extractor._occ_cache.clear()

    @pytest.mark.parametrize(
        "direction,expected",
        [
            ((1, 0, 0), "x-cylinder"),
            ((0, 1, 0), "y-cylinder"),
            ((0, 0, -1), "z-cylinder"),
            ((0.7, 0.7, 0.0), "cylinder"),
        ],
    )
    def test_cylinder_alignment(self, occ_extractor, monkeypatch, direction, expected):
        """Cylinder axes classify into aligned or general cylinder types."""
        _install_fake_occ(monkeypatch, {"f1": _cylinder_surf(direction=direction)})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            cyl = params[1]
            assert cyl.surface_type == expected
            assert cyl.coefficients == pytest.approx([0, 0, 0, *direction, 2.0])
            assert cyl.radius == 2.0
        finally:
            surface_extractor._occ_cache.clear()

    def test_cone_extraction(self, occ_extractor, monkeypatch):
        """A z-aligned cone yields r2 = tan^2(semi-angle)."""
        _install_fake_occ(monkeypatch, {"f1": _cone_surf(semi_angle=0.5)})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            cone = params[1]
            assert cone.surface_type == "z-cone"
            assert cone.coefficients == pytest.approx([0, 0, 0, math.tan(0.5) ** 2])
            assert cone.metadata["half_angle_rad"] == 0.5
        finally:
            surface_extractor._occ_cache.clear()

    def test_tilted_cone_returns_none(self, occ_extractor, monkeypatch):
        """A non-axis-aligned cone cannot be represented in OpenMC."""
        _install_fake_occ(monkeypatch, {"f1": _cone_surf(direction=(0.7, 0.7, 0.0))})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            assert params[1] is None
        finally:
            surface_extractor._occ_cache.clear()

    def test_sphere_extraction(self, occ_extractor, monkeypatch):
        """A sphere yields center + radius coefficients."""
        _install_fake_occ(monkeypatch, {"f1": _sphere_surf()})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            sphere = params[1]
            assert sphere.surface_type == "sphere"
            assert sphere.coefficients == pytest.approx([1, 1, 1, 5.0])
        finally:
            surface_extractor._occ_cache.clear()

    def test_torus_extraction(self, occ_extractor, monkeypatch):
        """A y-aligned torus yields center + major/minor radii."""
        _install_fake_occ(monkeypatch, {"f1": _torus_surf()})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            torus = params[1]
            assert torus.surface_type == "y-torus"
            assert torus.coefficients == pytest.approx([0, 0, 0, 10.0, 2.0, 0.0])
            assert torus.metadata == {"major_radius": 10.0, "minor_radius": 2.0}
        finally:
            surface_extractor._occ_cache.clear()

    def test_tilted_torus_returns_none(self, occ_extractor, monkeypatch):
        """A non-axis-aligned torus cannot be represented in OpenMC."""
        _install_fake_occ(monkeypatch, {"f1": _torus_surf(direction=(0.7, 0.7, 0.0))})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            assert params[1] is None
        finally:
            surface_extractor._occ_cache.clear()

    def test_unknown_surface_type_returns_none(self, occ_extractor, monkeypatch):
        """Free-form OCC surfaces produce no exact parameters."""
        _install_fake_occ(monkeypatch, {"f1": SimpleNamespace(GetType=lambda: "BSPLINE")})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.step")
            assert params[1] is None
        finally:
            surface_extractor._occ_cache.clear()

    def test_unsupported_extension_returns_none(self, occ_extractor, monkeypatch):
        """Only STEP/BREP files get OCC extraction."""
        _install_fake_occ(monkeypatch, {})
        importlib.reload(surface_extractor)
        try:
            assert surface_extractor._load_occ_params("model.iges") is None
        finally:
            surface_extractor._occ_cache.clear()

    def test_import_failure_returns_none(self, occ_extractor, monkeypatch):
        """A cadquery import failure degrades to None."""
        _install_fake_occ(monkeypatch, {})
        cadquery = sys.modules["cadquery"]

        def boom(path):
            raise RuntimeError("parse error")

        cadquery.importers = SimpleNamespace(importStep=boom, importBrep=boom)
        importlib.reload(surface_extractor)
        try:
            assert surface_extractor._load_occ_params("model.step") is None
        finally:
            surface_extractor._occ_cache.clear()

    def test_brep_extension_uses_brep_importer(self, occ_extractor, monkeypatch):
        """The .brep extension routes to importBrep."""
        _install_fake_occ(monkeypatch, {"f1": _sphere_surf()})
        importlib.reload(surface_extractor)
        try:
            params = surface_extractor._load_occ_params("model.brep")
            assert params[1].surface_type == "sphere"
        finally:
            surface_extractor._occ_cache.clear()

    def test_extract_uses_occ_cache_and_scales(self, occ_extractor, monkeypatch):
        """extract_surface_from_entity serves OCC params from the cache."""
        _install_fake_occ(monkeypatch, {"f1": _plane_surf(normal=(0, 0, 1), location=(0, 0, 5))})
        importlib.reload(surface_extractor)
        try:
            result = surface_extractor.extract_surface_from_entity(
                2, 1, unit_factor=2.0, file_path="model.step"
            )
            assert result.surface_type == "plane"
            assert result.coefficients == pytest.approx([0, 0, 1, 10])
            assert result.center == pytest.approx([0, 0, 10])
            # A second call hits the cache, not the importer.
            again = surface_extractor.extract_surface_from_entity(
                2, 1, unit_factor=1.0, file_path="model.step"
            )
            assert again.coefficients == pytest.approx([0, 0, 1, 5])
        finally:
            surface_extractor._occ_cache.clear()

    def test_out_of_range_tag_falls_back_to_sampling(self, occ_extractor, monkeypatch):
        """A face tag beyond the OCC list falls back to sampling."""
        _install_fake_occ(monkeypatch, {"f1": _plane_surf()})
        importlib.reload(surface_extractor)
        try:
            points = [[i * 0.5, j * 0.5, 5.0] for i in range(4) for j in range(4)]
            monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "Plane")
            monkeypatch.setattr(
                gmsh_utils, "get_surface_points", lambda d, t, tol: (points, "Plane")
            )
            result = surface_extractor.extract_surface_from_entity(2, 99, file_path="model.step")
            assert result is not None
            assert result.surface_type == "plane"
        finally:
            surface_extractor._occ_cache.clear()
