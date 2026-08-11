#!/usr/bin/env python3
"""Read the material-name -> XS-data-name mapping from an existing MGXS library.

This lets the IDE convert a project whose settings already point at an MGXS
library without re-running the continuous-energy generation step. The library
type is detected from the data set names: nuclide-wise libraries name each
set after a nuclide (e.g. ``Fe56``, ``U235``, ``Am242_m1``), material-wise
libraries name each set after a material.

Usage:
    python read_mgxs_data_names.py <mgxs_library.h5>

Output:
    JSON object: {"success": true, "type": "material" | "nuclide",
                  "xsDataNames": [{"materialName": "...", "xsDataName": "..."}, ...]}
"""

import json
import re
import sys
from pathlib import Path

# Nuclide names look like 'Fe56', 'U235', 'Am242_m1' (symbol + mass, optional
# metastable suffix). Material names are free-form, so a library counts as
# nuclide-wise only when EVERY data set name matches.
NUCLIDE_NAME_RE = re.compile(r"^[A-Z][a-z]?\d+(_m\d+)?$")


def read_mapping(mgxs_path: str):
    """Return material-name / XS-data-name pairs from the top-level HDF5 groups.

    Args:
        mgxs_path: Path to an existing MGXS library (usually mgxs.h5).

    Returns:
        Tuple (success, list_of_mappings_or_none, library_type_or_none,
        error_message_or_none).
    """
    try:
        import h5py
    except ImportError as e:
        return False, None, None, f"h5py is required to read MGXS libraries: {e}"

    path = Path(mgxs_path)
    if not path.exists():
        return False, None, None, f"MGXS library not found: {mgxs_path}"

    try:
        with h5py.File(path, "r") as f:
            names = list(f.keys())
        mapping = [{"materialName": name, "xsDataName": name} for name in names]
        library_type = (
            "nuclide" if names and all(NUCLIDE_NAME_RE.match(n) for n in names) else "material"
        )
        return True, mapping, library_type, None
    except Exception as e:
        return False, None, None, str(e)


def main():
    """Entry point: parse path and print the JSON result."""
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"success": False, "error": "Usage: read_mgxs_data_names.py <mgxs_library.h5>"}
            )
        )
        sys.exit(1)

    success, mapping, library_type, error = read_mapping(sys.argv[1])
    result = {"success": success, "xsDataNames": mapping if mapping else []}
    if library_type:
        result["type"] = library_type
    if error:
        result["error"] = error
    print(json.dumps(result))


if __name__ == "__main__":
    main()
