# Safe Edits

NukeAI can change basic OpenMC run settings, materials, tallies, scalar CAD feature parameters, and existing sketch
dimensions or referenced document parameters without writing directly from the chat model. Every edit goes through a
preview, an explicit apply step with confirmation, and an in-session undo.

## Supported settings

Only these paths are accepted. Any other path rejects the whole preview.

| Path                      | Rule                                                      |
| ------------------------- | --------------------------------------------------------- |
| `run.particles`           | integer >= 1                                              |
| `run.inactive`            | integer >= 0; only when the current run mode has inactive |
| `run.batches`             | integer >= 1                                              |
| `seed`                    | integer >= 0                                              |
| `threads`                 | integer >= 1                                              |
| `verbosity`               | integer from 1 to 10                                      |
| `energyMode`              | `continuous-energy` or `multigroup`                       |
| `photonTransport`         | boolean                                                   |
| `electronTreatment`       | `led` or `ttb`                                            |
| `atomicRelaxation`        | boolean                                                   |
| `sourceRejectionFraction` | number from 0 to 1                                        |

Sources, geometry, and advanced settings are not editable through this flow. Materials and tallies have their own
flows below.

## Materials

Material edits support add, update, and remove actions, one to twenty per preview.

- **Update** - change `name`, `density`, `densityUnit`, `nuclides`, `thermalScattering`, `color`, `temperature`,
  `volume`, `isDepletable`, `ncrystalCfg`, or `isotropic` on an existing material.
- **Add** - create a material with those fields. It receives the next material id, and its name must not already exist.
- **Remove** - delete an existing material; the preview keeps its full snapshot for undo.

Material ids, macroscopic data, and CAD provenance fields are read-only in this flow. NCrystal config cannot be
combined with thermal scattering. A nuclide list uses `{ name, fraction, fractionType }` entries and must have a
positive total fraction. NukeAI reads the current material first and does not invent nuclides, densities, volumes, or
names.

Removing a material does not rewrite references in cells or tallies. Validate the project after a removal.

## Tallies

Tally edits support add, update, and remove actions, one to twenty per preview.

- **Update** - change `name`, `scores`, `nuclides`, `estimator`, `multiplyDensity`, or `higherMoments`.
- **Add** - create a tally with those fields. It receives the next tally id, and a provided name must be unique.
  `nuclides` defaults to `["total"]` and `filters` defaults to `[]`.
- **Remove** - delete an existing tally; the preview keeps its full snapshot for undo.

Scores must be catalog names or numeric `MT<n>` values. Existing filters, triggers, and derivatives are preserved and
cannot be edited through this flow. Adding a tally with filters is supported; mesh authoring remains a dashboard task.
NukeAI never invents tally results: run the model and inspect a statepoint for results.

## Preview

Ask NukeAI to change a setting, for example "set 200 batches and 5000 particles per batch". NukeAI calls the
read-only preview capability (`nuke_openmc_previewSettings`) first. The preview validates every path and value, rejects
a request that would change nothing, and returns a diff without touching the project.

The finished tool card shows a **Changes** section with:

- the proposal title and summary;
- one row per changed path, with its human-readable label, its path, and the before and after values.

If anything is invalid, the preview fails and no proposal is stored. Read the error and ask for a corrected value
instead of retrying the same request.

## Apply with NukeAI

A preview card shows **Apply with NukeAI**. The button never applies anything itself: it opens a focused chat prompt with
the proposal id, summary, and apply capability. NukeAI previews again when needed, shows the diff, and asks for
explicit confirmation before calling the write capability.

Confirm only when the diff matches what you want. The apply tool call appears as its own result card with the same
diff, an **Undo** button, and no **Apply with NukeAI**.

If the project changed between the preview and the apply, the apply is rejected with a message naming the changed
setting, material, or tally. Run a fresh preview instead of retrying the old proposal.

## Undo

An applied change shows **Undo**. Selecting it opens a warning notification with an **Undo** action; the reverse
handler runs only after you choose that action. Cancelling the notification leaves the settings unchanged.

Undo restores only the paths, materials, or tallies that the proposal changed and verifies that the current values
still match the applied result. A failed undo keeps the token so you can try again, and reports the failure instead of
replacing the card.

Undo state is in memory for the current IDE session only:

- it does not survive an IDE restart or window reload;
- each token is one-shot and is removed after a successful undo;
- an unknown, expired, or already used token reports `This change can no longer be undone.`

## CAD feature edits

CAD edits are opt-in. Turn on **Nuke CAD: AI Authoring** in **Settings → Nuke CAD**; while it is off, the CAD
authoring tools (feature and sketch preview/apply plus sketch discovery) are absent from NukeAI. Only a saved
`.nuke-cad` document can be edited.

The allowlist is deliberately narrow:

| Feature         | Parameter   | Rule                                          |
| --------------- | ----------- | --------------------------------------------- |
| Pad, Pocket     | `length`    | blind/default end only; positive              |
| Revolve, Groove | `angle`     | greater than 0 and at most 360 degrees        |
| Fillet          | `radius`    | positive; the feature must already have edges |
| Shell           | `thickness` | positive                                      |

A preview writes a transient hidden candidate beside the source, builds it with the same geometry backend, and
compares it with the current build. The preview is rejected if the build fails, a feature fails, the solid count
changes, the selector map changes, the region-manifest volume or surface coverage changes, no tessellation is produced,
or the bounding box is invalid. The candidate and its sidecar are deleted whether the build succeeds or fails.

A successful preview opens the **CAD Edit Review** panel beside the viewport. The panel shows the same diff and impact, keeps the candidate geometry as a translucent ghost over the current model (changed solids use a warmer accent), and offers **Apply**, **Dismiss**, and **Undo**. The chat card remains available; both surfaces invoke the same apply capability and confirmation path.

Apply accepts only the proposal id. It rejects a proposal from another document, an expired proposal, a changed
document revision, or a feature whose parameters changed after the preview. Before mutating, it writes a hidden
`.nuke-ai-backup-<document>` snapshot beside the source. It then applies every edit in one document-store commit,
schedules the normal rebuild, and exposes **Undo** in the card. Undo re-checks the revision and applied values, restores
the before parameters in one batch, and schedules the rebuild again.

New sketch entities, constraints, or dimensions, free-form sketch creation, document parameters not referenced by a
sketch, scripts, topology, booleans, imports, assemblies, and drawings are outside this surface. External MCP never
exposes the CAD preview or apply tools.

## CAD sketch dimensions

Sketch edits use the same opt-in switch: **Nuke CAD: AI Authoring** in **Settings → Nuke CAD**. Only a saved `.nuke-cad`
document can be edited, and NukeAI starts by calling `nuke_cad_listSketchDimensions`. That read-only tool returns the
document path, the document parameter table, and every sketch with its id, name, datum, consumers, and dimensions (id,
kind, driving flag, bound parameter, and current value), so NukeAI never guesses a sketch or dimension.

A preview accepts one to eight edits on one target sketch, in either form:

```json
{ "sketchId": "fuel-sketch", "dimensionId": "dimension-5", "value": 0.44 }
```

```json
{ "sketchId": "fuel-sketch", "parameterName": "fuelRadius", "value": 0.44 }
```

Only existing driving dimensions and document parameters referenced by a sketch or parametric curve are editable.
A literal driving dimension changes only that sketch. A parameter-bound dimension cascades: the document parameter
changes, and every sketch and parametric curve that references it is re-solved or re-sampled. The preview diff names
the parameter and every affected dimension and sketch, so review the full impact before applying.

The preview runs a real build and is rejected when the sketch, dimension, or parameter is missing, the dimension is a
reference (`driving: false`), the parameter is not referenced by any sketch or curve, the value does not change
anything, or the solver reports a conflict. It preserves topology, selector, and region coverage. A successful preview
opens the **CAD Edit Review** panel with the same diff, solver status, and build impact, and shows the candidate
geometry as a display-only ghost.

Apply accepts only the proposal id after explicit confirmation. It re-checks the document revision and proposal
freshness, then writes the parameter and every affected sketch in one atomic document-store commit and rebuilds. If the
document changed after the preview, preview again instead of reusing the id. Undo from the chat card or the review
panel restores the parameter and all affected sketches together and schedules the rebuild again.

## Related

- [NukeAI Actions](actions.md) for the chat actions and result cards.
- [Agent and Tool Result Cards](../dev/agent-and-cards.md) for the renderer contract.
