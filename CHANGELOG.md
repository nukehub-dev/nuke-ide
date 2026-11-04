# Changelog

All notable changes to NukeIDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- nuke-ai: safe edits preview and apply OpenMC project name, description, and author changes with confirmation and session-scoped undo.
- openmc-studio: NukeAI reads the run mode and every supported OpenMC settings value before previewing an edit.
- openmc-studio: NukeAI advanced settings edits cover output, particle cutoffs, and kinetics (IFP) with nested-safe undo and IFP/inactive cross-checks.
- openmc-studio: NukeAI previews, applies, and undoes independent OpenMC source add/update/remove edits for fixed-source runs, with a read-only source inventory.
- nuke-cad: parametric components add box, cylinder, tube, sphere, cone, and plate-with-hole templates with editable dimensions and radius/diameter aliases.
- nuke-cad: mechanical component templates add L bracket, flange, stepped shaft, pipe with bore, and bolt-circle plate starters.
- nuke-cad: nuclear component templates add hex cell, control-rod guide tube, and assembly grid plate starters.
- nuke-essentials: a shared compact action menu provides keyboard navigation, focus return, and narrow-width icon collapse.
- nuke-ai: embedded action menus make the read-only context actions visible in the statepoint loader, CAD toolbar, and DAGMC editor.
- nuke-visualizer: the statepoint viewer header and empty loader expose Ask About Context, Explain Statepoint, and Diagnose Statepoint.
- nuke-cad: the CAD document toolbar exposes the NukeAI actions menu alongside the ribbon.
- openmc-studio: the DAGMC editor header exposes NukeAI actions while the Simulation tab keeps its validation and run groups.

### Changed

- nuke-ai: the chat prompt, chat tool list, Diagnostics tool list, skill allowlists, and MCP read-only allowlist are generated from one capability catalog, so enabled capabilities cannot silently disappear.
- nuke-cad: component-template count parameters rebuild the requested pattern or hole array at creation time instead of staying at the shipped count.
- nuke-cad: NukeAI actions move beside the floating CAD search launcher and open upward, keeping the ribbon uncluttered and the menu clear of dialogs.
- nuke-cad: BOM, Model Outline, and Feature Tree empty states use the shared card, drop duplicate status rows, and offer New CAD Document/Open CAD Viewport actions.
- nuke-visualizer: CSG/DAGMC outlines, Dataset Inspector, and Viewer Settings use the shared empty-state card; OpenMC geometry/tally cards align at the top.
- nuke-visualizer: CSG Outline uses an overlapping-primitives icon so it stays distinct from OpenMC Geometry.
- nuke-visualizer: the CSG Outline sidebar/activity icon and Nuke Tools entry use the same primitives glyph.
- nuke-ai: Diagnose CSG Geometry uses the shared CSG primitives glyph instead of the old symbol icon.
- nuke-essentials: the generic code Outline view is closed in the default shell; reopen it from View → Outline for code files.

### Removed

### Fixed

- nuke-essentials: illustrated empty-state icons and CAD mask glyphs render at the intended size instead of Theia's 16px codicon default.
- nuke-essentials: shared dialogs, color picker, viewer bar, ViewCube, and view badges expose screen-reader names and keyboard-focus tooltips.
- nuke-ai: NukeAI action menus use an icon-only bot trigger with a tooltip, and dashboard groups use the bot icon and sentence-case labels.
- nuke-ai: detached chat windows keep the NukeAI welcome and tool-card styling.
- openmc-studio: tally and dashboard checkboxes follow the active theme, checkbox labels stay sentence case, and icon-only actions expose screen-reader names.
- nuke-visualizer: probe and find-data cards share one slot without covering each other or the bottom bar, the viewer bar wraps on narrow panels, and icon-only controls expose screen-reader names.

## [0.2.1] - 2026-11-04

### Added

- nuke-ai: Diagnose CSG Geometry and Diagnose DAGMC Model focus OpenMC project validation and diagnosis on CSG and DAGMC findings.

### Fixed

- nuke-ai: Nuke Diagnostics can call its read-only CAD, OpenMC, CSG, DAGMC, and statepoint tools again after the allowlist guard compared sanitized tool names to dotted capability ids.
- nuke-ai: contextual actions verify the active CAD document, OpenMC project, run, statepoint, or DAGMC viewer first and show the missing prerequisite instead of opening a chat or calling a model.

## [0.2.0] - 2026-11-04

NukeIDE 0.2.0 is the first release with NukeAI: an in-IDE agent that reads CAD, OpenMC, and visualization state, previews changes, and applies them with confirmation. The release also adds a complete CAD authoring loop, broader OpenMC 0.16 coverage, fully native visualization, and refreshed build and verification infrastructure.

