# Changelog

All notable changes to NukeIDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- nuke-visualizer: **native 3D output viewers** — tracks, collision-track,
  weight-windows, and random-ray/voxel viewers now render directly in the
  IDE (three.js) with instant color-by/colormap switching and no per-viewer
  server; the trame server remains as an automatic fallback for files the
  native parser cannot read.
- nuke-cad: **lattice feature** — replicate a solid feature over a
  rectangular grid or hexagonal ring (2500-cell cap) with per-cell labels
  (`<prefix>_r<row>c<col>`) that flow into `selector_map` and DAGMC groups,
  fused through the standard pattern path and pattern/mirror eligible.
- nuke-cad: **DAGMC export robustness** — staged imprint with a reported
  stage log (fragment → dedup → capped tolerance-relaxed retry → model-only
  fallback → loud failure), sense errors naming surface + volumes + stage,
  additive `diagnostics`/`imprintStages`/`sealCheck` result keys, most-
  specific selector resolution (per-cell entries beat body-level), and a
  grouped diagnostics box in the Model Outline.
- nuke-cad: **in-CAD material tagging** — tag bodies with bare material
  names from the Feature Tree (undo-covered, no rebuild); tags merge into
  manifest volumes on every document build path, persist
  `<stem>.regions.json` beside the document, and reach openmc-studio as
  `materialLinks`. Explicit sidecar entries always win.
- nuke-cad: **fuse-path overlap check** now exits early (identical verdict,
  ~150 ms saved on ×50-scale checks); profiled W7X walls (sweep-station
  loft, GFOP variance) documented as outside the behavior-preserving
  surface.

- nuke-cad: **undo/redo** — the document store keeps snapshot history (depth 100) over committed mutations, with toolbar buttons and `Ctrl+Z` /
  `Ctrl+Shift+Z` / `Ctrl+Y` following the viewport key scoping rules.
  Granularity is one committed mutation per step; sketch strokes undo as a
  unit on save.

- nuke-cad: **assemblies** — multi-part documents with instances (same-doc
  bodies, `.nuke-cad` paths, STEP/IGES/BREP files), connector-frame mates
  solved closed-form from an explicitly grounded instance, per-instance
  viewport rendering with shared geometry, a mate dialog with DOF hints, a
  **BOM** panel with viewport selection sync, STEP-assembly export (one
  product per instance), and DAGMC export of the placed solids.
- nuke-cad: **drawings core** — single-sheet 2D drawings (A4/A3) with base,
  projected, section, and detail views from exact HLR linework, associative
  dimensions created by picking model edges in the viewport (stale-flagged
  on broken references), and SVG + DXF export. PDF export is deferred.

- nuke-cad: **extrude/revolve ends, subtractive tools, datum pattern axis,
  modeled threads, units, and offset auto-trim** — pad/pocket gain
  **up-to-body** termination; revolve/groove gain **through-all** ends;
  primitives and helical sweeps gain a **subtractive** option; linear
  patterns accept a **datum axis** like circular ones; holes gain a
  **thread** preset (`none`/`cosmetic`/`modeled`, modeled cuts a real ISO
  thread into simple blind holes); the document toolbar gains a **Units**
  dropdown (tags future inputs, never rescales); STEP/IGES imports read the
  file's length unit (adopted when unset, exact scaling on mismatch); and
  the sketch Offset popover gains **auto-trim** (miter-join, on by
  default).

- nuke-cad: **ellipse and B-spline sketch entities** — two new sketch tools
  join the toolbar: **Ellipse** (`E`, center → major-axis endpoint → minor
  radius) and **B-spline** (`B`, click control-polygon poles, finish with
  Enter or double-click). An equal-radius ellipse gesture is rejected with a
  hint pointing at the Circle tool, and an out-of-range minor radius is
  clamped with a hint. Both entities solve with the geometric solver, snap
  (center/end-pole/on-curve), render, serialize to the `.nuke-cad` document,
  rebuild through the headless Python backend, and export to Python. Ellipse
  and B-spline points accept point-level constraints (coincident, fix,
  distance, symmetry); curve-level constraints remain lines/circles/arcs
  only.
- nuke-cad: **explode view and measure angle/radius** — the 3D viewport
  navigation cluster gains an **Explode** slider (0–100%) that moves every
  solid away from the model center, faces and edge lines together, so fused
  multi-part bodies (e.g. a circular pattern) separate visually. It is a
  viewport-only transform — never written to the document, reset when the
  model reloads or rebuilds — and picking keeps working on exploded geometry.
  The measure tool (document toolbar Inspect group, Measurements popover) now
  has three modes: **Distance** (two points, as before), **Angle** (three
  clicks — A, vertex B, C — with overlay segments BA/BC and the angle label
  at B), and **Radius** (click a circular edge; reports radius and diameter
  from the edge's fingerprint center or a least-squares circle fit, warning
  on non-circular edges). All measurements stay viewport-only session state
  cleared after rebuild; with the explode slider raised, existing
  measurements stay at their original world positions (they are not
  re-anchored to moved solids).
- nuke-cad: **viewport context menu and draggable feature dialog** —
  right-clicking the 3D canvas opens a context menu instead of the browser
  default: on a solid it offers **Edit Feature…** (attributed through the
  solid's body to the latest feature writing it; disabled when no feature
  matches), **Measure Distance / Angle / Radius**, and **Fit to Solid**; on
  empty space it offers **Fit All** and **Reset Explode** (disabled at 0%).
  The feature-creation/edit dialog now floats like the sketch chrome: drag it
  by its header, double-click or right-click the header to reset its
  position. The `nuke.cad.editFeature` command palette entry now edits the
  feature selected in the Feature Tree when invoked without an id, and the
  Feature Tree shows the **Edit Parameters** pencil for boolean features too.
- nuke-cad: **result-cache rebuilds** — document builds now persist
  per-feature B-reps to a `<stem>.nuke-cache.zip` sidecar, so edits rebuild
  only the dirty closure (clean predecessors restore from blobs) and opening
  a cached document restores everything with only tessellation running; any
  miss safely executes that feature instead. Reorders, datum edits, and
  sketch-parameter edits all invalidate correctly. The in-session memory
  cache still covers same-session reopens with zero backend spawn.
- nuke-cad: **`nukeCad.rebuildOnEdit` preference** (`auto`/`manual`,
  default `auto`) — manual mode stops edit-triggered rebuilds and marks the
  model stale (banner + Rebuild button) instead, for documents where each
  rebuild is expensive; opening a document always builds, and plain Save
  never builds.
- nuke-cad: **tessellation cache + `nukeCad.resultCacheSizeMB`** — the
  result-cache sidecar now also stores a doc-level tessellation blob keyed
  by doc-hash, so cache-hit opens skip meshing entirely (reported via
  `tessCacheHit`); the new `nukeCad.resultCacheSizeMB` preference (default
  1024 MB, minimum 1) caps the sidecar size before LRU eviction and is sent
  on every partial build.
- nuke-cad: **extrude end-conditions** — pad/pocket dialogs gain an End
  selector (`blind` as before, plus first/last-face-hit, picked face, or
  through-all) with optional two-sided extrusion; a missed end fails with
  the existing "does not intersect" error instead of a silent no-op.
- nuke-cad: **datum-lite** — the Sketch Plane picker offers 3-Point planes,
  midplanes between two picked faces, and two-point line datums (pattern
  axes only); sketch entry derives the same workplanes client-side with no
  build round-trip.
- nuke-cad: **hole upgrade** — counterdrill preset, taper angle, blind-only
  drill-point angle (blank stays flat, existing holes unchanged), and a
  stored-only cosmetic thread flag.
- nuke-cad: **primitives, scale, multi-transform, defeature** — datum-placed
  box/cylinder/sphere/cone/torus features (no sketch needed,
  pattern-source eligible); per-instance scale on patterns/mirror; a
  multiTransform chaining two same-body pattern/mirror sources; face-delete
  defeaturing for pre-mesh cleanup; and an optional draft neutral plane.
- nuke-cad: **sketcher round** — Slot tool (`O`), PointOnObject,
  DistanceX/DistanceY, Diameter, and Block-freeze constraints; diagnostics
  now tag partially-redundant constraints and flag missing coincidents,
  open profiles, and fully-constrained state.
- nuke-cad: **navigation styles** — `nukeCad.navigationStyle` (`orbit` default,
  `solidworks`, `tinkercad`, `touchpad`) remaps viewport mouse/touch bindings
  so switchers keep their orbit habits; right-click menus work everywhere.
- nuke-cad: **document units** — `.nuke-cad` accepts `units` (`mm`/`cm`/`m`;
  absent stays legacy unitless); curve expressions coerce to the declared
  unit (`mm` doc: `10mm`→10, `1cm`→10, dimension mismatches error instead
  of silently numbering) and dimension labels carry the suffix.
- nuke-cad: **assembly foundation** — mate-connector assembly documents
  (instances, named frame connectors, one mate per pair, explicit ground)
  with closed-form placement and DOF counting (fixed/revolute/slider/
  cylindrical/ball/planar). Pure model layer; no UI or backend yet.
- nuke-cad: **exchange breadth** — IGES/BREP/glTF read-write (glTF write
  only on this OCP), STL export, IGES face-sewing import, STEP-style
  names/colors where formats support them. Plus versioned ISO/UNC thread
  tables for later hole recognition.
- nuke-cad: **sketch modify tools** — Trim, Extend, and Split (click with
  intersection math and constraint hygiene), 3-click sketch Fillet/Chamfer,
  chained Polyline with line/arc modes, rectangle corner/center/rounded
  modes, regular Polygon (3–12 sides), and 4-click Arc Slot, all on
  single-key shortcuts with M-key mode cycling; the diagnostics popover
  gains one-click redundant removal.
- nuke-cad: **sketch transform tools** — Move, Copy, Rotate, and Mirror
  gestures plus Scale, Rectangular Array, and Offset inline popovers and
  immediate Join, all operating on the selection with constraint hygiene.
