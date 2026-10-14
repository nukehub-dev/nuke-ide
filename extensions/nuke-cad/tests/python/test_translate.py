#!/usr/bin/env python3
"""Rigid body translation (move a body's accumulated shape by [dx, dy, dz])."""

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

import feature_builder as fb
import pytest
from doc_build_helpers import _by_id, _document, _feature, _rect_sketch


def _pad_doc(*extra: dict) -> dict:
    return _document(
        [_feature("base", "pad", {"length": 5.0}, "rect"), *extra],
        [_rect_sketch()],
    )


def test_translate_moves_body_down() -> None:
    """Translating by [0, 0, -5] shifts the body center down 5, volume unchanged."""
    pytest.importorskip("build123d", reason="build123d not installed")
    plain = fb.build_document_shape(_pad_doc())
    moved = fb.build_document_shape(
        _pad_doc(_feature("m", "translate", {"vector": [0.0, 0.0, -5.0]}))
    )
    assert _by_id(moved)["m"]["status"] == "built"
    assert moved["shape"] is not None and plain["shape"] is not None
    assert math.isclose(moved["shape"].volume, plain["shape"].volume, rel_tol=1e-9)
    assert math.isclose(
        plain["shape"].center().Z - moved["shape"].center().Z, 5.0, rel_tol=1e-9
    )


def test_translate_rejects_bad_vector() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    for bad in (None, [1.0, 2.0], [1.0, float("nan"), 0.0], ["a", 0.0, 0.0]):
        result = fb.build_document_shape(_pad_doc(_feature("m", "translate", {"vector": bad})))
        assert _by_id(result)["m"]["status"] == "failed"
        assert "vector" in _by_id(result)["m"]["error"]


def test_translate_requires_existing_body() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(
        _document([_feature("m", "translate", {"vector": [1.0, 0.0, 0.0]})], [_rect_sketch()])
    )
    assert _by_id(result)["m"]["status"] == "failed"
    assert "existing solid body" in _by_id(result)["m"]["error"]


def test_translate_without_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without build123d the backend fails with a clear error, never a traceback."""
    monkeypatch.setattr(fb, "HAS_BUILD123D", False)
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb._apply_translate(object(), [1.0, 0.0, 0.0], "m")
