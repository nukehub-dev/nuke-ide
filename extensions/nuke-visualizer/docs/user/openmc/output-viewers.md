# Output Viewers

The OpenMC plugin turns simulation output files into interactive 3D viewers. Double-clicking a recognized output file in the Explorer routes it to the right viewer automatically — the file is converted to VTK by the plugin's Python backend and rendered in an embedded 3D view with color-by, opacity, clipping, and screenshot controls.

---

## Particle Tracks (`tracks.h5`)

Recorded particle track segments, written when particle tracks are configured in OpenMC settings.

- **3D view:** polylines for every track segment. Use the viewer's **Color By** control with cell data `pdg` (particle type) or point data `energy`, `time`, `weight`.
- **Direction glyphs:** the Viewer Settings sidebar shows **Glyphs** rows (enable switch, Density slider, Glyph size slider) that draw decimated direction cones along the tracks — orientations come from polyline tangents, so they work with no backend change. Cones follow warp deformation, skip threshold-hidden segments, and color by the active Color By array; the status line reports how many of the points carry a cone.
- **Panel:** a tracks metadata table (batch, generation, particle ID, particle counts).
- **Header filters:** particle type, cell/material, and max-tracks/max-points caps re-run the conversion.

## Collision Tracks (`collision_track.h5`)

Individual collision sites recorded by OpenMC's collision track feature.

- **3D view:** a point cloud of collision sites — color by reaction MT, cell, or energy.
- **Panel:** a paginated collision table; MT and cell filter inputs in the header narrow the conversion.
- **Direction glyphs:** the viewer shares the tracks viewer's cone-instancing path — the same **Glyphs** rows appear in Viewer Settings once a dataset carries a 3-component point array to orient along (today's conversions carry none, so the rows stay hidden).

## Weight Windows (`weight_windows.h5`)

Weight window bounds on a regular mesh (from the weight window generator or FW-CADIS workflows).

- **3D view:** a rectilinear grid with one cell-data array per (bound, energy group), named `lower_g<i>` / `upper_g<i>` — the **Color By** control acts as the energy-group and lower/upper toggle.
- **Multi-mesh files:** when a file contains windows on more than one mesh, a **Mesh to display** selector appears in the panel ("Mesh N (M windows)"); switching meshes re-runs the conversion anchored to that mesh. Windows on other meshes are skipped and reported.
- **Panel:** summary cards per mesh/window (dimensions, energy groups, survival ratio).

## Derived Fields (Calculator) + Histogram

The tracks, collision-track, and weight-windows data panels open with a **Derived field (Calculator)** card plus a **Histogram** card.

- **Calculator:** type an expression over the dataset's array names and press **Apply**. The grammar is deliberately small (not a general parser): `a/b`, `a-b`, `mag(v)`, `log10(a)`, where `a`, `b`, `v` are array names shown under the input (for example `upper_g1/lower_g1` on a weight-windows mesh). Applying computes a transient array and colors the 3D view by it, exactly like picking a parsed array in Color By. Divide-by-zero yields NaN, which renders in each colormap's NaN color; `log10` of a zero or negative value is NaN for the same reason. A rejected expression shows a panel error and changes nothing — **Clear** drops the transient field and returns to Solid Color.
- **Histogram:** an SVG stats readout (min/max/mean/std, value counts) plus a bar chart over the **active** color-by array — derived or parsed — with a bin-count input and a **Log y** toggle for skewed tally distributions. It follows the Viewer Settings → Color by selection, so switching arrays re-bins instantly.

## Statistics

When a loaded dataset has at least two scalar arrays, the data panel adds a
**Statistics** card. **Show statistical plots** opens four tabs over the
loaded arrays (capped to the first eight so huge statepoints stay readable):

- **2D Histogram** — joint distribution of two selected arrays.
- **Scatter** — decimated pairwise scatter (up to 20,000 points).
- **Box** — min/Q1/median/Q3/max per array.
- **Parallel Coordinates** — multivariate rows colored by the active array.

NaN/non-finite values are excluded from bins and quantiles. The card is
available in the tracks, collision-track, and weight-windows data panels and
uses the existing Plotly stack (no new dependency).

## Dataset Inspector

`Tools → Visualizer → Dataset Inspector` opens a right-hand sidebar bound to
the active native viewer. It shows:

- **Summary** — dataset kind, point/cell counts, bounds.
- **Arrays** — every point and cell array with component count and range.
- **Statistics** — count, min/Q1/median/Q3/max, mean and population std for
  the selected array. Cell arrays on grids or triangle meshes also show the
  integral (value × cell volume/area) and the summed volume/area.
- **Table** — a paged preview of the selected array (coordinates plus
  components) with **Copy CSV**.

