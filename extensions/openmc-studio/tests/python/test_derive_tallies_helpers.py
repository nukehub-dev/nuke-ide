"""Extended derived-tally tests: formatting, arithmetic branches, and HDF5 fallback."""

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


def operand(tally_id, score="flux", nuclide=None):
    value = {"kind": "tally", "tallyId": tally_id, "score": score}
    if nuclide is not None:
        value["nuclide"] = nuclide
    return value


def binary(op, left, right):
    return {"kind": "binary", "op": op, "left": left, "right": right}


def scalar(value):
    return {"kind": "scalar", "value": value}


def unary(op, child):
    return {"kind": "unary", "op": op, "operand": child}


def derived_value(mean, std=None, filters=None, nuclides=None, score="flux", warnings=None):
    mean_array = np.asarray(mean, dtype=float)
    if std is None:
        std = np.zeros_like(mean_array)
    return derive_tallies.DerivedValue(
        mean_array,
        np.asarray(std, dtype=float),
        [derive_tallies._filter_axis(item) for item in filters or []],
        list(nuclides or ["total"]),
        score,
        list(warnings or []),
    )


def _h5py():
    return pytest.importorskip("h5py", reason="HDF5 statepoint fixtures require h5py")


def _raise_statepoint(path):
    raise RuntimeError("unreadable statepoint")


def _write_simple_statepoint(path):
    h5py = _h5py()
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally["score_bins"] = np.array([b"flux"])
        tally["nuclides"] = np.array([b"total"])
        tally["results"] = np.array([[[[20.0, 208.0]]]])


def test_numpy_encoder_serializes_numpy_scalars_and_arrays():
    payload = {
        "integer": np.int32(3),
        "float": np.float32(2.5),
        "non_finite": np.float32(np.inf),
        "array": np.array([1, 2], dtype=np.int32),
    }
    assert json.loads(json.dumps(payload, cls=derive_tallies.NumpyEncoder)) == {
        "integer": 3,
        "float": 2.5,
        "non_finite": 0.0,
        "array": [1, 2],
    }

    with pytest.raises(TypeError, match="not JSON serializable"):
        json.dumps({"object": object()}, cls=derive_tallies.NumpyEncoder)


def test_canonical_converts_numpy_scalars_bytes_and_arrays():
    assert derive_tallies._canonical(np.int32(3)) == 3
    assert derive_tallies._canonical(np.float32(2.5)) == 2.5
    assert derive_tallies._canonical(np.float32(np.inf)) == 0.0
    assert derive_tallies._canonical(b"cell") == "cell"
    assert derive_tallies._canonical(np.array([b"cell", b"fuel"])) == ["cell", "fuel"]


def test_filter_axis_prefers_an_explicit_type_name():
    axis = derive_tallies._filter_axis(
        types.SimpleNamespace(type_name="energy", bins=[1.0], num_bins=1)
    )
    assert (axis.type, axis.bins, axis.bin_count) == ("energy", [1.0], 1)


def test_format_number_zero_integer_and_fraction():
    assert derive_tallies.format_number(0) == "0"
    assert derive_tallies.format_number(3.0) == "3"
    assert derive_tallies.format_number(2.5) == "2.5"


def test_format_expression_rejects_non_dict_and_missing_score():
    with pytest.raises(derive_tallies.DerivedTallyError, match="no expression"):
        derive_tallies.format_expression(["not", "a", "dict"])
    with pytest.raises(derive_tallies.DerivedTallyError, match="missing its score"):
        derive_tallies.format_expression({"kind": "tally", "tallyId": 1})


def test_format_expression_unary_and_binary_precedence():
    assert derive_tallies.format_expression(unary("-", operand(1))) == "-T1[flux]"
    assert (
        derive_tallies.format_expression(unary("-", binary("+", operand(1), operand(2, "fission"))))
        == "-(T1[flux] + T2[fission])"
    )
    assert (
        derive_tallies.format_expression(
            binary("*", binary("+", operand(1), operand(2, "fission")), scalar(2))
        )
        == "(T1[flux] + T2[fission]) * 2"
    )


