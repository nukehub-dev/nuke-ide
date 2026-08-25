# Nuke CAD

## Purpose

Parametric CAD / meshing / FEM extension for NukeIDE with two authoring modes:
script-based build123d/CadQuery `.py` files and GUI-edited `.nuke-cad`
parametric documents. Both paths feed the same geometry-service pipeline and
produce identical simulation-ready artifacts (STEP, DAGMC, FEM meshes) consumed
by openmc-studio and future physics extensions.

## Ownership

All files under `extensions/nuke-cad/` except generated artifacts (`lib/`,
`node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md` with `src/browser/`,
  `src/node/`, and `src/common/`.
- `.nuke-cad` JSON document schema lives in `src/common/cad-document.ts`
  (version 2 today). Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. Future migrations register steps in `MIGRATIONS`
  and bump `NUKE_CAD_SCHEMA_VERSION`.
- Sketch solver adapter: `src/common/sketch-solver.ts` exports the solver-agnostic
  `SketchSolver` interface and the `PlanegcsSketchSolver` implementation. No
  other source file imports `@salusoft89/planegcs` directly. The dependency is
  pinned exact in `package.json`; vendoring the LGPL-2.0-or-later WASM is the
  documented fallback if the npm package stalls.
- Feature recompute planner: `src/common/feature-graph.ts` builds the feature
  dependency DAG from explicit `dependsOn` edges, computes topological order,
  rejects cycles with readable member lists, and produces a minimal dirty-subtree
  plan via `markDirty` + `recomputePlan`. Callers clear successfully rebuilt
  features with `markClean` so the next plan starts from the updated state.
  Suppressed features are omitted and their dependents marked stale so the
  builder can keep last-good geometry.
- Topological references: `src/common/topology-refs.ts` defines fingerprint-based
  `TopologyRef` types (`face`/`edge`) used by datum faces, fillets, chamfers,
  drafts, shells, hole placement faces, patterns, sketch-on-face, and sketch
  external geometry.
  References are never raw indices. Fingerprint matching and scoring lives in
  the Python backend (`python/reference_scoring.py`, `python/reference_resolver.py`);
  TypeScript owns only the types and validation. The builder resolves every
  reference against the referenced predecessor feature's current B-rep and
  returns `matched`/`ambiguous`/`unmatched` status per reference in
  `referenceResults` so the frontend can render repair affordances. Broken
  (`ambiguous` and `unmatched`) references carry up to 3 repair candidates,
  each with its full geometric fingerprint; the fingerprint — not the
  per-rebuild candidate id (`face_0007` style, re-sorted on every build) — is
  the identity the frontend stores via `CadDocumentStore.replaceTopologyRef`.
  Planar-face fingerprints report the outward normal (`TopAbs_REVERSED` faces
  flip the underlying plane axis); face workplane derivation
  (`face_plane_origin_normal` / `_workplane_from_face`) and the frontend UV
  projection (`face-picker.ts`, `sketch-math.ts`) follow the same convention,
  so off-center hole centers and sketch-on-face coordinates agree.
- Dress-up features (`fillet`, `chamfer`, `draft`, `shell`) operate on the
  accumulated B-rep of a body after its prior features. They store target
  edges or faces as `TopologyRef`s and resolve them through the same
  fingerprint-based resolver as sketch external geometry and face datums.
  Fillet requires `edges` and `radius`; chamfer supports symmetric (`distance`),
  two-distance (`distances`), and distance-angle (`distance` + `angle`) modes;
  draft requires `faces`, `angle`, and a non-zero `pullDirection`; shell
  requires `thickness` and an optional `faces` list (empty means hollow all
  faces). The viewport enters an edge-pick or face-pick mode when a dress-up
  dialog asks for references; hover highlights the candidate and a click adds
  the reference to the dialog list. The same-body additive overlap check is
  intentionally left untouched — dress-ups modify an existing body rather than
  create new material.
- Pattern, mirror, and hole features (`linearPattern`, `circularPattern`,
  `mirror`, `hole`) extend the same-body feature chain. Patterns and mirror name
  a `source` sketch-based solid feature (`pad`/`pocket`/`revolve`/`groove`) on
  the same body, earlier in document order. The backend stores the source's
  tool shape and applies transformed copies: additive sources are merged with a
  boolean union so overlapping pattern instances fuse into one solid
  (required for toroidal/poloidal coil assemblies), subtractive sources are
  cut. `linearPattern` uses `count`, `spacing`, and `axis`; `circularPattern`
  uses `count`, optional `angle`, and either `axis` or `axisDatumId`; `mirror`
  uses either `plane` (`XY`/`YZ`/`XZ`) or `planeDatumId`. Face datums behind
  `axisDatumId`/`planeDatumId` resolve against the referenced feature's
  historical shape (same scope as sketch datums), while the hole placement
  face resolves against the pattern/hole body's current B-rep. The hole wizard stores
  a single feature record with a face `TopologyRef` and a center `[u, v]` in the
  resolved face's workplane coordinates; the backend expands it internally into
  an extrude-cut plus optional counterbore/countersink geometry. Omitted `depth`
  means through-hole; counterbore and countersink are mutually exclusive.
  Subtractive features (pocket/groove/hole) whose tool is disjoint from the
  body fail with a clear "does not intersect" error instead of a silent no-op
  success.
- The same-body additive overlap check for single sketch features remains in
  `_combine_additive`; overlapping additive pattern instances are fused by the
  boolean union in `_apply_pattern_or_mirror` instead.
- Cross-body overlap is reported as a warning (with overlap volume) rather than
  a fatal error. Pure CAD assemblies such as the tokamak demo intentionally
  contain overlapping parts, so the B-rep build completes and callers that
  need a sealed model can inspect `result["warnings"]` before DAGMC export.
  `geometry_service.build_document` forwards the builder's `warnings` and
  `consumedBodies` to the RPC response (`GeometryBuildResult.warnings` /
  `consumedBodies`), and the viewport surfaces the warnings in a dismissible
  strip in the viewport chrome.
- Pad/pocket `upToFace`, `upToBody`, and `angle` parameters are
  schema-accepted and validated (so badges and repair paths work), but the
  builder does not implement them: it fails the feature with an explicit
  "not yet supported" error rather than silently ignoring them.
- Python backend lives in `python/` and is not pip-installed; the IDE spawns
  it as a subprocess via `nuke-core` environment detection.
- The CAD viewport is a purpose-built three.js widget (documented exception to
  the "reuse nuke-visualizer" rule); heavy visualization results still route to
  nuke-visualizer. The empty viewport shows an **Open CAD Model...** button.
  Rendering always goes through `SketchModeController.getActiveCamera()`: the
  orthographic camera in sketch mode, the live perspective camera otherwise —
  never a throwaway camera, or orbit/zoom/pan disconnect from the screen. The
  3D viewport exposes a navigation cluster (bottom-right: ISO/top/front/right
  views, fit, zoom in/out) backed by `fitView`/`zoomView`/`setStandardView` on
  the viewport API; `F` fits the view when no sketch, pick mode, or text field
  is active. Closing the viewport widget also closes the Model Outline and
  Feature Tree panels (they have no model to show otherwise); opening a CAD
  model reveals them again automatically. Entering sketch
  mode on a saved sketch fits the orthographic view to the sketch's bounding
  box (`SketchModeController.fitSketchView`); fresh sketches keep the default
  view size. `sketchEntering` covers the solver-WASM load window between
  **Start Sketch** and an active session: the widget treats it as sketch mode
  (no document-hint flash) and shows a "Starting sketch solver..." overlay.
  The 3D viewport also carries an axis gizmo (top-right SVG,
  updated imperatively from `renderScene` — never from React state; click an
  axis to snap views — snaps needing a different up re-create the controls
  because OrbitControls freezes its orbit pole at construction, keeping mouse
  orbit live after every snap; hidden in sketch mode and whenever no model is
  loaded via `setGizmoVisible`; the view label follows the same visibility) and a
  wireframe toggle (`setWireframe`) in the navigation cluster. Both the gizmo
  and the view-label overlay sit **below the document toolbar** (gizmo at
  top 64px, clear of the toolbar; view label at 52px) —
  at the toolbar's z-index the full-width toolbar would cover them. The view
  label (`cad-viewport-view-label`, imperative DOM) shows the active standard
  view (`User` after orbiting, `Top`/`Left`/... after snapping) or
  `Sketch — <name>` while sketching (`SketchModeController.getSketchName()`).
  Shading is a single material-state authority: `setShading(mode)` accepts
  `shaded`, `shadedWireframe`, `edgesOnly`, or `xray`, and
  `setGhostOpacity(v)` tunes x-ray transparency; pure helpers live in
  `shading-modes.ts` and one `applyShading()` applies everything —
  the nav-cluster popover picks the mode; rebuilds re-apply mode and opacity.
  Edges-only hides face meshes and disables face/solid picking (hint pill);
  x-ray ghosts faces at the ghost opacity with edges opaque. A section plane
  (`setSection({axis, flip, fraction} | undefined)`, pure math in
  `section-plane.ts`) clips faces and edge lines via
  `renderer.localClippingEnabled`; it is visual only, slider-driven over the
  tessellation bounding box, exits on button/Escape, and survives rebuilds
  through the same `applyShading()` path. The measure tool (pure logic in
  `measure-tool.ts`) records point-to-point distance annotations from the
  document toolbar Inspect group or the sketch toolbar — raycast surface
  points in 3D, snap-aware sketch-plane points in sketch mode — rendered as
  overlay lines/spheres with imperative HTML labels projected in
  `renderScene`; measurements are viewport state (never document state) and
  clear on rebuild or sketch exit. `fitView` frames
  the selected solid when `currentSelection.solidId` is set; `.` and
  double-click-on-solid also fit the selection; `Tab` toggles sketch mode
  (`handleToggleSketchMode`, guarded against pick modes, dialogs, and text
  fields).
- The Model Outline panel (`src/browser/widgets/outline-panel/`, widget ID
  `nuke-cad-outline-panel-widget`, label "Model Outline") lists the active
  model's manifest volumes and surfaces and is read-only — no manifest editing
  UI. Picking syncs both ways through the shared `NukeCadStateManager`: row
  click highlights the whole solid in the viewport; a viewport pick selects the
  row, scrolls it into view, and expands its section. Opened via the
  `nuke.cad.openOutlinePanel` command (right shell area) or the Nuke Tools
  sidebar (`CAD Studio → Geometry`). The panel also renders, from the shared
  per-solid summaries (`SolidSummary` published to `NukeCadStateManager`
  after tessellation parse; pure helpers in `solid-summaries.ts`): a
  **Properties** section for the selected solid (volume, area, bbox size,
  center of mass, face/edge/triangle counts in model units, with a pin
  toggle) and a **Table view** toggle (sortable Solid/Body label/Volume/Area/
  Faces/Tris columns driving the same selection sync). Missing data renders
  as em-dashes so payloads from older builds stay readable.
- The geometry service attaches optional per-solid inspection properties to
  every tessellation solid entry — `volume`, `area`, `bbox.min/max`, and
  `centerOfMass` — computed via OCP `GProp_GProps` + `BRepBndLib` in
  `_process_shape`'s `_solid_properties` helper. Additive and
  best-effort: on computation failure the key is omitted and the build path
  never breaks. Consumers must treat it as optional.
- Sketch snap behavior is session-scoped and user-toggleable:
  `SketchSession.setSnapEnabled(on)` / `setSnapRadius(px)` (default 12 px;
  disabled snapping short-circuits endpoint/center/grid snaps and the
  auto-coincident/point-on-object constraint paths alike), passed through by
  `SketchModeController`; the sketch toolbar exposes a magnet toggle plus an
  S/M/L radius control (6/12/24 px), and the status line reflects the state.
- Preferences live in `src/browser/nuke-cad-preferences.ts`.
  `nukeCad.facetingTolerance` (number, default 0.001, exclusiveMinimum 0) is
  the default faceting tolerance for export-quality builds (script builds and
  any build with DAGMC or FEM mesh export explicitly enabled); an explicit
  per-call tolerance wins and changes apply to subsequent builds only. It is
  deliberately separate from openmc-studio's
  `openmcStudio.defaultFacetingTolerance` — nuke-cad is an optional extension
  and cannot depend on openmc-studio. Viewport-only builds use
  `nukeCad.displayFacetingTolerance` (default 0.01), which is coarser so large
  documents open quickly, and `nukeCad.maxDisplayTriangles` (default 2 000 000)
  triggers a warning when a display tessellation exceeds the budget. DAGMC and
  FEM export tolerances are unaffected by the display settings.
- STEP/STP/BREP files open in nuke-cad by default (higher open-handler priority
  than nuke-visualizer); the geometry service reads them through OCP and runs
  the same tessellation pipeline as script builds. The `.py` open-handler
  priority is 50 — below the text editor's 100 — so Python files open in the
  editor by default and reach the CAD viewport via **Open With…**.
- STEP-source imports and `.nuke-cad` document opens/rebuilds skip DAGMC and
  FEM mesh export by default; the backend enforces `--no-dagmc`/`--no-mesh` on
  every path (including rebuilds) and `geometry_service.py` exposes opt-in
  `--dagmc`/`--mesh` flags for callers that explicitly request export.
- User geometry scripts execute in an isolated subprocess with a 120 s default
  timeout (`--script-timeout`); `SystemExit` and unsupported model types are
  reported as structured errors, not process crashes.
- Geometry-service selector extraction (build123d labels, CadQuery Assembly
  names) is tested against real cadquery 2.7/2.8: TShape-based matching via
  `IsPartner`, UUID-name filtering, and multi-solid Workplane handling.
- `dagmc_export.py` treats surface-sense verification as a hard error (every
  exported surface must have sense 1 or 2) and reports geometry diagnostics in
  the result: `sealed=False` + warning for hole edges, `nonManifoldEdges` for
  incidence > 2 (imprint seams legitimately have incidence 3), and
  `overlapCheck` from bbox + `BRepClass3d_SolidClassifier` sampling. The
  imprint/merge pass runs in gmsh (`occ.fragment` + `removeAllDuplicates`) and
  the optional `mat:graveyard` bounding box is added and fragmented in gmsh as
  well; the old OCP boolean graveyard cut is avoided because it re-duplicates
  coincident model-model faces and causes DAGMC particle leaks.
- `ocp_compat.py` owns the OCP 7.8/7.9 dual-flavor support. OCP 7.9 removed
  the `TopoDS.TopoDS.<X>_s` downcast statics (7.8 has only the `_s` names);
  `ensure_topo_ds_static_aliases()` re-attaches them from the non-suffixed
  callables so build123d 0.9.x runs on 7.9. The geometry-service child
  process applies it eagerly before `runpy`; `install_build123d_import_hook()`
  registers a one-shot meta-path finder so container images can activate the
  shim via a site-packages `.pth` line without paying the OCP import cost at
  every interpreter startup. `BRep_Tool` keeps its `_s` statics on both
  flavors — do not shim it.
- Widget CSS is copied to `lib/` by the `copy-css` build step.
- Python package requirements live in `src/common/packages.json`; never inline
  package lists in services or widgets. Only the `health` group is exported to
  TS (`CAD_HEALTH_PACKAGES`) and consumed today; the `core`/`cad`/`dagmc`
  groups stay as reference data. The `health` group's required set (numpy, OCP,
  build123d, gmsh) is what `checkCadEnvironment` treats as a working CAD
  backend; the rest are reported as `missingOptional`. Shared packages must
  match nuke-core's `package-registry.json`.
