"""Tests for plugins.base.lib.dagmc and plugins.base.lib.step converters.

pymoab, pydagmc, vtk, and gmsh are not installed in this environment, so
the conversion paths are exercised with recording fakes injected into
sys.modules (or monkeypatched module functions), mirroring the pattern in
test_command_error_paths.py.
"""

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from plugins.base.lib import dagmc as dagmc_lib  # noqa: E402
from plugins.base.lib import step as step_lib  # noqa: E402


@pytest.fixture
def h5m_file(tmp_path):
    f = tmp_path / "model.h5m"
    f.write_bytes(b"fake h5m content")
    return f


@pytest.fixture
def step_file(tmp_path):
    f = tmp_path / "bracket.step"
    f.write_bytes(b"ISO-10303-21 fake step content")
    return f


# ---------------------------------------------------------------------------
# Fake pymoab / pydagmc / vtk builders
# ---------------------------------------------------------------------------


class _FakeMoabCore:
    """Records pymoab Core operations; serves a fixed triangle list."""

    def __init__(self, triangles):
        self._triangles = triangles
        self.loaded = None
        self.written = None

    def load_file(self, path):
        self.loaded = path

    def get_entities_by_type(self, meshset, entity_type):
        return list(self._triangles)

    def write_file(self, path):
        self.written = path


def _install_fake_pymoab(monkeypatch, triangles=(11, 22, 33)):
    core_holder = {}

    def _core_factory():
        inst = _FakeMoabCore(triangles)
        core_holder["instance"] = inst
        return inst

    core_mod = ModuleType("pymoab.core")
    core_mod.Core = _core_factory
    types_mod = ModuleType("pymoab.types")
    types_mod.MBTRI = 3
    pymoab_mod = ModuleType("pymoab")
    pymoab_mod.core = core_mod
    pymoab_mod.types = types_mod

    monkeypatch.setitem(sys.modules, "pymoab", pymoab_mod)
    monkeypatch.setitem(sys.modules, "pymoab.core", core_mod)
    monkeypatch.setitem(sys.modules, "pymoab.types", types_mod)
    return core_holder


class _FakeVolume:
    def __init__(self, vol_id, material=None, num_triangles=4, with_bbox=True):
        self.id = vol_id
        self.material = material
        self.num_triangles = num_triangles
        self.surfaces = [SimpleNamespace(handle=100 + vol_id)]
        if with_bbox:
            self.bounding_box = [[0.0, 1.0], [2.0, 3.0], [4.0, 5.0]]


class _FakeGroup:
    def __init__(self, name, volumes):
        self.name = name
        self.volumes = volumes


class _FakeSurface:
    def __init__(self, surf_id, num_triangles=2, with_optional=True):
        self.id = surf_id
        if with_optional:
            self.num_triangles = num_triangles
            self.forward_volumes = [SimpleNamespace(id=1)]
            self.reverse_volumes = []


class _FakeDagmcModel:
    def __init__(self, volumes=None, groups=None, surfaces=None):
        self.volumes = volumes or []
        self.groups = groups or []
        self.surfaces = surfaces or []
        self.volumes_by_id = {int(v.id): v for v in self.volumes}
        materials = {}
        for v in self.volumes:
            materials.setdefault(v.material or "void", []).append(v)
        self.volumes_by_material = materials
        self.mb = SimpleNamespace()


def _install_fake_pydagmc(monkeypatch, model):
    pydagmc_mod = ModuleType("pydagmc")
    pydagmc_mod.Model = lambda path: model
    monkeypatch.setitem(sys.modules, "pydagmc", pydagmc_mod)
    # convert_* also do `from pymoab import types`.
    _install_fake_pymoab(monkeypatch)
    return model


def _install_fake_vtk(monkeypatch, **overrides):
    """Install a recording fake vtk module; returns the module for inspection."""
    vtk_mod = ModuleType("vtk")
    vtk_mod.VTK_TRIANGLE = 5
    vtk_mod.VTK_ID_TYPE = 12

    class _Writer:
        def __init__(self):
            self.calls = []

        def SetFileName(self, name):
            self.calls.append(("SetFileName", name))

        def SetInputData(self, data):
            self.calls.append(("SetInputData", data))

        def Write(self):
            self.calls.append(("Write",))

    vtk_mod._writers = []

    def _writer_factory():
        writer = _Writer()
        vtk_mod._writers.append(writer)
        return writer

    vtk_mod.vtkXMLUnstructuredGridWriter = _writer_factory
    vtk_mod.vtkXMLMultiBlockDataWriter = _writer_factory
    vtk_mod.vtkUnstructuredGridWriter = _writer_factory

    for name, value in overrides.items():
        setattr(vtk_mod, name, value)

    util_mod = ModuleType("vtk.util")
    numpy_support_mod = ModuleType("vtk.util.numpy_support")
    util_mod.numpy_support = numpy_support_mod
    vtk_mod.util = util_mod

    monkeypatch.setitem(sys.modules, "vtk", vtk_mod)
    monkeypatch.setitem(sys.modules, "vtk.util", util_mod)
    monkeypatch.setitem(sys.modules, "vtk.util.numpy_support", numpy_support_mod)
    return vtk_mod, numpy_support_mod


