#!/usr/bin/env python3
"""Assembly builder for `.nuke-cad` documents (Wave B1 backend).

Composes part instances into a placed assembly: resolves each instance's
``part`` source (same-document body, relative ``.nuke-cad`` document, or a
STEP/IGES/BREP exchange file), solves mate placements closed-form with a
grounded-first breadth-first search, and returns per-instance placed solids
plus the combined compound that feeds the shared ``_process_shape`` pipeline.

Resolution order for an instance ``part`` (first hit wins):

1. Same-document body (``body:<bodyId>`` or a bare body id).
2. Relative ``.nuke-cad`` path (built via ``feature_builder``; its labeled
   bodies become the instance's labeled solids).
3. STEP/IGES/BREP file path (via the existing ``geometry_service`` readers).

A missing source is a structured :class:`AssemblyBuildError` naming the
instance id and the source string.

Mate solving mirrors ``resolveMatePlacement`` in
``src/common/assembly-placement.ts``: for a mate between a solved instance
and an unsolved one, the solved side's connector frame is moved to assembly
space by its final placement, then the unsolved side's placement is the
closed form ``R = Ra.RbT``, ``t = pa - R.pb`` (mirrored into an OCP
``gp_Trsf`` when placing geometry). The grounded instance keeps its stored
placement; unmated non-grounded instances keep theirs. ``countAssemblyDof``
below zero is a warning (first mate wins), never fatal. Final transforms are
computed at build time by :func:`solve_assembly_placement` and never written
back to the document.

This module stays importable in the minimal pytest profile (pytest + numpy
only): build123d/OCP imports are guarded, and the pure placement math plus
source classification never touch them.
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
import math
import sys
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from ocp_compat import topods_solid  # noqa: E402

# Document builder modules guard their own heavy imports; the flags below
# keep this module importable (and its pure math testable) without OCP.
try:
    import feature_builder  # noqa: E402

    HAS_FEATURE_BUILDER = True
except Exception:
    feature_builder = None  # type: ignore
    HAS_FEATURE_BUILDER = False

try:
    import curve_builder  # noqa: E402

    HAS_CURVE_BUILDER = True
except Exception:
    curve_builder = None  # type: ignore
    HAS_CURVE_BUILDER = False


class AssemblyBuildError(ValueError):
    """Raised when an assembly cannot be resolved, solved, or built."""


#: Mate types in the frozen-spec order (mirrors ``MATE_TYPES``).
MATE_TYPES: tuple[str, ...] = ("fixed", "revolute", "slider", "cylindrical", "ball", "planar")

#: Free degrees of freedom per mate type, mirroring ``freeDofsForMateType``.
_FREE_DOFS: dict[str, int] = {
    "fixed": 0,
    "revolute": 1,
    "slider": 1,
    "cylindrical": 2,
    "ball": 3,
    "planar": 3,
}

#: Exchange-file suffixes handled by the file-instance path.
_EXCHANGE_SUFFIXES = (".step", ".stp", ".iges", ".igs", ".brep")

_PARALLEL_TOLERANCE = 1e-9


def count_assembly_dof(instance_count: int, mate_types: list[str]) -> int:
    """Remaining rigid-body DOFs: ``6 * (n - 1) - constrained``.

    Mirrors ``countAssemblyDof`` in ``assembly-placement.ts``; one instance is
    grounded and each mate removes ``6 - freeDofs`` constraints.
    """
    constrained = sum(6 - _FREE_DOFS[mate_type] for mate_type in mate_types)
    return 6 * (instance_count - 1) - constrained


def _is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _as_vec3(value: object) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise AssemblyBuildError(f"expected a [x, y, z] array of finite numbers, got {value!r}")
    if not all(_is_finite_number(v) for v in value):
        raise AssemblyBuildError(f"expected a [x, y, z] array of finite numbers, got {value!r}")
    return [float(value[0]), float(value[1]), float(value[2])]


def _as_quaternion(value: object) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise AssemblyBuildError(f"expected an [x, y, z, w] array of finite numbers, got {value!r}")
    if not all(_is_finite_number(v) for v in value):
        raise AssemblyBuildError(f"expected an [x, y, z, w] array of finite numbers, got {value!r}")
    return [float(value[0]), float(value[1]), float(value[2]), float(value[3])]


def _normalize_quaternion(q: list[float]) -> list[float]:
    length = math.sqrt(sum(c * c for c in q))
    if not length > _PARALLEL_TOLERANCE:
        raise AssemblyBuildError("cannot normalize a zero-length quaternion")
    return [c / length for c in q]


def _quaternion_to_matrix(q: list[float]) -> list[list[float]]:
    """Rotation rows for a unit quaternion (mirrors ``quaternionToMatrix``)."""
    x, y, z, w = _normalize_quaternion(q)
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def placement_to_matrix(placement: dict[str, Any]) -> list[float]:
    """Homogeneous row-major Mat4 for an authored ``InstancePlacement``.

    ``pos+quat`` preferred; raw ``matrix`` accepted (last row must be
    ``[0, 0, 0, 1]``).
    """
    if not isinstance(placement, dict):
        raise AssemblyBuildError(
            "instance placement must be an object with position+orientation or matrix"
        )
    if "matrix" in placement:
        matrix = placement["matrix"]
        if (
            not isinstance(matrix, (list, tuple))
            or len(matrix) != 16
            or not all(_is_finite_number(v) for v in matrix)
        ):
            raise AssemblyBuildError(
                "instance placement matrix must be a 16-element array of finite numbers"
            )
        values = [float(v) for v in matrix]
        if (
            abs(values[12]) > 1e-6
            or abs(values[13]) > 1e-6
            or abs(values[14]) > 1e-6
            or abs(values[15] - 1) > 1e-6
        ):
            raise AssemblyBuildError("instance placement matrix last row must be [0, 0, 0, 1]")
        return values
    rows = _quaternion_to_matrix(_as_quaternion(placement.get("orientation")))
    position = _as_vec3(placement.get("position"))
    return [
        rows[0][0],
        rows[0][1],
        rows[0][2],
        position[0],
        rows[1][0],
        rows[1][1],
        rows[1][2],
        position[1],
        rows[2][0],
        rows[2][1],
        rows[2][2],
        position[2],
        0.0,
        0.0,
        0.0,
        1.0,
    ]


def _mat3_rows_of(mat4: list[float]) -> list[list[float]]:
    return [[mat4[0], mat4[1], mat4[2]], [mat4[4], mat4[5], mat4[6]], [mat4[8], mat4[9], mat4[10]]]


def _translation_of(mat4: list[float]) -> list[float]:
    return [mat4[3], mat4[7], mat4[11]]


def orthonormalize_axes(
    x_axis: list[float], y_axis: list[float]
) -> tuple[list[float], list[float], list[float]]:
    """Gram-Schmidt orthonormalization completing ``z = x cross y``.

    Mirrors ``orthonormalizeConnectorAxes``; raises on degenerate axes.
    """
    x_length = math.sqrt(sum(c * c for c in x_axis))
    if not x_length > _PARALLEL_TOLERANCE:
        raise AssemblyBuildError("connector xAxis has zero length")
    x = [c / x_length for c in x_axis]
    projection = sum(a * b for a, b in zip(x, y_axis, strict=True))
    orthogonalized = [yv - projection * xv for xv, yv in zip(x, y_axis, strict=True)]
    y_length = math.sqrt(sum(c * c for c in orthogonalized))
    if not y_length > _PARALLEL_TOLERANCE:
        raise AssemblyBuildError("connector yAxis has zero length or is parallel to xAxis")
    y = [c / y_length for c in orthogonalized]
    z = [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
    ]
    return x, y, z


def _connector_frame(
    connector: dict[str, Any],
) -> tuple[list[float], list[float], list[float], list[float]]:
    """Local connector frame as ``(origin, x, y, z)`` with orthonormal axes."""
    origin = _as_vec3(connector.get("origin"))
    x, y, z = orthonormalize_axes(
        _as_vec3(connector.get("xAxis")), _as_vec3(connector.get("yAxis"))
    )
    return origin, x, y, z


def _apply_rows_to_point(rows: list[list[float]], point: list[float]) -> list[float]:
    return [sum(r * p for r, p in zip(row, point, strict=True)) for row in rows]


def _move_frame_to_world(
    placement: list[float], origin: list[float], x: list[float], y: list[float], z: list[float]
) -> tuple[list[float], list[float], list[float], list[float]]:
    """Move a local connector frame to assembly space via a final placement."""
    rows = _mat3_rows_of(placement)
    translation = _translation_of(placement)
    world_origin = [
        c + t for c, t in zip(_apply_rows_to_point(rows, origin), translation, strict=True)
    ]
    return (
        world_origin,
        _apply_rows_to_point(rows, x),
        _apply_rows_to_point(rows, y),
        _apply_rows_to_point(rows, z),
    )


def _resolve_mate_between_frames(
    frame_a: tuple[list[float], list[float], list[float], list[float]],
    frame_b: tuple[list[float], list[float], list[float], list[float]],
) -> list[float]:
    """Closed-form placement putting B's frame onto A's (``R = Ra.RbT``).

    Mirrors ``resolveMatePlacement``: ``frame_a`` lives in assembly space,
    ``frame_b`` in B-local space, and the returned Mat4 places B.
    """
    origin_a, xa, ya, za = frame_a
    origin_b, xb, yb, zb = frame_b
    cols_a = [xa, ya, za]
    cols_b = [xb, yb, zb]
    # R = Ra * Rb^T with rotations stored as axis columns: R[i][j] is the sum
    # over k of a_k[i] * b_k[j] (mirrors transposeTimes, not col-dot-col).
    rows = [
        [sum(cols_a[k][i] * cols_b[k][j] for k in range(3)) for j in range(3)] for i in range(3)
    ]
    rotated_origin = _apply_rows_to_point(rows, origin_b)
    translation = [a - r for a, r in zip(origin_a, rotated_origin, strict=True)]
    return [
        rows[0][0],
        rows[0][1],
        rows[0][2],
        translation[0],
        rows[1][0],
        rows[1][1],
        rows[1][2],
        translation[1],
        rows[2][0],
        rows[2][1],
        rows[2][2],
        translation[2],
        0.0,
        0.0,
        0.0,
        1.0,
    ]


def _validate_assembly_structure(
    assembly: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]], str]:
    """Structural validation mirroring ``validateAssemblyDocument``.

    Returns ``(instances, connectors, mates, grounded_id)``; raises
    :class:`AssemblyBuildError` on the first problem (the TypeScript side
    reports every problem, the backend fails fast with the same rules —
    including the one-mate-per-part-pair rule).
    """
    if not isinstance(assembly, dict):
        raise AssemblyBuildError("assembly section must be an object")
    raw_instances = assembly.get("instances", [])
    raw_connectors = assembly.get("connectors", [])
    raw_mates = assembly.get("mates", [])
    if (
        not isinstance(raw_instances, list)
        or not isinstance(raw_connectors, list)
        or not isinstance(raw_mates, list)
    ):
        raise AssemblyBuildError("assembly instances/connectors/mates must be arrays")

    instances: dict[str, dict[str, Any]] = {}
    for index, instance in enumerate(raw_instances):
        if not isinstance(instance, dict):
            raise AssemblyBuildError(f"assembly instances[{index}] must be an object")
        instance_id = instance.get("id")
        if not isinstance(instance_id, str) or not instance_id:
            raise AssemblyBuildError(f"assembly instances[{index}].id must be a non-empty string")
        if instance_id in instances:
            raise AssemblyBuildError(f"duplicate assembly instance id '{instance_id}'")
        if not isinstance(instance.get("part"), str) or not instance.get("part"):
            raise AssemblyBuildError(
                f"assembly instance '{instance_id}' needs a non-empty part source"
            )
        if not isinstance(instance.get("placement"), dict):
            raise AssemblyBuildError(f"assembly instance '{instance_id}' needs a placement object")
        placement_to_matrix(instance["placement"])  # validates encoding now
        scale = instance.get("scale")
        if scale is not None and not _valid_scale(scale):
            raise AssemblyBuildError(f"assembly instance '{instance_id}' scale must be positive")
        instances[instance_id] = instance

    grounded_id = assembly.get("groundedInstanceId")
    if not isinstance(grounded_id, str) or not grounded_id:
        raise AssemblyBuildError(
            "assembly groundedInstanceId must name the single grounded instance"
        )
    if grounded_id not in instances:
        raise AssemblyBuildError(f"assembly grounded instance '{grounded_id}' does not exist")

    connectors: dict[str, dict[str, Any]] = {}
    for index, connector in enumerate(raw_connectors):
        if not isinstance(connector, dict):
            raise AssemblyBuildError(f"assembly connectors[{index}] must be an object")
        connector_id = connector.get("id")
        if not isinstance(connector_id, str) or not connector_id:
            raise AssemblyBuildError(f"assembly connectors[{index}].id must be a non-empty string")
        if connector_id in connectors:
            raise AssemblyBuildError(f"duplicate assembly connector id '{connector_id}'")
        owner = connector.get("instanceId")
        if owner not in instances:
            raise AssemblyBuildError(
                f"assembly connector '{connector_id}' references unknown instance '{owner}'"
            )
        _connector_frame(connector)  # validates origin/axes now
        connectors[connector_id] = connector

    mates: list[dict[str, Any]] = []
    pair_to_mate: dict[tuple[str, str], str] = {}
    for index, mate in enumerate(raw_mates):
        if not isinstance(mate, dict):
            raise AssemblyBuildError(f"assembly mates[{index}] must be an object")
        mate_id = mate.get("id")
        if not isinstance(mate_id, str) or not mate_id:
            raise AssemblyBuildError(f"assembly mates[{index}].id must be a non-empty string")
        mate_type = mate.get("type")
        if mate_type not in MATE_TYPES:
            raise AssemblyBuildError(
                f"assembly mate '{mate_id}' has unknown type '{mate_type}' (expected one of {', '.join(MATE_TYPES)})"
            )
        for side in ("A", "B"):
            owner = mate.get(f"instance{side}")
            connector_ref = mate.get(f"connector{side}")
            if owner not in instances:
                raise AssemblyBuildError(
                    f"assembly mate '{mate_id}' references unknown instance '{owner}'"
                )
            target = connectors.get(connector_ref) if isinstance(connector_ref, str) else None
            if target is None:
                raise AssemblyBuildError(
                    f"assembly mate '{mate_id}' references unknown connector '{connector_ref}'"
                )
            if target.get("instanceId") != owner:
                raise AssemblyBuildError(
                    f"assembly mate '{mate_id}' connector '{connector_ref}' belongs to "
                    f"'{target.get('instanceId')}', not '{owner}'"
                )
        if mate["instanceA"] == mate["instanceB"]:
            raise AssemblyBuildError(
                f"assembly mate '{mate_id}' cannot connect an instance to itself"
            )
        pair = tuple(sorted((mate["instanceA"], mate["instanceB"])))
        if pair in pair_to_mate:
            raise AssemblyBuildError(
                f"assembly mate pair '{pair[0]}'/'{pair[1]}' already joined by "
                f"'{pair_to_mate[pair]}' (one mate per part pair)"
            )
        pair_to_mate[pair] = mate_id
        mates.append(mate)

    return instances, connectors, mates, grounded_id


def _valid_scale(scale: object) -> bool:
    if isinstance(scale, (int, float)):
        return math.isfinite(scale) and scale > 0
    if isinstance(scale, (list, tuple)) and len(scale) == 3:
        return all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in scale)
    return False


def solve_assembly_placement(assembly: dict[str, Any]) -> dict[str, Any]:
    """Solve final instance placements with a grounded-first BFS.

    Returns ``{"placements": {instanceId: Mat4}, "warnings": [...]}``. The
    grounded instance keeps its stored placement; each mate joining a solved
    instance to an unsolved one places the unsolved side closed-form;
    unmated non-grounded instances keep their stored placement. A negative
    remaining DOF is a warning (first mate wins), never fatal.
    """
    instances, connectors, mates, grounded_id = _validate_assembly_structure(assembly)

    placements: dict[str, list[float]] = {
        instance_id: placement_to_matrix(instance["placement"])
        for instance_id, instance in instances.items()
    }
    solved: dict[str, list[float]] = {grounded_id: placements[grounded_id]}

    adjacency: dict[str, list[dict[str, Any]]] = {instance_id: [] for instance_id in instances}
    for mate in mates:
        adjacency[mate["instanceA"]].append(mate)
        adjacency[mate["instanceB"]].append(mate)

    queue = [grounded_id]
    while queue:
        current = queue.pop(0)
        for mate in adjacency[current]:
            other = mate["instanceB"] if mate["instanceA"] == current else mate["instanceA"]
            if other in solved:
                continue
            if current == mate["instanceA"]:
                frame_solved = _move_frame_to_world(
                    solved[current], *_connector_frame(connectors[mate["connectorA"]])
                )
                frame_local = _connector_frame(connectors[mate["connectorB"]])
            else:
                frame_solved = _move_frame_to_world(
                    solved[current], *_connector_frame(connectors[mate["connectorB"]])
                )
                frame_local = _connector_frame(connectors[mate["connectorA"]])
            solved[other] = _resolve_mate_between_frames(frame_solved, frame_local)
            queue.append(other)

    for instance_id, stored in placements.items():
        solved.setdefault(instance_id, stored)

    warnings: list[str] = []
    remaining = count_assembly_dof(len(instances), [mate["type"] for mate in mates])
    if remaining < 0:
        warnings.append(
            f"assembly is over-constrained (remaining DOF {remaining}); "
            "first mate wins, later mates may disagree with the solved poses"
        )
    return {"placements": solved, "warnings": warnings}


def classify_instance_source(
    part: str, body_ids: set[str], document_dir: Path | None
) -> tuple[str, str | None]:
    """Classify an instance ``part`` without loading geometry (pure).

    Returns ``(kind, target)`` with kind one of ``body`` (same-document body
    id, ``body:`` prefix stripped), ``document`` (resolved ``.nuke-cad``
    path), ``exchange`` (resolved STEP/IGES/BREP path), or ``missing``
    (target None).
    """
    if part.startswith("body:"):
        body_id = part[len("body:") :]
        return ("body", body_id) if body_id in body_ids else ("missing", None)
    if part in body_ids:
        return ("body", part)
    candidate = Path(part)
    if not candidate.is_absolute() and document_dir is not None:
        candidate = document_dir / part
    suffix = candidate.suffix.lower()
    if suffix == ".nuke-cad":
        return ("document", str(candidate)) if candidate.is_file() else ("missing", None)
    if suffix in _EXCHANGE_SUFFIXES:
        return ("exchange", str(candidate)) if candidate.is_file() else ("missing", None)
    return ("missing", None)


def _build_single_doc_shape(doc_dict: dict[str, Any]) -> dict[str, Any]:
    """Build one single-part document dict to a feature-builder result."""
    if not HAS_FEATURE_BUILDER or feature_builder is None:
        raise AssemblyBuildError("assembly build requires build123d, which is not available")
    raw_curves = doc_dict.get("curves", [])
    curve_results: dict[str, dict[str, Any]] = {}
    if isinstance(raw_curves, list) and raw_curves:
        if not HAS_CURVE_BUILDER or curve_builder is None:
            raise AssemblyBuildError(
                "assembly part has curves but the curve builder (OCP) is not available"
            )
        try:
            curve_results = curve_builder.build_curves(doc_dict)
        except ValueError as exc:
            raise AssemblyBuildError(f"assembly part curve build failed: {exc}") from exc
    try:
        return feature_builder.build_document_shape(doc_dict, curve_results=curve_results)
    except AssemblyBuildError:
        raise
    except ValueError as exc:
        raise AssemblyBuildError(f"assembly part build failed: {exc}") from exc


def _load_document_dict(path: Path, instance_id: str, source: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            doc_dict = json.load(handle)
    except json.JSONDecodeError as exc:
        raise AssemblyBuildError(
            f"assembly instance '{instance_id}': part source '{source}' is not valid JSON: {exc}"
        ) from exc
    except OSError as exc:
        raise AssemblyBuildError(
            f"assembly instance '{instance_id}': cannot read part source '{source}': {exc}"
        ) from exc
    if not isinstance(doc_dict, dict):
        raise AssemblyBuildError(
            f"assembly instance '{instance_id}': part source '{source}' must be a JSON object"
        )
    return doc_dict


def _explorer_solids(wrapped: object) -> list[object]:
    """Explorer-order TopoDS_Solid list of an OCP shape (needs OCP)."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[object] = []
    explorer = TopExp_Explorer(wrapped, TopAbs_SOLID)
    while explorer.More():
        solids.append(topods_solid(TopoDS, explorer.Current()))
        explorer.Next()
    return solids


