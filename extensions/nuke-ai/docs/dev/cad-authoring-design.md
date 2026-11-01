# CAD Authoring Design (Gated)

## Status and gate

**Design only.** No CAD authoring capability is implemented, registered, or exposed. The shipped CAD surface stays
read/export-only until this design is approved and every item in the [security gate checklist](#security-gate-checklist)
is satisfied.

This page is the contract for a future implementation:

- It is not a commitment to ship.
- It does not authorize `.py`/build123d script editing, raw Python execution, sketch editing, or free-form JSON patches.
- Any implementation starts behind a default-off kill switch and must not be enabled for users until the roll-out gates
  are met.
- The security review is a hard gate, not a code-review formality.

The design intentionally reuses existing CAD services and the existing NukeAI preview/apply/undo pattern. It does not add
a second geometry kernel, a second build path, or a model-facing file API.

## Why CAD authoring is gated

| Risk                            | Why it is different from an OpenMC settings edit                                                                                                                                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arbitrary code execution        | A `build123d`/CadQuery `.py` model is Python. `geometry_service.py` executes it in a child process (120 s default timeout), but that isolation is resource control, not a security sandbox: the script can import libraries, read the filesystem, and write files the user can write. Any script-editing surface is a code-authoring surface. |
| Invalid geometry                | A syntactically valid document can build zero-volume, self-intersecting, non-manifold, or overlapping solids. The preview must fail or warn before the change reaches DAGMC/FEM export, because downstream physics silently consumes bad geometry.                                                                                            |
| Destructive overwrite           | Applying a change to a saved `.nuke-cad` file rewrites user work. The viewport's normal edit flow already saves dirty documents before a rebuild, so an in-memory-only apply would be persisted by the next rebuild anyway. Overwrite protection has to be explicit, not implied.                                                             |
| Stale previews                  | A preview is a snapshot. Between preview and apply the user can edit, undo, reload, switch documents, or change the file on disk. Applying a stale patch can silently discard newer work or produce a build that was never shown.                                                                                                             |
| Expensive builds                | A full document build can take minutes and produce large STEP/tessellation artifacts; the CAD backend's default process timeout is one hour. An unguarded preview loop is a denial-of-service surface for the IDE and the machine.                                                                                                            |
| Prompt injection via names/text | Body names, feature names, parameter names, material tags, build warnings, and import product names come from documents and external CAD files. They are untrusted data that the model reads and that UIs render. A malicious document can carry instructions, Markdown/HTML, control characters, or misleading labels.                       |
| Simulation impact               | `label`, `material`, selector maps, and body identity feed the region manifest and DAGMC export. A geometry edit that changes solid identity or region coverage can invalidate a coupled OpenMC model even when the shape still builds.                                                                                                       |

The current CAD AI surface is deliberately read/export-only:

| Capability                   | Risk      | Effect                                                                |
| ---------------------------- | --------- | --------------------------------------------------------------------- |
| `nuke.cad.summarizeDocument` | `read`    | Build counts, selection, manifest, optional per-solid summaries       |
| `nuke.cad.inspectSelection`  | `read`    | Selected solids and hidden ids                                        |
| `nuke.cad.diagnoseModel`     | `read`    | Build, manifest, selection, and per-solid findings without rebuilding |
| `nuke.cad.exportDagmc`       | `execute` | Builds a source and writes STEP, DAGMC, manifest, and cache artifacts |

`nuke.cad.diagnoseModel` already gives the model a bounded way to inspect a model. Nothing in the current surface mutates
`CadDocumentStore`, and external MCP never exposes write/execute CAD tools.

## Current surface and what must change

| Layer                                                                                             | Today                                                                                                                                                                                                                                                 | Required for authoring                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability registration (`extensions/nuke-cad/src/browser/capabilities/nuke-cad-capabilities.ts`) | Four read/export capabilities; no document store injected                                                                                                                                                                                             | Add preview/apply/undo contributions; inject `CadDocumentStore`, `NukeUndoService`, a CAD proposal service, and the kill-switch preference                                                                       |
| Document state (`CadDocumentStore`)                                                               | Framework-free in-memory authority; immutable snapshots; depth-100 snapshot undo/redo; one history entry per committed mutation; `documentEpoch` on install; `loadDocument` resets history                                                            | Add a revision/identity accessor, a single-transaction patch API (one history entry for a multi-operation patch), a guarded restore-by-transaction API, and the revision that the active build was produced from |
| Build orchestration (`NukeCadFrontendService` → `NukeCadBackendService`)                          | `buildDocument` → `geometry_service.py --from-document`; display builds skip DAGMC/mesh; the backend defaults to a one-hour process timeout and has `cancelJob` for tracked jobs, but `buildDocument` does not expose a timeout or cancellation input | Add a bounded preview build seam: explicit job id, timeout, abort/cancel, private output directory, cleanup guarantee; record the built document revision on the installed model                                 |
| Proposal/undo pattern                                                                             | OpenMC has a scoped in-memory proposal store (20 entries, 10-minute TTL, deep-cloned snapshots) and session-scoped `NukeUndoService` tokens. nuke-cad has neither                                                                                     | Add a CAD-owned proposal store with the same invariants; register reverse handlers with `NukeUndoService`                                                                                                        |
| NukeAI bridge                                                                                     | Generic `NukeCapability` → tool conversion; `changeSet` cards; apply requires `write`/`execute`; undo redeems the service token                                                                                                                       | No new tool-conversion code required; the capability IDs, `changeSet`, and `undoToken` follow the existing contract. A kill-switch context signal may be added so the catalog refreshes                          |
| MCP                                                                                               | Explicit read-only allowlist                                                                                                                                                                                                                          | CAD authoring IDs must never be added; add a regression test                                                                                                                                                     |

The CAD build service is the only build path. The design does not add an evaluator, a second feature builder, or a
model-reachable file writer. `geometry_service.py` continues to own document builds, STEP/tessellation output, and feature
validation.

## Recommended first editable surface

**Recommendation: structured feature properties for the extrude/dress-up family, limited to a starter allowlist of
scalar numbers. Document parameters are the second surface, not the first.**

Why feature properties first:

- A feature's `params` are consumed directly by the build on every rebuild. Changing `pad.length` or `fillet.radius` has a
  deterministic geometric effect; no client-side step is needed to make the value live.
- The change is a single scalar at a stable feature id. There are no sketch primitives, solver state, topology references,
  boolean targets, or array indices in the first slice.
- `CadDocumentStore.updateFeatureParams` already performs a shallow merge and a schema validation commit. The missing
  piece is a transaction wrapper for a multi-operation patch, not a new geometry authoring model.
- The existing preview card, `changeSet`, and undo token already fit the OpenMC safe-edit pattern.

Why document parameters are not first, despite the lower-looking schema risk:

- Today `CadDocumentStore.setParameter` only updates `doc.parameters`. Sketches are solved client-side by
  `sketch-solver.ts`, and `sketch_builder.py` explicitly never re-solves: it builds from the stored solved primitives.
  Parametric curves store dense samples, and `setParameter` does not resample them.
- A parameter patch would therefore be a no-op for most geometry unless the same transaction also reloads every dependent
  sketch into the planegcs solver, solves it, writes back the solved primitives and `dimension.value`, and resamples every
  dependent curve. That is a solver transaction, a materially larger and riskier change than a feature-scalar patch.
- Parameters become a good second surface once that solver/resample transaction is designed and tested. The patch schema
  and preview pipeline can be reused; only the applier and validation checks differ.

Starter allowlist (first implementation):

| Feature type | Allowed key | Condition                           | Why it is safe                                                                             |
| ------------ | ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pad`        | `length`    | `end` absent or `blind`             | Positive extrusion distance; topology changes only if the build itself fails or intersects |
| `pocket`     | `length`    | `end` absent or `blind`             | Positive cut depth; same build validation as a manual edit                                 |
| `revolve`    | `angle`     | `end` absent or `blind`             | Finite angle in `(0, 360]`; no sketch or reference change                                  |
| `groove`     | `angle`     | `end` absent or `blind`             | Same as revolve                                                                            |
| `fillet`     | `radius`    | Existing feature, non-empty `edges` | Positive scalar; a too-large radius fails the build and is rejected by preview             |
| `shell`      | `thickness` | Existing feature, non-empty `faces` | Positive scalar; build failure is caught before apply                                      |

Deliberately outside the first allowlist: pattern/mirror/lattice counts and spacing (topology and cell-count changes),
hole depth/diameter (face references and drilling modes), chamfer modes (`distances`/`angle`), primitive `dimensions`
arrays (index-addressed), `translate` vectors (array paths), booleans and consumed bodies, imports, sketches, datums,
assemblies, drawings, suppression, reorder, add, and delete.

The allowlist is a static table in the capability module, not something the model can extend. A feature type or key
missing from the table is rejected before any build.

## Candidate capability surface

| Capability                       | Risk           | Confirmation                       | Undo                                        | Inputs                                  | Outputs                                                                                                                                                            |
| -------------------------------- | -------------- | ---------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nuke.cad.previewDocumentChange` | `read`         | No                                 | No                                          | Active-document patch only: `{ patch }` | `{ proposalId?, documentPath, documentEpoch, baseRevision, candidateRevision, valid, changes, build, metrics, issues, limitations }` plus a `changeSet` when valid |
| `nuke.cad.applyDocumentChange`   | `execute`      | Yes (`requiresConfirmation: true`) | Yes (`undoable: true`, returns `undoToken`) | `{ proposalId }` only                   | `{ proposalId, documentPath, revision, backupPath, buildScheduled, changes }`                                                                                      |
| `nuke.cad.undoDocumentChange`    | `write`        | Yes                                | No (redeems the token)                      | `{ undoToken }` only                    | `{ documentPath, revision, restored }`                                                                                                                             |
| `nuke.cad.previewScriptChange`   | Not registered | —                                  | —                                           | —                                       | Excluded from this gate; see below                                                                                                                                 |

Notes:

- Preview and apply declare `when` requiring the kill switch on and an active `.nuke-cad` document. Undo checks the token
  in `invoke` and remains callable while the kill switch is off, so an applied change can always be reversed.
- Preview is `read` because it never mutates the user's document or writes user-visible artifacts. It still runs the
  geometry backend, so it must have the timeout, cancellation, concurrency, and rate limits described below. If those
  controls are not implemented, preview must be reclassified as `execute` before implementation.
- Apply is `execute`, matching the card's existing apply path (`write`/`execute` only). It overwrites the active
  `.nuke-cad` file, so the confirmation text must name the file and the backup, and the result must report both. If
  reviewers require a `destructive` risk, the card's apply path must be widened first; that is a separate NukeAI change,
  not part of this design.
- Apply never accepts a patch. It accepts only a proposal id, so an "always allow" confirmation cannot invent or widen a
  change; it can only apply a previously previewed, still-fresh proposal.
- Undo is a thin wrapper over the same session-scoped `NukeUndoService` token the NukeAI card already uses. The card's
  Undo button keeps redeeming the service token directly; the capability exists for typed in-process consumers and for
  symmetry. Both paths are single-use.
- `nuke.cad.previewScriptChange` is intentionally absent. A later, separately reviewed design may add a **read-only
  textual diff** for a `.py` segment, but it must not execute or write the script. Apply for scripts is a code-execution
  gate of its own and is not covered by this page.

### Example preview input

```json
{
  "patch": {
    "schemaVersion": 1,
    "summary": "Increase the fuel pellet height",
    "operations": [{ "op": "setFeatureParam", "featureId": "fuel", "key": "length", "value": 1.2 }]
  }
}
```

### Example preview result

```json
{
  "proposalId": "6f1c7a64-6f6f-4d8d-9d2e-9b9f4f3d2a10",
  "documentPath": "/workspace/models/pincell.nuke-cad",
  "documentEpoch": 12,
  "baseRevision": "sha256:1f0c...",
  "candidateRevision": "sha256:8a31...",
  "valid": true,
  "changes": [
    {
      "path": "features.fuel.params.length",
      "label": "fuel length",
      "kind": "update",
      "before": 1,
      "after": 1.2
    }
  ],
  "build": { "success": true, "solidCount": 3, "faceCount": 48, "triangleCount": 12040, "durationMs": 8421 },
  "metrics": {
    "before": { "solidCount": 3, "faceCount": 48, "volume": 5.12, "boundingBox": { "min": [0, 0, 0], "max": [1.26, 1.26, 1] } },
    "after": { "solidCount": 3, "faceCount": 48, "volume": 5.74, "boundingBox": { "min": [0, 0, 0], "max": [1.26, 1.26, 1.2] } },
    "delta": { "volume": 0.62 }
  },
  "issues": [],
  "limitations": ["Display build only: no DAGMC or FEM mesh is produced."]
}
```

### Example applied result

```json
{
  "proposalId": "6f1c7a64-6f6f-4d8d-9d2e-9b9f4f3d2a10",
  "documentPath": "/workspace/models/pincell.nuke-cad",
  "revision": "sha256:8a31...",
  "backupPath": "/workspace/.nuke-ide/ai/backups/cad/3f9a/2026-11-01T120000Z-1f0c.nuke-cad",
  "buildScheduled": true,
  "changes": [
    {
      "path": "features.fuel.params.length",
      "label": "fuel length",
      "kind": "update",
      "before": 1,
      "after": 1.2
    }
  ]
}
```

Deliberately excluded from the entire surface:

- No document path, output directory, file name, or output-format input. The target is always the active document.
- No raw JSON Patch (`add`/`remove`/`replace`/`move`/`copy`/`test` at arbitrary pointers).
- No script text, Python expression, shell command, import URL, or code snippet.
- No feature add/remove/reorder/suppress, body add/remove/rename, sketch/datum/topology edit, boolean target change, import
  source change, assembly/drawing edit, or unit change.
- No bulk/multi-document apply, no background/automatic apply, and no MCP write exposure.
- No preview image in the first slice. The preview is the structured diff plus build metrics; a ghosted 3D preview is a
  separate rendering feature and must not be implied by the card.

## Change representation and schema validation

The patch is a small, versioned object:

```ts
interface CadAuthoringPatchV1 {
  readonly schemaVersion: 1;
  readonly summary?: string;
  readonly operations: readonly CadSetFeatureParamOperation[];
}

interface CadSetFeatureParamOperation {
  readonly op: 'setFeatureParam';
  readonly featureId: string;
  readonly key: string;
  readonly value: number;
}
```

Validation is pure and runs before any file or build work:

1. **Shape** — object, `schemaVersion === 1`, at most 32 operations, serialized patch ≤ 64 KiB, `summary` trimmed to 200
   characters, `additionalProperties: false` at every level.
2. **Operation** — only `setFeatureParam`; unknown operations are rejected with the operation index.
3. **Feature id** — must exist exactly once in `document.features`; ids are opaque strings, never paths. No creation of
   ids, no implicit features.
4. **Allowlist** — `(feature.type, key)` must be in the static table, and the key must already exist on that feature (the
   patch never creates a parameter). The feature's current mode must satisfy the condition (`end` absent/`blind` for
   extrude-family keys). A key that is valid for another feature type is rejected.
