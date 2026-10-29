# Shutdown Dose (R2S / D1S)

The **Shutdown Dose** wizard runs OpenMC's activation and decay-photon workflows without writing a Python driver. Open it from **Tools → OpenMC → Advanced → Shutdown Dose**.

Two methods are available:

| Method  | What it does                                                                                       | Best for                                           |
| ------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **R2S** | Neutron transport → activation → decay photon source → photon transport, with cell or mesh regions | Spatially resolved dose and activity               |
| **D1S** | One coupled neutron–photon transport with decay photons and time correction factors                | A faster first estimate without spatial activation |

Both methods require a **fixed-source model**. Shutdown-dose settings are stored in the `.nuke-openmc` project and are never written to `settings.xml`; they are driver-only.

## Before you start

1. Build the model geometry, materials, and a fixed neutron source.
2. Set the **cell volume** for every cell you want to activate. Open the wizard's **Method & model** step and enter the volume inline, or run a volume calculation first.
3. Add at least one **photon tally** in the Tally Configurator, or use **Add dose tally** in the wizard. A photon tally needs a Particle Filter with the `photon` bin.
4. Select a **depletion chain** XML (for example, a CASL chain or one built with the Chain Builder). The chain supplies activation cross sections and decay data.

## Run an R2S calculation

1. **Method & model** — choose R2S, then select **Cells** or **Meshes**.
   - Cells must be material-filled and have a volume. Bounding boxes are computed from the CSG region; if OpenMC cannot bound a region, open **Bounding box overrides** and set an explicit box, or use a simpler region.
   - Multiple meshes are supported. They must not overlap; the wizard warns when regular-mesh bounds intersect.
2. **Schedule** — add one row per irradiation interval with a duration, unit, and source rate in neutrons/s. A rate of `0` is a pure decay interval. Choose the chain and the photon time indices (default: every time with a decay source).
3. **Photon tallies** — select existing photon tallies or **Add dose tally**. The dose template reads OpenMC's shipped ICRP tables through `openmc.data.dose_coefficients`; the response function is not hard-coded in the UI. Optional: score per parent radionuclide (R2S) or keep/sum the parent breakdown (D1S).
4. **Review & run** — choose a run directory. The wizard writes the model XML there and starts the driver. Progress streams in the panel; **Cancel** stops the process.
5. **Results** — review activation regions, photon tally charts, dose response, total activity, and decay heat. **Reveal output folder** opens the run tree in the file navigator. The results page reloads from `r2s_summary.json` / `d1s_summary.json` when you reopen the project.

> **Runtime warning:** R2S can run for a long time and writes a large output tree with neutron, activation, and photon subdirectories. Start with one or two short steps and a small particle count before scaling up.

## Minimal R2S example

- Model: a small fixed-source shielding model with a material-filled cell and a photon flux tally.
- Cell: volume `2000 cm³`.
- Schedule: `1 d` at `1e15 n/s`.
- Photon time index: the final time (`t1`).
- Chain: your depletion chain XML.

Run R2S from the wizard, then open **Results**. The summary reports the activation region count, photon tally values, and activity/decay heat at each activation time.

## D1S notes

D1S prepares every selected photon tally with a `ParentNuclideFilter`, runs one coupled transport solve, and applies time correction factors at the chosen schedule index. Uncheck **Sum corrected tallies over parent nuclides** to keep the per-nuclide breakdown in the corrected tally; the Results step lists the factor for each parent.

## Troubleshooting

| Message                                | Fix                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Cell N has no volume`                 | Enter the cell volume in the Method step or run a volume calculation and set it.           |
| `No photon tallies selected`           | Select a tally with a photon Particle Filter, or add the dose tally template.              |
| `Chain file not found`                 | Choose an existing chain XML in the Schedule step.                                         |
| `No decay photon sources were found`   | The schedule or materials produce no activation products; check the chain and source rate. |
| `Mesh not fully contained in geometry` | Shrink or move the activation mesh so every element lies inside the model.                 |
| `No viewer opened …`                   | The statepoint has no registered viewer; the file is revealed in the navigator instead.    |

## Python export

The single-file **Generate Python Script** export appends an equivalent R2S/D1S driver after `model.export_to_xml()`. The separate-files export labels the shutdown-dose boundary explicitly: run the wizard, or export the single-file script. Shutdown-dose fields never appear in `settings.xml` or `tallies.xml`.
