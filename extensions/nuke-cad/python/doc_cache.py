#!/usr/bin/env python3
"""Per-feature result cache for `.nuke-cad` documents (P2 Tier-4 perf work).

Single-zip sidecar layout (brief §1): ``<stem>.nuke-cache.zip`` beside the
document holds ``manifest.json`` plus one ``<featureId>.brep`` blob and one
``<featureId>.tess.json`` blob per cached feature. All zip IO is stdlib
``zipfile``; writes are atomic (tmp file + rename).

Cache identity (brief §2) is a SHA-256 over the canonical feature JSON:
params + sketch primitives snapshot + referenced curve samples + upstream
feature keys + ``BUILDER_VERSION`` + OCP version. Keys are computed from the
document JSON only, so the open fast path needs no backend call. A backend
shape fingerprint is stored alongside each entry for change detection; any
hash mismatch (external edit, builder upgrade) fails safe to a full rebuild.

Reads never raise: a missing/corrupt zip (or manifest) warns and is treated
as a miss (brief §10). ``MemoryDocCache`` offers the same interface for
untitled documents (brief §5): no URI, no zip.

Key-system split (do not "fix" by merging): the TypeScript side computes its
OWN keys for the in-session memory cache, and this module computes keys for
the zip sidecar. The two grammars differ (notably number formatting) and are
NEVER compared across the language boundary — each flow is self-consistent
(TS keys stay in TS, zip keys stay in Python). Cross-side comparison would
always miss at best and poison at worst.

Pure stdlib only (hashlib/json/zipfile/...) so this module stays importable
in the minimal pytest profile (pytest + numpy, no OCP).

Doc-level tessellation blob (brief §9, DOC-LEVEL revision): besides the
per-feature blobs the sidecar holds ONE ``__doc__.tess.json`` blob with the
whole document tessellation text, described by the manifest ``tess`` section
(``docHash``/``tolerance``/``lengthScale``/``updatedAt``/``sizeBytes``).
Doc-level — not per-feature — because per-feature facet blobs cannot survive
boolean reindexing (fuse/cut renumber solids and faces), while a doc-level
blob keyed by :func:`compute_tess_doc_hash` skips meshing soundly: any
geometry-affecting edit changes the hash and the blob is simply a miss. The
blob counts toward the LRU/size cap like any feature entry.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import warnings
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any

#: Builder-semantics version baked into every cache key and manifest.
#:
#: CONTRACT: bump this integer on ANY change to builder semantics — feature
#: execution, sketch-face construction, curve fitting, tessellation, shape
#: fingerprinting, or the key-canonicalization below. A bump invalidates
#: every existing cache loudly (whole-zip miss with a warning); forgetting
#: the bump risks silent cache poisoning (stale geometry served as fresh).
BUILDER_VERSION = 1

#: Manifest schema version (bump only for manifest-layout changes).
MANIFEST_VERSION = 1

MANIFEST_NAME = "manifest.json"

#: Size-cap preference default (brief §6: ``nukeCad.resultCacheSizeMB``).
DEFAULT_SIZE_CAP_BYTES = 1024 * 1024 * 1024

#: OCP-version sentinel used when the OCP distribution is not installed
#: (minimal profile) or the caller does not pass an explicit version.
UNKNOWN_OCP_VERSION = "unknown"


def _warn(message: str) -> None:
    warnings.warn(message, UserWarning, stacklevel=3)


@dataclass
class CachedFeature:
    """One cache-hit entry: blobs plus the key/fingerprint they were built from."""

    feature_id: str
    input_key: str
    shape_fingerprint: str
    brep_bytes: bytes | None
    tess_json: str | None
    updated_at: float
    tool_bytes: bytes | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def _json_default(value: Any) -> Any:
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def canonical_bytes(value: Any) -> bytes:
    """Canonical JSON encoding: sorted keys, compact separators, UTF-8."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=_json_default,
    ).encode("utf-8")


