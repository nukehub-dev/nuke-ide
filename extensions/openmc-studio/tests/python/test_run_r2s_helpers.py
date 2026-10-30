"""Additional unit tests for python/run_r2s.py helpers and error branches."""

import json
import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
import run_r2s
from shutdown_dose_fakes import (
    FakeBoundingBox,
    FakeCell,
    FakeCylindricalMesh,
    FakeParentNuclideFilter,
    FakeParticleFilter,
    FakeR2SManager,
    FakeRegularMesh,
    FakeSphericalMesh,
    FakeTally,
    make_openmc_module,
)


@pytest.fixture(autouse=True)
def _reset_managers():
    FakeR2SManager.instances.clear()


def write_model_inputs(tmp_path):
    """Create the minimum XML inputs the driver validates."""
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    (tmp_path / "settings.xml").write_text("<settings/>", encoding="utf-8")
    (tmp_path / "tallies.xml").write_text("<tallies/>", encoding="utf-8")
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>", encoding="utf-8")
    return chain


def make_config(tmp_path, chain):
    return {
        "method": "r2s",
        "domainType": "cell",
        "cellIds": [1],
        "timesteps": [1],
        "timestepUnits": "d",
        "sourceRates": [1e15],
        "chainFile": str(chain),
        "photonTallyIds": [7],
        "outputDirectory": str(tmp_path / "output"),
    }


# ---------------------------------------------------------------------------
# NumpyEncoder / load_config
# ---------------------------------------------------------------------------


def test_numpy_encoder_converts_numpy_scalars_and_arrays():
    payload = {
        "integer": np.int64(3),
        "floating": np.float32(2.5),
        "boolean": np.bool_(True),
        "array": np.array([1.0, 2.0]),
    }

    decoded = json.loads(json.dumps(payload, cls=run_r2s.NumpyEncoder))

    assert decoded == {
        "integer": 3,
        "floating": 2.5,
        "boolean": True,
        "array": [1.0, 2.0],
    }


def test_numpy_encoder_rejects_unsupported_objects():
    with pytest.raises(TypeError):
        json.dumps({"value": object()}, cls=run_r2s.NumpyEncoder)


def test_load_config_reads_object(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"method": "r2s"}', encoding="utf-8")

    assert run_r2s.load_config(path) == {"method": "r2s"}


def test_load_config_reports_missing_file(tmp_path):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not found"):
        run_r2s.load_config(tmp_path / "missing.json")


def test_load_config_reports_invalid_json(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="Invalid configuration JSON"):
        run_r2s.load_config(path)


def test_load_config_rejects_non_object(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("[1, 2]", encoding="utf-8")

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="JSON object"):
        run_r2s.load_config(path)


# ---------------------------------------------------------------------------
# _parse_timestep / normalize_schedule / normalize_photon_time_indices
# ---------------------------------------------------------------------------


def test_parse_timestep_accepts_numeric_and_single_token_strings():
    assert run_r2s._parse_timestep(3, "d") == (3.0, "d")
    assert run_r2s._parse_timestep(" 90 ", "s") == (90.0, "s")


@pytest.mark.parametrize(
    ("value", "match"),
    [
        (True, "positive numbers"),
        (None, "Invalid timestep"),
        ("1 2 3", "Invalid timestep"),
        (0, "Invalid timestep"),
        ("2 weeks", "Invalid timestep"),
        ("abc", "Invalid timestep"),
        ("abc h", "Invalid timestep"),
    ],
)
def test_parse_timestep_rejects_invalid_values(value, match):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match=match):
        run_r2s._parse_timestep(value, "h")


def test_normalize_schedule_expands_scalar_source_rate():
    config = {"timesteps": ["1 h", 2], "sourceRates": 2.5}

    timesteps, source_rates, units = run_r2s.normalize_schedule(config)

    assert timesteps == [(1.0, "h"), (2.0, "s")]
    assert source_rates == [2.5, 2.5]
    assert units == "s"


