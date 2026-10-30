# Depletion / Burnup Visualization

The Depletion Viewer analyzes `depletion_results.h5` files produced by OpenMC's depletion solver. Track how nuclide concentrations, masses, activities, decay heat, and photon dose evolve over irradiation time.

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

The viewer has a summary line, a material sidebar, and a plot pane.

### Summary Line

The header shows three counts for the loaded file:

- **Materials** — number of burnable materials
- **Time Steps** — number of depletion steps
- **Nuclides** — total nuclides tracked

### Material Selector

A **Material** dropdown in the left sidebar lists every burnable material as
`Name (Mat <index>)`. Selecting a material reloads the nuclide list and chart
for that material.

### Plot Pane

The center/right area contains the chart toolbar and an interactive Plotly
chart. If the file has no burnup values, the X-axis falls back to **Time
(days)** and the burnup option is marked unavailable.

---

## Plot Types

Use the **Plot** selector above the chart to switch types:

| Plot Type                            | Y-Axis              | Use Case                             |
| ------------------------------------ | ------------------- | ------------------------------------ |
| **Concentration**                    | atoms/barn-cm       | Raw nuclide density                  |
| **Mass**                             | grams               | Total mass per nuclide               |
| **Normalized**                       | % of initial        | Relative change from start           |
| **Stacked composition**              | % of total per step | Overall composition over time        |
| **Activity**                         | Ci                  | Radioactivity for decay analysis     |
| **Decay heat**                       | W                   | Thermal power from radioactive decay |
| **Contact dose rate (absorbed-air)** | Gy/h                | Photon contact dose from activation  |
| **Contact dose rate (effective)**    | Sv/h                | Effective photon contact dose        |
| **Decay photon spectrum**            | photons/s           | Gamma lines from decay at one step   |

### X-Axis Options

- **Time** — days (linear or log)
- **Burnup** — MWd/kg (unavailable when the file has no burnup values)
- **Step** — discrete step index

---

## Nuclide Selection

### Manual

Use the **Search nuclides…** box to filter the checkbox list, then check the
nuclides to plot. The list shows 20 entries at a time; **Show N more…** reveals
the rest.

### Presets

Quick-select important groups (click a preset to toggle its members):

| Preset               | Nuclides                                           | Use Case                          |
| -------------------- | -------------------------------------------------- | --------------------------------- |
| **Major Actinides**  | U234, U235, U236, U238, Pu238–Pu242, Am241, Am242m | Burnup credit, criticality safety |
| **Fission Products** | Xe135, Sm149, Cs137, I135, Pm147, Nd143, Nd145     | Reactivity poisons, dosimetry     |
| **Burnable Poisons** | B10, Gd155, Gd157, Er166, Er167                    | Control rod / poison analysis     |
| **Noble Gases**      | Kr83, Kr85, Xe131, Xe133, Xe135                    | Gap release, pressure buildup     |

---

## Comparing Two Depletion Runs

Compare results from two different simulations (e.g., different enrichments, different spectra):

1. Use `Tools → Visualizer → OpenMC → Depletion → Compare Depletion Results...`
   or the Command Palette (**"Compare Depletion Results"**).
2. Pick **Case A (Reference)**, then **Case B (Comparison)** from the workspace
   or browse for each file.
3. The **Depletion Comparison** tab opens with both cases overlaid.

The comparison loads the first material from each file. Its sidebar offers:

- **Plot Type:** **Concentration**, **Normalized (%)**, or **Difference (A - B)**
- **X-Axis:** **Time (days)**, or **Burnup (MWd/kg)** when both files have it
- **Common Nuclides:** only nuclides present in both cases, checked by default
  for important actinides and fission products

Difference plots show the absolute concentration difference, not a relative
percentage.

> **Tip:** The comparison is opened from the command palette or menu; selecting
> two files in the Explorer and choosing a context-menu action is not required.

---

## Activity and Decay Heat

**Activity** and **Decay heat** are plot types, computed from the end-of-step
concentrations. There is no load-time option to enable them.

- Activity is shown in **Curies (Ci)** and covers every nuclide in the material.
- Decay heat is shown in **Watts (W)**.
- For either plot, enable **Show individual nuclide contributions** to list the
  top 15 contributors at the final step. The total curve is unaffected by
  nuclide selection.

---

## Photon Contact Dose Rate

**Contact dose** plots the photon dose rate produced by the activated material at every depletion state:

- **Absorbed-air** — absorbed dose in air, **Gy/h**.
- **Effective** — effective dose from ICRP-116 photon coefficients, **Sv/h**.

The calculation uses OpenMC's `Material.get_photon_contact_dose_rate` with a slab-geometry approximation and a photon build-up factor (default **2.0**, matching the FISPACT-II manual). Set the build-up factor in the chart toolbar and press Enter or leave the field to reload. Enable **By nuclide** to add a table of the largest contributors at the final state, with CSV export.

> **Limitations:** contact dose is a slab approximation. It does not include Bremsstrahlung, and it only covers unstable nuclides whose decay-photon data is present in the depletion chain.

Contact dose and decay spectra need a depletion chain with photon source data. Set `OPENMC_CHAIN_FILE` in the app environment (or point OpenMC at a chain file) before opening the viewer. If the material has no unstable nuclides with photon data, the viewer shows an explanatory empty state instead of a blank chart.

---

## Decay Photon Spectrum

**Decay photon spectrum** shows the gamma lines emitted by the activated material at one depletion step:

- Pick the step in the chart toolbar; the default is the final state.
- The x-axis is photon energy in **MeV** (log scale); the y-axis defaults to log.
- **Export CSV** writes one row per line (energy, intensity, unit, component).
- Total material activity and the decay-photon intensity are shown above the chart.

Most chain data produces discrete lines (photons/s at fixed energies). A chain with continuous photon spectra adds continuous components, plotted as spectral density per eV; the axis label and CSV `unit` column distinguish the two.

---

## Exports

CSV export is available in two places:

- **Decay photon spectrum** — the **Export CSV** button in the chart toolbar
  writes one row per photon line.
- **Contact dose, By nuclide** — the table's **CSV** button writes the
  contributor rows.

There is no generic plot-data export; use the Plotly modebar if you need an
image of the current chart.

---

## Tips

- **Log scale** is often better for concentrations — actinides and fission products can span many orders of magnitude.
- **Zoom** into the Plotly chart to inspect specific time regions (e.g., first few days for Xenon transient).
- **Save figure** as PNG using the Plotly toolbar for reports.
