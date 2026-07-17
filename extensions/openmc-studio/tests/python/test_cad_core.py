"""Tests for cad_conversion.core (pure stdlib utilities and dataclasses)."""

import random

import pytest

from cad_conversion import core
from cad_conversion.core import (
    SurfaceFitResult,
    TopologyInfo,
    cross_product,
    distance_point_to_line,
    dot_product,
    is_axis_aligned,
    normalize_vector,
    ransac_fit,
    vector_add,
    vector_scale,
    vector_subtract,
)


class TestNormalizeVector:
    def test_unit_vector_unchanged(self):
        """A unit vector normalizes to itself."""
        assert normalize_vector([1.0, 0.0, 0.0]) == [1.0, 0.0, 0.0]

    def test_scales_to_unit_length(self):
        """[1, 2, 2] has length 3, so it becomes thirds."""
        result = normalize_vector([1.0, 2.0, 2.0])
        assert result == pytest.approx([1 / 3, 2 / 3, 2 / 3])

    def test_zero_vector_returns_z_axis_default(self):
        """A near-zero vector falls back to [0, 0, 1]."""
        assert normalize_vector([0.0, 0.0, 0.0]) == [0.0, 0.0, 1.0]
        assert normalize_vector([1e-12, 0.0, 0.0]) == [0.0, 0.0, 1.0]


class TestCrossAndDot:
    def test_cross_product_basis_vectors(self):
        """i x j = k and j x i = -k."""
        assert cross_product([1, 0, 0], [0, 1, 0]) == [0, 0, 1]
        assert cross_product([0, 1, 0], [1, 0, 0]) == [0, 0, -1]

    def test_cross_product_parallel_is_zero(self):
        """Cross product of parallel vectors is the zero vector."""
        assert cross_product([1, 2, 3], [2, 4, 6]) == [0, 0, 0]

    def test_dot_product_known_value(self):
        """[1,2,3] . [4,5,6] = 32."""
        assert dot_product([1, 2, 3], [4, 5, 6]) == 32

    def test_dot_product_orthogonal_is_zero(self):
        """Orthogonal vectors have a zero dot product."""
        assert dot_product([1, 0, 0], [0, 1, 0]) == 0


class TestVectorArithmetic:
    def test_add_subtract_scale(self):
        """Basic component-wise vector arithmetic."""
        assert vector_add([1, 2, 3], [4, 5, 6]) == [5, 7, 9]
        assert vector_subtract([4, 5, 6], [1, 2, 3]) == [3, 3, 3]
        assert vector_scale([1, -2, 3], 2.5) == [2.5, -5.0, 7.5]


class TestDistancePointToLine:
    def test_perpendicular_distance(self):
        """Point 3 units above the x-axis has distance 3."""
        assert distance_point_to_line([0, 3, 0], [0, 0, 0], [1, 0, 0]) == pytest.approx(3.0)

    def test_point_on_line_has_zero_distance(self):
        """A point on the line has zero distance."""
        assert distance_point_to_line([5, 0, 0], [0, 0, 0], [1, 0, 0]) == pytest.approx(0.0)

    def test_non_unit_direction(self):
        """The direction vector need not be normalized."""
        assert distance_point_to_line([1, 1, 0], [0, 0, 0], [2, 0, 0]) == pytest.approx(1.0)

    def test_degenerate_direction_returns_point_distance(self):
        """A zero direction degrades to point-to-point distance."""
        assert distance_point_to_line([3, 4, 0], [0, 0, 0], [0, 0, 0]) == pytest.approx(5.0)


class TestIsAxisAligned:
    @pytest.mark.parametrize("axis,expected", [
        ([1, 0, 0], 'x'),
        ([-1, 0, 0], 'x'),
        ([0, 1, 0], 'y'),
        ([0, 0, -1], 'z'),
        ([0.98, 0.01, 0.01], 'x'),
    ])
    def test_aligned_axes(self, axis, expected):
        """Axes close to a coordinate axis are classified."""
        assert is_axis_aligned(axis) == expected

    @pytest.mark.parametrize("axis", [
        [0.7071, 0.7071, 0.0],
        [0.9, 0.09, 0.09],   # dominant x but outside default tol
        [1.0, 0.06, 0.0],    # second component exceeds tol
    ])
    def test_non_aligned_axes_return_none(self, axis):
        """Tilted axes return None."""
        assert is_axis_aligned(axis) is None


class TestRansacFit:
    def test_fewer_points_than_sample_size(self):
        """Returns (None, all-indices) when there are too few points."""
        model, inliers = ransac_fit(
            [[0, 0, 0], [1, 1, 1]],
            fit_fn=lambda s: object(),
            evaluate_fn=lambda m, p: 0.0,
            sample_size=3,
        )
        assert model is None
        assert inliers == [0, 1]

    def test_fit_fn_always_none(self):
        """If no model can be fit, returns (None, [])."""
        model, inliers = ransac_fit(
            [[float(i), 0.0, 0.0] for i in range(10)],
            fit_fn=lambda s: None,
            evaluate_fn=lambda m, p: 0.0,
            sample_size=3,
            max_iterations=20,
        )
        assert model is None
        assert inliers == []

    def test_picks_best_scoring_model_with_outliers(self):
        """RANSAC recovers the dominant model and ignores outliers."""
        random.seed(42)
        inlier_points = [[float(i), 2.0, 0.0] for i in range(50)]
        outlier_points = [[float(i), 20.0, 5.0] for i in range(10)]
        points = inlier_points + outlier_points

        def fit_fn(sample):
            # Model: mean y of the sample.
            return sum(p[1] for p in sample) / len(sample)

        def evaluate_fn(model, point):
            return abs(point[1] - model)

        model, inlier_idx = ransac_fit(
            points, fit_fn, evaluate_fn,
            sample_size=3, max_iterations=200, inlier_threshold=0.5,
        )
        assert model is not None
        # Refit happens on the full inlier set, so the mean y is ~2.0.
        assert model == pytest.approx(2.0, abs=0.6)
        # Essentially all 50 true inliers are found, outliers excluded.
        assert len(inlier_idx) >= 45
        assert all(points[i][1] == 2.0 for i in inlier_idx)


class TestDataclasses:
    def test_surface_fit_result_defaults(self):
        """Optional fields default to None and metadata to an empty dict."""
        r = SurfaceFitResult(surface_type='plane', coefficients=[0, 0, 1, -5],
                             max_deviation=0.0)
        assert r.center is None
        assert r.axis is None
        assert r.radius is None
        assert r.warning is None
        assert r.metadata == {}

    def test_surface_fit_result_metadata_not_shared(self):
        """The default metadata dict is not shared between instances."""
        r1 = SurfaceFitResult('plane', [], 0.0)
        r2 = SurfaceFitResult('plane', [], 0.0)
        r1.metadata['k'] = 1
        assert r2.metadata == {}

    def test_topology_info_defaults(self):
        """TopologyInfo adjacency/shared_faces default to empty dicts."""
        t = TopologyInfo(solid_count=2, face_count=6, edge_count=12, vertex_count=8)
        assert t.solid_count == 2
        assert t.adjacency == {}
        assert t.shared_faces == {}
        t.adjacency[1] = [2]
        assert TopologyInfo(0, 0, 0, 0).adjacency == {}
