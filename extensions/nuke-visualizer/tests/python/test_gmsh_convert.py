"""Tests for plugins.base.lib.gmsh_mesh and the base.convert-gmsh command.

gmsh is optional and may not be installed, so the conversion paths are
exercised with a recording fake injected into sys.modules (and the module's
``HAS_GMSH`` probe forced on), mirroring the fake-gmsh pattern in
test_dagmc_step_convert.py. Forcing the probe off exercises the
missing-dependency :class:`GmshMeshError` path. The real-gmsh integration
test skips cleanly when the optional dependency is absent.
"""

import json
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from plugins.base.lib import gmsh_mesh as gmsh_lib


@pytest.fixture
def msh_file(tmp_path):
    f = tmp_path / "mesh.msh"
    f.write_text("$MeshFormat\n2.2 0 8\n$EndMeshFormat\n")
    return f


# ---------------------------------------------------------------------------
# Recording fake gmsh
# ---------------------------------------------------------------------------


def _install_fake_gmsh(monkeypatch, nodes=(1, 2, 3), elements=((10, 11), (12,))):
    """Install a recording fake gmsh module; returns (module, calls)."""
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
        mesh=SimpleNamespace(
            generate=_record("mesh.generate"),
            getNodes=lambda: (list(nodes), None, None),
            getElements=lambda: (None, [list(e) for e in elements], None),
        )
    )
    monkeypatch.setitem(sys.modules, "gmsh", gmsh_mod)
    # The fake provides the dependency the HAS_GMSH probe stands for.
    monkeypatch.setattr(gmsh_lib, "HAS_GMSH", True)
    return gmsh_mod, calls


# ---------------------------------------------------------------------------
# gmsh_mesh.convert_gmsh_to_vtk
# ---------------------------------------------------------------------------


def test_convert_gmsh_success(msh_file, monkeypatch):
    _gmsh, calls = _install_fake_gmsh(monkeypatch)

    result = gmsh_lib.convert_gmsh_to_vtk(str(msh_file))

    vtk_path = str(msh_file.with_suffix(".vtk"))
    assert result == {"vtk_path": vtk_path, "num_nodes": 3, "num_elements": 3}
    names = [c[0] for c in calls]
    assert names[0] == "initialize"
    assert names[-1] == "finalize"
    assert names.index("open") < names.index("write")
    assert ("open", (str(msh_file),)) in calls
    assert ("write", (vtk_path,)) in calls


def test_convert_gmsh_writes_ascii_and_never_regenerates(msh_file, monkeypatch):
    _gmsh, calls = _install_fake_gmsh(monkeypatch)

    gmsh_lib.convert_gmsh_to_vtk(str(msh_file))

    names = [c[0] for c in calls]
    assert "mesh.generate" not in names
    option_calls = {c[1][0]: c[1][1] for c in calls if c[0] == "option.setNumber"}
    assert option_calls["Mesh.Binary"] == 0


def test_convert_gmsh_missing_gmsh(msh_file, monkeypatch):
    monkeypatch.setitem(sys.modules, "gmsh", None)
    monkeypatch.setattr(gmsh_lib, "HAS_GMSH", False)
    with pytest.raises(gmsh_lib.GmshMeshError, match="gmsh is required"):
        gmsh_lib.convert_gmsh_to_vtk(str(msh_file))


def test_convert_gmsh_missing_file(monkeypatch):
    _gmsh, calls = _install_fake_gmsh(monkeypatch)
    with pytest.raises(gmsh_lib.GmshMeshError, match="Gmsh mesh file not found"):
        gmsh_lib.convert_gmsh_to_vtk("/no/such/mesh.msh")
    # Validation happens before gmsh is touched.
    assert calls == []


def test_convert_gmsh_output_dir_created(msh_file, tmp_path, monkeypatch):
    _install_fake_gmsh(monkeypatch)
    out_dir = tmp_path / "deep" / "out"

    result = gmsh_lib.convert_gmsh_to_vtk(str(msh_file), output_dir=str(out_dir))

    assert result["vtk_path"] == str(out_dir / "mesh.vtk")
    assert out_dir.is_dir()


