"""Tests for dagmc_editor_service (stub pydagmc/pymoab tier).

dagmc_editor_service does a top-level ``from pydagmc import Model``, so a
stub pydagmc module is inserted into sys.modules before import (same
pattern as test_run_optimization.py). pymoab, gmsh, and OCP are replaced
with lightweight recording fakes where the code under test needs them;
no real .h5m files, mesh databases, or CAD kernels are used.
"""

import json
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")


@pytest.fixture()
def des():
    """Import dagmc_editor_service with a stubbed pydagmc module; restore after."""
    stub = types.ModuleType("pydagmc")
    # Only pydagmc.Model is needed at import time.
    stub.Model = type("Model", (), {})

    sentinel = object()
    old_pydagmc = sys.modules.get("pydagmc", sentinel)
    old_des = sys.modules.get("dagmc_editor_service", sentinel)

    sys.modules["pydagmc"] = stub
    sys.modules.pop("dagmc_editor_service", None)
    import dagmc_editor_service

    yield dagmc_editor_service

    if old_pydagmc is sentinel:
        sys.modules.pop("pydagmc", None)
    else:
        sys.modules["pydagmc"] = old_pydagmc
    if old_des is sentinel:
        sys.modules.pop("dagmc_editor_service", None)
    else:
        sys.modules["dagmc_editor_service"] = old_des


# ---------------------------------------------------------------------------
# Fake DAGMC model objects
# ---------------------------------------------------------------------------


class FakeSurface:
    """Fake pydagmc surface holding optional triangle coordinates."""

    def __init__(self, coords=None, raises=False):
        self._coords = coords
        self._raises = raises

    def get_triangle_conn_and_coords(self):
        if self._raises:
            raise RuntimeError("mesh read failed")
        return ([0, 1, 2], self._coords)


class FakeVolume:
    """Fake pydagmc volume."""

    def __init__(self, vid, material=None, num_triangles=6, surfaces=None):
        self.id = vid
        self.material = material
        self.num_triangles = num_triangles
        self.surfaces = surfaces if surfaces is not None else []
        self.handle = 1000 + vid


class FakeGroup:
    """Fake pydagmc group."""

    def __init__(self, name, volumes=()):
        self.name = name
        self.volumes = list(volumes)
        self.handle = 2000 + len(name)


class FakeMB:
    """Recording fake for model.mb (the pymoab core object)."""

    def __init__(self, root_data=None, entity_data=None):
        self.calls = []
        self._root_data = root_data
        self._entity_data = entity_data if entity_data is not None else {}
        self._next_handle = 5000

    def write_file(self, path):
        self.calls.append(("write_file", path))

    def create_meshset(self, *args):
        self._next_handle += 1
        self.calls.append(("create_meshset",) + args)
        return self._next_handle

    def tag_set_data(self, tag, handle, data):
        self.calls.append(("tag_set_data", tag, handle, data))

    def tag_get_data(self, tag, entities):
        self.calls.append(("tag_get_data", tag, list(entities)))
        if list(entities) == [0]:
            if isinstance(self._root_data, Exception):
                raise self._root_data
            return self._root_data
        data = self._entity_data.get(entities[0])
        if isinstance(data, Exception):
            raise data
        return data

    def get_root_set(self):
        return 0

    def get_entities_by_type_and_tag(self, *args):
        return list(self._entity_data)

    def add_entities(self, handle, entities):
        self.calls.append(("add_entities", handle, list(entities)))

    def remove_entities(self, handle, entities):
        self.calls.append(("remove_entities", handle, list(entities)))

    def delete_entities(self, entities):
        self.calls.append(("delete_entities", list(entities)))


class FakeModel:
    """Configurable fake for pydagmc.Model."""

    def __init__(
        self,
        volumes=(),
        surfaces=(),
        groups=(),
        volumes_by_material=None,
        mb=None,
    ):
        self.volumes = list(volumes)
        self.surfaces = list(surfaces)
        self.groups = list(groups)
        self.group_names = [g.name for g in self.groups]
        self.volumes_by_id = {v.id: v for v in self.volumes}
        self.groups_by_name = {g.name: g for g in self.groups}
        self.volumes_by_material = volumes_by_material if volumes_by_material is not None else {}
        self.mb = mb if mb is not None else FakeMB()
        self.faceting_tol_tag = "FACETING_TOL_TAG"
        self.category_tag = "CATEGORY_TAG"
        self.name_tag = "NAME_TAG"


def _install_model(des, monkeypatch, model):
    """Point dagmc_editor_service.Model at a prebuilt fake model."""
    monkeypatch.setattr(des, "Model", lambda file_path: model)
    return model


def _install_fake_pymoab(monkeypatch):
    """Insert a bare fake pymoab module exposing the core/types namespaces."""
    fake_pymoab = types.ModuleType("pymoab")
    fake_pymoab.types = types.ModuleType("pymoab.types")
    fake_pymoab.types.MBENTITYSET = "MBENTITYSET"
    fake_pymoab.types.MBTRI = "MBTRI"
    fake_pymoab.core = types.ModuleType("pymoab.core")
    monkeypatch.setitem(sys.modules, "pymoab", fake_pymoab)
    monkeypatch.setitem(sys.modules, "pymoab.core", fake_pymoab.core)
    monkeypatch.setitem(sys.modules, "pymoab.types", fake_pymoab.types)
    return fake_pymoab


# ---------------------------------------------------------------------------
# _read_faceting_tolerance
# ---------------------------------------------------------------------------


