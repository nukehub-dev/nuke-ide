#!/usr/bin/env python3
"""Versioned fastener thread data tables for nuke-cad.

Plain ISO metric (coarse + fine, M1-M64) and UNC/UNF (1/4"-1") diameter /
pitch / tap-drill tables for later hole/thread recognition, mirroring the
role FreeCAD's ``FeatureHole`` thread tables play there.  Pure data plus
lookup helpers; no OCP/build123d imports so this module stays importable in
the minimal pytest profile (pytest + numpy only).

Designations are canonical strings:

- metric coarse/fine: ``'M10x1.5'`` (a bare ``'M10'`` is accepted as an
  alias for the coarse entry, matching drawing convention where an omitted
  pitch means coarse);
- inch: ``'1/4-20 UNC'`` / ``'1/4-28 UNF'``.

All lengths are millimetres.  Metric tap drills are the theoretical
diameter-minus-pitch values also stored by FreeCAD (shop wall charts round
a few of these to stock drills: M8 -> 6.8, M12 -> 10.2, M10x1.25 -> 8.8).
Inch tap drills are the stock-drill values from the same FreeCAD tables
(e.g. 1/4-20 -> 5.10 mm, the #7 drill at 5.105 mm), so they sit within
~0.1 mm of the exact major-minus-pitch math.

Bump :data:`FASTENER_DATA_VERSION` whenever a table entry is added,
removed, or corrected so consumers can gate on it.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Version of the tables below.  Bump on any entry add/remove/correction.
FASTENER_DATA_VERSION = 1

#: Thread family ids.
METRIC_COARSE = "metric-coarse"
METRIC_FINE = "metric-fine"
UNC = "unc"
UNF = "unf"

#: All supported families, in listing order.
THREAD_FAMILIES: tuple[str, ...] = (METRIC_COARSE, METRIC_FINE, UNC, UNF)


@dataclass(frozen=True)
class ThreadSpec:
    """One row of the fastener tables.  All lengths are millimetres."""

    designation: str
    family: str
    diameter_mm: float
    pitch_mm: float
    tap_drill_mm: float
    threads_per_inch: int | None = None
    major_diameter_in: float | None = None


# (nominal diameter mm, pitch mm) per ISO 261, M1-M64 including the
# second-choice diameters (M1.1, M2.2, M9, M11).
_METRIC_COARSE_ROWS: tuple[tuple[float, float], ...] = (
    (1.0, 0.25),
    (1.1, 0.25),
    (1.2, 0.25),
    (1.4, 0.30),
    (1.6, 0.35),
    (1.8, 0.35),
    (2.0, 0.40),
    (2.2, 0.45),
    (2.5, 0.45),
    (3.0, 0.50),
    (3.5, 0.60),
    (4.0, 0.70),
    (4.5, 0.75),
    (5.0, 0.80),
    (6.0, 1.00),
    (7.0, 1.00),
    (8.0, 1.25),
    (9.0, 1.25),
    (10.0, 1.50),
    (11.0, 1.50),
    (12.0, 1.75),
    (14.0, 2.00),
    (16.0, 2.00),
    (18.0, 2.50),
    (20.0, 2.50),
    (22.0, 2.50),
    (24.0, 3.00),
    (27.0, 3.00),
    (30.0, 3.50),
    (33.0, 3.50),
    (36.0, 4.00),
    (39.0, 4.00),
    (42.0, 4.50),
    (45.0, 4.50),
    (48.0, 5.00),
    (52.0, 5.00),
    (56.0, 5.50),
    (60.0, 5.50),
    (64.0, 6.00),
)

# (nominal diameter mm, pitch mm) fine series per DIN 13 / ISO 261, matching
# the FreeCAD FeatureHole fine set for diameters up to M64 (tap drill =
# diameter - pitch throughout).
_METRIC_FINE_ROWS: tuple[tuple[float, float], ...] = (
    (1.0, 0.20),
    (1.1, 0.20),
    (1.2, 0.20),
    (1.4, 0.20),
    (1.6, 0.20),
    (1.8, 0.20),
    (2.0, 0.25),
    (2.2, 0.25),
    (2.5, 0.35),
    (3.0, 0.35),
    (3.5, 0.35),
    (4.0, 0.50),
    (4.5, 0.50),
    (5.0, 0.50),
    (5.5, 0.50),
    (6.0, 0.75),
    (7.0, 0.75),
    (8.0, 0.75),
    (8.0, 1.00),
    (9.0, 0.75),
    (9.0, 1.00),
    (10.0, 0.75),
    (10.0, 1.00),
    (10.0, 1.25),
    (11.0, 0.75),
    (11.0, 1.00),
    (12.0, 1.00),
    (12.0, 1.25),
    (12.0, 1.50),
    (14.0, 1.00),
    (14.0, 1.25),
    (14.0, 1.50),
    (15.0, 1.00),
    (15.0, 1.50),
    (16.0, 1.00),
    (16.0, 1.50),
    (17.0, 1.00),
    (17.0, 1.50),
    (18.0, 1.00),
    (18.0, 1.50),
    (18.0, 2.00),
    (20.0, 1.00),
    (20.0, 1.50),
    (20.0, 2.00),
    (22.0, 1.00),
    (22.0, 1.50),
    (22.0, 2.00),
    (24.0, 1.00),
    (24.0, 1.50),
    (24.0, 2.00),
    (25.0, 1.00),
    (25.0, 1.50),
    (25.0, 2.00),
    (27.0, 1.00),
    (27.0, 1.50),
    (27.0, 2.00),
    (28.0, 1.00),
    (28.0, 1.50),
    (28.0, 2.00),
    (30.0, 1.00),
    (30.0, 1.50),
    (30.0, 2.00),
    (30.0, 3.00),
    (32.0, 1.50),
    (32.0, 2.00),
    (33.0, 1.50),
    (33.0, 2.00),
    (33.0, 3.00),
    (35.0, 1.50),
    (35.0, 2.00),
    (36.0, 1.50),
    (36.0, 2.00),
    (36.0, 3.00),
    (39.0, 1.50),
    (39.0, 2.00),
    (39.0, 3.00),
    (40.0, 1.50),
    (40.0, 2.00),
    (40.0, 3.00),
    (42.0, 1.50),
    (42.0, 2.00),
    (42.0, 3.00),
    (42.0, 4.00),
    (45.0, 1.50),
    (45.0, 2.00),
    (45.0, 3.00),
    (45.0, 4.00),
    (48.0, 1.50),
    (48.0, 2.00),
    (48.0, 3.00),
    (48.0, 4.00),
    (50.0, 1.50),
    (50.0, 2.00),
    (50.0, 3.00),
    (52.0, 1.50),
    (52.0, 2.00),
    (52.0, 3.00),
    (52.0, 4.00),
    (55.0, 1.50),
    (55.0, 2.00),
    (55.0, 3.00),
    (55.0, 4.00),
    (56.0, 1.50),
    (56.0, 2.00),
    (56.0, 3.00),
    (56.0, 4.00),
    (58.0, 1.50),
    (58.0, 2.00),
    (58.0, 3.00),
    (58.0, 4.00),
    (60.0, 1.50),
    (60.0, 2.00),
    (60.0, 3.00),
    (60.0, 4.00),
    (62.0, 1.50),
    (62.0, 2.00),
    (62.0, 3.00),
    (62.0, 4.00),
    (64.0, 1.50),
    (64.0, 2.00),
    (64.0, 3.00),
    (64.0, 4.00),
)

# (fraction, TPI, major diameter mm, pitch mm, stock tap-drill mm),
# 1/4"-1" subset, values as stored by FreeCAD FeatureHole.
_UNC_ROWS: tuple[tuple[str, int, float, float, float], ...] = (
    ("1/4", 20, 6.350, 1.270, 5.10),
    ("5/16", 18, 7.938, 1.411, 6.60),
    ("3/8", 16, 9.525, 1.588, 8.00),
    ("7/16", 14, 11.113, 1.814, 9.40),
    ("1/2", 13, 12.700, 1.954, 10.80),
    ("9/16", 12, 14.288, 2.117, 12.20),
    ("5/8", 11, 15.875, 2.309, 13.50),
    ("3/4", 10, 19.050, 2.540, 16.50),
    ("7/8", 9, 22.225, 2.822, 19.50),
    ("1", 8, 25.400, 3.175, 22.25),
)

_UNF_ROWS: tuple[tuple[str, int, float, float, float], ...] = (
    ("1/4", 28, 6.350, 0.907, 5.50),
    ("5/16", 24, 7.938, 1.058, 6.90),
    ("3/8", 24, 9.525, 1.058, 8.50),
    ("7/16", 20, 11.113, 1.270, 9.90),
    ("1/2", 20, 12.700, 1.270, 11.50),
    ("9/16", 18, 14.288, 1.411, 12.90),
    ("5/8", 18, 15.875, 1.411, 14.50),
    ("3/4", 16, 19.050, 1.588, 17.50),
    ("7/8", 14, 22.225, 1.814, 20.40),
    ("1", 12, 25.400, 2.117, 23.25),
)


def _metric_designation(diameter: float, pitch: float) -> str:
    """Format the canonical metric designation, e.g. ``'M10x1.5'``."""
    return f"M{diameter:g}x{pitch:g}"


def _fraction_to_inches(fraction: str) -> float:
    """Convert ``'1/4'`` (or a whole ``'1'``) to inches."""
    text = fraction.strip()
    if "/" in text:
        numerator, _, denominator = text.partition("/")
        return float(numerator) / float(denominator)
    return float(text)


def _build_table() -> dict[str, ThreadSpec]:
    """Assemble the versioned lookup table from the rows above."""
    table: dict[str, ThreadSpec] = {}
    for diameter, pitch in _METRIC_COARSE_ROWS:
        designation = _metric_designation(diameter, pitch)
        table[designation] = ThreadSpec(
            designation=designation,
            family=METRIC_COARSE,
            diameter_mm=diameter,
            pitch_mm=pitch,
            tap_drill_mm=diameter - pitch,
        )
    for diameter, pitch in _METRIC_FINE_ROWS:
        designation = _metric_designation(diameter, pitch)
        table[designation] = ThreadSpec(
            designation=designation,
            family=METRIC_FINE,
            diameter_mm=diameter,
            pitch_mm=pitch,
            tap_drill_mm=diameter - pitch,
        )
    for family, rows in ((UNC, _UNC_ROWS), (UNF, _UNF_ROWS)):
        for fraction, tpi, diameter_mm, pitch_mm, tap_mm in rows:
            designation = f"{fraction}-{tpi} {family.upper()}"
            table[designation] = ThreadSpec(
                designation=designation,
                family=family,
                diameter_mm=diameter_mm,
                pitch_mm=pitch_mm,
                tap_drill_mm=tap_mm,
                threads_per_inch=tpi,
                major_diameter_in=_fraction_to_inches(fraction),
            )
    return table


#: Canonical designation -> spec for every supported thread.
THREAD_TABLE: dict[str, ThreadSpec] = _build_table()

#: Nominal metric diameter -> coarse designation (bare ``'M10'`` lookup).
_COARSE_BY_DIAMETER: dict[float, str] = {
    spec.diameter_mm: spec.designation
    for spec in THREAD_TABLE.values()
    if spec.family == METRIC_COARSE
}


def _normalize(designation: str) -> str:
    """Normalize user input to a canonical table key.

    Accepts any case and surrounding/extra whitespace (``'m10x1.5'``,
    ``'1/4-20 unc'``); a bare metric diameter (``'M10'``) resolves to its
    coarse entry.
    """
    text = designation.strip().upper().replace(" ", "")
    if text.startswith("M"):
        rest = text[1:]
        if "X" in rest:
            diameter_text, _, pitch_text = rest.partition("X")
            return _metric_designation(float(diameter_text), float(pitch_text))
        coarse = _COARSE_BY_DIAMETER.get(float(rest))
        if coarse is None:
            raise KeyError(f"unknown thread designation: {designation!r}")
        return coarse
    for family in (UNC, UNF):
        suffix = family.upper()
        if text.endswith(suffix):
            size = text[: -len(suffix)]
            fraction, _, tpi_text = size.partition("-")
            tpi = int(tpi_text)
            return f"{fraction.strip()}-{tpi} {suffix}"
    raise KeyError(f"unknown thread designation: {designation!r}")


def get_spec(designation: str) -> ThreadSpec:
    """Return the :class:`ThreadSpec` for a canonical (or equivalent) designation."""
    try:
        return THREAD_TABLE[_normalize(designation)]
    except KeyError:
        raise KeyError(f"unknown thread designation: {designation!r}") from None


def pitch_for(designation: str) -> float:
    """Return the thread pitch in millimetres."""
    return get_spec(designation).pitch_mm


def tap_drill_for(designation: str) -> float:
    """Return the tapping-drill diameter in millimetres."""
    return get_spec(designation).tap_drill_mm


def diameter_for(designation: str) -> float:
    """Return the nominal (major) diameter in millimetres."""
    return get_spec(designation).diameter_mm


def thread_family(designation: str) -> str:
    """Return the thread family id (``'metric-coarse'`` / ``'metric-fine'`` / ``'unc'`` / ``'unf'``)."""
    return get_spec(designation).family


def list_thread_families() -> list[str]:
    """Return all supported thread family ids."""
    return list(THREAD_FAMILIES)


def list_designations(family: str | None = None) -> list[str]:
    """List canonical designations, optionally restricted to one family."""
    if family is None:
        return [spec.designation for spec in THREAD_TABLE.values()]
    if family not in THREAD_FAMILIES:
        raise KeyError(f"unknown thread family: {family!r}")
    return [spec.designation for spec in THREAD_TABLE.values() if spec.family == family]
