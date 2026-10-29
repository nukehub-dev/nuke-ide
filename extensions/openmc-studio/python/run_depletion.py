#!/usr/bin/env python3
"""
OpenMC Depletion Runner

This script runs OpenMC depletion simulations using the Python API.
It is designed to be called from the OpenMC Studio simulation runner.

Usage:
    python run_depletion.py <working_directory> [options]

Options:
    --chain-file PATH       Path to depletion chain file
    --time-steps STEPS      Comma-separated time steps in seconds
    --power POWER           Power level in Watts
    --power-density DENSITY Power density in W/g (alternative to --power)
    --solver SOLVER         Depletion solver (cecm, predictor, cf4, celi, epc_rk4, leqi, si_celi, si_leqi)
    --operator TYPE         Operator type (coupled, independent, openmc)
    --substeps N            Number of substeps per timestep
    --normalization MODE    Transport normalization mode (source-rate, fission-q, energy-deposition)
    --mpi-processes N       Number of MPI processes (for coupled operator)
"""

import argparse
import json
import os
import sys
import traceback
from collections.abc import Iterable
from pathlib import Path

# Canonical solver ids are the OpenMC short names from
# openmc/deplete/integrators.py `integrator_by_name` (identical in 0.15.3 and
# the dev clone). Mirrored by src/common/depletion-solvers.ts.
SOLVER_CLASS_MAP = {
    "cecm": "CECMIntegrator",
    "predictor": "PredictorIntegrator",
    "cf4": "CF4Integrator",
    "celi": "CELIIntegrator",
    "epc_rk4": "EPCRK4Integrator",
    "leqi": "LEQIIntegrator",
    "si_celi": "SICELIIntegrator",
    "si_leqi": "SILEQIIntegrator",
}

# Legacy names accepted with a deprecation warning (pre-fix UI values and
# pre-fix driver ids); never emitted.
SOLVER_ALIASES = {
    "leapfrog": "leqi",
    "predictor-corrector": "predictor",
    "si-rk4": "si_celi",
    "ce-cm": "cecm",
    "epc": "epc_rk4",
    "cecmr": "cecm",
    "epcr": "epc_rk4",
    "si-cesc": "si_celi",
}


class DepletionConfigError(ValueError):
    """User-facing configuration error — reported as clean JSON, no traceback."""


def read_energy_mode(working_dir):
    """Read <energy_mode> from settings.xml using only the standard library.

    Args:
        working_dir: Path to the directory containing settings.xml.

    Returns:
        The energy mode text (e.g. 'continuous-energy', 'multi-group'), or
        None when settings.xml or the element is missing.
    """
    import xml.etree.ElementTree as ET

    settings_path = Path(working_dir) / "settings.xml"
    if not settings_path.exists():
        return None
    elem = ET.parse(settings_path).getroot().find("energy_mode")
    return elem.text.strip() if elem is not None and elem.text else None


def read_macroscopic_depletable_names(working_dir):
    """Names of depletable materials that are macroscopic (multigroup).

    Macroscopic materials carry cross-section SETS, not nuclides, so they can
    never deplete. Detected from materials.xml with only the standard library
    (`depletable="true"` attribute + a <macroscopic> child element).

    Args:
        working_dir: Path to the directory containing materials.xml.

    Returns:
        List of material names (empty when none / materials.xml missing).
    """
    import xml.etree.ElementTree as ET

    materials_path = Path(working_dir) / "materials.xml"
    if not materials_path.exists():
        return []
    names = []
    for mat in ET.parse(materials_path).getroot().findall("material"):
        if mat.get("depletable") == "true" and mat.find("macroscopic") is not None:
            names.append(mat.get("name") or mat.get("id") or "?")
    return names


def resolve_solver(value):
    """Map a --solver value to a canonical solver id (aliases → warning)."""
    solver = (value or "cecm").lower()
    if solver in SOLVER_CLASS_MAP:
        return solver
    if solver in SOLVER_ALIASES:
        canonical = SOLVER_ALIASES[solver]
        log_progress(f"Warning: solver '{solver}' is deprecated, use '{canonical}' instead")
        return canonical
    available = ", ".join(SOLVER_CLASS_MAP)
    raise ValueError(f"Unknown solver: {solver}. Available: {available}")


def get_integrator_class():
    """Return the OpenMC Integrator base class via the deplete package.

    Raises:
        ImportError: If the installed OpenMC does not expose the base class.
    """
    from openmc.deplete.abc import Integrator

    return Integrator


def supports_integrator_option(option):
    """Whether the installed Integrator constructor accepts a keyword option.

    This is a capability probe, not a version check.

    Args:
        option: Constructor keyword (e.g. ``substeps``).

    Returns:
        True when the installed OpenMC accepts the option.
    """
    import inspect

    try:
        params = inspect.signature(get_integrator_class().__init__).parameters
    except (ImportError, TypeError, ValueError):
        return False
    return option in params


def supports_integrator_method(method):
    """Whether the installed Integrator exposes a public method.

    Args:
        method: Method name (e.g. ``add_keff_search_control``).

    Returns:
        True when the method exists.
    """
    try:
        return hasattr(get_integrator_class(), method)
    except ImportError:
        return False


