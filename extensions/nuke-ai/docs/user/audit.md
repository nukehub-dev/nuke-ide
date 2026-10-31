# Local Audit Logs

NukeAI keeps two small local journals so you can see what it did: one for capability tool calls and one for applied
edits. Everything stays in the open workspace. NukeIDE does not upload these files anywhere.

## Where the logs live

Both journals are under the workspace config folder:

```text
<workspace>/.nuke-ide/ai/
  metrics.jsonl
  metrics.1.jsonl
  edits.jsonl
  edits.1.jsonl
```

- `metrics.jsonl` has one line per capability tool call: the time, capability id, capability version, risk level, whether
  it succeeded, and how long it took.
- `edits.jsonl` has one line per capability result that proposed or applied an edit: the time, capability id, change-set
  id, title, summary, changed paths, and a SHA-256 hash of the undo token.
- The `.1.jsonl` files are single rotated backups. Each journal is capped at 1 MiB so it cannot grow without bound.

## View the logs in the IDE

- **NukeAI: Show Tool Metrics** opens a read-only quick pick with the last 20 tool calls or aggregate counts by
  capability.
- **NukeAI: Show Capability Catalog** lists every capability that is available in the current context with its id,
  title, risk, version, category, tags, and availability. Selecting a row copies its id and opens a read-only detail view.
  The catalog never invokes a capability.

Both commands are read-only. Neither command writes, deletes, or replays a log entry.

## What is not logged

The journals intentionally exclude:

- prompts, model responses, and chat text;
- tool inputs and argument values;
- file contents and file paths in the metrics journal;
- raw undo tokens in either journal (the edit journal stores only the SHA-256 hash);
- before and after values from a change set;
- credentials and secret-shaped text, which is redacted before writing.

The applied-edit journal records changed path identifiers such as `run.batches`, but not the values at those paths. The
full preview snapshot remains in the preview history under `.nuke-ide/ai/previews`; see [Previews and the Gallery](previews.md).

## Delete the logs

1. Open the workspace in the file explorer.
2. Delete `metrics.jsonl`, `metrics.1.jsonl`, `edits.jsonl`, and `edits.1.jsonl` under `.nuke-ide/ai/`, or delete the whole
   `.nuke-ide/ai/` folder to clear previews as well.

The IDE recreates the folder and journal files on the next recorded call. There is no delete control inside the metrics
command, and deleting a journal does not affect CAD, OpenMC, or visualizer files.

## Undo lifetime

Undo is in-memory and session-scoped:

- each applied edit returns an undo token that only the current IDE session can redeem;
- reloading the IDE or reopening the workspace discards every undo token;
- the edit journal is an audit trail, not an undo source, and cannot restore an edit after a reload.

The journal line remains after the token is gone, so you can still see that the edit happened.

## Without a workspace

With no workspace folder open, tool metrics stay in memory for the session and the edit journal is skipped. NukeAI logs
one message per service that persistence is disabled and never creates `.nuke-ide/ai/` outside a workspace.

## Related pages

- [Previews and the Gallery](previews.md) for saved preview bundles and their retention.
- [NukeAI Actions](actions.md) for the capability commands and their read-only default.
- [Local Metrics and the Edit Journal](../dev/metrics.md) for the exact schemas, rotation, and privacy rules.
