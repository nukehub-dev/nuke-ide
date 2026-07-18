"""Tests for dagmc_info success paths using a stub pydagmc module.

pydagmc is replaced with a bare stub whose Model returns a prebuilt fake
model, so the volume/surface/material/group extraction and the bounding-box
aggregation run without a real .h5m file or mesh database.
"""

import json
import sys
import types

import pytest

np = pytest.importorskip("numpy")

import dagmc_info

# ---------------------------------------------------------------------------
# Fake pydagmc model objects
# ---------------------------------------------------------------------------


class FakeVolume:
    """Fake pydagmc volume with id, material, triangles, and bounds."""

    def __init__(self, vid, material=None, num_triangles=10, bounds=None, bounds_raise=False):
        self.id = vid
        self.material = material
        self.num_triangles = num_triangles
        self._bounds = bounds
        self._bounds_raise = bounds_raise

    @property
    def bounds(self):
        if self._bounds_raise:
            raise RuntimeError("bounds unavailable")
        return self._bounds


class FakeSurface:
    """Fake pydagmc surface with area and triangle count."""

    def __init__(self, sid, area=12.5, num_triangles=4, area_raise=False):
        self.id = sid
        self._area = area
        self._area_raise = area_raise
        self.num_triangles = num_triangles

    @property
    def area(self):
        if self._area_raise:
            raise RuntimeError("area unavailable")
        return self._area


class FakeModel:
    """Configurable fake for pydagmc.Model."""

    def __init__(self, volumes=(), surfaces=(), volumes_by_material=None, group_names=()):
        self.volumes = list(volumes)
        self.surfaces = list(surfaces)
        self.volumes_by_material = volumes_by_material if volumes_by_material is not None else {}
        self.group_names = list(group_names)


def _install_model(monkeypatch, model):
    """Point the stub pydagmc.Model at a prebuilt fake model."""
    fake_pydagmc = types.ModuleType("pydagmc")
    fake_pydagmc.Model = lambda path: model
    monkeypatch.setitem(sys.modules, "pydagmc", fake_pydagmc)


# ---------------------------------------------------------------------------
# get_dagmc_info
# ---------------------------------------------------------------------------


