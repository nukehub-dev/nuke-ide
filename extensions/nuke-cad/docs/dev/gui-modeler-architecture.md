# GUI modeler architecture

The `.nuke-cad` GUI modeler is a three-tier system: a client-side geometric
constraint solver, a TypeScript document model, and a Python headless builder
that feeds the same geometry pipeline as script builds.

## Document schema

`src/common/cad-document.ts` owns the `.nuke-cad` v2 schema and its validation.

A document contains:

- `parameters` — document-level named scalar values.
- `datums` — planes on which sketches sit (`XY`, `YZ`, `XZ`, `offset`, and
  `face`). `face` datums reference a planar face of a predecessor feature by
  fingerprint and derive a deterministic workplane from it.
- `sketches` — `SketchDef` records with planegcs-verbatim primitives,
  constraints, sketch-local parameters (merged into document parameters on save),
  dimension metadata, and optional `externalRefs` to edges/faces of predecessor
  features (projected as construction geometry).
- `bodies` — solid body definitions (`id`, `name`, optional `label`). Every solid
  feature targets a body id; boolean features consume bodies. Body labels map to
  the region manifest / `selector_map`.
- `features` — a sequential feature tree with explicit `dependsOn` edges, a
  required `body` id for every feature, consumed feature `sketchId` for
  sketch-based features, parameters, suppression flag, and optional label.
  Solid features (`pad`/`pocket`/`revolve`/`groove`/`sweep`/`pipe`),
  pattern/mirror features
  (`linearPattern`/`circularPattern`/`mirror`), the hole wizard (`hole`), boolean
  features (`booleanFuse`/`booleanCut`/`booleanCommon`), and dress-up features
  (`fillet`/`chamfer`/`draft`/`shell`) share the same feature record shape.

Validation (`validateNukeCadDocument`) checks duplicate ids, dangling references,
body references on every feature, boolean parameter shape, parameter-name
collisions, and feature-parameter ranges. Migration (`migrateNukeCadDocument`)
runs registered v1→v2 steps in `MIGRATIONS`; future schema bumps add steps and
bump `NUKE_CAD_SCHEMA_VERSION`.

## Client solver

The solver is intentionally isolated from the rest of the codebase.

- `src/common/sketch-solver.ts` is the **only** module that imports
  `@salusoft89/planegcs`. It exposes the solver-agnostic `SketchSolver`
  interface and the `PlanegcsSketchSolver` implementation.
- `src/browser/sketch/sketch-session.ts` uses `SketchSolver` to manage one
  sketch: tools, snap, auto-constraints, user constraints, dimensions,
  parameters, drag solving, and serialization to `SketchDef`.
- `src/browser/sketch/sketch-mode-controller.ts` wires the session into the
  three.js viewport: orthographic camera, pointer-to-plane mapping, rendering,
  and pointer events.
- `src/browser/widgets/cad-viewport/cad-sketch-overlay.tsx` is the React UI
  chrome.

PlaneGCS primitives are stored verbatim in `SketchDef.primitives` and
`SketchDef.constraints`. `SketchSession` translates the UI-facing constraint
kinds (e.g. `coincident`, `distance`, `symmetry`) to the planegcs types
(`p2p_coincident`, `p2p_distance`, `p2p_symmetric_ppl`, etc.) on save and
restores them on load.

## Document store

`src/browser/document/cad-document-store.ts` is a framework-free store that:

- holds the active `NukeCadDocument`, backing URI, dirty flag, selection,
  selected body, and per-feature build results;
- performs immutable updates and validates them before committing;
- provides body mutations (`addBody`, `removeBody`, `renameBody`, `setBodyLabel`,
  `selectBody`);
- merges sketch-local parameters into document-level parameters when a sketch is
  saved;
- rejects destructive operations that would orphan dependents (delete a sketch
  referenced by a feature, delete a feature or body referenced by another
  feature).

## Backend build path

`python/geometry_service.py` exposes `build_document(document_path, ...)`, which
mirrors the script `build_geometry` signature. The flow is:

1. Parse and lightly validate the JSON document.
2. `python/feature_builder.py::build_document_shape()` topologically sorts the
   feature tree over `dependsOn` edges and builds each feature.
