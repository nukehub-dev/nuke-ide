# Base Visualizer — 3D Mesh & DAGMC Viewer

The Base Visualizer renders 3D geometry and scientific datasets with **native in-IDE viewers**. Files are converted to VTK by short-lived headless Python commands and rendered directly by three.js — no visualization server, no ports, no iframes.

---

## Supported File Formats

| Format     | Extension                                        | Notes                                        |
| ---------- | ------------------------------------------------ | -------------------------------------------- |
| VTK legacy | `.vtk`                                           | Structured and unstructured grids            |
| VTK XML    | `.vtu`, `.vtp`, `.vts`, `.vtr`, `.pvtu`, `.pvtp` | Parallel and serial XML formats              |
| DAGMC      | `.h5m`                                           | Nuclear CAD geometry; auto-converted to VTK  |
| STEP       | `.step`, `.stp`                                  | CAD exchange format; auto-converted to VTK   |
| BREP       | `.brep`                                          | OpenCASCADE native; auto-converted to VTK    |
| Gmsh mesh  | `.msh`                                           | Imported as-is; auto-converted to ASCII VTK  |
| STL        | `.stl`                                           | Stereolithography meshes                     |
| PLY        | `.ply`                                           | Polygon file format                          |
| OBJ        | `.obj`                                           | Wavefront OBJ                                |
| ExodusII   | `.e`, `.exo*`                                    | Time series; opens in the time-slider viewer |

> **Priority:** `.h5m` files open with the highest priority. If a statepoint exists in the same folder, NukeIDE may offer to overlay tally results instead.
>
> **Note:** `.step`, `.stp`, `.brep`, and `.msh` files take precedence over the text editor and open directly in the Visualizer.

---

## Opening Files

### From the Explorer

Click any supported file in the workspace Explorer. A new **Visualizer** tab opens.

### From the Menu

1. Go to `Tools → Visualizer → Open Visualizer`.
2. Use the **Browse Files** button in the empty state to pick a file.

### Multiple Files

The visualizer supports **multi-instance** tabs. Each file gets its own tab with a unique ID. Re-opening the same file activates the existing tab instead of duplicating it.

---

## Comparison Workspace

Use the comparison workspace to compare two to four cases side by side without
manually matching cameras or color scales.

1. Choose one flow:
   - `Tools → Visualizer → Compare Files...` (also in the Nuke Tools
     sidebar) browses for 2–4 VTK, DAGMC, CAD, Gmsh, STL, PLY, or OBJ files
     and opens each in its own viewer.
   - Open each case first (VTK, DAGMC, Gmsh, or tally-native), then run
     `Tools → Visualizer → Compare Open Views...` and multi-select 2–4 open
     viewers.
2. The views split into A/B/C panes; four panes form a 2×2 grid (A/B on top,
   C/D below). Cameras stay linked across different files (orientation only,
   so each pane keeps its own framing distance), and the color range uses the
   union of each pane's active-array data range.
3. Viewer Settings opens with a **Comparison** section for the active pane.

| Control                | What It Does                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| **Link cameras**       | Sync the orbit direction across panes; each pane keeps its own distance |
| **Shared color range** | Map every pane on the union of active-array data ranges                 |
| **Show pane labels**   | Show the A/B/C badge on each canvas                                     |
| **Leave comparison**   | Unlink this pane and restore its previous camera link and range mode    |

Shared color range unions the active arrays' data ranges; it does not change
which array each pane colors by. Choose comparable arrays (for example the same
score in two cases) or turn the shared range off for unrelated quantities.

Run `Stop Comparison` (command palette or Nuke Tools) to unlink every pane.
Panes stay open and split. Comparison is a session-only workspace state: it is
not saved with the viewer state.

---

## Interactive Controls

Once the file loads, the visualization panel shows an interactive 3D view with a control sidebar:

Right-click the 3D canvas for **Fit to View**, **Save Screenshot**, **Clip
Planes**, and the shading modes. In a DAGMC viewer with a volume selected, the
same menu adds **Hide Volume N** / **Isolate Volume N**, plus **Show All
Volumes** when any volume, material, or group is hidden.

**Viewer Settings** is a narrow sidebar panel built like the CAD outline:
every row reserves a visible label column, so **Background**, **Point size**,
**Line width**, and **Opacity** keep their full text at the default 250 px
width, and section headers are 11 px uppercase with plain-integer count
badges. Dense rows wrap their extra controls only when the panel is too
narrow. Controls appear only when they apply: **Solid Color** and the DAGMC
categorical modes hide the scalar mapping rows (Color Map, Invert/Log, Range,
Threshold, Scalar Bar) instead of showing them disabled.

