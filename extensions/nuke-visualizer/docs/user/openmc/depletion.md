# Depletion / Burnup Visualization

The Depletion Viewer analyzes `depletion_results.h5` files produced by OpenMC's depletion solver. Track how nuclide concentrations, masses, and activities evolve over irradiation time.

---

## Opening Depletion Results

### Method 1: Click
Click `depletion_results.h5` in the Explorer.

### Method 2: Menu
`Tools → Visualizer → OpenMC → Depletion → View Depletion Results...`

### Method 3: Command Palette
`Ctrl+Shift+P` → **"View Depletion Results"**

---

## Viewer Layout

The Depletion Viewer has three main areas:

### 1. Summary Panel (Top)

| Metric | Description |
|--------|-------------|
| **Materials** | Number of burnable materials |
| **Time Steps** | Number of depletion steps |
| **Nuclides** | Total nuclides tracked |
| **Time Range** | From 0 to final time (seconds and days) |
| **Burnup** | Final burnup in MWd/kg (if available) |

### 2. Material Selector (Left)

A list of all burnable materials. Click one to analyze it.

| Column | Description |
|--------|-------------|
| **Index** | Material index in the depletion file |
| **Name** | Material name (from OpenMC model) |
| **Initial Mass** | Starting mass in grams |
| **Volume** | Material volume in cm³ |

### 3. Plot Area (Center/Right)

Interactive Plotly charts showing the selected material's evolution.

---

## Plot Types

Use the toolbar above the plot to switch types:

| Plot Type | Y-Axis | Use Case |
|-----------|--------|----------|
| **Concentration** | atoms/barn-cm | Raw nuclide density |
| **Mass** | grams | Total mass per nuclide |
| **Mass Fraction** | % of total | Relative composition change |
| **Activity** | Bq or Ci | Radioactivity for decay analysis |
| **Decay Heat** | Watts | Thermal power from radioactive decay |
| **Normalized** | fraction of initial | Relative change from start |
| **Stacked** | cumulative mass/concentration | Overall composition pie-over-time |

### X-Axis Options

- **Time** — seconds (linear or log)
- **Burnup** — MWd/kg (if available)
- **Step** — discrete step index

---

## Nuclide Selection

### Manual
Type nuclide names in the filter box (e.g., `U235 U238 Pu239 Xe135`).

### Presets
Quick-select important groups:

| Preset | Nuclides | Use Case |
|--------|----------|----------|
| **Major Actinides** | U234–U238, Pu238–Pu242, Am241 | Burnup credit, criticality safety |
| **Fission Products** | Xe135, Sm149, Cs137, I135 | Reactivity poisons, dosimetry |
| **Burnable Poisons** | B10, Gd155, Gd157 | Control rod / poison analysis |
| **Noble Gases** | Kr83, Kr85, Xe131, Xe133, Xe135 | Gap release, pressure buildup |

---

## Comparing Two Depletion Runs

Compare results from two different simulations (e.g., different enrichments, different spectra):

1. Select **two** `depletion_results.h5` files in the Explorer (hold `Ctrl` and click).
2. Right-click → **"Compare Depletion"**.
3. Or use `Tools → Visualizer → OpenMC → Depletion → Compare Depletion Results...`.

The **Depletion Comparison** viewer opens:

- Side-by-side or overlay plots
- Relative difference chart: `(B - A) / A × 100%`
- Select the same material from both files
- Nuclide selections apply to both runs simultaneously

> **Tip:** You can also diff two depletion files via the Explorer by selecting both and choosing **"Compare Selected"**.

---

## Activity and Decay Heat

If you enable **"Include Activity"** when loading data:

- Activity is computed from decay constants and end-of-step concentrations.
- Units: **Becquerels (Bq)** or **Curies (Ci)**.
- Decay heat is shown in **Watts**.
- Useful for shutdown heat removal and waste classification analysis.

---

## Data Table

Below the plot, a sortable table shows the numerical values at the **final time step**:

| Column | Description |
|--------|-------------|
| Nuclide | Name |
| Final Concentration | atoms/barn-cm |
| Final Mass | grams |
| Mass Fraction | % of total mass |
| Half-life | seconds (if known) |

Click a column header to sort. Use the search box to filter nuclides.

---

## Export

Click **"Export CSV"** to download the current plot data as a CSV file for further analysis in Excel, Python, or MATLAB.

---

## Tips

- **Log scale** is often better for concentrations — actinides and fission products can span many orders of magnitude.
- **Zoom** into the Plotly chart to inspect specific time regions (e.g., first few days for Xenon transient).
- **Save figure** as PNG using the Plotly toolbar for reports.
