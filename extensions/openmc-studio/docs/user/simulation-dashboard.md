# Simulation Dashboard

The Simulation Dashboard is the central workspace for building, configuring, and running OpenMC simulations without writing code. It organizes every aspect of a model into focused tabs and provides a unified workflow from configuration to results.

---

## Opening the Dashboard

### Method 1: New Project

Create a new project (`Ctrl+Shift+P` → **"OpenMC Studio: New Project"**). The dashboard opens automatically.

### Method 2: Open Existing Project

Click any `.nuke-openmc` file in the Explorer.

### Method 3: Command Palette

`Ctrl+Shift+P` → **"OpenMC Studio: Open Simulation Dashboard"**

---

## Dashboard Layout

The dashboard is a single tab with a toolbar at the top and a tabbed panel below.

### Toolbar Actions

| Button           | Action                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| **New Project**  | Scaffold a new OpenMC project                                                                          |
| **Open Project** | Open an existing `.nuke-openmc` project                                                                |
| **Save Project** | Save the current project (the dashboard also auto-saves on every change)                               |
| **Generate XML** | Export the current configuration to `geometry.xml`, `materials.xml`, `settings.xml`, and `tallies.xml` |

Click the project name in the header to rename it.

### Tabs

| Tab                    | What It Covers                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------- |
| **Settings**           | Run mode, particles/batches, sources, output control, physics, convergence (CMFD)     |
| **Materials**          | Material library, templates, compositions, macroscopic materials, NCrystal import     |
| **Tallies**            | Quick view of all tallies; opens the Tally Configurator                               |
| **Depletion**          | Burnup configuration, chain builder, substeps, reactivity search, feeds, continuation |
| **Variance Reduction** | Survival biasing, UFS, weight cutoffs, weight window generator and editor             |
| **Random Ray**         | Multi-group energy mode and the random ray solver                                     |
| **Simulation**         | Setup checklist, run controls, restart, kinetics (IFP), live console                  |

### Narrow Windows

The dashboard responds to the width of its own editor panel, not just the browser window. In a split editor or a narrow dock:

- Header actions wrap below the project name, and long project names/descriptions wrap instead of clipping.
- The tab row scrolls horizontally; when space is tight, tabs collapse to their domain icons and keep the label as a tooltip.
- Multi-column form rows stack, and wide result tables scroll inside their card.
- Section cards and content padding tighten so controls stay usable down to phone-width panels.

The same behavior applies to the CSG Builder, DAGMC Editor, Tally Configurator, Optimization, and Simulation Comparison windows.

---

## Settings Tab

Global simulation parameters, organized into collapsible sections.

### General

| Setting                       | Description                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Run Mode**                  | `Eigenvalue (Criticality)`, `Fixed Source`, or `Volume Calculation`                                                    |
| **Particles / Batches**       | Eigenvalue: particles per generation, inactive and active batches. Fixed source: particles per batch and total batches |
| **Random Seed**               | Optional fixed seed for reproducibility (Advanced Settings sub-block)                                                  |
| **OpenMP threads**            | Per-process thread count, configured in **Advanced → Execution** and passed to OpenMC as `-s N`                        |
| **Source Rejection Fraction** | Fraction of source sites rejected during initial source sampling                                                       |

### Sources

Click **Add Source** to append a collapsible source card. The card starts with a
compact summary line (for example `Box [-10, 10]³ · Tabular 10 eV–14 MeV ·
Isotropic · t = 0 s`) and then exposes collapsible sections. Only the selected
type's fields render, so the panel stays readable at narrow widths.

| Type            | What You Configure                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Independent** | Spatial, energy, direction, time, constraints, and advanced (strength/particle) sections — see below                                                       |
| **File**        | Source file path (e.g. `surface_source.h5`), strength                                                                                                      |
| **Compiled**    | Library path (`libsource.so`), parameter string, strength                                                                                                  |
| **Mesh**        | A state mesh, one sub-source per mesh element (Fill button), per-element strength, particle, energy                                                        |
| **Tokamak**     | Miller flux-surface geometry (R₀, a, elongation, triangularity, Shafranov shift), emission profile S(r/a), energy distribution, optional time distribution |

