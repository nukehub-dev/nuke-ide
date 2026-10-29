"""Real OpenMC e2e: capture/fission derived tally matches a direct calculation."""

import json

import derive_tallies
import numpy as np
import pytest
from e2e_helpers import require_cross_sections, require_openmc

pytestmark = pytest.mark.e2e


def test_capture_fission_ratio_matches_direct_openmc_arithmetic(pincell_model, pincell_dir):
    """Build a pincell with capture + fission tallies, run, and compare."""
    require_cross_sections()
    openmc = require_openmc()

    fuel_id = pincell_model.pincell_cell_ids[0]
    capture = openmc.Tally(tally_id=1, name="capture")
    capture.scores = ["(n,gamma)"]
    capture.filters = [openmc.CellFilter([fuel_id])]
    fission = openmc.Tally(tally_id=2, name="fission")
    fission.scores = ["fission"]
    fission.filters = [openmc.CellFilter([fuel_id])]
    pincell_model.tallies = openmc.Tallies([capture, fission])
    pincell_model.export_to_xml(pincell_dir)

    openmc.run(cwd=pincell_dir)
    statepoints = sorted(pincell_dir.glob("statepoint*.h5"), key=lambda path: path.stat().st_mtime)
    assert statepoints, "OpenMC did not write a statepoint"
    statepoint_path = statepoints[-1]

    definitions = [
        {
            "id": 1,
            "name": "Capture / fission",
            "unit": "ratio",
            "color": "#4a9eff",
            "expression": {
                "kind": "binary",
                "op": "/",
                "left": {"kind": "tally", "tallyId": 1, "score": "(n,gamma)"},
                "right": {"kind": "tally", "tallyId": 2, "score": "fission"},
            },
        }
    ]
    result = derive_tallies.run(str(statepoint_path), json.dumps(definitions))
    assert result["success"] is True, result
    assert result["errors"] == []
    derived = result["derivedTallies"][0]
    assert derived["formula"] == "T1[(n,gamma)] / T2[fission]"

    with openmc.StatePoint(str(statepoint_path)) as statepoint:
        capture_values = statepoint.tallies[1].get_values(scores=["(n,gamma)"])
        fission_values = statepoint.tallies[2].get_values(scores=["fission"])
        capture_std = statepoint.tallies[1].get_values(scores=["(n,gamma)"], value="std_dev")
        fission_std = statepoint.tallies[2].get_values(scores=["fission"], value="std_dev")
        expected_mean = capture_values / fission_values
        with np.errstate(divide="ignore", invalid="ignore"):
            relative = np.sqrt(
                (capture_std / capture_values) ** 2 + (fission_std / fission_values) ** 2
            )
            expected_std = np.abs(expected_mean) * relative
        expected_mean = np.nan_to_num(expected_mean)
        expected_std = np.nan_to_num(expected_std)

    assert derived["totalBins"] == int(expected_mean.size)
    np.testing.assert_allclose(derived["mean"], expected_mean.ravel(), rtol=1e-12, atol=1e-14)
    np.testing.assert_allclose(derived["stdDev"], expected_std.ravel(), rtol=1e-12, atol=1e-14)
    assert derived["filters"] == [{"type": "cell", "bins": [fuel_id]}]
    assert derived["unit"] == "ratio"

    tallies_xml = (pincell_dir / "tallies.xml").read_text(encoding="utf-8")
    assert tallies_xml.count("<tally ") == 2
    assert "Derived" not in tallies_xml
    assert "derived" not in tallies_xml.lower()
