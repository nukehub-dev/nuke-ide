# Changelog

All notable changes to NukeIDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- build: optional extensions selectable at build time via `NUKE_EXTENSIONS` allow-list / `NUKE_EXCLUDE_EXTENSIONS` deny-list.
- nuke-cad: disabled toolbar and command-search actions now explain why they cannot run, in the tooltip, section menu, and search row.
- nuke-cad: Fillet and Chamfer offer an opt-in Tangent chain pick that expands one edge click to every tangent-connected edge on the same solid.
- nuke-cad: Document Settings section in the Model Outline shows units (editable), parameter count, name, source, body count, and schema version.
- nuke-cad: Document Settings precision sets maximum decimals for length and angle readouts across measurement labels and model properties.
- nuke-cad: New Sketch opens a Create Sketch task panel with the ribbon in place; empty documents offer Create Sketch/Open Model and the Model Outline shows the body count.
- nuke-cad: command search in the document toolbar (button or `/`) filters and runs any ribbon action, including caret-menu-only entries.
- nuke-cad: ribbon section menus pin any command inline (persisted in `nukeCad.ribbonPins`) and `nukeCad.ribbonLabels` hides tile labels for compact icon buttons.
- nuke-cad: CAD Studio menu under Tools mirrors the sidebar (geometry, panels, analysis, environment commands).
- nuke-cad: Move feature rigidly translates a body by dx/dy/dz with ghosted preview and tip chaining.
- nuke-cad: matching custom undo/redo toolbar icons (the codicon font ships no undo glyph).
- nuke-cad: Move dialog shows document units, a non-zero hint, and previews by default; a zero move fails with a clear error.
- nuke-cad: Ctrl/Cmd-click multi-selects viewport solids (camera frozen while held, crosshair cursor) with Ctrl/Cmd-drag box select and Hide/Isolate Selected (N) bulk actions.
- nuke-cad: Select Other disambiguates overlapping faces from the viewport context menu, with Alt+click cycling through candidates by body.
- nuke-cad: lattice feature replicates a solid feature over a rectangular grid or hexagonal ring with per-cell labels for DAGMC groups.
- nuke-cad: staged DAGMC export with a reported stage log, sense errors naming surface + volumes, and a grouped diagnostics box.
- nuke-cad: tag bodies with material names from the Feature Tree; tags merge into manifest volumes and reach openmc-studio as links.
- nuke-cad: material property cards ({E, nu, rho, k, cp, alpha, yield}) on the region manifest resolved by the FEM service.
- nuke-cad: FEM pressure/temperature boundary conditions with derived von Mises, max-principal, and safety-factor result arrays.
- nuke-cad: faster overlap checks in the fuse path with identical verdicts.
- nuke-cad: mesh repair ops for DAGMC prep (duplicate facets, hole fill, Laplacian smooth, decimate) with per-op counts in the report.
- nuke-cad: pinnable 3D measurements persist in the document, survive rebuilds, and ride undo/redo.
- nuke-cad: per-body Appearance dialog sets display-only color and opacity overrides that persist in the document and never rebuild geometry.
- nuke-cad: Appearance dialog adds user presets (save/apply/delete) and applies an appearance to every body in a multi-body selection.
- nuke-cad: saved named views capture the current camera, restore from the Model Outline, and persist with the document.
- nuke-cad: world-origin axis triad in the viewport with per-axis X/Y/Z eye toggles in a Model Outline Origin section.
- nuke-cad: undo/redo over committed document mutations with toolbar buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
- nuke-cad: multi-part assemblies with instances, connector-frame mates, BOM panel, STEP-assembly export, and placed-solid DAGMC export.
- nuke-cad: single-sheet 2D drawings (A4/A3) with base/projected/section/detail views and SVG + DXF export.
- nuke-cad: up-to-body pad/pocket ends, through-all revolve/groove, subtractive primitives/sweeps, datum-axis patterns, modeled threads.
- nuke-cad: Ellipse (E) and B-spline (B) sketch tools with solver, snap, serialization, rebuild, and Python export support.
- nuke-cad: Explode slider for viewport separation plus Angle and Radius measure modes alongside Distance.
- nuke-cad: viewport right-click menu (Edit Feature, measure, fit) and a draggable feature-creation dialog.
- nuke-cad: result-cache rebuilds persist per-feature B-reps so edits rebuild only the dirty closure.
- nuke-cad: `nukeCad.rebuildOnEdit` preference (auto/manual) to stop edit-triggered rebuilds on expensive documents.
- nuke-cad: cached tessellation skips meshing on open, capped by the `nukeCad.resultCacheSizeMB` preference.
- nuke-cad: pad/pocket end selector (blind, face hits, picked face, through-all) with optional two-sided extrusion.
- nuke-cad: 3-point planes, face-midplanes, and two-point line datums in the Sketch Plane picker without a build round-trip.
- nuke-cad: hole counterdrill preset, taper angle, blind-only drill-point angle, and cosmetic thread flag.
- nuke-cad: datum-placed primitives, per-instance pattern scale, multiTransform chains, face-delete defeature, draft neutral plane.
- nuke-cad: Slot tool, PointOnObject/DistanceX/Y/Diameter/Block-freeze constraints, and diagnostics for redundant/missing constraints.
- nuke-cad: `nukeCad.navigationStyle` remaps viewport mouse/touch bindings (orbit, solidworks, tinkercad, touchpad).
- nuke-cad: document units (mm/cm/m) with unit-aware curve expressions and suffixed dimension labels.
- nuke-cad: mate-connector assembly document model with closed-form placement and DOF counting (model layer).
- nuke-cad: IGES/BREP/glTF read-write plus STL export, IGES face-sewing import, and versioned thread tables.
- nuke-cad: Trim, Extend, Split, Fillet/Chamfer, Polyline, rectangle/polygon/arc-slot tools with one-click redundant removal.
- nuke-cad: Move, Copy, Rotate, Mirror, Scale, Rectangular Array, Offset, and Join sketch tools with constraint hygiene.
- nuke-cad: carbon-copy import of another sketch plus second-focus and axis construction lines for ellipses.
- nuke-cad: patterns/mirrors over primitives re-derive the primitive in Python export instead of hatching.
- nuke-cad: unit algebra in the expression mini-language with convert-or-fail coercion (unitless paths unchanged).
- nuke-cad: STEP carries per-solid labels and face colors; manifests accept physical-model UUIDs; pre-export deviation gates.
- nuke-cad: `nukeCad.viewportBackground` preference (theme, dark, light, gradient) for the 3D canvas backdrop.
- nuke-cad: parameter spreadsheet in Model Outline (edit-in-place expressions, guarded delete) with BOM CSV export.
- nuke-cad: Loft across ordered sketch sections and Helical Sweep along an analytic helix, both pattern/mirror eligible.
- nuke-cad: Sweep and Pipe features along picked 3D curves with ghosted preview and Python export.
- nuke-cad: ghosted Preview in every feature dialog showing the operation on true geometry.
- nuke-cad: multi-select, Hide/Isolate with Show all, and one-click Fuse fix for overlaps in the Model Outline.
- nuke-cad: viewport shading popover (Shaded, Shaded + Wireframe, Edges only, X-ray) with ghost-opacity slider.
- nuke-cad: click-two-points distance measure with a persistent viewport-only measurements list.
- nuke-cad: X/Y/Z section-plane slicing with flip and slider; visual only, exits via button or Esc.
- nuke-cad: read-only solid properties (volume, area, bbox, center of mass, counts) with a pin toggle in Model Outline.
- nuke-cad: Model Outline list/table toggle with sortable SI-suffixed columns and two-way selection sync.
- nuke-cad: sketch snap magnet toggle and S/M/L snap-radius control with status-line reflection.
- nuke-cad: `Q` context shortcut bar with sketch tools or feature actions anchored at the cursor.
- nuke-cad: Ctrl+click two sketch entities for a popover of valid geometric relations.
- nuke-cad: `nukeCad.sketchAutoDimension` opens an inline dimension input right after entity creation.
- nuke-cad: New Document templates (Empty, Pincell starter, Tokamak starter) merged over the empty document.
- nuke-cad: 3D curves (points, parametric, Fourier) render in the viewport, rebuild headless, and export to Python.
- nuke-cad: multi-body documents with booleanFuse/Cut/Common features, Bodies section, and v1-to-v2 migration.
- nuke-cad: feature reorder with dependency validation, cascade delete, inline rename, edit-parameters, and reference repair.
- nuke-cad: one-way deterministic build123d-ish Python export for `.nuke-cad` documents via the save dialog.
- nuke-cad: fillet, chamfer, draft, and shell dress-up features with viewport edge/face picking.
- nuke-cad: linear/circular patterns, mirror, and a viewport-placed hole wizard (simple, counterbore, countersink).
- nuke-cad: tokamak demo gate with GUI-path driver, committed fixture, and volume/face-count drift coverage.
- nuke-cad: script-first parametric CAD authoring (build123d/CadQuery) with live viewport and canonical STEP export.
- nuke-cad: `.nuke-cad` documents as a full authoring mode sharing one build path with script builds.
- nuke-cad: interactive 2D sketcher with snap, auto/explicit constraints, driving/reference dimensions, and live drag solving.
- nuke-cad: document build pipeline executing pad/pocket/revolve/groove in topological order with per-feature status.
- nuke-cad: fingerprint-based topological reference resolution with clear errors on ambiguous/unmatched references.
- nuke-cad: sketch-on-face datums derived deterministically from planar predecessor faces with optional offset.
- nuke-cad: external-geometry references projected as construction geometry without joining sketch output.
- nuke-cad: On Face sketch-plane picking and an External Geometry tool with dashed reference rendering.
- nuke-cad: per-sketch reference-resolution counts in the status line and broken-reference badges in the Feature Tree.
- nuke-cad: geometric tessellation fingerprints backing face-pick references and backend resolution.
- nuke-cad: Feature Tree panel with datums, sketches, features, suppression toggles, and build-status markers.
- nuke-cad: New/Save/Save-As document plus New Sketch and Exit Sketch commands.
- nuke-cad: DAGMC export via gmsh imprint/merge with manifest `mat:<name>` groups and auto graveyard.
- nuke-cad: FEM volume meshing to gmsh/Exodus/INP/VTK with manifest blocks, side sets, and per-region refinement.
- nuke-cad: direct STEP/IGES/BREP opening in the CAD viewport; STEP files open in nuke-cad by default.
- nuke-cad: empty-viewport Open CAD Model button with a file picker for scripts and STEP files.
- nuke-cad: CalculiX FEM analysis panel (materials, boundary conditions, `ccx` run, `.fem.vtk` opening).
- nuke-cad: generic solver job runner plus OpenFOAM case scaffolding and per-solid STL export.
- nuke-cad: Model Outline panel with manifest volumes/surfaces, two-way pick sync, and build-warnings box.
- nuke-cad: `nukeCad.facetingTolerance` default tolerance for geometry builds, honored by open/rebuild/import.
- nuke-cad: netgen meshing engine option with OCC imprint and second-order mesh support.
- nuke-cad: `lengthScale` build option forwarded to DAGMC export for meter-scaled transport meshes.
- nuke-cad: EDIT_SKETCH command and Feature-Tree action reopen an existing sketch for editing.
- nuke-cad/openmc-studio: one-click nuke-cad import loads `.h5m` + regions manifest with placeholder materials into the project.
- nuke-cad/openmc-studio: DAGMC Imprint & Merge refacet routes through nuke-cad, falling back to the OpenCASCADE path.
- nuke-core: Nuke Tools sidebar aggregates every Nuke command in a searchable, categorized, state-aware left-panel view.
- nuke-essentials: shared UI components (dialog, toolbar, empty state, loading overlay, panel, form layout) on the theme module.
- nuke-essentials + nuke-visualizer + nuke-cad: shared viewer chrome (orientation cube, nav bar, view badge, status line) in all 3D views.
- nuke-visualizer: ParaView-style color mapping with a 34-preset library, custom range, invert/log toggles, and component selection.
- nuke-visualizer: native 3D output viewers (tracks, collision-track, weight-windows, voxel) render in-IDE with instant color-by.
- nuke-visualizer: native tally, source, overlay/slice, `geometry.xml`, and multiblock viewers with clip and pick sync.
- nuke-visualizer: DAGMC files open with volume/material/group isolation and per-axis clip.
- nuke-visualizer: compressed multiblock DAGMC payloads decode and render with volume isolation.
- nuke-visualizer: labeled orientation-cube overlay in native 3D viewers snaps to standard views on click.
- nuke-visualizer: distance measure in native 3D viewers captures two surface points with an in-scene label.
- nuke-visualizer: Viewer Settings sidebar binds color, shading, clip, measure, and view snaps to the active viewer tab.
- nuke-visualizer: DAGMC Outline sidebar with volume/material/group trees, Graveyard toggle, Show all, and search.
- nuke-visualizer: two-way DAGMC Outline selection sync with auto-reveal that never steals focus.
- nuke-visualizer: DAGMC viewer tabs open instantly with a loading overlay while conversion runs.
- nuke-visualizer: orbit/pan/zoom camera with damping plus shading and clip-plane controls in all native viewers.
- nuke-visualizer: `vtk` is a required dependency with a guided install where it is missing.
- nuke-visualizer: XML and legacy-ASCII VTK files plus tree View 3D render natively with instant color control.
- nuke-visualizer: triangle datasets render as shaded surfaces with exact per-cell coloring.
- nuke-visualizer: DAGMC graveyard filtering derives limits from the mesh bounding box so real geometry survives.
- nuke-visualizer: trame/ParaView servers deleted along with the proxy/iframe layer and dependencies.
- nuke-visualizer: last trame remnants deleted; the CSG-builder preview renders through the native geometry viewer.
- nuke-visualizer: output viewers are native-only; unreadable files show an error pointing at the generic VTK viewer.
- nuke-visualizer: x-ray ghosting no longer fades the tally volume; geometry ghosts while tally colors stay at slider strength.
- nuke-visualizer: CSG Outline panel with per-cell visibility, material tree, Void switch, search, and selection sync.
- nuke-visualizer: theme-aware geometry palette and converged viewer chrome that follow theme switches live.
- nuke-visualizer: tally+source overlay layers the statepoint source bank as energy-colored points over the drape.
- nuke-visualizer: full-3D tally overlay no longer asks about graveyard filtering; the Outline switch toggles it post-load.
- nuke-visualizer: tally volume renders as colored points in Points mode and draws over ghosted shells.
- nuke-visualizer: Smooth volume switch renders tally meshes as hardware-trilinear raycast volumes.
- nuke-visualizer: Calculator derived fields over dataset arrays plus an SVG histogram with stats in output viewers.
- nuke-visualizer: warp-by-vector exaggerates FEM displacement meshes client-side with True/Auto/Capped scaling.
- nuke-visualizer: Line probe samples mesh tallies along a segment with a results table and CSV export.
- nuke-visualizer: Threshold window hides cells outside the active color-by range with slider and status coverage.
- nuke-visualizer: Contour panel extracts iso-surfaces from tally meshes into a sibling tab.
- nuke-visualizer: Exodus viewer exports the loaded steps to WebM with progress and Cancel.
- nuke-visualizer: decimated direction cones in the tracks viewer with density/size controls.
- nuke-visualizer: Link cameras toggle syncs orbit direction and distance across views of the same file.
- nuke-visualizer: depletion per-step statepoints open in the statepoint viewer.
- nuke-visualizer: NCrystal tab browses the material library, builds config strings, and plots S(a,b) and absorption.
- nuke-visualizer: ENDF tab browses library directories with decay, yield, and reaction-section detail.
- nuke-visualizer: voxel-plot and summary HDF5 open on double-click with a draggable viewer/table split.
- nuke-visualizer: visualizer proxy retries refused startup connections instead of false unreachable errors.
- nuke-visualizer: nuclear data browser with a searchable nuclide library and one-click XS plotting.
- nuke-visualizer: weight-windows viewer mesh selector for multi-mesh files.
- nuke-visualizer: shared HDF5 output readers and viewers for tracks, collision-track, and weight-windows files.
- nuke-visualizer: IFP kinetics tab (kinetics parameters with uncertainties, CSV export) plus restart-preview and random-ray viewers.
- openmc-studio: DAGMC Editor routes picked CAD files to import instead of landing on an empty model.
- openmc-studio: void cells emit standard `material="void"` so this OpenMC accepts them.
- openmc-studio: Simulation Dashboard re-attaches to in-flight runs after reload with live progress and log streaming.
- openmc-studio: one-click graveyard creation/re-tagging for DAGMC models; CAD conversion auto-creates it by default.
- openmc-studio: Import CAD button converts STEP/IGES/BREP/STL straight into DAGMC format.
- openmc-studio: optional Imprint & Merge DAGMC refacet that re-creates dropped graveyard volumes.
- openmc-studio: one-click fix switches incompatible projects back to continuous energy with materials restored.
- openmc-studio: `copyDagmcToRunDirectory` setting copies the DAGMC file into the run directory; paths stay project-relative.
- openmc-studio: element symbols expand to natural nuclide compositions on XML/script export.
- openmc-studio: one-click CE to multi-group conversion with lossless revert to continuous energy.
- openmc-studio: nuclide-wise multi-group mode for random ray on DAGMC geometries.
- openmc-studio: per-environment runtime probe adapts XML emission and gates dev-only options for upstream drift.
- openmc-studio: plain-language mode guard rails (depletion vs multi-group, IFP vs random ray, score whitelist, ...).
- openmc-studio: tally-derivative sensitivity tallies (density/nuclide-density/temperature perturbations).
- openmc-studio: custom depletion chain builder from ENDF-B-VII libraries or existing chain subsets with full closure.
- openmc-studio: manual Library mode in the MGXS generator with user-chosen XS types, domains, and decomposition.
- openmc-studio: random-ray adjoint editing, trigger ignore_zeros, TokamakSource time distributions, search cancellation, CMFD validation.
- openmc-studio: CMFD acceleration UI, validation, codegen, and run driver through the IDE.
- openmc-studio: mesh sources with sub-source enforcement plus TokamakSource with Miller geometry and emission profiles.
- openmc-studio: per-tally precision triggers with automatic emission plus run-level trigger settings.
- openmc-studio: criticality search as an optimization-widget mode with live table and apply-to-model.
- openmc-studio: Advanced settings section (event-based transport, photon creation, biasing, lost-particle limits, ...).
- openmc-studio: modular simulation-dashboard tabs behind a registry; project files carry schema 1.1.0.
- openmc-studio: full source model with file/compiled/multi sources, strengths, constraints, and surface source I/O.
- openmc-studio: output-control settings (statepoint batches, tracks, photon physics, entropy mesh, restarts).
- openmc-studio: track and lost-particle files move into `tracks/`/`particles/` subfolders; weight windows gain a dashboard action.
- openmc-studio: complete 79-score tally catalog with descriptor-driven editors for all 23 filter types.
- openmc-studio: IFP kinetics workflow with auto-generated tallies and optional per-group b_eff.
- openmc-studio: volume-calculation window with triggers and adopt-into-materials plus a native PNG plotting window.
- openmc-studio: advanced depletion (IndependentOperator, transfer rates, all normalizations, per-nuclide Q).
- openmc-studio: macroscopic multigroup materials and env-gated NCrystal material import.
- openmc-studio: random ray support with dashboard tab, MGXS generator window, and FW-CADIS weight-window generation.
- openmc-studio: DAGMC material overrides plus auto ID toggles and sync-for-depletion.
- openmc-studio: single-particle restart runs with track capture and post-run track handoff.
- Testing: Playwright UI smoke suite (`yarn test:ui`) covering boot, dashboard tabs, project flow, and windows in weekly CI.
- Testing: weekly upstream-OpenMC-develop CI lane with the Python suite on a cached conda full profile.
- Testing: end-to-end layer running real OpenMC drivers and project-file fixtures, env-gated and skipping cleanly otherwise.
- Testing: nuke-cad pincell DAGMC e2e (labeled pincell to imprinted h5m to real run asserting zero lost particles).

