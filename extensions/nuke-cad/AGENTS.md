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

- TypeScript follows `extensions/AGENTS.md` (`src/browser/`, `src/node/`,
  `src/common/`); Python in `python/` is not pip-installed and spawns via
  `nuke-core` environment detection; CSS ships via `copy-css`. See `docs/dev/backend-pipeline.md`.
- `.nuke-cad` schema v3 lives in `src/common/cad-document.ts`
  (`validateNukeCadDocument` / `migrateNukeCadDocument` / `MIGRATIONS`); bodies
  carry labels to `selector_map`, booleans consume tool bodies, consumed targets go
  `stale`. See `docs/dev/document-schema.md`.
- The document store (`cad-document-store.ts`) holds validated immutable state,
  dirty/selection/feature results, sketch-param merging, dependent-guarded deletes,
  and depth-100 snapshot undo/redo; Export Python (`python-codegen.ts`) is a lossy
  one-way starter. See `docs/dev/document-schema.md`.
- The sketch solver is client-side only: `sketch-solver.ts` is the sole planegcs
  importer (pinned exact, WASM fallback documented); curve-level constraints stay
  lines/circles/arcs, ellipses/B-splines take point-level ones; evaluation lives in
  `sketch-curves.ts`. See `docs/dev/sketch.md`.
- Sketch UI is three layers (`sketch-session.ts`, `sketch-mode-controller.ts`,
  `cad-sketch-overlay.tsx`) with session-scoped snap (default 12px, magnet + S/M/L)
  and face/edge picking (`face-picker.ts`, `edge-picker.ts`) feeding `externalRefs`
  as construction geometry. See `docs/dev/sketch.md`.
- Feature recompute (`feature-graph.ts`: DAG, topological order, cycle rejection,
  `markDirty`/`recomputePlan`/`markClean`, suppression → stale) plus fingerprint
  `TopologyRef`s (`topology-refs.ts` types, Python scoring/resolver,
  `matched`/`ambiguous`/`unmatched` with fingerprint-identity repair). See
  `docs/dev/features-patterns.md`.
- Dress-ups (fillet/chamfer/draft/shell on the accumulated B-rep via pick modes),
  patterns/mirror/lattice (2500-cell cap)/multiTransform over same-body sources with
  union-fuse semantics, and the hole wizard (face ref + `[u, v]`, blind/through,
  counterbore/countersink/counterdrill mutex, ISO `modeled` threads) with `defeature`.
  See `docs/dev/features-patterns.md`.
- Sweep/pipe (curve path, `frenet`/`fixedBinormal`, additive-only, closed-spine
  station lofts), loft (ordered `sectionSketchIds`, `ruled`), helicalSweep (analytic
  helix, optional `subtractive`); every dialog offers debounced ghost preview
  (producers standalone, modifiers pull full chains). See `docs/dev/features-patterns.md`.
- Overlap policy: same-body additive checks plus disjoint-skip → parallel-fuse →
  sequential-fallback for pattern instances (touching = intersecting; the W7X wall is
  accuracy-tuned, not an optimization surface); cross-body overlap is a warning with
  an outline **Fuse** auto-fix. See `docs/dev/features-patterns.md`.
- Backend builds (`geometry_service.py` script isolation at 120s, `feature_builder.py`
  topological bodies, `curve_builder.py` wires, datums `XY`–`line2Point`, P2
  `<stem>.nuke-cache.zip` partial cache with TS/C1 keys and doc-hash tess blob; display builds
  prime it, one batch load/commit serves a build, and per-body overlap verdicts are reused for
  unchanged signatures). See `docs/dev/backend-pipeline.md`.
- Imports (STEP/IGES/glTF/STL with unit adoption, build123d/CadQuery selectors) and
  default `--no-dagmc`/`--no-mesh` gates with opt-in flags; DAGMC export
  (`dagmc_export.py`: sense hard error, staged gmsh imprint, most-specific-wins
  selectors, `inspection_gates.py` warnings) and `ocp_compat.py` 7.8/7.9 shims. See
  `docs/dev/backend-pipeline.md`.
