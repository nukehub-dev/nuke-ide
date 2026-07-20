"""Tests for plugins.openmc.lib.openmc_vtk — OpenMCVTKExporter and helpers.

openmc and vtk are not installed in this environment. The module guards
the openmc import, so tests patch the module's ``openmc`` attribute and
``HAS_OPENMC`` flag with fakes, and inject a fake vtk module for the
structured-grid path. The module has numpy at its top level, so the
whole test module is skipped when numpy is unavailable.
"""

import sys
from types import ModuleType, SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from plugins.openmc.lib import openmc_vtk  # noqa: E402
from plugins.openmc.lib.openmc_vtk import (  # noqa: E402
    CellTallyData,
    MeshTallyData,
    OpenMCVTKExporter,
    export_statepoint_tallies,
)

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeMesh:
    """Regular-mesh stand-in with write_data_to_vtk recording."""

    def __init__(self, dimension=(2, 2, 1)):
        self.dimension = np.array(dimension)
        self.lower_left = np.array([0.0, 0.0, 0.0])
        self.upper_right = np.array([2.0, 2.0, 1.0])
        self.written = []

    def write_data_to_vtk(self, path, datasets=None):
        self.written.append((path, dict(datasets)))


class _FakeCylindricalMesh:
    """Cylindrical-mesh stand-in with r/z grids instead of bounds corners."""

    def __init__(self):
        self.dimension = np.array([3, 1, 2])
        self.r_grid = np.array([0.0, 1.0, 2.0, 3.0])
        self.z_grid = np.array([-1.0, 0.0, 1.0])


class _FakeTally:
    def __init__(
        self,
        tally_id=1,
        name="tally",
        scores=None,
        nuclides=None,
        filters=None,
        mean=None,
        std_dev=None,
        mesh_dims=(2, 2, 1),
    ):
        self.id = tally_id
        self.name = name
        self.scores = scores if scores is not None else ["flux", "heating"]
        self.nuclides = nuclides if nuclides is not None else ["total", "U235"]
        self.filters = filters or []
        self._mesh_dims = mesh_dims
        # Mean shaped (mesh_dims..., n_scores, n_nuclides) after squeeze.
        if mean is None:
            mean = np.arange(
                int(np.prod(mesh_dims)) * len(self.scores) * len(self.nuclides), dtype=float
            ).reshape(*mesh_dims, len(self.scores), len(self.nuclides))
        self._mean = mean
        self._std_dev = std_dev

    @property
    def mean(self):
        return self._mean

    @property
    def std_dev(self):
        return self._std_dev

    def get_reshaped_data(self, value="mean", expand_dims=True):
        data = self._mean if value == "mean" else self._std_dev
        return np.asarray(data)

    def get_values(self, value="mean"):
        data = self._mean if value == "mean" else self._std_dev
        return np.asarray(data).flatten()


class _FakeStatePoint:
    """StatePoint stand-in constructed from a tallies dict."""

    def __init__(self, tallies):
        self.tallies = tallies


@pytest.fixture
def fake_openmc(monkeypatch):
    """Patch the module's openmc reference and HAS_OPENMC flag with fakes."""
    module = ModuleType("openmc")

    class MeshFilter:
        def __init__(self, mesh):
            self.mesh = mesh

    class CellFilter:
        def __init__(self, bins):
            self.bins = bins

    module.MeshFilter = MeshFilter
    module.CellFilter = CellFilter
    module.StatePoint = None  # set per-test
    # When openmc is missing, the module never binds the name — allow setting it.
    monkeypatch.setattr(openmc_vtk, "openmc", module, raising=False)
    monkeypatch.setattr(openmc_vtk, "HAS_OPENMC", True)
    return module


def _make_exporter(fake_openmc, tallies, path="/run/statepoint.100.h5"):
    fake_openmc.StatePoint = lambda sp_path: _FakeStatePoint(tallies)
    return OpenMCVTKExporter(path)


# ---------------------------------------------------------------------------
# Constructor / listing / caching
# ---------------------------------------------------------------------------


def test_exporter_requires_openmc(monkeypatch):
    """With openmc unavailable (HAS_OPENMC forced off), construction fails."""
    monkeypatch.setattr(openmc_vtk, "HAS_OPENMC", False)
    with pytest.raises(RuntimeError, match="OpenMC Python module is required"):
        OpenMCVTKExporter("/no/such/statepoint.h5")


