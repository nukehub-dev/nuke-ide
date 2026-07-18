"""Tests for statepoint_reader (numpy tier).

Covers the NumpyEncoder, the pure-python statistics helpers, and the
error-dict shapes of the readers for missing dependencies / files. No real
statepoint files or OpenMC simulations are used.
"""

import importlib.util
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from statepoint_reader import (
    NumpyEncoder,
    analyze_keff_convergence,
    compare_statepoints,
    perform_statistical_tests,
    read_depletion_results,
    read_statepoint,
)

_HAS_OPENMC = (
    importlib.util.find_spec("openmc") is not None and importlib.util.find_spec("h5py") is not None
)


# ---------------------------------------------------------------------------
# NumpyEncoder
# ---------------------------------------------------------------------------


class TestNumpyEncoder:
    def test_numpy_scalars_and_arrays(self):
        """Numpy ints, floats, and arrays serialize to native JSON types."""
        payload = {
            "int": np.int64(7),
            "float": np.float32(1.5),
            "array": np.array([1, 2, 3]),
            "matrix": np.array([[1.0, 2.0], [3.0, 4.0]]),
        }
        data = json.loads(json.dumps(payload, cls=NumpyEncoder))
        assert data["int"] == 7
        assert data["float"] == pytest.approx(1.5)
        assert data["array"] == [1, 2, 3]
        assert data["matrix"] == [[1.0, 2.0], [3.0, 4.0]]

    def test_unsupported_type_still_raises(self):
        """Types the encoder does not handle still raise TypeError."""
        with pytest.raises(TypeError):
            json.dumps({"bad": {1, 2, 3}}, cls=NumpyEncoder)


# ---------------------------------------------------------------------------
# perform_statistical_tests
# ---------------------------------------------------------------------------


def _sp(name, keff_value, keff_std, tallies=None):
    """Build a synthetic statepoint dict as produced by read_statepoint."""
    sp = {"fileName": name, "kEff": {"value": keff_value, "stdDev": keff_std}}
    if tallies is not None:
        sp["tallies"] = tallies
    return sp


class TestPerformStatisticalTests:
    def test_consistent_keff_pair(self):
        """Two close k-eff values give a consistent weighted-mean result."""
        stats = perform_statistical_tests(
            [
                _sp("a.h5", 1.000, 0.01),
                _sp("b.h5", 1.002, 0.01),
            ]
        )
        keff = stats["kEffective"]
        assert keff["weightedMean"] == pytest.approx(1.001)
        # sqrt(1 / (2 / 0.01**2))
        assert keff["weightedUncertainty"] == pytest.approx((1 / 20000) ** 0.5)
        assert keff["ndof"] == 1
        assert keff["chi2"] == pytest.approx(0.02)
        assert keff["reducedChi2"] == pytest.approx(0.02)
        assert keff["consistency"] == "consistent"
        ci = keff["confidenceIntervals"]
        assert ci["overlapExists"] is True
        assert ci["overlapLower"] == pytest.approx(1.002 - 1.96 * 0.01)
        assert ci["overlapUpper"] == pytest.approx(1.000 + 1.96 * 0.01)

    def test_inconsistent_keff_pair(self):
        """Two far-apart k-eff values are flagged inconsistent with no CI overlap."""
        stats = perform_statistical_tests(
            [
                _sp("a.h5", 1.0, 0.001),
                _sp("b.h5", 1.1, 0.001),
            ]
        )
        keff = stats["kEffective"]
        assert keff["consistency"] == "inconsistent"
        ci = keff["confidenceIntervals"]
        assert ci["overlapExists"] is False
        assert ci["overlapLower"] is None
        assert ci["overlapUpper"] is None

    def test_single_statepoint_skips_keff_stats(self):
        """Fewer than two k-eff values leave the kEffective stats empty."""
        stats = perform_statistical_tests([_sp("a.h5", 1.0, 0.01)])
        assert stats["kEffective"] == {}

    def test_tally_consistency_checks(self):
        """Tally means within 5% are consistent; larger spreads are not."""
        tallies_close = [
            {"id": 1, "mean": [10.0], "stdDev": [0.1]},
        ]
        tallies_close2 = [
            {"id": 1, "mean": [10.1], "stdDev": [0.1]},
        ]
        stats = perform_statistical_tests(
            [
                _sp("a.h5", 1.0, 0.01, tallies_close),
                _sp("b.h5", 1.0, 0.01, tallies_close2),
            ]
        )
        t = stats["tallies"]["tally_1"]
        assert t["mean"] == pytest.approx(10.05)
        assert t["maxDeviation"] == pytest.approx(0.05)
        assert t["consistent"] is True

        stats = perform_statistical_tests(
            [
                _sp("a.h5", 1.0, 0.01, [{"id": 1, "mean": [10.0], "stdDev": [0.1]}]),
                _sp("b.h5", 1.0, 0.01, [{"id": 1, "mean": [12.0], "stdDev": [0.1]}]),
            ]
        )
        t = stats["tallies"]["tally_1"]
        assert t["relativeStdDev"] == pytest.approx(1.0 / 11.0 * 100)
        assert t["consistent"] is False