def _load_exchange_solids(path: Path, instance_id: str, source: str) -> list[object]:
    """Load solids from a STEP/IGES/BREP file via the existing import path."""
    import geometry_service as gs  # deferred: geometry_service owns this module's caller

    suffix = path.suffix.lower()
    try:
        if suffix in (".step", ".stp"):
            wrapped = gs._read_step(path)
        elif suffix in (".iges", ".igs"):
            wrapped = gs._read_iges(path)
        elif suffix == ".brep":
            wrapped = gs._read_brep(path)
        else:
            raise AssemblyBuildError(
                f"assembly instance '{instance_id}': unsupported part source '{source}'"
            )
    except AssemblyBuildError:
        raise
    except Exception as exc:
        raise AssemblyBuildError(
            f"assembly instance '{instance_id}': failed to read part source '{source}': {exc}"
        ) from exc
    solids = _explorer_solids(wrapped)
    if not solids:
        raise AssemblyBuildError(
            f"assembly instance '{instance_id}': part source '{source}' contains no solids"
        )
    return solids


def _scale_triple(scale: object) -> tuple[float, float, float]:
    if scale is None:
        return (1.0, 1.0, 1.0)
    if isinstance(scale, (int, float)):
        return (float(scale), float(scale), float(scale))
    values = list(scale) if isinstance(scale, (list, tuple)) else []
    return (float(values[0]), float(values[1]), float(values[2]))