- The converter home is nuke-cad `python/` (`dagmc_export.py`). openmc-studio
  delegates to nuke-cad services: the **Import from nuke-cad...** command loads
  a nuke-cad `.h5m` + `.regions.json` into an OpenMC project, and the DAGMC
  editor's imprinted refacet routes through `dagmc_export.py` when available.
- Two authoring modes converge on the same geometry pipeline:
  - **Script mode**: a `.py` file defines a top-level `model` variable;
    `geometry_service.py` executes it in an isolated child process and hands the
    normalized OCP shape to `_process_shape`.
  - **Document mode**: a `.nuke-cad` JSON file stores parameters, datum planes,
    sketches, and features; `geometry_service.py` runs `build_document()` and
    feeds the same `_process_shape` so STEP, tessellation, DAGMC, and mesh
    artifacts are authoring-mode-agnostic.
- `.nuke-cad` document schema lives in `src/common/cad-document.ts` (version 2).
  Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. The document store
  (`src/browser/document/cad-document-store.ts`) holds the active document,
  performs immutable updates validated against the schema, tracks dirty state,
  sketch/feature selection, body selection, and per-feature build results.
  Sketch-local parameters are merged into document-level parameters when a sketch
  is saved.
- `.nuke-cad` v2 introduces **bodies** and **boolean features**. Every solid
  feature (`pad`/`pocket`/`revolve`/`groove`) targets a body id; boolean
  features (`booleanFuse`/`booleanCut`/`booleanCommon`) consume one target body
  and one or more tool bodies. Bodies carry an optional `label` that maps to the
  region manifest / `selector_map` for DAGMC and mesh export. The v1→v2 migration
  creates a single implicit body for each legacy feature.