5. **Value** — finite number, not `NaN`/`Infinity`, within the feature type's documented bounds (for example angle in
   `(0, 360]`, length/thickness/radius `> 0`). No strings, arrays, objects, booleans, or `null`.
6. **No path-shaped keys** — `sketchId`, `body`, `dependsOn`, `suppressed`, `source`, `targetBody`, `toolBodies`,
   `upToFace`, `upToBody`, `edges`, `faces`, `dimensions`, `vector`, and every other structural key are not in the
   allowlist.
7. **No duplicate targets** — at most one operation per `(featureId, key)`. Operations apply in order to a clone; the
   final value must differ from the current value (a no-op patch is rejected rather than silently accepted).
8. **Document validation** — after applying every operation to a deep clone, run `validateNukeCadDocument`. Any issue
   rejects the whole patch; there is no partial application.
9. **Revision** — compute the candidate's canonical SHA-256 and require it to differ from `baseRevision` only by the
   intended changes (the diff is derived from the operations, not by diffing arbitrary JSON).

Path format is identifier-based, never index-based: `features.<featureId>.params.<key>`. Feature ids, not display names,
select targets. Display names are untrusted labels and are only shown, escaped, in the diff.

Name and text handling:

- Feature/body names and the model-supplied `summary` are untrusted display text. Cap them, strip control characters,
  render them as text (React escapes by default), and never interpolate them into a tool name, capability id, file path,
  prompt instruction, or Markdown/HTML fragment.