- nuke-cad: **carbon copy + ellipse internals** — a sketch toolbar button
  imports the Feature-Tree-selected sketch (fresh ids, constraints and
  dimensions remapped); ellipses expose their second focus plus major/minor
  axis construction lines for constraining.
- nuke-cad: **exact Python export for primitive pattern sources** —
  patterns/mirrors over primitives re-derive the primitive instead of
  hatching (multiTransform still degrades honestly).
- nuke-cad: **expression units layer** — the mini-language enforces unit
  algebra (`10mm + 1cm`, angle-gated trig, convert-or-fail coercion); the
  unit-less document paths reject unit syntax until a document-unit
  convention lands, so existing behavior is unchanged.
- nuke-cad: **export fidelity** — STEP carries per-solid labels and face
  colors with one object per solid on re-import; region manifests accept
  physical-model UUIDs (surfaced on OpenMC import as copy provenance);
  warnings-only mass-property and mesh-vs-CAD deviation gates run before
  DAGMC export.
- nuke-cad: **`nukeCad.viewportBackground` preference** — the 3D canvas
  backdrop is now choosable: `theme` (default, follows the active Theia
  theme as before), `dark`, `light`, or `gradient` (a dark gradient backdrop
  behind a transparent renderer).

### Changed

- nuke-cad: **faster large-model rebuilds** — the tessellation payload now
  parses in a Web Worker off the UI thread and transfers to the viewport as
  zero-copy typed arrays, and the viewport scene update is incremental:
  unchanged faces keep their GPU geometry across rebuilds (keyed by content
  fingerprints, not process-salted ids) and materials are shared per shading
  role instead of cloned per face. On the ~59 MB tokamak display model the
  main-thread work of a rebuild drops from roughly one second to about
  0.2 s on a cold load and to a few tens of milliseconds when the geometry is
  unchanged; a new opt-in performance test
  (`NUKE_CAD_W7X_PERF=1`, `tests/e2e/test_w7x_performance.py`) profiles the
  W7X-scale 50-coil document.
- Workspace-scope settings now live in `<project>/.nuke-ide/` instead of
  Theia's default `<project>/.theia/` — nuke-essentials rebinds Theia's
  `PreferenceConfigurations`, so `settings.json` plus the tasks/launch/snippets
  sections are read from and written to `.nuke-ide/` (`.vscode` remains a
  secondary path). Projects configured through `.theia/settings.json` must move
  that file to `.nuke-ide/settings.json` once after updating.
- **Save Workspace As** defaults to a new `*.nuke-workspace` format (filter
  label "Nuke workspace") — nuke-essentials rebinds Theia's
  `WorkspaceFileService`. Existing `*.theia-workspace` and `*.code-workspace`
  files keep opening as before.
- nuke-cad: **compact, professional CAD viewport chrome** — the document
  toolbar is now icon-only (tooltips on hover) with a dedicated SVG icon for
  every feature type, and the duplicate `...` overflow menu is gone; the
  sketch toolbar uses purpose-drawn icons for each tool and no longer
  overlaps the constraint bar when collapsed; build warnings collapse to an
  expandable `N build warning(s)` summary instead of a tall always-open list;
  the Feature Tree, Model Outline, and CAD Viewport panels each got a
  distinct custom icon in tab bars and the Nuke Tools sidebar (previously
  three panels shared the same generic icon).
- nuke-cad: **New Document is disabled while a document is open** — it
  previously replaced the open document (and its unsaved changes) without
  confirmation; start a fresh document by closing the current one first. The
  feature-creation dialog and the Sketch Plane picker use an aligned
  label/input grid, and the Model Outline header is a compact single-line.
- nuke-cad: **sketch-mode usability round** — the sketch toolbar (and its
  collapsed toggle) is now draggable anywhere in the canvas; right-click or
  double-click it for **Reset Position**. Exiting sketch mode is a labeled
  **Finish Sketch** pill at the top-center of the viewport (previously an
  unlabeled check icon at the bottom of the toolbar). Dimension labels no
  longer overlap each other — colliding labels shift apart automatically.
  Also adds an **axis navigation gizmo** (top-right,
  mirrors the camera; click X/Y/Z or their negatives to snap views) and a
  **wireframe** shading toggle in the navigation cluster. Starting a sketch
  shows a "Starting sketch solver..." overlay while the solver loads instead
  of flashing back to document mode.
- nuke-cad: **viewport inspection polish** — a view label overlay (top-left)
  shows the current standard view or the active sketch name; the shading
  button now cycles **shaded → wireframe → edges-only**; fit (`F` or the nav
  button) frames the selected solid when one is active, double-clicking a
  solid selects and frames it, and `.` fits the selection; `Tab` enters/exits
  sketch mode.

### Fixed

- nuke-cad: **DAGMC export mesh floor raised to tolerance/10** — the gmsh
  minimum characteristic length was tolerance/100, letting curvature
  refinement emit needle facets (aspect >100:1, edges far below the requested
  faceting tolerance) that DAGMC ray firing intermittently misses; large
  models sporadically lost particles with "No intersection found" at birth
  or first crossing. The floor now stays within an order of magnitude below
  the tolerance (verified zero lost on a 12-coil W7X-scale model).
- nuke-cad: **viewport tool keys keep working while a notification toast is
  visible** — Theia dispatches matched keybindings (Escape is bound to hiding
  notifications) from a document-capture listener and stops the event there, so
  viewport keys like Escape (end the measure tool, cancel a pick, exit section
  mode), Enter, and the single-key tool shortcuts silently did nothing
  whenever any notification was on screen. The viewport's tool-key handlers
  now listen in the window capture phase, which runs before Theia's document
  listener, keeping their focus and text-field guards; keys they don't claim
  still propagate to Theia. Choosing an item from the viewport context menu
  also hands focus back to the viewport, so a tool activated from the menu
  responds to Escape immediately.
- nuke-cad: **viewport theme and overlap polish** — the viewport canvas now
  matches the active theme at first paint (the initial scene colors re-read
  after the first frame, fixing a dark canvas under a freshly applied light
  theme) as well as on every theme switch. Secondary buttons (Cancel/close/nav)
  are themed in all five NukeIDE themes (Theia's `secondaryButton.*` keys were
  only defined in the light theme, so the others fell back to Theia's default
  slate-navy). The bottom-center status pill no longer slides under the
  navigation cluster (capped width with ellipsis), measurement labels clamp to
  the viewport and stack apart when they collide, the sketch shortcuts popover
  no longer opens stacked on the measurements popover, and the sketch value
  input no longer covers the status line.
- nuke-cad: **viewport chrome UX round** — the shading and section popovers
  now share a single slot above the navigation cluster (opening one closes
  the other; picking a shading mode, pressing `Esc`, or clicking the canvas
  closes it), fixing the stacked/overlapping cards. The context menu gains
  **Hide / Isolate Solid** on solids plus **Show All Solids** and a
  **Section View** toggle on empty space. Explode is capped at 0.35× the
  model diagonal at 100% so large assemblies stay framed (previously a full
  diagonal per solid scattered the model out of view), and the status pill
  points at `F` to refit while exploded. The extrude dialog groups Length /
  Direction under Dimensions and Symmetric under Options via the shared
  `NukeSection` / `NukeFormRow` components, and the misaligned checkbox row
  is fixed.
- nuke-cad: **status pill no longer hides under the navigation cluster** —
  the bottom-center hint pill used a hardcoded clearance narrower than the
  cluster (notably with the Explode slider present), so long hints such as
  `Explode 100% — F to refit` slid underneath the buttons. The pill now caps
  its width from the measured cluster width (re-measured on resize) and
  ellipsizes instead.
- nuke-cad: **tokamak demo "pillar" defect fixed** — the six TF inner-leg
  pads were extruded one-sided, spanning z 0..1030 instead of ±515, so six
  thin columns stuck ~460 above the machine. The driver now pads them
  symmetric, the committed fixture is regenerated, and a new bbox regression
  test pins the legs at z ±515 (volumes and face counts are identical either
  way, so drift checks could not catch it).
- nuke-cad: **hidden bodies no longer leave their curves behind** — the
  Model Outline hide/isolate actions skipped document curves (which have no
  solid of their own), so hiding the copper body left its full centerline
  loop floating in an empty viewport. A curve now hides exactly when every
  body consuming it as a sweep/pipe path is fully hidden (unreferenced
  construction curves always stay), and hidden curves are excluded from
  curve picking the same way hidden solids are.
- nuke-cad: **pattern fuse skipped for disjoint instances** — additive
  pattern/mirror instances that are pairwise bbox-disjoint (the W7X coil set)
  no longer pay the sequential boolean union: the union of disjoint solids is
  exactly their compound, so the builder returns it directly. Overlapping
  instances still fuse as before, and subtractive cuts always run
  sequentially. Touching counts as intersecting (conservative fuse).
  Overlapping instances now fuse in a single parallel `BRepAlgoAPI_Fuse`
  (Arguments=body, Tools=instances) instead of a sequential pairwise loop,
  falling back to the loop on any failure — measured ~1.5× on the tokamak TF
  pattern with identical results.
- nuke-cad: **closed-loop sweeps/pipes now survive STEP export** — a sweep or
  pipe whose path curve is a closed loop (e.g. a coil centerline) previously
  produced a tube whose periodic-seam edges carried meter-scale tolerances;
  the solid looked valid in memory but degraded to bare faces on the STEP
  round-trip, so DAGMC export failed with "No volumes found in STEP file".
  Closed-spine sweeps are now rebuilt as station lofts (corner sections loft
  through ring-sampled station wires, circular sections through analytic
  circle stations), giving a STEP-durable solid; open-spine behavior is
  unchanged.

### Added

- nuke-cad: **loft and helical sweep features** — a **Loft** joins two or more
  ordered sketch sections into a single solid (sections picked in-dialog with
  up/down reordering, used as positioned on their datums; optional ruled skin),
  and a **Helical Sweep** sweeps a selected sketch section along an analytic
  helix derived from axis, start radius, pitch, and turns (optional
  left-handed winding; Frenet or fixed-binormal orientation, the latter
  prefilled to the axis direction). Both are additive-only, offer the ghosted
  **Preview** while editing, can be replicated by patterns and mirror, and are
  exported by **Export as Python** (`bd.loft(...)` / `bd.Helix(...)` +
  `bd.sweep(...)`).
