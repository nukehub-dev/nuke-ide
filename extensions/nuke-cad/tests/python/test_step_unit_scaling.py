#!/usr/bin/env python3
"""STEP/IGES/BREP import length-unit detection and scaling.

Pure-mapping, IGES text-parser, and mocked-plumbing tests run in the minimal
pytest profile (pytest + numpy only); OCP-bound tests (real FileUnits
detection, end-to-end scaled imports) skip cleanly without the full CAD
profile. Mock seams: ``_ocp_step_length_names`` (STEP detection),
``_read_step``/``_read_step_raw``/``_scale_shape_uniform``/``_process_shape``
(import plumbing).
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

import json
import re
import sys
from pathlib import Path

import geometry_service
import pytest


def _requires_cad():
    """Skip unless build123d (and therefore OCP) is installed."""
    return pytest.importorskip("build123d", reason="build123d not installed")


# ---------------------------------------------------------------------------
# Pure unit-name mapping (minimal profile).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected_mm"),
    [
        ("millimetre", 1.0),
        ("millimeter", 1.0),
        ("centimetre", 10.0),
        ("metre", 1000.0),
        ("meter", 1000.0),
        ("INCH", 25.4),
        ("inch", 25.4),
        ("Inch", 25.4),
        ("  inch  ", 25.4),
        ("foot", 304.8),
        ("feet", 304.8),
        ("FT", 304.8),
        ("MM", 1.0),
        ("CM", 10.0),
        ("M", 1000.0),
        ("UIN", 0.0000254),
        ("MIL", 0.0254),
        ("UM", 0.001),
    ],
)
def test_mm_per_length_unit_exact_factors(name: str, expected_mm: float) -> None:
    assert geometry_service._mm_per_length_unit(name) == expected_mm


@pytest.mark.parametrize("name", ["", "   ", "furlong", "lightyear", None, 42, 25.4])
def test_mm_per_length_unit_unknown_is_none(name: object) -> None:
    assert geometry_service._mm_per_length_unit(name) is None


def test_canonical_length_unit_spellings() -> None:
    assert geometry_service._canonical_length_unit("millimetre") == "mm"
    assert geometry_service._canonical_length_unit("METRE") == "m"
    assert geometry_service._canonical_length_unit("inches") == "inch"
    # Unknown names pass through lowercased so callers can still report them.
    assert geometry_service._canonical_length_unit("Furlong") == "furlong"
    assert geometry_service._canonical_length_unit("") is None
    assert geometry_service._canonical_length_unit(None) is None


# ---------------------------------------------------------------------------
# Resolve rules (minimal profile).
# ---------------------------------------------------------------------------


def test_resolve_adopt_when_target_unset() -> None:
    target, scale, adopted = geometry_service._resolve_import_unit_scale("inch", 25.4, None)
    assert (target, scale, adopted) == ("inch", 1.0, True)


def test_resolve_scale_on_mismatch_is_exact() -> None:
    target, scale, adopted = geometry_service._resolve_import_unit_scale("inch", 25.4, "mm")
    assert target == "mm"
    assert scale == 25.4
    assert adopted is False

    _, scale_cm, _ = geometry_service._resolve_import_unit_scale("mm", 1.0, "cm")
    assert scale_cm == 0.1

    _, scale_same, _ = geometry_service._resolve_import_unit_scale("cm", 10.0, "cm")
    assert scale_same == 1.0


def test_resolve_unitless_target_and_file_is_legacy_noop() -> None:
    assert geometry_service._resolve_import_unit_scale(None, None, None) == (None, 1.0, False)


def test_resolve_unknown_file_unit_never_scales() -> None:
    target, scale, adopted = geometry_service._resolve_import_unit_scale(None, None, "mm")
    assert (target, scale, adopted) == ("mm", 1.0, False)


def test_normalize_target_units() -> None:
    assert geometry_service._normalize_target_units(None) is None
    assert geometry_service._normalize_target_units("mm") == "mm"
    assert geometry_service._normalize_target_units("CM") == "cm"
    assert geometry_service._normalize_target_units(" metre ") == "m"
    with pytest.raises(ValueError, match="Unknown target units"):
        geometry_service._normalize_target_units("furlong")


# ---------------------------------------------------------------------------
# STEP detection with a mocked reader layer (minimal profile).
# ---------------------------------------------------------------------------


def test_detect_step_file_unit_from_mocked_names(monkeypatch) -> None:
    monkeypatch.setattr(geometry_service, "_ocp_step_length_names", lambda path: ["millimetre"])
    assert geometry_service._detect_step_file_unit(Path("x.step")) == ("mm", 1.0)

    monkeypatch.setattr(geometry_service, "_ocp_step_length_names", lambda path: ["INCH"])
    assert geometry_service._detect_step_file_unit(Path("x.step")) == ("inch", 25.4)

    # Blank names (e.g. NAMED_UNIT(*) conversion-based units OCCT cannot
    # resolve) read as unitless.
    monkeypatch.setattr(geometry_service, "_ocp_step_length_names", lambda path: [""])
    assert geometry_service._detect_step_file_unit(Path("x.step")) == (None, None)

    # OCP missing/unreadable -> unitless.
    monkeypatch.setattr(geometry_service, "_ocp_step_length_names", lambda path: None)
    assert geometry_service._detect_step_file_unit(Path("x.step")) == (None, None)

    # Recognized name with no mm mapping is reported but never scaled.
    monkeypatch.setattr(geometry_service, "_ocp_step_length_names", lambda path: ["furlong"])
    assert geometry_service._detect_step_file_unit(Path("x.step")) == ("furlong", None)


# ---------------------------------------------------------------------------
# IGES global-section parser (minimal profile, hand-written text).
# ---------------------------------------------------------------------------


def _wrap_iges_global(body: str, first_seq: int = 1) -> str:
    """Chunk a global-section body into fixed-format G lines."""
    chunks = [body[i : i + 72] for i in range(0, len(body), 72)]
    return "\n".join(f"{chunk:<72}G{first_seq + k:7d}" for k, chunk in enumerate(chunks))


def _iges_file_text(units_name: str, units_flag: int, author: str = "tester") -> str:
    """Minimal IGES text with a controllable units name/flag (params 14/15)."""
    params = [
        "1H,",
        "1H;",
        "sender",
        "test.iges",
        "nuke-test",
        "v1",
        "32",
        "38",
        "15",
        "308",
        "15",
        "",
        "1.",
        str(units_flag),
        f"{len(units_name)}H{units_name}",
        "1",
        "0.01",
        "20260101.000000",
        "1E-07",
        "5.",
        f"{len(author)}H{author}",
        "",
        "11",
        "0",
        "20260101.000000",
    ]
    body = ",".join(params) + ";"
    return _wrap_iges_global(body) + "\n"


def test_detect_iges_flag_first(tmp_path: Path) -> None:
    probe = tmp_path / "mm.iges"
    probe.write_text(_iges_file_text("MM", 2))
    assert geometry_service._detect_iges_file_unit(probe) == ("mm", 1.0)

    probe.write_text(_iges_file_text("INCH", 1))
    assert geometry_service._detect_iges_file_unit(probe) == ("inch", 25.4)

    probe.write_text(_iges_file_text("CM", 10))
    assert geometry_service._detect_iges_file_unit(probe) == ("cm", 10.0)


def test_detect_iges_flag_three_falls_back_to_name(tmp_path: Path) -> None:
    probe = tmp_path / "inch.iges"
    probe.write_text(_iges_file_text("INCH", 3))
    assert geometry_service._detect_iges_file_unit(probe) == ("inch", 25.4)

    probe.write_text(_iges_file_text("ZZZ", 3))
    assert geometry_service._detect_iges_file_unit(probe) == ("zzz", None)


def test_detect_iges_tokenizer_survives_commas_in_strings(tmp_path: Path) -> None:
    probe = tmp_path / "comma.iges"
    probe.write_text(_iges_file_text("MM", 2, author="Doe, Jane"))
    assert geometry_service._detect_iges_file_unit(probe) == ("mm", 1.0)


def test_detect_iges_missing_or_short_section_is_unitless(tmp_path: Path) -> None:
    probe = tmp_path / "empty.iges"
    probe.write_text("no global section here\n")
    assert geometry_service._detect_iges_file_unit(probe) == (None, None)

    probe.write_text(_wrap_iges_global("1H,,1H;,") + "\n")
    assert geometry_service._detect_iges_file_unit(probe) == (None, None)

    missing = tmp_path / "missing.iges"
    assert geometry_service._detect_iges_file_unit(missing) == (None, None)


def test_detect_brep_has_no_units(tmp_path: Path) -> None:
    assert geometry_service._detect_brep_file_unit(tmp_path / "x.brep") == (None, None)


# ---------------------------------------------------------------------------
# Import plumbing with mocks (minimal profile).
# ---------------------------------------------------------------------------

_SENTINEL = object()
_SCALED = object()


def _patch_step_plumbing(monkeypatch, file_unit, file_mm):
    """Replace the OCP-bound import stages with sentinels; return call logs."""
    calls: dict = {"read": [], "read_raw": [], "scaled": [], "processed": []}
    monkeypatch.setattr(
        geometry_service, "_detect_step_file_unit", lambda path: (file_unit, file_mm)
    )
    monkeypatch.setattr(
        geometry_service, "_read_step", lambda path: calls["read"].append(path) or _SENTINEL
    )
    monkeypatch.setattr(
        geometry_service,
        "_read_step_raw",
        lambda path, system: calls["read_raw"].append((path, system)) or _SENTINEL,
    )
    monkeypatch.setattr(
        geometry_service,
        "_scale_shape_uniform",
        lambda shape, factor: calls["scaled"].append((shape, factor)) or _SCALED,
    )

    def _fake_process(shape, *args, **kwargs):
        calls["processed"].append(shape)
        return {"success": True}

    monkeypatch.setattr(geometry_service, "_process_shape", _fake_process)
    return calls


def test_import_step_adopts_file_unit_when_target_unset(monkeypatch, tmp_path: Path) -> None:
    calls = _patch_step_plumbing(monkeypatch, "inch", 25.4)
    probe = tmp_path / "box.step"
    probe.write_text("dummy")
    result = geometry_service.import_step_file(str(probe), output_dir=str(tmp_path))
    assert result["success"] is True
    # Raw file numbers: OCCT scaling suppressed, no backend rescale.
    assert len(calls["read_raw"]) == 1 and calls["read_raw"][0][1] == 25.4
    assert calls["read"] == []
    assert calls["scaled"] == []
    assert calls["processed"] == [_SENTINEL]
    assert result["fileUnit"] == "inch"
    assert result["targetUnits"] == "inch"
    assert result["unitScaleFactor"] == 1.0
    assert "adopted" in result["unitsMessage"]


def test_import_step_scales_on_mismatch_with_exact_factor(monkeypatch, tmp_path: Path) -> None:
    calls = _patch_step_plumbing(monkeypatch, "inch", 25.4)
    probe = tmp_path / "box.step"
    probe.write_text("dummy")
    result = geometry_service.import_step_file(
        str(probe), output_dir=str(tmp_path), target_units="mm"
    )
    assert result["success"] is True
    assert calls["scaled"] == [(_SENTINEL, 25.4)]
    assert calls["processed"] == [_SCALED]
    assert result["fileUnit"] == "inch"
    assert result["targetUnits"] == "mm"
    assert result["unitScaleFactor"] == 25.4
    assert "×25.4" in result["unitsMessage"]


def test_import_step_mm_to_cm_uses_legacy_reader(monkeypatch, tmp_path: Path) -> None:
    calls = _patch_step_plumbing(monkeypatch, "mm", 1.0)
    probe = tmp_path / "box.step"
    probe.write_text("dummy")
    result = geometry_service.import_step_file(
        str(probe), output_dir=str(tmp_path), target_units="cm"
    )
    assert result["success"] is True
    # Millimetre files take the legacy reader verbatim (no SetSystemLengthUnit).
    assert len(calls["read"]) == 1
    assert calls["read_raw"] == []
    assert calls["scaled"] == [(_SENTINEL, 0.1)]
    assert result["unitScaleFactor"] == 0.1
    assert "×0.1" in result["unitsMessage"]


def test_import_step_unitless_passthrough_is_legacy(monkeypatch, tmp_path: Path) -> None:
    calls = _patch_step_plumbing(monkeypatch, None, None)
    probe = tmp_path / "box.step"
    probe.write_text("dummy")
    result = geometry_service.import_step_file(str(probe), output_dir=str(tmp_path))
    assert result["success"] is True
    assert len(calls["read"]) == 1
    assert calls["read_raw"] == []
    assert calls["scaled"] == []
    assert result["fileUnit"] is None
    assert result["targetUnits"] is None
    assert result["unitScaleFactor"] == 1.0
    assert result["unitsMessage"] is None


def test_import_step_rejects_bad_target_before_io(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Unknown target units"):
        geometry_service.import_step_file(str(tmp_path / "missing.step"), target_units="furlong")


def test_import_iges_plumbing_scales_like_step(monkeypatch, tmp_path: Path) -> None:
    calls: dict = {"scaled": [], "processed": []}
    monkeypatch.setattr(geometry_service, "_detect_iges_file_unit", lambda path: ("inch", 25.4))
    monkeypatch.setattr(geometry_service, "_read_iges", lambda path: _SENTINEL)
    monkeypatch.setattr(
        geometry_service,
        "_scale_shape_uniform",
        lambda shape, factor: calls["scaled"].append((shape, factor)) or _SCALED,
    )

    def _fake_process(shape, *args, **kwargs):
        calls["processed"].append(shape)
        return {"success": True}

    monkeypatch.setattr(geometry_service, "_process_shape", _fake_process)
    probe = tmp_path / "box.iges"
    probe.write_text("dummy")
    result = geometry_service.import_iges_file(
        str(probe), output_dir=str(tmp_path), target_units="mm"
    )
    assert result["success"] is True
    # OCCT mm normalization undone (1/25.4), then file->target scaling (25.4).
    assert calls["scaled"] == [(_SENTINEL, 1.0 / 25.4), (_SCALED, 25.4)]
    assert result["unitScaleFactor"] == 25.4
    assert "×25.4" in result["unitsMessage"]


def test_import_brep_never_scales_but_records_target(monkeypatch, tmp_path: Path) -> None:
    calls: dict = {"scaled": []}
    monkeypatch.setattr(geometry_service, "_read_brep", lambda path: _SENTINEL)
    monkeypatch.setattr(
        geometry_service,
        "_scale_shape_uniform",
        lambda shape, factor: calls["scaled"].append((shape, factor)) or _SCALED,
    )
    monkeypatch.setattr(
        geometry_service, "_process_shape", lambda shape, *a, **k: {"success": True}
    )
    probe = tmp_path / "box.brep"
    probe.write_text("dummy")
    result = geometry_service.import_brep_file(
        str(probe), output_dir=str(tmp_path), target_units="mm"
    )
    assert result["success"] is True
    assert calls["scaled"] == []
    assert result["fileUnit"] is None
    assert result["targetUnits"] == "mm"
    assert result["unitScaleFactor"] == 1.0
    assert "kept native numbers" in result["unitsMessage"]


# ---------------------------------------------------------------------------
# Full profile: real OCP FileUnits detection + end-to-end scaled imports.
# ---------------------------------------------------------------------------


def _write_mm_box_step(path: Path):
    """Write a 10 mm cube STEP via the production writer; return its text."""
    bd = _requires_cad()
    geometry_service._write_step(bd.Box(10, 10, 10).wrapped, path)
    return path.read_text(encoding="utf-8")


def _craft_step_variant(text: str, kind: str) -> str:
    """Rewrite the length-unit declaration of an OCP-written STEP file.

    Only the unit declaration changes; coordinates stay raw file numbers, so
    a 10-unit box reads as 10 mm / 10 cm / 10 m / 10 inch respectively.
    """
    match = re.search(
        r"(#\d+) = \( LENGTH_UNIT\(\) NAMED_UNIT\(\*\) SI_UNIT\(\.MILLI\.,\.METRE\.\) \);",
        text,
    )
    assert match is not None, "expected an OCP millimetre length-unit declaration"
    length_id = match.group(1)
    used = [int(number) for number in re.findall(r"#(\d+) =", text)]
    fresh = max(used) + 1
    if kind == "cm":
        return text.replace(
            match.group(0),
            f"{length_id} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );",
        )
    if kind == "m":
        return text.replace(
            match.group(0),
            f"{length_id} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );",
        )
    if kind == "inch":
        # Conversion-based units need dimensional exponents (NAMED_UNIT(#dims))
        # or OCCT ignores the declaration (empty FileUnits, no scaling).
        return text.replace(
            match.group(0),
            f"{length_id} = ( CONVERSION_BASED_UNIT('INCH',#{fresh}) "
            f"LENGTH_UNIT() NAMED_UNIT(#{fresh + 2}) );\n"
            f"#{fresh} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(2.54E-02),#{fresh + 1});\n"
            f"#{fresh + 1} = ( LENGTH_UNIT() NAMED_UNIT(#{fresh + 2}) "
            "SI_UNIT($,.METRE.) );\n"
            f"#{fresh + 2} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);",
        )
    if kind == "unitless":
        return text.replace(
            match.group(0),
            f"{length_id} = ( NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );",
        )
    raise AssertionError(f"unknown STEP variant {kind!r}")


def _tess_bbox_dx(result: dict) -> float:
    tess = json.loads(Path(result["tessPath"]).read_text(encoding="utf-8"))
    box = tess["boundingBox"]
    return box["max"][0] - box["min"][0]


def test_file_unit_detection_real_step(tmp_path: Path) -> None:
    _requires_cad()
    text = _write_mm_box_step(tmp_path / "box.step")
    assert geometry_service._detect_step_file_unit(tmp_path / "box.step") == ("mm", 1.0)
    for kind, expected in [("cm", ("cm", 10.0)), ("m", ("m", 1000.0)), ("inch", ("inch", 25.4))]:
        probe = tmp_path / f"box_{kind}.step"
        probe.write_text(_craft_step_variant(text, kind), encoding="utf-8")
        assert geometry_service._detect_step_file_unit(probe) == expected
    unitless = tmp_path / "box_unitless.step"
    unitless.write_text(_craft_step_variant(text, "unitless"), encoding="utf-8")
    assert geometry_service._detect_step_file_unit(unitless) == (None, None)


def test_import_step_adopts_file_unit_when_unset(tmp_path: Path) -> None:
    _requires_cad()
    text = _write_mm_box_step(tmp_path / "box.step")
    probe = tmp_path / "box_inch.step"
    probe.write_text(_craft_step_variant(text, "inch"), encoding="utf-8")
    result = geometry_service.import_step_file(str(probe), output_dir=str(tmp_path / "out"))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["fileUnit"] == "inch"
    assert result["targetUnits"] == "inch"
    assert result["unitScaleFactor"] == 1.0
    assert "adopted" in result["unitsMessage"]
    # Raw file numbers preserved: a 10-inch box stays 10 units, not 254 mm.
    assert _tess_bbox_dx(result) == pytest.approx(10.0, rel=1e-6)


def test_import_step_scaled_on_mismatch_exact_factor(tmp_path: Path) -> None:
    _requires_cad()
    text = _write_mm_box_step(tmp_path / "box.step")

    probe = tmp_path / "box_inch.step"
    probe.write_text(_craft_step_variant(text, "inch"), encoding="utf-8")
    result = geometry_service.import_step_file(
        str(probe), output_dir=str(tmp_path / "out_inch"), target_units="mm"
    )
    assert result["success"] is True, result.get("error", "")
    assert result["unitScaleFactor"] == 25.4
    assert "×25.4" in result["unitsMessage"]
    assert _tess_bbox_dx(result) == pytest.approx(254.0, rel=1e-6)

    result_cm = geometry_service.import_step_file(
        str(tmp_path / "box.step"), output_dir=str(tmp_path / "out_cm"), target_units="cm"
    )
    assert result_cm["success"] is True, result_cm.get("error", "")
    assert result_cm["fileUnit"] == "mm"
    assert result_cm["unitScaleFactor"] == 0.1
    assert "×0.1" in result_cm["unitsMessage"]
    assert _tess_bbox_dx(result_cm) == pytest.approx(1.0, rel=1e-6)


def test_import_step_unitless_passthrough_no_scaling(tmp_path: Path, monkeypatch) -> None:
    _requires_cad()
    text = _write_mm_box_step(tmp_path / "box.step")
    probe = tmp_path / "box_unitless.step"
    probe.write_text(_craft_step_variant(text, "unitless"), encoding="utf-8")

    scaled_calls: list = []
    real_scale = geometry_service._scale_shape_uniform
    monkeypatch.setattr(
        geometry_service,
        "_scale_shape_uniform",
        lambda shape, factor: scaled_calls.append(factor) or real_scale(shape, factor),
    )
    first = geometry_service.import_step_file(str(probe), output_dir=str(tmp_path / "out1"))
    second = geometry_service.import_step_file(str(probe), output_dir=str(tmp_path / "out2"))
    assert first["success"] is True and second["success"] is True
    assert scaled_calls == []
    assert first["fileUnit"] is None
    assert first["targetUnits"] is None
    assert first["unitScaleFactor"] == 1.0
    assert first["unitsMessage"] is None
    assert _tess_bbox_dx(first) == pytest.approx(10.0, rel=1e-6)
    # Same legacy behavior across runs (tessellation floats are not
    # bit-stable run to run, so structural equality is the guard here).
    assert second["solidCount"] == first["solidCount"]
    assert second["faceCount"] == first["faceCount"]
    assert second["triangleCount"] == first["triangleCount"]
    assert _tess_bbox_dx(second) == pytest.approx(_tess_bbox_dx(first), rel=1e-9)


def _rewrite_iges_units(src: str, name: str, flag: int) -> str:
    """Re-emit an IGES global section with new units (re-chunked, column-safe)."""
    lines = src.splitlines()
    section = "".join(line[:72].rstrip() for line in lines if line[72:73] == "G")
    params = geometry_service._split_iges_global_params(section)
    assert len(params) >= 15
    params[13], params[14] = str(flag), f"{len(name)}H{name}"
    body = ",".join(params[:-1]) + ";"
    chunks = [body[i : i + 72] for i in range(0, len(body), 72)]
    seq0 = next(i for i, line in enumerate(lines) if line[72:73] == "G")
    new_g = [f"{chunk:<72}G{seq0 + 1 + k:7d}" for k, chunk in enumerate(chunks)]
    rest = [line for line in lines if line[72:73] != "G"]
    return "\n".join(new_g + rest) + "\n"


def test_import_iges_unit_scaling_end_to_end(tmp_path: Path) -> None:
    _requires_cad()
    bd = _requires_cad()
    iges_path = tmp_path / "box.iges"
    geometry_service._write_iges(bd.Box(10, 10, 10).wrapped, iges_path)
    src = iges_path.read_text(encoding="utf-8")

    assert geometry_service._detect_iges_file_unit(iges_path) == ("mm", 1.0)

    inch_path = tmp_path / "box_inch.iges"
    inch_path.write_text(_rewrite_iges_units(src, "INCH", 1), encoding="utf-8")
    assert geometry_service._detect_iges_file_unit(inch_path) == ("inch", 25.4)

    adopted = geometry_service.import_iges_file(str(inch_path), output_dir=str(tmp_path / "a"))
    assert adopted["success"] is True, adopted.get("error", "")
    assert adopted["fileUnit"] == "inch"
    assert adopted["targetUnits"] == "inch"
    assert adopted["unitScaleFactor"] == 1.0
    assert _tess_bbox_dx(adopted) == pytest.approx(10.0, rel=1e-6)

    scaled = geometry_service.import_iges_file(
        str(inch_path), output_dir=str(tmp_path / "s"), target_units="mm"
    )
    assert scaled["success"] is True, scaled.get("error", "")
    assert scaled["unitScaleFactor"] == 25.4
    assert "×25.4" in scaled["unitsMessage"]
    assert _tess_bbox_dx(scaled) == pytest.approx(254.0, rel=1e-6)


def test_step_import_scale_message_lists_factor_not_just_units(tmp_path: Path) -> None:
    """The import message must carry the numeric factor (unit-scaling contract)."""
    _requires_cad()
    text = _write_mm_box_step(tmp_path / "box.step")
    probe = tmp_path / "box_cm.step"
    probe.write_text(_craft_step_variant(text, "cm"), encoding="utf-8")
    result = geometry_service.import_step_file(
        str(probe), output_dir=str(tmp_path / "out"), target_units="m"
    )
    assert result["success"] is True, result.get("error", "")
    assert result["unitScaleFactor"] == pytest.approx(0.01)
    assert "×0.01" in result["unitsMessage"]
    assert "'cm'" in result["unitsMessage"] and "'m'" in result["unitsMessage"]


def test_ocp_step_length_names_returns_none_without_ocp(monkeypatch) -> None:
    """Forced-absence guard: detection degrades to unitless when OCP is missing."""
    monkeypatch.setitem(sys.modules, "OCP.STEPControl", None)
    monkeypatch.setitem(sys.modules, "OCP.TColStd", None)
    assert geometry_service._ocp_step_length_names(Path("x.step")) is None
    assert geometry_service._detect_step_file_unit(Path("x.step")) == (None, None)