The table shows the first 200 rows so large meshes never materialize in the
DOM; the CSV action copies that same preview window. The panel follows the
active viewer tab and shows an empty state when the bound widget is not a
native dataset viewer.

## Particle Restart (`particle_restart.h5`, `particle_<batch>_<id>.h5`)

A single particle's recorded state, written when a particle is lost with restart enabled. This viewer is a React summary — no 3D conversion: batch, generation, particle type, energy, position/direction, and weight.

## Random Ray Results

Random ray output is plain VTK with no distinctive filename, so those files are opened explicitly:

1. `Ctrl+Shift+P` → **"Open as Random Ray Results..."**
2. Pick a `.vtk`, `.vti`, or `.vtr` file.

Voxel plot HDF5 files (`*voxel*.h5`, `plot_*.h5`) open directly on double-click — they are converted to `.vti` automatically. Known random ray arrays (flux, source, residuals, …) are detected and offered as quick-select color-by buttons.

## Geometry Summary (`summary.h5`)

Double-clicking `summary.h5` opens the geometry 3D view (hierarchy tree + 3D). The file is converted to `geometry.xml`/`materials.xml` on the fly, so this requires the `openmc` Python package in the active environment.

---

## Viewer Controls

Display settings live in the **Viewer Settings** sidebar (`Ctrl+Shift+P` → "Open Viewer Settings", or Nuke Tools → Visualizer → Viewer Settings), bound to the active 3D viewer tab. Grid datasets add **Volume** (transfer curve, MIP/composite, gradient shading) and **Slice** (X/Y/Z orthoslice preview) sections; `Tools → Visualizer → Dataset Inspector` opens the companion array/spreadsheet panel. Like the CAD panels it has an icon + subtitle header (the bound viewer tab) and collapsible count-badge sections: **Display** (Color by array; Component for multi-component arrays; the full 34-preset ParaView colormap list with Invert/Log toggles; Auto/custom color Range; color-legend toggle; solid-color and background pickers; Shading incl. Shaded + Edges, Feature Edges (30° dihedral threshold), Wireframe, Points, and X-Ray; point size, line width, and opacity sliders), **Clip** (per-axis X/Y/Z tabs remembering position/flip, badge `n/3` enabled plus a live status dot), **Playback** (Exodus time-step slider), **Measure** (distance toggle with an armed status dot), and **View** (ISO/T/F/R/X/Y/Z axis snaps, same action as the canvas bottom bar). Viewer headers are gone in the native VTK and DAGMC viewers — screenshot and reload sit on the canvas bottom bar (the camera/refresh icons next to Clip and Shading) and the top-left badge is the single file-name surface; viewers with real header content (tally kind chip, random-ray array quick-select, tracks/collision filter bars) keep their strip. Geometry (`geometry.xml`) viewers show Clip plus opacity and background; Exodus viewers show Color by, Map (with Invert/Log), the legend toggle, background, and the time-step slider. The tracks viewer additionally shows Glyphs rows in Display (direction cones with density + size sliders). Right-clicking the canvas opens the view-actions menu (Fit, Screenshot, Clip Planes, shading) with the same icon-per-row density as the CAD viewport menu. DAGMC viewers add Hide/Isolate for the selected volume and Show All Volumes when anything is hidden.

- **Resizable split** — drag the handle between the 3D area and the data panel to resize it (the handle shields the 3D view's mouse capture while dragging, so fast drags stay smooth).
- **Orientation cube and bottom bar** — shared with the CAD viewport: the labeled ±X/±Y/±Z triad in the top-right tracks the camera as you orbit (click a knob to snap to that standard view), the bottom bar drives ISO/top/front/right + fit + zoom plus Clip and Shading popovers anchored above it (X/Y/Z tabs + Flip + Offset slider with % readout, and a mode list — the same setters the Viewer Settings sidebar drives), and the top-left badge names the dataset. The gear shortcut opens Viewer Settings; DAGMC viewers add a DAGMC Outline shortcut and exclude/isolate for the selected volume.
- **Distance measure** — the sidebar measure toggle captures two clicks on the model surface and labels the distance (model units); Escape cancels the pending point, then the measurement, then the tool, and reloading clears it. Angle/radius measurement stays in CAD.
- **Point probe markers** — sampled points stay anchored in the scene with the newest sample accented and older samples muted; clearing the probe history or reloading the dataset removes them.
- **Missing dependencies** — if the active Python environment lacks `vtk`, the viewer shows an actionable panel (what to install, or switch environment in Settings → Nuke Utils) with a Retry button.

> **Tip:** Conversions run in the active Python environment and cache nothing — if you switch environments, reopen the file to re-convert.
