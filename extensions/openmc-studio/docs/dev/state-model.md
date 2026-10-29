# State Model

`OpenMCState` is the central data model for the no-code simulation builder. It is a plain JSON object that completely describes an OpenMC simulation — geometry, materials, settings, tallies, meshes, variance reduction, depletion, and optimization parameters. The state is reactive: widgets read from it and mutate it through `OpenMCStateManager`, which emits change events on every modification.

For the full schema definition, see [`src/common/openmc-state-schema.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/openmc-studio/src/common/openmc-state-schema.ts).

---

## State Structure Overview

```
OpenMCState
├── metadata           # Project name, description, author, timestamps
├── geometry           # Surfaces, cells, universes, lattices
├── materials          # Nuclides, densities, S(α,β)
├── settings           # Run mode, sources, entropy mesh, output options
├── tallies            # Scores, filters, estimators
├── meshes             # Regular, cylindrical, spherical
├── varianceReduction  # Weight-window sets/file/checkpoints, UFS
├── depletion          # Burnup chain, timesteps, power
└── optimization       # Parameter sweeps, run history
```

---

## Metadata

Project bookkeeping and schema versioning. The `version` field enables future migration logic when the schema evolves.

```typescript
interface OpenMCProjectMetadata {
  version: string; // OPENMC_STATE_SCHEMA_VERSION, e.g. "1.0.0"
  name: string;
  description?: string;
  author?: string;
  created: string; // ISO 8601
  modified: string; // ISO 8601
  mgBackup?: {
    materials: OpenMCMaterial[]; // Materials before "Convert to Multi-Group"
    energyMode?: OpenMCSettings['energyMode']; // Energy mode before conversion
  };
}
```

**Concept:** Metadata is updated automatically by `OpenMCStateManager` on every mutating operation (it refreshes `modified`). The schema version is hard-coded and bumped when breaking changes are introduced. `mgBackup` is the optional, version-tolerant snapshot stashed by "Convert to Multi-Group" (no migration needed); "Revert to Continuous-Energy" restores the pre-conversion materials and energy mode from it (see `src/common/mg-conversion.ts`).

---

## Geometry

### Surfaces

OpenMC CSG surfaces are quadratic surfaces defined by type + coefficients. The schema uses a discriminated union: `type` determines which coefficient keys are valid.

```typescript
interface OpenMCSurface {
    id: number;
    type: 'sphere' | 'x-cylinder' | 'z-plane' | 'plane' | ...;
    coefficients: { x0: number; y0: number; z0: number; r: number }; // shape depends on type
    boundary?: 'vacuum' | 'reflective' | 'periodic' | 'white' | 'transmission';
    name?: string;
    periodicSurfaceId?: number;
    albedo?: number; // importance multiplier; only reflective/periodic/white
}
```

**Concept:** Coefficients are stored as structured objects (not flat arrays) so that the CSG builder widget can render parameter labels (`x0`, `r`, etc.) without hard-coding surface-type knowledge in the UI. Periodic boundaries must be reciprocal planes: both surfaces carry `boundary: 'periodic'` and each names the other in `periodicSurfaceId`; `validateState` rejects one-sided pairs, self-pairs, non-plane partners, and albedo on boundaries where OpenMC ignores it.

### Cells and Regions

Cells define material-filled regions using boolean combinations of surfaces.

```typescript
interface OpenMCCell {
  id: number;
  name?: string;
  region?: OpenMCRegionNode; // Boolean expression tree
  regionString?: string; // Alternative text representation (e.g., "-1 2 -3")
  fillType: 'material' | 'universe' | 'lattice' | 'void';
  fillId?: number;
  temperature?: number; // K
  density?: number; // positive override; units follow the material density unit
  rotation?: [number, number, number]; // intrinsic Tait-Bryan phi/theta/psi in degrees
  translation?: [number, number, number]; // cm, applied after rotation
  volume?: number; // cm³, emitted as <cell volume="...">; required for R2S activation
}
```

`volume` is optional for ordinary transport (OpenMC computes it) but required by cell-based R2S activation. It round-trips through `geometry.xml`; see [Shutdown Dose](shutdown-dose.md).

**Concept:** The schema supports _both_ a parsed boolean tree (`OpenMCRegionNode`) and a raw string (`regionString`). The tree is used by the visual CSG builder; the string is used for round-trip XML import/export. The backend canonicalizes between them when generating `geometry.xml`. Rotation/translation apply to universe and lattice fills; density applies to material fills. `setCellTransform` replaces (or clears) both transforms in one state event, and `setSurfacePeriodicPair` maintains reciprocal periodic links; the pure transitions live in `src/common/geometry-state.ts`.

### Universes

Universes group cells hierarchically. Universe `0` is the root: OpenMC XML has no explicit root element, so cells without a `universe` attribute belong to universe 0 and every other universe must be reachable from it. There is no `isRoot` flag — a universe is the root exactly when its ID is `0`.

```typescript
interface OpenMCUniverse {
  id: number;
  name?: string;
  cellIds: number[];
}
```

**Concept:** Cells are _not_ embedded directly in universes; they reference via `cellIds`. This avoids data duplication and makes cell re-assignment between universes a cheap array operation in `OpenMCStateManager`. A cell belongs to exactly one universe; `validateState` rejects duplicate membership, root fills, and lattice/universe ID collisions (OpenMC resolves a fill ID against the universe map before the lattice map).

### Lattices

Repeated geometry structures. Supported types: rectangular (`rect`) and hexagonal (`hex`).

```typescript
type OpenMCLattice = (OpenMCRectLattice | OpenMCHexLattice) & {
  id: number;
  name?: string;
  outer?: number; // Universe ID for positions outside the lattice
};
```

**Concept:** Both lattice arrays mirror the OpenMC Python objects exactly, so XML and Python export share one ordering:

- Rectangular: `universes[z][y][x]`; `dimensions` is `[nx, ny]` or `[nx, ny, nz]`, and `y = 0` is the top row (OpenMC's `RectLattice.universes`).
- Hexagonal: `universes[z][ring][theta]`; `rings` is OpenMC's `n_rings` (center ring included), ring 0 is the outermost ring, theta starts at the top and runs clockwise. `orientation` is `'x' | 'y'` (default `'y'`) and `nAxial` is set only for 3D lattices (`<n_axial>`). The old `x-hex`/`y-hex` types and `axial` sub-object are normalized on load.

`outer` handles positions beyond the defined array — essential for fuel-assembly models with infinite moderator. The state manager exposes `updateLattice`, `setLatticeUniverse`, and `setLatticeUniverses` for the grid/ring editors; the CSG Builder renders these maps with the pure helpers in `src/common/geometry-editor.ts`.

---

## Materials

Materials are composed of nuclides with atomic or weight fractions, plus optional thermal scattering data.

```typescript
interface OpenMCMaterial {
  id: number;
  name: string;
  density: number;
  densityUnit: 'g/cm3' | 'kg/m3' | 'atom/b-cm' | 'sum';
  nuclides: OpenMCNuclide[];
  thermalScattering: OpenMCThermalScattering[];
  isDepletable?: boolean;
  volume?: number; // cm³, required for depletion
  temperature?: number; // K
  color?: string; // hex code for visualization
}
```

**Concept:** `densityUnit` is explicit rather than inferred. This prevents ambiguity during XML generation (OpenMC accepts multiple units) and lets the UI show the correct unit label without heuristic parsing.

### S(α,β) Thermal Scattering

```typescript
interface OpenMCThermalScattering {
  name: string; // e.g., 'c_Graphite', 'h_H2O'
  fraction: number; // usually 1.0
}
```

**Concept:** Thermal scattering is stored as a first-class array on the material, not as a nuclide modifier. This mirrors OpenMC's XML structure and makes the tally-configurator widget's material inspector simpler.

### Macroscopic and NCrystal materials

Materials may carry `macroscopic: { name }` (multigroup XS data, no nuclide decomposition; `densityUnit: 'macro'`) — materials.xml uses
the real `<macroscopic name="..."/>` form and round-trips, except in nuclide-wise mode where stale flags are ignored. Materials may also
carry `ncrystalCfg` (NCrystal configuration string), emitted as the `<material cfg="...">` attribute with nuclide decomposition kept; `cfg`
is incompatible with sab and macroscopic. The Python exporter emits `Material.from_ncrystal(...)` for cfg materials.

---

## Settings

### Run Modes

The run configuration is a discriminated union keyed by `mode`:

```typescript
type OpenMCRunSettings =
  | OpenMCEigenvalueSettings // { mode: 'eigenvalue', particles, inactive, batches }
  | OpenMCFixedSourceSettings // { mode: 'fixed source', particles, batches }
  | OpenMCVolumeSettings; // { mode: 'volume', samples?, bounds? }
```

**Concept:** Using a discriminated union lets TypeScript narrow the type inside widgets. The eigenvalue dashboard only renders inactive-batch inputs when `mode === 'eigenvalue'`.

### Sources

External sources use one shared univariate model for energy, time, spatial
coordinates, mu/phi, and nested mixture children:

```typescript
type OpenMCUnivariateType =
  'discrete' | 'uniform' | 'maxwell' | 'watt' | 'normal' | 'muir' | 'powerlaw' | 'tabular' | 'mixture' | 'decay-spectrum';
// OpenMCUnivariate is the discriminated union of objects tagged with these types.

interface OpenMCIndependentSource {
  spatial: OpenMCSourceSpatial; // point | box | sphere | cylinder | cartesian | cylindrical
  // | spherical | pointcloud | mesh
  energy: OpenMCUnivariate; // ev; decay-spectrum is 0.16-only
  angle?: OpenMCSourceAngle; // isotropic | monodirectional | mu-phi
  time?: OpenMCSourceTime; // delta | uniform | discrete | tabular | mixture (seconds)
  strength?: number;
  particle?: 'neutron' | 'photon';
}
```

`OpenMCSourceEnergy` is an alias of `OpenMCUnivariate`; the energy-specific
interface names (`OpenMCDiscreteEnergy`, `OpenMCTabularEnergy`, ...) remain as
aliases. Mutation is by replacement: editors build the next distribution object
and call `updateSettings`, never mutate the previous array in place. Source bias
lives on the distribution (`bias`) and is covered under
[Variance Reduction](#source-bias).

`Legendre` is intentionally absent (its `to_xml_element()` raises
`NotImplementedError`). Tabular `ignore_negative` is not modeled because OpenMC
XML has no attribute for it; negative densities are rejected in validation
instead of letting XML and Python export diverge.

### Mesh and tokamak source variants

The source model is a discriminated union (`independent` | `file` | `compiled` | `mesh` | `tokamak`; absent `type` means `independent`)
with optional per-source `constraints` (fixed-source random ray requires material/cell/universe domain constraints). The `mesh` variant
references a state mesh by `meshId` with exactly one independent sub-source per mesh element; the `tokamak` variant (0.16.0+) models Miller
flux-surface geometry plus an `{r, s}` emission profile and a single energy distribution (`muir` serializes lossy as `normal`).
An independent source's `mesh` spatial distribution (`meshId`, optional element `strengths`, `volumeNormalized`) is distinct from
the `mesh` source variant: the former samples a site from one mesh element with a single energy/direction/time set, while the
latter requires one sub-source per element.

Legacy project files are normalized on load without a schema-version bump: pre-univariate time shapes (`params.times/min/max/time`)
convert to the shared model, and legacy angle types (`polar-azimuthal`, `reference`) convert to `mu-phi`/`monodirectional`.
Delta time round-trips through XML as a one-point discrete and converts back to `delta` on import.

### Entropy Mesh

A regular Cartesian mesh for Shannon entropy convergence monitoring:

```typescript
interface OpenMCEntropyMesh {
  lowerLeft: [number, number, number];
  upperRight: [number, number, number];
  shape: [number, number, number];
}
```

### Multi-Group and DAGMC Toggles

Two optional booleans on `OpenMCSettings` control specialized run modes (the schema file holds the full settings field list):

- `settings.nuclideWiseMgxs` — switches multi-group mode from material-wise macroscopic to nuclide-decomposed: the MGXS library holds one micro XSdata set per nuclide and materials stay nuclide-decomposed (no `macroscopic`). Required for random ray on DAGMC geometries, which reject macroscopic multi-group materials. Undefined/false = material-wise macroscopic mode.
- `settings.copyDagmcToRunDirectory` — when true, the DAGMC `.h5m` file is copied into each run directory as `geometry.h5m`; otherwise geometry.xml references the original file via a relative path (see [XML Generation](xml-generation.md#dagmc-geometry-mode)).

---

## Tallies

Tallies define what physical quantities to score, on which filters, and with which estimator.

```typescript
interface OpenMCTally {
  id: number;
  name?: string;
  scores: OpenMCTallyScore[]; // 'flux', 'fission', 'heating', ...
  nuclides: string[]; // 'total' or specific nuclide names
  filters: OpenMCTallyFilter[]; // cell, energy, mesh, ...
  estimator?: 'analog' | 'tracklength' | 'collision';
  multiplyDensity?: boolean; // absent = true
  higherMoments?: boolean; // <higher_moments>
}
```

**Concept:** Filters carry `bins` as a flat number array. The interpretation of those numbers depends on `type` (cell IDs vs energy bounds vs mesh IDs). Structured filters keep dedicated fields so the row order is explicit: `pairs` for `cellinstance` (cell ID + instance) and `meshmaterial` (zero-based mesh element + material ID), `nuclideBins` for `parentnuclide`, `reactionBins` for canonical `reaction` names, and `particleTypes` + `productionEnergyBins` for `particleproduction`. The flat OpenMC encoding is mirrored into `bins` for pair filters; XML generation, import, Python export, and the editor all share `src/common/tally-filter-utils.ts` so no path silently reorders bins. `reaction` and `particleproduction` are 0.16-only and are gated by `OpenMCCompat.reactionFilter` / `particleProductionFilter`.

`multiplyDensity` and `higherMoments` are tally output options that are XML-representable. `sparse` and `with_batch_statistics` are Python/statepoint analysis options and deliberately have no schema field or UI control.

---

## Meshes

Meshes are used by tally filters, mesh sources, and variance reduction. All five `openmc.mesh` types are supported:

| Type             | Interface                | Key Properties                                                          |
| ---------------- | ------------------------ | ----------------------------------------------------------------------- |
| **Regular**      | `OpenMCRegularMesh`      | `lowerLeft`, `upperRight`, `dimension: [nx, ny, nz]`                    |
| **Rectilinear**  | `OpenMCRectilinearMesh`  | `xGrid`, `yGrid`, `zGrid` (explicit, strictly increasing boundaries)    |
| **Cylindrical**  | `OpenMCCylindricalMesh`  | `origin`, `axis`, `rGrid`, `phiGrid`, `zGrid`                           |
| **Spherical**    | `OpenMCSphericalMesh`    | `origin`, `rGrid`, `thetaGrid`, `phiGrid`                               |
| **Unstructured** | `OpenMCUnstructuredMesh` | `filename`, `library` (`moab`/`libmesh`), `lengthMultiplier`, `options` |

**Concept:** All mesh types share `id` and `name`; structured types carry coordinate-system-specific grid arrays, while unstructured meshes reference an external MOAB/Exodus file. `getMeshElementCount` derives element counts from grid lengths (unstructured counts require statepoint data and return `undefined`). Rectilinear grids are validated as ≥2 finite, strictly increasing points per axis; unstructured filenames are validated against the selected library's extensions (MOAB: `.h5m`/`.h5`/`.vtk`/Exodus; libMesh: Exodus `.e`/`.exo`/`.ex2`).

Unstructured paths are stored project-relative when the file lives inside the project and resolved back to absolute paths on load, matching the DAGMC/MGXS path policy. XML import resolves relative `<filename>` values against the XML directory.

Mesh filters may carry optional transforms: `meshTranslation` (cm, every release) and `meshRotation` (intrinsic Tait-Bryan `phi`/`theta`/`psi` degrees, 0.16.0+). Rotation emission is gated by the probed `OpenMCCompat.meshFilterRotation` capability; the UI warns and XML omits it on older environments.

---

## Variance Reduction

### Source bias

OpenMC biases distributions, not source strength. An independent source carries
optional bias on the distributions that support it:

```typescript
// Continuous univariates nest a distribution with the same support.
energy: { type: 'uniform', min: 0, max: 20e6, bias: { distribution: { type: 'uniform', min: 1e5, max: 2e6 } } }
// Discrete/Mixture carry alternative probabilities.
energy: { type: 'discrete', energies: [1e6, 2e6], probabilities: [0.5, 0.5], bias: { probabilities: [0.9, 0.1] } }
// Isotropic direction uses PolarAzimuthal.
angle: { type: 'isotropic', bias: { distribution: { type: 'mu-phi', mu, phi } } }
// Point-cloud/mesh spatial distributions carry per-point/per-element arrays.
spatial: { type: 'pointcloud', positions, strengths, bias: { probabilities } }
```

`OpenMCUnivariateBase.bias` stores the `OpenMCUnivariateBias` union
(`distribution` or `probabilities`); `OpenMCArrayBias` stores spatial arrays.
A bias distribution may not itself be biased, and continuous bias must share
the parent support interval (OpenMC `check_bias_support`). Decay spectra reject
bias because OpenMC constructs them with `bias=None`. Point/box/sphere/cylinder
spatial types are not biasable; the editor explains that instead of showing a
dead control. The retired `varianceReduction.sourceBiasing` object is migrated
on load to the first independent source's energy bias where representable;
`strengthBias` and spatial legacy bias are dropped with a normalization warning.
Source bias is 0.16-only; `OpenMCCompat.sourceBias` is probed from the
`Uniform(..., bias=...)` signature, and XML/Python export strip the bias (with a
warning) when the environment probe reports it unsupported.

### Weight windows and UFS

```typescript
interface OpenMCVarianceReduction {
  weightWindows?: OpenMCWeightWindows[]; // one entry per <weight_windows id="...">
  weightWindowsFile?: string; // HDF5 loaded with <weight_windows_file>
  weightWindowsOn?: boolean; // <weight_windows_on>; defaults on when sets/file exist
  weightWindowCheckpoints?: { collision?: boolean; surface?: boolean };
  weightWindowGenerator?: WeightWindowGenerator; // <weight_window_generators>
  survivalBiasing?: boolean;
  cutoff?: { weight?: number; weightAvg?: number };
  ufs?: OpenMCUFS; // { enabled, meshId } -> <ufs_mesh> (regular mesh only)
}
```

Each set has an optional `id` (assigned 1..n when missing), `meshId`,
`particleType`, `energyBounds`, scalar-or-array `lowerBound` / `upperBound`,
`survivalWeight` (OpenMC `survival_ratio`), `maxSplit`, and `weightCutoff`. A
scalar bound broadcasts over `n_mesh_cells × n_energy_groups`; an explicit
array is emitted verbatim. The legacy single-object `weightWindows` shape is
normalized to a one-entry list on load. A file is loaded in addition to any
sets (OpenMC appends both), so the editor warns when a generator could overwrite
it. UFS requires an explicit regular mesh; it applies only to eigenvalue runs.
The generator resolves its mesh from `weightWindowGenerator.meshId`, then the
first set, then the UFS mesh.

**Concept:** Weight windows reference a mesh by `meshId`, decoupling the variance-reduction definition from the mesh geometry. This lets users tune weight bounds without redefining the mesh.

---

## Depletion

Time-dependent material evolution (burnup) settings:

```typescript
interface OpenMCDepletion {
  enabled?: boolean;
  chainFile?: string;
  operator?: 'coupled' | 'independent' | 'openmc';
  power?: number; // Watts
  powerDensity?: number; // W/g
  timeSteps: string[] | number[]; // e.g., ['1 d', '30 d', '1 y']
  solver?: 'cecm' | 'predictor' | 'cf4' | 'celi' | 'epc_rk4' | 'leqi' | 'si_celi' | 'si_leqi'; // integrator_by_name ids; legacy names map via resolveDepletionSolver
  substeps?: number; // CRAM substeps per interval (OpenMC 0.16+)
  normalizationMode?: 'source-rate' | 'fission-q' | 'energy-deposition';
  decayOnlySteps?: number[]; // Indices of timesteps with no transport
  reduceOutput?: boolean;
  reactivityControl?: OpenMCReactivityControl; // curated keff search (cell translation | nuclide density)
  externalSourceRates?: OpenMCExternalSourceRate[]; // feed/removal composition + mass rate
  continueFromResults?: string; // previous depletion_results.h5
  continueTimesteps?: boolean; // continue the previous schedule (requires the file)
}
```

**Concept:** `timeSteps` accepts both numeric seconds and string expressions with units. The backend normalizes strings to seconds before writing the OpenMC depletion XML. `decayOnlySteps` is stored as indices rather than flags on each step to keep the array compact. Reactivity control and continuation are optional and safe to leave unset; `substeps` defaults to 1. All advanced fields are driver-only (see [XML Generation](xml-generation.md#depletion-triggers-derivatives-kinetics-cmfd)).

---

## Shutdown Dose (R2S / D1S)

`OpenMCState.shutdownDose` stores the driver-only activation workflow configuration:

```typescript
interface OpenMCShutdownDoseConfig {
  method: 'r2s' | 'd1s';
  domainType?: 'cell' | 'mesh';
  cellIds?: number[];
  meshIds?: number[];
  timesteps: (number | string)[];
  timestepUnits?: 's' | 'min' | 'h' | 'd' | 'a';
  sourceRates: number | number[];
  chainFile?: string;
  photonTimeIndices?: number[];
  byParentNuclide?: boolean;
  outputDirectory?: string;
  workingDirectory?: string;
  boundingBoxes?: Record<number, { lowerLeft: [number, number, number]; upperRight: [number, number, number] }>;
  matVolSamples?: number;
  photonTallyIds?: number[];
  d1sTimeIndex?: number;
  d1sSumNuclides?: boolean;
  wizardStep?: 'method' | 'schedule' | 'tallies' | 'review' | 'results';
  doseTallyId?: number;
  lastRun?: { outputDirectory: string; method: 'r2s' | 'd1s'; completedAt?: string };
}
```

**Concept:** No shutdown-dose field is written to `settings.xml` or `tallies.xml`; the Python drivers receive the configuration as JSON alongside the generated model XML. `wizardStep`/`lastRun` make the wizard resumable, and `photonTallyIds` reference ordinary project tallies (the dose tally template adds a normal photon flux tally with an `energyfunction` response filter). See [Shutdown Dose](shutdown-dose.md) for the protocol and drivers.

---

## Optimization

Parameter sweeps for sensitivity studies and design optimization:

```typescript
interface OpenMCParameterSweep {
  id: number;
  name: string;
  enabled: boolean;
  variable: string; // Human-readable name
  parameterType: 'material' | 'geometry' | 'settings';
  parameterPath: string; // JSON path, e.g. 'materials.0.density'
  rangeType: 'linear' | 'logarithmic';
  startValue: number;
  endValue: number;
  numPoints: number;
  values?: number[]; // Computed by StateManager
}
```

**Concept:** Sweeps target state via JSON path strings rather than direct references. This makes sweeps serializable and allows the optimization backend to apply them by deep-patching a cloned state before each iteration. `StateManager.computeSweepValues()` generates the numeric array from `rangeType`, `startValue`, `endValue`, and `numPoints`.

---

## Serialization

### `.nuke-openmc` Project Files

The complete state is saved as JSON in `.nuke-openmc` files:

```typescript
interface OpenMCProjectFile {
    version: string;          // Schema version
    state: OpenMCState;       // Complete simulation state
    fileSync?: {              # Optional bi-directional XML sync metadata
        geometryXml?: string;
        materialsXml?: string;
        settingsXml?: string;
        talliesXml?: string;
        plotsXml?: string;
    };
    lastSync?: {              # ISO timestamps of last XML sync
        geometry?: string;
        ...
    };
}
```

**Concept:** `fileSync` and `lastSync` enable round-trip editing: the user can edit XML externally and re-import, or edit in the GUI and export XML, with conflict detection based on timestamps. This is optional — projects work fine without ever touching XML directly.

### Migration

The `OPENMC_STATE_SCHEMA_VERSION` constant (currently `'1.2.0'`) is embedded in every saved file. When the schema changes, a migration function can inspect `version` and transform legacy states on load. The `OpenMCStateManager` calls migration before adopting a loaded state. Version-independent representation changes (retired `isRoot`, legacy `x-hex`/`y-hex` lattice types, old `axial` lattice fields) are normalized on every load by `normalizeGeometryForLoad`.

---

## Default State

`createDefaultState()` (in `openmc-state-manager.ts`) produces a minimal valid state:

- Root universe `0` with no cells
- Eigenvalue run settings (`1000` particles, `10` inactive, `100` batches)
- A single box source centered at the origin with `1 MeV` discrete energy
- Empty materials, tallies, and meshes

This guarantees that `OpenMCState` is always structurally valid even for a blank project, preventing undefined-property errors in widgets.