# ---------------------------------------------------------------------------
# dagmc._volume_to_grid_numpy
# ---------------------------------------------------------------------------


def _install_grid_vtk(monkeypatch):
    """Fake vtk + numpy_support rich enough for _volume_to_grid_numpy."""
    recorded = {"points": [], "cell_arrays": [], "grids": [], "string_arrays": []}

    class _VtkDataArray:
        def __init__(self, data):
            self.data = data
            self.name = None

        def SetName(self, name):
            self.name = name

    class _Points:
        def SetData(self, data_array):
            recorded["points"].append(data_array)

    class _CellArray:
        def SetCells(self, n_cells, cells):
            recorded["cell_arrays"].append((n_cells, cells))

    class _CellData:
        def __init__(self):
            self.arrays = []

        def AddArray(self, array):
            self.arrays.append(array)

    class _Grid:
        def __init__(self):
            self.cell_data = _CellData()
            recorded["grids"].append(self)

        def SetPoints(self, points):
            self.points = points

        def SetCells(self, cell_type, cell_array):
            self.cell_type = cell_type
            self.cell_array = cell_array

        def GetCellData(self):
            return self.cell_data

    class _StringArray:
        def __init__(self):
            self.name = None
            self.values = {}
            recorded["string_arrays"].append(self)

        def SetName(self, name):
            self.name = name

        def SetNumberOfValues(self, n):
            self.n = n

        def SetValue(self, i, value):
            self.values[i] = value

    vtk_mod, numpy_support = _install_fake_vtk(
        monkeypatch,
        vtkPoints=_Points,
        vtkCellArray=_CellArray,
        vtkUnstructuredGrid=_Grid,
        vtkStringArray=_StringArray,
    )
    numpy_support.numpy_to_vtk = lambda arr, deep=False, array_type=None: _VtkDataArray(arr)
    return recorded


class _GridMoab:
    """Serves scripted connectivity/coords for _volume_to_grid_numpy."""

    def __init__(self, tris_by_handle, connectivity, coords):
        self._tris_by_handle = tris_by_handle
        self._connectivity = connectivity
        self._coords = coords

    def get_entities_by_type(self, handle, entity_type):
        return list(self._tris_by_handle.get(handle, []))

    def get_connectivity(self, tris):
        return self._connectivity

    def get_coords(self, verts):
        return self._coords


def test_volume_to_grid_numpy_builds_grid_with_metadata(monkeypatch):
    recorded = _install_grid_vtk(monkeypatch)

    # Two triangles (one per surface) sharing two vertices -> 4 unique vertices.
    connectivity = np.array([[0, 1, 2], [0, 2, 3]])
    coords = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]
    )
    mb = _GridMoab({10: (100,), 11: (101,)}, connectivity=connectivity, coords=coords)
    volume = SimpleNamespace(
        id=5,
        material="UO2",
        surfaces=[SimpleNamespace(handle=10), SimpleNamespace(handle=11)],
    )
    model = SimpleNamespace(mb=mb)

    result = dagmc_lib._volume_to_grid_numpy(
        volume, model, SimpleNamespace(MBTRI=3), {"core": [5], "other": [9]}
    )

    grid, n_verts, n_tris = result
    assert n_tris == 2
    assert n_verts == 4
    assert grid.cell_type == 5  # VTK_TRIANGLE

    # Points were built from the deduplicated coordinates.
    point_data = recorded["points"][0].data
    assert point_data.shape == (4, 3)

    # Cell connectivity references deduplicated indices, prefixed with size 3.
    n_cells, cell_data = recorded["cell_arrays"][0]
    assert n_cells == 2
    flat = np.asarray(cell_data.data).reshape(2, 4)
    assert (flat[:, 0] == 3).all()

    # Metadata arrays: volume_id (int per cell), material and groups strings.
    arrays = {a.name: a for a in grid.cell_data.arrays}
    assert list(arrays["volume_id"].data) == [5, 5]
    string_arrays = {a.name: a for a in recorded["string_arrays"]}
    assert string_arrays["material"].values == {0: "UO2", 1: "UO2"}
    assert string_arrays["groups"].values == {0: "core", 1: "core"}


def test_volume_to_grid_numpy_no_group_membership(monkeypatch):
    _install_grid_vtk(monkeypatch)
    connectivity = np.array([[0, 1, 2]])
    coords = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    mb = _GridMoab({10: (100,)}, connectivity=connectivity, coords=coords)
    volume = SimpleNamespace(id=6, material=None, surfaces=[SimpleNamespace(handle=10)])
    model = SimpleNamespace(mb=mb)

    grid, n_verts, n_tris = dagmc_lib._volume_to_grid_numpy(
        volume, model, SimpleNamespace(MBTRI=3), {"core": [5]}
    )
    string_arrays = {a.name: a for a in grid.cell_data.arrays if hasattr(a, "values")}
    # material None becomes 'void'; no group membership becomes ''.
    assert string_arrays["material"].values[0] == "void"
    assert string_arrays["groups"].values[0] == ""


