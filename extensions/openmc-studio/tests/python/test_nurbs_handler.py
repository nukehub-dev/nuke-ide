"""Tests for cad_conversion.nurbs_handler.

gmsh is faked for the detection/summary functions; OCP and pymoab are
replaced with recording fakes for the DAGMC conversion pipeline. No real
CAD kernel, mesh database, or .h5m output is involved.
"""

import importlib
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from cad_conversion import gmsh_utils, nurbs_handler

# ---------------------------------------------------------------------------
# is_nurbs_surface (pure)
# ---------------------------------------------------------------------------


class TestIsNurbsSurface:
    @pytest.mark.parametrize(
        "type_str",
        [
            "NURBS",
            "nurbs surface",
            "BSpline",
            "B-Spline Surface",
            "Bezier",
            "bsplinesurface",
            "bezierSurface",
            "nurbssurface",
            "SurfaceOfRevolution",
            "spline curve",
        ],
    )
    def test_freeform_keywords_detected(self, type_str):
        """Free-form type keywords are recognized case-insensitively."""
        assert nurbs_handler.is_nurbs_surface(type_str) is True

    @pytest.mark.parametrize("type_str", ["Plane", "Cylinder", "Sphere", "Cone", "Torus", ""])
    def test_analytic_types_rejected(self, type_str):
        """Analytic surface types are not free-form."""
        assert nurbs_handler.is_nurbs_surface(type_str) is False


# ---------------------------------------------------------------------------
# has_nurbs_surfaces / get_nurbs_summary (fake gmsh)
# ---------------------------------------------------------------------------


@pytest.fixture()
def fake_gmsh(monkeypatch):
    """Install a recording fake gmsh in nurbs_handler and flip HAS_GMSH on."""
    calls = []

    class FakeGmsh:
        model = SimpleNamespace()
        option = SimpleNamespace(setNumber=lambda *a: None)
        open_error = None

        def initialize(self):
            calls.append("initialize")

        def finalize(self):
            calls.append("finalize")

        def open(self, path):
            calls.append(("open", path))
            if self.open_error is not None:
                raise self.open_error

    gmsh = FakeGmsh()
    monkeypatch.setattr(nurbs_handler, "HAS_GMSH", True)
    # nurbs_handler only defines the gmsh name when the import succeeds.
    monkeypatch.setattr(nurbs_handler, "gmsh", gmsh, raising=False)
    gmsh.calls = calls
    return gmsh


class TestHasNurbsSurfaces:
    def test_false_without_gmsh(self, monkeypatch):
        """Without gmsh, detection conservatively returns False."""
        monkeypatch.setattr(nurbs_handler, "HAS_GMSH", False)
        assert nurbs_handler.has_nurbs_surfaces("model.step") is False

    def test_true_when_a_face_is_nurbs_like(self, fake_gmsh, monkeypatch):
        """Any NURBS-like face flags the whole file."""
        monkeypatch.setattr(gmsh_utils, "get_faces", lambda: [(2, 1), (2, 2)])
        monkeypatch.setattr(gmsh_utils, "is_nurbs_like_surface", lambda d, t: t == 2)

        assert nurbs_handler.has_nurbs_surfaces("model.step") is True
        assert fake_gmsh.calls == ["initialize", ("open", "model.step"), "finalize"]

    def test_false_when_all_analytic(self, fake_gmsh, monkeypatch):
        """All-analytic faces yield False."""
        monkeypatch.setattr(gmsh_utils, "get_faces", lambda: [(2, 1)])
        monkeypatch.setattr(gmsh_utils, "is_nurbs_like_surface", lambda d, t: False)

        assert nurbs_handler.has_nurbs_surfaces("model.step") is False

    def test_open_failure_is_false(self, fake_gmsh, monkeypatch):
        """A gmsh open failure degrades to False, still finalizing."""
        fake_gmsh.open_error = RuntimeError("bad file")

        assert nurbs_handler.has_nurbs_surfaces("model.step") is False
        assert fake_gmsh.calls == ["initialize", ("open", "model.step"), "finalize"]


class TestGetNurbsSummary:
    def test_default_without_gmsh(self, monkeypatch):
        """Without gmsh, the summary is the empty default."""
        monkeypatch.setattr(nurbs_handler, "HAS_GMSH", False)
        assert nurbs_handler.get_nurbs_summary("model.step") == {
            "hasNurbs": False,
            "totalFaces": 0,
            "nurbsFaces": [],
            "analyticFaces": [],
        }

    def test_summary_partitions_faces(self, fake_gmsh, monkeypatch):
        """Faces are split into NURBS-like and analytic buckets."""
        monkeypatch.setattr(gmsh_utils, "get_faces", lambda: [(2, 1), (2, 2), (2, 3)])
        monkeypatch.setattr(
            gmsh_utils,
            "classify_gmsh_surface_type",
            lambda d, t: {1: "plane", 2: "NURBS", 3: "SurfaceOfRevolution"}[t],
        )
        monkeypatch.setattr(gmsh_utils, "is_nurbs_like_surface", lambda d, t: t in (2, 3))
        monkeypatch.setattr(gmsh_utils, "has_freeform_boundary_curves", lambda d, t: t == 3)

        result = nurbs_handler.get_nurbs_summary("model.step")

        assert result["hasNurbs"] is True
        assert result["totalFaces"] == 3
        assert result["analyticFaces"] == [{"tag": 1, "type": "plane"}]
        assert result["nurbsFaces"] == [
            {"tag": 2, "type": "NURBS", "reason": "Free-form surface"},
            {
                "tag": 3,
                "type": "SurfaceOfRevolution",
                "reason": "SurfaceOfRevolution with free-form generating curve",
            },
        ]

    def test_open_failure_sets_error(self, fake_gmsh, monkeypatch):
        """A gmsh open failure records the error in the summary."""
        fake_gmsh.open_error = RuntimeError("bad file")

        result = nurbs_handler.get_nurbs_summary("model.step")

        assert result["error"] == "bad file"
        assert fake_gmsh.calls[-1] == "finalize"


# ---------------------------------------------------------------------------
# convert_to_dagmc
# ---------------------------------------------------------------------------


