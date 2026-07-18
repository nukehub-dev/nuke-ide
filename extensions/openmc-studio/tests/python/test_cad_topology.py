"""Tests for cad_conversion.topology (pure data-structure transforms)."""

import pytest
from cad_conversion.topology import (
    detect_boolean_ops,
    merge_coplanar_surfaces,
    normalize_plane,
)


class TestNormalizePlane:
    def test_scales_to_unit_normal(self):
        """[2, 0, 0, -4] normalizes to [1, 0, 0, -2]."""
        assert normalize_plane([2, 0, 0, -4]) == pytest.approx([1, 0, 0, -2])

    def test_flips_negative_z_normal(self):
        """A -z normal is flipped to +z (and d with it)."""
        assert normalize_plane([0, 0, -5, 10]) == pytest.approx([0, 0, 1, -2])

    def test_flips_negative_y_normal(self):
        """A -y normal (with a == 0) is flipped to +y."""
        assert normalize_plane([0, -3, 0, 6]) == pytest.approx([0, 1, 0, -2])

    def test_flips_negative_x_normal(self):
        """A -x normal is flipped to +x."""
        assert normalize_plane([-2, 0, 0, 4]) == pytest.approx([1, 0, 0, -2])

    def test_short_coefficient_list_returned_as_is(self):
        """Fewer than 4 coefficients are returned unchanged."""
        assert normalize_plane([1, 2]) == [1, 2]

    def test_zero_normal_returns_z_default(self):
        """A degenerate zero normal falls back to [0, 0, 1, d]."""
        assert normalize_plane([0, 0, 0, 5]) == [0.0, 0.0, 1.0, 5]


def _plane(surf_id, coeffs, name=None):
    """Build a surface dict in the shape merge_coplanar_surfaces expects."""
    return {
        "id": surf_id,
        "type": "plane",
        "coefficients": coeffs,
        "name": name or f"surf_{surf_id}",
    }


class TestMergeCoplanarSurfaces:
    def test_empty_input(self):
        """Empty list in, empty list out."""
        assert merge_coplanar_surfaces([]) == []

    def test_merges_scaled_duplicate_planes(self):
        """[1,0,0,-2] and [2,0,0,-4] describe the same plane and merge."""
        surfaces = [_plane(1, [1, 0, 0, -2]), _plane(2, [2, 0, 0, -4])]
        merged = merge_coplanar_surfaces(surfaces)
        assert len(merged) == 1
        assert merged[0]["_merged_ids"] == [1, 2]
        # The surviving entry is a copy; the input dict is not mutated.
        assert "_merged_ids" not in surfaces[0]

    def test_merges_opposite_orientation_planes(self):
        """Planes with flipped normals but same geometry still merge."""
        surfaces = [_plane(1, [1, 0, 0, -2]), _plane(2, [-1, 0, 0, 2])]
        merged = merge_coplanar_surfaces(surfaces)
        assert len(merged) == 1
        assert merged[0]["_merged_ids"] == [1, 2]

    def test_parallel_but_offset_planes_do_not_merge(self):
        """Same normal, different offset: no merge."""
        surfaces = [_plane(1, [1, 0, 0, -2]), _plane(2, [1, 0, 0, -3])]
        merged = merge_coplanar_surfaces(surfaces)
        assert len(merged) == 2
        assert all("_merged_ids" not in s for s in merged)

    def test_non_plane_surfaces_pass_through_untouched(self):
        """Spheres/cylinders are never merged and keep their identity."""
        sphere = {"id": 9, "type": "sphere", "coefficients": [0, 0, 0, 1], "name": "s"}
        merged = merge_coplanar_surfaces([sphere])
        assert merged == [sphere]
        assert merged[0] is sphere

    def test_plane_with_short_coefficients_passes_through(self):
        """A malformed plane dict (too few coefficients) is kept as-is."""
        bad = {"id": 3, "type": "plane", "coefficients": [1, 0], "name": "bad"}
        merged = merge_coplanar_surfaces([bad])
        assert merged == [bad]

    def test_duplicate_merges_across_non_adjacent_entries(self):
        """Duplicates merge even when other surfaces sit between them."""
        sphere = {"id": 5, "type": "sphere", "coefficients": [0, 0, 0, 1], "name": "s"}
        surfaces = [_plane(1, [0, 0, 1, -4]), sphere, _plane(7, [0, 0, 2, -8])]
        merged = merge_coplanar_surfaces(surfaces)
        assert len(merged) == 2
        assert merged[0]["_merged_ids"] == [1, 7]
        assert merged[1] is sphere


class TestDetectBooleanOps:
    def test_disjoint_boxes_are_union(self):
        """Non-overlapping bounding boxes suggest a union."""
        b1 = {"min": [0, 0, 0], "max": [1, 1, 1]}
        b2 = {"min": [5, 5, 5], "max": [6, 6, 6]}
        assert detect_boolean_ops(b1, b2) == "union"
        assert detect_boolean_ops(b2, b1) == "union"

    def test_containment_is_difference(self):
        """One solid fully inside the other suggests a difference."""
        outer = {"min": [0, 0, 0], "max": [10, 10, 10]}
        inner = {"min": [2, 2, 2], "max": [4, 4, 4]}
        assert detect_boolean_ops(outer, inner) == "difference"
        assert detect_boolean_ops(inner, outer) == "difference"

    def test_partial_overlap_is_intersection(self):
        """Partially overlapping boxes suggest an intersection."""
        b1 = {"min": [0, 0, 0], "max": [2, 2, 2]}
        b2 = {"min": [1, 1, 1], "max": [3, 3, 3]}
        assert detect_boolean_ops(b1, b2) == "intersection"

    def test_touching_boxes_count_as_overlapping(self):
        """Boxes touching at a face are treated as overlapping (strict <)."""
        b1 = {"min": [0, 0, 0], "max": [1, 1, 1]}
        b2 = {"min": [1, 1, 1], "max": [2, 2, 2]}
        assert detect_boolean_ops(b1, b2) == "intersection"
