# Tally Visualization

The OpenMC plugin offers multiple ways to visualize tally results from a statepoint file. Choose the method that best fits your analysis needs.

---

## Prerequisites

- A loaded `statepoint*.h5` file (see [Statepoint Viewer](statepoint-viewer.md))
- The statepoint must contain at least one tally

---

## 3D Mesh Tally

Best for: Understanding spatial distribution of results in 3D.

### How to Open

1. Load a statepoint.
2. In the **Tallies** list, click a tally that has a **mesh filter**.
3. Click **"View 3D"**.

Or use the menu: `Tools → Visualizer → OpenMC → Tally → Visualize Tally`

### What You See

- An interactive 3D volume rendered with ParaView/Trame.
- The mesh cells are colored by tally value using a selectable colormap.
- Controls for opacity, representation, and clipping work the same as the [Base Visualizer](../base-visualizer.md).

### Options

Before visualizing, you can select:
- **Score** — Which score to display (e.g., `flux`, `heating`)
- **Nuclide** — Which nuclide (e.g., `total`, `U235`)

> If the tally has only one score/nuclide, it is selected automatically.

---

## Overlay Tally on Geometry

Best for: Seeing tally results directly on your CAD/DAGMC geometry.

### How to Open

1. Load a statepoint.
2. Go to `Tools → Visualizer → OpenMC → Tally → Overlay Tally on Geometry`.
3. Select a **geometry file** (`.h5m` or `.xml`).
4. Select the **statepoint** (if not already loaded).
5. Choose a tally, score, and nuclide.

### What You See

- Your DAGMC or CSG geometry rendered in 3D.
- Geometry surfaces colored by the tally value.
- The graveyard volume is automatically filtered out for clarity.

### Spatial Mismatch Warning

If the tally mesh bounding box does not align with the geometry, a yellow warning banner appears. The visualization still renders, but be cautious interpreting results near boundaries.

---

## Energy Spectrum

Best for: Seeing how tally values vary with neutron energy.

### How to Open

1. Load a statepoint with a tally that has an **energy filter**.
2. In the Tallies list, click **"Spectrum"**.

Or open the **Tally Tree** sidebar, right-click a tally → **Energy Spectrum**.

### What You See

- A **log-log Plotly chart**:
  - X-axis: Energy (eV)
  - Y-axis: Tally value
- Error bars show relative standard deviation.
- Hover over points to see exact energy, value, and relative error.

### Multi-Score / Multi-Nuclide

- **"Plot All Scores"** — Overlays every score for the selected nuclide on one chart.
- **"Plot All Nuclides"** — Overlays every nuclide for the selected score.

---

## Spatial Distribution

Best for: 1D line plots of tally value along X, Y, or Z.

### How to Open

1. Load a statepoint with a **mesh tally**.
2. In the Tallies list, click **"Spatial"**.

### What You See

- A line chart with position (cm) on the X-axis and tally value on the Y-axis.
- By default, the Z-axis is plotted. The axis can be changed in the plot widget.

---

## 2D Heatmap Slices

Best for: Inspecting mesh tally slice-by-slice.

### How to Open

1. Load a statepoint with a **mesh tally**.
2. In the Tallies list, click **"Heatmap"**.

### What You See

- A 2D color heatmap of a single slice through the mesh.
- Controls:
  - **Plane:** XY / XZ / YZ
  - **Slice Index:** Step through slices with arrow buttons
  - **Score / Nuclide selectors**

### Animation

Click **"Play"** to animate through all slices automatically. Useful for presentations or quick scans of the full mesh.

---

## Source Distribution

Visualizes the source bank (starting particle positions/energies).

### How to Open

1. Click `source.h5` in the Explorer.

Or: `Tools → Visualizer → OpenMC → Tally → Visualize Source Distribution...`

### What You See

- A 3D scatter plot of source particle positions.
- Points can be colored by energy or weight.

---

## Summary Table

| Visualization | Requires | Best For |
|---------------|----------|----------|
| 3D Mesh Tally | Mesh filter | Full 3D spatial understanding |
| Overlay on Geometry | Geometry + mesh filter | CAD-integrated results |
| Energy Spectrum | Energy filter | Spectral analysis, flux shapes |
| Spatial Plot | Mesh filter | 1D profiles along an axis |
| 2D Heatmap | Mesh filter | Slice-by-slice inspection |
| Source Distribution | `source.h5` or statepoint with source | Source convergence checks |