- Sketch mode is split into three layers so each has a single responsibility:
  - `src/browser/sketch/sketch-session.ts` — pure TypeScript controller that
    owns tool state, snap, auto-constraints, constraint/dimension management,
    drag solving, external-geometry reference list, and serialization to/from
    `SketchDef`. No UI or three.js dependencies.
  - `src/browser/sketch/sketch-mode-controller.ts` — wires the session into the
    three.js viewport: orthographic camera, pointer-to-plane mapping, rendering
    of sketch primitives and projected external geometry as dashed construction
    lines, and pointer event routing.
  - `src/browser/widgets/cad-viewport/cad-sketch-overlay.tsx` — React UI chrome:
    sketch toolbar (including external-geometry tool), datum picker with
    sketch-on-face button, document toolbar, feature-creation dialog, constraint
    value input, dimension labels/popover (labels auto-shift apart when their
    screen projections would overlap), parameters panel, external-geometry
    reference list, diagnostics popover (with reference-resolution status), and
    status line. The sketch toolbar is a floating draggable panel: drag by its
    header (or the collapsed toggle), right-click/double-click for Reset
    Position; the dragged position persists across collapse/expand. Exiting
    sketch mode is the labeled **Finish Sketch** pill at the top-center of the
    viewport. The chrome builds on the shared nuke-essentials components
    (`NukeToolbar`/`NukeToolbarGroup` for the icon-only document toolbar —
    grouped Document/Sketch/Additive/Boolean/Dress-up/Pattern/Hole with
    tooltips and wrapping; no duplicate overflow menu — every action stays in
    its group; `NukeDialog` for the modal feature-creation dialog; `NukePanel`
    for the parameters/diagnostics/external-geometry popovers). The viewport
    widget itself uses `NukeEmptyState` for the empty viewport,
    `NukeLoadingOverlay` for rebuilds over existing geometry, and renders
    non-fatal build warnings (`GeometryBuildResult.warnings`, e.g. cross-body
    overlap) in a collapsible warning strip below the error banner: a collapsed
    `N build warning(s)` summary that expands to the full list, reset to
    collapsed on each new build.