def current_ocp_version() -> str:
    """Best-effort OCP distribution version; ``UNKNOWN_OCP_VERSION`` when absent."""
    for dist in ("cadquery-ocp", "OCP", "build123d"):
        try:
            return importlib_metadata.version(dist)
        except importlib_metadata.PackageNotFoundError:
            continue
    return UNKNOWN_OCP_VERSION


def _feature_sketch_ids(feature: Mapping[str, Any]) -> list[str]:
    """Sketch ids a feature's geometry depends on (sketch-as-node, brief §4)."""
    ids: list[str] = []
    sketch_id = feature.get("sketchId")
    if isinstance(sketch_id, str) and sketch_id:
        ids.append(sketch_id)
    params = feature.get("params")
    if isinstance(params, Mapping):
        section_ids = params.get("sectionSketchIds")
        if isinstance(section_ids, list):
            ids.extend(s for s in section_ids if isinstance(s, str) and s)
    seen: set[str] = set()
    ordered: list[str] = []
    for sid in ids:
        if sid not in seen:
            seen.add(sid)
            ordered.append(sid)
    return ordered


def _feature_curve_ids(feature: Mapping[str, Any]) -> list[str]:
    """Curve ids a feature's geometry depends on (sweep/pipe path curves)."""
    params = feature.get("params")
    if not isinstance(params, Mapping):
        return []
    curve_id = params.get("pathCurveId")
    if isinstance(curve_id, str) and curve_id:
        return [curve_id]
    return []


def _sketch_snapshot(sketch: Mapping[str, Any]) -> dict[str, Any]:
    """Solved-primitive snapshot: the sketch inputs the builder consumes."""
    return {
        "datumId": sketch.get("datumId"),
        "primitives": sketch.get("primitives", []),
        "constraints": sketch.get("constraints", []),
        "parameters": sketch.get("parameters", {}),
        "externalRefs": sketch.get("externalRefs", []),
    }


def _curve_snapshot(curve: Mapping[str, Any]) -> dict[str, Any]:
    """Curve snapshot: source recipe plus the stored sample polyline."""
    return {
        "source": curve.get("source"),
        "samples": curve.get("samples", []),
    }


