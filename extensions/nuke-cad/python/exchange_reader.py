#!/usr/bin/env python3
"""Exchange-file reader for imported `.nuke-cad` bodies.

Reads STEP/IGES/BREP sources into an OCP shape, resolves the effective length
unit against the document unit, and enumerates explorer-order solids with the
metadata the import feature and its inspection RPC need (face count, volume,
bbox, centre of mass, product name).

This module is intentionally standalone: it must not import
``geometry_service`` or ``feature_builder``. Heavy OCP imports are deferred to
the functions that need them so the module stays importable in the minimal
pytest profile (pytest + numpy only).

Unit policy:

* ``source_unit`` overrides the unit declared by the file (the W7-X STEP
  declares millimetres but stores metre-scale numbers).
* Without an override the file's declared unit is detected (STEP ``FileUnits``,
  IGES global-section flag/name); BREP carries no unit metadata.
* With a ``target_unit`` the geometry is scaled by the exact file-to-target
  factor; without one the native numbers are kept and the file unit is
  reported.
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

import hashlib
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import ocp_compat

#: Exchange formats the reader accepts, in the schema's lowercase spelling.
SOURCE_FORMATS: tuple[str, ...] = ("step", "iges", "brep")

#: Units the schema exposes for ``sourceUnit``/document units.
SOURCE_UNITS: tuple[str, ...] = ("mm", "cm", "m")

#: Extension -> format map (lowercase suffixes).
_FORMAT_SUFFIXES: dict[str, str] = {
    ".step": "step",
    ".stp": "step",
    ".iges": "iges",
    ".igs": "iges",
    ".brep": "brep",
}

#: Safety cap for source solid counts; above this the import is rejected.
DEFAULT_MAX_SOLIDS = 500

#: Relative volume tolerance for an exact signature match.
SIGNATURE_REL_TOLERANCE = 1e-6

#: Looser relative volume tolerance for a unique signature repair match.
SIGNATURE_REPAIR_REL_TOLERANCE = 1e-3

#: Lowercase SHA-256 hex digest (kept in sync with the TS schema pattern).
SOURCE_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class ExchangeReadError(ValueError):
    """Raised when an exchange source cannot be read, inspected, or selected."""


# ---------------------------------------------------------------------------
# Length units (shared with geometry_service's legacy import pipeline).
# ---------------------------------------------------------------------------

#: Millimetres per length unit, keyed by canonical unit name.
MM_PER_LENGTH_UNIT: dict[str, float] = {
    "mm": 1.0,
    "cm": 10.0,
    "dm": 100.0,
    "m": 1000.0,
    "km": 1000000.0,
    "um": 0.001,
    "inch": 25.4,
    "foot": 304.8,
    "yard": 914.4,
    "mile": 1609344.0,
    "mil": 0.0254,
    "microinch": 0.0000254,
}

#: Alternate spellings (STEP FileUnits SI names, IGES short names) to canonical.
LENGTH_UNIT_ALIASES: dict[str, str] = {
    "millimetre": "mm",
    "millimeter": "mm",
    "centimetre": "cm",
    "centimeter": "cm",
    "decimetre": "dm",
    "decimeter": "dm",
    "metre": "m",
    "meter": "m",
    "kilometre": "km",
    "kilometer": "km",
    "micrometre": "um",
    "micrometer": "um",
    "micron": "um",
    "in": "inch",
    "inches": "inch",
    "ft": "foot",
    "feet": "foot",
    "yd": "yard",
    "yards": "yard",
    "mi": "mile",
    "miles": "mile",
    "uin": "microinch",
    "mils": "mil",
    "microinches": "microinch",
}

#: IGES global-section units flag (param 14) to (canonical name, mm per unit).
IGES_UNITS_FLAG_MM: dict[int, tuple[str, float]] = {
    1: ("inch", 25.4),
    2: ("mm", 1.0),
    4: ("foot", 304.8),
    5: ("mile", 1609344.0),
    6: ("m", 1000.0),
    7: ("km", 1000000.0),
    8: ("mil", 0.0254),
    9: ("um", 0.001),
    10: ("cm", 10.0),
    11: ("microinch", 0.0000254),
}


def canonical_length_unit(name: object) -> str | None:
    """Canonicalize a length-unit name (``INCH`` -> ``inch``).

    Returns None for blank/non-string input. Unknown names pass through
    lowercased (so callers can still report them); use
    :func:`mm_per_length_unit` to check convertibility.
    """
    if not isinstance(name, str):
        return None
    key = name.strip().lower()
    if not key:
        return None
    return LENGTH_UNIT_ALIASES.get(key, key)


def mm_per_length_unit(name: object) -> float | None:
    """Return millimetres per unit for a length-unit name, else None."""
    canonical = canonical_length_unit(name)
    if canonical is None:
        return None
    return MM_PER_LENGTH_UNIT.get(canonical)


def split_iges_global_params(section: str) -> list[str]:
    """Split an IGES global section into top-level params.

    Hollerith strings (``nH<chars>``) may embed commas and semicolons, so the
    section is tokenized char-by-char and the ``nH`` prefix itself is dropped
    (only the string content is kept). Pure stdlib; no OCP needed.
    """
    params: list[str] = []
    current = ""
    i = 0
    n = len(section)
    while i < n:
        char = section[i]
        if char == "," or char == ";":
            params.append(current)
            current = ""
            if char == ";":
                break
            i += 1
            continue
        if char.isdigit():
            j = i
            while j < n and section[j].isdigit():
                j += 1
            if j < n and section[j] == "H":
                count = int(section[i:j])
                start = j + 1
                current += section[start : start + count]
                i = start + count
                continue
        current += char
        i += 1
    return params


def normalize_target_units(target_units: str | None) -> str | None:
    """Canonicalize a target document unit; None stays None.

    Raises ValueError for unknown names.
    """
    if target_units is None:
        return None
    canonical = canonical_length_unit(target_units)
    if canonical is None or canonical not in MM_PER_LENGTH_UNIT:
        raise ValueError(
            f"Unknown target units {target_units!r}; "
            "expected mm, cm, m (or another known length unit)"
        )
    return canonical


def resolve_import_unit_scale(
    file_unit: str | None, file_mm: float | None, target_units: str | None
) -> tuple[str | None, float, bool]:
    """Resolve the legacy import unit policy (adopt / scale / passthrough).

    Kept for ``geometry_service``'s existing STEP/IGES/BREP import pipeline:
    (unitless file, unset target) -> no-op legacy ``(None, 1.0, False)``;
    (known file unit, unset target) -> adopt ``(file_unit, 1.0, True)``;
    (known file unit, set target) -> ``(target, file_mm / target_mm, False)``;
    (unknown file unit, set target) -> ``(target, 1.0, False)``.
    """
    if target_units is None and file_mm is None:
        return None, 1.0, False
    if target_units is None:
        return file_unit, 1.0, True
    if file_mm is None:
        return target_units, 1.0, False
    return target_units, file_mm / MM_PER_LENGTH_UNIT[target_units], False


def resolve_import_source_units(
    file_unit: str | None,
    file_mm: float | None,
    source_unit: str | None,
    target_unit: str | None,
    kind: str = "exchange",
) -> tuple[str | None, float, str | None]:
    """Resolve ``(effective_unit, scale, message)`` for an imported source.

    The effective unit is the override when present, else the detected file
    unit. With a target unit the scale is the exact file-to-target factor;
    without one native numbers are kept (scale 1.0).
    """
    target = normalize_target_units(target_unit)
    if source_unit is not None:
        override = canonical_length_unit(source_unit)
        if override not in SOURCE_UNITS:
            raise ValueError(
                f"Unknown source unit {source_unit!r}; expected one of {', '.join(SOURCE_UNITS)}"
            )
        effective = override
        effective_mm = MM_PER_LENGTH_UNIT[override]
    else:
        effective = file_unit
        effective_mm = file_mm

    if target is None:
        if source_unit is not None:
            return effective, 1.0, f"{kind} file unit overridden to '{effective}' (no scaling)"
        if effective is not None:
            return effective, 1.0, f"{kind} file unit '{effective}' adopted (no scaling)"
        return None, 1.0, None

    if effective_mm is None:
        return (
            target,
            1.0,
            f"{kind} file unit unknown; kept native numbers (no scaling to '{target}')",
        )
    scale = effective_mm / MM_PER_LENGTH_UNIT[target]
    if scale != 1.0:
        return (
            target,
            scale,
            f"{kind} file unit '{effective}' converted to document units "
            f"'{target}' (scale ×{scale:g})",
        )
    if source_unit is not None:
        return (
            target,
            1.0,
            f"{kind} file unit overridden to '{effective}' "
            "and already in document units (no scaling)",
        )
    return target, 1.0, f"{kind} file already in document units '{target}' (no scaling)"


# ---------------------------------------------------------------------------
# Pure path/format helpers.
# ---------------------------------------------------------------------------


def source_format_for_path(path: str | Path) -> str | None:
    """Return the exchange format for a path's suffix, or None."""
    return _FORMAT_SUFFIXES.get(Path(path).suffix.lower())