def parse_json_option(value, name):
    """Parse a JSON command-line option into a Python object.

    Args:
        value: Raw JSON string or None.
        name: Option name for the error message.

    Returns:
        Parsed value, or None when the option was not supplied.

    Raises:
        DepletionConfigError: If the option is not valid JSON.
    """
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError as e:
        raise DepletionConfigError(f"Invalid JSON for {name}: {e}") from e


def load_previous_results(path):
    """Load a previous depletion results file for operator restart.

    Args:
        path: Path to a previous ``depletion_results.h5``.

    Returns:
        An ``openmc.deplete.Results`` instance.

    Raises:
        DepletionConfigError: If the file is missing or cannot be read.
    """
    import openmc
    import openmc.deplete

    if not hasattr(openmc.deplete, "Results"):
        raise DepletionConfigError(
            "Continuation requires OpenMC 0.15.1 or newer "
            "(openmc.deplete.Results is unavailable in this environment)."
        )
    results_path = Path(path)
    if not results_path.exists():
        raise DepletionConfigError(
            f"Previous depletion results file not found: {path}. "
            "Select the depletion_results.h5 from the earlier run."
        )
    try:
        return openmc.deplete.Results(str(results_path))
    except Exception as e:
        raise DepletionConfigError(
            f"Could not read previous depletion results file {path}: {e}. "
            "Select a valid depletion_results.h5 produced by OpenMC."
        ) from e


def build_cell_translation_modifier(cell_id, axis):
    """Build an openmc.lib modifier that translates a cell along one axis.

    The function passed to ``add_keff_search_control`` must modify the model
    through ``openmc.lib``; it runs inside a temporary C-API session.

    Args:
        cell_id: Cell ID to translate.
        axis: 'x', 'y', or 'z'.

    Returns:
        Callable accepting the searched position value.
    """
    axis_index = {"x": 0, "y": 1, "z": 2}[axis]

    def modify(value):
        import openmc.lib

        cell = openmc.lib.cells[int(cell_id)]
        translation = list(cell.translation)
        translation[axis_index] = float(value)
        cell.translation = translation

    return modify


def build_nuclide_density_modifier(material_id, nuclide):
    """Build an openmc.lib modifier that replaces one nuclide density.

    Args:
        material_id: Material ID to modify.
        nuclide: Nuclide name (e.g. U235) whose atom/b-cm density is searched.

    Returns:
        Callable accepting the searched density value.
    """

    def modify(value):
        import openmc.lib

        lib_mat = openmc.lib.materials[int(material_id)]
        nuclides = list(lib_mat.nuclides)
        try:
            index = nuclides.index(nuclide)
        except ValueError as e:
            raise DepletionConfigError(
                f"Nuclide {nuclide} is not present in material {material_id} at runtime; "
                "choose a specific isotope that the material contains."
            ) from e
        densities = lib_mat.densities
        densities[index] = float(value)
        lib_mat.set_densities(nuclides, densities)

    return modify


def build_reactivity_modifier(control):
    """Create the openmc.lib model modifier for a curated control type."""
    parameter = control.get("parameter")
    if parameter == "cell-translation":
        axis = control.get("axis")
        if axis not in ("x", "y", "z"):
            raise DepletionConfigError(
                "Reactivity control needs an axis (x, y, or z) for a control-rod cell."
            )
        return build_cell_translation_modifier(control.get("cellId"), axis)
    if parameter == "nuclide-density":
        nuclide = control.get("nuclide")
        if not nuclide:
            raise DepletionConfigError(
                "Reactivity control needs a nuclide for a material density search."
            )
        return build_nuclide_density_modifier(control.get("materialId"), nuclide)
    raise DepletionConfigError(
        "Reactivity control parameter must be 'cell-translation' or 'nuclide-density'."
    )


def install_warn_on_search_failure(integrator):
    """Make a non-converged keff search log a warning instead of aborting.

    OpenMC's search controller raises ``ValueError`` on non-convergence. The
    public ``add_keff_search_control`` method installs that controller but has
    no failure callback, so this wraps its ``run`` method when the user chose
    ``onFailure='warn'``. The last searched parameter value remains in the
    model and the depletion step continues.

    Args:
        integrator: Integrator that has already been given a search control.
    """
    control = getattr(integrator, "_keff_search_control", None)
    if control is None:
        return
    original_run = control.run

    def tolerant_run(x):
        try:
            return original_run(x)
        except ValueError as e:
            log_progress(
                "Warning: reactivity search did not converge; continuing this step with "
                f"the last searched value ({e})"
            )
            return None

    control.run = tolerant_run


