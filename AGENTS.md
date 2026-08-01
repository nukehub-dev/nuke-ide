# Nuke Agent Doc (NAD) Framework

## Purpose

Binding work contract for AI agents and human contributors working on NukeIDE.

## Ownership

This root `AGENTS.md` owns the NAD hierarchy, project-wide workflow rules, and cross-domain standards. Domain-specific guidance lives in child `AGENTS.md` files listed in the Child NAD Index.

## NAD Core Contract

- `AGENTS.md` files are binding work contracts for their subtrees.
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable `AGENTS.md` plus every parent `AGENTS.md` above it.

### Read Before Editing

1. Read this root `AGENTS.md`.
2. Identify every file or folder you expect to touch.
3. Walk from the repository root to each target path.
4. Read every `AGENTS.md` found along each route.
5. If a parent `AGENTS.md` lists a child `AGENTS.md` whose scope contains the path, read that child and continue from there.
6. Use the nearest `AGENTS.md` as the local contract and parent docs for repo-wide rules.
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken NAD.

### Update After Editing

Every meaningful change requires a NAD pass before the task is done.

Update the closest owning `AGENTS.md` when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- `AGENTS.md` creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the NAD pass still must happen.

## Hierarchy

- Root `AGENTS.md` is the NAD rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child NAD Index.
- Child `AGENTS.md` files own domain-specific instructions and their own Child NAD Index.
- Each parent explains what its direct children cover and what stays owned by the parent.
- The closer a doc is to the work, the more specific and practical it must be.

## Child Doc Shape

Create a child `AGENTS.md` when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards.

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child NAD Index

## Style

- Keep docs concise, current, and operational.
- Document stable contracts, not diary entries.
- Put broad rules in parent docs and concrete details in child docs.
- Prefer direct bullets with explicit names.
- Do not duplicate rules across many files unless each scope needs a local version.
- Delete stale notes instead of explaining history.
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist.

## Closeout

1. Re-check changed paths against the NAD chain.
2. Update nearest owning docs and any affected parents or children.
3. Refresh every affected Child NAD Index.
4. Remove stale or contradictory text.
5. Run existing verification when relevant.
6. Report any docs intentionally left unchanged and why.

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child `AGENTS.md`.

---

## NukeIDE Project Guidance

## Required tooling

Install once before making changes:

- **Node.js** >= 22.12.0 and **Yarn** 1.x (`>=1.7.0 <2`). Dependencies install with `yarn` (yarn workspaces + lerna 9).
- **Python** 3.13 with `pip install -r requirements-dev.txt` (pytest, numpy, ruff). Only needed for the extension Python backends and their tests; the TypeScript build does not need it.
- **Docker** (optional) for the containerized browser deployment in `applications/docker/`.

## Before committing

Run these from the repo root. They are the canonical "did I break anything" checks:

```bash
yarn lint             # prettier --check (TS/JS/JSON/MD/YAML/CSS) + ruff check + ruff format --check
yarn test:python      # pytest suites for the extension Python backends
npx lerna run build   # compile all extensions (tsc typecheck)
```

Notes:

- `yarn format` and `yarn format:python` auto-fix formatting (prettier --write, ruff check --fix + ruff format).
- Formatter configs: `.prettierrc.json` (Theia style: 4-space, single quotes, no trailing commas, width 140), `ruff.toml` (py313, width 100), `.editorconfig` mirrors both.
- Full application bundles are heavy: `yarn build:browser` / `yarn build:electron` run webpack. Prefer `npx lerna run build` for a fast compile check.

## CI/CD

GitHub Actions workflows under `.github/workflows/`:

