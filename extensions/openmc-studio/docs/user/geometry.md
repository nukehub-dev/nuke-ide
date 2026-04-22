# Geometry Workflows

OpenMC Studio supports two geometry workflows: **CSG Builder** for constructive solid geometry defined by surfaces and regions, and **DAGMC Editor** for CAD-based `.h5m` geometries. Both integrate with the 3D preview provided by nuke-visualizer.

---

## CSG Builder

The CSG Builder lets you create OpenMC geometry from primitive surfaces, combine them into cells with Boolean region expressions, and arrange cells into universes and lattices.

### Opening the CSG Builder

### Method 1: Dashboard
In the Simulation Dashboard, click the **Geometry** tab, then **"Open CSG Builder"**.

### Method 2: Command Palette
`Ctrl+Shift+P` → **"OpenMC Studio: Open CSG Builder"**

### Method 3: Menu
`Tools → OpenMC Studio → Geometry → CSG Builder`

---

### Adding Surfaces

Surfaces are the primitive building blocks of CSG geometry.

1. In the CSG Builder sidebar, click **"Add Surface"**.
2. Choose a surface type:

| Surface Type | Equation / Description | Coefficients Required |
|--------------|------------------------|----------------------|
| **Plane** | `ax + by + cz = d` | `a, b, c, d` |
| **Sphere** | `(x−x₀)² + (y−y₀)² + (z−z₀)² = r²` | `x₀, y₀, z₀, r` |
| **X-Cylinder** | `(y−y₀)² + (z−z₀)² = r²` | `y₀, z₀, r` |
| **Y-Cylinder** | `(x−x₀)² + (z−z₀)² = r²` | `x₀, z₀, r` |
| **Z-Cylinder** | `(x−x₀)² + (y−y₀)² = r²` | `x₀, y₀, r` |
| **X-Cone** | `(y−y₀)² + (z−z₀)² = r²(x−x₀)²` | `x₀, y₀, z₀, r²` |
| **Y-Cone** | `(x−x₀)² + (z−z₀)² = r²(y−y₀)²` | `x₀, y₀, z₀, r²` |
| **Z-Cone** | `(x−x₀)² + (y−y₀)² = r²(z−z₀)²` | `x₀, y₀, z₀, r²` |
| **Torus** | Rotationally symmetric ring | Axis, center, major radius, minor radius |
| **General Quadric** | `Ax² + By² + Cz² + ... = 0` | 10 coefficients |

3. Enter coefficients in the form. The surface appears in the **Surfaces List** with an auto-assigned ID.
4. Set the **Boundary Condition** (optional): `vacuum`, `reflective`, `periodic`, or `white`.

> **Tip:** Name surfaces descriptively (e.g., "Fuel Outer Radius") — the names appear in region expressions and make debugging easier.

---

### Defining Cells

Cells are volumes bounded by surfaces and filled with materials, universes, or left void.

1. Click **"Add Cell"** in the toolbar.
2. Fill in the cell form:

| Field | Description |
|-------|-------------|
| **ID** | Unique integer identifier |
| **Name** | Descriptive label |
| **Fill** | Material, Universe, Lattice, or Void |
| **Region** | Boolean expression of surface IDs |
| **Temperature** | Optional temperature in Kelvin |
| **Rotation** | Optional rotation matrix (for fills) |
| **Translation** | Optional translation vector (for fills) |

3. **Region Expressions:** Use parentheses, spaces, and the operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| `−` (minus) | Negative half-space (inside) | `−1` = inside sphere 1 |
| ` ` (space) | Intersection (AND) | `−1 2` = inside 1 AND outside 2 |
| `:` | Union (OR) | `−1 : −2` = inside 1 OR inside 2 |
| `~` | Complement (NOT) | `~1` = outside sphere 1 |

Example — fuel pin clad by zircaloy in water:
```
Fuel:     −1
Clad:      1 −2
Coolant:   2 −3
Outside:   3
```

4. Click **"Validate Region"** to check for syntax errors and unbounded regions before adding the cell.

---

### Universes

Universes group cells together so they can be reused as fills.

1. Click **"Add Universe"**.
2. Drag cells from the **Cells List** into the universe.
3. Set one universe as the **Root Universe** (the top-level geometry).

| Property | Description |
|----------|-------------|
| **ID** | Unique integer |
| **Name** | Descriptive label |
| **Cells** | List of member cells |
| **Is Root** | Whether this is the top-level universe |

---

### Lattices

Lattices are regular arrays of universes — essential for reactor assemblies.

1. Click **"Add Lattice"**.
2. Choose a lattice type:

| Lattice Type | Description | Use Case |
|--------------|-------------|----------|
| **Rectangular** | Cartesian grid of universes | PWR/BWR assemblies, regular arrays |
| **Hexagonal** | Hexagonal close-packed grid | VVER assemblies, prismatic reactors |

3. Configure the lattice:

| Parameter | Description |
|-----------|-------------|
| **ID** | Unique integer |
| **Name** | Descriptive label |
| **Dimensions** | `[nx, ny]` (rect) or `[nr, n_rings]` (hex) |
| **Pitch** | Center-to-center distance (cm) |
| **Lower Left** | `[x, y, z]` corner of the lattice (rect only) |
| **Center** | `[x, y, z]` center of the lattice (hex only) |
| **Universe Map** | 2D array assigning universe IDs to positions |
| **Outer Universe** | Universe ID for positions outside the defined map |

4. Click **"Populate Grid"** to open a visual grid editor. Click cells in the grid to assign universe IDs.

> **Tip:** Use the **Outer Universe** to define reflector or coolant regions surrounding the lattice without explicitly tiling them.

---

### 3D Preview

Click **"Preview 3D"** at any time to visualize the current geometry.

