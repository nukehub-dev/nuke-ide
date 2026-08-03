#!/usr/bin/env python3
"""Read the material-name -> XS-data-name mapping from an existing MGXS library.

This lets the IDE convert a project whose settings already point at an MGXS
library without re-running the continuous-energy generation step.

Usage:
    python read_mgxs_data_names.py <mgxs_library.h5>

Output:
    JSON object: {"success": true, "xsDataNames": [{"materialName": "...", "xsDataName": "..."}, ...]}
"""

import json
import sys
from pathlib import Path


def read_mapping(mgxs_path: str):
    """Return material-name / XS-data-name pairs from the top-level HDF5 groups.

    Args:
        mgxs_path: Path to an existing MGXS library (usually mgxs.h5).

    Returns:
        Tuple (success, list_of_mappings_or_none, error_message_or_none).
    """
    try:
        import h5py
    except ImportError as e:
        return False, None, f"h5py is required to read MGXS libraries: {e}"

    path = Path(mgxs_path)
    if not path.exists():
        return False, None, f"MGXS library not found: {mgxs_path}"

    try:
        with h5py.File(path, "r") as f:
            names = list(f.keys())
        mapping = [{"materialName": name, "xsDataName": name} for name in names]
        return True, mapping, None
    except Exception as e:
        return False, None, str(e)


def main():
    """Entry point: parse path and print the JSON result."""
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"success": False, "error": "Usage: read_mgxs_data_names.py <mgxs_library.h5>"}
            )
        )
        sys.exit(1)

    success, mapping, error = read_mapping(sys.argv[1])
    result = {"success": success, "xsDataNames": mapping if mapping else []}
    if error:
        result["error"] = error
    print(json.dumps(result))


if __name__ == "__main__":
    main()
