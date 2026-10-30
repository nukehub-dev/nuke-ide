#!/usr/bin/env python3
"""Evaluate derived OpenMC tallies against a statepoint.

Usage:
    python derive_tallies.py --statepoint statepoint.10.h5 \
        --definitions-file derived-tallies.json
    python derive_tallies.py --statepoint statepoint.10.h5 --definitions '[{...}]'

Derived tallies are analysis-only: expressions over simulation tally scores
and scalar constants, evaluated with OpenMC's independent-tally uncertainty
propagation. The script prints exactly one JSON object on stdout. Per-tally
failures are reported in ``errors`` and never abort other entries; missing
dependencies, unreadable statepoints, and missing definitions produce
``success: false`` with an actionable message.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import traceback
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

#: Filter class name -> OpenMC XML/API filter type.
FILTER_TYPES = {
    "AzimuthalFilter": "azimuthal",
    "CellBornFilter": "cellborn",
    "CellbornFilter": "cellborn",
    "CellFilter": "cell",
    "CellFromFilter": "cellfrom",
    "CellInstanceFilter": "cellinstance",
    "CollisionFilter": "collision",
    "DelayedGroupFilter": "delayedgroup",
    "DistribcellFilter": "distribcell",
    "EnergyFilter": "energy",
    "EnergyFunctionFilter": "energyfunction",
    "EnergyoutFilter": "energyout",
    "MaterialFilter": "material",
    "MaterialFromFilter": "materialfrom",
    "MeshBornFilter": "meshborn",
    "MeshFilter": "mesh",
    "MeshMaterialFilter": "meshmaterial",
    "MeshSurfaceFilter": "meshsurface",
    "MuFilter": "mu",
    "MuSurfaceFilter": "musurface",
    "ParentNuclideFilter": "parentnuclide",
    "ParticleFilter": "particle",
    "ParticleProductionFilter": "particleproduction",
    "PolarFilter": "polar",
    "ReactionFilter": "reaction",
    "SurfaceFilter": "surface",
    "TimeFilter": "time",
    "UniverseFilter": "universe",
    "WeightFilter": "weight",
}


class DerivedTallyError(Exception):
    """Actionable derived-tally failure (message shown directly in the UI)."""


class NumpyEncoder(json.JSONEncoder):
    """JSON encoder for numpy scalars and arrays."""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            value = float(obj)
            return value if math.isfinite(value) else 0.0
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


@dataclass
class FilterAxis:
    """One result filter axis: OpenMC filter type plus logical bins."""

    type: str
    bins: list[Any]
    bin_count: int

    @property
    def key(self) -> str:
        return json.dumps([self.type, self.bins], sort_keys=True, default=str)


@dataclass
class DerivedValue:
    """Tally-shaped value: filter dimensions flattened, then nuclides."""

    mean: np.ndarray
    std: np.ndarray
    filters: list[FilterAxis]
    nuclides: list[str]
    score: str
    warnings: list[str] = field(default_factory=list)

    @property
    def filter_shape(self) -> tuple[int, ...]:
        return tuple(max(1, axis.bin_count) for axis in self.filters)

    @property
    def nuclide_count(self) -> int:
        return self.mean.shape[-1]


def _canonical(value: Any) -> Any:
    """Convert OpenMC/numpy bin values to JSON-safe primitives."""
    if isinstance(value, np.ndarray):
        return [_canonical(item) for item in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        number = float(value)
        return number if math.isfinite(number) else 0.0
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def _filter_type(filter_obj: Any) -> str:
    explicit = getattr(filter_obj, "type_name", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    name = type(filter_obj).__name__
    return FILTER_TYPES.get(name, name.removesuffix("Filter").lower())


def _filter_axis(filter_obj: Any) -> FilterAxis:
    bins = _canonical(list(getattr(filter_obj, "bins", []) or []))
    bin_count = int(getattr(filter_obj, "num_bins", len(bins) or 1))
    return FilterAxis(type=_filter_type(filter_obj), bins=bins, bin_count=max(1, bin_count))


def format_number(value: float) -> str:
    """Deterministic scalar formatting shared with the TypeScript preview."""
    if value == 0:
        return "0"
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def format_expression(expression: Any) -> str:
    """Canonical formula: ``T1[flux] / T2[fission]``."""
    if not isinstance(expression, dict):
        raise DerivedTallyError("Derived tally has no expression.")
    kind = expression.get("kind")
    if kind == "tally":
        score = expression.get("score")
        if not isinstance(score, str) or not score:
            raise DerivedTallyError("A tally operand is missing its score.")
        nuclide = expression.get("nuclide")
        suffix = f":{nuclide}" if isinstance(nuclide, str) and nuclide else ""
        return f"T{int(expression.get('tallyId'))}[{score}{suffix}]"
    if kind == "scalar":
        return format_number(float(expression.get("value")))
    if kind == "unary":
        operand = format_expression(expression.get("operand"))
        if expression.get("op") != "-":
            raise DerivedTallyError("Only unary negation is supported.")
        return (
            f"-({operand})"
            if isinstance(expression.get("operand"), dict)
            and expression["operand"].get("kind") == "binary"
            else f"-{operand}"
        )
    if kind == "binary":
        op = expression.get("op")
        if op not in {"+", "-", "*", "/"}:
            raise DerivedTallyError(f"Unsupported operator {op!r} in derived tally.")
        left = expression.get("left")
        right = expression.get("right")
        left_text = format_expression(left)
        right_text = format_expression(right)
        precedence = {"+": 1, "-": 1, "*": 2, "/": 2}
        parent_precedence = precedence[op]

        def wrap(child: Any, text: str, right_side: bool) -> str:
            if not isinstance(child, dict) or child.get("kind") != "binary":
                return text
            child_precedence = precedence.get(child.get("op"), 0)
            needs = child_precedence < parent_precedence or (
                right_side and child_precedence == parent_precedence
            )
            return f"({text})" if needs else text

        return f"{wrap(left, left_text, False)} {op} {wrap(right, right_text, True)}"
    raise DerivedTallyError(f"Unknown derived expression node {kind!r}.")


def constant_value(expression: Any) -> float | None:
    """Numeric value of a scalar-only subtree, else ``None``."""
    if not isinstance(expression, dict):
        return None
    kind = expression.get("kind")
    if kind == "scalar":
        value = float(expression.get("value"))
        return value if math.isfinite(value) else None
    if kind == "tally":
        return None
    if kind == "unary":
        value = constant_value(expression.get("operand"))
        return None if value is None else -value
    if kind == "binary":
        left = constant_value(expression.get("left"))
        right = constant_value(expression.get("right"))
        if left is None or right is None:
            return None
        op = expression.get("op")
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            return None if right == 0 else left / right
    return None


def validate_division_by_zero(expression: Any) -> None:
    """Reject a scalar zero divisor before touching the statepoint."""
    if not isinstance(expression, dict):
        return
    if expression.get("kind") == "binary":
        validate_division_by_zero(expression.get("left"))
        validate_division_by_zero(expression.get("right"))
        if expression.get("op") == "/" and constant_value(expression.get("right")) == 0:
            raise DerivedTallyError(
                "The expression divides by a scalar zero. Replace the divisor with a non-zero value."
            )
    elif expression.get("kind") == "unary":
        validate_division_by_zero(expression.get("operand"))


def _shape_compatible(left: DerivedValue, right: DerivedValue) -> None:
    left_types = {axis.type: axis for axis in left.filters}
    for axis in right.filters:
        existing = left_types.get(axis.type)
        if existing is not None and existing.key != axis.key:
            raise DerivedTallyError(
                f"The {axis.type} filter bins differ between the two tallies. "
                "Use the same bins on both tallies or restrict the expression to one of them."
            )


def _result_axes(left: DerivedValue, right: DerivedValue) -> list[FilterAxis]:
    _shape_compatible(left, right)
    axes = list(left.filters)
    known = {axis.type for axis in axes}
    for axis in right.filters:
        if axis.type not in known:
            axes.append(axis)
            known.add(axis.type)
    return axes


def _broadcast(value: DerivedValue, axes: list[FilterAxis]) -> tuple[np.ndarray, np.ndarray]:
    """Broadcast a tally value to the result filter axes + nuclides."""
    target = [axis.bin_count for axis in axes] + [value.nuclide_count]
    if not value.filters:
        data = value.mean.reshape((1,) * len(axes) + (value.nuclide_count,))
        std = value.std.reshape((1,) * len(axes) + (value.nuclide_count,))
        return np.broadcast_to(data, target), np.broadcast_to(std, target)

    dims = value.filter_shape
    data = value.mean.reshape(dims + (value.nuclide_count,))
    std = value.std.reshape(dims + (value.nuclide_count,))
    value_index = {axis.type: index for index, axis in enumerate(value.filters)}
    order = [value_index[axis.type] for axis in axes if axis.type in value_index]
    order.append(len(axes))
    data = np.transpose(data, order)
    std = np.transpose(std, order)
    reshape = [axis.bin_count if axis.type in value_index else 1 for axis in axes]
    reshape.append(value.nuclide_count)
    return np.broadcast_to(data.reshape(reshape), target), np.broadcast_to(
        std.reshape(reshape), target
    )


def _combine_score(left: str | None, right: str | None, op: str) -> str:
    if left is None:
        return right or "derived"
    if right is None:
        return left
    return f"({left} {op} {right})"


def _scalar_binary(left: float, right: float, op: str) -> float:
    if op == "+":
        return left + right
    if op == "-":
        return left - right
    if op == "*":
        return left * right
    if right == 0:
        raise DerivedTallyError("Division by zero in the derived-tally expression.")
    return left / right


def _apply_finite(value: DerivedValue) -> DerivedValue:
    invalid = int(
        np.count_nonzero(~np.isfinite(value.mean)) + np.count_nonzero(~np.isfinite(value.std))
    )
    mean = np.nan_to_num(value.mean, nan=0.0, posinf=0.0, neginf=0.0)
    std = np.nan_to_num(value.std, nan=0.0, posinf=0.0, neginf=0.0)
    warnings = list(value.warnings)
    if invalid:
        warnings.append(
            f"{invalid} non-finite moment(s) were written as zero (OpenMC tally arithmetic convention)."
        )
    return DerivedValue(mean, std, value.filters, value.nuclides, value.score, warnings)


def _binary_value(
    left: float | DerivedValue, right: float | DerivedValue, op: str
) -> float | DerivedValue:
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return _scalar_binary(float(left), float(right), op)

    if isinstance(left, (int, float)):
        assert isinstance(right, DerivedValue)
        scalar = float(left)
        if op == "+":
            return DerivedValue(
                right.mean + scalar,
                right.std.copy(),
                right.filters,
                right.nuclides,
                right.score,
                right.warnings,
            )
        if op == "-":
            return DerivedValue(
                scalar - right.mean,
                right.std.copy(),
                right.filters,
                right.nuclides,
                right.score,
                right.warnings,
            )
        if op == "*":
            return DerivedValue(
                right.mean * scalar,
                right.std * abs(scalar),
                right.filters,
                right.nuclides,
                right.score,
                right.warnings,
            )
        zero = right.mean == 0
        with np.errstate(divide="ignore", invalid="ignore"):
            mean = np.where(zero, 0.0, scalar / right.mean)
            std = np.where(zero, 0.0, np.abs(mean) * (right.std / np.abs(right.mean)))
        warnings = list(right.warnings)
        if np.any(zero):
            warnings.append(
                f"{int(np.count_nonzero(zero))} bin(s) divide by a zero tally mean and were written as zero."
            )
        return DerivedValue(mean, std, right.filters, right.nuclides, right.score, warnings)

    if isinstance(right, (int, float)):
        scalar = float(right)
        assert isinstance(left, DerivedValue)
        if op == "+":
            return DerivedValue(
                left.mean + scalar,
                left.std.copy(),
                left.filters,
                left.nuclides,
                left.score,
                left.warnings,
            )
        if op == "-":
            return DerivedValue(
                left.mean - scalar,
                left.std.copy(),
                left.filters,
                left.nuclides,
                left.score,
                left.warnings,
            )
        if op == "*":
            return DerivedValue(
                left.mean * scalar,
                left.std * abs(scalar),
                left.filters,
                left.nuclides,
                left.score,
                left.warnings,
            )
        if scalar == 0:
            raise DerivedTallyError(
                "The expression divides by a scalar zero. Replace the divisor with a non-zero value."
            )
        return DerivedValue(
            left.mean / scalar,
            left.std / abs(scalar),
            left.filters,
            left.nuclides,
            left.score,
            left.warnings,
        )

    assert isinstance(left, DerivedValue) and isinstance(right, DerivedValue)
    axes = _result_axes(left, right)
    left_mean, left_std = _broadcast(left, axes)
    right_mean, right_std = _broadcast(right, axes)
    warnings = [*left.warnings, *right.warnings]
    if left.nuclides == right.nuclides:
        nuclides = list(left.nuclides)
        lmean = left_mean
        lstd = left_std
        rmean = right_mean
        rstd = right_std
    else:
        nuclides = [f"{a}/{b}" for a in left.nuclides for b in right.nuclides]
        lmean = np.repeat(left_mean, right.nuclide_count, axis=-1)
        lstd = np.repeat(left_std, right.nuclide_count, axis=-1)
        rmean = np.tile(right_mean, (1,) * (left_mean.ndim - 1) + (left.nuclide_count,))
        rstd = np.tile(right_std, (1,) * (right_mean.ndim - 1) + (left.nuclide_count,))
        lmean = lmean.reshape(lmean.shape[:-1] + (left.nuclide_count, right.nuclide_count))
        lstd = lstd.reshape(lstd.shape[:-1] + (left.nuclide_count, right.nuclide_count))
        rmean = rmean.reshape(rmean.shape[:-1] + (left.nuclide_count, right.nuclide_count))
        rstd = rstd.reshape(rstd.shape[:-1] + (left.nuclide_count, right.nuclide_count))

    if op in {"+", "-"}:
        mean = lmean + rmean if op == "+" else lmean - rmean
        std = np.sqrt(lstd**2 + rstd**2)
    elif op == "*":
        with np.errstate(divide="ignore", invalid="ignore"):
            relative = np.sqrt((lstd / lmean) ** 2 + (rstd / rmean) ** 2)
            mean = lmean * rmean
            std = np.abs(mean) * relative
        zero = (lmean == 0) | (rmean == 0)
        mean = np.where(zero, 0.0, mean)
        std = np.where(zero, 0.0, std)
    else:
        zero = rmean == 0
        with np.errstate(divide="ignore", invalid="ignore"):
            relative = np.sqrt((lstd / lmean) ** 2 + (rstd / rmean) ** 2)
            mean = np.where(zero, 0.0, lmean / rmean)
            std = np.abs(mean) * relative
        left_zero = lmean == 0
        mean = np.where(left_zero | zero, 0.0, mean)
        std = np.where(left_zero | zero, 0.0, std)
        if np.any(zero):
            warnings.append(
                f"{int(np.count_nonzero(zero))} bin(s) divide by a zero tally mean and were written as zero."
            )
    return _apply_finite(
        DerivedValue(
            np.asarray(mean, dtype=float),
            np.asarray(std, dtype=float),
            axes,
            nuclides,
            _combine_score(left.score, right.score, op),
            warnings,
        )
    )


def evaluate_expression(expression: Any, statepoint: Any) -> float | DerivedValue:
    """Evaluate a derived expression against ``openmc.StatePoint`` tallies."""
    if not isinstance(expression, dict):
        raise DerivedTallyError("Derived tally has no expression.")
    kind = expression.get("kind")
    if kind == "scalar":
        value = float(expression.get("value"))
        if not math.isfinite(value):
            raise DerivedTallyError("Scalar operands must be finite numbers.")
        return value
    if kind == "tally":
        return resolve_tally_operand(statepoint, expression)
    if kind == "unary":
        if expression.get("op") != "-":
            raise DerivedTallyError("Only unary negation is supported.")
        value = evaluate_expression(expression.get("operand"), statepoint)
        if isinstance(value, (int, float)):
            return -float(value)
        return DerivedValue(
            -value.mean,
            value.std.copy(),
            value.filters,
            value.nuclides,
            value.score,
            value.warnings,
        )
    if kind == "binary":
        left = evaluate_expression(expression.get("left"), statepoint)
        right = evaluate_expression(expression.get("right"), statepoint)
        return _binary_value(left, right, str(expression.get("op")))
    raise DerivedTallyError(f"Unknown derived expression node {kind!r}.")


def resolve_tally_operand(statepoint: Any, operand: dict[str, Any]) -> DerivedValue:
    """Resolve one tally/score (optionally nuclide-restricted) leaf."""
    tally_id = operand.get("tallyId")
    if not isinstance(tally_id, int):
        raise DerivedTallyError("Tally operands need an integer tally ID.")
    try:
        tally = statepoint.tallies[tally_id]
    except (KeyError, TypeError):
        available = ", ".join(str(key) for key in sorted(statepoint.tallies))
        raise DerivedTallyError(
            f"Tally {tally_id} is not in the statepoint (available: {available or 'none'})."
        ) from None

    scores = [str(score) for score in getattr(tally, "scores", [])]
    score = operand.get("score")
    if score not in scores:
        available = ", ".join(scores) or "none"
        raise DerivedTallyError(
            f"Tally {tally_id} does not score {score!r} in this statepoint (available: {available})."
        )
    nuclides = [str(nuclide) for nuclide in getattr(tally, "nuclides", [])] or ["total"]
    nuclide = operand.get("nuclide")
    if nuclide is not None and nuclide not in nuclides:
        available = ", ".join(nuclides)
        raise DerivedTallyError(
            f"Tally {tally_id} does not track nuclide {nuclide!r} (available: {available})."
        )

    mean = np.asarray(tally.mean, dtype=float)
    std = np.asarray(tally.std_dev, dtype=float)
    if mean.ndim != 3 or std.ndim != 3:
        raise DerivedTallyError(
            f"Tally {tally_id} results have unexpected shape {mean.shape}; expected (filter bins, nuclides, scores)."
        )
    if mean.shape != std.shape:
        raise DerivedTallyError(f"Tally {tally_id} mean and standard deviation shapes differ.")
    if mean.shape[1] != len(nuclides) or mean.shape[2] != len(scores):
        raise DerivedTallyError(
            f"Tally {tally_id} result shape {mean.shape} does not match "
            f"{len(nuclides)} nuclide(s) and {len(scores)} score(s)."
        )

    score_index = scores.index(score)
    nuclide_indices = (
        [nuclides.index(nuclide)] if nuclide is not None else list(range(len(nuclides)))
    )
    selected_mean = mean[:, nuclide_indices, score_index]
    selected_std = std[:, nuclide_indices, score_index]
    filters = [_filter_axis(filter_obj) for filter_obj in getattr(tally, "filters", [])]
    expected = int(np.prod([axis.bin_count for axis in filters])) if filters else 1
    if selected_mean.shape[0] != expected:
        raise DerivedTallyError(
            f"Tally {tally_id} has {selected_mean.shape[0]} filter bins but its filters describe {expected}. "
            "The statepoint may be inconsistent."
        )
    selected_nuclides = [nuclides[index] for index in nuclide_indices]
    return DerivedValue(selected_mean, selected_std, filters, selected_nuclides, score, [])


def evaluate_derived_tally(statepoint: Any, definition: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one derived-tally definition into the viewer payload."""
    expression = definition.get("expression")
    if expression is None:
        raise DerivedTallyError("The derived tally has no expression.")
    validate_division_by_zero(expression)
    value = evaluate_expression(expression, statepoint)
    if isinstance(value, (int, float)):
        raise DerivedTallyError("The expression must reference at least one tally score.")

    raw_mean = np.asarray(value.mean, dtype=float).reshape(-1)
    raw_std = np.asarray(value.std, dtype=float).reshape(-1)
    non_finite = int(
        np.count_nonzero(~np.isfinite(raw_mean)) + np.count_nonzero(~np.isfinite(raw_std))
    )
    flat_mean = np.nan_to_num(raw_mean, nan=0.0, posinf=0.0, neginf=0.0)
    flat_std = np.nan_to_num(raw_std, nan=0.0, posinf=0.0, neginf=0.0)
    warnings = list(value.warnings)
    if non_finite:
        warnings.append(f"{non_finite} non-finite moment(s) were written as zero.")
    filter_bins = int(np.prod(value.filter_shape)) if value.filters else 1
    result = {
        "id": definition.get("id"),
        "name": definition.get("name") or f"Derived {definition.get('id')}",
        "description": definition.get("description"),
        "formula": format_expression(expression),
        "unit": definition.get("unit"),
        "color": definition.get("color"),
        "mean": [float(item) for item in flat_mean],
        "stdDev": [float(item) for item in flat_std],
        "totalBins": int(flat_mean.size),
        "filters": [{"type": axis.type, "bins": axis.bins} for axis in value.filters],
        "scores": [value.score],
        "nuclides": value.nuclides,
        "shape": {"filterBins": filter_bins, "nuclides": len(value.nuclides), "scores": 1},
    }
    if warnings:
        result["warnings"] = warnings
    return result


