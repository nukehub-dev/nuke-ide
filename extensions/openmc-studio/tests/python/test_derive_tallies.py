"""Derived-tally evaluator tests (no real OpenMC install required)."""

import json
import sys
import types

import derive_tallies
import numpy as np
import pytest


class CellFilter:
    def __init__(self, bins):
        self.bins = list(bins)
        self.num_bins = len(self.bins)


class EnergyFilter:
    def __init__(self, bounds):
        self.bins = [[bounds[index], bounds[index + 1]] for index in range(len(bounds) - 1)]
        self.num_bins = len(self.bins)


class FakeTally:
    def __init__(self, filters, scores, nuclides, mean, std):
        self.filters = filters
        self.scores = list(scores)
        self.nuclides = list(nuclides)
        self.mean = np.asarray(mean, dtype=float).reshape(-1, len(nuclides), len(scores))
        self.std_dev = np.asarray(std, dtype=float).reshape(-1, len(nuclides), len(scores))


class FakeStatePoint:
    def __init__(self, tallies):
        self.tallies = tallies

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def operand(tally_id, score="flux", nuclide=None):
    value = {"kind": "tally", "tallyId": tally_id, "score": score}
    if nuclide is not None:
        value["nuclide"] = nuclide
    return value


def binary(op, left, right):
    return {"kind": "binary", "op": op, "left": left, "right": right}


def scalar(value):
    return {"kind": "scalar", "value": value}


@pytest.fixture()
def statepoint():
    flux = FakeTally([CellFilter([1, 2])], ["flux"], ["total"], [10, 20], [1, 2])
    fission = FakeTally([CellFilter([1, 2])], ["fission"], ["total"], [2, 4], [0.2, 0.4])
    return FakeStatePoint({1: flux, 2: fission})


def test_ratio_propagates_uncertainty_and_reports_axes(statepoint):
    definition = {
        "id": 1,
        "name": "Capture / fission",
        "expression": binary("/", operand(1, "flux"), operand(2, "fission")),
        "unit": "ratio",
        "color": "#4a9eff",
    }

    result = derive_tallies.evaluate_derived_tally(statepoint, definition)

    assert result["mean"] == pytest.approx([5.0, 5.0])
    expected = 5.0 * np.sqrt((1 / 10) ** 2 + (0.2 / 2) ** 2)
    assert result["stdDev"] == pytest.approx([expected, expected])
    assert result["formula"] == "T1[flux] / T2[fission]"
    assert result["totalBins"] == 2
    assert result["filters"] == [{"type": "cell", "bins": [1, 2]}]
    assert result["scores"] == ["(flux / fission)"]
    assert result["nuclides"] == ["total"]
    assert result["shape"] == {"filterBins": 2, "nuclides": 1, "scores": 1}
    assert result["unit"] == "ratio"


def test_scalar_scaling_and_sum_difference(statepoint):
    scaled = binary("+", binary("*", operand(1, "flux"), scalar(2)), scalar(1))
    result = derive_tallies.evaluate_derived_tally(
        statepoint, {"id": 1, "name": "scaled", "expression": scaled}
    )
    assert result["mean"] == pytest.approx([21.0, 41.0])
    assert result["stdDev"] == pytest.approx([2.0, 4.0])

    summed = binary("+", operand(1, "flux"), operand(2, "fission"))
    sum_result = derive_tallies.evaluate_derived_tally(
        statepoint, {"id": 2, "name": "sum", "expression": summed}
    )
    assert sum_result["mean"] == pytest.approx([12.0, 24.0])
    assert sum_result["stdDev"] == pytest.approx([np.sqrt(1 + 0.2**2), np.sqrt(4 + 0.4**2)])

    difference = binary("-", operand(1, "flux"), operand(2, "fission"))
    diff_result = derive_tallies.evaluate_derived_tally(
        statepoint, {"id": 3, "name": "diff", "expression": difference}
    )
    assert diff_result["mean"] == pytest.approx([8.0, 16.0])
    assert diff_result["formula"] == "T1[flux] - T2[fission]"


