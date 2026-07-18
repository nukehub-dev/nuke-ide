"""Tests for plugins.openmc.lib.overlap — OverlapChecker and module functions.

openmc is not installed in this environment, so a fake openmc module with
a recording Geometry class is injected into sys.modules. The module has
numpy at its top level, so the whole test module is skipped when numpy is
unavailable.
"""

import os
import sys
import unittest.mock as mock
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from plugins.openmc.lib.overlap import (  # noqa: E402
    BoundingBox,
    OverlapChecker,
    OverlapResult,
    check_overlaps,
    get_overlap_viz_data,
)


class _FakeCell:
    """Cell stand-in with a membership test for the manual search path."""

    def __init__(self, cell_id, name=None, contains=None):
        self.id = cell_id
        if name is not None:
            self.name = name
        self._contains = contains or (lambda point: False)

    def __contains__(self, point):
        return self._contains(point)


class _FakeGeometry:
    """Records find_overlaps calls; serves scripted results."""

    xml_paths = []

    def __init__(self):
        self.calls = []
        self.result = []
        self.error = None
        self.bounding_box = ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        self.root_universe = SimpleNamespace(cells={})

    @classmethod
    def from_xml(cls, path):
        cls.xml_paths.append(path)
        return cls()

    def find_overlaps(self, n_samples, tolerance, bbox):
        self.calls.append({"n_samples": n_samples, "tolerance": tolerance, "bbox": bbox})
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def fake_openmc(monkeypatch):
    """Install a fake openmc module and return it."""
    module = ModuleType("openmc")
    module.Geometry = _FakeGeometry
    _FakeGeometry.xml_paths = []
    monkeypatch.setitem(sys.modules, "openmc", module)
    return module


@pytest.fixture
def geom_file(tmp_path):
    path = tmp_path / "geometry.xml"
    path.write_text("<geometry/>")
    return path


def _cell(cell_id, name=None):
    ns = SimpleNamespace()
    ns.id = cell_id
    if name is not None:
        ns.name = name
    return ns


# ---------------------------------------------------------------------------
# Geometry loading
# ---------------------------------------------------------------------------


def test_load_geometry_from_xml_restores_cwd(fake_openmc, geom_file):
    cwd_before = os.getcwd()
    checker = OverlapChecker(str(geom_file))

    assert isinstance(checker.geometry, _FakeGeometry)
    # from_xml received only the file name (cwd was changed to the file's dir).
    assert _FakeGeometry.xml_paths == ["geometry.xml"]
    assert os.getcwd() == cwd_before
    assert checker._geometry_dir == geom_file.parent


def test_load_geometry_from_python_module(fake_openmc, tmp_path):
    model_py = tmp_path / "model.py"
    model_py.write_text("geometry = 'sentinel-geometry'\n")

    checker = OverlapChecker(str(model_py))
    assert checker.geometry == "sentinel-geometry"


def test_load_geometry_from_python_geom_attr(fake_openmc, tmp_path):
    model_py = tmp_path / "model.py"
    model_py.write_text("geom = 'sentinel-geom'\n")

    checker = OverlapChecker(str(model_py))
    assert checker.geometry == "sentinel-geom"


def test_load_geometry_from_python_scans_for_geometry_instance(fake_openmc, tmp_path):
    """A Geometry instance under any attribute name is discovered."""
    model_py = tmp_path / "model.py"
    model_py.write_text("import openmc\nmy_model = openmc.Geometry()\n")

    checker = OverlapChecker(str(model_py))
    assert isinstance(checker.geometry, _FakeGeometry)


def test_load_geometry_from_python_without_geometry_raises(fake_openmc, tmp_path):
    model_py = tmp_path / "model.py"
    model_py.write_text("x = 1\n")

    with pytest.raises(ValueError, match="No OpenMC Geometry found"):
        OverlapChecker(str(model_py))


# ---------------------------------------------------------------------------
# find_overlaps — primary path
# ---------------------------------------------------------------------------