@pytest.mark.parametrize(
    ("config", "match"),
    [
        ({}, "At least one timestep"),
        ({"timesteps": []}, "At least one timestep"),
        ({"timesteps": [1], "timestepUnits": "weeks"}, "Unsupported timestep unit"),
        ({"timesteps": [1], "sourceRates": [1e15, 0]}, "entries but there are"),
        ({"timesteps": [1], "sourceRates": "1e15"}, "sourceRates must be a number"),
        ({"timesteps": [1], "sourceRates": [-1]}, "non-negative"),
    ],
)
def test_normalize_schedule_rejects_invalid_config(config, match):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match=match):
        run_r2s.normalize_schedule(config)


def test_normalize_photon_time_indices_dedupes_and_normalizes_negatives():
    config = {"photonTimeIndices": [3, -1, 3]}

    assert run_r2s.normalize_photon_time_indices(config, 4) == [3]


def test_normalize_photon_time_indices_returns_none_when_absent():
    assert run_r2s.normalize_photon_time_indices({}, 4) is None


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        ([], "at least one index"),
        ([True], "only integers"),
        (["1"], "only integers"),
        ([4], "outside the schedule"),
        ([-5], "outside the schedule"),
    ],
)
def test_normalize_photon_time_indices_rejects_invalid_entries(raw, match):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match=match):
        run_r2s.normalize_photon_time_indices({"photonTimeIndices": raw}, 4)


# ---------------------------------------------------------------------------
# parse_bounding_boxes
# ---------------------------------------------------------------------------


def test_parse_bounding_boxes_returns_float_tuples():
    config = {"boundingBoxes": {"1": {"lowerLeft": ["0", 0, 0], "upperRight": [1, 2, 3]}}}

    assert run_r2s.parse_bounding_boxes(config) == {1: ((0.0, 0.0, 0.0), (1.0, 2.0, 3.0))}
    assert run_r2s.parse_bounding_boxes({}) == {}


@pytest.mark.parametrize(
    ("config", "match"),
    [
        ({"boundingBoxes": ["box"]}, "must be an object"),
        ({"boundingBoxes": {"abc": {}}}, "Invalid bounding-box cell ID"),
        (
            {"boundingBoxes": {"1": {"lowerLeft": [0, 0], "upperRight": [1, 1, 1]}}},
            "three values",
        ),
        ({"boundingBoxes": {"1": "nope"}}, "three values"),
        (
            {"boundingBoxes": {"1": {"lowerLeft": [0, 0, 0], "upperRight": [0, 1, 1]}}},
            "at or below",
        ),
    ],
)
def test_parse_bounding_boxes_rejects_invalid_config(config, match):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match=match):
        run_r2s.parse_bounding_boxes(config)


# ---------------------------------------------------------------------------
# Photon tally selection
# ---------------------------------------------------------------------------


def test_is_photon_tally_imports_openmc_when_module_not_injected(monkeypatch):
    fake_openmc = SimpleNamespace(ParticleFilter=FakeParticleFilter)
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)

    assert run_r2s._is_photon_tally(FakeTally(7)) is True
    assert run_r2s._is_photon_tally(FakeTally(7, filters=[])) is False


def test_select_photon_tallies_auto_selects_when_no_ids_requested():
    model = SimpleNamespace(tallies=[FakeTally(7), FakeTally(8, filters=[])])
    fake_openmc = SimpleNamespace(ParticleFilter=FakeParticleFilter, Tallies=list)

    selected = run_r2s.select_photon_tallies(model, [], fake_openmc)

    assert [tally.id for tally in selected] == [7]


