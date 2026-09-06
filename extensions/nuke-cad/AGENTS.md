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
  (version 3 today). Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. Future migrations register steps in `MIGRATIONS`
  and bump `NUKE_CAD_SCHEMA_VERSION`.
- Sketch solver adapter: `src/common/sketch-solver.ts` exports the solver-agnostic
  `SketchSolver` interface and the `PlanegcsSketchSolver` implementation. No
  other source file imports `@salusoft89/planegcs` directly. The dependency is
  pinned exact in `package.json`; vendoring the LGPL-2.0-or-later WASM is the
  documented fallback if the npm package stalls. Curve-level constraints
  (horizontal, radius, tangency, point-on-object, …) intentionally apply to
  lines/circles/arcs only; ellipses and B-splines accept point-level
  constraints on their points (center/focus/poles) but never curve-level
  ones, even though PlaneGCS has native ellipse/B-spline constraint types.
  Also available: axis-locked DistanceX/DistanceY, Diameter, and Block
  (freeze-in-place, recorded as plain fixes).
  Ellipse and B-spline evaluation for rendering, snapping, and codegen
  (analytic ellipse polyline, De Boor sampling, clamped-uniform knots) lives
  in `src/common/sketch-curves.ts`, shared by the browser sketch layer and
  `src/common/python-codegen.ts`.
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
  draft requires `faces`, `angle`, and a non-zero `pullDirection`, with an
  optional `neutralPlane` face ref; shell
  requires `thickness` and an optional `faces` list (empty means hollow all
  faces). The viewport enters an edge-pick or face-pick mode when a dress-up
  dialog asks for references; hover highlights the candidate and a click adds
  the reference to the dialog list. The same-body additive overlap check is
  intentionally left untouched — dress-ups modify an existing body rather than
  create new material.
- Pattern, mirror, and hole features (`linearPattern`, `circularPattern`,
  `mirror`, `hole`) extend the same-body feature chain. Patterns and mirror name
  a `source` solid-producing feature (`pad`/`pocket`/`revolve`/`groove`/
  `sweep`/`pipe`/`loft`/`helicalSweep`) on the same body, earlier in document order. The backend stores
  the source's tool shape and applies transformed copies: additive sources are
  merged with a boolean union so overlapping pattern instances fuse into one
  solid (required for toroidal/poloidal coil assemblies), subtractive sources
  are cut. `linearPattern` uses `count`, `spacing`, and either `axis` or
  `axisDatumId` (mirrors circular, `line2Point` datums included; plane-datum
  normals accepted); `circularPattern`
  uses `count`, optional `angle`, and either `axis` or `axisDatumId`
  (`axisDatumId` also accepts `line2Point` datums); `mirror`
  uses either `plane` (`XY`/`YZ`/`XZ`) or `planeDatumId`. All three pattern
  types take an optional per-instance `scale` about each instance's bbox
  center (default 1). `multiTransform` chains two same-body pattern/mirror
  sources (`first`, `second`, document-ordered) over the cartesian product
  of their instances. Face datums behind
  `axisDatumId`/`planeDatumId` resolve against the referenced feature's
  historical shape (same scope as sketch datums), while the hole placement
  face resolves against the pattern/hole body's current B-rep. The hole wizard
  stores a single feature record with a face `TopologyRef` and a center
  `[u, v]` in the resolved face's workplane coordinates; the backend expands it
  internally into an extrude-cut plus optional counterbore/countersink
  geometry. Omitted `depth` means through-hole; counterbore, countersink, and
  counterdrill are mutually exclusive, with optional `taperAngle`, a blind-only
  `drillPointAngle` (omitted = flat, as before), and a `thread` preset
  (`none`/`cosmetic`/`modeled`): `cosmetic` stays stored-only, `modeled`
  cuts a real ISO thread (pitch/tap from `fastener_data` by hole diameter)
  as a helical cut on blind simple holes only. `defeature` deletes named faces. `sweep` sweeps a sketch section along a document curve
  (`pathCurveId`); `pipe` sweeps a circular section of a given `radius` along a
  document curve. Both support `frenet`/`fixedBinormal` orientation (with a
  non-zero `binormal` required for the latter), auto-position the section at
  the path start, are additive-only, and are built with
  `BRepOffsetAPI_MakePipeShell`. Closed-spine paths (`BRep_Tool.IsClosed_s` on
  the spine wire) are the exception: the PipeShell tube's periodic-seam edges
  carry meter-scale tolerances that degrade the solid to bare faces on STEP
  round-trip, so closed-spine sweeps are rebuilt as station lofts
  (`_closed_spine_sweep_solid` — corner sections loft through ring-sampled
  station wires, circular sections through analytic circle stations) and must
  pass `_require_single_valid_solid`; open spines keep the PipeShell result
  (`_pipe_shell_result`, with a `ShapeFix_Shape` repair fallback when
  `MakeSolid` fails). `pipe` has no `sketchId`. `loft` joins two or
  more ordered sketch sections (`params.sectionSketchIds`; `FeatureDef.sketchId`
  stays unset) into a single solid with `BRepOffsetAPI_ThruSections`; sections
  are used as positioned on their datums (no auto-positioning), must be single
  profiles without inner loops, and `ruled=true` builds a straight skin between
  sections (a ruled failure suggests `ruled=false`). `helicalSweep` sweeps a
  sketch section along an analytic helix derived from params (`axis` `X`/`Y`/`Z`,
  positive `startRadius`/`pitch`/`turns`, optional `leftHanded`); the helix is
  fitted through `curve_builder`'s interpolation path and fed to the sweep
  machinery, so the section auto-positions at the helix start, the
  `_spine_min_radius` self-intersection pre-check applies, and the default
  orientation is `fixedBinormal` locked to the axis unit vector. Loft is
  additive-only; helicalSweep takes an optional `subtractive` flag (default
  additive). Both are pattern/mirror-source eligible, and store
  their tool shape in `tool_shapes`, like sweep. A section-sketch edit dirties
  the loft exactly like a sketch edit dirties a pad: the backend rebuilds
  sketches on every build, and `_compute_implied_dependencies` additionally
  orders a loft after the features its section sketches reference through
  topology (face datums, external geometry). Frontend-side the same rule holds:
  `computeDependsOn` (loft/helicalSweep are solid producers),
  `CadDocumentStore.deleteSketch`'s dependent guard, and
  `findConsumingFeature` in the sketch overlay all honor
  `params.sectionSketchIds` in addition to `sketchId`, mirroring the backend's
  `_feature_sketch_ids`. The sweep/pipe
  dialogs pick the path curve from a dropdown or a viewport curve-pick mode
  (click-through banner, hover highlight, right-click/Escape cancel; picks are
  guarded against deleted curves by `resolveCurvePick`), and offer an optional
  ghosted preview: every feature dialog offers it via a `previewEnabled`
  checkbox driving a debounced (~300 ms) `FeaturePreviewRequest`; the widget
  assembles a tentative mini-document (`buildFeaturePreviewDocument`) through
  the normal geometry-service path and renders the tessellation faces in a
  dedicated `cad-preview` scene group with the ghost (x-ray) opacity;
  preview failures clear the preview silently. Solid producers
  (pad/revolve/sweep/pipe/loft/helicalSweep/primitive) build standalone on a
  fresh `preview-body`; modifiers (pocket/groove/dress-up/hole/boolean) pull
  the referenced bodies' FULL feature chains (to a fixpoint, so cross-body
  booleans never replay against an empty tool body) and retarget the draft
  onto the real body, so TopologyRef fingerprints resolve against identical
  geometry. Blind ends, angles, and validated numerics preview; non-blind
  extrude ends and invalid drafts show the validator reason as hint text
  with no preview. Costly chains simply hit the backend timeout and clear
  per the contract. The
  same preview machinery serves all dialogs
  (`sweep-pipe.ts` stays the single home for the draft validators, the section
  reorder helper, the closure collector, and the preview-document builder): the loft dialog picks an
  ordered section list in-dialog (no selected-sketch guard, like pipe) with
  per-row remove and up/down reorder, and the helicalSweep dialog derives the
  path from axis/startRadius/pitch/turns with the fixed-binormal vector
  prefilled to the axis unit.
  Subtractive features (pocket/groove/hole) whose tool is disjoint from the
  body fail with a clear "does not intersect" error instead of a silent no-op
  success.