def test_list_tallies_extracts_info(fake_openmc):
    mesh = _FakeMesh(dimension=(4, 5, 6))
    mesh_tally = _FakeTally(tally_id=1, name="mesh tally", filters=[fake_openmc.MeshFilter(mesh)])
    cell_tally = _FakeTally(tally_id=2, name="cell tally", filters=[fake_openmc.CellFilter([1, 2])])
    exporter = _make_exporter(fake_openmc, {1: mesh_tally, 2: cell_tally})

    infos = exporter.list_tallies()
    assert len(infos) == 2

    mesh_info = infos[0]
    assert mesh_info.id == 1
    assert mesh_info.has_mesh is True
    assert mesh_info.mesh_type == "_FakeMesh"
    assert mesh_info.mesh_dimensions == (4, 5, 6)
    assert mesh_info.mesh_bounds == {
        "x": (0.0, 2.0),
        "y": (0.0, 2.0),
        "z": (0.0, 1.0),
    }
    assert mesh_info.filters == [{"type": "MeshFilter"}]

    cell_info = infos[1]
    assert cell_info.has_mesh is False
    assert cell_info.mesh_type is None
    assert cell_info.filters == [{"type": "CellFilter", "bins": 2}]


def test_list_tallies_populates_cache(fake_openmc):
    tally = _FakeTally(tally_id=5)
    exporter = _make_exporter(fake_openmc, {5: tally})
    exporter.list_tallies()

    # Cache hit: removing the tally from the statepoint must not matter.
    exporter.statepoint.tallies.clear()
    assert exporter.get_tally(5) is tally


def test_get_tally_loads_on_demand(fake_openmc):
    tally = _FakeTally(tally_id=3)
    exporter = _make_exporter(fake_openmc, {3: tally})
    assert exporter.get_tally(3) is tally
    assert 3 in exporter._tallies_cache


# ---------------------------------------------------------------------------
# export_mesh_tally
# ---------------------------------------------------------------------------


def test_export_mesh_tally_requires_mesh_filter(fake_openmc):
    tally = _FakeTally(filters=[])
    exporter = _make_exporter(fake_openmc, {1: tally})

    with pytest.raises(ValueError, match="does not have a mesh filter"):
        exporter.export_mesh_tally(1)


def test_export_mesh_tally_writes_vtk_and_metadata(fake_openmc, tmp_path):
    mesh = _FakeMesh(dimension=(2, 2, 1))
    tally = _FakeTally(
        filters=[fake_openmc.MeshFilter(mesh)],
        std_dev=np.ones((2, 2, 1, 2, 2)) * 0.1,
    )
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    data = exporter.export_mesh_tally(1)

    assert isinstance(data, MeshTallyData)
    assert data.tally_id == 1
    assert data.tally_name == "tally"
    assert data.score == "flux"  # first score by default
    assert data.nuclide == "total"  # first nuclide by default
    assert data.dimensions == (2, 2, 1)
    assert data.mesh_type == "_FakeMesh"
    assert data.bounds["x"] == (0.0, 2.0)
    assert data.vtk_path == str(tmp_path / "tally_1_flux_total.vtk")

    path, datasets = mesh.written[0]
    assert path == data.vtk_path
    assert list(datasets) == ["flux-mean", "flux-std-dev"]
    assert datasets["flux-mean"].shape == (2, 2, 1)

    expected_mean = tally._mean[..., 0, 0]
    assert data.data_range == (float(expected_mean.min()), float(expected_mean.max()))


def test_export_mesh_tally_without_std_dev(fake_openmc, tmp_path):
    mesh = _FakeMesh()
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)], std_dev=None)
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    data = exporter.export_mesh_tally(1)
    assert data.datasets == ["flux-mean"]


def test_export_mesh_tally_explicit_score_nuclide_and_paths(fake_openmc, tmp_path):
    mesh = _FakeMesh()
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)])
    exporter = _make_exporter(fake_openmc, {7: tally}, path=str(tmp_path / "sp.h5"))

    out_dir = tmp_path / "exports"
    out_dir.mkdir()
    data = exporter.export_mesh_tally(
        7, score="heating", nuclide="U235", output_dir=str(out_dir), filename="custom.vtk"
    )
    assert data.score == "heating"
    assert data.nuclide == "U235"
    assert data.vtk_path == str(out_dir / "custom.vtk")
    expected = tally._mean[..., 1, 1]
    assert data.data_range == (float(expected.min()), float(expected.max()))