class TestConvertToDagmc:
    def test_missing_ocp_dependency(self, monkeypatch):
        """Without OCP/pymoab, the dependency error is reported."""
        # None in sys.modules halts the exact probe imports regardless of
        # whether OCP/pymoab are installed or already imported elsewhere.
        for name in ("OCP", "OCP.BRepMesh", "OCP.STEPControl", "pymoab", "pymoab.core"):
            monkeypatch.setitem(sys.modules, name, None)
        result = nurbs_handler.convert_to_dagmc("model.step")
        assert result["success"] is False
        assert result["error"].startswith("Required dependency missing or incompatible:")
        assert result["output_path"] is None
        assert result["warnings"] == []

    def _install_ocp_probes(self, monkeypatch):
        """Insert bare OCP/pymoab probe modules so the import gate passes."""
        brepmesh = types.ModuleType("OCP.BRepMesh")
        brepmesh.BRepMesh_IncrementalMesh = object
        stepcontrol = types.ModuleType("OCP.STEPControl")
        stepcontrol.STEPControl_Reader = object
        ocp = types.ModuleType("OCP")
        pymoab = types.ModuleType("pymoab")
        pymoab.core = types.ModuleType("pymoab.core")
        for name, module in {
            "OCP": ocp,
            "OCP.BRepMesh": brepmesh,
            "OCP.STEPControl": stepcontrol,
            "pymoab": pymoab,
            "pymoab.core": pymoab.core,
        }.items():
            monkeypatch.setitem(sys.modules, name, module)

    def test_success_with_default_output_path(self, monkeypatch):
        """A successful native conversion reports the tempfile output path."""
        self._install_ocp_probes(monkeypatch)
        seen = {}

        def fake_native(file_path, h5m_path, tol, scale, warnings, auto_adjust, add_graveyard):
            seen.update(
                file=file_path,
                h5m=h5m_path,
                tol=tol,
                scale=scale,
                auto=auto_adjust,
                add_graveyard=add_graveyard,
            )
            warnings.append("done")
            return True

        monkeypatch.setattr(nurbs_handler, "_native_dagmc_conversion", fake_native)

        result = nurbs_handler.convert_to_dagmc(
            "model.step", faceting_tolerance=0.05, length_scale=2.0, auto_adjust_tolerance=False
        )

        assert result["success"] is True
        assert result["output_path"].endswith(".h5m")
        assert result["error"] is None
        assert result["warnings"] == ["done"]
        assert seen["tol"] == 0.05
        assert seen["scale"] == 2.0
        assert seen["auto"] is False
        assert seen["add_graveyard"] is True

    def test_add_graveyard_can_be_disabled(self, monkeypatch):
        """convert_to_dagmc passes add_graveyard=False when requested."""
        self._install_ocp_probes(monkeypatch)
        seen = {}

        def fake_native(file_path, h5m_path, tol, scale, warnings, auto_adjust, add_graveyard):
            seen["add_graveyard"] = add_graveyard
            return True

        monkeypatch.setattr(nurbs_handler, "_native_dagmc_conversion", fake_native)

        result = nurbs_handler.convert_to_dagmc("model.step", add_graveyard=False)

        assert result["success"] is True
        assert seen["add_graveyard"] is False

    def test_failure_reports_actual_reason(self, monkeypatch, tmp_path):
        """A failed native conversion surfaces the underlying warning, not a generic hint."""
        self._install_ocp_probes(monkeypatch)

        def fake_native(file_path, h5m_path, tol, scale, warnings, auto_adjust, add_graveyard):
            warnings.append("Failed to read CAD file, status=0")
            return False

        monkeypatch.setattr(nurbs_handler, "_native_dagmc_conversion", fake_native)
        out = str(tmp_path / "out.h5m")

        result = nurbs_handler.convert_to_dagmc("model.step", output_path=out)

        assert result["success"] is False
        assert result["output_path"] == out
        assert "Failed to read CAD file, status=0" == result["error"]
        assert result["warnings"] == []

    def test_failure_without_warnings_reports_generic_hint(self, monkeypatch, tmp_path):
        """A failed native conversion with no warnings falls back to the generic hint."""
        self._install_ocp_probes(monkeypatch)
        monkeypatch.setattr(nurbs_handler, "_native_dagmc_conversion", lambda *args: False)
        out = str(tmp_path / "out.h5m")

        result = nurbs_handler.convert_to_dagmc("model.step", output_path=out)

        assert result["success"] is False
        assert result["output_path"] == out
        assert result["error"].startswith("Failed to convert CAD to DAGMC .h5m.")
        assert result["warnings"] == []


# ---------------------------------------------------------------------------
# _native_dagmc_conversion (fake OCP + pymoab pipeline)
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


class _FakeOccTriangle:
    def __init__(self, a, b, c):
        self._v = (a, b, c)

    def Value(self, i):
        return self._v[i - 1]


class _FakeTriangulation:
    def __init__(self, n_nodes=3, n_tris=1):
        self._n_nodes = n_nodes
        self._n_tris = n_tris

    def NbNodes(self):
        return self._n_nodes

    def NbTriangles(self):
        return self._n_tris

    def Node(self, i):
        return _FakePnt(float(i), float(i * 2), float(i * 3))

    def Triangle(self, i):
        return _FakeOccTriangle(1, 2, 3)


class _FakeOccFace:
    def __init__(self, tri, tshape=None):
        self._tri = tri
        self._tshape = tshape if tshape is not None else object()

    def Location(self):
        return SimpleNamespace(Transformation=lambda: "TRSF")

    def TShape(self):
        return self._tshape


class _FakeMoabCore:
    """Recording fake for pymoab.core.Core."""

    instances = []

    def __init__(self):
        self.meshsets = 0
        self.tag_calls = []
        self.elements = []
        self.parent_child = []
        self.written = []
        self.vertices = None
        _FakeMoabCore.instances.append(self)

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
        pass

    def add_parent_child(self, parent, child):
        self.parent_child.append((parent, child))

    def get_root_set(self):
        return 0

    def write_file(self, path):
        self.written.append(path)