- The same-body additive overlap check for single sketch features remains in
  `_combine_additive`; overlapping additive pattern instances are fused by the
  boolean union in `_apply_pattern_or_mirror` instead. When the body and every
  additive instance are pairwise bbox-disjoint the union equals their plain
  compound exactly, so `_pattern_instances_are_disjoint` skips the fuse in
  favor of a flat `Compound` of all solids (touching counts as intersecting
  → conservative fuse; subtractive cuts always run sequentially). Otherwise
  one parallel `BRepAlgoAPI_Fuse` (`_pattern_parallel_fuse`: Arguments=body,
  Tools=instances, RunParallel + NonDestructive) is tried first — measured
  ~1.5× the sequential loop on the tokamak TF pattern, slower on trivial
  boxes — with the sequential loop kept verbatim as the fallback.
- Cross-body overlap is reported as a warning (with overlap volume) rather than
  a fatal error. Pure CAD assemblies such as the tokamak demo intentionally
  contain overlapping parts, so the B-rep build completes and callers that
  need a sealed model can inspect `result["warnings"]` before DAGMC export.
  `geometry_service.build_document` forwards the builder's `warnings` and
  `consumedBodies` to the RPC response (`GeometryBuildResult.warnings` /
  `consumedBodies`), and the viewport surfaces the warnings in a dismissible
  strip in the viewport chrome. For document models the Model Outline's
  warnings box offers a one-click **Fuse** auto-fix per overlap warning
  (appends a `booleanFuse` merging the pair, then rebuilds); assemblies that
  overlap intentionally can simply keep the warnings.
