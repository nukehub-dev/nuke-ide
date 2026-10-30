"""Edge-case tests for the exchange reader: guards, unit fallbacks, OCP seams.

Complements ``test_import_feature.py`` / ``test_step_unit_scaling.py`` with the
error branches of the reader (validation messages, unreadable/malformed
sources, OCP-absent stubs), the less common unit-detection fallbacks, and the
best-effort product-name walk. Pure tests run in the minimal pytest profile;
OCP-bound tests import their fixtures lazily and skip cleanly without the CAD
toolchain. Module-level OCP failures are forced by monkeypatching (never by
assuming the ambient env lacks the dependency).
"""

import sys
from pathlib import Path
from typing import Any

import exchange_reader as er
import geometry_service
import pytest

HASH_A = "a" * 64


def _requires_cad() -> Any:
    """Skip unless build123d (and therefore OCP) is installed."""
    return pytest.importorskip("build123d", reason="build123d not installed")


def _import_params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "sourcePath": "./doc.parts/source.step",
        "sourceHash": HASH_A,
        "selection": {"mode": "all"},
    }
    params.update(overrides)
    return params


def _write_named_two_box_step(path: Path) -> None:
    """Write a two-box STEP with product names (10 mm cubes at x=0 and x=20)."""
    bd = _requires_cad()
    path.parent.mkdir(parents=True, exist_ok=True)
    first = bd.Box(10, 10, 10)
    second = bd.Box(10, 10, 10).moved(bd.Location((20, 0, 0)))
    geometry_service._write_step(
        bd.Compound(children=[first, second]).wrapped, path, solid_names=["box_a", "box_b"]
    )


def _write_box_iges(path: Path) -> None:
    bd = _requires_cad()
    geometry_service._write_iges(bd.Box(10, 10, 10).wrapped, path)


def _wrap_iges_global(body: str) -> str:
    """Chunk a global-section body into fixed-format G lines."""
    chunks = [body[i : i + 72] for i in range(0, len(body), 72)]
    return "\n".join(f"{chunk:<72}G{k + 1:7d}" for k, chunk in enumerate(chunks)) + "\n"


def _iges_units_text(units_flag: object, units_name: str) -> str:
    """Minimal IGES text with controllable global-section units params."""
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
        f"{len(units_name)}H{units_name}" if units_name else "0H",
        "1",
        "0.01",
        "20260101.000000",
        "1E-07",
        "5.",
        "5Hauth",
        "",
        "11",
        "0",
        "20260101.000000",
    ]
    return _wrap_iges_global(",".join(params) + ";")