### Changed

- Platform: Theia 1.73.1 to 1.74.1 with the deprecated Vercel AI provider removed; Electron shell moves to 43.4.0.
- Platform: lerna 9 to 10 (Node.js >= 22.13.0) and markdown-it 14 to 15 in nuke-docs.
- Platform: React 18 to 19 for all extension widgets with no component API changes.
- nuke-cad: viewport toolbar groups actions into labelled sections with promoted buttons, per-section menus, and a width-driven compact mode.
- nuke-cad: faster large-model rebuilds via worker-side tessellation parsing and incremental scene updates.
- nuke-cad: multi-body opens and rebuilds reuse cross-body overlap verdicts for unchanged bodies instead of re-running the O(n²) exact boolean gate (tokamak: 30 s → 6 s warm, single edit 21 s → 8 s).
- nuke-cad: icon-only document toolbar, purpose-drawn sketch icons, collapsible build warnings, and distinct panel icons.
- nuke-cad: New Document disabled while a document is open so unsaved work can't be replaced silently.
- nuke-cad: draggable sketch toolbar, labeled Finish Sketch pill, auto-separated dimension labels, axis gizmo, wireframe toggle.
- nuke-cad: view-label overlay, shaded/wireframe/edges-only cycling, selection-aware fit, and Tab sketch toggle.
- nuke-cad: overlapping additive pattern/mirror instances now union instead of raising an overlap error.
- nuke-cad: cross-body overlap downgraded from abort to a reported warning with volumes.
- nuke-cad: viewport chrome redesign with a structured header toolbar, overflow menu, and collapsible sketch panel.
- nuke-cad: STEP imports skip DAGMC/FEM export by default for fast loads; script builds still export.
- nuke-cad: DAGMC surface-sense verification is now a hard error; watertightness and overlap stay reported diagnostics.
- nuke-cad: saving a script-source model rebuilds the viewport (STEP-source models unaffected).
- nuke-cad: viewport context menu gains Find in Feature Tree, Clear Selection (Esc), and shortcut hints.
- nuke-core: spec-aware dependency installs with a canonical package registry and a drift-failing consistency test.
- nuke-essentials: workspace settings now live in `<project>/.nuke-ide/` instead of `<project>/.theia/`.
- nuke-essentials: Save Workspace As defaults to the new `*.nuke-workspace` format (old formats still open).
- nuke-visualizer: two-button viewer headers removed; Screenshot/Reload live on the canvas bottom bar.
- nuke-visualizer: Viewer Settings and DAGMC Outline sidebars restyled to match the CAD panels with no behavior change.