- Pad/pocket take an `end` condition (`blind` default, `upToFirst`/`upToLast`/
  `upToFace`/`upToBody`/`throughAll`) with optional `twoSided` (splits `length` like
  `symmetric`; combining either with a non-blind end is a validation error).
  A missed end fails with the existing "does not intersect" error. `upToBody`
  names another body whose nearest/farthest extent along the direction
  terminates the extrusion (same ray-extent machinery as upToFirst/Last).
  `angle` on pad/pocket stays schema-accepted but unimplemented: the
  builder fails it with an explicit "not yet supported" error rather than
  silently ignoring it. Revolve/groove take `end` `blind` (default) or
  `throughAll` (profile slab fused over ±body-bbox-diagonal along the sketch-plane
  normal); the full UpTo set stays pad/pocket-only.
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
  is active. Pressing `Q` inside the viewport opens a transient context shortcut
  bar anchored at the cursor: sketch tools when a sketch session is active,
  feature-creation actions otherwise; it closes on click, Escape, or pointer
  leaving the viewport. Right-clicking the canvas (no pick mode, no sketch
  session) opens the viewport context menu instead of the browser default:
  on a solid it offers Edit Feature… (attributed through the solid's body id
  to the latest non-suppressed feature writing that body — a pattern fuse
  resolves to its tip feature; disabled when no feature matches, never
  guessed), the three measure tools, Fit to Solid, and Hide/Isolate Solid;
  on empty space it offers Fit All, Show All Solids (disabled when nothing
  is hidden), a Section View toggle, and Reset Explode (disabled at 0%).
  The shading and section popovers share one `openPopover` slot (never both
  open); picking a mode, pressing Escape, or clicking the canvas closes the
  open popover. It is imperative DOM
  (`viewport-context-menu.ts`: pure model + attribution, thin renderer;
  window pointerdown/Escape close), not a Theia ContextMenuRenderer.
  Viewport key handlers are scoped to the viewport: the container
  is focusable (`tabindex="-1"`, focused on pointerdown) and every window
  keydown handler early-returns unless the container contains
  `document.activeElement`, so Theia's own shortcuts keep working whenever
  focus is elsewhere. The tool-key handlers (`onKeyDown`, section Escape)
  additionally listen in the window CAPTURE phase: Theia's KeybindingRegistry
  matches keybindings (Escape → hide notifications among them) from a
  document-capture listener and stopPropagation()s the event, so bubble-phase
  tool keys were silently eaten while any notification was visible. Capture
  on window runs first; unclaimed keys still propagate to Theia. The context
  menu hands focus back to the container after dispatching an action, since
  the pressed button leaves the DOM with the menu. Closing the viewport widget also closes the Model Outline and
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
  top 64px, clear of the toolbar; view label at 64px) —
  at the toolbar's z-index the full-width toolbar would cover them. The view
  label (`cad-viewport-view-label`, imperative DOM) shows the active standard
  view (`User` after orbiting, `Top`/`Left`/... after snapping) or
  `Sketch — <name>` while sketching (`SketchModeController.getSketchName()`).
  Model colors are theme-adaptive (`viewport-colors.ts`): the face albedo
  follows `--theia-foreground` on dark themes but switches to a fixed steel
  tone on light editor backgrounds (a light theme's foreground is near-black
  and silhouettes the model), and edge lines flip from white to dark slate;
  theme changes re-color the loaded model live, and the initial scene colors
  re-read once after first paint so a freshly injected theme stylesheet is
  not stuck on the dark fallback (`applyThemeColors` at init + on theme
  change). The canvas background itself follows the `nukeCad.viewportBackground`
  preference (`theme` | `dark` | `light` | `gradient`, default `theme`):
  solid styles paint `scene.background`, while `gradient` clears it and shows
  a CSS backdrop behind a transparent renderer.
  The tessellation load path (`tess-reuse.ts` + `tess-parse.worker.ts` +
  `tess-parse-client.ts`): the `.tess.json` text parses in a Web Worker
  (webpack-5 native `new Worker(new URL(...))`, worker imports nothing Theia)
  and transfers back as typed arrays — transferring the parsed JSON object
  graph would cost about as much main-thread time as parsing it, while
  ArrayBuffer transfer is zero-copy and feeds `BufferAttribute` directly. If
  worker construction or transport fails, the client logs once and parses on
  the main thread; the feature degrades, never breaks. `buildModel` updates
  incrementally: faces are pooled by a content-based reuse key (the backend's
  geometric fingerprint when present, else a signature of the tessellated
  coordinates — never the process-salted `hash` field or the positional
  `solidId`/`faceId`) and unchanged faces keep their `BufferGeometry` across
  rebuilds while `userData` (solid/face/body identity) is re-derived from the
  new payload, because solid indices are positional and can shuffle. Edge
  lines and curves keep full teardown-rebuild (profiled small). Stage timings
  log behind `localStorage['nuke-cad-profile'] = '1'`.
  Shading is a single material-state authority: `setShading(mode)` accepts
  `shaded`, `shadedWireframe`, `edgesOnly`, or `xray`, and
  `setGhostOpacity(v)` tunes x-ray transparency; pure helpers live in
  `shading-modes.ts` and one `applyShading()` applies everything —
  the nav-cluster popover picks the mode; rebuilds re-apply mode and opacity.
  Materials are shared per shading role (body / selection highlight / edge
  lines / curve lines / preview ghost), not cloned per face: selection
  highlight swaps the shared material reference per mesh, and `applyShading`
  writes mode flags onto the shared materials directly. Edges-only hides face meshes and disables face/solid picking (hint pill);
  x-ray ghosts faces at the ghost opacity with edges opaque. A section plane
  (`setSection({axis, flip, fraction} | undefined)`, pure math in
  `section-plane.ts`) clips faces and edge lines via
  `renderer.localClippingEnabled`; it is visual only, slider-driven over the
  tessellation bounding box, exits on button/Escape, and survives rebuilds
  through the same `applyShading()` path. The measure tool (pure logic in
  `measure-tool.ts`) records viewport annotations from the
  document toolbar Inspect group or the sketch toolbar, in three modes
  (selector in the Measurements popover): point-to-point **distance**
  (raycast surface points in 3D, snap-aware sketch-plane points in sketch
  mode), three-click **angle** A→vertex B→C with overlay segments BA/BC and
  the label at B, and edge **radius** (model3d only — edge pick via
  `edge-picker.ts`; radius = mean polyline distance to the fingerprint
  center when present, else a Kasa least-squares circle fit in the best-fit
  plane from `radius-fit.ts`, rejecting non-circular edges with a status
  warning). Angle/radius capture is model3d-only; sketch mode always behaves
  as distance. All kinds render as
  overlay lines/spheres with imperative HTML labels projected in
  `renderScene`. Overlay updates must run BEFORE `renderer.render` inside
  `renderScene` (with a fresh `cam.updateMatrixWorld()`): render-on-demand has
  no next frame to correct a stale paint, so painting first flashes new
  measure markers at their initial unit scale. Measurements are viewport
  state (never document state) and
  clear on rebuild or sketch exit. The **explode view** slider (navigation
  cluster) is per-solid viewport-only state: `explode-view.ts` plans
  solidId → offset as `normalize(centroid − bboxCenter) · diagonal · factor ·
 EXPLODE_MAX_SPAN (0.35)` from vertex-averaged per-solid centroids (the cap
  keeps a 100% explode framed instead of flying a full diagonal per solid),
  and the widget applies it as mesh/edge-line `.position` transforms after
  every `buildModel` (transform only — the reuse pool, geometry, and picking
  are untouched; raycasts use world matrices; curve lines stay pinned at the
  origin). Factor 0 is the assembled model; the factor resets on
  reload/rebuild like measurements, and existing measurements stay world-
  anchored (NOT re-anchored to moved solids — the status hint reads
  `Explode N% — F to refit` while displaced). `fitView` frames
  the selected solid when `currentSelection.solidId` is set; `.` and
  double-click-on-solid also fit the selection; `Tab` toggles sketch mode
  (`handleToggleSketchMode`, guarded against pick modes, dialogs, and text
  fields). Selection highlighting is multi-solid aware:
  `CadSelection.solidIds` (Ctrl/Cmd multi-select in the Model Outline, or a
  Feature Tree body/feature click mapping to all of the body's solids)
  highlights every solid in the set; `solidId` stays the primary (properties
  panel, fit-to-selection). The Model Outline's hide/isolate actions publish
  a hidden-solids set through `NukeCadStateManager.setHiddenSolidIds` —
  viewport state, never document state; the viewport applies it in
  `applyShading` (face meshes and edge lines) and excludes hidden solids from
  every picking path (`pickableMeshes()` / `pickableEdgeLines()`; three.js
  never renders invisible objects but its raycaster still hits them, so the
  pick pool filters explicitly). Document curves have no solid of their own:
  `curve-visibility.ts` hides a curve exactly when every body consuming it as
  a sweep/pipe path is fully hidden (unreferenced curves always stay), applied
  in the same `applyShading` funnel, with hidden curves excluded from curve
  picking (`pickableCurveLines()`). The set clears on `setModel` because solid
  indices are positional and can shuffle between builds.
- The Model Outline panel (`src/browser/widgets/outline-panel/`, widget ID
  `nuke-cad-outline-panel-widget`, label "Model Outline") lists the active
  model's manifest volumes and surfaces (plus an ASSEMBLIES section with
  per-instance rows for assembly documents) and is read-only — no manifest editing
  UI. Picking syncs both ways through the shared `NukeCadStateManager`: row
  click highlights the whole solid in the viewport (Ctrl/Cmd-click toggles it
  in a multi-selection, pure helpers in `outline-interactions.ts`); a viewport
  pick selects the row, scrolls it into view, and expands its section. Each
  mapped row has hover actions to **Hide** (toggle its solids) or **Isolate**
  (hide all other mapped solids); a **Show all** button appears in the header
  while solids are hidden, and hidden rows render dimmed with an eye-closed
  marker. Opened via the
  `nuke.cad.openOutlinePanel` command (right shell area) or the Nuke Tools
  sidebar (`CAD Studio → Geometry`). The panel also renders, from the shared
  per-solid summaries (`SolidSummary` published to `NukeCadStateManager`
  after tessellation parse; pure helpers in `solid-summaries.ts`): a
  **Properties** section for the selected solid (volume, area, bbox size,
  center of mass, face/edge/triangle counts in model units, with a pin
  toggle) and a **Table view** toggle (sortable Solid/Body label/Volume/Area/
  Faces/Tris columns driving the same selection sync, Ctrl/Cmd-click
  multi-select included). Missing data renders
  as em-dashes so payloads from older builds stay readable. The panel's
  **Build warnings** box parses cross-body overlap warnings
  (`parseOverlapWarning`) and, when the model was built from an open
  `.nuke-cad` document containing both bodies, renders a **Fuse** button per
  warning that appends a `booleanFuse` feature (`buildFuseFeature`: target
  tip + tool tip as `dependsOn`, `keepTools: false`) and triggers a rebuild —
  script/STEP models have no document to fix and get no button.
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
  `nukeCad.viewportBackground` (string enum `theme`/`dark`/`light`/`gradient`,
  default `theme`) chooses the 3D canvas backdrop; `gradient` is a CSS
  backdrop behind a transparent renderer.
  `nukeCad.navigationStyle` (`orbit`/`solidworks`/`tinkercad`/`touchpad`,
  default `orbit`) remaps OrbitControls button tables (`navigation-styles.ts`,
  re-applied after every controls re-creation); right-click menus work in
  every style, and modifier-key styles stay out (OrbitControls has no
  modifier layer).
  `nukeCad.rebuildOnEdit` (string enum `auto`/`manual`, default `auto`)
  gates edit-triggered rebuilds: `manual` marks the model stale (banner +
  Rebuild button) instead of rebuilding; opening a document always builds,
  and plain Save never builds.
  `nukeCad.resultCacheSizeMB` (number, default 1024, minimum 1) caps the
  `<stem>.nuke-cache.zip` sidecar before LRU eviction; the widget threads it
  as `sizeCapMB` on every partial call.
