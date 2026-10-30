"""Edge-case tests for dagmc_editor_service helpers.

Covers the nuke-cad script discovery, bbox-center material mapping, and the
nuke-cad refacet delegation with a fake pydagmc model and subprocess. The
``des`` fixture and fake model pieces are shared with
test_dagmc_editor_service.py; no real .h5m files or subprocesses are used.
"""

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_dagmc_editor_service import (
    FakeMB,
    FakeSurface,
    FakeVolume,
)


@pytest.fixture()
def des():
    """Import dagmc_editor_service with a stubbed pydagmc module; restore after."""
    stub = types.ModuleType("pydagmc")
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


@pytest.fixture()
def isolated_nuke_cad_lookup(des, monkeypatch, tmp_path):
    """Point the module-relative and sys.path probes at empty temp locations."""
    monkeypatch.delenv("NUKE_CAD_DAGMC_EXPORT", raising=False)
    monkeypatch.setattr(
        des, "__file__", str(tmp_path / "package" / "python" / "dagmc_editor_service.py")
    )
    monkeypatch.setattr(sys, "path", [str(tmp_path / "empty")])
    return tmp_path


# ---------------------------------------------------------------------------
# _find_nuke_cad_dagmc_export
# ---------------------------------------------------------------------------


class TestFindNukeCadExport:
    def test_environment_override_wins(self, des, monkeypatch, tmp_path):
        """An existing NUKE_CAD_DAGMC_EXPORT path is returned as-is."""
        script = tmp_path / "custom_dagmc_export.py"
        script.write_text("")
        monkeypatch.setenv("NUKE_CAD_DAGMC_EXPORT", str(script))

        assert des._find_nuke_cad_dagmc_export() == str(script)

    def test_missing_environment_path_falls_through(self, des, monkeypatch, tmp_path):
        """A non-existent override is ignored in favor of the layout probe."""
        monkeypatch.setenv("NUKE_CAD_DAGMC_EXPORT", str(tmp_path / "missing.py"))
        monkeypatch.setattr(
            des, "__file__", str(tmp_path / "package" / "python" / "dagmc_editor_service.py")
        )
        (tmp_path / "package" / "python").mkdir(parents=True)
        script = tmp_path / "nuke-cad" / "python" / "dagmc_export.py"
        script.parent.mkdir(parents=True)
        script.write_text("")

        result = des._find_nuke_cad_dagmc_export()

        assert result is not None
        assert Path(result).resolve() == script.resolve()

    def test_sys_path_fallback(self, des, isolated_nuke_cad_lookup, monkeypatch):
        """When the sibling layout is absent, sys.path entries are searched."""
        root = isolated_nuke_cad_lookup / "installed"
        script = root / "nuke-cad" / "python" / "dagmc_export.py"
        script.parent.mkdir(parents=True)
        script.write_text("")
        monkeypatch.setattr(sys, "path", [str(root)])

        assert des._find_nuke_cad_dagmc_export() == str(script)

    def test_returns_none_when_nothing_matches(self, des, isolated_nuke_cad_lookup):
        """No override, sibling layout, or sys.path hit returns None."""
        assert des._find_nuke_cad_dagmc_export() is None


# ---------------------------------------------------------------------------
# _bbox_center / _map_materials_by_proximity
# ---------------------------------------------------------------------------


class TestMapMaterialsByProximity:
    def test_bbox_center_is_the_midpoint(self, des):
        center = des._bbox_center(([0.0, 2.0, 4.0], [2.0, 6.0, 10.0]))
        assert center.tolist() == [1.0, 4.0, 7.0]

    def test_no_old_bboxes_maps_nothing(self, des):
        """Without old bounding boxes the mapper is a no-op."""
        model = SimpleNamespace(volumes=[FakeVolume(1, material="old")])

        assert des._map_materials_by_proximity(model, {}, {}) == (0, [])

    def test_nearest_center_material_is_assigned(self, des):
        """The new volume receives the nearest old volume's material."""
        new_vol = FakeVolume(
            1,
            material="placeholder",
            surfaces=[FakeSurface([[10.0, 10.0, 10.0], [11.0, 11.0, 11.0]])],
        )
        empty_vol = FakeVolume(2, material="placeholder", surfaces=[])
        model = SimpleNamespace(volumes=[new_vol, empty_vol])
        old_bboxes = {
            7: ([20.0, 20.0, 20.0], [21.0, 21.0, 21.0]),
            8: ([10.5, 10.5, 10.5], [10.5, 10.5, 10.5]),
        }
        old_materials = {7: "steel", 8: "fuel"}

        matched, warnings = des._map_materials_by_proximity(model, old_bboxes, old_materials)

        assert matched == 1
        assert any("Volume 2" in warning and "bounding box" in warning for warning in warnings)
        assert new_vol.material == "fuel"
        # A volume without readable geometry is skipped, not counted.
        assert empty_vol.material == "placeholder"

    def test_unknown_nearest_material_is_not_counted(self, des):
        """A nearest old volume with no material leaves the new volume alone."""
        new_vol = FakeVolume(1, material=None, surfaces=[FakeSurface([[0.0, 0.0, 0.0]])])
        model = SimpleNamespace(volumes=[new_vol])

        matched, warnings = des._map_materials_by_proximity(
            model, {3: ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0])}, {3: None}
        )

        assert matched == 0
        assert any("no material" in warning for warning in warnings)
        assert new_vol.material is None


