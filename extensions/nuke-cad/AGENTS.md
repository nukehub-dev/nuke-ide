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
  (version 1 today). Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. Future migrations register steps in the migration
  function and bump `NUKE_CAD_SCHEMA_VERSION`.
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
  patterns, and sketch-on-face. References are never raw indices. Fingerprint
  matching and scoring lives in the Python backend
  (`python/reference_scoring.py`, `python/reference_resolver.py`); TypeScript
  owns only the types and validation.
- Python backend lives in `python/` and is not pip-installed; the IDE spawns
  it as a subprocess via `nuke-core` environment detection.
- The CAD viewport is a purpose-built three.js widget (documented exception to
  the "reuse nuke-visualizer" rule); heavy visualization results still route to
  nuke-visualizer. The empty viewport shows an **Open CAD Model...** button.
- The Model Outline panel (`src/browser/widgets/outline-panel/`, widget ID
  `nuke-cad-outline-panel-widget`, label "Model Outline") lists the active
  model's manifest volumes and surfaces and is read-only — no manifest editing
  UI. Picking syncs both ways through the shared `NukeCadStateManager`: row
  click highlights the whole solid in the viewport; a viewport pick selects the
  row, scrolls it into view, and expands its section. Opened via the
  `nuke.cad.openOutlinePanel` command (right shell area) or the Nuke Tools
  sidebar (`CAD Studio → Geometry`).
- Preferences live in `src/browser/nuke-cad-preferences.ts`.
  `nukeCad.facetingTolerance` (number, default 0.001, exclusiveMinimum 0) is
  the default faceting tolerance consumed by
  `NukeCadFrontendService.buildGeometry` on open/rebuild/Open-CAD-Model; an
  explicit per-call tolerance wins and changes apply to subsequent builds
  only. It is deliberately separate from openmc-studio's
  `openmcStudio.defaultFacetingTolerance` — nuke-cad is an optional extension
  and cannot depend on openmc-studio.
- STEP/STP/BREP files open in nuke-cad by default (higher open-handler priority
  than nuke-visualizer); the geometry service reads them through OCP and runs
  the same tessellation pipeline as script builds. The `.py` open-handler
  priority is 50 — below the text editor's 100 — so Python files open in the
  editor by default and reach the CAD viewport via **Open With…**.
- STEP-source imports skip DAGMC and FEM mesh export by default; the backend
  enforces `--no-dagmc`/`--no-mesh` on every path (including rebuilds) and
  `geometry_service.py` exposes opt-in `--dagmc`/`--mesh` flags.
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
- `.nuke-cad` document schema lives in `src/common/cad-document.ts` (version 1).
  Validate with `validateNukeCadDocument`; migrate with
  `migrateNukeCadDocument`. The document store
  (`src/browser/document/cad-document-store.ts`) holds the active document,
  performs immutable updates validated against the schema, tracks dirty state,
  sketch/feature selection, and per-feature build results. Sketch-local
  parameters are merged into document-level parameters when a sketch is saved.
- Sketch mode is split into three layers so each has a single responsibility:
  - `src/browser/sketch/sketch-session.ts` — pure TypeScript controller that
    owns tool state, snap, auto-constraints, constraint/dimension management,
    drag solving, and serialization to/from `SketchDef`. No UI or three.js
    dependencies.
  - `src/browser/sketch/sketch-mode-controller.ts` — wires the session into the
    three.js viewport: orthographic camera, pointer-to-plane mapping, rendering,
    and pointer event routing.
  - `src/browser/widgets/cad-viewport/cad-sketch-overlay.tsx` — React UI chrome:
    sketch toolbar, datum picker, document toolbar, feature-creation dialog,
    constraint value input, dimension labels/popover, parameters panel,
    diagnostics popover, and status line.
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
  - `python/feature_builder.py` executes `pad`/`pocket`/`revolve`/`groove`
    features in topological order over explicit `dependsOn` edges, fusing
    additive features into and cutting subtractive features from one accumulated
    body. Cycles are rejected with a readable member list.
  - `geometry_service.py` exposes `build_document()` plus a `--from-document`
    CLI flag; it validates references lightly, runs the feature builder, and
    reuses `_process_shape` verbatim so STEP/tessellation/DAGMC/mesh artifacts
    match script builds.
  - The first release performs a full document rebuild on every `buildDocument`
    call. Per-feature shape caching is deferred until the modeler needs it.
  - Datum support in this release is limited to `XY`/`YZ`/`XZ`/`offset`. `offset`
    datums are interpreted as offsets of the XY plane along +Z; `face` datums
    (sketch-on-face) are rejected with a clear error.
  - Feature labels map to 1-based solid indices in `selector_map`, feeding the
    same region-manifest/DAGMC/mesh pipeline used by script builds.
- `.nuke-cad` shell integration:
  - `.nuke-cad` files open in the CAD viewport by default (open-handler priority
    500). The handler parses the JSON, loads it into the document store, and
    triggers a document build.
  - Document commands: `nuke.cad.newDocument`, `nuke.cad.saveDocument`,
    `nuke.cad.saveDocumentAs`, `nuke.cad.newSketch`, `nuke.cad.exitSketch`, and
    `nuke.cad.openFeatureTree`.
  - The **Feature Tree** panel (`src/browser/widgets/feature-tree/`, widget ID
    `nuke-cad-feature-tree-widget`, label "Feature Tree") lists datums,
    sketches, and features in document order with selection, suppression toggle,
    edit, delete, and build-status markers from the last rebuild.
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
