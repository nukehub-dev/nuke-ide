# XML Generation

OpenMC Studio maintains a single source of truth — `OpenMCState` — and generates OpenMC XML input files from it. This document explains how GUI state maps to XML, how the generation pipeline works, and how XML is imported back into state.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  OpenMCState (frontend)                                     │
│  ├── metadata                                               │
│  ├── geometry { surfaces, cells, universes, lattices }      │
│  ├── materials [ { id, name, density, nuclides, sab } ]     │
│  ├── settings { run, sources, temperature, cutoff, ... }    │
│  ├── tallies [ { id, name, filters, scores, nuclides } ]    │
│  ├── meshes [ { id, type, dimension, lowerLeft, ... } ]     │
│  └── plots [ { id, type, origin, width, pixels } ]          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ generateXML()
┌─────────────────────────────────────────────────────────────┐
│  OpenMCXMLGenerationService (frontend)                      │
│  └── calls backendService.generateXML(request)              │
└─────────────────────────────────────────────────────────────┘
                            │ RPC
                            ▼
┌────────────────────────────────────────────────────────────┐
│  XMLGenerationService (Node backend)                       │
│  ├── generateMaterialsXML() → materials.xml                │
│  ├── generateGeometryXML()  → geometry.xml                 │
│  ├── generateSettingsXML()  → settings.xml                 │
│  ├── generateTalliesXML()   → tallies.xml                  │
│  └── generatePlotsXML()     → plots.xml                    │
└────────────────────────────────────────────────────────────┘
```

**Key files:**

| File                                                                                                                                                                                    | Role                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`src/browser/xml-generator/xml-generation-service.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/openmc-studio/src/browser/xml-generator/xml-generation-service.ts) | Frontend service: validates, formats request, shows toast messages      |
| [`src/node/xml-generation-service.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/openmc-studio/src/node/xml-generation-service.ts)                                   | Backend service: generates XML strings from `OpenMCState`               |
| [`src/common/openmc-studio-protocol.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/openmc-studio/src/common/openmc-studio-protocol.ts)                               | `XMLGenerationRequest`, `XMLGenerationResult`, `XMLImportRequest` types |

---

## materials.xml

Maps `OpenMCState.materials` → `<materials>`.

### State → XML Mapping

| State Field                        | XML Element                          | Notes                                |
| ---------------------------------- | ------------------------------------ | ------------------------------------ |
| `material.id`                      | `<material id="...">`                | Required                             |
| `material.name`                    | `<material name="...">`              | Escaped for XML                      |
| `material.density` + `densityUnit` | `<density units="..." value="..."/>` | `g/cm3`, `atom/b-cm`, etc.           |
| `material.nuclides[]`              | `<nuclide name="..." ao="..."/>`     | `ao` or `wo` based on `fractionType` |
| `material.thermalScattering[]`     | `<sab name="..."/>`                  | S(α,β) thermal scattering data       |
| `material.isDepletable`            | `depletable="true"`                  | Attribute on `<material>`            |
| `material.volume`                  | `volume="..."`                       | Attribute on `<material>`            |
| `material.temperature`             | `temperature="..."`                  | Attribute on `<material>`            |

### Example

```typescript
// State
{
    id: 1,
    name: 'UO2 Fuel',
    density: 10.0,
    densityUnit: 'g/cm3',
    nuclides: [
        { name: 'U235', fraction: 0.04, fractionType: 'wo' },
        { name: 'U238', fraction: 0.96, fractionType: 'wo' },
        { name: 'O16', fraction: 2.0, fractionType: 'wo' }
    ],
    thermalScattering: [],
    isDepletable: true,
    temperature: 900
}
```

```xml
<material id="1" name="UO2 Fuel" depletable="true" temperature="900">
  <density units="g/cm3" value="10"/>
  <nuclide ao="0.04" name="U235"/>
  <nuclide ao="0.96" name="U238"/>
  <nuclide ao="2.0" name="O16"/>
</material>
```

### DAGMC Material Handling

When `settings.dagmcFile` is set, the generator checks that OpenMC material names match DAGMC group names. Missing materials are logged as warnings but not auto-created — users must create them in the Materials tab.

---

## geometry.xml

Maps `OpenMCState.geometry` → `<geometry>`.

### State → XML Mapping

