#!/usr/bin/env python3
"""Topological fingerprint scoring for nuke-cad.

This module is pure Python + numpy and has no OCP/build123d dependency.  It
implements the geometric similarity scorer behind nuke-cad's topological
reference system: parametric features reference faces/edges by geometric
fingerprint rather than raw index, so references survive B-rep rebuilds.

A reference is resolved by comparing its geometric fingerprint to every
candidate face/edge extracted from the rebuilt shape.  The highest-scoring
candidate above a threshold wins.  When the top two scores are within
``ambiguity_margin`` the reference is marked ambiguous --- a symmetric edit
has made a deterministic guess unsafe and user repair is required.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

#: Default length scale used to normalize geometric distances.  It is expressed
#: in the same model units as ``center``/axis origin/``radius``.
DEFAULT_TOLERANCE_SCALE = 1.0

#: Minimum score a candidate must reach to be considered a match at all.
#: A face/edge type mismatch is treated as a hard failure (score 0), so type
#: equality is a prerequisite for any plausible match.
SCORE_THRESHOLD = 0.5

#: Number of top candidates reported for ambiguous and unmatched references
#: (repair UI uses these as suggestions).
AMBIGUITY_CANDIDATE_COUNT = 3


def _axis(
    origin: tuple[float, float, float], direction: tuple[float, float, float]
) -> dict[str, Any]:
    """Build the axis object expected by the TypeScript ``Axis`` contract."""
    return {"origin": origin, "direction": direction}


@dataclass(frozen=True)
class FaceFingerprint:
    """Geometric fingerprint of a single B-rep face.

    Python fields use snake_case for ergonomics; :meth:`to_dict` emits the
    camelCase keys and nested ``axis`` object required by the TypeScript
    ``FaceFingerprint`` contract.

    ``candidate_id`` and ``reference_id`` are optional bookkeeping fields; the
    scorer ignores them and they are omitted from serialization.
    """

    surface_type: str
    area: float
    center: tuple[float, float, float]
    normal: tuple[float, float, float] | None = None
    axis: dict[str, Any] | None = None
    radius: float | None = None
    minor_radius: float | None = None
    candidate_id: str | None = None
    reference_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the fingerprint to the TypeScript contract shape."""
        data: dict[str, Any] = {
            "surfaceType": self.surface_type,
            "area": self.area,
            "center": self.center,
        }
        if self.normal is not None:
            data["normal"] = self.normal
        if self.axis is not None:
            data["axis"] = self.axis
        if self.radius is not None:
            data["radius"] = self.radius
        if self.minor_radius is not None:
            data["minorRadius"] = self.minor_radius
        return data


@dataclass(frozen=True)
class EdgeFingerprint:
    """Geometric fingerprint of a single B-rep edge.

    Python fields use snake_case for ergonomics; :meth:`to_dict` emits the
    camelCase keys required by the TypeScript ``EdgeFingerprint`` contract.

    ``candidate_id`` and ``reference_id`` are optional bookkeeping fields; the
    scorer ignores them and they are omitted from serialization.
    """

    curve_type: str
    length: float
    start: tuple[float, float, float]
    end: tuple[float, float, float]
    center: tuple[float, float, float] | None = None
    candidate_id: str | None = None
    reference_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the fingerprint to the TypeScript contract shape."""
        data: dict[str, Any] = {
            "curveType": self.curve_type,
            "length": self.length,
            "start": self.start,
            "end": self.end,
        }
        if self.center is not None:
            data["center"] = self.center
        return data


@dataclass(frozen=True)
class ReferenceCandidate:
    """A candidate offered for an ambiguous or unmatched reference repair.

    ``candidate_id`` is a per-rebuild sort-order id (``face_0007`` style) that
    is not stable across rebuilds; the ``fingerprint`` is the candidate's real
    identity and is what the frontend stores when the user picks a replacement.
    """

    candidate_id: str
    score: float
    fingerprint: FaceFingerprint | EdgeFingerprint | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize the candidate to the RPC response shape."""
        data: dict[str, Any] = {"candidateId": self.candidate_id, "score": self.score}
        if self.fingerprint is not None:
            data["fingerprint"] = self.fingerprint.to_dict()
        return data


@dataclass(frozen=True)
class ReferenceMatch:
    """Resolution result for a single reference."""

    reference_index: int
    status: str
    candidate_id: str | None
    score: float
    runner_up_score: float
    candidates: list[ReferenceCandidate] | None = None


