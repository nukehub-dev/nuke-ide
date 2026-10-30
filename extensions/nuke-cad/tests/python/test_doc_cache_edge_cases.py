#!/usr/bin/env python3
"""Edge-case and error-path tests for the result-cache sidecar.

Covers malformed keys/manifests/blobs, atomic-write cleanup, LRU and removal
bookkeeping failures, missing-blob and non-UTF-8 decode paths, and the memory
backend's tessellation guards. Pure stdlib, so these run in the minimal
profile as well.
"""

# *****************************************************************************
# Copyright (C) 2024 NukeHub and others.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import doc_cache as dc
import pytest


def _manifest(**overrides: Any) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "version": dc.MANIFEST_VERSION,
        "builderVersion": dc.BUILDER_VERSION,
        "ocpVersion": "test",
        "features": {},
    }
    manifest.update(overrides)
    return manifest


def _entry(**overrides: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "inputKey": "k",
        "shapeFingerprint": "fp",
        "hasBrep": False,
        "hasTess": False,
        "hasTool": False,
        "meta": {},
        "updatedAt": 1.0,
        "sizeBytes": 0,
    }
    entry.update(overrides)
    return entry


def _write_zip(path: Path, manifest: Any, blobs: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(dc.MANIFEST_NAME, json.dumps(manifest))
        for name, data in blobs.items():
            archive.writestr(name, data)


def _tess_record(doc_hash: str = "h") -> dict[str, Any]:
    return {
        "docHash": doc_hash,
        "tolerance": 0.1,
        "lengthScale": 1.0,
        "updatedAt": 1.0,
        "sizeBytes": 4,
    }


# ---------------------------------------------------------------------------
# Key canonicalization.
# ---------------------------------------------------------------------------


def test_canonical_bytes_serializes_sets_and_rejects_objects() -> None:
    assert dc.canonical_bytes({"tags": {"b", "a"}}) == b'{"tags":["a","b"]}'
    assert dc.canonical_bytes({"tags": frozenset({"z", "y"})}) == b'{"tags":["y","z"]}'
    with pytest.raises(TypeError, match="is not JSON serializable"):
        dc.canonical_bytes({"value": object()})


def test_current_ocp_version_sentinel_without_distributions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing(_name: str) -> str:
        raise dc.importlib_metadata.PackageNotFoundError("not installed")

    monkeypatch.setattr(dc.importlib_metadata, "version", missing)
    assert dc.current_ocp_version() == dc.UNKNOWN_OCP_VERSION


def test_dependency_extraction_filters_malformed_ids() -> None:
    feature = {
        "sketchId": "sk1",
        "params": {"sectionSketchIds": ["sk2", "", 7, "sk1"]},
    }
    assert dc._feature_sketch_ids(feature) == ["sk1", "sk2"]
    assert dc._feature_curve_ids({"params": None}) == []
    assert dc._feature_curve_ids({"params": {"pathCurveId": ""}}) == []


def test_document_keys_reject_non_list_depends_on() -> None:
    document = {"features": [{"id": "pad1", "type": "pad", "dependsOn": "base"}]}
    with pytest.raises(ValueError, match="non-list dependsOn"):
        dc.compute_document_keys(document)


# ---------------------------------------------------------------------------
# Manifest loading and size bookkeeping.
# ---------------------------------------------------------------------------


def test_manifest_shape_list_is_corrupt(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(path, [1, 2, 3], {})
    with pytest.warns(UserWarning, match="bad manifest shape"):
        assert dc.DocCache(path).feature_ids() == []


def test_size_helpers_ignore_invalid_sizes() -> None:
    assert dc._record_size({"sizeBytes": "12"}) == 0
    assert dc._record_size({"sizeBytes": -1}) == 0
    assert dc._record_size({}) == 0
    assert dc._tess_size({"sizeBytes": "12"}) == 0
    assert dc._tess_size({"sizeBytes": -4}) == 0
    assert dc._tess_size({}) == 0


def test_evict_lru_ignores_non_dict_feature_section() -> None:
    manifest: dict[str, Any] = {"features": "corrupt", "tess": {"sizeBytes": 100}}
    blobs: dict[str, bytes] = {}
    dc._evict_lru(manifest, blobs, 1)
    assert manifest["features"] == "corrupt"
    assert manifest["tess"] == {"sizeBytes": 100}


def test_single_oversized_feature_is_kept() -> None:
    """An oversized just-stored feature is held, not silently evicted."""
    cache = dc.MemoryDocCache(size_cap_bytes=10)
    with pytest.warns(UserWarning, match="alone exceeds the size cap"):
        entry = cache.store("big", input_key="k", shape_fingerprint="fp", brep_bytes=b"x" * 20)
    assert entry is not None
    assert cache.lookup("big", "k") is not None


def test_evict_lru_warns_when_kept_tess_blob_exceeds_cap() -> None:
    manifest = {"features": {}, "tess": {"sizeBytes": 100}}
    with pytest.warns(UserWarning, match="alone exceeds the size cap"):
        dc._evict_lru(manifest, {}, 1, keep_tess=True)
    assert "tess" in manifest


def test_evict_lru_spares_kept_ids_and_drops_tess_before_warning() -> None:
    records = {
        "kept": {"updatedAt": 1.0, "sizeBytes": 8},
        "old": {"updatedAt": 2.0, "sizeBytes": 8},
    }
    blobs = {
        dc._brep_name("old"): b"x",
        dc._tess_name("old"): b"t",
        dc._tool_name("old"): b"u",
    }
    manifest: dict[str, Any] = {"features": records, "tess": {"sizeBytes": 4}}
    dc._evict_lru(manifest, blobs, 12, keep_id="kept")
    assert "kept" in manifest["features"]
    assert "old" not in manifest["features"]
    assert blobs == {}

    # Once only the doc-level tess blob remains over the cap, it is dropped.
    manifest = {"features": {"old": {"updatedAt": 1.0, "sizeBytes": 8}}, "tess": {"sizeBytes": 4}}
    dc._evict_lru(manifest, {}, 2)
    assert "tess" not in manifest
    assert "old" not in manifest["features"]


# ---------------------------------------------------------------------------
# Atomic write failure.
# ---------------------------------------------------------------------------


def test_atomic_write_failure_cleans_tmp_and_reraises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_replace(_src: Any, _dst: Any) -> None:
        raise OSError("rename failed")

    def fail_unlink(_path: Any, missing_ok: bool = False) -> None:
        raise OSError("busy")

    monkeypatch.setattr(dc.os, "replace", fail_replace)
    monkeypatch.setattr(dc.os, "unlink", fail_unlink)
    target = tmp_path / "c.nuke-cache.zip"
    with pytest.raises(OSError, match="rename failed"):
        dc._write_zip_atomic(target, _manifest(), {})
    assert not target.exists()


# ---------------------------------------------------------------------------
# Missing/corrupt blobs.
# ---------------------------------------------------------------------------


def test_lookup_rejects_records_with_missing_blobs(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(
        path,
        _manifest(features={"nobrep": _entry(hasBrep=True), "notess": _entry(hasTess=True)}),
        {},
    )
    cache = dc.DocCache(path)
    with pytest.warns(UserWarning, match="Ignoring corrupt result-cache entry 'nobrep'"):
        assert cache.lookup("nobrep", "k") is None
    with pytest.warns(UserWarning, match="Ignoring corrupt result-cache entry 'notess'"):
        assert cache.lookup("notess", "k") is None


def test_lookup_rejects_undecodable_tess_blob(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(
        path,
        _manifest(features={"bad": _entry(hasTess=True)}),
        {"bad.tess.json": b"\xff\xfe"},
    )
    with pytest.warns(UserWarning, match="Ignoring corrupt result-cache entry 'bad'"):
        assert dc.DocCache(path).lookup("bad", "k") is None


def test_lookup_rejects_non_string_record_fields(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(
        path,
        _manifest(features={"bad": _entry(shapeFingerprint=5)}),
        {},
    )
    with pytest.warns(UserWarning, match="Ignoring corrupt result-cache entry 'bad'"):
        assert dc.DocCache(path).lookup("bad", "k") is None


def test_lookup_tess_rejects_undecodable_blob(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(path, _manifest(tess=_tess_record()), {dc.TESS_BLOB_NAME: b"\xff\xfe"})
    with pytest.warns(UserWarning, match="corrupt result-cache tess entry"):
        assert dc.DocCache(path).lookup_tess("h", 0.1, 1.0) is None


def test_lookup_tess_requires_exact_key_triple(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h", 0.1, 1.0, '{"t": 1}')
    assert cache.lookup_tess("other", 0.1, 1.0) is None
    assert cache.lookup_tess("h", 0.2, 1.0) is None
    assert cache.lookup_tess("h", 0.1, 2.0) is None


def test_lookup_tess_missing_blob_warns(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    _write_zip(path, _manifest(tess=_tess_record()), {})
    with pytest.warns(UserWarning, match="corrupt result-cache tess entry"):
        assert dc.DocCache(path).lookup_tess("h", 0.1, 1.0) is None


# ---------------------------------------------------------------------------
# Batch lifecycle.
# ---------------------------------------------------------------------------


def test_batch_cannot_be_entered_twice(tmp_path: Path) -> None:
    batch = dc.DocCache(tmp_path / "c.nuke-cache.zip").batch()
    with batch:
        with pytest.raises(RuntimeError, match="already open"):
            with batch:
                pass


def test_batch_state_loads_lazily_outside_context(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    batch = cache.batch()
    hit = batch.lookup("f", "k")
    assert hit is not None and hit.brep_bytes == b"x"


def test_batch_commit_failure_propagates_without_best_effort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(_path: Any, _manifest: Any, _blobs: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(dc, "_write_zip_atomic", broken)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    with pytest.raises(OSError, match="disk full"):
        with cache.batch() as batch:
            batch.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    assert not cache.path.exists()


def test_store_tess_accepts_utf8_bytes(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h", 0.1, 1.0, b'{"label": "\xc2\xb5"}')
    assert cache.lookup_tess("h", 0.1, 1.0) == '{"label": "µ"}'


def test_store_tess_rejects_non_text_payloads(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    with pytest.raises(TypeError, match="tess_text must be str or utf-8 bytes"):
        cache.store_tess("h", 0.1, 1.0, 123)  # type: ignore[arg-type]
    assert not cache.path.exists()


def test_one_shot_overlap_verdicts_roundtrip(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")
    verdicts = {"a|b": {"a": "sa", "b": "sb", "volume": 2.0}}
    cache.store_overlap_verdicts(verdicts)
    assert cache.overlap_verdicts() == verdicts


# ---------------------------------------------------------------------------
# Invalidation / stale removal failures.
# ---------------------------------------------------------------------------


def test_size_cap_properties(tmp_path: Path) -> None:
    assert dc.DocCache(tmp_path / "c.zip", size_cap_bytes=123).size_cap_bytes == 123
    assert dc.MemoryDocCache(size_cap_bytes=456).size_cap_bytes == 456


def test_invalidate_warns_when_empty_sidecar_cannot_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")

    def fail_unlink(_self: Path, missing_ok: bool = False) -> None:
        raise OSError("busy")

    monkeypatch.setattr(Path, "unlink", fail_unlink)
    with pytest.warns(UserWarning, match="Could not remove empty result cache"):
        assert cache.invalidate("f") is False
    assert cache.path.exists()


def test_invalidate_last_entry_removes_sidecar(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")
    assert cache.invalidate("f") is True
    assert not cache.path.exists()


def test_remove_stale_with_no_changes_is_a_noop(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")
    assert cache.remove_stale({"f": "k"}) == []


def test_remove_stale_warns_when_empty_sidecar_cannot_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")

    def fail_unlink(_self: Path, missing_ok: bool = False) -> None:
        raise OSError("busy")

    monkeypatch.setattr(Path, "unlink", fail_unlink)
    with pytest.warns(UserWarning, match="Could not remove empty result cache"):
        assert cache.remove_stale({"f": "changed"}) == ["f"]
    assert cache.path.exists()


def test_remove_stale_rewrites_remaining_entries(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("keep", input_key="ka", shape_fingerprint="fp", brep_bytes=b"a")
    cache.store("drop", input_key="kb", shape_fingerprint="fp", brep_bytes=b"b")
    assert cache.remove_stale({"keep": "ka"}) == ["drop"]
    assert cache.path.exists()
    assert cache.lookup("keep", "ka") is not None
    assert cache.lookup("drop", "kb") is None


def test_clear_warns_when_sidecar_cannot_be_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp")

    def fail_unlink(_self: Path, missing_ok: bool = False) -> None:
        raise OSError("busy")

    monkeypatch.setattr(Path, "unlink", fail_unlink)
    with pytest.warns(UserWarning, match="Could not clear result cache"):
        cache.clear()


def test_total_bytes_ignores_non_dict_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dc, "_load_zip", lambda _path: (["bad"], {}))
    assert dc.DocCache(tmp_path / "c.nuke-cache.zip").total_bytes() == 0


# ---------------------------------------------------------------------------
# Memory backend.
# ---------------------------------------------------------------------------


def test_memory_cache_persists_tool_blob_and_lists_ids() -> None:
    memory = dc.MemoryDocCache()
    stored = memory.store("tooled", input_key="k", shape_fingerprint="fp", tool_bytes=b"tool")
    assert stored.tool_bytes == b"tool"
    assert memory.feature_ids() == ["tooled"]
    hit = memory.lookup("tooled", "k")
    assert hit is not None and hit.tool_bytes == b"tool"


def test_memory_cache_counts_tess_bytes_and_decodes_text() -> None:
    memory = dc.MemoryDocCache()
    memory.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"abc")
    memory.store_tess("h", 0.1, 1.0, '{"t": 1}')
    assert memory.lookup_tess("h", 0.1, 1.0) == '{"t": 1}'
    assert memory.total_bytes() == len(b"abc") + len('{"t": 1}')


def test_memory_tess_validation_and_lookup_guards() -> None:
    memory = dc.MemoryDocCache()
    assert memory.lookup_tess("h", 0.1, 1.0) is None
    memory.store_tess("h", 0.1, 1.0, b'{"t": 1}')
    assert memory.lookup_tess("h", 0.1, 1.0) == '{"t": 1}'
    assert memory.lookup_tess("other", 0.1, 1.0) is None
    assert memory.lookup_tess("h", 0.2, 1.0) is None
    assert memory.lookup_tess("h", 0.1, 2.0) is None

    memory._blobs.pop(dc.TESS_BLOB_NAME)
    assert memory.lookup_tess("h", 0.1, 1.0) is None

    memory._blobs[dc.TESS_BLOB_NAME] = b"\xff\xfe"
    assert memory.lookup_tess("h", 0.1, 1.0) is None

    with pytest.raises(TypeError, match="tess_text must be str or utf-8 bytes"):
        memory.store_tess("h", 0.1, 1.0, 123)  # type: ignore[arg-type]