**Independent source sections**

| Section         | What You Can Build                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spatial**     | Point, Box, Sphere, Cylinder (with Snap-to-Geometry helpers); Cartesian x/y/z; cylindrical r/phi/z with origin and axis directions; spherical r/cos θ/phi with origin; point cloud (x/y/z + optional strengths); mesh spatial distribution (mesh + element strengths) |
| **Energy**      | Discrete, uniform, Maxwell, Watt, normal, Muir, power law, tabular (x/probability table + interpolation), mixture (nested distributions), and decay spectrum (OpenMC 0.16+, R2S/D1S)                                                                                  |
| **Direction**   | Isotropic, monodirectional with a reference vector, or polar-azimuthal (mu-phi) with polar/azimuthal reference vectors and mu/phi distributions                                                                                                                       |
| **Time**        | Born at t = 0, delta, uniform, discrete, tabular, or mixture. Every value is in **seconds**                                                                                                                                                                           |
| **Constraints** | Domain type + IDs, energy/time bounds, fissionable-sites-only, rejection strategy `resample`/`kill`                                                                                                                                                                   |
| **Advanced**    | Strength (relative source weight) and particle type (neutron/photon)                                                                                                                                                                                                  |

Tabular and point-cloud tables support **Add row** and **Paste** (space-, comma-,
or semicolon-separated rows). Large tables page inside their card. Mixtures show
a running probability sum and warn when it is not 1. Reference vectors must be
non-zero; mu-phi references must not be parallel. Validation messages state what
is wrong and how to fix it, for example a tabular table that is not strictly
increasing or has a mismatched probability column.

**Source bias** is configured per distribution, inside the section that owns it:

- **Energy** and **Time** — turn on **Bias sampling** to sample from a nested distribution
  (continuous types) or alternative probabilities (discrete/mixture). The bias must share the
  parent support interval.
- **Direction** — isotropic sources can use a polar-azimuthal bias. Monodirectional and mu-phi
  sources explain that angle bias is not available.
- **Spatial** — point-cloud and mesh distributions expose a probability array; point/box/sphere/
  cylinder show “OpenMC does not support bias for this spatial type”. OpenMC 0.16's XML transport
  reader rejects point-cloud/mesh array bias even though the Python export carries it, so use energy
  or direction bias for XML runs.
- A biased source shows a `biased` badge in its summary. OpenMC adjusts particle weights so the
  reported estimate stays unbiased.
- Source bias is an OpenMC 0.16+ feature. On older probed environments the editors keep the
  configured bias in the project but warn that XML and Python export omit it; model validation blocks
  a run until the bias is removed or a compatible environment is selected.

Every source can also carry a nested **Surface Source** section for writing
surface crossings (`surface_source.h5` or MCPL) with cell/surface filters.

> **Boundaries:** `Legendre` is not offered because OpenMC cannot serialize it.
> Tabular negative densities are rejected because `ignore_negative` has no XML
> representation. Decay spectra require OpenMC 0.16+ and a depletion chain, and
> are omitted from settings.xml with a warning on older environments.

### Output

| Group               | Settings                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Output Files**    | `summary.h5`, `tallies.out` toggles                                                                                                               |
| **Statepoint**      | Statepoint batch list                                                                                                                             |
| **Sourcepoint**     | Write source points, separate `source.h5`, overwrite latest, MCPL format, sourcepoint batches                                                     |
| **Particle Tracks** | (Batch, Generation, Particle) track rows + max tracks — produces `tracks.h5` for the Tracks Viewer                                                |
| **Collision Track** | Collision filtering (reactions, nuclides, cells, energy threshold) — produces `collision_track.h5`                                                |
| **Tally Triggers**  | Run-level trigger evaluation: **Batch Interval** and **Max Batches** (per-tally triggers live in the [Tally Configurator](tally-configurator.md)) |