def test_export_mesh_tally_case_insensitive_score(fake_openmc, tmp_path):
    mesh = _FakeMesh()
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)])
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    data = exporter.export_mesh_tally(1, score="FLUX")
    assert data.score == "flux"


def test_export_mesh_tally_unknown_score_and_nuclide_fall_back(fake_openmc, tmp_path, capsys):
    mesh = _FakeMesh()
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)])
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    data = exporter.export_mesh_tally(1, score="bogus", nuclide="also-bogus")
    assert data.score == "flux"
    assert data.nuclide == "total"
    err = capsys.readouterr().err
    assert "Score 'bogus' not found" in err
    assert "Nuclide 'also-bogus' not found" in err


def test_export_mesh_tally_reshapes_flat_data(fake_openmc, tmp_path):
    """Data whose extracted shape is flat but correctly sized gets reshaped."""
    mesh = _FakeMesh(dimension=(2, 2, 1))
    # Shape (4, 2, 2): filter bins flattened, then scores, then nuclides.
    mean = np.arange(16, dtype=float).reshape(4, 2, 2)
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)], mean=mean)
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    data = exporter.export_mesh_tally(1)
    assert data.dimensions == (2, 2, 1)


def test_export_mesh_tally_shape_mismatch_raises(fake_openmc, tmp_path):
    mesh = _FakeMesh(dimension=(2, 2, 1))
    mean = np.zeros((3, 3, 3, 2, 2))  # 27 filter bins, not 4
    tally = _FakeTally(filters=[fake_openmc.MeshFilter(mesh)], mean=mean)
    exporter = _make_exporter(fake_openmc, {1: tally}, path=str(tmp_path / "sp.h5"))

    with pytest.raises(ValueError, match="does not match mesh dimensions"):
        exporter.export_mesh_tally(1)


def test_export_all_mesh_tallies(fake_openmc, tmp_path, capsys):
    mesh = _FakeMesh()
    good = _FakeTally(
        tally_id=1, scores=["flux"], nuclides=["total"], filters=[fake_openmc.MeshFilter(mesh)]
    )
    cell_only = _FakeTally(tally_id=2, filters=[fake_openmc.CellFilter([1])])
    bad = _FakeTally(
        tally_id=3,
        scores=["flux"],
        nuclides=["total"],
        filters=[fake_openmc.MeshFilter(mesh)],
        mean=np.zeros((9, 1, 1)),  # wrong bin count -> export fails
    )
    exporter = _make_exporter(fake_openmc, {1: good, 2: cell_only, 3: bad})

    results = exporter.export_all_mesh_tallies(output_dir=str(tmp_path))
    assert len(results) == 1
    assert results[0].tally_id == 1
    assert "Failed to export tally 3" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# get_cell_tally_data
# ---------------------------------------------------------------------------


def test_get_cell_tally_data_3d_mean(fake_openmc):
    cell_filter = fake_openmc.CellFilter([10, 20, 30])
    mean = np.arange(3 * 2 * 2, dtype=float).reshape(3, 2, 2)
    std_dev = np.ones((3, 2, 2)) * 0.5
    tally = _FakeTally(filters=[cell_filter], mean=mean, std_dev=std_dev)
    exporter = _make_exporter(fake_openmc, {1: tally})

    data = exporter.get_cell_tally_data(1, score="heating", nuclide="U235")

    assert isinstance(data, CellTallyData)
    assert data.score == "heating"
    assert data.nuclide == "U235"
    assert data.cell_values == {10: mean[0, 1, 1], 20: mean[1, 1, 1], 30: mean[2, 1, 1]}
    assert data.cell_errors == {10: 0.5, 20: 0.5, 30: 0.5}


def test_get_cell_tally_data_2d_and_1d_means(fake_openmc):
    cell_filter = fake_openmc.CellFilter([1, 2])

    mean_2d = np.array([[1.0, 2.0], [3.0, 4.0]])
    tally = _FakeTally(filters=[cell_filter], mean=mean_2d, std_dev=None)
    exporter = _make_exporter(fake_openmc, {1: tally})
    data = exporter.get_cell_tally_data(1)
    assert data.cell_values == {1: 1.0, 2: 3.0}
    assert data.cell_errors == {1: 0.0, 2: 0.0}

    mean_1d = np.array([7.0, 8.0])
    tally = _FakeTally(filters=[cell_filter], mean=mean_1d, std_dev=np.array([0.1, 0.2]))
    exporter = _make_exporter(fake_openmc, {1: tally})
    data = exporter.get_cell_tally_data(1)
    assert data.cell_values == {1: 7.0, 2: 8.0}
    assert data.cell_errors == {1: pytest.approx(0.1), 2: pytest.approx(0.2)}