- `ci.yml` — fast checks on every push/PR: prettier + ruff (`yarn lint`), extension compile (`npx lerna run build`), pytest with coverage, and vitest. This must stay green.
- `build.yml` — Electron packaging for Linux/Windows/macOS and draft GitHub Releases on `v*` tags.
- `docker.yml` — all-in-one container build + smoke test; runs on changes to `applications/docker/` or dependency manifests, weekly, and on manual dispatch. Smoke coverage: Python env import check, the extension pytest suite in-image, a functional rendering check (`applications/docker/render_smoke_test.py` — the trame/ParaView/VTK seam the unit tests skip), and an IDE boot check. Green builds archive a dependency snapshot (`conda list` + `pip freeze`); a failed weekly run opens/updates an `upstream-regression` issue.
- `upstream-latest.yml` — weekly early-warning job: builds the backend conda env with the `paraview` pin relaxed (everything else already floats) and runs pytest + the rendering smoke test headless on the runner. Catches a breaking upstream release before it reaches a pin bump; failures open/update an `upstream-regression` issue.

## Releases

1. Move anything releasable under `CHANGELOG.md`'s `Unreleased` into a new `## [x.y.z] - YYYY-MM-DD` section (Keep a Changelog format; hand-curated, not generated).
2. `yarn bump-version <x.y.z>` (runs `scripts/bump-version.js`: lerna.json + every app/extension `package.json` and their internal dependency versions).
3. Run the pre-commit checks (`yarn lint`, `yarn test:python`, `npx lerna run build`), commit, then `git tag v<x.y.z>`.
4. Pushing the tag triggers `build.yml`, which drafts the GitHub Release. The release body is extracted automatically from the tag's `CHANGELOG.md` section (GitHub's auto-generated notes are PR-based and useless for this trunk-based repo), so the changelog entry is what users read.

## Coverage

Tiered policy; the project does not chase one uniform percentage.