### Physics

Photon transport toggle; when enabled: electron treatment (`LED` / `TTB`) and atomic relaxation.

### Convergence

- **Shannon entropy mesh** — enable plus bounds/dimensions, with Auto-detect from Geometry.
- **CMFD acceleration** — mesh selection (inline or a regular tally mesh), albedo boundary faces, feedback, and a collapsible Run Control block (solver tolerances, window type, effective downscatter, power monitor, adjoint run). CMFD requires a regular mesh.

### Advanced

Advanced settings are grouped behind collapsible headers with a name filter at the top. Type a setting
name or OpenMC XML element (for example `threads`, `keff_trigger`, `free_gas_threshold`) to show only the
matching group. Each group reports its own validation state with a red dot and an inline message.

| Group           | Settings                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution**   | OpenMP threads (per MPI rank, passed as `openmc -s N`), MPI enable/processes/hosts, particle trace (batch/generation/particle), event-based parallelism, generations per batch, initial-source write, uniform source sampling                                              |
| **Convergence** | k-eff trigger type/threshold, confidence intervals (fixed 95% half-widths)                                                                                                                                                                                                 |
| **Physics**     | Temperature default/method/tolerance/windowed multipole, resonance elastic scattering (method and energy range), free-gas threshold, energy/time/weight cutoffs, shared secondary bank, surface grazing cutoff/ratio, particle creation and multi-group scattering options |
| **Limits**      | Lost-particle limits, max particle events/in-flight/secondaries, max history splits, lost-particle restart files                                                                                                                                                           |
| **Diagnostics** | Verbosity, no-reduce, random-number stride, plot seed, properties file, material/cell offsets                                                                                                                                                                              |

**Threads and MPI.** OpenMP threads apply per process. With MPI enabled the run command is
`mpirun -np <processes> openmc -s <threads>`, so total CPU demand is processes × threads. The optional
host list is passed as `mpirun --host host1,host2` (Open MPI syntax). Threads and MPI are launch
controls, not `settings.xml` content. CMFD and depletion drivers receive the same thread count; the
depletion driver applies it through `OMP_NUM_THREADS` because `CoupledOperator` initializes libopenmc
internally without a threads argument.

**Version boundaries.** Shared secondary bank and surface grazing cutoffs are OpenMC 0.16.0+ settings.
They are disabled when the configured environment lacks them and are omitted from XML/Python with a
warning. `Material.decay_photon_energy` is a Python analysis helper derived from decay data, not an XML
material field, so it is intentionally not exposed. `max_splits` is deprecated upstream in favor of
`max_history_splits`; only the latter is emitted. The k-eff trigger has no per-batch option in OpenMC
(only type and threshold); the "only last batch" flag exists on per-tally triggers.

---

## Materials Tab

Define and manage materials. The tab shows all materials in the project with inline editing, plus a template gallery (UO₂, water, heavy water, graphite, Zircaloy-4, B₄C, stainless steel, helium) for one-click creation.

### Editing a Material

1. Click a material card to expand it.
2. Edit **Name**, **ID**, **Density** and units, **Temperature**, **Isotropic scattering nuclides**, and **S(α,β)** thermal scattering assignments.
3. Add or remove nuclides in the composition table (name, fraction, `wo`/`ao`).
4. Toggle **Depletable** to include the material in burnup calculations.

**Isotropic scattering nuclides** lists nuclides whose elastic scattering is treated as isotropic in the
laboratory system (`Material.isotropic`, `<isotropic>` in `materials.xml`). Leave it empty for OpenMC's
default anisotropic treatment.

### Macroscopic (Multigroup) Materials