def compute_source_hash(path: str | Path) -> tuple[str, int]:
    """Return ``(lowercase sha256 hex, byte size)`` streaming ``path``."""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


# ---------------------------------------------------------------------------
# Parameter validation (shared with the feature builder and geometry service).
# ---------------------------------------------------------------------------


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _is_finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _is_finite_triple(value: object) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(_is_finite_number(entry) for entry in value)
    )


def validate_import_selection(selection: object) -> str | None:
    """Validate an import selection; return an error message or None."""
    if not isinstance(selection, dict):
        return "selection must be an object"
    mode = selection.get("mode")
    if mode == "all":
        return None
    if mode != "solids":
        return "selection mode must be 'all' or 'solids'"
    solids = selection.get("solids")
    if not isinstance(solids, list) or not solids:
        return "selection mode 'solids' requires a non-empty array of solid picks"
    seen: set[int] = set()
    for index, pick in enumerate(solids):
        prefix = f"selection.solids[{index}]"
        if not isinstance(pick, dict):
            return f"{prefix} must be an object"
        solid_index = pick.get("index")
        if not _is_positive_int(solid_index):
            return f"{prefix}.index must be a positive integer (1-based)"
        if solid_index in seen:
            return f"{prefix}.index duplicate solid index {solid_index}"
        seen.add(solid_index)
        signature = pick.get("signature")
        if signature is None:
            continue
        if not isinstance(signature, dict):
            return f"{prefix}.signature must be an object when present"
        if not _is_positive_int(signature.get("faceCount")):
            return f"{prefix}.signature.faceCount must be a positive integer"
        if not _is_finite_number(signature.get("volume")):
            return f"{prefix}.signature.volume must be a finite number"
    return None


