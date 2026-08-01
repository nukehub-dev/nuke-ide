# Nuclear Data

The Nuclear Data window is a read-only browser for the configured cross-section data library (`cross_sections.xml`). Use it to check which nuclides and temperatures your library actually provides before running, and to jump straight into cross-section plotting.

---

## Opening

- **Menu:** `Tools → Visualizer → OpenMC → Materials → Nuclear Data`
- **Command Palette:** `Ctrl+Shift+P` → **"Nuclear Data"**

The window loads the library from the `nuke.openmcCrossSections` preference. Use **Change Library…** to browse for a different `cross_sections.xml`, or the reload button to re-read it.

---

## Library Table

The library path row shows the resolved `cross_sections.xml`. Below it, a searchable table lists every nuclide in the library:

| Column        | Description                               |
| ------------- | ----------------------------------------- |
| **Nuclide**   | Nuclide name (e.g. `U235`, `O16`)         |
| **Temps**     | Number of temperature points available    |
| **Reactions** | Number of reactions in the nuclide's data |

Type in the search box to filter by name. Drag the divider between the table and the detail panel to resize. Click a row to inspect the nuclide.

## Detail Panel

The detail panel shows, for the selected nuclide:

- A header with the nuclide name and a **fission** chip when the nuclide is fissile.
- The available **temperatures**.
- The full **reaction list** as MT chips (hover for the MT number).

Click **Plot in XS Viewer** to open the nuclide in the [Cross-Section Plot](cross-sections.md), pre-selected and ready to plot.

> **Tip:** A "(unresolved)" library path means the `nuke.openmcCrossSections` preference is not set — set it in preferences or use **Change Library…**.
