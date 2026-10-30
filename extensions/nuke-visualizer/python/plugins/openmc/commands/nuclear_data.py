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


def _dose_table_catalog():
    """Return the OpenMC dose-table catalog keyed by (source, quantity, particle).

    The table map is OpenMC's own source of truth for which particles and
    irradiation geometries exist; importing it avoids a hard-coded copy in the
    viewer. Falls back to the documented neutron/photon set when a future
    OpenMC release renames the private map.
    """
    import openmc.data.dose.dose as dose_module

    tables = getattr(dose_module, "_TABLES", None)
    if tables is None:
        return {
            ("icrp74", "effective", "neutron"): ("AP", "PA", "LLAT", "RLAT", "ROT", "ISO"),
            ("icrp74", "effective", "photon"): ("AP", "PA", "LLAT", "RLAT", "ROT", "ISO"),
            ("icrp74", "ambient", "neutron"): (),
            ("icrp74", "ambient", "photon"): (),
            ("icrp116", "effective", "neutron"): ("AP", "PA", "LLAT", "RLAT", "ROT", "ISO"),
            ("icrp116", "effective", "photon"): ("AP", "PA", "LLAT", "RLAT", "ROT", "ISO"),
        }
    return {key: tuple(columns) if columns else () for key, (_path, columns) in tables.items()}


def read_dose_coefficients(particle, data_source, dose_quantity, geometry):
    """Read OpenMC's shipped ICRP dose-response coefficients.

    Returns the energy grid [eV] and coefficients (pSv cm^2, or Sv/Gy for
    photon kerma). The available particle and geometry lists come from the
    same table catalog so the UI never offers an unsupported combination.
    """
    import openmc.data

    catalog = _dose_table_catalog()
    available_particles = sorted(
        particle_name
        for (source, quantity, particle_name) in catalog
        if source == data_source and quantity == dose_quantity
    )
    geometries = list(catalog.get((data_source, dose_quantity, particle), ()))
    if not geometries or dose_quantity == "ambient":
        geometries = ["AP"]

    if particle not in available_particles:
        raise ValueError(
            f"'{particle}' has no {dose_quantity} dose data in {data_source}. "
            f"Available particles: {', '.join(available_particles)}"
        )
    if geometry not in geometries:
        raise ValueError(
            f"Geometry {geometry} is not defined for {particle} {dose_quantity} "
            f"dose in {data_source}. Available geometries: {', '.join(geometries)}"
        )

    energy, response = openmc.data.dose_coefficients(particle, geometry, data_source, dose_quantity)
    units = "Sv/Gy" if particle == "photon kerma" else "pSv cm^2"
    return {
        "success": True,
        "particle": particle,
        "dataSource": data_source,
        "doseQuantity": dose_quantity,
        "geometry": geometry,
        "energyEv": [float(value) for value in energy],
        "response": [float(value) for value in response],
        "units": units,
        "availableParticles": available_particles,
        "availableGeometries": geometries,
    }


@command("openmc.dose-coefficients", help="Read ICRP dose conversion coefficients")
@arg(
    "--particle",
    default="photon",
    help="Incident particle (for example photon, neutron, electron, proton)",
)
@arg(
    "--data-source",
    choices=["icrp74", "icrp116"],
    default="icrp116",
    help="ICRP data source",
)
@arg(
    "--dose-quantity",
    choices=["effective", "ambient"],
    default="effective",
    help="Effective dose or ambient dose equivalent H*(10)",
)
@arg(
    "--geometry",
    default="AP",
    help="Irradiation geometry for effective dose (AP, PA, LLAT, RLAT, ROT, ISO)",
)
def cmd_dose_coefficients(args):
    """Read a dose-coefficient reference table (read-only nuclear data)."""
    try:
        result = read_dose_coefficients(
            args.particle, args.data_source, args.dose_quantity, args.geometry
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        payload = {"success": False, "error": str(e)}
        try:
            catalog = _dose_table_catalog()
            payload["availableParticles"] = sorted(
                particle
                for (source, quantity, particle) in catalog
                if source == args.data_source and quantity == args.dose_quantity
            )
        except Exception:
            pass
        print(json.dumps(payload))
        return 1


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