def _place_solid(solid: object, mat4: list[float], scale: object) -> object:
    """Return a transformed copy of an OCP solid (needs OCP).

    The instance scale applies in part-local space first, then the solved
    rigid placement. Uniform scales fold into one ``gp_Trsf``; per-axis
    scales use ``gp_GTrsf``.
    """
    sx, sy, sz = _scale_triple(scale)
    # Local-space scale first: M' = M * S scales the rotation columns.
    m = list(mat4)
    m[0] *= sx
    m[1] *= sy
    m[2] *= sz
    m[4] *= sx
    m[5] *= sy
    m[6] *= sz
    m[8] *= sx
    m[9] *= sy
    m[10] *= sz
    if sx == sy == sz:
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
        from OCP.gp import gp_Trsf

        trsf = gp_Trsf()
        trsf.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11])
        operation = BRepBuilderAPI_Transform(solid, trsf, True)
        if not operation.IsDone():
            raise AssemblyBuildError("assembly instance placement transform failed")
        return operation.Shape()
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    from OCP.gp import gp_GTrsf, gp_Mat, gp_XYZ

    gtrsf = gp_GTrsf()
    gtrsf.SetVectorialPart(gp_Mat(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]))
    gtrsf.SetTranslationPart(gp_XYZ(m[3], m[7], m[11]))
    operation = BRepBuilderAPI_GTransform(solid, gtrsf, True)
    if not operation.IsDone():
        raise AssemblyBuildError("assembly instance placement transform failed")
    return operation.Shape()


