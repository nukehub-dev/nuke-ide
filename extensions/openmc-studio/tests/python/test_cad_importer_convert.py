"""Tests for cad_importer.convert_cad_to_openmc and main().

gmsh is replaced with a recording fake and the cad_conversion collaborators
(nurbs detection, DAGMC conversion, surface extraction) are stubbed at the
module boundary, so the whole conversion orchestration runs without a CAD
kernel. merge_coplanar_surfaces and _map_surface_type_to_openmc run for real.
"""

import json
import sys
from types import SimpleNamespace

import cad_importer
import pytest
from cad_conversion.core import SurfaceFitResult


@pytest.fixture()
def fake_gmsh(monkeypatch):
    """Install a recording fake gmsh and flip HAS_GMSH on."""
    calls = []

    class FakeOption:
        def setNumber(self, *args):
            pass

    class FakeGmsh:
        model = SimpleNamespace()
        option = FakeOption()

        def initialize(self):
            calls.append("initialize")

        def finalize(self):
            calls.append("finalize")

        def open(self, path):
            calls.append(("open", path))

    gmsh = FakeGmsh()
    monkeypatch.setattr(cad_importer.gmsh_utils, "HAS_GMSH", True)
    monkeypatch.setattr(cad_importer.gmsh_utils, "gmsh", gmsh)
    gmsh.calls = calls
    return gmsh


def _plane_result(coeffs=(0.0, 0.0, 1.0, -4.0), warning=None):
    return SurfaceFitResult(
        surface_type="plane",
        coefficients=list(coeffs),
        max_deviation=0.0001,
        center=[0.0, 0.0, 4.0],
        axis=[0.0, 0.0, 1.0],
        warning=warning,
    )


# ---------------------------------------------------------------------------
# DAGMC fallback path
# ---------------------------------------------------------------------------


class TestDagmcFallback:
    def test_nurbs_triggers_dagmc_fallback(self, fake_gmsh, monkeypatch):
        """Detected NURBS route to DAGMC conversion with file info and bbox."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: True)
        monkeypatch.setattr(
            cad_importer.nurbs_handler,
            "convert_to_dagmc",
            lambda *a, **k: {"success": True, "output_path": "/tmp/out.h5m", "warnings": ["dw"]},
        )
        monkeypatch.setattr(
            cad_importer.gmsh_utils,
            "get_all_entities",
            lambda: [(3, 1), (2, 5), (2, 6), (1, 3)],
        )
        monkeypatch.setattr(
            cad_importer.gmsh_utils, "get_bounding_box", lambda d, t: (0, 0, 0, 10, 20, 30)
        )

        result = cad_importer.convert_cad_to_openmc("model.step", unit_factor=2.0)

        assert result["success"] is True
        assert result["dagmc"] is True
        assert result["dagmcFile"] == "/tmp/out.h5m"
        assert result["nurbsDetected"] is True
        assert result["fileInfo"] == {
            "solidCount": 1,
            "faceCount": 2,
            "edgeCount": 1,
            "dagmc": True,
            "dagmcOutput": "/tmp/out.h5m",
        }
        # The bounding box is scaled by the unit factor.
        assert result["boundingBox"] == {"min": [0, 0, 0], "max": [20, 40, 60]}
        assert "NURBS or free-form surfaces detected" in result["warnings"][0]
        assert "dw" in result["warnings"]
        assert fake_gmsh.calls[0] == "initialize"
        assert fake_gmsh.calls[-1] == "finalize"

    def test_force_dagmc_without_nurbs(self, fake_gmsh, monkeypatch):
        """force_dagmc routes to DAGMC even when no NURBS are found."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: False)
        monkeypatch.setattr(
            cad_importer.nurbs_handler,
            "convert_to_dagmc",
            lambda *a, **k: {"success": True, "output_path": "/tmp/out.h5m", "warnings": []},
        )
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_all_entities", lambda: [])
        monkeypatch.setattr(
            cad_importer.gmsh_utils, "get_bounding_box", lambda d, t: (0, 0, 0, 1, 1, 1)
        )

        result = cad_importer.convert_cad_to_openmc("model.step", force_dagmc=True)

        assert result["success"] is True
        assert result["dagmc"] is True
        assert result["nurbsDetected"] is False

    def test_force_csg_skips_nurbs_detection(self, fake_gmsh, monkeypatch):
        """force_csg never calls the NURBS detector and takes the CSG path."""

        def detector_should_not_run(path):
            raise AssertionError("detector ran")

        monkeypatch.setattr(
            cad_importer.nurbs_handler, "has_nurbs_surfaces", detector_should_not_run
        )
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_all_entities", lambda: [(3, 1)])
        monkeypatch.setattr(
            cad_importer.gmsh_utils, "get_bounding_box", lambda d, t: (0, 0, 0, 1, 1, 1)
        )
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_boundary", lambda *a, **k: [])

        result = cad_importer.convert_cad_to_openmc("model.step", force_csg=True)

        assert result["success"] is True
        assert result["dagmc"] is False
        assert result["nurbsDetected"] is False

    def test_dagmc_conversion_failure(self, fake_gmsh, monkeypatch):
        """A failed DAGMC conversion surfaces its error message."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: True)
        monkeypatch.setattr(
            cad_importer.nurbs_handler,
            "convert_to_dagmc",
            lambda *a, **k: {"success": False, "error": "no pymoab"},
        )

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is False
        assert result["error"] == "no pymoab"

    def test_dagmc_fileinfo_failure_is_swallowed(self, fake_gmsh, monkeypatch):
        """A gmsh failure during file-info collection does not fail the run."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: True)
        monkeypatch.setattr(
            cad_importer.nurbs_handler,
            "convert_to_dagmc",
            lambda *a, **k: {"success": True, "output_path": "/tmp/out.h5m"},
        )

        def bad_open(path):
            raise RuntimeError("gmsh exploded")

        monkeypatch.setattr(fake_gmsh, "open", bad_open)

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is True
        assert result["dagmc"] is True
        assert "fileInfo" not in result

    def test_nurbs_detection_failure_warns_and_continues(self, fake_gmsh, monkeypatch):
        """A raising NURBS detector adds a warning and falls through to CSG."""

        def bad_detector(path):
            raise RuntimeError("detector broke")

        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", bad_detector)
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_all_entities", lambda: [(3, 1)])
        monkeypatch.setattr(
            cad_importer.gmsh_utils, "get_bounding_box", lambda d, t: (0, 0, 0, 1, 1, 1)
        )
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_boundary", lambda *a, **k: [])

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is True
        assert result["dagmc"] is False
        assert any("NURBS detection failed: detector broke" in w for w in result["warnings"])


