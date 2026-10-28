"""Tests for plugins.openmc.lib.tally_series (tally across statepoints).

Pure-logic tests (step parsing, natural sorting, aggregation) need only
pytest + numpy. Tests that build HDF5 fixtures are guarded by
importorskip("h5py"); the dependency-absence tests force h5py out via
monkeypatch so they pass in both the minimal and full profiles.
"""

import argparse
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import tally_series as tally_series_cmds  # noqa: E402
from plugins.openmc.lib import output_readers, tally_series  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    return json.loads(capsys.readouterr().out.strip())


# ---------------------------------------------------------------------------
# Pure logic: statepoint step parsing + natural sorting
# ---------------------------------------------------------------------------


def test_statepoint_step_index_numeric_suffix():
    assert tally_series.statepoint_step_index("statepoint.10.h5") == 10
    assert tally_series.statepoint_step_index("/a/b/statepoint.20.h5") == 20
    assert tally_series.statepoint_step_index("openmc_simulation_n2.h5") == 2
    assert tally_series.statepoint_step_index("openmc_simulation_n10.h5") == 10
    assert tally_series.statepoint_step_index("statepoint.007.h5") == 7


def test_statepoint_step_index_ignores_digits_in_extension():
    # The ".h5" suffix must not become the step (10, not 5).
    assert tally_series.statepoint_step_index("statepoint.10.h5") == 10
    assert tally_series.statepoint_step_index("statepoint.h5") is None
    assert tally_series.statepoint_step_index("run.h5") is None
    assert tally_series.statepoint_step_index("") is None


def test_sort_statepoint_files_natural_order():
    files = ["statepoint.20.h5", "statepoint.2.h5", "statepoint.10.h5"]
    assert tally_series.sort_statepoint_files(files) == [
        "statepoint.2.h5",
        "statepoint.10.h5",
        "statepoint.20.h5",
    ]


def test_sort_statepoint_files_n_series_and_unnumbered():
    files = ["openmc_simulation_n10.h5", "zzz.h5", "openmc_simulation_n2.h5", "aaa.h5"]
    assert tally_series.sort_statepoint_files(files) == [
        "openmc_simulation_n2.h5",
        "openmc_simulation_n10.h5",
        "aaa.h5",
        "zzz.h5",
    ]


# ---------------------------------------------------------------------------
# Pure logic: aggregation
# ---------------------------------------------------------------------------


def test_aggregate_values_unweighted_total_and_quadrature_std():
    value, std, n_bins = tally_series.aggregate_values([1.0, 2.0, 3.0], [0.1, 0.2, 0.3], "total")
    assert value == pytest.approx(6.0)
    assert std == pytest.approx(np.sqrt(0.01 + 0.04 + 0.09))
    assert n_bins == 3


def test_aggregate_values_unweighted_mean():
    value, std, n_bins = tally_series.aggregate_values([1.0, 2.0, 3.0], [0.1, 0.2, 0.3], "mean")
    assert value == pytest.approx(2.0)
    assert std == pytest.approx(np.sqrt(0.14) / 3)
    assert n_bins == 3


def test_aggregate_values_max_keeps_that_bins_std():
    value, std, n_bins = tally_series.aggregate_values([4.0, 1.0, 3.0], [0.4, 0.1, 0.3], "max")
    assert value == pytest.approx(4.0)
    assert std == pytest.approx(0.4)
    assert n_bins == 3


def test_aggregate_values_volume_weighted_total_and_mean():
    values = [10.0, 20.0]
    stds = [1.0, 2.0]
    volumes = [1.0, 3.0]
    value, std, n_bins = tally_series.aggregate_values(values, stds, "total", volumes=volumes)
    assert value == pytest.approx(70.0)
    assert std == pytest.approx(np.sqrt(1.0 + 36.0))
    assert n_bins == 2
    value, std, _ = tally_series.aggregate_values(values, stds, "mean", volumes=volumes)
    assert value == pytest.approx(17.5)
    assert std == pytest.approx(np.sqrt(37.0) / 4.0)


