# OpenMC Plugin

The OpenMC plugin visualizes output from [OpenMC](https://openmc.org/) Monte Carlo neutron/photon transport simulations. It covers the full analysis workflow: inspecting statepoints, plotting tallies, analyzing depletion, viewing geometry, and plotting nuclear cross-sections.

---

## Supported Files

| File              | Extension              | What You Can Do                                             |
| ----------------- | ---------------------- | ----------------------------------------------------------- |
| Statepoint        | `statepoint*.h5`       | View metadata, tallies, k-eff, runtime, source distribution |
| Source            | `source.h5`            | Visualize source particle distribution in 3D                |
| Depletion results | `depletion_results.h5` | Plot nuclide evolution, mass changes, activity, decay heat  |
| Geometry          | `geometry.xml`         | Browse CSG hierarchy, view cells/surfaces/lattices in 3D    |
| Materials         | `materials.xml`        | Inspect compositions, mix materials, trace cell usage       |
| DAGMC geometry    | `.h5m`                 | Visualize geometry with optional tally overlay              |

---

## Typical Workflow

1. **Run your OpenMC simulation** to produce `statepoint*.h5` (and optionally `depletion_results.h5`).
2. **Open the statepoint** by clicking it in the Explorer.
   - The [Statepoint Viewer](statepoint-viewer.md) shows simulation summary and tallies.
3. **Visualize tallies**:
   - [3D mesh tally](tally-visualization.md) — interactive volume rendering
   - [Overlay on geometry](tally-visualization.md#overlay-tally-on-geometry) — colorize DAGMC geometry with tally results
   - [Energy spectrum](tally-visualization.md#energy-spectrum) — log-log plot of flux vs energy
   - [Spatial plot](tally-visualization.md#spatial-distribution) — 1D line plot along X/Y/Z
   - [2D heatmap](tally-visualization.md#2d-heatmap-slices) — slice through mesh tally
4. **Analyze burnup** (if depletion was run):
   - Open `depletion_results.h5` → [Depletion Viewer](depletion.md)
5. **Inspect geometry and materials**:
   - Open `geometry.xml` → [Geometry Hierarchy](geometry.md)
   - Open `materials.xml` → [Material Explorer](materials.md)
6. **Plot cross-sections**:
   - Use the [XS Plot](cross-sections.md) sidebar view for on-the-fly nuclear data lookup.

---

## Quick Menu Reference

All OpenMC commands are under `Tools → Visualizer → OpenMC`:

| Submenu        | Commands                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Statepoint** | View Statepoint...                                                                                                   |
| **Tally**      | Visualize Tally, Visualize Source, Overlay Tally on Geometry, Overlay Tally on Geometry with Source, Show Tally Info |
| **Depletion**  | View Depletion Results..., Compare Depletion Results...                                                              |
| **Geometry**   | View Geometry Hierarchy..., Check Geometry Overlaps...                                                               |
| **Materials**  | View Materials                                                                                                       |
| **Plotting**   | Plot Cross-Sections                                                                                                  |

---

## Next Steps

- [Statepoint Viewer](statepoint-viewer.md)
- [Tally Visualization](tally-visualization.md)
- [Cross-Section Plotting](cross-sections.md)
- [Depletion / Burnup](depletion.md)
- [Geometry Viewer](geometry.md)
- [Material Explorer](materials.md)