- Package requirements live in `src/common/packages.json` (single source of truth;
  `health` group → `CAD_HEALTH_PACKAGES` for `checkCadEnvironment`, rest reference
  data; shared specs must match nuke-core's registry). See `docs/dev/backend-pipeline.md`.
- Viewport: purpose-built three.js widget (active-camera rule, scene-scaled
  `clip-planes.ts` near/far, `ViewerNavBar` children, scoped keys with capture phase,
  `ViewCube`/`ViewBadge` below the toolbar, theme-adaptive colors), worker-parsed
  tessellation with content-keyed reuse that rebuilds invalidate, single-authority
  shading, visual-only section, measure (distance/angle/radius + pinnable `measurements`
  block), per-solid explode, hidden-set picking filters. See `docs/dev/viewport-outline.md`.
- Model Outline (read-only manifest + Properties/Table/Parameters/BOM/warnings-Fuse)
  and Feature Tree (ordered bodies/datums/sketches/features/curves, suppression,
  reorder/delete guards, repair popover) with mask-based `codicon-nuke-cad-*` icons
  and `nuke-cad-preferences.ts` (faceting/display/background/navigation/rebuild/cache).
  See `docs/dev/viewport-outline.md`.
- Curves (`points`/`parametric`/`fourier` via `expression.ts` + units, closed-repeat
  convention, `curve_builder.py` wires), drawings (additive block, HLR
  `drawing_service.py`, SVG + optional DXF, fingerprint dimensions,
  `nuke-cad-drawing-widget`), and assemblies (frozen mate-connector spec,
  `assembly_builder.py` BFS placements, per-instance shared-geometry viewport, BOM
  panel, `fastener_data.py` threads). See `docs/dev/drawings-assemblies.md`.
- Manifest materials (`meshSize`, `materialId`/`parentId` links, `materials` cards,
  `BodyDef.material` tags → `<stem>.regions.json`), gmsh/netgen mesh parity (imprinted
  BREP, tetra10 remap), CalculiX FEM (`fem_service.py`, manifest-first cards),
  OpenFOAM scaffolding + per-solid STL (`foam_service.py`), and the `job_service.py`
  run-layer with `cancelJob` RPC. See `docs/dev/fem-mesh-foam.md`.
- Tests: minimal profile (`pytest` + `numpy`, guarded heavies, forced-absence guards),
  `.coveragerc` ratchet over `region_manifest.py` + `job_service.py` only,
  `@pytest.mark.e2e` env-gated suites, tokamak GUI-authored fixture with
  drift/toponaming/perf coverage, and opt-in W7X suites with a conda/pip netgen env
  split. See `docs/dev/testing-e2e.md`.

## Work Guidance

- Follow repo style: 4-space indent, single quotes, no trailing commas.
- New source files carry the BSD-2-Clause header.
- Geometry scripts must define a top-level `model` variable holding a
  build123d Part/Compound, CadQuery Workplane, or OCP TopoDS_Shape.
- Heavy Python imports must be guarded so modules stay importable in the
  minimal pytest profile.
- Compact icon buttons must reset Theia's `.theia-button` defaults via the
  grouped reset in `cad-viewport.css`.

## Verification

```bash
npx lerna run build --scope nuke-cad
yarn test:python   # includes nuke-cad tests/python and tests/e2e (e2e skips without env gates)
yarn lint
```

Full-profile e2e needs `NUKE_TEST_PYTHON` (openmc + CAD toolchain) plus `OPENMC_CROSS_SECTIONS`;
W7X suites are opt-in via `NUKE_CAD_W7X_PERF=1` / `NUKE_CAD_W7X_GATE=1` with `*_COUNT` overrides
and `NUKE_E2E_W7X_STEP` for the drift check. See `docs/dev/testing-e2e.md`.

## Child NAD Index

- None