def validate_import_params(params: object) -> str | None:
    """Validate ``ImportParams``; return an error message or None.

    Mirrors the TS ``validateFeatureParams`` case so the backend rejects the
    same malformed documents before any geometry work starts.
    """
    if not isinstance(params, dict):
        return "params must be an object"
    source_path = params.get("sourcePath")
    if not isinstance(source_path, str) or not source_path:
        return "sourcePath is required and must be a non-empty string"
    source_hash = params.get("sourceHash")
    if not isinstance(source_hash, str) or SOURCE_HASH_PATTERN.fullmatch(source_hash) is None:
        return "sourceHash must be a lowercase SHA-256 hex digest"
    source_size = params.get("sourceSize")
    if source_size is not None and not _is_positive_int(source_size):
        return "sourceSize must be a positive integer when present"
    source_format = params.get("sourceFormat")
    if source_format is not None and source_format not in SOURCE_FORMATS:
        return f"unknown sourceFormat {source_format!r} (expected {', '.join(SOURCE_FORMATS)})"
    source_unit = params.get("sourceUnit")
    if source_unit is not None and source_unit not in SOURCE_UNITS:
        return f"unknown sourceUnit {source_unit!r} (expected {', '.join(SOURCE_UNITS)})"
    if params.get("selection") is None:
        return "selection is required"
    selection_error = validate_import_selection(params.get("selection"))
    if selection_error is not None:
        return selection_error
    placement = params.get("placement")
    if placement is not None:
        if not isinstance(placement, dict):
            return "placement must be an object when present"
        for key in ("translate", "rotateDegrees"):
            vector = placement.get(key)
            if vector is not None and not _is_finite_triple(vector):
                return f"placement.{key} must be a [x, y, z] tuple of finite numbers"
    max_solids = params.get("maxSolids")
    if max_solids is not None and not _is_positive_int(max_solids):
        return "maxSolids must be a positive integer when present"
    return None