def test_filter_axes_broadcast_across_operands(statepoint):
    statepoint.tallies[1] = FakeTally([], ["flux"], ["total"], [10], [1])
    result = derive_tallies.evaluate_derived_tally(
        statepoint,
        {
            "id": 1,
            "name": "ratio",
            "expression": binary("/", operand(1, "flux"), operand(2, "fission")),
        },
    )
    assert result["mean"] == pytest.approx([5.0, 2.5])
    assert result["filters"] == [{"type": "cell", "bins": [1, 2]}]
    assert result["shape"] == {"filterBins": 2, "nuclides": 1, "scores": 1}


def test_nuclide_restriction_selects_one_axis(statepoint):
    statepoint.tallies[1] = FakeTally(
        [CellFilter([1])],
        ["flux"],
        ["total", "U235"],
        [10, 20],
        [1, 2],
    )
    result = derive_tallies.evaluate_derived_tally(
        statepoint,
        {"id": 1, "name": "U235 flux", "expression": operand(1, "flux", "U235")},
    )
    assert result["mean"] == pytest.approx([20.0])
    assert result["nuclides"] == ["U235"]
    assert result["formula"] == "T1[flux:U235]"


def test_different_filter_bins_report_an_actionable_shape_error(statepoint):
    statepoint.tallies[2] = FakeTally([CellFilter([9])], ["fission"], ["total"], [2], [0.2])
    with pytest.raises(derive_tallies.DerivedTallyError, match="cell filter bins differ"):
        derive_tallies.evaluate_derived_tally(
            statepoint,
            {
                "id": 1,
                "name": "bad",
                "expression": binary("/", operand(1, "flux"), operand(2, "fission")),
            },
        )


def test_scalar_division_by_zero_is_rejected(statepoint):
    with pytest.raises(derive_tallies.DerivedTallyError, match="scalar zero"):
        derive_tallies.evaluate_derived_tally(
            statepoint,
            {"id": 1, "name": "bad", "expression": binary("/", operand(1, "flux"), scalar(0))},
        )


def test_zero_tally_bins_become_zero_with_a_warning(statepoint):
    statepoint.tallies[2] = FakeTally(
        [CellFilter([1, 2])], ["fission"], ["total"], [0, 4], [0, 0.4]
    )
    result = derive_tallies.evaluate_derived_tally(
        statepoint,
        {
            "id": 1,
            "name": "ratio",
            "expression": binary("/", operand(1, "flux"), operand(2, "fission")),
        },
    )
    assert result["mean"][0] == 0.0
    assert result["stdDev"][0] == 0.0
    assert any("divide by a zero tally mean" in warning for warning in result["warnings"])


def test_unknown_tally_score_and_nuclide_errors(statepoint):
    with pytest.raises(derive_tallies.DerivedTallyError, match="Tally 7 is not in the statepoint"):
        derive_tallies.evaluate_derived_tally(
            statepoint, {"id": 1, "name": "bad", "expression": operand(7, "flux")}
        )
    with pytest.raises(derive_tallies.DerivedTallyError, match="does not score 'heating'"):
        derive_tallies.evaluate_derived_tally(
            statepoint, {"id": 1, "name": "bad", "expression": operand(1, "heating")}
        )
    with pytest.raises(derive_tallies.DerivedTallyError, match="does not track nuclide 'U235'"):
        derive_tallies.evaluate_derived_tally(
            statepoint, {"id": 1, "name": "bad", "expression": operand(1, "flux", "U235")}
        )


def test_scalar_only_expression_is_rejected(statepoint):
    with pytest.raises(derive_tallies.DerivedTallyError, match="reference at least one tally"):
        derive_tallies.evaluate_derived_tally(
            statepoint, {"id": 1, "name": "scalar", "expression": binary("+", scalar(1), scalar(2))}
        )


def test_run_reports_success_and_per_tally_errors_even_without_real_openmc(monkeypatch, tmp_path):
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = lambda path: FakeStatePoint(
        {
            1: FakeTally([CellFilter([1])], ["flux"], ["total"], [10], [1]),
        }
    )
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)

    statepoint_path = tmp_path / "statepoint.1.h5"
    statepoint_path.write_bytes(b"fake")
    definitions = [
        {"id": 1, "name": "good", "expression": operand(1, "flux")},
        {"id": 2, "name": "bad", "expression": operand(1, "heating")},
    ]

    result = derive_tallies.run(str(statepoint_path), json.dumps(definitions))

    assert result["success"] is True
    assert [entry["name"] for entry in result["derivedTallies"]] == ["good"]
    assert result["errors"][0]["name"] == "bad"
    assert "does not score" in result["errors"][0]["error"]