def test_select_photon_tallies_returns_plain_list_without_module():
    fake_openmc = SimpleNamespace(ParticleFilter=FakeParticleFilter)
    model = SimpleNamespace(tallies=[FakeTally(7)])

    # The helper imports the fake module itself for the filter check.
    original = sys.modules.get("openmc")
    sys.modules["openmc"] = fake_openmc
    try:
        selected = run_r2s.select_photon_tallies(model, None, None)
    finally:
        if original is None:
            sys.modules.pop("openmc", None)
        else:
            sys.modules["openmc"] = original

    assert isinstance(selected, list)
    assert [tally.id for tally in selected] == [7]


def test_select_photon_tallies_reports_missing_ids():
    model = SimpleNamespace(tallies=[FakeTally(7)])

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not found in tallies.xml"):
        run_r2s.select_photon_tallies(model, [99], make_openmc_module())


def test_select_photon_tallies_requires_a_photon_tally():
    model = SimpleNamespace(tallies=[FakeTally(7, filters=[])])

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="No photon tallies"):
        run_r2s.select_photon_tallies(model, [], make_openmc_module())


def test_select_photon_tallies_rejects_explicitly_requested_non_photon_tally():
    model = SimpleNamespace(tallies=[FakeTally(7, filters=[])])

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="do not target photons"):
        run_r2s.select_photon_tallies(model, [7], make_openmc_module())


# ---------------------------------------------------------------------------
# load_meshes / domain resolution / overlap warnings
# ---------------------------------------------------------------------------


def test_load_meshes_parses_every_mesh_type_and_skips_invalid_entries(tmp_path):
    (tmp_path / "tallies.xml").write_text(
        """
        <tallies>
          <mesh id="5" type="regular"/>
          <mesh id="6" type="cylindrical"/>
          <mesh id="7" type="spherical"/>
          <mesh id="nope" type="regular"/>
          <mesh type="regular"/>
          <mesh id="5" type="cylindrical"/>
          <mesh id="8" type="unstructured"/>
        </tallies>
        """,
        encoding="utf-8",
    )
    (tmp_path / "settings.xml").write_text(
        '<settings><mesh id="9" type="regular"/></settings>', encoding="utf-8"
    )

    meshes = run_r2s.load_meshes(make_openmc_module(), tmp_path)

    assert sorted(meshes) == [5, 6, 7, 9]
    assert isinstance(meshes[5], FakeRegularMesh)
    assert isinstance(meshes[6], FakeCylindricalMesh)
    assert isinstance(meshes[7], FakeSphericalMesh)


def test_load_meshes_ignores_absent_files(tmp_path):
    assert run_r2s.load_meshes(make_openmc_module(), tmp_path) == {}


def test_resolve_cell_domains_requires_cell_ids():
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="at least one activation cell"):
        run_r2s.resolve_cell_domains(make_openmc_module(), SimpleNamespace(), {})


def test_resolve_cell_domains_reports_missing_cells():
    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {}))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not found in geometry.xml"):
        run_r2s.resolve_cell_domains(make_openmc_module(), model, {"cellIds": [1, 2]})


def test_resolve_cell_domains_rejects_non_positive_volume():
    cell = FakeCell(cell_id=1, volume=0)
    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {1: cell}))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="has no volume"):
        run_r2s.resolve_cell_domains(make_openmc_module(), model, {"cellIds": [1]})


def test_resolve_cell_domains_prefers_configured_bounding_box():
    cell = FakeCell(cell_id=1, volume=1.0)
    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {1: cell}))
    config = {
        "cellIds": [1],
        "boundingBoxes": {"1": {"lowerLeft": [0, 0, 0], "upperRight": [1, 2, 3]}},
    }

    domains, boxes = run_r2s.resolve_cell_domains(make_openmc_module(), model, config)

    assert domains == [cell]
    assert isinstance(boxes[1], FakeBoundingBox)
    assert boxes[1].lower_left == (0.0, 0.0, 0.0)
    assert boxes[1].upper_right == (1.0, 2.0, 3.0)


