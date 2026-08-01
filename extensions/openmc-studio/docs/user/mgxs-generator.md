# MGXS Generator

The MGXS Generator produces a multi-group cross-section library (`mgxs.h5`) from your continuous-energy model and writes the library path into the project settings — the library multi-group and random ray runs need (see the Random Ray tab in the [Simulation Dashboard](simulation-dashboard.md)).

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
| **Energy Group Structure** | Named group structures (CASMO-2 through CCFE-709)                                                                                   |
| **Particles**              | Particle count for the underlying solve                                                                                             |
| **Transport Correction**   | `None` or `P0`                                                                                                                      |
| **Temperatures**           | Optional space/comma-separated temperatures — one MGXS set per point                                                                |
| **Random Ray conversion**  | Optionally also convert the model to random ray (sets `random_ray` defaults in settings.xml)                                        |

## Library (Manual) Mode

Drives `openmc.mgxs.Library` directly for fine-grained control:

| Setting                      | Description                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cross Section Types**      | Checkbox grid of all 22 MGXS types (default: total, absorption, fission, nu-fission, chi, scatter matrix). Scatter/multiplicity matrix types are added automatically when missing — they are required for XSdata output |
| **Domain Type / Domains**    | Tallies per material, cell, or universe (none checked = all)                                                                                                                                                            |
| **By-nuclide decomposition** | Store per-nuclide MGXS in addition to the material-wise set                                                                                                                                                             |
| **Legendre Order**           | Scattering expansion order                                                                                                                                                                                              |
| **Estimator**                | `analog`, `tracklength`, or `collision` (default: per XS type)                                                                                                                                                          |

---

## Generating

Click **Generate MGXS Library** and pick a working directory. Generation runs a continuous-energy solve and can take a while. On success the library path is stored in the project settings; switch to multi-group energy mode in the Random Ray tab to use it.
