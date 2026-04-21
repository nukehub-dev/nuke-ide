# State Model

`OpenMCState` is the central data model for the no-code simulation builder. It is a plain JSON object that completely describes an OpenMC simulation — geometry, materials, settings, tallies, meshes, variance reduction, depletion, and optimization parameters. The state is reactive: widgets read from it and mutate it through `OpenMCStateManager`, which emits change events on every modification.

For the full schema definition, see [`src/common/openmc-state-schema.ts`](../../src/common/openmc-state-schema.ts).

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
├── varianceReduction  # Weight windows, source biasing, UFS
├── depletion          # Burnup chain, timesteps, power
└── optimization       # Parameter sweeps, run history
```

---

## Metadata

Project bookkeeping and schema versioning. The `version` field enables future migration logic when the schema evolves.

```typescript
interface OpenMCProjectMetadata {
    version: string;      // OPENMC_STATE_SCHEMA_VERSION, e.g. "1.0.0"
    name: string;
    description?: string;
    author?: string;
    created: string;      // ISO 8601
    modified: string;     // ISO 8601
}
```

**Concept:** Metadata is updated automatically by `OpenMCStateManager` on every mutating operation (it refreshes `modified`). The schema version is hard-coded and bumped when breaking changes are introduced.

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
}
```

**Concept:** Coefficients are stored as structured objects (not flat arrays) so that the CSG builder widget can render parameter labels (`x0`, `r`, etc.) without hard-coding surface-type knowledge in the UI.

### Cells and Regions

Cells define material-filled regions using boolean combinations of surfaces.

```typescript
interface OpenMCCell {
    id: number;
    name?: string;
    region?: OpenMCRegionNode;       // Boolean expression tree
    regionString?: string;            // Alternative text representation (e.g., "-1 2 -3")
    fillType: 'material' | 'universe' | 'lattice' | 'void';
    fillId?: number;
    temperature?: number;             // K
    density?: number;                 // g/cm³, overrides material density
}
```

**Concept:** The schema supports *both* a parsed boolean tree (`OpenMCRegionNode`) and a raw string (`regionString`). The tree is used by the visual CSG builder; the string is used for round-trip XML import/export. The backend canonicalizes between them when generating `geometry.xml`.

### Universes

Universes group cells hierarchically. Universe `0` is the root.

```typescript
interface OpenMCUniverse {
    id: number;
    name?: string;
    cellIds: number[];
    isRoot?: boolean;
}
```

**Concept:** Cells are *not* embedded directly in universes; they reference via `cellIds`. This avoids data duplication and makes cell re-assignment between universes a cheap array operation in `OpenMCStateManager`.

### Lattices

Repeated geometry structures. Supported types: rectangular (`rect`) and hexagonal (`hex`, `x-hex`, `y-hex`).

```typescript
type OpenMCLattice = (OpenMCRectLattice | OpenMCHexLattice) & {
    id: number;
    name?: string;
    outer?: number;   // Universe ID for positions outside the lattice
};
```

**Concept:** The `universes` property is a 3D array of universe IDs (`number[][][]`). For 2D lattices the third dimension has length 1. The `outer` universe handles positions beyond the defined array — essential for fuel-assembly models with infinite moderator.

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
    volume?: number;       // cm³, required for depletion
    temperature?: number;  // K
    color?: string;        // hex code for visualization
}
```

**Concept:** `densityUnit` is explicit rather than inferred. This prevents ambiguity during XML generation (OpenMC accepts multiple units) and lets the UI show the correct unit label without heuristic parsing.

### S(α,β) Thermal Scattering

```typescript
interface OpenMCThermalScattering {
    name: string;      // e.g., 'c_Graphite', 'h_H2O'
    fraction: number;  // usually 1.0
}
```

**Concept:** Thermal scattering is stored as a first-class array on the material, not as a nuclide modifier. This mirrors OpenMC's XML structure and makes the tally-configurator widget's material inspector simpler.

---

## Settings

### Run Modes

The run configuration is a discriminated union keyed by `mode`:

```typescript
type OpenMCRunSettings =
    | OpenMCEigenvalueSettings   // { mode: 'eigenvalue', particles, inactive, batches }
    | OpenMCFixedSourceSettings  // { mode: 'fixed source', particles, batches }
    | OpenMCVolumeSettings;      // { mode: 'volume', samples?, bounds? }