### Removed

- nuke-visualizer: trame/ParaView servers, reverse proxy, and dependencies removed; converters plus native viewers cover the seam.

### Fixed

- app: startup splash tracks real loading progress and never blanks out on slow connections.
- CI: vitest job compiles extensions first; conda pin no longer requests an unsatisfiable Python.
- docker: image Python env ships working build123d with the OCP 7.9 shim and a CI version guard.
- nuke-cad: Copy sketch icon renders both offset squares (the standard mask declaration dropped the back square).
- nuke-cad: Escape cancels an inline parameter edit even when Theia's keybinding registry consumes the key.
- nuke-cad: large or far-offset models no longer vanish — viewport clip planes scale with the scene instead of a fixed 10,000-unit far plane (this also removes z-fighting on concentric shells).
- nuke-cad: edits now really rebuild only the dirty features (the partial-rebuild RPC was never wired, the CLI flag was misspelled, and a same-path rebuild kept stale triangles on screen).
- nuke-cad: opening a document from the explorer uses the cached open path instead of a full rebuild, and full builds prime the per-feature cache so the first edit is already partial.
- nuke-cad: tessellated triangles follow shell face orientation, so reversed faces no longer wind inward.
- nuke-cad: DAGMC export mesh floor raised so needle facets no longer cause sporadic lost particles.
- nuke-cad: viewport tool keys keep working while notification toasts are visible.
- nuke-cad: viewport matches the theme at first paint with themed secondary buttons and non-overlapping chrome.
- nuke-cad: single-slot shading/section popovers, Hide/Isolate/Show-All context actions, and capped explode framing.
- nuke-cad: status pill caps its width from the navigation cluster instead of sliding underneath.
- nuke-cad: tokamak demo TF inner-leg pads extrude symmetric so the pillar defect is gone, pinned by a bbox test.
- nuke-cad: hiding bodies hides their consumed sweep-path curves and excludes them from picking.
- nuke-cad: pairwise-disjoint additive pattern instances skip the boolean union; overlapping ones fuse in one parallel pass.
- nuke-cad: closed-spine sweeps rebuild as station lofts so they survive STEP export to DAGMC.
- nuke-cad: CAD viewport adapts to light themes with a steel body tone and dark edges.
- nuke-cad: measure markers no longer flash as a model-sized circle on first click.
- nuke-cad: view snaps re-pole orbit controls so mouse orbiting survives gizmo-axis clicks.
- nuke-cad: reopening a model shows a loader instead of a stale Untitled empty state.
- nuke-cad: axis gizmo and view label hidden in the empty viewport.
- nuke-cad: sketch chrome no longer overlaps (constraint bar top-center, compact toolbar, stable Finish pill).
- nuke-cad: opening a model auto-reveals the Model Outline and Feature Tree panels.
- nuke-cad: Finish Sketch pill top-right, draggable collapsed toolbar, and owned top-center constraint bar.
- nuke-cad: dimension labels are draggable-pinnable with calmer hover styling and themed popover input.
- nuke-cad: Save dialog defaults to and normalizes the `.nuke-cad` extension.
- nuke-cad: Escape clears sketch selection, hover outlines primitives, and the status line shows bindings.
- nuke-cad: pick-mode banners are click-through with proper text wrapping.
- nuke-cad: overlay form controls follow the dark theme instead of rendering white.
- nuke-cad: Model Outline and Feature Tree empty-state icons render at a readable size.
- nuke-cad: single-key sketch tool shortcuts with Escape fall-through and a keyboard cheat-sheet popover.
- nuke-cad: viewport shortcuts scoped to viewport focus so Theia shortcuts work elsewhere.
- nuke-cad: sketch tool tooltips land beside buttons and show their shortcut letter.
- nuke-cad: Parameters, Diagnostics, External Geometry, Shortcuts, and Measurements panels share draggable clamped chrome.
- nuke-cad: grouped two-column sketch toolbar at half height with a clearly highlighted active tool.
- nuke-cad: exiting a brand-new sketch saves reliably via Tab or the Finish pill.
- nuke-cad: viewport renders through the live camera with an explicit navigation cluster and F fit shortcut.
- nuke-cad: sketch-mode pan/zoom repaints with anchored labels; compact buttons escape Theia's 65px minimum.
- nuke-cad: entering a saved sketch frames its bounds; dialog labels, tooltips, and panel closing fixed.
- nuke-cad: viewport chrome layout no longer clips or overflows; dialogs are real modals on shared components.
- nuke-cad: non-fatal build warnings surface as a dismissible viewport strip.
- nuke-cad: sketch-mode lifecycle hardened with solver disposal, view restore, and visible errors.
- nuke-cad: viewport no longer flashes empty state on repeated tessellation; opens show a loading overlay.
- nuke-cad: rebuilding a feature-less document reports nothing-to-build instead of a no-solids failure.
- nuke-cad: REBUILD_GEOMETRY warns when the CAD viewport isn't open instead of silently idling.
- nuke-cad: dimension popover input stays in sync with external parameter changes.
- nuke-cad: 3-point arc clicks catch solver failures and reset pending auto-constraints.
- nuke-cad: sketch snap returns on-curve candidates for arcs, not just lines and circles.
- nuke-cad: document validation rejects dimensions targeting nonexistent primitives.
- nuke-cad: geometry-service protocol uses a result marker so user prints can't fake the payload.
- nuke-cad: DAGMC export drops graveyard auto-detection; existing graveyards must be flagged explicitly.
- nuke-cad: DAGMC export skips gmsh faces collapsing to zero triangles instead of KeyErroring.
- nuke-cad: pad and pocket share inner-wire semantics (islands for pads, through-holes for pockets).
- nuke-cad: overlapping additive features raise a clear builder error instead of invalid volumes.
- nuke-cad: revolve/groove axes must lie in the sketch plane, failing fast otherwise.
- nuke-cad: Python service rejects unsupported feature types and missing parameters before building.
- nuke-cad: validation accepts lattice, primitive, multi-transform, defeature, and Move features instead of rejecting them as unsupported.
- nuke-cad: features added to a reopened document get ids unique within it instead of colliding with saved ones.
- nuke-cad: sketches/holes on reversed-orientation faces no longer mirror.
- nuke-cad: topology repair popover shows clickable per-candidate fingerprints for ambiguous and unmatched references.
- nuke-cad: build responses forward per-feature warnings and the consumed-body list.
- nuke-cad: cuts disjoint from their target fail explicitly instead of silently dropping.
- nuke-cad: unsupported pad/pocket/draft parameters fail validation loudly instead of being ignored.
- nuke-cad: features on pattern-consumed bodies report stale like dress-ups and patterns.
- nuke-cad: pattern/mirror/hole datum references resolve against the whole document.
- nuke-cad: reordering a pattern/mirror above its source is rejected.
- nuke-cad: topology repair commits are atomic; failures leave references untouched.
- nuke-cad: GUI pincell DAGMC export imprints in gmsh first so document-built pincells stop leaking particles.
- nuke-cad: geometry scripts run on OCP 7.9 via an eagerly applied downcast-alias shim.
- nuke-cad: builds extract real selectors from build123d labels and CadQuery assembly names.
- nuke-cad: CadQuery assembly extraction hardened for cadquery 2.7/2.8 via partner matching and UUID filtering.
- nuke-cad: DAGMC export uses OpenMC-recognized fallback groups and mapping-safe volume tracking.
- nuke-cad: mesh service fixes side-set numbering, dihedral metric, max_size override, and tetra10 reporting.
- nuke-cad: FEM service emits compatible boundary cards, parses real FRD output, and caps runs with a timeout and log.
- nuke-cad: OpenFOAM STL export loads STEP directly with sanitized names, checked writes, and wired boundaries.
- nuke-cad: user geometry scripts run isolated with a timeout; SystemExit becomes a structured error.
- nuke-cad: Python files stay with the text editor; the CAD viewport is reached via Open With.
- nuke-cad: working face-pick highlight, no tessellation race or flicker, and in-viewport error banner.
- nuke-cad: backend job registry with cancel, timeout, output caps, and a FEM Stop button.
- nuke-cad: truthful CAD health check requiring OCP/build123d/gmsh with correct optional-package names.
- nuke-cad: additive-shape bbox prefilter uses the build123d BoundBox min/max API.
- nuke-cad: DAGMC volume tracking survives gmsh tag renumbering via geometric signature matching.
- nuke-cad: opening large documents defaults to viewport-only builds with a display tolerance and triangle budget.
- nuke-cad docs: corrected the sketch segment limit, exported-helix note, and edge-overlay description.
- nuke-core + nuke-cad + nuke-visualizer + openmc-studio: sidebar panels scroll natively; PerfectScrollbar's overlay no longer covers panel content.
- nuke-essentials: empty-state card centers itself in wide sidebars instead of hugging the left.
- nuke-essentials: color picker popup portals to the document body so it never clips in narrow sidebars.
- nuke-essentials: edge-adjacent tooltips flip and clamp to the viewport instead of rendering off-screen.
- nuke-essentials: stretched-wrapper tooltips track their control across scroll and resize.
- nuke-essentials + nuke-visualizer: shared checkbox/slider/search/switch/badge controls used by viewer sidebars and outline panels.
- nuke-essentials + nuke-visualizer + openmc-studio + nuke-cad: shared NukeSelect replaces all builtin selects so dropdowns never clip.
- nuke-visualizer: DAGMC Outline always binds on viewer open instead of sitting empty.
- nuke-visualizer: tally overlay/slice parsing accepts empty appended sections and real vtk-9 character offsets.
- nuke-visualizer: legacy STRUCTURED_GRID `.vtk` files preview with voxel axes or a center-point fallback.
- nuke-visualizer: DAGMC-less full overlay renders the voxel mesh instead of a cell-center cloud.
- nuke-visualizer: regular weight-window/voxel grids render as instanced voxel blocks instead of moire point clouds.
- nuke-visualizer: tally mesh/slice/overlay/contour/source tabs open instantly with a loading status while converting; failures show in-tab.
- nuke-visualizer: tally line-probe and contour panels pre-fill statepoint/tally/score from the open tab, share one bottom strip, and offer X/Y/Z span shortcuts.
- nuke-visualizer: tally slices render as smooth shaded surfaces with source-side decimation.
- nuke-visualizer: round soft points in every native point cloud instead of square pixels.
- nuke-visualizer: true Full 3D tally-on-geometry overlay paints the tally onto DAGMC volumes with outline isolation.
- nuke-visualizer: mesh `.vti` exports no longer silently rescale geometry; spacing and origin round-trip.
- nuke-visualizer: DAGMC viewer shows the edge overlay only in Shaded + Edges mode.
- nuke-visualizer: color-legend gradient bar renders as a floating card in every native viewer.
- nuke-visualizer: DAGMC Graveyard toggle works; conversion keeps the graveyard block hidden by default.
- nuke-visualizer: Viewer Settings sidebar binds immediately on open via the main-area tab fallback.
- nuke-visualizer: Escape works after canvas clicks (measure cancel, popover dismiss) via canvas focus.
- nuke-visualizer: DAGMC status line restores the `N of M volumes` count without model info.
- nuke-visualizer: smooth damped orbiting on large models with a driven update loop and coalesced repaints.
- nuke-visualizer: bottom-bar quick actions for clip toggle, X-plane section, shading cycle, and DAGMC exclude/isolate.
- nuke-visualizer: bottom-bar Clip/Shading anchored popovers matching the CAD viewport cards.
- nuke-visualizer: DAGMC drape blocks with ambiguous vtk-9 offsets parse via validated fallback instead of decompress errors.
- nuke-visualizer: Smooth Interpolation reaches the converter (trilinear point data) with a matching Pixelated slice mode.
- nuke-visualizer: CSG overlay tabs ghost the extracted cells under tally voxels with the CSG Outline bound.
- nuke-visualizer: geometry views open instantly with a spinner; extraction failures land in-tab.
- nuke-visualizer: overlay auto-detects its geometry via workspace walk, project pin, or lone `.h5m` before asking.
- nuke-visualizer: smooth tally volume is stencil-masked to the model footprint so hotspots stay inside.
- nuke-visualizer: Range row gains per-side resets and a dual-thumb slider; spinner arrows removed.
- nuke-visualizer: tally+source overlay layers the source bank on CSG tabs too, not just DAGMC drapes.
- nuke-visualizer: tally means divided by realizations so every native tally number reads correctly instead of N x high.
- nuke-visualizer: smooth-volume clip cuts reveal data instead of smearing the dataset into the cut.
- nuke-visualizer: Tally volume + Smooth volume rows work on tally mesh tabs with auto-dimming CSG context.
- nuke-visualizer: CSG cell boxes follow OpenMC plane senses so pincell moderators and clads size correctly.
- nuke-visualizer: CSG Outline binds tally overlay tabs for underlay hide, Void switch, and ghost highlight.
- nuke-visualizer: CSG Outline hide/isolate applies on the canvas through one shared visibility rule plus a canvas menu.
- nuke-visualizer: viewer right-click menu clamps inside the viewport with grouped actions and checked shading.
- nuke-visualizer: DAGMC Outline header truncates with tooltips, sticky badges, hover isolate, and muted graveyard row.
- nuke-visualizer: output viewer inputs gain focus/disabled styling and themed dropdown lists.
- nukelab-integration: expired server tokens re-mint silently so file transfers never hang on Preparing download.
- openmc-studio: DAGMC universes sync before CoupledOperator creation so coupled depletion runs.
- openmc-studio: FW-CADIS generation validated against random-ray mode; repeat CAD conversions stop duplicating graveyards.
- openmc-studio: nuclide-wise MGXS with random-ray sets the energy mode directly instead of via the rejecting converter.
- openmc-studio: run output directory excluded from the file watcher to stop file-manager lag.
- openmc-studio: runner caps captured output, batches log streaming, and replaces re-written track files in place.
- openmc-studio: project-relative DAGMC/MGXS asset paths so moved projects keep working.
- openmc-studio: ray_source XML format probed per environment instead of emitting dev-clone syntax everywhere.
- openmc-studio: macroscopic materials offer the required macro unit; MG-model MGXS crashes surface the real cause.
- openmc-studio: depletion solver dropdown emits only driver-accepted integrator names.
- openmc-studio: surface generation no longer stamps vacuum boundaries everywhere; regenerate XML for affected projects.
- openmc-studio: cylinder surfaces generate valid Python; kinetics scripts include IFP tallies; macro materials get their unit.
- openmc-studio: MGXS/k-eff-search fraction fixes (valid kwargs, no Model.clone, same-element renormalization).
- openmc-studio: chain builder accepts both ENDF neutron layouts and closes FPY borrow-parent references.
- openmc-studio: schema trigger settings round-trip to XML and appear in the UI.
- openmc-studio: DAGMC-override, MGXS-generator, and volume-calculator selections stick immediately.
- openmc-studio: tallies.xml and plots.xml parse back on XML import using the real element format.
- openmc-studio: tallies emit one space-joined nuclides element; codegen emits real filter constructors.
- openmc-studio: weight-window generators use the real settings.xml format.

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