The creation dialog offers a **Material Type** choice: `Nuclides` or `Macroscopic (Multigroup)`. A macroscopic material has no nuclide decomposition — it references a named macroscopic cross-section set (**XS Data Name**) from an MGXS library (see the [MGXS Generator](mgxs-generator.md)). Use these for multi-group / random ray runs.

### NCrystal Import

The material form includes an optional **Import from NCrystal** section: paste an NCrystal cfg-string (e.g. an `.ncmat` specification), click **Import**, and the form is filled with the parsed composition for review. The section is disabled when NCrystal is not installed in the active Python environment.

---

## Tallies Tab

A quick-access view of all tallies defined in the project (ID, name, scores, filters, nuclides). Tallies auto-generated for kinetics (IFP) runs show an **auto** badge. Click **"Open Tally Configurator"** to add or edit tallies — see the [Tally Configurator](tally-configurator.md) guide.

---

## Depletion Tab

Configure burnup and depletion calculations.

### Physics Configuration

| Parameter              | Description                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Chain File**         | Path to the depletion chain XML (decay constants and fission yields)                                             |
| **Integration Method** | OpenMC integrator: `CE/CM` (default), `Predictor`, `CF4`, `CE/LI`, `EPC-RK4`, `LE/QI`, `SI-CE/LI`, or `SI-LE/QI` |
| **Power Level**        | Total power (W) or power density (W/g)                                                                           |

### Custom Chain Builder

Build a problem-sized depletion chain without leaving the IDE:

- **Subset an existing chain** — filter a full chain to a nuclide list (FPY borrow parents are included automatically). Set expectations: subsets containing fissile nuclides stay large because fission-product yields pull in hundreds of daughters.
- **Build from ENDF directory** — construct a chain from ENDF text sub-libraries (`decay/`, `nfy/`, `neutron(s)/`). HDF5 incident data cannot build chains.

A successful build reports the nuclide count and offers **Use as Depletion Chain** to wire the output into the project.

### Advanced

| Setting                     | Description                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator Type**           | `Coupled` (transport solve each step) or `Independent` (pre-computed flux & MicroXS files per material, or generated from the model via `get_microxs_and_flux`) |
| **Normalization Mode**      | `Fission Q` (default), `Energy Deposition`, or `Source Rate`                                                                                                    |
| **Transfer Rates**          | Per-material element/nuclide transfer rates (from material, element, rate, units, optional destination) for moving species between materials                    |
| **Custom Fission Q Values** | Per-nuclide fission Q overrides (eV) for fission-q normalization                                                                                                |
| **diff_burnable_mats**      | Distinguish burnable materials with identical compositions (higher memory/runtime cost; optional volume assignment method)                                      |
| **CRAM substeps**           | Subdivide each depletion interval into smaller CRAM solves (OpenMC 0.16+); improves accuracy for short-lived nuclides                                           |
| **Reactivity control**      | Hold a target k-effective by moving a control-rod cell along one axis or adjusting a nuclide density in a material (OpenMC 0.16+)                               |
| **External feed/removal**   | Add or remove material at a mass rate (g/s … g/a), optionally limited to chosen timestep indices (OpenMC 0.15.3+)                                               |
| **Continuation**            | Start from a previous `depletion_results.h5`; continue the existing schedule instead of appending new steps                                                     |

#### Reactivity control

Enable **Hold a target k-effective** and choose one curated parameter:

- **Control-rod position** — pick a cell and an x/y/z axis; the search writes the cell translation through `openmc.lib` before each depletion step.
- **Nuclide density** — pick a material and a specific isotope; the search replaces that nuclide's atom density through `openmc.lib`.

Set the two search guesses (`x0`, `x1`) and the absolute bracket. Both guesses must lie inside the bracket, and the bracket must increase. The target keff, `k_tol`, final uncertainty, and maximum iterations default to OpenMC's values. **On non-convergence** either stops the run with an actionable error or logs a warning and continues with the last searched value. A search runs at every depletion step, so it is off by default and adds transport time.

#### External feed/removal