- A new **Visualizer** tab opens (via nuke-visualizer).
- Cells are colored by material or by cell ID.
- Mouse controls: rotate (left-drag), pan (right-drag), zoom (scroll).
- The preview updates automatically when you regenerate XML.

---

## DAGMC Editor

The DAGMC Editor is for working with CAD-based `.h5m` files. You can view volumes, assign materials, and manage groups without leaving NukeIDE.

### Opening the DAGMC Editor

### Method 1: Click
Click any `.h5m` file in the Explorer.

### Method 2: Command Palette
`Ctrl+Shift+P` → **"OpenMC Studio: Open DAGMC Editor"**

### Method 3: Menu
`Tools → OpenMC Studio → Geometry → DAGMC Editor`

---

### Viewing Volumes

The DAGMC Editor displays all volumes in a scrollable grid. Click any volume card to open a **centered detail modal** that shows:

| Property | Description |
|----------|-------------|
| **Volume ID** | DAGMC volume identifier |
| **Name** | Volume name (if tagged) |
| **Material** | Assigned material tag |
| **Group Tags** | DAGMC group memberships |
| **Bounding Box** | Axis-aligned bounds `[xmin, ymin, zmin]` to `[xmax, ymax, zmax]` |
| **Surface Count** | Number of bounding surfaces |
| **Triangle Count** | Faceted mesh triangle count |

The modal floats above the volume grid, so you can scroll through the list without losing your place. Click outside the modal or press `Escape` to close it.

Click **"View 3D"** in the modal to visualize the selected volume in the 3D viewer. Use Ctrl/Cmd-click on the grid to select multiple volumes for combined visualization.

---

### Assigning Materials

1. Click a volume card to open the detail modal.
2. In the **Material** section, select a material from the dropdown (populated from the current project's Materials tab) or type a new material name.
3. The material tag is written to the `.h5m` file immediately.

> **Tip:** DAGMC materials are stored as string tags on volumes. They must match material names in your `materials.xml` at runtime.

---

### Managing Groups

DAGMC uses groups to organize volumes and surfaces (e.g., "graveyard", "reflective_boundary").

| Action | How To |
|--------|--------|
| **Create Group** | Switch to the **Groups** tab → Click **"New Group"**, enter a name |
| **Add Volume to Group** | Open volume modal → **"Add to Group"** → choose group |
| **Remove from Group** | Open volume modal → **"Remove from Group"** |
| **Delete Group** | Groups tab → Click group → **"Delete Group"** |
| **Rename Group** | Groups tab → Click group → **"Rename"** |

Important groups:

| Group Name | Purpose |
|------------|---------|
| `graveyard` | The bounding void region; particles leaving this volume are killed |
| `reflective` | Surfaces with reflective boundary condition |
| `vacuum` | Surfaces with vacuum boundary condition |
| `periodic` | Surfaces with periodic boundary condition |

---

### Saving the DAGMC File

When a DAGMC file is loaded, the header shows a **Save As** button. Click it to save a copy of the current `.h5m` file under a new name or location. This is useful for:

- Creating checkpoints before bulk material assignments
- Exporting a modified model for use in other workflows
- Renaming files to match project conventions

The Save As button only appears when a file is actually loaded.

---

### 3D Preview via Nuke-Visualizer

Click **"3D View"** in the header to open the full model in the 3D viewer:

- Volumes are rendered as watertight triangular meshes.
- Colors are assigned by material tag or volume ID.
- Use the [Base Visualizer controls](../nuke-visualizer/docs/user/base-visualizer.md) for opacity, clipping, and screenshots.

For large models, use **"Preview Selected"** in the volume modal to load only the selected volumes and reduce memory usage.

---

## CAD Import

Import STEP, IGES, BREP, and STL files and convert them to CSG surfaces or DAGMC `.h5m`.

### Import Workflow

1. Use the CAD Import feature from the Simulation Dashboard.
2. Select one or more files (`.step`, `.stp`, `.iges`, `.igs`, `.brep`, `.stl`).
3. Choose the target format:

| Target | Description |
|--------|-------------|
| **CSG (Approximate)** | Fits analytic surfaces (planes, cylinders, spheres) to CAD geometry. Best for simple shapes. |
| **DAGMC (.h5m)** | Converts directly to a watertight mesh for DAGMC transport. Best for complex CAD. |

4. For CSG conversion, review the generated surfaces and adjust tolerances.
5. For DAGMC conversion, set the mesh tolerance and output path.

> **Tip:** CSG conversion works best on primitives (cylinders, boxes, spheres). Highly curved or organic shapes should use DAGMC.

---

## Robustness Notes

### Handling Corrupt or Partial Volumes

Some DAGMC files contain volumes that cannot be fully interrogated (e.g., missing triangle data or invalid topology). The DAGMC Editor **gracefully skips these individual volumes** rather than crashing the entire load. A warning toast appears listing how many volumes were skipped, and the remaining valid volumes are still displayed and editable.

If you see "skipped N volumes" warnings:
- The file may have been generated with an older or incomplete mesher.
- Try re-faceting the source CAD with the current importer (see [CAD Import](cad-import.md)).
- Check the Python output channel for the specific volume IDs that failed.

---

## Tips

- **Validate before running:** After building CSG geometry, run `Tools → OpenMC Studio → Simulation → Validate Model` to check for errors before simulation.
- **DAGMC graveyard:** Always ensure your DAGMC model has a `graveyard` group. Without it, OpenMC cannot terminate escaping particles.
- **Unit consistency:** OpenMC uses centimeters. Ensure your CAD files are in cm or convert during import.
- **Complex lattices:** For large lattice arrays, use the grid editor's **"Fill Pattern"** button to repeat a universe pattern across the lattice.