def test_format_expression_rejects_invalid_operators_and_node_kinds():
    with pytest.raises(derive_tallies.DerivedTallyError, match="Only unary negation"):
        derive_tallies.format_expression(unary("+", scalar(1)))
    with pytest.raises(derive_tallies.DerivedTallyError, match="Unsupported operator"):
        derive_tallies.format_expression(binary("%", scalar(1), scalar(2)))
    with pytest.raises(derive_tallies.DerivedTallyError, match="Unknown derived expression node"):
        derive_tallies.format_expression({"kind": "matrix"})


def test_constant_value_folds_scalars_and_rejects_nonconstants():
    assert derive_tallies.constant_value(scalar(2.5)) == 2.5
    assert derive_tallies.constant_value(scalar(float("inf"))) is None
    assert derive_tallies.constant_value(operand(1)) is None
    assert derive_tallies.constant_value(None) is None
    assert derive_tallies.constant_value(unary("-", scalar(3))) == -3
    assert derive_tallies.constant_value(unary("-", operand(1))) is None


def test_constant_value_binary_operators_and_zero_division():
    assert derive_tallies.constant_value(binary("+", scalar(1), scalar(2))) == 3
    assert derive_tallies.constant_value(binary("-", scalar(1), scalar(2))) == -1
    assert derive_tallies.constant_value(binary("*", scalar(2), scalar(3))) == 6
    assert derive_tallies.constant_value(binary("/", scalar(3), scalar(2))) == 1.5
    assert derive_tallies.constant_value(binary("/", scalar(3), scalar(0))) is None
    assert derive_tallies.constant_value(binary("+", operand(1), scalar(2))) is None
    assert derive_tallies.constant_value(binary("%", scalar(1), scalar(2))) is None


def test_validate_division_by_zero_ignores_non_dict_and_scans_unary():
    derive_tallies.validate_division_by_zero(None)
    with pytest.raises(derive_tallies.DerivedTallyError, match="scalar zero"):
        derive_tallies.validate_division_by_zero(unary("-", binary("/", scalar(1), scalar(0))))


def test_combine_score_names():
    assert derive_tallies._combine_score(None, None, "+") == "derived"
    assert derive_tallies._combine_score(None, "flux", "+") == "flux"
    assert derive_tallies._combine_score("flux", None, "+") == "flux"
    assert derive_tallies._combine_score("flux", "fission", "/") == "(flux / fission)"


def test_scalar_binary_operators_and_division_by_zero():
    assert derive_tallies._scalar_binary(5, 2, "+") == 7
    assert derive_tallies._scalar_binary(5, 2, "-") == 3
    assert derive_tallies._scalar_binary(5, 2, "*") == 10
    assert derive_tallies._scalar_binary(5, 2, "/") == 2.5
    with pytest.raises(derive_tallies.DerivedTallyError, match="Division by zero"):
        derive_tallies._scalar_binary(5, 0, "/")


def test_apply_finite_zeroes_non_finite_moments_with_warning():
    value = derived_value([np.nan, np.inf, 1.0], std=[np.inf, 1.0, 1.0])
    result = derive_tallies._apply_finite(value)
    assert result.mean.tolist() == [0.0, 0.0, 1.0]
    assert result.std.tolist() == [0.0, 1.0, 1.0]
    assert result.warnings == [
        "3 non-finite moment(s) were written as zero (OpenMC tally arithmetic convention)."
    ]