def test_aggregate_values_drops_non_finite_bins():
    value, std, n_bins = tally_series.aggregate_values(
        [1.0, np.nan, 3.0, np.inf], [0.1, 0.2, 0.3, 0.4], "total"
    )
    assert value == pytest.approx(4.0)
    assert std == pytest.approx(np.sqrt(0.01 + 0.09))
    assert n_bins == 2


def test_aggregate_values_non_finite_std_counts_as_zero_error():
    value, std, n_bins = tally_series.aggregate_values([1.0, 2.0], [np.nan, 0.5], "total")
    assert value == pytest.approx(3.0)
    assert std == pytest.approx(0.5)
    assert n_bins == 2


def test_aggregate_values_no_finite_bins_raises():
    with pytest.raises(output_readers.OutputReaderError, match="no finite bins"):
        tally_series.aggregate_values([np.nan, np.inf], [0.0, 0.0], "total")


def test_aggregate_values_rejects_bad_input():
    with pytest.raises(output_readers.OutputReaderError, match="statistic"):
        tally_series.aggregate_values([1.0], [0.0], "median")
    with pytest.raises(output_readers.OutputReaderError, match="std values"):
        tally_series.aggregate_values([1.0, 2.0], [0.0], "total")
    with pytest.raises(output_readers.OutputReaderError, match="volumes"):
        tally_series.aggregate_values([1.0, 2.0], [0.0, 0.0], "total", volumes=[1.0])
    with pytest.raises(output_readers.OutputReaderError, match="volumes"):
        tally_series.aggregate_values([1.0], [0.0], "total", volumes=[np.nan])


# ---------------------------------------------------------------------------
# h5py fixtures
# ---------------------------------------------------------------------------


