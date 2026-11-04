# Nuke Diagnostics

Nuke Diagnostics is a dedicated, read-only chat agent for triaging the active workspace. It reports severity-coded
findings for the active CAD model, OpenMC project or run, statepoints, and tally series, backed by tool evidence, and
closes with a short list of safe next steps. It never repairs anything.

## Open the diagnostics actions

Open the **Nuke Tools** view, expand the **NukeAI** section, and use the **Diagnostics** subsection. Every action is
also available in the Command Palette under the `NukeAI:` prefix.

| Action                     | Agent            | Tool                          |
| -------------------------- | ---------------- | ----------------------------- |
| Diagnose Active CAD Model  | Nuke Diagnostics | `nuke_cad_diagnoseModel`      |
| Diagnose OpenMC Project    | Nuke Diagnostics | `nuke_openmc_diagnoseProject` |
| Diagnose OpenMC Run        | Nuke Diagnostics | `nuke_openmc_diagnoseRun`     |
| Diagnose Active Statepoint | Nuke Diagnostics | `nuke_viz_diagnoseStatepoint` |

Each action opens a focused chat pinned to **Nuke Diagnostics** and sends the matching request with `#nukeContext`
attached. If the diagnostics agent is unavailable, the request falls back to the **NukeAI** agent instead of failing.

## What each diagnosis reports

- **CAD model** — the document path, build success, solid, face, and triangle counts, region manifest state,
  selection validity, hidden solids, and findings such as a failed build, no solids, missing triangles, stale
  selection, or a manifest count mismatch.
- **OpenMC project** — validation findings, environment readiness, cross-section configuration, DAGMC file state,
  entity counts, and whether the project is ready to run. Findings include environment problems, missing cross
  sections, missing DAGMC files, empty materials, missing geometry, and absent tallies.
- **OpenMC run** — the run state, working directory, log file, log tail, and findings from the log. Findings cover
  lost particles, overlapping cells, missing cross sections, error lines, warnings, convergence problems, and MPI
  failures. When more than one run is active, the request asks which working directory to diagnose instead of
  guessing.
- **Statepoint** — batches, generations per batch, k-effective and its uncertainty, tally coverage, and findings
  such as high k-effective uncertainty, few batches, missing tallies, tallies without scores, mesh tallies, and a
  large tally count.
- **Statepoint comparison** — batches, generations per batch, k-effective with uncertainty, and tally ids for two
  files, plus findings for a missing k-effective, a k-effective shift, a batch-count difference, and a tally-set
  difference.
- **Tally series** — per-step values, standard deviations, and bin counts for one tally and score, plus findings
  for empty bins, high uncertainty, worsening uncertainty, a mesh tally, and a single-step series.

## Compare statepoints and analyze tally series

The **Nuke Diagnostics** chat answers comparison and series questions directly; no sidebar action is needed. Ask,
for example, “compare `run-a/statepoint.100.h5` with `run-b/statepoint.100.h5`” or “how is the flux tally
uncertainty changing from `statepoint.100.h5` to `statepoint.500.h5`?”. Supply absolute workspace paths, the tally
id, and the optional score, nuclide, or statistic.

Comparison findings use the same issue codes the agent reports elsewhere:

| Code               | Severity        | Condition                                                |
| ------------------ | --------------- | -------------------------------------------------------- |
| `missing-keff`     | warning         | Either file omits k-effective or its standard deviation. |
| `keff-shift`       | warning / error | Relative k-effective difference above 1% / above 5%.     |
| `batch-count-diff` | info            | The batch counts differ.                                 |
| `tally-set-diff`   | info            | The tally id sets differ.                                |

Series findings:

| Code                    | Severity | Condition                                                      |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `no-steps`              | error    | The series returned no statepoint steps.                       |
| `empty-bins`            | warning  | A step has no finite tally bins.                               |
| `high-uncertainty`      | warning  | Relative uncertainty (`std / abs(value)`) above 10%.           |
| `high-uncertainty`      | error    | Relative uncertainty (`std / abs(value)`) above 25%.           |
| `worsening-uncertainty` | warning  | The last step's relative uncertainty exceeds the first by 20%. |
| `mesh-tally`            | info     | The tally is a mesh tally.                                     |
| `single-step`           | info     | Only one step is present, so no trend can be assessed.         |

A successful read returns `ok: true` even when it reports error findings. At most 50 statepoints are read for one
series, and findings are capped at 20.

## Severity triage

Findings carry `error`, `warning`, or `info` severity. Nuke Diagnostics reports them in that order:

1. **Error** — the subject is not trustworthy or usable yet. Address it before an export, import, or run.
2. **Warning** — the subject may work, but the risk or uncertainty is real. Read the suggestion before continuing.
3. **Info** — context only, such as hidden solids, a capped finding list, or a mesh tally.

A diagnosis that ran successfully returns `ok: true` even when it found errors. `ok: false` means the diagnosis could
not run at all, for example because no CAD document, OpenMC project, or statepoint is active, a path is relative or
outside the workspace, or a backend read failed; the chat reports the missing prerequisite instead of inventing
findings. Finding lists are capped at 20, and a `findings-truncated` entry marks a capped result.

## Evidence and next steps

Nuke Diagnostics cites the tool and the document path, run directory, or statepoint behind each finding, and quotes
issue codes and counts instead of paraphrasing them. It separates what a tool returned from any explanation labeled
as a hypothesis, and it never invents counts, paths, materials, tallies, or run states. Answers close with at most
three safe next steps. If a diagnostic tool is unavailable, the agent says so and continues with the read-only support
tools that are present.

## Statepoint and tally-series limits

**Diagnose Active Statepoint** triages the loaded statepoint's metadata only. It does not read raw tally values,
per-bin uncertainties, or spatial distributions.

`nuke_viz_analyzeTallySeries` adds aggregate per-step values and uncertainties, but the tally-series contract still
does not expose per-bin values for a single file or spatial distributions. Mesh tallies are reported as info findings so
the number is not mistaken for a spatial result. Use the statepoint viewer for per-bin and spatial detail.

## Read-only boundary

The agent and its tools only read state. They never export DAGMC, import geometry, edit a project, open a viewer,
start, stop, or cancel a run, or write files. They also leave the CAD selection, visibility, and loaded statepoint
unchanged. Between-step comparisons and series reads go through the headless OpenMC backend, so neither compared file
is loaded into the viewer and the active statepoint stays as it was. The capability bridge rejects a non-diagnostics
tool call when the request agent is Nuke Diagnostics, even if the message manually references that tool.

State-changing capabilities such as export, import, run, and viewer opening still exist in the **NukeAI** agent and
require explicit confirmation in the conversation. A diagnostic answer never performs or confirms them for you.

## Requirements

- A ready language model assigned to **Nuke Diagnostics** under **AI Settings → Agents** (or picked in the chat input
  for that session). The default chat agent preference only applies to NukeAI.
- **Diagnose Active CAD Model** needs an open CAD document.
- **Diagnose OpenMC Project** needs an active OpenMC Studio project and reports the selected Python environment and
  cross-section configuration it finds.
- **Diagnose OpenMC Run** needs exactly one active run, or a matching absolute working directory.
- **Diagnose Active Statepoint** needs a statepoint already loaded in the visualizer.
- **Compare statepoints** needs two absolute statepoint paths inside the workspace.
- **Analyze a tally series** needs one to fifty absolute statepoint paths inside the workspace and the tally id; the
  score, nuclide, and statistic are optional.

For the actions available from the same sidebar section, see [NukeAI Actions](actions.md). For the agent prompt,
tool contract, and result cards, see [Agent and Tool Result Cards](../dev/agent-and-cards.md).