class TestGetDagmcInfoSuccess:
    def test_full_model(self, monkeypatch, tmp_path):
        """Volumes, surfaces, materials, groups, and bbox are aggregated."""
        vol1 = FakeVolume(
            1,
            material="fuel",
            num_triangles=100,
            bounds=(np.array([0.0, 0.0, 0.0]), np.array([5.0, 6.0, 7.0])),
        )
        vol2 = FakeVolume(
            2,
            material="water",
            num_triangles=50,
            bounds=(np.array([-1.0, 1.0, 2.0]), np.array([3.0, 9.0, 4.0])),
        )
        vol3 = FakeVolume(3, material=None, num_triangles=25, bounds=None)
        surf1 = FakeSurface(11, area=12.345, num_triangles=60)
        surf2 = FakeSurface(12, area=1.0, num_triangles=20, area_raise=True)
        model = FakeModel(
            volumes=[vol1, vol2, vol3],
            surfaces=[surf1, surf2],
            volumes_by_material={"fuel": [vol1], "water": [vol2], "void": [vol3]},
            group_names=["mat:fuel", "mat:water", "boundary:vacuum"],
        )
        _install_model(monkeypatch, model)
        h5m = tmp_path / "model.h5m"
        h5m.write_bytes(b"x" * 2048)

        result = dagmc_info.get_dagmc_info(str(h5m))

        assert result["success"] is True
        assert result["fileName"] == "model.h5m"
        assert result["fileSize"] == 2048
        assert result["fileSizeMB"] == 0.0
        assert result["volumeCount"] == 3
        assert result["surfaceCount"] == 2
        assert result["totalTriangles"] == 175
        # The failing area contributes 0.0 to the total.
        assert result["totalSurfaceArea"] == 12.35

        v1 = result["volumes"][0]
        assert v1["id"] == 1
        assert v1["material"] == "fuel"
        assert v1["boundingBox"] == {"min": [0.0, 0.0, 0.0], "max": [5.0, 6.0, 7.0]}
        # None material maps to "void"; None bounds stay None.
        assert result["volumes"][2]["material"] == "void"
        assert result["volumes"][2]["boundingBox"] is None

        assert result["surfaces"][0] == {"id": 11, "area": 12.35, "numTriangles": 60}
        assert result["surfaces"][1] == {"id": 12, "area": 0.0, "numTriangles": 20}

        assert result["materials"]["fuel"] == {"volumeCount": 1, "totalTriangles": 100}
        assert result["materials"]["void"] == {"volumeCount": 1, "totalTriangles": 25}
        assert result["groups"] == ["mat:fuel", "mat:water", "boundary:vacuum"]

        # Overall bbox spans the valid volume bounds only.
        assert result["boundingBox"] == {"min": [-1.0, 0.0, 0.0], "max": [5.0, 9.0, 7.0]}

    def test_empty_model_has_zero_bbox(self, monkeypatch, tmp_path):
        """A model with no volumes produces the zero bounding box."""
        _install_model(monkeypatch, FakeModel())
        h5m = tmp_path / "empty.h5m"
        h5m.write_bytes(b"x")

        result = dagmc_info.get_dagmc_info(str(h5m))

        assert result["success"] is True
        assert result["volumeCount"] == 0
        assert result["totalTriangles"] == 0
        assert result["boundingBox"] == {"min": [0, 0, 0], "max": [0, 0, 0]}

    def test_all_invalid_bounds_gives_zero_bbox(self, monkeypatch, tmp_path):
        """When no volume has usable bounds, the bbox falls back to zeros."""
        vol = FakeVolume(1, bounds=None)
        _install_model(monkeypatch, FakeModel(volumes=[vol]))
        h5m = tmp_path / "m.h5m"
        h5m.write_bytes(b"x")

        result = dagmc_info.get_dagmc_info(str(h5m))

        assert result["boundingBox"] == {"min": [0, 0, 0], "max": [0, 0, 0]}

    def test_raising_bounds_breaks_aggregate_bbox(self, monkeypatch, tmp_path):
        """A volume whose bounds raise per-volume is fine, but the aggregate
        bounding-box pass has no guard and surfaces the error dict."""
        vol_ok = FakeVolume(
            1,
            num_triangles=10,
            bounds=(np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])),
        )
        vol_bad = FakeVolume(2, num_triangles=5, bounds_raise=True)
        _install_model(monkeypatch, FakeModel(volumes=[vol_ok, vol_bad]))
        h5m = tmp_path / "m.h5m"
        h5m.write_bytes(b"x")

        result = dagmc_info.get_dagmc_info(str(h5m))

        assert result["success"] is False
        assert "bounds unavailable" in result["error"]

    def test_model_load_failure_returns_error(self, monkeypatch, tmp_path):
        """A Model constructor failure yields an error dict with a traceback."""
        fake_pydagmc = types.ModuleType("pydagmc")

        def boom(path):
            raise RuntimeError("not a DAGMC file")

        fake_pydagmc.Model = boom
        monkeypatch.setitem(sys.modules, "pydagmc", fake_pydagmc)
        h5m = tmp_path / "broken.h5m"
        h5m.write_bytes(b"x")

        result = dagmc_info.get_dagmc_info(str(h5m))

        assert result["success"] is False
        assert result["error"] == "Error reading DAGMC file: not a DAGMC file"
        assert "traceback" in result


# ---------------------------------------------------------------------------
# main() output on success
# ---------------------------------------------------------------------------


class TestMainSuccess:
    def _model(self):
        vol = FakeVolume(
            1,
            material="fuel",
            num_triangles=100,
            bounds=(np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])),
        )
        return FakeModel(
            volumes=[vol],
            surfaces=[FakeSurface(1, area=4.0, num_triangles=100)],
            volumes_by_material={"fuel": [vol]},
            group_names=["mat:fuel"],
        )

    def test_pretty_output_on_success(self, monkeypatch, capsys, tmp_path):
        """The human-readable summary prints model statistics."""
        _install_model(monkeypatch, self._model())
        h5m = tmp_path / "model.h5m"
        h5m.write_bytes(b"x")
        monkeypatch.setattr(sys, "argv", ["dagmc_info.py", str(h5m)])

        dagmc_info.main()

        out = capsys.readouterr().out
        assert "DAGMC File: model.h5m" in out
        assert "Volumes: 1" in out
        assert "Surfaces: 1" in out
        assert "Total Triangles: 100" in out
        assert "fuel: 1 volumes, 100 triangles" in out
        assert "Bounding Box" in out

    def test_json_output_on_success_exits_0(self, monkeypatch, capsys, tmp_path):
        """--output-json prints the info dict and does not exit."""
        _install_model(monkeypatch, self._model())
        h5m = tmp_path / "model.h5m"
        h5m.write_bytes(b"x")
        monkeypatch.setattr(sys, "argv", ["dagmc_info.py", str(h5m), "--output-json"])

        dagmc_info.main()

        out = json.loads(capsys.readouterr().out)
        assert out["success"] is True
        assert out["fileName"] == "model.h5m"