def _body_labels(doc_dict: dict[str, Any]) -> dict[str, str | None]:
    labels: dict[str, str | None] = {}
    bodies = doc_dict.get("bodies", [])
    if isinstance(bodies, list):
        for body in bodies:
            if isinstance(body, dict) and isinstance(body.get("id"), str):
                label = body.get("label")
                labels[body["id"]] = label if isinstance(label, str) and label else None
    return labels


def _instance_overlap_warnings(groups: list[tuple[str, list[object]]]) -> list[str]:
    """Pairwise overlap warnings between placed instance solids.

    Assemblies overlap intentionally, so any contact is a warning, never an
    error. Mechanics mirror the single-part cross-body check (bbox prefilter,
    boolean-common volume); a failed check degrades to a bbox-level warning.
    """
    try:
        import build123d as bd
    except ImportError:
        return []
    if bd is None:
        return []
    wrapped_groups: list[tuple[str, list[object]]] = []
    for instance_id, solids in groups:
        cast: list[object] = []
        for solid in solids:
            try:
                cast.append(bd.Shape.cast(solid))
            except Exception:
                cast = []
                break
        if cast:
            wrapped_groups.append((instance_id, cast))
    warnings: list[str] = []
    for i in range(len(wrapped_groups)):
        for j in range(i + 1, len(wrapped_groups)):
            id_a, solids_a = wrapped_groups[i]
            id_b, solids_b = wrapped_groups[j]
            try:
                if not any(
                    _bbox_overlaps(a.bounding_box(), b.bounding_box())
                    for a in solids_a
                    for b in solids_b
                ):
                    continue
                volume = 0.0
                for a in solids_a:
                    for b in solids_b:
                        try:
                            common = a & b
                        except ValueError as exc:
                            if "empty compound" in str(exc).lower():
                                continue
                            raise
                        volume += getattr(common, "volume", 0.0) or 0.0
                if volume > 1e-9:
                    warnings.append(
                        f"assembly instances '{id_a}' and '{id_b}' overlap "
                        f"(volume {volume:.6g} mm³) but are not merged by a boolean"
                    )
            except AssemblyBuildError:
                raise
            except Exception as exc:
                warnings.append(
                    f"assembly overlap check between '{id_a}' and '{id_b}' failed: {exc}"
                )
    return warnings