- Object keys such as `__proto__`, `constructor`, or `prototype` are rejected even if a malformed document contains them as
  own keys. The applier uses own-property checks and a null-prototype working map, never dynamic property assignment on a
  normal object.
- No expression strings in the first slice. If the parameter surface later accepts expressions, they are evaluated by
  `expression.ts` (a whitelisted recursive-descent evaluator, not `eval`) against the document parameter scope, with a
  256-character limit, finite-result check, and no new identifiers or functions; the evaluated number is stored, never
  the expression text.

Ids and revisions:

- `baseRevision` = canonical SHA-256 of the validated in-memory document at preview time.
- `candidateRevision` = canonical SHA-256 of the fully patched, validated document.
- `documentEpoch` = `CadDocumentStore.documentEpoch`; a reload/open bumps it even when the content is identical.
- `proposalId` and `undoToken` are server-generated UUIDs. The model never supplies either.
- `revision` after apply is the hash of the exact document written to disk.

## Preview, build, and validation pipeline

The preview runs the existing CAD backend, not a new evaluator:

1. **Target resolution.** Use the active `CadDocumentStore` document only. Require a backing `.nuke-cad` URI inside a
   workspace root, a clean buffer (`dirty === false`), a readable file whose parsed canonical document hash equals
   `baseRevision`, and an active build whose recorded document revision equals `baseRevision`. Reject an unsaved
   sample/new document until the user saves it, and ask the user to rebuild a stale model before previewing. There is no
   model-supplied path.