def _install_native_fakes(monkeypatch, registry, read_status=1, bbox=(0, 0, 0, 1, 1, 1)):
    """Insert the fake OCP/pymoab stack for _native_dagmc_conversion."""
    mesh_calls = []

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

    class FakeStepReader:
        def ReadFile(self, path):
            return read_status

        def TransferRoot(self):
            return None

        def OneShape(self):
            return "SHAPE"

    class FakeIgesReader(FakeStepReader):
        pass

    class FakeBndBox:
        def Get(self):
            return bbox

    def incremental_mesh(*args):
        mesh_calls.append(args)

    modules = {}
    ocp = types.ModuleType("OCP")
    modules["OCP"] = ocp

    brep = types.ModuleType("OCP.BRep")
    brep.BRep_Tool = SimpleNamespace(Triangulation_s=staticmethod(lambda face, loc: face._tri))
    modules["OCP.BRep"] = brep

    brepmesh = types.ModuleType("OCP.BRepMesh")
    brepmesh.BRepMesh_IncrementalMesh = incremental_mesh
    modules["OCP.BRepMesh"] = brepmesh

    iges = types.ModuleType("OCP.IGESControl")
    iges.IGESControl_Reader = FakeIgesReader
    modules["OCP.IGESControl"] = iges

    step = types.ModuleType("OCP.STEPControl")
    step.STEPControl_Reader = FakeStepReader
    modules["OCP.STEPControl"] = step

    topabs = types.ModuleType("OCP.TopAbs")
    topabs.TopAbs_FACE = "FACE"
    topabs.TopAbs_SOLID = "SOLID"
    modules["OCP.TopAbs"] = topabs

    topexp = types.ModuleType("OCP.TopExp")
    topexp.TopExp_Explorer = FakeExplorer
    modules["OCP.TopExp"] = topexp

    topods = types.ModuleType("OCP.TopoDS")
    topods.TopoDS = SimpleNamespace(
        Solid_s=staticmethod(lambda s: s), Face_s=staticmethod(lambda f: f)
    )
    modules["OCP.TopoDS"] = topods

    bnd = types.ModuleType("OCP.Bnd")
    bnd.Bnd_Box = FakeBndBox
    modules["OCP.Bnd"] = bnd

    bndlib = types.ModuleType("OCP.BRepBndLib")
    bndlib.BRepBndLib = SimpleNamespace(Add_s=staticmethod(lambda shape, box: None))
    modules["OCP.BRepBndLib"] = bndlib

    pymoab = types.ModuleType("pymoab")
    pymoab_core = types.ModuleType("pymoab.core")
    pymoab_core.Core = _FakeMoabCore
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
    modules["pymoab"] = pymoab
    modules["pymoab.core"] = pymoab_core
    modules["pymoab.types"] = pymoab_types

    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)

    _FakeMoabCore.instances = []
    return mesh_calls


def _two_volume_registry(shared_tshape=None):
    """Two solids sharing one face (same TShape) with one unique face each."""
    shared_tshape = shared_tshape or object()
    face_a = _FakeOccFace(_FakeTriangulation())
    face_b = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
    face_b2 = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
    face_c = _FakeOccFace(_FakeTriangulation())
    solid1, solid2 = object(), object()
    registry = {
        (id("SHAPE"), "SOLID"): [solid1, solid2],
        (id(solid1), "FACE"): [face_a, face_b],
        (id(solid2), "FACE"): [face_b2, face_c],
    }
    return registry


class TestNativeDagmcConversion:
    def test_success_builds_tagged_moab(self, monkeypatch, tmp_path):
        """Two solids produce volumes, shared-face senses, and an H5M write."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []
        out = str(tmp_path / "out.h5m")

        ok = nurbs_handler._native_dagmc_conversion("model.step", out, 0.01, 1.0, warnings)

        assert ok is True
        mb = _FakeMoabCore.instances[0]
        assert mb.written == [out]
        # 3 surfaces + 2 volumes + 2 groups.
        assert mb.meshsets == 7
        # Each of the 3 unique faces has 1 triangle; the shared face is meshed once.
        assert len(mb.elements) == 3
        # 3 nodes per face * 3 faces = 9 vertices (no cross-face dedup here).
        assert len(mb.vertices) == 9

        tags = {(t[1], d) for t, h, d in mb.tag_calls if not hasattr(d, "tolist")}
        assert ("CATEGORY_TAG_NAME", "Volume") in tags
        assert ("CATEGORY_TAG_NAME", "Surface") in tags
        assert ("CATEGORY_TAG_NAME", "Group") in tags
        assert ("NAME_TAG_NAME", "mat:mat_0") in tags
        assert ("NAME_TAG_NAME", "mat:mat_1") in tags
        assert ("FACETING_TOL", 0.01) in tags

        senses = sorted(d.tolist() for t, h, d in mb.tag_calls if t[1] == "GEOM_SENSE_2")
        assert senses[0][1] == 0
        assert senses[1][1] != 0  # the shared face references both volumes
        assert senses[2][1] == 0

        assert any("2 volumes" in w and "9 vertices" in w for w in warnings)

    def test_length_scale_scales_vertices(self, monkeypatch, tmp_path):
        """A non-1 length scale multiplies every vertex coordinate."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 2.0, warnings
        )

        assert ok is True
        verts = _FakeMoabCore.instances[0].vertices
        # Node 1 of each face is (1, 2, 3) before scaling.
        assert verts[0].tolist() == [2.0, 4.0, 6.0]

    def test_large_model_auto_adjusts_tolerance(self, monkeypatch, tmp_path):
        """A model diagonal > 100 bumps the faceting tolerance with a warning."""
        mesh_calls = _install_native_fakes(
            monkeypatch,
            _two_volume_registry(),
            bbox=(0, 0, 0, 100.0, 100.0, 100.0),
        )
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is True
        # diag ~173.2 -> tol = max(0.01, min(173.2/200, 10)) ~ 0.866.
        assert mesh_calls[0][1] == pytest.approx(0.866, abs=1e-3)
        assert any("auto-adjusted" in w for w in warnings)
        # The adjusted tolerance lands on the root set.
        mb = _FakeMoabCore.instances[0]
        ftol = [d for t, h, d in mb.tag_calls if t[1] == "FACETING_TOL"]
        assert ftol == [pytest.approx(0.866, abs=1e-3)]

    def test_no_auto_adjust_when_disabled(self, monkeypatch, tmp_path):
        """auto_adjust=False keeps the requested tolerance on a large model."""
        mesh_calls = _install_native_fakes(
            monkeypatch,
            _two_volume_registry(),
            bbox=(0, 0, 0, 100.0, 100.0, 100.0),
        )
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step",
            str(tmp_path / "out.h5m"),
            0.01,
            1.0,
            warnings,
            auto_adjust_tolerance=False,
        )

        assert ok is True
        assert mesh_calls[0][1] == 0.01

    def test_iges_extension_uses_iges_reader(self, monkeypatch, tmp_path):
        """The .iges extension selects the IGES reader."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.iges", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is True

    def test_unsupported_extension_warns_and_uses_step(self, monkeypatch, tmp_path):
        """An unknown extension warns but still attempts the STEP reader."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.brep", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is True
        assert any("Unsupported CAD format: .brep" in w for w in warnings)

    def test_read_failure_returns_false(self, monkeypatch, tmp_path):
        """A non-1 read status fails with a warning."""
        _install_native_fakes(monkeypatch, {}, read_status=0)
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is False
        assert any("Failed to read CAD file, status=0" in w for w in warnings)

    def test_faces_without_triangulation_are_skipped(self, monkeypatch, tmp_path):
        """Faces with no/empty triangulation contribute nothing."""
        solid = object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid],
            (id(solid), "FACE"): [
                _FakeOccFace(None),
                _FakeOccFace(_FakeTriangulation(n_tris=0)),
                _FakeOccFace(_FakeTriangulation()),
            ],
        }
        _install_native_fakes(monkeypatch, registry)
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is True
        mb = _FakeMoabCore.instances[0]
        # Only the third face produced mesh content (1 surface + 1 vol + 1 group).
        assert mb.meshsets == 3
        assert len(mb.elements) == 1

    def test_pipeline_exception_returns_false(self, monkeypatch, tmp_path):
        """An unexpected pipeline error fails with a traceback warning."""
        _install_native_fakes(monkeypatch, _two_volume_registry())

        def bad_vertices(self, arr):
            raise RuntimeError("vertex buffer exploded")

        monkeypatch.setattr(_FakeMoabCore, "create_vertices", bad_vertices)
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is False
        assert any("DAGMC conversion failed: vertex buffer exploded" in w for w in warnings)

    def test_import_failure_returns_false(self, monkeypatch):
        """Without OCP the conversion fails with a dependency warning."""
        # None halts even the dotted probe imports when OCP is installed.
        for name in ("OCP", "OCP.BRep", "OCP.BRepMesh", "pymoab", "pymoab.core"):
            monkeypatch.setitem(sys.modules, name, None)
        warnings = []

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", "/tmp/out.h5m", 0.01, 1.0, warnings
        )

        assert ok is False
        assert any(
            "Missing or incompatible dependency for fast DAGMC conversion" in w for w in warnings
        )