def test_get_cell_tally_data_requires_cell_filter(fake_openmc):
    tally = _FakeTally(filters=[])
    exporter = _make_exporter(fake_openmc, {1: tally})
    with pytest.raises(ValueError, match="does not have a cell filter"):
        exporter.get_cell_tally_data(1)


# ---------------------------------------------------------------------------
# find_geometry_file / mesh bounds
# ---------------------------------------------------------------------------


def test_find_geometry_file_prefers_run_dir(fake_openmc, tmp_path):
    exporter = _make_exporter(fake_openmc, {}, path=str(tmp_path / "sp.h5"))
    geom = tmp_path / "geometry.h5m"
    geom.write_text("h5m")
    assert exporter.find_geometry_file() == str(geom)


def test_find_geometry_file_xml_and_parent_search(fake_openmc, tmp_path):
    run_dir = tmp_path / "a" / "b" / "c"
    run_dir.mkdir(parents=True)
    geom = tmp_path / "a" / "geometry.xml"
    geom.write_text("<geometry/>")

    exporter = _make_exporter(fake_openmc, {}, path=str(run_dir / "sp.h5"))
    assert exporter.find_geometry_file() == str(geom)


def test_find_geometry_file_returns_none_when_absent(fake_openmc, tmp_path):
    run_dir = tmp_path / "empty" / "deeper"
    run_dir.mkdir(parents=True)
    exporter = _make_exporter(fake_openmc, {}, path=str(run_dir / "sp.h5"))
    assert exporter.find_geometry_file(run_dir=str(run_dir)) is None


def test_get_mesh_bounds_cylindrical(fake_openmc):
    exporter = _make_exporter(fake_openmc, {})
    bounds = exporter._get_mesh_bounds(_FakeCylindricalMesh())
    assert bounds["r"] == (0.0, 3.0)
    assert bounds["z"] == (-1.0, 1.0)
    assert bounds["phi"] == (0.0, pytest.approx(2 * np.pi))


def test_get_mesh_bounds_unknown_mesh(fake_openmc):
    exporter = _make_exporter(fake_openmc, {})
    assert exporter._get_mesh_bounds(SimpleNamespace()) == {}


# ---------------------------------------------------------------------------
# Score/nuclide resolution edge cases
# ---------------------------------------------------------------------------


def test_resolve_score_empty_scores(fake_openmc):
    tally = _FakeTally(scores=[])
    exporter = _make_exporter(fake_openmc, {})
    assert exporter._resolve_score(tally, None) == (0, "total")
    assert exporter._resolve_score(tally, "flux") == (0, "total")


def test_resolve_nuclide_empty_nuclides(fake_openmc):
    tally = _FakeTally(nuclides=[])
    exporter = _make_exporter(fake_openmc, {})
    assert exporter._resolve_nuclide(tally, None) == (0, "total")
    assert exporter._resolve_nuclide(tally, "U235") == (0, "total")


# ---------------------------------------------------------------------------
# export_statepoint_tallies convenience function
# ---------------------------------------------------------------------------


def test_export_statepoint_tallies_filters_and_collects_errors(fake_openmc, tmp_path):
    mesh = _FakeMesh()
    good = _FakeTally(
        tally_id=1, scores=["flux"], nuclides=["total"], filters=[fake_openmc.MeshFilter(mesh)]
    )
    bad = _FakeTally(
        tally_id=2,
        scores=["flux"],
        nuclides=["total"],
        filters=[fake_openmc.MeshFilter(mesh)],
        mean=np.zeros((9, 1, 1)),
    )
    cell_only = _FakeTally(tally_id=3, filters=[fake_openmc.CellFilter([1])])
    fake_openmc.StatePoint = lambda path: _FakeStatePoint({1: good, 2: bad, 3: cell_only})

    out_dir = tmp_path / "new" / "exports"
    result = export_statepoint_tallies(
        str(tmp_path / "sp.h5"), output_dir=str(out_dir), tally_ids=[1, 2]
    )

    assert out_dir.is_dir()  # created on demand
    assert len(result["mesh_tallies"]) == 1
    assert result["mesh_tallies"][0].tally_id == 1
    assert len(result["errors"]) == 1
    assert "Tally 2" in result["errors"][0]