2. **Patch validation.** Run the pure validator above against the current document. Reject unknown ids, keys, modes,
   duplicate targets, no-ops, size overflows, and prototype-shaped names.
3. **Candidate materialization.** Apply the operations to a detached clone with `cloneDocument`, revalidate, and compute
   `candidateRevision`.
4. **Transient document.** Write the candidate to a harness-named hidden sibling of the real document, for example
   `<docdir>/.nuke-ai-preview-<uuid>.nuke-cad`. A sibling is required because `import` and assembly part paths resolve
   against the document's directory; a file in the OS temp directory would silently break relative imports. Use exclusive
   create, never overwrite, and remove it in `finally`.
5. **Private output directory.** Build outputs go to `<workspace>/.nuke-ide/ai/cad-builds/<uuid>/`, not next to the user's
   file. Pass it as `outputDirectory`; the transient document is the only artifact beside the source and is deleted.
6. **Bounded build.** Call `NukeCadFrontendService.buildDocument` with `exportDagmc: false`, `exportMesh: false`,
   `useCache: false`, `tolerance: document.displayTolerance`, the private output directory, an explicit timeout, and an
   abort signal. No DAGMC or FEM mesh is produced; the cache sidecar is not written. The display build still writes STEP
   and tessellation files into the private output directory; they are deleted after metrics are read.
7. **Result mapping.** Read `success`, `error`, counts, `boundingBox`, `warnings`, `featureResults`, `referenceResults`,
   `selectorMap`, and the region manifest from the build result. Read per-solid properties from the tessellation only when
   the file is within the metrics cap.
8. **Checks.** Turn the result into issues (below). A valid preview stores a proposal and returns a `changeSet`; an invalid
   preview stores nothing and has no apply next action. The preview never installs the candidate model in the viewport or
   `NukeCadStateManager`; the user's screen keeps the current model until apply commits and the normal rebuild finishes.
9. **Cleanup.** Delete the transient document, any sidecar sharing its stem in the source directory, the private output
   directory, and any partial artifacts in `finally`. A startup sweep removes stale `.nuke-ai-preview-*` files and files
   sharing that stem older than one hour; the sweep only matches the harness prefix.

Time and size limits (constants, not user preferences):

| Limit                     | Value                                                                                                 | Reason                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Patch size / operations   | 64 KiB / 32                                                                                           | Bounded tool input; a CAD edit is not a batch migration       |
| Expression length         | 256 chars (only if expressions are enabled later)                                                     | Prevent parser/stack abuse                                    |
| Candidate document        | 16 MiB serialized, 5,000 features, 2,000 parameters                                                   | Bounded validation and temp-file write                        |
| Preview build             | 120 s deadline; kill the process tree at the deadline; 180 s absolute cap including startup/cleanup   | The backend default is one hour; previews must not inherit it |
| Concurrent previews       | 1 per document/workspace                                                                              | Avoid multiplying an expensive build                          |
| Preview rate              | 6 per minute per session                                                                              | Bound an unguarded `read` capability loop                     |
| Tessellation metrics read | 64 MiB, 5,000 solids; aggregate metrics over all parsed solids, per-solid rows only for the first 500 | Avoid parsing a huge model just to format a card              |
| Proposals                 | 20 stored, 10-minute TTL, deep-cloned                                                                 | Mirrors the OpenMC proposal store                             |
| Backups                   | 10 per document, 50 MiB total, 30-day age cap                                                         | Recovery without unbounded disk growth                        |

The timeout/cancellation seam is a hard prerequisite. `NukeCadBackendServiceImpl.buildDocument` currently has no timeout
parameter and does not expose the internal job id before completion, so a preview cannot cancel or bound a build today.
Implementation must add an explicit preview method (or request fields) that passes `timeoutSeconds` and a job id or abort
signal to `_spawnJsonService`, and kills the process tree on timeout/abort.

Validation checks:

| Check                                                | Severity | Behavior                                                                |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `validateNukeCadDocument` issues                     | error    | Reject before build                                                     |
| Build `success === false`                            | error    | No proposal                                                             |
| Any `featureResults[].status === 'failed'`           | error    | No proposal; list feature ids                                           |
| Any `referenceResults[].status === 'unmatched'`      | error    | No proposal                                                             |
| Any `referenceResults[].status === 'ambiguous'`      | warning  | Allow with a warning                                                    |
| `solidCount === 0`                                   | error    | No proposal                                                             |
| Solid count changed by the patch                     | error    | First slice is topology-preserving; block and ask for a separate design |
| Body or selector coverage changed                    | error    | Prevent silent region-map changes                                       |
| Non-finite bounding box or non-positive solid volume | error    | Reject invalid geometry                                                 |
| Cross-body/build overlap warnings                    | warning  | Surface after sanitization; apply remains possible after confirmation   |
| Volume/bbox delta above the informational threshold  | warning  | Show the percentage; do not block a legitimate scalar edit              |
| Metrics unavailable (tessellation over cap)          | info     | Say so in `limitations`; do not guess                                   |
| Build timeout / cancellation                         | error    | No proposal; no retry                                                   |

