# Optimization Framework

The Optimization Framework automates model-driven studies across your OpenMC model in two modes:

- **Parameter Sweep** — vary input parameters (enrichment, density, geometry dimensions, …) over specified ranges, execute batch simulations, and collate results for analysis.
- **Criticality Search** — wrap OpenMC's `search_for_keff` to find the parameter value that produces a target k-effective.

---

## Opening the Optimization Framework

### Method 1: Dashboard

In the Simulation Dashboard, go to the **Simulation** tab and click **"Optimization"**.

### Method 2: Command Palette

`Ctrl+Shift+P` → **"OpenMC Studio: Optimization Study"**

### Method 3: Menu

`Tools → OpenMC Studio → Advanced → Optimization Study`

---

## Sweep Study Layout

Select **Parameter Sweep** in the mode selector at the top. Sweep mode has four sub-tabs: **Parameter Sweeps** (define variables), **Batch Runner** (execute and monitor), **Results** (k-effective trends), and **Analysis** (comparisons and statistics).

---

## Defining Sweep Variables

A sweep variable maps a model parameter to a range of values.

### Step 1: Add a Variable

1. In the **Sweep Variables** panel, click **"Add Variable"**.
2. Choose a **Parameter Type**:

| Parameter Type                | Description                                     | Example Values                  |
| ----------------------------- | ----------------------------------------------- | ------------------------------- |
| **Material Property**         | Density, enrichment, or composition fraction    | `UO2 enrichment = 3.0–5.0%`     |
| **Material Nuclide Fraction** | Atomic or weight fraction of a specific nuclide | `B-10 in water = 0–2000 ppm`    |
| **Geometry Dimension**        | Surface coefficient or lattice pitch            | `Fuel radius = 0.3–0.5 cm`      |
| **Settings Value**            | Particles, batches, or temperature              | `Particles = 1000–10000`        |
| **Cell Temperature**          | Temperature of a specific cell                  | `Fuel temperature = 500–1200 K` |

3. Select the **Target** (specific material, surface, cell, or setting).
4. Define the **Range**:

| Range Mode          | Description                       | Use Case                           |
| ------------------- | --------------------------------- | ---------------------------------- |
| **Linear**          | Evenly spaced values              | `start`, `stop`, `step` or `count` |
| **Logarithmic**     | Log-spaced values                 | Spanning orders of magnitude       |
| **Custom List**     | Explicit comma-separated values   | Irregular sampling                 |
| **Latin Hypercube** | Statistically stratified sampling | Surrogate model training           |

### Step 2: Multi-Variable Sweeps

Add multiple variables to explore combined effects:

- **Cartesian Product:** Every combination of variable values is simulated. With 3 variables at 5 points each, this produces `5³ = 125` runs.
- **Zipped / Simultaneous:** Variables advance together point-by-point. All lists must have the same length.

Select the combination mode in the **Sweep Settings** dropdown.

### Step 3: Reference Case

The **Reference Case** is the current project state before any sweep modifications. It serves as the baseline for comparison.

- Click **"Set from Current Project"** to capture the baseline.
- Toggle **"Include Reference Run"** to simulate the unmodified case alongside sweeps.

---

## Setting Parameter Ranges

### Example 1: Enrichment Sweep

| Field            | Value                             |
| ---------------- | --------------------------------- |
| Parameter Type   | Material Property                 |
| Target           | UO2 Fuel → Enrichment             |
| Range Mode       | Linear                            |
| Start            | 2.0                               |
| Stop             | 5.0                               |
| Count            | 7                                 |
| Resulting values | 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0 |

### Example 2: Moderator Density and Temperature

| Variable | Parameter           | Range Mode | Start | Stop | Count |
| -------- | ------------------- | ---------- | ----- | ---- | ----- |
| 1        | Water → Density     | Linear     | 0.6   | 1.0  | 5     |
| 2        | Water → Temperature | Linear     | 500   | 600  | 3     |

With **Cartesian Product** enabled, this produces `5 × 3 = 15` simulations.

### Example 3: Geometry Pin Radius

| Field            | Value                                         |
| ---------------- | --------------------------------------------- |
| Parameter Type   | Geometry Dimension                            |
| Target           | Surface "Fuel Outer Radius" → Coefficient `r` |
| Range Mode       | Linear                                        |
| Start            | 0.35                                          |
| Stop             | 0.45                                          |
| Step             | 0.02                                          |
| Resulting values | 0.35, 0.37, 0.39, 0.41, 0.43, 0.45            |

> **Tip:** When sweeping geometry dimensions, ensure region expressions remain valid. The framework warns if a swept value would invert a half-space (e.g., radius becoming negative).

---

## Running Batch Optimization

### Execution Settings

| Setting               | Description                                   | Default |
| --------------------- | --------------------------------------------- | ------- |
| **Parallel Runs**     | Number of simulations to run concurrently     | `1`     |
| **Use MPI**           | Run each case with MPI                        | Off     |
| **MPI Ranks per Run** | Number of MPI processes per simulation        | `4`     |
| **Reuse XML**         | Regenerate XML only when variables change     | On      |
| **Cleanup**           | Delete temporary run folders after completion | Off     |