# ---------------------------------------------------------------------------
# create_structured_grid (fake vtk)
# ---------------------------------------------------------------------------


def _install_fake_vtk(monkeypatch):
    recorded = {"arrays": [], "points": [], "dims": None, "active_scalars": []}

    class _DoubleArray:
        def __init__(self):
            self.name = None
            self.values = {}

        def SetName(self, name):
            self.name = name
            recorded["arrays"].append(self)

        def SetNumberOfValues(self, n):
            self.n = n

        def SetValue(self, i, v):
            self.values[i] = v

    class _Points:
        def InsertNextPoint(self, x, y, z):
            recorded["points"].append((x, y, z))

    class _DataSetAttributes:
        def AddArray(self, array):
            pass

        def SetActiveScalars(self, name):
            recorded["active_scalars"].append(name)

    class _Grid:
        def __init__(self):
            self._cell_data = _DataSetAttributes()
            self._point_data = _DataSetAttributes()

        def SetDimensions(self, x, y, z):
            recorded["dims"] = (x, y, z)

        def SetPoints(self, points):
            pass

        def GetCellData(self):
            return self._cell_data

        def GetPointData(self):
            return self._point_data

    class _CellDataToPointData:
        def __init__(self):
            self._grid = _Grid()

        def SetInputData(self, grid):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return self._grid

    vtk_mod = ModuleType("vtk")
    vtk_mod.vtkStructuredGrid = _Grid
    vtk_mod.vtkPoints = _Points
    vtk_mod.vtkDoubleArray = _DoubleArray
    vtk_mod.vtkCellDataToPointData = _CellDataToPointData
    monkeypatch.setitem(sys.modules, "vtk", vtk_mod)
    return recorded


def test_create_structured_grid_pixelated(fake_openmc, monkeypatch):
    recorded = _install_fake_vtk(monkeypatch)
    mesh = _FakeMesh(dimension=(2, 1, 1))
    mean = np.array([1.0, 2.0])
    std_dev = np.array([0.1, 0.2])
    tally = _FakeTally(
        tally_id=9,
        name="flux tally",
        scores=["flux"],
        nuclides=["total"],
        filters=[fake_openmc.MeshFilter(mesh)],
        mean=mean,
        std_dev=std_dev,
    )
    exporter = _make_exporter(fake_openmc, {9: tally})

    grid, name, data_range = exporter.create_structured_grid(9, pixelated=True)

    assert name == "flux tally"
    assert data_range == (1.0, 2.0)
    assert recorded["dims"] == (3, 2, 2)
    assert len(recorded["points"]) == 3 * 2 * 2
    mean_array = next(a for a in recorded["arrays"] if a.name == "flux_mean")
    std_array = next(a for a in recorded["arrays"] if a.name == "flux_std_dev")
    assert mean_array.values == {0: 1.0, 1: 2.0}
    assert std_array.values == {0: 0.1, 1: 0.2}
    assert recorded["active_scalars"] == ["flux_mean"]


def test_create_structured_grid_smooth_converts_to_point_data(fake_openmc, monkeypatch):
    recorded = _install_fake_vtk(monkeypatch)
    mesh = _FakeMesh(dimension=(1, 1, 1))
    tally = _FakeTally(
        scores=["flux"],
        nuclides=["total"],
        filters=[fake_openmc.MeshFilter(mesh)],
        mean=np.array([5.0]),
        std_dev=np.array([0.5]),
    )
    exporter = _make_exporter(fake_openmc, {1: tally})

    _grid, _name, data_range = exporter.create_structured_grid(1, pixelated=False)
    assert data_range == (5.0, 5.0)
    # Both the cell-data and point-data SetActiveScalars calls are recorded.
    assert recorded["active_scalars"] == ["flux_mean", "flux_mean"]


def test_create_structured_grid_requires_mesh_filter(fake_openmc, monkeypatch):
    _install_fake_vtk(monkeypatch)
    tally = _FakeTally(filters=[])
    exporter = _make_exporter(fake_openmc, {1: tally})
    with pytest.raises(ValueError, match="does not have a mesh filter"):
        exporter.create_structured_grid(1)
