# Getting Started with Nuke Visualizer

This guide walks you through installing dependencies, verifying your setup, and opening your first visualization.

---

## Prerequisites

Nuke Visualizer requires a Python environment with scientific computing packages. The exact packages depend on which features you plan to use.

### Base Visualizer (3D Mesh Viewer)

| Package   | Required?        | Notes                                                                  |
| --------- | ---------------- | ---------------------------------------------------------------------- |
| `vtk`     | Yes              | VTK conversion, export, mesh quality, and line-profile probing         |
| `pydagmc` | For `.h5m` files | DAGMC model and volume inspection; it imports `pymoab`                 |
| `moab`    | For `.h5m` files | Provides `pymoab` for pydagmc and DAGMC conversion                     |
| `gmsh`    | For `.msh` files | Gmsh mesh import; also meshes STEP/BREP when opened in Nuke Visualizer |

### OpenMC Plugin

| Package  | Required? | Notes                                         |
| -------- | --------- | --------------------------------------------- |
| `openmc` | Yes       | Monte Carlo simulation toolkit                |
| `h5py`   | Yes       | For reading HDF5 statepoint files             |
| `numpy`  | Yes       | Array processing                              |
| `vtk`    | Yes       | 3D mesh tally, overlay, and output conversion |

> **Tip:** The easiest way to get the core OpenMC stack is via conda:
> `conda install -c conda-forge openmc vtk h5py numpy`
>
> For `.h5m` files, add `pydagmc` and `moab`; the Visualizer health check offers the pinned install for both.

---

## Configure Your Python Environment

Nuke Visualizer discovers Python through **Nuke Core** (the Python environment manager built into NukeIDE).

1. Open **Settings** (`File → Preferences → Settings` or `Ctrl+,`).
2. Search for **"Nuke"** and find the Python path settings.
3. Set your preferred Python interpreter or conda environment.

The visualizer will automatically:

- Detect if required packages are present
- Fall back to other environments if the primary one lacks packages
- Prompt you to install missing packages when needed

---

## Run a Health Check

Before visualizing anything, verify your environment:

1. Open the **Command Palette** (`Ctrl+Shift+P` or `F1`).
2. Run **"Visualizer: Run Health Check"** (or go to `Tools → Visualizer → Environment → Run Health Check`).
3. Check the **"Nuke Visualizer"** output channel for results:
   - ✓ Green checks = ready to go
   - ✗ Red crosses = missing packages (install instructions shown)

### Install Missing Packages from the Menu

If the health check reports missing packages, you can install them directly:

- `Tools → Visualizer → Environment → Install Base Visualizer Dependencies`
- `Tools → Visualizer → Environment → Install OpenMC Dependencies`

---

## Open Your First File

### 3D Mesh / DAGMC

1. In the Explorer sidebar, **click** any of these file types:
   - `.h5m` — DAGMC geometry
   - `.msh` — Gmsh mesh
   - `.vtk`, `.vtu`, `.vtp`, `.vti` — VTK data
   - `.e`, `.exo*` — Exodus time series
   - `.stl`, `.ply`, `.obj` — Surface meshes
2. The **Visualizer** tab opens with an interactive 3D view.

> **STEP / STP / BREP:** With Nuke CAD installed, these files open in the Nuke CAD viewport by default. To view one in Nuke Visualizer, use **Open With… → Open in Nuke Visualizer** (the CAD viewport's **Open CAD Model…** action opens it as a CAD document instead).

### OpenMC Statepoint

1. **Click** a `statepoint*.h5` file in your workspace.
2. The **Statepoint Viewer** opens, showing:
   - Simulation metadata (batches, particles, k-effective)
   - Runtime breakdown
   - Tallies list
   - k-generation convergence plot

### OpenMC Geometry

1. **Click** `geometry.xml`.
2. The **Geometry Hierarchy** tree opens in the sidebar.
3. Click **"View 3D"** on any universe or cell to launch the 3D viewer.

### OpenMC Materials

1. **Click** `materials.xml`.
2. The **Material Explorer** shows all defined materials, nuclides, and densities.

---

## Next Steps

- Learn about [Base Visualizer controls](base-visualizer.md) (opacity, colormaps, clipping, screenshots)
- Explore [OpenMC statepoints and tallies](openmc/statepoint-viewer.md)
- Plot [nuclear cross-sections](openmc/cross-sections.md)
- Analyze [depletion / burnup](openmc/depletion.md)
- Troubleshoot issues with the [troubleshooting guide](troubleshooting.md)
