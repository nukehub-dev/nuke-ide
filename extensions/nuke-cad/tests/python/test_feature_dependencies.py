#!/usr/bin/env python3
"""Implied build-order dependencies for reference-carrying features."""

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

from typing import Any

import feature_builder as fb


def test_implied_dependencies_for_new_edges() -> None:
    """multiTransform, primitive/upToFace/datum refs imply build ordering."""
    features = [
        {"id": "base", "body": "body-1", "type": "pad", "params": {}},
        {"id": "lin", "body": "body-1", "type": "linearPattern", "params": {"source": "base"}},
        {"id": "mir", "body": "body-1", "type": "mirror", "params": {"source": "base"}},
        {
            "id": "multi",
            "body": "body-1",
            "type": "multiTransform",
            "params": {"first": "lin", "second": "mir"},
        },
        {
            "id": "up",
            "body": "body-1",
            "type": "pad",
            "params": {"upToFace": {"featureId": "base", "kind": "face"}},
        },
        {
            "id": "prim",
            "body": "body-2",
            "type": "primitive",
            "params": {"shape": "box", "dimensions": [1, 1, 1], "datumId": "mp"},
        },
    ]
    sketches: dict[str, dict[str, Any]] = {}
    datums = {
        "mp": {
            "id": "mp",
            "kind": "midplane",
            "faces": [
                {"featureId": "base", "kind": "face"},
                {"featureId": "lin", "kind": "face"},
            ],
        }
    }
    edges = fb._compute_implied_dependencies(features, sketches, datums)
    assert ("multi", "lin") in edges
    assert ("multi", "mir") in edges
    assert ("up", "base") in edges
    assert ("prim", "base") in edges
    assert ("prim", "lin") in edges


def test_implied_dependencies_pattern_datum_refs() -> None:
    """Pattern datum references order the pattern after the datum's feature."""
    features = [
        {"id": "base", "body": "body-1", "type": "pad", "params": {}},
        {
            "id": "circ",
            "body": "body-1",
            "type": "circularPattern",
            "params": {"source": "base", "axisDatumId": "ad"},
        },
    ]
    datums = {
        "ad": {"id": "ad", "kind": "face", "reference": {"featureId": "base", "kind": "face"}}
    }
    edges = fb._compute_implied_dependencies(features, {}, datums)
    assert ("circ", "base") in edges
