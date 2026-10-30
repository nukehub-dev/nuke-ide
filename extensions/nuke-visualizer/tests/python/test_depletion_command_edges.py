# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Command wiring tests for the depletion contact-dose and decay-spectrum handlers.

The physics shaping lives in ``plugins.openmc.lib.depletion_analysis`` and is
covered by ``test_depletion_analysis.py``. These tests replace that module
with a recording stub so the command layer is verified independently: the
requested chain file reaches ``depletion_results``, the material/time/dose
arguments reach the summarizer, and the result is emitted as one JSON object
with the source file attached. Failure paths must stay JSON-only.
"""

import argparse
import json
import sys
from contextlib import contextmanager
from types import ModuleType

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import depletion as depletion_cmds  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


def _install_analysis(monkeypatch, contact_payload=None, spectrum_payload=None, error=None):
    """Install a recording fake ``depletion_analysis`` module."""
    calls = {"opened": [], "contact": [], "spectrum": []}
    module = ModuleType("plugins.openmc.lib.depletion_analysis")

    @contextmanager
    def depletion_results(path, chain_file):
        calls["opened"].append((path, chain_file))
        if error is not None:
            raise error
        yield ("results", "chain")

    def summarize_contact_dose(results, material_index, **kwargs):
        calls["contact"].append((results, material_index, kwargs))
        return dict(contact_payload or {"total": [1.0], "unit": "Gy/h"})

    def summarize_decay_spectrum(results, material_index, time_index):
        calls["spectrum"].append((results, material_index, time_index))
        return dict(spectrum_payload or {"lines": [[1.0, 2.0]], "unit": "Bq"})

    module.depletion_results = depletion_results
    module.summarize_contact_dose = summarize_contact_dose
    module.summarize_decay_spectrum = summarize_decay_spectrum
    monkeypatch.setitem(sys.modules, "plugins.openmc.lib.depletion_analysis", module)
    return calls


def test_contact_dose_forwards_arguments_and_marks_file(monkeypatch, capsys):
    calls = _install_analysis(monkeypatch, contact_payload={"total": [0.5], "unit": "Sv/h"})

    args = _parse(
        depletion_cmds.cmd_depletion_contact_dose,
        [
            "results.h5",
            "4",
            "--dose-quantity",
            "effective",
            "--build-up",
            "3.5",
            "--by-nuclide",
            "--chain-file",
            "chain.xml",
        ],
    )
    assert depletion_cmds.cmd_depletion_contact_dose(args) == 0

    payload = _stdout_json(capsys)
    assert payload == {"total": [0.5], "unit": "Sv/h", "file": "results.h5"}
    assert calls["opened"] == [("results.h5", "chain.xml")]
    assert calls["contact"] == [
        (
            "results",
            4,
            {
                "dose_quantity": "effective",
                "build_up": 3.5,
                "by_nuclide": True,
            },
        )
    ]


def test_contact_dose_defaults(monkeypatch, capsys):
    calls = _install_analysis(monkeypatch)

    args = _parse(depletion_cmds.cmd_depletion_contact_dose, ["results.h5", "9"])
    assert depletion_cmds.cmd_depletion_contact_dose(args) == 0

    assert _stdout_json(capsys)["file"] == "results.h5"
    assert calls["opened"] == [("results.h5", None)]
    assert calls["contact"][0][2] == {
        "dose_quantity": "absorbed-air",
        "build_up": 2.0,
        "by_nuclide": False,
    }


def test_contact_dose_reports_failure_as_json(monkeypatch, capsys):
    _install_analysis(monkeypatch, error=RuntimeError("no chain configured"))

    args = _parse(depletion_cmds.cmd_depletion_contact_dose, ["results.h5", "1"])
    assert depletion_cmds.cmd_depletion_contact_dose(args) == 1

    assert _stdout_json(capsys) == {"error": "no chain configured"}


def test_decay_spectrum_forwards_indices_and_marks_file(monkeypatch, capsys):
    calls = _install_analysis(monkeypatch, spectrum_payload={"lines": [[2.0, 3.0]]})

    args = _parse(
        depletion_cmds.cmd_depletion_decay_spectrum,
        ["results.h5", "7", "2", "--chain-file", "chain.xml"],
    )
    assert depletion_cmds.cmd_depletion_decay_spectrum(args) == 0

    payload = _stdout_json(capsys)
    assert payload == {"lines": [[2.0, 3.0]], "file": "results.h5"}
    assert calls["opened"] == [("results.h5", "chain.xml")]
    assert calls["spectrum"] == [("results", 7, 2)]


def test_decay_spectrum_reports_failure_as_json(monkeypatch, capsys):
    _install_analysis(monkeypatch, error=RuntimeError("unknown time index"))

    args = _parse(depletion_cmds.cmd_depletion_decay_spectrum, ["results.h5", "1", "99"])
    assert depletion_cmds.cmd_depletion_decay_spectrum(args) == 1

    assert _stdout_json(capsys) == {"error": "unknown time index"}
