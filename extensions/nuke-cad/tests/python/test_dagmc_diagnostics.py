# Copyright (C) 2026 NukeHub and others.
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
"""Tests for DAGMC export diagnostics and staged imprint recovery.

Minimal-profile only: heavy gmsh behavior is simulated with a fake module
(monkeypatched over ``dagmc_export.gmsh``), so these tests never assume the
ambient environment has (or lacks) the CAD toolchain.
"""

from pathlib import Path
from types import SimpleNamespace

import dagmc_export
import pytest


def test_overlap_diagnostic_golden_message() -> None:
    """Overlap pair message follows the '<WHAT> (<WHERE>): <EFFECT>. Fix: <ACTION>.' convention."""
    entry, message = dagmc_export.overlap_diagnostic(1, 2, "fuel_pin", "clad")
    assert message == (
        "Overlap fuel_pin/clad: export would double-count volume. "
        "Fix: Fuse in Model Outline or separate bodies."
    )
    assert entry["code"] == "overlap"
    assert entry["severity"] == "warning"
    assert entry["bodies"] == ["fuel_pin", "clad"]
    assert "Fuse" in entry["hint"]


def test_overlap_diagnostic_positional_fallback_labels() -> None:
    """Unlabeled volumes fall back to positional names."""
    entry, message = dagmc_export.overlap_diagnostic(1, 2)
    assert "volume 1/volume 2" in message
    assert entry["bodies"] == ["volume 1", "volume 2"]


def test_sense_error_message_names_surface_volumes_and_stage() -> None:
    """Sense failure names the surface, its volumes, and the imprint stage."""
    message = dagmc_export.sense_error_message(7, [1], "S2")
    assert message == (
        "Surface 7 has no valid sense (volumes [1]): imprint failed at S2. Not exported."
    )


def test_verify_surface_senses_stage_error_naming() -> None:
    """Sense verification stays hard but names surface + volumes + stage."""
    with pytest.raises(RuntimeError) as excinfo:
        dagmc_export._verify_surface_senses({7: None}, {7: []}, stage="S2")
    message = str(excinfo.value)
    assert "surface 7 (adjacent volumes: 0)" in message
    assert "volumes []" in message
    assert "S2" in message
    assert "Not exported" in message


def test_imprint_relax_message_golden() -> None:
    """S2 fallback message carries the tolerance change and the REPORTED flag."""
    message = dagmc_export.imprint_relax_message(1e-07, 1e-06)
    assert message == (
        "Imprint S2 tolerance relaxed 1e-07 -> 1e-06 (reported): "
        "fragment recovered at relaxed tolerance. "
        "Fix: accept warning or tighten CAD gaps."
    )


def test_graveyard_skipped_message_reports_fallback() -> None:
    """S3 fallback message carries the graveyardSkipped flag (never silent)."""
    message = dagmc_export.graveyard_skipped_message()
    assert "graveyardSkipped" in message
    assert "reported" in message


def test_seal_error_message_golden() -> None:
    """Seal fail-fast message names the open-edge count and the fix."""
    message = dagmc_export.seal_error_message(4, "close the gaps")
    assert message == (
        "Seal check failed (4 open edges): "
        "the facet mesh has holes and would leak particles. Fix: close the gaps."
    )


def test_relaxed_tolerance_is_capped() -> None:
    """S2 relaxes 10x but never exceeds the cap."""
    assert dagmc_export._relaxed_imprint_tolerance(1e-07) == pytest.approx(1e-06)
    assert dagmc_export._relaxed_imprint_tolerance(1e-03) == pytest.approx(1e-04)


def test_last_ok_imprint_stage_prefers_recovered() -> None:
    """The sense-error stage label tracks the latest ok/recovered stage."""
    log = [
        {"stage": "S0", "status": "failed"},
        {"stage": "S1", "status": "skipped"},
        {"stage": "S2", "status": "failed"},
        {"stage": "S3", "status": "recovered"},
    ]
    assert dagmc_export._last_ok_imprint_stage(log) == "S3"
    assert dagmc_export._last_ok_imprint_stage([]) == "S1"