def _write_statepoint(
    path,
    values,
    *,
    stds=0.5,
    scores=(b"flux",),
    nuclides=(b"total",),
    n_realizations=10,
    dimension=(2, 1, 1),
    lower_left=(0.0, 0.0, 0.0),
    upper_right=(2.0, 1.0, 1.0),
    mesh_type="regular",
    extra_filter=False,
    name="mesh tally",
):
    """Write a minimal statepoint with one tally.

    ``values`` is ``(bins,)``, ``(bins, scores)`` or ``(bins, scores,
    nuclides)``; ``stds`` is a scalar or the same shape. Results store the
    ``[sum, sum_sq]`` moments that reconstruct exactly those means/stds at
    ``n_realizations``. ``mesh_type=None`` writes no filter at all;
    ``extra_filter`` adds a single-bin energy filter (multi-filter tally).
    """
    h5py = pytest.importorskip("h5py")
    grid = np.asarray(values, dtype=float)
    if grid.ndim == 1:
        grid = grid[:, None, None]
    elif grid.ndim == 2:
        grid = grid[:, :, None]
    n_bins, n_scores, n_nuclides = grid.shape
    sigma = np.broadcast_to(np.asarray(stds, dtype=float), grid.shape)

    with h5py.File(path, "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = name
        tally.create_dataset("score_bins", data=np.array(scores, dtype="S"))
        tally.create_dataset("nuclides", data=np.array(nuclides, dtype="S"))
        tally.create_dataset("n_realizations", data=n_realizations)
        results = np.zeros((n_bins, n_scores, n_nuclides, 2))
        results[..., 0] = grid * n_realizations
        results[..., 1] = n_realizations * (
            np.square(sigma) * (n_realizations - 1) + np.square(grid)
        )
        tally.create_dataset("results", data=results)
        if mesh_type is None:
            return

        filter_ids = [1]
        filters = tallies.create_group("filters")
        mesh_filter = filters.create_group("filter 1")
        mesh_filter.create_dataset("type", data=np.bytes_(b"mesh"))
        mesh_filter.create_dataset("bins", data=np.array([7]))
        if extra_filter:
            energy_filter = filters.create_group("filter 2")
            energy_filter.create_dataset("type", data=np.bytes_(b"energy"))
            energy_filter.create_dataset("bins", data=np.array([0]))
            energy_filter.create_dataset("n_bins", data=1)
            filter_ids.append(2)
        tally.create_dataset("filters", data=np.array(filter_ids))

        meshes = tallies.create_group("meshes")
        mesh = meshes.create_group("mesh 7")
        if mesh_type == "regular":
            mesh.create_dataset("dimension", data=np.array(dimension))
            mesh.create_dataset("lower_left", data=np.array(lower_left))
            mesh.create_dataset("upper_right", data=np.array(upper_right))
        elif mesh_type == "cylindrical":
            mesh.create_dataset("r_grid", data=np.array([0.0, 1.0]))
            mesh.create_dataset("phi_grid", data=np.array([0.0, np.pi]))
            mesh.create_dataset("z_grid", data=np.array([0.0, 1.0]))
        else:  # unstructured
            mesh.attrs["type"] = np.bytes_(b"unstructured")
            mesh.create_dataset("vertices", data=np.zeros((4, 3)))


def _two_statepoint_files(tmp_path, **kwargs):
    """Write statepoint.10 (values 1,2) and .20 (values 3,4); return reversed."""
    earlier = tmp_path / "statepoint.10.h5"
    later = tmp_path / "statepoint.20.h5"
    _write_statepoint(str(earlier), [1.0, 2.0], **kwargs)
    _write_statepoint(str(later), [3.0, 4.0], **kwargs)
    return str(later), str(earlier)


# ---------------------------------------------------------------------------
# h5py-backed series builds
# ---------------------------------------------------------------------------


def test_build_series_sorts_steps_and_totals(tmp_path):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    result = tally_series.build_series([later, earlier], 1)

    assert result["files"] == [earlier, later]
    assert [step["index"] for step in result["steps"]] == [0, 1]
    assert [step["time"] for step in result["steps"]] == [10, 20]
    assert [step["file"] for step in result["steps"]] == [earlier, later]
    assert [step["fileName"] for step in result["steps"]] == [
        "statepoint.10.h5",
        "statepoint.20.h5",
    ]
    assert [step["value"] for step in result["steps"]] == pytest.approx([3.0, 7.0])
    assert [step["std"] for step in result["steps"]] == pytest.approx([np.sqrt(0.5), np.sqrt(0.5)])
    assert [step["nBins"] for step in result["steps"]] == [2, 2]
    assert result["tallyId"] == 1
    assert result["tallyName"] == "mesh tally"
    assert result["score"] == "flux"
    assert result["nuclide"] == "total"
    assert result["statistic"] == "total"
    assert result["timeLabel"] == "Statepoint step"
    assert result["range"] == pytest.approx([3.0, 7.0])
    assert result["viewRange"] == pytest.approx([1.0, 4.0])
    assert result["hasMesh"] is True
    assert result["volumeWeighted"] is True


def test_build_series_mean_statistic(tmp_path):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    result = tally_series.build_series([later, earlier], 1, statistic="mean")

    assert result["statistic"] == "mean"
    assert [step["value"] for step in result["steps"]] == pytest.approx([1.5, 3.5])
    assert [step["std"] for step in result["steps"]] == pytest.approx(
        [np.sqrt(0.5) / 2, np.sqrt(0.5) / 2]
    )
    assert [step["nBins"] for step in result["steps"]] == [2, 2]
    assert result["range"] == pytest.approx([1.5, 3.5])


def test_build_series_max_statistic(tmp_path):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    result = tally_series.build_series([later, earlier], 1, statistic="max")

    assert [step["value"] for step in result["steps"]] == pytest.approx([2.0, 4.0])
    assert [step["std"] for step in result["steps"]] == pytest.approx([0.5, 0.5])
    assert result["range"] == pytest.approx([2.0, 4.0])


def test_build_series_explicit_times_preserve_input_order(tmp_path):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    result = tally_series.build_series([later, earlier], 1, times=[0.0, 100.0])

    assert result["timeLabel"] == "Time"
    assert result["files"] == [later, earlier]
    assert [step["time"] for step in result["steps"]] == [0.0, 100.0]
    assert [step["fileName"] for step in result["steps"]] == [
        "statepoint.20.h5",
        "statepoint.10.h5",
    ]
    assert [step["value"] for step in result["steps"]] == pytest.approx([7.0, 3.0])
    # The shared ranges are order-independent.
    assert result["range"] == pytest.approx([3.0, 7.0])
    assert result["viewRange"] == pytest.approx([1.0, 4.0])


def test_build_series_time_falls_back_to_position_without_suffix(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "run.h5"
    _write_statepoint(str(sp), [5.0])
    result = tally_series.build_series([str(sp)], 1)
    assert result["timeLabel"] == "Statepoint step"
    assert result["steps"][0]["time"] == 0


def test_build_series_volume_weighted_regular_mesh(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    # 2x1x1 mesh over 4x1x1 cm -> dV = 2 per cell.
    _write_statepoint(
        str(sp),
        [1.0, 2.0],
        dimension=(2, 1, 1),
        lower_left=(0.0, 0.0, 0.0),
        upper_right=(4.0, 1.0, 1.0),
    )
    total = tally_series.build_series([str(sp)], 1, statistic="total")
    assert total["volumeWeighted"] is True
    assert total["steps"][0]["value"] == pytest.approx(6.0)
    assert total["steps"][0]["std"] == pytest.approx(np.sqrt(2.0))

    mean = tally_series.build_series([str(sp)], 1, statistic="mean")
    assert mean["steps"][0]["value"] == pytest.approx(1.5)
    assert mean["steps"][0]["std"] == pytest.approx(np.sqrt(2.0) / 4.0)


def test_build_series_non_mesh_omits_view_range(tmp_path):
    pytest.importorskip("h5py")
    first = tmp_path / "statepoint.1.h5"
    second = tmp_path / "statepoint.2.h5"
    _write_statepoint(str(first), [5.0], mesh_type=None)
    _write_statepoint(str(second), [7.0], mesh_type=None)
    result = tally_series.build_series([str(second), str(first)], 1)

    assert "viewRange" not in result
    assert result["hasMesh"] is False
    assert result["volumeWeighted"] is False
    assert [step["value"] for step in result["steps"]] == pytest.approx([5.0, 7.0])
    assert result["range"] == pytest.approx([5.0, 7.0])


def test_build_series_multi_filter_is_not_volume_weighted(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, 2.0], extra_filter=True)
    result = tally_series.build_series([str(sp)], 1)

    assert result["hasMesh"] is True
    assert result["volumeWeighted"] is False
    assert result["steps"][0]["value"] == pytest.approx(3.0)


@pytest.mark.parametrize("mesh_type", ["cylindrical", "unstructured"])
def test_build_series_non_regular_mesh_is_not_volume_weighted(tmp_path, mesh_type):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, 2.0], mesh_type=mesh_type)
    result = tally_series.build_series([str(sp)], 1)

    assert result["hasMesh"] is True
    assert result["volumeWeighted"] is False
    assert result["viewRange"] == pytest.approx([1.0, 2.0])
    assert result["steps"][0]["value"] == pytest.approx(3.0)


