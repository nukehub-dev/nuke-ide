#!/usr/bin/env python3
"""DOC-LEVEL tessellation cache (brief §9 revision): zip section, hooks, e2e.

Covers the ``tess`` manifest section plus ``__doc__.tess.json`` blob in
``doc_cache`` (roundtrip, tolerance/length-scale sensitivity, LRU/size
accounting), the ``compute_tess_doc_hash`` key grammar, and the
document-build hook in ``geometry_service``: first build stores with
``tessCacheHit`` False, an identical rebuild hits with byte-identical tess
text, an edited document misses and re-tessellates, and a cache-disabled
build reports False with byte-identical output.

Pure-stdlib tests run in the minimal pytest profile (pytest + numpy only);
the build plumbing is build123d-gated via ``importorskip`` like neighbors.
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

TOL = 0.001
LENGTH_SCALE = 1.0


def _doc(length: float = 5.0) -> dict[str, Any]:
    """Synthetic 2-feature document: two pads on separate bodies."""
    return {
        "version": 3,
        "name": "tess-doc",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "off20", "kind": "offset", "name": "offset 20", "offset": 20.0},
        ],
        "bodies": [
            {"id": "body-1", "name": "Body 1"},
            {"id": "body-2", "name": "Body 2"},
        ],
        "sketches": [
            {
                "id": "rect",
                "name": "rect",
                "datumId": "dxy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0.0, "y": 0.0},
                    {"id": "p2", "type": "point", "x": 10.0, "y": 0.0},
                    {"id": "p3", "type": "point", "x": 10.0, "y": 10.0},
                    {"id": "p4", "type": "point", "x": 0.0, "y": 10.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
            {
                "id": "rect2",
                "name": "rect2",
                "datumId": "off20",
                "primitives": [
                    {"id": "q1", "type": "point", "x": 0.0, "y": 0.0},
                    {"id": "q2", "type": "point", "x": 6.0, "y": 0.0},
                    {"id": "q3", "type": "point", "x": 6.0, "y": 6.0},
                    {"id": "q4", "type": "point", "x": 0.0, "y": 6.0},
                    {"id": "m1", "type": "line", "p1_id": "q1", "p2_id": "q2"},
                    {"id": "m2", "type": "line", "p1_id": "q2", "p2_id": "q3"},
                    {"id": "m3", "type": "line", "p1_id": "q3", "p2_id": "q4"},
                    {"id": "m4", "type": "line", "p1_id": "q4", "p2_id": "q1"},
                ],
                "constraints": [],
            },
        ],
        "curves": [],
        "features": [
            {
                "id": "pad1",
                "name": "pad1",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": length},
                "dependsOn": [],
            },
            {
                "id": "pad2",
                "name": "pad2",
                "type": "pad",
                "body": "body-2",
                "sketchId": "rect2",
                "params": {"length": 4.0},
                "dependsOn": [],
            },
        ],
    }


def _doc_hash(document: dict[str, Any]) -> str:
    """Expected plumbing hash: same OCP-version input the geometry service uses."""
    return dc.compute_tess_doc_hash(
        document, TOL, LENGTH_SCALE, ocp_version=dc.current_ocp_version()
    )


# ---------------------------------------------------------------------------
# Key grammar (OCP-free, minimal profile).
# ---------------------------------------------------------------------------


def test_tess_doc_hash_deterministic() -> None:
    first = _doc_hash(_doc())
    assert first == _doc_hash(_doc())
    assert len(first) == 64  # sha256 hex


def test_tess_doc_hash_dict_order_independent() -> None:
    assert _doc_hash(_doc()) == _doc_hash(json.loads(json.dumps(_doc())))


def test_tess_doc_hash_param_edit_changes_hash() -> None:
    before = _doc_hash(_doc())
    assert _doc_hash(_doc(length=7.0)) != before


def test_tess_doc_hash_tolerance_and_scale_sensitive() -> None:
    document = _doc()
    base = dc.compute_tess_doc_hash(document, TOL, LENGTH_SCALE)
    assert dc.compute_tess_doc_hash(document, 0.01, LENGTH_SCALE) != base
    assert dc.compute_tess_doc_hash(document, TOL, 10.0) != base


def test_tess_doc_hash_empty_document() -> None:
    assert _doc_hash({"features": []}) == _doc_hash({"features": []})


def test_tess_doc_hash_no_heavy_imports() -> None:
    """Key computation stays OCP-free (runs in the minimal profile)."""
    assert dc.compute_tess_doc_hash(_doc(), TOL, LENGTH_SCALE)


# ---------------------------------------------------------------------------
# Zip section: store/lookup roundtrip + sensitivity (minimal profile).
# ---------------------------------------------------------------------------


def test_store_lookup_tess_roundtrip(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "model.nuke-cache.zip")
    assert cache.lookup_tess("hash-a", TOL, LENGTH_SCALE) is None  # missing file is a miss
    cache.store_tess("hash-a", TOL, LENGTH_SCALE, '{"solids": []}')
    assert cache.lookup_tess("hash-a", TOL, LENGTH_SCALE) == '{"solids": []}'
    with zipfile.ZipFile(cache.path) as archive:
        assert dc.TESS_BLOB_NAME in archive.namelist()
        manifest = json.loads(archive.read("manifest.json"))
    section = manifest["tess"]
    assert section["docHash"] == "hash-a"
    assert section["tolerance"] == TOL
    assert section["lengthScale"] == LENGTH_SCALE
    assert section["sizeBytes"] == len('{"solids": []}')
    assert isinstance(section["updatedAt"], (int, float))
    assert set(section) == {"docHash", "tolerance", "lengthScale", "updatedAt", "sizeBytes"}


def test_lookup_tess_sensitivity(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("hash-a", TOL, LENGTH_SCALE, "TESS")
    assert cache.lookup_tess("hash-b", TOL, LENGTH_SCALE) is None
    assert cache.lookup_tess("hash-a", 0.01, LENGTH_SCALE) is None
    assert cache.lookup_tess("hash-a", TOL, 10.0) is None
    assert cache.lookup_tess("hash-a", TOL, LENGTH_SCALE) == "TESS"


def test_store_tess_accepts_bytes(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h", TOL, LENGTH_SCALE, b'{"s": 1}')
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == '{"s": 1}'


def test_store_tess_overwrites(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store_tess("h1", TOL, LENGTH_SCALE, "OLD")
    cache.store_tess("h2", TOL, LENGTH_SCALE, "NEW")
    assert cache.lookup_tess("h1", TOL, LENGTH_SCALE) is None
    assert cache.lookup_tess("h2", TOL, LENGTH_SCALE) == "NEW"


def test_store_tess_coexists_with_feature_blobs(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("pad1", input_key="k", shape_fingerprint="fp", brep_bytes=b"BREP!")
    cache.store_tess("h", TOL, LENGTH_SCALE, "TESS")
    assert cache.lookup("pad1", "k") is not None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "TESS"
    with zipfile.ZipFile(cache.path) as archive:
        names = set(archive.namelist())
    assert {"manifest.json", "pad1.brep", dc.TESS_BLOB_NAME} <= names


def test_tess_counts_toward_total_bytes(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345")
    assert cache.total_bytes() == 5
    cache.store_tess("h", TOL, LENGTH_SCALE, "1234567890")
    assert cache.total_bytes() == 5 + 10


def test_tess_eviction_drops_oldest_features_first(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip", size_cap_bytes=15)
    cache.store("old", input_key="k", shape_fingerprint="f", brep_bytes=b"12345", updated_at=1.0)
    cache.store_tess("h", TOL, LENGTH_SCALE, "1234567890", updated_at=2.0)
    assert cache.total_bytes() == 15  # exactly at cap: nothing evicted
    assert cache.lookup("old", "k") is not None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "1234567890"
    # One more byte forces eviction: the older feature goes, the fresh tess blob stays.
    cache.store("new", input_key="k", shape_fingerprint="f", brep_bytes=b"1", updated_at=3.0)
    assert cache.lookup("old", "k") is None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "1234567890"
    assert cache.lookup("new", "k") is not None


def test_tess_section_evicts_when_features_must_stay(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip", size_cap_bytes=10)
    cache.store_tess("h", TOL, LENGTH_SCALE, "1234567890", updated_at=1.0)
    cache.store("keep", input_key="k", shape_fingerprint="f", brep_bytes=b"12345", updated_at=2.0)
    # 10 + 5 > 10: the just-stored feature is protected, the older tess section evicts.
    assert cache.lookup("keep", "k") is not None
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) is None
    assert cache.total_bytes() == 5


def test_oversized_tess_blob_is_kept_with_warning(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip", size_cap_bytes=4)
    with pytest.warns(UserWarning, match="exceeds the size cap"):
        cache.store_tess("h", TOL, LENGTH_SCALE, "1234567890")
    assert cache.lookup_tess("h", TOL, LENGTH_SCALE) == "1234567890"


def test_memory_tess_roundtrip_and_eviction() -> None:
    memory = dc.MemoryDocCache()
    assert memory.lookup_tess("h", TOL, LENGTH_SCALE) is None
    memory.store_tess("h", TOL, LENGTH_SCALE, "TESS")
    assert memory.lookup_tess("h", TOL, LENGTH_SCALE) == "TESS"
    assert memory.lookup_tess("other", TOL, LENGTH_SCALE) is None
    assert memory.lookup_tess("h", 0.5, LENGTH_SCALE) is None
    assert memory.total_bytes() == len("TESS")

    small = dc.MemoryDocCache(size_cap_bytes=15)
    small.store("old", input_key="k", shape_fingerprint="f", brep_bytes=b"12345", updated_at=1.0)
    small.store_tess("h", TOL, LENGTH_SCALE, "1234567890", updated_at=2.0)
    assert small.total_bytes() == 15
    small.store("new", input_key="k", shape_fingerprint="f", brep_bytes=b"1", updated_at=3.0)
    assert small.lookup("old", "k") is None
    assert small.lookup_tess("h", TOL, LENGTH_SCALE) == "1234567890"


def test_tess_missing_blob_reads_as_miss(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    cache = dc.DocCache(path)
    cache.store_tess("h", TOL, LENGTH_SCALE, "TESS")
    manifest_raw, blobs = dc._load_zip(path)
    del blobs[dc.TESS_BLOB_NAME]
    dc._write_zip_atomic(path, manifest_raw, blobs)
    with pytest.warns(UserWarning, match="tess entry"):
        assert cache.lookup_tess("h", TOL, LENGTH_SCALE) is None


# ---------------------------------------------------------------------------
# Build plumbing (full profile, build123d-gated like neighbors).
# ---------------------------------------------------------------------------


def _write_doc(path: Path, document: dict[str, Any]) -> str:
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def _strip_hashes(value: Any) -> Any:
    """Drop the process-salted ``hash`` fields from a parsed tessellation.

    ``geometry_service._tessellate_shape`` stamps each face with
    ``hash(face.TShape().__hash__())``, which is unstable across builds even
    with zero cache involvement (verified: two pristine no-cache builds of
    the same document differ only there). Comparisons of independently meshed
    outputs must strip it; hit-path verbatim writes are still asserted
    byte-for-byte.
    """
    if isinstance(value, dict):
        return {k: _strip_hashes(v) for k, v in value.items() if k != "hash"}
    if isinstance(value, list):
        return [_strip_hashes(v) for v in value]
    return value


def _build(document: dict[str, Any], tmp_path: Path, cache_dir: str | None) -> dict[str, Any]:
    import geometry_service

    doc_path = tmp_path / "tess.nuke-cad"
    out_dir = tmp_path / "out"
    out_dir.mkdir(exist_ok=True)
    kwargs: dict[str, Any] = {"output_dir": str(out_dir)}
    if cache_dir is not None:
        kwargs["cache_dir"] = cache_dir
    return geometry_service.build_document(
        _write_doc(doc_path, document),
        export_dagmc=False,
        export_mesh=False,
        **kwargs,
    )


def test_build_caches_and_hits(tmp_path: Path) -> None:
    """First build stores (False), identical rebuild hits byte-identical, edit misses."""
    pytest.importorskip("build123d", reason="build123d not installed")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()

    first = _build(_doc(), tmp_path, str(cache_dir))
    assert first["success"] is True, first.get("error", "")
    assert first["tessCacheHit"] is False
    assert first["solidCount"] == 2
    first_text = Path(first["tessPath"]).read_text(encoding="utf-8")

    sidecar = cache_dir / "tess.nuke-cache.zip"
    assert sidecar.exists()
    with zipfile.ZipFile(sidecar) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["tess"]["docHash"] == _doc_hash(_doc())

    second = _build(_doc(), tmp_path, str(cache_dir))
    assert second["success"] is True, second.get("error", "")
    assert second["tessCacheHit"] is True
    second_text = Path(second["tessPath"]).read_text(encoding="utf-8")
    assert second_text == first_text
    assert (second["solidCount"], second["faceCount"], second["triangleCount"]) == (
        first["solidCount"],
        first["faceCount"],
        first["triangleCount"],
    )

    edited = _build(_doc(length=7.0), tmp_path, str(cache_dir))
    assert edited["success"] is True, edited.get("error", "")
    assert edited["tessCacheHit"] is False
    edited_text = Path(edited["tessPath"]).read_text(encoding="utf-8")
    assert edited_text != first_text


def test_build_primes_every_feature_for_partial_restore(tmp_path: Path) -> None:
    """A cache-enabled full build stores every feature B-rep.

    That is what makes the FIRST edit after opening a document partial: without
    priming, a cold feature cache forces the partial path to execute (and only
    then write back) every feature, so the spinner's "1 of N" claim would hide
    a full rebuild. A zero-dirty partial rebuild afterwards must restore every
    feature (``cached``) and reuse the identical tess stream.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    first = _build(_doc(), tmp_path, str(cache_dir))
    assert first["success"] is True, first.get("error", "")

    sidecar = cache_dir / "tess.nuke-cache.zip"
    with zipfile.ZipFile(sidecar) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    keys = dc.compute_document_keys(_doc(), ocp_version=dc.current_ocp_version())
    assert set(manifest["features"]) == {"pad1", "pad2"}
    cache = dc.DocCache(str(sidecar))
    for feature_id, input_key in keys.items():
        assert manifest["features"][feature_id]["inputKey"] == input_key
        assert cache.lookup(feature_id, input_key) is not None

    part = geometry_service.build_document_partial(
        str(tmp_path / "tess.nuke-cad"),
        [],
        cache_dir=str(cache_dir),
        output_dir=str(tmp_path / "out"),
        export_dagmc=False,
        export_mesh=False,
    )
    assert part["success"] is True, part.get("error", "")
    statuses = {record["featureId"]: record.get("status") for record in part["featureResults"]}
    assert statuses == {"pad1": "cached", "pad2": "cached"}
    assert part["tessCacheHit"] is True
    assert part["tessWriteSkipped"] is True