- **Logic layer** (Python parsers/converters/services/command handlers, TS pure helpers): measured and ratcheted. `.coveragerc` holds `fail_under` — it may only go UP; bump it whenever the baseline improves.
- **Rendering layer** (trame/ParaView/VTK server modules, plugin glue): excluded in `.coveragerc`; covered by error-path contract tests and the docker smoke test instead.
- Run `yarn test:python:cov` for the Python report (writes `coverage.xml`) and `yarn test:ts` for vitest.
- `yarn test:python:full` runs the suite against a full-dependency Python (integration tests execute instead of skipping). Point it at an env with openmc/h5py/vtk via `NUKE_TEST_PYTHON`, e.g. `NUKE_TEST_PYTHON=$HOME/.conda/envs/nuke/bin/python yarn test:python:full` (set `OPENMC_CROSS_SECTIONS` for tests that run models). The docker image test step exercises the same profile in CI.
- **E2E layer** (real OpenMC runs, full profile only): `extensions/openmc-studio/tests/e2e/` (pytest, driver-level: pincell fixtures built with the openmc API, real CMFD/depletion/k-eff-search/volume/MGXS/collision-track runs, DAGMC asset checks, native plotting via C++ plot mode) and `extensions/openmc-studio/src/node/e2e/` (vitest, project-level: small `.nuke-openmc` fixtures → migration → XML generation → real runs; `codegen-run.test.ts` additionally executes the exporter's generated `model.py`). Env vars — all optional (tests skip cleanly when unset): `NUKE_TEST_PYTHON` (env python; its `bin/openmc` runs the binary), `OPENMC_CROSS_SECTIONS` (openmc-standard, needed for any model run), `NUKE_E2E_CHAIN` (depletion chain, only for depletion e2e), `NUKE_E2E_ENDF` (ENDF-B library dir with `decay/` `nfy/` `neutron(s)/`, only for the ENDF-mode chain-builder e2e). Get nuclear data from the official OpenMC data libraries (openmc.org) or the docker image's environment; the DAGMC test asset is committed at `tests/e2e/assets/fuel_pin.h5m`. No machine-specific paths anywhere in the layer. Every e2e test skips cleanly in the minimal profile, so minimal CI is unaffected; e2e tests carry the `@pytest.mark.e2e` marker.
- New Python tests must pass with only `pytest` + `numpy` installed (use `pytest.importorskip`/guarded imports for heavy deps); the full-dependency profile is exercised by the docker image test step. Tests for dependency-absence guards must force the absence (monkeypatch `sys.modules` entries to `None` or module-level `HAS_*` flags to `False`) rather than assume the ambient environment lacks the dependency, so they pass in both profiles.

## Architecture pointer

High-level layout; see the Child NAD Index below for domain-specific details.

- `applications/` — IDE shells: Theia browser app, Electron desktop app, Docker deployment.
- `extensions/` — custom Theia extensions; several ship Python backends under `python/` with pytest suites under `tests/python/`.
- `docs/` — product documentation (read natively in the IDE by `extensions/nuke-docs`).
- `resources/` — static assets (logos, preload templates, tips/quotes).
- `scripts/` — Node build/utility scripts (preload generation, version bumps, css copy, electron patch).
- `configs/` — shared `base.tsconfig.json`.
- `plugins/` — downloaded Theia `.vsix` plugins (generated; populated by `yarn download:plugins`).

## Common pitfalls

- **Never edit generated artifacts**: `extensions/*/lib/`, `applications/*/lib/`, `**/src-gen/`, `gen-webpack*.js`, `*.tsbuildinfo`, `plugins/`, and `resources/preload.html` (generated from `resources/preload.template.html` by `scripts/generate-preload.js` — edit the template instead).
- **New extensions must be registered** as dependencies in both `applications/browser/package.json` and `applications/electron/package.json`, or they will not ship.
- **Extension Python code is not pip-installed**; tests put `extensions/<name>/python/` on `sys.path` via `tests/python/conftest.py`. Keep imports package-relative to that layout (`nuke_viz.*`, `plugins.*`, top-level service modules).
- **Do not remove "unused" Python imports blindly**: some top-level imports are deliberate dependency probes that must fail fast (e.g. `import vtk` in `dagmc_viz.py`). These carry `# noqa: F401` comments.
- **`yarn install` runs `lerna run prepare`** (full extension rebuild) via the root `prepare` script; use `yarn install --ignore-scripts` when only the lockfile/node_modules must change.
- **`--ignore-scripts` also skips native module builds** (`keytar`, `cpu-features`, `@theia/ffmpeg`, `ssh2`, etc.); a following webpack build then fails with `Can't resolve '../build/Release/keytar.node'` (or `cpufeatures.node`), and `theia build` for Electron crashes in `checkFfmpeg` with `Cannot find module '../build/Debug/ffmpeg.node'`. Repair with `(cd node_modules/<mod> && npm run install)`, or `npx node-gyp rebuild` for `@theia/ffmpeg` (no install script — npm/yarn normally compile its `binding.gyp` via the implicit node-gyp install). In CI, `ci.yml` caches use the `ci-yarn-` prefix precisely so `build.yml`'s `${{ runner.os }}-yarn-` restore-keys cannot pick up scriptless node_modules; `build.yml`'s Linux job additionally rebuilds `cpu-features`/`keytar`/`@theia/ffmpeg` after install.
- **Keep `**/ssh2` pinned in root `resolutions`**: multiple ssh2 copies (hoisted + nested under `@theia/remote`) each build `sshcrypto.node`, and webpack fails with `Conflict: Multiple assets emit different content to the same filename native/sshcrypto.node`.
- **Theia does not read VS Code's `button.secondary*` theme keys**: `.theia-button.secondary` is styled from Theia-native `secondaryButton.background/foreground/hoverBackground`. Themes must define both key families or secondary buttons fall back to Theia's slate-navy default.
- **Theia CSS variables preserve case**: `--theia-<colorId>` only replaces dots with dashes (`focusBorder` → `--theia-focusBorder`). Kebab-case guesses like `--theia-focus-border` or `--theia-input-placeholder-foreground` resolve to nothing.

## Child NAD Index

- `applications/AGENTS.md` — browser/Electron/Docker IDE shells, generated frontend code, packaging.
- `docs/AGENTS.md` — product documentation conventions and the in-IDE docs widget contract.
- `extensions/AGENTS.md` — shared Theia extension conventions (layout, DI, RPC, build, docs).
  - `extensions/nuke-visualizer/AGENTS.md` — visualization plugin framework and its Python backend.
  - `extensions/openmc-studio/AGENTS.md` — OpenMC workspace extension and its Python backend.