3. Before building each feature, `feature_builder` resolves its `TopologyRef`s
   (face datum, external geometry, and future edge arrays) against the referenced
   predecessor feature's current B-rep. `matched`/`ambiguous`/`unmatched` status
   for every reference is returned in `referenceResults`; ambiguous or unmatched
   references fail the dependent feature with a clear `FeatureBuilderError`.
4. For each feature, `feature_builder` calls `python/sketch_builder.py` to turn
   the feature's sketch primitives into build123d `Face` objects on the sketch
   datum plane.
5. Additive features (`pad`, `revolve`, `sweep`, `pipe`) combine into the accumulated body for
   the feature's `body`; subtractive features (`pocket`, `groove`) cut from it.
   Boolean features (`booleanFuse`, `booleanCut`, `booleanCommon`) perform OCP
   booleans between a target body and the union of one or more tool bodies, then
   consume the tool bodies unless `keepTools` is true. Dress-up features
   (`fillet`, `chamfer`, `draft`, `shell`) apply build123d operations to the
   accumulated body after resolving their edge/face `TopologyRef`s against the
   body's current B-rep. Pattern/mirror features (`linearPattern`,
   `circularPattern`, `mirror`) resolve their `source` solid feature
   and apply transformed copies of its stored tool shape: additive sources are
   appended (overlap-checked), subtractive sources are cut. Sweep/pipe features
   (`sweep`, `pipe`) build their path wire from the document's curves and sweep a
   section (the sketch face, or a generated circle for pipe) along it. The hole wizard
   (`hole`) resolves its planar placement `face`, projects `center` from face
   workplane coordinates, and expands the record into an extrude-cut plus
   optional counterbore/countersink geometry. Implied dependencies automatically
   order features within the same body and order boolean/dress-up/pattern/mirror
   features after the tips of their target/tool/source bodies.
6. A final cross-body overlap gate rejects documents where two non-consumed
   bodies occupy the same space without a boolean merge.
7. The final shape is handed to `_process_shape`, the same function used by
   script builds and STEP imports, so STEP/tessellation/DAGMC/mesh artifacts are
   identical across authoring modes.

The Python backend never re-solves; it consumes the solved coordinates stored in
the document. A full build executes every feature and primes the per-feature
result cache (it runs the partial builder with every feature dirty, which is the
equivalence-tested cold-cache path), so the next edit restores clean predecessors
from `<stem>.nuke-cache.zip` instead of re-executing them. See
`docs/dev/backend-pipeline.md` (P2 result cache) and `docs/dev/viewport-outline.md`
(camera clipping).

### Feature-result tracking

`build_document_shape` returns per-feature status records (`built`, `stale`, or
`failed`) with an optional error string, plus `selectorMap` keyed by body label,
`consumedBodies`, and `solidBodyIds` mapping each final solid back to its body.
The document store keeps the status records in `featureResults` and the Feature
Tree widget renders status markers. A feature is stale when it is suppressed or
depends on a stale/failed feature; failed features leave the accumulated body at
its last-good shape when possible.

## Topological reference system

Topological references let features (sketch-on-face, fillets, chamfers,
drafts, shells, hole placement faces, patterns) target faces/edges produced by
earlier features without storing fragile raw indices. The system has three parts:

- `src/common/topology-refs.ts` — TypeScript types and validation for
  `TopologyRef` objects (`featureId`, `kind`, `fingerprint`).
- `python/reference_scoring.py` — pure-Python/numpy fingerprint similarity
  scoring and reference matching.
- `python/reference_resolver.py` — OCP-bound fingerprint extraction and batch
  resolution against a rebuilt shape.

### Fingerprint shape

A face fingerprint stores `surfaceType`, `area`, `center`, optional `normal`,
`axis`, `radius`, and `minorRadius`. An edge fingerprint stores `curveType`,
`length`, `start`, `end`, and optional `center`. The TypeScript side owns shape
validation; the Python side owns extraction and scoring.

### Match semantics

`reference_scoring.match_references()` classifies each reference as:

- **matched** — the best candidate exceeds `SCORE_THRESHOLD` (0.5) and the gap
  to the runner-up is larger than `ambiguity_margin` (0.05).
- **ambiguous** — the best candidate exceeds the threshold but the runner-up is
  close; the result includes the top candidates (with fingerprints) but the user
  must repair.
- **unmatched** — no candidate reaches the threshold; the result still includes
  up to three best candidates so the user can pick a repair manually.

Candidates are assigned greedily in one-to-one fashion so two ambiguous
references do not collapse onto the same geometry.