def test_priming_failure_falls_back_to_the_full_builder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cache-primed build failure must never fail the document.

    Priming routes full builds through the partial builder; if that path
    raises, the canonical full builder runs without the cache and the build
    still succeeds (and leaves no half-written sidecar behind).
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    import feature_builder

    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("priming exploded")

    monkeypatch.setattr(feature_builder, "build_document_shape_partial", boom)
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    result = _build(_doc(), tmp_path, str(cache_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2
    # The fallback may still store the doc-level tess blob (that hook is
    # independent), but it must not claim to have primed feature entries.
    sidecar = cache_dir / "tess.nuke-cache.zip"
    if sidecar.exists():
        with zipfile.ZipFile(sidecar) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        assert manifest.get("features", {}) == {}


def test_export_build_does_not_prime_the_cache(tmp_path: Path) -> None:
    """Export builds skip the sidecar entirely (display-only priming)."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    doc_path = _write_doc(tmp_path / "export.nuke-cad", _doc())
    geometry_service.build_document(
        doc_path,
        output_dir=str(out_dir),
        cache_dir=str(cache_dir),
        export_dagmc=True,
        export_mesh=False,
    )
    assert not (cache_dir / "export.nuke-cache.zip").exists()


def test_build_without_cache_reports_false_and_matches(tmp_path: Path) -> None:
    """Cache-disabled builds report False and emit identical tess content.

    Compared modulo the pre-existing process-salted ``hash`` face field (see
    ``_strip_hashes``): the cache hook adds no content of its own.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()

    uncached = _build(_doc(), tmp_path, None)
    assert uncached["success"] is True, uncached.get("error", "")
    assert uncached["tessCacheHit"] is False

    miss = _build(_doc(), tmp_path, str(cache_dir))
    assert miss["success"] is True, miss.get("error", "")
    assert miss["tessCacheHit"] is False
    assert _strip_hashes(json.loads(Path(miss["tessPath"]).read_text(encoding="utf-8"))) == (
        _strip_hashes(json.loads(Path(uncached["tessPath"]).read_text(encoding="utf-8")))
    )
    assert (miss["solidCount"], miss["faceCount"], miss["triangleCount"]) == (
        uncached["solidCount"],
        uncached["faceCount"],
        uncached["triangleCount"],
    )


def test_build_tolerance_change_misses(tmp_path: Path) -> None:
    """A tolerance change is a key change: miss, then hit at the new tolerance."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    out_dir = tmp_path / "out"
    out_dir.mkdir(exist_ok=True)
    doc_path = _write_doc(tmp_path / "tess.nuke-cad", _doc())

    coarse = geometry_service.build_document(
        doc_path,
        output_dir=str(out_dir),
        export_dagmc=False,
        export_mesh=False,
        tolerance=0.01,
        cache_dir=str(cache_dir),
    )
    assert coarse["success"] is True, coarse.get("error", "")
    assert coarse["tessCacheHit"] is False

    coarse_again = geometry_service.build_document(
        doc_path,
        output_dir=str(out_dir),
        export_dagmc=False,
        export_mesh=False,
        tolerance=0.01,
        cache_dir=str(cache_dir),
    )
    assert coarse_again["tessCacheHit"] is True
    assert Path(coarse_again["tessPath"]).read_text(encoding="utf-8") == Path(
        coarse["tessPath"]
    ).read_text(encoding="utf-8")

    fine = geometry_service.build_document(
        doc_path,
        output_dir=str(out_dir),
        export_dagmc=False,
        export_mesh=False,
        tolerance=TOL,
        cache_dir=str(cache_dir),
    )
    assert fine["success"] is True, fine.get("error", "")
    assert fine["tessCacheHit"] is False


def test_build_hit_preserves_manifest_and_step(tmp_path: Path) -> None:
    """A cache hit still emits STEP/selectorMap/featureResults normally (only meshing skips).

    STEP bytes are compared by existence + downstream payloads, not
    byte-for-byte: the OCP STEP translator renumbers entities between any two
    builds (verified pre-existing, zero cache involvement).
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()

    first = _build(_doc(), tmp_path, str(cache_dir))
    assert first["success"] is True, first.get("error", "")
    assert Path(first["stepPath"]).exists()

    second = _build(_doc(), tmp_path, str(cache_dir))
    assert second["success"] is True, second.get("error", "")
    assert second["tessCacheHit"] is True
    assert Path(second["stepPath"]).exists()
    assert Path(second["stepPath"]).stat().st_size > 0
    assert second["selectorMap"] == first["selectorMap"]
    assert [r["status"] for r in second["featureResults"]] == ["built", "built"]
    assert (second["solidCount"], second["faceCount"], second["triangleCount"]) == (
        first["solidCount"],
        first["faceCount"],
        first["triangleCount"],
    )


def test_size_cap_conversions() -> None:
    """MiB pref values convert to bytes; junk means the backend default."""
    import geometry_service

    assert geometry_service._size_cap_bytes(None) is None
    assert geometry_service._size_cap_bytes(1) == 1024 * 1024
    assert geometry_service._size_cap_bytes(0.5) == 512 * 1024
    assert geometry_service._size_cap_bytes(0) is None
    assert geometry_service._size_cap_bytes(-3) is None
    assert geometry_service._size_cap_bytes("junk") is None


def test_partial_build_with_size_cap_succeeds(tmp_path: Path) -> None:
    """A tiny cap never breaks the build (entries evict, geometry is exact)."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    doc_path = tmp_path / "cap.nuke-cad"
    doc_path.write_text(
        json.dumps(
            {
                "version": 3,
                "name": "cap",
                "parameters": {},
                "datums": [{"id": "d", "kind": "XY", "name": "XY"}],
                "bodies": [{"id": "b", "name": "B"}],
                "sketches": [
                    {
                        "id": "s",
                        "name": "S",
                        "datumId": "d",
                        "primitives": [
                            {"id": "p1", "type": "point", "x": 0, "y": 0},
                            {"id": "p2", "type": "point", "x": 2, "y": 0},
                            {"id": "p3", "type": "point", "x": 2, "y": 2},
                            {"id": "p4", "type": "point", "x": 0, "y": 2},
                            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                        ],
                        "constraints": [],
                    }
                ],
                "curves": [],
                "features": [
                    {
                        "id": "pad",
                        "name": "P",
                        "type": "pad",
                        "body": "b",
                        "sketchId": "s",
                        "params": {"length": 3.0},
                        "dependsOn": [],
                        "suppressed": False,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    result = geometry_service.build_document_partial(
        str(doc_path),
        ["pad"],
        cache_dir=str(tmp_path),
        output_dir=str(tmp_path / "out"),
        export_dagmc=False,
        export_mesh=False,
        size_cap_mb=0.001,
    )
    assert result["success"], result.get("error")
    assert Path(result["tessPath"]).exists()
    statuses = {r["featureId"]: r["status"] for r in result["featureResults"]}
    assert statuses == {"pad": "built"}
