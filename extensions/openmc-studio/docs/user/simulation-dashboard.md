# Simulation Dashboard

The Simulation Dashboard is the central workspace for building, configuring, and running OpenMC simulations without writing code. It organizes every aspect of a model into focused tabs and provides a unified workflow from configuration to results.

---

## Opening the Dashboard

### Method 1: New Project
Create a new project (`Ctrl+Shift+P` → **"OpenMC Studio: New Project"**). The dashboard opens automatically.

### Method 2: Open Existing Project
Click any `.nuke-openmc` file in the Explorer.

### Method 3: Command Palette
`Ctrl+Shift+P` → **"OpenMC Studio: Open Dashboard"**

---

## Dashboard Layout

The dashboard is a single tab with a toolbar at the top and a tabbed panel below.

### Toolbar Actions

| Button | Action |
|--------|--------|
| **Generate XML** | Export the current configuration to `geometry.xml`, `materials.xml`, `settings.xml`, and `tallies.xml` |
| **Run** | Execute the simulation in the active terminal |
| **Stop** | Terminate the running simulation |
| **Open Statepoint** | Load the latest `statepoint*.h5` into the Statepoint Viewer |
| **Health Check** | Re-run the environment health check |

---

## Settings Tab

Configure global simulation parameters.

| Parameter | Description | Common Values |
|-----------|-------------|---------------|
| **Run Mode** | Type of simulation | `eigenvalue`, `fixed source`, `plot`, `volume` |
| **Particles** | Number of particles per batch | `1000` – `1,000,000` |
| **Batches** | Total batches to run | `50` – `500` |
| **Inactive Batches** | Batches discarded before tally accumulation | `10` – `100` |
| **Generations per Batch** | For super-history eigenvalue tracking | `1` (default) |
| **Random Seed** | Optional fixed seed for reproducibility | Any integer |
| **Temperature Method** | How to handle material temperatures | `interpolation`, `nearest` |

### Source Configuration

Click **"Configure Source"** to define particle sources:

| Source Property | Description |
|-----------------|-------------|
| **Spatial Distribution** | Point, box, sphere, or Cartesian independent distributions |
| **Energy Distribution** | Watt fission spectrum, Maxwellian, tabular, or monoenergetic |
| **Angle Distribution** | Isotropic, monodirectional, or tabular |
| **Strength** | Source intensity (particles per second for fixed source) |

> **Tip:** For eigenvalue problems, OpenMC automatically initializes a fission source from the defined `Source`. You only need to specify its spatial and energy distribution.

---

## Materials Tab

Define and manage materials. The Materials tab shows a list of all materials in the project with inline editing.

### Built-In Templates

Click **"Add from Template"** to quickly create common nuclear materials:

| Template | Composition | Default Density |
|----------|-------------|-----------------|
| **UO2 Fuel** | UO₂ with enrichable U-235 | 10.3 g/cm³ |
| **Water (H₂O)** | Light water with optional boron | 1.0 g/cm³ |
| **Heavy Water (D₂O)** | Deuterated water | 1.1 g/cm³ |
| **Graphite** | Natural carbon | 1.7 g/cm³ |
| **Zircaloy-4** | Zr-Sn-Fe-Cr alloy | 6.55 g/cm³ |
| **Boron Carbide (B₄C)** | Control poison material | 2.52 g/cm³ |
| **Stainless Steel 304** | Fe-Cr-Ni alloy | 8.0 g/cm³ |
| **Helium** | Pure He-4 gas | 0.000178 g/cm³ |

### Editing a Material

1. Click a material card to expand it.
2. Edit fields directly:
   - **Name** and **ID**
   - **Density** and **units** (`g/cm³`, `kg/m³`, `atom/b-cm`, `sum`)
   - **Temperature** (optional, in Kelvin)
   - **S(α,β)** thermal scattering assignments
3. Add or remove nuclides in the composition table:
   - **Nuclide** name (e.g., `U235`, `O16`)
   - **Fraction** and **type** (`wo` for weight %, `ao` for atomic %)
4. Toggle **Depletable** to include the material in burnup calculations.

---

## Tallies Tab

A quick-access view of all tallies defined in the project. For full tally configuration, see the [Tally Configurator](tally-configurator.md).

The Tallies tab shows:

| Column | Description |
|--------|-------------|
| **ID** | Tally identifier |
| **Name** | User-defined name |
| **Scores** | What is being scored (e.g., `flux`, `fission`) |
| **Filters** | Applied filters (e.g., `energy`, `cell`) |
| **Nuclides** | Which nuclides (e.g., `U235`, `total`) |

Click **"Open Tally Configurator"** to add or edit tallies.

---

## Depletion Tab

Configure burnup and depletion calculations.

| Parameter | Description |
|-----------|-------------|
| **Enable Depletion** | Toggle burnup calculation on/off |
| **Depletion Operator** | `cecm` (constant extrapolation, constant midpoint) or `epc_rk4` |
| **Chain File** | Path to depletion chain XML (e.g., `chain_casmo71.xml`) |
| **Burnable Materials** | Select which materials participate in burnup |

### Burnup Timeline

Define irradiation steps as a table:

| Step | Power (W) or Flux (n/cm²/s) | Duration (days) |
|------|------------------------------|-----------------|
| 1 | 40e6 | 30 |
| 2 | 40e6 | 30 |
| 3 | 0 | 365 |

> **Tip:** Use a zero-power step for decay-only periods (e.g., post-shutdown cooling).

Click **"Add Step"** to append rows and **"Remove Step"** to delete the selected row.

---

## Variance Reduction Tab

Apply variance reduction techniques to improve statistics in deep-penetration or localized problems.

### Weight Windows

| Setting | Description |
|---------|-------------|
| **Enable Weight Windows** | Toggle weight window generation |
| **Particle Type** | Neutron, photon, or both |
| **Energy Bounds** | Group structure for energy-dependent windows |
| **Lower Bound Ratio** | Ratio of lower weight bound to average |
| **Update Interval** | Batches between weight window updates |

### Source Biasing

| Setting | Description |
|---------|-------------|
| **Enable Source Biasing** | Toggle spatial or energy biasing |
| **Spatial Bias** | Importance map for source sampling |
| **Energy Bias** | Preferential sampling of high-importance energies |

> **Tip:** Variance reduction requires an initial simulation to generate mesh-based importance maps. Run a short simulation first, then enable weight windows for the production run.

---

## Simulation Tab

Execute OpenMC and monitor progress in real time.

### Run Controls

| Button | Description |
|--------|-------------|
| **Run** | Start the simulation with the current XML files |
| **Run with MPI** | Start with `mpirun -n <N> openmc` (prompts for N) |
| **Stop** | Send SIGTERM to the running process |
| **Restart** | Resume from the latest statepoint |

### Live Console

The console streams OpenMC stdout/stderr:

- **Batch progress** — current batch / total batches
- **k-effective** — per-generation and cumulative mean
- **Tally accumulation** — active batch tally updates
- **Warnings and errors** — highlighted in yellow/red

### Console Filters

Use the filter buttons to show/hide:

| Filter | Shows |
|--------|-------|
| **All** | Complete output |
| **k-eff Only** | Lines containing k-effective values |
| **Errors** | Warnings and errors only |
| **Tallies** | Tally result summaries |

### Post-Run Actions

When the simulation completes:

| Action | Result |
|--------|--------|
| **Open Statepoint** | Launch the Statepoint Viewer |
| **Open Summary** | Open `summary.h5` in the Material Explorer |
| **View Geometry** | Open `geometry.xml` in the Geometry Viewer |
| **Compare Results** | Open the Simulation Comparison tool |

---

## Workflow Summary

The typical workflow through the dashboard tabs is:

1. **Settings** — Define run mode, particles, batches, and source.
2. **Materials** — Add materials from templates or create custom compositions.
3. **Geometry** — Build CSG or import DAGMC (see [Geometry Guide](geometry.md)).
4. **Tallies** — Configure scores and filters (see [Tally Configurator](tally-configurator.md)).
5. **Depletion** *(optional)* — Set burnup timeline and chain file.
6. **Variance Reduction** *(optional)* — Enable weight windows or source biasing.
7. **Generate XML** — Export all configuration files.
8. **Simulation** — Run, monitor, and view results.

---

## Tips

- **Auto-save:** The dashboard auto-saves the `.nuke-openmc` project file on every change.
- **XML diff:** After generating XML, use the Explorer's file comparison to diff against a previous version.
- **Template projects:** Save a configured project as a template with `File → Save As Template` for reuse across studies.
- **MPI runs:** If `mpirun` is not found, ensure your MPI bin directory is on the system `PATH` or specify the full path in settings.
