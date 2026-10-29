# Native Plotting

The Native Plotting window renders geometry plots with OpenMC's built-in C++ plot mode (`openmc -p`) — no Python plotting stack required. It supports slice plots, voxel plots, and ray-traced renders, and can batch several plot definitions in one run.

---

## Opening

- **Command Palette:** `Ctrl+Shift+P` → **"OpenMC Studio: Native Plotting"**
- **Menu:** `Tools → OpenMC Studio → Advanced → Native Plotting`

---

## Plot Types

When the window opens with no plots, choose one of the four plot-type cards in
the centered empty state. Once a plot exists, the left **Plots** panel offers
the same plot types as compact add buttons; the first plot is selected
automatically after a project load or when the selected plot is deleted.

Click an add button to append a plot definition; each plot has a name and a **Color By** choice (cell or material).

| Type             | Key Settings                                                                                              | Output              |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| **Slice**        | Basis (XY / XZ / YZ), width/height, pixel resolution, optional legend                                     | PNG                 |
| **Voxel**        | Bounds and voxel counts                                                                                   | HDF5 → VTK (`.vti`) |
| **Solid RT**     | Ray-traced solid render: camera position/look-at/up, horizontal FOV, orthographic width, diffuse fraction | PNG                 |
| **Wireframe RT** | Ray-traced wireframe overlay: wireframe thickness in pixels                                               | PNG                 |

Solid ray-trace plots render every material/cell opaque when **Opaque Domain IDs** is empty; add IDs to reveal interior regions.

If OpenMC is built without libpng (some conda builds), it writes PPM files instead of PNG. Native Plotting automatically converts them to PNG previews with Pillow.

---

## Appearance

The **Appearance** section of the plot editor controls what the renderer shows and hides. It is
collapsed by default so the common geometry settings stay in view.

| Control                | Applies to                 | Effect                                                                                    |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| **Background**         | Slice and ray-traced plots | Color for regions outside every cell. OpenMC default: black. **Reset** restores black.    |
| **Mask**               | Slice and ray-traced plots | Shows only selected cells or materials; every other domain uses the mask background.      |
| **Highlight overlaps** | Slice plots only           | Paints regions claimed by more than one cell with the overlap color. OpenMC default: red. |

Voxel plots store raw cell/material IDs, so OpenMC does not apply background, mask, or overlap
colors there. The Appearance section explains this instead of offering controls that have no effect.

### Masking

Turn on **Show only selected cells/materials** and pick domains from the list. The list follows the
plot's **Color By** choice: cells for **Cell**, materials for **Material**. The summary reports how many
domains remain visible, for example `12 of 240 materials visible`. Changing **Color By** clears the
selection because cell IDs and material IDs are different namespaces.

The mask background defaults to white. Masking only changes display colors; the generated geometry and
materials are unchanged. If a mask references an ID that is no longer in the model, the editor lists
it and offers **Remove missing**. OpenMC's `plots.xml` records the masked-out domains, so the IDE
inverts that list when exporting and importing; your visible selection round-trips unchanged.

### Overlap highlighting

Overlap highlighting only works when the geometry actually contains overlapping cells. OpenMC detects
overlaps while rendering a slice; ray-traced plots do not report them. Use the Overlap Checker to find
and fix geometry overlaps before relying on this view.

Appearance settings are project state: they survive save/reload and round-trip through `plots.xml`
import and export.

## Outputs

- **Slice and ray-trace plots** produce PNG images, opened with the IDE's default image handler.
- **Voxel plots** produce an `.h5` voxel file that is automatically converted to VTK (`.vti`) and opened in the 3D viewer, where you can slice, clip, and color the volume interactively.

> **Tip:** Ray-trace plots are slower than slices but need no mesh — use them for publication-quality geometry figures and overlap inspections.