Mass properties come from the build's tessellation `properties` block (volume, area, bounding box, center of mass) when it
is within the read cap. `before` comes from the active build installed for `baseRevision`; `after` comes from the
candidate build. The preview reports `before`, `after`, and `delta` for solid count, face count, triangles, volume, and
bounding box. It does not return the tessellation itself.

On build failure: no proposal id, no apply next action, no file write, no store change, and no partial artifact. The
transient files are deleted, and the result reports the build error plus per-feature findings so the user can ask for a
different change. On a clean build, the candidate is stored with its `before`/`after` snapshots and revisions; only then
does the result advertise `nuke.cad.applyDocumentChange`.

Apply is all-or-nothing:

1. Re-check the kill switch, proposal id/scope/TTL, `documentEpoch`, clean buffer, file hash, and `baseRevision`.
2. Re-apply the stored operations to the current document (not the stored `after` blob) and require the result to hash to
   `candidateRevision`. Any difference is a stale preview; discard the proposal and ask for a fresh preview.
3. Validate the candidate again and run the file-write and store-commit steps in the order below.
4. Write the candidate atomically: temp file in the same directory, flush, rename over the original. Keep a backup of the
   previous bytes in `<workspace>/.nuke-ide/ai/backups/cad/...` before the rename. Do not follow symlinks out of the
   workspace.
5. Commit the candidate to `CadDocumentStore` as **one** history entry and mark it saved, so the store-change rebuild reads
   the file that was just written instead of auto-saving a second time.
6. If the file write fails, change nothing. If the store commit fails after the write, restore the backup and change
   nothing. The operation never leaves the file and the store disagreeing.

No partial apply is possible: a multi-operation patch is validated and materialized as one candidate, the file replace is
atomic, and the store gets one transaction. There is no loop of `updateFeatureParams` calls that could half-succeed.

### Path scoping and backups

| Target        | First-slice rule                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document      | Active `.nuke-cad` only; no model-supplied path; must be workspace-contained, a regular file (no symlink escape), and match the previewed revision. Backup the previous bytes under `<workspace>/.nuke-ide/ai/backups/cad/`, then replace via a same-directory temp file + rename. Retain at most 10 backups / 50 MiB / 30 days per document. |
| Script        | No write path. `.py`/build123d editing is out of scope; a future script surface needs its own code-execution review, backup, atomic write, and explicit confirmation.                                                                                                                                                                         |
| Import source | Never patched. Existing `sourceHash`/`sourceSize` verification keeps stale STEP/IGES/BREP sources from building silently.                                                                                                                                                                                                                     |
| Internal temp | Harness-named hidden sibling for the candidate document (relative imports must resolve against the document directory), private output directory under `.nuke-ide/ai/cad-builds/`, exclusive create, `finally` cleanup, startup sweep.                                                                                                        |

The backup is a recovery aid, not an undo source: undo redeems the in-memory token and restores the recorded backup only
after verifying its hash. A user can also recover manually from the reported `backupPath` if the session ends.

## Confirmation and undo UX

The existing NukeAI tool card is the confirmation surface; no new CAD UI is introduced.

Preview card:

- Title and summary: "CAD feature change — increase the fuel pellet height".
- Diff rows: `features.fuel.params.length  1 → 1.2`, using the existing `changeSet` renderer.
- Validation badge: valid/invalid, solid/face/triangle counts, volume and bounding-box delta, overlap and reference
  warnings, and a short "Not produced: DAGMC/FEM mesh" limitation line.
- Actions: **Apply with NukeAI** only when the preview is valid; otherwise no apply action. The existing card never invokes
  a write capability directly; it opens a NukeAI prompt and the normal tool confirmation stays in charge.
- The proposal id is shown only as an opaque reference, not as an editable field.

Apply confirmation:

- The confirmation names the absolute document path and says that the file will be rewritten, that a backup is kept, and
  that a rebuild will be scheduled.
- The user must confirm the write/execute tool call. An always-allow confirmation cannot widen the change because apply
  accepts only a proposal id.
- The result card shows the applied revision, the backup path, and an **Undo** action. If the rebuild was scheduled but has
  not finished, the card says so; it never claims the new geometry is already on screen.

Undo:

- The card asks for explicit confirmation before redeeming the token (the existing warning dialog).
- The undo entry restores the file and the store as one unit and marks the document clean; it must not emit a store change
  that lets the rebuild read the still-applied file. Validate the restore first, write the backup to the file atomically,
  then restore the store transaction and emit.
- The entry is one-shot and session-scoped. `NukeUndoService` removes it only after `ok: true`.
- Before restoring, compare the current revision and transaction id with the applied values. If the user edited, undid, or
  reloaded after apply, undo fails with "The document changed after this edit; undo is not available" and leaves both the
  file and the store untouched. The backup path is reported for manual recovery.
- If the backup is missing or does not hash to the recorded value, undo fails safely. The edit journal remains an audit
  trail, not an undo source.

Stale and reload behavior:

- Preview records `documentEpoch`, `baseRevision`, the on-disk canonical hash, and the proposal creation time. Apply
  re-checks all of them and re-materializes the candidate. A mismatch discards the proposal.
- Switching documents bumps the epoch; the old proposal cannot be applied. Reloading resets store history and invalidates
  every in-memory undo token.
- Applying writes the file, so a reload after apply loads the applied document; the change persists, but the undo token
  does not survive the reload. This is the same session-scoped undo contract as OpenMC edits.
- A failed post-apply rebuild does not roll the document back automatically. The file and store contain the confirmed
  change, the viewport shows its normal build error, and Undo is the recovery path. The result suggests
  `nuke.cad.diagnoseModel`.

