# Testing

OpenMC Studio has four test layers with a tiered coverage policy: the logic layer (Python drivers, TypeScript helpers) is measured and ratcheted; the rendering layer is covered by error-path contract tests and the docker smoke test instead.

---

## Python Unit Tests

`tests/python/` — pytest suites for the Python backends (`python/*.py`). They must pass with only `pytest` + `numpy` installed (the minimal CI profile); guard heavy imports with `pytest.importorskip` or module-level `HAS_*` flags, and force dependency absence in guard tests rather than assuming it. `test_derive_tallies.py` drives the evaluator with fake tally/statepoint objects (ratio, scaling, sum/difference, shape mismatch, zero division, CLI JSON) without importing OpenMC; the real pincell capture/fission comparison lives in `tests/e2e/test_derive_tallies_e2e.py`.

```bash
yarn test:python        # all extension pytest suites (minimal profile)
yarn test:python:cov    # with coverage report (coverage.xml)
yarn test:python:full   # against a full-dependency Python (see below)
```

## TypeScript Unit Tests

Vitest suites next to the code (`src/**/*.test.ts`) cover the state schema, XML round-trips, catalogs,
parameter paths, and the pure derived-tally model (`derived-tallies.test.ts`: parse/format precedence,
token round-trip, validation, bin estimates, reference evaluation). Export-absence tests assert derived
tallies never reach `tallies.xml` or the Python model; the state CRUD suite covers add/update/delete and
project round-trip. `xml-roundtrip-matrix.test.ts` is the semantic matrix for every supported feature
area (lattices/transforms, meshes, filters, sources, variance reduction, depletion, runtime settings,
plots, materials); `project-templates.test.ts` validates every runnable template; and
`xml-import-report.test.ts` asserts warnings are classified as ignored versus needs-attention.

```bash
npx vitest run extensions/openmc-studio
```

## E2E Layer (Real OpenMC Runs)

Two e2e layers execute real OpenMC runs and skip cleanly when their environment variables are unset:

- **`tests/e2e/`** (pytest, driver level) — pincell fixtures built with the openmc API driving the Python scripts directly: CMFD, depletion, k-eff search, volume, MGXS, collision tracks, DAGMC assets, native plotting, chain building, and cell/mesh R2S plus D1S shutdown dose. All tests carry the `@pytest.mark.e2e` marker.
- **`src/node/e2e/`** (vitest, project level) — small hand-written `.nuke-openmc` fixtures under `src/node/e2e/projects/` → migration → XML generation → real runs; `codegen-run.test.ts` additionally executes the exporter's generated `model.py`. `project-templates.test.ts` shortens every runnable template and asserts transport completes with no lost particles. `geometry-core.test.ts` loads generated lattice/transform/periodic XML with the real OpenMC Python API, compares it against the exporter's `model.py`, and needs only `NUKE_TEST_PYTHON`; its transport case additionally needs `OPENMC_CROSS_SECTIONS`. `mesh-rectilinear.nuke-openmc` runs a rectilinear mesh tally; mesh-filter rotation is added only when the environment's `openmc.MeshFilter.rotation` probe succeeds. `tally-filters.test.ts` runs a cell-instance tally in a 2×2 lattice plus mesh-material and mesh-born tallies and inspects the statepoint bins. Unstructured mesh runs stay gated on a build/library that is not part of the minimal profile.

Environment variables (all optional):

| Variable                     | Used By       | Purpose                                                                                           |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `NUKE_TEST_PYTHON`           | both layers   | Python with full dependencies; its `bin/openmc` runs the binary (geometry parity needs only this) |
| `OPENMC_CROSS_SECTIONS`      | both layers   | `cross_sections.xml` — needed for any model run (including the lattice transport case)            |
| `NUKE_E2E_CHAIN`             | depletion     | Depletion chain XML                                                                               |
| `NUKE_E2E_ENDF`              | chain builder | ENDF-B library dir with `decay/` `nfy/` `neutron(s)/` sub-libraries (ENDF-mode builds only)       |
| `NUKE_E2E_TALLY_FILTERS_016` | tally filters | Opt in to the 0.16-only reaction/particle-production run; point `NUKE_TEST_PYTHON` at OpenMC 0.16 |

Example:

```bash
NUKE_TEST_PYTHON=$HOME/.conda/envs/nuke/bin/python \
OPENMC_CROSS_SECTIONS=/path/to/cross_sections.xml \
NUKE_E2E_CHAIN=/path/to/chain_casl.xml \
NUKE_E2E_ENDF=/path/to/endf-b-vii.1 \
    yarn test:python:full
```

Get nuclear data from the official OpenMC data libraries (openmc.org) or the docker image's environment; the DAGMC test asset is committed at `tests/e2e/assets/fuel_pin.h5m`. No machine-specific paths anywhere in the layer.

---

## UI Smoke Tests

`tests/ui/openmc-*.spec.ts` and the other Playwright specs under `tests/ui/` drive the bundled browser
app through the Theia workbench. `project-templates.spec.ts` covers every template card, the
keyboard-selected state, dashboard handoff, and narrow-panel stacking. Run the suite with `yarn test:ui`
after `yarn build:browser` (see the root `AGENTS.md`).

## Conventions

- New Python tests must pass in the minimal profile; the full profile is exercised by the docker image test step in CI.
- Shared pytest e2e helpers live in `tests/e2e/e2e_helpers.py` — never `from conftest import ...` (conftest module names collide across test dirs).
- Vitest fixtures are small, reviewable `.nuke-openmc` JSON projects — no generated XML is committed.