def test_volume_to_grid_numpy_empty_volume_returns_none(monkeypatch):
    _install_grid_vtk(monkeypatch)
    mb = _GridMoab({10: ()}, connectivity=np.array([]), coords=np.array([]))
    volume = SimpleNamespace(id=1, material="x", surfaces=[SimpleNamespace(handle=10)])
    model = SimpleNamespace(mb=mb)

    result = dagmc_lib._volume_to_grid_numpy(volume, model, SimpleNamespace(MBTRI=3), {})
    assert result is None


# ---------------------------------------------------------------------------
# dagmc.convert_h5m_to_vtk
# ---------------------------------------------------------------------------


def test_convert_h5m_to_vtk_missing_pymoab(h5m_file, monkeypatch):
    """Without pymoab the import failure surfaces as ImportError."""
    monkeypatch.setitem(sys.modules, "pymoab", None)
    with pytest.raises(ImportError):
        dagmc_lib.convert_h5m_to_vtk(str(h5m_file))


def test_convert_h5m_to_vtk_missing_file(monkeypatch):
    _install_fake_pymoab(monkeypatch)
    with pytest.raises(FileNotFoundError, match="DAGMC file not found"):
        dagmc_lib.convert_h5m_to_vtk("/no/such/model.h5m")


def test_convert_h5m_to_vtk_writes_next_to_input(h5m_file, monkeypatch):
    holder = _install_fake_pymoab(monkeypatch, triangles=(1, 2, 3, 4))
    out = dagmc_lib.convert_h5m_to_vtk(str(h5m_file))

    assert out == str(h5m_file.with_suffix(".vtk"))
    mb = holder["instance"]
    assert mb.loaded == str(h5m_file)
    assert mb.written == out


def test_convert_h5m_to_vtk_output_dir_and_count(h5m_file, tmp_path, monkeypatch):
    _install_fake_pymoab(monkeypatch, triangles=(1, 2))
    out_dir = tmp_path / "deep" / "out"
    out, count = dagmc_lib.convert_h5m_to_vtk(
        str(h5m_file), output_dir=str(out_dir), return_count=True
    )

    assert out == str(out_dir / "model.vtk")
    assert out_dir.is_dir()  # created on demand
    assert count == 2


# ---------------------------------------------------------------------------
# dagmc.convert_h5m_volume_to_vtk
# ---------------------------------------------------------------------------


def test_convert_h5m_volume_missing_file():
    with pytest.raises(FileNotFoundError, match="DAGMC file not found"):
        dagmc_lib.convert_h5m_volume_to_vtk("/no/such/model.h5m", 1)


def test_convert_h5m_volume_missing_pydagmc(h5m_file, monkeypatch):
    monkeypatch.setitem(sys.modules, "pydagmc", None)
    with pytest.raises(ImportError, match="pydagmc not available"):
        dagmc_lib.convert_h5m_volume_to_vtk(str(h5m_file), 1)


def test_convert_h5m_volume_unknown_volume(h5m_file, monkeypatch):
    _install_fake_pydagmc(monkeypatch, _FakeDagmcModel())
    with pytest.raises(ValueError, match="Volume 99 not found"):
        dagmc_lib.convert_h5m_volume_to_vtk(str(h5m_file), 99)


def test_convert_h5m_volume_without_triangles(h5m_file, monkeypatch):
    model = _FakeDagmcModel(volumes=[_FakeVolume(7, material="steel")])
    _install_fake_pydagmc(monkeypatch, model)
    monkeypatch.setattr(dagmc_lib, "_volume_to_grid_numpy", lambda *a: None)

    with pytest.raises(ValueError, match="has no triangles"):
        dagmc_lib.convert_h5m_volume_to_vtk(str(h5m_file), 7)


def test_convert_h5m_volume_success_default_output(h5m_file, tmp_path, monkeypatch):
    volume = _FakeVolume(7, material="steel")
    model = _FakeDagmcModel(
        volumes=[volume],
        groups=[_FakeGroup("fuel:cells", [volume]), _FakeGroup("empty", [])],
    )
    _install_fake_pydagmc(monkeypatch, model)
    monkeypatch.setattr(dagmc_lib, "_volume_to_grid_numpy", lambda *a: (SimpleNamespace(), 12, 4))
    vtk_mod, _ = _install_fake_vtk(monkeypatch)
    monkeypatch.setattr(dagmc_lib.tempfile, "gettempdir", lambda: str(tmp_path))

    out = dagmc_lib.convert_h5m_volume_to_vtk(str(h5m_file), 7)

    assert out == str(tmp_path / "volume_7_model.vtu")
    writer = vtk_mod._writers[0]
    assert ("SetFileName", out) in writer.calls
    assert ("Write",) in writer.calls


