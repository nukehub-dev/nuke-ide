# Getting Started with OpenMC Studio

This guide walks you through installing dependencies, configuring your Python environment, and running your first OpenMC simulation from within NukeIDE.

---

## Prerequisites

OpenMC Studio requires a working OpenMC installation with cross-section data and a compatible Python environment.

### Required Software

| Component | Required? | Notes |
|-----------|-----------|-------|
| OpenMC | Yes | Monte Carlo transport code; install via conda or build from source |
| Python | Yes | 3.9 or newer |
| Cross-section data | Yes | ENDF/B-VII.1, ENDF/B-VIII.0, or JEFF; set via `OPENMC_CROSS_SECTIONS` |
| MPI (optional) | No | For parallel execution; `mpi4py` recommended |

### Required Python Packages

| Package | Required? | Notes |
|---------|-----------|-------|
| `openmc` | Yes | Core simulation toolkit |
| `numpy` | Yes | Array processing |
| `h5py` | Yes | HDF5 I/O for statepoints and depletion results |
| `matplotlib` | Yes | Plotting and 2D slice previews |
| `scipy` | No | Statistical tests in Simulation Comparison |
| `pandas` | No | Optimization data export |
| `trame` | No | For 3D visualization via nuke-visualizer |
| `vtk` | No | For 3D mesh and geometry rendering |

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
2. Run **"OpenMC Studio: Run Health Check"** (or go to `Tools → OpenMC Studio → Environment → Run Health Check`).
3. Check the **"OpenMC Studio"** output channel for results:
   - ✓ Green checks = ready to go
   - ✗ Red crosses = missing packages or configuration issues (fix instructions shown)

### Health Check Items

| Check | What It Verifies |
|-------|-----------------|
| Python executable | Selected interpreter responds |
| `openmc` import | OpenMC Python package is importable |
| OpenMC version | Compatible version (≥0.13 recommended) |
| Cross sections | `OPENMC_CROSS_SECTIONS` is set and file exists |
| HDF5 support | `h5py` is installed and functional |
| MPI (optional) | `mpi4py` and `mpirun` are available |

### Install Missing Packages from the Menu

If the health check reports missing packages:

- `Tools → OpenMC Studio → Environment → Install OpenMC`
- `Tools → OpenMC Studio → Environment → Install DAGMC Tools`

---

## Create Your First Project

OpenMC Studio stores simulation configurations in `.nuke-openmc` project files.

### Step 1: Create a New Project

1. Open the **Command Palette** (`Ctrl+Shift+P`).
2. Run **"OpenMC Studio: New Project"**.
3. Choose a template:

| Template | Description |
|----------|-------------|
| **Blank Project** | Empty model; build from scratch |
| **Pincell** | Single fuel pin in coolant; good first tutorial |
| **Bare Sphere** | Simple critical sphere of U-235 |
| **PWR Assembly** | 17×17 fuel assembly with guide tubes |
| **CANDU Bundle** | 37-element natural uranium bundle |

4. Select a folder to save the `.nuke-openmc` file.
5. The **Simulation Dashboard** opens automatically.

### Step 2: Configure Basic Settings

1. In the **Settings** tab of the dashboard:
   - Set **Run Mode** to `eigenvalue`.
   - Set **Particles** to `1000`.
   - Set **Inactive Batches** to `10`.
   - Set **Active Batches** to `50`.
2. In the **Materials** tab:
   - Click **"Add from Template"**.
   - Select **UO2 Fuel**.
   - Select **Water**.
3. In the **Geometry** tab (or open the **CSG Builder**):
   - Add a sphere surface (radius `10` cm).
   - Create a cell filled with **UO2 Fuel** bounded by the sphere.
   - Set the outer boundary to `vacuum`.

### Step 3: Generate XML

1. Click **"Generate XML"** in the dashboard toolbar (or `Tools → OpenMC Studio → XML Configuration → Generate XML Files`).
2. The extension writes `geometry.xml`, `materials.xml`, `settings.xml`, and `tallies.xml` to your workspace.
3. A notification confirms success and shows the output folder.

### Step 4: Run Your First Simulation

1. Switch to the **Simulation** tab in the dashboard.
2. Click **"Run"**.
3. The live console streams OpenMC output:
   - Batch-by-batch k-effective
   - Particle tracking progress
   - Final tally results
4. Wait for the run to complete. A notification appears with the final k-effective.

### Step 5: View Results

1. After the simulation finishes, click **"Open Statepoint"** in the Simulation tab.
2. The **Statepoint Viewer** opens, showing:
   - Simulation metadata
   - k-effective convergence plot
   - Runtime breakdown
3. Double-click any tally in the Tallies panel to visualize results (requires nuke-visualizer).

---

## Next Steps

- Learn the [Simulation Dashboard](simulation-dashboard.md) in depth
- Build geometry with the [CSG Builder or DAGMC Editor](geometry.md)
- Configure tallies with the [Tally Configurator](tally-configurator.md)
- Run parameter sweeps with the [Optimization Framework](optimization.md)
