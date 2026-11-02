# Previews and the Gallery

NukeAI records truthful previews under the workspace config folder and keeps the command that produced each one.
The preview gallery is a read-only view over that history, so you can find images and artifacts after the chat
session ends.

## Where previews live

Every workspace keeps its own history under `.nuke-ide/ai/previews/`, one folder per AI session:

```text
<workspace>/.nuke-ide/ai/previews/<session-id>/
  session.json
  trajectory.jsonl
  bundle-001/
    preview.png
    result.json
  bundle-002/
    preview.svg
    result.json
```

- `<session-id>` is a timestamp plus a short random suffix.
- `bundle-NNN` is created in order; each bundle holds at most one preview file and its result snapshot.
- `session.json` stores the session id, creation time, and workspace root.
- `trajectory.jsonl` records one line per capture with the capability id, a redacted input, and the preview path; it
  keeps the newest records up to 1 MiB.
- Previews larger than 8 MiB are not written to disk. The chat renders inline previews up to 4 MiB and falls back to text
  above that cap.
- Result snapshots are capped at 1 MiB, omit undo tokens, and redact credential-like values.

Sessions are created in memory when a capability result needs a preview. A session that never captures leaves
nothing on disk.

## Open the gallery

Run **NukeAI: Open Preview Gallery** from the Command Palette. The gallery opens in the main area and lists saved
bundles newest first.

- Each card shows the preview caption or capability, the capture time, and the preview file name.
- Select a card to open its preview image, HTML, text preview, or result snapshot.
- **Refresh** rescans the workspace after a new capture.
- With no saved previews, the empty state explains that previews appear after a NukeAI action captures a viewport
  or returns a result that carries a preview or artifact.

The gallery only reads the workspace folder. It never deletes, regenerates, or writes a preview, and it never reads
outside the open workspace. Malformed session or bundle metadata is skipped.

## Retention and deletion

The IDE keeps every bundle and never prunes automatically. To clear the history:

1. Open the workspace in the file explorer.
2. Delete the `.nuke-ide/ai/previews` folder.

The IDE recreates the folder on the next capture. There is no delete control in the gallery, and deleting the folder
does not affect CAD, OpenMC, or visualizer files outside it.

## Related pages

- [Getting Started](getting-started.md) for the welcome quick actions and model setup.
- [NukeAI Actions](actions.md) for the read-only action list and the capture action.
- [Previews and Trajectory](../dev/preview.md) for the persistence contract and trajectory schema.