def test_convert_h5m_volume_vtk_suffix_becomes_vtu(h5m_file, tmp_path, monkeypatch):
    model = _FakeDagmcModel(volumes=[_FakeVolume(3)])
    _install_fake_pydagmc(monkeypatch, model)
    monkeypatch.setattr(dagmc_lib, "_volume_to_grid_numpy", lambda *a: (SimpleNamespace(), 1, 1))
    _install_fake_vtk(monkeypatch)

    out = dagmc_lib.convert_h5m_volume_to_vtk(str(h5m_file), 3, output_path=str(tmp_path / "x.vtk"))
    assert out == str(tmp_path / "x.vtu")


# ---------------------------------------------------------------------------
# dagmc.convert_h5m_to_multiblock_vtk
# ---------------------------------------------------------------------------


def _install_multiblock_vtk(monkeypatch):
    """Fake vtk with multi-block dataset support."""
    blocks = {}
    metadata = {}

    class _MetaData:
        def __init__(self, index):
            self.index = index

        def Set(self, key, value):
            metadata[self.index] = (key, value)

    class _MultiBlock:
        def SetBlock(self, index, grid):
            blocks[index] = grid

        def GetMetaData(self, index):
            return _MetaData(index)

    class _Composite:
        @staticmethod
        def NAME():
            return "NAME"

    vtk_mod, _ = _install_fake_vtk(
        monkeypatch,
        vtkMultiBlockDataSet=_MultiBlock,
        vtkCompositeDataSet=_Composite,
    )
    return vtk_mod, blocks, metadata


def test_convert_h5m_to_multiblock_missing_file(monkeypatch):
    _install_fake_vtk(monkeypatch)
    with pytest.raises(FileNotFoundError, match="DAGMC file not found"):
        dagmc_lib.convert_h5m_to_multiblock_vtk("/no/such/model.h5m")


def test_convert_h5m_to_multiblock_missing_pydagmc(h5m_file, monkeypatch):
    _install_fake_vtk(monkeypatch)
    monkeypatch.setitem(sys.modules, "pydagmc", None)
    with pytest.raises(ImportError, match="pydagmc not available"):
        dagmc_lib.convert_h5m_to_multiblock_vtk(str(h5m_file))


def test_convert_h5m_to_multiblock_skips_graveyard_and_empty(h5m_file, tmp_path, monkeypatch):
    fuel = _FakeVolume(2, material="UO2", num_triangles=4)
    graveyard = _FakeVolume(1, material="Graveyard")
    empty = _FakeVolume(3, material=None)  # grid builder returns None
    model = _FakeDagmcModel(
        volumes=[fuel, graveyard, empty],
        groups=[_FakeGroup("core", [fuel])],
    )
    _install_fake_pydagmc(monkeypatch, model)

    def fake_grid(volume, model_, types_, group_map):
        if volume is empty:
            return None
        return (SimpleNamespace(), 9, int(volume.num_triangles))

    monkeypatch.setattr(dagmc_lib, "_volume_to_grid_numpy", fake_grid)
    _vtk_mod, blocks, metadata = _install_multiblock_vtk(monkeypatch)

    result = dagmc_lib.convert_h5m_to_multiblock_vtk(str(h5m_file), output_dir=str(tmp_path))

    # Only the fuel volume made it into the multi-block.
    assert list(blocks) == [0]
    assert metadata[0] == ("NAME", "Volume_2")
    assert result["volume_info"] == [
        {
            "id": 2,
            "material": "UO2",
            "numTriangles": 4,
            "numVertices": 9,
            "groups": ["core"],
            "blockIndex": 0,
            "selector": "/Root/Volume_2",
        }
    ]
    assert result["materials"] == {"UO2": [2]}
    assert result["groups"] == {"core": [2]}

    vtm_path = Path(result["vtm_path"])
    assert vtm_path.parent == tmp_path
    assert vtm_path.name == "model_volumes.vtm"


def test_convert_h5m_to_multiblock_include_graveyard(h5m_file, tmp_path, monkeypatch):
    graveyard = _FakeVolume(1, material="graveyard")
    model = _FakeDagmcModel(volumes=[graveyard])
    _install_fake_pydagmc(monkeypatch, model)
    monkeypatch.setattr(dagmc_lib, "_volume_to_grid_numpy", lambda *a: (SimpleNamespace(), 3, 1))
    _vtk_mod, blocks, _metadata = _install_multiblock_vtk(monkeypatch)

    result = dagmc_lib.convert_h5m_to_multiblock_vtk(
        str(h5m_file), output_dir=str(tmp_path), include_graveyard=True
    )
    assert [v["id"] for v in result["volume_info"]] == [1]
    assert result["materials"] == {"graveyard": [1]}


def test_convert_h5m_to_multiblock_default_output_dir(h5m_file, tmp_path, monkeypatch):
    model = _FakeDagmcModel(volumes=[])
    _install_fake_pydagmc(monkeypatch, model)
    _install_multiblock_vtk(monkeypatch)
    monkeypatch.setattr(dagmc_lib.tempfile, "gettempdir", lambda: str(tmp_path))

    result = dagmc_lib.convert_h5m_to_multiblock_vtk(str(h5m_file))
    expected = tmp_path / "nuke-visualizer" / "dagmc" / "model_volumes.vtm"
    assert result["vtm_path"] == str(expected)
    assert result["volume_info"] == []