### Upgrade notes

- NukeAI ships as an optional extension. Configure an OpenAI-compatible model provider before first use; no model is bundled.
- Workspace settings now live in `<project>/.nuke-ide/`; older workspace files still open.
- CAD AI authoring and script authoring are off by default. External MCP is off by default and read-only when enabled.

### Known limitations

- Undo is session-scoped and is discarded when the IDE session ends.
- CAD AI authoring requires an enabled setting and a saved document; script authoring is Linux-only.
- External MCP is opt-in, token-protected, read-only, and backend-global for multi-user deployments.
- NukeAI requires a configured model provider.
- Prompt-injection mitigation is an instruction hierarchy that treats tool output, files, scripts, logs, names, and labels as untrusted data; it does not sanitize content, so review proposed actions before confirming.

### Added

- build: optional extensions are selectable per build with allow/deny lists, so NukeAI and other optional features can be omitted.
- docs: screenshots cover OpenMC Studio settings, runs, materials, tallies, CSG/DAGMC, dose, CAD sketch tools, and Visualizer comparison.
- nuke-ai: the AI runtime, providers, and chat theming ship as an optional extension that can be excluded from a build.
- nuke-ai: a dedicated NukeAI agent with domain skills, a workspace context variable, read-only project resources, and Nuke Tools actions.
- nuke-ai: a one-click context chip, welcome quick actions, model setup guidance, run-status refresh, and a read-only preview gallery.
- nuke-ai: tool results render as compact cards with status, counts, warnings, previews, artifacts, and next actions; writes confirm.
- nuke-ai: truthful viewport previews and a reviewable command-to-preview history.
- nuke-ai: a read-only diagnostics agent for CAD, OpenMC projects and failed runs, statepoints, tally series, and statepoint comparison.
- nuke-ai: safe edits preview as diffs and apply with confirmation for OpenMC settings, materials, and tallies, with session-scoped undo.
- nuke-ai: reads OpenMC material, tally, geometry, and DAGMC inventories before editing, and exposes the same read-only tools over MCP.
- nuke-ai: an opt-in, token-protected MCP endpoint serves a live read-only CAD/OpenMC/Visualizer catalog with prompts and audit logging.
- nuke-ai: tool results, files, scripts, logs, names, and labels are treated as untrusted data; MCP clients receive the same rule.
- nuke-ai: NukeAI actions appear directly in CAD viewport, OpenMC validation/run, DAGMC, and tally menus.
- nuke-ai: the chat welcome, cards, and composer adapt to narrow panels, and Help opens a NukeAI-branded getting-started walkthrough.
- nuke-cad: script-first parametric CAD (build123d/CadQuery) with a live viewport and STEP export; .nuke-cad documents share the build path.
- nuke-cad: an interactive 2D sketcher with snap, constraints, driving/reference dimensions, drag solving, and sketch-local undo.
- nuke-cad: sketch tools: trim, extend, split, fillet/chamfer, slots, ellipses, B-splines, transforms, arrays, offset, external geometry.
- nuke-cad: constraint chips, valid-only context menus, snap magnet/radius, auto-dimension, a Q context bar, and relation popovers.
- nuke-cad: pad, pocket, revolve, groove, dress-ups, patterns, mirror, holes, booleans, and up-to-body/through-all ends build in order.
- nuke-cad: loft, helical sweep, sweep/pipe, lattice, 3D curves, multi-transform chains, defeature, datum planes, and modeled threads.
- nuke-cad: Feature Tree and Model Outline show datums, sketches, features, suppression, references, units, parameters, and properties.
- nuke-cad: deterministic references with fingerprint-based repair, sketch-on-face datums, and broken-reference badges keep models stable.
- nuke-cad: STEP/IGES/BREP/glTF/STL import and export, editable bodies or grounded instances, plus STEP files opening in CAD by default.
- nuke-cad: multi-part assemblies with instances, connector-frame mates, BOM, explode, STEP-assembly export, and placed-solid DAGMC export.
- nuke-cad: the W7-X generator builds 10 exact coil bodies and 5 shells as 55 instances, with a downloadable MIT-licensed STEP.
- nuke-cad: a W7-X coil study builds 4/5/6-module layouts with interference reports; a native coil sweep builds editable twisted coils.
- nuke-cad: single-sheet drawings with base/projected/section/detail views, SVG/DXF export, framed sheets, title blocks, and an inspector.
- nuke-cad: New Document templates and an example gallery include editable pincell and tokamak starters plus a downloadable W7-X sample.
- nuke-cad: Export as Python emits runnable document, imported-body, and assembly scripts that preserve units and placements.
- nuke-cad: DAGMC export uses gmsh imprint/merge with material groups and a staged log; graveyards must be flagged explicitly.
- nuke-cad: STEP carries per-solid labels and face colors, manifests accept physical-model UUIDs, and pre-export deviation gates run.
- nuke-cad: bodies carry material tags from the Feature Tree into manifest volumes, and openmc-studio receives them as material links.
- nuke-cad: FEM meshing to gmsh/Exodus/INP/VTK with gmsh or netgen, material property cards, CalculiX analysis, and OpenFOAM scaffolding.
- nuke-cad: shading modes, section planes, 3D measurements, named views, appearance overrides, material color-by, and an origin triad.
- nuke-cad: multi-select and box select, Select Other, Hide/Isolate, and a viewport context menu with fit, measure, and feature editing.
- nuke-cad: command search, pinnable ribbon sections, compact narrow toolbars, and disabled actions that explain why they cannot run.
- nuke-cad: preferences for display faceting, viewport background, navigation style, rebuild-on-edit, and cache size, plus units.
- nuke-cad: NukeAI diagnoses the active model and summarizes, inspects, and exports CAD documents to DAGMC.
- nuke-cad: CAD Edit Review ghosts pending AI proposals; a default-off setting lets NukeAI edit features, sketches, holes, and patterns.
- nuke-cad: NukeAI imports STEP/IGES/BREP bodies and adds, removes, or repositions assembly instances with review, checks, and undo.
- nuke-cad: NukeAI edits drawing sheets, sandbox-previews Python scripts on Linux, and creates Pincell component documents.
- nuke-core: the Nuke Tools sidebar aggregates every Nuke command in a searchable, state-aware view ordered design → simulate → inspect.
- nuke-essentials: shared dialog, toolbar, empty state, loading, panel, form, and viewer-chrome components unify the product UI.
- nuke-visualizer: native in-IDE viewers for tracks, collision tracks, weight windows, and voxel plots render instantly with color-by.
- nuke-visualizer: tally, source, overlay/slice, geometry.xml, multiblock, VTK, and tree View 3D viewers open with clip and pick sync.
- nuke-visualizer: DAGMC opens with volume/material/group isolation and color-by, per-axis clip, an outline tree, and graveyard filtering.
- nuke-visualizer: a labeled orientation cube, distance measure, camera controls, and a Viewer Settings sidebar serve every native viewer.
- nuke-visualizer: ParaView-style color mapping with 34 presets, custom ranges, invert/log, and volume opacity with MIP/composite blending.
- nuke-visualizer: CSG Outline offers per-cell visibility, a material tree, a Void switch, search, and selection sync.
- nuke-visualizer: tally overlays paint onto DAGMC or CSG models, including full 3D and smooth volumes, with source overlay and fading.
- nuke-visualizer: tally series charts one score across statepoints with error bars, aggregation switching, and shared-range 3D handoff.
- nuke-visualizer: a comparison workspace splits 2–4 views with linked cameras, shared color ranges, A/B labels, and a 2×2 grid.
- nuke-visualizer: point/line probes, contours, thresholds, derived fields, warp, mesh quality, statistical plots, and CSV/VTK export.
- nuke-visualizer: Dataset Inspector, Find Data, a bounding-box axes grid, color legends, and save/restore view state aid inspection.
- nuke-visualizer: screenshot export to PNG/JPEG/WebP at 1x/2x/4x with transparency and clipboard copy; Exodus exports WebM.
- nuke-visualizer: nuclear data browser with nuclide search and XS plots, NCrystal S(a,b), ENDF libraries, and material CSV export.
- nuke-visualizer: IFP kinetics, restart-preview, random-ray, and depletion per-step statepoint viewers are built in.
- nuke-visualizer: OpenMC analysis adds entropy convergence, photon contact dose, decay-photon spectra, and ICRP dose coefficients.
- nuke-visualizer: headless base.integrate, describe, export, and mesh-quality commands operate on VTK datasets.
- nuke-visualizer: Gmsh .msh files import directly, and vtk is a required dependency with a guided install when missing.
- nuke-visualizer: NukeAI summarizes and opens statepoints, captures the DAGMC viewport, and diagnoses convergence and tally coverage.
- openmc-studio: NukeAI creates template projects and exports Python; CSG geometry and DAGMC material changes preview and undo.
- openmc-studio: NukeAI summarizes and validates projects, previews and undoes run settings, diagnoses failures, and polls runs.
- openmc-studio: a full source model with file/compiled/multi sources, per-distribution bias, mesh/Tokamak sources, and surface source I/O.
- openmc-studio: rect/hex lattices, cell transforms and density, periodic pairs, boundary albedo, and CSG builder validation.
- openmc-studio: DAGMC authoring with Import CAD, one-click graveyard, optional imprint/merge refacet, and material overrides.
- openmc-studio: CE/multi-group conversion with lossless revert, macroscopic and nuclide-wise random ray, MGXS mode, and NCrystal imports.
- openmc-studio: random ray, CMFD acceleration, criticality search, FW-CADIS weight windows, and IFP kinetics workflows.
- openmc-studio: a 79-score tally catalog with every 0.16 filter type, descriptor editors, per-tally triggers, and derived tallies.
- openmc-studio: depletion advanced controls (CRAM, keff-search, feed/removal, continuation) and a custom ENDF chain builder.
- openmc-studio: a Shutdown Dose wizard runs cell/mesh R2S and D1S with dose tallies, activity/decay heat, and resumable results.
- openmc-studio: volume calculation with triggers and adopt-into-materials, plus native PNG plotting from the IDE.
- openmc-studio: advanced settings, event-based transport, photon creation, biasing, lost-particle limits, OpenMP/MPI launch, and restarts.
- openmc-studio: rectilinear and unstructured mesh authoring with library-aware checks and mesh-filter transforms.
- openmc-studio: runnable pin-cell, PWR assembly, demonstration-core, shielding, and criticality-safety templates.
- openmc-studio: XML import round-trips geometry, meshes, tallies, sources, variance reduction, depletion, settings, and plots.
- openmc-studio: a coverage page documents supported, partial, and unsupported OpenMC surfaces and what still needs Python.
- openmc-studio: dashboard tabs, domain icons, and responsive layouts fit narrow editor panels.