### Appearance

| Control        | What It Does                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opacity**    | Slider from 0 (invisible) to 1 (fully opaque)                                                                                                                        |
| **Shading**    | Shaded / Shaded + Edges / Feature Edges / Wireframe / Points / X-Ray                                                                                                 |
| **Color By**   | Choose a data array (e.g., temperature, flux) or "Solid Color"                                                                                                       |
| **Component**  | For multi-component arrays: Magnitude or a single component (X / Y / Z)                                                                                              |
| **Color Map**  | Full ParaView preset list (34 maps — Viridis, Cool to Warm, Jet, RdBu, …)                                                                                            |
| **Invert/Log** | Reverse the colormap, or map values log-scaled (needs a positive range)                                                                                              |
| **Range**      | Auto (data range) or a custom min/max the colormap clamps to                                                                                                         |
| **Threshold**  | Hide cells whose active-array value falls outside a min/max window (row appears beside Range)                                                                        |
| **Scalar Bar** | Toggle the floating color-legend card (array name, gradient, min/max) on/off; when on, **Title** overrides the array name and **Vertical labels** stacks the min/max |
| **Warp**       | Displace the mesh along a 3-component vector array (FEM deformation; row appears only when such an array exists)                                                     |
| **Colors**     | Solid-color and background pickers                                                                                                                                   |
| **Sizes**      | Point size and line width sliders (line width is driver-dependent); points render as round soft sprites                                                              |

**Feature Edges** keeps the shaded surface and draws only creases whose
dihedral angle exceeds 30°, so smooth tessellations stay clean while sharp
corners remain readable. **Shaded + Edges** still draws every triangle edge.
DAGMC viewers use their single surface-edge overlay for both edge modes.

### Warp (FEM Deformation)

Meshes from FEM exports carry a nodal displacement array (typically `DISP`).
The **Warp** row in Viewer Settings (visible only when the file has a
3-component point array) deforms the mesh client-side so small strains become
visible, with mesh normals recomputed so lighting stays correct:

| Control          | What It Does                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warp switch**  | Turn the deformation on/off                                                                                                                                                 |
| **Vector array** | Which 3-component point array displaces the mesh                                                                                                                            |
| **Scale mode**   | `True scale (x1)` for real displacement, `Auto (10% of size)` to magnify the largest displacement to a tenth of the model size, or `Capped exaggeration` for a custom value |
| **Exaggeration** | Slider + numeric input for the custom value (editing either switches to Capped); the reset button restores the auto scale                                                   |

Warp applies instantly with no reload: fit, clip planes, and the measure tool
follow the deformed mesh, and the status line reports the applied factor
(e.g. `warped x23.5`). Voxel-block grids keep their layout (their positions
are cell centers, not displaceable nodes).

### Threshold (Hide Cells)

The **Threshold** row in Viewer Settings (beside Range, visible whenever a
data array is the active color-by) hides cells whose active-array value
falls outside a min/max window — flux below a cutoff, for example. The
window follows the Range dual-control pattern: an enable switch, numeric
min/max inputs with per-side data resets, a full-range reset, and a
dual-thumb slider over the data range.

Threshold tests the active color-by array, including transient derived
fields, and combines with warp (warp displaces first, then cells hide).
Switching the color-by array clears a custom window back to the new data
range (so a stale window cannot blank the scene) while the switch stays
on. The status line reports the coverage (e.g. `threshold 8,412 of 10,000
shown`); non-finite values stay visible, matching the NaN-color rule. The
smooth raycast volume and the grid cell-center cloud ignore the window.

### Clipping

| Control         | What It Does                                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| **Enable Clip** | Turn the clipping planes on/off                                                      |
| **Clip Axis**   | X / Y / Z tabs, each remembering its own setting                                     |
| **Position**    | Slider moving the plane through the volume                                           |
| **Unflip**      | Swap which side of the plane is visible                                              |
| **Cap cut**     | Fill the clipped cross-section of a closed triangle mesh so the cut reads as a solid |

Caps are built per enabled plane from closed surface meshes (DAGMC volumes,
VTK/STL/FEM surfaces). Open shells and point/line data stay hollow. Cap
color follows the solid or categorical block color and the current opacity.

### Volume