Kill switch:

- `nukeCad.aiAuthoringEnabled` is a user-level boolean preference, default `false`.
- `when` hides preview/apply from the tool catalog while it is false, and `invoke` re-checks it so a stale tool cannot run.
- Toggling it off cancels in-flight previews (abort signal/process kill), clears pending proposals, and prevents new
  previews/applies. Existing undo tokens remain redeemable so an already-applied change can still be reversed.
- The preference change must notify the capability context/bridge so the tool list refreshes; a passive `when` check alone
  is not enough.
- External MCP never allowlists these ids. Disabling or excluding `nuke-ai` leaves the capabilities inert behind the
  default-off switch.

## Security model

### Threat table

| #   | Threat                                 | Attack or failure path                                                                                                                                   | Impact                                                       | Required mitigation                                                                                                                                                                                                                                                          |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Arbitrary code execution               | Model-authored `.py`, Python expression, `eval`, shell, dynamic import, or a script path passed through a patch                                          | Full user-level code execution in the backend                | No script capability in this design; the only future expression path would use `expression.ts` with a fixed identifier/function set; no `eval`/`Function`/dynamic import; no model-supplied interpreter args or paths                                                        |
| 2   | Path escape / symlink                  | A patch or proposal makes the capability write, read, back up, or build outside the workspace                                                            | Write/read outside the project, credential exposure          | First slice accepts no paths at all; target is the active store document; internal temp/backup/output paths are harness-generated, absolute, canonicalized, checked with `isWithinWorkspace`, and `lstat`-checked to reject symlinks; write via same-directory temp + rename |
| 3   | Destructive overwrite                  | Apply rewrites a saved `.nuke-cad`; the file changed on disk or the backup is missing                                                                    | Loss of user work                                            | Apply requires a clean buffer, a matching base revision, and an atomic backup before the rename; the confirmation names the file; undo restores the backup; the operation is one transaction; no retry                                                                       |
| 4   | Stale preview / TOCTOU                 | User edits, undoes, reloads, switches documents, or changes the file between preview and apply                                                           | Applying a change that was never previewed                   | Proposal scope + 10-minute TTL + `documentEpoch` + `baseRevision` + on-disk hash + candidate re-materialization; any mismatch rejects and discards; undo checks the applied revision/transaction id                                                                          |
| 5   | Untrusted names/text                   | Feature/body names, labels, material tags, warnings, or import product names contain instructions, Markdown/HTML, control characters, or misleading text | Prompt injection, UI/log injection, misleading confirmations | Treat as data; cap and strip control characters; render as text; never build ids/paths/prompts from them; static capability descriptions; the NukeAI prompt must state that CAD document content is untrusted                                                                |
| 6   | Prompt injection via document content  | A malicious document tells the model to apply, export, or ignore confirmation                                                                            | Unauthorized edits or exports                                | Confirmation is a UI/tool-layer control, not a prompt instruction; apply accepts only a fresh proposal id; the model cannot skip preview; the system prompt and tool descriptions are static and reviewed                                                                    |
| 7   | DoS via expensive builds               | Repeated previews, a huge document, pathological geometry, or many operations                                                                            | IDE and machine exhaustion                                   | 120 s build deadline + process-tree kill; one concurrent preview; 6/min rate; patch/document/size caps; proposal cap/TTL; no auto-retry; no background previews                                                                                                              |
| 8   | Prototype pollution / schema confusion | `__proto__`/`constructor` keys, duplicate keys, deep nesting, unknown fields, array where a scalar is expected                                           | Validator bypass or state corruption                         | Strict `additionalProperties: false`, own-property checks, null-prototype maps, reject reserved keys, depth/size caps, semantic validation in the handler                                                                                                                    |
| 9   | Cross-scope or replay                  | An OpenMC proposal id is passed to CAD apply, or a proposal/token is replayed                                                                            | Wrong-domain mutation or double apply                        | Proposal scope `cad-document`; apply/undo accept only ids/tokens from their own store; tokens are one-shot; proposals are removed after apply or on staleness                                                                                                                |
| 10  | Concurrent apply/race                  | Two applies, apply while a rebuild is in flight, or apply during a document switch                                                                       | Interleaved writes or a build against the wrong file         | One in-flight apply per document; revision/epoch re-check immediately before write; store transaction is synchronous; a document switch invalidates the proposal                                                                                                             |
| 11  | Privacy/log leakage                    | Parameter values, feature names, document paths, or before/after values land in metrics/journals                                                         | Sensitive model data in local logs                           | Reuse the existing journal rules: capability id, outcome, counts, durations, hashed tokens; no names, values, paths, or before/after payloads                                                                                                                                |
| 12  | Simulation-invalid geometry            | The build succeeds but solid identity, labels, or selector coverage changed                                                                              | Wrong region/material mapping downstream                     | Block solid-count/body/selector changes in the first slice; surface overlap and manifest warnings; keep DAGMC/FEM export out of preview                                                                                                                                      |

### Required mitigations before implementation

- A bounded, cancellable preview build seam in the CAD backend (timeout, job id, process-tree kill) and an abort path from
  the capability context.
- A pure patch validator/applier with no `eval`, no dynamic property assignment, and a static allowlist.
- Active-document-only targeting with no model-supplied paths; harness-generated temp/backup paths with realpath and
  symlink checks.
- Atomic write + backup + restore helpers; a store transaction API that commits and restores exactly one history entry
  without exposing an intermediate state to the rebuild scheduler.
- A CAD proposal store with scope, TTL, capacity, deep clones, and revision binding.
- The kill switch wired into `when`, `invoke`, and the capability-context refresh path.
- Static NukeAI prompt/tool descriptions that treat all CAD document text as untrusted data.
- No MCP allowlist entry and a regression test proving the authoring ids never register externally.
- Security tests for every row in the threat table before any user-facing enablement.