def compute_sketch_key(
    sketch: Mapping[str, Any],
    *,
    builder_version: int = BUILDER_VERSION,
    ocp_version: str = UNKNOWN_OCP_VERSION,
) -> str:
    """Content key for a sketch node (primitive JSON + datum snapshot, brief §4)."""
    payload = {
        "kind": "sketch",
        "builderVersion": builder_version,
        "ocpVersion": ocp_version,
        "sketch": _sketch_snapshot(sketch),
    }
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def compute_feature_key(
    feature: Mapping[str, Any],
    *,
    sketches_by_id: Mapping[str, Mapping[str, Any]] | None = None,
    curves_by_id: Mapping[str, Mapping[str, Any]] | None = None,
    upstream_keys: Mapping[str, str] | None = None,
    datums: list[Any] | None = None,
    order: int = 0,
    builder_version: int = BUILDER_VERSION,
    ocp_version: str = UNKNOWN_OCP_VERSION,
) -> str:
    """Content key for one feature (brief §2).

    Hashes the canonical params JSON, the referenced sketches' primitive
    snapshots, the referenced curves' source + samples, the upstream
    features' cache keys (sorted by id), the whole datum table (coarse but
    safe: any datum edit invalidates every key rather than risk a stale
    face-datum workplane), ``BUILDER_VERSION``, and the OCP version.
    Unknown sketch/curve references hash as ``None`` (the builder fails them
    loudly later); they must not collide with a real snapshot.
    """
    sketches = sketches_by_id or {}
    curves = curves_by_id or {}
    sketch_ids = _feature_sketch_ids(feature)
    curve_ids = _feature_curve_ids(feature)
    payload = {
        "kind": "feature",
        "builderVersion": builder_version,
        "ocpVersion": ocp_version,
        "order": order,
        "type": feature.get("type"),
        "params": feature.get("params", {}),
        "sketches": {
            sid: _sketch_snapshot(sketches[sid]) if sid in sketches else None for sid in sketch_ids
        },
        "curves": {
            cid: _curve_snapshot(curves[cid]) if cid in curves else None for cid in curve_ids
        },
        "datums": list(datums) if datums is not None else [],
        "upstream": {dep: upstream_keys[dep] for dep in sorted(upstream_keys or {})},
    }
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def compute_document_keys(
    document: Mapping[str, Any],
    *,
    builder_version: int = BUILDER_VERSION,
    ocp_version: str = UNKNOWN_OCP_VERSION,
) -> dict[str, str]:
    """Key for every feature in a document, chained over ``dependsOn`` edges.

    Features are keyed in topological order so each feature's ``upstream``
    map holds its predecessors' keys; editing an upstream feature therefore
    changes every downstream key. Raises ``ValueError`` on unknown
    dependencies or dependency cycles.
    """
    features = document.get("features", [])
    sketches = {s["id"]: s for s in document.get("sketches", []) if isinstance(s, Mapping)}
    curves = {c["id"]: c for c in document.get("curves", []) if isinstance(c, Mapping)}
    by_id = {f["id"]: f for f in features if isinstance(f, Mapping)}
    ordered: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(fid: str, stack: list[str]) -> None:
        if fid in visited:
            return
        if fid in visiting:
            cycle = " -> ".join([*stack, fid])
            raise ValueError(f"Dependency cycle detected: {cycle}")
        feature = by_id.get(fid)
        if feature is None:
            raise ValueError(f"Unknown feature dependency: {fid!r}")
        visiting.add(fid)
        depends = feature.get("dependsOn", [])
        if not isinstance(depends, list):
            raise ValueError(f"Feature {fid!r} has a non-list dependsOn")
        for dep in depends:
            visit(dep, [*stack, fid])
        visiting.discard(fid)
        visited.add(fid)
        ordered.append(fid)

    for feature in features:
        if isinstance(feature, Mapping) and "id" in feature:
            visit(feature["id"], [])

    keys: dict[str, str] = {}
    datums = document.get("datums", [])
    doc_order = [f["id"] for f in features if isinstance(f, Mapping) and "id" in f]
    for fid in ordered:
        feature = by_id[fid]
        depends = feature.get("dependsOn", [])
        upstream = {dep: keys[dep] for dep in depends}
        keys[fid] = compute_feature_key(
            feature,
            sketches_by_id=sketches,
            curves_by_id=curves,
            upstream_keys=upstream,
            datums=datums if isinstance(datums, list) else [],
            order=doc_order.index(fid),
            builder_version=builder_version,
            ocp_version=ocp_version,
        )
    return keys


def cache_path_for_document(document_path: str | Path) -> Path:
    """Sidecar path for a document: ``<stem>.nuke-cache.zip`` beside it (brief §1)."""
    path = Path(document_path)
    return path.parent / f"{path.stem}.nuke-cache.zip"


def _brep_name(feature_id: str) -> str:
    return f"{feature_id}.brep"


def _tess_name(feature_id: str) -> str:
    return f"{feature_id}.tess.json"


def _tool_name(feature_id: str) -> str:
    """Sidecar blob for a solid-producer's tool shape (pattern source reuse)."""
    return f"{feature_id}.tool.brep"


#: Blob name for the DOC-LEVEL tessellation cache (brief §9 revision): one
#: ``__doc__.tess.json`` blob per sidecar holds the whole document
#: tessellation text. The ``__doc__`` prefix cannot collide with a feature id
#: blob (``<featureId>.tess.json`` always carries the feature id).
TESS_BLOB_NAME = "__doc__.tess.json"


