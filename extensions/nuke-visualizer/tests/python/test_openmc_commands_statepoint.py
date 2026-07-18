"""Tests for plugins.openmc.commands.statepoint handlers.

h5py is not installed here, so the handlers are exercised with a fake
h5py module patched into the command module's globals (the real numpy is
patched in for the module-level ``np``). The HAS_H5PY=False error paths
run against the real environment.
"""

import argparse
import json
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import statepoint as statepoint_cmds  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


# ---------------------------------------------------------------------------
# Fake h5py framework
# ---------------------------------------------------------------------------


class _FakeDataset:
    """Minimal h5py.Dataset stand-in wrapping a numpy value."""

    def __init__(self, data, attrs=None):
        self._data = data
        self.attrs = attrs or {}

    def __getitem__(self, key):
        if key is Ellipsis or key == ():
            return self._data
        return self._data[key]

    def __len__(self):
        return len(self._data)


class _FakeGroup:
    """Minimal h5py.Group stand-in with dict children and attrs."""

    def __init__(self, children=None, attrs=None):
        self._children = dict(children or {})
        self.attrs = dict(attrs or {})

    def __contains__(self, key):
        return key in self._children

    def __getitem__(self, key):
        return self._children[key]

    def keys(self):
        return self._children.keys()


class _FakeFile(_FakeGroup):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def fake_h5py(monkeypatch):
    """Patch the command module's h5py/np/HAS_H5PY globals with fakes."""
    holder = {"file": None}
    module = ModuleType("h5py")
    module.Dataset = _FakeDataset
    module.Group = _FakeGroup

    def _file(path, mode="r"):
        holder["path"] = path
        if isinstance(holder["file"], Exception):
            raise holder["file"]
        return holder["file"]

    module.File = _file
    monkeypatch.setattr(statepoint_cmds, "h5py", module, raising=False)
    monkeypatch.setattr(statepoint_cmds, "np", np, raising=False)
    monkeypatch.setattr(statepoint_cmds, "HAS_H5PY", True)
    return holder


def _source_bank(n=10):
    """Structured array mimicking OpenMC's source_bank compound dataset."""
    bank = np.zeros(n, dtype=[("r", float, 3), ("u", float, 3), ("E", float), ("wgt", float)])
    bank["r"] = [[i, i + 0.1, i + 0.2] for i in range(n)]
    bank["u"] = [[0.0, 0.0, 1.0]] * n
    bank["E"] = np.linspace(1.0e6, 2.0e6, n)
    bank["wgt"] = 1.0
    return bank