def test_report_imprint_fallbacks_is_idempotent() -> None:
    """Fallback reporting fires exactly once per stage entry."""
    log = [
        dagmc_export._stage_entry("S0", 1e-07, 2, 2, "failed", "boom"),
        dagmc_export._stage_entry("S1", 1e-07, 2, 2, "skipped", "S0 failed"),
    ]
    s2_entry = dagmc_export._stage_entry("S2", 1e-06, 2, 2, "ok", "relaxed")
    s2_entry["previousTolerance"] = 1e-07
    log.append(s2_entry)
    warnings: list[str] = []
    diagnostics: list[dict] = []
    reported = dagmc_export._report_imprint_fallbacks(log, 0, warnings, diagnostics)
    assert reported == len(log)
    assert sum("S2" in w for w in warnings) == 1
    assert any(d["code"] == "imprint" for d in diagnostics)
    # A second scan over the same log reports nothing new.
    reported_again = dagmc_export._report_imprint_fallbacks(log, reported, warnings, diagnostics)
    assert reported_again == len(log)
    assert sum("S2" in w for w in warnings) == 1


class _FakeOcc:
    """Minimal gmsh occ stub: fragment fails until armed, then succeeds."""

    def __init__(self, fail_tags: set[int] | None = None, fail_all: bool = False) -> None:
        self.fail_tags = set(fail_tags or set())
        self.fail_all = fail_all
        self.armed_failures = 0

    def getMass(self, dim: int, tag: int) -> float:
        return float(tag)

    def fragment(
        self, objects: list[tuple[int, int]], tools: list[tuple[int, int]]
    ) -> tuple[list[tuple[int, int]], list[list[tuple[int, int]]]]:
        tags = [int(tag) for _, tag in objects]
        if self.fail_all or any(tag in self.fail_tags for tag in tags):
            self.armed_failures += 1
            raise RuntimeError("fake fragment boom")
        return objects, [[(3, tag)] for tag in tags]

    def synchronize(self) -> None:
        pass

    def removeAllDuplicates(self) -> None:
        pass


class _FakeOption:
    def __init__(self) -> None:
        self.values = {"Geometry.Tolerance": 1e-07}
        self.set_calls: list[tuple[str, float]] = []

    def getNumber(self, name: str) -> float:
        return float(self.values.get(name, 1e-07))

    def setNumber(self, name: str, value: float) -> None:
        self.values[name] = float(value)
        self.set_calls.append((name, float(value)))


class _FakeModel:
    def __init__(self, occ: _FakeOcc, tags: list[int]) -> None:
        self.occ = occ
        self.tags = tags

    def getEntities(self, dim: int) -> list[tuple[int, int]]:
        assert dim == 3
        return [(3, tag) for tag in self.tags]

    def getBoundingBox(self, dim: int, tag: int = -1) -> tuple[float, ...]:
        return (0.0, 0.0, 0.0, 1.0, 1.0, 1.0)


class _FakeGmsh:
    def __init__(self, occ: _FakeOcc, tags: list[int]) -> None:
        self.model = _FakeModel(occ, tags)
        self.option = _FakeOption()


def _install_fake(monkeypatch: pytest.MonkeyPatch, fake: _FakeGmsh) -> None:
    monkeypatch.setattr(dagmc_export, "gmsh", fake)


def test_fragment_s4_hard_fail_carries_stage_log(monkeypatch: pytest.MonkeyPatch) -> None:
    """Total imprint failure raises at S4 with the full stage log attached."""
    fake = _FakeGmsh(_FakeOcc(fail_all=True), [1, 2])
    _install_fake(monkeypatch, fake)
    log: list[dict] = []
    with pytest.raises(RuntimeError) as excinfo:
        dagmc_export._fragment_and_track([(3, 1), (3, 2)], {1: 1, 2: 2}, 1.0, stage_log=log)
    message = str(excinfo.value)
    assert "S4" in message
    assert "fake fragment boom" in message
    assert [entry["stage"] for entry in log] == ["S0", "S1", "S2", "S4"]
    assert log[0]["status"] == "failed"
    assert log[2]["stage"] == "S2" and "previousTolerance" in log[2]