# ---------------------------------------------------------------------------
# dagmc.get_dagmc_model_info
# ---------------------------------------------------------------------------


def test_get_dagmc_model_info_missing_file():
    with pytest.raises(FileNotFoundError, match="DAGMC file not found"):
        dagmc_lib.get_dagmc_model_info("/no/such/model.h5m")


def test_get_dagmc_model_info_missing_pydagmc(h5m_file, monkeypatch):
    monkeypatch.setitem(sys.modules, "pydagmc", None)
    with pytest.raises(ImportError, match="pydagmc not available"):
        dagmc_lib.get_dagmc_model_info(str(h5m_file))


def test_get_dagmc_model_info_full(h5m_file, monkeypatch):
    vol_a = _FakeVolume(2, material="UO2", num_triangles=10)
    vol_b = _FakeVolume(1, material=None, num_triangles=4)
    # A volume whose bounding box lookup blows up.
    vol_c = _FakeVolume(3, material="steel", num_triangles=1, with_bbox=False)
    model = _FakeDagmcModel(
        volumes=[vol_a, vol_b, vol_c],
        groups=[_FakeGroup("core", [vol_a, vol_b]), _FakeGroup("empty", [])],
        surfaces=[_FakeSurface(5), _FakeSurface(4, with_optional=False)],
    )
    _install_fake_pydagmc(monkeypatch, model)

    info = dagmc_lib.get_dagmc_model_info(str(h5m_file))

    # Volumes are sorted by id; missing material becomes 'void'.
    assert [v["id"] for v in info["volumes"]] == [1, 2, 3]
    assert info["volumes"][0]["material"] == "void"
    assert info["volumes"][0]["boundingBox"] == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
    assert info["volumes"][1]["numTriangles"] == 10
    assert info["volumes"][1]["numSurfaces"] == 1
    # The volume with a broken bounding_box reports None.
    assert info["volumes"][2]["boundingBox"] is None

    assert info["materials"] == {
        "UO2": {"volumeCount": 1, "volumeIds": [2]},
        "void": {"volumeCount": 1, "volumeIds": [1]},
        "steel": {"volumeCount": 1, "volumeIds": [3]},
    }
    # Groups without volumes are dropped.
    assert info["groups"] == {"core": {"volumeCount": 2, "volumeIds": [2, 1]}}

    # Surfaces sorted by id; missing optional attrs default to 0/[].
    assert [s["id"] for s in info["surfaces"]] == [4, 5]
    assert info["surfaces"][0] == {
        "id": 4,
        "numTriangles": 0,
        "forwardVolumes": [],
        "reverseVolumes": [],
    }
    assert info["surfaces"][1]["numTriangles"] == 2
    assert info["surfaces"][1]["forwardVolumes"] == [1]

    assert info["fileInfo"]["name"] == "model.h5m"
    assert info["fileInfo"]["sizeBytes"] == len(b"fake h5m content")


# ---------------------------------------------------------------------------
# dagmc cell geometry helpers
# ---------------------------------------------------------------------------


class _FakeCell:
    def __init__(self, point_ids):
        self._point_ids = point_ids

    def GetNumberOfPoints(self):
        return len(self._point_ids)

    def GetPointId(self, i):
        return self._point_ids[i]


class _FakePoints:
    def __init__(self, coords):
        self._coords = coords

    def GetPoint(self, pid):
        return self._coords[pid]


def test_compute_cell_surface_area_triangle_and_polygon():
    coords = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
    points = _FakePoints(coords)

    triangle = _FakeCell([0, 1, 2])
    assert dagmc_lib._compute_cell_surface_area(triangle, points) == pytest.approx(0.5)

    # A quad fan (0,1,2)+(0,2,3): two right triangles of area 0.5 each.
    quad = _FakeCell([0, 1, 2, 3])
    assert dagmc_lib._compute_cell_surface_area(quad, points) == pytest.approx(1.0)


def test_compute_cell_surface_area_degenerate():
    assert dagmc_lib._compute_cell_surface_area(_FakeCell([0, 1]), _FakePoints([(0, 0, 0)])) == 0.0


def test_compute_max_edge_length():
    coords = [(0, 0, 0), (3, 0, 0), (0, 4, 0)]
    triangle = _FakeCell([0, 1, 2])
    assert dagmc_lib._compute_max_edge_length(triangle, _FakePoints(coords)) == pytest.approx(5.0)


def test_compute_max_edge_length_degenerate():
    assert dagmc_lib._compute_max_edge_length(_FakeCell([0]), _FakePoints([(0, 0, 0)])) == 0.0


# ---------------------------------------------------------------------------
# dagmc.filter_graveyard
# ---------------------------------------------------------------------------