### Starting the Sweep

1. Click **"Preview Matrix"** to see the full list of runs before executing.
2. Click **"Run Sweep"** to begin.
3. The **Run Control** panel shows:
   - Total runs
   - Completed / running / queued counts
   - Estimated time remaining
   - Per-run status with pass/fail icons

### Stopping and Resuming

- Click **"Stop"** to halt after the current batch of active runs finishes.
- Click **"Pause"** to hold the queue (active runs continue).
- Click **"Resume"** to continue a paused sweep.
- The sweep state is saved automatically; you can resume even after closing and reopening NukeIDE.

---

## Viewing k-Effective Trends

The **Results** panel plots k-effective (or any scalar tally) against sweep variables.

### Single-Variable Sweep

- A **line chart** shows k-effective vs. the swept parameter.
- Error bars represent the standard deviation from OpenMC.
- A **reference line** marks the baseline case if included.

### Multi-Variable Sweep

- Use the **Color By** dropdown to select the second variable; points are colored by its value.
- Or switch to the **Surface Plot** view for 2D parameter grids.

### Statistics Overlay

| Overlay            | Description                              |
| ------------------ | ---------------------------------------- |
| **k-eff ± 1σ**     | Shaded band around the mean              |
| **Reference Band** | ±1σ of the reference case for comparison |
| **Trend Line**     | Linear or polynomial fit to the data     |

---

## Comparing Results Across Iterations

### Iteration Table

The results table lists every run:

| Column              | Description                   |
| ------------------- | ----------------------------- |
| **Run ID**          | Sequential identifier         |
| **Variable Values** | One column per sweep variable |
| **k-effective**     | Mean k-effective              |
| **k-σ**             | Standard deviation            |
| **Runtime**         | Wall-clock time               |
| **Status**          | Success, failed, or cancelled |

Click any row to open that run's statepoint in the Statepoint Viewer.

### Relative Comparison

Select a **Reference Run** from the dropdown, then view:

| Metric           | Formula                       | Use Case                   |
| ---------------- | ----------------------------- | -------------------------- |
| **Δk**           | `k_i − k_ref`                 | Absolute reactivity change |
| **Δk/k (pcm)**   | `(k_i − k_ref) / k_ref × 10⁵` | Reactivity in pcm          |
| **% Difference** | `(k_i − k_ref) / k_ref × 100` | Percent change             |

### Statistical Tests

For comparing two or more runs:

| Test                                 | Description                                                | When Significant                            |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------- |
| **Student's t-test**                 | Tests if two k-effective means are statistically different | p-value < 0.05                              |
| **Welch's t-test**                   | Unequal variance variant                                   | When standard deviations differ             |
| **Overlapping Confidence Intervals** | Visual check of 1σ or 2σ bands                             | Non-overlap suggests significant difference |

Select runs in the table and click **"Run Statistical Test"** to compute.

---

## Exporting Optimization Data

Click **"Export Results"** in the toolbar to save sweep data for external analysis.

| Format      | Contents                   | Best For                   |
| ----------- | -------------------------- | -------------------------- |
| **CSV**     | Tabular run data           | Excel, MATLAB, pandas      |
| **JSON**    | Full metadata and results  | Python scripting           |
| **HDF5**    | Results + statepoint paths | Archiving, reloading later |
| **PNG/SVG** | Trend plots                | Reports and presentations  |

### Python Export Script

Click **"Generate Python Script"** to create a reproducible script that:

- Defines the same sweep matrix
- Runs OpenMC in a loop
- Collects results into a DataFrame

This is useful for running large sweeps on an HPC cluster outside NukeIDE.

---

## Criticality Search

Select **Criticality Search** in the mode selector to find the parameter value that yields a target k-effective (wraps `openmc.search_for_keff`).

| Setting                 | Description                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| **Parameter**           | Searchable parameter path to vary (e.g. a material density or temperature)                   |
| **Target k-eff**        | The k-effective to solve for (e.g. `1.0` for criticality)                                    |
| **Bracketing interval** | Optional low/high bracket with a bracketed method (`Bisect`, `Brent-Q`, `Brent-H`, `Ridder`) |
| **Initial Guess**       | Un-bracketed starting point (secant method) when no bracket is given                         |
| **Tolerance**           | Convergence tolerance on the parameter value                                                 |

Click **Run Search** to start; a **Stop** button cancels the search mid-iteration. The result card shows the converged parameter value and the final k-eff ± σ.

Nuclide-fraction parameters are renormalized within their element: changing one isotope's fraction scales its same-element siblings so the element total is preserved.

---

## Tips

- **Start small:** Test your sweep with a coarse range (2–3 points) and low particle count before running a full matrix.
- **Parallel safety:** When running multiple simulations in parallel, ensure each run uses a unique output directory. The framework handles this automatically.
- **Memory:** Large mesh tallies combined with many runs can fill disk space quickly. Enable **Cleanup** if you only need k-effective trends.
- **Reproducibility:** Set a fixed random seed in the Settings tab if you need deterministic results across sweep iterations.
- **Surrogate modeling:** Export sweep results and train a surrogate model (e.g., Gaussian process) to interpolate between simulated points and find optimal parameters faster.
