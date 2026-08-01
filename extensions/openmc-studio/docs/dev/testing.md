# Testing

OpenMC Studio has four test layers with a tiered coverage policy: the logic layer (Python drivers, TypeScript helpers) is measured and ratcheted; the rendering layer is covered by error-path contract tests and the docker smoke test instead.

---

## Python Unit Tests

`tests/python/` — pytest suites for the Python backends (`python/*.py`). They must pass with only `pytest` + `numpy` installed (the minimal CI profile); guard heavy imports with `pytest.importorskip` or module-level `HAS_*` flags, and force dependency absence in guard tests rather than assuming it.

```bash
yarn test:python        # all extension pytest suites (minimal profile)
yarn test:python:cov    # with coverage report (coverage.xml)
yarn test:python:full   # against a full-dependency Python (see below)
```

## TypeScript Unit Tests

Vitest suites next to the code (`src/**/*.test.ts`) cover the state schema, XML round-trips, catalogs, and parameter paths:

```bash
npx vitest run extensions/openmc-studio
```

## E2E Layer (Real OpenMC Runs)

Two e2e layers execute real OpenMC runs and skip cleanly when their environment variables are unset:

- **`tests/e2e/`** (pytest, driver level) — pincell fixtures built with the openmc API driving the Python scripts directly: CMFD, depletion, k-eff search, volume, MGXS, collision tracks, DAGMC assets, native plotting, chain building. All tests carry the `@pytest.mark.e2e` marker.
- **`src/node/e2e/`** (vitest, project level) — small hand-written `.nuke-openmc` fixtures under `src/node/e2e/projects/` → migration → XML generation → real runs; `codegen-run.test.ts` additionally executes the exporter's generated `model.py`.

Environment variables (all optional):

| Variable                | Used By       | Purpose                                                                                     |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `NUKE_TEST_PYTHON`      | both layers   | Python with full dependencies; its `bin/openmc` runs the binary                             |
| `OPENMC_CROSS_SECTIONS` | both layers   | `cross_sections.xml` — needed for any model run                                             |
| `NUKE_E2E_CHAIN`        | depletion     | Depletion chain XML                                                                         |
| `NUKE_E2E_ENDF`         | chain builder | ENDF-B library dir with `decay/` `nfy/` `neutron(s)/` sub-libraries (ENDF-mode builds only) |

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

## Conventions

- New Python tests must pass in the minimal profile; the full profile is exercised by the docker image test step in CI.
- Shared pytest e2e helpers live in `tests/e2e/e2e_helpers.py` — never `from conftest import ...` (conftest module names collide across test dirs).
- Vitest fixtures are small, reviewable `.nuke-openmc` JSON projects — no generated XML is committed.
