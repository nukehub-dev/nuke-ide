# Getting Started with OpenMC Studio

This guide walks you through installing dependencies, configuring your Python environment, and running your first OpenMC simulation from within NukeIDE.

---

## Prerequisites

OpenMC Studio requires a working OpenMC installation with cross-section data and a compatible Python environment.

### Required Software

| Component          | Required? | Notes                                                                 |
| ------------------ | --------- | --------------------------------------------------------------------- |
| OpenMC             | Yes       | 0.15.3 or 0.16.0+; install via conda or build from source             |
| Python             | Yes       | 3.12+ for OpenMC 0.16; 3.9–3.11 only with OpenMC 0.15.3               |
| Cross-section data | Yes       | ENDF/B-VII.1, ENDF/B-VIII.0, or JEFF; set via `OPENMC_CROSS_SECTIONS` |
| MPI (optional)     | No        | For parallel execution; `mpi4py` recommended                          |

### Required Python Packages

| Package      | Required? | Notes                                          |
| ------------ | --------- | ---------------------------------------------- |
| `openmc`     | Yes       | Core simulation toolkit                        |
| `numpy`      | Yes       | Array processing                               |
| `h5py`       | Yes       | HDF5 I/O for statepoints and depletion results |
| `matplotlib` | No        | Optional visualization tooling                 |
| `scipy`      | No        | Optional depletion tooling                     |
| `pandas`     | No        | Not required                                   |
| `vtk`        | No        | For 3D mesh and geometry rendering             |
| `Pillow`     | No        | Converts PPM plots when OpenMC lacks libpng    |

> **Tip:** The easiest way to get everything is via conda:  
> `conda install -c conda-forge openmc numpy h5py matplotlib`

### Cross-Section Data

Before running simulations, point OpenMC to your cross-section library:

1. Download or build a cross-section library (e.g., ENDF/B-VIII.0 from the OpenMC website).
2. Set the environment variable `OPENMC_CROSS_SECTIONS` to the absolute path of `cross_sections.xml`.
3. Verify the path in a terminal: `echo $OPENMC_CROSS_SECTIONS`

---

## Configure Your Python Environment

OpenMC Studio discovers Python through **Nuke Core** (the Python environment manager built into NukeIDE).

1. Open **Settings** (`File → Preferences → Settings` or `Ctrl+,`).
2. Search for **"Nuke"** and find the Python path settings.
3. Set your preferred Python interpreter or conda environment.

The extension will automatically:

- Detect if required packages are present
- Prompt you to install missing packages when needed
- Fall back to other environments if the primary one lacks packages

---

## Run a Health Check

Before building any models, verify your environment:

1. Open the **Command Palette** (`Ctrl+Shift+P` or `F1`).
2. Run **`OpenMC/Environment: Run Health Check`** (or go to `Tools → OpenMC Studio → Environment → Run Health Check`).
3. Check the **"OpenMC Studio"** output channel for results:
   - ✓ Green checks = ready to go
   - ✗ Red crosses = missing packages or configuration issues (fix instructions shown)

### Health Check Items

| Check             | What It Verifies                                                      |
| ----------------- | --------------------------------------------------------------------- |
| Python executable | Configured interpreter responds                                       |
| `openmc` package  | OpenMC Python package is importable; the detected version is reported |
| `numpy` / `h5py`  | Core array and HDF5 packages are importable                           |
| Cross sections    | `OPENMC_CROSS_SECTIONS` path is set (the path text is not validated)  |
| Depletion chain   | `OPENMC_CHAIN_FILE` is set (informational; only needed for depletion) |
| Optional packages | `mpi4py`, `pydagmc`, `moab`, and `OCP` when present; warnings only    |

The health check reports the OpenMC version but does not enforce a supported version line, and it checks the `mpi4py` package rather than looking for `mpirun` on `PATH`.

### Install Missing Packages from the Menu

If the health check reports missing packages:

- `Tools → OpenMC Studio → Environment → Install OpenMC`
- `Tools → OpenMC Studio → Environment → Install DAGMC Tools`

---

## Create Your First Project

OpenMC Studio stores simulation configurations in `.nuke-openmc` project files.

### Step 1: Create a New Project

1. Open the **Command Palette** (`Ctrl+Shift+P`).
2. Run **`OpenMC/Project: New Project`** (or use `Tools → OpenMC Studio → Project → New Project`).
3. Choose a template card:

| Template               | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| **Blank Project**      | Empty model; build from scratch (selected by default)     |
| **Pin Cell**           | Single UO2 fuel pin in light water; good first tutorial   |
| **17x17 PWR Assembly** | 264 fuel pins, 24 guide tubes, and 1 instrument tube      |
| **Demonstration Core** | Small 3×3 assembly core for workflow demonstrations       |
| **Shielding**          | Fixed-source neutrons through a lead slab into a detector |
| **Criticality Safety** | Bare HEU sphere with a vacuum boundary and fission tally  |

4. Adjust the template parameters and project name, then click **Create Project**.
5. The **Simulation Dashboard** opens on the **Simulation** tab. Save the `.nuke-openmc` file with `Tools → OpenMC Studio → Project → Save Project As...` (or `OpenMC/Project: Save Project As...`).

See [Coverage and Limitations](coverage.md) for what each template and the rest of the workbench support.

### Step 2: Configure Basic Settings

![OpenMC Studio Materials tab with the empty-state guidance and Add Material action](images/dashboard.png)

_The Materials tab starts with a short creation checklist and one Add Material action; the same tab is used to create the fuel and moderator before geometry._

1. In the **Settings** tab of the dashboard:
   - Set **Run Mode** to `Eigenvalue (Criticality)`.
   - Set **Particles** to `1000`.
   - Set **Inactive Batches** to `10`.
   - Set **Active Batches** to `50`.
2. In the **Materials** tab:
   - Click **Add Material**.
   - In the material form, open **Start from Template** and choose **UO2 Fuel (4% enriched)**, then click **Create Material**.
   - Repeat **Add Material** with the **Light Water (H2O)** template to create the moderator.
3. In the **Geometry** tab (or open the **CSG Builder**):
   - Add a sphere surface (radius `10` cm).
   - Create a cell filled with **UO2 Fuel** bounded by the sphere.
   - Set the outer boundary to `vacuum`.

### Step 3: Generate XML

1. Click **"Generate XML Files"** in the dashboard toolbar (or `Tools → OpenMC Studio → XML Configuration → Generate XML Files`).
2. The extension asks for an output folder and writes `geometry.xml`, `materials.xml`, `settings.xml`, and `tallies.xml` (when tallies exist) there. `plots.xml` is produced separately by [Native Plotting](native-plotting.md).
3. A notification lists the generated files.

### Step 4: Run Your First Simulation

1. Switch to the **Simulation** tab in the dashboard.
2. Click **"Run Simulation"**.
3. The live console streams OpenMC output:
   - Batch-by-batch k-effective
   - Particle tracking progress
   - Final tally results
4. Wait for the run to complete. The console reports completion and the run duration; a successful eigenvalue run leaves a `statepoint.<N>.h5` file in the run directory.

### Step 5: View Results

1. After the simulation finishes, open the `statepoint.<N>.h5` file from the Explorer. The **OpenMC Statepoint Viewer** opens.
2. The viewer groups results into **Overview**, **K-Effective**, **Entropy**, **Kinetics (IFP)** (when IFP tallies exist), **Tallies**, and **Performance** tabs.
3. Click a tally in the **Tallies** tab to visualize results (requires nuke-visualizer).

---

## Next Steps

- Learn the [Simulation Dashboard](simulation-dashboard.md) in depth
- Build geometry with the [CSG Builder or DAGMC Editor](geometry.md)
- Configure tallies with the [Tally Configurator](tally-configurator.md)
- Run parameter sweeps with the [Optimization Framework](optimization.md)
