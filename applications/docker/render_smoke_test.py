#!/usr/bin/env python3
"""Functional rendering smoke test for the all-in-one image.

The docker CI job's import check proves the Python environment exists and the
HTTP check proves the IDE boots; neither proves the trame/ParaView/VTK seam
that nuke-visualizer depends on actually renders. This script exercises that
seam against whatever versions the image ships:

1. ParaView boots in batch mode and renders offscreen (the GL stack works).
2. ParaView's composite pipeline output (vtkPartitionedDataSetCollection,
   which ParaView 6 feeds to its composite mappers) serializes to non-empty
   geometry through trame-vtk's real serializer pipeline once
   plugins.base.lib.common has registered its composite serializers — the
   exact path local (vtk.js) rendering uses, which silently drops every
   actor when no serializer matches.
3. VtkRemoteLocalView still accepts the arguments create_view_widget passes
   (trame-vtk API compatibility).

Run inside the image from the repo root:

    python applications/docker/render_smoke_test.py

Exit code 0 means the rendering seam is intact; any failure raises and the
script exits non-zero.
"""

import os
import sys
from pathlib import Path

# Headless setup mirroring plugins/base/commands/serve.py: only clear DISPLAY
# when unset (containers may provide Xvfb); keep Qt offscreen.
if "DISPLAY" not in os.environ:
    os.environ["DISPLAY"] = ""
os.environ["QT_QPA_PLATFORM"] = "offscreen"

import paraview  # noqa: E402

paraview.options.batch = True

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "extensions" / "nuke-visualizer" / "python"))

import vtkmodules.all  # noqa: E402,F401 — probe: the full vtkmodules namespace must import
from paraview import simple  # noqa: E402
from paraview.servermanager import Fetch  # noqa: E402
from vtkmodules.vtkCommonDataModel import (  # noqa: E402
    vtkPartitionedDataSet,
    vtkPartitionedDataSetCollection,
)
from vtkmodules.vtkRenderingCore import vtkActor, vtkRenderer, vtkRenderWindow  # noqa: E402

# VTK >= 9.6 renamed vtkCompositePolyDataMapper2 to vtkCompositePolyDataMapper.
try:
    from vtkmodules.vtkRenderingOpenGL2 import (  # noqa: E402
        vtkCompositePolyDataMapper2 as vtkCompositeMapper,
    )
except ImportError:
    from vtkmodules.vtkRenderingCore import (  # noqa: E402
        vtkCompositePolyDataMapper as vtkCompositeMapper,
    )


def _find_meshes(node):
    """Yield every serialized node that carries point geometry."""
    if isinstance(node, dict):
        points = node.get("properties", {}).get("points")
        if points:
            yield node
        for dependency in node.get("dependencies", []):
            yield from _find_meshes(dependency)


def check_paraview_offscreen_render():
    """ParaView renders offscreen and produces a non-empty screenshot."""
    sphere = simple.Sphere(ThetaResolution=16, PhiResolution=16)
    view = simple.CreateRenderView()
    simple.Show(sphere, view)
    simple.Render(view)
    shot = Path("/tmp/nuke_render_smoke.png")
    simple.SaveScreenshot(str(shot), view)
    assert shot.exists() and shot.stat().st_size > 0, "offscreen screenshot is empty"
    print("ok: ParaView offscreen render")


def check_composite_serialization():
    """Composite ParaView output survives the trame-vtk serializer pipeline."""
    from plugins.base.lib.common import _register_composite_data_serializers
    from trame_vtk.modules.vtk.serializers import SynchronizationContext, serialize
    from trame_vtk.modules.vtk.serializers.registry import SERIALIZERS

    _register_composite_data_serializers()
    for class_name in ("vtkPartitionedDataSetCollection", "vtkPartitionedDataSet"):
        assert class_name in SERIALIZERS, f"no serializer registered for {class_name}"

    # Geometry produced by ParaView, wrapped into the composite types that
    # ParaView 6 feeds to its composite mappers (vtkPartitionedDataSet and
    # vtkPartitionedDataSetCollection). Build them with VTK directly: which
    # ParaView filter emits which composite type varies across releases.
    sphere = simple.Sphere(ThetaResolution=16, PhiResolution=16)
    sphere.UpdatePipeline()
    poly = Fetch(sphere)
    assert poly.GetNumberOfPoints() > 0, "ParaView produced empty geometry"

    partitioned = vtkPartitionedDataSet()
    partitioned.SetPartition(0, poly)
    collection = vtkPartitionedDataSetCollection()
    collection.SetPartition(0, 0, poly)

    # Rebuild the local-render path: composite mapper -> actor -> render window,
    # then serialize the window exactly like trame-vtk's scene sync does.
    window = vtkRenderWindow()
    renderer = vtkRenderer()
    window.AddRenderer(renderer)
    for composite in (partitioned, collection):
        mapper = vtkCompositeMapper()
        mapper.SetInputDataObject(composite)
        actor = vtkActor()
        actor.SetMapper(mapper)
        renderer.AddActor(actor)

    scene = serialize(None, window, "smoke-render-window", SynchronizationContext(), 0)
    meshes = list(_find_meshes(scene))
    assert len(meshes) >= 2, (
        f"expected geometry for both composite actors, got {len(meshes)} mesh(es) "
        "(local vtk.js rendering would be empty)"
    )
    print(f"ok: composite serialization ({len(meshes)} meshes extracted)")


def check_view_widget_api():
    """VtkRemoteLocalView accepts what create_view_widget passes to it."""
    from plugins.base.lib.common import create_view_widget
    from trame.app import get_server
    from trame.ui.vuetify3 import VAppLayout
    from trame.widgets import paraview as pv_widgets

    server = get_server(client_type="vue3")
    view = simple.GetActiveView() or simple.CreateRenderView()
    # Widgets resolve their server from the active layout context (production
    # builds the view inside VAppLayout the same way).
    with VAppLayout(server):
        create_view_widget(pv_widgets, view, "smoke")
    assert server.state["smokeMode"] == "local"
    print("ok: VtkRemoteLocalView API compatibility")


def main():
    import trame_vtk
    import vtk

    print(f"paraview {paraview.__version__} / vtk {vtk.vtkVersion.GetVTKVersion()}")
    print(f"trame-vtk {trame_vtk.__version__}")
    import openmc

    print(f"openmc {openmc.__version__}")

    check_paraview_offscreen_render()
    check_composite_serialization()
    check_view_widget_api()
    print("rendering smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
