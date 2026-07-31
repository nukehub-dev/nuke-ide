"""End-to-end tests for generate_plots.py against REAL OpenMC plot mode.

All plot types render via the C++ plot mode (openmc -p) and write PNG/HDF5
without a display. The .vti conversion is gated on the vtk package (absent in
the minimal dev env, present in the docker image).
"""

import json
from types import SimpleNamespace

import pytest
from e2e_helpers import require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e

PINCELL_BOUNDS = {"lowerLeft": [-0.63, -0.63, -0.5], "upperRight": [0.63, 0.63, 0.5]}


def _run(pincell_dir, configs, convert_vtk=False):
    import generate_plots

    config_path = pincell_dir / "plots-config.json"
    config_path.write_text(json.dumps(configs))
    args = SimpleNamespace(
        working_directory=str(pincell_dir), plots_config=str(config_path), convert_vtk=convert_vtk
    )
    return generate_plots.run_generate_plots(args)


def _assert_png(path, min_size=1024):
    assert path.exists(), f"missing plot output {path}"
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    assert len(data) > min_size, f"{path} is suspiciously small ({len(data)} bytes)"


def _assert_raytrace_png(path):
    """Raytrace renders of a tiny pincell are mostly uniform background —
    a valid PNG of a few hundred bytes is expected, not a failure."""
    assert path.exists(), f"missing plot output {path}"
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    assert len(data) > 100, f"{path} is empty ({len(data)} bytes)"


@pytest.mark.e2e
def test_slice_plot_real_render(pincell_dir):
    result = _run(
        pincell_dir,
        [
            {
                "id": 1,
                "type": "slice",
                "name": "xy slice",
                "basis": "xy",
                "origin": [0, 0, 0],
                "width": 1.5,
                "pixels": [300, 300],
            }
        ],
    )

    assert result["success"] is True
    assert result["files"] == [
        {"plotId": 1, "type": "slice", "path": str(pincell_dir / "plot_1.png"), "kind": "png"}
    ]
    _assert_png(pincell_dir / "plot_1.png")


@pytest.mark.e2e
def test_voxel_plot_real_render(pincell_dir):
    result = _run(
        pincell_dir,
        [{"id": 2, "type": "voxel", "name": "vox", "voxels": [20, 20, 20], **PINCELL_BOUNDS}],
    )

    assert result["success"] is True
    h5_path = pincell_dir / "plot_2.h5"
    assert result["files"] == [{"plotId": 2, "type": "voxel", "path": str(h5_path), "kind": "h5"}]
    assert h5_path.exists() and h5_path.stat().st_size > 1024

    import h5py

    with h5py.File(h5_path, "r") as f:
        assert len(f.keys()) > 0


@pytest.mark.e2e
def test_voxel_vti_conversion(pincell_dir):
    pytest.importorskip(
        "vtk", reason="voxel_to_vtk conversion needs the vtk package (docker image provides it)"
    )
    result = _run(
        pincell_dir,
        [{"id": 2, "type": "voxel", "name": "vox", "voxels": [20, 20, 20], **PINCELL_BOUNDS}],
        convert_vtk=True,
    )

    assert result["success"] is True
    vti_path = pincell_dir / "plot_2.vti"
    kinds = {(f["plotId"], f["kind"]) for f in result["files"]}
    assert (2, "h5") in kinds and (2, "vti") in kinds
    assert vti_path.exists() and vti_path.read_text().startswith("<?xml")


@pytest.mark.e2e
def test_solid_raytrace_plot_real_render(pincell_dir):
    result = _run(
        pincell_dir,
        [
            {
                "id": 3,
                "type": "solid-raytrace",
                "name": "solid",
                "pixels": [200, 200],
                "cameraPosition": [3, 3, 3],
                "lookAt": [0, 0, 0],
            }
        ],
    )

    assert result["success"] is True
    _assert_raytrace_png(pincell_dir / "plot_3.png")


@pytest.mark.e2e
def test_wireframe_raytrace_plot_real_render(pincell_dir):
    result = _run(
        pincell_dir,
        [
            {
                "id": 4,
                "type": "wireframe-raytrace",
                "name": "wire",
                "pixels": [200, 200],
                "cameraPosition": [3, 3, 3],
                "lookAt": [0, 0, 0],
                "wireframeIds": [1],
                "colorBy": "cell",
            }
        ],
    )

    assert result["success"] is True
    _assert_raytrace_png(pincell_dir / "plot_4.png")