Axis-aligned 3D grids (`.vti`, `.vtr`, tally meshes, weight-window grids)
gain a **Volume** section in Viewer Settings:

| Control           | What It Does                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Volume**        | Show or hide the volume (boxes or smooth raycast)                                                  |
| **Smooth**        | Trilinear raycast volume instead of per-cell voxel boxes (WebGL2)                                  |
| **Blend**         | `MIP` keeps the hottest sample per ray; `Composite` accumulates front-to-back alpha                |
| **Shade**         | Gradient headlight shading inside the volume                                                       |
| **Opacity curve** | Piecewise-linear alpha over display intensity; add/remove points, Reset returns to the linear ramp |

The opacity curve is the volume transfer function: the x position is display
intensity after the active colormap range/log mapping, and the alpha is the
sample opacity. MIP remains the default so existing tally views look unchanged.

### Slice

For cell-centered grids the Viewer Settings sidebar also shows **Slice**:
X/Y/Z orthoslices, a position slider, a Smooth switch (linear blend between
two cell layers), and a live 2D preview painted with the active colormap.
The preview is a data inspection aid; the 3D camera never moves.

### Find Data

The magnifier button on the native VTK/tally viewer bottom bar opens
**Find Data**. Pick a point or cell array, then query it with the small
closed grammar:

- `value >= 1.5`, `value < 0`, `value == 10`, `value != 0`
- `value in [min, max]` (inclusive)
- `id == 42` (explicit ids or the 0-based tuple index)
- `name contains fuel` (case-insensitive, when the dataset carries names)
- combine predicates with `and` (no OR/nesting)

**Select** highlights the matching tuples in orange on the canvas; **Clear**
drops the highlight; **Extract CSV** downloads index/value rows for the
selection. Non-finite values never match. The highlight is view-only and is
cleared when the dataset reloads.

### Probe

The pulse button on the native viewer bottom bar opens **Probe**:

- **Point** tab: click **Pick points**, then click the canvas. Each sample
  records X/Y/Z, the active array, and its value; **Clear** resets the list and
  **Export CSV** downloads it. Solid Color still records coordinates, with an
  empty value. Every picked point leaves a world-anchored marker on the
  canvas; the newest marker is larger and accented, older samples stay muted,
  and all markers clear with **Clear** or a dataset reload.
- **Line** tab: choose a point/cell array, two endpoints (`x, y, z`), and a
  sample count, then **Run profile**. The headless `base.probe` command samples
  the line and returns a distance-vs-value chart, table, and CSV export. Point
  arrays interpolate between vertices; cell arrays use the containing cell.
  Line profiles need a file-backed viewer — converted tally tabs keep their
  existing tally line probe.

Probe state is view-only and cleared when the dataset reloads. `vtk` must be
installed in the active Python environment for line profiles; point probing is
client-side.

### Mesh quality

The checklist button on the native viewer bottom bar opens **Mesh quality**.
Pick `Aspect ratio`, `Area`, `Min angle`, or `Volume`; the viewer runs the
headless `base.mesh-quality` command, writes `mesh_quality_<metric>` as a cell
array, and opens the result in a new viewer tab ready for Color by. This needs
`vtk` in the active Python environment and a surface/tetrahedral mesh.

### Axes grid

Viewer Settings → **View → Grid** draws a bounding-box axes grid with nice
tick labels for the active dataset. Labels follow the camera and drop out
when they overlap or leave the viewport. The grid is view-only and is not
saved into the dataset.

### Saved views

Viewer Settings → **View → View state** has **Save** and **Restore**. Save
captures the camera, color mapping, shading, opacity, clip/threshold/warp,
volume/slice, legend, and grid settings for that viewer tab; Restore applies
them again after a reload. Entries live in the `nukeVisualizer.viewerStates`
preference, keyed by the viewer tab.

### Camera

| Control          | What It Does                                     |
| ---------------- | ------------------------------------------------ |
| **Reset Camera** | Center and fit the view to the data              |
| **Preset Views** | Isometric, Front, Back, Left, Right, Top, Bottom |

### Background

- Choose a solid background color (default dark blue-gray for dark theme, light for light theme).
- The IDE theme is automatically propagated to the visualizer.

---

## Screenshots

The bottom bar has a one-click **Screenshot** button (PNG at the current
viewport) and an **Export** menu for the rest:

- **Format:** PNG, JPEG, or WebP
- **Scale:** 1×, 2×, or 4× the viewport resolution
- **Transparent Background:** PNG/WebP only (JPEG has no alpha)
- **Copy:** copy the image to the clipboard where the browser shell supports
  `ClipboardItem`; otherwise a warning suggests downloading instead

