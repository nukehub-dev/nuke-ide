#!/usr/bin/env python3
"""Imported-body (`import`) feature: exchange reader, builder, and inspection.

Minimal-profile tests cover the pure contracts (validation, unit policy,
signature selection, path resolution, structural validation, cache-key
invalidation) and run with pytest + numpy only. Full-profile tests write tiny
STEP fixtures with the production writer and exercise the real OCP reader,
document builds, patterns over imported bodies, assembly sub-documents, and
the ``--inspect-import`` CLI. All heavy imports live inside the tests (or are
guarded with ``pytest.importorskip``) so the minimal profile skips cleanly.
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

import ast
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import exchange_reader as er
import feature_builder as fb
import geometry_service
import pytest

_PYTHON_DIR = Path(__file__).resolve().parent.parent.parent / "python"


def _requires_cad() -> Any:
    """Skip unless build123d (and therefore OCP) is installed."""
    return pytest.importorskip("build123d", reason="build123d not installed")


# ---------------------------------------------------------------------------
# Pure helpers: fake source and tiny documents.
# ---------------------------------------------------------------------------

_HASH_A = "a" * 64
_HASH_B = "b" * 64


def _info(
    index: int, face_count: int, volume: float, name: str | None = None
) -> er.ImportSolidInfo:
    return er.ImportSolidInfo(
        index=index,
        face_count=face_count,
        volume=volume,
        bbox_min=(0.0, 0.0, 0.0),
        bbox_max=(1.0, 1.0, 1.0),
        center=(0.5, 0.5, 0.5),
        name=name,
    )


def _fake_source(infos: list[er.ImportSolidInfo]) -> er.ImportSource:
    return er.ImportSource(
        path=Path("/tmp/source.step"),
        digest=_HASH_A,
        size=12,
        format="step",
        file_unit="mm",
        effective_unit="mm",
        unit_scale=1.0,
        units_message=None,
        shape=object(),
        solids=[f"solid-{info.index}" for info in infos],
        info=infos,
    )


def _import_params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "sourcePath": "./doc.parts/source.step",
        "sourceHash": _HASH_A,
        "sourceSize": 12,
        "selection": {"mode": "all"},
    }
    params.update(overrides)
    return params


def _import_document(
    features: list[dict[str, Any]],
    bodies: list[str],
    *,
    units: str | None = "mm",
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "version": 3,
        "name": "import-doc",
        "datums": [],
        "bodies": [{"id": body, "name": body, "label": body} for body in bodies],
        "sketches": [],
        "curves": [],
        "features": features,
    }
    if units is not None:
        document["units"] = units
    return document


def _import_feature(
    fid: str,
    body: str,
    params: dict[str, Any],
    *,
    depends_on: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": fid,
        "name": fid,
        "type": "import",
        "body": body,
        "params": params,
        "dependsOn": depends_on or [],
        "suppressed": False,
    }


# ---------------------------------------------------------------------------
# Minimal profile: module isolation, units, validation, selection.
# ---------------------------------------------------------------------------


def test_exchange_reader_does_not_import_geometry_modules() -> None:
    """The reader stays standalone (no geometry_service/feature_builder imports)."""
    tree = ast.parse((_PYTHON_DIR / "exchange_reader.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "geometry_service" not in imported
    assert "feature_builder" not in imported


@pytest.mark.parametrize(
    ("file_unit", "file_mm", "source_unit", "target_unit", "expected"),
    [
        (None, None, None, None, (None, 1.0)),
        ("mm", 1.0, None, None, ("mm", 1.0)),
        ("inch", 25.4, None, "mm", ("mm", 25.4)),
        ("mm", 1.0, None, "cm", ("cm", 0.1)),
        ("m", 1000.0, None, "mm", ("mm", 1000.0)),
        ("cm", 10.0, None, "cm", ("cm", 1.0)),
        ("mm", 1.0, "m", None, ("m", 1.0)),
        ("mm", 1.0, "m", "m", ("m", 1.0)),
        ("mm", 1.0, "m", "mm", ("mm", 1000.0)),
        ("cm", 10.0, "m", "cm", ("cm", 100.0)),
        (None, None, "mm", "cm", ("cm", 0.1)),
        (None, None, None, "mm", ("mm", 1.0)),
    ],
)
def test_resolve_import_source_units(
    file_unit: str | None,
    file_mm: float | None,
    source_unit: str | None,
    target_unit: str | None,
    expected: tuple[str | None, float],
) -> None:
    effective, scale, message = er.resolve_import_source_units(
        file_unit, file_mm, source_unit, target_unit, "STEP"
    )
    assert effective == expected[0]
    assert scale == pytest.approx(expected[1])
    if expected[0] is None:
        assert message is None
    else:
        assert isinstance(message, str) and message


def test_resolve_import_source_units_messages_are_informative() -> None:
    _, _, adopted = er.resolve_import_source_units("mm", 1.0, None, None, "STEP")
    assert adopted is not None and "adopted" in adopted
    _, _, overridden = er.resolve_import_source_units("mm", 1.0, "m", None, "STEP")
    assert overridden is not None and "overridden" in overridden
    _, _, unknown = er.resolve_import_source_units(None, None, None, "mm", "STEP")
    assert unknown is not None and "unknown" in unknown and "no scaling" in unknown


def test_resolve_import_source_units_rejects_unknown_units() -> None:
    with pytest.raises(ValueError, match="Unknown source unit"):
        er.resolve_import_source_units(None, None, "furlong", None)
    with pytest.raises(ValueError, match="Unknown target units"):
        er.resolve_import_source_units(None, None, None, "furlong")


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("a.step", "step"),
        ("a.STEP", "step"),
        ("a.stp", "step"),
        ("a.iges", "iges"),
        ("a.igs", "iges"),
        ("a.brep", "brep"),
        ("a.sldprt", None),
        ("a", None),
    ],
)
def test_source_format_for_path(name: str, expected: str | None) -> None:
    assert er.source_format_for_path(Path(name)) == expected


def test_validate_import_params_accepts_minimal_and_full_params() -> None:
    assert er.validate_import_params(_import_params()) is None
    full = _import_params(
        sourceFormat="step",
        sourceUnit="m",
        selection={
            "mode": "solids",
            "solids": [
                {"index": 1, "signature": {"faceCount": 6, "volume": 1000.0}},
                {"index": 2},
            ],
        },
        placement={"translate": [1.0, 2.0, 3.0], "rotateDegrees": [0.0, 0.0, 90.0]},
        maxSolids=50,
    )
    assert er.validate_import_params(full) is None


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"sourcePath": ""}, "sourcePath"),
        ({"sourcePath": 42}, "sourcePath"),
        ({"sourceHash": "abc"}, "sourceHash"),
        ({"sourceHash": "A" * 64}, "sourceHash"),
        ({"sourceSize": 0}, "sourceSize"),
        ({"sourceSize": True}, "sourceSize"),
        ({"sourceFormat": "obj"}, "sourceFormat"),
        ({"sourceUnit": "inch"}, "sourceUnit"),
        ({"selection": {"mode": "some"}}, "selection mode"),
        ({"selection": {"mode": "solids"}}, "non-empty"),
        ({"selection": {"mode": "solids", "solids": []}}, "non-empty"),
        ({"selection": {"mode": "solids", "solids": [{"index": 0}]}}, "positive integer"),
        (
            {
                "selection": {
                    "mode": "solids",
                    "solids": [{"index": 1}, {"index": 1}],
                }
            },
            "duplicate",
        ),
        (
            {
                "selection": {
                    "mode": "solids",
                    "solids": [{"index": 1, "signature": {"faceCount": 0, "volume": 1.0}}],
                }
            },
            "faceCount",
        ),
        (
            {
                "selection": {
                    "mode": "solids",
                    "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": "x"}}],
                }
            },
            "volume",
        ),
        ({"placement": {"translate": [0.0, 0.0]}}, "placement.translate"),
        ({"placement": {"rotateDegrees": [0.0, 0.0, float("inf")]}}, "rotateDegrees"),
        ({"maxSolids": 0}, "maxSolids"),
    ],
)
def test_validate_import_params_rejects_malformed(overrides: dict, match: str) -> None:
    error = er.validate_import_params(_import_params(**overrides))
    assert error is not None and match in error


def test_validate_import_params_rejects_non_object() -> None:
    assert er.validate_import_params(None) == "params must be an object"
    assert er.validate_import_params([]) == "params must be an object"


def test_select_solids_all_and_by_index() -> None:
    source = _fake_source([_info(1, 6, 1000.0), _info(2, 6, 2000.0)])
    assert er.select_solids(source, {"mode": "all"}) == ["solid-1", "solid-2"]
    assert er.select_solids(
        source,
        {
            "mode": "solids",
            "solids": [{"index": 2, "signature": {"faceCount": 6, "volume": 2000.0}}],
        },
    ) == ["solid-2"]


def test_select_solids_signature_repairs_to_unique_match() -> None:
    source = _fake_source([_info(1, 6, 1000.0), _info(2, 6, 4000.0), _info(3, 6, 9000.0)])
    # Index 1 now has solid 2's signature: unique repair lands on solid 2.
    selected = er.select_solids(
        source,
        {
            "mode": "solids",
            "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": 4000.0}}],
        },
    )
    assert selected == ["solid-2"]


def test_select_solids_signature_mismatch_without_match_raises() -> None:
    source = _fake_source([_info(1, 6, 1000.0), _info(2, 6, 2000.0)])
    with pytest.raises(er.ExchangeReadError, match="no longer matches its signature"):
        er.select_solids(
            source,
            {
                "mode": "solids",
                "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": 12345.0}}],
            },
        )


def test_select_solids_ambiguous_repair_raises() -> None:
    source = _fake_source([_info(1, 6, 1000.0), _info(2, 6, 2000.0), _info(3, 6, 2000.0)])
    with pytest.raises(er.ExchangeReadError, match="ambiguous"):
        er.select_solids(
            source,
            {
                "mode": "solids",
                "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": 2000.0}}],
            },
        )


def test_select_solids_out_of_range_and_duplicate_resolution() -> None:
    source = _fake_source([_info(1, 6, 1000.0), _info(2, 6, 2000.0)])
    with pytest.raises(er.ExchangeReadError, match="out of range"):
        er.select_solids(source, {"mode": "solids", "solids": [{"index": 3}]})
    with pytest.raises(er.ExchangeReadError, match="more than once"):
        er.select_solids(
            source,
            {
                "mode": "solids",
                "solids": [
                    {"index": 1, "signature": {"faceCount": 6, "volume": 2000.0}},
                    {"index": 2},
                ],
            },
        )


def test_resolve_import_source_path_relative_and_absolute(tmp_path: Path) -> None:
    relative = fb._resolve_import_source_path("./parts/a.step", tmp_path)
    assert relative == (tmp_path / "parts" / "a.step").resolve()
    absolute = (tmp_path / "b.step").resolve()
    assert fb._resolve_import_source_path(str(absolute), None) == absolute


def test_is_solid_producer_includes_import() -> None:
    assert fb._is_solid_producer("import") is True
    assert fb._is_sketch_based_solid("import") is False
    assert (
        fb._solid_feature_is_subtractive({"type": "import", "params": {"subtractive": True}})
        is False
    )


def test_validate_document_refs_accepts_valid_import_document() -> None:
    doc = _import_document([_import_feature("i1", "b1", _import_params())], ["b1"])
    assert geometry_service._validate_document_refs(doc, Path("doc.nuke-cad")) is None


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"sourcePath": ""}, "sourcePath"),
        ({"sourceHash": "not-a-hash"}, "sourceHash"),
        ({"selection": {"mode": "solids"}}, "non-empty"),
        ({"maxSolids": -1}, "maxSolids"),
        ({"placement": {"translate": [0.0, 0.0]}}, "translate"),
    ],
)
def test_validate_document_refs_rejects_malformed_import(overrides: dict, match: str) -> None:
    doc = _import_document([_import_feature("i1", "b1", _import_params(**overrides))], ["b1"])
    error = geometry_service._validate_document_refs(doc, Path("doc.nuke-cad"))
    assert error is not None
    assert error["success"] is False
    assert match in error["error"]


def test_inspect_import_missing_source_reports_error(tmp_path: Path) -> None:
    result = geometry_service.inspect_import_source(str(tmp_path / "missing.step"))
    assert result["success"] is False
    assert "not found" in result["error"].lower()


def test_doc_cache_keys_invalidate_on_source_hash_change() -> None:
    import doc_cache

    doc = _import_document(
        [
            _import_feature("i1", "b1", _import_params()),
            {
                "id": "p1",
                "name": "p1",
                "type": "linearPattern",
                "body": "b1",
                "params": {"source": "i1", "count": 2, "spacing": 30.0, "axis": "x"},
                "dependsOn": ["i1"],
                "suppressed": False,
            },
        ],
        ["b1"],
    )
    first = doc_cache.compute_document_keys(doc)
    edited = json.loads(json.dumps(doc))
    edited["features"][0]["params"]["sourceHash"] = _HASH_B
    second = doc_cache.compute_document_keys(edited)
    assert first["i1"] != second["i1"]
    assert first["p1"] != second["p1"]


# ---------------------------------------------------------------------------
# Full profile: tiny STEP fixtures and real builds.
# ---------------------------------------------------------------------------


def _write_two_box_step(path: Path, *, names: bool = True) -> tuple[str, int]:
    """Write a two-box STEP (10 mm cubes at x=0 and x=20) and return hash/size."""
    bd = _requires_cad()
    path.parent.mkdir(parents=True, exist_ok=True)
    first = bd.Box(10, 10, 10)
    second = bd.Box(10, 10, 10).moved(bd.Location((20, 0, 0)))
    compound = bd.Compound(children=[first, second])
    geometry_service._write_step(
        compound.wrapped,
        path,
        solid_names=["box_a", "box_b"] if names else None,
    )
    return er.compute_source_hash(path)


def _write_mixed_box_step(path: Path) -> tuple[str, int]:
    """Write a 10 mm cube plus a 4 mm cube (distinct signatures)."""
    bd = _requires_cad()
    path.parent.mkdir(parents=True, exist_ok=True)
    first = bd.Box(10, 10, 10)
    second = bd.Box(4, 4, 4).moved(bd.Location((20, 0, 0)))
    compound = bd.Compound(children=[first, second])
    geometry_service._write_step(compound.wrapped, path, solid_names=["big", "small"])
    return er.compute_source_hash(path)


def test_read_import_source_enumerates_solids(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)
    source = er.read_import_source(step)
    assert source.format == "step"
    assert source.file_unit == "mm"
    assert source.effective_unit == "mm"
    assert source.unit_scale == 1.0
    assert source.digest == digest and source.size == size == step.stat().st_size
    assert source.solid_count == 2
    assert [info.index for info in source.info] == [1, 2]
    assert [info.name for info in source.info] == ["box_a", "box_b"]
    assert all(info.face_count == 6 for info in source.info)
    assert source.info[0].volume == pytest.approx(1000.0, rel=1e-9)
    assert source.info[0].bbox_min == pytest.approx((-5.0, -5.0, -5.0), abs=1e-6)
    assert source.info[0].bbox_max == pytest.approx((5.0, 5.0, 5.0), abs=1e-6)
    assert source.info[1].center[0] == pytest.approx(20.0, abs=1e-6)
    payload = source.to_dict()
    assert payload["solidCount"] == 2
    assert payload["solids"][0]["faceCount"] == 6
    assert set(payload["solids"][0]) >= {
        "index",
        "faceCount",
        "volume",
        "bboxMin",
        "bboxMax",
        "center",
    }


def test_read_import_source_iges_and_brep(tmp_path: Path) -> None:
    bd = _requires_cad()
    symmetric = bd.Box(10, 10, 10).wrapped
    iges = tmp_path / "box.iges"
    brep = tmp_path / "box.brep"
    geometry_service._write_iges(symmetric, iges, solid_names=["box"])
    geometry_service._write_brep(symmetric, brep)

    iges_source = er.read_import_source(iges)
    assert iges_source.format == "iges"
    assert iges_source.file_unit == "mm"
    assert iges_source.solid_count == 1
    assert iges_source.info[0].volume == pytest.approx(1000.0, rel=1e-6)
    assert iges_source.info[0].name == "box"

    brep_source = er.read_import_source(brep)
    assert brep_source.format == "brep"
    assert brep_source.file_unit is None
    assert brep_source.effective_unit is None
    assert brep_source.unit_scale == 1.0
    assert brep_source.info[0].volume == pytest.approx(1000.0, rel=1e-6)

    scaled = er.read_import_source(brep, source_unit="cm", target_unit="mm")
    assert scaled.unit_scale == pytest.approx(10.0)
    assert scaled.info[0].volume == pytest.approx(1.0e6, rel=1e-6)


def test_read_import_source_unit_override_and_scaling(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_two_box_step(step)

    overridden = er.read_import_source(step, source_unit="m", target_unit="m")
    assert (overridden.file_unit, overridden.effective_unit) == ("mm", "m")
    assert overridden.unit_scale == 1.0
    assert overridden.info[0].volume == pytest.approx(1000.0, rel=1e-9)

    to_mm = er.read_import_source(step, source_unit="m", target_unit="mm")
    assert to_mm.unit_scale == 1000.0
    # Numbers treated as metres, then reported in mm: volume scales by 1000³.
    assert to_mm.info[0].volume == pytest.approx(1.0e12, rel=1e-6)

    to_cm = er.read_import_source(step, target_unit="cm")
    assert to_cm.unit_scale == pytest.approx(0.1)
    assert to_cm.effective_unit == "cm"
    assert to_cm.info[0].volume == pytest.approx(1.0, rel=1e-6)
    assert to_cm.info[0].bbox_max == pytest.approx((0.5, 0.5, 0.5), abs=1e-6)


def test_read_import_source_max_solids_cap(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_two_box_step(step)
    with pytest.raises(er.ExchangeReadError, match="maxSolids cap"):
        er.read_import_source(step, max_solids=1)


def _built_doc(
    features: list[dict[str, Any]],
    bodies: list[str],
    *,
    units: str = "mm",
) -> dict[str, Any]:
    return _import_document(features, bodies, units=units)


def test_build_import_all_selects_compound_single_body(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)
    doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(sourcePath=str(step), sourceHash=digest, sourceSize=size),
            )
        ],
        ["b1"],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 2
    assert result["selectorMap"] == {"b1": [1, 2]}
    assert result["shape"].volume == pytest.approx(2000.0, rel=1e-9)
    assert result["featureResults"][0]["status"] == "built"


def test_build_import_per_solid_selects_two_bodies(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)

    def feature(fid: str, body: str, index: int) -> dict[str, Any]:
        return _import_feature(
            fid,
            body,
            _import_params(
                sourcePath=str(step),
                sourceHash=digest,
                sourceSize=size,
                selection={
                    "mode": "solids",
                    "solids": [{"index": index, "signature": {"faceCount": 6, "volume": 1000.0}}],
                },
            ),
        )

    doc = _built_doc([feature("i1", "b1", 1), feature("i2", "b2", 2)], ["b1", "b2"])
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 2
    assert result["selectorMap"] == {"b1": [1], "b2": [2]}
    assert result["shape"].volume == pytest.approx(2000.0, rel=1e-9)


def test_build_import_signature_repair_and_mismatch(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "mixed.step"
    digest, size = _write_mixed_box_step(step)
    # Signature of the 4 mm box (volume 64) with the wrong index repairs uniquely.
    repaired = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(
                    sourcePath=str(step),
                    sourceHash=digest,
                    sourceSize=size,
                    selection={
                        "mode": "solids",
                        "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": 64.0}}],
                    },
                ),
            )
        ],
        ["b1"],
    )
    result = fb.build_document_shape(repaired)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(64.0, rel=1e-6)

    mismatched = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(
                    sourcePath=str(step),
                    sourceHash=digest,
                    sourceSize=size,
                    selection={
                        "mode": "solids",
                        "solids": [{"index": 1, "signature": {"faceCount": 6, "volume": 12345.0}}],
                    },
                ),
            )
        ],
        ["b1"],
    )
    failed = fb.build_document_shape(mismatched)
    assert failed["shape"] is None
    record = failed["featureResults"][0]
    assert record["status"] == "failed"
    assert "no longer matches its signature" in record["error"]


def test_build_import_hash_mismatch_fails_feature(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_two_box_step(step)
    doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(sourcePath=str(step), sourceHash=_HASH_B),
            )
        ],
        ["b1"],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is None
    record = result["featureResults"][0]
    assert record["status"] == "failed"
    assert "source hash mismatch" in record["error"]


def test_build_import_relative_source_resolves_via_document_dir(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "doc.parts" / "two.step"
    digest, size = _write_two_box_step(step)
    doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(
                    sourcePath="./doc.parts/two.step", sourceHash=digest, sourceSize=size
                ),
            )
        ],
        ["b1"],
    )
    relative = fb.build_document_shape(doc, document_dir=tmp_path)
    assert relative["shape"] is not None
    assert len(relative["shape"].solids()) == 2
    absolute = fb.build_document_shape(
        _built_doc(
            [
                _import_feature(
                    "i1",
                    "b1",
                    _import_params(sourcePath=str(step), sourceHash=digest, sourceSize=size),
                )
            ],
            ["b1"],
        )
    )
    assert absolute["shape"] is not None

    missing = fb.build_document_shape(
        _built_doc(
            [
                _import_feature(
                    "i1",
                    "b1",
                    _import_params(sourcePath="./doc.parts/missing.step", sourceHash=digest),
                )
            ],
            ["b1"],
        ),
        document_dir=tmp_path,
    )
    assert missing["featureResults"][0]["status"] == "failed"
    assert "import source not found" in missing["featureResults"][0]["error"]


def test_build_import_reads_one_shared_source(tmp_path: Path, monkeypatch) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)
    doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(sourcePath=str(step), sourceHash=digest, sourceSize=size),
            ),
            _import_feature(
                "i2",
                "b2",
                _import_params(sourcePath=str(step), sourceHash=digest, sourceSize=size),
            ),
        ],
        ["b1", "b2"],
    )
    calls: list[Path] = []
    original = er.read_import_source

    def counted(path, **kwargs):
        calls.append(Path(path))
        return original(path, **kwargs)

    monkeypatch.setattr(er, "read_import_source", counted)
    result = fb.build_document_shape(doc)
    assert [record["status"] for record in result["featureResults"]] == ["built", "built"]
    assert len(calls) == 1


def test_build_import_placement_rotation_then_translation(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)
    doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(
                    sourcePath=str(step),
                    sourceHash=digest,
                    sourceSize=size,
                    selection={"mode": "solids", "solids": [{"index": 2}]},
                    placement={
                        "rotateDegrees": [0.0, 0.0, 90.0],
                        "translate": [5.0, 0.0, 0.0],
                    },
                ),
            )
        ],
        ["b1"],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    bbox = result["shape"].bounding_box()
    # Source box spans x [15, 25], y [-5, 5]; 90° about Z swaps the extents,
    # then +5 mm X moves it to x [0, 10], y [15, 25].
    assert (bbox.min.X, bbox.min.Y) == pytest.approx((0.0, 15.0), abs=1e-6)
    assert (bbox.max.X, bbox.max.Y) == pytest.approx((10.0, 25.0), abs=1e-6)


def test_build_pattern_over_import_additive_and_count_one_noop(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)

    def doc(count: int) -> dict[str, Any]:
        return _built_doc(
            [
                _import_feature(
                    "i1",
                    "b1",
                    _import_params(
                        sourcePath=str(step),
                        sourceHash=digest,
                        sourceSize=size,
                        selection={"mode": "solids", "solids": [{"index": 2}]},
                    ),
                ),
                {
                    "id": "p1",
                    "name": "p1",
                    "type": "circularPattern",
                    "body": "b1",
                    "params": {"source": "i1", "count": count, "angle": 360, "axis": "z"},
                    "dependsOn": ["i1"],
                    "suppressed": False,
                },
            ],
            ["b1"],
        )

    four = fb.build_document_shape(doc(4))
    assert four["shape"] is not None
    assert len(four["shape"].solids()) == 4
    assert four["shape"].volume == pytest.approx(4000.0, rel=1e-9)
    assert four["featureResults"][-1]["status"] == "built"

    one = fb.build_document_shape(doc(1))
    assert one["shape"] is not None
    assert len(one["shape"].solids()) == 1
    assert one["shape"].volume == pytest.approx(1000.0, rel=1e-9)


def test_build_document_threads_document_dir(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "doc.parts" / "two.step"
    digest, size = _write_two_box_step(step)
    doc_path = tmp_path / "doc.nuke-cad"
    doc_path.write_text(
        json.dumps(
            _built_doc(
                [
                    _import_feature(
                        "i1",
                        "b1",
                        _import_params(
                            sourcePath="./doc.parts/two.step",
                            sourceHash=digest,
                            sourceSize=size,
                        ),
                    )
                ],
                ["b1"],
            )
        ),
        encoding="utf-8",
    )
    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path / "out"),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error")
    assert result["solidCount"] == 2
    assert result["featureResults"][0]["status"] == "built"


def test_build_document_partial_restores_import_from_cache(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "doc.parts" / "two.step"
    digest, size = _write_two_box_step(step)
    doc_path = tmp_path / "doc.nuke-cad"
    doc_path.write_text(
        json.dumps(
            _built_doc(
                [
                    _import_feature(
                        "i1",
                        "b1",
                        _import_params(
                            sourcePath="./doc.parts/two.step",
                            sourceHash=digest,
                            sourceSize=size,
                        ),
                    )
                ],
                ["b1"],
            )
        ),
        encoding="utf-8",
    )
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    first = geometry_service.build_document_partial(
        str(doc_path),
        ["i1"],
        cache_dir=str(cache_dir),
        output_dir=str(tmp_path / "out1"),
        export_dagmc=False,
        export_mesh=False,
    )
    assert first["success"] is True, first.get("error")
    assert first["solidCount"] == 2

    cached = geometry_service.build_document_partial(
        str(doc_path),
        [],
        cache_dir=str(cache_dir),
        output_dir=str(tmp_path / "out2"),
        export_dagmc=False,
        export_mesh=False,
    )
    assert cached["success"] is True, cached.get("error")
    assert cached["solidCount"] == 2
    assert cached["featureResults"][0]["status"] == "cached"


def test_build_assembly_subdocument_import_relative_source(tmp_path: Path) -> None:
    _requires_cad()
    import assembly_builder as ab

    parts_dir = tmp_path / "parts"
    step = parts_dir / "part.parts" / "two.step"
    digest, size = _write_two_box_step(step)
    sub_doc = _built_doc(
        [
            _import_feature(
                "i1",
                "b1",
                _import_params(
                    sourcePath="./part.parts/two.step", sourceHash=digest, sourceSize=size
                ),
            )
        ],
        ["b1"],
    )
    (parts_dir / "part.nuke-cad").write_text(json.dumps(sub_doc), encoding="utf-8")

    parent = {
        "version": 3,
        "name": "assembly",
        "units": "mm",
        "datums": [],
        "bodies": [],
        "sketches": [],
        "curves": [],
        "features": [],
        "assembly": {
            "instances": [
                {
                    "id": "inst-1",
                    "part": "parts/part.nuke-cad",
                    "placement": {"position": [0.0, 0.0, 0.0], "orientation": [0.0, 0.0, 0.0, 1.0]},
                }
            ],
            "connectors": [],
            "mates": [],
            "groundedInstanceId": "inst-1",
        },
    }
    result = ab.build_assembly_shape(parent, document_dir=tmp_path)
    assert result["shape"] is not None
    assert len(geometry_service._solids_in_explorer_order(result["shape"])) == 2


def _inspect_cli(step: Path, *extra: str, expect_success: bool = True) -> dict[str, Any]:
    completed = subprocess.run(
        [
            sys.executable,
            str(_PYTHON_DIR / "geometry_service.py"),
            str(step),
            "--inspect-import",
            *extra,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    expected_code = 0 if expect_success else 1
    assert completed.returncode == expected_code, completed.stderr + completed.stdout
    for line in reversed(completed.stdout.splitlines()):
        if line.startswith(geometry_service.RESULT_MARKER):
            return json.loads(line[len(geometry_service.RESULT_MARKER) :])
    raise AssertionError(f"no result marker in stdout: {completed.stdout!r}")


def test_inspect_import_cli_reports_solids_and_writes_nothing(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    digest, size = _write_two_box_step(step)
    before = {entry.name for entry in tmp_path.iterdir()}

    result = _inspect_cli(step)

    after = {entry.name for entry in tmp_path.iterdir()}
    assert after == before
    assert result["success"] is True
    assert result["sourceFormat"] == "step"
    assert result["sourceHash"] == digest
    assert result["sourceSize"] == size
    assert result["fileUnit"] == "mm"
    assert result["effectiveUnit"] == "mm"
    assert result["unitScaleFactor"] == 1.0
    assert result["solidCount"] == 2
    solids = result["solids"]
    assert [solid["index"] for solid in solids] == [1, 2]
    assert [solid["name"] for solid in solids] == ["box_a", "box_b"]
    assert all(solid["faceCount"] == 6 for solid in solids)
    assert solids[0]["volume"] == pytest.approx(1000.0, rel=1e-9)
    assert solids[0]["bboxMin"] == pytest.approx([-5.0, -5.0, -5.0], abs=1e-6)
    assert result["warnings"] == []


def test_inspect_import_cli_unit_override_and_cap(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_two_box_step(step)
    result = _inspect_cli(step, "--target-units", "cm")
    assert result["success"] is True
    assert result["effectiveUnit"] == "cm"
    assert result["unitScaleFactor"] == pytest.approx(0.1)
    assert result["solids"][0]["volume"] == pytest.approx(1.0, rel=1e-6)

    capped = _inspect_cli(step, "--max-solids", "1", expect_success=False)
    assert capped["success"] is False
    assert "maxSolids cap" in capped["error"]