# ---------------------------------------------------------------------------
# CSG conversion path
# ---------------------------------------------------------------------------


class TestCsgConversion:
    def _setup_csg(self, monkeypatch, boundary, extract):
        """Wire the CSG-path collaborators for one solid with signed faces."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: False)
        monkeypatch.setattr(
            cad_importer.gmsh_utils,
            "get_all_entities",
            lambda: [(3, 1), (2, 5), (2, 7), (1, 3)],
        )
        monkeypatch.setattr(
            cad_importer.gmsh_utils, "get_bounding_box", lambda d, t: (0, 0, 0, 10, 20, 30)
        )
        monkeypatch.setattr(cad_importer.gmsh_utils, "get_boundary", lambda *a, **k: boundary)
        monkeypatch.setattr(cad_importer.surface_extractor, "extract_surface_from_entity", extract)

    def test_csg_conversion_builds_surfaces_and_cell(self, fake_gmsh, monkeypatch):
        """Signed boundary faces become surfaces plus a half-space region."""
        results = {5: _plane_result(), 7: _plane_result((0.0, 0.0, 1.0, -4.0), warning="approx")}
        self._setup_csg(
            monkeypatch,
            boundary=[(2, 5), (2, -7), (1, 3)],
            extract=lambda dim, tag, tol, uf, fp: results.get(tag),
        )

        result = cad_importer.convert_cad_to_openmc(
            "model.step", unit_factor=2.0, material_id=7, universe_id=3
        )

        assert result["success"] is True
        assert result["fileInfo"] == {
            "solidCount": 1,
            "faceCount": 2,
            "edgeCount": 1,
            "dagmc": False,
        }
        assert result["boundingBox"] == {"min": [0, 0, 0], "max": [20, 40, 60]}

        # Both faces are the same plane -> merged into one surface entry.
        assert len(result["surfaces"]) == 1
        assert result["surfaces"][0]["_merged_ids"] == [1, 2]
        assert result["summary"]["surfacesCreated"] == 1
        assert result["summary"]["cellsCreated"] == 1
        assert result["summary"]["approximationsMade"] == 1

        (cell,) = result["cells"]
        assert cell["name"] == "cell_solid_1"
        assert cell["material"] == "7"
        assert cell["universe"] == 3
        # Positive signed tag -> '-', negative -> '+'.
        assert set(cell["region"].split(" & ")) == {"-1", "+2"}

        assert any("Surface -7: approx" in w for w in result["warnings"])

    def test_csg_default_material_is_void(self, fake_gmsh, monkeypatch):
        """Without a material id, the cell material is 'void'."""
        self._setup_csg(
            monkeypatch,
            boundary=[(2, 5)],
            extract=lambda dim, tag, tol, uf, fp: _plane_result(),
        )

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["cells"][0]["material"] == "void"

    def test_unfittable_surface_warns_and_is_skipped(self, fake_gmsh, monkeypatch):
        """A face that fits nothing is skipped with a warning."""
        self._setup_csg(
            monkeypatch,
            boundary=[(2, 5), (2, 7)],
            extract=lambda dim, tag, tol, uf, fp: _plane_result() if tag == 5 else None,
        )

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is True
        assert len(result["surfaces"]) == 1
        assert any("could not fit any analytic primitive" in w for w in result["warnings"])

    def test_solid_with_no_fittable_surfaces_gets_no_cell(self, fake_gmsh, monkeypatch):
        """A solid whose faces all fail produces no cell entry."""
        self._setup_csg(
            monkeypatch,
            boundary=[(2, 5)],
            extract=lambda dim, tag, tol, uf, fp: None,
        )

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is True
        assert result["cells"] == []
        assert result["summary"]["cellsCreated"] == 0

    def test_gmsh_open_failure(self, fake_gmsh, monkeypatch):
        """A gmsh open failure returns a clear error and finalizes gmsh."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: False)

        def bad_open(path):
            raise RuntimeError("cannot parse STEP")

        monkeypatch.setattr(fake_gmsh, "open", bad_open)

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result == {"success": False, "error": "Failed to open CAD file: cannot parse STEP"}
        assert fake_gmsh.calls[-1] == "finalize"

    def test_extraction_failure_returns_error(self, fake_gmsh, monkeypatch):
        """An unexpected error in the extraction loop returns an error dict."""
        monkeypatch.setattr(cad_importer.nurbs_handler, "has_nurbs_surfaces", lambda p: False)

        def bad_entities():
            raise RuntimeError("topology corrupt")

        monkeypatch.setattr(cad_importer.gmsh_utils, "get_all_entities", bad_entities)

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["success"] is False
        assert result["error"] == "Geometry extraction failed: topology corrupt"
        assert result["warnings"] == []
        assert fake_gmsh.calls[-1] == "finalize"

    def test_cylinder_axis_mapping_applied(self, fake_gmsh, monkeypatch):
        """Fitted cylinders are mapped through _map_surface_type_to_openmc."""
        cyl = SurfaceFitResult(
            surface_type="cylinder",
            coefficients=[1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0],
            max_deviation=0.0001,
        )
        self._setup_csg(
            monkeypatch,
            boundary=[(2, 5)],
            extract=lambda dim, tag, tol, uf, fp: cyl,
        )

        result = cad_importer.convert_cad_to_openmc("model.step")

        assert result["surfaces"][0]["type"] == "z-cylinder"