class TestReadFacetingTolerance:
    def test_default_without_pymoab(self, des, monkeypatch):
        """Without pymoab the default tolerance 0.001 is returned."""
        monkeypatch.setitem(sys.modules, "pymoab", None)
        model = FakeModel()
        assert des._read_faceting_tolerance(model) == 0.001

    def test_reads_value_from_root_set(self, des, monkeypatch):
        """A FACETING_TOL tag on the root set is used."""
        _install_fake_pymoab(monkeypatch)
        model = FakeModel(mb=FakeMB(root_data=[[0.05]]))
        assert des._read_faceting_tolerance(model) == 0.05

    def test_falls_back_to_entity_sets(self, des, monkeypatch):
        """When the root set read fails, entity sets are scanned."""
        _install_fake_pymoab(monkeypatch)
        mb = FakeMB(root_data=RuntimeError("no root tag"), entity_data={42: [[0.07]]})
        model = FakeModel(mb=mb)
        assert des._read_faceting_tolerance(model) == 0.07

    def test_empty_root_data_falls_through(self, des, monkeypatch):
        """None/empty root data skips to entity sets, then the default."""
        _install_fake_pymoab(monkeypatch)
        assert des._read_faceting_tolerance(FakeModel(mb=FakeMB(root_data=None))) == 0.001
        assert des._read_faceting_tolerance(FakeModel(mb=FakeMB(root_data=[]))) == 0.001

    def test_entity_read_error_is_skipped(self, des, monkeypatch):
        """A failing entity read is skipped in favor of later entities."""
        _install_fake_pymoab(monkeypatch)
        mb = FakeMB(
            root_data=None,
            entity_data={41: RuntimeError("bad entity"), 42: [[0.09]]},
        )
        assert des._read_faceting_tolerance(FakeModel(mb=mb)) == 0.09


# ---------------------------------------------------------------------------
# load_model
# ---------------------------------------------------------------------------


class TestLoadModel:
    def test_success_full_model(self, des, monkeypatch, tmp_path):
        """Volumes, materials, and typed groups are reported with a bbox."""
        coords = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 1.0]]
        vol1 = FakeVolume(1, material="fuel", num_triangles=12, surfaces=[FakeSurface(coords)])
        vol2 = FakeVolume(2, material=None, num_triangles=6, surfaces=[])
        vol3 = FakeVolume(3, num_triangles=4, surfaces=[FakeSurface(raises=True)])
        groups = [
            FakeGroup("mat:fuel", [vol1]),
            FakeGroup("boundary:vacuum", [vol2]),
            FakeGroup("misc", []),
        ]
        model = FakeModel(
            volumes=[vol1, vol2, vol3],
            surfaces=[object(), object()],
            groups=groups,
            volumes_by_material={"fuel": [vol1], "void": [vol2, vol3]},
        )
        _install_model(des, monkeypatch, model)
        h5m = tmp_path / "model.h5m"
        h5m.write_bytes(b"fake")

        result = des.load_model(str(h5m))

        assert result["success"] is True
        data = result["data"]
        assert data["fileName"] == "model.h5m"
        assert data["fileSizeMB"] == 0.0
        assert data["volumeCount"] == 3
        assert data["surfaceCount"] == 2
        assert data["vertices"] == 22

        v1 = data["volumes"][0]
        assert v1["id"] == 1
        assert v1["material"] == "fuel"
        assert v1["numTriangles"] == 12
        assert v1["boundingBox"] == {"min": [0.0, 0.0, 0.0], "max": [2.0, 3.0, 1.0]}
        # No surfaces -> default zero bbox.
        assert data["volumes"][1]["boundingBox"] == {"min": [0, 0, 0], "max": [0, 0, 0]}
        # Surface mesh read failure -> default zero bbox, volume kept.
        assert data["volumes"][2]["boundingBox"] == {"min": [0, 0, 0], "max": [0, 0, 0]}

        assert data["materials"]["fuel"] == {"volumeCount": 1, "volumes": [1]}
        assert data["materials"]["void"] == {"volumeCount": 2, "volumes": [2, 3]}

        gtypes = {g["name"]: g["type"] for g in data["groups"]}
        assert gtypes == {"mat:fuel": "material", "boundary:vacuum": "boundary", "misc": "other"}
        assert data["groups"][0]["volumes"] == [1]

    def test_broken_volume_is_skipped_with_warning(self, des, monkeypatch, tmp_path, capsys):
        """A volume whose attributes raise is skipped with a stderr warning."""

        class BadVolume:
            id = 9
            material = "x"
            surfaces = []

            @property
            def num_triangles(self):
                raise RuntimeError("MB_INDEX_OUT_OF_RANGE")

        good = FakeVolume(1, num_triangles=3)
        model = FakeModel(volumes=[good, BadVolume()])
        _install_model(des, monkeypatch, model)
        h5m = tmp_path / "model.h5m"
        h5m.write_bytes(b"fake")

        result = des.load_model(str(h5m))

        assert result["success"] is True
        assert [v["id"] for v in result["data"]["volumes"]] == [1]
        assert "skipped volume 9" in capsys.readouterr().err

    def test_model_load_failure_returns_error(self, des, monkeypatch):
        """A Model constructor failure yields an error dict with a traceback."""

        def boom(file_path):
            raise RuntimeError("not a DAGMC file")

        monkeypatch.setattr(des, "Model", boom)
        result = des.load_model("/nonexistent/model.h5m")
        assert result["success"] is False
        assert "not a DAGMC file" in result["error"]
        assert "traceback" in result


# ---------------------------------------------------------------------------
# assign_material
# ---------------------------------------------------------------------------