class Hdf5Filter:
    """Minimal OpenMC-filter stand-in for the HDF5 fallback reader."""

    def __init__(self, type_name: str, bins: list[Any], num_bins: int):
        self.type_name = type_name
        self.bins = bins
        self.num_bins = max(1, num_bins)


class Hdf5Tally:
    """Minimal OpenMC-tally stand-in backed by a statepoint results dataset."""

    def __init__(
        self,
        scores: list[str],
        nuclides: list[str],
        filters: list[Hdf5Filter],
        mean: np.ndarray,
        std: np.ndarray,
    ):
        self.scores = scores
        self.nuclides = nuclides
        self.filters = filters
        self.mean = mean
        self.std_dev = std


def _decode_strings(dataset: Any) -> list[str]:
    if dataset is None:
        return []
    values = np.asarray(dataset[()]).ravel()
    return [value.decode("utf-8") if isinstance(value, bytes) else str(value) for value in values]


def _hdf5_filter_axes(group: Any, tally_group: Any, total_filter_bins: int) -> list[Hdf5Filter]:
    filter_ids: list[int] = []
    if "filters" in tally_group:
        reference = tally_group["filters"]
        if hasattr(reference, "shape"):
            filter_ids = [int(value) for value in np.asarray(reference[()]).ravel()]
    locations = [
        candidate
        for candidate in (group.get("filters"), group.get("tallies", {}).get("filters"))
        if candidate is not None
    ]
    axes: list[Hdf5Filter] = []
    missing = 0
    for filter_id in filter_ids:
        key = f"filter {filter_id}"
        filter_group = next((location[key] for location in locations if key in location), None)
        if filter_group is None:
            missing += 1
            continue
        if "type" in filter_group:
            raw_type = filter_group["type"][()]
            type_name = raw_type.decode("utf-8") if isinstance(raw_type, bytes) else str(raw_type)
        else:
            raw_type = filter_group.attrs.get("type", "filter")
            type_name = raw_type.decode("utf-8") if isinstance(raw_type, bytes) else str(raw_type)
        bins = _canonical(filter_group["bins"][()]) if "bins" in filter_group else []
        num_bins = (
            int(filter_group["n_bins"][()])
            if "n_bins" in filter_group
            else (len(bins) if isinstance(bins, list) else 1)
        )
        if not isinstance(bins, list):
            bins = [bins]
        if len(bins) != num_bins and len(bins) == 1:
            # Synthetic meshes store only the mesh ID; expose one label per bin.
            bins = list(range(num_bins))
        axes.append(Hdf5Filter(type_name, bins, num_bins))
    known = int(np.prod([axis.num_bins for axis in axes])) if axes else 1
    if total_filter_bins != known:
        # Synthetic/minimal fixtures may omit filter groups; keep one explicit
        # axis so the result still reports its bin count honestly.
        missing_bins = max(1, total_filter_bins // max(1, known))
        axes.append(Hdf5Filter("filter", list(range(missing_bins)), missing_bins))
    return axes


def load_hdf5_statepoint(path: Path) -> Any:
    """Fallback reader for statepoints OpenMC cannot open (synthetic fixtures).

    Mirrors the statepoint results layout: ``results`` stores ``[sum, sum_sq]``
    per filter/scores/nuclides bin. Tallies are returned as lightweight objects
    with the same public fields the evaluator reads from ``openmc.Tally``.
    """
    try:
        import h5py
    except ImportError as error:
        raise DerivedTallyError(f"h5py is required to read statepoints: {error}") from None

    tallies: dict[int, Hdf5Tally] = {}
    with h5py.File(path, "r") as handle:
        if "tallies" not in handle:
            raise DerivedTallyError(f"No tallies found in {path}")
        groups = handle["tallies"]
        for key in groups.keys():
            if not key.startswith("tally "):
                continue
            tally_id = int(key.split()[-1])
            tally_group = groups[key]
            scores = _decode_strings(tally_group.get("score_bins"))
            if not scores and "score" in tally_group.attrs:
                raw = tally_group.attrs["score"]
                scores = (raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)).split()
            nuclides = _decode_strings(tally_group.get("nuclides")) or ["total"]
            if "results" not in tally_group:
                raise DerivedTallyError(f"Tally {tally_id} has no results dataset")
            results = np.asarray(tally_group["results"][()], dtype=float)
            if results.shape[-1] != 2:
                raise DerivedTallyError(f"Tally {tally_id} results do not store [sum, sum_sq]")
            realizations = (
                int(tally_group["n_realizations"][()]) if "n_realizations" in tally_group else 1
            )
            sums = results[..., 0]
            sums_sq = results[..., 1]
            mean = sums / max(1, realizations)
            if realizations > 1:
                variance = (sums_sq / realizations - mean**2) / (realizations - 1)
                std = np.sqrt(np.clip(variance, 0.0, None))
            else:
                std = np.zeros_like(mean)
            if mean.ndim != 3:
                raise DerivedTallyError(
                    f"Tally {tally_id} results have unexpected shape {mean.shape}"
                )
            mean = np.swapaxes(mean, 1, 2)
            std = np.swapaxes(std, 1, 2)
            filters = _hdf5_filter_axes(handle, tally_group, mean.shape[0])
            tallies[tally_id] = Hdf5Tally(scores or ["flux"], nuclides, filters, mean, std)
    return tallies