| State Field                 | XML Element                      | Notes                                                              |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `surface.id`                | `<surface id="...">`             | Required                                                           |
| `surface.type`              | `type="..."`                     | `sphere`, `x-cylinder`, `z-plane`, etc.                            |
| `surface.coefficients`      | `coeffs="..."`                   | Formatted per surface type                                         |
| `surface.boundary`          | `boundary="..."`                 | ONLY when set; unset = transmission default (interior stays unset) |
| `surface.albedo`            | `albedo="..."`                   | Only reflective/periodic/white and only when not 1                 |
| `surface.periodicSurfaceId` | `periodic_surface_id="..."`      | Emitted on both planes of a validated periodic pair                |
| `cell.id`                   | `<cell id="...">`                | Required                                                           |
| `cell.fillType` + `fillId`  | `material="..."` or `fill="..."` | Material ID, universe ID, lattice ID, or void                      |
| `cell.regionString`         | `region="..."`                   | CSG boolean expression                                             |
| `cell.universe`             | `universe="..."`                 | Defaults to `0` (root)                                             |
| `cell.density`              | `density="..."`                  | Positive per-cell density override                                 |
| `cell.translation`          | `translation="x y z"`            | Applied after rotation                                             |
| `cell.rotation`             | `rotation="phi theta psi"`       | Intrinsic Tait-Bryan angles in degrees                             |
| `cell.volume`               | `volume="..."`                   | cm³; imported back; required for cell-based R2S activation         |
| `lattice.*`                 | `<lattice>` / `<hex_lattice>`    | See below; every universe ID is preserved                          |

### Lattices

Rectangular and hexagonal lattices use different OpenMC element names (`<lattice>` vs `<hex_lattice>`), never a `type` attribute.

- Rectangular: attributes `id`, optional `name`; children in OpenMC order `pitch`, optional `outer`, `dimension`, `lower_left`, `universes`. `universes` is one row per z/y slice, x-fastest; row 0 is the top y row (the order `RectLattice.create_xml_subelement` writes and both readers consume).
- Hexagonal: attributes `id`, optional `name`, `n_rings`, optional `orientation` (only `x` is written; `y` is the default), optional `n_axial` (only when greater than 1); children `pitch`, optional `outer`, `center`, `universes`. Universe order is the visual top-to-bottom walk of the hexagon produced by `HexLattice._repr_axial_slice_x/_y`; `geometry-lattices.ts` reproduces it for both orientations so generation and import cannot drift.

`universes` arrays in state use the same nesting as OpenMC: `[z][y][x]` for rectangular, `[z][ring][theta]` for hexagonal (one z slice for 2D). `outer` is emitted only when set and its universe must exist.

### Root universe and fill namespaces

OpenMC XML has no `<root_universe>` element. The C++ reader derives the root as the one universe that is not used as a cell fill or a lattice universe; cells without a `universe` attribute belong to universe 0. OpenMC Studio therefore requires `geometry.rootUniverseId === 0`, rejects universe 0 as a fill, and rejects lattice IDs that collide with universe IDs (the C++ reader resolves a fill ID to a universe before a lattice). Every universe referenced by a cell fill, lattice position, or outer fill must also contain at least one cell, because OpenMC builds its universe map from cells and omits empty universes. These checks live in `src/common/geometry-validation.ts` and run from `validateState` and the dashboard readiness checklist.

### Surface Type Mapping

OpenMC does not support a generic `cylinder` type. The generator detects the principal axis from the direction vector:

```typescript
if (type === 'cylinder') {
  const { vx, vy, vz } = coeffs;
  // Determine axis from direction vector
  if (Math.abs(vx) >= Math.abs(vy) && Math.abs(vx) >= Math.abs(vz)) {
    return 'x-cylinder'; // coeffs: y0 z0 r
  } else if (Math.abs(vy) >= Math.abs(vx) && Math.abs(vy) >= Math.abs(vz)) {
    return 'y-cylinder'; // coeffs: x0 z0 r
  } else {
    return 'z-cylinder'; // coeffs: x0 y0 r
  }
}
```

### DAGMC Geometry Mode

When `state.settings.dagmcFile` is set, geometry.xml contains a single `dagmc_universe` element. How the `.h5m` file reaches the run directory depends on `settings.copyDagmcToRunDirectory`:

- **Copy mode** (`copyDagmcToRunDirectory: true`): the `.h5m` file is copied into the output directory as `geometry.h5m` and geometry.xml references that copy — the run directory is self-contained:

```xml
<geometry>
  <dagmc_universe filename="geometry.h5m" id="1" />
</geometry>
```

- **Reference mode** (default, unset/false): no copy is made; geometry.xml references the original `.h5m` via a path relative to the output directory, avoiding duplication of large files:

```xml
<geometry>
  <dagmc_universe filename="../geometry.h5m" id="1" />
</geometry>
```

If a relative path cannot be computed (e.g., different drive on Windows), the generator falls back to copying the file.

`settings.dagmcFile` / `dagmcInfo.filePath` and `settings.mgxsLibrary` may be project-relative paths. At XML generation time the backend resolves them against `XMLGenerationRequest.projectDirectory` first, then falls back to the output directory (`resolveDagmcSourcePath` / `resolveMgxsLibraryFile` in `src/node/xml-generation-service.ts`).

---

## settings.xml

Maps `OpenMCState.settings` → `<settings>`.

### State → XML Mapping

| State Field                        | XML Element                                 | Notes                                        |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `settings.run.mode`                | `<run_mode>`                                | `eigenvalue`, `fixed source`, `volume`       |
| `settings.run.particles`           | `<particles>`                               | Per generation (eigenvalue) or batch (fixed) |
| `settings.run.batches`             | `<batches>`                                 | Total batches                                |
| `settings.run.inactive`            | `<inactive>`                                | Only for eigenvalue                          |
| `settings.sources[]`               | `<source>`                                  | Spatial, energy, angle distributions         |
| `settings.seed`                    | `<seed>`                                    | Optional random seed                         |
| `settings.sourceRejectionFraction` | `<source_rejection_fraction>`               | Only if > 0                                  |
| `settings.photonTransport`         | `<photon_transport>true</photon_transport>` | Optional                                     |
| `settings.dagmcFile`               | `<dagmc>true</dagmc>`                       | Enables DAGMC mode                           |

### Runtime and advanced settings

| State Field(s)                                                       | XML element(s)                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `threads`, `mpi`                                                     | None — launch-only (`openmc -s N`, `mpirun -np N [--host ...]`)                                                         |
| `trace`                                                              | `<trace>batch generation particle</trace>`                                                                              |
| `keffTrigger`                                                        | `<keff_trigger><type/><threshold/></keff_trigger>`                                                                      |
| `confidenceIntervals`                                                | `<confidence_intervals>`                                                                                                |
| `temperature.default/method/tolerance/multipole`                     | Separate `<temperature_default>`, `<temperature_method>`, `<temperature_tolerance>`, `<temperature_multipole>` elements |
| `cutoff.energyNeutron/energyPhoton/time/timePhoton/weight/weightAvg` | `<cutoff>` with `energy_neutron`, `energy_photon`, `time_neutron`, `time_photon`, `weight`, `weight_avg`                |
| `resonanceScattering`                                                | `<resonance_scattering>` with `enable`, `method`, `energy_min`, `energy_max`                                            |
| `freeGasThreshold`                                                   | `<free_gas_threshold>`                                                                                                  |
| `sharedSecondaryBank`                                                | `<shared_secondary_bank>` (0.16.0+, probed)                                                                             |
| `surfaceGrazingCutoff/Ratio`                                         | `<surface_grazing_cutoff>` / `<surface_grazing_ratio>` (0.16.0+, probed)                                                |
| `maxParticleEvents`, `maxParticlesInFlight`, `maxSecondaries`        | `<max_particle_events>`, `<max_particles_in_flight>`, `<max_secondaries>`                                               |
| `maxHistorySplits`, `maxWriteLostParticles`                          | `<max_history_splits>`, `<max_write_lost_particles>` (`max_splits` is deprecated upstream)                              |
| `noReduce`, `stride`, `plotSeed`, `propertiesFile`, `verbosity`      | `<no_reduce>`, `<stride>`, `<plot_seed>`, `<properties_file>`, `<verbosity>`                                            |
| `materialCellOffsets`                                                | `<material_cell_offsets>`                                                                                               |
| `material.isotropic`                                                 | `<isotropic>nuclide ...</isotropic>` inside `<material>`                                                                |