- Custom CAD icons live in
  `src/browser/widgets/cad-viewport/cad-icons.css` as mask-based
  `codicon-nuke-cad-<name>` classes (16x16, `currentColor` — same technique as
  Theia file icons). They are used everywhere codicons are: toolbar buttons,
  feature-tree rows, widget `title.iconClass`, and the Nuke Tools sidebar
  (whose registry `icon` field takes the bare `nuke-cad-<name>` and renders it
  through Theia's `codicon()` helper). Keep new glyphs on the documented 16px
  grid (header comment in the CSS); never substitute a generic codicon for a
  panel/feature that already has a dedicated `nuke-cad-` icon — distinct
  panels must stay visually distinct.
- The geometric constraint solver is client-side only. The document stores
  planegcs-verbatim primitives with solved coordinates; the Python backend never
  re-solves. `src/common/sketch-solver.ts` exports the solver-agnostic
  `SketchSolver` interface and the `PlanegcsSketchSolver` implementation. No
  other source file imports `@salusoft89/planegcs` directly.
- PlaneGCS dependency posture: `@salusoft89/planegcs` is pinned exact in
  `package.json` (1.2.0 today). The bundled WASM library is
  LGPL-2.0-or-later and is loaded dynamically. In the browser the WASM is
  bundled via webpack `asset/resource` and its public URL is obtained through a
  `require()` in `src/browser/sketch/planegcs-wasm-url.ts`. Vendoring the WASM is
  the documented fallback if the npm package stalls.
- Sketch primitive JSON contract (planegcs-verbatim, with camelCase aliases
  accepted for compatibility): each primitive is an object with `id`, `type`,
  and optional boolean `construction` (default `false`). Type-specific fields:
  - `point`: `x`, `y`
  - `line`: `p1_id` (alias `p1Id`), `p2_id` (alias `p2Id`)
  - `circle`: `c_id` (alias `centerId`), `radius`
  - `arc`: `c_id` (alias `centerId`), `radius`, `start_angle` (alias
    `startAngle`), `end_angle` (alias `endAngle`), `start_id` (alias
    `startId`), `end_id` (alias `endId`). Angles are stored in radians.
- `.nuke-cad` document build path (headless backend):
  - `python/sketch_builder.py` consumes the solved sketch primitives stored in
    the document and emits build123d `Face` objects on the sketch datum plane.
  - `python/feature_builder.py` executes `pad`/`pocket`/`revolve`/`groove`,
    pattern (`linearPattern`/`circularPattern`), `mirror`, and `hole` features in
    topological order over explicit `dependsOn` edges, maintaining a separate
    accumulated body per `body` id. Additive features combine into their target
    body; subtractive features cut from it. `booleanFuse`, `booleanCut`, and
    `booleanCommon` features merge tool bodies into a target body and optionally
    keep the consumed tools. Dress-up features
    (`fillet`/`chamfer`/`draft`/`shell`) apply build123d/OCP operations to the
    accumulated body after resolving their edge/face `TopologyRef`s against the
    body's current B-rep. Pattern/mirror features resolve their `source` feature
    and transform copies of its stored tool shape; the hole wizard resolves its
    placement face and expands the record into an extrude-cut plus optional
    counterbore/countersink geometry. Features targeting a body consumed by a
    boolean feature are marked `stale` (the guard applies uniformly to
    dress-up, pattern/mirror/hole, and sketch-solid features). Cycles are
    rejected with a readable member list.
  - `geometry_service.py` exposes `build_document()` plus a `--from-document`
    CLI flag; it validates references lightly, runs the feature builder, and
    reuses `_process_shape` verbatim so STEP/tessellation/DAGMC/mesh artifacts
    match script builds.
  - The first release performs a full document rebuild on every `buildDocument`
    call. Per-feature shape caching is deferred until the modeler needs it.
  - Datum support includes `XY`/`YZ`/`XZ`/`offset`/`face`. `offset` datums are
    interpreted as offsets of the XY plane along +Z. `face` datums resolve a
    referenced planar face by fingerprint, derive a deterministic workplane from
    its origin/normal, and apply an optional `offset` along the normal; a
    non-planar resolved face is a clear build error.
  - Sketches may declare `externalRefs` to edges or faces of predecessor
    features. Resolved entities are projected into the sketch plane and passed
    to the sketch builder as `construction` primitives; they do not become part
    of the sketch's output wires or faces. `projectedPrimitives` is reported
    per sketch in the build result so the viewport can render the projected
    geometry as dashed construction lines while sketching.
  - The build returns `referenceResults` (`matched`/`ambiguous`/`unmatched`)
    for every `TopologyRef` so the feature tree and sketch diagnostics can
    surface broken references.
  - Feature labels map to 1-based solid indices in `selector_map`, feeding the
    same region-manifest/DAGMC/mesh pipeline used for script builds.
  - The tokamak demo fixture (`tests/e2e/assets/tokamak_with_divertor.nuke-cad`)
    is authored by the GUI-path vitest driver
    (`src/browser/document/gui-build-tokamak.test.ts`). It exercises dense
    polyline sketches, revolve/pad features, circular patterns, boolean clipping,
    overlapping assembly bodies, and the full DAGMC export path. Drift, e2e, and
    performance coverage live in `tests/python/test_tokamak_document.py` and
    `tests/e2e/test_dagmc_tokamak_document_e2e.py` /
    `tests/e2e/test_tokamak_performance.py`. Tokamak-scale topological-reference
    (toponaming) coverage lives in `tests/python/test_tokamak_toponaming.py`: it
    derives a face `TopologyRef` from the built `pf_coil_1` body via the
    production fingerprint extraction, attaches a hole feature to an in-memory
    copy of the document, and asserts the fingerprint resolves `matched` before
    and after an upstream dimension edit. The drift test compares per-body
    volumes (and face counts for non-spline bodies) against the authoritative
    STEP reference; plasma-facing spline boundaries are approximated with dense
    polylines and therefore checked to a relaxed 1e-3 volume tolerance.
- `.nuke-cad` shell integration:
  - `.nuke-cad` files open in the CAD viewport by default (open-handler priority
    500). The handler parses the JSON, loads it into the document store, and
    triggers a viewport-only document build (no DAGMC or FEM mesh export).
  - Document commands: `nuke.cad.newDocument`, `nuke.cad.saveDocument`,
    `nuke.cad.saveDocumentAs`, `nuke.cad.newSketch`, `nuke.cad.exitSketch`, and
    `nuke.cad.openFeatureTree`.
  - The **Feature Tree** panel (`src/browser/widgets/feature-tree/`, widget ID
    `nuke-cad-feature-tree-widget`, label "Feature Tree") lists bodies, datums,
    sketches, and features in document order with selection, suppression toggle,
    edit, delete, build-status markers, and lightweight reference-resolution
    badges (`ambiguous`/`unmatched`) from the last rebuild. Boolean features show
    their target body and tool bodies inline. The panel supports inline rename
    for bodies and features, up/down reorder with dependency-precedence
    validation, and a cascade-delete policy that prompts when deleting a feature
    that later pattern/mirror features use as a `source`. A reference-repair
    popover lists resolution candidates with fingerprint comparison for each
    broken `TopologyRef` so users can pick a replacement or leave the reference
    unmatched for manual repair.
  - The **Edit Parameters** flow reopens the feature-creation dialog for an
    existing feature, prefilled with its current parameters, and updates the
    document on confirmation.
  - **Export Python** writes a deterministic, one-way build123d-ish script from
    the current `.nuke-cad` document using `src/common/python-codegen.ts`. The
    export is a lossy starting point, not a round-trip format, and the output is
    saved through the Theia file dialog and `FileService`. Emission mirrors the
    backend's semantics (`feature_builder.py` / `sketch_builder.py`): arcs
    become `bd.CenterArc` with a signed degree sweep (document angles are
    radians), revolve uses `revolution_arc`, pattern counts include the
    original with full/partial circular sweeps stepped `360/count` resp.
    `angle/(count-1)`, pattern/mirror instances transform a re-derived source
    solid (never the sketch), boolean tools are combined before the operation,
    and contained sketch profiles (any nesting depth) are holes emitted with
    `bd.Mode.SUBTRACT` — matching the backend's outer/inner-wire pairing.
    Topology-reference-dependent items (face datums, external geometry,
    fillet/chamfer edges, draft/shell faces, hole placement) are emitted as
    `# TODO(manual):` comments, never silently dropped.
- Viewport picking for sketch-on-face and external geometry:
  - The **Sketch Plane** picker exposes an **On Face…** button that puts the
    viewport into face-pick mode. Hover highlights the candidate face; a click
    creates a `face` datum and enters sketch mode on it. Right-click or Escape
    cancels the pick.
  - Inside sketch mode, the **External Geometry** tool picks the most recent
    non-suppressed solid-producing feature as the reference target and enters
    face-pick mode. Clicking a face or edge of that body adds a `TopologyRef`
    to the active sketch's `externalRefs`; the resolved entity is projected into
    the sketch plane and rendered as dashed construction geometry after the
    next rebuild.
  - Face picking is handled by `src/browser/widgets/cad-viewport/face-picker.ts`
    (`raycastFace`, `buildTopologyRef`, `FaceHighlighter`). Edge picking for
    dress-up features is handled by `edge-picker.ts` (`raycastEdge`,
    `EdgeHighlighter`), which uses `THREE.Line` overlays and an edge topology
    map built from the viewport tessellation. The viewport builds one mesh per
    face and stores the geometric fingerprint in `userData`, so the pick path
    reads `userData.faceId` directly without reconstructing a triangle-to-face
    index; edge picks derive their fingerprint from the underlying curve data.
- The FEM service (`python/fem_service.py`) generates CalculiX `.inp` decks
  from gmsh `.msh` files, runs the external `ccx` executable (3600 s default
  timeout via the `ccxTimeout` request field, output streamed to
  `<stem>.ccx.log` with a 1 MB JSON tail), and converts FRD results to VTK.
  `ccx` is resolved from `NUKE_CCX`, `PATH`, or an explicit request path; it
  is not a Python package.
- The generic job runner (`python/job_service.py`) is the run-layer
  abstraction for solver hooks: declarative working directory, command,
  environment, artifacts, timeout, and log capture (request schema is
  documented in the module docstring). Timeouts and cancellation kill the
  whole process group. Local subprocess only today; SSH/container submit
  should keep the same request schema. The TypeScript backend mirrors this
  with a job registry and a `cancelJob(jobId)` RPC (process-group kill,
  one-hour default timeout, 1 MB output tail, remaining jobs killed on
  backend stop); the FEM panel's **Stop** button uses it.
- The mesh service (`python/mesh_service.py`) supports `engine='gmsh'`
  (default) and `engine='netgen'` with interface parity: per-region `meshSize`
  maps to `solid.maxh`, surface names become boundary-condition names, and the
  result converges into the same meshio-based report/Exodus/INP/VTK pipeline.
  The netgen path imprints: a shared gmsh load → `fragment` →
  `removeAllDuplicates` pass writes an imprinted BREP (a STEP round-trip
  re-duplicates shared faces; BREP preserves the imprint) that netgen meshes,
  so touching solids share one face; selector COM resolution runs in the same
  imprinted session. `order=2` produces real tetra10/triangle6 elements via
  netgen's `Mesh.SecondOrder()` with node-order remapping to the
  meshio/SEACAS canonical convention; `order > 2` clamps to 2 with a warning.
  Curved-boundary mid-nodes are netgen's best-effort projection (verified
  straight-edged only). The `.msh` artifact is gmsh-2.2 ASCII via meshio; a
  missing netgen install returns a structured error. Install netgen with the
  `ngsolve` pip wheel (pulls in netgen-mesher, which bundles its own OCCT
  7.8.1).
