# Output Viewers

The OpenMC plugin turns simulation output files into interactive 3D viewers. Double-clicking a recognized output file in the Explorer routes it to the right viewer automatically — the file is converted to VTK by the plugin's Python backend and rendered in an embedded 3D view with color-by, opacity, clipping, and screenshot controls.

---

## Particle Tracks (`tracks.h5`)

Recorded particle track segments, written when particle tracks are configured in OpenMC settings.

- **3D view:** polylines for every track segment. Use the viewer's **Color By** control with cell data `pdg` (particle type) or point data `energy`, `time`, `weight`.
- **Panel:** a tracks metadata table (batch, generation, particle ID, particle counts).
- **Header filters:** particle type, cell/material, and max-tracks/max-points caps re-run the conversion.

## Collision Tracks (`collision_track.h5`)

Individual collision sites recorded by OpenMC's collision track feature.

- **3D view:** a point cloud of collision sites — color by reaction MT, cell, or energy.
- **Panel:** a paginated collision table; MT and cell filter inputs in the header narrow the conversion.

## Weight Windows (`weight_windows.h5`)

Weight window bounds on a regular mesh (from the weight window generator or FW-CADIS workflows).

- **3D view:** a rectilinear grid with one cell-data array per (bound, energy group), named `lower_g<i>` / `upper_g<i>` — the **Color By** control acts as the energy-group and lower/upper toggle.
- **Multi-mesh files:** when a file contains windows on more than one mesh, a **Mesh to display** selector appears in the panel ("Mesh N (M windows)"); switching meshes re-runs the conversion anchored to that mesh. Windows on other meshes are skipped and reported.
- **Panel:** summary cards per mesh/window (dimensions, energy groups, survival ratio).

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

All 3D output viewers share the base visualizer's [display controls](../base-visualizer.md): color-by array, color map, scalar bar, opacity, representation, clip plane, point size / line width, and Save Screenshot.

- **Resizable split** — drag the handle between the 3D area and the data panel to resize it (the handle disables the 3D iframe's mouse capture while dragging, so fast drags stay smooth).
- **Missing dependencies** — if the active Python environment lacks `vtk`/`trame`, the viewer shows an actionable panel (what to install, or switch environment in Settings → Nuke Utils) with a Retry button.

> **Tip:** Conversions run in the active Python environment and cache nothing — if you switch environments, reopen the file to re-convert.
