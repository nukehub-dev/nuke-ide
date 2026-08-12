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

The editor automatically detects a missing graveyard when a file is loaded. If none is found, a banner appears below the header with two actions:

- **Create Graveyard Box** (primary) — creates a new axis-aligned bounding cube around the model, tagged `mat:graveyard`.
- **Tag existing volume N instead** (secondary, shown when an enclosing volume is detected) — re-tags that existing volume as the graveyard. The banner warns that this turns the volume into a particle sink, so creating a new box is the safe choice.

---

### Overrides

Map DAGMC volume materials onto your project's material library and resolve ID conflicts.

#### Replace Material by Name

Reassign every volume that carries a given material tag in the `.h5m` file: pick the **From Material** (as tagged in the file) and the **To Material** (a project material), then click **Replace**.

#### Per-Cell Overrides

A table of all volumes with their current material and an **Override With** select per volume — assign any project material, or choose `(remove assignment)` to clear a volume's tag.

#### ID Conflict Resolution

When DAGMC cell/material IDs would collide with CSG IDs in `geometry.xml`, enable **Auto-resolve geometry ID conflicts** (`auto_geom_ids`) and/or **Auto-resolve material ID conflicts** (`auto_mat_ids`). These are written as attributes on the `dagmc_universe` element.

#### Sync for Depletion

Click **Sync for Depletion** to run OpenMC's `sync_dagmc_universes` pass over the model: every DAGMC cell gets an explicit material assignment in `geometry.xml`, which per-cell burnup tracking requires. The tool asks for a working directory and rewrites `geometry.xml` there — the `.h5m` file is not modified.

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
4. **(Optional) Imprint & Merge** — Check **"Imprint & merge shared surfaces"** to imprint and merge coincident surfaces between adjacent volumes during re-faceting. This is slower but produces conformal meshes, which is better for particle transport.
5. **Generate** — Click **Generate Re-faceted H5M**. The new file is saved with a `_refaceted` suffix. Choose whether to load it immediately.

> **Tip:** Material assignments from the original file are preserved. If the volume count changes (e.g., due to CAD healing differences), materials are mapped by volume tag where possible. The graveyard is preserved too: re-faceting re-tessellates from the source CAD, which does not contain the auto-created graveyard shell — if the old file had a `mat:graveyard` volume it is re-created on the output automatically, with a warning.

#### Under the Hood

Refacet uses **OpenCASCADE BRepMesh_IncrementalMesh** to tessellate the source CAD surface directly, then streams the resulting triangles into a properly tagged DAGMC H5M file via `pymoab`. Triangle count scales predictably with tolerance because tessellation is based on linear deflection from the true CAD surface.

---

## 3D Preview

Click **3D View** in the header to open the full model in the 3D viewer:

- Volumes are rendered as watertight triangular meshes
- Colors are assigned by material tag or volume ID
- Use the [Base Visualizer controls](/nuke-visualizer/user/base-visualizer) for opacity, clipping, and screenshots

For large models, use **"View in 3D"** from a volume modal to load only the selected volumes and reduce memory usage.

---

## Switching Files

Click **Open...** in the header to load a different `.h5m` file. When the newly loaded file differs from the one stored in the project, the project's DAGMC reference (`dagmcFile` and `dagmcInfo`) is updated automatically so the new geometry is used for simulation.

## Importing CAD

Click **Import CAD** in the header to open a file dialog for STEP/IGES/BREP/STL files and import the CAD model into DAGMC format. The editor first checks that gmsh or OpenCASCADE is available in the active Python environment and warns if neither is installed. See [CAD Import](cad-import.md) for the full conversion pipeline.

## Saving

Click **Save As** in the header to save a copy of the current `.h5m` under a new name or location. This is useful for creating checkpoints before bulk edits.

---

## Tips

- **Always ensure a `graveyard` group exists.** Without it, OpenMC cannot terminate escaping particles. The editor detects a missing graveyard automatically and offers to create one (see the Groups tab).
- **Use Draft preset first** when exploring a new model. You can always re-facet with Fine later.
- **Check the triangle estimate** before generating. Very fine meshes (>5× current count) will show a warning.
- **Unit consistency:** OpenMC uses centimeters. Ensure your CAD files are in cm.