- The e2e layer lives in `tests/e2e/` (pytest, `@pytest.mark.e2e`): real
  full-pipeline runs such as the pincell DAGMC test (labeled build123d pincell
  → STEP → imprinted h5m → real OpenMC run asserting zero lost particles).
  Tests are env-gated on `NUKE_TEST_PYTHON` + `OPENMC_CROSS_SECTIONS` and must
  skip cleanly when unset.
- Coverage split: only the pure-logic Python modules (`region_manifest.py`,
  `job_service.py`) are measured in the `.coveragerc` ratchet; the
  OCC/gmsh/pymoab-bound pipeline modules (`geometry_service`, `dagmc_export`,
  `mesh_service`, `fem_service`, `foam_service`, `ocp_compat`) are omitted
  because they are only exercised in the full-dependency profile (docker
  in-image pytest step, `NUKE_TEST_PYTHON`) and would drag the gate down.
- The OpenFOAM service (`python/foam_service.py`) scaffolds solver-ready
  cases (controlDict, fvSchemes, fvSolution, transportProperties, and
  0/U/p/T field files) and exports per-solid STL files from a STEP file.
  STL export loads STEP in-module via `STEPControl_Reader` and the
  `ocp_compat` TopoDS downcast — there is no `cad_conversion` dependency.
  Heavy OCP/build123d imports are optional; the module stays importable
  without them.

