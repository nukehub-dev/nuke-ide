"""End-to-end test for the nuclear-data commands against the real data library.

Reads the cross_sections.xml from OPENMC_CROSS_SECTIONS, summarizes the
library, and spot-checks U235 detail (temperatures, fission MTs). Skips
cleanly when the env var is unset.
"""

import pytest
from e2e_helpers import require_cross_sections, require_openmc

openmc = require_openmc()

pytestmark = pytest.mark.e2e


@pytest.mark.e2e
def test_library_summary_and_u235_detail():
    xs = require_cross_sections()

    from plugins.openmc.commands import nuclear_data

    # Library summary: real per-file metadata from the data dir
    result = nuclear_data.read_data_library(xs)

    assert result["success"] is True
    assert result["libraryPath"] == xs
    assert result["nuclideCount"] > 0
    by_name = {n["name"]: n for n in result["nuclides"]}
    assert "U235" in by_name
    u235_entry = by_name["U235"]
    assert u235_entry["temperatureCount"] >= 1
    assert u235_entry["reactionCount"] > 0

    # U235 detail: IncidentNeutron parse — fission MTs and temperatures present
    detail = nuclear_data.read_nuclide_detail(u235_entry["path"])

    assert detail["success"] is True
    assert detail["name"] == "U235"
    assert detail["fission"] is True
    assert len(detail["temperatures"]) >= 1
    mts = {r["mt"] for r in detail["reactions"]}
    assert 18 in mts, "U235 must carry the (n,fission) MT 18 channel"
    assert 2 in mts and 102 in mts
