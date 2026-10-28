#!/usr/bin/env python3
"""Result-cache batching, uncompressed tess storage, and identical-write skips.

Covers the batch cache behavior: ``DocCache.batch`` (one archive load,
one LRU pass, one atomic zip write per build; read-only batches never write;
staged writes are discarded when the block raises), the ``ZIP_STORED``
``__doc__.tess.json`` entry, and the cache skip of an identical tess stream
(``tessWriteSkipped``). Batch assertions are pure stdlib (minimal profile);
the build-level ones are build123d-gated like their neighbors.
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
from doc_build_helpers import _document, _feature, _rect_sketch

TOL = 0.001
LENGTH_SCALE = 1.0


def _spy_writes(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Count atomic zip rewrites without changing their behavior."""
    calls: list[Path] = []
    real = dc._write_zip_atomic

    def spy(path: Path, manifest: dict[str, Any], blobs: dict[str, bytes]) -> None:
        calls.append(Path(path))
        real(path, manifest, blobs)

    monkeypatch.setattr(dc, "_write_zip_atomic", spy)
    return calls


# ---------------------------------------------------------------------------
# Batch IO (minimal profile, stdlib only).
# ---------------------------------------------------------------------------


def test_batch_many_stores_one_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """N staged stores commit as exactly one zip rewrite; reads see earlier stores."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    with cache.batch() as batch:
        for index in range(5):
            batch.store(
                f"f{index}",
                input_key="k",
                shape_fingerprint="fp",
                brep_bytes=f"brep-{index}".encode(),
            )
            # The staged entry is visible to a later lookup in the same batch.
            hit = batch.lookup(f"f{index}", "k")
            assert hit is not None and hit.brep_bytes == f"brep-{index}".encode()
        assert batch.lookup("f9", "k") is None
    assert len(calls) == 1
    fresh = dc.DocCache(cache.path)
    assert fresh.feature_ids() == [f"f{index}" for index in range(5)]
    assert fresh.lookup("f3", "k") is not None  # type: ignore[union-attr]


def test_batch_reads_only_never_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A read-only batch neither rewrites nor creates the sidecar."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    cache.store_tess("h", TOL, LENGTH_SCALE, "TESS")
    stamp = cache.path.stat().st_mtime_ns
    calls.clear()

    with cache.batch() as batch:
        assert batch.lookup("f", "k") is not None
        assert batch.lookup("f", "stale") is None
        assert batch.lookup_tess("h", TOL, LENGTH_SCALE) == "TESS"
        assert batch.lookup_tess("other", TOL, LENGTH_SCALE) is None
    assert calls == []
    assert cache.path.stat().st_mtime_ns == stamp

    absent = dc.DocCache(tmp_path / "fresh.nuke-cache.zip")
    with absent.batch() as batch:
        assert batch.lookup("f", "k") is None
    assert not absent.path.exists()
    assert calls == []


def test_batch_exception_discards_staged_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An exception inside the block leaves the previous archive byte-intact."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("keep", input_key="k", shape_fingerprint="fp", brep_bytes=b"old")
    before = cache.path.read_bytes()
    calls.clear()

    with pytest.raises(RuntimeError, match="boom"):
        with cache.batch() as batch:
            batch.store("new", input_key="k", shape_fingerprint="fp", brep_bytes=b"new")
            batch.store_tess("h", TOL, LENGTH_SCALE, "TESS")
            raise RuntimeError("boom")

    assert calls == []
    assert cache.path.read_bytes() == before
    fresh = dc.DocCache(cache.path)
    assert fresh.feature_ids() == ["keep"]
    assert fresh.lookup_tess("h", TOL, LENGTH_SCALE) is None
    with zipfile.ZipFile(cache.path) as archive:
        assert archive.testzip() is None
    assert sorted(p.name for p in tmp_path.iterdir()) == ["c.nuke-cache.zip"]


def test_batch_commits_features_and_tess_in_one_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Feature blobs + the doc tess blob share a single commit."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    with cache.batch() as batch:
        batch.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"BREP!")
        batch.store_tess("h", TOL, LENGTH_SCALE, '{"solids": []}')
    assert len(calls) == 1
    assert cache.lookup("f", "k") is not None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == '{"solids": []}'


def test_identical_tess_store_does_not_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-staging the same tess blob (warm open / no-change rebuild) is a no-op."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h", TOL, LENGTH_SCALE, "SAME-TEXT")
    before = cache.path.stat().st_mtime_ns
    calls.clear()

    with cache.batch() as batch:
        batch.store_tess("h", TOL, LENGTH_SCALE, "SAME-TEXT")
    assert calls == []
    assert cache.path.stat().st_mtime_ns == before

    with cache.batch() as batch:
        batch.store_tess("h", TOL, LENGTH_SCALE, "CHANGED-TEXT")
    assert len(calls) == 1
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "CHANGED-TEXT"


def test_identical_tess_store_still_commits_feature_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Skipping the tess blob must not suppress a real feature write-back."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h", TOL, LENGTH_SCALE, "SAME-TEXT")
    calls.clear()

    with cache.batch() as batch:
        batch.store_tess("h", TOL, LENGTH_SCALE, "SAME-TEXT")
        batch.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"BREP")
    assert len(calls) == 1
    assert cache.lookup("f", "k") is not None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "SAME-TEXT"


def test_overlap_verdicts_roundtrip_without_spurious_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verdicts persist, read back, and re-staging identical ones is a no-op."""
    calls = _spy_writes(monkeypatch)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    calls.clear()
    verdicts = {"a|b": {"a": "sa", "b": "sb", "volume": 1.5}}
    with cache.batch() as batch:
        assert batch.overlap_verdicts() == {}
        batch.store_overlap_verdicts(verdicts)
    assert len(calls) == 1

    calls.clear()
    with cache.batch() as batch:
        assert batch.overlap_verdicts() == verdicts
        batch.store_overlap_verdicts(verdicts)
    assert calls == []

    with cache.batch() as batch:
        batch.store_overlap_verdicts({"a|b": {"a": "sa", "b": "sx", "volume": 0.0}})
    assert len(calls) == 1
    with cache.batch() as batch:
        assert batch.overlap_verdicts() == {"a|b": {"a": "sa", "b": "sx", "volume": 0.0}}