## Work Guidance

- Follow repo style: 4-space indent, single quotes, no trailing commas.
- New source files carry the BSD-2-Clause header.
- Compact icon buttons in the CAD chrome must reset Theia's `.theia-button`
  defaults (`min-width: 65px`, 8px left margin) — the grouped reset lives in
  `cad-viewport.css`; add new compact button classes there or they render
  65px+ wide and overlap their neighbors.
- Geometry scripts must define a top-level `model` variable holding a
  build123d Part/Compound, CadQuery Workplane, or OCP TopoDS_Shape.
- Heavy Python imports must be guarded so the module stays importable in the
  minimal pytest profile (`pytest` + `numpy` only).
- Region manifest volume entries may include an optional `meshSize` number
  for per-region mesh refinement.
- Region manifest surface entries drive FEM boundary conditions in the FEM
  analysis panel; `name` is the selector used to bind loads and constraints.

## Verification

```bash
npx lerna run build --scope nuke-cad
yarn test:python   # includes nuke-cad tests/python and tests/e2e (e2e skips without env gates)
yarn lint
```

E2e runs require the full profile: `NUKE_TEST_PYTHON` pointing at an env with
openmc + the CAD toolchain, plus `OPENMC_CROSS_SECTIONS` for the model run —
see the root `AGENTS.md` coverage/e2e bullets.

Environment split for local testing: the dedicated `nuke` dev env
(`$HOME/.conda/envs/nuke`, conda-forge OCP stack: cadquery, build123d,
python-gmsh, meshio, netCDF4, vtk + pip openmc/moab/pydagmc) intentionally
excludes netgen — conda netgen and conda OCP register the same OCCT types
with pybind11 in one process ("type gp_Pnt is already registered!"), and the
pip `ngsolve` wheel dumps its own OCCT .so files into the env's `lib/`,
clobbering conda's occt. Netgen engine tests therefore need a pip-OCP env
(e.g. pip `cadquery-ocp` + pip `ngsolve`, which coexist fine).

## Child NAD Index

- None