def _full_statepoint_file():
    """A fully populated fake statepoint for the main success test."""
    mesh_1 = _FakeGroup(
        {
            "dimension": _FakeDataset(np.array([2, 3, 4])),
            "lower_left": _FakeDataset(np.array([-1.0, -2.0, -3.0])),
            "upper_right": _FakeDataset(np.array([1.0, 2.0, 3.0])),
            "width": _FakeDataset(np.array([1.0, 1.5, 1.5])),
        }
    )
    mesh_2 = _FakeGroup(
        {
            "dimension": _FakeDataset(np.array([2, 2, 2])),
            "lower_left": _FakeDataset(np.array([0.0, 0.0, 0.0])),
            "upper_right": _FakeDataset(np.array([4.0, 8.0, 16.0])),
            # no 'width' dataset -> computed from dimension and bounds
        }
    )
    filter_1 = _FakeGroup(
        {
            "type": _FakeDataset(b"mesh"),
            "n_bins": _FakeDataset(1),
            "bins": _FakeDataset(np.array([1])),
        }
    )
    filter_2 = _FakeGroup(
        {"type": _FakeDataset(b"cell"), "n_bins": _FakeDataset(3)},
        attrs={"type": "cell"},
    )
    filters_group = _FakeGroup({"filter 1": filter_1, "filter 2": filter_2, "other": _FakeGroup()})
    meshes_group = _FakeGroup({"mesh 1": mesh_1, "mesh 2": mesh_2})

    tally_1 = _FakeGroup(
        {
            "score_bins": _FakeDataset(np.array([b"flux", b"heating"])),
            "nuclides": _FakeDataset(np.array([b"total", b"U235"])),
            "filters": _FakeDataset(np.array([1, 2])),
        },
        attrs={"name": b"Mesh Tally"},
    )
    tally_2 = _FakeGroup(
        {
            "score": _FakeDataset(np.array(b"flux")),
            "filters": _FakeGroup({"filter 2": filter_2}),
        },
        attrs={"name": "Cell Tally", "nuclides": "total U235"},
    )
    tallies_group = _FakeGroup(
        {
            "tally 1": tally_1,
            "tally 2": tally_2,
            "filters": filters_group,
            "meshes": meshes_group,
            "summary": _FakeGroup(),  # non-tally key: skipped
        }
    )

    runtime_group = _FakeGroup(
        {
            "total initialization": _FakeDataset(np.float64(1.5)),
            "reading_cross_sections": _FakeDataset(np.array([0.25])),
            "inactive batches": _FakeDataset(np.float64(2.0)),
            "active_batches": _FakeDataset(np.float64(8.0)),
            "simulation": _FakeDataset(np.float64(10.0)),
            "transport": _FakeDataset(np.float64(9.5)),
            "synchronizing fission bank": _FakeDataset(np.float64(0.1)),
            "sampling_source_sites": _FakeDataset(np.float64(0.2)),
            "accumulating tallies": _FakeDataset(np.float64(0.3)),
            "writing_statepoints": _FakeDataset(np.float64(0.4)),
            "SEND-RECV source sites": _FakeDataset(np.float64(0.05)),
            "total": _FakeDataset(np.float64(12.0)),
        }
    )

    return _FakeFile(
        {
            "run_mode": _FakeDataset(b"eigenvalue"),
            "n_batches": _FakeDataset(100),
            "n_particles": _FakeDataset(10000),
            "n_inactive": _FakeDataset(10),
            "n_realizations": _FakeDataset(5),
            "seed": _FakeDataset(42),
            "energy_mode": _FakeDataset("continuous-energy"),
            "generations_per_batch": _FakeDataset(1),
            "current_batch": _FakeDataset(100),
            "k_combined": _FakeDataset(np.array([1.05, 0.002])),
            "k_generation": _FakeDataset(np.linspace(0.9, 1.1, 5)),
            "k_col_abs": _FakeDataset(np.float64(1.04)),
            "k_col_tra": _FakeDataset(np.float64(1.06)),
            "k_abs_tra": _FakeDataset(np.float64(1.05)),
            "source_bank": _FakeDataset(_source_bank(10)),
            "runtime": runtime_group,
            "global_tallies": _FakeDataset(np.arange(12, dtype=float).reshape(4, 3)),
            "tallies": tallies_group,
        },
        attrs={"openmc_version": np.array([0, 15, 0])},
    )


# ---------------------------------------------------------------------------
# openmc.statepoint-info
# ---------------------------------------------------------------------------


def test_statepoint_info_requires_h5py(capsys):
    """h5py is missing in this environment: JSON error, exit code 1."""
    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    rc = statepoint_cmds.cmd_statepoint_info(args)

    if not statepoint_cmds.HAS_H5PY:
        assert rc == 1
        assert _stdout_json(capsys)["error"] == "h5py not installed"