def _bbox_overlaps(a: object, b: object) -> bool:
    min_a, max_a = a.min, a.max
    min_b, max_b = b.min, b.max
    return (
        min_a[0] <= max_b[0]
        and max_a[0] >= min_b[0]
        and min_a[1] <= max_b[1]
        and max_a[1] >= min_b[1]
        and min_a[2] <= max_b[2]
        and max_a[2] >= min_b[2]
    )


def build_assembly_shape(
    doc: dict[str, Any], document_dir: str | Path | None = None
) -> dict[str, Any]:
    """Build an assembly document to placed per-instance solids.

    ``doc`` is the full ``.nuke-cad`` document dict (its bodies/features feed
    same-document body instances). Returns a dict with:

        ``placed``
            List of ``{instanceId, shape, transform}`` in document instance
            order (``shape`` is the placed OCP compound, ``transform`` the
            solved row-major Mat4).
        ``shape``
            Combined OCP compound of all placed instance solids (``None``
            when the assembly produced no solids).
        ``selectorMap``
            Body label to 1-based solid indices with keys prefixed
            ``<instanceId>/<bodyLabel>``.
        ``solidInstanceIds``
            Owning instance id per explorer-order solid of ``shape``.
        ``placements``
            Solved ``instanceId -> Mat4`` map (computed, never written back).
        ``warnings``
            Non-fatal issues (over-constraint, overlaps).
    """
    if not isinstance(doc, dict):
        raise AssemblyBuildError(".nuke-cad document must be a JSON object")
    assembly = doc.get("assembly")
    if not isinstance(assembly, dict) or not assembly.get("groundedInstanceId"):
        raise AssemblyBuildError(
            "document has no assembly section (absent assembly is a single-part build)"
        )

    # Pure phase (no OCP): solve placements and classify every source so a
    # missing source fails fast with instance + source named, even minimal.
    solved = solve_assembly_placement(assembly)
    placements: dict[str, list[float]] = solved["placements"]
    warnings: list[str] = list(solved["warnings"])

    base_dir = Path(document_dir).resolve() if document_dir is not None else None
    own_body_ids = {
        body["id"]
        for body in doc.get("bodies", [])
        if isinstance(body, dict) and isinstance(body.get("id"), str)
    }
    classifications: dict[str, tuple[str, str | None]] = {}
    for instance in assembly.get("instances", []):
        part = instance.get("part", "")
        kind, target = classify_instance_source(part, own_body_ids, base_dir)
        if kind == "missing":
            raise AssemblyBuildError(
                f"assembly instance '{instance.get('id')}': part source '{part}' not found "
                "(expected a same-document body, a .nuke-cad path, or a STEP/IGES/BREP file)"
            )
        classifications[instance["id"]] = (kind, target)

    # Geometry phase (needs OCP/build123d).
    try:
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Compound
    except ImportError as exc:
        raise AssemblyBuildError(
            f"assembly build requires OCP, which is not available: {exc}"
        ) from exc

    own_build: dict[str, Any] | None = None
    own_labels = _body_labels(doc)

    placed: list[dict[str, Any]] = []
    selector_map: dict[str, list[int]] = {}
    solid_instance_ids: list[str] = []
    placed_solids_all: list[object] = []
    overlap_groups: list[tuple[str, list[object]]] = []

    for instance in assembly.get("instances", []):
        instance_id = instance["id"]
        part = instance["part"]
        kind, target = classifications[instance_id]
        # Each entry: (body label or None, OCP solid in source order).
        labeled_solids: list[tuple[str | None, object]] = []
        try:
            if kind == "body":
                if own_build is None:
                    own_build = _build_single_doc_shape(doc)
                labeled_solids = _solids_of_body(own_build, target or "", own_labels)
                if not labeled_solids:
                    raise AssemblyBuildError(
                        f"assembly instance '{instance_id}': body '{target}' produced no solids "
                        "(it may be consumed by a boolean)"
                    )
            elif kind == "document":
                assert target is not None
                sub_path = Path(target)
                sub_doc = _load_document_dict(sub_path, instance_id, part)
                sub_build = _build_single_doc_shape(sub_doc)
                labeled_solids = _solids_of_document(sub_build, _body_labels(sub_doc))
                if not labeled_solids:
                    raise AssemblyBuildError(
                        f"assembly instance '{instance_id}': part source '{part}' produced no solids"
                    )
            else:
                assert target is not None
                labeled_solids = [
                    (None, solid)
                    for solid in _load_exchange_solids(Path(target), instance_id, part)
                ]
        except AssemblyBuildError:
            raise
        except ValueError as exc:
            raise AssemblyBuildError(f"assembly instance '{instance_id}': {exc}") from exc

        transform = placements[instance_id]
        instance_solids: list[object] = []
        local_index_by_label: dict[str, list[int]] = {}
        for label, solid in labeled_solids:
            moved = _place_solid(solid, transform, instance.get("scale"))
            instance_solids.append(moved)
            if label:
                local_index_by_label.setdefault(label, []).append(len(instance_solids))
        for label, local_indices in local_index_by_label.items():
            key = f"{instance_id}/{label}"
            existing = selector_map.setdefault(key, [])
            for local_index in local_indices:
                global_index = len(placed_solids_all) + local_index
                if global_index not in existing:
                    existing.append(global_index)
            existing.sort()
        placed_solids_all.extend(instance_solids)
        solid_instance_ids.extend([instance_id] * len(instance_solids))
        overlap_groups.append((instance_id, list(instance_solids)))

        builder = BRep_Builder()
        compound = TopoDS_Compound()
        builder.MakeCompound(compound)
        for solid in instance_solids:
            builder.Add(compound, solid)
        placed.append({"instanceId": instance_id, "shape": compound, "transform": list(transform)})

    warnings.extend(_instance_overlap_warnings(overlap_groups))

    combined: object | None = None
    if placed_solids_all:
        builder = BRep_Builder()
        combined = TopoDS_Compound()
        builder.MakeCompound(combined)
        for solid in placed_solids_all:
            builder.Add(combined, solid)

    return {
        "placed": placed,
        "shape": combined,
        "selectorMap": selector_map,
        "solidInstanceIds": solid_instance_ids,
        "placements": {key: list(value) for key, value in placements.items()},
        "warnings": warnings,
    }