# ---------------------------------------------------------------------------
# Graveyard handling
# ---------------------------------------------------------------------------


class TestGraveyardHandling:
    def test_graveyard_logic_skipped_by_default(self, monkeypatch, tmp_path):
        """Without add_graveyard=True the helper is never invoked."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        def fake_maybe(*args, **kwargs):
            raise AssertionError("_maybe_add_graveyard should not be called")

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings
        )

        assert ok is True

    def test_existing_graveyard_detected_warning(self, monkeypatch, tmp_path):
        """If a graveyard is detected, a skip warning is appended."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        def fake_maybe(shape, file_path, ext, warns):
            warns.append("Existing graveyard volume detected; skipping auto-creation.")
            return shape, set()

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings, add_graveyard=True
        )

        assert ok is True
        assert any("Existing graveyard volume detected" in w for w in warnings)

    def test_existing_graveyard_tagged_mat_graveyard(self, monkeypatch, tmp_path):
        """An existing graveyard solid is re-tagged mat:graveyard in the output."""
        shared_tshape = object()
        face_a = _FakeOccFace(_FakeTriangulation())
        face_b = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
        face_b2 = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
        face_c = _FakeOccFace(_FakeTriangulation())
        solid1, solid2 = object(), object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid1, solid2],
            (id(solid1), "FACE"): [face_a, face_b],
            (id(solid2), "FACE"): [face_b2, face_c],
        }
        _install_native_fakes(monkeypatch, registry)
        warnings = []

        def fake_maybe(shape, file_path, ext, warns):
            warns.append("Existing graveyard volume detected; skipping auto-creation.")
            # Mark the second solid (vol_id 2) as the existing graveyard.
            return shape, {2}

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings, add_graveyard=True
        )

        assert ok is True
        mb = _FakeMoabCore.instances[0]
        name_tags = {data for tag, handle, data in mb.tag_calls if tag[1] == "NAME_TAG_NAME"}
        assert "mat:graveyard" in name_tags
        assert "mat:mat_0" in name_tags
        assert "mat:mat_1" not in name_tags

    def test_auto_graveyard_adds_warning(self, monkeypatch, tmp_path):
        """If no graveyard exists, a graveyard is auto-added and a warning emitted."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        def fake_maybe(shape, file_path, ext, warns):
            warns.append("Auto-created graveyard volume around model (mat:graveyard).")
            return shape, set()

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings, add_graveyard=True
        )

        assert ok is True
        assert any("Auto-created graveyard" in w for w in warnings)

    def test_graveyard_failure_warns_and_continues(self, monkeypatch, tmp_path):
        """A failed graveyard construction warns but conversion continues."""
        _install_native_fakes(monkeypatch, _two_volume_registry())
        warnings = []

        def fake_maybe(shape, file_path, ext, warns):
            warns.append(
                "Could not auto-create graveyard: boolean cut failed. "
                "Add one in your CAD workflow if needed."
            )
            return shape, set()

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings, add_graveyard=True
        )

        assert ok is True
        assert any("Could not auto-create graveyard" in w for w in warnings)

    def test_auto_graveyard_volume_tagged_mat_graveyard(self, monkeypatch, tmp_path):
        """An auto-added graveyard volume is written with the mat:graveyard group."""
        shared_tshape = object()
        face_a = _FakeOccFace(_FakeTriangulation())
        face_b = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
        face_b2 = _FakeOccFace(_FakeTriangulation(), tshape=shared_tshape)
        face_c = _FakeOccFace(_FakeTriangulation())
        solid1, solid2, gy_solid = object(), object(), object()
        registry = {
            (id("SHAPE"), "SOLID"): [solid1, solid2],
            (id("GY_SHAPE"), "SOLID"): [solid1, solid2, gy_solid],
            (id(solid1), "FACE"): [face_a, face_b],
            (id(solid2), "FACE"): [face_b2, face_c],
            (id(gy_solid), "FACE"): [_FakeOccFace(_FakeTriangulation())],
        }
        _install_native_fakes(monkeypatch, registry)
        warnings = []

        def fake_maybe(shape, file_path, ext, warns):
            warns.append("Auto-created graveyard volume around model (mat:graveyard).")
            # The third volume (vol_id 3) is the auto-added graveyard.
            return "GY_SHAPE", {3}

        monkeypatch.setattr(nurbs_handler, "_maybe_add_graveyard", fake_maybe)

        ok = nurbs_handler._native_dagmc_conversion(
            "model.step", str(tmp_path / "out.h5m"), 0.01, 1.0, warnings, add_graveyard=True
        )

        assert ok is True
        mb = _FakeMoabCore.instances[0]
        name_tags = {data for tag, handle, data in mb.tag_calls if tag[1] == "NAME_TAG_NAME"}
        assert "mat:graveyard" in name_tags
        assert "mat:mat_0" in name_tags
        assert "mat:mat_1" in name_tags


# ---------------------------------------------------------------------------
# Import fallbacks (module reload with blocked imports)
# ---------------------------------------------------------------------------


@pytest.fixture()
def _restore_module():
    """Reload nurbs_handler after a test reloaded it with blocked imports."""
    yield
    importlib.reload(nurbs_handler)


class TestImportFallbacks:
    def test_gmsh_absence_disables_detection(self, _restore_module, monkeypatch):
        """When gmsh cannot be imported, HAS_GMSH flips off and detection returns False."""
        monkeypatch.setitem(sys.modules, "gmsh", None)

        importlib.reload(nurbs_handler)

        assert nurbs_handler.HAS_GMSH is False
        assert nurbs_handler.has_nurbs_surfaces("model.step") is False

    def test_numpy_absence_is_flagged(self, _restore_module, monkeypatch):
        """When numpy cannot be imported, HAS_NUMPY flips off."""
        monkeypatch.setitem(sys.modules, "numpy", None)

        importlib.reload(nurbs_handler)

        assert nurbs_handler.HAS_NUMPY is False


# ---------------------------------------------------------------------------
# _bbox_contains (pure)
# ---------------------------------------------------------------------------


class TestBboxContains:
    def test_inner_fully_inside(self):
        outer = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
        inner = (1.0, 2.0, 3.0, 9.0, 8.0, 7.0)
        assert nurbs_handler._bbox_contains(outer, inner) is True

    def test_equal_bounds_contain(self):
        box = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
        assert nurbs_handler._bbox_contains(box, box) is True

    def test_protruding_inner_rejected(self):
        outer = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
        assert nurbs_handler._bbox_contains(outer, (-1.0, 0.0, 0.0, 10.0, 10.0, 10.0)) is False
        assert nurbs_handler._bbox_contains(outer, (0.0, 0.0, 0.0, 10.0, 10.0, 11.0)) is False

    def test_padding_tolerates_small_protrusion(self):
        outer = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
        # Protrusion of 5e-5 is below the default 1e-4 padding.
        assert nurbs_handler._bbox_contains(outer, (0.0, 0.0, 0.0, 10.00005, 10.0, 10.0)) is True
        # Protrusion of 1e-3 exceeds it.
        assert nurbs_handler._bbox_contains(outer, (0.0, 0.0, 0.0, 10.001, 10.0, 10.0)) is False


# ---------------------------------------------------------------------------
# Graveyard helpers (fake OCP geometry + CAF stack)
# ---------------------------------------------------------------------------


class _FakeOccShape:
    """Stand-in for a TopoDS shape; identity-keyed in the fake registries."""

    _counter = 0

    def __init__(self):
        _FakeOccShape._counter += 1
        self.label = f"shape-{_FakeOccShape._counter}"

    def __repr__(self):
        return f"<_FakeOccShape {self.label}>"


class _FakeCafLabel:
    """TDF label carrying an optional name plus component/subshape children."""

    def __init__(self, name=None, components=(), subshapes=()):
        self.name = name
        self.components = list(components)
        self.subshapes = list(subshapes)

    def FindAttribute(self, attr_id, attr):
        if self.name is None:
            return False
        attr._value = self.name
        return True


class _FakeNameString:
    def __init__(self, value):
        self._value = value

    def PrintToString(self):
        if isinstance(self._value, Exception):
            raise self._value
        return self._value


class _FakeTDataStdName:
    def __init__(self):
        self._value = None

    @staticmethod
    def GetID():
        return "NAME_ID"

    def Get(self):
        return _FakeNameString(self._value)


class _FakeLabelSequence:
    def __init__(self):
        self._items = []

    def Length(self):
        return len(self._items)

    def Value(self, i):
        return self._items[i - 1]


class _FakeGProps:
    def __init__(self):
        self._mass = 0.0

    def Mass(self):
        return self._mass


class _FakeGraveyardBndBox:
    def __init__(self):
        self._bounds = (0.0,) * 6

    def Get(self):
        return self._bounds


def _install_graveyard_fakes(monkeypatch):
    """Insert the fake OCP stack used by the graveyard helper functions.

    Returns a SimpleNamespace of mutable registries the fakes read at call
    time: ``solids`` maps id(shape) -> [solid, ...], ``volumes`` maps
    id(shape) -> float (a missing key makes _shape_volume raise), ``bboxes``
    maps id(shape) -> 6-tuple (falling back to ``default_bbox``),
    ``free_shapes`` holds the CAF root labels, ``read_status`` drives the CAF
    readers, and ``cut_is_done``/``cut_shape``/``box_error`` drive the boolean
    pipeline. ``box_points`` and ``compounds`` record construction details.
    """
    state = SimpleNamespace(
        solids={},
        volumes={},
        bboxes={},
        default_bbox=(0.0, 0.0, 0.0, 1.0, 1.0, 1.0),
        free_shapes=[],
        read_status=1,
        cut_is_done=True,
        cut_shape=None,
        box_error=None,
        box_points=[],
        compounds=[],
    )

    class FakeSolidExplorer:
        def __init__(self, shape, what):
            self._items = list(state.solids.get(id(shape), []))
            self._i = 0

        def More(self):
            return self._i < len(self._items)

        def Current(self):
            return self._items[self._i]

        def Next(self):
            self._i += 1

    class FakeShapeTool:
        def GetFreeShapes(self, seq):
            seq._items.extend(state.free_shapes)

        def GetComponents(self, label, seq):
            seq._items.extend(label.components)

        def GetSubShapes(self, label, seq):
            seq._items.extend(label.subshapes)

    class FakeDoc:
        def __init__(self, fmt):
            self.fmt = fmt

        def Main(self):
            return "MAIN"

    class FakeCafReader:
        def __init__(self):
            self.name_mode = None

        def SetNameMode(self, mode):
            self.name_mode = mode

        def ReadFile(self, path):
            return state.read_status

        def Transfer(self, doc):
            pass

    class FakeMakeCompound:
        def __init__(self):
            self.added = []
            state.compounds.append(self)

        def Add(self, solid):
            self.added.append(solid)

        def Shape(self):
            shape = _FakeOccShape()
            state.bboxes.setdefault(id(shape), state.default_bbox)
            return shape

    class FakeGpPnt:
        def __init__(self, x, y, z):
            self.coords = (x, y, z)

    class FakeMakeBox:
        def __init__(self, p1, p2):
            state.box_points.append((p1.coords, p2.coords))

        def Shape(self):
            return _FakeOccShape()

    class FakeCut:
        def __init__(self, box, model):
            pass

        def IsDone(self):
            return state.cut_is_done

        def Shape(self):
            return state.cut_shape

    def make_compound():
        return FakeMakeCompound()

    def make_box(p1, p2):
        if state.box_error is not None:
            raise state.box_error
        return FakeMakeBox(p1, p2)

    def set_volume(shape, props):
        props._mass = state.volumes[id(shape)]

    def set_bounds(shape, box):
        box._bounds = state.bboxes.get(id(shape), state.default_bbox)

    modules = {}
    modules["OCP"] = types.ModuleType("OCP")

    topabs = types.ModuleType("OCP.TopAbs")
    topabs.TopAbs_SOLID = "SOLID"
    modules["OCP.TopAbs"] = topabs

    topexp = types.ModuleType("OCP.TopExp")
    topexp.TopExp_Explorer = FakeSolidExplorer
    modules["OCP.TopExp"] = topexp

    topods = types.ModuleType("OCP.TopoDS")
    topods.TopoDS = SimpleNamespace(Solid_s=staticmethod(lambda s: s))
    modules["OCP.TopoDS"] = topods

    bnd = types.ModuleType("OCP.Bnd")
    bnd.Bnd_Box = _FakeGraveyardBndBox
    modules["OCP.Bnd"] = bnd

    bndlib = types.ModuleType("OCP.BRepBndLib")
    bndlib.BRepBndLib = SimpleNamespace(Add_s=staticmethod(set_bounds))
    modules["OCP.BRepBndLib"] = bndlib

    brepgprop = types.ModuleType("OCP.BRepGProp")
    brepgprop.BRepGProp = SimpleNamespace(VolumeProperties_s=staticmethod(set_volume))
    modules["OCP.BRepGProp"] = brepgprop

    gprop = types.ModuleType("OCP.GProp")
    gprop.GProp_GProps = _FakeGProps
    modules["OCP.GProp"] = gprop

    builderapi = types.ModuleType("OCP.BRepBuilderAPI")
    builderapi.BRepBuilderAPI_MakeCompound = make_compound
    modules["OCP.BRepBuilderAPI"] = builderapi

    primapi = types.ModuleType("OCP.BRepPrimAPI")
    primapi.BRepPrimAPI_MakeBox = make_box
    modules["OCP.BRepPrimAPI"] = primapi

    algoapi = types.ModuleType("OCP.BRepAlgoAPI")
    algoapi.BRepAlgoAPI_Cut = FakeCut
    modules["OCP.BRepAlgoAPI"] = algoapi

    gp = types.ModuleType("OCP.gp")
    gp.gp_Pnt = FakeGpPnt
    modules["OCP.gp"] = gp

    tdatastd = types.ModuleType("OCP.TDataStd")
    tdatastd.TDataStd_Name = _FakeTDataStdName
    modules["OCP.TDataStd"] = tdatastd

    tdf = types.ModuleType("OCP.TDF")
    tdf.TDF_LabelSequence = _FakeLabelSequence
    modules["OCP.TDF"] = tdf

    tdocstd = types.ModuleType("OCP.TDocStd")
    tdocstd.TDocStd_Document = FakeDoc
    modules["OCP.TDocStd"] = tdocstd

    xcafdoc = types.ModuleType("OCP.XCAFDoc")
    xcafdoc.XCAFDoc_DocumentTool = SimpleNamespace(
        ShapeTool=staticmethod(lambda main: FakeShapeTool())
    )
    modules["OCP.XCAFDoc"] = xcafdoc

    stepcaf = types.ModuleType("OCP.STEPCAFControl")
    stepcaf.STEPCAFControl_Reader = FakeCafReader
    modules["OCP.STEPCAFControl"] = stepcaf

    igescaf = types.ModuleType("OCP.IGESCAFControl")
    igescaf.IGESCAFControl_Reader = FakeCafReader
    modules["OCP.IGESCAFControl"] = igescaf

    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)

    return state


class TestShapeHelpers:
    def test_solids_from_shape(self, monkeypatch):
        """The explorer walks every solid nested in a shape."""
        state = _install_graveyard_fakes(monkeypatch)
        shape = _FakeOccShape()
        s1, s2 = _FakeOccShape(), _FakeOccShape()
        state.solids[id(shape)] = [s1, s2]

        assert nurbs_handler._solids_from_shape(shape) == [s1, s2]

    def test_shape_volume(self, monkeypatch):
        """The GProp mass is returned as the shape volume."""
        state = _install_graveyard_fakes(monkeypatch)
        solid = _FakeOccShape()
        state.volumes[id(solid)] = 42.5

        assert nurbs_handler._shape_volume(solid) == 42.5

    def test_bounding_box_helpers(self, monkeypatch):
        """Both bounding-box helpers return the Bnd_Box bounds."""
        state = _install_graveyard_fakes(monkeypatch)
        shape = _FakeOccShape()
        state.bboxes[id(shape)] = (1.0, 2.0, 3.0, 4.0, 5.0, 6.0)

        assert nurbs_handler._solid_bounding_box(shape) == (1.0, 2.0, 3.0, 4.0, 5.0, 6.0)
        assert nurbs_handler._shape_bounding_box(shape) == (1.0, 2.0, 3.0, 4.0, 5.0, 6.0)


class TestCollectCadNames:
    def test_step_names_collected_recursively(self, monkeypatch):
        """Names are gathered from free shapes, components, and subshapes."""
        state = _install_graveyard_fakes(monkeypatch)
        state.free_shapes = [
            _FakeCafLabel(
                "Assembly",
                components=[_FakeCafLabel("Part A"), _FakeCafLabel(None)],
                subshapes=[_FakeCafLabel("Solid 1")],
            ),
            _FakeCafLabel("Graveyard"),
        ]

        names = nurbs_handler._collect_cad_names("model.step", ".step")

        assert names == {"Assembly", "Part A", "Solid 1", "Graveyard"}

    def test_iges_names_collected(self, monkeypatch):
        """The IGES CAF reader is used for .iges files."""
        state = _install_graveyard_fakes(monkeypatch)
        state.free_shapes = [_FakeCafLabel("Iges Part")]

        assert nurbs_handler._collect_cad_names("model.iges", ".iges") == {"Iges Part"}

    def test_unsupported_extension_returns_empty(self, monkeypatch):
        """Non-STEP/IGES extensions skip name collection entirely."""
        _install_graveyard_fakes(monkeypatch)

        assert nurbs_handler._collect_cad_names("model.brep", ".brep") == set()

    def test_read_failure_returns_empty(self, monkeypatch):
        """A non-1 CAF read status yields no names."""
        state = _install_graveyard_fakes(monkeypatch)
        state.read_status = 0
        state.free_shapes = [_FakeCafLabel("Part")]

        assert nurbs_handler._collect_cad_names("model.step", ".step") == set()

    def test_empty_and_failing_names_skipped(self, monkeypatch):
        """Empty names and name-extraction errors are skipped per label."""
        state = _install_graveyard_fakes(monkeypatch)
        state.free_shapes = [
            _FakeCafLabel(""),
            _FakeCafLabel(RuntimeError("name exploded")),
            _FakeCafLabel("Good"),
        ]

        assert nurbs_handler._collect_cad_names("model.step", ".step") == {"Good"}

    def test_caf_stack_failure_returns_empty(self, monkeypatch):
        """A broken CAF import degrades to an empty name set."""
        _install_graveyard_fakes(monkeypatch)
        monkeypatch.setitem(sys.modules, "OCP.TDocStd", None)

        assert nurbs_handler._collect_cad_names("model.step", ".step") == set()


class TestDetectExistingGraveyard:
    def _register_model(self, state, gy, models, gy_volume=1e6, model_volume=1.0):
        """Register a shape whose first solid is a huge box around the models."""
        shape = _FakeOccShape()
        state.solids[id(shape)] = [gy, *models]
        state.volumes[id(gy)] = gy_volume
        state.bboxes[id(gy)] = (0.0, 0.0, 0.0, 100.0, 100.0, 100.0)
        for m in models:
            state.volumes[id(m)] = model_volume
            state.bboxes[id(m)] = (10.0, 10.0, 10.0, 20.0, 20.0, 20.0)
        return shape

    def test_name_detection_identifies_enclosing_solid(self, monkeypatch):
        """A 'graveyard' product name plus an enclosing solid is detected."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1, m2 = _FakeOccShape(), _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1, m2])
        monkeypatch.setattr(
            nurbs_handler, "_collect_cad_names", lambda fp, ext: {"Assembly", "Graveyard Box"}
        )

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is True
        assert model_solids == [m1, m2]
        assert gy_index == 0

    def test_name_detection_without_identifiable_solid(self, monkeypatch):
        """A graveyard name with a single solid reports detection without an index."""
        state = _install_graveyard_fakes(monkeypatch)
        only = _FakeOccShape()
        shape = _FakeOccShape()
        state.solids[id(shape)] = [only]
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: {"graveyard"})

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is True
        assert model_solids == [only]
        assert gy_index is None

    def test_name_collection_error_falls_back_to_heuristic(self, monkeypatch):
        """A failing name lookup is ignored; the heuristic still applies."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1 = _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1])

        def raising_collect(fp, ext):
            raise RuntimeError("CAF exploded")

        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", raising_collect)

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is True
        assert model_solids == [m1]
        assert gy_index == 0

    def test_heuristic_detects_enclosing_solid(self, monkeypatch):
        """Without names, a >10x solid containing all others is a graveyard."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1, m2 = _FakeOccShape(), _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1, m2])
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is True
        assert model_solids == [m1, m2]
        assert gy_index == 0

    def test_heuristic_rejects_similar_volumes(self, monkeypatch):
        """A largest solid under 10x the second is not a graveyard."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1 = _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1], gy_volume=5.0, model_volume=1.0)
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is False
        assert model_solids == [gy, m1]
        assert gy_index is None

    def test_heuristic_rejects_non_containing_solid(self, monkeypatch):
        """A huge solid that does not contain the others is not a graveyard."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1 = _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1])
        # m1 sticks out of the gy bounding box.
        state.bboxes[id(m1)] = (500.0, 500.0, 500.0, 600.0, 600.0, 600.0)
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, _, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is False
        assert gy_index is None

    def test_heuristic_rejects_zero_second_volume(self, monkeypatch):
        """A zero-volume second solid makes the ratio check meaningless."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1 = _FakeOccShape(), _FakeOccShape()
        shape = self._register_model(state, gy, [m1], model_volume=0.0)
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, _, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is False
        assert gy_index is None

    def test_heuristic_rejects_unmeasurable_solid(self, monkeypatch):
        """A solid whose volume cannot be computed aborts the heuristic."""
        state = _install_graveyard_fakes(monkeypatch)
        gy, m1 = _FakeOccShape(), _FakeOccShape()
        shape = _FakeOccShape()
        state.solids[id(shape)] = [gy, m1]
        state.volumes[id(gy)] = 1e6
        # m1 has no registered volume -> _shape_volume raises.
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is False
        assert model_solids == [gy, m1]
        assert gy_index is None

    def test_single_solid_is_not_a_graveyard(self, monkeypatch):
        """A lone solid can never match the enclosing heuristic."""
        state = _install_graveyard_fakes(monkeypatch)
        only = _FakeOccShape()
        shape = _FakeOccShape()
        state.solids[id(shape)] = [only]
        monkeypatch.setattr(nurbs_handler, "_collect_cad_names", lambda fp, ext: set())

        detected, model_solids, gy_index = nurbs_handler._detect_existing_graveyard(
            shape, "model.step", ".step"
        )

        assert detected is False
        assert model_solids == [only]
        assert gy_index is None


class TestMakeCompound:
    def test_compound_collects_solids_in_order(self, monkeypatch):
        """The builder receives every solid and produces a shape."""
        _install_graveyard_fakes(monkeypatch)
        s1, s2 = _FakeOccShape(), _FakeOccShape()

        compound = nurbs_handler._make_compound([s1, s2])

        assert compound is not None


class TestBuildGraveyardShape:
    def test_empty_model_warns_and_returns_none(self, monkeypatch):
        """No model solids means no graveyard can be built."""
        _install_graveyard_fakes(monkeypatch)
        warnings = []

        result = nurbs_handler._build_graveyard_shape([], warnings)

        assert result is None
        assert any("no model solids found" in w for w in warnings)

    def test_success_cuts_padded_box_and_combines(self, monkeypatch):
        """A padded box minus the model yields model + graveyard solids."""
        state = _install_graveyard_fakes(monkeypatch)
        state.default_bbox = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
        gy = _FakeOccShape()
        state.cut_shape = _FakeOccShape()
        state.solids[id(state.cut_shape)] = [gy]
        m1, m2 = _FakeOccShape(), _FakeOccShape()
        warnings = []

        result = nurbs_handler._build_graveyard_shape([m1, m2], warnings)

        assert result is not None
        assert warnings == []
        # max_dim 10 -> padding max(1.0, 1.0) = 1.0 around the model bbox.
        assert state.box_points == [((-1.0, -1.0, -1.0), (11.0, 11.0, 11.0))]
        # The final compound holds the model solids followed by the graveyard.
        assert state.compounds[-1].added == [m1, m2, gy]

    def test_failed_cut_warns_and_returns_none(self, monkeypatch):
        """A failed boolean cut warns and yields no shape."""
        state = _install_graveyard_fakes(monkeypatch)
        state.cut_is_done = False
        warnings = []

        result = nurbs_handler._build_graveyard_shape([_FakeOccShape()], warnings)

        assert result is None
        assert any("boolean cut failed" in w for w in warnings)

    def test_cut_without_solids_warns_and_returns_none(self, monkeypatch):
        """A cut that produces no volumes warns and yields no shape."""
        state = _install_graveyard_fakes(monkeypatch)
        state.cut_shape = _FakeOccShape()  # no solids registered for it
        warnings = []

        result = nurbs_handler._build_graveyard_shape([_FakeOccShape()], warnings)

        assert result is None
        assert any("boolean cut produced no volumes" in w for w in warnings)

    def test_kernel_error_warns_and_returns_none(self, monkeypatch):
        """An OCC failure during construction is reported in the warning."""
        state = _install_graveyard_fakes(monkeypatch)
        state.box_error = RuntimeError("kernel exploded")
        warnings = []

        result = nurbs_handler._build_graveyard_shape([_FakeOccShape()], warnings)

        assert result is None
        assert any("kernel exploded" in w for w in warnings)


class TestMaybeAddGraveyard:
    def test_existing_graveyard_with_index_is_tagged(self, monkeypatch):
        """A detected graveyard keeps the shape and tags its 1-based volume id."""
        shape = _FakeOccShape()
        monkeypatch.setattr(
            nurbs_handler, "_detect_existing_graveyard", lambda s, fp, ext: (True, ["m"], 1)
        )
        warnings = []

        result_shape, gy_ids = nurbs_handler._maybe_add_graveyard(
            shape, "model.step", ".step", warnings
        )

        assert result_shape is shape
        assert gy_ids == {2}
        assert any("Existing graveyard volume detected" in w for w in warnings)
        assert any("will be tagged mat:graveyard" in w for w in warnings)

    def test_existing_graveyard_without_index_warns_manual(self, monkeypatch):
        """A name-only detection tags nothing and warns about manual correction."""
        shape = _FakeOccShape()
        monkeypatch.setattr(
            nurbs_handler, "_detect_existing_graveyard", lambda s, fp, ext: (True, ["m"], None)
        )
        warnings = []

        result_shape, gy_ids = nurbs_handler._maybe_add_graveyard(
            shape, "model.step", ".step", warnings
        )

        assert result_shape is shape
        assert gy_ids == set()
        assert any("could not be matched to a solid" in w for w in warnings)

    def test_auto_created_graveyard_returns_new_ids(self, monkeypatch):
        """An auto-created graveyard yields the combined shape and new volume ids."""
        state = _install_graveyard_fakes(monkeypatch)
        shape, m1, gy = _FakeOccShape(), _FakeOccShape(), _FakeOccShape()
        combined = _FakeOccShape()
        state.solids[id(shape)] = [m1]
        state.solids[id(combined)] = [m1, gy]
        monkeypatch.setattr(
            nurbs_handler, "_detect_existing_graveyard", lambda s, fp, ext: (False, [m1], None)
        )
        monkeypatch.setattr(nurbs_handler, "_build_graveyard_shape", lambda solids, w: combined)
        warnings = []

        result_shape, gy_ids = nurbs_handler._maybe_add_graveyard(
            shape, "model.step", ".step", warnings
        )

        assert result_shape is combined
        assert gy_ids == {2}
        assert any("Auto-created graveyard volume around model" in w for w in warnings)

    def test_failed_creation_keeps_original_shape(self, monkeypatch):
        """When graveyard construction fails, the original shape is kept."""
        shape = _FakeOccShape()
        monkeypatch.setattr(
            nurbs_handler, "_detect_existing_graveyard", lambda s, fp, ext: (False, [], None)
        )
        monkeypatch.setattr(nurbs_handler, "_build_graveyard_shape", lambda solids, w: None)
        warnings = []

        result_shape, gy_ids = nurbs_handler._maybe_add_graveyard(
            shape, "model.step", ".step", warnings
        )

        assert result_shape is shape
        assert gy_ids == set()

    def test_detection_error_warns_and_keeps_shape(self, monkeypatch):
        """An unexpected detection failure warns and leaves the shape untouched."""
        shape = _FakeOccShape()

        def raising_detect(s, fp, ext):
            raise RuntimeError("detector exploded")

        monkeypatch.setattr(nurbs_handler, "_detect_existing_graveyard", raising_detect)
        warnings = []

        result_shape, gy_ids = nurbs_handler._maybe_add_graveyard(
            shape, "model.step", ".step", warnings
        )

        assert result_shape is shape
        assert gy_ids == set()
        assert any("detector exploded" in w for w in warnings)