def test_statepoint_info_full(fake_h5py, capsys):
    fake_h5py["file"] = _full_statepoint_file()

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["statepoint.100.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    result = _stdout_json(capsys)
    assert result["file"] == "statepoint.100.h5"
    assert result["runMode"] == "eigenvalue"
    assert result["nBatches"] == 100
    assert result["nParticles"] == 10000
    assert result["nInactive"] == 10
    assert result["nRealizations"] == 5
    assert result["seed"] == 42
    assert result["energyMode"] == "continuous-energy"
    assert result["generationsPerBatch"] == 1
    assert result["currentBatch"] == 100
    assert result["version"] == "0.15.0"
    assert result["kCombined"] == [1.05, 0.002]
    assert len(result["kGeneration"]) == 5
    assert result["kColAbs"] == pytest.approx(1.04)
    assert result["kColTra"] == pytest.approx(1.06)
    assert result["kAbsTra"] == pytest.approx(1.05)
    assert result["nSourceParticles"] == 10
    assert result["hasSourceBank"] is True

    runtime = result["runtime"]
    assert runtime["total"] == pytest.approx(12.0)
    assert runtime["initialization"] == pytest.approx(1.5)
    assert runtime["readingCrossSections"] == pytest.approx(0.25)
    assert runtime["inactiveBatches"] == pytest.approx(2.0)
    assert runtime["activeBatches"] == pytest.approx(8.0)
    assert runtime["simulation"] == pytest.approx(10.0)
    assert runtime["transport"] == pytest.approx(9.5)
    assert runtime["synchronizingFissionBank"] == pytest.approx(0.1)
    assert runtime["samplingSourceSites"] == pytest.approx(0.2)
    assert runtime["accumulatingTallies"] == pytest.approx(0.3)
    assert runtime["writingStatepoints"] == pytest.approx(0.4)
    assert runtime["sendRecvSourceSites"] == pytest.approx(0.05)

    assert [g["name"] for g in result["globalTallies"]] == [
        "Leakage",
        "Loss to Fission",
        "Fission Neutrons",
        "Non-Fission Captures",
    ]
    assert result["globalTallies"][0]["mean"] == pytest.approx(0.0)
    assert result["globalTallies"][3]["stdDev"] == pytest.approx(10.0)

    # Tallies: dataset-backed scores/nuclides, name bytes decoding.
    assert len(result["tallies"]) == 2
    tally_1 = result["tallies"][0]
    assert tally_1["id"] == 1
    assert tally_1["name"] == "Mesh Tally"
    assert tally_1["scores"] == ["flux", "heating"]
    assert tally_1["nuclides"] == ["total", "U235"]
    assert tally_1["hasMesh"] is True

    # Mesh filter resolved through the filters group into mesh metadata.
    mesh_filter = tally_1["filters"][0]
    assert mesh_filter["type"] == "mesh"
    assert mesh_filter["meshDimensions"] == [2, 3, 4]
    assert mesh_filter["lowerLeft"] == [-1.0, -2.0, -3.0]
    assert mesh_filter["upperRight"] == [1.0, 2.0, 3.0]
    assert mesh_filter["width"] == [1.0, 1.5, 1.5]
    # Cell filter: type from attrs, bins from dataset.
    assert tally_1["filters"][1] == {"type": "cell", "bins": 3}

    # Tally 2: 0-d score dataset, attrs nuclides, group-style filters.
    tally_2 = result["tallies"][1]
    assert tally_2["scores"] == ["flux"]
    assert tally_2["nuclides"] == ["total", "U235"]
    assert tally_2["filters"] == [{"type": "cell", "bins": 3}]
    assert tally_2["hasMesh"] is False

    # Top-level filter listing.
    assert result["filters"] == [
        {"id": 1, "type": "mesh", "nBins": 1},
        {"id": 2, "type": "cell", "nBins": 3},
    ]

    # Meshes: explicit width for mesh 1, computed width for mesh 2.
    assert len(result["meshes"]) == 2
    assert result["meshes"][0]["width"] == [1.0, 1.5, 1.5]
    assert result["meshes"][1]["dimensions"] == [2, 2, 2]
    assert result["meshes"][1]["width"] == [2.0, 4.0, 8.0]


def test_statepoint_info_minimal_file(fake_h5py, capsys):
    """A nearly empty statepoint yields defaults for everything."""
    fake_h5py["file"] = _FakeFile({}, attrs={"version": b"0.14.0"})

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    result = _stdout_json(capsys)
    assert result["runMode"] == "unknown"
    assert result["version"] == "0.14.0"  # bytes via the 'version' fallback attr
    assert result["kCombined"] is None
    assert result["kGeneration"] is None
    assert result["hasSourceBank"] is False
    assert result["runtime"] == {}
    assert result["globalTallies"] == []
    assert result["tallies"] == []
    assert result["filters"] == []
    assert result["meshes"] == []


def test_statepoint_info_runtime_total_fallback(fake_h5py, capsys):
    """Without a 'total' key the total is initialization + simulation."""
    fake_h5py["file"] = _FakeFile(
        {
            "runtime": _FakeGroup(
                {
                    "init": _FakeDataset(np.float64(3.0)),
                    "active": _FakeDataset(np.float64(7.0)),
                }
            )
        },
        attrs={},
    )

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    runtime = _stdout_json(capsys)["runtime"]
    assert runtime["initialization"] == pytest.approx(3.0)
    assert runtime["simulation"] == pytest.approx(7.0)
    assert runtime["total"] == pytest.approx(10.0)
    assert runtime["transport"] == 0


def test_statepoint_info_root_level_filters_group(fake_h5py, capsys):
    """Filter references resolve against a root-level /filters group first."""
    root_filter = _FakeGroup({"type": _FakeDataset(b"energy"), "n_bins": _FakeDataset(4)})
    tally = _FakeGroup(
        {"filters": _FakeDataset(np.array([3]))},
        attrs={},
    )
    tallies_group = _FakeGroup({"tally 5": tally})
    fake_h5py["file"] = _FakeFile(
        {"tallies": tallies_group, "filters": _FakeGroup({"filter 3": root_filter})},
        attrs={},
    )

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 0

    result = _stdout_json(capsys)
    assert result["tallies"][0]["filters"] == [{"type": "energy", "bins": 4}]
    # Unknown filter ids are skipped silently.
    assert result["tallies"][0]["hasMesh"] is False


def test_statepoint_info_unreadable_file(fake_h5py, capsys):
    fake_h5py["file"] = OSError("cannot open")

    args = _parse(statepoint_cmds.cmd_statepoint_info, ["sp.h5"])
    assert statepoint_cmds.cmd_statepoint_info(args) == 1
    assert "cannot open" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# _parse_filter
# ---------------------------------------------------------------------------


def test_parse_filter_mesh_with_scalar_bins_and_missing_mesh(fake_h5py):
    filter_obj = _FakeGroup(
        {"type": _FakeDataset(b"mesh"), "n_bins": _FakeDataset(1), "bins": _FakeDataset(7)}
    )
    # No 'meshes' group in tallies_group -> mesh metadata omitted.
    info = statepoint_cmds._parse_filter(filter_obj, _FakeFile({}), _FakeGroup({}))
    assert info == {"type": "mesh", "bins": 1}

    # Mesh id not present in the meshes group -> still no metadata.
    tallies_group = _FakeGroup({"meshes": _FakeGroup({"mesh 8": _FakeGroup({})})})
    info = statepoint_cmds._parse_filter(filter_obj, _FakeFile({}), tallies_group)
    assert info == {"type": "mesh", "bins": 1}


def test_parse_filter_mesh_without_bins_dataset():
    filter_obj = _FakeGroup({"type": _FakeDataset(b"mesh"), "n_bins": _FakeDataset(2)})
    mesh_obj = _FakeGroup({"dimension": _FakeDataset(np.array([4, 4, 4]))})
    tallies_group = _FakeGroup({"meshes": _FakeGroup({"mesh 1": mesh_obj})})
    info = statepoint_cmds._parse_filter(filter_obj, _FakeFile({}), tallies_group)
    # No bins dataset -> no mesh id -> no metadata attached.
    assert info == {"type": "mesh", "bins": 2}


def test_parse_filter_mesh_partial_mesh_datasets(fake_h5py):
    filter_obj = _FakeGroup(
        {
            "type": _FakeDataset(b"mesh"),
            "n_bins": _FakeDataset(1),
            "bins": _FakeDataset(np.array([2])),
        }
    )
    mesh_obj = _FakeGroup(
        {
            "lower_left": _FakeDataset(np.array([0.0, 0.0, 0.0])),
            "width": _FakeDataset(np.array([1.0, 1.0, 1.0])),
        }
    )
    tallies_group = _FakeGroup({"meshes": _FakeGroup({"mesh 2": mesh_obj})})
    info = statepoint_cmds._parse_filter(filter_obj, _FakeFile({}), tallies_group)
    assert info["lowerLeft"] == [0.0, 0.0, 0.0]
    assert info["width"] == [1.0, 1.0, 1.0]
    assert "meshDimensions" not in info
    assert "upperRight" not in info


def test_parse_filter_attrs_fallbacks_and_unknown_type():
    filter_obj = _FakeGroup({}, attrs={"type": b"cell", "n_bins": 6})
    info = statepoint_cmds._parse_filter(filter_obj, _FakeFile({}), _FakeGroup({}))
    assert info == {"type": "cell", "bins": 6}

    empty = _FakeGroup({})
    info = statepoint_cmds._parse_filter(empty, _FakeFile({}), _FakeGroup({}))
    assert info == {"type": "unknown", "bins": 0}


# ---------------------------------------------------------------------------
# openmc.k-generation
# ---------------------------------------------------------------------------


def test_k_generation_requires_h5py(capsys):
    args = _parse(statepoint_cmds.cmd_k_generation, ["sp.h5"])
    rc = statepoint_cmds.cmd_k_generation(args)
    if not statepoint_cmds.HAS_H5PY:
        assert rc == 1
        assert _stdout_json(capsys)["error"] == "h5py not installed"


def test_k_generation_success(fake_h5py, capsys):
    k_gen = np.array([1.0, 1.2, 0.8])
    fake_h5py["file"] = _FakeFile({"k_generation": _FakeDataset(k_gen)})

    args = _parse(statepoint_cmds.cmd_k_generation, ["sp.h5"])
    assert statepoint_cmds.cmd_k_generation(args) == 0

    result = _stdout_json(capsys)
    assert result["batches"] == [1, 2, 3]
    assert result["kValues"] == [1.0, 1.2, 0.8]
    assert result["cumulativeMean"] == [1.0, pytest.approx(1.1), pytest.approx(1.0)]
    assert result["cumulativeStdDev"][0] == 0  # first batch has no std
    assert result["cumulativeStdDev"][1] == pytest.approx(np.std([1.0, 1.2], ddof=1))
    assert result["upperBound"][2] == pytest.approx(
        result["cumulativeMean"][2] + 2 * result["cumulativeStdDev"][2]
    )
    assert result["lowerBound"][2] == pytest.approx(
        result["cumulativeMean"][2] - 2 * result["cumulativeStdDev"][2]
    )


def test_k_generation_missing_dataset(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({})
    args = _parse(statepoint_cmds.cmd_k_generation, ["sp.h5"])
    assert statepoint_cmds.cmd_k_generation(args) == 1
    assert "No k_generation data" in _stdout_json(capsys)["error"]


def test_k_generation_unreadable_file(fake_h5py, capsys):
    fake_h5py["file"] = OSError("locked")
    args = _parse(statepoint_cmds.cmd_k_generation, ["sp.h5"])
    assert statepoint_cmds.cmd_k_generation(args) == 1
    assert "locked" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# openmc.source-data
# ---------------------------------------------------------------------------


def test_source_data_requires_h5py(capsys):
    args = _parse(statepoint_cmds.cmd_source_data, ["sp.h5"])
    rc = statepoint_cmds.cmd_source_data(args)
    if not statepoint_cmds.HAS_H5PY:
        assert rc == 1
        assert _stdout_json(capsys)["error"] == "h5py not installed"


def test_source_data_success_with_stride(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({"source_bank": _FakeDataset(_source_bank(10))})

    args = _parse(statepoint_cmds.cmd_source_data, ["sp.h5", "--max-particles", "4"])
    assert statepoint_cmds.cmd_source_data(args) == 0

    result = _stdout_json(capsys)
    assert result["totalParticles"] == 10
    assert result["returnedParticles"] == 4
    assert len(result["positions"]) == 4
    # stride = 2 -> particles 0, 2, 4, 6
    assert result["positions"][0] == [0.0, 0.1, 0.2]
    assert result["positions"][1] == [2.0, 2.1, 2.2]
    assert result["energies"][0] == pytest.approx(1.0e6)
    assert result["weights"] == [1.0, 1.0, 1.0, 1.0]
    assert result["directions"][0] == [0.0, 0.0, 1.0]


def test_source_data_all_particles_when_below_max(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({"source_bank": _FakeDataset(_source_bank(3))})

    args = _parse(statepoint_cmds.cmd_source_data, ["sp.h5"])
    assert statepoint_cmds.cmd_source_data(args) == 0
    result = _stdout_json(capsys)
    assert result["returnedParticles"] == 3


def test_source_data_missing_source_bank(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({})
    args = _parse(statepoint_cmds.cmd_source_data, ["sp.h5"])
    assert statepoint_cmds.cmd_source_data(args) == 1
    assert "No source_bank" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# openmc.energy-distribution
# ---------------------------------------------------------------------------


def test_energy_distribution_requires_h5py(capsys):
    args = _parse(statepoint_cmds.cmd_energy_distribution, ["sp.h5"])
    rc = statepoint_cmds.cmd_energy_distribution(args)
    if not statepoint_cmds.HAS_H5PY:
        assert rc == 1
        assert _stdout_json(capsys)["error"] == "h5py not installed"


def test_energy_distribution_success(fake_h5py, capsys):
    bank = _source_bank(10)
    bank["wgt"] = 2.0
    fake_h5py["file"] = _FakeFile({"source_bank": _FakeDataset(bank)})

    args = _parse(statepoint_cmds.cmd_energy_distribution, ["sp.h5", "--bins", "5"])
    assert statepoint_cmds.cmd_energy_distribution(args) == 0

    result = _stdout_json(capsys)
    assert len(result["binEdges"]) == 6
    assert len(result["binCenters"]) == 5
    assert len(result["counts"]) == 5
    assert sum(result["counts"]) == 10
    # All weights are 2.0, so weighted counts are double the raw counts.
    assert result["weightedCounts"] == [2 * c for c in result["counts"]]


def test_energy_distribution_missing_source_bank(fake_h5py, capsys):
    fake_h5py["file"] = _FakeFile({})
    args = _parse(statepoint_cmds.cmd_energy_distribution, ["sp.h5"])
    assert statepoint_cmds.cmd_energy_distribution(args) == 1
    assert "No source_bank" in _stdout_json(capsys)["error"]