# ---------------------------------------------------------------------------
# Structured results.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ImportSolidInfo:
    """Metadata for one explorer-order source solid."""

    index: int
    face_count: int
    volume: float
    bbox_min: tuple[float, float, float]
    bbox_max: tuple[float, float, float]
    center: tuple[float, float, float]
    name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return the camelCase JSON record used by the inspection RPC."""
        payload: dict[str, Any] = {
            "index": self.index,
            "faceCount": self.face_count,
            "volume": self.volume,
            "bboxMin": list(self.bbox_min),
            "bboxMax": list(self.bbox_max),
            "center": list(self.center),
        }
        if self.name is not None:
            payload["name"] = self.name
        return payload


@dataclass
class ImportSource:
    """A read exchange source with unit-resolved geometry and solid metadata."""

    path: Path
    digest: str
    size: int
    format: str
    file_unit: str | None
    effective_unit: str | None
    unit_scale: float
    units_message: str | None
    shape: object
    solids: list[object]
    info: list[ImportSolidInfo]

    @property
    def solid_count(self) -> int:
        return len(self.solids)

    def to_dict(self) -> dict[str, Any]:
        """Return the source metadata as the inspection RPC payload."""
        return {
            "sourcePath": str(self.path),
            "sourceFormat": self.format,
            "sourceHash": self.digest,
            "sourceSize": self.size,
            "fileUnit": self.file_unit,
            "effectiveUnit": self.effective_unit,
            "unitScaleFactor": self.unit_scale,
            "unitsMessage": self.units_message,
            "solidCount": self.solid_count,
            "solids": [solid.to_dict() for solid in self.info],
        }


# ---------------------------------------------------------------------------
# OCP readers (deferred imports keep the module minimal-profile importable).
# ---------------------------------------------------------------------------


def _ocp_import_error(capability: str, exc: ImportError) -> ExchangeReadError:
    return ExchangeReadError(
        f"{capability} requires OCP (cadquery-ocp/build123d), which is not available: {exc}"
    )


def ocp_step_length_names(step_path: Path) -> list[str] | None:
    """Return the STEP file's length-unit names via OCP ``FileUnits``.

    Returns None when OCP is unavailable or the file does not parse.
    """
    try:
        from OCP.STEPControl import STEPControl_Reader
        from OCP.TColStd import TColStd_SequenceOfAsciiString
    except ImportError:
        return None
    try:
        from OCP.IFSelect import IFSelect_RetDone

        reader = STEPControl_Reader()
        if reader.ReadFile(str(step_path)) != IFSelect_RetDone:
            return None
        length = TColStd_SequenceOfAsciiString()
        angles = TColStd_SequenceOfAsciiString()
        solid_angles = TColStd_SequenceOfAsciiString()
        reader.FileUnits(length, angles, solid_angles)
        names: list[str] = []
        for i in range(length.Length()):
            raw = length.Value(i + 1).ToCString()
            names.append(raw.decode("ascii") if isinstance(raw, bytes) else str(raw))
        return names
    except Exception:
        return None


def detect_step_unit_from_names(names: list[str] | None) -> tuple[str | None, float | None]:
    """Return ``(canonical_name, mm_per_unit)`` from STEP ``FileUnits`` names.

    ``(None, None)`` when the file is unitless, declares an unrecognized unit,
    or carries no names. Mixed-unit files: the first non-blank name wins.
    """
    if not names:
        return None, None
    for name in names:
        canonical = canonical_length_unit(name)
        if canonical:
            return canonical, MM_PER_LENGTH_UNIT.get(canonical)
    return None, None


def detect_step_file_unit(step_path: str | Path) -> tuple[str | None, float | None]:
    """Detect a STEP file's declared length unit via OCP."""
    return detect_step_unit_from_names(ocp_step_length_names(Path(step_path)))


