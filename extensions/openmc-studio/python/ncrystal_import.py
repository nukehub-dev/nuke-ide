#!/usr/bin/env python3
"""Import an OpenMC material from an NCrystal configuration string.

One-shot helper for the materials tab: builds a material via
``openmc.Material.from_ncrystal()`` and returns its composition as JSON.

Usage:
    python ncrystal_import.py <cfg>

Example:
    python ncrystal_import.py "Al_sg225.ncmat;temp=300K"
"""

import argparse
import json
import sys
import traceback


def import_ncrystal(cfg: str):
    """Build a material from an NCrystal configuration string.

    Args:
        cfg: NCrystal configuration string, e.g. ``Al_sg225.ncmat;temp=300K``.

    Returns:
        Dictionary with the material composition (nuclides, density, temperature).
    """
    import openmc

    material = openmc.Material.from_ncrystal(cfg)

    nuclides = [
        {
            "name": nuclide.name,
            "fraction": float(nuclide.percent),
            "fractionType": nuclide.percent_type,
        }
        for nuclide in material.nuclides
    ]

    return {
        "success": True,
        "material": {
            "nuclides": nuclides,
            "density": float(material.density),
            "densityUnit": "g/cm3",
            "temperature": float(material.temperature)
            if material.temperature is not None
            else None,
        },
    }


def main():
    """Entry point: parse arguments, import the material, print JSON result."""
    parser = argparse.ArgumentParser(
        description="Import an OpenMC material from an NCrystal configuration string"
    )
    parser.add_argument("cfg", help="NCrystal configuration string, e.g. Al_sg225.ncmat;temp=300K")

    args = parser.parse_args()

    try:
        result = import_ncrystal(args.cfg)
        print(json.dumps(result))
    except ImportError as e:
        print(
            json.dumps(
                {"success": False, "error": f"Missing dependency: {e}. Please install openmc."}
            )
        )
        sys.exit(0)
    except RuntimeError as e:
        # from_ncrystal raises RuntimeError when NCrystal itself is missing
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(0)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(0)


if __name__ == "__main__":
    main()
