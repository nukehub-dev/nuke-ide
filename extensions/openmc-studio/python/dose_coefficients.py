#!/usr/bin/env python3
"""Return OpenMC's shipped ICRP dose-response coefficients as JSON.

Used by the Shutdown Dose wizard's "Add dose tally" action so the response
function always comes from OpenMC's own data tables rather than a hard-coded
copy in the UI.

Usage:
    python dose_coefficients.py --data-source icrp116 --dose-quantity effective --geometry AP
"""

import argparse
import json
import sys


def main():
    """Parse arguments and print the coefficient table."""
    parser = argparse.ArgumentParser(description="Read OpenMC dose-response coefficients")
    parser.add_argument(
        "--particle",
        default="photon",
        choices=["photon"],
        help="Incident particle (photon only)",
    )
    parser.add_argument(
        "--data-source",
        default="icrp116",
        choices=["icrp74", "icrp116"],
        help="ICRP data source",
    )
    parser.add_argument(
        "--dose-quantity",
        default="effective",
        choices=["effective", "ambient"],
        help="Dose quantity",
    )
    parser.add_argument(
        "--geometry",
        default="AP",
        choices=["AP", "PA", "LLAT", "RLAT", "ROT", "ISO"],
        help="Irradiation geometry (effective dose only)",
    )
    args = parser.parse_args()

    try:
        import openmc.data
    except ImportError as exc:
        print(json.dumps({"success": False, "error": f"OpenMC is required: {exc}"}))
        return 0

    try:
        energy, response = openmc.data.dose_coefficients(
            args.particle, args.geometry, args.data_source, args.dose_quantity
        )
    except Exception as exc:  # noqa: BLE001 - OpenMC raises ValueError for missing tables
        print(json.dumps({"success": False, "error": str(exc)}))
        return 0

    print(
        json.dumps(
            {
                "success": True,
                "energy": [float(value) for value in energy],
                "response": [float(value) for value in response],
                "units": "pSv cm^2",
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
