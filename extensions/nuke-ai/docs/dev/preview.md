# Previews and Trajectory

`nuke-ai` renders the `preview` field of a `NukeCapabilityResult` in the chat and records every preview-producing
invocation in an append-only trajectory. The first capability that supplies a preview is `nuke.viz.captureView`; a
capability without a preview still works and simply has no preview block.

## Directory layout

Previews are written under the workspace config folder, one folder per AI session:

```text
<workspace>/.nuke-ide/ai/previews/<session-id>/
  session.json
  bundle-001/
    preview.png | preview.svg | preview.html | preview.txt
    result.json
  bundle-002/
  trajectory.jsonl
```

- `<session-id>` is `YYYYMMDD-HHmmss-<short-random>`.
- `session.json` contains `{ id, createdAt, updatedAt, rootDir }`.
- `bundle-NNN` is created in order and contains at most one preview file.
- `result.json` is a bounded snapshot: inline data is removed, secret-shaped values are redacted, undo tokens are
  omitted, and a snapshot over 1 MiB is replaced by preview metadata plus a truncation marker; a persisted data URI is
  replaced by the preview file path.
- `trajectory.jsonl` has one command-to-preview record per capture and keeps the newest records up to 1 MiB.

Sessions are created in memory when the first capability result needs a preview; the folder is created on the first
capture. A session that never captures leaves nothing on disk. Without a workspace, at most 100 bundles stay in memory.
A change to the workspace roots starts a new preview session and releases the old in-memory state, so path checks and
the session directory follow the active workspace.

## Truthful and approximate previews

Every `NukePreview` must set `truthful`:

- `truthful: true` means the preview shows the actual rendered state the capability reports. The DAGMC viewport
  capture is truthful: it reads the visible viewport at the current camera and visibility state.
- `truthful: false` means the preview is a sketch, approximation, or composite. The chat always adds
  `Preview is approximate` so the model cannot mistake it for exact output.

`limitations` lists what the preview does not show, for example a camera state or hidden geometry. The renderer always
emits a caption block:

```text
Preview: <caption>
Limitations: <limitation>; <limitation>
Preview is approximate
```

Only the caption and limitations are sent as text; the image itself is sent as an image block, never as raw base64 in
the JSON block.

## Adding a preview to a capability

Return a `preview` in the capability result:

```ts
return {
  ok: true,
  message: 'Captured the active viewport.',
  preview: {
    kind: 'image',
    data: capture.dataUrl, // data:image/png;base64,...
    mimeType: capture.mimeType,
    caption: 'Active DAGMC viewport',
    truthful: true,
    limitations: ['Captures the visible viewport at the current camera and visibility state.']
  }
};
```

Supported forms:

| `kind`     | `data`                                 | `path`               | Rendering                                      |
| ---------- | -------------------------------------- | -------------------- | ---------------------------------------------- |
| `image`    | `data:<image mime>;base64,<payload>`   | workspace image file | Theia image block                              |
| `svg`      | `data:image/svg+xml;base64,<payload>`  | workspace SVG file   | Theia image block                              |
| `html`     | inline HTML or `data:text/html;base64` | not read             | Theia HTML app block with the caption as title |
| `markdown` | inline markdown                        | not read             | Text block                                     |

Persistence rules:

- Data URIs are decoded byte-for-byte and written as `preview.png`, `preview.jpeg`, `preview.webp`, `preview.svg`, or
  `preview.html`. Unsupported mime types are rejected with a text note and no preview file.
- An in-workspace `path` is referenced, never copied. The path must be absolute, inside the workspace, and free of
  symlinked components. Chat rendering applies the same check before reading a path preview.
- Inline non-data text is persisted only for `markdown`, as `preview.txt`. Other inline formats are not guessed.
- HTML previews that need a file should be encoded as a `text/html` data URI.

## Size and lifetime limits

- Persisted previews are capped at 8 MiB. A larger preview is not written; the bundle keeps a warning. The chat renders an
  inline preview up to 4 MiB and falls back to text above that cap.
- Path previews read for the chat are capped at 4 MiB. Inline image, SVG, and HTML previews share the 4 MiB cap. A
  failed or oversized preview becomes a text link with the path and a warning instead of an image block.
- The store keeps one bundle per capability invocation and does not prune. Delete `.nuke-ide/ai/previews` in the
  workspace to remove every recorded preview and trajectory. The IDE recreates the folder on the next capture.
- On dispose the bridge does not delete its session. Closing and reopening the IDE keeps the history.
- With no workspace open, captures stay in memory, no files are written, and the store logs once that persistence is
  disabled. The preview still renders in the chat.

## Trajectory schema

`trajectory.jsonl` is append-only; concurrent captures are serialized per session so lines never interleave. Each line
is one JSON object:

```json
{
  "timestamp": "2026-10-31T12:34:56.789Z",
  "capabilityId": "nuke.viz.captureView",
  "input": { "format": "png" },
  "ok": true,
  "bundleId": "bundle-001",
  "previewPath": "/workspace/.nuke-ide/ai/previews/20261031-123456-abc123/bundle-001/preview.png",
  "artifacts": ["/workspace/model.h5m"]
}
```

- `previewPath` is present only when a preview file exists or an in-workspace path was referenced.
- `artifacts` contains the target of every artifact (path, URI, or label).
- Input strings are capped at 200 characters. `Bearer ...` values, `apiKey` and `token` values, and similar
  credentials are replaced with `[redacted]` before the line is written. Preview data URIs and other inline data are
  removed from `result.json`.

A failed write is logged and the store returns `undefined`; it never fails the capability tool call. The chat uses the
original result, so a preview still renders even when its history entry could not be saved.
