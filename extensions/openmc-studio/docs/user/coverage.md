# Coverage and Limitations

OpenMC Studio is a graphical workbench over OpenMC 0.15.3 and 0.16.0. It covers the modelling, transport, depletion, variance-reduction, plotting, and analysis workflows documented below. It is not a wrapper around every OpenMC Python symbol, and it does not claim that every OpenMC feature is configurable in the IDE.

This page is the source of truth for that boundary. The project schema is **1.2.0**; optional fields keep older `.nuke-openmc` projects loading unchanged.

---

## Supported / Partial / Not Supported

| Area                          | Status        | What is covered                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSG geometry                  | **Supported** | Surfaces, cells, boolean regions, universes, root universe 0, void cells, cell rotation/translation/density/volume, surface names, albedo, periodic pairs                                                                                                                                                                                                                 |
| Lattices                      | **Supported** | Rectangular (`[z][y][x]`) and hexagonal (`[z][ring][theta]`) lattices, orientation, axial stacks, outer universe. Import and export use OpenMC's row/ring order.                                                                                                                                                                                                          |
| DAGMC                         | **Partial**   | DAGMC geometry, group/material overrides, graveyard creation, imprint/merge, and depletion sync. XML import keeps the `<dagmc_universe>` filename but does not read the `.h5m`; open it in the DAGMC Editor to load volume metadata.                                                                                                                                      |
| Materials                     | **Supported** | Nuclides and element expansion, atomic/weight fractions, density units, S(α,β), NCrystal cfg, macroscopic multi-group materials, temperature, isotropic elastic scattering, depletability and volumes                                                                                                                                                                     |
| Sources                       | **Supported** | Independent point/box/sphere/cylinder, Cartesian/cylindrical/spherical independent, point cloud, mesh spatial; discrete/uniform/Maxwell/Watt/normal/Muir/power-law/tabular/mixture/decay-spectrum energy; isotropic/monodirectional/mu-phi angle; delta/uniform/discrete/tabular/mixture time; constraints; file and compiled sources; mesh source; TokamakSource (0.16+) |
| Source bias                   | **Supported** | Energy/time continuous bias, discrete/mixture probability bias, isotropic angle bias, and point-cloud/mesh array bias. Array bias serializes for Python but the 0.16 XML transport reader rejects it; use energy or direction bias for XML runs.                                                                                                                          |
| Tallies                       | **Supported** | Every concrete OpenMC 0.16 filter exposed by the catalog, structured cell-instance and mesh-material pairs, reaction names/MT search, particle production, estimators, scores, nuclides, triggers, material derivatives, multiply-density, higher moments                                                                                                                 |
| Meshes                        | **Supported** | Regular, rectilinear, cylindrical, spherical, unstructured (MOAB/libMesh), mesh-filter translation; mesh-filter rotation is 0.16+ and capability-gated                                                                                                                                                                                                                    |
| Variance reduction            | **Supported** | Source-distribution bias, UFS mesh, multiple weight-window sets, weight-window file, enable toggle, collision/surface checkpoints, weight-window generator. Generator targets require FW-CADIS.                                                                                                                                                                           |
| Depletion                     | **Partial**   | Simple and advanced driver settings (CRAM substeps, keff-search reactivity control, external feed/removal, continuation), coupled/independent operators, transfer rates, all normalizations, per-nuclide Q. The advanced block is read by the OpenMC Studio driver, not by the standalone `openmc` binary.                                                                |
| Shutdown dose (R2S / D1S)     | **Supported** | Guided cell/mesh R2S and D1S workflows with dose tallies, parent-nuclide breakdown, activity/decay heat, and resumable results. Driver-only; not part of `settings.xml`.                                                                                                                                                                                                  |
| Runtime and advanced settings | **Supported** | OpenMP threads, MPI launch controls, trace, keff trigger, confidence intervals, free-gas threshold, shared secondary bank, surface grazing, particle limits, cutoffs, resonance scattering, multipole/tolerance, stride, seeds, properties file, triggers, and diagnostics. Threads/MPI are launch-only and are not written to XML.                                       |
| Plotting                      | **Supported** | Slice, voxel, solid ray-trace, wireframe ray-trace, camera controls, background, cell/material masks, overlap highlighting. Voxel plots ignore display colors; overlaps are slice-only.                                                                                                                                                                                   |
| Analysis                      | **Supported** | Statepoint tallies and convergence, entropy, derived tallies, depletion results, contact dose, decay spectra, dose coefficients, simulation comparison, CSV/PNG export through nuke-visualizer                                                                                                                                                                            |