- Drawings are an additive `drawings: DrawingSheet[]` block on the `.nuke-cad`
  document (v3, no migration, never cached in the zip). `python/drawing_service.py`
  projects exact B-rep linework with OCP `HLRBRep_Algo`/`HLRToShape` (never
  faceted approximations), cuts section views with a half-space box, and emits
  SVG natively plus DXF via optional `ezdxf` (PDF is deferred — no PDF writer
  in the env). Dimensions reference model `TopologyRef` fingerprints and
  recompute from 3D on every build (`stale: true` + last-good text on broken
  refs). Frontend: the **Drawing Sheet** widget (`nuke-cad-drawing-widget`,
  `nuke.cad.openDrawingSheet`, 2D SVG rendering, drag-to-place with 5 mm
  snap) drives the `buildDrawing` RPC on the shared backend interface; dirty
  drawing state never triggers a full rebuild. Dimensions are created by
  picking model edges in the 3D viewport (edge-picker broker → `addDimension`);
  face-on HLR views legitimately show 4 visible + 4 hidden box edges (depth
  edges degenerate) — only off-axis views show all 12.
- STEP/STP/BREP files open in nuke-cad by default (higher open-handler priority
  than nuke-visualizer); the geometry service reads them through OCP and runs
  the same tessellation pipeline as script builds. IGES/BREP/glTF read-write,
  glTF write-only (this OCP has no CafReader read API), and STL export ride
  the same path (IGES import sews loose faces into shells first); OBJ/PLY
  and open-handler priorities are untouched. The `.py` open-handler
  priority is 50 — below the text editor's 100 — so Python files open in the
  editor by default and reach the CAD viewport via **Open With…**.
