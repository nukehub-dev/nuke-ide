# Statepoint Viewer

The Statepoint Viewer is the main dashboard for inspecting OpenMC simulation results. It opens automatically when you click a `statepoint*.h5` file.

---

## Opening a Statepoint

### Method 1: Click
In the Explorer, Click any file matching `statepoint*.h5`.

### Method 2: Menu
1. Go to `Tools → Visualizer → OpenMC → Statepoint → View Statepoint...`.
2. Choose a file from the workspace or browse.

### Method 3: Command Palette
Press `Ctrl+Shift+P`, type **"View Statepoint"**, and select a file.

---

## Viewer Layout

The Statepoint Viewer tab is divided into sections:

### Simulation Metadata

| Field | Description |
|-------|-------------|
| **File** | Path to the statepoint |
| **Run Mode** | `eigenvalue` or `fixed source` |
| **Batches** | Total number of batches run |
| **Particles/Batch** | Number of particles per batch |
| **Inactive Batches** | Batches discarded for k-effective statistics |
| **Generations/Batch** | Generations per batch (for eigenvalue) |
| **Energy Mode** | `continuous-energy` or `multigroup` |
| **Seed** | Random number seed |
| **OpenMC Version** | Version string from the simulation |

### k-Effective Results (Eigenvalue Mode)

| Field | Description |
|-------|-------------|
| **k-combined** | Final k-effective mean ± standard deviation |
| **k-generation** | Per-generation k-values (plotted as convergence curve) |
| **Collision/Absorption** | Alternative k-estimator |
| **Collision/Transport** | Alternative k-estimator |
| **Absorption/Transport** | Alternative k-estimator |

### Runtime Breakdown

A bar chart or table showing time spent in each phase:

- Initialization
- Reading cross sections
- Inactive batches
- Active batches
- Particle transport
- Tally accumulation
- Writing statepoints

### Source Distribution

If the statepoint contains a source bank:
- Click **"View Source"** to launch a 3D scatter plot of source particle positions.
- Particles are colored by energy or weight.

---

## Tallies Panel

The lower half of the viewer lists all tallies found in the statepoint.

| Column | Description |
|--------|-------------|
| **ID** | Tally identifier |
| **Name** | User-defined tally name |
| **Scores** | What was scored (flux, heating, fission, etc.) |
| **Nuclides** | Which nuclides (U235, total, etc.) |
| **Filters** | Applied filters (energy, mesh, material, etc.) |

### Actions per Tally

Click a tally to reveal action buttons:

| Action | Result |
|--------|--------|
| **View 3D** | Opens a 3D mesh tally visualization (if mesh filter exists) |
| **Overlay on Geometry** | Colors DAGMC/VTK geometry with this tally |
| **Heatmap** | Opens a 2D slice heatmap viewer |
| **Spectrum** | Plots energy spectrum (if energy filter exists) |
| **Spatial** | Plots 1D spatial distribution (if mesh filter exists) |

---

## k-Generation Convergence Plot

A line chart is shown at the top of the viewer:

- **X-axis:** Batch (or generation) number
- **Y-axis:** k-effective
- **Lines:**
  - Raw k per generation
  - Cumulative mean
  - Cumulative mean ± 2σ (shaded confidence band)

This helps you judge whether the simulation reached convergence.

---

## Tally Tree Sidebar

Click **"Show Tally Information"** in the Statepoint Viewer (or use `Tools → Visualizer → OpenMC → Tally → Show Tally Information`) to open a dedicated sidebar widget.

The Tally Tree shows:
- Hierarchical view of tallies
- Expandable nodes for scores and nuclides
- Quick-action buttons for each tally

---

## Global Tallies

Some statepoints contain global tallies (e.g., leakage, absorption rates). These are shown in a summary table near the top of the viewer.

---

## Tips

- **Environment changes:** If you switch Python environments in NukeIDE, the OpenMC state is automatically cleared. Reload the statepoint to use the new environment.
- **Large statepoints:** Files with many tallies or fine meshes may take a few seconds to load. A progress indicator is shown.
- **Source bank:** Source visualization requires the statepoint to have been written with `sourcepoint = True` in OpenMC settings.
