#!/usr/bin/env python3
"""Real-build check for the two-instance assembly fixture.

The fixture is the canonical small assembly used by live placement apply/undo
scenarios: two labelled embedded-body instances (``base`` grounded at the
origin, ``arm`` at x=20) with no mates. This test proves the committed JSON
builds two placed solids through the backend assembly path; it skips cleanly
when the full CAD toolchain is unavailable.
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

from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parents[1] / "e2e" / "assets" / "assembly_two_instances.nuke-cad"


def test_two_instance_fixture_builds_placed_body_instances(tmp_path: Path) -> None:
    pytest.importorskip("OCP", reason="OCP not installed")
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service as gs

    result = gs.build_assembly(
        str(FIXTURE),
        output_dir=str(tmp_path / "out"),
        export_dagmc=False,
        export_mesh=False,
    )

    assert result["success"] is True, result.get("error")
    assert result["selectorMap"] == {"base/base": [1], "arm/arm": [2]}
    assert result["solidInstanceIds"] == ["base", "arm"]
    assert result["placements"]["base"][3] == pytest.approx(0.0)
    assert result["placements"]["arm"][3] == pytest.approx(20.0)