- Assemblies build on the mate-connector foundation (`src/common/assembly-document.ts`
  - `assembly-placement.ts`, frozen spec): instances with placement overrides,
    connectors as named frames, one mate per part pair, explicit grounded
    instance, closed-form placement (`R = Ra·Rbᵀ`) and DOF counting per mate
    type. `python/assembly_builder.py` resolves parts (same-doc body →
    `.nuke-cad` path → STEP/IGES/BREP file), solves placements BFS from ground
    (computed at build, never written back), and `build_assembly()` reuses
    `_process_shape` with `<instanceId>/<bodyLabel>` selectors; STEP export
    uses an OCAF product structure, DAGMC reuses the imprint path with overlap
    as a warning. Schema carries one additive optional `assembly` field (v3,
    absent = single-part, byte-identical). The viewport renders per-instance
    `THREE.Group`s sharing source-face BufferGeometry (reuse key
    `<sourcePath>#<bodyId>::<faceFingerprint>`); the mate dialog + connector
    pick mode mirror the dress-up pattern; grounding is explicit-only; the
    **BOM** panel (`nuke-cad-bom-panel-widget`, `nuke.cad.openBomPanel`) lists
    instance/source/mate/DOF rows with viewport selection sync; outline and
    tree carry assembly sections (read-only rule stands). `python/fastener_data.py`
    holds versioned ISO/UNC thread tables consumed by modeled-hole threading
    (pitch/tap by diameter) and later hole recognition.
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
  coincident model-model faces and causes DAGMC particle leaks. STEP export
  carries per-solid labels as product names plus deterministic face colors
  (OCAF writer when names exist, legacy writer otherwise); STEP import
  restores product names and keeps one object per solid for DAGMC. Before
  export, `inspection_gates.py` runs warnings-only mass-property and
  mesh-vs-CAD deviation checks, reported as `result["inspectionGates"]`.
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
- `.nuke-cad` document schema lives in `src/common/cad-document.ts` (version 3).
  Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. The document store
  (`src/browser/document/cad-document-store.ts`) holds the active document,
  performs immutable updates validated against the schema, tracks dirty state,
  sketch/feature selection, body selection, and per-feature build results.
  Sketch-local parameters are merged into document-level parameters when a sketch
  is saved.
- `.nuke-cad` v2 introduced **bodies** and **boolean features**; v3 adds a
  top-level **`curves`** array. Every solid feature (`pad`/`pocket`/`revolve`/
  `groove`, plus `sweep`/`pipe` which also reference a curve, `loft`/
  `helicalSweep`, `primitive` on a datum (optional `subtractive` flag), and `multiTransform` over
  two pattern/mirror sources) targets a body id;
  boolean features (`booleanFuse`/`booleanCut`/`booleanCommon`) consume one
  target body and one or more tool bodies. Bodies carry an optional `label`
  that maps to the region manifest / `selector_map` for DAGMC and mesh export.
  The v1→v2 migration creates a single implicit body for each legacy feature;
  the v2→v3 migration adds an empty `curves` array.
