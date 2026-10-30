# Simulation Comparison

The Simulation Comparison widget lets you analyze results from multiple OpenMC runs side-by-side. Use it to compare k-effective across perturbations, inspect tally differences, check statistical consistency, or review depletion burnup curves.

---

## Opening the Comparison Widget

### Method 1: Menu

`Tools → OpenMC Studio → Simulation → Compare Simulations`

### Method 2: Command Palette

`Ctrl+Shift+P` → **`OpenMC/View: Compare Simulations`**

---

## Loading Statepoint Files

1. In the Comparison widget, click **"Add Statepoints"**.
2. Select one or more `statepoint*.h5` files from the file dialog. You can select multiple files at once.
3. Repeat to add more runs. Loaded runs are identified by file name.

Each entry is identified by its statepoint file name.

### Adding Depletion Results

Click **"Add Depletion"** and select one or more `depletion_results*.h5` files to enable the **Burnup** tab. Statepoint files and depletion results are tracked separately.

### Supported Statepoint Data

| Data                                       | Behavior                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Eigenvalue statepoints                     | Enable the **k-effective**, **Statistics**, and **Convergence** tabs      |
| Fixed-source statepoints                   | Tally and metadata comparison only; no k-effective tab                    |
| Statepoints from different OpenMC releases | Load if readable; the release is shown in the metadata card for each file |
| Corrupt or interrupted files               | Reported as a load error on that entry; other files stay loaded           |

> **Tip:** Use statepoints written by the same OpenMC release when you need the cleanest comparison.

---

## k-Effective Comparison

Once at least one loaded statepoint contains k-effective data, the **k-effective** tab shows:

### Statistical Summary

| Metric             | Description                                   |
| ------------------ | --------------------------------------------- |
| **Mean k-eff**     | Arithmetic mean across loaded eigenvalue runs |
| **Std Deviation**  | Spread of the run-level k-effective values    |
| **Minimum**        | Lowest k-effective                            |
| **Maximum**        | Highest k-effective                           |
| **Range**          | Maximum minus minimum                         |
| **Relative Error** | Standard deviation divided by the mean        |

### Comparison Table

| Column             | Description                              |
| ------------------ | ---------------------------------------- |
| **#**              | Loaded file index                        |
| **File**           | Statepoint file name                     |
| **k-eff**          | Combined k-effective                     |
| **Std Dev**        | k-effective standard deviation           |
| **Diff from Mean** | Difference from the mean across files    |
| **Rel. Diff (%)**  | Difference from the mean as a percentage |

A horizontal bar chart below the table compares each run against the mean. Differences are computed against the group mean, not against a user-selected reference run.

---

## Statistical Tests

The **Statistics** tab runs automatically after two or more statepoints load.

### k-Effective Consistency Test

OpenMC's combined k-effective values are checked with a weighted chi-square test:

| Field                    | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Reduced χ² (χ²/ndof)** | Chi-square per degree of freedom; also shows the verdict |
| **Weighted Mean k-eff**  | Inverse-variance weighted mean                           |
| **Weighted Uncertainty** | Uncertainty of the weighted mean                         |
| **Chi-Square (χ²)**      | Raw chi-square statistic                                 |
| **Degrees of Freedom**   | Number of files minus one                                |

A reduced χ² below 3.0 is reported as **consistent**; a higher value is reported as **inconsistent** and suggests systematic differences.

### Confidence Interval Overlap

The tab also draws each run's 95% confidence interval (`k ± 1.96σ`) and reports whether all intervals share a common range. Non-overlapping intervals are flagged as a possible significant difference.

### Tally Consistency

For each tally present in the loaded statepoints, the tab shows the mean, maximum deviation, and relative standard deviation across runs. Tally cards are marked consistent or variable based on that spread.

### Simulation Metadata

Each loaded file gets a metadata card with run mode, batches, particles per batch, tally count, OpenMC version (when available), and run date.

---

## Convergence Analysis

The **Convergence** tab evaluates each eigenvalue statepoint separately.

1. Click **"Analyze Convergence"** on a statepoint card.
2. The card reports the final k-effective, the relative drift percentage, the number of batches analyzed, a convergence recommendation, and a running-average sparkline.

Convergence is assessed per statepoint as k-effective drift across batches. Entropy overlays are not part of this tab; open the statepoint in the Statepoint Viewer's **Entropy** tab for Shannon-entropy convergence data.

---

## Burnup Chart Comparisons

Load one or more `depletion_results*.h5` files with **Add Depletion** to enable the **Burnup** tab.

### Controls

| Control          | Options                                                  |
| ---------------- | -------------------------------------------------------- |
| **Plot Type**    | **Nuclides** (concentration in g/cm³) or **k-effective** |
| **X-Axis**       | **Burnup** (MWd/kg, when available) or **Time** (days)   |
| **Scale**        | **Linear** or **Log** for the concentration axis         |
| **Material**     | Material selector for the nuclide plot                   |
| **Quick Select** | Shortcut buttons for common nuclides                     |

Select a depletion file in the left panel; **Add More** loads additional files. The header badges show final burnup, material count, and time-step count.

---

## Derived Tally Comparison

When the open project defines derived tallies, a **Derived** tab compares each persisted expression across the loaded statepoints. Rows show the aggregate mean (or sum of filter bins), standard deviation, and bin count per statepoint; results are matched by definition ID first and by name second. Missing tallies/scores/nuclides appear as inline errors instead of blank rows. The tab also notes that derived tallies are post-processing only and that uncertainty assumes independent tallies.

---

## Exporting Comparison Data

Click **"Export"** in the Comparison widget header and choose a destination.

The widget writes a single **CSV report** containing:

- k-effective comparison rows (file, k-eff, standard deviation) when eigenvalue data is loaded
- Tally rows per statepoint (tally ID, name, score, mean, standard deviation)
- Derived-tally rows when the project defines them
- Depletion summary and nuclide rows when depletion results are loaded

CSV is the only export format.

---

## Tips

- **Compare fewer files:** The summary table and bar chart stay readable with a small set of related runs.
- **Check the Statistics tab:** A reduced χ² above 3.0 is a prompt to inspect run settings or model differences before drawing conclusions.
- **Convergence first:** Run **Analyze Convergence** on each statepoint before comparing small k-effective differences.
- **Depletion data is separate:** Burnup charts come from `depletion_results*.h5`, not from a statepoint's batch data.
