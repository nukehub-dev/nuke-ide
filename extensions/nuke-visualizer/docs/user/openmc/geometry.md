# Geometry Viewer

The Geometry Viewer lets you inspect OpenMC's constructive solid geometry (CSG) from `geometry.xml`. It combines a hierarchical tree view with an interactive 3D renderer.

---

## Opening Geometry

### Method 1: Click

Click `geometry.xml` in the Explorer.

### Method 2: Menu

`Tools → Visualizer → OpenMC → Geometry → View Geometry Hierarchy`

### Method 3: Command Palette

`Ctrl+Shift+P` → **"View Geometry Hierarchy"**

---

## Geometry Hierarchy Tree

The tree opens in the **right sidebar** by default. It shows:

```
Root Universe (ID: 0)
├── Cell 1: Fuel Pin
│   ├── Material: UO2 (ID: 1)
│   └── Surfaces: 1, 2, 3
├── Cell 2: Cladding
│   ├── Material: Zircaloy (ID: 2)
│   └── Surfaces: 2, 3, 4
├── Cell 3: Coolant
│   ├── Material: H2O (ID: 3)
│   └── Surfaces: 4, 5
└── Lattice 10: Fuel Assembly
    └── Universe array [17×17]
```

### Tree Nodes

| Node Type    | What It Shows                                                              |
| ------------ | -------------------------------------------------------------------------- |
| **Universe** | ID, name, whether it's the root universe                                   |
| **Cell**     | ID, name, fill type (material/universe/lattice/void), region expression    |
| **Surface**  | ID, type (sphere, plane, cylinder, etc.), coefficients, boundary condition |
| **Lattice**  | ID, name, type (rect/hex), dimensions, pitch, universe map                 |

### Selection Actions

Click any node to see details:

- **Cell:** Region expression, fill material, temperature, density, bounding box
- **Surface:** Mathematical coefficients, boundary condition (vacuum/reflective/periodic/white)
- **Lattice:** Lower-left corner, pitch, outer universe

---

## 3D Geometry Visualization

Click **"View 3D"** on any universe or cell to launch the 3D viewer.

### What You See

- A surface-based rendering of the geometry (one box per cell).
- Cells colored by material from a theme-aware palette (vivid on dark
  themes, deepened on light ones), with matching edge lines.
- Navigation: rotate, pan, zoom with mouse; orientation cube and
  ISO/top/front/right bar over the canvas.

### CSG Outline

Opening a geometry view also reveals the **CSG Outline** sidebar:
per-cell visibility checkboxes with hover isolate buttons, a material
tree, a **Void** switch for unfilled cells, **Show all** reset, and a
search filter. Row clicks sync with canvas selection both ways. Display
settings (clip, opacity, background) live in Viewer Settings. Tally
overlay tabs bind the same panel for their CSG underlay (visibility
plus row-click ghost highlight; selection sync is panel→canvas only).

Hiding is exact: per-cell checkboxes, material toggles, and the Void
switch all remove the box from the canvas through one shared rule. The
void material row reads hidden while the Void switch is off (matching
the DAGMC Graveyard row). Note cells render as nested bounding boxes, so hiding an outer cell (e.g.
moderator) reveals the cells inside rather than empty space. Right-click
the canvas for Fit / Screenshot / Clip plus Hide / Isolate selected cell
and Show all.

### Highlighting

In the tree, click the **highlight icon** next to a cell:

- The cell is emphasized in the 3D view.
- Other cells become semi-transparent.
- Useful for isolating specific components (e.g., control rods, fuel pins).

### From Material Explorer

In the [Material Explorer](materials.md), click **"Highlight Cells"** next to a material:

- All cells using that material are highlighted in the 3D view.

---

## Geometry Overlap Checker

Detect overlapping cells — a common source of simulation errors.

### How to Run

1. Open `geometry.xml`.
2. Click **"Check Overlaps"** in the Geometry Tree toolbar.
3. Or use: `Tools → Visualizer → OpenMC → Geometry → Check Geometry Overlaps...`

### Settings

| Parameter         | Default | Description               |
| ----------------- | ------- | ------------------------- |
| **Sample Points** | 100,000 | Random points to test     |
| **Tolerance**     | 1e-6 cm | Numerical tolerance       |
| **Bounding Box**  | Auto    | Limit check to a region   |
| **Parallel**      | On      | Use multi-core processing |

### Results

- A list of overlaps appears in a panel:
  - Coordinates of the overlap
  - Cell IDs involved
  - Cell names (if available)
- Click an overlap to **jump to that location** in the 3D view.
- Export results to CSV or JSON.

### Overlap Visualization

If overlaps are found:

1. Click **"Visualize Overlaps"**.
2. The 3D viewer opens with **red spheres** marking overlap locations.
3. Overlapping cells are highlighted in red.

> **Performance note:** Overlap checks on large geometries can take minutes. The progress bar shows sample count and percentage.

---

## Tips

- **Complex lattices:** Large lattice arrays (e.g., 17×17 fuel assemblies) are shown as a 2D grid in the tree. Expand to see individual universe positions.
- **CSG expressions:** The region expression (e.g., `(-1 2 -3):4`) is shown in the cell detail panel. Click **"Tokenize"** to see a readable breakdown of surface operations.
- **3D viewer sync:** The 3D viewer and tree are linked. Selecting a cell in the tree highlights it in 3D, and vice versa.