def detect_iges_file_unit(iges_path: str | Path) -> tuple[str | None, float | None]:
    """Detect an IGES file's length unit from its global section.

    Uses the units flag (0-based param 13, right after the model-space scale)
    with the units name (param 14) as fallback for flag 3 ("see name") and
    unknown flags. Returns ``(None, None)`` when the section is missing or
    unrecognized. Pure text parse; no OCP needed.
    """
    try:
        text = Path(iges_path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None, None
    # Fixed-format lines: 72 content columns, section id in column 73.
    # Trailing blanks are insignificant outside Hollerith strings.
    section = "".join(line[:72].rstrip() for line in text.splitlines() if line[72:73] == "G")
    if not section:
        return None, None
    params = split_iges_global_params(section)
    if len(params) < 15:
        return None, None
    flag, name = params[13].strip(), params[14].strip()
    try:
        flag_value: int | None = int(flag)
    except ValueError:
        flag_value = None
    if flag_value in IGES_UNITS_FLAG_MM:
        canonical, mm = IGES_UNITS_FLAG_MM[flag_value]
        return canonical, mm
    canonical = canonical_length_unit(name)
    if canonical is not None:
        return canonical, MM_PER_LENGTH_UNIT.get(canonical)
    return None, None


def detect_brep_file_unit(_brep_path: str | Path) -> tuple[str | None, float | None]:
    """BREP carries no length-unit metadata; always ``(None, None)``."""
    return None, None


def detect_file_unit(path: str | Path, source_format: str) -> tuple[str | None, float | None]:
    """Detect the declared unit for a source path/format pair."""
    if source_format == "step":
        return detect_step_file_unit(path)
    if source_format == "iges":
        return detect_iges_file_unit(path)
    return detect_brep_file_unit(path)


def scale_shape_uniform(shape: object, factor: float) -> object:
    """Return ``shape`` scaled uniformly about the origin.

    A factor of exactly 1.0 returns the shape unchanged (no B-rep rewrite).
    """
    if factor == 1.0:
        return shape
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Pnt, gp_Trsf

    transform = gp_Trsf()
    transform.SetScale(gp_Pnt(0.0, 0.0, 0.0), float(factor))
    operation = BRepBuilderAPI_Transform(shape, transform, True)
    if not operation.IsDone():
        raise ExchangeReadError(f"Uniform scaling by {factor:g} failed")
    return operation.Shape()


def _read_step_geometry(step_path: Path, system_unit_mm: float | None) -> object:
    """Read STEP geometry, optionally suppressing OCCT's file-unit scaling."""
    try:
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPControl import STEPControl_Reader
    except ImportError as exc:
        raise _ocp_import_error("STEP import", exc) from exc

    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step_path))
    if status != IFSelect_RetDone:
        raise ExchangeReadError(f"STEP reader returned status {status} for {step_path}")
    if system_unit_mm is not None:
        reader.SetSystemLengthUnit(float(system_unit_mm))
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None:
        raise ExchangeReadError(f"No shape transferred from {step_path}")
    return shape


def read_step_raw(step_path: Path, system_unit_mm: float) -> object:
    """Read a STEP file preserving raw file numbers.

    ``SetSystemLengthUnit`` suppresses OCCT's automatic file-unit to millimetre
    scaling so the caller can apply the exact file-to-target factor once.
    """
    return _read_step_geometry(step_path, system_unit_mm)


def read_step_shape(step_path: Path) -> object:
    """Read a STEP file into an OCP ``TopoDS_Shape`` via the legacy reader."""
    return _read_step_geometry(step_path, None)