def test_resolve_cell_domains_rejects_unfilled_cells():
    cell = SimpleNamespace(id=1, volume=1.0, fill=None)
    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {1: cell}))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not filled with a material"):
        run_r2s.resolve_cell_domains(make_openmc_module(), model, {"cellIds": [1]})


def test_resolve_cell_domains_rejects_fill_without_nuclides():
    cell = SimpleNamespace(id=1, volume=1.0, fill=SimpleNamespace())
    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {1: cell}))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not filled with a material"):
        run_r2s.resolve_cell_domains(make_openmc_module(), model, {"cellIds": [1]})


def test_resolve_cell_domains_reports_uncomputable_bounding_box():
    class BrokenCell:
        id = 1
        volume = 1.0
        fill = SimpleNamespace(get_nuclides=lambda: ["Fe56"])

        @property
        def bounding_box(self):
            raise RuntimeError("csg failed")

    model = SimpleNamespace(geometry=SimpleNamespace(get_all_cells=lambda: {1: BrokenCell()}))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="no computable bounding box"):
        run_r2s.resolve_cell_domains(make_openmc_module(), model, {"cellIds": [1]})


def test_resolve_mesh_domains_requires_mesh_ids():
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="at least one activation mesh"):
        run_r2s.resolve_mesh_domains(make_openmc_module(), ".", {})


def test_resolve_mesh_domains_reports_missing_meshes(monkeypatch):
    monkeypatch.setattr(run_r2s, "load_meshes", lambda openmc, working_dir: {})

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="not found in tallies.xml"):
        run_r2s.resolve_mesh_domains(make_openmc_module(), ".", {"meshIds": [3]})


def test_resolve_mesh_domains_returns_domains_and_warnings(monkeypatch):
    meshes = {
        3: FakeRegularMesh(3, (0, 0, 0), (1, 1, 1)),
        4: FakeRegularMesh(4, (2, 0, 0), (3, 1, 1)),
    }
    monkeypatch.setattr(run_r2s, "load_meshes", lambda openmc, working_dir: meshes)

    domains, warnings = run_r2s.resolve_mesh_domains(make_openmc_module(), ".", {"meshIds": [3, 4]})

    assert [mesh.id for mesh in domains] == [3, 4]
    assert warnings == []


def test_mesh_overlap_warnings_ignores_touching_and_non_regular_meshes():
    touching = [
        FakeRegularMesh(3, (0, 0, 0), (1, 1, 1)),
        FakeRegularMesh(4, (1, 0, 0), (2, 1, 1)),
    ]
    non_regular = SimpleNamespace(id=9)

    assert run_r2s.mesh_overlap_warnings(touching + [non_regular]) == []


def test_mesh_overlap_warnings_reports_overlapping_bounds():
    meshes = [
        FakeRegularMesh(3, (0, 0, 0), (2, 1, 1)),
        FakeRegularMesh(4, (1, 0, 0), (3, 1, 1)),
    ]

    warnings = run_r2s.mesh_overlap_warnings(meshes)

    assert len(warnings) == 1
    assert "Meshes 3 and 4" in warnings[0]


# ---------------------------------------------------------------------------
# _finite_array / summarize_tally / summarize_activation
# ---------------------------------------------------------------------------


def test_finite_array_flattens_and_drops_non_finite_values():
    finite = run_r2s._finite_array([[1.0, np.nan], [np.inf, 2.0]])

    assert finite.tolist() == [1.0, 2.0]


def test_summarize_tally_handles_missing_std_dev_and_all_non_finite_mean():
    class BrokenStdDevTally:
        id = 5
        name = "broken"
        scores = ["flux"]
        filters = []
        mean = np.array([[1.0, np.nan], [3.0, np.inf]])

        @property
        def std_dev(self):
            raise RuntimeError("std dev unavailable")

    summary = run_r2s.summarize_tally(BrokenStdDevTally())

    assert summary["min"] == 1.0
    assert summary["max"] == 3.0
    assert summary["sum"] == 4.0
    assert "stdDev" not in summary

    empty = run_r2s.summarize_tally(
        FakeTally(mean=np.array([np.nan, np.nan]), filters=[], scores=["flux"])
    )
    assert empty["min"] is None
    assert empty["max"] is None
    assert empty["sum"] is None