```

**Concept:** Using a discriminated union lets TypeScript narrow the type inside widgets. The eigenvalue dashboard only renders inactive-batch inputs when `mode === 'eigenvalue'`.

### Sources

External sources support spatial, energy, angular, and time distributions:

```typescript
interface OpenMCSource {
    spatial: OpenMCSourceSpatial;   // point | box | sphere | cylinder
    energy: OpenMCSourceEnergy;     // discrete | uniform | maxwell | watt | muir | tabular
    angle?: OpenMCSourceAngle;      // isotropic | monodirectional | polar-azimuthal
    strength?: number;
    particle?: 'neutron' | 'photon';
    time?: { type: 'delta' | 'uniform' | 'discrete', params: {...} };
}
```

**Concept:** Each distribution type is a separate interface extending a common base. Widgets can switch rendering based on `type` without parsing opaque parameter arrays.

### Entropy Mesh

A regular Cartesian mesh for Shannon entropy convergence monitoring:

```typescript
interface OpenMCEntropyMesh {
    lowerLeft: [number, number, number];
    upperRight: [number, number, number];
    shape: [number, number, number];
}
```

---

## Tallies

Tallies define what physical quantities to score, on which filters, and with which estimator.

```typescript
interface OpenMCTally {
    id: number;
    name?: string;
    scores: OpenMCTallyScore[];      // 'flux', 'fission', 'heating', ...
    nuclides: string[];              // 'total' or specific nuclide names
    filters: OpenMCTallyFilter[];    // cell, energy, mesh, ...
    estimator?: 'analog' | 'tracklength' | 'collision';
    multiplyDensity?: boolean;
}
```

**Concept:** Filters carry `bins` as a flat number array. The interpretation of those numbers depends on `type` (cell IDs vs energy bounds vs mesh IDs). The tally-configurator widget uses the `type` to render appropriate editors (cell picker, energy range slider, mesh selector).

---

## Meshes

Meshes are used by tally filters and variance reduction. Three coordinate systems are supported:

| Type | Interface | Key Properties |
|------|-----------|----------------|
| **Regular** | `OpenMCRegularMesh` | `lowerLeft`, `upperRight`, `dimension: [nx, ny, nz]` |
| **Cylindrical** | `OpenMCCylindricalMesh` | `origin`, `axis`, `rGrid`, `phiGrid`, `zGrid` |
| **Spherical** | `OpenMCSphericalMesh` | `origin`, `rGrid`, `thetaGrid`, `phiGrid` |

**Concept:** All mesh types share `id` and `name` but have coordinate-system-specific grid definitions. The tally configurator renders a mesh preview using the bounding box for regular meshes and the grid arrays for curvilinear meshes.

---

## Variance Reduction

```typescript
interface OpenMCVarianceReduction {
    weightWindows?: OpenMCWeightWindows;
    weightWindowGenerator?: { iterations?: number; particleType?: 'neutron' | 'photon' };
    sourceBiasing?: OpenMCSourceBiasing;
    survivalBiasing?: boolean;
    cutoff?: { weight?: number; weightAvg?: number };
    ufs?: OpenMCUFS;   // Uniform Fission Site
}
```

**Concept:** Weight windows reference a mesh by `meshId`, decoupling the variance-reduction definition from the mesh geometry. This lets users tune weight bounds without redefining the mesh.

---

## Depletion

Time-dependent material evolution (burnup) settings:

```typescript
interface OpenMCDepletion {
    enabled?: boolean;
    chainFile?: string;
    operator?: 'coupled' | 'independent' | 'openmc';
    power?: number;            // Watts
    powerDensity?: number;     // W/g
    timeSteps: string[] | number[];   // e.g., ['1 d', '30 d', '1 y']
    solver?: 'cecm' | 'epc' | 'predictor' | ...;
    substeps?: number;
    normalizationMode?: 'source-rate' | 'fission-q' | 'energy-deposition';
    decayOnlySteps?: number[]; // Indices of timesteps with no transport
    reduceOutput?: boolean;
}
```

**Concept:** `timeSteps` accepts both numeric seconds and string expressions with units. The backend normalizes strings to seconds before writing the OpenMC depletion XML. `decayOnlySteps` is stored as indices rather than flags on each step to keep the array compact.

---

## Optimization

Parameter sweeps for sensitivity studies and design optimization:

```typescript
interface OpenMCParameterSweep {
    id: number;
    name: string;
    enabled: boolean;
    variable: string;               // Human-readable name
    parameterType: 'material' | 'geometry' | 'settings';
    parameterPath: string;          // JSON path, e.g. 'materials.0.density'
    rangeType: 'linear' | 'logarithmic';
    startValue: number;
    endValue: number;
    numPoints: number;
    values?: number[];              // Computed by StateManager
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

The `OPENMC_STATE_SCHEMA_VERSION` constant (currently `'1.0.0'`) is embedded in every saved file. When the schema changes, a migration function can inspect `version` and transform legacy states on load. The `OpenMCStateManager` calls migration before adopting a loaded state.

---

## Default State

`createDefaultState()` (in `openmc-state-manager.ts`) produces a minimal valid state:
- Root universe `0` with no cells
- Eigenvalue run settings (`1000` particles, `10` inactive, `100` batches)
- A single box source centered at the origin with `1 MeV` discrete energy
- Empty materials, tallies, and meshes

This guarantees that `OpenMCState` is always structurally valid even for a blank project, preventing undefined-property errors in widgets.