def sew_faces_to_solids(shape: object) -> object:
    """Sew loose IGES faces into closed shells and rebuild solids from them.

    IGES is a surface format: readers deliver unsewn faces, so the per-solid
    pipeline would see an empty model. Sewing plus one
    ``BRepBuilderAPI_MakeSolid`` per shell restores the solids without a
    boolean fuse. Returns a compound of the rebuilt solids, or the sewed shape
    unchanged when no closed shell is found (open sheets stay faces).
    """
    try:
        from OCP.BRep import BRep_Builder
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
        from OCP.TopAbs import TopAbs_SHELL
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS, TopoDS_Compound
    except ImportError as exc:
        raise _ocp_import_error("IGES import", exc) from exc

    sewing = BRepBuilderAPI_Sewing()
    sewing.Add(shape)
    sewing.Perform()
    sewed = sewing.SewedShape()

    shell_downcast = getattr(TopoDS, "Shell_s", None) or TopoDS.Shell
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    made = 0
    exp = TopExp_Explorer(sewed, TopAbs_SHELL)
    while exp.More():
        maker = BRepBuilderAPI_MakeSolid()
        maker.Add(shell_downcast(exp.Current()))
        if maker.IsDone():
            solid = maker.Solid()
            if not solid.IsNull():
                builder.Add(compound, solid)
                made += 1
        exp.Next()
    return compound if made > 0 else sewed


def _explorer_solids(shape: object) -> list[object]:
    """Return explorer-order ``TopoDS_Solid`` shapes nested in ``shape``."""
    try:
        from OCP.TopAbs import TopAbs_SOLID
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS
    except ImportError as exc:
        raise _ocp_import_error("Exchange import", exc) from exc

    solids: list[object] = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solids.append(ocp_compat.topods_solid(TopoDS, explorer.Current()))
        explorer.Next()
    return solids


def read_iges_shape(iges_path: Path) -> object:
    """Read an IGES file into an OCP shape, sewing loose faces into solids."""
    try:
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.IGESControl import IGESControl_Reader
    except ImportError as exc:
        raise _ocp_import_error("IGES import", exc) from exc

    reader = IGESControl_Reader()
    status = reader.ReadFile(str(iges_path))
    if status != IFSelect_RetDone:
        raise ExchangeReadError(f"IGES reader returned status {status} for {iges_path}")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None:
        raise ExchangeReadError(f"No shape transferred from {iges_path}")
    if not _explorer_solids(shape):
        shape = sew_faces_to_solids(shape)
    return shape


def read_brep_shape(brep_path: Path) -> object:
    """Read a native BREP file into an OCP ``TopoDS_Shape``."""
    try:
        from OCP.BRep import BRep_Builder
        from OCP.BRepTools import BRepTools
        from OCP.TopoDS import TopoDS_Shape
    except ImportError as exc:
        raise _ocp_import_error("BREP import", exc) from exc

    shape = TopoDS_Shape()
    builder = BRep_Builder()
    if not ocp_compat.brep_tools_read(BRepTools, shape, builder, str(brep_path)):
        raise ExchangeReadError(f"BREP reader failed for {brep_path}")
    return shape


def read_shape(path: Path, source_format: str, file_mm: float | None) -> object:
    """Read ``path`` into OCP geometry with native file numbers preserved."""
    if source_format == "step":
        if file_mm is not None and file_mm != 1.0:
            return read_step_raw(path, file_mm)
        return read_step_shape(path)
    if source_format == "iges":
        shape = read_iges_shape(path)
        if file_mm is not None and file_mm != 1.0:
            # OCCT normalizes recognized IGES units to millimetres on read;
            # recover the raw file numbers so the exact unit policy applies once.
            shape = scale_shape_uniform(shape, 1.0 / file_mm)
        return shape
    return read_brep_shape(path)


# ---------------------------------------------------------------------------
# Per-solid metadata.
# ---------------------------------------------------------------------------


def _face_count(solid: object) -> int:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    count = 0
    explorer = TopExp_Explorer(solid, TopAbs_FACE)
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def _volume_and_center(solid: object) -> tuple[float, tuple[float, float, float]]:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    ocp_compat.brep_gprop_volume_properties(BRepGProp, solid, props)
    center = props.CentreOfMass()
    return float(props.Mass()), (float(center.X()), float(center.Y()), float(center.Z()))