### Changed

- build: Theia 1.73.1 → 1.76.0, Electron 43.8.5, Node.js ≥24, React 19, lerna 10, esbuild bundling, and refreshed test tooling.
- docs: product and extension guides match the current UI, OpenMC 0.16 support, CAD schema, and actual OpenMC coverage limits.
- nuke-ai: the chat welcome uses a responsive animated bot with pointer tracking and reduced motion, and links to the in-IDE guide.
- nuke-cad: CadQuery is optional and no longer bundled; build123d/OCP remains the default CAD and scripting stack.
- nuke-cad: large-model rebuilds are faster through worker tessellation parsing, incremental scenes, and reused overlap verdicts.
- nuke-cad: overlapping additive pattern/mirror instances union instead of erroring, and cross-body overlaps warn instead of aborting.
- nuke-cad: STEP imports skip DAGMC/FEM export by default for fast loads; script builds still export.
- nuke-cad: DAGMC surface-sense verification is a hard error, while watertightness and overlap remain reported diagnostics.
- nuke-cad: viewport chrome gains grouped labelled toolbars, overflow menus, icon-only document actions, and a Start a model launcher.
- nuke-cad: New Document is disabled while a document is open, and the Empty template opens the Create Sketch plane picker directly.
- nuke-cad: saving a script-source model rebuilds the viewport; STEP-source models are unaffected.
- nuke-core: spec-aware dependency installs use a canonical package registry with drift detection.
- nuke-docs: Documentation can open a specific guide page from an in-IDE link.
- nuke-essentials: workspace settings live in `<project>/.nuke-ide/`; Save Workspace As defaults to `*.nuke-workspace` (older formats open).
- nuke-visualizer: viewer headers simplify, sidebars match CAD, tab titles drop Native, and Dataset Inspector tables gain sticky headers.
- openmc-studio: OpenMC 0.16 is supported with typed plots, PPM fallback, and updated TokamakSource gates.
- openmc-studio: source bias moves to each source distribution, with legacy energy bias migrating on load.
- openmc-studio: dashboard, geometry, tally, optimization, and comparison windows reflow to narrow editor panels.
- openmc-studio: the installer drops the obsolete OpenMC Plotter option; native plotting covers that workflow.
- openmc-studio: native plotting uses one plot-type chooser when empty, keeps a live plot selected, and clears stale outputs.