def test_summarize_tally_reports_parent_nuclide_bins():
    tally = FakeTally(
        mean=np.array([1.0, 2.0]),
        filters=[FakeParentNuclideFilter(["Co60", "Ni65"])],
    )

    summary = run_r2s.summarize_tally(tally)

    assert summary["parentNuclides"] == ["Co60", "Ni65"]


class FakeDepletionResults:
    """Depletion results stub with configurable activity/decay-heat responses."""

    def __init__(
        self,
        times=(0.0, 3600.0),
        activity=(1.0, 2.0),
        decay_heat=(0.1, 0.2),
        activity_error=None,
        heat_error=None,
    ):
        self.times = list(times)
        self.activity = list(activity)
        self.decay_heat = list(decay_heat)
        self.activity_error = activity_error
        self.heat_error = heat_error

    def get_activity(self, material, units="Bq", chain_file=None):
        if self.activity_error:
            raise RuntimeError(self.activity_error)
        return list(self.times), list(self.activity)

    def get_decay_heat(self, material, units="W"):
        if self.heat_error:
            raise RuntimeError(self.heat_error)
        return list(self.times), list(self.decay_heat)


def test_summarize_activation_returns_empty_for_missing_results():
    assert run_r2s.summarize_activation(None, [SimpleNamespace(id=1)]) == (None, None, [])
    assert run_r2s.summarize_activation(FakeDepletionResults(), []) == (None, None, [])


def test_summarize_activation_accumulates_activity_and_decay_heat():
    materials = [
        SimpleNamespace(id=1, name="steel"),
        SimpleNamespace(id=2, name="water"),
    ]

    activity, decay_heat, warnings = run_r2s.summarize_activation(FakeDepletionResults(), materials)

    assert warnings == []
    assert activity["timesSeconds"] == [0.0, 3600.0]
    assert activity["totalBq"] == [2.0, 4.0]
    assert [region["region"] for region in activity["byRegion"]] == ["steel", "water"]
    assert decay_heat["totalW"] == [pytest.approx(0.2), pytest.approx(0.4)]


def test_summarize_activation_uses_fallback_heat_and_names():
    results = FakeDepletionResults(activity=(3.0, 4.0), heat_error="no decay data")
    materials = [SimpleNamespace(id=7, name="")]

    activity, decay_heat, warnings = run_r2s.summarize_activation(results, materials)

    assert activity["byRegion"][0]["region"] == "Material 7"
    assert decay_heat["totalW"] == [0.0, 0.0]
    assert any("Could not compute decay heat for 7" in warning for warning in warnings)


def test_summarize_activation_skips_materials_without_activity():
    results = FakeDepletionResults(activity_error="no chain data")
    materials = [SimpleNamespace(id=3, name="steel")]

    activity, decay_heat, warnings = run_r2s.summarize_activation(results, materials)

    assert activity is None
    assert decay_heat is None
    assert any("Could not compute activity for steel" in warning for warning in warnings)


def test_summarize_activation_truncates_region_summaries():
    materials = [SimpleNamespace(id=index, name=f"region-{index}") for index in range(203)]

    activity, _, warnings = run_r2s.summarize_activation(FakeDepletionResults(), materials)

    assert len(activity["byRegion"]) == run_r2s.MAX_REGION_SUMMARIES
    assert sum("truncated" in warning for warning in warnings) == 1


# ---------------------------------------------------------------------------
# collect_files / find_last_photon_statepoint
# ---------------------------------------------------------------------------


def test_collect_files_respects_limit_and_reports_relative_paths(tmp_path):
    nested = tmp_path / "activation"
    nested.mkdir()
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    (nested / "b.txt").write_text("b", encoding="utf-8")
    (nested / "c.txt").write_text("c", encoding="utf-8")

    files = run_r2s.collect_files(tmp_path, limit=2)

    assert files == ["a.txt", "activation/b.txt"]