`shared_secondary_bank` and the surface grazing cutoffs are disabled and warned about when the probed
`OpenMCCompat` reports an older environment. Python export emits the same `Settings` attributes; threads
and MPI stay out of the Python model because they are run-launch controls. The legacy variance-reduction
weight cutoff merges into the single `<cutoff>` block, with `settings.cutoff` taking precedence.

### Source Distributions

Spatial, energy, angle, time, and nested mixture children share the serializer
in `src/common/source-utils.ts`. Element names, attributes, and parameter
ordering match `openmc/stats/univariate.py`, `openmc/stats/multivariate.py`, and
`src/distribution*.cpp`:

| Spatial Type  | XML `type`    | Shape                                                               |
| ------------- | ------------- | ------------------------------------------------------------------- |
| `point`       | `point`       | `<parameters>x y z</parameters>`                                    |
| `box`         | `box`         | `<parameters>lx ly lz ux uy uz</parameters>`                        |
| `sphere`      | `spherical`   | origin + uniform `r`/`cos_theta`/`phi` (canonical convenience form) |
| `cylinder`    | `cylindrical` | origin + uniform `r`/`phi`/`z`; `r_dir`/`z_dir` for x/y axes        |
| `cartesian`   | `cartesian`   | `<x>`, `<y>`, `<z>` univariate elements                             |
| `cylindrical` | `cylindrical` | `r`/`phi`/`z` elements, origin, optional `r_dir`/`z_dir` attrs      |
| `spherical`   | `spherical`   | `r`/`cos_theta`/`phi` elements, `origin` attr                       |
| `pointcloud`  | `cloud`       | `<coords>` flattened x/y/z + optional `<strengths>`                 |
| `mesh`        | `mesh`        | `mesh_id`, `volume_normalized`, optional `<strengths>`              |

| Univariate Type  | XML `type`       | Shape                                                         |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| `discrete`       | `discrete`       | `<parameters>` values then probabilities (not interleaved)    |
| `uniform`        | `uniform`        | `parameters="a b"`                                            |
| `maxwell`        | `maxwell`        | `parameters="theta"` (eV, not kelvin)                         |
| `watt`           | `watt`           | `parameters="a b"`                                            |
| `normal`         | `normal`         | `parameters="mean std_dev"`                                   |
| `muir`           | `normal`         | `std_dev = sqrt(2 e0 kt / m_rat)` (no XML `muir` type)        |
| `powerlaw`       | `powerlaw`       | `parameters="a b n"`                                          |
| `tabular`        | `tabular`        | `interpolation` attr + `<parameters>` x values then densities |
| `mixture`        | `mixture`        | repeated `<pair probability="..."><dist .../></pair>`         |
| `decay-spectrum` | `decay_spectrum` | `volume` attr + `<nuclides>` + `<parameters>` densities       |

Angles are `isotropic`, `monodirectional` (`reference_uvw`), or `mu-phi`
(`reference_uvw`/`reference_vwu` plus `<mu>`/`<phi>`). Time uses the same
univariate serializer with element name `time`; `delta` is a one-point
discrete and imports back as `delta`. All time values are seconds.

Distribution bias mirrors `Univariate._append_bias_to_xml` /
`_append_array_bias_to_xml`: continuous distributions append a nested
`<bias type="...">` child, Discrete/Mixture append `<bias>p1 p2 ...</bias>`, an
isotropic angle appends `<bias type="mu-phi">`, and point-cloud/mesh spatial
distributions append a probability array. `Legendre` and decay-spectrum bias are
not emitted. Bias distributions may not carry their own bias; continuous bias
must match the parent support interval. Source bias is 0.16-only: when the
probed `OpenMCCompat.sourceBias` is false, XML generation strips the bias and
adds a warning, and model validation blocks the run. The OpenMC 0.16 XML
transport reader rejects point-cloud/mesh array bias even though the Python
serializer writes it; the editor labels that limitation rather than pretending
it applies in XML runs.

Source constraints are emitted after the distributions and remain orthogonal to
the distribution types. Mesh spatial meshes are emitted once into settings.xml
by `getSettingsMeshIds`, so tallies.xml skips them; source meshes are parsed
back into `state.meshes` on import.