def test_build_series_drops_void_bins(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, np.nan])
    result = tally_series.build_series([str(sp)], 1)

    step = result["steps"][0]
    assert step["nBins"] == 1
    assert step["value"] == pytest.approx(1.0)
    assert result["viewRange"] == pytest.approx([1.0, 1.0])


def test_build_series_score_selection(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(
        str(sp),
        np.array([[1.0, 10.0], [2.0, 20.0]]),
        scores=(b"flux", b"heating"),
    )
    default = tally_series.build_series([str(sp)], 1)
    assert default["score"] == "flux"
    assert default["steps"][0]["value"] == pytest.approx(3.0)

    heating = tally_series.build_series([str(sp)], 1, score="heating")
    assert heating["score"] == "heating"
    assert heating["steps"][0]["value"] == pytest.approx(30.0)
    assert heating["steps"][0]["nBins"] == 2


def test_build_series_nuclide_selection(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(
        str(sp),
        np.array([[[1.0, 3.0]], [[2.0, 4.0]]]),
        nuclides=(b"total", b"u235"),
    )
    result = tally_series.build_series([str(sp)], 1, nuclide="u235")
    assert result["nuclide"] == "u235"
    assert result["steps"][0]["value"] == pytest.approx(7.0)


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_build_series_empty_files_raises():
    with pytest.raises(output_readers.OutputReaderError, match="No statepoint files"):
        tally_series.build_series([], 1)


def test_build_series_missing_file_raises():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        tally_series.build_series(["/no/such/statepoint.10.h5"], 1)


def test_build_series_missing_tally(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, 2.0])
    with pytest.raises(output_readers.OutputReaderError, match="Tally 9 not found"):
        tally_series.build_series([str(sp)], 9)


def test_build_series_missing_score(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, 2.0])
    with pytest.raises(output_readers.OutputReaderError, match="Score 'heating'"):
        tally_series.build_series([str(sp)], 1, score="heating")


