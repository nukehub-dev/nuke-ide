# Optimization Framework

The Optimization Framework automates model studies in two modes:

- **Parameter Sweep** — vary material, geometry, or settings values over a range, run the resulting combinations as a batch, and review k-effective trends.
- **Criticality Search** — wrap OpenMC's `search_for_keff` to find the parameter value that produces a target k-effective.

---

## Opening the Optimization Framework

### Method 1: Dashboard

In the Simulation Dashboard, go to the **Simulation** tab and click **"Optimization"**.

### Method 2: Command Palette

`Ctrl+Shift+P` → **`OpenMC/View: Optimization Study`**

### Method 3: Menu

`Tools → OpenMC Studio → Advanced → Optimization Study`

---

## Workspace Layout

Use the mode selector at the top to switch between **Parameter Sweep** and **Criticality Search**. Sweep mode has four tabs: **Parameter Sweeps** (define sweeps), **Batch Runner** (start and monitor a run), **Results** (run history and tables), and **Analysis** (k-effective trends and statistics).

---

## Defining Parameter Sweeps

A sweep varies one model parameter over a linear or logarithmic range.

### Step 1: Add a Sweep

1. In the **Parameter Sweeps** tab, click **"Add Sweep"**.
2. Give the sweep a **Name**; the **Variable** field stores the label used when no parameter path is selected.
3. Choose a **Parameter Type**:
   - **Material** — a material density, temperature, or nuclide fraction.
   - **Geometry** — a cell temperature.
   - **Settings** — particles, inactive batches, batches, or random seed.
4. Choose the **Parameter Path**. The path list is populated from the current project.
5. Choose the **Range Type**: **Linear** or **Logarithmic**.
6. Enter the **Start Value**, **End Value**, and **Num Points** (2–1000).
7. Optionally set the display **Unit**, then click **Save**.

A new sweep starts disabled; enable it with its checkbox before running. Each sweep card also offers edit, duplicate, and delete actions.

### Step 2: Multiple Variables

Every enabled sweep is combined with every other enabled sweep as a **Cartesian product**. The Batch Runner shows the resulting total iteration count; with three sweeps at five points each, that is `5³ = 125` runs.

### Example: Enrichment Sweep

| Field          | Value           |
| -------------- | --------------- |
| Parameter Type | Material        |
| Parameter Path | `UO2 Fuel.U235` |
| Range Type     | Linear          |
| Start Value    | 2.0             |
| End Value      | 5.0             |
| Num Points     | 7               |
| Unit           | %               |

The runner computes seven evenly spaced values between 2.0 and 5.0.

### Example: Moderator Density

| Field          | Value           |
| -------------- | --------------- |
| Parameter Type | Material        |
| Parameter Path | `Water.density` |
| Range Type     | Linear          |
| Start Value    | 0.6             |
| End Value      | 1.0             |
| Num Points     | 5               |
| Unit           | g/cm³           |

> **Tip:** Start with material properties such as enrichment or density, and keep the range small while you validate the setup.

---

## Running a Batch

1. Open the **Batch Runner** tab.
2. Review the enabled sweep count and total iterations. The runner also validates the model and flags conflicts such as batches ≤ inactive batches.
3. Click **"Start Batch Run"**.
4. Watch the progress bar, iteration timeline, success/failure counts, and estimated remaining time. Per-iteration logs are available from the run view.
5. Click **"Stop"** to cancel the active run.

Iterations run **sequentially** under **Start Batch Run** / **Stop** control.

The Batch Runner offers to save the project before it starts; a criticality search requires an already saved project. Results are written under `optimization/<run-id>/` beside the project file.

---

## Viewing Results

### Run History

The **Results** tab lists previous optimization runs in a sidebar. Select a run to view its table:

| Column            | Description                   |
| ----------------- | ----------------------------- |
| **#**             | Iteration number              |
| **Sweep columns** | One column per sweep variable |
| **k-eff**         | Mean k-effective              |
| **σ (std)**       | Standard deviation            |
| **Time**          | Wall-clock seconds            |
| **Status**        | Success or failed             |

Click the trash icon to delete a run, or delete all runs from the sidebar header.

### k-Effective Trends

The **Analysis** tab plots k-effective against the first sweep variable, with error bars for each point. For multi-variable sweeps, the remaining variables appear in the results table.

The statistics cards report mean, minimum, maximum, range, standard deviation, and number of successful points. The table below the chart repeats the per-iteration values.

---

## Exporting Optimization Data

Click **"Export CSV"** in the Results table toolbar and choose a destination. The CSV contains:

- `Iteration`
- One column per sweep parameter path
- `k-eff`
- `sigma`
- `Time (s)`
- `Status`

CSV is the only export format.

---

## Criticality Search

Select **Criticality Search** in the mode selector to find the parameter value that yields a target k-effective (wraps `openmc.search_for_keff`).

| Setting                 | Description                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| **Parameter**           | Material density, temperature, or nuclide fraction to vary                                   |
| **Target k-eff**        | The k-effective to solve for (e.g. `1.0` for criticality)                                    |
| **Bracketing interval** | Optional low/high bracket with a bracketed method (`Bisect`, `Brent-Q`, `Brent-H`, `Ridder`) |
| **Initial Guess**       | Un-bracketed starting point (secant method) when no bracket is given                         |
| **Tolerance**           | Convergence tolerance on the parameter value                                                 |

Click **"Run Search"** to start; a **"Stop"** button cancels the active search. The result card reports the converged value and final k-eff ± σ, lists each iteration, and offers **"Apply to Model"** to write the converged value back into the project.

Nuclide-fraction parameters are renormalized within their element: changing one isotope's fraction scales its same-element siblings so the element total is preserved.

---

## Tips

- **Start small:** Test a sweep with a coarse range (2–3 points) and low particle count before running a full matrix.
- **Save first:** A batch run prompts for a save when needed; save the project before starting a criticality search.
- **Sequential runtime:** Plan for the full `product(points)` runtime; each iteration is a complete OpenMC run.
- **Reproducibility:** Set a fixed random seed in the Settings tab if you need deterministic results across sweep iterations.
