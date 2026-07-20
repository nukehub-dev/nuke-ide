"""Tests for cad_conversion.gmsh_utils.

The HAS_GMSH=False guards are exercised by forcing gmsh absence via
monkeypatch (so they run identically with or without gmsh installed), and a
fake gmsh namespace is injected for the sampling/classification logic.
No real CAD geometry or gmsh session is used.
"""

import pytest
from cad_conversion import gmsh_utils


@pytest.fixture()
def fake_gmsh(monkeypatch):
    """Install a fake gmsh namespace and flip HAS_GMSH on."""
    calls = []

    class FakeOption:
        def setNumber(self, *args):
            pass

    class FakeModel:
        def __init__(self):
            self.entities = []
            self.bounding_box = (0.0, 0.0, 0.0, 1.0, 2.0, 3.0)
            self.boundaries = {}
            self.types = {}
            self.param_bounds = {}
            self.values = {}

        def getEntities(self, *args):
            return list(self.entities)

        def getBoundingBox(self, dim, tag):
            return self.bounding_box

        def getBoundary(self, dimtags, oriented=True, recursive=False):
            return self.boundaries.get(dimtags[0], [])

        def getType(self, dim, tag):
            value = self.types[(dim, tag)]
            if isinstance(value, Exception):
                raise value
            return value

        def getParametrizationBounds(self, dim, tag):
            value = self.param_bounds[(dim, tag)]
            if isinstance(value, Exception):
                raise value
            return value

        def getValue(self, dim, tag, params):
            value = self.values.get((dim, tag))
            if callable(value):
                return value(params)
            return value

    class FakeGmsh:
        def __init__(self):
            self.model = FakeModel()
            self.option = FakeOption()

        def initialize(self):
            calls.append("initialize")

        def finalize(self):
            calls.append("finalize")

        def open(self, path):
            calls.append(("open", path))

    gmsh = FakeGmsh()
    monkeypatch.setattr(gmsh_utils, "HAS_GMSH", True)
    monkeypatch.setattr(gmsh_utils, "gmsh", gmsh)
    gmsh.calls = calls
    return gmsh


# ---------------------------------------------------------------------------
# HAS_GMSH = False guards
# ---------------------------------------------------------------------------