def test_scalar_on_left_arithmetic_branches():
    value = derived_value([[2.0], [0.0]], std=[[0.2], [0.5]], filters=[CellFilter([1, 2])])

    added = derive_tallies._binary_value(1.0, value, "+")
    assert added.mean.ravel().tolist() == [3.0, 1.0]
    assert added.std.ravel().tolist() == [0.2, 0.5]

    subtracted = derive_tallies._binary_value(1.0, value, "-")
    assert subtracted.mean.ravel().tolist() == [-1.0, 1.0]
    assert subtracted.std.ravel().tolist() == [0.2, 0.5]

    multiplied = derive_tallies._binary_value(3.0, value, "*")
    assert multiplied.mean.ravel().tolist() == [6.0, 0.0]
    assert multiplied.std.ravel().tolist() == pytest.approx([0.6, 1.5])

    assert derive_tallies._binary_value(4, 2, "-") == 2


def test_scalar_on_left_division_masks_zero_bins():
    value = derived_value([[2.0], [0.0]], std=[[0.2], [0.5]], filters=[CellFilter([1, 2])])
    divided = derive_tallies._binary_value(1.0, value, "/")
    assert divided.mean.ravel().tolist() == [0.5, 0.0]
    assert divided.std.ravel().tolist() == [0.05, 0.0]
    assert "1 bin(s) divide by a zero tally mean and were written as zero." in divided.warnings


def test_derived_on_left_arithmetic_and_division():
    value = derived_value([[2.0], [0.0]], std=[[0.2], [0.5]], filters=[CellFilter([1, 2])])

    assert derive_tallies._binary_value(value, 2.0, "+").mean.ravel().tolist() == [4.0, 2.0]
    assert derive_tallies._binary_value(value, 2.0, "-").mean.ravel().tolist() == [0.0, -2.0]

    multiplied = derive_tallies._binary_value(value, 2.0, "*")
    assert multiplied.mean.ravel().tolist() == [4.0, 0.0]
    assert multiplied.std.ravel().tolist() == [0.4, 1.0]

    divided = derive_tallies._binary_value(value, 2.0, "/")
    assert divided.mean.ravel().tolist() == [1.0, 0.0]
    assert divided.std.ravel().tolist() == [0.1, 0.25]


def test_derived_on_left_division_by_scalar_zero_raises():
    value = derived_value([2.0])
    with pytest.raises(derive_tallies.DerivedTallyError, match="divides by a scalar zero"):
        derive_tallies._binary_value(value, 0.0, "/")


def test_binary_values_with_different_nuclide_lists_pairwise():
    left = derived_value([10.0], nuclides=["U235"])
    right = derived_value([2.0], nuclides=["total"])
    result = derive_tallies._binary_value(left, right, "/")
    assert isinstance(result, derive_tallies.DerivedValue)
    assert result.nuclides == ["U235/total"]
    assert result.mean.ravel().tolist() == [5.0]
    assert result.score == "(flux / flux)"


def test_binary_value_multiplication_masks_zero_bins():
    left = derived_value([[2.0], [0.0]], std=[[0.2], [0.1]], filters=[CellFilter([1, 2])])
    right = derived_value([[4.0], [5.0]], std=[[0.4], [0.5]], filters=[CellFilter([1, 2])])
    result = derive_tallies._binary_value(left, right, "*")
    assert result.mean.ravel().tolist() == [8.0, 0.0]
    assert result.std.ravel()[0] == pytest.approx(8.0 * np.sqrt((0.2 / 2) ** 2 + (0.4 / 4) ** 2))
    assert result.std.ravel()[1] == 0.0


def test_evaluate_expression_rejects_non_dict_and_unknown_kind():
    with pytest.raises(derive_tallies.DerivedTallyError, match="no expression"):
        derive_tallies.evaluate_expression(None, None)
    with pytest.raises(derive_tallies.DerivedTallyError, match="Unknown derived expression node"):
        derive_tallies.evaluate_expression({"kind": "matrix"}, None)


def test_evaluate_expression_rejects_non_finite_scalar_and_bad_unary():
    with pytest.raises(derive_tallies.DerivedTallyError, match="must be finite"):
        derive_tallies.evaluate_expression(scalar(float("nan")), None)
    with pytest.raises(derive_tallies.DerivedTallyError, match="Only unary negation"):
        derive_tallies.evaluate_expression(unary("+", scalar(1)), None)