# ---------------------------------------------------------------------------
# main() CLI
# ---------------------------------------------------------------------------


class TestMain:
    def _success_result(self):
        return {
            "success": True,
            "surfaces": [],
            "cells": [],
            "warnings": [],
            "summary": {"surfacesCreated": 2, "cellsCreated": 1, "approximationsMade": 0},
            "dagmc": False,
            "dagmcFile": None,
            "nurbsDetected": False,
        }

    def test_output_json(self, monkeypatch, capsys):
        """--output-json writes the raw result JSON to stdout."""
        captured = {}

        def fake_convert(file_path, **kwargs):
            captured.update(file=file_path, **kwargs)
            return self._success_result()

        monkeypatch.setattr(cad_importer, "convert_cad_to_openmc", fake_convert)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "cad_importer.py",
                "in.step",
                "--unit-factor",
                "2",
                "--scale",
                "3",
                "--tolerance",
                "0.01",
                "--material-id",
                "9",
                "--universe-id",
                "4",
                "--faceting-tol",
                "0.05",
                "--no-auto-adjust-tol",
                "--output-json",
            ],
        )

        cad_importer.main()

        out = json.loads(capsys.readouterr().out)
        assert out["success"] is True
        # unit_factor and scale multiply together.
        assert captured["unit_factor"] == 6.0
        assert captured["tolerance"] == 0.01
        assert captured["material_id"] == 9
        assert captured["universe_id"] == 4
        assert captured["faceting_tolerance"] == 0.05
        assert captured["auto_adjust_tolerance"] is False
        assert captured["force_dagmc"] is False
        assert captured["force_csg"] is False

    def test_pretty_success_output(self, monkeypatch, capsys):
        """The default output prints a success summary."""
        result = self._success_result()
        result["dagmc"] = True
        result["dagmcFile"] = "/tmp/out.h5m"
        result["warnings"] = [f"w{i}" for i in range(12)]
        monkeypatch.setattr(cad_importer, "convert_cad_to_openmc", lambda *a, **k: result)
        monkeypatch.setattr(sys, "argv", ["cad_importer.py", "in.step"])

        cad_importer.main()

        out = capsys.readouterr().out
        assert "Successfully converted CAD file" in out
        assert "DAGMC output: /tmp/out.h5m" in out
        assert "Surfaces created: 2" in out
        assert "Cells created: 1" in out
        # Only the first 10 warnings print, with a remainder note.
        assert "  - w9" in out
        assert "  - w10" not in out
        assert "... and 2 more" in out

    def test_pretty_failure_exits_1(self, monkeypatch, capsys):
        """A failed conversion prints the error and exits 1."""
        monkeypatch.setattr(
            cad_importer,
            "convert_cad_to_openmc",
            lambda *a, **k: {"success": False, "error": "gmsh not available"},
        )
        monkeypatch.setattr(sys, "argv", ["cad_importer.py", "in.step"])

        with pytest.raises(SystemExit) as exc:
            cad_importer.main()

        assert exc.value.code == 1
        assert "Error: gmsh not available" in capsys.readouterr().out
