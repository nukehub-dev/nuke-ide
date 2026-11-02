# Nuke CAD

## Purpose

Parametric CAD / meshing / FEM extension for NukeIDE with two authoring modes:
script-based build123d `.py` files (CadQuery is optional) and GUI-edited `.nuke-cad`
parametric documents. Both paths feed the same geometry-service pipeline and
produce identical simulation-ready artifacts (STEP, DAGMC, FEM meshes) consumed
by openmc-studio and future physics extensions.

## Ownership

All files under `extensions/nuke-cad/` except generated artifacts (`lib/`,
`node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript follows `extensions/AGENTS.md` (`src/browser/`, `src/node/`,
  `src/common/`); Python in `python/` is not pip-installed and spawns via
  `nuke-core` environment detection; CSS ships via `copy-css`. See `docs/dev/backend-pipeline.md`.
- `.nuke-cad` schema v3 lives in `src/common/cad-document.ts`
  (`validateNukeCadDocument` / `migrateNukeCadDocument` / `MIGRATIONS`); bodies
  carry labels to `selector_map`, booleans consume tool bodies, consumed targets go
  `stale`. See `docs/dev/document-schema.md`.
- `import` features (additive v3, no migration) turn a document-relative STEP/IGES/BREP
  snapshot into body geometry: lowercase SHA-256 `sourceHash` is the build/cache identity,
  `sourceSize` is advisory, `sourceUnit` overrides a lying header (`mm` header / metre
  numbers for W7-X), and `selection` + optional `placement` author the result.
  `addImportBodies` commits N bodies + N features once. See `docs/dev/document-schema.md`.
- The document store (`cad-document-store.ts`) holds validated immutable state,
  dirty/selection/feature results, sketch-param merging, dependent-guarded deletes,
  and depth-100 snapshot undo/redo; Export Python (`python-codegen.ts`) is a lossy
  one-way starter that now emits runnable imports, assembly placement helpers, and a
  final `model`. See `docs/dev/document-schema.md`.
- Example projects (`src/common/sample-projects.ts` + generated JSON) clone complete
  documents into a dirty unsaved store via `CadDocumentStore.createSampleDocument`;
  the full W7-X entry downloads (or takes a local) MIT-licensed STEP and stores it
  in `<document>.parts/` (never bundled). See `docs/user/gui-modeler.md` and `samples/README.md`.
- The W7-X generator (`src/common/w7x-generator.ts` + `samples/w7x/w7x_geometry.json`)
  plans 10 coil + 5 shell imported bodies and 55 assembly instances; it is valid-only at
  the validated five modules, and the committed asset is metadata, never the 47 MB STEP.
  Validation is index + face count + volume; STEP product names are advisory (OCCT can
  report the root product name for every solid).
- The experimental coil study (`src/common/w7x-study.ts` + `samples/w7x/w7x_study.json`)
  reuses those bodies at 4/5/6 modules (45/55/65 instances) and marks documents with
  `designStudy`; display builds work, DAGMC/FEM export is rejected, and its banner is permanent.
- `coilSweep` (additive v3) sweeps a rectangular section along a curve with
  tilt/twist/stations, needs no sketch, and is pattern/mirror eligible. The native W7-X
  shape study (`w7x-shape-study.ts` + `samples/w7x/w7x_coils.json`) uses ten such bodies
  across five modules (50 instances), needs no STEP, approximates the B-reps (~0.55% volume),
  and rejects simulation export via its `w7x-coil-shape-study` marker.
- `src/common/samples/*.json` are generated from the canonical `tests/e2e/assets/*.nuke-cad`
  fixtures by `scripts/copy-cad-samples.js` during `yarn build`; never edit the generated
  copies. The fixture remains the single source of truth.
- The sketch solver is client-side only: `sketch-solver.ts` is the sole planegcs
  importer (pinned exact, WASM fallback documented); curve-level constraints stay
  lines/circles/arcs, ellipses/B-splines take point-level ones; evaluation lives in
  `sketch-curves.ts`. See `docs/dev/sketch.md`.
- Sketch UI is three layers (`sketch-session.ts`, `sketch-mode-controller.ts`,
  `cad-sketch-overlay.tsx`) with session-scoped snap (default 12px, magnet + S/M/L),
  a controller-owned grid toggle, a top-center constraint chip bar plus a **More**
  select, a selection-aware right-click menu, and split hints/solver badges plus
  `N selected`/`Construction` state on the status line (failed gestures warn;
  selection transforms disable with reasons), session-local undo/redo (50
  snapshots; finish-save prompt on unsaved documents); face/edge picking
  (`face-picker.ts`, `edge-picker.ts`) feeds `externalRefs` as construction geometry.
  See `docs/dev/sketch.md`.
- Feature recompute (`feature-graph.ts`: DAG, topological order, cycle rejection,
  `markDirty`/`recomputePlan`/`markClean`, suppression → stale) plus fingerprint
  `TopologyRef`s (`topology-refs.ts` types, Python scoring/resolver,
  `matched`/`ambiguous`/`unmatched` with fingerprint-identity repair). See
  `docs/dev/features-patterns.md`.
- Drawing Sheet workspace: grouped toolbar, framed paper + title block, cursor-centered
  zoom + Space/middle/Alt pan, grid/snap/frame toggles, inspector
  (views/dimensions/scale/Fit/delete), label/body view dragging with a minimum grab
  area, view + paper context menus, double-click Fit, selected-view status segment, tiny-1:1
  auto-fit, and Save/Refresh/SVG/DXF; grounded assemblies project placed
  instances; pending edits auto-save before HLR. See `docs/dev/drawings-assemblies.md`.
- Dress-ups (fillet/chamfer/draft/shell on the accumulated B-rep via pick modes;
  fillet/chamfer edge picks optionally expand to a same-solid tangent chain, 15° / 256-edge cap),
  patterns/mirror/lattice (2500-cell cap)/multiTransform over same-body sources with
  union-fuse semantics, and the hole wizard (face ref + `[u, v]`, blind/through,
  counterbore/countersink/counterdrill mutex, ISO `modeled` threads) with `defeature`.
  See `docs/dev/features-patterns.md` and `docs/dev/viewport-outline.md`.
- Sweep/pipe (curve path, `frenet`/`fixedBinormal`, additive-only, closed-spine
  station lofts), loft (ordered `sectionSketchIds`, `ruled`), helicalSweep (analytic
  helix, optional `subtractive`); every dialog offers debounced ghost preview
  (producers standalone, modifiers pull full chains). See `docs/dev/features-patterns.md`.
- Overlap policy: same-body additive checks plus disjoint-skip → parallel-fuse →
  sequential-fallback for pattern instances (touching = intersecting; the W7X wall is
  accuracy-tuned, not an optimization surface); cross-body overlap is a warning with
  an outline **Fuse** auto-fix, and document `overlapCheck: false` skips cross-body +
  assembly-instance warnings for a validated large assembly (warnings only; the W7-X
  generator sets it). See `docs/dev/features-patterns.md`.
- Backend builds (`geometry_service.py` script child process at 120s — resource control, not a security sandbox;
  `sandbox_service.py` bwrap/prlimit path for AI script authoring with no fallback; `feature_builder.py`
  topological bodies, `curve_builder.py` wires, datums `XY`–`line2Point`, the result cache
  (`<stem>.nuke-cache.zip` sidecar with TS and Python content keys and doc-hash tess blob); display builds
  prime it, one batch load/commit serves a build, and per-body overlap verdicts are reused for
  unchanged signatures). See `docs/dev/backend-pipeline.md`.
- Imported-body features read STEP/IGES/BREP through `exchange_reader.py` (one source read
  per distinct configuration per build, exact unit scaling, streamed SHA-256 verification);
  `geometry_service --inspect-import` backs the read-only `inspectImportSource` RPC.
  See `docs/dev/backend-pipeline.md`.
- Imports (STEP/IGES/glTF/STL with unit adoption, build123d/CadQuery selectors) and
  default `--no-dagmc`/`--no-mesh` gates with opt-in flags; DAGMC export
  (`dagmc_export.py`: sense hard error, staged gmsh imprint, most-specific-wins
  selectors, `inspection_gates.py` warnings) and `ocp_compat.py` 7.8/7.9 shims. See
  `docs/dev/backend-pipeline.md`.
- Package requirements live in `src/common/packages.json` (single source of truth;
  `health` group → `CAD_HEALTH_PACKAGES` for `checkCadEnvironment`, rest reference
  data; shared specs must match nuke-core's registry). See `docs/dev/backend-pipeline.md`.
- CAD AI capabilities live in `src/browser/capabilities/nuke-cad-capabilities.ts`, use the
  nuke-core capability contract, and delegate to existing CAD services; never expose raw
  commands. `nuke.cad.diagnoseModel` reports build, manifest, selection, and per-solid
  findings without rebuilding. The seven gated authoring slices preview and apply scalar feature
  edits, existing sketch driving dimensions or document parameters a sketch references, topology-impacting hole
  blind/through or linear/circular pattern counts, imported STEP/IGES/BREP bodies, placement-only actions on an
  existing grounded assembly, presentation settings on existing drawing sheets, and Linux-only sandboxed full-file `.py`
  replacements through the document store (the assembly and drawing summaries stay read-only); it is default-off
  (`nukeCad.aiAuthoringEnabled`) and requires a saved model. Script authoring additionally needs workspace-scoped
  `nukeCad.scriptAuthoringEnabled`, `bwrap` plus user namespaces, bounded text/hash inspection (source text reaches the
  model provider), a full-body preview with no network/workspace bind, no ghost, no chat Apply, and a panel-only approval
  nonce; apply overwrites with a hidden backup, rebuilds sandboxed, blocks DAGMC/FEM export for the sandboxed model, and
  has no unsandboxed fallback. Parameter-bound dimensions cascade to every affected sketch and curve, a sketch apply commits the
  parameter and all sketches atomically, and a topology apply replaces exact params in one commit (removing a blind
  hole's `depth` key), reports solid/region impact, and checks the saved active OpenMC project's DAGMC references and
  requires region acknowledgement. Imports use a user-chosen source: `inspectImportSource` returns
  format/size/hash/units/solids, `previewImportBodies` is plan-only (no build or ghost) and opens the review panel with a
  one-to-N-body plan, and `applyImportBodies` re-inspects the source, rejects stale hash/size/selection/plan, writes a
  backup, and commits one `addImportBodies`; the source must be in a workspace root, a regular file (no symlink), a
  supported extension, and at most 256 MiB, and the AI flow never downloads or copies it. Assembly authoring summarizes
  instances/parts/placements/grounding/selector ids/BOM/overlap policy, previews 1-16 add/remove/setPlacement actions with
  a real candidate build, placement rows, BOM delta, exact overlap warnings, and `overlapCheck:false`, and applies one
  `applyAssemblyChanges` batch; it adds only an existing `body:<id>` or reuses an existing instance part, removes only a
  non-grounded connector-free embedded instance (final count >= 1), sets pos+quat only on a grounded/unmated instance,
  requires acknowledgement only when a removal loses the last instance of a labeled embedded body, blocks on a saved
  OpenMC reference, and never changes mates, connectors, grounding, sources, parts, names, or an existing instance's
  scale. Drawing authoring summarizes sheets/views/dimensions and previews one sheet with 1-16 `setSheetSize`,
  `setViewDisplay`, or `setDimensionVisibility` actions that change only existing presentation settings; preview is
  plan-only (no build or ghost), A3→A4 is rejected when a view is outside A4 and views never move, hidden dimensions
  stay listed but leave SVG/DXF, and the title block is fixed and read-only. Drawing apply is one `applyDrawingChanges`
  commit (`markDrawing`) with backup, sheet open/refresh, undo, and no `nuke.cad.rebuild`.
  Booleans, body/feature add/delete/reorder, lattices, new sketch entities/constraints/dimensions, partial or unsandboxed
  scripts, assembly structure beyond placement, drawing creation/deletion or view placement, title-block edits, and MCP
  stay excluded. A successful feature, sketch, topology, or assembly
  preview publishes the candidate tessellation to `NukeCadGhostPreviewService` and reveals the **CAD Edit Review**
  panel; the panel applies the same capability and the viewport renders the candidate in the scene-level `cad-ghost`
  group only. Import preview shows the plan without a ghost; drawing preview shows the sheet/view/dimension plan without
  a build or ghost; script preview shows the diff/sandbox/audit without a ghost; repeated-body assembly ghosts are
  approximate. Script apply is reachable only from the panel, which keeps the approval nonce out of the view.
  See `docs/dev/ai-capabilities.md`.
- Viewport: purpose-built three.js widget (active-camera rule, scene-scaled
  `clip-planes.ts` near/far, `ViewerNavBar` children, scoped keys with capture phase,
  floating bottom-left command-search launcher (`/`) over the shared `cad-command-registry.ts` table
  (ribbon + search, disabled reasons, pinned commands + label-free density) with text/pick/dialog guards,
  `ViewCube`/`ViewBadge` below the toolbar, theme-adaptive colors), worker-parsed
  tessellation with content-keyed reuse that rebuilds invalidate, single-authority
  shading, visual-only section, measure (distance/angle/radius + pinnable `measurements`
  block), saved named views (`views` block + camera API), per-solid explode, hidden-set picking filters,
  overlapping-face Select Other (context-menu candidate popover + Alt+click cycling), and a
  display-only world-origin triad with a master `nukeCad.showOriginAxes` switch plus per-axis
  `nukeCad.showOriginX/Y/Z` visibility (Model Outline Origin section; only rendered with a loaded model).
  See `docs/dev/viewport-outline.md`.
- Reopening the viewport restores the state manager's model + tessellation (or rebuilds
  a saved document from cache) in `onAfterAttach`; the empty-document card must never
  cover an active document. The same hook re-reveals Feature Tree + Model Outline, and
  New Document clears the old model/tokens before installing (no background restore).
- The viewport context menu appends the neutral `cad.viewport` context-action group; existing
  rows/separators stay fixed and missing commands are omitted. See `nuke-core/docs/dev/context-actions.md`.
- Document opens are generation-guarded: a slower file read, rebuild, or cached-fast-path
  parse is discarded after a newer `.nuke-cad` open, and the Drawing Sheet clears per-document
  linework/results via `CadDocumentStore.documentEpoch` before refreshing the new document.
- Narrow document toolbars wrap the ribbon and use compact section menus; explode groups
  solids by instance/body and separates centered shells vertically.
- Assembly-panel hover help uses the shared `Tooltip`/`useTooltip`; no native `title`.
- Per-body appearance overrides (`BodyDef.appearance`: `color` `#rrggbb` + `opacity` 0–1,
  display-only, no rebuild) use one cloned material per overridden body; selection keeps
  the shared highlight and xray wins opacity. `nukeCad.appearancePresets` is a user-level
  preset library (normalized in `body-appearance.ts`); multi-body apply commits once via
  `setBodiesAppearance`. `nukeCad.colorByMaterial` adds material-tag palette colors beneath
  explicit appearance colors (`resolveBodyDisplayAppearance`; shared `materialColor`). See
  `docs/dev/viewport-outline.md`.
- Model Outline (read-only manifest; Document units/precision/display + material legend,
  Properties, Table, Parameters, BOM, warnings-Fuse)
  and Feature Tree (ordered bodies/datums/sketches/features/curves, suppression,
  reorder/delete guards, repair popover) with mask-based `codicon-nuke-cad-*` icons
  and `nuke-cad-preferences.ts` (faceting/display/background/navigation/rebuild/cache/
  precision/origin axes/ribbon labels+pins/appearance/material color).
  See `docs/dev/viewport-outline.md`.
- Curves (`points`/`parametric`/`fourier` via `expression.ts` + units, closed-repeat
  convention, `curve_builder.py` wires), drawings (additive block, HLR
  `drawing_service.py`, SVG + optional DXF, fingerprint dimensions,
  `nuke-cad-drawing-widget`), and assemblies (frozen mate-connector spec,
  `assembly_builder.py` BFS placements, `addAssemblyInstances` batch commits, per-instance
  shared-geometry viewport, BOM panel, `fastener_data.py` threads, one-click exchange import
  with document-relative part paths, backend-routed external sample downloads).
  See `docs/dev/drawings-assemblies.md`.
- Manifest materials (`meshSize`, `materialId`/`parentId` links, `materials` cards,
  `BodyDef.material` tags → `<stem>.regions.json`), gmsh/netgen mesh parity (imprinted
  BREP, tetra10 remap), CalculiX FEM (`fem_service.py`, manifest-first cards),
  OpenFOAM scaffolding + per-solid STL (`foam_service.py`), and the `job_service.py`
  run-layer with `cancelJob` RPC. See `docs/dev/fem-mesh-foam.md`.
- Tests: minimal profile (`pytest` + `numpy`, guarded heavies, forced-absence guards),
  `.coveragerc` ratchet over the nuke-cad logic modules with the OCC/gmsh/pymoab
  pipeline omitted, `@pytest.mark.e2e` env-gated suites, tokamak GUI-authored fixture
  with drift/toponaming/perf coverage, and opt-in W7X suites with a conda/pip netgen
  env split. Import/generator coverage: `tests/python/test_import_feature.py` (units,
  selection/signatures, hash/cache, assembly dirs, inspect CLI) and
  `tests/e2e/test_w7x_generator.py` (`NUKE_E2E_W7X_STEP`: 55 solids / 55 selector keys,
  plus 45/65-solid 4/6-module studies with simulation export blocked),
  `tests/e2e/test_w7x_shape_study.py` (50 native solids, no STEP), and
  `tests/python/test_coil_sweep.py`. See `docs/dev/testing-e2e.md`.

## Work Guidance

- Follow repo style: 4-space indent, single quotes, no trailing commas.
- New source files carry the BSD-2-Clause header.
- BOM panel empty state is one card; rows use the shared `Tooltip` and support Enter/Space selection. It is bound through
  `CadBomPanelWidget` + `nuke.cad.openBomPanel` (right area), the CAD Studio menu, and the Nuke Tools sidebar.
- Geometry scripts must define a top-level `model` variable holding a
  build123d Part/Compound, CadQuery Workplane (when installed), or OCP TopoDS_Shape.
- Heavy Python imports must be guarded so modules stay importable in the
  minimal pytest profile.
- Compact icon buttons must reset Theia's `.theia-button` defaults via the
  grouped reset in `cad-viewport.css`.

## Verification

```bash
npx lerna run build --scope nuke-cad
npx vitest run extensions/nuke-cad/src/common/cad-feature-edit.test.ts \
  extensions/nuke-cad/src/common/cad-topology-edit.test.ts \
  extensions/nuke-cad/src/common/topology-impact.test.ts \
  extensions/nuke-cad/src/common/cad-assembly-edit.test.ts \
  extensions/nuke-cad/src/common/assembly-bom.test.ts \
  extensions/nuke-cad/src/common/cad-drawing.test.ts \
  extensions/nuke-cad/src/common/cad-drawing-edit.test.ts \
  extensions/nuke-cad/src/common/openmc-region-references.test.ts \
  extensions/nuke-cad/src/browser/capabilities/openmc-region-reference-reader.test.ts \
  extensions/nuke-cad/src/browser/capabilities/import-source-policy.test.ts \
  extensions/nuke-cad/src/browser/capabilities/nuke-cad-authoring-capabilities.test.ts \
  extensions/nuke-cad/src/browser/capabilities/nuke-cad-proposal-service.test.ts \
  extensions/nuke-cad/src/browser/document/cad-document-store.test.ts \
  extensions/nuke-cad/src/browser/document/cad-document-store-drawings.test.ts \
  extensions/nuke-cad/src/browser/widgets/drawing-sheet \
  extensions/nuke-cad/src/browser/sketch/sketch-session.test.ts \
  extensions/nuke-cad/src/browser/sketch/sketch-edit-service.test.ts \
  extensions/nuke-cad/src/browser/preview \
  extensions/nuke-cad/src/browser/widgets/review-panel
yarn test:python   # includes nuke-cad tests/python and tests/e2e (e2e skips without env gates)
yarn lint
```

Full-profile e2e needs `NUKE_TEST_PYTHON` (openmc + CAD toolchain) plus `OPENMC_CROSS_SECTIONS`;
W7X suites are opt-in via `NUKE_CAD_W7X_PERF=1` / `NUKE_CAD_W7X_GATE=1` with `*_COUNT` overrides;
`NUKE_E2E_W7X_STEP` gates the drift check and the W7-X generator e2e. See `docs/dev/testing-e2e.md`.

## Child NAD Index

- None