def apply_reactivity_control(integrator, control):
    """Attach a curated keff-search control to the integrator.

    Args:
        integrator: Depletion integrator.
        control: Parsed reactivity-control settings.

    Raises:
        DepletionConfigError: If the environment lacks the public API or the
            configuration is incomplete.
    """
    if not control or control.get("enabled") is False:
        return
    if not supports_integrator_method("add_keff_search_control"):
        raise DepletionConfigError(
            "Reactivity control requires OpenMC 0.16 or newer (Integrator.add_keff_search_control "
            "is unavailable in this environment)."
        )

    modifier = build_reactivity_modifier(control)
    x0 = control.get("x0")
    x1 = control.get("x1")
    bracket = control.get("bracket")
    if not isinstance(x0, (int, float)) or not isinstance(x1, (int, float)):
        raise DepletionConfigError("Reactivity control needs numeric x0 and x1 search guesses.")
    if not isinstance(bracket, (list, tuple)) or len(bracket) != 2:
        raise DepletionConfigError("Reactivity control bracket must be [min, max].")
    if bracket[0] >= bracket[1]:
        raise DepletionConfigError("Reactivity control bracket must be increasing.")
    if not (bracket[0] <= x0 <= bracket[1] and bracket[0] <= x1 <= bracket[1]):
        raise DepletionConfigError("Reactivity control guesses x0/x1 must lie inside the bracket.")
    if x0 == x1:
        raise DepletionConfigError("Reactivity control guesses x0/x1 must differ.")

    search_kwargs = {}
    if control.get("targetKeff") is not None:
        search_kwargs["target"] = float(control["targetKeff"])
    if control.get("kTol") is not None:
        search_kwargs["k_tol"] = float(control["kTol"])
    if control.get("sigmaFinal") is not None:
        search_kwargs["sigma_final"] = float(control["sigmaFinal"])
    if control.get("maxIterations") is not None:
        search_kwargs["maxiter"] = int(control["maxIterations"])

    label = control.get("parameter")
    if label == "cell-translation":
        label = f"cell {control.get('cellId')} {control.get('axis')}-translation"
    else:
        label = f"material {control.get('materialId')} {control.get('nuclide')} density"
    log_progress(
        f"Reactivity control: {label} (x0={x0}, x1={x1}, bracket={list(bracket)}, "
        f"target keff={search_kwargs.get('target', 1.0)})"
    )

    integrator.add_keff_search_control(
        modifier,
        x0=float(x0),
        x1=float(x1),
        bracket=[float(bracket[0]), float(bracket[1])],
        **search_kwargs,
    )
    if control.get("onFailure") == "warn":
        install_warn_on_search_failure(integrator)


def apply_external_source_rates(integrator, rates):
    """Attach external feed/removal rates to the integrator.

    Args:
        integrator: Depletion integrator.
        rates: Parsed external source rate rows.

    Raises:
        DepletionConfigError: If the environment lacks the public API or a row
            is incomplete.
    """
    if not rates:
        return
    if not supports_integrator_method("add_external_source_rate"):
        raise DepletionConfigError(
            "External source rates require OpenMC 0.15.3 or newer "
            "(Integrator.add_external_source_rate is unavailable in this environment)."
        )

    for index, row in enumerate(rates):
        composition_list = row.get("composition") or []
        composition = {}
        for entry in composition_list:
            name = (entry.get("name") or "").strip()
            weight = entry.get("weightPercent")
            if not name or not isinstance(weight, (int, float)) or weight <= 0:
                raise DepletionConfigError(
                    f"External source rate {index + 1} needs element/nuclide names with positive weight percents."
                )
            if name in composition:
                raise DepletionConfigError(
                    f"External source rate {index + 1} repeats '{name}'; combine the weight percents."
                )
            composition[name] = float(weight)
        if not composition:
            raise DepletionConfigError(
                f"External source rate {index + 1} has an empty composition."
            )

        material = row.get("material")
        rate = row.get("rate")
        if not isinstance(material, int) or material <= 0:
            raise DepletionConfigError(
                f"External source rate {index + 1} needs a positive material ID."
            )
        if not isinstance(rate, (int, float)) or rate == 0:
            raise DepletionConfigError(
                f"External source rate {index + 1} needs a non-zero rate (positive feeds, negative removes)."
            )

        timesteps = row.get("timesteps")
        if timesteps is not None:
            if not isinstance(timesteps, list) or any(
                not isinstance(step, int) or step < 0 for step in timesteps
            ):
                raise DepletionConfigError(
                    f"External source rate {index + 1} timesteps must be non-negative whole indices."
                )
            if any(step >= len(integrator.timesteps) for step in timesteps):
                raise DepletionConfigError(
                    f"External source rate {index + 1} references timestep {max(timesteps)}, "
                    f"but this run executes {len(integrator.timesteps)} step(s)."
                )

        units = row.get("units") or "g/s"
        log_progress(
            f"External source rate: material {material}, {rate} {units}, "
            f"composition {composition}"
            + (f", timesteps {timesteps}" if timesteps is not None else " (all steps)")
        )
        integrator.add_external_source_rate(
            material,
            composition,
            float(rate),
            rate_units=units,
            timesteps=timesteps,
        )