class _FakeVtkArray:
    """Wraps a numpy array so fake numpy_support can resolve it."""

    def __init__(self, array):
        self._numpy = array


def _install_filter_vtk(monkeypatch, mesh):
    """Fake vtk rich enough for filter_graveyard; returns (vtk_mod, numpy_support)."""

    class _Reader:
        def __init__(self):
            self.filename = None

        def SetFileName(self, name):
            self.filename = name

        def Update(self):
            pass

        def GetOutput(self):
            return mesh

    vtk_mod, numpy_support = _install_fake_vtk(monkeypatch, vtkUnstructuredGridReader=_Reader)
    numpy_support.vtk_to_numpy = lambda arr: arr._numpy
    numpy_support.numpy_to_vtk = lambda arr, deep=False, array_type=None: _FakeVtkArray(arr)

    class _SelectionNode:
        CELL = 0
        INDICES = 4

        def SetFieldType(self, value):
            self.field_type = value

        def SetContentType(self, value):
            self.content_type = value

        def SetSelectionList(self, ids):
            self.ids = ids

    class _Selection:
        def __init__(self):
            self.nodes = []

        def AddNode(self, node):
            self.nodes.append(node)

    class _Extract:
        def __init__(self):
            self.inputs = {}

        def SetInputData(self, port, data):
            self.inputs[port] = data

        def Update(self):
            pass

        def GetOutput(self):
            return "filtered-mesh"

    class _UnstructuredGrid:
        @staticmethod
        def SafeDownCast(obj):
            return obj

    vtk_mod.vtkSelection = _Selection
    vtk_mod.vtkSelectionNode = _SelectionNode
    vtk_mod.vtkExtractSelection = _Extract
    vtk_mod.vtkUnstructuredGrid = _UnstructuredGrid
    return vtk_mod, numpy_support


def _filter_mesh(points, cell_types, offsets, connectivity):
    mesh = SimpleNamespace()
    mesh.GetNumberOfCells = lambda: len(cell_types)
    mesh.GetNumberOfPoints = lambda: len(points)
    mesh.GetPoints = lambda: SimpleNamespace(
        GetData=lambda: _FakeVtkArray(np.asarray(points, dtype=float))
    )
    mesh.GetCellTypesArray = lambda: _FakeVtkArray(np.asarray(cell_types))
    cells = SimpleNamespace(
        GetOffsetsArray=lambda: _FakeVtkArray(np.asarray(offsets)),
        GetConnectivityArray=lambda: _FakeVtkArray(np.asarray(connectivity)),
    )
    mesh.GetCells = lambda: cells
    return mesh


def test_filter_graveyard_missing_file(monkeypatch):
    _install_fake_vtk(monkeypatch)
    with pytest.raises(FileNotFoundError, match="VTK file not found"):
        dagmc_lib.filter_graveyard("/no/such/mesh.vtk")


def test_filter_graveyard_empty_mesh_copies(tmp_path, monkeypatch):
    vtk_file = tmp_path / "empty.vtk"
    vtk_file.write_text("vtk data")
    mesh = _filter_mesh(np.zeros((0, 3)), [], [0], [])
    _install_filter_vtk(monkeypatch, mesh)

    out = dagmc_lib.filter_graveyard(str(vtk_file))
    assert out == str(tmp_path / "empty_filtered.vtk")
    assert Path(out).read_text() == "vtk data"


def test_filter_graveyard_nothing_filtered_copies(tmp_path, monkeypatch):
    vtk_file = tmp_path / "small.vtk"
    vtk_file.write_text("vtk data")
    # One small triangle (area 0.5) and one short line (length 1).
    points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 5], [6, 5, 5]]
    mesh = _filter_mesh(points, [5, 3], [0, 3, 5], [0, 1, 2, 3, 4])
    _install_filter_vtk(monkeypatch, mesh)

    out = dagmc_lib.filter_graveyard(str(vtk_file), output_path=str(tmp_path / "out.vtk"))
    assert Path(out).read_text() == "vtk data"


def test_filter_graveyard_filters_large_cells(tmp_path, monkeypatch):
    vtk_file = tmp_path / "mixed.vtk"
    vtk_file.write_text("vtk data")
    # Small triangle, huge triangle (area >> max_cell_area), short line, long line.
    points = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 0],
        [1e6, 0, 0],
        [0, 1e6, 0],
        [9, 9, 9],
        [10, 9, 9],
        [0, 0, 0],
        [1e6, 0, 0],
    ]
    cell_types = [5, 5, 3, 3]
    offsets = [0, 3, 6, 8, 10]
    connectivity = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    mesh = _filter_mesh(points, cell_types, offsets, connectivity)
    vtk_mod, _ = _install_filter_vtk(monkeypatch, mesh)

    out = dagmc_lib.filter_graveyard(str(vtk_file), output_path=str(tmp_path / "kept.vtk"))

    # The extract-selection pipeline ran and the writer received its output.
    writer = vtk_mod._writers[-1]
    assert ("SetFileName", out) in writer.calls
    assert ("SetInputData", "filtered-mesh") in writer.calls
    assert ("Write",) in writer.calls