def _fake_source(infos: list[er.ImportSolidInfo]) -> er.ImportSource:
    return er.ImportSource(
        path=Path("/tmp/source.step"),
        digest=HASH_A,
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


def _info(index: int, face_count: int = 6, volume: float = 1.0) -> er.ImportSolidInfo:
    return er.ImportSolidInfo(
        index=index,
        face_count=face_count,
        volume=volume,
        bbox_min=(0.0, 0.0, 0.0),
        bbox_max=(1.0, 1.0, 1.0),
        center=(0.5, 0.5, 0.5),
    )


# ---------------------------------------------------------------------------
# Validation messages reached only through malformed nested selections.
# ---------------------------------------------------------------------------


def test_selection_and_nested_pick_shapes_are_validated() -> None:
    assert er.validate_import_selection([]) == "selection must be an object"
    assert (
        er.validate_import_selection({"mode": "solids", "solids": ["solid"]})
        == "selection.solids[0] must be an object"
    )
    assert (
        er.validate_import_selection(
            {"mode": "solids", "solids": [{"index": 1, "signature": "fingerprint"}]}
        )
        == "selection.solids[0].signature must be an object when present"
    )


def test_import_params_require_selection_and_object_placement() -> None:
    missing = _import_params()
    del missing["selection"]
    assert er.validate_import_params(missing) == "selection is required"
    assert (
        er.validate_import_params(_import_params(placement="translate"))
        == "placement must be an object when present"
    )


def test_ocp_import_error_names_the_capability() -> None:
    error = er._ocp_import_error("STEP import", ImportError("no OCP module"))
    assert isinstance(error, er.ExchangeReadError)
    assert "STEP import requires OCP" in str(error)
    assert "no OCP module" in str(error)


# ---------------------------------------------------------------------------
# Unit detection fallbacks and pure helpers.
# ---------------------------------------------------------------------------


def test_detect_iges_non_integer_flag_falls_back_to_name(tmp_path: Path) -> None:
    probe = tmp_path / "auto.iges"
    probe.write_text(_iges_units_text("auto", "MM"), encoding="utf-8")
    assert er.detect_iges_file_unit(probe) == ("mm", 1.0)


def test_detect_iges_flag_three_uses_units_name(tmp_path: Path) -> None:
    probe = tmp_path / "inch.iges"
    probe.write_text(_iges_units_text(3, "INCH"), encoding="utf-8")
    assert er.detect_iges_file_unit(probe) == ("inch", 25.4)


def test_detect_iges_unknown_flag_blank_name_is_unitless(tmp_path: Path) -> None:
    probe = tmp_path / "blank.iges"
    probe.write_text(_iges_units_text(99, ""), encoding="utf-8")
    assert er.detect_iges_file_unit(probe) == (None, None)


def test_scale_shape_uniform_identity_returns_same_object() -> None:
    _requires_cad()
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    shape = bd.Box(1, 1, 1).wrapped
    assert er.scale_shape_uniform(shape, 1.0) is shape


def test_scale_shape_uniform_reports_transform_failure(monkeypatch: Any) -> None:
    _requires_cad()
    transform_module = pytest.importorskip("OCP.BRepBuilderAPI", reason="OCP not installed")

    class _FailedTransform:
        def __init__(self, *args: Any) -> None:
            pass

        def IsDone(self) -> bool:
            return False

    monkeypatch.setattr(transform_module, "BRepBuilderAPI_Transform", _FailedTransform)
    with pytest.raises(er.ExchangeReadError, match="Uniform scaling by 2 failed"):
        er.scale_shape_uniform(object(), 2.0)


def test_bounding_box_falls_back_without_optimal_api(monkeypatch: Any) -> None:
    """Older OCP builds lack AddOptimal; the compat helper still bounds a solid."""
    bd = _requires_cad()
    bnd_module = pytest.importorskip("OCP.BRepBndLib", reason="OCP not installed")
    solid = er._explorer_solids(bd.Box(10, 10, 10).wrapped)[0]
    monkeypatch.setattr(bnd_module.BRepBndLib, "AddOptimal_s", None)

    bbox_min, bbox_max = er._bounding_box(solid)
    assert bbox_min == pytest.approx((-5.0, -5.0, -5.0), abs=1e-4)
    assert bbox_max == pytest.approx((5.0, 5.0, 5.0), abs=1e-4)


# ---------------------------------------------------------------------------
# OCP-absent and malformed-source guards (forced absence, no ambient assumption).
# ---------------------------------------------------------------------------


def test_ocp_step_length_names_without_step_control(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.STEPControl", None)
    assert er.ocp_step_length_names(Path("x.step")) is None


def test_ocp_step_length_names_swallows_reader_exceptions(monkeypatch: Any) -> None:
    _requires_cad()
    step_control = pytest.importorskip("OCP.STEPControl", reason="OCP not installed")

    class _ExplodingReader:
        def __init__(self) -> None:
            raise RuntimeError("reader unavailable")

    monkeypatch.setattr(step_control, "STEPControl_Reader", _ExplodingReader)
    assert er.ocp_step_length_names(Path("x.step")) is None


def test_ocp_step_length_names_unreadable_file_returns_none(tmp_path: Path) -> None:
    _requires_cad()
    probe = tmp_path / "broken.step"
    probe.write_text("not a STEP file", encoding="utf-8")
    assert er.ocp_step_length_names(probe) is None


def test_read_step_shape_without_step_control(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.STEPControl", None)
    with pytest.raises(er.ExchangeReadError, match="STEP import requires OCP"):
        er.read_step_shape(Path("x.step"))


def test_read_step_shape_rejects_unreadable_file(tmp_path: Path) -> None:
    _requires_cad()
    probe = tmp_path / "broken.step"
    probe.write_text("not a STEP file", encoding="utf-8")
    with pytest.raises(er.ExchangeReadError, match="STEP reader returned status"):
        er.read_step_shape(probe)


def test_read_step_shape_rejects_empty_transfer(monkeypatch: Any) -> None:
    _requires_cad()
    step_control = pytest.importorskip("OCP.STEPControl", reason="OCP not installed")
    if_select = pytest.importorskip("OCP.IFSelect", reason="OCP not installed")

    class _EmptyReader:
        def ReadFile(self, path: str) -> Any:
            return if_select.IFSelect_RetDone

        def SetSystemLengthUnit(self, units: float) -> None:
            pass

        def TransferRoots(self) -> None:
            pass

        def OneShape(self) -> None:
            return None

    monkeypatch.setattr(step_control, "STEPControl_Reader", _EmptyReader)
    with pytest.raises(er.ExchangeReadError, match="No shape transferred"):
        er.read_step_shape(Path("x.step"))


def test_read_step_shape_rejects_an_occt_null_shape(monkeypatch: Any) -> None:
    _requires_cad()
    step_control = pytest.importorskip("OCP.STEPControl", reason="OCP not installed")
    if_select = pytest.importorskip("OCP.IFSelect", reason="OCP not installed")

    class _NullShape:
        def IsNull(self) -> bool:
            return True

    class _NullReader:
        def ReadFile(self, path: str) -> Any:
            return if_select.IFSelect_RetDone

        def SetSystemLengthUnit(self, units: float) -> None:
            pass

        def TransferRoots(self) -> None:
            pass

        def OneShape(self) -> Any:
            return _NullShape()

    monkeypatch.setattr(step_control, "STEPControl_Reader", _NullReader)
    with pytest.raises(er.ExchangeReadError, match="No shape transferred"):
        er.read_step_shape(Path("x.step"))


def test_sew_faces_without_ocp_names_iges(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.BRep", None)
    with pytest.raises(er.ExchangeReadError, match="IGES import requires OCP"):
        er.sew_faces_to_solids(object())


def test_explorer_solids_without_topology(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.TopAbs", None)
    with pytest.raises(er.ExchangeReadError, match="Exchange import requires OCP"):
        er._explorer_solids(object())


def test_read_iges_shape_without_iges_control(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.IGESControl", None)
    with pytest.raises(er.ExchangeReadError, match="IGES import requires OCP"):
        er.read_iges_shape(Path("x.iges"))


def test_read_iges_shape_rejects_reader_status(monkeypatch: Any, tmp_path: Path) -> None:
    _requires_cad()
    iges_control = pytest.importorskip("OCP.IGESControl", reason="OCP not installed")
    if_select = pytest.importorskip("OCP.IFSelect", reason="OCP not installed")

    class _FailingReader:
        def ReadFile(self, path: str) -> Any:
            return if_select.IFSelect_RetFail

    monkeypatch.setattr(iges_control, "IGESControl_Reader", _FailingReader)
    with pytest.raises(er.ExchangeReadError, match="IGES reader returned status"):
        er.read_iges_shape(tmp_path / "x.iges")


def test_read_iges_shape_rejects_empty_transfer(monkeypatch: Any) -> None:
    _requires_cad()
    iges_control = pytest.importorskip("OCP.IGESControl", reason="OCP not installed")
    if_select = pytest.importorskip("OCP.IFSelect", reason="OCP not installed")

    class _EmptyReader:
        def ReadFile(self, path: str) -> Any:
            return if_select.IFSelect_RetDone

        def TransferRoots(self) -> None:
            pass

        def OneShape(self) -> None:
            return None

    monkeypatch.setattr(iges_control, "IGESControl_Reader", _EmptyReader)
    with pytest.raises(er.ExchangeReadError, match="No shape transferred"):
        er.read_iges_shape(Path("x.iges"))


def test_read_brep_shape_without_brep_tools(monkeypatch: Any) -> None:
    monkeypatch.setitem(sys.modules, "OCP.BRepTools", None)
    with pytest.raises(er.ExchangeReadError, match="BREP import requires OCP"):
        er.read_brep_shape(Path("x.brep"))


def test_read_brep_shape_rejects_unreadable_file(tmp_path: Path) -> None:
    _requires_cad()
    probe = tmp_path / "broken.brep"
    probe.write_text("not a BREP file", encoding="utf-8")
    with pytest.raises(er.ExchangeReadError, match="BREP reader failed"):
        er.read_brep_shape(probe)


def test_read_shape_scales_raw_iges_to_file_units(tmp_path: Path) -> None:
    """IGES readers normalize to mm; read_shape recovers raw numbers first."""
    _requires_cad()
    iges = tmp_path / "box.iges"
    _write_box_iges(iges)

    shape = er.read_shape(iges, "iges", 1000.0)
    solids = er._explorer_solids(shape)
    assert len(solids) == 1
    info = er.solid_info(solids[0], 1)
    assert info.volume == pytest.approx(1.0e-6, rel=1e-6)


def test_read_shape_uses_raw_step_reader_for_non_mm_units(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_named_two_box_step(step)
    shape = er.read_shape(step, "step", 1000.0)
    assert len(er._explorer_solids(shape)) == 2


def test_read_import_source_rejects_bad_solids_cap(tmp_path: Path) -> None:
    with pytest.raises(er.ExchangeReadError, match="maxSolids must be a positive integer"):
        er.read_import_source(tmp_path / "missing.step", max_solids=0)


def test_read_import_source_rejects_unsupported_extension(tmp_path: Path) -> None:
    probe = tmp_path / "model.xyz"
    probe.write_text("dummy", encoding="utf-8")
    with pytest.raises(er.ExchangeReadError, match="Unsupported import source"):
        er.read_import_source(probe)


def test_read_import_source_rejects_source_without_solids(tmp_path: Path) -> None:
    """A face-only BREP is readable but contains no solids."""
    bd = _requires_cad()
    probe = tmp_path / "face.brep"
    geometry_service._write_brep(bd.Box(10, 10, 10).faces()[0].wrapped, probe)
    with pytest.raises(er.ExchangeReadError, match="contains no solids"):
        er.read_import_source(probe)


# ---------------------------------------------------------------------------
# Product-name walk: fallbacks, mismatches, and reader failures.
# ---------------------------------------------------------------------------


def test_product_names_without_solids_returns_empty() -> None:
    assert er.read_product_names(Path("unused.step"), "step", 0) == {}
    assert er.read_product_names(Path("unused.brep"), "brep", 2) == {}


def test_product_names_reader_failure_returns_empty(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "broken.step"
    step.write_text("not a STEP file", encoding="utf-8")
    iges = tmp_path / "broken.iges"
    iges.write_text("not an IGES file", encoding="utf-8")
    assert er.read_product_names(step, "step", 2) == {}
    assert er.read_product_names(iges, "iges", 2) == {}


def test_product_names_iges_reader_failure_returns_empty(monkeypatch: Any, tmp_path: Path) -> None:
    _requires_cad()
    iges = tmp_path / "probe.iges"
    iges.write_text("dummy", encoding="utf-8")
    caf = pytest.importorskip("OCP.IGESCAFControl", reason="OCP not installed")

    class _FailingReader:
        def SetNameMode(self, enabled: bool) -> None:
            pass

        def SetColorMode(self, enabled: bool) -> None:
            pass

        def ReadFile(self, path: str) -> int:
            return 0

    monkeypatch.setattr(caf, "IGESCAFControl_Reader", _FailingReader)
    assert er.read_product_names(iges, "iges", 2) == {}


def test_product_names_caf_transfer_failure_returns_empty(monkeypatch: Any, tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_named_two_box_step(step)
    caf = pytest.importorskip("OCP.STEPCAFControl", reason="OCP not installed")

    class _FailedTransfer:
        def SetNameMode(self, enabled: bool) -> None:
            pass

        def SetColorMode(self, enabled: bool) -> None:
            pass

        def ReadFile(self, path: str) -> int:
            return 1

        def Transfer(self, document: object) -> bool:
            return False

    monkeypatch.setattr(caf, "STEPCAFControl_Reader", _FailedTransfer)
    assert er.read_product_names(step, "step", 2) == {}


def test_product_names_unexpected_document_failure_returns_empty(
    monkeypatch: Any, tmp_path: Path
) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_named_two_box_step(step)
    doc_module = pytest.importorskip("OCP.TDocStd", reason="OCP not installed")

    class _ExplodingDocument:
        def __init__(self, *args: Any) -> None:
            raise RuntimeError("document unavailable")

    monkeypatch.setattr(doc_module, "TDocStd_Document", _ExplodingDocument)
    assert er.read_product_names(step, "step", 2) == {}


def test_product_names_swallows_name_conversion_failure(monkeypatch: Any, tmp_path: Path) -> None:
    """A name attribute that cannot decode never breaks the import."""
    _requires_cad()
    step = tmp_path / "two.step"
    _write_named_two_box_step(step)
    name_module = pytest.importorskip("OCP.TDataStd", reason="OCP not installed")

    class _BrokenName:
        def ToExtString(self) -> str:
            raise RuntimeError("decode failed")

    monkeypatch.setattr(name_module.TDataStd_Name, "Get", lambda self: _BrokenName())
    assert er.read_product_names(step, "step", 2) == {}


def test_product_names_mismatched_solid_count_returns_empty(tmp_path: Path) -> None:
    _requires_cad()
    step = tmp_path / "two.step"
    _write_named_two_box_step(step)
    assert er.read_product_names(step, "step", 3) == {}


def test_xcaf_names_tolerates_unsewable_free_shapes(monkeypatch: Any, tmp_path: Path) -> None:
    """A free shape with no solids whose sew probe raises counts as zero."""
    bd = _requires_cad()
    doc_module = pytest.importorskip("OCP.TDocStd", reason="OCP not installed")
    collection = pytest.importorskip("OCP.TCollection", reason="OCP not installed")
    xcaf = pytest.importorskip("OCP.XCAFDoc", reason="OCP not installed")

    document = doc_module.TDocStd_Document(collection.TCollection_ExtendedString("probe"))
    tool = xcaf.XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    tool.AddShape(bd.Box(10, 10, 10).faces()[0].wrapped, False)

    def _boom(shape: object) -> list[object]:
        raise RuntimeError("sew failed")

    monkeypatch.setattr(er, "_explorer_solids", _boom)
    assert er.xcaf_free_shape_names(document.Main(), 0) == {}


# ---------------------------------------------------------------------------
# Signature matching and selector guards.
# ---------------------------------------------------------------------------


def test_signature_matches_rejects_face_count_and_non_finite_volume() -> None:
    info = _info(1, face_count=6, volume=1000.0)
    assert er._signature_matches(info, 6, 1000.0, er.SIGNATURE_REL_TOLERANCE) is True
    assert er._signature_matches(info, 5, 1000.0, er.SIGNATURE_REL_TOLERANCE) is False
    assert er._signature_matches(info, 6, float("nan"), er.SIGNATURE_REL_TOLERANCE) is False
    infinite = _info(1, face_count=6, volume=float("inf"))
    assert er._signature_matches(infinite, 6, 1.0, er.SIGNATURE_REL_TOLERANCE) is False


def test_select_solids_rejects_invalid_selection() -> None:
    source = _fake_source([_info(1)])
    with pytest.raises(er.ExchangeReadError, match="selection mode"):
        er.select_solids(source, {"mode": "some"})
