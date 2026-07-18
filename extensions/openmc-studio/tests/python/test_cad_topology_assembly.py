"""Tests for cad_conversion.topology.analyze_assembly (fake gmsh).

The adjacency/shared-face graph construction is exercised against a fake
gmsh namespace; merge/normalize/boolean helpers are covered by
test_cad_topology.py.
"""

from types import SimpleNamespace

import pytest
from cad_conversion import gmsh_utils, topology


@pytest.fixture()
def fake_gmsh(monkeypatch):
    """Install a recording fake gmsh and flip HAS_GMSH on."""
    calls = []

    class FakeModel:
        def __init__(self):
            self.entities = []
            self.boundaries = {}

        def getEntities(self, *args):
            return list(self.entities)

        def getBoundary(self, dimtags, oriented=True, recursive=False):
            return self.boundaries.get(dimtags[0], [])

    class FakeGmsh:
        def __init__(self):
            self.model = FakeModel()
            self.option = SimpleNamespace(setNumber=lambda *a: None)
            self.open_error = None

        def initialize(self):
            calls.append("initialize")

        def finalize(self):
            calls.append("finalize")

        def open(self, path):
            calls.append(("open", path))
            if self.open_error is not None:
                raise self.open_error

    gmsh = FakeGmsh()
    monkeypatch.setattr(gmsh_utils, "HAS_GMSH", True)
    monkeypatch.setattr(gmsh_utils, "gmsh", gmsh)
    gmsh.calls = calls
    return gmsh


class TestAnalyzeAssembly:
    def test_empty_info_without_gmsh(self, monkeypatch):
        """Without gmsh, the topology info is all zeros."""
        monkeypatch.setattr(gmsh_utils, "HAS_GMSH", False)

        info = topology.analyze_assembly("model.step")

        assert info.solid_count == 0
        assert info.face_count == 0
        assert info.edge_count == 0
        assert info.vertex_count == 0
        assert info.adjacency == {}
        assert info.shared_faces == {}

    def test_adjacency_from_shared_faces(self, fake_gmsh):
        """Solids sharing a face become adjacent with the face recorded."""
        fake_gmsh.model.entities = [
            (3, 1),
            (3, 2),
            (2, 1),
            (2, 2),
            (2, 3),
            (2, 4),
            (1, 5),
            (0, 7),
        ]
        fake_gmsh.model.boundaries = {
            (3, 1): [(2, 1), (2, 2), (2, 3)],
            (3, 2): [(2, 3), (2, 4)],
        }

        info = topology.analyze_assembly("model.step")

        assert info.solid_count == 2
        assert info.face_count == 4
        assert info.edge_count == 1
        assert info.vertex_count == 1
        assert info.adjacency == {1: [2], 2: [1]}
        assert info.shared_faces == {(1, 2): [3]}
        assert fake_gmsh.calls == ["initialize", ("open", "model.step"), "finalize"]

    def test_disjoint_solids_have_no_adjacency(self, fake_gmsh):
        """Solids without shared faces produce no adjacency entries."""
        fake_gmsh.model.entities = [(3, 1), (3, 2), (2, 1), (2, 2)]
        fake_gmsh.model.boundaries = {(3, 1): [(2, 1)], (3, 2): [(2, 2)]}

        info = topology.analyze_assembly("model.step")

        assert info.solid_count == 2
        assert info.adjacency == {}
        assert info.shared_faces == {}

    def test_open_failure_returns_empty_info(self, fake_gmsh):
        """A gmsh open failure is swallowed and finalize still runs."""
        fake_gmsh.open_error = RuntimeError("bad file")

        info = topology.analyze_assembly("model.step")

        assert info.solid_count == 0
        assert fake_gmsh.calls == ["initialize", ("open", "model.step"), "finalize"]
