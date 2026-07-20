"""Tests for cad_conversion.nurbs_handler.

gmsh is faked for the detection/summary functions; OCP and pymoab are
replaced with recording fakes for the DAGMC conversion pipeline. No real
CAD kernel, mesh database, or .h5m output is involved.
"""

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
        assert result["error"].startswith("Required dependency missing:")
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

        def fake_native(file_path, h5m_path, tol, scale, warnings, auto_adjust):
            seen.update(file=file_path, h5m=h5m_path, tol=tol, scale=scale, auto=auto_adjust)
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

    def test_failure_reports_hint(self, monkeypatch, tmp_path):
        """A failed native conversion surfaces the install-hint error."""
        self._install_ocp_probes(monkeypatch)
        monkeypatch.setattr(nurbs_handler, "_native_dagmc_conversion", lambda *a: False)
        out = str(tmp_path / "out.h5m")

        result = nurbs_handler.convert_to_dagmc("model.step", output_path=out)

        assert result["success"] is False
        assert result["output_path"] == out
        assert "Failed to convert CAD to DAGMC" in result["error"]


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
        assert any("Missing dependency for fast DAGMC conversion" in w for w in warnings)
