# Safe OpenMC Settings Edits

NukeAI can change basic OpenMC run settings without writing directly to your project from the chat model. Every edit
goes through a preview, an explicit apply step with confirmation, and an in-session undo.

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

Materials, tallies, sources, geometry, and advanced settings are not editable through this flow.

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

If the settings changed between the preview and the apply, the apply is rejected with
`Settings changed since the preview. Preview again.` Run a fresh preview instead of retrying the old proposal.

## Undo

An applied change shows **Undo**. Selecting it opens a warning notification with an **Undo** action; the reverse
handler runs only after you choose that action. Cancelling the notification leaves the settings unchanged.

Undo restores only the paths that the proposal changed and verifies that the current values still match the applied
result. A failed undo keeps the token so you can try again, and reports the failure instead of replacing the card.

Undo state is in memory for the current IDE session only:

- it does not survive an IDE restart or window reload;
- each token is one-shot and is removed after a successful undo;
- an unknown, expired, or already used token reports `This change can no longer be undone.`

## Related

- [NukeAI Actions](actions.md) for the chat actions and result cards.
- [Agent and Tool Result Cards](../dev/agent-and-cards.md) for the renderer contract.