# ---------------------------------------------------------------------------
# dagmc.convert_h5m_to_vtk_cached
# ---------------------------------------------------------------------------


def test_convert_cached_returns_cache_hit(h5m_file, tmp_path, monkeypatch):
    cache_dir = str(tmp_path / "cache")
    cache_path, exists = dagmc_lib.get_cache_path(str(h5m_file), cache_dir, filtered=True)
    assert not exists
    Path(cache_path).write_text("cached")

    def _boom(*args, **kwargs):
        raise AssertionError("conversion must not run on a cache hit")

    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_vtk", _boom)
    result = dagmc_lib.convert_h5m_to_vtk_cached(str(h5m_file), cache_dir=cache_dir)

    assert result["from_cache"] is True
    assert result["vtk_path"] == cache_path


def test_convert_cached_no_cache_no_filter(h5m_file, tmp_path, monkeypatch):
    raw_vtk = tmp_path / "model.vtk"
    raw_vtk.write_text("raw")
    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_vtk", lambda *a, **k: (str(raw_vtk), 7))

    result = dagmc_lib.convert_h5m_to_vtk_cached(
        str(h5m_file), use_cache=False, do_filter_graveyard=False
    )
    assert result == {
        "vtk_path": str(raw_vtk),
        "from_cache": False,
        "original_cells": 7,
        "filtered_cells": 7,
    }


def test_convert_cached_copies_unfiltered_to_cache(h5m_file, tmp_path, monkeypatch):
    raw_vtk = tmp_path / "model.vtk"
    raw_vtk.write_text("raw")
    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_vtk", lambda *a, **k: (str(raw_vtk), 3))

    cache_dir = str(tmp_path / "cache")
    result = dagmc_lib.convert_h5m_to_vtk_cached(
        str(h5m_file), cache_dir=cache_dir, do_filter_graveyard=False
    )
    assert result["vtk_path"] != str(raw_vtk)
    assert Path(result["vtk_path"]).read_text() == "raw"
    assert result["original_cells"] == 3


def test_convert_cached_with_filtering(h5m_file, tmp_path, monkeypatch):
    raw_vtk = tmp_path / "model.vtk"
    raw_vtk.write_text("raw")
    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_vtk", lambda *a, **k: (str(raw_vtk), 10))
    filtered_vtk = tmp_path / "filtered.vtk"
    filtered_vtk.write_text("filtered")
    monkeypatch.setattr(dagmc_lib, "filter_graveyard", lambda *a, **k: str(filtered_vtk))

    class _Mesh:
        def GetNumberOfCells(self):
            return 4

    class _Reader:
        def SetFileName(self, name):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return _Mesh()

    _install_fake_vtk(monkeypatch, vtkUnstructuredGridReader=_Reader)

    result = dagmc_lib.convert_h5m_to_vtk_cached(str(h5m_file), cache_dir=str(tmp_path / "c"))
    assert result["vtk_path"] == str(filtered_vtk)
    assert result["original_cells"] == 10
    assert result["filtered_cells"] == 4


# ---------------------------------------------------------------------------
# step.convert_step_to_vtk
# ---------------------------------------------------------------------------


def _install_fake_gmsh(
    monkeypatch, entities=((1, 1), (2, 3), (0, 9)), nodes=(1, 2, 3), elements=((10, 11), (12,))
):
    calls = []

    def _record(name):
        return lambda *args: calls.append((name, args))

    gmsh_mod = ModuleType("gmsh")
    gmsh_mod.initialize = _record("initialize")
    gmsh_mod.finalize = _record("finalize")
    gmsh_mod.open = _record("open")
    gmsh_mod.write = _record("write")
    gmsh_mod.option = SimpleNamespace(setNumber=_record("option.setNumber"))
    gmsh_mod.model = SimpleNamespace(
        getEntities=lambda: list(entities),
        mesh=SimpleNamespace(
            generate=_record("mesh.generate"),
            clear=_record("mesh.clear"),
            getNodes=lambda: (list(nodes), None),
            getElements=lambda: (None, [list(e) for e in elements]),
        ),
    )
    monkeypatch.setitem(sys.modules, "gmsh", gmsh_mod)
    return gmsh_mod, calls


def test_convert_step_missing_gmsh(step_file, monkeypatch):
    monkeypatch.setitem(sys.modules, "gmsh", None)
    with pytest.raises(ImportError, match="gmsh is required"):
        step_lib.convert_step_to_vtk(str(step_file))


def test_convert_step_missing_file(monkeypatch):
    _install_fake_gmsh(monkeypatch)
    with pytest.raises(FileNotFoundError, match="CAD file not found"):
        step_lib.convert_step_to_vtk("/no/such/part.step")