@dataclass(frozen=True)
class MatchResult:
    """Resolution result for a batch of references."""

    matches: list[ReferenceMatch]

    def matched(self) -> list[ReferenceMatch]:
        """Return the references that resolved to a single unambiguous match."""
        return [m for m in self.matches if m.status == "matched"]

    def broken(self) -> list[ReferenceMatch]:
        """Return references that were unmatched or ambiguous."""
        return [m for m in self.matches if m.status in ("unmatched", "ambiguous")]


def _as_array(value: tuple[float, float, float]) -> np.ndarray:
    return np.asarray(value, dtype=float)


def _is_finite_scalar(value: float) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _is_finite_point(value: tuple[float, float, float] | None) -> bool:
    if value is None:
        return True
    return len(value) == 3 and all(_is_finite_scalar(v) for v in value)


def _is_finite_fingerprint(fp: FaceFingerprint | EdgeFingerprint) -> bool:
    """Return False if any numeric field is NaN or infinite."""
    if isinstance(fp, FaceFingerprint):
        if not _is_finite_scalar(fp.area):
            return False
        if not _is_finite_point(fp.center):
            return False
        if not _is_finite_point(fp.normal):
            return False
        if fp.axis is not None:
            if not _is_finite_point(fp.axis.get("origin")) or not _is_finite_point(
                fp.axis.get("direction")
            ):
                return False
        if fp.radius is not None and not _is_finite_scalar(fp.radius):
            return False
        if fp.minor_radius is not None and not _is_finite_scalar(fp.minor_radius):
            return False
        return True

    if isinstance(fp, EdgeFingerprint):
        if not _is_finite_scalar(fp.length):
            return False
        if not _is_finite_point(fp.start) or not _is_finite_point(fp.end):
            return False
        if not _is_finite_point(fp.center):
            return False
        return True

    return False


def _safe_exp_distance(distance: float, scale: float) -> float:
    """Convert a Euclidean distance to a [0, 1] score using the tolerance scale."""
    if scale <= 0.0:
        scale = 1e-12
    return float(math.exp(-distance / scale))


def _normalized_ratio(a: float, b: float) -> float:
    """Return a [0, 1] similarity score for two positive scalar measurements."""
    if a <= 0.0 and b <= 0.0:
        return 1.0
    denom = max(abs(a), abs(b))
    if denom == 0.0:
        return 1.0
    return min(abs(a), abs(b)) / denom


def _clamp_cosine(cosine: float) -> float:
    """Clamp a cosine value to [-1, 1] to avoid floating-point overshoot."""
    return max(-1.0, min(1.0, cosine))


def _direction_similarity_abs(
    a: tuple[float, float, float] | None, b: tuple[float, float, float] | None
) -> float:
    """Absolute cosine similarity of two direction vectors.

    Axes are unoriented (a reversed axis is the same axis) and OCCT edge
    orientation is arbitrary, so the absolute value is used for both.
    """
    if a is None or b is None:
        return 1.0
    va = _as_array(a)
    vb = _as_array(b)
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        return 1.0
    cosine = _clamp_cosine(float(np.dot(va, vb) / (na * nb)))
    return abs(cosine)


def _normal_similarity(
    a: tuple[float, float, float] | None, b: tuple[float, float, float] | None
) -> float:
    """Signed cosine similarity of two face normals, mapped to [0, 1].

    Face normals are oriented: opposite normals (cosine = -1) score 0,
    aligned normals (cosine = +1) score 1.
    """
    if a is None or b is None:
        return 1.0
    va = _as_array(a)
    vb = _as_array(b)
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        return 1.0
    cosine = _clamp_cosine(float(np.dot(va, vb) / (na * nb)))
    return (cosine + 1.0) / 2.0


def _midpoint(
    start: tuple[float, float, float], end: tuple[float, float, float]
) -> tuple[float, float, float]:
    s = _as_array(start)
    e = _as_array(end)
    mid = (s + e) / 2.0
    return (float(mid[0]), float(mid[1]), float(mid[2]))


def _edge_center(fp: EdgeFingerprint) -> tuple[float, float, float]:
    if fp.center is not None:
        return fp.center
    return _midpoint(fp.start, fp.end)


def _face_orientation_similarity(ref: FaceFingerprint, cand: FaceFingerprint) -> float:
    if ref.normal is not None and cand.normal is not None:
        return _normal_similarity(ref.normal, cand.normal)
    if ref.axis is not None and cand.axis is not None:
        return _direction_similarity_abs(ref.axis["direction"], cand.axis["direction"])
    return 1.0


