#!/usr/bin/env python3
"""Per-feature result cache (`doc_cache`): keys, zip layout, eviction, tolerance.

Pure stdlib under test, so this runs in the minimal pytest profile
(pytest + numpy only, no OCP).
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

import copy
import json
import os
import zipfile
from pathlib import Path
from typing import Any

import doc_cache as dc
import pytest


def _sketch() -> dict[str, Any]:
    return {
        "id": "sk1",
        "datumId": "XY",
        "primitives": [{"id": "p1", "type": "point", "x": 1.0, "y": 2.0}],
        "constraints": [],
        "parameters": {"w": 10.0},
    }


def _curve() -> dict[str, Any]:
    return {
        "id": "cu1",
        "source": {"kind": "points"},
        "samples": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
    }


def _feature() -> dict[str, Any]:
    return {
        "id": "pad1",
        "type": "pad",
        "sketchId": "sk1",
        "params": {"length": 5.0},
        "dependsOn": [],
    }


def _ctx() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return _feature(), {"sk1": _sketch()}, {"cu1": _curve()}


def test_builder_version_contract() -> None:
    # Bump only with a comment in doc_cache.py: this invalidates every sidecar.
    assert dc.BUILDER_VERSION == 3


def test_key_deterministic() -> None:
    feature, sketches, curves = _ctx()
    first = dc.compute_feature_key(feature, sketches_by_id=sketches, curves_by_id=curves)
    second = dc.compute_feature_key(feature, sketches_by_id=sketches, curves_by_id=curves)
    assert first == second
    assert len(first) == 64  # sha256 hex


def test_key_param_change_changes_key() -> None:
    feature, sketches, curves = _ctx()
    before = dc.compute_feature_key(feature, sketches_by_id=sketches)
    feature["params"] = {"length": 6.0}
    after = dc.compute_feature_key(feature, sketches_by_id=sketches, curves_by_id=curves)
    assert before != after


def test_key_dict_order_independent() -> None:
    feature, sketches, _ = _ctx()
    reordered = copy.deepcopy(feature)
    reordered["params"] = {"b": 2.0, "a": 1.0}
    feature["params"] = {"a": 1.0, "b": 2.0}
    assert dc.compute_feature_key(feature, sketches_by_id=sketches) == dc.compute_feature_key(
        reordered, sketches_by_id=sketches
    )


def test_key_sketch_primitive_change() -> None:
    feature, sketches, _ = _ctx()
    before = dc.compute_feature_key(feature, sketches_by_id=sketches)
    sketches["sk1"]["primitives"].append({"id": "p2", "type": "point", "x": 3.0, "y": 4.0})
    assert dc.compute_feature_key(feature, sketches_by_id=sketches) != before


def test_key_sketch_datum_change() -> None:
    feature, sketches, _ = _ctx()
    before = dc.compute_feature_key(feature, sketches_by_id=sketches)
    sketches["sk1"]["datumId"] = "YZ"
    assert dc.compute_feature_key(feature, sketches_by_id=sketches) != before


def test_key_curve_sample_change() -> None:
    feature = {"id": "sw1", "type": "sweep", "params": {"pathCurveId": "cu1"}}
    _, _, curves = _ctx()
    before = dc.compute_feature_key(feature, curves_by_id=curves)
    curves["cu1"]["samples"].append([2.0, 0.0, 0.0])
    assert dc.compute_feature_key(feature, curves_by_id=curves) != before


def test_key_upstream_change() -> None:
    feature, sketches, _ = _ctx()
    before = dc.compute_feature_key(feature, sketches_by_id=sketches)
    changed = dc.compute_feature_key(
        feature, sketches_by_id=sketches, upstream_keys={"pad0": "deadbeef"}
    )
    assert changed != before
    # Upstream map order must not matter.
    multi_a = dc.compute_feature_key(
        feature, sketches_by_id=sketches, upstream_keys={"a": "1", "b": "2"}
    )
    multi_b = dc.compute_feature_key(
        feature, sketches_by_id=sketches, upstream_keys={"b": "2", "a": "1"}
    )
    assert multi_a == multi_b


def test_key_version_inputs() -> None:
    feature, sketches, _ = _ctx()
    base = dc.compute_feature_key(feature, sketches_by_id=sketches)
    assert (
        dc.compute_feature_key(
            feature, sketches_by_id=sketches, builder_version=dc.BUILDER_VERSION + 1
        )
        != base
    )
    assert dc.compute_feature_key(feature, sketches_by_id=sketches, ocp_version="7.9") != base


def test_sketch_key_covers_primitives_and_datum() -> None:
    sketch = _sketch()
    before = dc.compute_sketch_key(sketch)
    tweaked = copy.deepcopy(sketch)
    tweaked["primitives"][0]["x"] = 9.0
    assert dc.compute_sketch_key(tweaked) != before
    moved = copy.deepcopy(sketch)
    moved["datumId"] = "XZ"
    assert dc.compute_sketch_key(moved) != before


def _doc() -> dict[str, Any]:
    return {
        "sketches": [_sketch(), {**_sketch(), "id": "sk2", "datumId": "YZ"}],
        "curves": [],
        "features": [
            {"id": "pad1", "type": "pad", "sketchId": "sk1", "params": {"length": 5.0}},
            {
                "id": "pad2",
                "type": "pad",
                "sketchId": "sk2",
                "params": {"length": 3.0},
                "dependsOn": ["pad1"],
            },
            {"id": "lone", "type": "pad", "sketchId": "sk2", "params": {"length": 1.0}},
        ],
    }


def test_document_keys_chain_upstream() -> None:
    keys = dc.compute_document_keys(_doc())
    assert set(keys) == {"pad1", "pad2", "lone"}
    edited = _doc()
    edited["features"][0]["params"] = {"length": 50.0}
    edited_keys = dc.compute_document_keys(edited)
    assert edited_keys["pad1"] != keys["pad1"]
    assert edited_keys["pad2"] != keys["pad2"]  # downstream follows upstream
    assert edited_keys["lone"] == keys["lone"]  # unrelated feature untouched


def test_document_keys_reject_cycle_and_unknown_dep() -> None:
    cyclic = _doc()
    cyclic["features"][0]["dependsOn"] = ["pad2"]
    cyclic["features"][1]["dependsOn"] = ["pad1"]
    with pytest.raises(ValueError, match="cycle"):
        dc.compute_document_keys(cyclic)
    dangling = _doc()
    dangling["features"][2]["dependsOn"] = ["nope"]
    with pytest.raises(ValueError, match="Unknown feature dependency"):
        dc.compute_document_keys(dangling)


def test_current_ocp_version_returns_str() -> None:
    assert isinstance(dc.current_ocp_version(), str)


def test_cache_path_for_document(tmp_path: Path) -> None:
    doc = tmp_path / "model.nuke-cad"
    assert dc.cache_path_for_document(doc) == tmp_path / "model.nuke-cache.zip"
    assert dc.cache_path_for_document(str(doc)).name == "model.nuke-cache.zip"


def test_store_lookup_roundtrip(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "model.nuke-cache.zip")
    assert cache.lookup("pad1", "key-1") is None  # missing file is a miss, no warning
    stored = cache.store(
        "pad1",
        input_key="key-1",
        shape_fingerprint="fp-1",
        brep_bytes=b"BREP!",
        tess_json='{"solids": []}',
    )
    assert stored.brep_bytes == b"BREP!"
    assert stored.tess_json == '{"solids": []}'
    hit = cache.lookup("pad1", "key-1")
    assert hit is not None
    assert (hit.input_key, hit.shape_fingerprint) == ("key-1", "fp-1")
    assert hit.brep_bytes == b"BREP!"
    assert hit.tess_json == '{"solids": []}'
    # Stale key is a miss, not an error.
    assert cache.lookup("pad1", "key-2") is None
    assert cache.lookup("missing", "key-1") is None
    assert len(cache) == 1
    assert cache.total_bytes() == len(b"BREP!") + len('{"solids": []}')
    # Single-zip layout: manifest + per-feature blobs.
    with zipfile.ZipFile(cache.path) as archive:
        assert sorted(archive.namelist()) == ["manifest.json", "pad1.brep", "pad1.tess.json"]
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["builderVersion"] == dc.BUILDER_VERSION
        assert manifest["features"]["pad1"]["inputKey"] == "key-1"


def test_store_accepts_tess_bytes(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", tess_json=b'{"a": 1}')
    assert cache.lookup("f", "k") is not None
    assert cache.lookup("f", "k").tess_json == '{"a": 1}'  # type: ignore[union-attr]


def test_store_overwrites_entry(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k1", shape_fingerprint="fp1", brep_bytes=b"one")
    cache.store("f", input_key="k2", shape_fingerprint="fp2", brep_bytes=b"two")
    assert cache.lookup("f", "k1") is None
    hit = cache.lookup("f", "k2")
    assert hit is not None and hit.brep_bytes == b"two"
    assert len(cache) == 1


def test_atomic_write_leaves_no_tmp(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"x")
    leftovers = [p for p in tmp_path.iterdir() if p.name != "c.nuke-cache.zip"]
    assert leftovers == []
    with zipfile.ZipFile(cache.path) as archive:
        assert archive.testzip() is None


def test_lru_eviction(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip", size_cap_bytes=10)
    cache.store("old", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=1.0)
    cache.store("mid", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=2.0)
    assert len(cache) == 2  # 5 + 5 bytes exactly fills the cap
    cache.store("new", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=3.0)
    assert cache.lookup("old", "k") is None  # least-recently-used entry evicted
    assert cache.lookup("mid", "k") is not None
    assert cache.lookup("new", "k") is not None


def test_corrupt_zip_warns_and_misses(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    path.write_bytes(b"this is not a zip")
    cache = dc.DocCache(path)
    with pytest.warns(UserWarning, match="corrupt result cache"):
        assert cache.lookup("f", "k") is None
    with pytest.warns(UserWarning, match="corrupt result cache"):
        assert cache.feature_ids() == []
    with pytest.warns(UserWarning, match="corrupt result cache"):
        assert cache.total_bytes() == 0
    # A later store heals the cache (warning once more while reading the damage).
    with pytest.warns(UserWarning, match="corrupt result cache"):
        cache.store("f", input_key="k", shape_fingerprint="fp")
    assert cache.lookup("f", "k") is not None


def test_corrupt_manifest_warns_and_misses(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", "{not json")
    cache = dc.DocCache(path)
    with pytest.warns(UserWarning, match="bad manifest"):
        assert cache.lookup("f", "k") is None


def test_builder_version_mismatch_invalidates(tmp_path: Path) -> None:
    path = tmp_path / "c.nuke-cache.zip"
    manifest = {"version": 1, "builderVersion": 999, "ocpVersion": "x", "features": {}}
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
    cache = dc.DocCache(path)
    with pytest.warns(UserWarning, match="builder version"):
        assert cache.lookup("f", "k") is None


def test_invalidate_clear_and_remove_stale(tmp_path: Path) -> None:
    cache = dc.DocCache(tmp_path / "c.nuke-cache.zip")
    assert cache.invalidate("ghost") is False  # missing zip counts as absent
    cache.store("a", input_key="ka", shape_fingerprint="fa", brep_bytes=b"a")
    cache.store("b", input_key="kb", shape_fingerprint="fb", brep_bytes=b"b")
    assert cache.invalidate("ghost") is False
    assert cache.invalidate("a") is True
    assert cache.lookup("a", "ka") is None
    dropped = cache.remove_stale({"b": "kb-changed"})
    assert dropped == ["b"]
    assert len(cache) == 0
    assert not cache.path.exists()  # last entry removed deletes the sidecar
    cache.store("c", input_key="kc", shape_fingerprint="fc")
    cache.clear()
    assert not cache.path.exists()
    assert cache.lookup("c", "kc") is None


def test_memory_backend_matches_file_backend(tmp_path: Path) -> None:
    memory = dc.MemoryDocCache()
    assert memory.lookup("f", "k") is None
    memory.store(
        "f", input_key="k", shape_fingerprint="fp", brep_bytes=b"blob", tess_json='{"s": 1}'
    )
    hit = memory.lookup("f", "k")
    assert hit is not None
    assert hit.brep_bytes == b"blob"
    assert hit.tess_json == '{"s": 1}'
    assert memory.lookup("f", "stale") is None
    assert (len(memory), memory.total_bytes()) == (1, len(b"blob") + len('{"s": 1}'))
    assert memory.remove_stale({"f": "other"}) == ["f"]
    assert memory.invalidate("ghost") is False
    memory.store("g", input_key="k", shape_fingerprint="fp")
    memory.clear()
    assert len(memory) == 0
    # Same LRU-with-size-cap policy as the file backend.
    small = dc.MemoryDocCache(size_cap_bytes=10)
    small.store("old", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=1.0)
    small.store("mid", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=2.0)
    small.store("new", input_key="k", shape_fingerprint="fp", brep_bytes=b"12345", updated_at=3.0)
    assert small.lookup("old", "k") is None
    assert small.lookup("mid", "k") is not None
    assert small.lookup("new", "k") is not None


def test_no_heavy_imports() -> None:
    """The module must stay importable without OCP/build123d installed."""
    with open(os.path.join(os.path.dirname(dc.__file__), "doc_cache.py")) as handle:
        source = handle.read()
    for line in source.splitlines():
        stripped = line.strip()
        assert not stripped.startswith("import OCP")
        assert not stripped.startswith("from OCP")
        assert not stripped.startswith("import build123d")
        assert not stripped.startswith("from build123d")


def test_tool_blob_and_meta_roundtrip(tmp_path: Path) -> None:
    """Tool shapes and boolean meta persist alongside the body blob."""
    cache = dc.DocCache(tmp_path / "t.nuke-cache.zip")
    stored = cache.store(
        "pat",
        input_key="k",
        shape_fingerprint="fp",
        brep_bytes=b"body",
        tool_bytes=b"tool",
        meta={"target": "b1", "consumed": ["b2"]},
    )
    assert stored.tool_bytes == b"tool"
    assert stored.meta == {"target": "b1", "consumed": ["b2"]}
    assert cache.lookup("pat", "k") == stored
    assert cache.lookup("pat", "other") is None


def test_tool_blob_missing_when_record_claims_it(tmp_path: Path) -> None:
    """A record claiming a tool blob without bytes on disk reads as a miss."""
    import zipfile as zf

    path = tmp_path / "t.nuke-cache.zip"
    cache = dc.DocCache(path)
    cache.store("f", input_key="k", shape_fingerprint="fp", brep_bytes=b"b", tool_bytes=b"t")
    with zf.ZipFile(path, "a") as archive:
        archive_list = archive.namelist()
    assert "f.tool.brep" in archive_list
    # Corrupt the entry by dropping the blob but keeping the flag.
    manifest_raw, blobs = dc._load_zip(path)
    del blobs["f.tool.brep"]
    dc._write_zip_atomic(path, manifest_raw, blobs)
    assert cache.lookup("f", "k") is None


def test_eviction_drops_tool_blobs(tmp_path: Path) -> None:
    """LRU eviction removes the tool blob together with the body blob."""
    import zipfile as zf

    cache = dc.DocCache(tmp_path / "t.nuke-cache.zip", size_cap_bytes=10)
    cache.store("a", input_key="k", shape_fingerprint="f", brep_bytes=b"12345", tool_bytes=b"67890")
    cache.store("b", input_key="k", shape_fingerprint="f", brep_bytes=b"12345")
    with zf.ZipFile(tmp_path / "t.nuke-cache.zip") as archive:
        names = set(archive.namelist())
    assert "a.tool.brep" not in names
    assert "a.brep" not in names


def test_datums_change_feature_key() -> None:
    """Datum-table edits invalidate every feature key (coarse but safe)."""
    feature, sketches, curves = _ctx()
    before = dc.compute_feature_key(
        feature, sketches_by_id=sketches, curves_by_id=curves, datums=[]
    )
    after = dc.compute_feature_key(
        feature,
        sketches_by_id=sketches,
        curves_by_id=curves,
        datums=[{"id": "dxy", "kind": "XY", "offset": 5.0}],
    )
    assert before != after


def test_external_refs_change_sketch_key() -> None:
    """External-reference edits invalidate the sketch key."""
    feature, sketches, curves = _ctx()
    plain = dc.compute_feature_key(feature, sketches_by_id=sketches, curves_by_id=curves)
    with_ref = copy.deepcopy(sketches)
    with_ref["sk1"] = dict(
        with_ref["sk1"],
        externalRefs=[{"featureId": "f0", "kind": "face", "fingerprint": {"a": 1}}],
    )
    changed = dc.compute_feature_key(feature, sketches_by_id=with_ref, curves_by_id=curves)
    assert plain != changed


def test_feature_order_changes_keys() -> None:
    """Reordering features changes keys even with identical content."""
    doc = {
        "version": 3,
        "name": "doc",
        "datums": [],
        "bodies": [{"id": "b", "name": "B"}],
        "sketches": [],
        "curves": [],
        "features": [
            {"id": "a", "type": "pad", "body": "b", "params": {}, "dependsOn": []},
            {"id": "b", "type": "pad", "body": "b", "params": {}, "dependsOn": ["a"]},
        ],
    }
    before = dc.compute_document_keys(doc)
    reordered = dict(doc, features=list(reversed(doc["features"])))
    after = dc.compute_document_keys(reordered)
    assert after != before