def test_fragment_s2_relaxed_recovery_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """An S2 retry that recovers logs ok and restores the model tolerance."""
    occ = _FakeOcc()
    fake = _FakeGmsh(occ, [1, 2])
    _install_fake(monkeypatch, fake)
    log: list[dict] = []

    calls = {"count": 0}
    real_worker = dagmc_export._fragment_track_and_map

    def _flaky(
        input_tags: list[tuple[int, int]], input_to_pre: dict[int, int], diag: float
    ) -> dict[int, int]:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("first attempt boom")
        return real_worker(input_tags, input_to_pre, diag)

    monkeypatch.setattr(dagmc_export, "_fragment_track_and_map", _flaky)
    mapping = dagmc_export._fragment_and_track([(3, 1), (3, 2)], {1: 1, 2: 2}, 1.0, stage_log=log)
    assert mapping == {1: 1, 2: 2}
    assert [(e["stage"], e["status"]) for e in log] == [
        ("S0", "failed"),
        ("S1", "skipped"),
        ("S2", "ok"),
    ]
    # The relaxed tolerance was applied for S2 then restored to the model value.
    assert ("Geometry.Tolerance", pytest.approx(1e-06)) in fake.option.set_calls
    assert fake.option.getNumber("Geometry.Tolerance") == pytest.approx(1e-07)

    warnings: list[str] = []
    diagnostics: list[dict] = []
    dagmc_export._report_imprint_fallbacks(log, 0, warnings, diagnostics)
    assert any("(reported)" in w and "S2" in w for w in warnings)
    assert any(d["code"] == "imprint" for d in diagnostics)