Each row targets a depletable material with a composition of elements/nuclides and weight percents. **Positive rates feed material in; negative rates remove it.** OpenMC normalizes the composition vector, so weights that do not total 100% are accepted (the tab warns). Leave **Timesteps** blank to apply the rate to every step, or list zero-based indices. With continuation, indices refer to the steps this run executes (the first new step is 0).

#### Continuation

Pick the previous `depletion_results.h5`, then choose:

- **Continue the previous timesteps** — the configured schedule must begin with the previous run's timesteps and use the same power/power-density/source-rate specification. OpenMC runs only the new steps.
- **Append steps** (toggle off) — the configured steps are appended to the previous results.

The previous results file must exist and be readable; validation and the Python driver both fail with a clear message otherwise.

> **Driver-only settings:** substeps, reactivity control, external feed/removal, continuation, transfer rates, and independent-operator inputs are applied by the OpenMC Studio depletion driver, not by the standalone `openmc` binary. They are stored in the custom `<depletion>` block and XML export warns when they are present. Run depletion from the IDE to apply them.

### Burnup Timeline

Define irradiation steps as a table of power/duration rows. Use a zero-power step for decay-only periods (e.g. post-shutdown cooling), or mark a step as decay-only directly.

---

## Variance Reduction Tab

| Section                     | What It Does                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Survival Biasing**        | Enable implicit capture (survival biasing)                                                            |
| **Uniform Fission Site**    | Regular UFS mesh picker with a readiness error when missing; eigenvalue-only                          |
| **Weight Cutoffs**          | Cell-based average weight threshold; terminate particles below the cutoff                             |
| **Weight Window Generator** | MAGIC/FW-CADIS generation, particle type, update interval, target tallies; bootstrap to file          |
| **Weight Windows**          | A list of sets (mesh, particle, energy bounds, lower/upper bounds, survival ratio), file, checkpoints |

**Weight-window sets.** Click **Add weight-window set** to create one card per
OpenMC `<weight_windows>` block. Each set picks a mesh and particle type, has an
energy-bound token editor, and accepts either one uniform lower/upper value or a
per-cell/group array (the editor shows `N values`). A scalar broadcasts over
`n_mesh_cells × n_energy_groups`; an explicit array is emitted verbatim. The
header summarizes the list (`2 sets · 2 meshes · 3 energy groups`). Mesh,
strictly increasing energy bounds, non-empty bound arrays, positive survival
ratio, and unique set IDs are validated inline.

**Reusable file.** Set **HDF5 file** (Browse) to load a generated
`weight_windows.h5` at simulation start. OpenMC loads it in addition to any sets,
so remove sets you do not want. A generator run can overwrite the same file; the
editor warns and the generator section offers **Use generated weight_windows.h5**
after a successful generation run, which fills the file field, enables weight
windows, and turns the generator off for the production run.

**Enable and checkpoints.** **Enable weight windows** maps to
`<weight_windows_on>` and defaults on when sets or a file exist. Collision
checking is OpenMC's default; surface checking is optional. At least one
checkpoint must stay on while weight windows are enabled.

**UFS** emits `<ufs_mesh>` (not `<ufs>`) and requires a regular mesh that covers
every fissionable region. The toggle is disabled outside eigenvalue mode and
model validation reports a missing/invalid mesh before a run.

The generator method can be `MAGIC (default)` or `FW-CADIS (multi-group)`. **FW-CADIS requires random ray mode** — enable the random ray solver in the Random Ray tab (multi-group energy mode plus an MGXS library); the tab shows a warning otherwise, and model validation fails until random ray is enabled.

> **Tip:** Variance reduction requires an initial simulation to generate mesh-based importance maps. Run a short simulation first, then enable weight windows for the production run. For FW-CADIS workflows, pair weight windows with the adjoint options in the Random Ray tab.

---

## Random Ray Tab

Configure multi-group energy mode and the random ray solver.

### Energy Mode