def test_convert_gmsh_finalizes_on_error(msh_file, monkeypatch):
    gmsh_mod, calls = _install_fake_gmsh(monkeypatch)

    def _fail(path):
        raise RuntimeError("cannot parse")

    gmsh_mod.open = _fail
    with pytest.raises(RuntimeError, match="cannot parse"):
        gmsh_lib.convert_gmsh_to_vtk(str(msh_file))
    assert ("finalize", ()) in calls


def test_convert_gmsh_no_elements(msh_file, monkeypatch):
    _gmsh, calls = _install_fake_gmsh(monkeypatch, nodes=(), elements=())

    with pytest.raises(gmsh_lib.GmshMeshError, match="no elements"):
        gmsh_lib.convert_gmsh_to_vtk(str(msh_file))

    names = [c[0] for c in calls]
    assert "write" not in names
    assert names[-1] == "finalize"


# ---------------------------------------------------------------------------
# gmsh_mesh.convert_gmsh_to_vtk_cached
# ---------------------------------------------------------------------------


def test_gmsh_cached_returns_cache_hit(msh_file, tmp_path, monkeypatch):
    cache_dir = str(tmp_path / "cache")
    cache_path, exists = gmsh_lib.get_cache_path(str(msh_file), cache_dir)
    assert not exists
    Path(cache_path).write_text("cached vtk")

    def _boom(*args, **kwargs):
        raise AssertionError("conversion must not run on a cache hit")

    monkeypatch.setattr(gmsh_lib, "convert_gmsh_to_vtk", _boom)
    result = gmsh_lib.convert_gmsh_to_vtk_cached(str(msh_file), cache_dir=cache_dir)

    assert result == {
        "vtk_path": cache_path,
        "from_cache": True,
        "num_nodes": 0,
        "num_elements": 0,
    }


def test_gmsh_cached_converts_and_moves_to_cache(msh_file, tmp_path, monkeypatch):
    cache_dir = str(tmp_path / "cache")

    def fake_convert(path, output_dir=None):
        # Conversion output lands in the cache dir, then gets moved to the
        # content-addressed cache path.
        assert output_dir == Path(cache_dir)
        out = tmp_path / "mesh.vtk"
        out.write_text("fresh vtk")
        return {"vtk_path": str(out), "num_nodes": 5, "num_elements": 6}

    monkeypatch.setattr(gmsh_lib, "convert_gmsh_to_vtk", fake_convert)

    result = gmsh_lib.convert_gmsh_to_vtk_cached(str(msh_file), cache_dir=cache_dir)

    assert result["from_cache"] is False
    assert result["num_nodes"] == 5
    assert result["num_elements"] == 6
    assert Path(result["vtk_path"]).read_text() == "fresh vtk"
    assert result["vtk_path"].startswith(cache_dir)
    assert not (tmp_path / "mesh.vtk").exists()  # moved, not copied


def test_gmsh_cached_no_cache_returns_conversion_path(msh_file, monkeypatch):
    def fake_convert(path, output_dir=None):
        assert output_dir is None  # no cache dir -> no output_dir passed
        return {"vtk_path": "/tmp/out.vtk", "num_nodes": 1, "num_elements": 2}

    monkeypatch.setattr(gmsh_lib, "convert_gmsh_to_vtk", fake_convert)
    result = gmsh_lib.convert_gmsh_to_vtk_cached(str(msh_file), use_cache=False)

    assert result == {
        "vtk_path": "/tmp/out.vtk",
        "from_cache": False,
        "num_nodes": 1,
        "num_elements": 2,
    }