def test_convert_step_success(step_file, monkeypatch):
    gmsh_mod, calls = _install_fake_gmsh(monkeypatch)

    result = step_lib.convert_step_to_vtk(str(step_file), mesh_size_max=5.0)

    assert result == {
        "vtk_path": str(step_file.with_suffix(".vtk")),
        "num_nodes": 3,
        "num_elements": 3,
    }
    names = [c[0] for c in calls]
    assert names[0] == "initialize"
    assert names[-1] == "finalize"
    assert ("open", (str(step_file),)) in calls
    assert ("mesh.generate", (2,)) in calls
    assert "mesh.clear" in names
    # Mesh size options were applied.
    option_calls = {c[1][0]: c[1][1] for c in calls if c[0] == "option.setNumber"}
    assert option_calls["Mesh.MeshSizeMax"] == 5.0
    assert option_calls["Mesh.MeshSizeMin"] == pytest.approx(0.25)


def test_convert_step_output_dir_created(step_file, tmp_path, monkeypatch):
    _install_fake_gmsh(monkeypatch)
    out_dir = tmp_path / "deep" / "out"
    result = step_lib.convert_step_to_vtk(str(step_file), output_dir=str(out_dir))
    assert result["vtk_path"] == str(out_dir / "bracket.vtk")
    assert out_dir.is_dir()


def test_convert_step_finalizes_on_error(step_file, monkeypatch):
    gmsh_mod, calls = _install_fake_gmsh(monkeypatch)

    def _fail(path):
        raise RuntimeError("cannot parse")

    gmsh_mod.open = _fail
    with pytest.raises(RuntimeError, match="cannot parse"):
        step_lib.convert_step_to_vtk(str(step_file))
    assert ("finalize", ()) in calls


def test_convert_step_empty_elements(step_file, monkeypatch):
    gmsh_mod, _ = _install_fake_gmsh(monkeypatch)
    gmsh_mod.model.mesh.getElements = lambda: (None, [])
    result = step_lib.convert_step_to_vtk(str(step_file))
    assert result["num_elements"] == 0


# ---------------------------------------------------------------------------
# step.convert_step_to_vtk_cached
# ---------------------------------------------------------------------------


def test_step_cached_returns_cache_hit(step_file, tmp_path):
    cache_dir = str(tmp_path / "cache")
    cache_path, exists = step_lib.get_cache_path(str(step_file), cache_dir)
    assert not exists
    Path(cache_path).write_text("cached vtk")

    # vtk is unavailable here, so the stats stay at their defaults but the
    # hit is still returned (the stats read is best-effort).
    result = step_lib.convert_step_to_vtk_cached(str(step_file), cache_dir=cache_dir)
    assert result["from_cache"] is True
    assert result["vtk_path"] == cache_path
    assert result["num_nodes"] == 0


def test_step_cached_hit_reads_stats_with_vtk(step_file, tmp_path, monkeypatch):
    cache_dir = str(tmp_path / "cache")
    cache_path, _ = step_lib.get_cache_path(str(step_file), cache_dir)
    Path(cache_path).write_text("cached vtk")

    class _Mesh:
        def GetNumberOfPoints(self):
            return 42

        def GetNumberOfCells(self):
            return 17

    class _Reader:
        def SetFileName(self, name):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return _Mesh()

    vtk_mod = ModuleType("vtk")
    vtk_mod.vtkUnstructuredGridReader = _Reader
    monkeypatch.setitem(sys.modules, "vtk", vtk_mod)

    result = step_lib.convert_step_to_vtk_cached(str(step_file), cache_dir=cache_dir)
    assert result["num_nodes"] == 42
    assert result["num_elements"] == 17


def test_step_cached_converts_and_moves_to_cache(step_file, tmp_path, monkeypatch):
    cache_dir = str(tmp_path / "cache")

    def fake_convert(path, output_dir=None, mesh_size_max=10.0):
        # Conversion output lands beside the input, then gets moved to cache.
        out = tmp_path / "bracket.vtk"
        out.write_text("fresh vtk")
        return {"vtk_path": str(out), "num_nodes": 5, "num_elements": 6}

    monkeypatch.setattr(step_lib, "convert_step_to_vtk", fake_convert)

    result = step_lib.convert_step_to_vtk_cached(
        str(step_file), cache_dir=cache_dir, mesh_size_max=3.0
    )
    assert result["from_cache"] is False
    assert result["num_nodes"] == 5
    assert result["num_elements"] == 6
    assert Path(result["vtk_path"]).read_text() == "fresh vtk"
    assert result["vtk_path"].startswith(cache_dir)
    assert not (tmp_path / "bracket.vtk").exists()  # moved, not copied


def test_step_cached_no_cache_returns_conversion_path(step_file, tmp_path, monkeypatch):
    def fake_convert(path, output_dir=None, mesh_size_max=10.0):
        assert output_dir is None  # no cache dir -> no output_dir passed
        return {"vtk_path": "/tmp/out.vtk", "num_nodes": 1, "num_elements": 2}

    monkeypatch.setattr(step_lib, "convert_step_to_vtk", fake_convert)
    result = step_lib.convert_step_to_vtk_cached(str(step_file), use_cache=False)
    assert result["vtk_path"] == "/tmp/out.vtk"
    assert result["from_cache"] is False
