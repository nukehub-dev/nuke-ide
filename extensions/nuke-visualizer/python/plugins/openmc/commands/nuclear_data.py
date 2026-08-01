"""Nuclear data inspection commands (read-only).

- ``openmc.nuclear-data-library`` summarizes a cross_sections.xml data
  library: library path, nuclide count, and per-nuclide entries (name, file
  path, temperature count, reaction count). Per-file metadata is read cheaply
  from HDF5 group keys (``kTs`` temperatures, ``reactions``) — full
  IncidentNeutron parsing of hundreds of files would take minutes. When
  ``--cross-sections`` is omitted the path resolves via
  ``openmc.config['cross_sections']`` / OPENMC_CROSS_SECTIONS.
- ``openmc.nuclear-data-nuclide`` reports detail for a single HDF5 data file
  via ``openmc.data.IncidentNeutron.from_hdf5``: temperatures, reaction MT
  list (with REACTION_NAME labels), and the fission flag.
"""

import json
import os

from nuke_viz.plugin import arg, command

# MT numbers that mark fission channels (openmc/data/neutron.py FISSION_MTS)
FISSION_MTS = {18, 19, 20, 21, 38}


def _cheap_file_metadata(path):
    """Read temperature keys and reaction count from an HDF5 file cheaply.

    Uses group keys only (no IncidentNeutron parse): the nuclide group is the
    file's first group, kTs holds one entry per temperature, reactions one
    group per reaction. Returns (sorted temperature keys, reaction count);
    empty values on any read problem.
    """
    import h5py

    try:
        with h5py.File(str(path), "r") as f:
            group = list(f.values())[0]
            temps = sorted(group["kTs"].keys()) if "kTs" in group else []
            reactions = len(group["reactions"]) if "reactions" in group else 0
            return temps, reactions
    except Exception:
        return [], 0


def read_data_library(cross_sections=None):
    """Summarize a cross_sections.xml data library.

    Raises ValueError when no path is given and openmc.config has none set,
    FileNotFoundError when the resolved cross_sections.xml is missing.
    """
    xs_path = cross_sections
    if xs_path is None:
        # Config resolution needs openmc (falls back to OPENMC_CROSS_SECTIONS)
        import openmc

        xs_path = openmc.config.get("cross_sections")
    if xs_path is None:
        raise ValueError("No cross_sections.xml given and openmc.config['cross_sections'] is unset")
    xs_path = os.path.abspath(str(xs_path))
    if not os.path.exists(xs_path):
        raise FileNotFoundError(f"cross_sections.xml not found: {xs_path}")

    # Heavy import only after the path is validated
    import openmc.data

    library = openmc.data.DataLibrary.from_xml(str(xs_path))

    nuclides = []
    for entry in library.libraries:
        if "neutron" not in entry["type"] or not entry["materials"]:
            continue
        file_path = entry["path"]
        temps, reaction_count = (
            _cheap_file_metadata(file_path) if os.path.exists(file_path) else ([], 0)
        )
        nuclides.append(
            {
                "name": entry["materials"][0],
                "path": file_path,
                "temperatureCount": len(temps),
                "temperatures": temps,
                "reactionCount": reaction_count,
            }
        )

    nuclides.sort(key=lambda n: n["name"])

    return {
        "success": True,
        "libraryPath": str(xs_path),
        "nuclideCount": len(nuclides),
        "nuclides": nuclides,
    }


def read_nuclide_detail(path):
    """Detail for a single HDF5 data file via IncidentNeutron.from_hdf5.

    Raises FileNotFoundError when the file is missing.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Nuclear data file not found: {path}")

    # Heavy import only after the path is validated
    import openmc.data

    data = openmc.data.IncidentNeutron.from_hdf5(path)

    reactions = [
        {"mt": mt, "label": openmc.data.REACTION_NAME.get(mt, f"MT {mt}")}
        for mt in sorted(data.reactions.keys())
    ]
    fission = data.fission_energy is not None or any(mt in FISSION_MTS for mt in data.reactions)

    return {
        "success": True,
        "name": data.name,
        "path": os.path.abspath(path),
        "temperatures": list(data.temperatures),
        "reactionCount": len(reactions),
        "reactions": reactions,
        "fission": fission,
    }


@command("openmc.nuclear-data-library", help="Summarize a cross_sections.xml data library")
@arg("--cross-sections", help="Path to cross_sections.xml (default: openmc.config)")
def cmd_nuclear_data_library(args):
    """Summarize the configured cross-section data library."""
    from plugins.openmc.lib import output_readers

    try:
        result = read_data_library(args.cross_sections)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return 1


@command("openmc.nuclear-data-nuclide", help="Detail for a single HDF5 nuclear data file")
@arg("file", help="Path to the HDF5 data file")
def cmd_nuclear_data_nuclide(args):
    """Report reaction/temperature detail for one nuclear data file."""
    from plugins.openmc.lib import output_readers

    try:
        result = read_nuclide_detail(args.file)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return 1
