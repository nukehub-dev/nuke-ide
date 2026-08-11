#!/usr/bin/env python3
"""OpenMC MGXS Library Generator.

Wraps ``Model.convert_to_multigroup()`` to generate a multi-group cross
section library from a model exported as XML files, optionally followed by
``Model.convert_to_random_ray()``. Progress is streamed to stderr; exactly
one JSON result object is printed to stdout.

Usage:
    python generate_mgxs.py <working_directory> [options]

Options:
    --method METHOD           Generation method: material_wise (default), stochastic_slab, infinite_medium
    --groups GROUPS           Energy group structure name (default CASMO-2)
    --particles N             Particles for the generation runs (default 2000)
    --correction CORRECTION   Transport correction: P0 or none (default none)
    --temperatures TEMPS      Comma-separated temperatures in K for MGXS generation
    --output PATH             Output MGXS library path (default mgxs.h5)
    --random-ray              Also convert the model to random ray and re-export settings.xml
    --nuclide-wise            Generate a nuclide-wise library (one micro XSdata set
                              per nuclide) instead of a material-wise one. Required
                              for random ray on DAGMC geometries, which rejects
                              macroscopic multi-group materials. Delegates to
                              generate_mgxs_library.py (openmc.mgxs.Library API);
                              --method does not apply.
"""

import argparse
import json
import os
import sys
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace


def log_progress(message: str):
    """Print a progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def read_model_compatibility(working_dir: Path):
    """Check the model is continuous-energy with nuclide-decomposed materials.

    MGXS generation runs continuous-energy transport solves with per-nuclide
    reaction tallies. A multi-group settings.xml or macroscopic materials
    cannot work — and in DAGMC/C-API runs libopenmc fatals with a C-level
    exit that bypasses Python exceptions entirely, so this must be guarded
    BEFORE the openmc import (standard library only).

    Args:
        working_dir: Directory containing settings.xml and materials.xml.

    Returns:
        Error message string when incompatible, else None.
    """
    settings_path = working_dir / "settings.xml"
    if settings_path.exists():
        elem = ET.parse(settings_path).getroot().find("energy_mode")
        if elem is not None and elem.text and elem.text.strip() == "multi-group":
            return (
                "MGXS generation requires a continuous-energy model with "
                "nuclide-decomposed materials (this model is multigroup)."
            )
    materials_path = working_dir / "materials.xml"
    if materials_path.exists():
        names = [
            m.get("name") or m.get("id") or "?"
            for m in ET.parse(materials_path).getroot().findall("material")
            if m.find("macroscopic") is not None
        ]
        if names:
            return (
                "MGXS generation requires a continuous-energy model with "
                f"nuclide-decomposed materials (this model has macroscopic materials: {', '.join(names)})."
            )
    return None


def _resolve_dagmc_file(working_dir: Path) -> Path | None:
    """Find the DAGMC .h5m file referenced by geometry.xml, if any.

    Args:
        working_dir: Directory containing geometry.xml.

    Returns:
        Path to the referenced .h5m file, or None if no DAGMC geometry is used.
    """
    geometry_path = working_dir / "geometry.xml"
    if not geometry_path.exists():
        return None
    try:
        root = ET.parse(geometry_path).getroot()
        dagmc_elem = root.find(".//dagmc_universe")
        if dagmc_elem is not None:
            filename = dagmc_elem.get("filename")
            if filename:
                return working_dir / filename
    except Exception:
        pass
    return None


def _fix_dagmc_category_tags(working_dir: Path) -> None:
    """Work around OpenMC 0.15.x reading old MOAB sparse tag layout.

    Some newer MOAB versions store the CATEGORY tag as a dense set tag
    (``tstt/sets/tags/CATEGORY``) instead of the sparse tag layout OpenMC
    0.15.3's ``dagmc.py`` expects (``tstt/tags/CATEGORY/{id_list,values}``).
    When the latter is missing, ``model.convert_to_multigroup()`` fails with
    ``KeyError: Unable to synchronously open object (object 'values' doesn't
    exist)``. This helper mirrors the dense tag back to the sparse path so
    OpenMC can introspect the DAGMC model.

    Args:
        working_dir: Directory containing geometry.xml and the DAGMC .h5m file.
    """
    dagmc_path = _resolve_dagmc_file(working_dir)
    if dagmc_path is None or not dagmc_path.exists():
        return

    try:
        import h5py
        import numpy as np
    except Exception:
        # h5py/numpy may not be installed in minimal test environments.
        return

    try:
        with h5py.File(dagmc_path, "a") as f:
            # Already has the layout OpenMC expects.
            if "tstt/tags/CATEGORY/values" in f:
                return

            # No dense CATEGORY tag to mirror.
            if "tstt/sets/tags/CATEGORY" not in f:
                return

            sets_list = f["tstt/sets/list"][()]
            set_ids = sets_list[:, 0].astype(np.uint64)
            cat_values = f["tstt/sets/tags/CATEGORY"][()]

            cat_group = f["tstt/tags/CATEGORY"]
            cat_group.create_dataset("id_list", data=set_ids)
            cat_group.create_dataset("values", data=cat_values)

            log_progress(f"Mirrored dense CATEGORY tag to sparse layout in {dagmc_path.name}")
    except Exception as e:
        log_progress(f"Warning: Could not fix DAGMC CATEGORY tags: {e}")


def load_model(working_dir: Path):
    """Load materials, geometry, and settings from XML files in the working directory.

    Args:
        working_dir: Directory containing materials.xml, geometry.xml, and settings.xml.

    Returns:
        Tuple of (materials, geometry, settings).
    """
    import openmc

    _fix_dagmc_category_tags(working_dir)

    materials = openmc.Materials.from_xml("materials.xml")
    geometry = openmc.Geometry.from_xml("geometry.xml", materials)

    meshes = {}
    tallies_path = working_dir / "tallies.xml"
    if tallies_path.exists():
        try:
            tallies_root = ET.parse(tallies_path).getroot()
            for mesh_elem in tallies_root.findall("mesh"):
                mesh_type = mesh_elem.get("type")
                mesh_id = int(mesh_elem.get("id"))
                if mesh_type == "regular":
                    mesh = openmc.RegularMesh.from_xml_element(mesh_elem)
                elif mesh_type == "cylindrical":
                    mesh = openmc.CylindricalMesh.from_xml_element(mesh_elem)
                elif mesh_type == "spherical":
                    mesh = openmc.SphericalMesh.from_xml_element(mesh_elem)
                else:
                    continue
                meshes[mesh_id] = mesh
        except Exception as e:
            log_progress(f"Warning: Could not load meshes from tallies.xml: {e}")

    settings_root = ET.parse(working_dir / "settings.xml").getroot()
    settings = openmc.Settings.from_xml_element(settings_root, meshes)

    return materials, geometry, settings


def _call_with_supported_kwargs(fn, **kwargs):
    """Call fn with only the kwargs its signature accepts (version tolerance).

    Post-0.15.3 ``convert_to_multigroup`` gained ``temperatures`` and
    ``overwrite_mgxs_library``; release 0.15.3 rejects them. Dropped keys are
    reported instead of crashing on old versions.
    """
    import inspect

    params = inspect.signature(fn).parameters.values()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params):
        return fn(**kwargs)
    supported = {p.name for p in params}
    accepted = {key: value for key, value in kwargs.items() if key in supported}
    dropped = sorted(set(kwargs) - set(accepted))
    if dropped:
        log_progress(
            f"Note: this OpenMC version ignores unsupported convert kwargs: {', '.join(dropped)}"
        )
    return fn(**accepted)


def _run_nuclide_wise(args, working_dir: Path):
    """Generate a nuclide-wise MGXS library via generate_mgxs_library.

    Nuclide-decomposed multi-group materials (the only material form random
    ray accepts on DAGMC geometries) need a library with one micro XSdata set
    per nuclide — convert_to_multigroup cannot produce that, so this path
    delegates to the openmc.mgxs.Library machinery (single code path for
    nuclide-wise libraries).

    Args:
        args: Parsed command-line arguments.
        working_dir: Absolute working directory containing the model XML files.

    Returns:
        Result dictionary in the same shape as run_generate_mgxs.
    """
    import generate_mgxs_library

    lib_args = SimpleNamespace(
        working_directory=str(working_dir),
        groups=args.groups,
        mgxs_types=None,
        domain_type="material",
        domain_ids=None,
        by_nuclide=True,
        nuclide_wise=True,
        legendre_order=0,
        estimator=None,
        correction=args.correction,
        particles=args.particles,
        output=args.output,
    )
    result = generate_mgxs_library.run_generate_mgxs_library(lib_args)

    random_ray_applied = False
    if args.random_ray:
        import openmc

        log_progress("Converting model to random ray...")
        materials, geometry, settings = load_model(working_dir)
        model = openmc.Model(geometry=geometry, materials=materials, settings=settings)
        # convert_to_random_ray requires multi-group energy mode. The
        # nuclide-wise path keeps materials nuclide-decomposed (no
        # convert_to_multigroup, which would also macroscopic-ify them),
        # so switch only the energy mode setting before converting.
        model.settings.energy_mode = "multi-group"
        model.convert_to_random_ray()
        model.settings.export_to_xml()
        random_ray_applied = True
        log_progress("Random ray settings exported to settings.xml")

    return {
        "success": True,
        "mgxsPath": result["mgxsPath"],
        "method": "nuclide_wise",
        "groups": args.groups,
        "nuclideWise": True,
        "libraryType": "nuclide",
        "nuclides": result.get("nuclides"),
        "randomRayApplied": random_ray_applied,
    }


def run_generate_mgxs(args):
    """Generate the MGXS library (and optionally convert to random ray).

    Args:
        args: Parsed command-line arguments.

    Returns:
        Dictionary with the output library path and conversion details.
    """
    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    if getattr(args, "nuclide_wise", False):
        log_progress("Generating a nuclide-wise MGXS library (openmc.mgxs.Library path)")
        return _run_nuclide_wise(args, working_dir)

    import openmc

    log_progress(f"Loading OpenMC model from {working_dir}")
    materials, geometry, settings = load_model(working_dir)

    model = openmc.Model(geometry=geometry, materials=materials, settings=settings)

    temperatures = None
    if args.temperatures:
        temperatures = [float(t.strip()) for t in args.temperatures.split(",")]

    correction = args.correction if args.correction != "none" else None

    convert_kwargs = {
        "method": args.method,
        "groups": args.groups,
        "mgxs_path": args.output,
        "overwrite_mgxs_library": True,
        "correction": correction,
        "temperatures": temperatures,
    }
    if args.particles:
        convert_kwargs["nparticles"] = args.particles

    log_progress(
        f"Generating MGXS library: method={args.method}, groups={args.groups}, output={args.output}"
    )
    log_progress("This runs continuous-energy Monte Carlo simulations and may take a while...")
    _call_with_supported_kwargs(model.convert_to_multigroup, **convert_kwargs)
    log_progress(f"MGXS library written to {args.output}")

    random_ray_applied = False
    if args.random_ray:
        log_progress("Converting model to random ray...")
        model.convert_to_random_ray()
        model.settings.export_to_xml()
        random_ray_applied = True
        log_progress("Random ray settings exported to settings.xml")

    return {
        "success": True,
        "mgxsPath": str(working_dir / args.output),
        "method": args.method,
        "groups": args.groups,
        "nuclideWise": False,
        "libraryType": "material",
        "randomRayApplied": random_ray_applied,
    }


def main():
    """Entry point: parse arguments, generate the library, print JSON result."""
    parser = argparse.ArgumentParser(description="OpenMC MGXS library generator")
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--method",
        default="material_wise",
        choices=["material_wise", "stochastic_slab", "infinite_medium"],
        help="MGXS generation method",
    )
    parser.add_argument(
        "--groups", default="CASMO-2", help="Energy group structure name (e.g. CASMO-2, XMAS-172)"
    )
    parser.add_argument("--particles", type=int, help="Particles for the generation runs")
    parser.add_argument(
        "--correction", default="none", choices=["none", "P0"], help="Transport correction"
    )
    parser.add_argument("--temperatures", help="Comma-separated temperatures in K")
    parser.add_argument("--output", default="mgxs.h5", help="Output MGXS library path")
    parser.add_argument(
        "--random-ray", action="store_true", help="Also convert the model to random ray"
    )
    parser.add_argument(
        "--nuclide-wise",
        action="store_true",
        help="Generate a nuclide-wise library (one micro XSdata set per nuclide; "
        "required for random ray on DAGMC geometries)",
    )

    args = parser.parse_args()

    if not Path(args.working_directory).is_dir():
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Working directory not found: {args.working_directory}",
                }
            )
        )
        sys.exit(0)

    # Semantic guard, before any openmc import: MGXS generation is a
    # continuous-energy, per-nuclide workflow
    incompatible = read_model_compatibility(Path(args.working_directory))
    if incompatible:
        log_progress(f"FAILED: {incompatible}")
        print(json.dumps({"success": False, "error": incompatible}))
        sys.exit(1)

    try:
        result = run_generate_mgxs(args)
        print(json.dumps(result))
    except ImportError as e:
        print(
            json.dumps(
                {"success": False, "error": f"Missing dependency: {e}. Please install openmc."}
            )
        )
        sys.exit(0)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(0)


if __name__ == "__main__":
    main()