class TestAssignMaterial:
    def test_assign_writes_file(self, des, monkeypatch, tmp_path):
        """Assigning a material sets it and persists the model."""
        vol = FakeVolume(3)
        model = FakeModel(volumes=[vol])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.assign_material(target, 3, "steel")

        assert result["success"] is True
        assert 'Assigned material "steel" to volume 3' in result["message"]
        assert vol.material == "steel"
        assert ("write_file", target) in model.mb.calls

    def test_empty_name_removes_material(self, des, monkeypatch, tmp_path):
        """An empty material name clears the assignment."""
        vol = FakeVolume(3, material="steel")
        _install_model(des, monkeypatch, FakeModel(volumes=[vol]))

        result = des.assign_material(str(tmp_path / "m.h5m"), 3, "")

        assert result["success"] is True
        assert vol.material is None

    def test_unknown_volume_returns_error(self, des, monkeypatch, tmp_path):
        """A missing volume id yields a 'not found' error dict."""
        _install_model(des, monkeypatch, FakeModel(volumes=[FakeVolume(1)]))
        result = des.assign_material(str(tmp_path / "m.h5m"), 99, "steel")
        assert result == {"success": False, "error": "Volume 99 not found"}

    def test_model_failure_returns_error(self, des, monkeypatch, tmp_path):
        """A Model constructor failure yields an error dict with a traceback."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.assign_material(str(tmp_path / "m.h5m"), 1, "steel")
        assert result["success"] is False
        assert "bad file" in result["error"]
        assert "traceback" in result


# ---------------------------------------------------------------------------
# Group management
# ---------------------------------------------------------------------------


class TestCreateGroup:
    def test_create_group_with_volumes(self, des, monkeypatch, tmp_path):
        """A new meshset is tagged and the requested volumes are added."""
        _install_fake_pymoab(monkeypatch)
        vol = FakeVolume(1)
        model = FakeModel(volumes=[vol])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.create_group(target, "shielding", [1, 99])

        assert result == {"success": True, "message": 'Created group "shielding"'}
        created = [c for c in model.mb.calls if c[0] == "create_meshset"]
        assert created == [("create_meshset", "MBENTITYSET")]
        handle = created[0] and 5001
        assert ("tag_set_data", "CATEGORY_TAG", handle, "Group") in model.mb.calls
        assert ("tag_set_data", "NAME_TAG", handle, "shielding") in model.mb.calls
        # Volume 99 does not exist; only volume 1 is added.
        assert ("add_entities", handle, [vol.handle]) in model.mb.calls
        assert ("write_file", target) in model.mb.calls

    def test_create_group_without_volumes(self, des, monkeypatch, tmp_path):
        """Omitting volume_ids creates an empty group."""
        _install_fake_pymoab(monkeypatch)
        model = FakeModel()
        _install_model(des, monkeypatch, model)

        result = des.create_group(str(tmp_path / "m.h5m"), "empty_group")

        assert result["success"] is True
        assert not [c for c in model.mb.calls if c[0] == "add_entities"]

    def test_existing_group_returns_error(self, des, monkeypatch, tmp_path):
        """A duplicate group name is rejected before any pymoab import."""
        _install_model(des, monkeypatch, FakeModel(groups=[FakeGroup("mat:fuel")]))
        result = des.create_group(str(tmp_path / "m.h5m"), "mat:fuel")
        assert result == {"success": False, "error": 'Group "mat:fuel" already exists'}

    def test_model_failure_returns_error(self, des, monkeypatch, tmp_path):
        """A Model constructor failure yields an error dict."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.create_group(str(tmp_path / "m.h5m"), "g")
        assert result["success"] is False
        assert "bad file" in result["error"]


class TestDeleteGroup:
    def test_delete_group(self, des, monkeypatch, tmp_path):
        """The group meshset is deleted and the file rewritten."""
        group = FakeGroup("mat:fuel")
        model = FakeModel(groups=[group])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.delete_group(target, "mat:fuel")

        assert result == {"success": True, "message": 'Deleted group "mat:fuel"'}
        assert ("delete_entities", [group.handle]) in model.mb.calls
        assert ("write_file", target) in model.mb.calls

    def test_missing_group_returns_error(self, des, monkeypatch, tmp_path):
        """Deleting an unknown group yields a 'not found' error."""
        _install_model(des, monkeypatch, FakeModel())
        result = des.delete_group(str(tmp_path / "m.h5m"), "nope")
        assert result == {"success": False, "error": 'Group "nope" not found'}


class TestAddRemoveVolumes:
    def test_add_volumes_to_group(self, des, monkeypatch, tmp_path):
        """Existing volumes are added to the group meshset."""
        vol = FakeVolume(2)
        group = FakeGroup("mat:fuel")
        model = FakeModel(volumes=[vol], groups=[group])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.add_volumes_to_group(target, "mat:fuel", [2, 77])

        assert result["success"] is True
        assert 'Added 2 volumes to group "mat:fuel"' in result["message"]
        assert ("add_entities", group.handle, [vol.handle]) in model.mb.calls
        assert ("write_file", target) in model.mb.calls

    def test_add_to_missing_group_returns_error(self, des, monkeypatch, tmp_path):
        """Adding to an unknown group yields a 'not found' error."""
        _install_model(des, monkeypatch, FakeModel())
        result = des.add_volumes_to_group(str(tmp_path / "m.h5m"), "nope", [1])
        assert result == {"success": False, "error": 'Group "nope" not found'}

    def test_remove_volumes_from_group(self, des, monkeypatch, tmp_path):
        """Existing volumes are removed from the group meshset."""
        vol = FakeVolume(2)
        group = FakeGroup("mat:fuel")
        model = FakeModel(volumes=[vol], groups=[group])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.remove_volumes_from_group(target, "mat:fuel", [2, 77])

        assert result["success"] is True
        assert 'Removed 2 volumes from group "mat:fuel"' in result["message"]
        assert ("remove_entities", group.handle, [vol.handle]) in model.mb.calls
        assert ("write_file", target) in model.mb.calls

    def test_remove_from_missing_group_returns_error(self, des, monkeypatch, tmp_path):
        """Removing from an unknown group yields a 'not found' error."""
        _install_model(des, monkeypatch, FakeModel())
        result = des.remove_volumes_from_group(str(tmp_path / "m.h5m"), "nope", [1])
        assert result == {"success": False, "error": 'Group "nope" not found'}