- **3D curves** are lightweight polylines stored in `curves`. Each curve has an
  `id`, `name`, `source` recipe, and `samples` array of `[x, y, z]` points.
  Sources may be `points` (explicit samples), `parametric` (expressions for
  `x(t)`, `y(t)`, `z(t)` sampled uniformly over `[tStart, tEnd]`), or `fourier`
  (cos/sin coefficients sampled over `[0, 2π)`). The expression mini-language
  lives in `src/common/expression.ts` (with a units layer — `Quantity`,
  per-operator unit rules, coercion — active wherever a document declares
  `units` (`mm`/`cm`/`m`; absent = legacy unitless, and the unit-less
  sampler path rejects unit syntax rather than folding it); the document
  store resamples parametric and Fourier curves when they are added or
  edited, coercing each coordinate to the declared unit, and dimension
  labels carry the unit suffix. The document toolbar's units dropdown writes
  `document.units` through a `setUnits` store mutation (tag-only — existing
  numbers are never rescaled). STEP/IGES imports read the file length unit:
  unset targets adopt it, mismatches scale geometry by the exact factor
  (reported in the import message); BREP carries no unit metadata and is
  never scaled. Closed curves repeat the
  first sample exactly at the end of `samples` — the Fourier sampler always
  does this (the series is periodic) and the parametric sampler does it when
  the expressions meet at both ends — so the backend's proximity check marks
  the wire closed. Curves are rendered in the
  viewport as line segments, listed in the Feature Tree under a **CURVES**
  section, and exported to Python as `bd.Spline` calls. The Python backend
  (`python/curve_builder.py`) fits B-spline wires: `points` sources are
  approximated with a tolerance derived from sample spacing, while parametric
  and Fourier sources are interpolated; closed curves are detected from
  first/last sample proximity relative to the average sample spacing and built
  as periodic wires.
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
    screen projections would overlap; a dragged label pins a session-scoped
    screen offset that survives zoom/pan and opts out of auto-shift),
    parameters panel, external-geometry
    reference list, carbon-copy button (imports the Feature-Tree-selected
    sketch with fresh ids), transform group (move/copy/rotate/mirror gesture
    tools plus scale/array/offset inline popovers and immediate join; the
    offset popover carries an auto-trim checkbox, miter-join, default on),
    remove-redundants button (session fixpoint),
    diagnostics popover (with reference-resolution status,
    conflicting/redundant/partially-redundant tags, missing-coincident and
    open-profile validator warnings, and a fully-constrained flag), and
    status line (leads with `Click: select · Ctrl+Click: multi-select / relations
· Q: shortcut bar · Del: delete · Esc: clear` while the Select tool is active
    and no constraint pick is in progress). Sketch tools have single-key shortcuts
    (S select, L line, C circle, A arc, R rectangle, P point, E ellipse, B
    B-spline, O slot, T trim, X extend, D split, J sketch-fillet, K sketch-chamfer,
    W polyline, Y polygon, U arc-slot, V move, G copy, I rotate, N mirror;
    M cycles tool modes — rectangle corner/center/rounded, polyline line/arc,
    polygon sides; guarded against pick modes, dialogs, measure, text fields,
    and modifier keys), and Escape falls
    through: dismiss auto-dimension / constraint popover, cancel in-progress entity,
    clear selection, return to the Select tool. The B-spline tool finishes on
    Enter or double-click (`SketchSession.finish()`, committing at two or more
    poles) and a lone pole is discarded. The ellipse tool rejects an equal-radius
    third click (that would be a circle) and clamps a minor radius above the
    major radius, reporting both through the transient `SketchStatus.hint`
    status line. Ctrl+click selecting exactly two
    entities opens a constraint relation popover listing the valid geometric
    relations for the pair (`constraint-relations.ts`). The auto-dimension
    preference (`nukeCad.sketchAutoDimension`, default false) shows an inline
    value input after completing a line, circle, or arc; Enter creates a driving
    dimension, Escape dismisses. A keyboard cheat-sheet popover on the toolbar header
    lists the bindings. The sketch toolbar is a floating draggable panel: drag by its
    header (or the collapsed toggle), right-click/double-click for Reset
    Position; the dragged position persists across collapse/expand. Dragging
    is shared, not per-panel: `draggable-panel.ts` owns the hook
    (`useDraggablePanel`), the header-region gates, and `clampPanelPosition`
    (panels stay inside the canvas; a 32px header sliver stays reachable when
    the panel exceeds it). The toolbar, Parameters, Solver Diagnostics,
    External Geometry, Keyboard Shortcuts, and Measurements panels all drag
    by their headers with the same reset grammar; the feature-creation modal
    also drags by its NukeDialog header (double-click/right-click resets,
    clamped to the viewport), while the dimension value popover stays
    anchored. The toolbar body is a
    grouped two-column grid (draw / modify & constraint / lists) with
    `active`-state tool buttons (accent background via the
    `.theia-button.secondary`-beating specificity rules in cad-viewport.css). Exiting
    sketch mode is the labeled **Finish Sketch** pill at the top-right of the
    viewport (the constraint bar owns top-center). Dimension labels are
    session-state draggable: a dragged label pins a screen-space offset that
    survives zoom/pan and opts out of the auto-deconflict shift; offsets die
    with the sketch session or the dimension. The chrome builds on the shared
    nuke-essentials components
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
  - `ellipse`: `c_id` (alias `centerId`), `focus1_id` (alias `focus1Id`),
    `radmin`. Stored the way PlaneGCS models it: the focus sets the major-axis
    direction and focal distance, so the major semi-axis is
    `sqrt(radmin² + |c − f1|²)` and `radmin` is the minor semi-axis.
  - `bspline`: `pole_ids` (alias `poleIds`), `weights`, `knots`, `mult`,
    `degree`, `periodic`. Control-polygon form with OpenCASCADE compressed
    knots; the invariant is `sum(mult) == len(pole_ids) + degree + 1`
    (clamped non-periodic). Only unit weights and `periodic: false` are
    buildable; clamped knots make the curve interpolate the first and last
    pole, so those poles double as wire endpoints.
