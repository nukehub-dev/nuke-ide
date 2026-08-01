"""Tests for generate_mgxs_library (fine-grained MGXS Library mode).

openmc / openmc.mgxs are replaced with recording fakes so domain resolution,
library configuration, and the run/export flow are exercised without OpenMC.
The integration test at the end checks the real API surface.
"""

import json
import os
import sys
import types
from types import SimpleNamespace

import generate_mgxs_library
import pytest


@pytest.fixture(autouse=True)
def _restore_cwd():
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


# ---------------------------------------------------------------------------
# resolve_domains (pure — no openmc needed)
# ---------------------------------------------------------------------------


def _fake_geometry():
    return SimpleNamespace(
        get_all_materials=lambda: {
            1: SimpleNamespace(id=1, name="fuel"),
            2: SimpleNamespace(id=2, name="clad"),
        },
        get_all_cells=lambda: {3: SimpleNamespace(id=3), 4: SimpleNamespace(id=4)},
        get_all_universes=lambda: {0: SimpleNamespace(id=0)},
    )


def test_resolve_domains_all_and_by_id():
    geometry = _fake_geometry()
    assert [d.id for d in generate_mgxs_library.resolve_domains(geometry, "material", [])] == [1, 2]
    assert [d.id for d in generate_mgxs_library.resolve_domains(geometry, "cell", [3])] == [3]
    assert [d.id for d in generate_mgxs_library.resolve_domains(geometry, "universe", [0])] == [0]


def test_resolve_domains_errors():
    geometry = _fake_geometry()
    with pytest.raises(ValueError, match="not found"):
        generate_mgxs_library.resolve_domains(geometry, "cell", [99])
    with pytest.raises(ValueError, match="Unsupported domain type"):
        generate_mgxs_library.resolve_domains(geometry, "mesh", [])
    empty = SimpleNamespace(get_all_materials=lambda: {})
    with pytest.raises(ValueError, match="No domains"):
        generate_mgxs_library.resolve_domains(empty, "material", [])


# ---------------------------------------------------------------------------
# run_generate_mgxs_library with fake openmc
# ---------------------------------------------------------------------------


class RecordingLibrary:
    instances = []

    def __init__(self, geometry, by_nuclide=False, mgxs_types=None, name=""):
        self.geometry = geometry
        self.by_nuclide = by_nuclide
        self.mgxs_types = mgxs_types
        self.built = False
        self.loaded_sp = None
        RecordingLibrary.instances.append(self)

    def build_library(self):
        self.built = True

    def add_to_tallies(self, tallies, merge=True):
        self.merged = merge

    def load_from_statepoint(self, sp):
        self.loaded_sp = True

    def get_xsdata(self, domain, xsdata_name):
        return SimpleNamespace(domain=domain.id, name=xsdata_name)


class RecordingMgxsFile:
    instances = []

    def __init__(self, energy_groups):
        self.groups = energy_groups
        self.xsdata = []
        self.exported = None
        RecordingMgxsFile.instances.append(self)

    def add_xsdata(self, xsdata):
        self.xsdata.append(xsdata)

    def export_to_hdf5(self, path):
        self.exported = str(path)


class FakeStatePoint:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_fake_openmc(monkeypatch):
    fake_openmc = types.ModuleType("openmc")
    fake_mgxs = types.ModuleType("openmc.mgxs")
    fake_mgxs.GROUP_STRUCTURES = {"CASMO-2": [0.0, 1.0, 2e7]}
    fake_mgxs.MGXS_TYPES = ("total", "absorption", "fission", "nu-fission", "chi", "scatter matrix")
    fake_mgxs.EnergyGroups = lambda arg: SimpleNamespace(
        num_groups=(len(arg) - 1 if isinstance(arg, list) else 2)
    )
    fake_mgxs.Library = RecordingLibrary

    model = SimpleNamespace(settings=SimpleNamespace(particles=1000), tallies=None)
    model.run = lambda cwd: "statepoint.12.h5"
    fake_openmc.Model = lambda geometry, materials, settings: model
    fake_openmc.MGXSLibrary = RecordingMgxsFile
    fake_openmc.Materials = SimpleNamespace(from_xml=lambda p: [])
    fake_openmc.Geometry = SimpleNamespace(from_xml=lambda p, m: _fake_geometry())
    fake_openmc.Settings = SimpleNamespace(from_xml=lambda p: SimpleNamespace())
    fake_openmc.Tallies = lambda: []
    fake_openmc.StatePoint = lambda path: FakeStatePoint()
    fake_openmc.mgxs = fake_mgxs

    RecordingLibrary.instances = []
    RecordingMgxsFile.instances = []
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.mgxs", fake_mgxs)
    return model


