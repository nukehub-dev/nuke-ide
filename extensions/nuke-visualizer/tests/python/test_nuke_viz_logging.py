"""Tests for nuke_viz.logging — structured stdout/stderr messaging."""

import json

from nuke_viz import logging as nuke_logging


def test_warning_prints_prefixed_json_to_stdout(capsys):
    """warning() emits one NUKE_IDE_WARNING:<json> line on stdout."""
    nuke_logging.warning("something looks off", "spatial_warning", cell_id=7)

    captured = capsys.readouterr()
    assert captured.err == ""

    line = captured.out.strip()
    assert line.startswith("NUKE_IDE_WARNING:")

    payload = json.loads(line[len("NUKE_IDE_WARNING:") :])
    assert payload == {
        "type": "spatial_warning",
        "message": "something looks off",
        "cell_id": 7,
    }


def test_warning_default_type(capsys):
    """The default warning_type is 'generic'."""
    nuke_logging.warning("plain warning")

    line = capsys.readouterr().out.strip()
    payload = json.loads(line[len("NUKE_IDE_WARNING:") :])
    assert payload["type"] == "generic"
    assert payload["message"] == "plain warning"


def test_info_goes_to_stderr(capsys):
    """info() writes a [NukeViz] line to stderr, keeping stdout clean."""
    nuke_logging.info("loading model")

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == "[NukeViz] loading model"


def test_error_goes_to_stderr(capsys):
    """error() writes a [NukeViz] ERROR line to stderr."""
    nuke_logging.error("conversion failed")

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == "[NukeViz] ERROR: conversion failed"