def test_gmsh_cache_key_includes_name_size_and_mtime(msh_file, tmp_path):
    cache_dir = str(tmp_path / "cache")
    first, _ = gmsh_lib.get_cache_path(str(msh_file), cache_dir)
    same, _ = gmsh_lib.get_cache_path(str(msh_file), cache_dir)
    assert same == first

    msh_file.write_text(msh_file.read_text() + "$Comments\nbigger\n$EndComments\n")
    grown, _ = gmsh_lib.get_cache_path(str(msh_file), cache_dir)
    assert grown != first

    stat = msh_file.stat()
    os.utime(msh_file, (stat.st_atime, stat.st_mtime + 10))
    touched, _ = gmsh_lib.get_cache_path(str(msh_file), cache_dir)
    assert touched != grown


# ---------------------------------------------------------------------------
# Input validation (no heavy dependency required — validated first)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_path", ["", None, 123])
def test_gmsh_converters_reject_empty_paths(bad_path):
    with pytest.raises(gmsh_lib.GmshMeshError, match="invalid Gmsh mesh file path"):
        gmsh_lib.convert_gmsh_to_vtk(bad_path)
    with pytest.raises(gmsh_lib.GmshMeshError, match="invalid Gmsh mesh file path"):
        gmsh_lib.convert_gmsh_to_vtk_cached(bad_path)


def test_gmsh_cached_missing_file():
    with pytest.raises(gmsh_lib.GmshMeshError, match="Gmsh mesh file not found"):
        gmsh_lib.convert_gmsh_to_vtk_cached("/no/such/mesh.msh")


# ---------------------------------------------------------------------------
# base.convert-gmsh command
# ---------------------------------------------------------------------------


def test_convert_gmsh_command_success(msh_file, monkeypatch, capsys):
    from plugins.base.commands.convert import cmd_convert_gmsh

    monkeypatch.setattr(
        gmsh_lib,
        "convert_gmsh_to_vtk_cached",
        lambda path, use_cache=True: {
            "vtk_path": "/tmp/mesh.vtk",
            "from_cache": False,
            "num_nodes": 3,
            "num_elements": 1,
        },
    )

    assert cmd_convert_gmsh(SimpleNamespace(file=str(msh_file))) == 0

    captured = capsys.readouterr()
    assert json.loads(captured.out) == {
        "vtk_path": "/tmp/mesh.vtk",
        "from_cache": False,
        "num_nodes": 3,
        "num_elements": 1,
    }


def test_convert_gmsh_command_error(msh_file, monkeypatch, capsys):
    from plugins.base.commands.convert import cmd_convert_gmsh

    def _fail(*args, **kwargs):
        raise gmsh_lib.GmshMeshError("Gmsh mesh has no elements: /tmp/x.msh")

    monkeypatch.setattr(gmsh_lib, "convert_gmsh_to_vtk_cached", _fail)

    assert cmd_convert_gmsh(SimpleNamespace(file=str(msh_file))) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err) == {"error": "Gmsh mesh has no elements: /tmp/x.msh"}


# ---------------------------------------------------------------------------
# Real gmsh integration (skipped when the optional dependency is absent)
# ---------------------------------------------------------------------------

_GMSH_22_TRIANGLE = """$MeshFormat
2.2 0 8
$EndMeshFormat
$Nodes
3
1 0 0 0
2 1 0 0
3 0 1 0
$EndNodes
$Elements
1
1 2 2 1 1 1 2 3
$EndElements
"""


def test_real_gmsh_converts_msh_to_ascii_vtk(tmp_path):
    pytest.importorskip("gmsh")
    msh_path = tmp_path / "triangle.msh"
    msh_path.write_text(_GMSH_22_TRIANGLE)

    result = gmsh_lib.convert_gmsh_to_vtk(str(msh_path))

    vtk_path = Path(result["vtk_path"])
    assert vtk_path == tmp_path / "triangle.vtk"
    text = vtk_path.read_text()
    assert text.startswith("# vtk DataFile")
    assert "ASCII" in text
    assert result["num_nodes"] == 3
    assert result["num_elements"] == 1