### Explicitly not solved by this design

- Sandboxing arbitrary Python. The `.py` build path remains an execution surface for user-authored scripts; this design
  does not make it safe to let a model write those scripts.
- Multi-user concurrent editing, merge, or conflict resolution.
- A malicious CAD kernel/OCP or a malicious imported STEP file. The design bounds the build and treats imported data as
  untrusted, but does not replace the geometry kernel's own security posture.
- Supply-chain or model-provider trust. The model is not trusted to enforce confirmation; the UI/tool layer is.

## Model context budget and projection

The model never receives the full document, geometry, or script. Context is built from bounded projections:

| Projection                        | Budget                  | Contents                                                                                                                                  |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Document summary                  | ≤ 4 KiB                 | Name, units, `documentEpoch`, revision, dirty flag, body/sketch/feature/curve/parameter counts, build success/counts, at most 10 warnings |
| Parameter table (optional, later) | ≤ 50 rows               | Name + finite value only; `truncated: true` beyond the cap; no expressions or solver state                                                |
| Feature projection (later)        | ≤ 50 features           | Id, name, type, body id, suppression, and allowlisted scalar params only; no topology refs, arrays, or nested objects                     |
| Selection projection              | Current selection only  | `nuke.cad.inspectSelection` output plus per-solid volume/area/bbox for the selected solid(s)                                              |
| Preview diff                      | ≤ 32 changes            | `path`, display label, before/after scalar, issue list, metrics summary                                                                   |
| Build issues                      | ≤ 20, truncation marker | Severity, code, short message; sanitized                                                                                                  |

Never sent to the model:

- The serialized `NukeCadDocument`, full parameter table, sketch primitives/constraints, curve samples, selector map, or
  region manifest.
- Tessellation data, STEP/DAGMC/FEM bytes, file contents, backup contents, or absolute internal temp paths.
- `.py` script text, Python tracebacks beyond a short sanitized message, or environment details.
- Raw tool output beyond the existing 8 KiB per string and 32 KiB per JSON payload caps in `nuke-tool-result.ts`.

Projection rules:

- Prefer ids over names for matching; names are display-only untrusted text.
- Cap every array before JSON serialization, not after, so the tool result never constructs a huge payload.
- Summarize geometry as scalar counts and deltas; do not attempt to describe topology in prose.
- `#nukeContext` continues to carry only the active document path. It must not gain document content.
- The NukeAI prompt must say that document names, labels, warnings, and preview text are data, never instructions, and that
  the model must not ask the user to bypass confirmation.

## Test strategy

| Layer                                                          | Tests                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure patch validation (`src/common`, vitest, no Theia/backend) | Allowed ops/keys; unknown op/feature/key/mode; duplicate targets; no-op; non-finite values; bounds; patch/document size caps; reserved prototype keys; strict `additionalProperties`; path format; canonical revision stability                                                                                                                                                                  |
| Proposal store                                                 | TTL expiry, 20-entry eviction, deep-clone isolation, scope rejection, revision/epoch binding, removal after apply, replay rejection                                                                                                                                                                                                                                                              |
| Capability wiring (fake registry/store/service/undo)           | IDs, risk, `requiresConfirmation`, `undoable`, `when` kill switch, `changeSet.applyCapability`, result shapes, no apply action for invalid previews, no mutation on preview                                                                                                                                                                                                                      |
| Store transaction (in-memory)                                  | One undo entry for a multi-op patch; dirty/clean transitions; revision changes; transaction-id restore; stale restore rejection; load/create resets history; reload invalidates tokens                                                                                                                                                                                                           |
| Preview pipeline (fake build + fake file service)              | Temp sibling naming, private output directory, `exportDagmc/exportMesh/useCache` flags, timeout/abort, cleanup in `finally` and on throw, no proposal on failure, metrics mapping, size-cap fallbacks                                                                                                                                                                                            |
| Real build end-to-end (env-gated)                              | Committed small fixture (pincell or a dedicated primitive/pad fixture) → preview → apply → undo with the real `geometry_service.py`; assert volume changes, solid count/selector coverage unchanged, the file is written atomically, the backup restores byte-for-byte, and a reload sees the persisted change. Skip cleanly without `NUKE_TEST_PYTHON`; keep the e2e marker/profile conventions |
| Failure paths                                                  | Build failure, timeout, missing Python, zero solids, failed feature, unmatched reference, solid-count change, body/selector change, non-positive volume, stale proposal, expired proposal, wrong scope, kill switch off, concurrent apply, missing/corrupt backup                                                                                                                                |
| Security                                                       | Path/symlink probes, prototype pollution, deeply nested/oversized JSON, expression bombs (`2^100000`), control/injection characters in names and summary, proposal/token replay, MCP allowlist absence                                                                                                                                                                                           |
| UI/card                                                        | Existing renderer tests for diff rows, valid/invalid badges, Apply only when valid, Undo confirmation and stale-undo message; no new Cad UI tests required beyond the card                                                                                                                                                                                                                       |

Tests must not boot Theia or call an LLM. The real-build test uses the existing CAD e2e fixtures and environment gates; the
minimal profile skips it cleanly. Pure logic is covered by vitest and should keep the measured logic-layer ratchet honest.

## Rollout gates and kill switch

| Gate       | Entry criteria                                                   | Exit criteria                                                                                            |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Design     | This page reviewed; threat table and checklist accepted          | Explicit approval to implement                                                                           |
| Internal   | Flag off by default; unit/fake/e2e tests green; no user exposure | Maintainer dogfood with a small set of documents; no security findings                                   |
| Opt-in     | Documented as experimental; kill switch visible; metrics on      | Two weeks without high/medium findings; undo success > 95%; p95 preview < 30 s on the reference fixtures |
| Default on | Only the feature-property allowlist; backups and undo proven     | Security review sign-off; rollback drill passes                                                          |

