# Local Metrics and the Edit Journal

NukeAI keeps two local, bounded JSON-lines journals under the workspace config folder. They exist for debugging and
audit, not for remote analytics: nothing is uploaded, no prompt or file content is recorded, and a failed write never
fails a capability tool call.

## Files

```text
<workspace>/.nuke-ide/ai/
  metrics.jsonl       # current tool invocation metrics
  metrics.1.jsonl     # one rotated backup, overwritten on the next rotation
  edits.jsonl         # current applied-edit audit journal
  edits.1.jsonl       # one rotated backup, overwritten on the next rotation
```

Each journal is capped at 1 MiB. Once appending the next line would exceed the cap, the current file moves to its
single backup and the new line starts a fresh current file. The backup is overwritten on the next rotation; there is no
second backup and no automatic pruning beyond that. Delete the files to clear the history.

Writes are serialized per service through a promise chain. Concurrent tool calls therefore append whole lines in call
order and never interleave. Reads wait behind pending writes.

## Metrics schema

`NukeAiMetricsService` records one line per capability tool call:

```json
{
  "timestamp": "2026-11-01T12:34:56.789Z",
  "capabilityId": "nuke.cad.summarizeDocument",
  "version": 1,
  "risk": "read",
  "ok": true,
  "durationMs": 42
}
```

- `version` is the effective capability version, defaulting to `1`.
- `risk` is the capability risk level.
- `ok` is the capability result's `ok`, or `false` when argument parsing, input validation, cancellation, or a thrown
  handler prevented a successful result.
- `durationMs` is wall-clock time for the tool handler, rounded to a non-negative integer.
- The bridge records in a `finally` block, so success, error, cancellation, and early validation failures all produce
  one line. External MCP calls use their own audit ring and are not written here.

The record is deliberately limited to those six fields. Inputs, argument values, file contents, workspace or artifact
paths, prompts, model output, handles, and credentials are never passed to the metrics service. `record` picks only the
known fields even if a caller supplies extra properties at runtime.

Without a workspace the service keeps at most 200 entries in memory and logs once that persistence is disabled.
`NukeAI: Show Tool Metrics` can still show those entries for the session.

## Edit journal schema

`NukeEditJournal` records one line when a capability result carries a `changeSet` or an `undoToken`:

```json
{
  "timestamp": "2026-11-01T12:34:56.789Z",
  "capabilityId": "nuke.openmc.applySettings",
  "changeSetId": "proposal-1",
  "title": "Run settings",
  "summary": "Increase batches and particles.",
  "paths": ["run.batches", "run.particles"],
  "undoTokenHash": "64-character-sha-256-hex"
}
```

- `changeSetId`, `title`, and `summary` come from the result's change set; a token-only result uses empty strings and
  an empty `paths` list.
- `paths` lists the changed change-set paths, deduplicated. It never includes `before` or `after` values.
- `undoTokenHash` is the SHA-256 hex digest of the undo token computed with Web Crypto. The raw token is never written.
  If Web Crypto is unavailable, the hash is omitted and one warning is logged.
- Title, summary, and path text are capped and secret-shaped values (`Bearer ...`, `apiKey=...`, `token: ...`,
  `password=...`) are replaced with `[redacted]` before writing.
- Without a workspace the journal skips the entry and logs once.

## Undo persistence

Undo is deliberately session-scoped:

- `NukeUndoService` handlers and tokens live in frontend memory only;
- the edit journal is an audit trail, not an undo source, and does not contain enough state to reverse an edit;
- reopening the workspace or reloading the IDE discards every undo token, even though the journal line remains.

Persisting undo would require a serialized inverse operation, a state fingerprint, and a security review. That is out of
scope for this contract.

## Failure behavior

Every append catches its own errors, logs the failure with the journal file name, and resolves. A read-only,
permission-denied, or full disk never changes a tool result and never rejects a tool call. Malformed lines are skipped
when reading.

## Related code

- `src/browser/capabilities/nuke-ai-metrics-service.ts` — metrics schema, recording, recent entries, aggregation.
- `src/browser/capabilities/nuke-edit-journal.ts` — journal entry, SHA-256 hash, redaction.
- `src/browser/capabilities/nuke-local-log.ts` — serialized append, rotation, and reading for both journals.
- `src/browser/commands/nuke-ai-metrics-command.ts` — read-only `NukeAI: Show Tool Metrics`.

See [Local Audit Logs](../user/audit.md) for where the files live, how to delete them, and what users can expect. See the
[Capability Registry](../../../nuke-core/docs/dev/capability-registry.md) for the version contract.