#: Closed curve types where start == end, so a start->end direction vector
#: is meaningless and should not contribute to orientation similarity.
_CLOSED_CURVE_TYPES = frozenset({"circle", "ellipse"})


def _edge_orientation_similarity(ref: EdgeFingerprint, cand: EdgeFingerprint) -> float:
    if ref.curve_type in _CLOSED_CURVE_TYPES or cand.curve_type in _CLOSED_CURVE_TYPES:
        return 1.0
    ref_dir = _as_array(ref.end) - _as_array(ref.start)
    cand_dir = _as_array(cand.end) - _as_array(cand.start)
    return _direction_similarity_abs(
        (float(ref_dir[0]), float(ref_dir[1]), float(ref_dir[2])),
        (float(cand_dir[0]), float(cand_dir[1]), float(cand_dir[2])),
    )


def score_fingerprint(
    reference: FaceFingerprint | EdgeFingerprint,
    candidate: FaceFingerprint | EdgeFingerprint,
    tolerance_scale: float = DEFAULT_TOLERANCE_SCALE,
) -> float:
    """Return a geometric similarity score in ``[0, 1]``.

    The score is a weighted combination of:

    * **Surface/curve type match** (40 % faces / 45 % edges): a type mismatch
      returns 0 immediately because type equality is a hard prerequisite.
    * **Center proximity** (25 % faces / 25 % edges): ``exp(-distance /
      tolerance_scale)`` so small translations lose score smoothly.
    * **Orientation alignment** (20 % faces / 15 % edges): face normals use
      signed cosine mapped to ``[0, 1]`` (opposite normals are different faces);
      axes and edge directions use absolute cosine because they are
      unoriented / orientation-arbitrary.
    * **Size ratio** (10 % faces / 15 % edges): ``min(a,b) / max(a,b)`` of
      face areas or edge lengths.
    * **Radius similarity** (5 % faces only): exponential falloff of the
      absolute radius delta, only when both face fingerprints carry a radius.

    Non-finite numeric values in either fingerprint result in a score of 0.

    The function is deterministic and symmetric in ``reference`` and
    ``candidate`` except for the radius/length/area fields used only as ratios.
    """
    if not _is_finite_fingerprint(reference) or not _is_finite_fingerprint(candidate):
        return 0.0
    if isinstance(reference, FaceFingerprint) and isinstance(candidate, FaceFingerprint):
        return _score_face(reference, candidate, tolerance_scale)
    if isinstance(reference, EdgeFingerprint) and isinstance(candidate, EdgeFingerprint):
        return _score_edge(reference, candidate, tolerance_scale)
    return 0.0


def _score_face(ref: FaceFingerprint, cand: FaceFingerprint, scale: float) -> float:
    if ref.surface_type != cand.surface_type:
        return 0.0
    center_dist = float(np.linalg.norm(_as_array(ref.center) - _as_array(cand.center)))
    center_score = _safe_exp_distance(center_dist, scale)
    orientation_score = _face_orientation_similarity(ref, cand)
    size_score = _normalized_ratio(ref.area, cand.area)
    radius_score = _radius_score(ref.radius, cand.radius, scale)
    minor_radius_score = _radius_score(ref.minor_radius, cand.minor_radius, scale)

    # Radius and minor radius share the 5 % radius budget equally when present.
    radius_component = (
        radius_score
        if ref.minor_radius is None or cand.minor_radius is None
        else (radius_score + minor_radius_score) / 2.0
    )

    return (
        0.40 * 1.0
        + 0.25 * center_score
        + 0.20 * orientation_score
        + 0.10 * size_score
        + 0.05 * radius_component
    )


def _score_edge(ref: EdgeFingerprint, cand: EdgeFingerprint, scale: float) -> float:
    if ref.curve_type != cand.curve_type:
        return 0.0
    center_dist = float(
        np.linalg.norm(_as_array(_edge_center(ref)) - _as_array(_edge_center(cand)))
    )
    center_score = _safe_exp_distance(center_dist, scale)
    orientation_score = _edge_orientation_similarity(ref, cand)
    size_score = _normalized_ratio(ref.length, cand.length)

    return 0.45 * 1.0 + 0.25 * center_score + 0.15 * orientation_score + 0.15 * size_score


def _radius_score(a: float | None, b: float | None, scale: float) -> float:
    if a is None or b is None:
        return 1.0
    return _safe_exp_distance(abs(a - b), scale)


