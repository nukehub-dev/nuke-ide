#!/usr/bin/env python3
"""Versioned fastener thread data tables (spot-checks + invariants).

Guards the real standard values in ``fastener_data``: ISO metric coarse +
fine (M1-M64) and the UNC/UNF 1/4"-1" subset.  Pure data + lookups, so this
runs in the minimal pytest profile (pytest + numpy only).
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

import math
import os

import fastener_data as fd
import pytest

#: Independent transcription of the ISO 261 coarse series (diameter -> pitch).
EXPECTED_COARSE_PITCH = {
    1.0: 0.25,
    1.1: 0.25,
    1.2: 0.25,
    1.4: 0.30,
    1.6: 0.35,
    1.8: 0.35,
    2.0: 0.40,
    2.2: 0.45,
    2.5: 0.45,
    3.0: 0.50,
    3.5: 0.60,
    4.0: 0.70,
    4.5: 0.75,
    5.0: 0.80,
    6.0: 1.00,
    7.0: 1.00,
    8.0: 1.25,
    9.0: 1.25,
    10.0: 1.50,
    11.0: 1.50,
    12.0: 1.75,
    14.0: 2.00,
    16.0: 2.00,
    18.0: 2.50,
    20.0: 2.50,
    22.0: 2.50,
    24.0: 3.00,
    27.0: 3.00,
    30.0: 3.50,
    33.0: 3.50,
    36.0: 4.00,
    39.0: 4.00,
    42.0: 4.50,
    45.0: 4.50,
    48.0: 5.00,
    52.0: 5.00,
    56.0: 5.50,
    60.0: 5.50,
    64.0: 6.00,
}

#: Independent transcription of the UNC/UNF 1/4"-1" subset
#: (designation -> (TPI, pitch mm, tap-drill mm)).
EXPECTED_INCH = {
    "1/4-20 UNC": (20, 1.270, 5.10),
    "5/16-18 UNC": (18, 1.411, 6.60),
    "3/8-16 UNC": (16, 1.588, 8.00),
    "7/16-14 UNC": (14, 1.814, 9.40),
    "1/2-13 UNC": (13, 1.954, 10.80),
    "9/16-12 UNC": (12, 2.117, 12.20),
    "5/8-11 UNC": (11, 2.309, 13.50),
    "3/4-10 UNC": (10, 2.540, 16.50),
    "7/8-9 UNC": (9, 2.822, 19.50),
    "1-8 UNC": (8, 3.175, 22.25),
    "1/4-28 UNF": (28, 0.907, 5.50),
    "5/16-24 UNF": (24, 1.058, 6.90),
    "3/8-24 UNF": (24, 1.058, 8.50),
    "7/16-20 UNF": (20, 1.270, 9.90),
    "1/2-20 UNF": (20, 1.270, 11.50),
    "9/16-18 UNF": (18, 1.411, 12.90),
    "5/8-18 UNF": (18, 1.411, 14.50),
    "3/4-16 UNF": (16, 1.588, 17.50),
    "7/8-14 UNF": (14, 1.814, 20.40),
    "1-12 UNF": (12, 2.117, 23.25),
}


def test_data_version() -> None:
    assert fd.FASTENER_DATA_VERSION == 1


def test_m10_coarse_spot_check() -> None:
    """M10 coarse is 1.5 mm pitch with an 8.5 mm tap drill."""
    assert fd.pitch_for("M10x1.5") == 1.5
    assert fd.tap_drill_for("M10x1.5") == 8.5
    assert fd.diameter_for("M10x1.5") == 10.0
    assert fd.thread_family("M10x1.5") == "metric-coarse"
    # A bare diameter means coarse pitch by drawing convention.
    assert fd.pitch_for("M10") == 1.5
    assert fd.thread_family("M10") == "metric-coarse"


def test_m6_fine_spot_check() -> None:
    """M6 fine is 0.75 mm pitch."""
    assert fd.pitch_for("M6x0.75") == 0.75
    assert fd.tap_drill_for("M6x0.75") == pytest.approx(5.25)
    assert fd.thread_family("M6x0.75") == "metric-fine"


def test_quarter_twenty_unc_spot_check() -> None:
    """1/4-20 UNC pitch is 25.4/20 mm; the tap is the #7 drill (~5.1 mm)."""
    assert fd.pitch_for("1/4-20 UNC") == pytest.approx(25.4 / 20, abs=1e-9)
    assert fd.thread_family("1/4-20 UNC") == "unc"
    # Exact inch math: (0.25 - 1/20) inch in mm; the stored stock-drill
    # value (#7 = 0.201" = 5.105 mm, stored 5.10) must land within 0.05 mm.
    exact_tap_mm = (0.25 - 1.0 / 20.0) * 25.4
    assert fd.tap_drill_for("1/4-20 UNC") == pytest.approx(exact_tap_mm, abs=0.05)