def test_main_prints_one_json_object_and_handles_missing_definitions(monkeypatch, capsys, tmp_path):
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = lambda path: FakeStatePoint(
        {1: FakeTally([CellFilter([1])], ["flux"], ["total"], [10], [1])}
    )
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    statepoint_path = tmp_path / "statepoint.2.h5"
    statepoint_path.write_bytes(b"fake")
    definitions_path = tmp_path / "derived.json"
    definitions_path.write_text(
        json.dumps([{"id": 1, "name": "flux", "expression": operand(1, "flux")}]),
        encoding="utf-8",
    )

    exit_code = derive_tallies.main(
        [
            "--statepoint",
            str(statepoint_path),
            "--definitions-file",
            str(definitions_path),
            "--json",
        ]
    )
    output = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert output["success"] is True
    assert output["derivedTallies"][0]["formula"] == "T1[flux]"

    exit_code = derive_tallies.main(["--statepoint", str(statepoint_path)])
    output = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert output["success"] is False
    assert "No derived-tally definitions" in output["error"]


def test_hdf5_fallback_reads_sum_sq_moments(tmp_path):
    h5py = pytest.importorskip("h5py", reason="fallback reader requires h5py")
    path = tmp_path / "statepoint.3.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = "flux"
        tally["score_bins"] = np.array([b"flux"])
        tally["nuclides"] = np.array([b"total"])
        tally["n_realizations"] = 2
        # [sum, sum_sq] for two energy bins: means 10 and 20, std 2 and 4.
        tally["results"] = np.array([[[[20.0, 208.0]]], [[[40.0, 832.0]]]])
        tally["filters"] = np.array([1])
        filters = tallies.create_group("filters")
        energy = filters.create_group("filter 1")
        energy["type"] = np.bytes_(b"energy")
        energy["bins"] = np.array([[0.0, 1.0], [1.0, 2.0]])
        energy["n_bins"] = 2

    tallies_map = derive_tallies.load_hdf5_statepoint(path)
    statepoint = types.SimpleNamespace(tallies=tallies_map)
    result = derive_tallies.evaluate_derived_tally(
        statepoint, {"id": 1, "name": "flux", "expression": operand(1, "flux")}
    )
    assert result["mean"] == pytest.approx([10.0, 20.0])
    assert result["stdDev"] == pytest.approx([2.0, 4.0])
    assert result["filters"] == [{"type": "energy", "bins": [[0.0, 1.0], [1.0, 2.0]]}]


def test_main_reports_invalid_definitions_json(monkeypatch, capsys, tmp_path):
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = lambda path: FakeStatePoint({})
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    statepoint_path = tmp_path / "statepoint.4.h5"
    statepoint_path.write_bytes(b"fake")

    exit_code = derive_tallies.main(
        ["--statepoint", str(statepoint_path), "--definitions", "not-json", "--json"]
    )
    output = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert output["success"] is False
    assert "not valid JSON" in output["error"]


def test_parse_definitions_rejects_duplicate_ids():
    with pytest.raises(derive_tallies.DerivedTallyError, match="duplicated"):
        derive_tallies.parse_definitions(
            json.dumps(
                [
                    {"id": 1, "name": "one", "expression": operand(1)},
                    {"id": 1, "name": "two", "expression": operand(1)},
                ]
            )
        )


def test_energy_and_mesh_filter_axes_are_reported():
    class MeshFilter:
        def __init__(self):
            self.bins = [(1, 2, 3), (2, 2, 3)]
            self.num_bins = 2

    statepoint = FakeStatePoint(
        {
            1: FakeTally(
                [EnergyFilter([0, 1e6, 2e6]), MeshFilter()],
                ["flux"],
                ["total"],
                [1, 2, 3, 4],
                [0.1] * 4,
            )
        }
    )
    result = derive_tallies.evaluate_derived_tally(
        statepoint, {"id": 1, "name": "flux", "expression": operand(1, "flux")}
    )
    assert [axis["type"] for axis in result["filters"]] == ["energy", "mesh"]
    assert result["filters"][0]["bins"] == [[0, 1e6], [1e6, 2e6]]
    assert result["filters"][1]["bins"] == [[1, 2, 3], [2, 2, 3]]
    assert result["shape"]["filterBins"] == 4
    assert result["totalBins"] == 4
