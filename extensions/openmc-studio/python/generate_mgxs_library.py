#!/usr/bin/env python3
"""
OpenMC Fine-Grained MGXS Library Generator (manual openmc.mgxs.Library mode)

Builds a multi-group cross-section library with the openmc.mgxs.Library API —
the same machinery ``Model.convert_to_multigroup`` wraps (model.py:1944), but
with user control over the cross-section types, spatial domains, nuclide
decomposition, Legendre order, and estimator.

Flow: load the model from the working-directory XML, build an
``openmc.mgxs.Library`` with the requested ``mgxs_types``/domains, construct
its tallies, run the continuous-energy transport, post-process from the
statepoint, convert each domain to ``openmc.XSdata``, and write an
``openmc.MGXSLibrary`` HDF5 file (the format OpenMC's multi-group mode reads
via OPENMC_MG_CROSS_SECTIONS).

Usage:
    python generate_mgxs_library.py <working_directory> [options]

Options:
    --groups STRUCTURE     Group structure name (e.g. CASMO-2, XMAS-172) or
                           comma-separated group edges in eV (default CASMO-2)
    --mgxs-types LIST      Comma-separated cross-section types (default the
                           random-ray set). Valid values: openmc.mgxs.MGXS_TYPES
    --domain-type TYPE     material | cell | universe (default material)
    --domain-ids LIST      Comma-separated domain IDs (default: all domains of
                           the domain type)
    --by-nuclide           Compute cross sections per nuclide in each domain
    --nuclide-wise         Export one micro XSdata set per nuclide (named after
                           the nuclide) instead of one macro set per domain.
                           Implies --by-nuclide; requires material domains.
                           Produces the library format nuclide-decomposed
                           multi-group materials need (e.g. random ray + DAGMC)
    --legendre-order N     Legendre order for scattering matrices (default 0)
    --estimator TYPE       Tally estimator override (analog, tracklength, collision)
    --correction TYPE      Transport correction: none | P0 (default none)
    --particles N          Particles per generation for the generation run
    --output PATH          Output MGXS library path (default mgxs.h5)

Progress streams to stderr; exactly one JSON object is printed to stdout.
"""

import argparse
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

DEFAULT_MGXS_TYPES = ["total", "absorption", "fission", "nu-fission", "chi", "scatter matrix"]