- nuke-cad: **sweep and pipe features** — sweep a selected sketch section (or a
  circular pipe of a given radius, no sketch needed) along a 3D curve. The
  dialog picks the path curve from a dropdown or directly in the viewport
  (hover-highlight, right-click/Escape cancel), supports Frenet and
  fixed-binormal orientations, and offers an optional ghosted **Preview** that
  builds the tentative feature through the normal geometry pipeline. Sweep/pipe
  solids can start a new body or fuse into an existing one, patterns and mirror
  can replicate them, and **Export as Python** emits the corresponding
  `bd.sweep(...)` calls.
- nuke-cad: **ghosted preview in every feature dialog** — pad/pocket/revolve/
  groove/primitive/dress-up/hole/boolean dialogs offer the same ghosted
  **Preview** as sweep (blind ends and validated inputs only; the reason
  shows as hint text otherwise). Cuts, dress-ups, holes, and booleans preview
  against the referenced bodies' full feature chains with the draft retargeted
  onto the real body, so the ghost shows the operation on true geometry.
- nuke-cad: **Model Outline interactivity round** — `Ctrl`/`Cmd`-click rows
  (list and table view) to build a multi-selection; every selected solid
  highlights in the viewport while the last-clicked one drives the Properties
  panel and fit-to-selection. Hover actions on each volume row **Hide** its
  solids or **Isolate** it (hide all others), hidden rows render dimmed with
  an eye-closed marker, and a **Show all** button appears in the header while
  anything is hidden (hiding is viewport-only and resets when another model
  loads). Cross-body overlap warnings in the Build warnings box now carry a
  one-click **Fuse** fix for document models: it appends a `booleanFuse`
  feature merging the offending pair and rebuilds, clearing the warning.
  Feature Tree body/feature rows also highlight the body's solids in the
  viewport.
- nuke-cad: **viewport shading menu** — the wireframe toggle becomes a popover
  with four mutually exclusive modes (**Shaded**, **Shaded + Wireframe**,
  **Edges only**, **X-ray**) plus a **Ghost opacity** slider (15–60%) for
  x-ray. The active mode and opacity survive rebuilds; edges-only hides face
  fills (picking disabled with an on-screen hint) while edges stay opaque.
- nuke-cad: **measure tool** — click two points in 3D (surface pick) or in
  sketch mode (snap-aware plane points) to record persistent distance labels;
  a measurements list popover allows per-row deletion, entries are viewport-
  only annotations (never stored in the document), and they clear on rebuild.
- nuke-cad: **section plane** — a navigation-cluster button slices the model
  along an X/Y/Z plane with flip and a bounding-box slider; visual only,
  exports unaffected, exits via the button or `Esc`.
- nuke-cad: **solid properties in Model Outline** — selecting a solid shows a
  read-only properties section (volume, area, bbox size dx/dy/dz, center of
  mass, face/edge/triangle counts in model units) computed by the geometry
  service via OCP mass properties, with a pin toggle to freeze it while the
  selection changes.
- nuke-cad: **Model Outline table view** — the volume list gains a list ⇄
  table toggle with sortable Solid / Body label / Volume / Area / Faces /
  Tris columns (SI-suffixed model units) and two-way selection sync.
- nuke-cad: **sketch snap toggles** — a magnet toggle disables snapping for
  free placement and an S/M/L control sets the snap radius (6/12/24 px,
  session-scoped); the status line reflects the current snap state.
- nuke-cad: **context shortcut bar (`Q`)** — press `Q` in the viewport to open a
  transient cursor-anchored toolbar: sketch tools in sketch mode, feature-creation
  actions in document mode. Closes on click, `Escape`, or pointer leaving the
  viewport.
- nuke-cad: **constraint relation popover** — `Ctrl`+click selecting exactly two
  sketch entities opens a popover listing the valid geometric relations for the
  pair (coincident, parallel, perpendicular, equal, tangent, concentric); clicking
  a relation applies it through the existing constraint path.
- nuke-cad: **auto-dimension on entity creation** — new preference
  `nukeCad.sketchAutoDimension` (default false). When enabled, completing a line,
  circle, or 3-point arc opens an inline input to immediately create a driving
  distance or radius dimension; `Escape` dismisses without dimensioning.
- nuke-cad: **document templates on New Document** — **New CAD Document** now opens
  a compact picker with **Empty document**, **Pincell starter (cm)**, and
  **Tokamak starter (cm)** presets. The chosen template's parameters are merged
  over the empty v3 document; no template metadata is stored in the document.
- nuke-cad: **3D curves** — `.nuke-cad` documents now store a top-level `curves`
  array (schema v3). Curves can be defined by explicit points, parametric
  expressions (`x(t)`, `y(t)`, `z(t)`), or Fourier coefficients; the document
  store resamples parametric and Fourier sources on add/edit. Curves render as
  viewport polylines, appear in the Feature Tree under a **CURVES** section with
  inline rename/delete and a source editor dialog, and export to Python as
  `bd.Spline` calls. The Python backend (`python/curve_builder.py`) fits
  B-spline wires and includes them in the tessellation output. Curves whose
  endpoints meet (parametric/Fourier loops close automatically; a points list
  closes by repeating its first point) are detected as closed and built as
  periodic wires.

### Fixed

- nuke-cad: **the CAD viewport now adapts to light themes** — the model body
  previously used the theme foreground color, which is near-black in light
  themes and rendered the model as a silhouette on the light background, and
  the B-rep edge lines were always white (invisible on white). On light
  editor backgrounds the body switches to a mid steel tone and edges to dark
  slate; dark themes keep the established look. Theme switches re-color the
  loaded model live.

- nuke-cad: **giant circle over the model when using the measure tool** — the
  viewport painted the frame before updating the measure overlays, so the frame
  right after a click showed the marker spheres at their initial unit scale
  (one world-unit radius, larger than the whole model) and render-on-demand
  kept that stale frame until the next pointer move. Overlays now update before
  the paint, with the camera matrices refreshed first.

- **The startup splash screen now shows real loading progress instead of a
  timed animation** — the bar previously ran on fake random-timer stages and
  wiped itself after 15 seconds, leaving a blank screen (and a still-loading
  file tree) whenever the app was served over a slow connection. Progress now
  tracks actual events: bytes received while downloading the app (Resource
  Timing API, with live "N MB received" counts on slow connections), bundle
  execution, Theia attaching the workbench shell, and Theia's own reveal step
  as the 100% signal. The splash stays up until the IDE is really there, and
  never blanks out on a timer.
- nuke-cad: **mouse orbiting died after clicking a gizmo axis** — OrbitControls
  freezes its orbit pole from the camera's up vector at construction, so view
  snaps left the camera stranded on the pole with dead drag directions (worst
  on the Front/Back/Top/Bottom handles). Snaps now re-pole the controls
  (top/bottom orbit map-style around Y), and the gizmo moved below the
  toolbar with proper clearance instead of touching it.
- nuke-cad: **reopening a CAD model showed a stale "Untitled" empty state
  instead of a loader** — a React hooks-order violation in the viewport widget
  wiped the widget's subtree during loading transitions; hooks now run
  unconditionally, viewport initialization survives first-paint-during-load,
  and an in-flight tessellation read no longer clears the loading state early.
- nuke-cad: the axis gizmo and view label no longer render in the empty
  viewport (they were meaningless without a model).
- nuke-cad: the floating sketch toolbar no longer covers the constraint
  input (the constraint bar moved to top-center below the Finish Sketch
  pill), the toolbar panel no longer keeps dead space to the right of its
  tool column, and the Finish Sketch pill no longer jumps sideways on hover.
- nuke-cad: opening a CAD model now reveals the Model Outline and Feature
  Tree panels automatically (mirroring the existing close-with-viewport
  behavior).