def _solids_of_body(
    build_result: dict[str, Any], body_id: str, labels: dict[str, str | None]
) -> list[tuple[str | None, object]]:
    """Explorer-order ``(label, solid)`` pairs of one body from a build result."""
    shape = build_result.get("shape")
    if shape is None:
        return []
    wrapped = getattr(shape, "wrapped", shape)
    solids = _explorer_solids(wrapped)
    solid_body_ids = build_result.get("solidBodyIds") or []
    if len(solids) != len(solid_body_ids):
        return []
    label = labels.get(body_id)
    return [
        (label, solid)
        for solid, owner in zip(solids, solid_body_ids, strict=True)
        if owner == body_id
    ]


def _solids_of_document(
    build_result: dict[str, Any], labels: dict[str, str | None]
) -> list[tuple[str | None, object]]:
    """Explorer-order ``(label, solid)`` pairs of every built body."""
    shape = build_result.get("shape")
    if shape is None:
        return []
    wrapped = getattr(shape, "wrapped", shape)
    solids = _explorer_solids(wrapped)
    solid_body_ids = build_result.get("solidBodyIds") or []
    pairs: list[tuple[str | None, object]] = []
    if len(solids) != len(solid_body_ids):
        return pairs
    for solid, owner in zip(solids, solid_body_ids, strict=True):
        pairs.append((labels.get(owner), solid))
    return pairs