def test_evaluate_expression_negates_scalars_and_tally_values():
    assert derive_tallies.evaluate_expression(unary("-", scalar(3)), None) == -3.0

    statepoint = FakeStatePoint({1: FakeTally([], ["flux"], ["total"], [10], [1])})
    value = derive_tallies.evaluate_expression(unary("-", operand(1)), statepoint)
    assert isinstance(value, derive_tallies.DerivedValue)
    assert value.mean.ravel().tolist() == [-10.0]
    assert value.std.ravel().tolist() == [1.0]


def test_resolve_tally_operand_requires_integer_id():
    with pytest.raises(derive_tallies.DerivedTallyError, match="integer tally ID"):
        derive_tallies.resolve_tally_operand(FakeStatePoint({}), {"kind": "tally", "score": "flux"})


@pytest.mark.parametrize(
    ("mean", "std", "filters", "match"),
    [
        (np.zeros((2, 1)), np.zeros((2, 1)), [], "unexpected shape"),
        (np.zeros((1, 1, 1)), np.zeros((2, 1, 1)), [], "shapes differ"),
        (np.zeros((1, 2, 1)), np.zeros((1, 2, 1)), [], "does not match"),
        (np.zeros((1, 1, 1)), np.zeros((1, 1, 1)), [CellFilter([1, 2])], "filter bins"),
    ],
)
def test_resolve_tally_operand_rejects_inconsistent_results(mean, std, filters, match):
    tally = types.SimpleNamespace(
        scores=["flux"], nuclides=["total"], filters=filters, mean=mean, std_dev=std
    )
    statepoint = types.SimpleNamespace(tallies={1: tally})
    with pytest.raises(derive_tallies.DerivedTallyError, match=match):
        derive_tallies.resolve_tally_operand(statepoint, operand(1))


def test_evaluate_derived_tally_requires_an_expression():
    with pytest.raises(derive_tallies.DerivedTallyError, match="has no expression"):
        derive_tallies.evaluate_derived_tally(types.SimpleNamespace(tallies={}), {"id": 1})


def test_evaluate_derived_tally_warns_about_non_finite_moments():
    tally = types.SimpleNamespace(
        scores=["flux"],
        nuclides=["total"],
        filters=[],
        mean=np.array([[[np.nan]]]),
        std_dev=np.array([[[np.inf]]]),
    )
    result = derive_tallies.evaluate_derived_tally(
        types.SimpleNamespace(tallies={1: tally}),
        {"id": 1, "name": "flux", "expression": operand(1)},
    )
    assert result["mean"] == [0.0]
    assert result["stdDev"] == [0.0]
    assert result["warnings"] == ["2 non-finite moment(s) were written as zero."]


def test_decode_strings_handles_missing_and_byte_datasets():
    assert derive_tallies._decode_strings(None) == []
    assert derive_tallies._decode_strings(np.array([b"flux"])) == ["flux"]