def match_references(
    refs: list[FaceFingerprint] | list[EdgeFingerprint],
    candidates: list[FaceFingerprint] | list[EdgeFingerprint],
    *,
    tolerance_scale: float = DEFAULT_TOLERANCE_SCALE,
    ambiguity_margin: float = 0.05,
) -> MatchResult:
    """Match each reference to the best candidate from a rebuilt shape.

    For every reference the candidates are scored with :func:`score_fingerprint`.
    A reference is ``unmatched`` if its best score is below ``SCORE_THRESHOLD``,
    ``ambiguous`` if the gap between the top two scores is not larger than
    ``ambiguity_margin``, and ``matched`` otherwise.  Both ``ambiguous`` and
    ``unmatched`` references carry the top-``AMBIGUITY_CANDIDATE_COUNT``
    candidates (with fingerprints) so the repair UI can offer replacements.

    Candidates are assigned greedily in one-to-one fashion: references are
    processed in descending order of their best score, and each claims the
    highest-scoring still-available candidate.  Ambiguous references still
    receive a tentative candidate id (flagged for repair) so that two ambiguous
    references are not both mapped to the same geometric candidate.
    """
    if not refs:
        return MatchResult([])

    # Compute the full score matrix up front.
    scores = [
        [score_fingerprint(ref, cand, tolerance_scale) for cand in candidates] for ref in refs
    ]

    # Per-reference classification based on the full candidate list.
    class_meta: list[dict[str, Any]] = []
    for row in scores:
        if not row:
            class_meta.append(
                {"best_score": 0.0, "best_idx": None, "runner_up": 0.0, "status": "unmatched"}
            )
            continue

        sorted_idx = sorted(
            range(len(row)), key=lambda j: (-row[j], candidates[j].candidate_id or "")
        )
        best_idx = sorted_idx[0]
        best_score = row[best_idx]
        runner_idx = sorted_idx[1] if len(sorted_idx) > 1 else None
        runner_up = row[runner_idx] if runner_idx is not None else 0.0

        if best_score < SCORE_THRESHOLD:
            status = "unmatched"
        elif best_score - runner_up <= ambiguity_margin:
            status = "ambiguous"
        else:
            status = "matched"

        class_meta.append(
            {
                "best_score": best_score,
                "best_idx": best_idx,
                "runner_up": runner_up,
                "status": status,
            }
        )

    # Greedy one-to-one assignment.  Process refs with the strongest matches
    # first; ties are broken by reference index for determinism.
    assignment_order = sorted(range(len(refs)), key=lambda i: (-class_meta[i]["best_score"], i))
    assigned_candidate: set[int] = set()
    assigned_ref: dict[int, int] = {}

    for i in assignment_order:
        meta = class_meta[i]
        if meta["status"] == "unmatched":
            continue

        row = scores[i]
        sorted_idx = sorted(
            range(len(row)), key=lambda j: (-row[j], candidates[j].candidate_id or "")
        )
        chosen: int | None = None
        for j in sorted_idx:
            if j not in assigned_candidate:
                chosen = j
                break

        if chosen is None or row[chosen] < SCORE_THRESHOLD:
            # No usable candidate left for this reference.
            meta["status"] = "unmatched"
            continue

        assigned_candidate.add(chosen)
        assigned_ref[i] = chosen
        meta["assigned_score"] = row[chosen]

    matches: list[ReferenceMatch] = []
    for i, meta in enumerate(class_meta):
        if i in assigned_ref:
            j = assigned_ref[i]
            cand_id = candidates[j].candidate_id
            score = round(meta.get("assigned_score", scores[i][j]), 6)
        else:
            cand_id = None
            score = round(meta["best_score"], 6)

        ambiguity_candidates: list[ReferenceCandidate] | None = None
        if meta["status"] in ("ambiguous", "unmatched"):
            # Repair candidates are offered for both ambiguous and unmatched
            # references: the fingerprint (not the per-rebuild candidate id) is
            # what the frontend stores as the replacement reference.
            row = scores[i]
            sorted_idx = sorted(
                range(len(row)),
                key=lambda j: (-row[j], candidates[j].candidate_id or ""),
            )
            ambiguity_candidates = [
                ReferenceCandidate(
                    candidate_id=candidates[j].candidate_id or "",
                    score=round(row[j], 6),
                    fingerprint=candidates[j],
                )
                for j in sorted_idx[:AMBIGUITY_CANDIDATE_COUNT]
                if candidates[j].candidate_id
            ]

        matches.append(
            ReferenceMatch(
                reference_index=i,
                status=meta["status"],
                candidate_id=cand_id,
                score=score,
                runner_up_score=round(meta["runner_up"], 6),
                candidates=ambiguity_candidates,
            )
        )

    return MatchResult(matches)