- `.nuke-cad` document build path (headless backend):
  - `python/sketch_builder.py` consumes the solved sketch primitives stored in
    the document and emits build123d `Face` objects on the sketch datum plane.
  - `python/feature_builder.py` executes `pad`/`pocket`/`revolve`/`groove`,
    `sweep`/`pipe`/`loft`/`helicalSweep`, `primitive`, pattern (`linearPattern`/
    `circularPattern`), `mirror`, `multiTransform`, `defeature`, and `hole`
    features in topological order over
    explicit `dependsOn` edges,
    maintaining a separate accumulated body per `body` id. Additive features
    combine into their target body; subtractive features cut from it.
    `booleanFuse`, `booleanCut`, and `booleanCommon` features merge tool bodies
    into a target body and optionally keep the consumed tools. Dress-up features
    (`fillet`/`chamfer`/`draft`/`shell`) apply build123d/OCP operations to the
    accumulated body after resolving their edge/face `TopologyRef`s against the
    body's current B-rep. Pattern/mirror features resolve their `source` feature
    and transform copies of its stored tool shape; the hole wizard resolves its
    placement face and expands the record into an extrude-cut plus optional
    counterbore/countersink geometry. Sweep/pipe features read their path wires
    from the curve results passed into `build_document_shape` (curves are built
    before features in `geometry_service.build_document`); loft builds its
    sections through the sketch-face pipeline as positioned and
    helicalSweep derives its helix wire from params. Features targeting a
    body consumed by a boolean feature are marked `stale` (the guard applies
    uniformly to dress-up, pattern/mirror/hole, and sketch-solid features).
    Cycles are rejected with a readable member list.
  - `python/curve_builder.py` fits a B-spline wire through each curve's stored
    sample polyline. `points` sources are approximated with a tolerance derived
    from sample spacing; parametric and Fourier sources are interpolated.
    Closed curves are detected from first/last sample proximity and built as
    periodic wires; the result is included in the tessellation output as a
    `curves` array alongside solids.
  - `geometry_service.py` exposes `build_document()` plus a `--from-document`
    CLI flag; it validates references lightly, builds any curves, runs the
    feature builder with the curve results, and reuses `_process_shape` verbatim
    so STEP/tessellation/DAGMC/mesh artifacts match script builds.
  - Document builds go through the P2 result cache: `build_document_partial`
    executes only the TS-planned dirty closure and restores clean
    predecessors from the `<stem>.nuke-cache.zip` sidecar (per-feature BREP
    blobs + tool shapes + boolean meta, `python/doc_cache.py`); a document
    open with an empty dirty set restores everything and only tessellates.
    Any miss executes that feature, so an empty cache is exactly a full
    build. Full `build_document` calls never touch the sidecar. Two
    self-consistent key systems, never compared across languages: TS keys
    back the in-session memory cache, C1 content keys back the zip (sketch
    params, external refs, the datum table, and document order are key
    inputs on both sides). Per-feature tessellation rides the same sidecar as
    a doc-level `tess` blob in the manifest section, keyed by doc-hash
    (`store_tess`/`lookup_tess`, `python/doc_cache.py`): a hash hit restores
    shapes and skips meshing (reported via `tessCacheHit`), while any miss
    re-tessellates. `nukeCad.resultCacheSizeMB` caps the zip size before LRU
    eviction.
  - Datum support includes `XY`/`YZ`/`XZ`/`offset`/`face`/`threePoint`/
    `midplane`/`line2Point`. `offset` datums are
    interpreted as offsets of the XY plane along +Z. `face` datums resolve a
    referenced planar face by fingerprint, derive a deterministic workplane from
    its origin/normal, and apply an optional `offset` along the normal; a
    non-planar resolved face is a clear build error. `threePoint` builds the
    plane through three points, `midplane` the plane midway between two
    resolved planar faces (normal face1→face2, ~1° parallelism tolerance),
    and `line2Point` is an axis for `circularPattern.axisDatumId` only —
    sketch placement on it is a validation error. The frontend derives the
    same planes client-side (`sketch-math.ts`) so sketch entry needs no build.
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
    `nuke.cad.openFeatureTree`. `newDocument` opens a compact template picker
    (`DOCUMENT_TEMPLATES` in `src/common/document-templates.ts`) that merges the
    chosen preset's parameters over an empty v3 document; "Empty document" preserves
    today's behavior. Save/Save-As enforce the `.nuke-cad`
    extension: the dialog defaults to it and the chosen path is normalized
    through `ensureNukeCadExtension` (`cad-save-path.ts`) before writing.
  - The **Feature Tree** panel (`src/browser/widgets/feature-tree/`, widget ID
    `nuke-cad-feature-tree-widget`, label "Feature Tree") lists bodies, datums,
    sketches, features, and curves in document order (plus Instances and Mates
    sections for assembly documents) with selection, suppression
    toggle, edit, delete, build-status markers, and lightweight reference-resolution
    badges (`ambiguous`/`unmatched`) from the last rebuild. Clicking a body or
    feature row also highlights the body's tessellated solids in the viewport
    (via `NukeCadStateManager`, mapping `bodyId` through the shared
    `SolidSummary` list); a no-op while the body has no built solids. Boolean
    features show
    their target body and tool bodies inline. The **CURVES** section lists each
    curve row with inline rename/delete and a dialog (`curve-dialog.tsx`) for
    editing the source recipe; selecting a curve highlights its polyline in the
    viewport. The panel supports inline rename for bodies, features, and curves,
    up/down reorder with dependency-precedence validation, and a cascade-delete
    policy that prompts when deleting a feature that later pattern/mirror
    features use as a `source`. A reference-repair popover lists resolution
    candidates with fingerprint comparison for each broken `TopologyRef` so
    users can pick a replacement or leave the reference unmatched for manual
    repair.
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
    solid (never the sketch; primitive sources re-derive exactly like
    sketch-based ones, multiTransform still hatches), boolean tools are combined before the operation,
    and contained sketch profiles (any nesting depth) are holes emitted with
    `bd.Mode.SUBTRACT` — matching the backend's outer/inner-wire pairing.
    Ellipses become `bd.Ellipse(x_radius, y_radius, rotation=deg)` under
    `bd.Locations(center)`. B-spline segments keep their authored control
    polygon: loops containing one are emitted as an explicit
    `bd.make_face([...])` edge list (no `bd.BuildLine` capture) using the
    module-level `_bspline_edge` helper (raw OCP `Geom_BSplineCurve`), because
    `bd.Spline` interpolates through points and cannot express control-polygon
    curves; periodic or non-unit-weight B-splines degrade the sketch to
    `# TODO(manual):`. The helper is emitted once after the imports whenever
    any non-construction B-spline exists.
    Curves are emitted as `bd.Spline` calls over their sample point lists,
    before the bodies/features blocks (sweep/pipe reference the curve vars).
    Sweep/pipe features emit `bd.sweep(...)`: the section is repositioned to
    the path start via a `bd.Plane` built from the curve's start point and
    tangent (`fixedBinormal` orientation adds a binormal-locked `# TODO(manual):`
    escape hatch), and pipe sections are `bd.Circle(radius)` faces. Loft
    features emit `bd.loft([<section fn>()...], ruled=...)` in section order
    (an unbuildable section — e.g. a face datum — degrades the whole feature
    to `# TODO(manual):`), and helicalSweep features emit
    `bd.Helix(pitch, height=pitch*turns, radius, direction, lefthand)` as the
    path plus the same `_sweep_plane` + `bd.sweep(...)` emission as sweep.
    Topology-reference-dependent items (face datums, external geometry,
    fillet/chamfer edges, draft/shell faces, hole placement) are emitted as
    `# TODO(manual):` comments, never silently dropped.
