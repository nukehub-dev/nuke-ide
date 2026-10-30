# Material Explorer

The Material Explorer parses `materials.xml` and gives you a searchable, interactive view of all materials in your OpenMC model. You can also mix materials and trace which cells use them.

---

## Opening Materials

### Method 1: Click

Click `materials.xml` in the Explorer.

### Method 2: Menu

`Tools → Visualizer → OpenMC → Materials → View Materials`

### Method 3: Command Palette

`Ctrl+Shift+P` → **"View Materials"**

---

## Material List

The left panel shows one row per material:

- **ID** — material identifier
- **Name** — name from the XML (with a `D` badge when depletable)
- **Density** — value and unit (`g/cm3`, `kg/m3`, `atom/b-cm`, or `sum`)
- **Nuclides** — count of constituent nuclides
- **S(α,β)** — count of thermal scattering assignments

Sort the list by ID, name, or density with the column headers. Select a row to
show its details on the right:

- density, optional temperature, optional volume, and nuclide count
- thermal scattering assignments
- cells that reference the material
- a nuclide composition bar chart and the full nuclide table

---

## Composition Table

When selected, each material shows a table of nuclides:

| Column       | Description                        |
| ------------ | ---------------------------------- |
| **Nuclide**  | Name (e.g., `U235`, `O16`)         |
| **Fraction** | Weight or atomic fraction          |
| **Type**     | `wo` (weight %) or `ao` (atomic %) |

### Thermal Scattering

If the material has S(α,β) data (e.g., `c_H_in_H2O`), it is listed above the
nuclide table with the assigned fraction.

---

## Search & Filter

Use the search bar at the top to filter materials:

- By **name** (e.g., "fuel", "coolant")
- By **ID**
- By **nuclide** (e.g., "U235" — shows all materials containing U235)

Use the sortable list headers to order materials by ID, name, or density.

---

## Cell Linkage

The details panel lists the cells in the geometry that reference the selected material.

Requirements:

- A `geometry.xml` file must exist in the same directory as `materials.xml`.

The linkage panel shows:

| Column        | Description                        |
| ------------- | ---------------------------------- |
| **Cell ID**   | Cell identifier                    |
| **Cell Name** | Name from geometry.xml             |
| **Universe**  | Which universe the cell belongs to |

Click the crosshair button on a cell row to open the **3D Geometry Viewer** with
that cell selected.

---

## Material Mixer

Create a new material by homogenizing existing ones.

### How to Open

Click **"Mix Materials"** in the Material Explorer toolbar. The **Material
Homogenizer** panel opens.

### Steps

1. **Add source materials:** click materials in the left list; each added
   material appears with a fraction field.
2. **Choose the fraction type:** Atom % (`ao`), Weight % (`wo`), or Volume %
   (`vo`).
3. **Set fractions** for each material. Atom and weight fractions must total
   `1.0000`; volume fractions may total less, with the remainder treated as void.
4. **Set the output name and material ID.**
5. Click **"Generate Mixture"**.

### Result

- A **Generated Material** card shows the computed density, nuclide count,
  depletable flag, and the generated XML.
- The density is computed by the mixer and displayed; there is no overall
  density input.
- Click **"Save to File"** to append the new material definition to
  `materials.xml`.
- Or click **"Copy XML"** to paste the `<material>` snippet manually.

### Use Cases

- **Blending enrichments:** Mix 3% and 5% enriched UO₂ to get 4%.
- **Coolant chemistry:** Mix borated water at different ppm levels.
- **Clad mixtures:** Combine Zircaloy alloys.

---

## Editing Materials

The Material Explorer is **read-only**; it does not edit existing material
definitions. The mixer can append a new material directly with **Save to File**,
or you can copy its generated XML and paste it into `materials.xml` in the
editor for manual changes.

---

## Export

Click **"Export CSV"** in the Material Explorer toolbar to download the materials currently shown (the search filter and sort order apply). The file has one row per nuclide or S(α,β) entry, with the material ID, name, density, temperature, volume, and depletable flag repeated on each row. Materials without a composition produce a single row.

---

## Tips

- **Depletable materials** are marked with a `D` badge. These are the materials tracked by the depletion solver.
- **Missing materials:** If a cell references a material ID that doesn't exist in `materials.xml`, a warning icon appears in the Cell Linkage panel.
- **Density = sum:** If a material uses `density units="sum"`, the explorer shows the computed atom density for each nuclide.
