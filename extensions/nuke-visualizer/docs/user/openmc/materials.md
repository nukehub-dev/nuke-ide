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

The left panel shows a sortable list of all materials:

| Field           | Description                                        |
| --------------- | -------------------------------------------------- |
| **ID**          | Material identifier                                |
| **Name**        | Material name (from XML)                           |
| **Density**     | Value and unit (g/cm³, kg/m³, atom/b-cm, or `sum`) |
| **Depletable?** | Whether the material is marked for burnup          |
| **Temperature** | Optional temperature in Kelvin                     |
| **Volume**      | Optional volume in cm³                             |
| **Nuclides**    | Count of constituent nuclides                      |
| **S(α,β)**      | Count of thermal scattering assignments            |

Select a material to show its full composition in the details panel on the right.

---

## Composition Table

When selected, each material shows a table of nuclides:

| Column       | Description                        |
| ------------ | ---------------------------------- |
| **Nuclide**  | Name (e.g., `U235`, `O16`)         |
| **Fraction** | Weight or atomic fraction          |
| **Type**     | `wo` (weight %) or `ao` (atomic %) |

### Thermal Scattering

If the material has S(α,β) data (e.g., `c_H_in_H2O`), it is listed below the nuclide table with the assigned fraction.

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

Click a cell to **highlight it in the 3D Geometry Viewer**.

---

## Material Mixer

Create a new material by mixing existing ones.

### How to Open

Click **"Mix Materials"** in the Material Explorer toolbar.

### Steps

1. **Select materials** from the list (check the boxes).
2. **Set fractions** for each material:
   - Atomic % (`ao`)
   - Weight % (`wo`)
   - Volume % (`vo`)
3. **Name** the new material.
4. **Optional:** Assign an ID.
5. Click **"Calculate"**.

### Result

- The mixed composition is shown in a preview table.
- The resulting density is computed.
- Click **"Save to File"** to append the new material definition to your file.
- Or click **"Copy XML"** to paste the `<material>` snippet manually.

### Use Cases

- **Blending enrichments:** Mix 3% and 5% enriched UO₂ to get 4%.
- **Coolant chemistry:** Mix borated water at different ppm levels.
- **Clad mixtures:** Combine Zircaloy alloys.

---

## Editing Materials

The Material Explorer is **read-only by default** for safety. To edit:

1. Make changes in the mixer.
2. Copy the generated XML.
3. Paste it into `materials.xml` in the editor.

Future versions may support direct in-place editing.

---

## Export

Click **"Export CSV"** in the Material Explorer toolbar to download the materials currently shown (the search filter and sort order apply). The file has one row per nuclide or S(α,β) entry, with the material ID, name, density, temperature, volume, and depletable flag repeated on each row. Materials without a composition produce a single row.

---

## Tips

- **Depletable materials** are marked with a `D` badge. These are the materials tracked by the depletion solver.
- **Missing materials:** If a cell references a material ID that doesn't exist in `materials.xml`, a warning icon appears in the Cell Linkage panel.
- **Density = sum:** If a material uses `density units="sum"`, the explorer shows the computed atom density for each nuclide.
