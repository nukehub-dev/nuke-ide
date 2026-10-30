# Cross-Section (XS) Plotting

The XS Plot view lets you query and visualize nuclear cross-section data directly from your `cross_sections.xml` library. No simulation required — just pick nuclides and reactions.

---

## Opening the XS Plot View

Use the Command Palette (`Ctrl+Shift+P`) → **"Plot Cross-Sections"**, or
`Tools → Visualizer → OpenMC → Plotting → Plot Cross-Sections`. The XS Plot
opens as an editor-area tab (there is no activity-bar icon or right-sidebar
panel).

---

## Basic Plot

### 1. Select Nuclides

- Type nuclide names in the input field (e.g., `U235`, `U238`, `H1`).
- Separate multiple nuclides with commas.
- The dropdown suggests available nuclides from your `cross_sections.xml`.

### 2. Select Reactions

Check the reactions you want to plot:

| MT      | Reaction                             | Default? |
| ------- | ------------------------------------ | -------- |
| 1       | Total (n,total)                      | ✓        |
| 2       | Elastic (n,elastic)                  |          |
| 18      | Fission (n,fission)                  | ✓        |
| 102     | Capture (n,gamma)                    | ✓        |
| 103–107 | Charged particles (n,p), (n,d), etc. |          |
| 16, 17  | (n,2n), (n,3n)                       |          |

### 3. Set Temperature

- Default: **294 K** (room temperature)
- OpenMC will Doppler-broaden the cross-sections to the selected temperature.

### 4. Plot

Click **"Plot Cross-Sections"**. The chart renders in the XS Plot tab:

- **X-axis:** Energy (eV), logarithmic scale
- **Y-axis:** Cross-section (barns), logarithmic scale by default
- **Lines:** One per nuclide-reaction pair

Hover over the chart to see exact values at any energy.

---

## Temperature Comparison

Compare the same nuclide/reaction at multiple temperatures to see Doppler broadening effects.

1. Enter a nuclide and reaction.
2. Select the **Temp** plot mode.
3. Add temperatures (e.g., `294, 600, 900, 1200`).
4. Click **"Plot Cross-Sections"**.

Each temperature gets its own line, making resonance broadening clearly visible.

---

## Materials Mode

Build one or more named materials and plot their macroscopic cross-sections.

1. Select the **Materials** plot mode.
2. Enter a **Material name**.
3. Add one or more **components**: pick a nuclide from the dropdown and enter
   a fraction between 0 and 1.
4. Click **Add Material**. Repeat to overlay more materials.
5. Click **"Plot Cross-Sections"**.

Fractions are normalized across the components, and the plotted curve is
macroscopic (Σ). There are no weight/atomic fraction or density controls in
this mode.

---

## Multigroup Cross-Sections

Collapse continuous-energy cross-sections into energy group structures:

1. After plotting, select a **Group Structure (Multigroup)** from the dropdown.
   The default is **Continuous Energy**; the available names come from OpenMC's
   built-in structures and any `group_structures.yaml` files.
2. The chart updates to show group-averaged cross-sections as bars.

---

## Thermal Scattering (S(α,β))

Plot thermal scattering data for bound atoms:

1. Select a thermal scattering material (e.g., `c_Graphite`, `h_H2O`, `h_ZrH`).
2. Enter one or more temperatures (comma-separated).
3. The plot shows inelastic, elastic, and total thermal scattering cross-sections in the thermal energy range (~0.01 meV to 10 eV).

---

## Energy Region Presets

Quickly zoom to important energy ranges:

| Region     | Range             | Use Case                 |
| ---------- | ----------------- | ------------------------ |
| Full       | 0.01 meV – 20 MeV | Complete picture         |
| Thermal    | < 1 eV            | Thermal reactor physics  |
| Resonance  | 1 eV – 100 keV    | Resonance absorption     |
| Epithermal | 1 meV – 100 keV   | Intermediate range       |
| Fast       | > 100 keV         | Fast reactors, shielding |

---

## Cross-Sections Path

The plugin looks for nuclear data in this order:

1. **Explicit path** set in the XS Plot panel
2. **Nuke setting** `nuke.openmcCrossSections` (`Settings → Nuke Utils → Cross Sections Path`)
3. **`OPENMC_CROSS_SECTIONS`** environment variable

If no path is found, the plugin shows a warning and prompts you to configure one.

---

## Tips

- **Resonance regions and markers** are annotated on the plot; use the Settings
  checkboxes to hide either layer.
- **Integral quantities** (resonance integral, thermal cross-section, Maxwellian
  average, average and integrated cross-section) appear in the **Integral
  Quantities** panel below the chart when **Calculate Integral Quantities** is on.
- Use the **Plotly modebar** to download the figure as PNG. The energy and
  cross-section axes are logarithmic by default.