def test_hdf5_reader_missing_filter_group_and_default_std(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.10.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["score"] = np.bytes_(b"flux")
        tally["results"] = np.array([[[[20.0, 208.0]]]])
        tally["filters"] = np.array([99])

    tallies_map = derive_tallies.load_hdf5_statepoint(path)
    loaded = tallies_map[1]
    assert loaded.scores == ["flux"]
    assert loaded.nuclides == ["total"]
    assert loaded.filters == []
    assert loaded.mean.ravel().tolist() == [20.0]
    assert loaded.std_dev.ravel().tolist() == [0.0]


def test_hdf5_reader_reads_filter_type_attrs_and_expands_scalar_bins(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.11.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 2")
        tally["score_bins"] = np.array([b"flux"])
        tally["nuclides"] = np.array([b"total"])
        tally["results"] = np.zeros((9, 1, 1, 2))
        tally["filters"] = np.array([1, 2])
        filters = tallies.create_group("filters")
        energy = filters.create_group("filter 1")
        energy.attrs["type"] = np.bytes_(b"energy")
        energy["bins"] = np.int32(7)
        energy["n_bins"] = 3
        cell = filters.create_group("filter 2")
        cell.attrs["type"] = "cell"
        cell["bins"] = np.array([4, 5, 6])
        cell["n_bins"] = 3

    loaded = derive_tallies.load_hdf5_statepoint(path)[2]
    assert [(axis.type_name, axis.bins, axis.num_bins) for axis in loaded.filters] == [
        ("energy", [0, 1, 2], 3),
        ("cell", [4, 5, 6], 3),
    ]


def test_hdf5_reader_adds_synthetic_axis_for_unexplained_bins(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.12.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 3")
        tally["score_bins"] = np.array([b"flux"])
        tally["results"] = np.ones((4, 1, 1, 2))
        tally["filters"] = np.array([1])
        filters = tallies.create_group("filters")
        mesh = filters.create_group("filter 1")
        mesh.attrs["type"] = np.bytes_(b"mesh")
        mesh["bins"] = np.int32(5)
        mesh["n_bins"] = 1

    loaded = derive_tallies.load_hdf5_statepoint(path)[3]
    assert [(axis.type_name, axis.bins, axis.num_bins) for axis in loaded.filters] == [
        ("mesh", [5], 1),
        ("filter", [0, 1, 2, 3], 4),
    ]


def test_hdf5_reader_uses_string_score_attribute(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.13.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 4")
        tally.attrs["score"] = "flux fission"
        tally["results"] = np.zeros((1, 2, 1, 2))

    loaded = derive_tallies.load_hdf5_statepoint(path)[4]
    assert loaded.scores == ["flux", "fission"]
    assert loaded.nuclides == ["total"]
    assert loaded.mean.shape == (1, 1, 2)


def test_hdf5_reader_requires_h5py(monkeypatch):
    monkeypatch.setitem(sys.modules, "h5py", None)
    with pytest.raises(derive_tallies.DerivedTallyError, match="h5py is required"):
        derive_tallies.load_hdf5_statepoint(types.SimpleNamespace())


def test_hdf5_reader_requires_tallies_group(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.14.h5"
    with h5py.File(path, "w"):
        pass
    with pytest.raises(derive_tallies.DerivedTallyError, match="No tallies found"):
        derive_tallies.load_hdf5_statepoint(path)


def test_hdf5_reader_requires_results_dataset(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.15.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 5")
        tally["score_bins"] = np.array([b"flux"])
    with pytest.raises(derive_tallies.DerivedTallyError, match="has no results dataset"):
        derive_tallies.load_hdf5_statepoint(path)


def test_hdf5_reader_requires_sum_sum_sq_layout(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.16.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 6")
        tally["score_bins"] = np.array([b"flux"])
        tally["results"] = np.zeros((1, 1, 1, 3))
    with pytest.raises(derive_tallies.DerivedTallyError, match=r"store \[sum, sum_sq\]"):
        derive_tallies.load_hdf5_statepoint(path)


def test_hdf5_reader_requires_three_dimensional_results(tmp_path):
    h5py = _h5py()
    path = tmp_path / "statepoint.17.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tally = tallies.create_group("tally 7")
        tally["score_bins"] = np.array([b"flux"])
        tally["results"] = np.zeros((1, 2))
    with pytest.raises(derive_tallies.DerivedTallyError, match="unexpected shape"):
        derive_tallies.load_hdf5_statepoint(path)


def test_evaluate_definitions_catches_unexpected_errors():
    definitions = [
        {"id": 1, "name": "good", "expression": operand(1, "flux")},
        {"id": 2, "name": "boom", "expression": scalar("not-a-number")},
    ]
    statepoint = FakeStatePoint({1: FakeTally([], ["flux"], ["total"], [10], [1])})
    derived, errors = derive_tallies._evaluate_definitions(statepoint, definitions)
    assert [entry["id"] for entry in derived] == [1]
    assert errors[0]["id"] == 2
    assert errors[0]["error"].startswith("Failed to evaluate:")
    assert "traceback" in errors[0]


def test_parse_definitions_accepts_wrapped_payloads():
    entry = {"id": 4, "name": "flux", "expression": operand(4)}
    assert derive_tallies.parse_definitions(json.dumps({"derivedTallies": [entry]})) == [entry]
    assert derive_tallies.parse_definitions(json.dumps({"definitions": [entry]})) == [entry]


def test_parse_definitions_rejects_bad_shapes_and_ids():
    with pytest.raises(derive_tallies.DerivedTallyError, match="must be a JSON array"):
        derive_tallies.parse_definitions(json.dumps({"unexpected": []}))
    with pytest.raises(derive_tallies.DerivedTallyError, match="index 0 must be an object"):
        derive_tallies.parse_definitions(json.dumps([1]))
    with pytest.raises(derive_tallies.DerivedTallyError, match="needs an integer id"):
        derive_tallies.parse_definitions(json.dumps([{"id": "one"}]))


def test_run_rejects_missing_files_and_wrong_suffix(tmp_path):
    missing = tmp_path / "missing.h5"
    assert derive_tallies.run(str(missing), "[]") == {
        "success": False,
        "error": f"File not found: {missing}",
    }

    wrong_suffix = tmp_path / "statepoint.18.txt"
    wrong_suffix.write_text("not hdf5", encoding="utf-8")
    assert derive_tallies.run(str(wrong_suffix), "[]") == {
        "success": False,
        "error": f"Not an HDF5 statepoint: {wrong_suffix}",
    }


def test_run_falls_back_to_hdf5_without_openmc(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "openmc", None)
    path = tmp_path / "statepoint.19.h5"
    _write_simple_statepoint(path)

    result = derive_tallies.run(
        str(path), json.dumps([{"id": 1, "name": "flux", "expression": operand(1)}])
    )

    assert result["success"] is True
    assert result["statepoint"] == str(path.absolute())
    assert result["derivedTallies"][0]["mean"] == [20.0]
    assert result["errors"] == []


def test_run_falls_back_when_openmc_cannot_open(monkeypatch, tmp_path):
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = _raise_statepoint
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    path = tmp_path / "statepoint.20.h5"
    _write_simple_statepoint(path)

    result = derive_tallies.run(
        str(path), json.dumps([{"id": 1, "name": "flux", "expression": operand(1)}])
    )

    assert result["success"] is True
    assert result["derivedTallies"][0]["mean"] == [20.0]


def test_run_reports_openmc_error_when_fallback_also_fails(monkeypatch, tmp_path):
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = _raise_statepoint
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    h5py = _h5py()
    path = tmp_path / "statepoint.21.h5"
    with h5py.File(path, "w"):
        pass

    result = derive_tallies.run(str(path), "[]")

    assert result["success"] is False
    assert "unreadable statepoint" in result["error"]
    assert "traceback" in result


def test_run_reports_fallback_error_without_openmc(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "openmc", None)
    h5py = _h5py()
    path = tmp_path / "statepoint.22.h5"
    with h5py.File(path, "w"):
        pass

    result = derive_tallies.run(str(path), "[]")

    assert result["success"] is False
    assert "No tallies found" in result["error"]
    assert "traceback" in result


def test_main_reports_unexpected_exceptions(capsys, tmp_path):
    statepoint_path = tmp_path / "statepoint.23.h5"
    statepoint_path.write_bytes(b"fake")

    exit_code = derive_tallies.main(
        [
            "--statepoint",
            str(statepoint_path),
            "--definitions-file",
            str(tmp_path / "missing-definitions.json"),
        ]
    )
    output = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert output["success"] is False
    assert "Derived-tally evaluation failed" in output["error"]
    assert "traceback" in output