def test_find_overlaps_converts_results_and_reports_progress(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    cell_a = _cell(1, "fuel")
    cell_b = _cell(2)  # no name -> default label
    checker.geometry.result = [(cell_a, cell_b, np.array([0.1, 0.2, 0.3]))]

    progress_events = []
    overlaps = checker.find_overlaps(
        sample_points=500, tolerance=1e-5, progress_callback=progress_events.append
    )

    assert len(overlaps) == 1
    assert overlaps[0].coordinates == pytest.approx((0.1, 0.2, 0.3))
    assert overlaps[0].cell_ids == [1, 2]
    assert overlaps[0].cell_names == ["fuel", "Cell 2"]

    call = checker.geometry.calls[0]
    assert call["n_samples"] == 500
    assert call["tolerance"] == 1e-5
    assert call["bbox"] is None

    assert len(progress_events) == 1
    assert progress_events[0].complete is True
    assert progress_events[0].percentage == 100.0
    assert progress_events[0].current_overlaps == overlaps


def test_find_overlaps_passes_bounds(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    bounds = BoundingBox(min=(-1.0, -2.0, -3.0), max=(4.0, 5.0, 6.0))

    checker.find_overlaps(bounds=bounds)
    assert checker.geometry.calls[0]["bbox"] == ((-1.0, -2.0, -3.0), (4.0, 5.0, 6.0))


def test_find_overlaps_requires_geometry(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    checker.geometry = None
    with pytest.raises(ValueError, match="Geometry not loaded"):
        checker.find_overlaps()


# ---------------------------------------------------------------------------
# find_overlaps — manual fallback
# ---------------------------------------------------------------------------


def test_find_overlaps_manual_fallback_detects_overlap(fake_openmc, geom_file, capsys):
    checker = OverlapChecker(str(geom_file))
    checker.geometry.error = RuntimeError("no builtin")
    checker.geometry.root_universe = SimpleNamespace(
        cells={
            1: _FakeCell(1, "fuel", contains=lambda p: True),
            2: _FakeCell(2, contains=lambda p: p[0] < 0.5),
            3: _FakeCell(3, contains=lambda p: False),
        }
    )

    progress_events = []
    overlaps = checker.find_overlaps(sample_points=50, progress_callback=progress_events.append)

    assert "Falling back to manual search" in capsys.readouterr().err
    # Points with x < 0.5 are inside cells 1 and 2 simultaneously.
    assert len(overlaps) > 0
    for overlap in overlaps:
        assert overlap.cell_ids == [1, 2]
        assert overlap.cell_names == ["fuel", "Cell 2"]
    # batch_size is 1 for 50 samples, so every sample reports progress.
    assert len(progress_events) == 50
    assert progress_events[-1].checked == 50
    assert progress_events[-1].complete is False


def test_find_overlaps_manual_uses_default_bounds_for_missing_bbox(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    checker.geometry.error = RuntimeError("no builtin")
    checker.geometry.bounding_box = None

    seen = []
    checker.geometry.root_universe = SimpleNamespace(
        cells={1: _FakeCell(1, contains=lambda p: seen.append(tuple(p)) or False)}
    )
    checker.find_overlaps(sample_points=10)

    # Default bounds are +/-100 on every axis.
    assert len(seen) == 10
    for point in seen:
        assert all(-100.0 <= coord <= 100.0 for coord in point)


def test_find_overlaps_manual_uses_default_bounds_for_infinite_bbox(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    checker.geometry.error = RuntimeError("no builtin")
    checker.geometry.bounding_box = ([-np.inf, 0.0, 0.0], [np.inf, 1.0, 1.0])

    seen = []
    checker.geometry.root_universe = SimpleNamespace(
        cells={1: _FakeCell(1, contains=lambda p: seen.append(tuple(p)) or False)}
    )
    checker.find_overlaps(sample_points=5)
    assert all(-100.0 <= point[0] <= 100.0 for point in seen)


def test_find_overlaps_manual_uses_explicit_bounds(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    checker.geometry.error = RuntimeError("no builtin")

    seen = []
    checker.geometry.root_universe = SimpleNamespace(
        cells={1: _FakeCell(1, contains=lambda p: seen.append(tuple(p)) or False)}
    )
    bounds = BoundingBox(min=(10.0, 20.0, 30.0), max=(11.0, 21.0, 31.0))
    checker.find_overlaps(sample_points=5, bounds=bounds)

    for point in seen:
        assert 10.0 <= point[0] <= 11.0
        assert 20.0 <= point[1] <= 21.0
        assert 30.0 <= point[2] <= 31.0


def test_find_overlaps_manual_skips_broken_cells(fake_openmc, geom_file):
    """A cell whose __contains__ raises is skipped for that sample point."""

    class _BrokenCell:
        def __contains__(self, point):
            raise RuntimeError("broken")

    checker = OverlapChecker(str(geom_file))
    checker.geometry.error = RuntimeError("no builtin")
    checker.geometry.root_universe = SimpleNamespace(cells={1: _BrokenCell()})

    overlaps = checker.find_overlaps(sample_points=5)
    assert overlaps == []


def test_find_overlaps_manual_failure_reports_error_progress(fake_openmc, geom_file):
    """If the fallback itself fails, an error progress is emitted and re-raised."""

    class _BrokenGeometry(_FakeGeometry):
        @property
        def root_universe(self):
            raise RuntimeError("no root universe")

        @root_universe.setter
        def root_universe(self, value):
            pass

    checker = OverlapChecker(str(geom_file))
    broken = _BrokenGeometry()
    broken.error = RuntimeError("no builtin")
    checker.geometry = broken

    progress_events = []
    with pytest.raises(RuntimeError, match="no root universe"):
        checker.find_overlaps(sample_points=25, progress_callback=progress_events.append)

    assert len(progress_events) == 1
    assert progress_events[0].error == "no root universe"
    assert progress_events[0].complete is True


# ---------------------------------------------------------------------------
# get_overlap_viz_data (method and module function)
# ---------------------------------------------------------------------------


def test_checker_get_overlap_viz_data(fake_openmc, geom_file):
    checker = OverlapChecker(str(geom_file))
    overlaps = [
        OverlapResult(coordinates=(1.0, 2.0, 3.0), cell_ids=[1, 2], cell_names=["a", "b"]),
        OverlapResult(coordinates=(4.0, 5.0, 6.0), cell_ids=[2, 3], cell_names=["b", "c"]),
    ]

    data = checker.get_overlap_viz_data(overlaps, marker_size=2.5)
    assert data["markers"] == [
        {"coordinates": [1.0, 2.0, 3.0], "cellIds": [1, 2], "radius": 2.5},
        {"coordinates": [4.0, 5.0, 6.0], "cellIds": [2, 3], "radius": 2.5},
    ]
    assert sorted(data["overlappingCellIds"]) == [1, 2, 3]


def test_get_overlap_viz_data_function(fake_openmc, geom_file):
    data = get_overlap_viz_data(
        str(geom_file),
        [{"coordinates": [1, 2, 3], "cellIds": [7, 8], "cellNames": ["x", "y"]}],
        marker_size=3.0,
    )
    assert data["markers"] == [{"coordinates": [1, 2, 3], "cellIds": [7, 8], "radius": 3.0}]
    assert sorted(data["overlappingCellIds"]) == [7, 8]


def test_get_overlap_viz_data_function_error(fake_openmc, tmp_path):
    """A geometry that fails to load yields an error dict instead of raising."""

    class _FailingGeometry:
        @classmethod
        def from_xml(cls, path):
            raise RuntimeError("cannot load")

    fake_openmc.Geometry = _FailingGeometry
    geom = tmp_path / "geometry.xml"
    geom.write_text("<geometry/>")

    data = get_overlap_viz_data(str(geom), [])
    assert data["markers"] == []
    assert data["overlappingCellIds"] == []
    assert "cannot load" in data["error"]


# ---------------------------------------------------------------------------
# check_overlaps
# ---------------------------------------------------------------------------


def test_check_overlaps_creates_and_cleans_dummy_materials(
    fake_openmc, tmp_path, capsys, monkeypatch
):
    """Without materials.xml, a dummy is generated from referenced material ids."""
    geom = tmp_path / "geometry.xml"
    geom.write_text(
        "<geometry>"
        '<cell id="1" material="2" region="1"/>'
        '<cell id="2" material="void" region="-1"/>'
        '<cell id="3" material="5" region="2"/>'
        "</geometry>"
    )

    checker_geom = _FakeGeometry()
    cell_a = _cell(1, "fuel")
    cell_b = _cell(2, "clad")
    checker_geom.result = [(cell_a, cell_b, np.array([0.0, 0.0, 0.0]))]

    created_paths = []

    def _spy_from_xml(path):
        created_paths.append((tmp_path / "materials.xml").exists())
        return checker_geom

    monkeypatch.setattr(_FakeGeometry, "from_xml", _spy_from_xml)

    result = check_overlaps(
        str(geom), sample_points=100, tolerance=1e-6, bounds={"min": [0, 0, 0], "max": [1, 1, 1]}
    )

    assert result["error"] is None
    assert result["totalOverlaps"] == 1
    assert result["samplesChecked"] == 100
    assert result["overlaps"][0]["cellIds"] == [1, 2]
    assert result["overlaps"][0]["cellNames"] == ["fuel", "clad"]

    # The dummy materials.xml existed during loading but was cleaned up after.
    assert created_paths == [True]
    assert not (tmp_path / "materials.xml").exists()
    assert "Creating dummy materials.xml" in capsys.readouterr().err


def test_check_overlaps_keeps_existing_materials(fake_openmc, tmp_path):
    geom = tmp_path / "geometry.xml"
    geom.write_text("<geometry/>")
    materials = tmp_path / "materials.xml"
    materials.write_text("<materials/>")

    result = check_overlaps(str(geom), sample_points=10)
    assert result["error"] is None
    # Pre-existing materials.xml is untouched (not deleted).
    assert materials.exists()


def test_check_overlaps_python_model_skips_dummy_materials(fake_openmc, tmp_path, capsys):
    model_py = tmp_path / "model.py"
    model_py.write_text("import openmc\ngeometry = openmc.Geometry()\n")

    result = check_overlaps(str(model_py), sample_points=10)

    assert result["error"] is None
    assert "dummy materials.xml" not in capsys.readouterr().err


def test_check_overlaps_error_returns_error_dict(fake_openmc, tmp_path):
    class _FailingGeometry:
        @classmethod
        def from_xml(cls, path):
            raise RuntimeError("cannot load")

    fake_openmc.Geometry = _FailingGeometry
    geom = tmp_path / "geometry.xml"
    geom.write_text("<geometry/>")

    result = check_overlaps(str(geom))
    assert result["overlaps"] == []
    assert result["totalOverlaps"] == 0
    assert result["samplesChecked"] == 0
    assert "cannot load" in result["error"]


def test_check_overlaps_unparseable_geometry_still_writes_default_material(
    fake_openmc, tmp_path, capsys
):
    """If geometry.xml cannot be scanned for material ids, id '1' is still used."""
    geom = tmp_path / "geometry.xml"
    geom.write_bytes(b"\x00not xml\x00")

    written = {}
    original_write_text = Path.write_text

    def _spy_write_text(self, text, *args, **kwargs):
        written["text"] = text
        return original_write_text(self, text, *args, **kwargs)

    with mock.patch.object(Path, "write_text", autospec=True) as write_mock:
        write_mock.side_effect = _spy_write_text
        result = check_overlaps(str(geom), sample_points=10)

    assert result["error"] is None
    assert 'material id="1"' in written["text"]
    assert "Could not parse geometry.xml" in capsys.readouterr().err
    assert not (tmp_path / "materials.xml").exists()
