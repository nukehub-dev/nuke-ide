# OpenMC Studio

## Purpose

No-code graphical workspace for OpenMC neutron transport inside NukeIDE: dashboard, CSG builder, DAGMC editor, tallies,
optimization, XML round-trip, and runner.
See `docs/dev/index.md` for the developer-doc map and `docs/dev/architecture.md` for the layer diagram.

## Ownership

All files under `extensions/openmc-studio/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- CAD/DAGMC graveyard: `cad_conversion` auto-creates `mat:graveyard` unless `--no-graveyard`; `dagmc_editor_service.py` offers
  `detect_graveyard` / `create_graveyard_box` (preferred) / `tag_graveyard`, and `refacet` re-creates it. See `docs/dev/python-backends.md`.
- Depletion DAGMC sync + volumes: `run_depletion.py` syncs DAGMC universes (`init_lib` → `sync_dagmc_universes` → `finalize_lib`)
  before `CoupledOperator`, and depletable materials must carry `VOLUMES`. See `docs/dev/python-backends.md`.
- `openmc` binary resolution is 4-step: `$OPENMC_ROOT/bin/openmc`, `PATH` (with env dirs prepended), beside the selected Python,
  sibling `bin/`/`Scripts`. See `src/node/openmc-runner-service.ts` and `docs/dev/architecture.md`.
- Runner output: 1 MB in-memory tail cap, batched client streaming (200 ms / 256 KB), and a 3 s mover shifting `tracks*.h5` /
  `particle_*.h5` into `tracks/`/`particles/` (replace-on-collision, only track moves logged). See `docs/dev/architecture.md`.
- XS/chain precedence for runs: explicit preferences (`nuke.openmcCrossSections`, `nuke.openmcChainFile`) beat `OPENMC_CROSS_SECTIONS` /
  `OPENMC_CHAIN_FILE` env vars, which beat OpenMC defaults. See `docs/dev/rpc-protocols.md`.
- Watcher excludes: `OpenMCStateManager` adds the effective output dir to `files.watcherExclude` via pure `computeOutputWatcherExcludes`
  (dedicated dir excluded wholesale; project-dir output excludes only `particles/**`/`tracks/**`). See `docs/dev/state-model.md`.
- Surface boundary is emitted ONLY when `OpenMCSurface.boundary` is set; unset means OpenMC transmission default and interior surfaces
  must stay unset. Cells must fully bound the geometry. See `docs/dev/xml-generation.md`.
- Lattices mirror OpenMC arrays: rect `[z][y][x]` (row 0 top, x fastest), hex `[z][ring][theta]` (ring 0 outermost, theta
  clockwise), emitted as `<lattice>`/`<hex_lattice>` in `_repr_axial_slice_x/_y` order. Root is always universe 0; lattice/universe
  IDs share the fill namespace. Periodic pairs are reciprocal planes, albedo only on reflective/periodic/white.
  See `docs/dev/state-model.md`.
- Depletion `<depletion>` block: `settings.xml` ↔ runner `checkDepletionEnabled` ↔ `run_depletion.py` args stay in lockstep; advanced
  fields (substeps, keff search, external rates, continuation) are driver-only and XML export warns. 0.16-only APIs are capability-probed
  by introspection; coupled is CE-only, MG depletion is Independent-operator only, macroscopic materials never deplete (`validateState` +
  pre-import driver guards, clean `DepletionConfigError` JSON). See `docs/dev/xml-generation.md` and `docs/dev/python-backends.md`.
- Random-ray / multi-group: `energyMode` + canonical `settings.mgxsLibrary` (resolved via `resolveMgxsLibrary`, never read raw);
  DAGMC random ray requires multi-group + `nuclideWiseMgxs` (no macroscopic); version skew handled by probed `OpenMCCompat`, never version
  parsing; `generate_mgxs.py` wraps `convert_to_multigroup` / `convert_to_random_ray`. See `docs/dev/xml-generation.md`.
- CE ↔ MG conversion uses pure `computeMgConversion` / `computeMgRevert` with the pre-conversion snapshot in `metadata.mgBackup`; revert
  strips `macroscopic` explicitly (`macroscopic: undefined`) for the shallow-merge state manager. See `docs/dev/state-model.md`.
- Materials: `macroscopic: { name }` emits real `<macroscopic/>` (never with `ncrystalCfg`/sab); `ncrystalCfg` emits `<material cfg="...">`
  and exports via `Material.from_ncrystal` (`ncrystal` package optional). See `docs/dev/state-model.md`.

## Work Guidance

- Meshes/sources/bounds: `getSettingsMeshIds` is the single settings-level mesh inventory (emitted once, skipped in tallies.xml); `mesh`
  sources need exactly `n_elements` sub-sources; `tokamak` sources need 0.16.0+ (`muir` serializes lossy as `normal`); shared
  bounding-box logic lives in `geometry-bounds.ts`. See `docs/dev/state-model.md` and `docs/dev/xml-generation.md`.
- Shared widget CSS: `widgets/shared/openmc-widget.css` is the opt-in design system (root gets `openmc-widget` class, accent
  `--theia-focusBorder`, Theia vars only). Dashboard tabs are `DashboardTabContribution`s; new scalar settings belong in the
  Advanced section (`advanced-section.tsx`). See `docs/dev/widget-patterns.md` and `docs/dev/adding-a-widget.md`.
- Domain chrome uses `codicon-openmc-*` masks from `src/browser/icons/openmc-icon-classes.css`; generic codicons stay for
  utility actions. Project identity uses the theme-aware `openmc-brand-openmc` mask; DAGMC keeps the mesh icon because
  upstream has no theme-safe standalone mark. Hover labels use the shared nuke-essentials `Tooltip`, never native
  `title` attributes. Widget roots set `container-type: inline-size`, narrow layouts use `@container` (tab labels collapse
  to icon-only, headers wrap, tables scroll), never viewport-only breakpoints.
- Tally model: extend `scores-catalog.ts` / `filters-catalog.ts`, not the components; per-tally `triggers` auto-emit run-level
  `<trigger><active>true</active>`; `derivative` perturbs a material only (top-level `<derivative>`, tally references by ID).
  See `docs/dev/xml-generation.md`.
- Kinetics / CMFD: IFP tallies auto-append from `settings.kinetics` and re-derive on import (idempotent); CMFD is C-API-only (no
  settings.xml element) via `generateCmfdCodeLines` + `run_cmfd.py`, and depletion wins when both are set. See `docs/dev/xml-generation.md`.
- Preferences stay minimal: only `openmcStudio.lastMgxsWorkDir` is a preference; MGXS-generator / volume-calc / chain-builder /
  MG-conversion form values are session-scoped, sweeps/depletion/plots are project state. See `docs/dev/widget-patterns.md`.
- Native Plotting: `generate_plots.py` owns `plots.xml` (UI XML generation passes `plots: false`), stale plot outputs are
  removed before rendering, the first plot is auto-selected after a project load or deletion, and solid ray-trace plots
  default to all-opaque domains so they never render a blank scene. Appearance (background/mask/overlaps) follows the
  support matrix in `src/common/plot-appearance.ts`; voxel ignores display colors, overlaps are slice-only, and
  `mask.components` is the visible selection (XML emits the hidden complement). Builds without libpng emit PPM, converted
  to PNG. See `docs/user/native-plotting.md` and `docs/dev/widget-patterns.md`.
- Assets + nuke-cad seam: `dagmcFile`, `dagmcInfo.filePath`, and relative `mgxsLibrary` resolve against
  `XMLGenerationRequest.projectDirectory`;
  `openmc.project.importNukeCAD` loads `.h5m` + sibling `.regions.json` into placeholder materials reusing the DAGMC machinery.
  See `docs/dev/rpc-protocols.md` and `docs/dev/xml-generation.md`.
- Keep the graphical model and OpenMC XML in sync through the round-trip modules; no one-way generators. TS/DI/RPC/CSS/test layout
  follows parent `extensions/AGENTS.md`; Python style, subprocess, and coverage rules follow root `AGENTS.md`.

## Verification

```bash
yarn test:python     # from repo root; runs this extension's pytest suite
npx lerna run build --scope openmc-studio
npx vitest run extensions/openmc-studio
```

## Child NAD Index

- None (developer guides live under `docs/dev/`, indexed by `docs/dev/index.md`).