**Boundaries.** `openmc.stats.Legendre` is not emitted or offered because
`to_xml_element()` raises `NotImplementedError`. Tabular `ignore_negative` is a
Python-only constructor flag and has no XML attribute, so the editor rejects
negative densities rather than silently exporting different semantics.
`decay-spectrum` is 0.16-only: XML generation drops the source with a warning on
environments whose `OpenMCCompat.decaySpectrum` probe is false.

Discrete XML uses OpenMC's native values-then-probabilities ordering. Older
NukeIDE builds wrote interleaved pairs; re-open the project file (the schema
normalizer preserves the state) rather than importing that legacy XML.

### Variance Reduction

| State Field                  | XML Element(s)                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `vr.survivalBiasing`         | `<survival_biasing>true</survival_biasing>`                                    |
| `vr.cutoff`                  | `<cutoff><weight>...</weight></cutoff>`                                        |
| `vr.ufs`                     | `<ufs_mesh>id</ufs_mesh>` plus the regular `<mesh>` (never `<ufs>`)            |
| `vr.weightWindows[]`         | one `<weight_windows id="...">` per set (mesh, particle, energy/bounds arrays) |
| `vr.weightWindowsOn`         | `<weight_windows_on>true/false</weight_windows_on>`                            |
| `vr.weightWindowsFile`       | `<weight_windows_file>path</weight_windows_file>`                              |
| `vr.weightWindowCheckpoints` | `<weight_window_checkpoints><collision/><surface/></...>`                      |
| `vr.weightWindowGenerator`   | `<weight_window_generators><weight_windows_generator>...`                      |

Scalar lower/upper bounds broadcast over `n_mesh_cells × n_energy_groups`;
explicit arrays are emitted verbatim. Every referenced mesh (sets, generator,
UFS) is emitted once into settings.xml, and `getSettingsMeshIds` keeps
tallies.xml from repeating it. `<weight_windows_on>` is emitted from the
resolved enable flag when sets, a file, or a generator are configured; OpenMC
enables weight windows automatically when sets or a file exist. The generator
resolves its mesh from `weightWindowGenerator.meshId`, the first set, then UFS.
UFS is emitted only with an explicit regular mesh. Xml import parses repeated
`<weight_windows>` blocks, uniform bound arrays (collapsed back to scalars),
the enable flag, file, checkpoints, and `<ufs_mesh>`.

---

## tallies.xml

Maps `OpenMCState.tallies` + `OpenMCState.meshes` → `<tallies>`. `OpenMCState.derivedTallies`
is analysis-only and is deliberately never mapped here (or in the Python exporter); it is evaluated
against a statepoint by `python/derive_tallies.py`. XML generation adds an explicit warning when
derived tallies exist, and the Python model script carries the same analysis-only comment.

### State → XML Mapping

| State Field                      | XML Element                                | Notes                                                                                |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `mesh.id` + `mesh.type`          | `<mesh id="..." type="..." name="...">`    | `regular`, `rectilinear`, `cylindrical`, `spherical`, `unstructured`                 |
| `mesh.dimension`                 | `<dimension>`                              | For regular meshes                                                                   |
| `mesh.lowerLeft` / `upperRight`  | `<lower_left>` / `<upper_right>`           | For regular meshes                                                                   |
| `mesh.xGrid` / `yGrid` / `zGrid` | `<x_grid>` / `<y_grid>` / `<z_grid>`       | Rectilinear meshes; validated for ≥2 finite, strictly increasing boundaries          |
| `mesh.filename`                  | `<filename>`                               | Unstructured meshes; absolute paths are rewritten relative to the run directory      |
| `mesh.library`                   | `library="..."`                            | Unstructured meshes (`moab`/`libmesh`); extension mismatch and missing files warn    |
| `mesh.lengthMultiplier`          | `length_multiplier="..."`                  | Unstructured meshes; omitted when 1 (OpenMC default)                                 |
| `mesh.options`                   | `options="..."`                            | Unstructured MOAB search-tree options                                                |
| `filter.meshTranslation`         | `translation="..."`                        | `mesh`/`meshsurface`/`meshborn`/`meshmaterial` filters; 0.15.3+                      |
| `filter.meshRotation`            | `rotation="..."`                           | `mesh`/`meshsurface`/`meshborn`; 0.16.0+ gated by `OpenMCCompat.meshFilterRotation`  |
| `tally.id` + `tally.name`        | `<tally id="..." name="...">`              | Name is optional                                                                     |
| `tally.filters[]`                | `<filter id="...">` + `<filters>` on tally | Filters are deduplicated across tallies (transform + pair attributes are in the key) |
| `tally.scores[]`                 | `<scores>`                                 | e.g., `flux`, `fission`, `absorption`                                                |
| `tally.nuclides[]`               | `<nuclides>`                               | `total` or specific nuclides                                                         |
| `tally.multiplyDensity`          | `multiply_density="false"`                 | Attribute written only when false (OpenMC default true)                              |
| `tally.higherMoments`            | `<higher_moments>true</higher_moments>`    | Extra statepoint moments                                                             |