def _evaluate_definitions(
    statepoint: Any, definitions: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    derived: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for definition in definitions:
        try:
            derived.append(evaluate_derived_tally(statepoint, definition))
        except DerivedTallyError as error:
            errors.append(
                {
                    "id": definition.get("id"),
                    "name": definition.get("name") or f"Derived {definition.get('id')}",
                    "error": str(error),
                }
            )
        except Exception as error:  # noqa: BLE001 - one bad definition must not hide the rest
            errors.append(
                {
                    "id": definition.get("id"),
                    "name": definition.get("name") or f"Derived {definition.get('id')}",
                    "error": f"Failed to evaluate: {error}",
                    "traceback": traceback.format_exc(),
                }
            )
    return derived, errors


def parse_definitions(raw: str) -> list[dict[str, Any]]:
    """Parse the definitions payload (array or ``{derivedTallies: [...]}``)."""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DerivedTallyError(f"Derived-tally definitions are not valid JSON: {error}") from None
    if isinstance(payload, dict):
        payload = payload.get("derivedTallies", payload.get("definitions"))
    if not isinstance(payload, list):
        raise DerivedTallyError("Derived-tally definitions must be a JSON array.")
    definitions = []
    seen_ids = set()
    for index, entry in enumerate(payload):
        if not isinstance(entry, dict):
            raise DerivedTallyError(f"Derived tally at index {index} must be an object.")
        tally_id = entry.get("id")
        if not isinstance(tally_id, int):
            raise DerivedTallyError(f"Derived tally at index {index} needs an integer id.")
        if tally_id in seen_ids:
            raise DerivedTallyError(f"Derived tally id {tally_id} is duplicated.")
        seen_ids.add(tally_id)
        definitions.append(entry)
    return definitions


def run(statepoint_path: str, definitions_raw: str) -> dict[str, Any]:
    """Read the statepoint and evaluate every definition."""
    path = Path(statepoint_path)
    if not path.exists():
        return {"success": False, "error": f"File not found: {path}"}
    if path.suffix != ".h5":
        return {"success": False, "error": f"Not an HDF5 statepoint: {path}"}

    try:
        definitions = parse_definitions(definitions_raw)
    except DerivedTallyError as error:
        return {"success": False, "error": str(error)}

    try:
        import openmc
    except ImportError:
        openmc = None

    if openmc is not None:
        try:
            with openmc.StatePoint(str(path)) as statepoint:
                derived, errors = _evaluate_definitions(statepoint, definitions)
            return {
                "success": True,
                "statepoint": str(path.absolute()),
                "derivedTallies": derived,
                "errors": errors,
            }
        except Exception as error:  # noqa: BLE001 - try the HDF5 fallback below
            openmc_error = error
    else:
        openmc_error = None

    try:
        tallies = load_hdf5_statepoint(path)
        derived, errors = _evaluate_definitions(types.SimpleNamespace(tallies=tallies), definitions)
        return {
            "success": True,
            "statepoint": str(path.absolute()),
            "derivedTallies": derived,
            "errors": errors,
        }
    except Exception as fallback_error:  # noqa: BLE001 - report the best available error
        detail = openmc_error if openmc_error is not None else fallback_error
        return {
            "success": False,
            "error": f"Failed to read statepoint: {detail}",
            "traceback": traceback.format_exc(),
        }


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; always prints one JSON object after parsing flags."""
    parser = argparse.ArgumentParser(
        description="Evaluate derived OpenMC tallies from a statepoint"
    )
    parser.add_argument("--statepoint", required=True, help="Path to statepoint .h5")
    parser.add_argument("--definitions-file", help="JSON file with derived-tally definitions")
    parser.add_argument("--definitions", help="Inline JSON derived-tally definitions")
    parser.add_argument(
        "--json", action="store_true", help="Emit JSON (always on; accepted for symmetry)"
    )
    args = parser.parse_args(argv)

    try:
        if args.definitions_file:
            definitions_raw = Path(args.definitions_file).read_text(encoding="utf-8")
        elif args.definitions is not None:
            definitions_raw = args.definitions
        else:
            result = {"success": False, "error": "No derived-tally definitions were provided."}
            print(json.dumps(result))
            return 0
        result = run(args.statepoint, definitions_raw)
    except Exception as error:  # noqa: BLE001 - never exit without a JSON response
        result = {
            "success": False,
            "error": f"Derived-tally evaluation failed: {error}",
            "traceback": traceback.format_exc(),
        }

    print(json.dumps(result, cls=NumpyEncoder))
    return 0


if __name__ == "__main__":
    sys.exit(main())