### Removed

- nuke-visualizer: the trame/ParaView server, reverse proxy, and dependencies are removed; converters and native viewers cover the seam.

### Fixed

- app: the startup splash tracks real loading progress and never blanks out on slow connections.
- docker: the image Python environment ships working build123d with the OCP 7.9 shim and a version guard.
- docs: GitHub-rendered guides use portable relative links; images, anchors, and cross-extension links resolve, and CAD notes are corrected.
- nuke-ai: capability tools appear when a document opens, script authoring follows its switch, and CAD/OpenMC tools are advertised.
- nuke-ai: NukeAI is the default chat agent on a fresh profile, and the general agent can run CAD, OpenMC, and statepoint diagnostics.
- nuke-ai: script source inspection asks before text leaves the IDE, and MCP reads share session rate limits and the audit ring.
- nuke-ai: preview writes reject symlinks, history redacts credentials and undo tokens, and oversized previews fall back to bounded text.
- nuke-ai: MCP rejects initialize bursts beyond 16 sessions, and Clear Preview History deletes the validated folder after confirmation.
- nuke-cad: sketch selections, transforms, snapping, construction toggles, external-geometry picks, and dimensions stay in sync.
- nuke-cad: sketch entry/exit focuses the viewport, frames saved bounds, saves new sketches, and its chrome no longer overlaps.
- nuke-cad: drawing views select and drag reliably, keep positions, auto-fit tiny views, and follow document switches.
- nuke-cad: drawing builds use the saved path, auto-save pending edits, capture long service output, and offer Refresh imports.
- nuke-cad: document open/switch/close is generation-safe: no stale rebuilds or empty flashes, and cached opens skip full rebuilds.
- nuke-cad: edits rebuild only dirty features, full builds prime the cache, large documents open viewport-only, and clip planes scale.
- nuke-cad: viewport chrome, popovers, warnings, status pills, and measure markers adapt to theme and narrow widths without clipping.
- nuke-cad: modeling validation catches pad/pocket islands, revolve axes, disjoint cuts, unsupported parameters, and stale consumed bodies.
- nuke-cad: topology repair is atomic with clickable fingerprints, unique feature ids, and rejected pattern-above-source reorders.
- nuke-cad: DAGMC export imprints document-built pincells, tracks volumes through tag renumbering, and avoids needle or zero-area faces.
- nuke-cad: geometry scripts run isolated with timeouts on OCP 7.9, Python files stay in the text editor, and mesh/FEM jobs are cancellable.
- nuke-cad: command search floats clear of the ribbon and returns viewport focus; Edit Selected Sketch reopens on its stored datum.
- nuke-essentials: Welcome renders immediately, empty states center, ribbon contrast holds in light themes, and inputs size predictably.
- nuke-essentials: shared selects, checkboxes, sliders, search, switches, badges, and tooltips replace built-ins so controls never clip.
- nuke-essentials: shared sidebar panels scroll natively without overlay scrollbars covering content across CAD, OpenMC, and Visualizer.
- nuke-visualizer: tally numbers divide by realizations, smooth volumes stay in the model, and CSG cell boxes follow OpenMC plane senses.
- nuke-visualizer: tally overlay, slice, contour, source, and geometry tabs open instantly and render 3D, source, voxel, and grid data.
- nuke-visualizer: DAGMC outline, graveyard toggle, viewer settings, and status counts bind on open instead of staying empty.
- nuke-visualizer: viewer chrome, probe layout, step controls, ViewCube, legends, context menus, and bottom bars stay clear and themed.
- nuke-visualizer: depletion axes start at the initial state in days, orbits stay smooth on large models, and Escape works after clicks.
- nuke-visualizer: headless commands return one JSON error without tracebacks, slices render smooth, and round points replace square pixels.
- nukelab-integration: expired server tokens re-mint silently so file transfers never hang on Preparing download.
- openmc-studio: particle selectors, tally filters, mesh boundaries, source-bias and weight-window fields, derived inputs, ID chips, cards, buttons, and tabs follow the theme and fit narrow panels.
- openmc-studio: New Project cards preview their own defaults, source cards expand, and empty-state actions clear their text.
- openmc-studio: coupled DAGMC depletion runs, CAD conversions stop duplicating graveyards, and FW-CADIS checks random ray.
- openmc-studio: CE/multi-group, MGXS, k-eff search, macro materials, surfaces, cylinders, kinetics tallies, and ray_source emit valid code.
- openmc-studio: tallies, plots, weight windows, and trigger settings round-trip through XML and Python export.
- openmc-studio: project-relative DAGMC/MGXS paths survive moves, run output is excluded from the watcher, and health checks report Pillow.

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

[Unreleased]: https://github.com/nukehub-dev/nuke-ide/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/nukehub-dev/nuke-ide/releases/tag/v0.2.1
[0.2.0]: https://github.com/nukehub-dev/nuke-ide/releases/tag/v0.2.0
[0.1.3]: https://github.com/nukehub-dev/nuke-ide/releases/tag/v0.1.3
