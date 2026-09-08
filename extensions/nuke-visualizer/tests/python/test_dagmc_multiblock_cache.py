"""Tests for the cached multiblock converter and its CLI command.

The ``base.convert-dagmc-multiblock`` command turns a DAGMC ``.h5m`` file
into a ``.vtm`` manifest (one block per volume) so the native DAGMC viewer
gets volume/material/group isolation through its existing toggle model.
pydagmc/vtk are not installed here, so conversion is exercised with
recording fakes; missing dependencies must surface as a stderr JSON error
with exit code 1 (base-plugin contract), never a traceback.
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path
from types import ModuleType

import pytest
from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.base.commands import convert as convert_cmds  # noqa: E402
from plugins.base.lib import dagmc as dagmc_lib  # noqa: E402


@pytest.fixture
def h5m_file(tmp_path):
    f = tmp_path / "tokamak.h5m"
    f.write_bytes(b"fake h5m content")
    return f


@pytest.fixture
def hermetic_tmp(monkeypatch, tmp_path):
    """Redirect tempfile.gettempdir so cache dirs stay inside tmp_path."""
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    return tmp_path


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error_line(capsys):
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f"expected JSON error on stderr, got: {err!r}"
    return json.loads(err)["error"]


def _install_fake_pydagmc(monkeypatch):
    pydagmc_mod = ModuleType("pydagmc")
    monkeypatch.setitem(sys.modules, "pydagmc", pydagmc_mod)
    monkeypatch.setattr(dagmc_lib, "HAS_PYDAGMC", True)


# ---------------------------------------------------------------------------
# lib.get_multiblock_cache_path
# ---------------------------------------------------------------------------


def test_multiblock_cache_path_shape(h5m_file, tmp_path):
    """The manifest is ``<stem>_volumes.vtm`` inside a hash subdirectory."""
    manifest, exists = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))

    assert not exists
    manifest_path = Path(manifest)
    assert manifest_path.name == "tokamak_volumes.vtm"
    assert manifest_path.parent.name.endswith("_multiblock")
    assert manifest_path.parent.name.startswith("tokamak_")
    assert manifest_path.parent.parent == tmp_path


def test_multiblock_cache_key_versioned(h5m_file, tmp_path):
    """FILTER_VERSION invalidates multiblock manifests across derivation changes."""
    manifest, _ = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))
    assert dagmc_lib.FILTER_VERSION >= 2

    import hashlib

    stat = h5m_file.stat()
    legacy = hashlib.md5(
        f"{h5m_file.name}:{stat.st_size}:{stat.st_mtime}:multiblock".encode()
    ).hexdigest()[:12]
    assert legacy not in Path(manifest).parent.name


def test_multiblock_cache_hit_is_existing_manifest(h5m_file, tmp_path):
    """A hit is simply an existing manifest file."""
    manifest, exists = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))
    assert not exists
    Path(manifest).write_text("fake vtm")

    _, exists = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))
    assert exists


def test_multiblock_cache_separates_graveyard(h5m_file, tmp_path):
    """Graveyard-included conversions cache separately from filtered ones."""
    plain, _ = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))
    grave, _ = dagmc_lib.get_multiblock_cache_path(
        str(h5m_file), str(tmp_path), include_graveyard=True
    )
    assert plain != grave


def test_multiblock_cache_rejects_bad_path():
    with pytest.raises(dagmc_lib.DagmcError, match="invalid DAGMC file path"):
        dagmc_lib.get_multiblock_cache_path("")
    with pytest.raises(dagmc_lib.DagmcError, match="DAGMC file not found"):
        dagmc_lib.get_multiblock_cache_path("/no/such/model.h5m")


# ---------------------------------------------------------------------------
# lib.convert_h5m_to_multiblock_vtk_cached
# ---------------------------------------------------------------------------


def test_multiblock_cached_hit_skips_conversion(h5m_file, tmp_path, monkeypatch):
    manifest, _ = dagmc_lib.get_multiblock_cache_path(str(h5m_file), str(tmp_path))
    Path(manifest).write_text("cached vtm")

    def _boom(*args, **kwargs):
        raise AssertionError("conversion must not run on a cache hit")

    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_multiblock_vtk", _boom)
    result = dagmc_lib.convert_h5m_to_multiblock_vtk_cached(str(h5m_file), cache_dir=str(tmp_path))

    assert result["from_cache"] is True
    assert result["vtm_path"] == manifest
    assert result["volume_info"] == []


def test_multiblock_cached_miss_converts_into_hash_subdir(h5m_file, tmp_path, monkeypatch):
    seen = {}

    def _fake_convert(path, output_dir=None, include_graveyard=False):
        seen["output_dir"] = output_dir
        manifest = Path(output_dir) / "tokamak_volumes.vtm"
        manifest.write_text("fresh vtm")
        return {
            "vtm_path": str(manifest),
            "volume_info": [{"id": 2}],
            "materials": {"UO2": [2]},
            "groups": {},
        }

    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_multiblock_vtk", _fake_convert)
    result = dagmc_lib.convert_h5m_to_multiblock_vtk_cached(str(h5m_file), cache_dir=str(tmp_path))

    assert result["from_cache"] is False
    assert result["vtm_path"].endswith("tokamak_volumes.vtm")
    assert "_multiblock" in result["vtm_path"]
    assert seen["output_dir"] == str(Path(result["vtm_path"]).parent)
    assert result["volume_info"] == [{"id": 2}]


def test_multiblock_cached_missing_file():
    with pytest.raises(dagmc_lib.DagmcError, match="DAGMC file not found"):
        dagmc_lib.convert_h5m_to_multiblock_vtk_cached("/no/such/model.h5m")


# ---------------------------------------------------------------------------
# base.convert-dagmc-multiblock command
# ---------------------------------------------------------------------------


def test_multiblock_command_missing_file(hermetic_tmp, capsys):
    args = _parse(convert_cmds.cmd_convert_dagmc_multiblock, ["--file", "/no/such/model.h5m"])

    rc = convert_cmds.cmd_convert_dagmc_multiblock(args)

    assert rc == 1
    assert _stderr_error_line(capsys)


def test_multiblock_command_missing_pydagmc(hermetic_tmp, monkeypatch, capsys):
    fake_h5m = hermetic_tmp / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "pydagmc", None)

    args = _parse(convert_cmds.cmd_convert_dagmc_multiblock, ["--file", str(fake_h5m)])
    rc = convert_cmds.cmd_convert_dagmc_multiblock(args)

    assert rc == 1
    assert "pydagmc" in _stderr_error_line(capsys)


def test_multiblock_command_success(hermetic_tmp, monkeypatch, capsys):
    fake_h5m = hermetic_tmp / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    _install_fake_pydagmc(monkeypatch)

    def _writing_convert(path, output_dir=None, include_graveyard=False):
        # The fake writer never creates the manifest file itself; claim the
        # write so the miss path returns a real path.
        result = {"vtm_path": str(Path(output_dir) / "model_volumes.vtm")}
        Path(result["vtm_path"]).write_text("fresh vtm")
        return {**result, "volume_info": [], "materials": {}, "groups": {}}

    monkeypatch.setattr(dagmc_lib, "convert_h5m_to_multiblock_vtk", _writing_convert)

    args = _parse(convert_cmds.cmd_convert_dagmc_multiblock, ["--file", str(fake_h5m)])
    rc = convert_cmds.cmd_convert_dagmc_multiblock(args)

    assert rc == 0
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["vtm_path"].endswith("model_volumes.vtm")
    assert payload["from_cache"] is False


def test_multiblock_command_hit_returns_cache(hermetic_tmp, capsys):
    fake_h5m = hermetic_tmp / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    manifest, _ = dagmc_lib.get_multiblock_cache_path(str(fake_h5m))
    Path(manifest).write_text("cached vtm")

    args = _parse(convert_cmds.cmd_convert_dagmc_multiblock, ["--file", str(fake_h5m)])
    rc = convert_cmds.cmd_convert_dagmc_multiblock(args)

    assert rc == 0
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["vtm_path"] == manifest
    assert payload["from_cache"] is True


def test_multiblock_command_file_argument_required():
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(convert_cmds.cmd_convert_dagmc_multiblock, parser)

    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args([])
    assert excinfo.value.code == 2