Rollback and kill switch:

- `nukeCad.aiAuthoringEnabled = false` immediately hides/cancels previews and blocks new applies; undo remains available.
- No `.nuke-cad` schema change is introduced by the first slice, so disabling authoring requires no migration or file
  rewrite.
- Proposals expire in 10 minutes and are in-memory only; restarting the IDE clears them.
- Backups are retained for manual recovery even after the kill switch is off; pruning is age/count based, never on disable.
- External MCP remains read-only regardless of the flag; the check is compile-time/test-enforced, not only runtime.

## Non-goals

- Implementing any part of the capability in this change.
- Editing or executing `.py`/build123d/CadQuery scripts, Python snippets, shell commands, or arbitrary expressions.
- Sketch geometry, constraints, datums, topology references, booleans, consumed bodies, imports, assemblies, drawings,
  appearance, materials, labels, units, suppression, reorder, add, or delete.
- Raw JSON Patch, arbitrary document pointers, array-index paths, or model-supplied file paths.
- A new geometry kernel, a new feature builder, or a second execution path.
- New CAD widgets, menus, or a 3D ghost preview in the first slice.
- Automatic, background, batch, multi-document, or cross-workspace apply.
- Persisting proposals or undo tokens across reload/restart.
- MCP write exposure, external-agent authoring, or a generic "run this CAD change" endpoint.
- Making arbitrary Python safe to model-author; that is a separate sandbox/code-execution problem.

## Related documentation

- [CAD AI capabilities](../../../nuke-cad/docs/dev/ai-capabilities.md) — the current read/export-only surface.
- [CAD document schema](../../../nuke-cad/docs/dev/document-schema.md) — store history, parameters, features, and imports.
- [CAD backend pipeline](../../../nuke-cad/docs/dev/backend-pipeline.md) — document builds, timeouts, tessellation, and artifacts.
- [CAD features and patterns](../../../nuke-cad/docs/dev/features-patterns.md) — feature parameters and build behavior.
- [CAD end-to-end testing](../../../nuke-cad/docs/dev/testing-e2e.md) — fixtures and environment gates.
- [Capability registry](../../../nuke-core/docs/dev/capability-registry.md) — risk, confirmation, `changeSet`, and undo.
- [Safe OpenMC edits](../user/safe-edits.md) — the preview/apply/undo pattern this design follows.
- [Agent and tool result cards](./agent-and-cards.md) — how the preview card and undo action are rendered.
- [Previews and trajectory](./preview.md) — truthful preview persistence; CAD authoring adds no image preview.
- [Local metrics and the edit journal](./metrics.md) — the privacy rules the authoring journal must follow.
- [External MCP](./mcp.md) — why CAD authoring is never exposed externally.
- [Adding a capability](./adding-a-capability.md) — the registration and schema conventions.

## Security gate checklist

Implementation must not start, and the capability must not be enabled, until every item is checked and signed off:

- [ ] The capability surface (ids, risks, confirmation, undo, no script capability) is approved.
- [ ] The first editable surface is the static feature-property allowlist; document parameters and every other surface are
      explicitly out of scope.
- [ ] The patch schema is frozen with `schemaVersion`, strict `additionalProperties`, operation/feature/key allowlists,
      finite-number bounds, no strings/arrays/nested values, and no duplicate targets.
- [ ] The validator/applier is pure, has no `eval`/`Function`/dynamic import, rejects reserved prototype keys, and has
      adversarial tests for oversized/deep/duplicate input.
- [ ] There is no model-supplied document, output, backup, script, or import path. The target is the active document only.
- [ ] Internal temp/backup/output paths are harness-generated, absolute, workspace-contained, realpath-checked, and
      symlink-rejected.
- [ ] Preview cannot inherit the one-hour backend timeout: an explicit timeout + process-tree kill + abort path exists and
      is tested (including a real hung build).
- [ ] Preview uses `exportDagmc: false`, `exportMesh: false`, `useCache: false`, a private output directory, one concurrent
      build, a preview rate limit, and cleanup in `finally` plus a stale-file sweep.
- [ ] The size/time limits in this design are constants, not user preferences, and are enforced before parsing/building.
- [ ] Preview requires an active build produced from `baseRevision`, records that revision, and rejects a stale or missing
      build instead of comparing against an old model.
- [ ] Apply requires a clean buffer, matching epoch/revision/on-disk hash, a valid unexpired proposal, and re-materializes
      the candidate; any mismatch rejects without writing.
- [ ] Apply writes atomically with a backup, commits exactly one store transaction, and restores the backup if the store
      commit fails. No partial file/store state is observable.
- [ ] Undo restores file and store as one unit, validates the transaction id/revision, is one-shot, is session-scoped, and
      fails safely when the document changed or the backup is missing.
- [ ] The kill switch is default-off, is checked in `when` and `invoke`, refreshes the tool catalog on change, cancels
      in-flight previews, and leaves undo available.
- [ ] Solid-count, body, and selector-coverage changes are blocked in the first slice; zero-volume/non-finite geometry is
      blocked; overlaps and reference ambiguity are surfaced as warnings.
- [ ] Untrusted names/labels/warnings/summary are bounded, sanitized, rendered as text, and documented as data; the NukeAI
      prompt/tool descriptions are updated and reviewed.
- [ ] The local metrics/journal record no names, values, paths, before/after payloads, or raw tokens; tokens are hashed.
- [ ] CAD authoring ids are absent from the external MCP read-only allowlist, and a regression test proves it.
- [ ] Unit, fake-backend, real-build e2e, failure-path, reload/undo, and security tests are green in the minimal and full
      profiles, and `yarn lint` / `npx lerna run build` pass.
- [ ] A security review has signed off on the threat table, with no open high or medium findings.
