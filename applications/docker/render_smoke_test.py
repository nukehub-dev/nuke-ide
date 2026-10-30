#!/usr/bin/env python3
"""Native-extract smoke test for the all-in-one image.

The docker CI job's import check proves the Python environment exists and the
HTTP check proves the IDE boots; neither proves the headless converter seam
that nuke-visualizer's native three.js viewers depend on actually works. This
script exercises that seam against whatever versions the image ships:

1. ``vtk`` imports (every converter lazily imports it for the final write).
2. A synthetic ``tracks.h5`` (OpenMC track-writer layout) converts to a
   non-empty ``.vtp`` through the repo's own ``tracks_to_vtk`` converter,
   and the output reads back with the expected point/line counts.
3. The same conversion runs end to end through the ``server.py``
   ``openmc.tracks-vtk`` CLI — the exact headless path the IDE backend
   invokes (convert, no server, no port).

Run inside the image from the repo root:

    python applications/docker/render_smoke_test.py

Exit code 0 means the converter seam is intact; any failure raises and the
script exits non-zero.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# Headless Qt for any vtk import that touches rendering modules. Converters
# never create a render window, so no DISPLAY handling is needed.
os.environ["QT_QPA_PLATFORM"] = "offscreen"

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_DIR = REPO_ROOT / "extensions" / "nuke-visualizer" / "python"
sys.path.insert(0, str(PYTHON_DIR))

import numpy as np  # noqa: E402

TRACKS_H5 = Path("/tmp/nuke_extract_smoke_tracks.h5")
VTP_OUT = Path("/tmp/nuke_extract_smoke_tracks.vtp")
VTP_CLI_OUT = Path("/tmp/nuke_extract_smoke_cli.vtp")


def _track_dtype():
    """OpenMC TrackState layout (mirrors the writer; see output_readers)."""
    pos = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    return np.dtype(
        [
            ("r", pos),
            ("u", pos),
            ("E", "<f8"),
            ("time", "<f8"),
            ("wgt", "<f8"),
            ("cell_id", "<i4"),
            ("cell_instance", "<i4"),
            ("material_id", "<i4"),
        ]
    )


def _make_states(n, x0=0.0):
    states = np.zeros(n, dtype=_track_dtype())
    states["r"]["x"] = x0 + np.arange(n, dtype=float)
    states["r"]["y"] = 1.0
    states["r"]["z"] = 2.0
    states["u"]["z"] = 1.0
    states["E"] = 1.0e6
    states["time"] = np.arange(n, dtype=float) * 1e-9
    states["wgt"] = 1.0
    states["cell_id"] = 5
    return states


def write_synthetic_tracks(path):
    """Write a two-track tracks.h5: neutron+photon, then neutron only."""
    import h5py

    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "track"
        f.attrs["version"] = [3, 1]
        for name, segments in (
            ("track_1_1_0", [(2112, _make_states(10)), (22, _make_states(5, x0=100.0))]),
            ("track_1_2_7", [(2112, _make_states(4, x0=200.0))]),
        ):
            offsets = [0]
            particles = []
            arrays = []
            for pdg, states in segments:
                particles.append(pdg)
                arrays.append(states)
                offsets.append(offsets[-1] + len(states))
            dset = f.create_dataset(name, data=np.concatenate(arrays))
            dset.attrs["n_particles"] = len(segments)
            dset.attrs["offsets"] = offsets
            dset.attrs["particles"] = particles


def check_vtk_available():
    import vtk

    print(f"ok: vtk {vtk.vtkVersion.GetVTKVersion()} imports")
    return vtk


def check_library_convert():
    """tracks.h5 -> .vtp through the repo's own converter, read back via vtk."""
    from plugins.openmc.lib import output_vtk
    from vtkmodules.vtkIOXML import vtkXMLPolyDataReader

    write_synthetic_tracks(TRACKS_H5)
    if VTP_OUT.exists():
        VTP_OUT.unlink()
    result = output_vtk.tracks_to_vtk(str(TRACKS_H5), output_path=str(VTP_OUT))
    assert VTP_OUT.exists() and VTP_OUT.stat().st_size > 0, "converter wrote no output"
    assert result["convertedTracks"] == 2, f"expected 2 tracks, got {result}"

    reader = vtkXMLPolyDataReader()
    reader.SetFileName(str(VTP_OUT))
    reader.Update()
    poly = reader.GetOutput()
    assert poly.GetNumberOfPoints() == result["nPoints"] > 0, "round-trip lost points"
    assert poly.GetNumberOfLines() == result["nLines"] > 0, "round-trip lost lines"
    print(
        f"ok: library convert ({result['convertedTracks']} tracks, "
        f"{result['nPoints']} points -> {VTP_OUT.stat().st_size} bytes)"
    )


def check_cli_convert():
    """Same conversion through server.py: convert, no server, no port."""
    if VTP_CLI_OUT.exists():
        VTP_CLI_OUT.unlink()
    proc = subprocess.run(
        [
            sys.executable,
            str(PYTHON_DIR / "server.py"),
            "openmc.tracks-vtk",
            str(TRACKS_H5),
            "--output",
            str(VTP_CLI_OUT),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, f"tracks-vtk CLI failed: {proc.stderr[-2000:]}"
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert "error" not in payload, f"tracks-vtk CLI error: {payload['error']}"
    assert VTP_CLI_OUT.exists() and VTP_CLI_OUT.stat().st_size > 0, "CLI wrote no output"
    print(f"ok: CLI convert ({payload['convertedTracks']} tracks -> {VTP_CLI_OUT.name})")


def main():
    check_vtk_available()
    try:
        import openmc

        print(f"openmc {openmc.__version__}")
    except ImportError:
        print("openmc not installed (optional for this check)")
    check_library_convert()
    check_cli_convert()
    print("native-extract smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
