---
name: nuke-diagnostics
description: Triage the active CAD model, OpenMC project or run, and loaded statepoint with read-only diagnostic tools. Use when a model or simulation misbehaves and the user needs severity-ordered findings and safe next steps.
---

# Nuke Diagnostics

Use this skill when the user asks why a model, project, run, or statepoint looks wrong, or wants a readiness
check before continuing the workflow. The diagnostics tools report findings; they never repair anything.

## Tool names

Capability ids are stable registry identifiers. Chat calls use sanitized tool names: `nuke.cad.diagnoseModel` is
exposed as `nuke_cad_diagnoseModel`, and the other diagnostic ids follow the same dots-to-underscores mapping.

## Diagnostic tools

- `nuke_cad_diagnoseModel` - triages the active CAD document. Reports the document path, build success, solid,
  face, and triangle counts, region manifest state, selection validity, hidden solids, and severity-coded issues.
- `nuke_openmc_diagnoseProject` - triages the active OpenMC project. Reports validation findings, environment
  readiness, cross-section state, DAGMC file state, entity counts, and whether the project is ready to run.
- `nuke_openmc_diagnoseRun` - triages one active OpenMC run. Reports the run state, working directory, log path,
  log tail, and severity-coded findings. Pass `{ "workingDirectory": "<absolute path>" }` to choose a run; omit
  it only when exactly one run is active.
- `nuke_viz_diagnoseStatepoint` - triages the currently loaded statepoint. Reports batches, generations per
  batch, k-effective uncertainty, tally coverage, and severity-coded findings. It never loads a different file.

Read-only support tools add context without changing state: `nuke_cad_summarizeDocument`,
`nuke_cad_inspectSelection`, `nuke_openmc_summarizeProject`, `nuke_openmc_validateProject`,
`nuke_openmc_getRunStatus`, and `nuke_viz_summarizeStatepoint`.

## Severity triage

Order findings by severity and keep the order in the answer:

1. `error` - the subject cannot be trusted or used yet. Fix or explain before any run or export.
2. `warning` - the subject may work, but the risk or uncertainty is real. Report it with the suggested fix.
3. `info` - context only. Hidden solids, capped finding lists, and mesh tallies belong here.

`ok: false` means the diagnosis could not run: report the missing document, project, statepoint, or backend
failure and stop. `ok: true` with error findings still means the diagnosis ran; report the errors and do not call
the subject healthy. A `findings-truncated` entry means the finding list was capped at 20; say so.

## Evidence rules

- Cite the tool name plus the document path, run directory, or statepoint the finding refers to.
- Quote issue codes, counts, and messages from the result. Never paraphrase them into new values.
- Separate observation from hypothesis: state what the tool returned, then label any explanation as a hypothesis
  and name the evidence that would confirm it.
- Never invent solid counts, materials, tallies, k-effective, paths, run states, or findings. Unknown values stay
  unknown.
- If a diagnostic tool is unavailable, say which one and use the read-only support tools that are present. Do
  not claim the diagnosis ran.

## Read-only boundary

Every diagnostic tool has read risk. This skill never exports DAGMC, imports geometry, edits a project, opens a
viewer, starts or cancels a run, or writes a file. It also never changes the CAD selection, visibility, or the
loaded statepoint.

State-changing capabilities keep their normal confirmation flow and require explicit user intent. Do not call one
from a diagnostic answer, and do not present a repair as already done. Close with at most three safe next steps
and mark any step that changes state as something the user must perform.

## Statepoint metadata limitation

`nuke_viz_diagnoseStatepoint` triages metadata only: batches, generations per batch, k-effective and its
uncertainty, and tally coverage. It does not read raw tally values, per-bin uncertainties, or spatial distributions.
For those, direct the user to the statepoint viewer or a dedicated tally analysis; do not infer them from the
diagnosis.

## Stop conditions

Stop and report the specific message when:

- no CAD document, OpenMC project, or statepoint is active;
- more than one OpenMC run is active and no working directory was provided;
- the backend cannot read a run log;
- a diagnostic tool returns `ok: false`;
- the user asks for an automatic repair.

## Related skills

Use `/nuke-cad`, `/openmc-studio`, and `/nuke-visualizer` for their normal read/export/run workflows, and
`/nuke-workflow` for the end-to-end CAD to DAGMC to OpenMC to visualizer handoff.
