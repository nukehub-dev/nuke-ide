"""Edge-case coverage for the nuke-cad curve builder helpers."""

from __future__ import annotations

import curve_builder as cb
import pytest


def test_is_closed_and_spacing_need_at_least_two_points():
    assert cb._is_closed([]) is False
    assert cb._is_closed([(0.0, 0.0, 0.0)]) is False
    assert cb._average_spacing([(0.0, 0.0, 0.0)]) == 1.0


def test_interpolate_rejects_a_failed_operation(monkeypatch):
    class FailedInterpolate:
        def __init__(self, *args, **kwargs):
            pass

        def Perform(self):
            pass

        def IsDone(self):
            return False

    monkeypatch.setattr(cb, "_harray_of_points", lambda points: object())
    monkeypatch.setattr(cb, "GeomAPI_Interpolate", FailedInterpolate)
    with pytest.raises(cb.CurveBuildError, match="interpolation failed"):
        cb._interpolate([(0.0, 0.0, 0.0)] * 4, False)


def test_approximate_rejects_a_failed_operation(monkeypatch):
    class FailedApproximate:
        def __init__(self, *args, **kwargs):
            pass

        def IsDone(self):
            return False

    monkeypatch.setattr(cb, "_array_of_points", lambda points: object())
    monkeypatch.setattr(cb, "GeomAPI_PointsToBSpline", FailedApproximate)
    with pytest.raises(cb.CurveBuildError, match="approximation failed"):
        cb._approximate([(0.0, 0.0, 0.0)] * 4)


def test_fit_curve_requires_four_points():
    with pytest.raises(cb.CurveBuildError, match="at least 4 points"):
        cb._fit_curve("c1", "Short", {}, [(0.0, 0.0, 0.0)] * 3)


def test_fit_curve_reports_a_failed_wire(monkeypatch):
    class Curve:
        def FirstParameter(self):
            return 0.0

        def LastParameter(self):
            return 1.0

    class EdgeMaker:
        def __init__(self, *args, **kwargs):
            pass

        def Edge(self):
            return object()

    class WireMaker:
        def Add(self, edge):
            pass

        def IsDone(self):
            return False

    monkeypatch.setattr(cb, "_require_ocp", lambda: None)
    monkeypatch.setattr(cb, "_is_closed", lambda points: False)
    monkeypatch.setattr(cb, "_interpolate", lambda points, closed: Curve())
    monkeypatch.setattr(cb, "BRepBuilderAPI_MakeEdge", EdgeMaker)
    monkeypatch.setattr(cb, "BRepBuilderAPI_MakeWire", WireMaker)
    with pytest.raises(cb.CurveBuildError, match="could not build wire"):
        cb._fit_curve("c1", "Broken", {}, [(0.0, 0.0, 0.0)] * 4)


def test_build_curves_rejects_a_non_object_entry():
    with pytest.raises(cb.CurveBuildError, match="expected a curve object"):
        cb.build_curves({"curves": [None]})
