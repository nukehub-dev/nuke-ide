# Statepoint Viewer

The Statepoint Viewer is the main dashboard for inspecting OpenMC simulation results. It opens automatically when you click a `statepoint*.h5` file. It also opens for `openmc_simulation_n<N>.h5` files — the per-step statepoints a depletion run writes, which share the statepoint layout minus the source bank.

---

## Opening a Statepoint

### Method 1: Click

In the Explorer, Click any file matching `statepoint*.h5` or `openmc_simulation_n<N>.h5` (depletion per-step statepoints).

### Method 2: Menu

1. Go to `Tools → Visualizer → OpenMC → Statepoint → View Statepoint...`.
2. Choose a file from the workspace or browse.

### Method 3: Command Palette

Press `Ctrl+Shift+P`, type **"View Statepoint"**, and select a file.

---

## Viewer Layout

The Statepoint Viewer is organized into tabs: **Overview** (run configuration), **K-Effective** (convergence), **Entropy** (Shannon-entropy convergence), **Kinetics (IFP)** (only for statepoints with IFP tallies), **Tallies**, and **Performance** (runtime breakdown).

### Simulation Metadata

| Field                 | Description                                  |
| --------------------- | -------------------------------------------- |
| **File**              | Path to the statepoint                       |
| **Run Mode**          | `eigenvalue` or `fixed source`               |
| **Batches**           | Total number of batches run                  |
| **Particles/Batch**   | Number of particles per batch                |
| **Inactive Batches**  | Batches discarded for k-effective statistics |
| **Generations/Batch** | Generations per batch (for eigenvalue)       |
| **Energy Mode**       | `continuous-energy` or `multigroup`          |
| **Seed**              | Random number seed                           |
| **OpenMC Version**    | Version string from the simulation           |

### k-Effective Results (Eigenvalue Mode)

| Field                    | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| **k-combined**           | Final k-effective mean ± standard deviation            |
| **k-generation**         | Per-generation k-values (plotted as convergence curve) |
| **Collision/Absorption** | Alternative k-estimator                                |
| **Collision/Transport**  | Alternative k-estimator                                |
| **Absorption/Transport** | Alternative k-estimator                                |

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

| Column       | Description                                    |
| ------------ | ---------------------------------------------- |
| **ID**       | Tally identifier                               |
| **Name**     | User-defined tally name                        |
| **Scores**   | What was scored (flux, heating, fission, etc.) |
| **Nuclides** | Which nuclides (U235, total, etc.)             |
| **Filters**  | Applied filters (energy, mesh, material, etc.) |

### Actions per Tally

Click a tally to reveal action buttons:

| Action                  | Result                                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| **View 3D**             | Opens a 3D mesh tally visualization (if mesh filter exists)                    |
| **Overlay on Geometry** | Colors DAGMC/VTK geometry with this tally (slice or full 3D)                   |
| **+ Source**            | Colors geometry with tally _and_ overlays source particles from the statepoint |
| **Heatmap**             | Opens a 2D slice heatmap viewer                                                |
| **Spectrum**            | Plots energy spectrum (if energy filter exists)                                |
| **Spatial**             | Plots 1D spatial distribution (if mesh filter exists)                          |
| **Series**              | Charts this score across every sibling statepoint (see below)                  |

### Tally Series

The **Series** button (line-chart icon) plots one tally score across the
statepoints in the same directory: `statepoint*.h5` and the depletion
per-step files `openmc_simulation_n<N>.h5`. The chart shows the aggregated
value with ± standard-deviation error bars; the x-axis is the numeric
statepoint step (for example `statepoint.20.h5` plots at 20), not depletion
time.

Use the **Total/Mean/Max** selector to switch the aggregation; the chart and
error bars reload in place. Use the first/previous/slider/next/last controls to
move through steps. For a mesh tally, **Open 3D at this step** opens that
statepoint's mesh in the native tally viewer. **Shared color range** (on by
default) applies the min/max of the mesh cell means across the whole series, so
every step is displayed on one color scale. Non-mesh tallies still chart, but
the 3D handoff is unavailable.

The value is a sum over the selected score/nuclide bins. Regular-mesh tallies
whose only filter is the mesh are volume-weighted; other tallies use an
unweighted sum. Use the headless `openmc.tally-series` command for explicit
time values or scripted exports.

### Derived Tallies

When the statepoint sits beside an `.nuke-openmc` project that defines derived
tallies, the **Tallies** tab shows a **Derived Tallies** section above the user
tallies. Each card has a **DERIVED** badge and shows the stored formula, unit,
aggregate mean (or sum of filter bins) and standard deviation, plus:

| Action      | Result                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| **Plot**    | Bar chart of mean ± standard deviation per result bin                  |
| **Bins**    | Per-bin table with decoded filter labels, nuclide, mean, std. dev.     |
| **Compare** | Evaluates the same derived tally across sibling statepoints            |
| **CSV**     | Exports one row per filter bin with filter values, mean, and std. dev. |

Derived results are analysis-only: they are evaluated on demand from the
project definitions and are never added to simulation XML or Python. The
uncertainty assumes the underlying tallies are independent; a matching caveat
is shown in the section. If a definition references a tally/score/nuclide that
is absent from the statepoint, the card reports the specific evaluation error
instead of hiding it.

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

## Entropy Convergence

The **Entropy** tab plots the Shannon entropy of the fission source per batch when the run had an entropy mesh. It shows:

- the entropy history with a vertical marker at the end of the inactive batches,
- the final entropy in bits,
- the change over the last active batches and a trend hint (stable or still changing),
- a **CMFD entropy** toggle when the statepoint also contains CMFD entropy history (CMFD entropy starts at the CMFD solver batch).

Entropy is a source-convergence diagnostic, not a tally convergence test. A stable entropy trace is a useful hint, but confirm convergence with k-effective and tally statistics.

If the statepoint has no entropy history, the tab explains that an entropy mesh was not configured and links to the Simulation Dashboard's Convergence settings. Fixed-source runs do not produce entropy.

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

## Kinetics (IFP) Tab

For statepoints containing iterated fission probability tallies (generated when kinetics/IFP is enabled in the run settings), the **Kinetics (IFP)** tab shows point-kinetics parameters computed with `StatePoint.get_kinetics_parameters()`:

- **β_eff** — effective delayed neutron fraction (mean ± σ), plus a per-delayed-group breakdown when multiple precursor groups were scored.
- **Λ_eff** — effective neutron generation time (seconds).
- **k_eff reference** — the k-effective the parameters were normalized against.

Click **Export CSV** to save the parameters table alongside the statepoint (`<file>.kinetics.csv`).

---

## Tips

- **Environment changes:** If you switch Python environments in NukeIDE, the OpenMC state is automatically cleared. Reload the statepoint to use the new environment.
- **Large statepoints:** Files with many tallies or fine meshes may take a few seconds to load. A progress indicator is shown.
- **Source bank:** Source visualization requires the statepoint to have been written with `sourcepoint = True` in OpenMC settings.