def log_progress(message: str):
    """Print progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def _json_safe(obj):
    """Fallback JSON encoder for numpy scalars/arrays (without importing numpy).

    Args:
        obj: Object that failed default JSON serialization.

    Returns:
        A JSON-serializable equivalent.
    """
    if hasattr(obj, "item"):
        return obj.item()
    if hasattr(obj, "tolist"):
        return obj.tolist()
    return str(obj)


def load_model(working_dir):
    """Load materials, geometry, and settings from XML files.

    Args:
        working_dir: Directory containing materials.xml, geometry.xml, settings.xml.

    Returns:
        Tuple of (openmc.Model, materials, geometry, settings).
    """
    import openmc

    materials = openmc.Materials.from_xml("materials.xml")
    geometry = openmc.Geometry.from_xml("geometry.xml", materials)
    settings = openmc.Settings.from_xml("settings.xml")
    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)
    return model, materials, geometry, settings


def sync_dagmc_materials(model, working_dir):
    """Synchronize DAGMC universes so their materials resolve as MGXS domains.

    Mirrors ``Model.convert_to_multigroup``: on DAGMC geometries the materials
    live inside the .h5m file, and ``geometry.get_all_materials()`` is empty
    until the DAGMC universes are synced through the C API (the synced cells
    survive in memory, so the transport run tallies per-material correctly).

    Args:
        model: The loaded openmc.Model.
        working_dir: Directory containing the model XML files.
    """
    import openmc

    dagmc_universe_cls = getattr(openmc, "DAGMCUniverse", None)
    if dagmc_universe_cls is None or not any(
        isinstance(univ, dagmc_universe_cls) for univ in model.geometry.get_all_universes().values()
    ):
        return

    # Mirrors the dense CATEGORY tag to the sparse layout OpenMC 0.15.x
    # introspects (see generate_mgxs._fix_dagmc_category_tags)
    from generate_mgxs import _fix_dagmc_category_tags

    _fix_dagmc_category_tags(Path(working_dir))

    original_run_mode = model.settings.run_mode
    model.settings.run_mode = "volume"
    with tempfile.TemporaryDirectory() as tmpdir:
        model.init_lib(directory=tmpdir, output=False)
        model.sync_dagmc_universes()
        model.finalize_lib()
    model.settings.run_mode = original_run_mode
    log_progress("Synchronized DAGMC universes with the model materials")


def resolve_domains(geometry, domain_type, domain_ids):
    """Resolve domain IDs to geometry domains for the Library.

    Args:
        geometry: The loaded openmc.Geometry.
        domain_type: 'material' | 'cell' | 'universe'.
        domain_ids: List of domain IDs, or empty for all domains of the type.

    Returns:
        List of openmc.Material, openmc.Cell, or openmc.Universe domains.

    Raises:
        ValueError: If a requested domain ID does not exist.
    """
    if domain_type == "material":
        available = geometry.get_all_materials()
    elif domain_type == "cell":
        available = geometry.get_all_cells()
    elif domain_type == "universe":
        available = geometry.get_all_universes()
    else:
        raise ValueError(f"Unsupported domain type '{domain_type}' (material | cell | universe)")

    if not domain_ids:
        domains = list(available.values())
        if not domains:
            raise ValueError(f"No domains of type '{domain_type}' exist in the model")
        return domains

    domains = []
    missing = []
    for domain_id in domain_ids:
        domain = available.get(domain_id)
        if domain is None:
            missing.append(domain_id)
        else:
            domains.append(domain)
    if missing:
        raise ValueError(f"{domain_type.capitalize()} domain(s) not found: {missing}")
    return domains


def export_nuclide_wise(library, domains, groups, output):
    """Export one micro XSdata set per nuclide, named after the nuclide.

    Nuclide-decomposed multi-group materials (the only form random ray
    accepts on DAGMC geometries) resolve each ``<nuclide>`` against an XSdata
    set of the same name holding MICRO cross sections (barns) — unlike
    material-wise libraries, which hold one macro set per material.

    A nuclide shared by several domains gets a single XSdata set, condensed
    over the domain where it has the highest atom density (the most
    representative flux spectrum for that nuclide).

    Args:
        library: The openmc.mgxs.Library after load_from_statepoint.
        domains: Material domains the library was tallied over.
        groups: The energy group structure.
        output: Output MGXS library path.

    Returns:
        Tuple of (openmc.MGXSLibrary, sorted list of exported nuclide names).
    """
    import openmc

    # Pick the winning domain per nuclide (highest atom density)
    winners = {}
    for domain in domains:
        for nuclide, density in domain.get_nuclide_atom_densities().items():
            if nuclide not in winners or density > winners[nuclide][0]:
                winners[nuclide] = (density, domain)

    mgxs_file = openmc.MGXSLibrary(energy_groups=groups)
    exported = []
    for nuclide in sorted(winners):
        density, domain = winners[nuclide]
        # get_xsdata appends '_<nuclide>' to the name when nuclide != 'total';
        # the data set must be named exactly after the nuclide
        xsdata = library.get_xsdata(
            domain=domain, xsdata_name=nuclide, nuclide=nuclide, xs_type="micro"
        )
        xsdata.name = nuclide
        mgxs_file.add_xsdata(xsdata)
        exported.append(nuclide)
        log_progress(f"  {nuclide}: condensed over material {domain.id} ({density:.3e} atom/b-cm)")

    return mgxs_file, exported


def run_generate_mgxs_library(args):
    """Build a fine-grained MGXS library with the openmc.mgxs.Library API.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Result dictionary with the output path and configuration summary.

    Raises:
        FileNotFoundError: If the working directory lacks XML inputs.
        ValueError: For invalid mgxs types or domain specifications.
    """
    import openmc
    import openmc.mgxs

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    for required in ("materials.xml", "geometry.xml", "settings.xml"):
        if not (working_dir / required).exists():
            raise FileNotFoundError(
                f"{required} not found in {working_dir} — generate XML inputs first"
            )

    # Group structure: named structure or explicit edges
    groups_arg = args.groups or "CASMO-2"
    if groups_arg in openmc.mgxs.GROUP_STRUCTURES:
        groups = openmc.mgxs.EnergyGroups(groups_arg)
    else:
        try:
            edges = [float(v.strip()) for v in groups_arg.split(",")]
        except ValueError as e:
            raise ValueError(
                f"Unknown group structure '{groups_arg}' — use a name from openmc.mgxs.GROUP_STRUCTURES or comma-separated edges"
            ) from e
        if len(edges) < 2:
            raise ValueError("Explicit group edges need at least two values")
        groups = openmc.mgxs.EnergyGroups(edges)

    # MGXS types, validated against the verified list
    mgxs_types = [
        t.strip() for t in (args.mgxs_types.split(",") if args.mgxs_types else DEFAULT_MGXS_TYPES)
    ]
    valid = set(openmc.mgxs.MGXS_TYPES)
    invalid = [t for t in mgxs_types if t not in valid]
    if invalid:
        raise ValueError(f"Invalid mgxs type(s): {invalid}. Valid: {sorted(valid)}")

    # XSdata conversion requires a nu-scatter matrix for the scattering data
    # and prefers a multiplicity matrix for the multiplication correction
    # (library.py get_xsdata, lines ~1197-1250) — ensure both are present
    appended = []
    if not any("nu-scatter matrix" in t for t in mgxs_types):
        mgxs_types.append("consistent nu-scatter matrix")
        appended.append("consistent nu-scatter matrix")
    if "multiplicity matrix" not in mgxs_types:
        mgxs_types.append("multiplicity matrix")
        appended.append("multiplicity matrix")
    if appended:
        log_progress(f"Added required XS types for XSdata conversion: {', '.join(appended)}")

    log_progress(f"Loading OpenMC model from {working_dir}")
    model, materials, geometry, settings = load_model(working_dir)
    sync_dagmc_materials(model, working_dir)

    domains = resolve_domains(
        geometry,
        args.domain_type,
        [int(v) for v in args.domain_ids.split(",")] if args.domain_ids else [],
    )

    # Nuclide-wise export needs per-nuclide tallies over material domains
    nuclide_wise = getattr(args, "nuclide_wise", False)
    if nuclide_wise and args.domain_type != "material":
        raise ValueError(
            "nuclide-wise libraries require material domains "
            "(each nuclide's cross sections are condensed over a material)"
        )
    by_nuclide = args.by_nuclide or nuclide_wise

    # Build the Library (manual mode of the convert_to_multigroup machinery)
    library = openmc.mgxs.Library(geometry, by_nuclide=by_nuclide, mgxs_types=mgxs_types)
    library.energy_groups = groups
    library.domain_type = args.domain_type
    library.domains = domains
    library.correction = args.correction if args.correction != "none" else None
    library.legendre_order = args.legendre_order
    if args.estimator:
        library.estimator = args.estimator

    if args.particles:
        model.settings.particles = args.particles

    domain_desc = ", ".join(f"{args.domain_type} {d.id}" for d in domains)
    log_progress(
        f"Building MGXS library: {len(mgxs_types)} types over [{domain_desc}], "
        f"{groups.num_groups} groups, by_nuclide={by_nuclide}, legendre_order={args.legendre_order}"
    )
    library.build_library()

    # Add the library's tallies to the model and run the transport
    model.tallies = openmc.Tallies()
    library.add_to_tallies(model.tallies, merge=True)

    log_progress("Running continuous-energy transport for MGXS generation...")
    statepoint = model.run(cwd=working_dir)

    log_progress(f"Loading tally data from {statepoint}")
    with openmc.StatePoint(statepoint) as sp:
        library.load_from_statepoint(sp)

    # Convert each domain to XSdata and write the MGXSLibrary file
    output = working_dir / args.output
    nuclides = None
    if nuclide_wise:
        log_progress("Exporting nuclide-wise micro XS data sets...")
        mgxs_file, nuclides = export_nuclide_wise(library, domains, groups, output)
    else:
        mgxs_file = openmc.MGXSLibrary(energy_groups=groups)
        for domain in domains:
            name = getattr(domain, "name", None) or f"{args.domain_type}_{domain.id}"
            xsdata = library.get_xsdata(domain=domain, xsdata_name=name)
            mgxs_file.add_xsdata(xsdata)
    mgxs_file.export_to_hdf5(output)
    log_progress(f"MGXS library written to {output}")

    return {
        "success": True,
        "mgxsPath": str(output),
        "mgxsTypes": mgxs_types,
        "domainType": args.domain_type,
        "domainIds": [d.id for d in domains],
        "byNuclide": by_nuclide,
        "nuclideWise": nuclide_wise,
        "libraryType": "nuclide" if nuclide_wise else "material",
        "nuclides": nuclides,
        "legendreOrder": args.legendre_order,
        "estimator": args.estimator,
        "groups": groups_arg,
        "statepoint": str(statepoint),
    }


def main():
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(
        description="Generate a fine-grained MGXS library with openmc.mgxs.Library",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--groups", default="CASMO-2", help="Group structure name or comma-separated edges in eV"
    )
    parser.add_argument(
        "--mgxs-types", help=f"Comma-separated XS types (default: {','.join(DEFAULT_MGXS_TYPES)})"
    )
    parser.add_argument(
        "--domain-type", default="material", choices=["material", "cell", "universe"]
    )
    parser.add_argument(
        "--domain-ids", help="Comma-separated domain IDs (default: all of the domain type)"
    )
    parser.add_argument(
        "--by-nuclide", action="store_true", help="Compute cross sections per nuclide"
    )
    parser.add_argument(
        "--nuclide-wise",
        action="store_true",
        help="Export one micro XSdata set per nuclide (implies --by-nuclide)",
    )
    parser.add_argument(
        "--legendre-order", type=int, default=0, help="Legendre order for scattering matrices"
    )
    parser.add_argument(
        "--estimator",
        choices=["analog", "tracklength", "collision"],
        help="Tally estimator override",
    )
    parser.add_argument(
        "--correction", default="none", choices=["none", "P0"], help="Transport correction"
    )
    parser.add_argument(
        "--particles", type=int, help="Particles per generation for the generation run"
    )
    parser.add_argument("--output", default="mgxs.h5", help="Output MGXS library path")

    args = parser.parse_args()

    try:
        result = run_generate_mgxs_library(args)
        print(json.dumps(result, default=_json_safe))
        return 0
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