Files download with the dataset name and a timestamp, e.g.
`native-image-20261028-120000.png`.

The same menu has a **Dataset** section with **CSV** and **VTK** buttons. They
run the headless `base.export` command on the loaded dataset and download the
result. This needs `vtk` in the active Python environment; a missing
dependency shows an error instead of a partial file.

---

## Exodus Time Series

Opening a `.e` / `.exo*` file loads its steps into the **time-slider
viewer**: first/prev/slider/next/last stepping plus an instant per-step
array switch (no reload), with the same Color by / Map / legend /
background controls as the other viewers and the step in the Viewer
Settings Playback section. Extraction needs `netCDF4` (or `meshio` for
the single-step fallback) in the Python environment.

### Animation Export

The header **Export** button records the loaded steps to a `.webm` file
through the browser-built-in `MediaRecorder` (VP9 preferred — no encoder
to install). Each step paints at the slider's decimated resolution with
the current color-by state and stays on screen half a second while a
header progress row with **Cancel** tracks the capture; the file
downloads when the last step is recorded and the slider returns to its
starting step.

- The export is WYSIWYG: colors use the current global range and
  per-step re-ranging is off, so brightness may flicker between steps.
- Shells without `MediaRecorder` (headless builds) cannot record — the
  export reports a clear error instead of silently doing nothing.

---

## CAD Specifics (STEP / BREP)

### Auto-Conversion

When you open a `.step`, `.stp`, or `.brep` file:

1. The backend detects the format.
2. It runs `python server.py base.convert-step` (using **gmsh** + OpenCASCADE) to mesh the geometry into VTK.
3. The VTK file is parsed and rendered natively in the IDE.

> Conversion time depends on model complexity and mesh density. A loading spinner is shown while gmsh generates the surface mesh. The result is cached, so re-opening the same file is instant.

### Requirements

CAD conversion requires **gmsh** in your Python environment:

```bash
pip install gmsh
# or
conda install -c conda-forge gmsh
```

---

## Gmsh Mesh Specifics

Opening a `.msh` file imports the existing Gmsh mesh and writes a legacy
ASCII VTK file for the native viewer. The mesh is never regenerated or
re-meshed, and the converted file is cached so reopening the same file is
instant. Volumetric meshes render their outer boundary surface, with shared
interior faces omitted. This requires **gmsh** in the active Python
environment:

```bash
pip install gmsh
# or
conda install -c conda-forge gmsh
```

---

## DAGMC Specifics

### Auto-Conversion

When you open a `.h5m` file:

1. The viewer tab opens immediately with a loading overlay.
2. The backend converts the file (`base.convert-dagmc-multiblock`, cached) while the spinner shows.
3. The multiblock volumes load into the tab; conversion failure shows the
   error panel in the same tab with a jump to the generic viewer.

> Conversion may take a few seconds for large models. Re-opening the same file is instant (cached conversion, live tab reused).

### Volume Extraction

If you select a specific volume ID (e.g., from the Geometry Hierarchy), only that volume is extracted and visualized.

### Color by Material, Volume, and Group

Converted `.h5m` files carry per-volume material names and group membership
from `dagmc.info`, so **Viewer Settings → Color by** also offers **Material**,
**Volume**, and **Group**:

- **Material** paints every volume with one deterministic color per material
  name (case and surrounding whitespace are ignored — `Fuel` and `fuel`
  match; the Graveyard termination material is muted grey). Volumes without a
  material fall back to the solid color.
- **Volume** paints every volume with its own deterministic color (keyed by
  volume id), so neighboring volumes stay visually distinct.
- **Group** paints each volume with the color of its primary group — the
  first group (in model order) containing the volume. Volumes in no group
  fall back to the solid color.

These modes have no scalar mapping, so the colormap, component, range,
threshold, and color legend rows are hidden (not shown disabled) and the
panel shows a muted `Color by material`, `Color by volume`, or `Color by
group` note. Unlike Material mode, Volume and Group are structural: graveyard
volumes keep their normal category color (the Graveyard switch still hides
them). The same colors appear as swatches on the DAGMC Outline material and
group rows; picking a data array in Color by switches back to scalar mapping
instantly. **Solid Color** follows the same rule: only the Color by row and
the solid-color picker remain among the mapping controls.

### DAGMC Outline Sidebar