- Viewport picking for sketch-on-face and external geometry:
  - The **Sketch Plane** picker exposes an **On Face…** button that puts the
    viewport into face-pick mode. Hover highlights the candidate face; a click
    creates a `face` datum and enters sketch mode on it. Right-click or Escape
    cancels the pick. All pick-mode banners (datum, external geometry,
    dress-up, hole, sweep/pipe curve) are click-through (`pointer-events: none`
    except their Cancel button) so faces under the banner stay pickable.
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
  for per-region mesh refinement, plus optional `materialId`/`parentId`
  physical-model UUIDs (additive; the nuclear sidecar stays keyed by
  `material`/`name`) and a per-body `default` entry with copy propagation
  (`parentId` ← default's `materialId`); openmc-studio's nuke-cad import
  surfaces these as `materialLinks` and stamps them onto placeholder
  materials as copy provenance.
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
see the root `AGENTS.md` coverage/e2e bullets. The W7X-scale performance
measurement (`tests/e2e/test_w7x_performance.py`) is additionally opt-in via
`NUKE_CAD_W7X_PERF=1` (the x50 build takes tens of minutes);
`NUKE_CAD_W7X_PERF_COUNT` overrides the pattern count for partial runs.
The W7X demo gate (`tests/e2e/test_w7x_dagmc_e2e.py` — patterned coil document
to imprinted DAGMC h5m, OpenMC fixed-source run with a zero-lost-particle
assertion, and a per-solid drift check against the developer-local reference
W7-X STEP) is likewise opt-in via `NUKE_CAD_W7X_GATE=1` (the x50 pattern fuse
takes ~45 min); `NUKE_CAD_W7X_GATE_COUNT` overrides the pattern count, and
`NUKE_E2E_W7X_STEP` gates the drift test (the reference STEP is
developer-local and never committed).

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