class TestNoGmshGuards:
    @pytest.fixture(autouse=True)
    def no_gmsh(self, monkeypatch):
        """Force gmsh absence so the HAS_GMSH=False guards run in any environment."""
        monkeypatch.setattr(gmsh_utils, "HAS_GMSH", False)
        monkeypatch.setattr(gmsh_utils, "gmsh", None)

    def test_gmsh_session_raises(self):
        """The session context manager refuses to start without gmsh."""
        with pytest.raises(RuntimeError, match="gmsh is not installed"):
            with gmsh_utils.gmsh_session():
                pass

    def test_open_model_raises(self):
        """open_model refuses to open without gmsh."""
        with pytest.raises(RuntimeError, match="gmsh is not installed"):
            gmsh_utils.open_model("model.step")

    def test_entity_queries_return_empty(self):
        """Entity/boundary queries degrade to empty results without gmsh."""
        assert gmsh_utils.get_all_entities() == []
        assert gmsh_utils.get_solids() == []
        assert gmsh_utils.get_faces() == []
        assert gmsh_utils.get_edges() == []
        assert gmsh_utils.get_boundary((3, 1)) == []

    def test_bounding_box_returns_zeros(self):
        """The bounding box degrades to zeros without gmsh."""
        assert gmsh_utils.get_bounding_box() == (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    def test_surface_type_is_unknown(self):
        """The surface type degrades to 'Unknown' without gmsh."""
        assert gmsh_utils.get_surface_type(2, 1) == "Unknown"

    def test_samplers_return_empty(self):
        """Point samplers degrade to empty lists without gmsh."""
        assert gmsh_utils.sample_surface_parametric(2, 1) == []
        assert gmsh_utils.sample_surface_from_curves(2, 1) == []

    def test_freeform_check_is_false(self):
        """The free-form boundary check degrades to False without gmsh."""
        assert gmsh_utils.has_freeform_boundary_curves(2, 1) is False


# ---------------------------------------------------------------------------
# Simple wrappers with fake gmsh
# ---------------------------------------------------------------------------


class TestFakeGmshWrappers:
    def test_session_initializes_and_finalizes(self, fake_gmsh):
        """The session context manager wraps the body in init/finalize."""
        with gmsh_utils.gmsh_session() as gmsh:
            assert gmsh is fake_gmsh
            assert fake_gmsh.calls == ["initialize"]
        assert fake_gmsh.calls == ["initialize", "finalize"]

    def test_session_finalizes_on_error(self, fake_gmsh):
        """finalize runs even when the session body raises."""
        with pytest.raises(ValueError):
            with gmsh_utils.gmsh_session():
                raise ValueError("boom")
        assert fake_gmsh.calls == ["initialize", "finalize"]

    def test_open_model(self, fake_gmsh):
        """open_model forwards to gmsh.open."""
        gmsh_utils.open_model("model.step")
        assert fake_gmsh.calls == [("open", "model.step")]

    def test_entity_filters(self, fake_gmsh):
        """get_solids/faces/edges filter the full entity list by dimension."""
        fake_gmsh.model.entities = [(3, 1), (2, 5), (2, 6), (1, 9), (0, 2)]
        assert gmsh_utils.get_all_entities() == fake_gmsh.model.entities
        assert gmsh_utils.get_solids() == [(3, 1)]
        assert gmsh_utils.get_faces() == [(2, 5), (2, 6)]
        assert gmsh_utils.get_edges() == [(1, 9)]

    def test_bounding_box_passthrough(self, fake_gmsh):
        """The bounding box comes straight from gmsh."""
        assert gmsh_utils.get_bounding_box(-1, -1) == (0.0, 0.0, 0.0, 1.0, 2.0, 3.0)

    def test_get_boundary_passthrough(self, fake_gmsh):
        """get_boundary forwards dimtag and orientation flags."""
        fake_gmsh.model.boundaries = {(3, 1): [(2, 5), (2, -6)]}
        assert gmsh_utils.get_boundary((3, 1), oriented=True, recursive=False) == [
            (2, 5),
            (2, -6),
        ]

    def test_get_surface_type_exception_is_unknown(self, fake_gmsh):
        """A gmsh getType failure degrades to 'Unknown'."""
        fake_gmsh.model.types = {(2, 1): RuntimeError("no such entity")}
        assert gmsh_utils.get_surface_type(2, 1) == "Unknown"


# ---------------------------------------------------------------------------
# classify_gmsh_surface_type / is_nurbs_like_surface
# ---------------------------------------------------------------------------


class TestClassifySurfaceType:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Plane", "plane"),
            ("cylinder", "cylinder"),
            ("Sphere", "sphere"),
            ("Cone", "cone"),
            ("Torus", "torus"),
            ("BSpline surface", "BSpline"),
            ("B-spline curve", "BSpline"),
            ("Bezier surface", "Bezier"),
            ("NURBS surface", "NURBS"),
            ("Spline thing", "NURBS"),
            ("Surface of revolution", "SurfaceOfRevolution"),
            ("Something else", "Unknown"),
        ],
    )
    def test_classification(self, monkeypatch, raw, expected):
        """Raw gmsh type strings classify into the internal vocabulary."""
        monkeypatch.setattr(gmsh_utils, "get_surface_type", lambda d, t: raw)
        assert gmsh_utils.classify_gmsh_surface_type(2, 1) == expected


class TestIsNurbsLikeSurface:
    @pytest.mark.parametrize("stype", ["BSpline", "Bezier", "NURBS"])
    def test_freeform_types_are_nurbs_like(self, monkeypatch, stype):
        """Free-form surface types are NURBS-like by definition."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: stype)
        assert gmsh_utils.is_nurbs_like_surface(2, 1) is True

    def test_surface_of_revolution_depends_on_curves(self, monkeypatch):
        """Surfaces of revolution are NURBS-like only with free-form curves."""
        monkeypatch.setattr(
            gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "SurfaceOfRevolution"
        )
        monkeypatch.setattr(gmsh_utils, "has_freeform_boundary_curves", lambda d, t: True)
        assert gmsh_utils.is_nurbs_like_surface(2, 1) is True
        monkeypatch.setattr(gmsh_utils, "has_freeform_boundary_curves", lambda d, t: False)
        assert gmsh_utils.is_nurbs_like_surface(2, 1) is False

    def test_analytic_types_are_not_nurbs_like(self, monkeypatch):
        """Analytic surface types are not NURBS-like."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "plane")
        assert gmsh_utils.is_nurbs_like_surface(2, 1) is False