The **DAGMC Outline** sidebar opens automatically with every DAGMC viewer
tab (or via `Tools → Visualizer → DAGMC Outline`), bound to the active
DAGMC viewer tab. Like the CAD panels it has an icon + subtitle header
(the bound viewer tab) and collapsible count-badge sections with 11 px
uppercase headers and 24 px rows:

- **Volumes** — one row per `Volume_<id>` block: per-row icon plus a live
  status dot (green visible, muted hidden), the checkbox toggles
  visibility, clicking the row highlights the volume in the 3D canvas
  (click again to clear); picking a volume in the canvas selects its row.
  Hidden rows dim with an eye-closed marker. Hovering a row reveals an eye
  button isolating that volume (hide the rest). The material rides as a
  muted suffix — never repeated in the name.
- **Materials / Groups** — one row per name with the same icon, status
  dot, checkbox, and hover isolate button; unchecking hides every member
  volume. Material and group rows carry a small swatch matching the canvas
  color used by **Color by → Material** / **Group**. These sections need the
  `dagmc.info` model metadata (present for converted `.h5m` files); without
  it an info banner says so instead of bare text.
- **Graveyard** — show or hide the graveyard termination volumes (hidden
  by default; conversion keeps the block so the toggle takes effect on
  either setting). Isolating a graveyard row with the hover eye also turns
  this switch on, so the canvas shows the graveyard instead of going blank
  (`Show all` still keeps it off).
- **Show all** — clear every hidden-set and restore all volumes.
- **Filter** — search box matching volume id, material, or group (for 20+-volume models).

Display settings (color-by, shading, clip) stay in the **Viewer Settings** sidebar; the viewer itself keeps an `N of M volumes` status line.

---

## Headless Analysis Commands (advanced)

The base backend also exposes analysis commands for scripts and automation:

```bash
python server.py base.describe --file model.vtk --array cell:flux
python server.py base.integrate --file model.vtk --array cell:flux --volume
python server.py base.mesh-quality --file model.vtk --output quality.vtu --metric aspect
python server.py base.export --file model.vtk --format csv --output model.csv
python server.py base.probe --file model.vti --array cell:flux --path "0.5,0.5,0.5;3.5,0.5,0.5" --samples 100
python server.py base.convert-gmsh --file mesh.msh
```

- `base.describe` returns min/Q1/median/Q3/max/mean/std/count for one point or
  cell array.
- `base.integrate` returns the integral and mean of a scalar array over cell
  volumes or surface areas (use `--surface` for area integration).
- `base.mesh-quality` writes the same dataset with a quality cell array
  (`area`, `min-angle`, `aspect`, or `volume`) for color-by in the viewer.
- `base.export` writes CSV (one row per point/cell tuple), VTK, or glTF; use
  `--array cell:flux` to export one array and `--block N` to restrict a
  block/volume. glTF is available only when the installed VTK provides the
  writer.
- `base.probe` samples one array at `--points "x,y,z;…"` or along a `--path`
  polyline (`--samples N`); it returns values plus a `dataRange`.
- `base.convert-gmsh` imports an existing Gmsh `.msh` mesh and writes ASCII
  VTK without remeshing; the result path and node/element counts are JSON.

All print one JSON object and exit non-zero with `{"error": …}` on bad input;
heavy VTK imports are lazy, so the commands fail cleanly when `vtk` is not
installed.

---

## Preferences

Conversion commands (STEP, DAGMC, and Gmsh) time out based on file size:

- **Setting:** `nukeVisualizer.serverTimeout` / `nukeVisualizer.serverTimeoutPerMB`
- **Defaults:** 30 seconds + 0.5 seconds per MB (capped at 10 minutes)
- **Description:** How long a headless conversion may run before it is
  cancelled with an error. Raise either value for very large models.

---

## Troubleshooting

| Symptom                                          | Likely Cause         | Fix                                                                    |
| ------------------------------------------------ | -------------------- | ---------------------------------------------------------------------- |
| "Loading..." forever / conversion never finishes | Python/`vtk` missing | Run health check, install missing packages                             |
| "Conversion failed" for .h5m                     | MOAB not installed   | `pip install --extra-index-url https://shimwell.github.io/wheels moab` |
| Blank 3D view after loading                      | Conversion crashed   | Check **Nuke Visualizer** output channel for Python errors             |
| Widget shows "No Visualization Loaded"           | No file selected     | Click a supported file or use Browse                                   |

See the full [Troubleshooting Guide](troubleshooting.md) for more.
