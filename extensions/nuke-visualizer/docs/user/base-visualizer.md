# Base Visualizer — 3D Mesh & DAGMC Viewer

The Base Visualizer renders 3D geometry and scientific datasets using **ParaView + Trame** under the hood. It runs a local Python server that streams an interactive visualization into an IDE panel.

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

Once the server loads, the visualization panel shows an interactive 3D view with a control sidebar:

### Appearance

| Control            | What It Does                                                   |
| ------------------ | -------------------------------------------------------------- |
| **Opacity**        | Slider from 0 (invisible) to 1 (fully opaque)                  |
| **Representation** | Surface / Surface with Edges / Wireframe / Points              |
| **Color By**       | Choose a data array (e.g., temperature, flux) or "Solid Color" |
| **Color Map**      | Select from 30+ presets (Viridis, Cool to Warm, Jet, etc.)     |
| **Scalar Bar**     | Toggle the color legend on/off                                 |

### Clipping

| Control         | What It Does                            |
| --------------- | --------------------------------------- |
| **Enable Clip** | Turn the clipping plane on/off          |
| **Clip Origin** | XYZ position of the clip plane center   |
| **Clip Normal** | Direction vector the plane faces        |
| **Invert Clip** | Swap which side of the plane is visible |

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
3. The VTK file is passed to the Trame server for visualization.

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

1. The backend detects the format.
2. It runs `python server.py base.convert-dagmc` (using MOAB/PyDAGMC) to extract geometry into VTK.
3. The VTK file is passed to the Trame server for visualization.

> Conversion may take a few seconds for large models. A loading spinner is shown.

### Volume Extraction

If you select a specific volume ID (e.g., from the Geometry Hierarchy), only that volume is extracted and visualized.

---

## Preferences

You can adjust the server timeout in settings:

- **Setting:** `nukeVisualizer.serverTimeout`
- **Default:** 30 seconds
- **Description:** How long to wait for the Python visualization server to start before showing an error.

---

## Troubleshooting

| Symptom                                 | Likely Cause                  | Fix                                                        |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| "Starting visualizer server..." forever | Python/Trame/ParaView missing | Run health check, install missing packages                 |
| "Conversion failed" for .h5m            | MOAB not installed            | `conda install moab` or `pip install moab`                 |
| Blank iframe after loading              | Server crashed                | Check **Nuke Visualizer** output channel for Python errors |
| Widget shows "No Visualization Loaded"  | No file selected              | Click a supported file or use Browse                       |

See the full [Troubleshooting Guide](troubleshooting.md) for more.