# ---------------------------------------------------------------------------
# analyze_keff_convergence
# ---------------------------------------------------------------------------


class TestAnalyzeKeffConvergence:
    def test_no_batch_data(self):
        """Missing batch data returns an error dict."""
        result = analyze_keff_convergence({"kEff": {"value": 1.0}})
        assert result == {"success": False, "error": "No batch data available"}

    def test_fewer_than_ten_batches(self):
        """Short histories report a running average with an insufficiency note."""
        sp = {
            "kEffectiveByBatch": [
                {"batch": i + 1, "value": v, "stdDev": 0.01} for i, v in enumerate([1.0, 2.0, 3.0])
            ]
        }
        result = analyze_keff_convergence(sp)
        assert result["success"] is True
        assert result["runningAverage"] == pytest.approx([1.0, 1.5, 2.0])
        assert result["finalValue"] == 3.0
        assert result["note"] == "Insufficient batches for convergence analysis"
        assert "converged" not in result

    def test_converged_constant_history(self):
        """A constant 20-batch history is reported as converged."""
        sp = {
            "kEffectiveByBatch": [{"batch": i + 1, "value": 1.0, "stdDev": 0.01} for i in range(20)]
        }
        result = analyze_keff_convergence(sp)
        assert result["success"] is True
        assert result["drift"] == pytest.approx(0.0)
        assert result["driftPercent"] == pytest.approx(0.0)
        assert result["converged"] is True
        assert result["recommendation"] == "Converged"
        assert result["finalValue"] == 1.0
        assert result["finalUncertainty"] == 0.01
        assert len(result["runningAverage"]) == 20

    def test_drifting_history_not_converged(self):
        """A rising 20-batch history drifts >5% and asks for more batches."""
        values = [1.0 + i / 19 for i in range(20)]
        sp = {
            "kEffectiveByBatch": [
                {"batch": i + 1, "value": v, "stdDev": 0.01} for i, v in enumerate(values)
            ]
        }
        result = analyze_keff_convergence(sp)
        assert result["success"] is True
        assert result["converged"] is False
        assert result["driftPercent"] > 5.0
        assert result["recommendation"] == "More batches recommended"


# ---------------------------------------------------------------------------
# Reader error shapes (no real statepoint files)
# ---------------------------------------------------------------------------


class TestReaderErrorShapes:
    def test_read_statepoint_nonexistent_file(self, tmp_path):
        """A nonexistent path yields a failure dict with an error message."""
        result = read_statepoint(str(tmp_path / "nope.h5"))
        assert result["success"] is False
        assert isinstance(result["error"], str)
        if _HAS_OPENMC:
            assert "File not found" in result["error"]

    def test_read_statepoint_missing_dependency(self, monkeypatch, tmp_path):
        """Blocking openmc triggers the documented missing-dependency error."""
        f = tmp_path / "sp.h5"
        f.write_bytes(b"not really hdf5")
        monkeypatch.setitem(sys.modules, "openmc", None)
        result = read_statepoint(str(f))
        assert result["success"] is False
        assert result["error"].startswith("Missing dependency:")

    def test_compare_statepoints_all_failures(self, tmp_path):
        """When every file fails, success is False and errors are itemized."""
        f1 = str(tmp_path / "a.h5")
        f2 = str(tmp_path / "b.h5")
        result = compare_statepoints([f1, f2])
        assert result["success"] is False
        assert result["statepoints"] == []
        assert len(result["errors"]) == 2
        assert result["errors"][0]["file"] == f1
        assert result["errors"][1]["file"] == f2
        assert all(isinstance(e["error"], str) for e in result["errors"])

    def test_read_depletion_results_nonexistent_file(self, tmp_path):
        """A nonexistent depletion file yields a failure dict."""
        result = read_depletion_results(str(tmp_path / "nope.h5"))
        assert result["success"] is False
        assert isinstance(result["error"], str)
        if _HAS_OPENMC:
            assert "File not found" in result["error"]

    def test_read_depletion_results_missing_dependency(self, monkeypatch, tmp_path):
        """Blocking openmc triggers the depletion missing-dependency error."""
        f = tmp_path / "depletion_results.h5"
        f.write_bytes(b"not really hdf5")
        monkeypatch.setitem(sys.modules, "openmc", None)
        result = read_depletion_results(str(f))
        assert result["success"] is False
        assert result["error"].startswith("Missing dependency:")