def test_build_series_missing_nuclide(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [1.0, 2.0])
    with pytest.raises(output_readers.OutputReaderError, match="Nuclide 'u238'"):
        tally_series.build_series([str(sp)], 1, nuclide="u238")


def test_build_series_file_without_tallies(tmp_path):
    h5py = pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    with h5py.File(str(sp), "w") as f:
        f.create_group("materials")
    with pytest.raises(output_readers.OutputReaderError, match="No tallies"):
        tally_series.build_series([str(sp)], 1)


def test_build_series_no_finite_bins(tmp_path):
    pytest.importorskip("h5py")
    sp = tmp_path / "statepoint.1.h5"
    _write_statepoint(str(sp), [np.nan, np.inf])
    with pytest.raises(output_readers.OutputReaderError, match="no finite bins"):
        tally_series.build_series([str(sp)], 1)


def test_build_series_time_count_mismatch(tmp_path):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    with pytest.raises(output_readers.OutputReaderError, match="--time count"):
        tally_series.build_series([later, earlier], 1, times=[1.0])


def test_build_series_missing_h5py_forced(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "statepoint.1.h5"
    fake.write_bytes(b"not hdf5")
    with pytest.raises(output_readers.OutputReaderError, match="h5py"):
        tally_series.build_series([str(fake)], 1)


# ---------------------------------------------------------------------------
# Command handler: stdout JSON + exit code
# ---------------------------------------------------------------------------


def test_cmd_tally_series_missing_file(capsys):
    args = _parse(
        tally_series_cmds.cmd_tally_series,
        ["--file", "/no/such/statepoint.10.h5", "--tally-id", "1"],
    )
    assert tally_series_cmds.cmd_tally_series(args) == 1
    assert _stdout_json(capsys)["error"]


def test_cmd_tally_series_missing_h5py_forced(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(sys.modules, "h5py", None)
    fake = tmp_path / "statepoint.1.h5"
    fake.write_bytes(b"not hdf5")
    args = _parse(
        tally_series_cmds.cmd_tally_series,
        ["--file", str(fake), "--tally-id", "1"],
    )
    assert tally_series_cmds.cmd_tally_series(args) == 1
    assert "h5py" in _stdout_json(capsys)["error"]


def test_cmd_tally_series_time_count_mismatch(tmp_path, capsys):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    args = _parse(
        tally_series_cmds.cmd_tally_series,
        ["--file", later, "--file", earlier, "--tally-id", "1", "--time", "1.0"],
    )
    assert tally_series_cmds.cmd_tally_series(args) == 1
    assert "--time count" in _stdout_json(capsys)["error"]


def test_cmd_tally_series_success(tmp_path, capsys):
    pytest.importorskip("h5py")
    later, earlier = _two_statepoint_files(tmp_path)
    args = _parse(
        tally_series_cmds.cmd_tally_series,
        [
            "--file",
            later,
            "--file",
            earlier,
            "--tally-id",
            "1",
            "--statistic",
            "mean",
            "--time",
            "1.5",
            "--time",
            "2.5",
        ],
    )
    assert tally_series_cmds.cmd_tally_series(args) == 0
    result = _stdout_json(capsys)
    assert result["statistic"] == "mean"
    assert result["timeLabel"] == "Time"
    assert [step["time"] for step in result["steps"]] == [1.5, 2.5]
    assert [step["value"] for step in result["steps"]] == pytest.approx([3.5, 1.5])
    assert result["viewRange"] == pytest.approx([1.0, 4.0])