def _bounding_box(
    solid: object,
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    optimal = getattr(BRepBndLib, "AddOptimal_s", None) or getattr(BRepBndLib, "AddOptimal", None)
    if optimal is not None:
        optimal(solid, bbox)
    else:
        ocp_compat.brep_bnd_lib_add(BRepBndLib, solid, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    return (float(xmin), float(ymin), float(zmin)), (float(xmax), float(ymax), float(zmax))


def solid_info(solid: object, index: int, name: str | None = None) -> ImportSolidInfo:
    """Return the metadata record for one explorer-order solid."""
    volume, center = _volume_and_center(solid)
    bbox_min, bbox_max = _bounding_box(solid)
    return ImportSolidInfo(
        index=index,
        face_count=_face_count(solid),
        volume=volume,
        bbox_min=bbox_min,
        bbox_max=bbox_max,
        center=center,
        name=name,
    )


# ---------------------------------------------------------------------------
# Best-effort product names (STEP/IGES).
# ---------------------------------------------------------------------------


def xcaf_free_shape_names(doc_main: object, solid_count: int) -> dict[int, str]:
    """Map free-shape product names onto consecutive explorer-order solids."""
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_LabelSequence
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc_main)
    free_shapes = TDF_LabelSequence()
    shape_tool.GetFreeShapes(free_shapes)

    names: dict[int, str] = {}
    next_index = 1
    total = 0
    for i in range(1, free_shapes.Length() + 1):
        label = free_shapes.Value(i)
        product = shape_tool.GetShape_s(label)
        count = 0
        explorer = TopExp_Explorer(product, TopAbs_SOLID)
        while explorer.More():
            count += 1
            explorer.Next()
        if count == 0:
            try:
                count = len(_explorer_solids(sew_faces_to_solids(product)))
            except Exception:
                count = 0
        name_attr = TDataStd_Name()
        name: str | None = None
        if label.FindAttribute(TDataStd_Name.GetID_s(), name_attr):
            try:
                candidate = name_attr.Get().ToExtString()
                if candidate:
                    name = candidate
            except Exception:
                name = None
        for _ in range(count):
            if name:
                names[next_index] = name
            next_index += 1
        total += count
    if total != solid_count:
        return {}
    return names


def read_product_names(path: str | Path, source_format: str, solid_count: int) -> dict[int, str]:
    """Best-effort per-solid STEP/IGES product names by 1-based solid index.

    Returns {} whenever OCAF is unavailable, the file carries no names, or the
    label/solid counts do not line up. Never raises.
    """
    if source_format not in ("step", "iges") or solid_count <= 0:
        return {}
    source_path = Path(path)
    try:
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDocStd import TDocStd_Document

        if source_format == "step":
            from OCP.STEPCAFControl import STEPCAFControl_Reader

            reader = STEPCAFControl_Reader()
            reader.SetNameMode(True)
            reader.SetColorMode(True)
            if reader.ReadFile(str(source_path)) != 1:
                return {}
        else:
            from OCP.IGESCAFControl import IGESCAFControl_Reader

            reader = IGESCAFControl_Reader()
            reader.SetNameMode(True)
            reader.SetColorMode(True)
            if reader.ReadFile(str(source_path)) != 1:
                return {}
        doc = TDocStd_Document(TCollection_ExtendedString("nuke-cad-import"))
        if not reader.Transfer(doc):
            return {}
        return xcaf_free_shape_names(doc.Main(), solid_count)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Public reader / selector.
# ---------------------------------------------------------------------------


def read_import_source(
    path: str | Path,
    *,
    source_unit: str | None = None,
    target_unit: str | None = None,
    max_solids: int = DEFAULT_MAX_SOLIDS,
    source_format: str | None = None,
) -> ImportSource:
    """Read an exchange source into unit-resolved geometry plus solid metadata.

    ``source_unit`` overrides the file's declared unit; ``target_unit`` is the
    document unit to scale to (native numbers are kept when omitted).
    ``source_format`` overrides suffix inference (useful for oddly named
    files). Raises :class:`ExchangeReadError` for missing files, unsupported
    formats, unreadable geometry, empty sources, or a solid count above
    ``max_solids``.
    """
    if not _is_positive_int(max_solids):
        raise ExchangeReadError("maxSolids must be a positive integer when present")

    source_path = Path(path).resolve()
    if not source_path.is_file():
        raise ExchangeReadError(f"Import source not found: {path}")

    fmt = source_format if source_format is not None else source_format_for_path(source_path)
    if fmt not in SOURCE_FORMATS:
        raise ExchangeReadError(
            f"Unsupported import source '{source_path}'; expected a "
            f"{', '.join(SOURCE_FORMATS)} file (.step/.stp, .iges/.igs, .brep)"
        )

    file_unit, file_mm = detect_file_unit(source_path, fmt)
    effective_unit, unit_scale, units_message = resolve_import_source_units(
        file_unit, file_mm, source_unit, target_unit, fmt.upper()
    )

    digest, size = compute_source_hash(source_path)
    shape = read_shape(source_path, fmt, file_mm)
    if unit_scale != 1.0:
        shape = scale_shape_uniform(shape, unit_scale)

    solids = _explorer_solids(shape)
    if not solids:
        raise ExchangeReadError(f"Import source '{source_path}' contains no solids")
    if len(solids) > max_solids:
        raise ExchangeReadError(
            f"Import source '{source_path}' contains {len(solids)} solids, "
            f"above the maxSolids cap of {max_solids}"
        )

    names = read_product_names(source_path, fmt, len(solids))
    info = [
        solid_info(solid, index, names.get(index)) for index, solid in enumerate(solids, start=1)
    ]
    return ImportSource(
        path=source_path,
        digest=digest,
        size=size,
        format=fmt,
        file_unit=file_unit,
        effective_unit=effective_unit,
        unit_scale=unit_scale,
        units_message=units_message,
        shape=shape,
        solids=solids,
        info=info,
    )


def _signature_matches(
    info: ImportSolidInfo, face_count: int, volume: float, rel_tolerance: float
) -> bool:
    if info.face_count != face_count:
        return False
    if not math.isfinite(info.volume) or not math.isfinite(volume):
        return False
    return math.isclose(info.volume, volume, rel_tol=rel_tolerance, abs_tol=1e-9)


def select_solids(source: ImportSource, selection: dict[str, Any]) -> list[object]:
    """Return the source solids named by an ``ImportSelection``.

    ``all`` returns every solid in explorer order. ``solids`` resolves each
    pick by its 1-based index and, when a signature is present, verifies the
    face count + volume fingerprint. A mismatching index falls back to a
    unique looser-tolerance signature match (repair); otherwise the selection
    fails with a clear message. Duplicate resolved solids are rejected.
    """
    error = validate_import_selection(selection)
    if error is not None:
        raise ExchangeReadError(error)
    if selection.get("mode") == "all":
        return list(source.solids)

    picks = selection.get("solids") or []
    selected: list[object] = []
    resolved_indices: set[int] = set()
    for pick in picks:
        index = int(pick["index"])
        if index > source.solid_count:
            raise ExchangeReadError(
                f"selected solid index {index} is out of range "
                f"(the source has {source.solid_count} solids)"
            )
        info = source.info[index - 1]
        signature = pick.get("signature")
        resolved = index
        if isinstance(signature, dict):
            face_count = int(signature["faceCount"])
            volume = float(signature["volume"])
            if not _signature_matches(info, face_count, volume, SIGNATURE_REL_TOLERANCE):
                candidates = [
                    candidate.index
                    for candidate in source.info
                    if _signature_matches(
                        candidate, face_count, volume, SIGNATURE_REPAIR_REL_TOLERANCE
                    )
                ]
                if not candidates:
                    raise ExchangeReadError(
                        f"source solid {index} no longer matches its signature "
                        f"(faceCount {face_count}, volume {volume:g}); "
                        f"found faceCount {info.face_count}, volume {info.volume:g} "
                        "and no other solid matches"
                    )
                if len(candidates) > 1:
                    listing = ", ".join(str(candidate) for candidate in candidates)
                    raise ExchangeReadError(
                        f"source solid {index} no longer matches its signature and "
                        f"the repair scan is ambiguous (candidates: {listing})"
                    )
                resolved = candidates[0]
        if resolved in resolved_indices:
            raise ExchangeReadError(
                f"selection resolves solid {resolved} more than once; "
                "each picked solid must be distinct"
            )
        resolved_indices.add(resolved)
        selected.append(source.solids[resolved - 1])
    return selected
