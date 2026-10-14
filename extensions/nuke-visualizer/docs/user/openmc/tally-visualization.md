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
planes cut it identically). While smooth draws, the CSG ghosts
auto-dim to faint context so stacked shells cannot veil the
projection; they return to full strength on boxes. Solid Color mode
and non-cell arrays fall back to boxes. Slices and source clouds keep
boxes only.

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
mesh itself opens as voxel blocks with the same source layer (tab title
gains `+ Source`; without a source bank the tally opens alone).

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

## Line Probe

Best for: Flux profiles along an arbitrary segment (e.g. across a fuel pin, through a shield wall).

### How to Open

1. Open a mesh tally in the native 3D tally viewer (**"View 3D"**).
2. Click **"Line probe"** in the viewer header.

### What You See

- A probe builder panel below the 3D view: statepoint path, tally id,
  score/nuclide, two endpoints **P0/P1** in cm, the sample count, and a
  **Smooth** switch. Only one tool panel is open at a time (probe and
  contour share the bottom strip), and each panel has a close button.
- Statepoint, tally, score, and nuclide arrive pre-filled from the open tab,
  so a run usually needs no typing. Endpoints default to the dataset's X
  axis through its center, with **X/Y/Z span** shortcuts for the other axes.
  Canvas picking stays in the measure tool.
- **Smooth** (default) trilinearly interpolates between mesh cells; turning
  it off samples nearest cells, showing the actual blocky mesh values (the
  same convention as the overlay Rendering Style).
- Running the probe samples the tally along the segment and renders the
  series (distance / position / value) in a table; **Export CSV** downloads
  the full series.

### Requirements

- The statepoint must contain the probed tally with a regular mesh filter
  (cylindrical meshes are rejected with a clear error, like the other
  tally exports).
- Missing dependencies (`h5py` for reading, `vtk` for the optional
  `.vtp` probe-path polyline) surface as panel errors naming the package.

---

## Contour

Best for: Flux iso-surfaces (e.g. the surface where the flux equals a
shielding limit, nested shells around a hot spot).

### How to Open

1. Open a mesh tally in the native 3D tally viewer (**"View 3D"**).
2. Click **"Contour"** in the viewer header.

### What You See

- A contour builder panel below the 3D view: statepoint path, tally id,
  score/nuclide, up to 8 **Iso values** in tally units (separated by spaces
  or commas — every value becomes a surface in one call), and a **Smooth**
  switch. Source fields arrive pre-filled from the open tab; only one tool
  panel is open at a time.
- **Smooth** (default) interpolates surface vertices along mesh edges;
  turning it off snaps vertices to edge midpoints, showing the blocky mesh
  cells (the same convention as the overlay Rendering Style).
- Running the contour opens the surfaces as a sibling tab next to the tally
  mesh, colored by the tally array with one iso value per vertex. The
  sibling is a full tally tab: Viewer Settings warp and threshold keep
  working on it with no extra steps.

### Requirements

- The statepoint must contain the contoured tally with a regular mesh
  filter of at least 2 cells per axis (cylindrical meshes are rejected with
  a clear error, like the other tally exports).
- Iso values that all miss the data range fail with an error naming the
  range; values that hit still extract when mixed with misses.
- Missing dependencies (`h5py` for reading, `vtk` for the `.vtp` write)
  surface as panel errors naming the package.

---

## Linked Cameras

Best for: Comparing two views of one file side by side from the same angle.

### How to Use

1. Open the same file in two viewer tabs.
2. In each tab's bottom nav bar, click the **link** icon (**Link cameras**).
3. Orbit either view — the linked views follow its direction and distance.

### What Syncs (and What Doesn't)

- Only the camera follows: the orbit direction and distance apply through
  each view's orbit handle, and every view keeps its own target and framing.
- Display settings never sync: warp, threshold, glyphs, color-by, clip, and
  shading stay per-view, so linked tabs can show different fields of the same
  data from one camera.
- Identity is the file path: views of different files never link, even with
  the toggle on. The toggle is per-view and defaults to off.
- Tally mesh, slice, overlay, source, and contour tabs are keyed by their
  source statepoint (or source) file, so tabs derived from one file link
  with each other — and never with tabs from another file.

---

## Threshold

Best for: Hiding low-flux (or out-of-range) cells to expose the hot region
of a mesh tally.

### How to Open

1. Open a mesh tally in the native 3D tally viewer (**"View 3D"**).
2. In the Viewer Settings sidebar, find the **Threshold** row beside Range
   and flip the switch, then narrow the min/max window.

### What You See

- Cells whose active color-by value falls outside the window disappear
  (voxel boxes collapse, mesh triangles fold away); the rest keep their
  colors. The status line reports the coverage (e.g. `threshold 8,412 of 10,000 shown`).
- The window tests the active array, including a transient derived field
  from the Calculator, and follows color-by switches (a custom window
  resets to the new data range so a stale window cannot blank the scene).
- Non-finite values (NaN from divide-by-zero fields) stay visible, matching
  the colormap's NaN-color rule. The smooth raycast volume ignores the
  window — switch back to voxel boxes to see it apply.

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
| Line Probe          | Mesh filter                            | Flux profiles along an arbitrary segment    |
| Contour             | Mesh filter                            | Flux iso-surfaces in a sibling tab          |
| 2D Heatmap          | Mesh filter                            | Slice-by-slice inspection                   |
| Source Distribution | `source.h5` or statepoint with source  | Source convergence checks                   |
| Overlay + Source    | Geometry + statepoint with source bank | Correlating source birth with tally regions |
