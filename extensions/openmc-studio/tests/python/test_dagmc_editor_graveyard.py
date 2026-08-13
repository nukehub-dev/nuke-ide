"""Graveyard/imprint/main-dispatch tests for dagmc_editor_service.

Extends test_dagmc_editor_service.py (whose fakes and fixtures are imported
here) with coverage for detect_graveyard / tag_graveyard /
create_graveyard_box, the imprinted OpenCASCADE conversion path
(_step_to_dagmc_imprinted_ocp), the refacet bbox/imprint branches, the
graveyard CLI dispatches in main(), the ``__main__`` guard, and the pydagmc
site-packages import fallback. All heavy deps (pydagmc, pymoab, OCP, gmsh)
remain faked, so the suite runs with only pytest + numpy installed.
"""

import builtins
import importlib.util
import runpy
import site
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_dagmc_editor_service import (
    FakeGroup,
    FakeMB,
    FakeModel,
    FakeSurface,
    FakeVolume,
    _FakeMoabCore,
    _FakeOccFace,
    _FakeOctTriangle,
    _FakePnt,
    _FakeTriangulation,
    _install_fake_ocp,
    _install_fake_pymoab,
    _install_model,
)
from test_dagmc_editor_service import des as des  # noqa: F401  (fixture re-export)

np = pytest.importorskip("numpy")


# ---------------------------------------------------------------------------
# pydagmc import fallback (module top-level, lines 17-24 + sys.path insert)
# ---------------------------------------------------------------------------