### Filter Encoding

The additional filters follow `openmc/filter.py` exactly:

| Filter               | XML                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `materialfrom`       | `<filter type="materialfrom"><bins>` material IDs                                            |
| `cellinstance`       | `<bins>` flattened `cell instance cell instance …`; imported back into `pairs`               |
| `parentnuclide`      | `<bins>` nuclide names                                                                       |
| `meshborn`           | `<bins>` mesh ID plus optional `translation`/`rotation` (rotation 0.16+)                     |
| `meshmaterial`       | `mesh="ID"` attribute, `<bins>` flattened `element material …`, optional `translation`       |
| `collision`          | `<bins>` positive collision numbers                                                          |
| `reaction`           | `<bins>` canonical OpenMC reaction names; MT numbers normalize through `reaction-catalog.ts` |
| `particleproduction` | `<particles>` and optional `<energies>` (no `<bins>`); 0.16+                                 |
| `musurface`          | `<bins>` cosine boundaries in [-1, 1]                                                        |
| `weight`             | `<bins>` non-negative weight boundaries                                                      |

Pair filters keep their row order end-to-end: structured `pairs` → flattened `<bins>` → import
`pairs` + flattened `bins`. A trailing odd value is warned about, never silently dropped. Filter
deduplication includes pairs, particle types, production energies, reaction/nuclide names, and mesh
transforms so two tallies with different structured filters never share an element.

`reaction` and `particleproduction` are emitted only when `OpenMCCompat.reactionFilter` /
`particleProductionFilter` are true. Otherwise generation omits the filter element, drops it from the
tally's `<filters>` reference, and adds a warning naming the tally; the project keeps the configured
filter. The Python exporter mirrors this with an explanatory comment. During XML import the same
validation also rejects non-increasing weight/collision/mu-surface bins, unknown reactions, bad
cell-instance/mesh-material pairs, and mu-surface tallies without a surface filter + current score.

Random ray accepts only the upstream filter set: `cell`, `cellinstance`, `distribcell`, `energy`,
`material`, `mesh`, and `universe`; `validateState` reports any other filter in multi-group mode.

### Filter Deduplication

The generator creates a global filter pool to avoid duplicate filter definitions:

```typescript
const filterMap = new Map<string, { id: number; type: string; bins: number[] }>();
let nextFilterId = 1;

for (const tally of state.tallies) {
    for (const filter of tally.filters) {
        const key = this.getFilterKey(filter); // "type:bins"
        if (!filterMap.has(key)) {
            filterMap.set(key, { id: nextFilterId++, ... });
        }
    }
}
```

`MeshFilter` also supports `translation` (all supported releases) and `rotation` (0.16.0+), emitted as
space-separated attributes on mesh-based filter elements and imported back into `meshTranslation` /
`meshRotation`. Rotation is an intrinsic Tait-Bryan rotation (`Rz(psi) Ry(theta) Rx(phi)`); when
`OpenMCCompat.meshFilterRotation` is false the generator emits a warning and omits the attribute, and
the Python exporter mirrors this with an explanatory comment instead of emitting a setter that would
not exist. `MeshMaterialFilter` accepts translation only (upstream has no rotation attribute).

---

## Depletion, Triggers, Derivatives, Kinetics, CMFD