class TestHasFreeformBoundaryCurves:
    @pytest.mark.parametrize("ctype", ["BSplineCurve", "Bezier curve", "NURBS", "Spline"])
    def test_freeform_curve_detected(self, fake_gmsh, ctype):
        """Any free-form boundary curve flags the surface."""
        fake_gmsh.model.boundaries = {(2, 1): [(1, 5)]}
        fake_gmsh.model.types = {(1, 5): ctype}
        assert gmsh_utils.has_freeform_boundary_curves(2, 1) is True

    def test_analytic_curves_only(self, fake_gmsh):
        """Lines and circles do not flag the surface."""
        fake_gmsh.model.boundaries = {(2, 1): [(1, 5), (1, 6), (2, 7)]}
        fake_gmsh.model.types = {(1, 5): "Line", (1, 6): "Circle"}
        assert gmsh_utils.has_freeform_boundary_curves(2, 1) is False

    def test_boundary_failure_is_false(self, fake_gmsh, monkeypatch):
        """A boundary query failure degrades to False."""
        monkeypatch.setattr(
            gmsh_utils,
            "get_boundary",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bad")),
        )
        assert gmsh_utils.has_freeform_boundary_curves(2, 1) is False


# ---------------------------------------------------------------------------
# Parametric and curve-based sampling
# ---------------------------------------------------------------------------


class TestSampleSurfaceParametric:
    def test_grid_sampling(self, fake_gmsh):
        """A full grid yields num_samples squared points."""
        fake_gmsh.model.param_bounds = {(2, 1): [[0.0, 1.0], [0.0, 2.0]]}
        fake_gmsh.model.values = {(2, 1): lambda p: [p[0], p[1], p[0] + p[1]]}

        points = gmsh_utils.sample_surface_parametric(2, 1, num_samples=3)

        assert len(points) == 9
        assert [0.0, 0.0, 0.0] in points
        assert [1.0, 2.0, 3.0] in points

    def test_bad_values_are_skipped(self, fake_gmsh):
        """Values that raise or have the wrong shape are dropped."""

        def flaky(p):
            if p[0] < 0.5:
                raise RuntimeError("no value")
            if p[1] < 1.0:
                return [1.0, 2.0]  # wrong length
            return [p[0], p[1], 0.0]

        fake_gmsh.model.param_bounds = {(2, 1): [[0.0, 1.0], [0.0, 2.0]]}
        fake_gmsh.model.values = {(2, 1): flaky}

        points = gmsh_utils.sample_surface_parametric(2, 1, num_samples=3)

        assert points
        assert all(len(p) == 3 for p in points)
        assert all(p[0] >= 0.5 and p[1] >= 1.0 for p in points)

    def test_dense_center_sampling_when_sparse(self, fake_gmsh):
        """Fewer than 9 grid points triggers denser center sampling."""
        fake_gmsh.model.param_bounds = {(2, 1): [[0.0, 1.0], [0.0, 1.0]]}
        # Only corner values resolve -> 4 grid points, then center fills in.
        fake_gmsh.model.values = {
            (2, 1): lambda p: [p[0], p[1], 0.0] if p[0] in (0.0, 1.0) else None
        }

        points = gmsh_utils.sample_surface_parametric(2, 1, num_samples=2)

        assert len(points) >= 4
        assert [0.0, 0.0, 0.0] in points

    def test_empty_param_bounds_returns_empty(self, fake_gmsh):
        """Missing parametrization bounds yield no points."""
        fake_gmsh.model.param_bounds = {(2, 1): []}
        assert gmsh_utils.sample_surface_parametric(2, 1) == []

    def test_param_bounds_failure_returns_empty(self, fake_gmsh):
        """A parametrization-bounds failure yields no points."""
        fake_gmsh.model.param_bounds = {(2, 1): RuntimeError("no bounds")}
        # getParametrizationBounds raising is caught by the outer try.
        assert gmsh_utils.sample_surface_parametric(2, 1) == []