def test_pydagmc_site_packages_fallback(monkeypatch, tmp_path):
    """A missing pydagmc is retried from a site-packages dir that contains it."""
    stub = types.ModuleType("pydagmc")
    stub.Model = type("Model", (), {})
    monkeypatch.setitem(sys.modules, "pydagmc", stub)
    import dagmc_editor_service  # noqa: F401  (gets cad_conversion into sys.modules)

    des_path = Path(sys.modules["dagmc_editor_service"].__file__)
    script_dir = str(des_path.parent.resolve())

    fake_site = tmp_path / "site-packages"
    (fake_site / "pydagmc").mkdir(parents=True)
    (fake_site / "pydagmc" / "__init__.py").write_text("class Model:\n    pass\n")

    monkeypatch.delitem(sys.modules, "pydagmc", raising=False)
    monkeypatch.setattr(sys, "path", [p for p in sys.path if str(Path(p).resolve()) != script_dir])
    monkeypatch.setattr(site, "getsitepackages", lambda: [str(fake_site)])

    real_import = builtins.__import__
    failed = []

    def fake_import(name, *args, **kwargs):
        if name == "pydagmc" and not failed:
            failed.append(name)
            raise ImportError("forced pydagmc absence")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    spec = importlib.util.spec_from_file_location("dagmc_editor_service_fallback", des_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert failed == ["pydagmc"]
    assert mod.Model.__module__ == "pydagmc"
    assert str(fake_site) in sys.path
    assert script_dir in sys.path


# ---------------------------------------------------------------------------
# detect_graveyard
# ---------------------------------------------------------------------------


class TestDetectGraveyard:
    def test_volume_already_tagged_graveyard(self, des, monkeypatch):
        """A volume whose material is graveyard (any case) needs no action."""
        vol = FakeVolume(1, material="GraveYard")
        _install_model(des, monkeypatch, FakeModel(volumes=[vol]))

        result = des.detect_graveyard("m.h5m")

        assert result == {
            "success": True,
            "needsTag": False,
            "canCreate": False,
            "message": "A graveyard volume is already present.",
        }

    def test_graveyard_group_already_present(self, des, monkeypatch):
        """An existing mat:graveyard group needs no action."""
        model = FakeModel(
            volumes=[FakeVolume(1, material="fuel")],
            groups=[FakeGroup("mat:graveyard")],
        )
        _install_model(des, monkeypatch, model)

        result = des.detect_graveyard("m.h5m")

        assert result["success"] is True
        assert result["needsTag"] is False
        assert result["canCreate"] is False
        assert "group" in result["message"]

    def test_enclosing_volume_is_a_retag_candidate(self, des, monkeypatch):
        """A volume enclosing all others is reported as a re-tag candidate."""
        inner = FakeVolume(1, material="fuel", surfaces=[FakeSurface([[0, 0, 0], [1, 1, 1]])])
        outer = FakeVolume(2, material="void", surfaces=[FakeSurface([[-5, -5, -5], [5, 5, 5]])])
        _install_model(des, monkeypatch, FakeModel(volumes=[inner, outer]))

        result = des.detect_graveyard("m.h5m")

        assert result["success"] is True
        assert result["needsTag"] is True
        assert result["canCreate"] is True
        assert result["volumeId"] == 2
        assert result["material"] == "void"
        assert result["bounds"] == {"min": [-5.0, -5.0, -5.0], "max": [5.0, 5.0, 5.0]}
        assert result["suggestedPadding"] == 0.1
        assert "particle sink" in result["message"]

    def test_disjoint_volumes_can_create_new_box(self, des, monkeypatch):
        """No enclosing volume -> a new bounding-box graveyard can be created."""
        vol1 = FakeVolume(1, material="fuel", surfaces=[FakeSurface([[0, 0, 0], [1, 1, 1]])])
        vol2 = FakeVolume(2, surfaces=[FakeSurface([[10, 10, 10], [11, 11, 11]])])
        _install_model(des, monkeypatch, FakeModel(volumes=[vol1, vol2]))

        result = des.detect_graveyard("m.h5m")

        assert result["success"] is True
        assert result["needsTag"] is False
        assert result["canCreate"] is True
        assert result["bounds"] == {"min": [0.0, 0.0, 0.0], "max": [11.0, 11.0, 11.0]}
        assert "bounding-box graveyard" in result["message"]

    def test_single_volume_skips_candidate_scan(self, des, monkeypatch):
        """A lone volume cannot enclose anything; creation is still possible."""
        vol = FakeVolume(1, surfaces=[FakeSurface([[0, 0, 0], [2, 2, 2]])])
        _install_model(des, monkeypatch, FakeModel(volumes=[vol]))

        result = des.detect_graveyard("m.h5m")

        assert result["canCreate"] is True
        assert result["bounds"] == {"min": [0.0, 0.0, 0.0], "max": [2.0, 2.0, 2.0]}

    def test_unreadable_geometry_cannot_create(self, des, monkeypatch):
        """No readable triangles anywhere -> graveyard creation is impossible."""
        vols = [
            FakeVolume(1, surfaces=[FakeSurface(raises=True)]),
            FakeVolume(2, surfaces=[FakeSurface(None)]),
            FakeVolume(3, surfaces=[FakeSurface([1.0, 2.0, 3.0])]),  # 1-D coords: skipped
        ]
        _install_model(des, monkeypatch, FakeModel(volumes=vols))

        result = des.detect_graveyard("m.h5m")

        assert result["success"] is True
        assert result["needsTag"] is False
        assert result["canCreate"] is False
        assert "Could not read model geometry" in result["message"]

    def test_model_failure_returns_error(self, des, monkeypatch):
        """A Model constructor failure yields an error dict with a traceback."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.detect_graveyard("m.h5m")
        assert result["success"] is False
        assert "bad file" in result["error"]
        assert "traceback" in result


# ---------------------------------------------------------------------------
# tag_graveyard
# ---------------------------------------------------------------------------


class TestTagGraveyard:
    def test_explicit_volume_is_retagged(self, des, monkeypatch, tmp_path):
        """The named volume's material is set to graveyard and saved."""
        vol = FakeVolume(2, material="steel")
        model = FakeModel(volumes=[vol])
        _install_model(des, monkeypatch, model)
        target = str(tmp_path / "m.h5m")

        result = des.tag_graveyard(target, 2)

        assert result["success"] is True
        assert result["volumeId"] == 2
        assert result["oldMaterial"] == "steel"
        assert 'was "steel"' in result["message"]
        assert vol.material == "graveyard"
        assert ("write_file", target) in model.mb.calls

    def test_unknown_volume_returns_error(self, des, monkeypatch, tmp_path):
        """A missing volume id yields a 'not found' error dict."""
        _install_model(des, monkeypatch, FakeModel(volumes=[FakeVolume(1)]))
        result = des.tag_graveyard(str(tmp_path / "m.h5m"), 99)
        assert result == {"success": False, "error": "Volume 99 not found"}

    def test_auto_detect_not_needed(self, des, monkeypatch, tmp_path):
        """When detection says no tag is needed its message is passed through."""
        _install_model(des, monkeypatch, FakeModel(volumes=[FakeVolume(1)]))
        monkeypatch.setattr(
            des,
            "detect_graveyard",
            lambda p: {"success": True, "needsTag": False, "message": "already present"},
        )
        result = des.tag_graveyard(str(tmp_path / "m.h5m"))
        assert result == {"success": True, "message": "already present"}

    def test_auto_detect_failure_passthrough(self, des, monkeypatch, tmp_path):
        """A failed detection result is returned unchanged."""
        _install_model(des, monkeypatch, FakeModel(volumes=[FakeVolume(1)]))
        monkeypatch.setattr(des, "detect_graveyard", lambda p: {"success": False, "error": "boom"})
        result = des.tag_graveyard(str(tmp_path / "m.h5m"))
        assert result == {"success": False, "error": "boom"}

    def test_auto_detect_tags_detected_volume(self, des, monkeypatch, tmp_path):
        """Auto-detection forwards the detected volume id to the re-tag."""
        vol = FakeVolume(3, material="water")
        model = FakeModel(volumes=[vol])
        _install_model(des, monkeypatch, model)
        monkeypatch.setattr(
            des, "detect_graveyard", lambda p: {"success": True, "needsTag": True, "volumeId": 3}
        )

        result = des.tag_graveyard(str(tmp_path / "m.h5m"))

        assert result["success"] is True
        assert result["volumeId"] == 3
        assert vol.material == "graveyard"

    def test_model_failure_returns_error(self, des, monkeypatch, tmp_path):
        """A Model constructor failure yields an error dict with a traceback."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.tag_graveyard(str(tmp_path / "m.h5m"), 1)
        assert result["success"] is False
        assert "bad file" in result["error"]
        assert "traceback" in result


# ---------------------------------------------------------------------------
# _model_bounding_box
# ---------------------------------------------------------------------------


class TestModelBoundingBox:
    def test_stacks_all_volume_coords(self, des):
        """The model bbox spans every volume's triangle coordinates."""
        vol1 = FakeVolume(1, surfaces=[FakeSurface([[0, 0, 0], [1, 4, 1]])])
        vol2 = FakeVolume(2, surfaces=[FakeSurface([[-2, 1, 3], [5, 1, 0]])])
        mn, mx = des._model_bounding_box(FakeModel(volumes=[vol1, vol2]))
        assert mn.tolist() == [-2.0, 0.0, 0.0]
        assert mx.tolist() == [5.0, 4.0, 3.0]

    def test_no_coords_raises(self, des):
        """A model without readable coordinates raises ValueError."""
        vol = FakeVolume(1, surfaces=[FakeSurface(raises=True)])
        with pytest.raises(ValueError, match="no readable triangle coordinates"):
            des._model_bounding_box(FakeModel(volumes=[vol]))


# ---------------------------------------------------------------------------
# create_graveyard_box
# ---------------------------------------------------------------------------


class _GraveyardMB(FakeMB):
    """FakeMB extended with the vertex/element creation used by graveyard shells."""

    def __init__(self):
        super().__init__()
        self.vertices_created = []
        self.elements = []
        self.entities = []

    def create_vertices(self, arr):
        arr = np.asarray(arr)
        self.vertices_created.append(arr)
        return list(range(len(arr)))

    def create_element(self, etype, verts):
        self.elements.append((etype, tuple(verts)))
        return ("tri", len(self.elements))

    def add_entity(self, handle, entity):
        self.entities.append((handle, entity))


class _ShellSurface:
    """Fake surface shell with a handle, senses, and delete tracking."""

    def __init__(self, sid):
        self.id = sid
        self.handle = 3000 + sid
        self.senses = None
        self.deleted = False

    def delete(self):
        self.deleted = True


class _ShellVolume:
    """Fake volume with delete tracking for the graveyard-removal path."""

    def __init__(self, vid, material=None, surfaces=()):
        self.id = vid
        self.handle = 4000 + vid
        self.material = material
        self.surfaces = list(surfaces)
        self.deleted = False

    def delete(self):
        self.deleted = True


class _GraveyardModel(FakeModel):
    """FakeModel extended with volume/surface creation and file writing."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.created_volumes = []
        self.created_surfaces = []
        self.written = []

    def create_volume(self, global_id):
        vol = _ShellVolume(global_id)
        self.created_volumes.append(vol)
        return vol

    def create_surface(self, global_id):
        surf = _ShellSurface(global_id)
        self.created_surfaces.append(surf)
        return surf

    def write_file(self, path):
        self.written.append(path)


class TestCreateGraveyardBox:
    def _make_model(self, coords=((0.0, 0.0, 0.0), (2.0, 2.0, 2.0)), surfaces=None):
        vol = FakeVolume(1, material="fuel", surfaces=[FakeSurface([list(c) for c in coords])])
        return _GraveyardModel(
            volumes=[vol],
            surfaces=surfaces if surfaces is not None else [_ShellSurface(1)],
            mb=_GraveyardMB(),
        )

    def test_builds_hollow_shell(self, des, monkeypatch):
        """A 12-surface shell around the model bbox is created and saved."""
        _install_fake_pymoab(monkeypatch)
        model = self._make_model()
        _install_model(des, monkeypatch, model)

        result = des.create_graveyard_box("m.h5m", padding=0.1)

        assert result["success"] is True
        assert result["volumeId"] == 2  # max existing volume id (1) + 1
        assert "volume 2" in result["message"]
        # center [1,1,1], size 2 -> outer half = 2 * 1.1 * 0.5 = 1.1
        assert result["bounds"]["min"] == pytest.approx([-0.1, -0.1, -0.1])
        assert result["bounds"]["max"] == pytest.approx([2.1, 2.1, 2.1])

        # 6 inner + 6 outer faces, two triangles each; ids continue after max surf id.
        assert [s.id for s in model.created_surfaces] == list(range(2, 14))
        assert len(model.mb.vertices_created) == 2
        assert all(len(v) == 8 for v in model.mb.vertices_created)
        assert len(model.mb.elements) == 24
        assert all(etype == "MBTRI" for etype, _ in model.mb.elements)

        # Every shell surface has the graveyard volume as its forward sense.
        gy = model.created_volumes[0]
        assert gy.material == "graveyard"
        assert all(s.senses == [gy, None] for s in model.created_surfaces)
        assert model.written == ["m.h5m"]

    def test_output_path_overrides_input(self, des, monkeypatch):
        """An explicit output path receives the file instead of the input."""
        _install_fake_pymoab(monkeypatch)
        model = self._make_model()
        _install_model(des, monkeypatch, model)

        result = des.create_graveyard_box("m.h5m", output_path="out.h5m")

        assert result["success"] is True
        assert model.written == ["out.h5m"]

    def test_degenerate_model_uses_unit_size(self, des, monkeypatch):
        """A zero-size model bbox falls back to a unit shell size."""
        _install_fake_pymoab(monkeypatch)
        model = self._make_model(coords=((1.0, 1.0, 1.0), (1.0, 1.0, 1.0)), surfaces=[])
        _install_model(des, monkeypatch, model)

        result = des.create_graveyard_box("m.h5m", padding=0.1)

        assert result["success"] is True
        # size -> 1.0, outer half = 1 * 1.1 * 0.5 = 0.55 around center [1,1,1].
        assert result["bounds"]["min"] == pytest.approx([0.45, 0.45, 0.45])
        assert result["bounds"]["max"] == pytest.approx([1.55, 1.55, 1.55])
        # No pre-existing surfaces -> surface ids start at 1.
        assert [s.id for s in model.created_surfaces] == list(range(1, 13))

    def test_existing_graveyard_is_removed_first(self, des, monkeypatch):
        """An old graveyard volume and its surfaces are deleted before rebuilding."""
        _install_fake_pymoab(monkeypatch)
        gy_surf = _ShellSurface(5)
        gy_vol = _ShellVolume(9, material="graveyard", surfaces=[gy_surf])
        fuel = FakeVolume(1, material="fuel", surfaces=[FakeSurface([[0, 0, 0], [2, 2, 2]])])
        model = _GraveyardModel(
            volumes=[gy_vol, fuel], surfaces=[_ShellSurface(1)], mb=_GraveyardMB()
        )
        _install_model(des, monkeypatch, model)

        result = des.create_graveyard_box("m.h5m")

        assert result["success"] is True
        assert result["volumeId"] == 10  # max existing volume id (9) + 1
        assert gy_vol.deleted is True
        assert gy_surf.deleted is True

    def test_unreadable_model_returns_error(self, des, monkeypatch):
        """A model with no readable triangles yields an error dict."""
        _install_fake_pymoab(monkeypatch)
        _install_model(des, monkeypatch, _GraveyardModel(mb=_GraveyardMB()))
        result = des.create_graveyard_box("m.h5m")
        assert result["success"] is False
        assert "no readable triangle coordinates" in result["error"]
        assert "traceback" in result

    def test_model_failure_returns_error(self, des, monkeypatch):
        """A Model constructor failure yields an error dict with a traceback."""
        _install_fake_pymoab(monkeypatch)
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        result = des.create_graveyard_box("m.h5m")
        assert result["success"] is False
        assert "bad file" in result["error"]


# ---------------------------------------------------------------------------
# Group management error paths
# ---------------------------------------------------------------------------


class TestGroupErrorPaths:
    def test_model_failures_return_error_dicts(self, des, monkeypatch):
        """delete/add/remove group surface Model failures as error dicts."""
        monkeypatch.setattr(
            des, "Model", lambda file_path: (_ for _ in ()).throw(ValueError("bad file"))
        )
        calls = (
            (des.delete_group, ("m.h5m", "g")),
            (des.add_volumes_to_group, ("m.h5m", "g", [1])),
            (des.remove_volumes_from_group, ("m.h5m", "g", [1])),
        )
        for func, args in calls:
            result = func(*args)
            assert result["success"] is False, func.__name__
            assert "bad file" in result["error"]
            assert "traceback" in result


# ---------------------------------------------------------------------------
# _write_dagmc_streaming: sense-loop skip
# ---------------------------------------------------------------------------


class TestWriteDagmcStreamingSkips:
    def test_face_without_surface_set_is_skipped(self, des, monkeypatch):
        """A face that never got a surface meshset is skipped in the sense loop."""
        _install_fake_pymoab(monkeypatch)
        # The face->volume scan (first getBoundary call) sees faces 10 and 11,
        # but the processing pass only sees face 10, so face 11 has no surface set.
        calls = {"n": 0}

        def get_boundary(dimtags, oriented=False, recursive=False):
            calls["n"] += 1
            return [(2, 10), (2, 11)] if calls["n"] == 1 else [(2, 10)]

        fake_gmsh = types.ModuleType("gmsh")
        fake_gmsh.model = SimpleNamespace(
            getEntities=lambda dim: [(3, 1)],
            getBoundary=get_boundary,
            mesh=SimpleNamespace(
                getElements=lambda dim, tag: ([2], [[201]], [np.array([1, 2, 3])])
            ),
        )
        monkeypatch.setitem(sys.modules, "gmsh", fake_gmsh)
        mb = _FakeMoabCore()

        volume_sets, surface_sets, _group_sets = des._write_dagmc_streaming(
            mb,
            "GID",
            "GDIM",
            "CAT",
            "NAME",
            "SENSE",
            "FTOL",
            ["v1", "v2", "v3"],
            {1: 0, 2: 1, 3: 2},
            {},
            0.1,
        )

        assert set(surface_sets) == {10}
        senses = [data for tag, _h, data in mb.tag_data if tag == "SENSE"]
        assert len(senses) == 1
        assert senses[0].tolist() == [volume_sets[1], 0]


# ---------------------------------------------------------------------------
# _step_to_dagmc_ocp edge paths
# ---------------------------------------------------------------------------


class TestStepToDagmcOcpEdges:
    def test_faces_without_triangulation_are_skipped(self, des, monkeypatch, tmp_path):
        """Faces with no (or an empty) triangulation do not produce surfaces."""
        nodes = [_FakePnt(0, 0, 0), _FakePnt(1, 0, 0), _FakePnt(0, 1, 0)]
        face_ok = _FakeOccFace(_FakeTriangulation(nodes, [_FakeOctTriangle(1, 2, 3)]), object())
        face_none = _FakeOccFace(None, object())
        face_empty = _FakeOccFace(_FakeTriangulation([], []), object())
        solid = object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid],
            (id(solid), "FACE"): [face_none, face_empty, face_ok],
        }
        state = _install_fake_ocp(monkeypatch, registry)
        out = str(tmp_path / "out.h5m")

        n_vols, n_verts, n_tris = des._step_to_dagmc_ocp("model.step", out, 0.1)

        assert (n_vols, n_verts, n_tris) == (1, 3, 1)
        assert len(state["cores"][0].elements) == 1

    def test_none_material_falls_back_to_default(self, des, monkeypatch, tmp_path):
        """A material_map entry of None falls back to the mat_<idx> default."""
        nodes = [_FakePnt(0, 0, 0), _FakePnt(1, 0, 0), _FakePnt(0, 1, 0)]
        face_ok = _FakeOccFace(_FakeTriangulation(nodes, [_FakeOctTriangle(1, 2, 3)]), object())
        solid = object()
        registry = {(id("SHAPE"), "SOLID"): [solid], (id(solid), "FACE"): [face_ok]}
        state = _install_fake_ocp(monkeypatch, registry)

        des._step_to_dagmc_ocp("model.step", str(tmp_path / "o.h5m"), 0.1, {1: None})

        tags = {(t[1], d) for t, _h, d in state["cores"][0].tag_calls if not hasattr(d, "tolist")}
        assert ("NAME_TAG_NAME", "mat:mat_0") in tags


# ---------------------------------------------------------------------------
# _step_to_dagmc_imprinted_ocp
# ---------------------------------------------------------------------------


def _install_fake_bopalgo(monkeypatch, shape):
    """Insert a fake OCP.BOPAlgo whose builder returns ``shape`` from Shape()."""
    bop = types.ModuleType("OCP.BOPAlgo")

    class FakeBuilder:
        instances = []

        def __init__(self):
            self.args = []
            self.performed = False
            FakeBuilder.instances.append(self)

        def AddArgument(self, solid):
            self.args.append(solid)

        def Perform(self):
            self.performed = True

        def Shape(self):
            return shape

    bop.BOPAlgo_Builder = FakeBuilder
    monkeypatch.setitem(sys.modules, "OCP.BOPAlgo", bop)
    return FakeBuilder


def _one_tri_face(points, tshape):
    nodes = [_FakePnt(*p) for p in points]
    return _FakeOccFace(_FakeTriangulation(nodes, [_FakeOctTriangle(1, 2, 3)]), tshape)


def _tag_names(core):
    """Set of (tag name, data) pairs recorded on the fake pymoab core."""
    return {(t[1], d) for t, _h, d in core.tag_calls if not hasattr(d, "tolist")}


class TestStepToDagmcImprintedOcp:
    def test_two_solids_shared_face_merged(self, des, monkeypatch, tmp_path):
        """Coincident faces merge into one surface with a two-volume sense."""
        face_a = _one_tri_face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], object())
        # Shared interface: identical coordinates, distinct TShapes.
        face_b1 = _one_tri_face([(5, 5, 5), (6, 5, 5), (5, 6, 5)], object())
        face_b2 = _one_tri_face([(5, 5, 5), (6, 5, 5), (5, 6, 5)], object())
        face_c = _one_tri_face([(9, 9, 9), (10, 9, 9), (9, 10, 9)], object())
        solid1, solid2 = object(), object()
        merged = object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid1, solid2],
            (id(merged), "SOLID"): [solid1, solid2],
            (id(solid1), "FACE"): [face_a, face_b1],
            (id(solid2), "FACE"): [face_b2, face_c],
        }
        state = _install_fake_ocp(monkeypatch, registry)
        fake_builder = _install_fake_bopalgo(monkeypatch, merged)
        out = str(tmp_path / "out.h5m")

        n_vols, n_verts, n_tris = des._step_to_dagmc_imprinted_ocp(
            "model.step", out, 0.25, {1: "fuel"}
        )

        # 9 unique vertices (shared face deduped), 3 merged surfaces x 1 triangle.
        assert (n_vols, n_verts, n_tris) == (2, 9, 3)
        builder = fake_builder.instances[0]
        assert builder.args == [solid1, solid2]
        assert builder.performed is True

        mb = state["cores"][0]
        assert mb.written == [out]
        tags = _tag_names(mb)
        assert ("NAME_TAG_NAME", "mat:fuel") in tags
        assert ("NAME_TAG_NAME", "mat:mat_1") in tags
        assert ("NAME_TAG_NAME", "boundary:vacuum") in tags
        assert ("FACETING_TOL", 0.25) in tags
        # 2 volume sets + 3 surface sets + 3 group sets (2 materials + boundary).
        assert mb.meshsets == 8
        assert len(mb.elements) == 3

        # The merged interface senses both volumes; external faces are one-sided.
        senses = [d.tolist() for t, _h, d in mb.tag_calls if t[1] == "GEOM_SENSE_2"]
        assert len(senses) == 3
        assert sum(1 for s in senses if s[1] != 0) == 1

        # Only the two external surfaces join the boundary:vacuum group.
        boundary_handle = next(
            h for t, h, d in mb.tag_calls if t[1] == "NAME_TAG_NAME" and d == "boundary:vacuum"
        )
        boundary_members = [ms for ms, _e in mb.entities if ms == boundary_handle]
        assert len(boundary_members) == 2

    def test_single_solid_skips_builder(self, des, monkeypatch, tmp_path):
        """One solid needs no imprint; BOPAlgo_Builder is never constructed."""
        face_a = _one_tri_face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], object())
        solid = object()
        registry = {(id("SHAPE"), "SOLID"): [solid], (id(solid), "FACE"): [face_a]}
        state = _install_fake_ocp(monkeypatch, registry)
        fake_builder = _install_fake_bopalgo(monkeypatch, object())

        n_vols, n_verts, n_tris = des._step_to_dagmc_imprinted_ocp(
            "model.step", str(tmp_path / "o.h5m"), 0.1
        )

        assert (n_vols, n_verts, n_tris) == (1, 3, 1)
        assert fake_builder.instances == []
        assert ("NAME_TAG_NAME", "mat:mat_0") in _tag_names(state["cores"][0])

    def test_read_failure_raises(self, des, monkeypatch, tmp_path):
        """A non-1 STEP read status raises a RuntimeError."""
        _install_fake_ocp(monkeypatch, {}, read_status=0)
        _install_fake_bopalgo(monkeypatch, object())
        with pytest.raises(RuntimeError, match="Failed to read STEP file, status=0"):
            des._step_to_dagmc_imprinted_ocp("model.step", str(tmp_path / "o.h5m"), 0.1)

    def test_faces_without_triangulation_are_skipped(self, des, monkeypatch, tmp_path):
        """Faces with no (or an empty) triangulation do not produce surfaces."""
        face_ok = _one_tri_face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], object())
        face_none = _FakeOccFace(None, object())
        face_empty = _FakeOccFace(_FakeTriangulation([], []), object())
        solid = object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid],
            (id(solid), "FACE"): [face_none, face_empty, face_ok],
        }
        state = _install_fake_ocp(monkeypatch, registry)
        _install_fake_bopalgo(monkeypatch, object())

        n_vols, n_verts, n_tris = des._step_to_dagmc_imprinted_ocp(
            "model.step", str(tmp_path / "o.h5m"), 0.1
        )

        assert (n_vols, n_verts, n_tris) == (1, 3, 1)
        assert len(state["cores"][0].elements) == 1

    def test_faceless_volume_gets_zero_bbox(self, des, monkeypatch, tmp_path):
        """A solid without faces still becomes a volume with a zero bbox."""
        face_a = _one_tri_face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], object())
        solid1, solid2 = object(), object()
        merged = object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid1, solid2],
            (id(merged), "SOLID"): [solid1, solid2],
            (id(solid1), "FACE"): [face_a],
            (id(solid2), "FACE"): [],
        }
        state = _install_fake_ocp(monkeypatch, registry)
        _install_fake_bopalgo(monkeypatch, merged)

        n_vols, n_verts, n_tris = des._step_to_dagmc_imprinted_ocp(
            "model.step", str(tmp_path / "o.h5m"), 0.1
        )

        assert (n_vols, n_verts, n_tris) == (2, 3, 1)
        tags = _tag_names(state["cores"][0])
        assert ("NAME_TAG_NAME", "mat:mat_0") in tags
        assert ("NAME_TAG_NAME", "mat:mat_1") in tags

    def test_material_mapped_by_bbox_center(self, des, monkeypatch, tmp_path):
        """Unmatched volume ids fall back to nearest old-bbox-center matching."""
        face_a = _one_tri_face([(0, 0, 0), (1, 0, 0), (0, 1, 0)], object())
        solid = object()
        registry = {(id("SHAPE"), "SOLID"): [solid], (id(solid), "FACE"): [face_a]}
        state = _install_fake_ocp(monkeypatch, registry)
        _install_fake_bopalgo(monkeypatch, object())
        # Old volume 7 sits exactly at the new volume's bbox center; old volume 8
        # has no bbox and is ignored.
        material_map = {7: "steel", 8: "lead"}
        old_bboxes = {7: ([0.5, 0.5, 0.0], [0.5, 0.5, 0.0])}

        des._step_to_dagmc_imprinted_ocp(
            "model.step",
            str(tmp_path / "o.h5m"),
            0.1,
            material_map=material_map,
            old_bboxes=old_bboxes,
        )

        assert ("NAME_TAG_NAME", "mat:steel") in _tag_names(state["cores"][0])


# ---------------------------------------------------------------------------
# refacet: bbox extraction + imprint dispatch
# ---------------------------------------------------------------------------


class TestRefacetImprint:
    def test_imprint_uses_imprinted_converter_with_bboxes(self, des, monkeypatch, tmp_path):
        """imprint=True routes to the imprinted converter with old bboxes."""
        _install_fake_pymoab(monkeypatch)
        vols = [
            FakeVolume(1, material="fuel", surfaces=[FakeSurface([[0.0, 0, 0], [1, 1, 1]])]),
            FakeVolume(2, material=None, surfaces=[FakeSurface(raises=True)]),
        ]
        _install_model(des, monkeypatch, FakeModel(volumes=vols))
        captured = {}

        def fake_imprinted(step_path, h5m_path, tolerance, material_map=None, old_bboxes=None):
            captured.update(
                step_path=step_path,
                tolerance=tolerance,
                material_map=material_map,
                old_bboxes=old_bboxes,
            )
            with open(h5m_path, "wb") as f:
                f.write(b"h5m")
            return (2, 9, 3)

        monkeypatch.setattr(des, "_step_to_dagmc_imprinted_ocp", fake_imprinted)
        monkeypatch.setattr(
            des,
            "_step_to_dagmc_ocp",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("wrong converter")),
        )
        existing = tmp_path / "model.h5m"
        existing.write_bytes(b"old")

        result = des.refacet(str(existing), "model.step", 0.05, imprint=True)

        assert result["success"] is True
        assert captured["step_path"] == "model.step"
        assert captured["tolerance"] == 0.05
        assert captured["material_map"] == {1: "fuel", 2: None}
        # Only volume 1 has a readable bbox; volume 2's failing surface is skipped.
        assert captured["old_bboxes"] == {1: ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])}


# ---------------------------------------------------------------------------
# main() graveyard/replace dispatch
# ---------------------------------------------------------------------------


class TestMainGraveyardDispatch:
    def _run(self, des, monkeypatch, argv):
        monkeypatch.setattr(sys, "argv", argv)
        return des.main()

    def test_detect_graveyard_dispatch(self, des, monkeypatch, capsys):
        """'detect_graveyard' forwards the file path and prints the result."""
        monkeypatch.setattr(des, "detect_graveyard", lambda p: {"success": True, "p": p})
        self._run(des, monkeypatch, ["x.py", "detect_graveyard", "m.h5m"])
        import json

        assert json.loads(capsys.readouterr().out) == {"success": True, "p": "m.h5m"}

    def test_detect_graveyard_missing_path_exits_1(self, des, monkeypatch, capsys):
        """'detect_graveyard' without a path exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "detect_graveyard"])
        assert exc.value.code == 1
        assert "No file path specified" in capsys.readouterr().out

    def test_tag_graveyard_dispatch(self, des, monkeypatch):
        """'tag_graveyard' parses an optional volume id (empty/missing -> None)."""
        captured = {}

        def fake(file_path, volume_id=None):
            captured.update(file=file_path, vid=volume_id)
            return {"success": True}

        monkeypatch.setattr(des, "tag_graveyard", fake)
        self._run(des, monkeypatch, ["x.py", "tag_graveyard", "m.h5m", "7"])
        assert captured == {"file": "m.h5m", "vid": 7}

        self._run(des, monkeypatch, ["x.py", "tag_graveyard", "m.h5m"])
        assert captured["vid"] is None

    def test_tag_graveyard_missing_path_exits_1(self, des, monkeypatch, capsys):
        """'tag_graveyard' without a path exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "tag_graveyard"])
        assert exc.value.code == 1
        assert "No file path specified" in capsys.readouterr().out

    def test_create_graveyard_dispatch(self, des, monkeypatch):
        """'create_graveyard' parses an optional padding (default 0.1)."""
        captured = {}

        def fake(file_path, padding=0.1):
            captured.update(file=file_path, padding=padding)
            return {"success": True}

        monkeypatch.setattr(des, "create_graveyard_box", fake)
        self._run(des, monkeypatch, ["x.py", "create_graveyard", "m.h5m", "0.25"])
        assert captured == {"file": "m.h5m", "padding": 0.25}

        self._run(des, monkeypatch, ["x.py", "create_graveyard", "m.h5m"])
        assert captured["padding"] == 0.1

    def test_create_graveyard_missing_path_exits_1(self, des, monkeypatch, capsys):
        """'create_graveyard' without a path exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "create_graveyard"])
        assert exc.value.code == 1
        assert "No file path specified" in capsys.readouterr().out

    def test_replace_material_dispatch(self, des, monkeypatch, capsys):
        """'replace_material' forwards old and new material names."""
        import json

        monkeypatch.setattr(
            des, "replace_material", lambda f, old, new: {"success": True, "old": old, "new": new}
        )
        self._run(des, monkeypatch, ["x.py", "replace_material", "m.h5m", "fuel", "uo2"])
        assert json.loads(capsys.readouterr().out) == {"success": True, "old": "fuel", "new": "uo2"}

    def test_replace_material_insufficient_args_exits_1(self, des, monkeypatch, capsys):
        """'replace_material' with too few args exits 1."""
        with pytest.raises(SystemExit) as exc:
            self._run(des, monkeypatch, ["x.py", "replace_material", "m.h5m", "fuel"])
        assert exc.value.code == 1
        assert "Insufficient arguments" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# __main__ guard
# ---------------------------------------------------------------------------


def test_main_guard_executes_main(monkeypatch, capsys):
    """Running the module as __main__ dispatches into main()."""
    stub = types.ModuleType("pydagmc")
    stub.Model = type("Model", (), {})
    monkeypatch.setitem(sys.modules, "pydagmc", stub)
    monkeypatch.delitem(sys.modules, "dagmc_editor_service", raising=False)
    monkeypatch.setattr(sys, "argv", ["dagmc_editor_service.py"])

    with pytest.raises(SystemExit) as exc:
        runpy.run_module("dagmc_editor_service", run_name="__main__")

    assert exc.value.code == 1
    import json

    assert json.loads(capsys.readouterr().out)["error"] == "No command specified"
