# Cross-Section (XS) Plotting

The XS Plot view lets you query and visualize nuclear cross-section data directly from your `cross_sections.xml` library. No simulation required — just pick nuclides and reactions.

---

## Opening the XS Plot View

1. Click the **XS Plot** icon in the left sidebar (activity bar).
2. Or use the Command Palette (`Ctrl+Shift+P`) → **"Open XS Plot View"**.

The XS Plot panel opens, usually in the right sidebar.

---

## Basic Plot

### 1. Select Nuclides

- Type nuclide names in the input field (e.g., `U235`, `U238`, `H1`).
- Separate multiple nuclides with commas.
- The dropdown suggests available nuclides from your `cross_sections.xml`.

### 2. Select Reactions

Check the reactions you want to plot:

| MT | Reaction | Default? |
|----|----------|----------|
| 1 | Total (n,total) | ✓ |
| 2 | Elastic (n,elastic) | |
| 18 | Fission (n,fission) | ✓ |
| 102 | Capture (n,gamma) | ✓ |
| 103–107 | Charged particles (n,p), (n,d), etc. | |
| 16, 17 | (n,2n), (n,3n) | |

### 3. Set Temperature

- Default: **294 K** (room temperature)
- OpenMC will Doppler-broaden the cross-sections to the selected temperature.

### 4. Plot

Click **"Plot"**. A new tab opens with an interactive Plotly chart:

- **X-axis:** Energy (eV), logarithmic scale
- **Y-axis:** Cross-section (barns), logarithmic scale
- **Lines:** One per nuclide-reaction pair

Hover over the chart to see exact values at any energy.

---

## Temperature Comparison

Compare the same nuclide/reaction at multiple temperatures to see Doppler broadening effects.

1. Enter a nuclide and reaction.
2. Enable **"Temperature Comparison"**.
3. Add temperatures (e.g., `294, 600, 900, 1200`).
4. Click **"Plot"**.

Each temperature gets its own line, making resonance broadening clearly visible.

---

## Mixed Materials

Plot macroscopic cross-sections for a mixture of nuclides.

1. Enable **"Mixed Material Mode"**.
2. Add components:
   - Nuclide (e.g., `U235`)
   - Fraction (weight or atomic)
3. Optionally set overall **density** (g/cm³).
4. The resulting curve is the macroscopic cross-section Σ = N·σ in units of 1/cm.

---

## Reaction Rate Calculation

If you provide a **flux spectrum**, the plugin calculates reaction rates:

1. Enable **"Calculate Reaction Rates"**.
2. Enter or load a flux spectrum (energy bins + flux values).
3. The reaction rate R = ∫ φ(E)·Σ(E) dE is computed and displayed in a table.

---

## Multigroup Cross-Sections

Collapse continuous-energy cross-sections into energy group structures:

1. After plotting, select a **Group Structure** from the dropdown:
   - 2-group
   - 8-group
   - 16-group
   - 70-group
   - 172-group
   - CASMO-8, etc.
2. The chart updates to show group-averaged cross-sections as step functions.
3. A table shows the numerical values per group.

---

## Thermal Scattering (S(α,β))

Plot thermal scattering data for bound atoms:

1. Select a thermal scattering material (e.g., `c_Graphite`, `h_H2O`, `h_ZrH`).
2. Choose temperature.
3. The plot shows inelastic, elastic, and total thermal scattering cross-sections in the thermal energy range (~0.01 meV to 10 eV).

---

## Energy Region Presets

Quickly zoom to important energy ranges:

| Region | Range | Use Case |
|--------|-------|----------|
| Full | 0.01 meV – 20 MeV | Complete picture |
| Thermal | < 1 eV | Thermal reactor physics |
| Resonance | 1 eV – 100 keV | Resonance absorption |
| Epithermal | 1 meV – 100 keV | Intermediate range |
| Fast | > 100 keV | Fast reactors, shielding |

---

## Cross-Sections Path

The plugin looks for nuclear data in this order:

1. **Explicit path** set in the XS Plot panel
2. **`OPENMC_CROSS_SECTIONS`** environment variable
3. **Nuke Core setting** (`Settings → Nuke Utils → Cross Sections Path`)

If no path is found, the plugin shows a warning and prompts you to configure one.

---

## Tips

- **Resonance regions** are automatically annotated on the plot when zoomed into the resonance energy range.
- **Integral quantities** (resonance integral, thermal cross-section, etc.) are shown in a summary table below the plot.
- Use the **toolbar** above the plot to toggle log/linear axes, toggle lines, and download the figure as PNG.