# ---------------------------------------------------------------------------
# _refacet_with_nuke_cad
# ---------------------------------------------------------------------------


class _RefacetModel:
    """Fake pydagmc model returned after the nuke-cad export."""

    def __init__(self, volumes):
        self.volumes = list(volumes)
        self.mb = FakeMB()


def _successful_run(des, monkeypatch, model, matched=1):
    """Patch discovery/subprocess/Model and the proximity mapper."""
    monkeypatch.setattr(des, "_find_nuke_cad_dagmc_export", lambda: "/fake/dagmc_export.py")
    monkeypatch.setattr(
        des.subprocess,
        "run",
        lambda args, capture_output, text: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )
    monkeypatch.setattr(des, "Model", lambda path: model)
    monkeypatch.setattr(
        des, "_map_materials_by_proximity", lambda new_model, bboxes, mats: (matched, [])
    )


class TestRefacetWithNukeCad:
    def test_missing_script_raises(self, des, monkeypatch):
        """Discovery failure is reported with the override hint."""
        monkeypatch.setattr(des, "_find_nuke_cad_dagmc_export", lambda: None)
        with pytest.raises(RuntimeError, match="nuke-cad dagmc_export.py not found"):
            des._refacet_with_nuke_cad("model.step", "temp.h5m", 0.1, "old.h5m", {}, {})

    @pytest.mark.parametrize(
        ("stderr", "stdout", "expected"),
        [
            ("export failed", "", "export failed"),
            ("", "stdout detail", "stdout detail"),
            ("", "", "nuke-cad dagmc_export.py failed"),
        ],
    )
    def test_export_failure_detail_precedence(self, des, monkeypatch, stderr, stdout, expected):
        """stderr wins, then stdout, then a generic message."""
        monkeypatch.setattr(des, "_find_nuke_cad_dagmc_export", lambda: "/fake/script.py")
        monkeypatch.setattr(
            des.subprocess,
            "run",
            lambda args, capture_output, text: SimpleNamespace(
                returncode=1, stdout=stdout, stderr=stderr
            ),
        )
        with pytest.raises(RuntimeError, match=expected):
            des._refacet_with_nuke_cad("model.step", "temp.h5m", 0.1, "old.h5m", {}, {})

    def test_success_counts_volumes_triangles_and_vertices(self, des, monkeypatch):
        """A successful export maps materials and counts the new mesh."""
        volume = FakeVolume(
            1,
            num_triangles=4,
            surfaces=[FakeSurface([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]), FakeSurface(raises=True)],
        )
        model = _RefacetModel([volume])
        _successful_run(des, monkeypatch, model)

        assert des._refacet_with_nuke_cad("model.step", "temp.h5m", 0.1, "old.h5m", {}, {}) == (
            1,
            3,
            4,
        )
        assert model.mb.calls == [("write_file", "temp.h5m")]

    def test_export_invocation_arguments(self, des, monkeypatch):
        """The nuke-cad script receives source, output, and tolerance."""
        model = _RefacetModel([FakeVolume(1, num_triangles=1, surfaces=[])])
        _successful_run(des, monkeypatch, model)
        calls = []
        monkeypatch.setattr(
            des.subprocess,
            "run",
            lambda args, capture_output, text: (
                calls.append(list(args)) or SimpleNamespace(returncode=0, stdout="", stderr="")
            ),
        )

        des._refacet_with_nuke_cad("model.step", "temp.h5m", 0.25, "old.h5m", {}, {})

        assert calls == [
            [
                sys.executable,
                "/fake/dagmc_export.py",
                "model.step",
                "--output",
                "temp.h5m",
                "--tolerance",
                "0.25",
            ]
        ]

    def test_material_mapping_mismatch_raises(self, des, monkeypatch):
        """Every new volume must receive a material or the export is rejected."""
        model = _RefacetModel([FakeVolume(1, surfaces=[])])
        _successful_run(des, monkeypatch, model, matched=0)

        with pytest.raises(RuntimeError, match="Material mapping mismatch: matched 0 of 1"):
            des._refacet_with_nuke_cad("model.step", "temp.h5m", 0.1, "old.h5m", {}, {})