class TestSampleSurfaceFromCurves:
    def test_samples_boundary_curves(self, fake_gmsh):
        """Points come from each 1D boundary curve, deduplicated."""
        fake_gmsh.model.boundaries = {(2, 1): [(1, 5), (1, 6), (2, 9)]}
        fake_gmsh.model.param_bounds = {(1, 5): [[0.0, 1.0]], (1, 6): [[0.0, 1.0]]}
        fake_gmsh.model.values = {
            (1, 5): lambda p: [p[0], 0.0, 0.0],
            (1, 6): lambda p: [p[0], 1.0, 0.0] if p[0] != 0.0 else [0.0, 0.0, 0.0],
        }

        points = gmsh_utils.sample_surface_from_curves(2, 1, samples_per_curve=3)

        # Curve 5 gives 3 points; curve 6 gives 2 new ones (one duplicate).
        assert len(points) == 5
        assert [0.0, 0.0, 0.0] in points
        assert [1.0, 1.0, 0.0] in points

    def test_missing_curve_bounds_are_skipped(self, fake_gmsh):
        """Curves without parametrization bounds are skipped."""
        fake_gmsh.model.boundaries = {(2, 1): [(1, 5), (1, 6)]}
        fake_gmsh.model.param_bounds = {(1, 5): []}
        fake_gmsh.model.values = {}

        assert gmsh_utils.sample_surface_from_curves(2, 1) == []

    def test_curve_value_failures_are_skipped(self, fake_gmsh):
        """Failing curve evaluations are dropped individually."""
        fake_gmsh.model.boundaries = {(2, 1): [(1, 5)]}
        fake_gmsh.model.param_bounds = {(1, 5): [[0.0, 1.0]]}

        def flaky(p):
            if p[0] < 0.5:
                raise RuntimeError("no value")
            return [p[0], 0.0, 0.0]

        fake_gmsh.model.values = {(1, 5): flaky}

        points = gmsh_utils.sample_surface_from_curves(2, 1, samples_per_curve=3)

        assert all(p[0] >= 0.5 for p in points)


# ---------------------------------------------------------------------------
# _has_nearby_point / get_surface_points
# ---------------------------------------------------------------------------


class TestHasNearbyPoint:
    def test_finds_duplicate_within_tol(self):
        """A point within tol of an existing one is detected."""
        points = [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]
        assert gmsh_utils._has_nearby_point([1e-7, 0.0, 0.0], points) is True
        assert gmsh_utils._has_nearby_point([0.5, 0.0, 0.0], points) is False

    def test_empty_list(self):
        """No points means nothing is nearby."""
        assert gmsh_utils._has_nearby_point([0.0, 0.0, 0.0], []) is False


class TestGetSurfacePoints:
    def test_combines_parametric_and_curve_points(self, monkeypatch):
        """Sparse parametric sampling is topped up from boundary curves."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "cylinder")
        monkeypatch.setattr(
            gmsh_utils,
            "sample_surface_parametric",
            lambda d, t, n: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
        )
        monkeypatch.setattr(
            gmsh_utils,
            "sample_surface_from_curves",
            lambda d, t: [[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
        )

        points, stype = gmsh_utils.get_surface_points(2, 1)

        assert stype == "cylinder"
        # The duplicate curve point is dropped.
        assert points == [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]]

    def test_enough_parametric_points_skips_curves(self, monkeypatch):
        """With 9+ parametric points, curve sampling is not consulted."""
        monkeypatch.setattr(gmsh_utils, "classify_gmsh_surface_type", lambda d, t: "plane")
        monkeypatch.setattr(
            gmsh_utils,
            "sample_surface_parametric",
            lambda d, t, n: [[float(i), 0.0, 0.0] for i in range(9)],
        )

        def should_not_run(d, t):
            raise AssertionError("curve sampler ran")

        monkeypatch.setattr(gmsh_utils, "sample_surface_from_curves", should_not_run)

        points, _ = gmsh_utils.get_surface_points(2, 1)

        assert len(points) == 9