def test_find_last_photon_statepoint_returns_last_candidate(tmp_path):
    for index in (1, 2, 10):
        directory = tmp_path / "photon_transport" / f"time_{index}"
        directory.mkdir(parents=True)
        (directory / f"statepoint.{index}.h5").write_text("x", encoding="utf-8")

    statepoint = run_r2s.find_last_photon_statepoint(tmp_path)

    # Candidates are sorted as paths, so time_2 sorts after time_10.
    assert statepoint is not None
    assert statepoint.endswith("time_2/statepoint.2.h5")
    assert run_r2s.find_last_photon_statepoint(tmp_path / "missing") is None


# ---------------------------------------------------------------------------
# run_r2s error branches and optional results
# ---------------------------------------------------------------------------


def test_run_r2s_rejects_non_r2s_method(tmp_path):
    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="method='r2s'"):
        run_r2s.run_r2s({"method": "d1s"}, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_rejects_skipping_neutron_transport(tmp_path):
    config = {"method": "r2s", "runNeutron": False}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="cannot be skipped"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_reports_missing_chain_file(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    config = {"method": "r2s", "chainFile": str(tmp_path / "missing-chain.xml")}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="chain file not found"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_reports_missing_openmc(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "openmc", None)
    monkeypatch.setitem(sys.modules, "openmc.deplete", None)
    config = {"method": "r2s", "runNeutron": True}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="depletion support is required"):
        run_r2s.run_r2s(config, str(tmp_path))


def test_run_r2s_reports_missing_openmc_deplete(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "openmc", ModuleType("openmc"))
    monkeypatch.setitem(sys.modules, "openmc.deplete", None)
    config = {"method": "r2s", "runNeutron": True}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="depletion support is required"):
        run_r2s.run_r2s(config, str(tmp_path))


def test_run_r2s_requires_geometry_xml(tmp_path):
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>", encoding="utf-8")
    config = {"method": "r2s", "chainFile": str(chain)}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="No geometry.xml"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_requires_chain_file(tmp_path):
    (tmp_path / "geometry.xml").write_text("<geometry/>", encoding="utf-8")
    config = {"method": "r2s", "cellIds": [1], "timesteps": [1], "sourceRates": [1.0]}

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="chain file is required"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=make_openmc_module())


def test_run_r2s_reports_model_load_failure(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    def broken_from_xml(cls, *args, **kwargs):
        raise RuntimeError("bad xml")

    monkeypatch.setattr(fake_openmc.Model, "from_xml", classmethod(broken_from_xml))

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="Could not load the model XML"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)


def test_run_r2s_skips_photon_transport_when_disabled(tmp_path):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    config["runPhoton"] = False
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    manager = FakeR2SManager.instances[0]
    assert manager.photon_model is None
    assert manager.step4_args is None
    assert result["summary"]["photonTallies"] == 0
    assert result["summary"]["photonTimeIndices"] == []
    assert any("Photon transport was disabled" in item for item in result["summary"]["warnings"])


def test_run_r2s_propagates_config_errors_from_manager(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    def fail_step2(self, *args, **kwargs):
        raise run_r2s.ShutdownDoseConfigError("step two says no")

    monkeypatch.setattr(FakeR2SManager, "step2_activation", fail_step2)

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="step two says no"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)


def test_run_r2s_wraps_manager_failures(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    def fail_step1(self, *args, **kwargs):
        raise RuntimeError("solver exploded")

    monkeypatch.setattr(FakeR2SManager, "step1_neutron_transport", fail_step1)

    with pytest.raises(run_r2s.ShutdownDoseConfigError, match="R2S calculation failed"):
        run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)