Depletion config persists in a custom `<depletion>` block in settings.xml (operator, solver, normalization, diff burnable mats,
independent-operator file inputs, `transfer_rates`/`fission_q` as escaped JSON, plus driver-only `substeps`,
`reactivity_control`, `external_source_rates`, `continue_from_results`, and `continue_timesteps`). OpenMC's own settings parser
ignores the block; the runner parses it in `checkDepletionEnabled` and builds `run_depletion.py` args from it — extend both in
lockstep. XML import parses the same block back through the shared `parseDepletionBlock` helper. Coupled is CE-only, MG depletion
is Independent-operator only, macroscopic materials never deplete. Whenever a driver-only field is active, XML generation adds a
warning that the standalone `openmc` binary does not apply it; the frontend surfaces that warning after generation.

Per-tally triggers serialize as `<trigger type threshold [scores] [ignore_zeros]/>` sub-elements (scores is a space-separated
**attribute**); settings.xml/codegen emit `<trigger><active>true</active>` automatically whenever any tally has triggers, with run-level
`batch_interval`/`max_batches` knobs in `settings.triggers`. Tally derivatives perturb a material only
(`density`/`nuclide_density`/`temperature`): top-level `<derivative id variable material [nuclide]/>` elements referenced by the owning
tally via `<derivative>ID</derivative>`. Kinetics (IFP) auto-appends the three IFP tallies plus `<ifp_n_generation>` on export and
re-derives `settings.kinetics` on import (idempotent). CMFD is C-API-only with no settings.xml element: export emits
`openmc.cmfd.CMFDMesh`/`CMFDRun` assignments (pure `generateCmfdCodeLines`), and runs route to `run_cmfd.py`; depletion wins when both
are configured.

Shutdown dose (R2S/D1S) is driver-only and emits nothing to settings.xml or tallies.xml: the persisted `state.shutdownDose`
configuration travels as JSON to `run_r2s.py` / `run_d1s.py`. The only model-side field it depends on is `cell.volume`, which
serializes as `<cell volume="...">` and imports back. See [Shutdown Dose](shutdown-dose.md).

---

## plots.xml

Maps `OpenMCState.plots` → `<plots>`. Generated only when `request.files.plots` is true and `state.plots` is non-empty.

| State Field             | XML Element                                 | Notes                                 |
| ----------------------- | ------------------------------------------- | ------------------------------------- |
| `plot.id` + `plot.name` | `<plot id="..." name="...">`                |                                       |
| `plot.type`             | `type="..."`                                | `slice`, `voxel`                      |
| `plot.origin`           | `<origin>`                                  | Center point                          |
| `plot.width`            | `<width>`                                   | Plot dimensions                       |
| `plot.pixels`           | `<pixels>`                                  | Resolution                            |
| `plot.colorBy`          | `color_by="..."`                            | `cell`, `material`                    |
| `plot.basis`            | `basis="..."`                               | `xy`, `xz`, `yz`                      |
| `plot.background`       | `<background>r g b</background>`            | Slice and ray-traced plots            |
| `plot.mask`             | `<mask components="..." background="..."/>` | Visible selection → hidden complement |
| `plot.showOverlaps`     | `<show_overlaps>true</show_overlaps>`       | Slice plots only                      |
| `plot.overlapColor`     | `<overlap_color>r g b</overlap_color>`      | Only emitted with `showOverlaps`      |

OpenMC's Python API exposes background/mask on all plot classes, but voxel output stores raw
cell/material IDs and never applies display colors; C++ ray-traced rendering consumes background and
mask colors, while only `SlicePlotBase` performs overlap detection. The generator, importer, Python
exporter, and UI follow that support matrix so the UI never promises an effect the renderer ignores.
Import warns about unsupported fields (for example a voxel `<background>`), missing mask domains, and
`<overlap_color>` without `<show_overlaps>`.

`OpenMCPlotConfig.mask.components` is the **visible** domain selection shown in the UI. OpenMC does
the inverse: it paints every ID listed in `<mask components>` with the mask background and leaves the
rest visible (`src/plot.cpp::set_mask`). Generation therefore emits the complement of the existing
selected domains, and import inverts the XML list back into the visible selection. An empty visible
selection, or one that selects every domain, writes no mask because it would not change the image.

---

## XML Import

OpenMC Studio can parse existing OpenMC XML files back into `OpenMCState`. This is implemented in [`OpenMCStudioBackendServiceImpl.importXML()`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/openmc-studio/src/node/openmc-studio-backend-service.ts).

### Import Pipeline

