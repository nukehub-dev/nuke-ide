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

- An interactive 3D volume rendered natively in the IDE.
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
5. Choose the **visualization mode**:
   - **Slice View** — 2D cross-section with interpolated tally values
   - **Full 3D Overlay** — Map tally values onto 3D geometry cells
6. Configure mode-specific options (see below).
7. Choose a tally, score, and nuclide.

### Slice View Mode

Best for: Inspecting a specific cross-section of your geometry.

The slice renders as a smooth shaded surface (per-point values
interpolate across a triangulated grid), so Shaded/Wireframe/Points/Edges
all apply. Wide grids decimate by whole grid steps (capped) to stay
interactive with complete coverage; points stay full-resolution.

**Options:**

- **Plane** — X, Y, or Z cross-section
- **Position** — Slice position in cm (shows geometry bounds; defaults to center)
- **Resolution** — 100×100 (fast) to 400×400 (high quality)
- **Rendering Style** — Smooth interpolation or pixelated (blocky) mesh cells

### Full 3D Overlay Mode

Best for: Full spatial context of tally results on the complete geometry.

With a DAGMC (`.h5m`) geometry, every volume surface is painted with the
mesh tally — Pixelated samples each triangle centroid (nearest mesh
cell, clamped at the mesh bounds, flat per-triangle color), while Smooth
Interpolation trilinearly interpolates at the surface vertices (blended
between mesh cells) — and opened in the native DAGMC viewer — volume,
material, and group isolation, instant color-by on the tally array, clip
planes, and the color legend all keep working. The tally mesh itself also
loads as voxel blocks inside the same scene (Viewer Settings → Tally
volume), so clipping reveals the hot interior instead of hollow shells.
The **Smooth volume** switch renders the same mesh as a trilinear
raycast volume instead of per-cell boxes (same colors, exact-zero cells
stay invisible, clip planes cut it identically) — turn Tally volume off
entirely to judge the surface drape alone. In Points shading mode the
volume renders as colored points over non-empty cell centers (void stays
empty), since surface-only point clouds cannot show the interior. Tally
objects draw after the ghosted shells so the interior stays readable
under transparency instead of drowning in it. X-Ray ghosts the geometry but
keeps tally colors (boxes and smooth volume) at full strength so the
hot interior stays readable; to inspect it without any transparency,
isolate volumes in the DAGMC Outline or cut a clip plane instead.
Void (exact-zero) cells collapse away rather than fogging the geometry;
lowering Opacity ghosts the rest with interiors kept visible. Any other
geometry opens the full mesh itself as voxel blocks, which the per-axis
clip planes cut through for interior exploration — with the ghosted CSG
cells underlaid for context (solid fills plus edge-only void shells, so
the big bounding boxes can't wash out the tally; theme-aware,
clip-cut with the tally; the header chip reads `mesh + N CSG`).
Right-click the canvas for a CSG Underlay toggle, and the CSG Outline
binds the overlay tab too: per-cell/material visibility, the Void
switch, show-all, and row-click highlight of the ghost (selection sync
is panel→canvas only — the tally canvas has no CSG picking).

**Options:**

- **Rendering Style** — Smooth interpolation or pixelated (blocky) mesh cells

On true 3D tally meshes the Viewer Settings sidebar gains the DAGMC
drape's **Tally volume** rows: a visibility master switch (hide the
voxels to inspect the CSG underlay alone) and **Smooth volume**, which
renders the same mesh as a trilinear raycast volume instead of
per-cell boxes (same colors, exact-zero cells stay invisible, clip
planes cut it identically). Solid Color mode and non-cell arrays fall
back to boxes. Slices and source clouds keep boxes only.

The graveyard termination volume always converts with the rest and stays
hidden by default; re-show it anytime with the DAGMC Outline's Graveyard
switch.

### What You See

- Your DAGMC or CSG geometry rendered in 3D (or 2D slice).
- Geometry surfaces colored by the tally value.
- Interactive controls for rotation, zoom, and clipping.

### Spatial Mismatch Warning

If the tally mesh bounding box does not align with the geometry, a yellow warning banner appears. The visualization still renders, but be cautious interpreting results near boundaries.

---

## Overlay Tally on Geometry with Source Particles

Best for: Validating that your source distribution covers the tally regions you care about.

### How to Open

1. Load a statepoint that contains a **source bank**.
2. In the **Tallies** list, click a tally that has a **mesh filter**.
3. Click **"+ Source"** (or **"Overlay with Source"** in the Tally Tree).

Or use the menu: `Tools → Visualizer → OpenMC → Tally → Overlay Tally on Geometry with Source`

### What You See

On a DAGMC (`.h5m`) geometry: the draped tally overlay, plus source
particles from the statepoint overlaid as points throughout the scene.
Source particles are colored by **energy** (weight fallback) through the
current colormap with their own data range, and follow the shared Point
size / Opacity sliders and clip planes. On any other geometry the tally
mesh itself opens as voxel blocks (no separate source layer).

> If the statepoint has no source bank, the visualization falls back to a standard geometry overlay.

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

| Visualization       | Requires                               | Best For                                    |
| ------------------- | -------------------------------------- | ------------------------------------------- |
| 3D Mesh Tally       | Mesh filter                            | Full 3D spatial understanding               |
| Overlay on Geometry | Geometry + mesh filter                 | CAD-integrated results (slice or full 3D)   |
| Energy Spectrum     | Energy filter                          | Spectral analysis, flux shapes              |
| Spatial Plot        | Mesh filter                            | 1D profiles along an axis                   |
| 2D Heatmap          | Mesh filter                            | Slice-by-slice inspection                   |
| Source Distribution | `source.h5` or statepoint with source  | Source convergence checks                   |
| Overlay + Source    | Geometry + statepoint with source bank | Correlating source birth with tally regions |