def test_batch_commit_failure_is_warned_when_best_effort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing commit warns under ``best_effort`` and leaves no tmp file behind."""

    def broken(path: Path, manifest: dict[str, Any], blobs: dict[str, bytes]) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(dc, "_write_zip_atomic", broken)
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    with pytest.warns(UserWarning, match="Could not write result cache"):
        with cache.batch(best_effort=True) as batch:
            batch.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    assert not cache.path.exists()


# ---------------------------------------------------------------------------
# Uncompressed doc tess blob (minimal profile).
# ---------------------------------------------------------------------------


def test_tess_blob_is_stored_uncompressed(tmp_path: Path) -> None:
    """``__doc__.tess.json`` is ZIP_STORED, everything else stays deflated."""
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    text = json.dumps({"solids": [{"faces": []}] * 50})
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"BREP!" * 40)
    cache.store_tess("h", TOL, LENGTH_SCALE, text)

    with zipfile.ZipFile(cache.path) as archive:
        names = archive.namelist()
        assert names[0] == dc.MANIFEST_NAME  # manifest stays first
        assert archive.getinfo(dc.TESS_BLOB_NAME).compress_type == zipfile.ZIP_STORED
        assert archive.getinfo("f.brep").compress_type == zipfile.ZIP_DEFLATED
        assert archive.read(dc.TESS_BLOB_NAME).decode("utf-8") == text
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == text
    assert cache.lookup("f", "k") is not None  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Identical-write skip (minimal profile: the helper itself).
# ---------------------------------------------------------------------------


def test_write_text_if_changed_skips_identical(tmp_path: Path) -> None:
    """Identical content (including multi-byte UTF-8) is not rewritten."""
    import geometry_service as gs

    target = tmp_path / "model.tess.json"
    text = '{"solids": [], "label": "µ-section"}'
    assert gs._write_text_if_changed(target, text) is True
    stamp = target.stat().st_mtime_ns
    assert gs._write_text_if_changed(target, text) is False
    assert target.stat().st_mtime_ns == stamp
    assert target.read_text(encoding="utf-8") == text
    # A length-identical but content-different stream still writes.
    assert gs._write_text_if_changed(target, text.replace("µ", "æ")) is True
    assert target.read_text(encoding="utf-8") == text.replace("µ", "æ")


def test_write_text_if_changed_writes_when_absent(tmp_path: Path) -> None:
    import geometry_service as gs

    target = tmp_path / "absent.tess.json"
    assert gs._write_text_if_changed(target, "{}") is True
    assert target.read_text(encoding="utf-8") == "{}"


# ---------------------------------------------------------------------------
# Build-level behaviour (full profile).
# ---------------------------------------------------------------------------


def _one_pad_document() -> dict[str, Any]:
    return _document(
        [_feature("base", "pad", {"length": 5.0}, "rect")],
        [_rect_sketch()],
    )


def _two_feature_document() -> dict[str, Any]:
    return _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "pat",
                "linearPattern",
                {"source": "base", "count": 2, "spacing": 30.0, "axis": "x"},
            ),
        ],
        [_rect_sketch()],
    )


def test_no_change_rebuild_skips_tess_write(tmp_path: Path) -> None:
    """A cache-hit rebuild leaves the tess file untouched and reports the skip."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    doc_path = tmp_path / "skip.nuke-cad"
    doc_path.write_text(json.dumps(_one_pad_document()), encoding="utf-8")
    kwargs: dict[str, Any] = {
        "output_dir": str(tmp_path / "out"),
        "export_dagmc": False,
        "export_mesh": False,
        "cache_dir": str(cache_dir),
    }

    first = geometry_service.build_document(str(doc_path), **kwargs)
    assert first["success"] is True, first.get("error", "")
    assert first["tessCacheHit"] is False
    assert first["tessWriteSkipped"] is False
    tess_path = Path(first["tessPath"])
    stamp = tess_path.stat().st_mtime_ns

    second = geometry_service.build_document(str(doc_path), **kwargs)
    assert second["success"] is True, second.get("error", "")
    assert second["tessCacheHit"] is True
    assert second["tessWriteSkipped"] is True
    assert tess_path.stat().st_mtime_ns == stamp
    assert second["triangleCount"] == first["triangleCount"]


def test_partial_build_uses_one_cache_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A partial build restores + writes back + stores tess through one commit."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    calls = _spy_writes(monkeypatch)
    doc_path = tmp_path / "partial.nuke-cad"
    doc_path.write_text(json.dumps(_two_feature_document()), encoding="utf-8")
    kwargs: dict[str, Any] = {
        "cache_dir": str(tmp_path),
        "output_dir": str(tmp_path / "out"),
        "export_dagmc": False,
        "export_mesh": False,
    }

    first = geometry_service.build_document_partial(str(doc_path), ["base", "pat"], **kwargs)
    assert first["success"] is True, first.get("error", "")
    assert len(calls) == 1  # two feature write-backs + tess blob, one zip write

    calls.clear()
    second = geometry_service.build_document_partial(str(doc_path), ["pat"], **kwargs)
    assert second["success"] is True, second.get("error", "")
    statuses = {r["featureId"]: r["status"] for r in second["featureResults"]}
    assert statuses == {"base": "cached", "pat": "built"}
    assert len(calls) == 1