---

## Explicit Non-Goals

These are deliberately outside the no-code promise. The UI explains the boundary instead of pretending to cover them.

- **`openmc.lib` / C API as a model-authoring path.** Studio does not expose an in-memory Python session or a raw C API editor.
- **Arbitrary Python model construction.** Generated Python is a faithful export, not a general Python IDE integration.
- **Compiling or authoring custom `CompiledSource` libraries.** A compiled-source path and parameter string can be imported/exported, but Studio does not build the shared library.
- **Nuclear-data generation or downloads.** Studio does not generate ACE/HDF5 libraries, run NJOY, download ENDF data, or process covariances. Use OpenMC's data tools or a data distribution.
- **A general OpenMC Python-model importer.** Import accepts XML files (and `.nuke-openmc` projects), not arbitrary `model.py` scripts.
- **Post-0.16 develop features.** Stellarator sources, geometry debug, the PNNL material library, and other develop-only additions are out of scope until they reach a supported release surface.
- **A separate plotting or CAD system.** Results use nuke-visualizer; geometry authoring uses the CSG Builder or DAGMC/nuke-cad workflows.

---

## What Still Requires OpenMC / Python

Studio generates inputs and drives the installed tools. These steps still run OpenMC or Python outside the state model:

- transport and eigenvalue/fixed-source execution;
- statepoint and summary generation;
- depletion, R2S/D1S, CMFD, and criticality-search drivers;
- multi-group cross-section generation and random-ray preparation;
- stochastic volume calculation;
- native plot rendering through OpenMC's C++ plot mode;
- dose-coefficient and decay-data reads from the installed data libraries;
- chain-file construction from ENDF libraries;
- installing OpenMC, MPI, DAGMC, and the Python packages.

A run needs a configured OpenMC environment and cross-section library (`OPENMC_CROSS_SECTIONS`). The Simulation tab's readiness checklist reports missing items before a run.

---

## Version and Capability Notes

- **OpenMC 0.15.3** is supported with the release-compatible XML surface.
- **OpenMC 0.16.0+** adds source-distribution bias, mesh-filter rotation, shared secondary bank, surface grazing, reaction and particle-production filters, TokamakSource, decay-spectrum sources, depletion substeps, and keff-search reactivity control.
- Capability probes decide which 0.16-only fields are emitted; version strings are never parsed. Unsupported fields are omitted with a generation warning instead of being silently written into an invalid XML file.
- Generated XML and Python are both views of the same project state. Derived tallies are analysis-only and never appear in either simulation input.

---

## Known Limitations

- **Generalized PDG particles are not supported.** Sources and filters are limited to neutron and photon. Imported particle names outside that pair are reported and mapped with a warning rather than dropped silently.
- **Some fields are driver-only.** CMFD, R2S/D1S, depletion advanced controls, MPI/threads, and derived tallies are not representable in vanilla OpenMC XML. The UI labels them, and XML export warns where OpenMC would ignore them.
- **Source array bias is Python-only.** Point-cloud and mesh probability arrays are preserved in the project and Python export, but the 0.16 XML transport reader rejects them.
- **`openmc.stats.Legendre` is absent.** Its XML serializer raises in OpenMC; Studio does not offer a control that cannot round-trip.
- **Tabular `ignore_negative` is absent.** OpenMC XML has no attribute for it, so the editor rejects negative densities instead of letting XML and Python diverge.
- **DAGMC XML import is a reference handoff.** The `.h5m` file must travel with the project; the XML does not embed mesh data.
- **Unstructured meshes need MOAB or libMesh.** The editor validates the file extension and reports a dependency hint when the reader is unavailable.
- **Depletion `reduceOutput` is stored in the project but is not yet emitted to XML or the driver.** This is a project-only field.

If a feature you need is missing, use the generated XML/Python as an escape hatch or file an issue with the model file and the OpenMC version.