```
Directory containing XML files
    │
    ├── materials.xml ──→ parseMaterialsXML() ──→ state.materials
    ├── geometry.xml ───→ parseGeometryXML() ───→ state.geometry
    ├── settings.xml ───→ parseSettingsXML() ───→ state.settings
    └── (tallies.xml) ──→ (not yet implemented)
```

### Parser Details

The import uses `xml2js` with `explicitArray: false`:

```typescript
const xml2js = await import('xml2js');
const parser = new xml2js.Parser({ explicitArray: false });
const result = await parser.parseStringPromise(xml);
```

**Materials parsing** extracts:

- `id`, `name`, `density` + `units`
- Nuclides with `ao`/`wo` fraction type detection
- S(α,β) entries
- Temperature attribute

**Geometry parsing** handles:

- Both attribute-based (`$.material`) and child-element (`cell.material`) formats
- Surface coefficients parsed into structured objects by type
- Surface `boundary`, `albedo`, and `periodic_surface_id`
- Cell `rotation`, `translation`, `density`, and `volume`
- `<lattice>` and `<hex_lattice>` definitions, including `outer`, `name`, `orientation`, and `n_axial`
- Fill classification: a `fill` ID that matches a parsed lattice becomes `fillType: 'lattice'`, otherwise `fillType: 'universe'`
- Universe assignment from `$.universe` (defaults to root universe `0`), plus universe entries for every lattice-referenced and outer universe
- Warnings for unsupported input (for example a 9-element rotation matrix, which cannot be represented as Tait-Bryan angles)

**Settings parsing** extracts:

- Run mode, particles, batches, inactive
- Source spatial/energy distributions
- Seed, temperature, cutoff, photon transport

---

## Round-Trip Considerations

Full round-trip (state → XML → state) is **lossy** by design. The following are not preserved:

| What                | Status                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Material colors     | Not in OpenMC XML — UI-only                                                                     |
| Cell region trees   | Converted to `regionString` — tree structure lost                                               |
| Lattice definitions | Full round-trip: `<lattice>` / `<hex_lattice>`, transforms, periodic pairs, albedo              |
| Tally filters       | Reconstructed but IDs reassigned                                                                |
| Mesh IDs            | Preserved if matching                                                                           |
| Plot definitions    | Appearance fields round-trip; meshline details collapse to a boolean                            |
| Project metadata    | Not in OpenMC XML — use `.nuke-openmc` projects                                                 |
| Depletion settings  | Custom `<depletion>` block in settings.xml; parsed back by the runner (`checkDepletionEnabled`) |
| Variance reduction  | Partially written; not parsed back                                                              |

**Best practice:** Use `.nuke-openmc` project files for persistent storage. Use XML generation only for running OpenMC.

---

## Frontend Usage

### Generate XML from Widget

```typescript
// Inside a widget
@inject(OpenMCXMLGenerationService)
protected readonly xmlService!: OpenMCXMLGenerationService;

async generateXML(outputDir: string): Promise<void> {
    const state = this.stateManager.getState();
    const result = await this.xmlService.generateXML(state, outputDir, {
        geometry: true,
        materials: true,
        settings: true,
        tallies: true,
        plots: false
    });

    if (result.success) {
        this.messageService.info(`Generated ${result.generatedFiles.length} files`);
    }
}
```

### Import XML from Directory

```typescript
async importXML(directory: string): Promise<void> {
    const result = await this.xmlService.importXML({ directory });

    if (result.success && result.state) {
        this.stateManager.setState(result.state);
        this.messageService.info('Project imported from XML');
    } else {
        this.messageService.error(result.errors?.join(', ') || 'Import failed');
    }
}
```

---

## Summary

| XML File        | Generator Method         | Parser Method         | Completeness       |
| --------------- | ------------------------ | --------------------- | ------------------ |
| `materials.xml` | `generateMaterialsXML()` | `parseMaterialsXML()` | Full               |
| `geometry.xml`  | `generateGeometryXML()`  | `parseGeometryXML()`  | Full (CSG + DAGMC) |
| `settings.xml`  | `generateSettingsXML()`  | `parseSettingsXML()`  | Full               |
| `tallies.xml`   | `generateTalliesXML()`   | Not implemented       | Generation only    |
| `plots.xml`     | `generatePlotsXML()`     | `parsePlotsXML()`     | Full (appearance)  |