def compute_tess_doc_hash(
    document: Mapping[str, Any],
    tolerance: float,
    length_scale: float,
    *,
    builder_version: int = BUILDER_VERSION,
    ocp_version: str = UNKNOWN_OCP_VERSION,
) -> str:
    """Content hash keying the doc-level tessellation blob (brief §9).

    SHA-256 over the C1-canonical JSON of the sorted per-feature keys from
    :func:`compute_document_keys` plus ``tolerance`` and ``lengthScale``.
    OCP-free (feature keys hash document JSON only), so the geometry service
    computes it before meshing. Any edit that changes built geometry changes
    a feature key and therefore this hash; tolerance and length-scale changes
    are key inputs because they change the emitted facets.
    """
    keys = compute_document_keys(document, builder_version=builder_version, ocp_version=ocp_version)
    payload = {
        "features": {fid: keys[fid] for fid in sorted(keys)},
        "lengthScale": length_scale,
        "tolerance": tolerance,
    }
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def _empty_manifest(ocp_version: str = UNKNOWN_OCP_VERSION) -> dict[str, Any]:
    return {
        "version": MANIFEST_VERSION,
        "builderVersion": BUILDER_VERSION,
        "ocpVersion": ocp_version,
        "features": {},
    }


def _load_zip(path: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Read (manifest, blobs); corrupt/missing zips warn and yield empty (brief §10)."""
    try:
        with zipfile.ZipFile(path, "r") as archive:
            try:
                manifest = json.loads(archive.read(MANIFEST_NAME).decode("utf-8"))
            except (KeyError, ValueError, UnicodeDecodeError) as exc:
                _warn(f"Ignoring corrupt result cache {path}: bad manifest ({exc})")
                return _empty_manifest(), {}
            if not isinstance(manifest, dict) or not isinstance(manifest.get("features"), dict):
                _warn(f"Ignoring corrupt result cache {path}: bad manifest shape")
                return _empty_manifest(), {}
            if manifest.get("builderVersion") != BUILDER_VERSION:
                _warn(
                    f"Ignoring result cache {path}: builder version "
                    f"{manifest.get('builderVersion')} != {BUILDER_VERSION} (full rebuild)"
                )
                return _empty_manifest(), {}
            blobs: dict[str, bytes] = {}
            for name in archive.namelist():
                if name != MANIFEST_NAME:
                    blobs[name] = archive.read(name)
            return manifest, blobs
    except FileNotFoundError:
        return _empty_manifest(), {}
    except (zipfile.BadZipFile, OSError, EOFError) as exc:
        _warn(f"Ignoring corrupt result cache {path}: {exc}")
        return _empty_manifest(), {}


def _record_size(record: Mapping[str, Any]) -> int:
    size = record.get("sizeBytes")
    if isinstance(size, int) and size >= 0:
        return size
    return 0


def _tess_size(record: Mapping[str, Any]) -> int:
    size = record.get("sizeBytes")
    if isinstance(size, int) and size >= 0:
        return size
    return 0


def _tess_record(manifest: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the manifest ``tess`` section, or ``None`` when absent/malformed."""
    tess = manifest.get("tess")
    return tess if isinstance(tess, dict) else None


def _manifest_total(manifest: Mapping[str, Any]) -> int:
    """Summed ``sizeBytes`` over feature records plus the doc-level tess blob."""
    total = 0
    records = manifest.get("features", {})
    if isinstance(records, dict):
        total += sum(_record_size(r) for r in records.values() if isinstance(r, dict))
    tess = _tess_record(manifest)
    if tess is not None:
        total += _tess_size(tess)
    return total


def _evict_lru(
    manifest: dict[str, Any],
    blobs: dict[str, bytes],
    size_cap_bytes: int,
    keep_id: str | None = None,
    keep_tess: bool = False,
) -> None:
    """Drop least-recently-used entries until under the cap (brief §6).

    The doc-level tess blob counts toward the cap like any feature entry.
    Feature entries evict oldest-first, sparing ``keep_id`` (the just-stored
    feature) while anything else can go; the tess section evicts next unless
    ``keep_tess`` protects the just-stored blob. A single oversized kept
    entry is held with a warning instead of making the store a no-op.
    """
    if _manifest_total(manifest) <= size_cap_bytes:
        return
    records = manifest.get("features", {})
    if not isinstance(records, dict):
        return
    for fid in sorted(records, key=lambda f: records[f].get("updatedAt", 0.0)):
        if _manifest_total(manifest) <= size_cap_bytes:
            break
        if fid == keep_id and (len(records) > 1 or _tess_record(manifest) is not None):
            continue
        record = records.pop(fid)
        _ = record
        blobs.pop(_brep_name(fid), None)
        blobs.pop(_tess_name(fid), None)
        blobs.pop(_tool_name(fid), None)
    if _manifest_total(manifest) <= size_cap_bytes:
        return
    if _tess_record(manifest) is not None and not keep_tess:
        del manifest["tess"]
        blobs.pop(TESS_BLOB_NAME, None)
        return
    if _manifest_total(manifest) <= size_cap_bytes:
        return
    kept = TESS_BLOB_NAME if keep_tess else repr(keep_id)
    _warn(
        f"Result-cache entry {kept} alone exceeds the size cap "
        f"({_manifest_total(manifest)} > {size_cap_bytes} bytes); keeping it"
    )


def _write_zip_atomic(path: Path, manifest: dict[str, Any], blobs: dict[str, bytes]) -> None:
    """Write the whole zip to a tmp sibling and rename over the target (brief §1)."""
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            with zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(MANIFEST_NAME, json.dumps(manifest, sort_keys=True))
                for name in sorted(blobs):
                    archive.writestr(name, blobs[name])
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _build_entry(
    feature_id: str, record: Mapping[str, Any], blobs: Mapping[str, bytes]
) -> CachedFeature | None:
    brep = blobs.get(_brep_name(feature_id))
    tess_raw = blobs.get(_tess_name(feature_id))
    tool = blobs.get(_tool_name(feature_id))
    if record.get("hasBrep") and brep is None:
        return None
    if record.get("hasTess") and tess_raw is None:
        return None
    if record.get("hasTool") and tool is None:
        return None
    tess_json = None
    if tess_raw is not None:
        try:
            tess_json = tess_raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    fingerprint = record.get("shapeFingerprint")
    input_key = record.get("inputKey")
    if not isinstance(fingerprint, str) or not isinstance(input_key, str):
        return None
    meta = record.get("meta")
    updated = record.get("updatedAt")
    return CachedFeature(
        feature_id=feature_id,
        input_key=input_key,
        shape_fingerprint=fingerprint,
        brep_bytes=brep,
        tess_json=tess_json,
        updated_at=float(updated) if isinstance(updated, (int, float)) else 0.0,
        tool_bytes=tool,
        meta=dict(meta) if isinstance(meta, dict) else {},
    )


class DocCache:
    """File-backed per-feature result cache (single-zip sidecar, brief §1)."""

    def __init__(self, path: str | Path, *, size_cap_bytes: int = DEFAULT_SIZE_CAP_BYTES) -> None:
        self._path = Path(path)
        self._size_cap_bytes = size_cap_bytes

    @property
    def path(self) -> Path:
        return self._path

    @property
    def size_cap_bytes(self) -> int:
        return self._size_cap_bytes

    def lookup(self, feature_id: str, input_key: str) -> CachedFeature | None:
        """Return the entry on an exact key match, else ``None`` (miss, brief §10).

        Never raises for missing/corrupt caches: corruption warns and is a miss.
        """
        manifest, blobs = _load_zip(self._path)
        record = manifest.get("features", {}).get(feature_id)
        if not isinstance(record, dict) or record.get("inputKey") != input_key:
            return None
        entry = _build_entry(feature_id, record, blobs)
        if entry is None:
            _warn(f"Ignoring corrupt result-cache entry {feature_id!r} in {self._path}")
            return None
        return entry

    def store(
        self,
        feature_id: str,
        *,
        input_key: str,
        shape_fingerprint: str,
        brep_bytes: bytes | None = None,
        tess_json: str | bytes | None = None,
        tool_bytes: bytes | None = None,
        meta: Mapping[str, Any] | None = None,
        updated_at: float | None = None,
    ) -> CachedFeature:
        """Write blobs + manifest atomically (tmp + rename), then LRU-evict.

        ``tool_bytes`` persists a solid-producer's tool shape for pattern
        source reuse; ``meta`` is a small verbatim sidecar (booleans store
        target/consumed bodies). Both are optional and backward compatible:
        entries written without them read back with ``None``/``{}``.
        """
        if isinstance(tess_json, str):
            tess_raw = tess_json.encode("utf-8")
        else:
            tess_raw = tess_json
        manifest, blobs = _load_zip(self._path)
        now = time.time() if updated_at is None else updated_at
        size = len(brep_bytes or b"") + len(tess_raw or b"") + len(tool_bytes or b"")
        records = manifest.setdefault("features", {})
        records[feature_id] = {
            "inputKey": input_key,
            "shapeFingerprint": shape_fingerprint,
            "hasBrep": brep_bytes is not None,
            "hasTess": tess_raw is not None,
            "hasTool": tool_bytes is not None,
            "meta": dict(meta) if isinstance(meta, Mapping) else {},
            "updatedAt": now,
            "sizeBytes": size,
        }
        if brep_bytes is not None:
            blobs[_brep_name(feature_id)] = bytes(brep_bytes)
        else:
            blobs.pop(_brep_name(feature_id), None)
        if tess_raw is not None:
            blobs[_tess_name(feature_id)] = bytes(tess_raw)
        else:
            blobs.pop(_tess_name(feature_id), None)
        if tool_bytes is not None:
            blobs[_tool_name(feature_id)] = bytes(tool_bytes)
        else:
            blobs.pop(_tool_name(feature_id), None)
        _evict_lru(manifest, blobs, self._size_cap_bytes, keep_id=feature_id)
        _write_zip_atomic(self._path, manifest, blobs)
        stored = records[feature_id]
        return _build_entry(feature_id, stored, blobs)  # type: ignore[return-value]

    def store_tess(
        self,
        doc_hash: str,
        tolerance: float,
        length_scale: float,
        tess_text: str | bytes,
        *,
        updated_at: float | None = None,
    ) -> None:
        """Write the DOC-LEVEL tessellation blob (brief §9 revision).

        Persists ``tess_text`` as ``__doc__.tess.json`` plus the manifest
        ``tess`` section (``docHash``/``tolerance``/``lengthScale``/
        ``updatedAt``/``sizeBytes``). The blob counts toward the LRU/size cap
        like any feature entry. Raises ``TypeError``/``UnicodeDecodeError``
        for non-text payloads; zip IO failures propagate to the caller (the
        geometry-service hook guards the store so a build never breaks).
        """
        if isinstance(tess_text, bytes):
            raw = bytes(tess_text)
            raw.decode("utf-8")  # validate text; raises UnicodeDecodeError otherwise
        elif isinstance(tess_text, str):
            raw = tess_text.encode("utf-8")
        else:
            raise TypeError(f"tess_text must be str or utf-8 bytes, got {type(tess_text).__name__}")
        manifest, blobs = _load_zip(self._path)
        now = time.time() if updated_at is None else updated_at
        manifest["tess"] = {
            "docHash": doc_hash,
            "tolerance": tolerance,
            "lengthScale": length_scale,
            "updatedAt": now,
            "sizeBytes": len(raw),
        }
        blobs[TESS_BLOB_NAME] = raw
        _evict_lru(manifest, blobs, self._size_cap_bytes, keep_tess=True)
        _write_zip_atomic(self._path, manifest, blobs)

    def lookup_tess(self, doc_hash: str, tolerance: float, length_scale: float) -> str | None:
        """Return the cached tessellation text on an exact key match, else ``None``.

        The ``docHash``/``tolerance``/``lengthScale`` triple must match
        exactly; a missing/corrupt zip or section is a miss (warns like the
        feature path, never raises for IO damage).
        """
        manifest, blobs = _load_zip(self._path)
        record = _tess_record(manifest)
        if record is None:
            return None
        if record.get("docHash") != doc_hash:
            return None
        if record.get("tolerance") != tolerance:
            return None
        if record.get("lengthScale") != length_scale:
            return None
        raw = blobs.get(TESS_BLOB_NAME)
        if raw is None:
            _warn(f"Ignoring corrupt result-cache tess entry in {self._path}")
            return None
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            _warn(f"Ignoring corrupt result-cache tess entry in {self._path}")
            return None

    def invalidate(self, feature_id: str) -> bool:
        """Drop one entry; ``False`` when absent (missing zip counts as absent)."""
        manifest, blobs = _load_zip(self._path)
        records = manifest.get("features", {})
        if feature_id not in records:
            return False
        del records[feature_id]
        blobs.pop(_brep_name(feature_id), None)
        blobs.pop(_tess_name(feature_id), None)
        blobs.pop(_tool_name(feature_id), None)
        if not records and _tess_record(manifest) is None:
            try:
                self._path.unlink(missing_ok=True)
            except OSError as exc:
                _warn(f"Could not remove empty result cache {self._path}: {exc}")
                return False
            return True
        _write_zip_atomic(self._path, manifest, blobs)
        return True

    def remove_stale(self, current_keys: Mapping[str, str]) -> list[str]:
        """Drop entries whose id is gone or whose key changed; returns dropped ids."""
        manifest, blobs = _load_zip(self._path)
        records = manifest.get("features", {})
        stale = [
            fid
            for fid, record in records.items()
            if not isinstance(record, dict) or current_keys.get(fid) != record.get("inputKey")
        ]
        if not stale:
            return []
        for fid in stale:
            del records[fid]
            blobs.pop(_brep_name(fid), None)
            blobs.pop(_tess_name(fid), None)
            blobs.pop(_tool_name(fid), None)
        if not records and _tess_record(manifest) is None:
            try:
                self._path.unlink(missing_ok=True)
            except OSError as exc:
                _warn(f"Could not remove empty result cache {self._path}: {exc}")
                return stale
            return stale
        _write_zip_atomic(self._path, manifest, blobs)
        return stale

    def clear(self) -> None:
        """Remove the whole sidecar; missing file is a no-op, never an error."""
        try:
            self._path.unlink(missing_ok=True)
        except OSError as exc:
            _warn(f"Could not clear result cache {self._path}: {exc}")

    def feature_ids(self) -> list[str]:
        """Ids present in the manifest (corrupt/missing cache reads as empty)."""
        manifest, _ = _load_zip(self._path)
        records = manifest.get("features", {})
        return sorted(records) if isinstance(records, dict) else []

    def total_bytes(self) -> int:
        """Summed ``sizeBytes`` over manifest records plus the tess blob (0 when missing)."""
        manifest, _ = _load_zip(self._path)
        if not isinstance(manifest, dict):
            return 0
        return _manifest_total(manifest)

    def __len__(self) -> int:
        return len(self.feature_ids())


class MemoryDocCache:
    """Untitled-document backend (brief §5): same interface, no URI, no zip."""

    def __init__(self, *, size_cap_bytes: int = DEFAULT_SIZE_CAP_BYTES) -> None:
        self._size_cap_bytes = size_cap_bytes
        self._records: dict[str, dict[str, Any]] = {}
        self._blobs: dict[str, bytes] = {}
        self._tess: dict[str, Any] | None = None

    def _facade(self) -> dict[str, Any]:
        """Manifest-shaped view over the memory entries for shared eviction."""
        facade: dict[str, Any] = {"features": self._records}
        if self._tess is not None:
            facade["tess"] = self._tess
        return facade

    def _sync_tess(self, facade: dict[str, Any]) -> None:
        """Mirror a facade-side tess eviction back onto the memory entry."""
        if "tess" not in facade:
            self._tess = None

    @property
    def size_cap_bytes(self) -> int:
        return self._size_cap_bytes

    def lookup(self, feature_id: str, input_key: str) -> CachedFeature | None:
        record = self._records.get(feature_id)
        if record is None or record.get("inputKey") != input_key:
            return None
        return _build_entry(feature_id, record, self._blobs)

    def store(
        self,
        feature_id: str,
        *,
        input_key: str,
        shape_fingerprint: str,
        brep_bytes: bytes | None = None,
        tess_json: str | bytes | None = None,
        tool_bytes: bytes | None = None,
        meta: Mapping[str, Any] | None = None,
        updated_at: float | None = None,
    ) -> CachedFeature:
        if isinstance(tess_json, str):
            tess_raw = tess_json.encode("utf-8")
        else:
            tess_raw = tess_json
        now = time.time() if updated_at is None else updated_at
        size = len(brep_bytes or b"") + len(tess_raw or b"") + len(tool_bytes or b"")
        self._records[feature_id] = {
            "inputKey": input_key,
            "shapeFingerprint": shape_fingerprint,
            "hasBrep": brep_bytes is not None,
            "hasTess": tess_raw is not None,
            "hasTool": tool_bytes is not None,
            "meta": dict(meta) if isinstance(meta, Mapping) else {},
            "updatedAt": now,
            "sizeBytes": size,
        }
        if brep_bytes is not None:
            self._blobs[_brep_name(feature_id)] = bytes(brep_bytes)
        else:
            self._blobs.pop(_brep_name(feature_id), None)
        if tess_raw is not None:
            self._blobs[_tess_name(feature_id)] = bytes(tess_raw)
        else:
            self._blobs.pop(_tess_name(feature_id), None)
        if tool_bytes is not None:
            self._blobs[_tool_name(feature_id)] = bytes(tool_bytes)
        else:
            self._blobs.pop(_tool_name(feature_id), None)
        facade = self._facade()
        _evict_lru(facade, self._blobs, self._size_cap_bytes, keep_id=feature_id)
        self._sync_tess(facade)
        return _build_entry(feature_id, self._records[feature_id], self._blobs)  # type: ignore[return-value]

    def store_tess(
        self,
        doc_hash: str,
        tolerance: float,
        length_scale: float,
        tess_text: str | bytes,
        *,
        updated_at: float | None = None,
    ) -> None:
        """Memory twin of :meth:`DocCache.store_tess` (same key grammar, no zip)."""
        if isinstance(tess_text, bytes):
            raw = bytes(tess_text)
            raw.decode("utf-8")  # validate text; raises UnicodeDecodeError otherwise
        elif isinstance(tess_text, str):
            raw = tess_text.encode("utf-8")
        else:
            raise TypeError(f"tess_text must be str or utf-8 bytes, got {type(tess_text).__name__}")
        now = time.time() if updated_at is None else updated_at
        self._tess = {
            "docHash": doc_hash,
            "tolerance": tolerance,
            "lengthScale": length_scale,
            "updatedAt": now,
            "sizeBytes": len(raw),
        }
        self._blobs[TESS_BLOB_NAME] = raw
        facade = self._facade()
        _evict_lru(facade, self._blobs, self._size_cap_bytes, keep_tess=True)
        self._sync_tess(facade)

    def lookup_tess(self, doc_hash: str, tolerance: float, length_scale: float) -> str | None:
        """Memory twin of :meth:`DocCache.lookup_tess` (exact triple match, else miss)."""
        record = self._tess
        if record is None:
            return None
        if record.get("docHash") != doc_hash:
            return None
        if record.get("tolerance") != tolerance:
            return None
        if record.get("lengthScale") != length_scale:
            return None
        raw = self._blobs.get(TESS_BLOB_NAME)
        if raw is None:
            return None
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None

    def invalidate(self, feature_id: str) -> bool:
        if feature_id not in self._records:
            return False
        del self._records[feature_id]
        self._blobs.pop(_brep_name(feature_id), None)
        self._blobs.pop(_tess_name(feature_id), None)
        self._blobs.pop(_tool_name(feature_id), None)
        return True

    def remove_stale(self, current_keys: Mapping[str, str]) -> list[str]:
        stale = [
            fid
            for fid, record in self._records.items()
            if current_keys.get(fid) != record.get("inputKey")
        ]
        for fid in stale:
            self.invalidate(fid)
        return stale

    def clear(self) -> None:
        self._records.clear()
        self._blobs.clear()
        self._tess = None

    def feature_ids(self) -> list[str]:
        return sorted(self._records)

    def total_bytes(self) -> int:
        total = sum(_record_size(r) for r in self._records.values())
        if self._tess is not None:
            total += _tess_size(self._tess)
        return total

    def __len__(self) -> int:
        return len(self._records)
