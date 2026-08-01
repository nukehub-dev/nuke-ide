# Native Plotting

The Native Plotting window renders geometry plots with OpenMC's built-in C++ plot mode (`openmc -p`) — no Python plotting stack required. It supports slice plots, voxel plots, and ray-traced renders, and can batch several plot definitions in one run.

---

## Opening

- **Command Palette:** `Ctrl+Shift+P` → **"OpenMC Studio: Native Plotting"**
- **Menu:** `Tools → OpenMC Studio → Advanced → Native Plotting`

---

## Plot Types

Click an add button to append a plot definition; each plot has a name and a **Color By** choice (cell or material).

| Type             | Key Settings                                                                                              | Output              |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| **Slice**        | Basis (XY / XZ / YZ), width/height, pixel resolution, optional legend                                     | PNG                 |
| **Voxel**        | Bounds and voxel counts                                                                                   | HDF5 → VTK (`.vti`) |
| **Solid RT**     | Ray-traced solid render: camera position/look-at/up, horizontal FOV, orthographic width, diffuse fraction | PNG                 |
| **Wireframe RT** | Ray-traced wireframe overlay: wireframe thickness in pixels                                               | PNG                 |

## Outputs

- **Slice and ray-trace plots** produce PNG images, opened with the IDE's default image handler.
- **Voxel plots** produce an `.h5` voxel file that is automatically converted to VTK (`.vti`) and opened in the 3D viewer, where you can slice, clip, and color the volume interactively.

> **Tip:** Ray-trace plots are slower than slices but need no mesh — use them for publication-quality geometry figures and overlap inspections.
