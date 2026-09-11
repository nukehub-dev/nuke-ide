# Base Visualizer — 3D Mesh & DAGMC Viewer

The Base Visualizer renders 3D geometry and scientific datasets with **native in-IDE viewers**. Files are converted to VTK by short-lived headless Python commands and rendered directly by three.js — no visualization server, no ports, no iframes.

---

## Supported File Formats

| Format     | Extension                                        | Notes                                       |
| ---------- | ------------------------------------------------ | ------------------------------------------- |
| VTK legacy | `.vtk`                                           | Structured and unstructured grids           |
| VTK XML    | `.vtu`, `.vtp`, `.vts`, `.vtr`, `.pvtu`, `.pvtp` | Parallel and serial XML formats             |
| DAGMC      | `.h5m`                                           | Nuclear CAD geometry; auto-converted to VTK |
| STEP       | `.step`, `.stp`                                  | CAD exchange format; auto-converted to VTK  |
| BREP       | `.brep`                                          | OpenCASCADE native; auto-converted to VTK   |
| STL        | `.stl`                                           | Stereolithography meshes                    |
| PLY        | `.ply`                                           | Polygon file format                         |
| OBJ        | `.obj`                                           | Wavefront OBJ                               |

> **Priority:** `.h5m` files open with the highest priority. If a statepoint exists in the same folder, NukeIDE may offer to overlay tally results instead.
>
> **Note:** `.step`, `.stp`, and `.brep` files take precedence over the text editor and open directly in the Visualizer.

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

## Interactive Controls

Once the file loads, the visualization panel shows an interactive 3D view with a control sidebar:

### Appearance

| Control        | What It Does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| **Opacity**    | Slider from 0 (invisible) to 1 (fully opaque)                             |
| **Shading**    | Shaded / Shaded + Edges / Wireframe / Points / X-Ray                      |
| **Color By**   | Choose a data array (e.g., temperature, flux) or "Solid Color"            |
| **Component**  | For multi-component arrays: Magnitude or a single component (X / Y / Z)   |
| **Color Map**  | Full ParaView preset list (34 maps — Viridis, Cool to Warm, Jet, RdBu, …) |
| **Invert/Log** | Reverse the colormap, or map values log-scaled (needs a positive range)   |
| **Range**      | Auto (data range) or a custom min/max the colormap clamps to              |
| **Scalar Bar** | Toggle the color legend on/off                                            |
| **Colors**     | Solid-color and background pickers                                        |
| **Sizes**      | Point size and line width sliders (line width is driver-dependent)        |

### Clipping

| Control         | What It Does                                     |
| --------------- | ------------------------------------------------ |
| **Enable Clip** | Turn the clipping planes on/off                  |
| **Clip Axis**   | X / Y / Z tabs, each remembering its own setting |
| **Position**    | Slider moving the plane through the volume       |
| **Unflip**      | Swap which side of the plane is visible          |

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

Click the **Screenshot** button in the control panel to capture the current view:

- **Format:** PNG, JPG, SVG, or PDF
- **Resolution:** Use current viewport or specify custom [width, height]
- **Transparent Background:** Optional

The image is saved to a timestamped file in your workspace or copied to the clipboard.

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

### DAGMC Outline Sidebar

The **DAGMC Outline** sidebar opens automatically with every DAGMC viewer
tab (or via `Tools → Visualizer → DAGMC Outline`), bound to the active
DAGMC viewer tab. Like the CAD panels it has an icon + subtitle header
(the bound viewer tab) and collapsible count-badge sections:

- **Volumes** — one row per `Volume_<id>` block: per-row icon plus a live
  status dot (green visible, muted hidden), the checkbox toggles
  visibility, clicking the row highlights the volume in the 3D canvas
  (click again to clear); picking a volume in the canvas selects its row.
  Hidden rows dim with an eye-closed marker. Hovering a row reveals an eye
  button isolating that volume (hide the rest). The material rides as a
  muted suffix — never repeated in the name.
- **Materials / Groups** — one row per name with the same icon, status
  dot, checkbox, and hover isolate button; unchecking hides every member
  volume. These sections need the `dagmc.info` model metadata (present for
  converted `.h5m` files); without it an info banner says so instead of
  bare text.
- **Graveyard** — show or hide the graveyard termination volumes.
- **Show all** — clear every hidden-set and restore all volumes.
- **Filter** — search box matching volume id, material, or group (for 20+-volume models).

Display settings (color-by, shading, clip) stay in the **Viewer Settings** sidebar; the viewer itself keeps an `N of M volumes` status line.

---

## Preferences

Conversion commands (STEP/DAGMC meshing) time out based on file size:

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