- nuke-cad: **sketch chrome placement pass** — the Finish Sketch pill moved
  to the top-right (its tooltip and the collapsed toolbar's tooltip now
  anchor to the button instead of the viewport's top-left), the constraint
  bar owns top-center, the sketch toolbar defaults below the chrome row so
  it never overlaps at init, and the collapsed toolbar is draggable again.
- nuke-cad: **dimension labels are pinnable** — dragging a label gives it a
  persistent screen-space offset that survives zoom/pan and opts it out of
  the auto-deconflict shift (session state; deleting the dimension clears
  it). The dimension value popover input now follows the dark theme, and
  label hover/selected styling is calmer (accent border instead of full
  orange fill). The 3D view label moved below the top bar like the gizmo.
- nuke-cad: **saving a new CAD document no longer omits the `.nuke-cad`
  extension** — the save dialog defaults to it and the chosen path is
  normalized before writing.
- nuke-cad: **sketch selection is discoverable and fully wired** — Escape now
  clears the selection (previously it only cancelled the in-progress
  entity), keyboard Delete/Backspace/Escape no longer leak from open text
  fields, primitives outline on hover, clicking near an endpoint selects its
  primitive, and the status line shows the select/drag/delete bindings while
  the Select tool is active.
- nuke-cad: pick-mode banners (datum, external geometry, dress-up, hole) are
  now click-through — faces under the banner can be picked — and wrap their
  text properly instead of collapsing one word per line.
- nuke-cad: overlay form controls (Parameters panel, feature dialog,
  datum picker, constraint inputs, checkboxes, selects) now follow the dark
  theme via shared `--theia-input-*` styling instead of rendering white.
- nuke-cad: the Model Outline and Feature Tree empty-state icons render at a
  readable size instead of a fixed 16px glyph.
- nuke-cad: **sketch tool shortcuts and a keyboard cheat sheet** — `S`/`L`/
  `C`/`A`/`R`/`P` switch to select/line/circle/arc/rectangle/point, and
  Escape falls through (cancel entity → clear selection → back to Select),
  so there is always an obvious way back to select mode. A keyboard icon on
  the sketch toolbar opens a cheat-sheet popover listing all bindings.
- nuke-cad: viewport keyboard shortcuts are now scoped to viewport focus —
  the canvas container takes focus on click and Theia's own shortcuts keep
  working whenever focus is in an editor or another panel.
- nuke-cad: sketch toolbar tooltips no longer render on top of the tool
  buttons (the palette is single-column so chips land beside the panel), and
  tool tooltips show their shortcut letter (e.g. "Line (L)").
- nuke-cad: **shared draggable panels** — the sketch toolbar's drag behavior
  is extracted into a shared hook and applied to the Parameters, Solver
  Diagnostics, External Geometry, Keyboard Shortcuts, and Measurements
  panels: drag by the header, right-click/double-click the header to reset,
  positions persist for the session, and panels are clamped inside the
  canvas so they can no longer be dragged under Theia's sidebar.
- nuke-cad: the sketch toolbar body is a grouped two-column grid (draw /
  modify & constraint / lists) — roughly half the previous height — and the
  active tool button is clearly highlighted (accent background) in both the
  sketch and document toolbars.
- nuke-cad: **exiting a brand-new sketch silently failed** — the sketch session
  was created without the pre-registered document def, so the exit-time save
  failed datum validation (`unknown datum 'XY'`) and kept the user trapped in
  sketch mode behind an error notification. New sketches now round-trip their
  id, datum, and name through the session; Tab and the Finish Sketch pill both
  exit reliably.
- nuke-cad: the CAD viewport rendered through a disconnected throwaway
  camera, so orbiting, zooming, and panning had no visible effect and models
  appeared zoomed in. The viewport now renders through the live camera, and a
  new navigation cluster (ISO/top/front/right views, fit, zoom) plus an `F`
  fit-view shortcut make navigation explicit.
- nuke-cad: sketch-mode pan and zoom changed the camera without repainting
  the canvas, so wheel zoom and middle/Shift-drag pan appeared dead; both now
  repaint and keep the HTML dimension labels anchored. The "Document mode"
  hint no longer renders underneath sketch-mode controls, and compact CAD
  buttons (sketch tools, toolbar actions, navigation cluster, warnings
  toggle) now reset Theia's `.theia-button` `min-width: 65px`, which made
  24px buttons render 65px+ wide and overlap neighboring controls.
- nuke-cad: editing an existing sketch opened with the geometry out of
  frame (only the grid was visible); entering a saved sketch now frames its
  bounding box. Feature-creation dialog labels no longer clip ("Sourc..."),
  row tooltips in the Model Outline and Feature Tree anchor to the row label
  instead of the panel's far edge, and closing the CAD Viewport tab now also
  closes its Model Outline and Feature Tree panels instead of leaving them
  showing stale content.

### Added

- nuke-cad: **multi-body `.nuke-cad` documents and boolean features** — the
  `.nuke-cad` schema is now v2 with explicit `bodies`; every solid feature
  targets a body, and `booleanFuse`/`booleanCut`/`booleanCommon` features merge
  tool bodies into a target body with optional `keepTools`. The v1→v2 migration
  creates implicit bodies for legacy documents; the builder validates body refs,
  maintains per-body accumulators, and runs a final cross-body overlap gate.
  The Feature Tree adds a **Bodies** section, and boolean dialogs expose
  target/tool body dropdowns.
- nuke-cad: **Feature Tree editing workflow** — reorder features with
  dependency-precedence validation; delete with a cascade-delete prompt that
  covers pattern/mirror `source` dependents; inline rename for bodies and
  features; an edit-parameters action that reopens the feature dialog prefilled
  with current values; and a reference-repair popover that lists resolution
  candidates with fingerprint comparison for each broken `TopologyRef`.
- nuke-cad: **Export Python for `.nuke-cad` documents** — writes a deterministic,
  one-way build123d-ish script from the current document via
  `src/common/python-codegen.ts`, saved through the standard Theia save dialog.
- nuke-cad: **dress-up features in the GUI modeler** — `fillet`, `chamfer`,
  `draft`, and `shell` features are now available in `.nuke-cad` documents.
  Fillet rounds selected edges by radius; chamfer supports symmetric,
  two-distance, and distance-angle modes; draft tapers selected faces by an
  angle along a pull direction; shell hollows a body by a uniform thickness with
  optional open faces. Target edges and faces are picked directly in the
  viewport using fingerprint-based `TopologyRef`s, and the backend resolves
  them against the body's current B-rep so parametric edits remain robust.
- nuke-cad: **patterns, mirror, and hole wizard in the GUI modeler** —
  `linearPattern`, `circularPattern`, and `mirror` replicate a sketch-based
  solid feature on the same body; the backend stores the source's tool shape and
  applies transformed copies, with additive sources still subject to the same
  overlap check. The hole wizard places simple, counterbore, or countersink
  holes on a planar face picked in the viewport; the click point is projected
  into the face's deterministic workplane coordinates so the 2D `[u, v]` center
  aligns with the backend builder. Counterbore and countersink presets are
  mutually exclusive.
- nuke-cad: **tokamak demo gate** — added a GUI-path vitest driver
  (`src/browser/document/gui-build-tokamak.test.ts`) and committed fixture
  (`tests/e2e/assets/tokamak_with_divertor.nuke-cad`) for a multi-body tokamak
  assembly. Plasma-facing BSpline boundaries are approximated with dense
  polylines sampled from the reference STEP. Drift coverage
  (`tests/python/test_tokamak_document.py`) compares per-body volumes against the
  authoritative STEP (1e-6 for non-spline bodies, 1e-3 for spline-approximated
  bodies) and checks face counts for non-spline bodies. DAGMC export coverage
  (`tests/e2e/test_dagmc_tokamak_document_e2e.py`) and a gated performance test
  (`tests/e2e/test_tokamak_performance.py`) keep the demo stable.
- nuke-cad: **new parametric CAD extension** — script-first geometry
  authoring with build123d/CadQuery, live three.js viewport, canonical STEP
  export, JSON tessellation stream, and region manifest validation. Registered
  as an optional extension in the browser and Electron apps.
- nuke-cad: **GUI parametric modeler** — `.nuke-cad` documents are now a
  complete authoring mode alongside Python scripts. The document stores
  parameters, datum planes, sketches, and a feature tree; `.nuke-cad` files open
  in the CAD viewport by default. Script builds and document builds feed the
  same `_process_shape` path, so STEP, viewport tessellation, DAGMC, and FEM
  artifacts are authoring-mode-agnostic.
- nuke-cad: **sketcher** — interactive 2D sketch mode with point, line, circle,
  3-point arc, and rectangle tools; endpoint/midpoint/center/quadrant/on-curve/
  grid snap; auto-coincident and auto-horizontal/vertical constraints; explicit
  constraints (coincident, fix, horizontal, vertical, parallel, perpendicular,
  tangent, equal, concentric, point-on-object, distance, angle, radius,
  symmetry); driving and reference dimensions with parameter binding; sketch-local
  and document-level parameters; live drag solving; and a solver diagnostics
  popover for conflicting or redundant constraints.
- nuke-cad: **document build pipeline** — `python/sketch_builder.py` turns
  stored sketch primitives into build123d `Face` objects on the sketch datum;
  `python/feature_builder.py` executes `pad`/`pocket`/`revolve`/`groove`
  features in topological order over explicit `dependsOn` edges; and
  `geometry_service.py` exposes `build_document()` plus a `--from-document` CLI
  flag. The first release performs a full rebuild on every call; per-feature status
  (`built`/`stale`/`failed`) is returned so the viewport can show which feature
  failed and why.
- nuke-cad: **topological reference resolution** — `TopologyRef`s (face datums,
  sketch `externalRefs`, and future edge arrays) are resolved against the
  referenced predecessor feature's current B-rep using geometric fingerprints.
  The build result carries per-reference `referenceResults`
  (`matched`/`ambiguous`/`unmatched`) and fails dependent features with a clear
  error when a reference is ambiguous or unmatched, so parametric edits that
  change the B-rep do not silently pick the wrong geometry.
- nuke-cad: **sketch-on-face (`face` datum)** — planar faces of predecessor
  features can be used as sketch datums. The backend derives a deterministic
  workplane from the resolved face (origin, normal, in-plane x-direction) and
  supports an optional offset along the normal; non-planar faces produce a clear
  build error.
- nuke-cad: **external geometry in sketches** — sketches can reference edges or
  faces of predecessor features via `externalRefs`. Resolved entities are
  projected into the sketch plane and passed to the sketch builder as
  construction geometry, so they appear as references without becoming part of
  the sketch's output wires or faces.
- nuke-cad: **viewport face picking** — the Sketch Plane picker now has an
  **On Face…** button that enters face-pick mode; hover highlights and a click
  create a `face` datum and start sketching on it. The sketch toolbar adds an
  **External Geometry** tool for picking faces/edges of the latest solid body.
  Resolved references are rendered as dashed construction geometry after the
  next rebuild.
- nuke-cad: **reference-status UI** — the sketch status line and diagnostics
  popover now show per-sketch reference-resolution counts
  (`matched`/`ambiguous`/`unmatched`), and the Feature Tree shows
  `ambiguous`/`unmatched` badges on features with broken topological
  references.
- nuke-cad: **tessellation fingerprint** — every face in the viewport
  tessellation now carries a geometric `fingerprint` (surface type, area,
  centroid, normal/axis/radii) used for face-pick-based `TopologyRef`
  construction and backend reference resolution.
- nuke-cad: **Feature Tree panel** — a right-area widget (ID
  `nuke-cad-feature-tree-widget`, command `Open Feature Tree`) listing datums,
  sketches, and features with selection, suppression toggle, edit, delete, and
  build-status markers.
- nuke-cad: **document commands** — `New CAD Document`, `Save CAD Document`,
  `Save CAD Document As...`, `New Sketch`, and `Exit Sketch` provide the
  document shell workflow.
- nuke-cad: **DAGMC export** — `dagmc_export.py` converts the
  canonical STEP file to a tagged `.h5m` using gmsh OCC imprint/merge so
  touching solids share exact coincident faces. Region-manifest volume names
  map to `mat:<name>` groups, unmanifested volumes fall back to positional
  `mat_<vol_id-1>`, and a `mat:graveyard` bounding volume is auto-created by
  default. Geometry service exposes `dagmcPath`, `dagmcSuccess`,
  `dagmcWarnings`, and `dagmcError` in the stdout-JSON result.
- nuke-cad: **FEM volume meshing** — `mesh_service.py` turns the canonical
  STEP file into gmsh `.msh`, ExodusII `.e`, CalculiX/Abaqus `.inp`, and
  VTK `.vtk` meshes using the HXT tetrahedral algorithm. Manifest volume
  names become Exodus/INP element blocks, manifest surface names become
  Exodus side sets, and volume entries support an optional `meshSize` for
  per-region refinement. The geometry service exposes `meshPath`,
  `exodusPath`, `inpPath`, `vtkPath`, `meshReportPath`, `meshSuccess`,
  `meshWarnings`, `meshError`, and `meshReport` in the stdout-JSON result.
- nuke-cad/openmc-studio: **one-click nuke-cad import** — OpenMC Studio's
  **Import from nuke-cad...** command loads a nuke-cad-produced `.h5m` and its
  sibling `.regions.json` manifest into the project, auto-creates placeholder
  OpenMC materials for manifest material names, and sets `dagmcFile`/
  `dagmcInfo` so the existing DAGMC graveyard/sync/run flow works unchanged.
- nuke-cad/openmc-studio: **imprinted DAGMC refacet through nuke-cad** — when
  the DAGMC editor refacets with **Imprint & Merge** enabled, it routes through
  nuke-cad's `dagmc_export.py` pipeline; if nuke-cad is unavailable it falls
  back to the legacy OpenCASCADE path.
- nuke-cad: **direct STEP import** — `.step` / `.stp` / `.brep` files can be
  opened in the CAD viewport without a script. The geometry service reads the
  file through OCP, writes the canonical viewport tessellation, and runs the
  optional DAGMC/FEM export pipeline. Double-clicking a STEP file now opens it
  in nuke-cad by default instead of nuke-visualizer.
- nuke-cad: **Open CAD Model button** — the empty CAD viewport shows an
  **Open CAD Model...** button that launches a file picker for `.py` scripts
  and `.step` / `.stp` files.
- nuke-cad: **CalculiX FEM analysis** — `fem_service.py` reads a
  gmsh `.msh` file and writes a CalculiX `.inp` deck with materials, solid
  sections, gravity loads, and boundary conditions on named surface sets.
  The **FEM Analysis** panel lets users configure analysis type, assign
  built-in materials to mesh blocks, add fixed/displacement/pressure/
  temperature/heat-flux boundary conditions, run `ccx`, and open the
  resulting `.fem.vtk` in nuke-visualizer. FRD nodal displacements (`DISP`)
  and temperatures (`TEMP`) are parsed and written into the VTK file.
  `ccx` is resolved from `NUKE_CCX`, `PATH`, or an explicit request path.
- nuke-cad: **generic job runner + OpenFOAM scaffolding** —
  `job_service.py` implements a declarative run-layer abstraction
  (working directory, command, environment overlay, artifact globs, timeout,
  log capture) for future solver hooks. `foam_service.py` scaffolds
  solver-ready OpenFOAM cases (controlDict, fvSchemes, fvSolution,
  transportProperties, and 0/U/p/T field files) from the region manifest
  and exports per-solid STL files from a canonical STEP file for patch
  geometry. The **OpenFOAM Case** panel exposes solver selection, boundary
  condition editing, case scaffolding, and STL export.
- nuke-cad: **Model Outline panel** — a new right-area widget (**Open Model
  Outline** command, also under `CAD Studio → Geometry` in the Nuke Tools
  sidebar) listing the active model's manifest volumes (name/material/tags)
  and surfaces (name/role) with count badges, collapsible sections, and a
  build-warnings box; unmanifested models fall back to positional `mat_<id>`
  rows. Picking is synced both ways through the shared CAD state manager:
  clicking a row highlights the whole solid in the viewport, and picking in
  the viewport selects the row, scrolls it into view, and expands its
  section. The panel is read-only; its manifest button opens the model's
  `.regions.json` in the editor.
- nuke-cad: **`nukeCad.facetingTolerance` preference** — default faceting
  tolerance (0.001) for geometry builds (tessellation and DAGMC export),
  honored by open, rebuild, and **Open CAD Model...**; an explicit per-call
  tolerance still wins, and changes apply to subsequent builds only.
- nuke-cad: **netgen meshing engine** — `mesh_service.py` now accepts
  `engine='netgen'` (netgen.occ OCCGeometry, per-region `meshSize` mapped to
  `solid.maxh`, surface names mapped to boundary-condition names) and
  converges into the same meshio-based report/Exodus/INP/VTK pipeline as
  gmsh. The netgen path imprints first — a shared gmsh
  load/fragment/`removeAllDuplicates` pass writes an imprinted BREP (a STEP
  round-trip re-duplicates shared faces; BREP preserves the imprint), so
  touching solids share one face — and supports second-order meshes:
  `order=2` produces real tetra10/triangle6 elements via netgen's
  `Mesh.SecondOrder()` with node-order remapping to the meshio/SEACAS
  convention (`order > 2` clamps to 2 with a warning; curved-boundary
  mid-nodes are a best-effort projection, verified straight-edged only).
  Netgen requires the `ngsolve` pip wheel; a missing install returns a
  structured error.
- build: **optional extensions are selectable at build time** —
  `NUKE_EXTENSIONS` (allow-list, `all` = everything) / `NUKE_EXCLUDE_EXTENSIONS`
  (deny-list) prune optional extensions from the browser/Electron bundles and
  the Docker image (build args); `nuke-core`/`nuke-essentials` always ship and
  local dependency closure is automatic. `yarn ext:list` previews the resolved
  set without building. `nukelab-integration` only applies to NukeLab
  deployments and is no longer bundled by default — NukeLab deployments must
  opt in with `NUKE_EXTENSIONS=all`.

- openmc-studio: the Simulation Dashboard re-attaches to in-flight backend
  runs after a browser tab/window reload — Stop keeps working and live
  progress/log streaming resumes instead of the run looking idle.
- openmc-studio: **graveyard tooling for DAGMC models** — the DAGMC editor
  detects a missing graveyard and offers one-click creation of a bounding box
  tagged `mat:graveyard` (or re-tagging an existing enclosing volume), and
  CAD→DAGMC conversion auto-creates the graveyard bounding volume by default
  (`--no-graveyard` / `addGraveyard: false` to opt out).
- openmc-studio: **Import CAD** button in the DAGMC editor header — imports
  STEP/IGES/BREP/STL files straight into DAGMC format with a gmsh/OpenCASCADE
  availability check. Generated `.h5m` files land in the project directory
  when a project is saved, otherwise next to the source CAD file.
- openmc-studio: optional **Imprint & Merge** mode for DAGMC refacet
  (OpenCASCADE imprint/merge so touching faces share topology), and refacet
  re-creates a graveyard volume that re-tessellation would otherwise drop.
- openmc-studio: one-click fix when MGXS generation is incompatible with the
  project (multi-group mode or macroscopic materials) — a warning box offers
  to switch back to continuous energy, restoring materials from the
  pre-conversion backup.
- openmc-studio: `copyDagmcToRunDirectory` setting (Simulation tab) — off by
  default, geometry.xml references the DAGMC file via a project-relative path;
  on, the `.h5m` is copied into the run directory as `geometry.h5m` for a
  self-contained run directory. Project files store DAGMC/MGXS asset paths
  project-relative, keeping projects portable across machines.
- nuke-visualizer: depletion per-step statepoints (`openmc_simulation_n<N>.h5`)
  open in the statepoint viewer alongside regular `statepoint*.h5` files.
- nuke-core: **Nuke Tools sidebar** — a searchable, categorized left-panel view that aggregates every Nuke command across extensions. Extensions contribute items via `NukeToolsContribution`, with support for nested categories, section/category ordering, and state-aware enabled/disabled items.
- openmc-studio: element symbols (e.g. `U`, `O`) in materials are expanded to their natural nuclide compositions on XML export and script generation, so hand-edited element shorthand round-trips correctly through OpenMC.
- openmc-studio: one-click **CE ↔ Multi-Group conversion** (Random Ray tab) —
  generates MGXS from the current CE model, converts matched materials to
  macroscopic with the correct XS data names, and stashes the original materials
  in project metadata for a lossless **Revert to Continuous-Energy**.
- openmc-studio: **nuclide-wise multi-group mode** for random ray on DAGMC
  geometries — a `settings.nuclideWiseMgxs` flag plus nuclide-wise MGXS
  generation (`generate_mgxs.py` / `generate_mgxs_library.py --nuclide-wise`,
  also wired into `convertToMultigroupProject` and the MGXS Generator window)
  that writes one micro XS data set per nuclide instead of macroscopic
  materials, which OpenMC random ray rejects on DAGMC. Materials stay
  nuclide-decomposed, validation and run readiness enforce the mode for DAGMC
  random ray, and library type detection routes existing libraries correctly.
- openmc-studio: version-compatibility architecture for upstream OpenMC drift —
  a per-env runtime probe (ray_source XML format, adjoint source, TokamakSource,
  s2 sampling) that adapts XML emission and gates dev-only UI options; MG library
  reference in materials.xml with legacy path unification; depletion solver names
  aligned to OpenMC's real integrator registry with legacy aliases.
- openmc-studio: mode guard rails with plain-language errors — coupled depletion
  vs multi-group, macroscopic depletable materials, MGXS generation vs MG models,
  IFP kinetics vs random ray, random-ray score whitelist, duplicate mesh emission.
- nuke-visualizer: NCrystal tab in the Nuclear Data window — browse the installed
  `.ncmat` material library (or custom files/dirs), inspect phases/structure,
  build config strings with a guided editor (temp, dcutoff, mosaicity, …) for
  pasting into openmc-studio's NCrystal import, and plot S(α,β) scatter +
  absorption cross sections (validated against known thermal values).
- nuke-visualizer: ENDF tab in the Nuclear Data window — browse an ENDF-6
  library directory (decay/nfy/sfy/neutrons sub-libraries), with per-evaluation
  detail: decay modes and half-lives, per-energy fission-product yield tables,
  and fast reaction-section scans of neutron files.
- nuke-visualizer: voxel plot HDF5 (`*voxel*.h5`, `plot_*.h5`) and `summary.h5`
  now open on double-click (voxel → results viewer; summary → geometry 3D via
  on-the-fly XML conversion). Output viewers have a draggable viewer/table
  split, and missing-dependency errors show an actionable install/env panel.
- nuke-visualizer: the visualizer proxy retries refused connections on startup
  (trame bind race), eliminating false 'Visualizer server unreachable' errors.
- openmc-studio: tally derivatives (`TallyDerivative`) — sensitivity tallies in
  the tally editor with density/nuclide-density/temperature perturbation
  variables, e2e-verified against the real statepoint layout.
- openmc-studio: custom depletion chain builder (Depletion tab) — build from an
  ENDF-B-VII library directory (`decay/` + `nfy/` + `neutron(s)/`) or subset an
  existing chain XML, with full recursive closure over decay/reaction targets,
  fission-yield products, and FPY borrow parents; 'Use as Depletion Chain'
  applies the result directly.
- nuke-visualizer: nuclear data browser (Materials menu) — searchable library table
  (nuclides, temperatures, reaction counts) with per-nuclide MT/temperature/
  fission detail, resolved from `OPENMC_CROSS_SECTIONS`, and one-click plotting
  of any nuclide in the XS viewer.
- openmc-studio: Library (manual) mode in the MGXS generator — user-chosen XS
  types, domains, by-nuclide decomposition, Legendre order, and estimator via
  the `openmc.mgxs.Library` API (validated: MG k-eff within 0.3% of CE).
- openmc-studio: random-ray adjoint source editing, tally-trigger `ignore_zeros`,
  muir energy round-trip (serializes as `normal` in this OpenMC version),
  TokamakSource time distributions, criticality-search cancellation, and CMFD
  mesh-reference validation.
- nuke-visualizer: weight-windows viewer mesh selector for multi-mesh files.
- openmc-studio: CMFD acceleration — Convergence-section UI, validation, codegen,
  and a `run_cmfd.py` driver so CMFD-enabled runs execute through the IDE (CMFD is
  C-API-only in this OpenMC version; there is no settings.xml form).
- openmc-studio: mesh sources (`MeshSource`) with exact `n_elements` sub-source
  enforcement and a fill helper; tokamak sources (`TokamakSource`, 0.15.4+) with
  Miller geometry and emission-profile editing. Both join the source type selector.
- openmc-studio: per-tally precision triggers (variance/std_dev/rel_err, per-score
  subsets) with automatic `trigger_active` emission, plus run-level trigger
  settings in Settings → Output.
- openmc-studio: criticality search (`search_for_keff`) as a mode of the
  optimization widget — guess or bracket with method selection, live iteration
  table, and apply-to-model for the converged parameter. Parameter paths
  (`material.density|temperature|<nuclide>`, `settings.*`, `geometry.<cell>.temperature`)
  are now one shared vocabulary used by sweeps, search, and the Python drivers.
- openmc-studio: Advanced settings section — event-based transport, tabular
  Legendre conversion, delayed neutron/photon creation, decay photons, survival
  biasing, generations per batch, probability tables, lost-particle limits,
  initial-source writing, uniform source sampling, log-grid bins, and multi-group
  max order.
- openmc-studio: simulation dashboard tabs are now modular contributions behind a
  `DashboardTabRegistry` (the monolithic dashboard widget was split into per-tab
  modules), and `.nuke-openmc` project files carry schema version 1.1.0 with a
  chained migration hook.
- openmc-studio: full source model — file sources, compiled sources, multi-source
  lists with strengths, source constraints, and surface source write/read.
- openmc-studio: output-control settings (statepoint/sourcepoint batches, track
  files, collision tracks), photon physics (`electron_treatment`,
  `atomic_relaxation`), Shannon entropy mesh, and restart-from-statepoint runs.
- openmc-studio: particle track files (`tracks.h5`, `tracks_p<N>.h5`) and
  lost-particle restart files (`particle_<batch>_<id>.h5`) are moved into
  `tracks/` and `particles/` subfolders after a run, keeping the working
  directory clean when many particles are written. `weight_windows.h5` is
  surfaced as an 'Open Weight Windows' action alongside 'Open Tracks' in the
  Simulation Dashboard.
- openmc-studio: complete tally score catalog (79 scores incl. photon,
  particle-production, and IFP kinetics scores) and descriptor-driven filter
  editors for all 23 supported filter types.
- openmc-studio: IFP kinetics workflow (`ifp_n_generation`, auto-generated IFP
  tallies with optional per-delayed-group β_eff) with validation.
- openmc-studio: volume-calculation window with trigger support and
  adopt-into-materials; native plotting window for slice, voxel, solid and
  wireframe ray-trace plots (PNG output, voxel→VTK handoff).
- openmc-studio: advanced depletion — `IndependentOperator` (file or
  generate-from-model MicroXS), integrator transfer rates, all normalization
  modes with per-nuclide fission Q, and `diff_burnable_mats`.
- openmc-studio: macroscopic (multigroup) materials and NCrystal material import
  (optional dependency, env-gated).
- openmc-studio: random ray support — dedicated dashboard tab, MGXS generator
  window (`convert_to_multigroup`/`convert_to_random_ray`), and FW-CADIS weight
  window generation via the adjoint workflow.
- openmc-studio: DAGMC material overrides (by-name replace, per-cell assignment),
  `auto_geom_ids`/`auto_mat_ids` toggles, and sync-for-depletion.
- openmc-studio: single-particle restart runs with track capture (`-t`) and
  post-run track handoff.
- nuke-visualizer: shared HDF5 output readers and viewers for `tracks*.h5`,
  `collision_track.h5`, and `weight_windows.h5` (convert→VTK→trame pipeline),
  registered through a new `OutputViewerRegistry`.
- nuke-visualizer: IFP kinetics tab in the statepoint viewer (β_eff/Λ_eff with
  uncertainties, CSV export), particle-restart preview viewer, and a random-ray
  results viewer with initial-coloring support (`base.serve --color-by`).
- Testing: **Playwright UI smoke suite** (`yarn test:ui`) — boot with zero
  console errors, all dashboard tabs, New Project flow, windows, select-sticks;
  weekly `ui-smoke.yml` CI with failure screenshots.
- Testing: `openmc-dev.yml` weekly CI lane building upstream OpenMC develop from
  source; CI python tests moved to a cached conda full profile (coverage ratchet
  back above 94%).
- Testing: end-to-end test layer — real OpenMC runs for every driver
  (CMFD, depletion, k-eff search, volume calc, MGXS, chain build, plots) and a
  project-file suite (10+ `.nuke-openmc` fixtures through the real
  load → migrate → XML → run pipeline, incl. DAGMC, random ray, kinetics,
  derivatives, mesh/tokamak sources, and a v1.0.0 migration fixture).
  `yarn test:python:full` runs the full-dependency profile via `NUKE_TEST_PYTHON`;
  env-gated on `OPENMC_CROSS_SECTIONS` / `NUKE_E2E_CHAIN` / `NUKE_E2E_ENDF`,
  skipping cleanly otherwise.
- Testing: nuke-cad **pincell DAGMC e2e** (`extensions/nuke-cad/tests/e2e/`) —
  labeled build123d pincell → STEP → imprinted h5m (asserts
  `mat:fuel/clad/moderator/graveyard` groups) → a real OpenMC run asserting
  zero lost particles. Marked `@pytest.mark.e2e`, env-gated on
  `NUKE_TEST_PYTHON` + `OPENMC_CROSS_SECTIONS`, skipping cleanly otherwise.
- nuke-essentials: **shared UI components** under
  `src/theme/browser/components/` — `NukeDialog` (modal shell with backdrop),
  `NukeToolbar`/`NukeToolbarGroup` (grouped, wrapping toolbars),
  `NukeEmptyState`, `NukeLoadingOverlay`, `NukePanel` (floating panel chrome),
  and `NukeSection`/`NukeFormRow` (form layout primitives), exported from the
  components index with co-located CSS shipped via the theme module.

### Changed

- nuke-cad: **additive pattern instances fuse** — overlapping instances of
  additive `linearPattern`/`circularPattern`/`mirror` features now union via
  `_apply_pattern_or_mirror` instead of raising an overlap error, matching the
  behavior expected for coil assemblies.
- nuke-cad: **cross-body overlap is a warning** — non-consumed bodies that
  overlap in space no longer abort `build_document_shape`; instead the overlap
  volume is reported in `result["warnings"]` so CAD assemblies (e.g., the
  tokamak demo) can build while still alerting callers that need a sealed DAGMC
  model.
- nuke-cad: **viewport chrome redesign** — the CAD viewport now shows the
  welcome card only when no document is open; a new document displays a minimal
  document hint instead. The document toolbar is now a structured header bar
  (icon + name + dirty indicator on the left, grouped actions on the right)
  styled after openmc-studio, with a "More" overflow menu when the action groups
  wrap beyond two rows. The sketch toolbar is now a compact, collapsible
  vertical panel with a floating toggle to reopen it.

### Fixed

- nuke-cad: **viewport chrome layout** — the empty-state card no longer clips
  at narrow widths (border-box sizing, wrapping action row) and stays centered
  in document mode when the document toolbar/sketch overlay is present, the
  rebuild loading indicator is a centered overlay instead of a corner strip, the
  document toolbar is grouped by function and wraps instead of overflowing, and
  the feature-creation dialog is a real modal with a backdrop that blocks the
  toolbar behind it. The chrome now builds on shared nuke-essentials
  components (`NukeDialog`, `NukeToolbar`/`NukeToolbarGroup`, `NukeEmptyState`,
  `NukeLoadingOverlay`, `NukePanel`), and the document toolbar gains
  New/Save/Rebuild buttons alongside Export Python.
- nuke-cad: non-fatal build warnings (e.g. cross-body overlap with volumes)
  are surfaced in the viewport as a dismissible warning strip instead of only
  reaching the message service.
- nuke-cad: sketch mode lifecycle hardening — `SketchSession.destroy()` releases
  the solver and clears listeners; `SketchModeController` disposes the session
  and restores the 3D view on exit/teardown; solver and pointer-up errors now
  surface as user-visible messages instead of failing silently.
- nuke-cad: viewport no longer flashes the empty state when the same
  tessellation is set repeatedly, and the open handler shows a loading overlay
  while scripts or STEP files build.
- nuke-cad: `REBUILD_GEOMETRY` now warns when a `.nuke-cad` document is active
  but the CAD viewport is not open, instead of silently doing nothing.
- nuke-cad: dimension popover input stays in sync with external parameter/value
  changes while open.
- nuke-cad: 3-point arc clicks catch solver failures and reset pending
  auto-constraints instead of crashing.
- nuke-cad: sketch snap now returns `on_curve` candidates for arcs (projected
  onto the arc circle within the angular span), not just lines and circles.
- nuke-cad: document validation now rejects dimensions whose `targetIds`
  reference primitives that do not exist in the sketch.
- nuke-cad: geometry service stdout-JSON protocol now uses a `__NUKE_RESULT__`
  marker so user prints can no longer be mistaken for the result payload.
- nuke-cad: DAGMC export no longer auto-detects graveyards via the >10×
  volume-ratio + containment heuristic. Existing graveyards must be explicitly
  flagged with `existing_graveyard_vol_ids` or by naming the STEP
  product/assembly "graveyard".
- nuke-cad: DAGMC export skips gmsh faces that collapse to zero triangles
  instead of failing with a missing-surface KeyError on assemblies with very
  thin or sliver faces (exposed by the tokamak demo).
- nuke-cad: `pad` and `pocket` now share the same inner-wire semantics — inner
  wires represent removed material, leaving islands for pads and producing
  through-holes for pockets.
- nuke-cad: overlapping additive features now raise a clear `FeatureBuilderError`
  instead of producing invalid overlapping volumes.
- nuke-cad: revolve/groove axes are validated to lie in the sketch plane; a
  non-planar axis now fails fast with a clear message instead of an unwrapped
  OCCT traceback.
- nuke-cad: shallow `.nuke-cad` document validation in the Python service now
  rejects unsupported feature types and missing required parameters (positive
  length for pad/pocket, axis and angle for revolve/groove) before any geometry
  is built.
- nuke-cad: sketches and holes attached to a reversed-orientation face (e.g. the
  bottom face of a box) were mirrored across the face. Datum plane extraction now
  flips the plane normal to the outward convention, and the face-picker fallback
  X axis matches the solver's deterministic basis.
- nuke-cad: the topology repair popover shows suggested candidates again —
  ambiguous references carry per-candidate fingerprints, unmatched references now
  offer up to three best candidates, and candidate rows are clickable.
- nuke-cad: the document build response now forwards per-feature warnings and the
  consumed-body list on successful builds, so partial feature failures surface in
  the UI.
- nuke-cad: holes/pockets/grooves whose cut tool is disjoint from the target body
  now fail with an explicit error instead of silently dropping the cut.
- nuke-cad: pads/pockets with `upToFace`, `upToBody`, or draft `angle` parameters
  now fail validation with a "not yet supported" error instead of silently
  ignoring the parameter.
- nuke-cad: pads/pockets/revolves/grooves on bodies consumed by a pattern/mirror
  are now reported `stale`, matching dress-up and pattern features.
- nuke-cad: pattern/mirror/hole datum references now resolve against the whole
  document instead of only the target body — an axis datum carried by a patterned
  instance resolves again.
- nuke-cad: feature reordering now rejects moving a pattern/mirror above its
  source feature (implied dependency enforced alongside datum references).
- nuke-cad: topology repair commits are atomic — a failed commit no longer leaves
  the document's references half-updated.
- nuke-cad docs: corrected the sketch boundary segment limit (255), the
  exported-CAD helix note, and the edge-overlay rendering description.

### Added

- nuke-cad: `lengthScale` option on `GeometryBuildRequest` and
  `BuildDocumentRequest` (default 1.0). The value is forwarded through the RPC
  layer to `geometry_service.py --length-scale` and applied to DAGMC `.h5m`
  vertices via `convert_to_dagmc`. Default units are cm; use `0.01` to produce
  meter-scaled meshes for transport solvers that expect meters.
- nuke-cad: `EDIT_SKETCH` command and feature-tree sketch edit action open an
  existing sketch for editing.

### Fixed

- nuke-cad: GUI-authored pincell DAGMC e2e no longer leaks particles. The
  `dagmc_export.py` pipeline now imprints model volumes in gmsh first and adds
  the optional `mat:graveyard` bounding box with a second gmsh `fragment`,
  preserving shared model-model faces. The previous OCP boolean graveyard cut
  re-duplicated coincident faces and caused "No intersection found with DAGMC
  cell" lost-particle errors on document-built pincells.
- nuke-cad: geometry scripts now run on OCP 7.9 — `ocp_compat` re-attaches
  the `TopoDS.TopoDS.<X>_s` downcast aliases removed in OCP 7.9 (build123d
  0.9.x still calls them), applied eagerly in the geometry-service child
  process and optionally via a one-shot `build123d` import hook that
  container images can activate with a site-packages `.pth` line.
- docker: the image's Python env now ships a working build123d 0.9.1. The
  conda solver (with paraview pinned, hence the ocp 7.9 line) silently
  selected the broken build123d 0.7.0; the Dockerfile now installs
  build123d/ocpsvg via pip `--no-deps` (pure Python, no binary conflicts) and
  activates the OCP 7.9 alias shim image-wide through a `.pth` hook. A CI
  version guard in the docker workflow prevents a silent regression.
- nukelab-integration: IDE file downloads and uploads no longer hang on
  "Preparing download..." after the NukeLab server access token expires
  (5 minutes after opening the environment) — a 401 from the container auth
  sidecar now silently re-mints the token via the hub and retries the request.
- openmc-studio: DAGMC universes are synchronized before CoupledOperator
  creation on DAGMC geometries — coupled depletion previously failed with
  'Number of material instances have not been determined'.
- openmc-studio: FW-CADIS weight-window generation is validated against
  random ray mode (it silently required it), and repeated CAD conversions no
  longer produce duplicate graveyard volumes.
- openmc-studio: nuclide-wise MGXS generation with `--random-ray` sets
  `energy_mode = 'multi-group'` directly instead of running
  `convert_to_random_ray`, which rejects continuous-energy models.
- openmc-studio: the OpenMC run output directory is excluded from the file
  watcher, stopping file-manager lag on runs that flood the output dir with
  track/particle files.
- openmc-studio: runner robustness — in-memory run output capture is capped
  to a 1 MB tail (multi-hour runs can't OOM the backend), client log
  streaming is batched (chatty DAGMC warning floods no longer stall the
  frontend), re-written track/particle files replace older copies in the
  `tracks/`/`particles/` subfolders, and empty track directories are skipped.
- openmc-studio: DAGMC file persistence — project files no longer break when
  moved, with asset paths saved and resolved relative to the project file.
- openmc-studio: random-ray ray_source emitted in the dev-clone XML format,
  which release 0.15.3 binaries reject — now probed per env.
- openmc-studio: macroscopic materials couldn't select the required `macro`
  density unit; MGXS generation crashed silently on MG models via libopenmc's
  C-level exit — now a first-class guarded error with the real cause surfaced.
- openmc-studio: depletion solver dropdown emitted names the driver rejected
  (`ce-cm`, `leapfrog`, `si-rk4`, `predictor-corrector`).
- openmc-studio: `generateSurfaceElement` stamped `boundary="vacuum"` on every
  surface, silently killing particles in all multi-region models — regenerate
  XML for existing projects.
- openmc-studio: cylinder surfaces generated invalid Python (`openmc.Cylinder`
  does not exist); kinetics-enabled scripts omitted the auto-generated IFP
  tallies; macroscopic materials lacked the required `macro` density unit —
  all caught by the e2e layer.
- openmc-studio: MGXS generation passed a wrong `particles` kwarg to
  `convert_to_multigroup`; k-eff search used nonexistent `Model.clone()` and a
  direct density assignment; nuclide-fraction changes now renormalize only
  within the same element instead of distorting all other nuclides.
- openmc-studio: chain builder accepts both ENDF `neutron/` and `neutrons/`
  layouts and closes FPY borrow-parent references in ENDF-built chains.
- openmc-studio: run-level tally trigger settings, `eventBased`,
  `probabilityTables`, `maxLostParticles`, and `relLostParticleRate` existed in
  the project schema but never round-tripped to XML or appeared in the UI.
- openmc-studio: React controlled selects/checkboxes that mutated widget fields
  without scheduling a re-render were reverted by React (DAGMC overrides, MGXS
  generator, volume calculator) — selections now stick immediately.
- openmc-studio: `tallies.xml` and `plots.xml` are now parsed back on XML import
  (previously export-only), and plots use the real OpenMC element format.
- openmc-studio: tallies emit a single space-joined `<nuclides>` element (the
  repeated `<nuclide>` form was silently ignored by OpenMC), and tally codegen
  emits real filter constructors instead of invalid `openmc.Filter()` calls.
- openmc-studio: weight window generators use the real
  `<weight_window_generators>` settings.xml format.
- nuke-essentials: tooltips anchored to a stretched wrapper span could appear far
  from their control, and lingered at stale coordinates after scroll/resize.
- nuke-visualizer: output viewers' selects/inputs lacked focus/disabled styling
  and themed dropdown option lists.
- CI: vitest job never compiled extensions (broken imports on fresh runners);
  setup-miniconda pinned Python 3.14, unsatisfiable for OpenMC.
- nuke-cad: geometry builds now extract real selectors from build123d labels
  and CadQuery assembly names — region-manifest `mat:<name>` groups, Exodus
  block names, and per-region `meshSize` values resolve instead of falling
  back to positional names.
- nuke-cad: CadQuery Assembly selector extraction hardened against real
  cadquery 2.7/2.8 — TShape-based matching via `IsPartner`, UUID-name
  filtering, and correct multi-solid Workplane handling (covered by the
  assembly/cadquery test suite).
- nuke-cad: DAGMC export corrections — unmanifested volumes fall back to
  OpenMC-recognized `mat:mat_<vol_id-1>` groups (previously missing the
  `mat:` prefix), volume identity across the gmsh fragment step uses the
  fragment's returned mapping (plus `removeAllDuplicates`), and the temp STEP
  rewrite is skipped when the shape is unmodified.
- nuke-cad: mesh service corrections — Exodus side-set numbering now follows
  the SEACAS TETRA(4) convention, the dihedral-angle quality metric is fixed
  (a regular tetrahedron reports 70.53°), an explicit `max_size` overrides
  `mesh_size`, and `elementTypes` reports `tetra10` for second-order meshes.
  Selecting the `netgen` engine returns a structured "not yet implemented"
  error instead of silently meshing with gmsh.
- nuke-cad: FEM service — fixed boundary conditions emit dof-range
  `*Boundary` cards (`nset, 1, 3`) instead of the ccx-incompatible
  `ENCASTRE`, the FRD parser handles CalculiX's real fixed-width output
  (NDTEMP results now reach the VTK file), ccx runs time out after one hour
  by default (`ccxTimeout` request field) and stream output to
  `<stem>.ccx.log` with a 1 MB JSON tail, and physical-group/block
  assignment is vectorized (was O(n²) on large meshes).
- nuke-cad: OpenFOAM STL export works — the service loads STEP directly via
  `STEPControl_Reader` with the correct `TopoDS` downcast (the broken
  `cad_conversion` dependency is gone), output filenames are sanitized, the
  writer's return status is checked, and `wall_boundaries` are wired into
  the field files.
- nuke-cad: user geometry scripts run in an isolated subprocess with a 120 s
  default timeout (`--script-timeout`); `SystemExit` in a script is reported
  as a structured error instead of taking down the service, and unsupported
  model types raise a specific `TypeError`.
- nuke-cad: the `.py` open handler no longer hijacks Python files from the
  text editor (priority 50, below the editor's 100) — the CAD viewport is
  reached via **Open With…**. STEP/STP/BREP files still open the viewport by
  default.
- nuke-cad: CAD viewport — face-pick highlighting works (in-place material
  recolor), a tessellation load race is fixed (stale results are discarded),
  the scene rebuilds only on new tessellation (indexed BufferGeometry,
  on-demand rendering instead of a perpetual animation loop), rebuilds keep
  the old model visible behind a loading overlay instead of flickering to
  the empty state, and Python build errors surface in a dismissible error
  banner in the viewport.
- nuke-cad: job lifecycle — the backend tracks spawned services in a job
  registry with a `cancelJob` RPC (process-group kill) and a one-hour
  default timeout, caps captured output at a 1 MB tail, kills remaining jobs
  when the backend stops, and the FEM panel gains a **Stop** button for
  running CalculiX jobs; the Python `job_service` no longer leaks file
  descriptors and kills timed-out solver processes as a group.
- nuke-cad: the CAD environment health check is now truthful — the health
  group requires OCP/build123d/gmsh (plus numpy) and reports
  `missingOptional` packages; "pymoab" is renamed to its real distribution
  name `moab` with the shimwell wheels extra index.

### Changed

- Platform: Theia 1.73.1 → **1.74.1** across all applications and extensions.
  The experimental `@theia/ai-vercel-ai` provider was removed (upstream
  deprecated and unpublished it — the dedicated `@theia/ai-openai` and
  `@theia/ai-anthropic` providers cover the same models), and the Electron
  shell moves to Electron **43.4.0** (Theia requires ≥ 42.3.0; both bundle
  Node 24). Inherited upstream behavior changes: file dialogs now default to
  the Downloads folder instead of remembering the last-used directory, and
  frameless windows get rounded corners on Linux.
- Platform: build tooling updates — lerna 9 → **10** (ESM-only; minimum Node.js
  is now 22.13.0) and markdown-it 14 → **15** in nuke-docs (bundled TypeScript
  declarations; its linkify-it v6 no longer autolinks bare domains in
  documentation pages — use explicit markdown links).
- Platform: React 18 → **19** (`react`/`react-dom` 19.2.8) for all extension
  widgets, supported by Theia 1.74 — no component API changes were needed
  beyond qualifying the removed global `JSX.Element` namespace as
  `React.JSX.Element`.
- nuke-cad: STEP/STP/BREP viewport imports skip DAGMC and FEM mesh export by
  default so files load quickly (this shipped earlier without a changelog
  entry, commit 2d0a0fc); script builds still export by default, and imports
  opt in via `--dagmc`/`--mesh`. The backend enforces
  `--no-dagmc`/`--no-mesh` for STEP-source models on every path, including
  rebuilds.
- nuke-cad: DAGMC surface-sense verification is now a hard error with
  diagnostics (every exported surface must have sense 1 or 2);
  watertightness holes mark the export `sealed=False` with a warning,
  incidence > 2 edges are reported as a `nonManifoldEdges` diagnostic
  (multi-volume imprint seams legitimately have incidence 3), and a new
  overlap check (bbox + `BRepClass3d_SolidClassifier` sampling) is reported
  as `overlapCheck` in the result.
- nuke-cad: saving a script-source model's `.py` file debounce-triggers a
  viewport rebuild (STEP-source models are unaffected).
- nuke-core: dependency installs are now spec-aware. `PackageDependency`
  entries carry structured install specs (`pipSpec`, `pipArgs`, `condaSpec`)
  alongside `condaOnly`/`channels`/`extraIndexUrl`; the missing-packages
  install flow (`ensurePackages`) routes them through a new
  `buildDependencyInstallPlan` planner — conda envs batch `condaOnly`/
  `condaSpec` entries into one conda command, everything else installs via
  pip grouped by (`extraIndexUrl`, `pipArgs`) signature (so pinned/VCS specs
  like the commit-pinned pydagmc git URL and `--no-deps` build123d are
  actually honored, and a single `condaOnly` entry no longer flips the whole
  batch to conda). `installCommand` is deprecated (legacy hint-only). Install
  hints in health checks, env validation, and the Python backends render from
  the same fields, and `extensions/nuke-core/src/common/package-registry.json`
  pins the canonical specs for shared packages (openmc/moab → shimwell wheel
  index, gmsh → conda `python-gmsh`, OCP → conda `ocp`, netgen/ngsolve → conda
  `ngsolve`, mpi4py/paraview → conda-only, …) with a vitest consistency test
  (`package-registry.test.ts`) that fails CI on drift between the three
  extension `packages.json` files.

### Fixed

- nuke-cad: additive-shape bounding-box prefilter in `feature_builder.py` now
  uses the build123d `BoundBox` `.min.X`/`.max.X` API.
- nuke-cad: DAGMC volume-to-pre-index tracking through gmsh imprint/merge and
  auto-graveyard insertion now survives tag renumbering after
  `removeAllDuplicates`. The old "disturbed mapping" hard error was replaced by
  geometric signature matching (volume + bbox), so manifest material groups
  (`mat:<name>`) and the auto-created `mat:graveyard` bind correctly.
- nuke-cad: opening large `.nuke-cad` documents no longer pays for DAGMC and
  FEM mesh export. Document opens and rebuilds now default to viewport-only
  builds (`--no-dagmc`/`--no-mesh`), matching STEP imports, while explicit
  export requests still work. A new display-only faceting tolerance
  (`nukeCad.displayFacetingTolerance`, default 0.01) and a soft triangle budget
  (`nukeCad.maxDisplayTriangles`, default 2 000 000) keep viewport tessellation
  bounded; a warning is added to the build result when the budget is exceeded.
  DAGMC and FEM export tolerances remain controlled by `nukeCad.facetingTolerance`.

## [0.1.3] - 2026-07-28

First tagged release.

### Added

- IDE shells: Theia browser application, Electron desktop application, and an
  all-in-one Docker deployment (`applications/`).
- Extensions (`extensions/`):
  - `nuke-core` — shared services, environment detection, and health checks.
  - `nuke-essentials` — core IDE workflow features.
  - `nuke-docs` — product documentation readable inside the IDE.
  - `nuke-sysmon` — system monitor widget.
  - `nuke-fileinfo` — file information views.
  - `nuke-visualizer` — trame/ParaView visualization backends with
    local (vtk.js) / remote (server-rendered) view modes.
  - `openmc-studio` — OpenMC workspace: CAD import/conversion, DAGMC tooling,
    statepoint reading, depletion and optimization runners.
  - `nukelab-integration` — NukeLab service integration.
- Python backend test suites with tiered coverage policy (lightweight
  pytest profile for logic, full-dependency profile exercised in Docker).
- CI/CD: fast PR checks (`ci.yml`), cross-platform Electron packaging with
  draft GitHub Releases on `v*` tags (`build.yml`), weekly all-in-one
  container build + smoke test (`docker.yml`), and a weekly latest-upstream
  early-warning job (`upstream-latest.yml`).
- Functional rendering smoke test (`applications/docker/render_smoke_test.py`)
  gating the trame/ParaView/VTK seam in the container.

### Fixed

- Container image now renders headless: `libosmesa6` provides the OSMesa
  software-GL backend (no X server / EGL device in the image).
- `create_view_widget` no longer requires trame-vtk at import time, so the
  lightweight test profile runs without the rendering stack.

### Changed

- Backend conda environment (`applications/docker/environment.yml`) moved to
  an all-conda-forge visualization/CAD stack (paraview 6.1.1, trame, gmsh,
  cadquery, pythonocc-core sharing conda's VTK 9.6.1); the pip
  `cadquery-ocp`/`cadquery_vtk` pins and the Dockerfile's VTK force-reinstall
  repair step are gone.

[Unreleased]: https://github.com/nukehub-dev/nuke-ide/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/nukehub-dev/nuke-ide/releases/tag/v0.1.3
