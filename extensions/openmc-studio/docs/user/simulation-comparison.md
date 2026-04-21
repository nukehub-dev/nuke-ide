# Simulation Comparison

The Simulation Comparison widget lets you analyze results from multiple OpenMC runs side-by-side. Use it to compare k-effective across perturbations, validate depletion burnup curves, or judge convergence between different settings.

---

## Opening the Comparison Widget

### Method 1: Menu
`Tools → OpenMC Studio → Simulation → Compare Simulations`

### Method 2: Command Palette
`Ctrl+Shift+P` → **"Open Simulation Comparison"**

### Method 3: Dashboard
In the **Simulation Dashboard**, click **"Compare Runs"** after selecting two or more completed simulations.

---

## Loading Statepoint Files

1. In the Comparison widget, click **"Add Run"**.
2. Select a `statepoint*.h5` file from the file dialog.
3. Assign a **label** (e.g., "Nominal", "Cladding thickened", "Higher enrichment").
4. Repeat for each run you want to compare.

> **Tip:** You can also drag statepoint files directly from the Explorer into the Comparison widget.

### Supported Statepoint Versions

| Statepoint Version | Compatible? | Notes |
|--------------------|-------------|-------|
| Same major OpenMC version | Yes | Best results when all files come from the same OpenMC release |
| Different minor versions | Usually | A warning banner is shown if version mismatches are detected |
| Mixed eigenvalue / fixed source | Partial | k-effective comparisons are only available for eigenvalue runs |

---

## k-Effective Comparison

Once two or more statepoints are loaded, the **k-Effective** tab becomes active.

### Summary Table

| Column | Description |
|--------|-------------|
| **Run Label** | User-defined name for the run |
| **k-combined** | Combined k-effective ± 1σ |
| **Δk from Reference** | Absolute difference versus the first loaded run |
| **Relative Δk (pcm)** | Difference in per-cent-mille |

### k-Generation Overlay Plot

A line chart shows k-effective per generation for all loaded runs:

- **X-axis:** Generation number
- **Y-axis:** k-effective
- **Lines:** One per run, colored by label
- **Shaded bands:** ±2σ confidence intervals

Use the legend to toggle individual runs on or off.

---

## Statistical Tests

Click **"Run Statistical Tests"** to evaluate whether differences between runs are significant.

### t-Test for k-Effective Differences

A paired t-test is performed between the selected reference run and every other run.

| Field | Description |
|-------|-------------|
| **t-statistic** | Test statistic magnitude |
| **p-value** | Probability that the difference is due to random noise |
| **Significant?** | `Yes` if p < 0.05 (configurable threshold) |

> **Interpretation:** A low p-value (< 0.05) suggests the perturbation genuinely changed k-effective. A high p-value means the observed difference could be statistical noise.

### Test Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Confidence Level** | 95% | Threshold for significance |
| **Discard Inactive** | On | Exclude inactive batches from the test |
| **Minimum Batches** | 10 | Runs with fewer active batches are skipped |

---

## Burnup Chart Comparisons

For depletion studies, load multiple `depletion_results*.h5` files or statepoints from different burnup steps.

### What You Can Compare

- **k-Effective vs. Burnup** — Track reactivity swing across cycle lengths
- **Nuclide Inventory** — Overlay atom densities for key isotopes (e.g., U-235, Pu-239, Xe-135)
- **Power Distribution** — Compare assembly or pin powers at specific burnup points

### Using the Burnup Comparison Panel

1. Switch to the **Burnup** tab.
2. Select a **nuclide** or **score** from the dropdown.
3. Choose the **x-axis variable**: `burnup (MWd/kg)` or `time (days)`.
4. Click **"Plot Overlay"**.

> **Tip:** Right-click the chart to export the image as PNG or SVG.

---

## Convergence Analysis

The **Convergence** tab helps you decide whether all runs reached stable statistics.

### Shannon Entropy Convergence

If statepoints contain Shannon entropy data, overlay plots show entropy versus batch for each run. Flattening curves indicate adequate source convergence.

### Cumulative Mean Stability

A table shows the slope of the cumulative mean over the last N batches:

| Run Label | Slope (Δk / batch) | Stable? |
|-----------|-------------------|---------|
| Nominal | +1.2e-05 | ✓ Yes |
| Perturbed A | -4.5e-04 | ✗ No — extend batches |

> **Recommendation:** If any run shows `Stable? = No`, consider re-running with more active batches before drawing conclusions.

---

## Exporting Comparison Data

Click **"Export"** in the Comparison widget toolbar.

### Export Formats

| Format | Contents | Use Case |
|--------|----------|----------|
| **CSV** | Summary table (k, Δk, p-values) | Spreadsheets, reports |
| **JSON** | Full metadata + raw k-generation arrays | Post-processing scripts |
| **HTML Report** | Styled tables + embedded plots | Sharing with stakeholders |
| **LaTeX Table** | Summary statistics | Academic papers |

### Bulk Export

To export all loaded statepoints as a single archive:

1. Click **"Export → All Runs as ZIP"**.
2. Choose a destination folder.
3. The archive contains each statepoint, its label mapping, and a `comparison_manifest.json`.

---

## Tips

- **Reference run:** The first loaded run is automatically the reference. Drag runs in the sidebar to reorder and change the reference.
- **Color coding:** Runs are assigned colors automatically. Click the color swatch next to a label to customize it.
- **Large comparisons:** Comparing more than ~10 runs can clutter the overlay plot. Use the **filter box** to show only selected runs.
- **Statepoint versions:** If you see "Statepoint comparison shows no data," verify that all files were generated by the same OpenMC major version.