Switch the **Energy Treatment** between `Continuous Energy` and `Multi-Group`. Multi-group mode requires an **MGXS Library** (`mgxs.h5`) — generate one with the [MGXS Generator](mgxs-generator.md) or point at an existing file (used as `OPENMC_MG_CROSS_SECTIONS`).

### Multi-Group Conversion

One-click conversion from a continuous-energy project: pick the generation method, group structure, particle count, and a working directory, then **Run Conversion**. The IDE generates the MGXS library, then offers **Apply Conversion**, which:

- converts every matched material to **Macroscopic (Multigroup)** with the correct XS data name and `macro` density units,
- switches the model to multi-group mode and sets the MGXS library path,
- stores the original nuclide-decomposed materials in project metadata.

A **Revert to Continuous-Energy** button then restores the original materials losslessly (the MGXS library is kept). Materials that don't match an XS data set in the library are left untouched, so mixed models convert partially and cleanly.

The conversion panel also offers a **Nuclide-wise MGXS (required for DAGMC random ray)** toggle, which defaults ON when a DAGMC geometry is loaded. In nuclide-wise mode materials stay nuclide-decomposed and the MGXS library holds one micro XS data set per nuclide instead of macroscopic material sets — the only library form OpenMC's random ray solver accepts on DAGMC geometries. Apply then sets the project's nuclide-wise multi-group flag instead of converting materials; generation is slower and the library larger than material-wise.

> **Note:** Conversion requires a continuous-energy model with nuclide-decomposed materials (the Generate step runs a CE solve). Save a CE copy for depletion work — depletion needs nuclide decomposition and cannot run on a converted project.

### Random Ray Solver

Inactive/active ray distances, source shape (`Flat` / `Linear` / `Linear XY`), sample method (`PRNG` / `Halton` / `S2`), volume estimator, diagonal stabilization, volume-normalized flux tallies, and **Adjoint flux mode** (forward then adjoint solve, for FW-CADIS weight window generation).

### Ray Source and Adjoint Source

The ray source is a uniform box (Auto-detect from Geometry, or explicit lower-left/upper-right corners). An optional **Adjoint Source** box localizes the adjoint source for detector-response (FW-CADIS) calculations; use Auto-detect or Clear to manage it.

### Source Region

Restrict the random ray source to a mesh-defined region: pick a regular mesh from the Tally Configurator and a domain type (cells, materials, or universes) with IDs.

### Fixed-Source Domain Constraint

When the run mode is **Fixed Source**, every independent source must either be a **point source** or constrained to a domain (cell, material, or universe). OpenMC rejects unconstrained box/sphere/cylinder sources in random ray mode.

The Random Ray tab shows a **Fixed-Source Domain Constraint** panel when random ray is enabled:

- A status list shows whether each source is a point source, already constrained, or still unconstrained.
- Choose a **Domain Type** (`Material`, `Cell / DAGMC Volume`, or `Universe`) and enter one or more IDs.
- Click **Apply to All Sources** to add the domain constraint to every independent source at once.
- For tokamak/plasma models, the **Guess Plasma** button auto-fills the lowest-density material (or one whose name suggests fuel/plasma).

For DAGMC models, constraining the source to the plasma **material** or **volume** ensures fusion neutrons are born inside the plasma instead of in void, which prevents the runtime `Too few source sites satisfied the constraints` error.

> **Tip:** The validator also warns if a point source lies outside the geometry bounds or if a source box does not overlap the geometry. Use the domain constraint rather than guessing coordinates — it lets OpenMC resample until a valid site is found.

---

## Simulation Tab

Execute OpenMC and monitor progress in real time.

### Setup Checklist

A readiness checklist (with an `N / M configured` badge) verifies the model before running: Materials, Geometry, Source, Tallies (optional), Depletion (when enabled), Variance Reduction (optional), Kinetics (when IFP is enabled), and MGXS Library (in multi-group mode). The readiness pill shows **Ready to run** or what is missing; geometry items offer inline **Open CSG Builder** / **Edit** shortcuts.

