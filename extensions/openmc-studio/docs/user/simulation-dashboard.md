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

| Tab                    | What It Covers                                                                    |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Settings**           | Run mode, particles/batches, sources, output control, physics, convergence (CMFD) |
| **Materials**          | Material library, templates, compositions, macroscopic materials, NCrystal import |
| **Tallies**            | Quick view of all tallies; opens the Tally Configurator                           |
| **Depletion**          | Burnup configuration, chain builder, transfer rates, timeline                     |
| **Variance Reduction** | Survival biasing, UFS, weight cutoffs, weight window generator and editor         |
| **Random Ray**         | Multi-group energy mode and the random ray solver                                 |
| **Simulation**         | Setup checklist, run controls, restart, kinetics (IFP), live console              |

---

## Settings Tab

Global simulation parameters, organized into collapsible sections.

### General

| Setting                       | Description                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Run Mode**                  | `Eigenvalue (Criticality)`, `Fixed Source`, or `Volume Calculation`                                                    |
| **Particles / Batches**       | Eigenvalue: particles per generation, inactive and active batches. Fixed source: particles per batch and total batches |
| **Random Seed**               | Optional fixed seed for reproducibility (Advanced Settings sub-block)                                                  |
| **Threads**                   | OpenMP thread count                                                                                                    |
| **Source Rejection Fraction** | Fraction of source sites rejected during initial source sampling                                                       |

### Sources

Click **Add Source** to append a collapsible source card. Each source has a type (segmented control) and a strength chip:

| Type            | What You Configure                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Independent** | Spatial distribution (Point / Box / Sphere / Cylinder, with Snap-to-Geometry helpers), energy distribution (Discrete / Uniform / Maxwell / Watt / Muir), particle type, strength |
| **File**        | Source file path (e.g. `surface_source.h5`), strength                                                                                                                            |
| **Compiled**    | Library path (`libsource.so`), parameter string, strength                                                                                                                        |
| **Mesh**        | A state mesh, one sub-source per mesh element (Fill button), per-element strength, particle, energy                                                                              |
| **Tokamak**     | Miller flux-surface geometry (R₀, a, elongation, triangularity, Shafranov shift), emission profile S(r/a), energy distribution, optional time distribution                       |

Every source can carry **Source Constraints** (domain type + IDs, energy/time bounds, fissionable-sites-only, rejection strategy `resample`/`kill`) and a nested **Surface Source** section for writing surface crossings (`surface_source.h5` or MCPL) with cell/surface filters.

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

Particle creation & physics toggles (fission neutrons, delayed neutrons/photons, survival biasing, probability tables) and run behavior knobs (event-based parallelism, generations per batch, lost-particle limits, log grid bins, max scattering order, tabular Legendre conversion).

---

## Materials Tab

Define and manage materials. The tab shows all materials in the project with inline editing, plus a template gallery (UO₂, water, heavy water, graphite, Zircaloy-4, B₄C, stainless steel, helium) for one-click creation.

### Editing a Material

1. Click a material card to expand it.
2. Edit **Name**, **ID**, **Density** and units, **Temperature**, and **S(α,β)** thermal scattering assignments.
3. Add or remove nuclides in the composition table (name, fraction, `wo`/`ao`).
4. Toggle **Depletable** to include the material in burnup calculations.

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

### Burnup Timeline

Define irradiation steps as a table of power/duration rows. Use a zero-power step for decay-only periods (e.g. post-shutdown cooling), or mark a step as decay-only directly.

---

## Variance Reduction Tab

| Section                     | What It Does                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| **Survival Biasing**        | Enable implicit capture (survival biasing)                                                          |
| **Uniform Fission Site**    | UFS mesh (optional — falls back to the weight window mesh), method, max realizations, particle type |
| **Weight Cutoffs**          | Cell-based average weight threshold; terminate particles below the cutoff                           |
| **Weight Window Generator** | Magic-style weight window generation: particle type, update interval, target tallies (local VR)     |
| **Weight Windows**          | Edit weight window sets and their meshes; import MCNP `wwinp` files                                 |

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