def log_progress(message: str):
    """Print progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def sync_dagmc_universes_for_depletion(model):
    """Populate Python-side cells of DAGMC universes for depletion.

    CoupledOperator needs material instances, which requires the DAGMC cells
    (and their material fills) on the Python side — geometry.xml only carries
    a <dagmc_universe> file reference, so the universe is EMPTY until
    synchronized. Prefers the upstream init_lib → sync_dagmc_universes →
    finalize_lib sequence; falls back to direct openmc.lib cell enumeration
    when the .h5m stores set tags in the compact tstt/sets/tags layout
    (newer pymoab writes) that openmc's h5py tag reader cannot parse. Also
    determines instance counts (determine_paths), which CoupledOperator
    requires.

    Args:
        model: openmc.Model with geometry/materials loaded.

    Returns:
        Number of synchronized DAGMC cells (0 when the model has no DAGMC
        universes).
    """
    import openmc

    dagmc_universe_cls = getattr(openmc, "DAGMCUniverse", None)
    dagmc_cell_cls = getattr(openmc, "DAGMCCell", None)
    if dagmc_universe_cls is None or dagmc_cell_cls is None:
        return 0
    dagmc_universes = [
        u for u in model.geometry.get_all_universes().values() if isinstance(u, dagmc_universe_cls)
    ]
    if not dagmc_universes:
        return 0
    if all(len(u.cells) > 0 for u in dagmc_universes):
        # Already synchronized (e.g. geometry.xml carries cell overrides)
        return sum(len(u.cells) for u in dagmc_universes)

    log_progress(f"Synchronizing {len(dagmc_universes)} DAGMC universe(s) for depletion...")
    model.init_lib(output=False)
    try:
        try:
            model.sync_dagmc_universes()
        except Exception as e:
            log_progress(
                f"Note: sync_dagmc_universes failed ({e}); "
                "falling back to direct lib cell enumeration"
            )
            import openmc.lib

            mats_per_id = {m.id: m for m in model.materials}
            for universe in dagmc_universes:
                if len(universe.cells) > 0:
                    continue  # this universe was synchronized by the upstream attempt
                for cell_id in openmc.lib.dagmc.dagmc_universe_cell_ids(universe.id):
                    lib_cell = openmc.lib.cells[cell_id]
                    fill = lib_cell.fill
                    if isinstance(fill, Iterable):
                        fill = [mats_per_id[m.id] for m in fill if m]
                    else:
                        fill = mats_per_id[fill.id] if fill else None
                    universe.add_cell(dagmc_cell_cls(cell_id=cell_id, fill=fill))
    finally:
        model.finalize_lib()

    model.geometry.determine_paths()
    return sum(len(u.cells) for u in dagmc_universes)


def run_depletion(args):
    """Run an OpenMC depletion simulation.

    Loads the model from XML files in the working directory, creates the
    depletion operator and integrator, and runs the burnup calculation.

    Args:
        args: Parsed command-line arguments containing working_directory,
            chain_file, time_steps, power, power_density, solver, operator,
            substeps, normalization, and mpi_processes.

    Returns:
        Dictionary with simulation summary including time steps, burnup,
        power, solver, and operator type.

    Raises:
        FileNotFoundError: If the depletion chain file is missing.
        ValueError: If neither power nor power-density is specified.
        NotImplementedError: If the independent operator is requested.
    """
    working_dir = Path(args.working_directory).absolute()

    # Semantic guards, before any openmc import so failures are clean config
    # errors (not lxml tracebacks from DataLibrary.from_xml(<mgxs.h5>)):
    # 1. Macroscopic (multigroup) materials have no nuclides — a depletable
    #    macroscopic material can never deplete, in any mode or operator.
    macroscopic = read_macroscopic_depletable_names(working_dir)
    if macroscopic:
        raise DepletionConfigError(
            "Depletion requires nuclide-decomposed materials; macroscopic "
            f"(multigroup) materials have no nuclide data ({', '.join(macroscopic)})."
        )
    # 2. Coupled depletion is continuous-energy only in this OpenMC version,
    #    and MicroXS generation needs a CE transport solve.
    energy_mode = read_energy_mode(working_dir)
    if energy_mode == "multi-group":
        if args.operator != "independent":
            raise DepletionConfigError(
                "Coupled depletion requires continuous-energy mode; this project is "
                "multi-group. Use the Independent operator with flux/MicroXS files "
                "(or switch the model to continuous-energy)."
            )
        if getattr(args, "generate_microxs", False):
            raise DepletionConfigError(
                "MicroXS generation requires continuous-energy mode; provide "
                "flux/MicroXS files instead, or switch the model to continuous-energy."
            )

    import numpy as np
    import openmc
    import openmc.deplete

    substeps = getattr(args, "substeps", 1)
    if substeps is None:
        substeps = 1
    continue_from_results = getattr(args, "continue_from_results", None)
    continue_timesteps = bool(getattr(args, "continue_timesteps", False))
    if not isinstance(substeps, int) or substeps < 1:
        raise DepletionConfigError("Substeps must be a whole number of at least 1.")
    if substeps > 1 and not supports_integrator_option("substeps"):
        raise DepletionConfigError(
            "CRAM substeps require OpenMC 0.16 or newer "
            "(Integrator(..., substeps=) is unavailable in this environment)."
        )
    if continue_timesteps and not supports_integrator_option("continue_timesteps"):
        raise DepletionConfigError(
            "Continuing a depletion schedule requires OpenMC 0.15.1 or newer "
            "(continue_timesteps is unavailable in this environment)."
        )
    if continue_timesteps and not continue_from_results:
        raise DepletionConfigError(
            "Continue timesteps needs a previous depletion results file (--continue-from-results)."
        )

    os.chdir(working_dir)

    log_progress(f"Loading OpenMC model from {working_dir}")

    # Load the model from XML files
    try:
        import xml.etree.ElementTree as ET

        materials = openmc.Materials.from_xml("materials.xml")
        geometry = openmc.Geometry.from_xml("geometry.xml", materials)

        # Load meshes from tallies.xml first (needed for weight windows)
        meshes = {}
        if os.path.exists("tallies.xml"):
            try:
                tallies_tree = ET.parse("tallies.xml")
                tallies_root = tallies_tree.getroot()

                # Load meshes the same way OpenMC does
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

        # Load settings with meshes dictionary
        settings_tree = ET.parse("settings.xml")
        settings_root = settings_tree.getroot()
        settings = openmc.Settings.from_xml_element(settings_root, meshes)

    except Exception as e:
        log_progress(f"Error loading XML files: {e}")
        raise

    # Load depletion chain
    chain_file = args.chain_file or os.environ.get("OPENMC_CHAIN_FILE")
    if not chain_file:
        # Try to find a default chain file
        chain_file = os.environ.get("OPENMC_CROSS_SECTIONS", "").replace(".h5", "_chain.xml")
        if not os.path.exists(chain_file):
            chain_file = None

    if not chain_file or not os.path.exists(chain_file):
        raise FileNotFoundError(
            f"Depletion chain file not found: {chain_file}. "
            "Set --chain-file or OPENMC_CHAIN_FILE environment variable."
        )

    log_progress(f"Loading depletion chain from {chain_file}")

    # Parse time steps
    time_steps_str = args.time_steps
    time_steps = [float(t.strip()) for t in time_steps_str.split(",")]

    decay_only_steps = []
    raw_decay_only = getattr(args, "decay_only_steps", None)
    if raw_decay_only:
        try:
            if isinstance(raw_decay_only, (list, tuple)):
                decay_only_steps = sorted({int(token) for token in raw_decay_only})
            else:
                decay_only_steps = sorted(
                    {int(token.strip()) for token in str(raw_decay_only).split(",")}
                )
        except ValueError as e:
            raise DepletionConfigError(
                f"Decay-only steps must be comma-separated zero-based integers: {e}"
            ) from e
        invalid = [step for step in decay_only_steps if step < 0 or step >= len(time_steps)]
        if invalid:
            raise DepletionConfigError(
                f"Decay-only step indices {invalid} are outside the configured timeline "
                f"(0-{len(time_steps) - 1})."
            )

    # Calculate total mass of depletable materials (needed for burnup calculation)
    total_mass_g = 0.0
    for mat in materials:
        if mat.depletable:
            # Get volume from material (assuming cm^3)
            volume = mat.volume
            if volume is None:
                log_progress(f"Warning: Material {mat.name} is depletable but has no volume set")
                continue
            # Calculate mass in grams: density (g/cm^3) * volume (cm^3)
            mass_g = mat.density * volume
            total_mass_g += mass_g
            log_progress(f"Material {mat.name}: {mass_g:.2f} g")

    # Calculate total power from power density if needed
    total_power = args.power
    if total_power is None and args.power_density is not None:
        if total_mass_g > 0:
            total_power = args.power_density * total_mass_g
            log_progress(
                f"Calculated total power from density: {total_power:.2f} W "
                f"({args.power_density} W/g * {total_mass_g:.2f} g)"
            )
        else:
            raise ValueError(
                "Power density specified but no depletable materials with volumes found"
            )

    if total_power is None:
        raise ValueError("Either --power or --power-density must be specified")

    decay_set = set(decay_only_steps)
    power_values = [0.0 if index in decay_set else total_power for index in range(len(time_steps))]

    log_progress(f"Time steps: {time_steps} seconds")
    log_progress(f"Power: {total_power:.2f} W")
    if decay_only_steps:
        log_progress(f"Decay-only steps (zero power): {decay_only_steps} of {len(time_steps)}")
    log_progress(f"Solver: {args.solver}")
    log_progress(f"Operator: {args.operator}")

    # Create the model
    if not geometry.root_universe:
        log_progress("Warning: Geometry has no root universe. Creating a dummy one for DAGMC mode.")
        root_univ = openmc.Universe(universe_id=0, name="root universe")
        geometry.root_universe = root_univ

    model = openmc.model.Model(geometry=geometry, materials=materials, settings=settings)

    # Parse structured options
    fission_q = parse_json_option(getattr(args, "fission_q", None), "--fission-q")
    transfer_rates = (
        parse_json_option(getattr(args, "transfer_rates", None), "--transfer-rates") or []
    )
    reactivity_control = parse_json_option(
        getattr(args, "reactivity_control", None), "--reactivity-control"
    )
    external_source_rates = (
        parse_json_option(getattr(args, "external_source_rates", None), "--external-source-rates")
        or []
    )
    if not isinstance(external_source_rates, list):
        raise DepletionConfigError("--external-source-rates must be a JSON list.")

    previous_results = None
    if continue_from_results:
        log_progress(f"Loading previous depletion results from {continue_from_results}")
        previous_results = load_previous_results(continue_from_results)

    # Create the operator — construction errors are user-facing config
    # problems (wrong mode, missing files, bad library), so they surface as
    # clean JSON without a traceback
    try:
        chain = openmc.deplete.Chain.from_xml(chain_file)
        if args.operator == "independent":
            operator = build_independent_operator(
                args, model, materials, chain, fission_q, previous_results
            )
        else:
            log_progress("Creating CoupledOperator...")
            # DAGMC models need Python-side cells + instance counts before
            # CoupledOperator (geometry.xml only references the .h5m)
            synced_cells = sync_dagmc_universes_for_depletion(model)
            if synced_cells:
                log_progress(f"Synchronized {synced_cells} DAGMC cell(s) for depletion")
            # CE edge: an MG/non-XML library reference in materials.xml would be
            # fed to DataLibrary.from_xml (lxml crash). 0.15.3's CoupledOperator
            # has no cross_sections kwarg, so clear it and let
            # _find_cross_sections fall back to openmc.config (OPENMC_CROSS_SECTIONS).
            mat_xs = getattr(materials, "cross_sections", None)
            env_xs = os.environ.get("OPENMC_CROSS_SECTIONS")
            if env_xs and mat_xs and not str(mat_xs).lower().endswith(".xml"):
                log_progress(
                    f"Note: materials cross_sections ({mat_xs}) is not a CE library — "
                    "using OPENMC_CROSS_SECTIONS for nuclide data"
                )
                materials.cross_sections = None
            # Only pass W6 kwargs when enabled to keep the default call shape stable
            coupled_kwargs = {"normalization_mode": args.normalization or "fission-q"}
            if getattr(args, "diff_burnable_mats", False):
                coupled_kwargs["diff_burnable_mats"] = True
                coupled_kwargs["diff_volume_method"] = getattr(
                    args, "diff_volume_method", "divide equally"
                )
            if fission_q is not None:
                coupled_kwargs["fission_q"] = fission_q
            if previous_results is not None:
                coupled_kwargs["prev_results"] = previous_results
            operator = openmc.deplete.CoupledOperator(model, chain, **coupled_kwargs)
    except DepletionConfigError:
        raise
    except Exception as e:
        raise DepletionConfigError(f"Failed to create the depletion operator: {e}") from e

    # Create the integrator (solver) — canonical ids from
    # integrator_by_name; legacy aliases resolve with a deprecation warning
    solver = resolve_solver(args.solver)
    class_name = SOLVER_CLASS_MAP[solver]

    integrator_class = getattr(openmc.deplete, class_name, None)

    if integrator_class is None:
        raise ValueError(f"OpenMC deplete module does not have class: {class_name}")

    log_progress(f"Creating {solver.upper()} integrator...")
    if substeps > 1:
        log_progress(f"Using {substeps} CRAM substeps per depletion interval")
    if continue_timesteps:
        log_progress("Continuing the previous depletion schedule (previous timesteps are skipped)")

    # Create integrator. Only pass 0.16-only kwargs when active so the default
    # call shape stays compatible with 0.15.3.
    integrator_kwargs = {"power": power_values if decay_only_steps else total_power}
    if substeps > 1:
        integrator_kwargs["substeps"] = substeps
    if continue_timesteps:
        integrator_kwargs["continue_timesteps"] = True
    try:
        integrator = integrator_class(
            operator,
            time_steps,
            **integrator_kwargs,
        )
    except ValueError as e:
        if continue_timesteps:
            raise DepletionConfigError(
                "Could not continue the previous depletion schedule: "
                f"{e} The configured timesteps and power must begin with the "
                "previous run's timesteps and power."
            ) from e
        raise
    log_progress(f"Effective depletion steps for this run: {len(integrator.timesteps)}")

    # Apply external transfer rates (Integrator.add_transfer_rate)
    for tr in transfer_rates:
        units = tr.get("units", "1/s")
        destination = tr.get("destinationMaterial")
        log_progress(
            f"Transfer rate: {tr['element']} from material {tr['material']} at {tr['rate']} {units}"
            + (f" to material {destination}" if destination else "")
        )
        integrator.add_transfer_rate(
            tr["material"],
            [tr["element"]],
            tr["rate"],
            transfer_rate_units=units,
            destination_material=destination,
        )

    # Reactivity control (keff search) and external feed/removal rates are
    # Python-API-only; validate them here so failures are clean config errors.
    apply_reactivity_control(integrator, reactivity_control)
    apply_external_source_rates(integrator, external_source_rates)

    # Run depletion
    log_progress("Starting depletion simulation...")

    try:
        # The integrate() method runs the full depletion
        integrator.integrate()
        log_progress("=" * 60)
        log_progress("Depletion simulation completed successfully!")
    except ValueError as e:
        if "Search for keff failed to converge" in str(e):
            raise DepletionConfigError(
                "The reactivity search did not converge during depletion. Increase the maximum "
                "iterations or widen the search bracket, or set failure behavior to warn."
            ) from e
        log_progress(f"Error during depletion: {e}")
        traceback.print_exc(file=sys.stderr)
        raise
    except Exception as e:
        log_progress(f"Error during depletion: {e}")
        traceback.print_exc(file=sys.stderr)
        raise

    # Output summary
    log_progress("Depletion results saved to depletion_results.h5")

    # Calculate burnup for each timestep (MWd/kg)
    # Burnup = cumulative energy (MWd) / initial heavy-metal mass (kg); decay-only
    # steps contribute no energy because their power value is zero.
    cumulative_energy_mwd = np.cumsum(
        [
            power_values[index] * (time_steps[index] / 86400.0) / 1e6
            for index in range(len(time_steps))
        ]
    )
    total_mass_kg = total_mass_g / 1000.0

    # Calculate burnup in MWd/kg
    burnup_mwd_kg = []
    for energy_mwd in cumulative_energy_mwd:
        burnup = energy_mwd / total_mass_kg if total_mass_kg > 0 else 0
        burnup_mwd_kg.append(float(burnup))

    log_progress(f"Final burnup: {burnup_mwd_kg[-1]:.2f} MWd/kg")

    # Add burnup dataset to the depletion results file for visualization
    try:
        import h5py

        with h5py.File("depletion_results.h5", "a") as f:
            # Create burnup dataset if it doesn't exist
            if "burnup" not in f:
                # Calculate burnup in MWd/kg for each timestep
                burnup_data = np.array(burnup_mwd_kg, dtype=np.float64)
                f.create_dataset("burnup", data=burnup_data)
                log_progress("Added burnup dataset to depletion_results.h5")
    except Exception as e:
        log_progress(f"Warning: Could not add burnup to HDF5: {e}")

    # Return summary (visualizer reads from depletion_results.h5 directly)
    summary = {
        "success": True,
        "timeSteps": time_steps,
        "burnupMWdPerKg": burnup_mwd_kg,
        "power": total_power,
        "solver": solver,
        "operator": args.operator,
        "substeps": substeps,
        "effectiveSteps": len(integrator.timesteps),
        "decayOnlySteps": decay_only_steps,
        "reactivityControl": {
            "enabled": bool(reactivity_control and reactivity_control.get("enabled") is not False),
            "parameter": (reactivity_control or {}).get("parameter"),
            "cellId": (reactivity_control or {}).get("cellId"),
            "axis": (reactivity_control or {}).get("axis"),
            "materialId": (reactivity_control or {}).get("materialId"),
            "nuclide": (reactivity_control or {}).get("nuclide"),
            "onFailure": (reactivity_control or {}).get("onFailure", "fail"),
        }
        if reactivity_control
        else None,
        "externalSourceRates": external_source_rates,
        "continueFromResults": continue_from_results,
        "continueTimesteps": continue_timesteps,
    }

    return summary


def load_flux_file(path):
    """Load a flux array from a .npy or delimiter-separated text file.

    Args:
        path: Path to the flux file (.npy, .csv, or whitespace-separated text).

    Returns:
        numpy.ndarray with the group fluxes.
    """
    import numpy as np

    if str(path).endswith(".npy"):
        return np.load(path)
    return np.loadtxt(path, delimiter="," if str(path).endswith(".csv") else None)


def build_independent_operator(args, model, materials, chain, fission_q, prev_results=None):
    """Create an IndependentOperator from file inputs or a model transport solve.

    Args:
        args: Parsed command-line arguments.
        model: The loaded openmc.Model.
        materials: Loaded openmc.Materials.
        chain: Loaded openmc.deplete.Chain.
        fission_q: Optional custom fission Q dictionary.
        prev_results: Optional previous depletion Results for continuation.

    Returns:
        openmc.deplete.IndependentOperator instance.

    Raises:
        ValueError: If no depletable materials exist or the file inputs do not
            match the depletable material count.
    """
    import openmc

    depletable = [m for m in materials if m.depletable]
    if not depletable:
        raise ValueError("Independent operator requires at least one depletable material")

    if getattr(args, "generate_microxs", False):
        log_progress(
            "Computing multigroup fluxes and cross sections via transport solve (this may take a while)..."
        )
        fluxes, micros = openmc.deplete.get_microxs_and_flux(model, depletable, chain_file=chain)
    else:
        flux_files = (
            [f.strip() for f in args.flux_files.split(",")]
            if getattr(args, "flux_files", None)
            else []
        )
        microxs_files = (
            [f.strip() for f in args.microxs_files.split(",")]
            if getattr(args, "microxs_files", None)
            else []
        )
        if len(flux_files) != len(depletable) or len(microxs_files) != len(depletable):
            raise ValueError(
                f"Independent operator needs one flux file and one MicroXS file per depletable material "
                f"({len(depletable)} needed, got {len(flux_files)} flux and {len(microxs_files)} MicroXS files), "
                "or use --generate-microxs"
            )
        log_progress(f"Loading fluxes and MicroXS for {len(depletable)} depletable material(s)...")
        fluxes = [load_flux_file(f) for f in flux_files]
        micros = [openmc.deplete.MicroXS.from_csv(f) for f in microxs_files]

    log_progress(f"Creating IndependentOperator for {len(depletable)} depletable material(s)...")
    operator_kwargs = {
        "normalization_mode": args.normalization or "fission-q",
        "fission_q": fission_q,
    }
    if prev_results is not None:
        operator_kwargs["prev_results"] = prev_results
    return openmc.deplete.IndependentOperator(
        depletable,
        fluxes,
        micros,
        chain,
        **operator_kwargs,
    )


def main():
    """Main entry point for CLI usage.

    Parses arguments, runs the depletion simulation, and prints the
    result as JSON to stdout.
    """
    parser = argparse.ArgumentParser(
        description="Run OpenMC depletion simulation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python run_depletion.py /path/to/simulation --chain-file /path/to/chain.xml --time-steps 86400,86400 --power 1e6
        """,
    )

    parser.add_argument("working_directory", help="Directory containing XML files")
    parser.add_argument("--chain-file", help="Path to depletion chain XML file")
    parser.add_argument("--time-steps", required=True, help="Comma-separated time steps in seconds")
    parser.add_argument("--power", type=float, help="Power level in Watts")
    parser.add_argument(
        "--power-density", type=float, help="Power density in W/g (alternative to --power)"
    )
    parser.add_argument(
        "--solver",
        default="cecm",
        choices=list(SOLVER_CLASS_MAP) + list(SOLVER_ALIASES),
        help="Depletion solver method (OpenMC integrator short name; legacy names map with a warning)",
    )
    parser.add_argument(
        "--operator",
        default="coupled",
        choices=["coupled", "independent", "openmc"],
        help="Depletion operator type",
    )
    parser.add_argument("--substeps", type=int, default=1, help="Number of substeps per timestep")
    parser.add_argument(
        "--normalization",
        default="fission-q",
        choices=["source-rate", "fission-q", "energy-deposition"],
        help="Transport normalization mode",
    )
    parser.add_argument("--mpi-processes", type=int, help="Number of MPI processes")
    parser.add_argument(
        "--flux-files",
        help="Comma-separated flux file paths for the independent operator (one per depletable material)",
    )
    parser.add_argument(
        "--microxs-files",
        help="Comma-separated MicroXS CSV file paths for the independent operator (one per depletable material)",
    )
    parser.add_argument(
        "--generate-microxs",
        action="store_true",
        help="Compute fluxes and micro cross sections from the model via a transport solve",
    )
    parser.add_argument(
        "--transfer-rates",
        help='JSON list of transfer rates: [{"material": 1, "element": "U", "rate": 1e-5, "units": "1/s", "destinationMaterial": 2}]',
    )
    parser.add_argument(
        "--fission-q",
        help='JSON dict of custom fission Q values per nuclide [eV]: {"U235": 2.02e8}',
    )
    parser.add_argument(
        "--diff-burnable-mats",
        action="store_true",
        help="Distinguish burnable materials that share the same composition (higher memory/runtime cost)",
    )
    parser.add_argument(
        "--diff-volume-method",
        choices=["divide equally", "match cell"],
        default="divide equally",
        help="How volumes are assigned to differentiated materials",
    )
    parser.add_argument(
        "--reactivity-control",
        help='JSON reactivity control: {"enabled": true, "parameter": "cell-translation", "cellId": 2, "axis": "z", "x0": 0, "x1": 10, "bracket": [-20, 20], "targetKeff": 1.0}',
    )
    parser.add_argument(
        "--external-source-rates",
        help='JSON list of feed/removal rates: [{"material": 1, "composition": [{"name": "U235", "weightPercent": 100}], "rate": -1e-6, "units": "g/s", "timesteps": [0]}]',
    )
    parser.add_argument(
        "--continue-from-results",
        help="Path to a previous depletion_results.h5 used as the operator restart point",
    )
    parser.add_argument(
        "--decay-only-steps",
        help="Comma-separated zero-based timestep indices that run at zero power (decay only)",
    )
    parser.add_argument(
        "--continue-timesteps",
        action="store_true",
        help="Continue the previous schedule (configured timesteps must start with the previous run's)",
    )

    args = parser.parse_args()

    try:
        result = run_depletion(args)
        print(json.dumps(result))
        return 0
    except DepletionConfigError as e:
        # User-facing configuration errors: clean JSON, no traceback
        log_progress(f"FAILED: {e}")
        print(json.dumps({"success": False, "error": str(e)}))
        return 1
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        error_result = {"success": False, "error": str(e)}
        print(json.dumps(error_result))
        return 1


if __name__ == "__main__":
    sys.exit(main())