### Run Controls

| Button             | Description                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Run Simulation** | Generate XML and start the run; a progress bar shows batch x/y, live k-eff ± σ, and elapsed time |
| **Stop**           | Terminate the running simulation                                                                 |
| **Validate**       | Run the model validator without executing                                                        |
| **Optimization**   | Open the [Optimization](optimization.md) widget                                                  |
| **Restart…**       | Resume from a selected statepoint (sets `settings.restartFile`, shown as a dismissible chip)     |

If you reload the browser tab or window while a simulation is running, the dashboard automatically re-attaches to the in-flight backend run: **Stop** keeps working and live progress and the log resume where they left off.

The **Run Summary** card mirrors the launch configuration: mode, particles, batches, OpenMP threads,
and the MPI rank/host selection, so the command that will run is visible before and after starting.

### Particle Restart

When the restart file is a particle restart file (`particle_restart.h5` or `particle_<batch>_<id>.h5`), the tab explains that OpenMC re-runs a single lost particle (the dashboard passes `-t` automatically) and offers:

- **Capture Track for Restarted Particle** — enables a one-particle track for the restarted particle.
- **Preview Restart File** — opens the particle restart viewer.

### Run Output Actions

After a run, the Simulation tab surfaces one-click open actions for files OpenMC wrote:

- **Open Tracks** — appears when the run produced particle tracks. Track files (`tracks.h5` for serial runs, `tracks_p<N>.h5` for MPI runs) are moved into a `tracks/` subfolder (or `output/tracks/` when Settings → Output → Path is set) to keep the top level tidy.
- **Open Weight Windows** — appears when the run produced `weight_windows.h5` (for example, from a **Weight Window Generator** or a FW-CADIS/random-ray workflow).

Lost-particle restart files (`particle_<batch>_<id>.h5`) are also moved into a `particles/` subfolder (or `output/particles/`) after a run. The file currently selected as the simulation restart file is left in place so re-running from it keeps working.

### Kinetics (IFP)

Enable iterated fission probability kinetics (eigenvalue mode only): IFP generations (must not exceed inactive batches), precursor group count for β_eff, and toggles for β_eff and Λ_eff (generation time). The required IFP tallies are auto-generated on export and badged **auto** in the Tallies tab; results appear in the Statepoint Viewer's Kinetics (IFP) tab.

### Console and Summaries

The console streams OpenMC stdout/stderr with filtering and a maximize toggle. Summary cards recap the run configuration, depletion, variance reduction, and geometry (with **Edit in CSG Builder** / DAGMC details shortcuts), plus validation results.

For DAGMC models, the geometry summary offers a **Copy DAGMC file into run directory** checkbox (default off). Off: `geometry.xml` references the `.h5m` via a project-relative path. On: the file is copied into the run directory as `geometry.h5m`, making the run directory self-contained.

---

## Workflow Summary

1. **Settings** — Define run mode, particles, batches, and sources.
2. **Materials** — Add materials from templates, custom compositions, macroscopic sets, or NCrystal.
3. **Geometry** — Build CSG or import DAGMC (see [Geometry Workflows](geometry.md)).
4. **Tallies** — Configure scores and filters (see [Tally Configurator](tally-configurator.md)).
5. **Depletion** _(optional)_ — Set burnup timeline and chain file.
6. **Variance Reduction / Random Ray** _(optional)_ — Weight windows, multi-group mode.
7. **Generate XML** — Export all configuration files.
8. **Simulation** — Check readiness, run, monitor, and view results.

---

## Tips

- **Auto-save:** The dashboard auto-saves the `.nuke-openmc` project file on every change.
- **XML diff:** After generating XML, use the Explorer's file comparison to diff against a previous version.
- **Restart runs:** Use **Restart…** on the Simulation tab to continue long runs from the latest statepoint instead of starting over.