# ---------------------------------------------------------------------------
# get_faceting_params / estimate_triangles
# ---------------------------------------------------------------------------


class TestGetFacetingParams:
    def test_success(self, des, monkeypatch, tmp_path):
        """Tolerance, triangle count, and entity counts are reported."""
        model = FakeModel(
            volumes=[FakeVolume(1, num_triangles=10), FakeVolume(2, num_triangles=5)],
            surfaces=[object(), object(), object()],
        )
        _install_model(des, monkeypatch, model)

        result = des.get_faceting_params(str(tmp_path / "m.h5m"))

        assert result["success"] is True
        # pymoab is absent in the test env -> default tolerance.
        assert result["data"] == {
            "facetingTolerance": 0.001,
            "totalTriangles": 15,
            "volumeCount": 2,
            "surfaceCount": 3,
        }

    def test_model_failure_returns_error(self, des, monkeypatch, tmp_path):
        """A Model constructor failure yields an error dict."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.get_faceting_params(str(tmp_path / "m.h5m"))
        assert result["success"] is False
        assert "bad file" in result["error"]


def _params(tol=0.001, tri=100000, vols=4, surfs=12, success=True):
    """Build a fake get_faceting_params result."""
    if not success:
        return {"success": False, "error": "nope"}
    return {
        "success": True,
        "data": {
            "facetingTolerance": tol,
            "totalTriangles": tri,
            "volumeCount": vols,
            "surfaceCount": surfs,
        },
    }


class TestEstimateTriangles:
    def test_failed_params_passthrough(self, des, monkeypatch, tmp_path):
        """A failing get_faceting_params result is returned unchanged."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params(success=False))
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.01)
        assert result == {"success": False, "error": "nope"}

    def test_non_positive_tolerance_rejected(self, des, monkeypatch, tmp_path):
        """Zero/negative tolerances yield a validation error."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params())
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.0)
        assert result == {"success": False, "error": "Tolerance must be positive"}

        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params(tol=0.0))
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.01)
        assert result == {"success": False, "error": "Tolerance must be positive"}

    def test_coarsening_sqrt_scaling(self, des, monkeypatch, tmp_path):
        """A 10x larger tolerance scales triangles by sqrt(0.1)."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params())
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.01)

        assert result["success"] is True
        data = result["data"]
        assert data["estimatedTriangles"] == int(100000 * 0.1**0.5)
        assert data["currentTolerance"] == 0.001
        assert data["newTolerance"] == 0.01
        assert data["currentTriangles"] == 100000
        assert data["volumeCount"] == 4
        assert data["surfaceCount"] == 12

    def test_coarsening_floor_applies(self, des, monkeypatch, tmp_path):
        """Extreme coarsening is clamped to the geometry-aware floor."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params(tri=1000))
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 100.0)

        data = result["data"]
        # scale floor is 0.02 -> 20 triangles, floor is max(800, 240, 1000).
        assert data["estimatedTriangles"] == 1000

    def test_refinement_power_scaling(self, des, monkeypatch, tmp_path):
        """A 10x smaller tolerance scales triangles by 10**1.5."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params())
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.0001)

        assert result["data"]["estimatedTriangles"] == int(100000 * 10.0**1.5)

    def test_refinement_scale_cap_and_ceiling(self, des, monkeypatch, tmp_path):
        """Refinement is capped at 100x and at least a 1M-triangle ceiling."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: _params(tri=20000))
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 1e-9)

        # ratio -> scale capped at 100 -> 2,000,000; ceiling max(2M, 1M) keeps it.
        assert result["data"]["estimatedTriangles"] == 2000000

    def test_unexpected_error_returns_error_dict(self, des, monkeypatch, tmp_path):
        """An exception in the estimation logic yields an error dict."""

        def boom(path):
            raise RuntimeError("disk exploded")

        monkeypatch.setattr(des, "get_faceting_params", boom)
        result = des.estimate_triangles(str(tmp_path / "m.h5m"), 0.01)
        assert result["success"] is False
        assert "disk exploded" in result["error"]


# ---------------------------------------------------------------------------
# refacet
# ---------------------------------------------------------------------------


class TestRefacet:
    def test_missing_pymoab(self, des, monkeypatch, tmp_path):
        """Without pymoab the documented error dict is returned."""
        monkeypatch.setitem(sys.modules, "pymoab", None)
        result = des.refacet(str(tmp_path / "m.h5m"), "model.step", 0.01)
        assert result == {"success": False, "error": "pymoab is not installed"}

    def _install_refacet_fakes(self, des, monkeypatch, n_vols=2):
        """Fake pymoab, Model (2 materials), and _step_to_dagmc_ocp."""
        _install_fake_pymoab(monkeypatch)
        vols = [FakeVolume(1, material="fuel"), FakeVolume(2, material=None)]
        _install_model(des, monkeypatch, FakeModel(volumes=vols))
        calls = {}

        def fake_step(step_path, h5m_path, tolerance, material_map=None):
            calls.update(
                step_path=step_path,
                h5m_path=h5m_path,
                tolerance=tolerance,
                material_map=material_map,
            )
            # The real converter writes the h5m file that refacet then moves.
            with open(h5m_path, "wb") as f:
                f.write(b"h5m")
            return (n_vols, 50, 300)

        monkeypatch.setattr(des, "_step_to_dagmc_ocp", fake_step)
        return calls

    def test_success_path(self, des, monkeypatch, tmp_path):
        """A successful refacet moves the output next to the source file."""
        calls = self._install_refacet_fakes(des, monkeypatch)
        existing = tmp_path / "model.h5m"
        existing.write_bytes(b"old")

        result = des.refacet(str(existing), "model.step", 0.01)

        assert result["success"] is True
        out = tmp_path / "model_refaceted.h5m"
        assert result["data"]["outputPath"] == str(out)
        assert out.read_bytes() == b"h5m"
        assert "2 volumes, 300 triangles" in result["data"]["message"]
        assert result["warnings"] == []
        # Old materials were extracted and forwarded to the converter.
        assert calls["material_map"] == {1: "fuel", 2: None}
        assert calls["step_path"] == "model.step"
        assert calls["tolerance"] == 0.01

    def test_volume_count_mismatch_warns(self, des, monkeypatch, tmp_path):
        """A different new volume count adds a warning entry."""
        self._install_refacet_fakes(des, monkeypatch, n_vols=5)
        existing = tmp_path / "model.h5m"
        existing.write_bytes(b"old")

        result = des.refacet(str(existing), "model.step", 0.01)

        assert result["success"] is True
        assert len(result["warnings"]) == 1
        assert "old=2, new=5" in result["warnings"][0]

    def test_existing_output_is_replaced(self, des, monkeypatch, tmp_path):
        """A stale _refaceted.h5m file is removed before the move."""
        self._install_refacet_fakes(des, monkeypatch)
        existing = tmp_path / "model.h5m"
        existing.write_bytes(b"old")
        stale = tmp_path / "model_refaceted.h5m"
        stale.write_bytes(b"stale")

        result = des.refacet(str(existing), "model.step", 0.01)

        assert result["success"] is True
        assert stale.read_bytes() == b"h5m"

    def test_conversion_failure_returns_error(self, des, monkeypatch, tmp_path):
        """A converter exception yields an error dict with a traceback."""
        _install_fake_pymoab(monkeypatch)
        _install_model(des, monkeypatch, FakeModel(volumes=[FakeVolume(1)]))
        monkeypatch.setattr(
            des,
            "_step_to_dagmc_ocp",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("OCP exploded")),
        )
        existing = tmp_path / "model.h5m"
        existing.write_bytes(b"old")

        result = des.refacet(str(existing), "model.step", 0.01)

        assert result["success"] is False
        assert "OCP exploded" in result["error"]
        assert "traceback" in result


# ---------------------------------------------------------------------------
# _write_dagmc_streaming (fake gmsh + fake moab core)
# ---------------------------------------------------------------------------


class _FakeMoabCore:
    """Recording fake for the pymoab core used by _write_dagmc_streaming."""

    def __init__(self):
        self.meshsets = 0
        self.elements = []
        self.tag_data = []
        self.entities_added = []
        self.parent_child = []

    def create_meshset(self):
        self.meshsets += 1
        return 9000 + self.meshsets

    def tag_set_data(self, tag, handle, data):
        self.tag_data.append((tag, handle, data))

    def create_element(self, etype, verts):
        self.elements.append((etype, tuple(verts)))
        return ("elem", len(self.elements))

    def add_entity(self, meshset, entity):
        self.entities_added.append((meshset, entity))

    def add_parent_child(self, parent, child):
        self.parent_child.append((parent, child))

    def get_root_set(self):
        return 0


def _install_fake_gmsh(monkeypatch, boundaries, elements):
    """Insert a fake gmsh module driven by per-volume boundary/element maps."""
    fake_gmsh = types.ModuleType("gmsh")

    def get_boundary(dimtags, oriented=False, recursive=False):
        return boundaries.get(dimtags[0][1], [])

    def get_elements(dim, tag):
        return elements.get(tag, ([], [], []))

    fake_gmsh.model = SimpleNamespace(
        getEntities=lambda dim: [(3, tag) for tag in boundaries],
        getBoundary=get_boundary,
        mesh=SimpleNamespace(getElements=get_elements),
    )
    monkeypatch.setitem(sys.modules, "gmsh", fake_gmsh)
    return fake_gmsh


class TestWriteDagmcStreaming:
    def test_streams_triangles_quads_and_senses(self, des, monkeypatch):
        """Two volumes sharing a face produce tagged sets and GEOM_SENSE_2."""
        _install_fake_pymoab(monkeypatch)
        boundaries = {
            # Volume 1 has faces 10, 11 and an edge entry that must be skipped.
            1: [(2, 10), (2, 11), (1, 99)],
            2: [(2, 10)],
        }
        elements = {
            # Face 10: 2 triangles, 1 quad (split into 2), 1 line (skipped).
            10: (
                [2, 3, 1],
                [[201], [202], [204]],
                [
                    np.array([1, 2, 3, 2, 3, 4]),
                    np.array([1, 2, 3, 4]),
                    np.array([1, 2]),
                ],
            ),
            # Face 11: a single triangle.
            11: ([2], [[203]], [np.array([1, 2, 4])]),
        }
        _install_fake_gmsh(monkeypatch, boundaries, elements)
        mb = _FakeMoabCore()
        verts = ["v1", "v2", "v3", "v4"]
        node_idx = {1: 0, 2: 1, 3: 2, 4: 3}

        volume_sets, surface_sets, group_sets = des._write_dagmc_streaming(
            mb,
            "GID",
            "GDIM",
            "CAT",
            "NAME",
            "SENSE",
            "FTOL",
            verts,
            node_idx,
            {2: None},
            0.5,
        )

        assert set(volume_sets) == {1, 2}
        assert set(surface_sets) == {10, 11}
        assert set(group_sets) == {1, 2}

        # 4 triangles from face 10 (2 tri + quad split) and 1 from face 11;
        # the shared face is meshed only once.
        assert len(mb.elements) == 5
        assert all(etype == "MBTRI" for etype, _ in mb.elements)
        assert ("MBTRI", ("v1", "v2", "v3")) in mb.elements

        # Volume/surface tags and parent-child links.
        assert ("GID", volume_sets[1], 1) in mb.tag_data
        assert ("GDIM", surface_sets[10], 2) in mb.tag_data
        assert ("CAT", volume_sets[2], "Volume") in mb.tag_data
        assert (volume_sets[2], surface_sets[10]) in mb.parent_child

        # Material groups: vol 1 falls back to mat_0, vol 2 (None) to mat_1.
        assert ("NAME", group_sets[1], "mat:mat_0") in mb.tag_data
        assert ("NAME", group_sets[2], "mat:mat_1") in mb.tag_data

        # GEOM_SENSE_2: shared face points at both volumes, boundary face at one.
        senses = {handle: data for tag, handle, data in mb.tag_data if tag == "SENSE"}
        assert senses[surface_sets[10]].tolist() == [volume_sets[1], volume_sets[2]]
        assert senses[surface_sets[11]].tolist() == [volume_sets[1], 0]

        # Faceting tolerance lands on the root set.
        assert ("FTOL", 0, 0.5) in mb.tag_data


# ---------------------------------------------------------------------------
# _step_to_dagmc_ocp (fake OCP + fake pymoab)
# ---------------------------------------------------------------------------


class _FakePnt:
    def __init__(self, x, y, z):
        self._xyz = (x, y, z)

    def X(self):
        return self._xyz[0]

    def Y(self):
        return self._xyz[1]

    def Z(self):
        return self._xyz[2]

    def Transform(self, trsf):
        return None


class _FakeOctTriangle:
    def __init__(self, a, b, c):
        self._v = (a, b, c)

    def Value(self, i):
        return self._v[i - 1]


class _FakeTriangulation:
    """1-based node/triangle access like an OCCT Poly_Triangulation."""

    def __init__(self, nodes, tris):
        self._nodes = nodes
        self._tris = tris

    def NbNodes(self):
        return len(self._nodes)

    def NbTriangles(self):
        return len(self._tris)

    def Node(self, i):
        return self._nodes[i - 1]

    def Triangle(self, i):
        return self._tris[i - 1]


class _FakeOccFace:
    def __init__(self, tri, tshape):
        self._tri = tri
        self._tshape = tshape

    def Location(self):
        return SimpleNamespace(Transformation=lambda: "TRSF")

    def TShape(self):
        return self._tshape


class _FakeOccCore:
    """Recording fake for pymoab.core.Core used by _step_to_dagmc_ocp."""

    def __init__(self):
        self.meshsets = 0
        self.tag_calls = []
        self.elements = []
        self.entities = []
        self.parent_child = []
        self.written = []
        self.vertices = None

    def tag_get_handle(self, name, *args, **kwargs):
        return ("TAG", name)

    def create_vertices(self, arr):
        self.vertices = arr
        return list(range(len(arr)))

    def create_meshset(self):
        self.meshsets += 1
        return 7000 + self.meshsets

    def tag_set_data(self, tag, handle, data):
        self.tag_calls.append((tag, handle, data))

    def create_element(self, etype, verts):
        self.elements.append((etype, tuple(verts)))
        return ("elem", len(self.elements))

    def add_entity(self, meshset, entity):
        self.entities.append((meshset, entity))

    def add_parent_child(self, parent, child):
        self.parent_child.append((parent, child))

    def get_root_set(self):
        return 0

    def write_file(self, path):
        self.written.append(path)


def _install_fake_ocp(monkeypatch, registry, read_status=1):
    """Insert fake OCP/pymoab modules; returns the recording pymoab core class.

    registry maps (id(shape_or_solid), "SOLID"/"FACE") to explorer children.
    """
    state = {"cores": []}

    class FakeExplorer:
        def __init__(self, shape, what):
            self._items = list(registry.get((id(shape), what), []))
            self._i = 0

        def More(self):
            return self._i < len(self._items)

        def Current(self):
            return self._items[self._i]

        def Next(self):
            self._i += 1

    class FakeReader:
        def ReadFile(self, path):
            return read_status

        def TransferRoot(self):
            return None

        def OneShape(self):
            return "SHAPE"

    ocp = types.ModuleType("OCP")
    brep = types.ModuleType("OCP.BRep")
    brep.BRep_Tool = SimpleNamespace(Triangulation_s=staticmethod(lambda face, loc: face._tri))
    brepmesh = types.ModuleType("OCP.BRepMesh")
    brepmesh.BRepMesh_IncrementalMesh = lambda *a: None
    stepcontrol = types.ModuleType("OCP.STEPControl")
    stepcontrol.STEPControl_Reader = FakeReader
    topabs = types.ModuleType("OCP.TopAbs")
    topabs.TopAbs_FACE = "FACE"
    topabs.TopAbs_SOLID = "SOLID"
    topexp = types.ModuleType("OCP.TopExp")
    topexp.TopExp_Explorer = FakeExplorer
    topods = types.ModuleType("OCP.TopoDS")
    topods.TopoDS = SimpleNamespace(
        Solid_s=staticmethod(lambda s: s), Face_s=staticmethod(lambda f: f)
    )

    class FakeCore(_FakeOccCore):
        def __init__(self):
            super().__init__()
            state["cores"].append(self)

    pymoab = types.ModuleType("pymoab")
    pymoab_core = types.ModuleType("pymoab.core")
    pymoab_core.Core = FakeCore
    pymoab_types = types.ModuleType("pymoab.types")
    for name in (
        "CATEGORY_TAG_NAME",
        "NAME_TAG_NAME",
        "GEOM_DIMENSION_TAG_NAME",
        "GLOBAL_ID_TAG_NAME",
    ):
        setattr(pymoab_types, name, name)
    pymoab_types.CATEGORY_TAG_SIZE = 16
    pymoab_types.NAME_TAG_SIZE = 32
    pymoab_types.MB_TYPE_OPAQUE = 0
    pymoab_types.MB_TYPE_INTEGER = 1
    pymoab_types.MB_TYPE_HANDLE = 2
    pymoab_types.MB_TYPE_DOUBLE = 3
    pymoab_types.MB_TAG_SPARSE = 0
    pymoab_types.MB_TAG_DENSE = 1
    pymoab_types.MBTRI = "MBTRI"
    pymoab.core = pymoab_core
    pymoab.types = pymoab_types

    modules = {
        "OCP": ocp,
        "OCP.BRep": brep,
        "OCP.BRepMesh": brepmesh,
        "OCP.STEPControl": stepcontrol,
        "OCP.TopAbs": topabs,
        "OCP.TopExp": topexp,
        "OCP.TopoDS": topods,
        "pymoab": pymoab,
        "pymoab.core": pymoab_core,
        "pymoab.types": pymoab_types,
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    return state


def _tri_faces():
    """Build three faces where face B shares its TShape across two solids."""

    def face(points, tshape):
        nodes = [_FakePnt(*p) for p in points]
        tri = _FakeTriangulation(nodes, [_FakeOctTriangle(1, 2, 3)])
        return _FakeOccFace(tri, tshape)

    tshape_a, tshape_b, tshape_c = object(), object(), object()
    face_a = face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], tshape_a)
    # Shared face: same TShape and coordinates in both solids.
    face_b1 = face([(5, 5, 5), (6, 5, 5), (5, 6, 5)], tshape_b)
    face_b2 = face([(5, 5, 5), (6, 5, 5), (5, 6, 5)], tshape_b)
    face_c = face([(9, 9, 9), (10, 9, 9), (9, 10, 9)], tshape_c)
    return face_a, face_b1, face_b2, face_c


class TestStepToDagmcOcp:
    def test_builds_tagged_moab(self, des, monkeypatch, tmp_path):
        """Two solids sharing a face produce volumes, surfaces, and senses."""
        face_a, face_b1, face_b2, face_c = _tri_faces()
        solid1, solid2 = object(), object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid1, solid2],
            (id(solid1), "FACE"): [face_a, face_b1],
            (id(solid2), "FACE"): [face_b2, face_c],
        }
        state = _install_fake_ocp(monkeypatch, registry)
        out = str(tmp_path / "out.h5m")

        n_vols, n_verts, n_tris = des._step_to_dagmc_ocp("model.step", out, 0.25, {1: "fuel"})

        assert (n_vols, n_verts, n_tris) == (2, 9, 4)
        mb = state["cores"][0]
        assert mb.written == [out]
        # Vertex dedup: the shared face contributes its nodes only once.
        assert len(mb.vertices) == 9

        tags = {(tag[1], data) for tag, handle, data in mb.tag_calls if not hasattr(data, "tolist")}
        assert ("CATEGORY_TAG_NAME", "Volume") in tags
        assert ("CATEGORY_TAG_NAME", "Surface") in tags
        assert ("CATEGORY_TAG_NAME", "Group") in tags
        assert ("NAME_TAG_NAME", "mat:fuel") in tags
        # Volume 2 has no material entry -> mat_1 default.
        assert ("NAME_TAG_NAME", "mat:mat_1") in tags
        assert ("FACETING_TOL", 0.25) in tags

        # The shared face has a two-volume sense; the others are one-sided.
        senses = [data for tag, handle, data in mb.tag_calls if tag[1] == "GEOM_SENSE_2"]
        sense_lists = sorted(s.tolist() for s in senses)
        assert sense_lists[0][1] == 0
        assert sense_lists[1][1] != 0
        assert sense_lists[2][1] == 0

        # 1 meshset per surface (3) + per volume (2) + per group (2).
        assert mb.meshsets == 7
        # 3 surface meshsets receive one triangle each... shared face meshed once.
        assert len(mb.elements) == 3

    def test_read_failure_raises(self, des, monkeypatch, tmp_path):
        """A non-1 STEP read status raises a RuntimeError."""
        _install_fake_ocp(monkeypatch, {}, read_status=0)
        with pytest.raises(RuntimeError, match="Failed to read STEP file, status=0"):
            des._step_to_dagmc_ocp("model.step", str(tmp_path / "o.h5m"), 0.1)


# ---------------------------------------------------------------------------
# main() CLI dispatch
# ---------------------------------------------------------------------------


class TestMain:
    def _run(self, des, monkeypatch, argv):
        monkeypatch.setattr(sys, "argv", argv)
        return des.main()

    def test_no_command_exits_1(self, des, monkeypatch, capsys):
        """No command prints an error JSON and exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["dagmc_editor_service.py"])
        assert exc.value.code == 1
        assert json.loads(capsys.readouterr().out)["error"] == "No command specified"

    def test_unknown_command_exits_1(self, des, monkeypatch, capsys):
        """An unknown command prints an error JSON and exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["dagmc_editor_service.py", "frobnicate"])
        assert exc.value.code == 1
        assert json.loads(capsys.readouterr().out)["error"] == "Unknown command: frobnicate"

    def test_load_dispatch(self, des, monkeypatch, capsys):
        """'load' forwards the file path and prints the result JSON."""
        monkeypatch.setattr(des, "load_model", lambda p: {"success": True, "path": p})
        self._run(des, monkeypatch, ["x.py", "load", "model.h5m"])
        assert json.loads(capsys.readouterr().out) == {"success": True, "path": "model.h5m"}

    def test_load_missing_path_exits_1(self, des, monkeypatch, capsys):
        """'load' without a path exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "load"])
        assert exc.value.code == 1
        assert "No file path specified" in capsys.readouterr().out

    def test_assign_material_dispatch(self, des, monkeypatch, capsys):
        """'assign_material' parses volume id and material name."""
        captured = {}

        def fake(file_path, volume_id, material_name):
            captured.update(file=file_path, vid=volume_id, mat=material_name)
            return {"success": True}

        monkeypatch.setattr(des, "assign_material", fake)
        self._run(des, monkeypatch, ["x.py", "assign_material", "m.h5m", "7", "steel"])
        assert captured == {"file": "m.h5m", "vid": 7, "mat": "steel"}

    def test_assign_material_insufficient_args_exits_1(self, des, monkeypatch, capsys):
        """'assign_material' with too few args exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "assign_material", "m.h5m", "7"])
        assert exc.value.code == 1
        assert "Insufficient arguments" in capsys.readouterr().out

    def test_create_group_dispatch_parses_volume_list(self, des, monkeypatch, capsys):
        """'create_group' parses the comma-separated volume id list."""
        captured = {}

        def fake(file_path, group_name, volume_ids):
            captured.update(file=file_path, group=group_name, vids=volume_ids)
            return {"success": True}

        monkeypatch.setattr(des, "create_group", fake)
        self._run(des, monkeypatch, ["x.py", "create_group", "m.h5m", "shield", "1,2,3"])
        assert captured == {"file": "m.h5m", "group": "shield", "vids": [1, 2, 3]}

    def test_create_group_without_volume_list(self, des, monkeypatch, capsys):
        """'create_group' without a volume list passes None."""
        captured = {}

        def fake(file_path, group_name, volume_ids):
            captured["vids"] = volume_ids
            return {"success": True}

        monkeypatch.setattr(des, "create_group", fake)
        self._run(des, monkeypatch, ["x.py", "create_group", "m.h5m", "shield"])
        assert captured["vids"] is None

    def test_delete_group_dispatch(self, des, monkeypatch, capsys):
        """'delete_group' forwards the group name."""
        monkeypatch.setattr(des, "delete_group", lambda f, g: {"success": True, "group": g})
        self._run(des, monkeypatch, ["x.py", "delete_group", "m.h5m", "mat:fuel"])
        assert json.loads(capsys.readouterr().out) == {"success": True, "group": "mat:fuel"}

    def test_add_to_group_dispatch(self, des, monkeypatch, capsys):
        """'add_to_group' parses the volume list; empty string means []."""
        captured = {}

        def fake(file_path, group_name, volume_ids):
            captured["vids"] = volume_ids
            return {"success": True}

        monkeypatch.setattr(des, "add_volumes_to_group", fake)
        self._run(des, monkeypatch, ["x.py", "add_to_group", "m.h5m", "g", "4,5"])
        assert captured["vids"] == [4, 5]

        self._run(des, monkeypatch, ["x.py", "add_to_group", "m.h5m", "g", ""])
        assert captured["vids"] == []

    def test_remove_from_group_dispatch(self, des, monkeypatch, capsys):
        """'remove_from_group' parses the volume list."""
        captured = {}

        def fake(file_path, group_name, volume_ids):
            captured["vids"] = volume_ids
            return {"success": True}

        monkeypatch.setattr(des, "remove_volumes_from_group", fake)
        self._run(des, monkeypatch, ["x.py", "remove_from_group", "m.h5m", "g", "4"])
        assert captured["vids"] == [4]

    def test_get_faceting_params_dispatch(self, des, monkeypatch, capsys):
        """'get_faceting_params' forwards the file path."""
        monkeypatch.setattr(des, "get_faceting_params", lambda p: {"success": True, "p": p})
        self._run(des, monkeypatch, ["x.py", "get_faceting_params", "m.h5m"])
        assert json.loads(capsys.readouterr().out) == {"success": True, "p": "m.h5m"}

    def test_estimate_triangles_dispatch(self, des, monkeypatch, capsys):
        """'estimate_triangles' parses the float tolerance."""
        captured = {}

        def fake(file_path, tol):
            captured["tol"] = tol
            return {"success": True}

        monkeypatch.setattr(des, "estimate_triangles", fake)
        self._run(des, monkeypatch, ["x.py", "estimate_triangles", "m.h5m", "0.025"])
        assert captured["tol"] == 0.025

    def test_refacet_dispatch(self, des, monkeypatch, capsys):
        """'refacet' forwards file, CAD path, and float tolerance."""
        captured = {}

        def fake(existing, cad, tol):
            captured.update(existing=existing, cad=cad, tol=tol)
            return {"success": True}

        monkeypatch.setattr(des, "refacet", fake)
        self._run(des, monkeypatch, ["x.py", "refacet", "m.h5m", "model.step", "0.01"])
        assert captured == {"existing": "m.h5m", "cad": "model.step", "tol": 0.01}

    def test_insufficient_args_exit_1(self, des, monkeypatch, capsys):
        """Commands without enough arguments exit 1 with an error JSON."""
        for argv in (
            ["x.py", "create_group", "m.h5m"],
            ["x.py", "delete_group", "m.h5m"],
            ["x.py", "add_to_group", "m.h5m", "g"],
            ["x.py", "remove_from_group", "m.h5m", "g"],
            ["x.py", "get_faceting_params"],
            ["x.py", "estimate_triangles", "m.h5m"],
            ["x.py", "refacet", "m.h5m", "model.step"],
        ):
            with pytest.raises(SystemExit) as exc:
                self._run(des, monkeypatch, argv)
            assert exc.value.code == 1, argv
            assert json.loads(capsys.readouterr().out)["success"] is False
