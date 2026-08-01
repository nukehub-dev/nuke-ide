# Nuclear Data

The Nuclear Data window is a read-only browser for nuclear data. It is tabbed:

- **Library** — the configured cross-section data library (`cross_sections.xml`, HDF5). Use it to check which nuclides and temperatures your library actually provides before running, and to jump straight into cross-section plotting.
- **NCrystal** — NCrystal `.ncmat` materials (thermal neutron scattering, S(a,b)) with a cfg-string builder and cross-section plots.
- **ENDF** — raw ENDF evaluations (decay, fission-product yields, reaction sections) from an ENDF library directory on disk.

---

## Opening

- **Menu:** `Tools → Visualizer → OpenMC → Materials → Nuclear Data`
- **Command Palette:** `Ctrl+Shift+P` → **"Nuclear Data"**

---

## Library Tab

The library tab loads the library from the `nuke.openmcCrossSections` preference. Use **Change Library…** to browse for a different `cross_sections.xml`, or the reload button to re-read it.

The library path row shows the resolved `cross_sections.xml`. Below it, a searchable table lists every nuclide in the library:

| Column        | Description                               |
| ------------- | ----------------------------------------- |
| **Nuclide**   | Nuclide name (e.g. `U235`, `O16`)         |
| **Temps**     | Number of temperature points available    |
| **Reactions** | Number of reactions in the nuclide's data |

Type in the search box to filter by name. Drag the divider between the table and the detail panel to resize. Click a row to inspect the nuclide.

The detail panel shows, for the selected nuclide:

- A header with the nuclide name and a **fission** chip when the nuclide is fissile.
- The available **temperatures**.
- The full **reaction list** as MT chips (hover for the MT number).

Click **Plot in XS Viewer** to open the nuclide in the [Cross-Section Plot](cross-sections.md), pre-selected and ready to plot.

> **Tip:** A "(unresolved)" library path means the `nuke.openmcCrossSections` preference is not set — set it in preferences or use **Change Library…**.

---

## NCrystal Tab

The NCrystal tab inspects `.ncmat` materials (requires the `ncrystal` package in the configured Python environment).

**Material list:** the left panel lists the materials in the NCrystal data library (searchable). Use **File…** to open a single `.ncmat` file, **Dir…** to list `.ncmat` files from your own directory, or the reload button to re-read the list.

**Config-string builder:** the fields (Temperature, dcutoff, dcutoffup, Mosaicity, vdoslux — hover each for a one-line hint) compose an NCrystal cfg string, previewed live (e.g. `Al_sg225.ncmat;temp=300K;dcutoff=0.5Aa`). **Copy** puts it on the clipboard for use in openmc-studio's NCrystal import or `openmc.Material.from_ncrystal`; **Apply** loads the detail and cross-sections for the shown cfg.

**Detail:** temperature, density, composition chips (hover for the full atom label), and crystal structure info (space group, lattice constants) when the material is crystalline.

**XS plot:** scatter and absorption cross sections vs energy (log-log), sampled across 1e-5 eV – 10 MeV. For crystalline materials you can see the Bragg edges below ~100 meV move as you change `temp`/`dcutoff`.

---

## ENDF Tab

The ENDF tab inspects raw ENDF evaluations — the text files the HDF5 data libraries are built from. No library is loaded by default: click **Library…** and choose an ENDF root directory (one containing `decay/`, `nfy/`, `neutrons/` etc. sub-directories, e.g. an ENDF-B release). The choice is saved to the `nuke.endfLibrary` preference and restored across sessions (set it once in Settings → Nuke Utils or pick a folder here).

**Sub-library selector:** after scanning, the available sub-libraries appear as buttons with their nuclide counts (`neutrons`, `decay`, `nfy`, `sfy`, …). Pick one to list its nuclides (searchable, same idiom as the Library tab), then click a nuclide to inspect it.

**Detail panel** depends on the file kind:

- **Decay files** (`dec-*`): half-life (human unit and seconds with uncertainty), and the decay-mode table (mode, daughter, branching ratio). Stable nuclides get a **stable** chip.
- **Fission-yield files** (`nfy-*` / `sfy-*`): one energy selector per tabulated energy (e.g. 0.0253 eV / 500 keV / 14 MeV) and the top-25 fission products by yield, with the product count and total yield.
- **Neutron files** (`n-*`): target ZA, section count, and the reaction list as labeled chips (hover for the MF/MT numbers). The section scan reads the ENDF text records directly, so even large evaluations load in well under a second.