def test_fragment_s3_model_only_fallback_skips_graveyard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S3 drops the graveyard inputs and recovers; the skip is REPORTED."""
    fake = _FakeGmsh(_FakeOcc(fail_tags={99}), [1])
    _install_fake(monkeypatch, fake)
    log: list[dict] = []
    mapping = dagmc_export._fragment_and_track(
        [(3, 1), (3, 99)], {1: 1, 99: 3}, 1.0, stage_log=log, graveyard_pre={3}
    )
    assert mapping == {1: 1}
    s3_entries = [e for e in log if e["stage"] == "S3"]
    assert len(s3_entries) == 1
    assert s3_entries[0]["status"] == "recovered"
    assert "graveyardSkipped" in s3_entries[0].get("note", "")

    warnings: list[str] = []
    diagnostics: list[dict] = []
    dagmc_export._report_imprint_fallbacks(log, 0, warnings, diagnostics)
    assert any("graveyardSkipped" in w for w in warnings)


def test_fragment_empty_inputs_short_circuits() -> None:
    """No inputs means no stages and an empty mapping."""
    log: list[dict] = []
    assert dagmc_export._fragment_and_track([], {}, 1.0, stage_log=log) == {}
    assert log == []


def test_convert_result_carries_additive_keys_on_early_failure(tmp_path: Path) -> None:
    """Even failed exports report diagnostics/imprintStages/sealCheck keys."""
    result = dagmc_export.convert_to_dagmc(
        str(tmp_path / "missing.step"), output_path=str(tmp_path / "out.h5m")
    )
    assert result["success"] is False
    assert result["diagnostics"] == []
    assert result["imprintStages"] == []
    assert result["sealCheck"] is None
    assert result["error"]


def test_require_deps_reports_forced_absence(monkeypatch: pytest.MonkeyPatch) -> None:
    """Forced-absence guards report exactly which deps are missing (both profiles)."""
    monkeypatch.setattr(dagmc_export, "HAS_NUMPY", True)
    monkeypatch.setattr(dagmc_export, "HAS_GMSH", False)
    monkeypatch.setattr(dagmc_export, "HAS_PYMOLAB", False)
    with pytest.raises(RuntimeError) as excinfo:
        dagmc_export._require_deps()
    assert "gmsh" in str(excinfo.value)
    assert "pymoab" in str(excinfo.value)


def _lattice_manifest() -> SimpleNamespace:
    """Body-level plus per-cell volume entries, mirroring a pin-lattice export."""
    return SimpleNamespace(
        volumes=[
            {"selector": "assembly", "name": "assembly", "material": "fuel"},
            {"selector": "assembly_r0c0", "name": "assembly_r0c0", "material": "fuel"},
            {"selector": "assembly_r0c1", "name": "assembly_r0c1", "material": "fuel"},
        ]
    )


def test_most_specific_selector_prefers_cell_over_body() -> None:
    """A per-cell entry beats the body-level entry covering the same volume."""
    selector_map = {"assembly": [1, 2], "assembly_r0c0": [1], "assembly_r0c1": [2]}
    assert dagmc_export._most_specific_selector(1, selector_map) == "assembly_r0c0"
    assert dagmc_export._most_specific_selector(2, selector_map) == "assembly_r0c1"


def test_most_specific_selector_is_order_independent() -> None:
    """Body-first or body-last dict order resolves to the same cell selector."""
    body_first = {"assembly": [1, 2], "assembly_r0c0": [1]}
    body_last = {"assembly_r0c0": [1], "assembly": [1, 2]}
    assert dagmc_export._most_specific_selector(1, body_first) == "assembly_r0c0"
    assert dagmc_export._most_specific_selector(1, body_last) == "assembly_r0c0"


def test_most_specific_selector_tie_keeps_first() -> None:
    """Equal-size overlapping selectors keep first-match-wins (byte-identical)."""
    assert dagmc_export._most_specific_selector(2, {"a": [1, 2], "b": [2, 3]}) == "a"
    assert dagmc_export._most_specific_selector(9, {"a": [1]}) is None
    assert dagmc_export._most_specific_selector(1, None) is None
    assert dagmc_export._most_specific_selector(1, {}) is None


def test_volume_name_prefers_cell_group_over_body_group() -> None:
    """Lattice volumes resolve to per-cell mat: groups with a body entry present."""
    manifest = _lattice_manifest()
    selector_map = {"assembly": [1, 2], "assembly_r0c0": [1], "assembly_r0c1": [2]}
    assert (
        dagmc_export._volume_name_from_manifest(1, manifest, selector_map, set())
        == "mat:assembly_r0c0"
    )
    assert (
        dagmc_export._volume_name_from_manifest(2, manifest, selector_map, set())
        == "mat:assembly_r0c1"
    )


def test_volume_name_disjoint_selectors_match_first_match_wins() -> None:
    """Non-overlapping selectors resolve exactly as before (shadowing byte-identical)."""
    manifest = SimpleNamespace(
        volumes=[
            {"selector": "left", "name": "left_block", "material": "m1"},
            {"selector": "right", "name": "right_block", "material": "m2"},
        ]
    )
    selector_map = {"left": [1], "right": [2]}
    assert (
        dagmc_export._volume_name_from_manifest(1, manifest, selector_map, set())
        == "mat:left_block"
    )
    assert (
        dagmc_export._volume_name_from_manifest(2, manifest, selector_map, set())
        == "mat:right_block"
    )
    assert dagmc_export._volume_name_from_manifest(3, manifest, selector_map, set()) == "mat:mat_2"
    assert dagmc_export._volume_name_from_manifest(1, None, selector_map, set()) == "mat:mat_0"


def test_volume_label_prefers_cell_over_body() -> None:
    """Overlap diagnostics label the cell, not the enclosing body entry."""
    manifest = _lattice_manifest()
    selector_map = {"assembly": [1, 2], "assembly_r0c0": [1]}
    assert dagmc_export._volume_label(1, manifest, selector_map) == "assembly_r0c0"
    assert dagmc_export._volume_label(2, manifest, selector_map) == "assembly"
    assert dagmc_export._volume_label(9, manifest, selector_map) == "volume 9"