def _write_xml(tmp_path):
    for name in ("materials.xml", "geometry.xml", "settings.xml"):
        (tmp_path / name).write_text(f"<{name.split('.')[0]}/>")
    return tmp_path


def _args(workdir, **overrides):
    defaults = {
        "working_directory": str(workdir),
        "groups": "CASMO-2",
        "mgxs_types": None,
        "domain_type": "material",
        "domain_ids": None,
        "by_nuclide": False,
        "legendre_order": 0,
        "estimator": None,
        "correction": "none",
        "particles": None,
        "output": "mgxs.h5",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_full_flow_configures_library_and_exports(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    _write_xml(tmp_path)
    args = _args(
        tmp_path,
        mgxs_types="total,fission",
        domain_type="cell",
        domain_ids="3",
        by_nuclide=True,
        legendre_order=3,
        estimator="analog",
        particles=500,
    )

    result = generate_mgxs_library.run_generate_mgxs_library(args)

    assert result["success"] is True
    assert result["mgxsTypes"] == [
        "total",
        "fission",
        "consistent nu-scatter matrix",
        "multiplicity matrix",
    ]
    assert result["domainIds"] == [3]
    assert result["byNuclide"] is True
    library = RecordingLibrary.instances[0]
    assert library.built is True
    assert library.by_nuclide is True
    assert library.legendre_order == 3
    assert library.estimator == "analog"
    assert library.correction is None
    assert library.loaded_sp is True
    mgxs_file = RecordingMgxsFile.instances[0]
    assert len(mgxs_file.xsdata) == 1
    assert mgxs_file.exported.endswith("mgxs.h5")


def test_particles_override_and_default_types(monkeypatch, tmp_path):
    model = _install_fake_openmc(monkeypatch)
    _write_xml(tmp_path)
    generate_mgxs_library.run_generate_mgxs_library(_args(tmp_path, particles=500))
    assert model.settings.particles == 500
    assert RecordingLibrary.instances[0].mgxs_types == generate_mgxs_library.DEFAULT_MGXS_TYPES + [
        "consistent nu-scatter matrix",
        "multiplicity matrix",
    ]


def test_explicit_group_edges(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    _write_xml(tmp_path)
    result = generate_mgxs_library.run_generate_mgxs_library(_args(tmp_path, groups="0.0,1.0,2e7"))
    assert result["success"] is True


def test_error_paths(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    with pytest.raises(FileNotFoundError, match="materials.xml"):
        generate_mgxs_library.run_generate_mgxs_library(_args(tmp_path))
    _write_xml(tmp_path)
    with pytest.raises(ValueError, match="Invalid mgxs type"):
        generate_mgxs_library.run_generate_mgxs_library(_args(tmp_path, mgxs_types="bogus-type"))
    with pytest.raises(ValueError, match="Unknown group structure"):
        generate_mgxs_library.run_generate_mgxs_library(_args(tmp_path, groups="NOPE-99"))


def test_main_contract(monkeypatch, tmp_path, capsys):
    _install_fake_openmc(monkeypatch)
    _write_xml(tmp_path)
    monkeypatch.setattr(sys, "argv", ["generate_mgxs_library.py", str(tmp_path)])
    assert generate_mgxs_library.main() == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is True

    monkeypatch.setattr(
        sys, "argv", ["generate_mgxs_library.py", str(tmp_path), "--mgxs-types", "bogus"]
    )
    assert generate_mgxs_library.main() == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is False


# ---------------------------------------------------------------------------
# Integration: real API surface (skipped when openmc is absent)
# ---------------------------------------------------------------------------


def test_mgxs_api_surface_matches_assumptions():
    pytest.importorskip("openmc")
    import inspect

    import openmc.mgxs

    params = inspect.signature(openmc.mgxs.Library.__init__).parameters
    assert list(params)[1:4] == ["geometry", "by_nuclide", "mgxs_types"]
    assert "total" in openmc.mgxs.MGXS_TYPES
    assert "nu-fission" in openmc.mgxs.MGXS_TYPES
    assert "CASMO-2" in openmc.mgxs.GROUP_STRUCTURES
    assert hasattr(openmc.mgxs.Library, "build_library")
    assert hasattr(openmc.mgxs.Library, "add_to_tallies")
    assert hasattr(openmc.mgxs.Library, "load_from_statepoint")
    assert hasattr(openmc.mgxs.Library, "get_xsdata")
    assert hasattr(openmc, "MGXSLibrary")
