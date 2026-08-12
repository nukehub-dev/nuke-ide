# MGXS Generator

The MGXS Generator produces a multi-group cross-section library (`mgxs.h5`) from your continuous-energy model and writes the library path into the project settings — the library multi-group and random ray runs need (see the Random Ray tab in the [Simulation Dashboard](simulation-dashboard.md)).

> **Tip:** For the full one-click workflow (generate + convert materials to macroscopic + switch to multi-group, with lossless revert), use **Multi-Group Conversion** in the Random Ray tab instead — it wraps this generator. The **Generate…** button next to the MGXS library picker opens this window directly.

---

## Opening

- **Command Palette:** `Ctrl+Shift+P` → **"OpenMC Studio: MGXS Generator"**
- **Menu:** `Tools → OpenMC Studio → Advanced → MGXS Generator`

The generator has two modes, selected at the top of the window.

---

## Convert (Automatic) Mode

Wraps `Model.convert_to_multigroup()` — the simplest path from a continuous-energy model to a multi-group library.

| Setting                    | Description                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Generation Method**      | `Material Wise` (highest fidelity — runs a continuous-energy solve of the actual geometry), `Stochastic Slab`, or `Infinite Medium` |
| **Nuclide-wise library**   | One micro XS data set per nuclide; materials stay nuclide-decomposed (see below). Defaults on when a DAGMC geometry is loaded       |
| **Energy Group Structure** | Named group structures (CASMO-2 through CCFE-709)                                                                                   |
| **Particles**              | Particle count for the underlying solve                                                                                             |
| **Transport Correction**   | `None` or `P0`                                                                                                                      |
| **Temperatures**           | Optional space/comma-separated temperatures — one MGXS set per point                                                                |
| **Random Ray conversion**  | Optionally also convert the model to random ray (sets `random_ray` defaults in settings.xml)                                        |

## Nuclide-Wise Libraries (DAGMC Random Ray)

Standard multi-group mode replaces every material with a **macroscopic** cross-section set. OpenMC's random ray solver rejects macroscopic multi-group materials on DAGMC geometries, so random ray + DAGMC needs the other library form: **nuclide-wise**.

A nuclide-wise library stores one microscopic XS data set per nuclide, named after the nuclide (`Fe56`, `U235`, …). Materials stay nuclide-decomposed — each `<nuclide>` in materials.xml resolves against the same-named data set — so random ray accepts the model. Enable it with **Nuclide-wise library** in either generator mode (or the toggle in the Random Ray tab's Multi-Group Conversion panel); it defaults on when a DAGMC geometry is loaded. Applying a nuclide-wise library sets the project's nuclide-wise multi-group flag instead of converting materials to macroscopic.

Caveats: generation is slower and the library larger (per-nuclide tallies); when a nuclide appears in several materials, its data set is condensed over the material where it has the highest atom density; thermal scattering (Sαβ) tables are not included in nuclide-wise libraries.

## Library (Manual) Mode

Drives `openmc.mgxs.Library` directly for fine-grained control:

| Setting                      | Description                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cross Section Types**      | Checkbox grid of all 22 MGXS types (default: total, absorption, fission, nu-fission, chi, scatter matrix). Scatter/multiplicity matrix types are added automatically when missing — they are required for XSdata output |
| **Domain Type / Domains**    | Tallies per material, cell, or universe (none checked = all)                                                                                                                                                            |
| **By-nuclide decomposition** | Store per-nuclide MGXS in addition to the material-wise set                                                                                                                                                             |
| **Nuclide-wise library**     | Export one micro XS data set per nuclide instead (material domains only) — the DAGMC random-ray form, see below                                                                                                         |
| **Legendre Order**           | Scattering expansion order                                                                                                                                                                                              |
| **Estimator**                | `analog`, `tracklength`, or `collision` (default: per XS type)                                                                                                                                                          |

---

## Generating

Click **Generate MGXS Library** and pick a working directory. Generation runs a continuous-energy solve and can take a while. On success the library path is stored in the project settings; switch to multi-group energy mode in the Random Ray tab to use it.

MGXS generation requires a continuous-energy model with nuclide-decomposed materials. If the project is incompatible (multi-group energy mode, or macroscopic materials from a previous conversion), the window shows a warning box listing the issues and offers a one-click fix: **Switch to Continuous Energy** (or **Switch to Continuous Energy & Restore Materials** when macroscopic materials need restoring from the pre-conversion backup). The restore button is disabled with an explanation when no backup exists.
