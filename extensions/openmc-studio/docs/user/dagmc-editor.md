# DAGMC Editor

The DAGMC Editor is a visual tool for inspecting and editing faceted CAD geometry stored in `.h5m` files. You can view volumes, assign materials, manage groups, preview the mesh in 3D, and re-facet from source CAD — all inside NukeIDE.

---

## Opening the Editor

### Method 1: Click

Click any `.h5m` file in the Explorer.

### Method 2: Command Palette

`Ctrl+Shift+P` → **"OpenMC Studio: Open DAGMC Editor"**

### Method 3: Menu

`Tools → OpenMC Studio → Geometry → DAGMC Editor`

---

## Tabs

### Volumes

Displays all volumes in a scrollable grid. Each card shows:

| Property      | Description                                 |
| ------------- | ------------------------------------------- |
| **Volume ID** | DAGMC volume identifier                     |
| **Material**  | Assigned material tag (or "UNASSIGNED")     |
| **Triangles** | Faceted mesh triangle count for this volume |

Click a card to open a **detail modal** with:

- Full bounding box coordinates
- Surface and triangle counts
- Material editor inline
- **View in 3D** button to preview only that volume

Use the filter pills (**All**, **Assigned**, **Unassigned**, **High-Poly**) and the search box to narrow the list.

> **Tip:** The colored triangle-density bar at the bottom of each card shows the relative mesh density of that volume compared to the largest volume in the model.

---

### Materials

Shows every material in the model as a card with:

- Volume count and percentage of total mesh
- A coverage bar indicating how much of the total triangle budget belongs to this material
- Quick-click volume tags to jump to a specific volume

Materials are derived from the volume tags in the `.h5m` file. Assigning a material in the Volumes tab updates this view immediately.

---

### Groups

DAGMC groups organize volumes and surfaces (e.g., `graveyard`, `reflective_boundary`).

| Action           | How To                                 |
| ---------------- | -------------------------------------- |
| **Create Group** | Click **"New Group"**, enter a name    |
| **Delete Group** | Click the trash icon on the group card |

Important groups:

| Group Name   | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `graveyard`  | The bounding void region; particles leaving this volume are killed |
| `reflective` | Surfaces with reflective boundary condition                        |
| `vacuum`     | Surfaces with vacuum boundary condition                            |
| `periodic`   | Surfaces with periodic boundary condition                          |

---

### Properties

A model overview with:

- **Stats cards:** Volumes, Surfaces, Triangles, Materials
- **File information:** filename and full path
- **Material distribution:** bar chart of volumes per material
- **Volumes table:** sortable list of all volumes with ID, material, and triangle count

---

### Faceting

Regenerate the DAGMC mesh from the original source CAD with a new tolerance.

#### When to Use

- The current mesh is too dense (slow simulation, large file)
- The current mesh is too coarse (jagged surfaces, poor accuracy)
- You want to create a draft mesh for quick iteration before running a final high-fidelity simulation

#### Workflow

1. **Select source CAD** — Click **Browse** to pick the original STEP or IGES file. The editor will also **auto-detect** a CAD file in the same directory as the `.h5m`.
2. **Choose tolerance** — Four presets are available:

   | Preset       | Tolerance | Best For                       |
   | ------------ | --------- | ------------------------------ |
   | **Draft**    | 1.0 cm    | Fast preview, large assemblies |
   | **Standard** | 0.5 cm    | Balanced quality and speed     |
   | **Fine**     | 0.1 cm    | Production simulations         |
   | **Ultra**    | 0.01 cm   | High-fidelity verification     |

   Use the slider for values between presets.

3. **Review impact** — The gauge shows the estimated triangle count and the delta (increase or decrease) relative to the current mesh. A warning appears if the new mesh would be significantly denser.
4. **Generate** — Click **Generate Re-faceted H5M**. The new file is saved with a `_refaceted` suffix. Choose whether to load it immediately.

> **Tip:** Material assignments from the original file are preserved. If the volume count changes (e.g., due to CAD healing differences), materials are mapped by volume tag where possible.

#### Under the Hood

Refacet uses **OpenCASCADE BRepMesh_IncrementalMesh** to tessellate the source CAD surface directly, then streams the resulting triangles into a properly tagged DAGMC H5M file via `pymoab`. Triangle count scales predictably with tolerance because tessellation is based on linear deflection from the true CAD surface.

---

## 3D Preview

Click **3D View** in the header to open the full model in the 3D viewer:

- Volumes are rendered as watertight triangular meshes
- Colors are assigned by material tag or volume ID
- Use the [Base Visualizer controls](../nuke-visualizer/docs/user/base-visualizer.md) for opacity, clipping, and screenshots

For large models, use **"View in 3D"** from a volume modal to load only the selected volumes and reduce memory usage.

---

## Saving

Click **Save As** in the header to save a copy of the current `.h5m` under a new name or location. This is useful for creating checkpoints before bulk edits.

---

## Tips

- **Always ensure a `graveyard` group exists.** Without it, OpenMC cannot terminate escaping particles.
- **Use Draft preset first** when exploring a new model. You can always re-facet with Fine later.
- **Check the triangle estimate** before generating. Very fine meshes (>5× current count) will show a warning.
- **Unit consistency:** OpenMC uses centimeters. Ensure your CAD files are in cm.