def test_coarse_table_matches_iso_261() -> None:
    coarse = fd.list_designations("metric-coarse")
    assert len(coarse) == len(EXPECTED_COARSE_PITCH)
    for diameter, pitch in EXPECTED_COARSE_PITCH.items():
        designation = f"M{diameter:g}x{pitch:g}"
        assert designation in coarse
        assert fd.pitch_for(designation) == pitch
        assert fd.tap_drill_for(designation) == pytest.approx(diameter - pitch)


def test_inch_subset_values() -> None:
    for designation, (tpi, pitch_mm, tap_mm) in EXPECTED_INCH.items():
        spec = fd.get_spec(designation)
        assert spec.threads_per_inch == tpi
        assert spec.pitch_mm == pytest.approx(pitch_mm, abs=1e-9)
        assert spec.tap_drill_mm == pytest.approx(tap_mm, abs=1e-9)
        assert spec.pitch_mm == pytest.approx(25.4 / tpi, abs=1e-3)
        # Stored stock-drill taps stay close to the exact major-minus-pitch math.
        assert spec.major_diameter_in is not None
        exact_tap_mm = (spec.major_diameter_in - 1.0 / tpi) * 25.4
        assert spec.tap_drill_mm == pytest.approx(exact_tap_mm, abs=0.15)


def test_metric_tap_drills_are_diameter_minus_pitch() -> None:
    """FreeCAD convention: metric tap drill = nominal diameter - pitch."""
    for family in ("metric-coarse", "metric-fine"):
        for designation in fd.list_designations(family):
            spec = fd.get_spec(designation)
            assert spec.tap_drill_mm == pytest.approx(spec.diameter_mm - spec.pitch_mm)
            assert 0.0 < spec.pitch_mm < spec.diameter_mm
            assert spec.threads_per_inch is None


def test_thread_family_listing() -> None:
    assert fd.list_thread_families() == ["metric-coarse", "metric-fine", "unc", "unf"]
    assert len(fd.list_designations("metric-coarse")) == 39
    assert len(fd.list_designations("metric-fine")) == 122
    assert len(fd.list_designations("unc")) == 10
    assert len(fd.list_designations("unf")) == 10
    all_designations = fd.list_designations()
    assert len(all_designations) == 181
    assert len(set(all_designations)) == 181
    assert "M10x1.5" in all_designations
    assert "1/4-20 UNC" in all_designations
    with pytest.raises(KeyError):
        fd.list_designations("metric-extra-fine")


def test_lookup_normalization_and_errors() -> None:
    assert fd.pitch_for("m10x1.5") == 1.5
    assert fd.pitch_for("M10X1.5") == 1.5
    assert fd.tap_drill_for("1/4-20 unc") == pytest.approx(5.10)
    assert fd.thread_family("3/4-16 UNF") == "unf"
    with pytest.raises(KeyError):
        fd.pitch_for("M10x9.99")
    with pytest.raises(KeyError):
        fd.tap_drill_for("M13")
    with pytest.raises(KeyError):
        fd.thread_family("1/4-20 UNEF")


def test_no_heavy_imports() -> None:
    """The module must stay importable without OCP/build123d installed."""
    with open(os.path.join(os.path.dirname(fd.__file__), "fastener_data.py")) as handle:
        source = handle.read()
    for line in source.splitlines():
        stripped = line.strip()
        assert not stripped.startswith("import OCP")
        assert not stripped.startswith("from OCP")
        assert not stripped.startswith("import build123d")
        assert not stripped.startswith("from build123d")
    for spec in fd.THREAD_TABLE.values():
        assert isinstance(spec.pitch_mm, float)
        assert isinstance(spec.tap_drill_mm, float)
        assert math.isfinite(spec.diameter_mm)