def test_run_r2s_reports_dose_from_matching_photon_tally(tmp_path):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    config["doseTallyId"] = 7
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert result["summary"]["dose"] == {
        "tallyId": 7,
        "timeIndex": 1,
        "peak": 3.0,
        "mean": 2.0,
    }


def test_run_r2s_leaves_dose_unset_for_non_finite_tally(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    config["doseTallyId"] = 7
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    def step4_with_nan(self, output_dir, run_kwargs=None, by_parent_nuclide=False):
        self.results["photon_tallies"] = {1: [FakeTally(7, mean=np.array([np.nan, np.nan]))]}

    monkeypatch.setattr(FakeR2SManager, "step4_photon_transport", step4_with_nan)

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert result["summary"]["dose"] is None


def test_run_r2s_dose_ignores_infinite_bins(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = make_config(tmp_path, chain)
    config["doseTallyId"] = 7
    fake_openmc = make_openmc_module(cells=[FakeCell()], tallies=[FakeTally(7)])

    def step4_with_inf(self, output_dir, run_kwargs=None, by_parent_nuclide=False):
        self.results["photon_tallies"] = {1: [FakeTally(7, mean=np.array([np.inf, 2.0]))]}

    monkeypatch.setattr(FakeR2SManager, "step4_photon_transport", step4_with_inf)

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    assert result["summary"]["dose"]["peak"] == 2.0
    assert result["summary"]["dose"]["mean"] == 2.0


def test_run_r2s_mesh_based_passes_mat_vol_samples(tmp_path, monkeypatch):
    chain = write_model_inputs(tmp_path)
    config = {
        "method": "r2s",
        "domainType": "mesh",
        "meshIds": [3],
        "timesteps": [1],
        "sourceRates": [1e15],
        "chainFile": str(chain),
        "photonTallyIds": [7],
        "matVolSamples": 250,
    }
    meshes = {3: FakeRegularMesh(3)}
    monkeypatch.setattr(run_r2s, "load_meshes", lambda openmc, working_dir: meshes)
    fake_openmc = make_openmc_module(tallies=[FakeTally(7)])

    result = run_r2s.run_r2s(config, str(tmp_path), openmc_module=fake_openmc)

    manager = FakeR2SManager.instances[0]
    assert [mesh.id for mesh in manager.domains] == [3]
    assert manager.step1_args[1] == {"n_samples": 250}
    assert result["summary"]["activationRegions"] == 1


# ---------------------------------------------------------------------------
# main CLI
# ---------------------------------------------------------------------------


def test_main_prints_result_and_returns_zero(tmp_path, monkeypatch, capsys):
    config_path = tmp_path / "config.json"
    config_path.write_text('{"method": "r2s"}', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["run_r2s.py", str(tmp_path), "--config", str(config_path)])
    monkeypatch.setattr(run_r2s, "load_config", lambda path: {"method": "r2s"})
    monkeypatch.setattr(run_r2s, "run_r2s", lambda config, working_directory: {"success": True})

    assert run_r2s.main() == 0
    assert json.loads(capsys.readouterr().out) == {"success": True}


def test_main_reports_config_error_as_json(tmp_path, monkeypatch, capsys):
    missing = tmp_path / "missing.json"
    monkeypatch.setattr(sys, "argv", ["run_r2s.py", str(tmp_path), "--config", str(missing)])

    assert run_r2s.main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["success"] is False
    assert "not found" in payload["error"]
    assert "FAILED:" in captured.err


def test_main_reports_unexpected_error_with_traceback(tmp_path, monkeypatch, capsys):
    config_path = tmp_path / "config.json"
    config_path.write_text('{"method": "r2s"}', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["run_r2s.py", str(tmp_path), "--config", str(config_path)])

    def broken_load(path):
        raise RuntimeError("boom")

    monkeypatch.setattr(run_r2s, "load_config", broken_load)

    assert run_r2s.main() == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"success": False, "error": "boom"}
    assert "Traceback" in captured.err