`reference_resolver.resolve_references()` extracts candidates from a rebuilt
`TopoDS_Shape` (stable `face_0001`, `edge_0001` ids) and delegates to the scorer.

## Adding a new feature type

1. **Schema** — add the feature type to `FeatureType` in
   `src/common/cad-document.ts` and add parameter validation in
   `validateFeatureParams`. Solid features must require a `body`; boolean
   features must validate `targetBody` and `toolBodies`; dress-up features must
   validate their edge/face arrays and operation-specific parameters;
   pattern/mirror features must validate a `source` feature id and their
   axis/plane parameters; the hole wizard must validate a face `TopologyRef`,
   a `[u, v]` center, diameter/depth, and mutually exclusive
   counterbore/countersink fields.
2. **UI** — add a button in `cad-sketch-overlay.tsx` (`DocumentModeToolbar` or
   `FeatureCreationDialog`) and a command in `src/browser/commands.ts`. Wire the
   command in the relevant contribution. Boolean dialogs populate target/tool
   body dropdowns from `document.bodies`. Dress-up dialogs use the viewport's
   edge-pick or face-pick mode via `setDressUpPickMode` and store picked
   references in the feature params. The hole wizard enters a dedicated face-pick
   mode; the click handler uses `buildTopologyRef` plus
   `projectHitToFaceUv(hit)` from `face-picker.ts` to produce the placement face
   reference and 2D center in the same deterministic workplane coordinates the
   backend uses.
3. **Document store** — `addFeature` and `updateFeatureParams` already accept any
   `FeatureParams`; no change needed unless the new type needs special selection
   or dependency logic. For booleans, `computeDependsOn` derives dependencies from
   the target and tool body tips. For dress-ups, `computeDependsOn` should order
   the dress-up after the tip of its target body. For patterns and mirror,
   `computeDependsOn` must also include the `source` feature id so the planner
   keeps the source before the pattern/mirror feature.
4. **Backend** — implement the builder in `python/feature_builder.py`:
   - Accept the new type in `_build_feature_shape` (for sketch-based features),
     in the topological loop (for boolean/pattern/mirror/hole features), or in
     the dress-up handler (for `fillet`/`chamfer`/`draft`/`shell`).
   - Build the tool shape from the feature's sketch and parameters (sketch-based
     features only).
   - For pattern/mirror features, store the source's tool shape and apply
     transformed copies; additive sources use `_combine_additive` (overlap check
     applies), subtractive sources are cut.
   - For the hole wizard, resolve the placement face, build a cylinder/cut from
     the 2D center along the inward normal, and optionally add counterbore/
     countersink geometry.
   - Resolve `TopologyRef`s through `_collect_topology_refs` and
     `resolve_references` before applying the operation.
   - Apply the operation to the feature's target body in the topological loop.
5. **Feature tree** — add an icon in `feature-tree-widget.tsx` if desired and
   update row rendering for the new type's parameters.

## Adding a new constraint kind

1. **Solver API** — extend `SketchSolver` in `src/common/sketch-solver.ts` with
   the new method and implement it in `PlanegcsSketchSolver` by emitting the
   correct planegcs constraint type.
2. **Session API** — add the kind to `ConstraintKind` in
   `src/browser/sketch/sketch-session.ts`, validate targets in
   `validateConstraint`, and call the solver method in `addConstraint`.
3. **Serialization** — translate the UI kind to planegcs JSON in
   `constraintToPg` and restore it in `loadConstraintFromPg`.
4. **Overlay** — add the kind to `CONSTRAINT_OPTIONS` in
   `cad-sketch-overlay.tsx`; if it requires a value, add it to
   `VALUE_CONSTRAINTS` and set the arity in `arityFor`.
5. **Dimensions** — if the constraint produces a dimension, map the kind in
   `inferDimensionKind` and `createDimensionForConstraint`.

Constraint kinds must keep the planegcs-verbatim representation stable so saved
`.nuke-cad` documents remain loadable even when the UI layer evolves.

## WASM loading

The PlaneGCS library is LGPL-2.0-or-later. The browser app bundles the WASM as a
webpack `asset/resource`; `src/browser/sketch/planegcs-wasm-url.ts` resolves the
emitted public URL with `require('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm')`.
Vitest runs in Node and uses the package's default Node wasm resolution.
