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

| File | Role |
|------|------|
| [`src/browser/xml-generator/xml-generation-service.ts`](../../src/browser/xml-generator/xml-generation-service.ts) | Frontend service: validates, formats request, shows toast messages |
| [`src/node/xml-generation-service.ts`](../../src/node/xml-generation-service.ts) | Backend service: generates XML strings from `OpenMCState` |
| [`src/common/openmc-studio-protocol.ts`](../../src/common/openmc-studio-protocol.ts) | `XMLGenerationRequest`, `XMLGenerationResult`, `XMLImportRequest` types |

---

## materials.xml

Maps `OpenMCState.materials` → `<materials>`.

### State → XML Mapping

| State Field | XML Element | Notes |
|-------------|-------------|-------|
| `material.id` | `<material id="...">` | Required |
| `material.name` | `<material name="...">` | Escaped for XML |
| `material.density` + `densityUnit` | `<density units="..." value="..."/>` | `g/cm3`, `atom/b-cm`, etc. |
| `material.nuclides[]` | `<nuclide name="..." ao="..."/>` | `ao` or `wo` based on `fractionType` |
| `material.thermalScattering[]` | `<sab name="..."/>` | S(α,β) thermal scattering data |
| `material.isDepletable` | `depletable="true"` | Attribute on `<material>` |
| `material.volume` | `volume="..."` | Attribute on `<material>` |
| `material.temperature` | `temperature="..."` | Attribute on `<material>` |

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

| State Field | XML Element | Notes |
|-------------|-------------|-------|
| `surface.id` | `<surface id="...">` | Required |
| `surface.type` | `type="..."` | `sphere`, `x-cylinder`, `z-plane`, etc. |
| `surface.coefficients` | `coeffs="..."` | Formatted per surface type |
| `surface.boundary` | `boundary="..."` | `vacuum`, `reflective`, `transmission` |
| `cell.id` | `<cell id="...">` | Required |
| `cell.fillType` + `fillId` | `material="..."` or `fill="..."` | Material ID, universe ID, or void |
| `cell.regionString` | `region="..."` | CSG boolean expression |
| `cell.universe` | `universe="..."` | Defaults to `0` (root) |
| `lattice.id` | `<!-- placeholder -->` | Lattices are stubbed (full impl TODO) |

### Surface Type Mapping

OpenMC does not support a generic `cylinder` type. The generator detects the principal axis from the direction vector:

```typescript
if (type === 'cylinder') {
    const { vx, vy, vz } = coeffs;
    // Determine axis from direction vector
    if (Math.abs(vx) >= Math.abs(vy) && Math.abs(vx) >= Math.abs(vz)) {
        return 'x-cylinder';  // coeffs: y0 z0 r
    } else if (Math.abs(vy) >= Math.abs(vx) && Math.abs(vy) >= Math.abs(vz)) {
        return 'y-cylinder';  // coeffs: x0 z0 r
    } else {
        return 'z-cylinder';  // coeffs: x0 y0 r
    }
}
```

### DAGMC Geometry Mode

When `state.settings.dagmcFile` is set, geometry.xml contains a single `dagmc_universe` element:

```xml
<geometry>
  <dagmc_universe filename="geometry.h5m" id="1" />
</geometry>
```

The DAGMC `.h5m` file is also copied to the output directory as `geometry.h5m`.

---

## settings.xml

Maps `OpenMCState.settings` → `<settings>`.

### State → XML Mapping

| State Field | XML Element | Notes |
|-------------|-------------|-------|
| `settings.run.mode` | `<run_mode>` | `eigenvalue`, `fixed source`, `volume` |
| `settings.run.particles` | `<particles>` | Per generation (eigenvalue) or batch (fixed) |
| `settings.run.batches` | `<batches>` | Total batches |
| `settings.run.inactive` | `<inactive>` | Only for eigenvalue |
| `settings.sources[]` | `<source>` | Spatial, energy, angle distributions |
| `settings.seed` | `<seed>` | Optional random seed |
| `settings.sourceRejectionFraction` | `<source_rejection_fraction>` | Only if > 0 |
| `settings.photonTransport` | `<photon_transport>true</photon_transport>` | Optional |
| `settings.dagmcFile` | `<dagmc>true</dagmc>` | Enables DAGMC mode |

### Source Distributions

| Spatial Type | XML `type` | Parameters |
|--------------|-----------|------------|
| `point` | `point` | `origin: [x, y, z]` |
| `box` | `box` | `lowerLeft`, `upperRight` |
| `sphere` | `spherical` | `center`, `radius` |
| `cylinder` | `cylindrical` | `center`, `radius`, `height` |

| Energy Type | XML `type` | Parameters |
|-------------|-----------|------------|
| `discrete` | `discrete` | `energies[]` |
| `uniform` | `uniform` | `min`, `max` |
| `maxwell` | `maxwell` | `temperature` |
| `watt` | `watt` | `a`, `b` |

### Variance Reduction

| State Field | XML Element |
|-------------|-------------|
| `vr.survivalBiasing` | `<survival_biasing>true</survival_biasing>` |
| `vr.cutoff` | `<cutoff><weight>...</weight></cutoff>` |
| `vr.weightWindowGenerator` | `<weight_window_generator>` |
| `vr.weightWindows` | `<weight_windows id="1">` |
| `vr.ufs` | `<ufs><mesh>...</mesh></ufs>` |

---

## tallies.xml

Maps `OpenMCState.tallies` + `OpenMCState.meshes` → `<tallies>`.

### State → XML Mapping

| State Field | XML Element | Notes |
|-------------|-------------|-------|
| `mesh.id` + `mesh.type` | `<mesh id="..." type="...">` | `regular`, `cylindrical`, `spherical` |
| `mesh.dimension` | `<dimension>` | For regular meshes |
| `mesh.lowerLeft` / `upperRight` | `<lower_left>` / `<upper_right>` | For regular meshes |
| `tally.id` + `tally.name` | `<tally id="..." name="...">` | Name is optional |
| `tally.filters[]` | `<filter id="...">` + `<filters>` on tally | Filters are deduplicated across tallies |
| `tally.scores[]` | `<scores>` | e.g., `flux`, `fission`, `absorption` |
| `tally.nuclides[]` | `<nuclides>` | `total` or specific nuclides |

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

---

## plots.xml

Maps `OpenMCState.plots` → `<plots>`. Generated only when `request.files.plots` is true and `state.plots` is non-empty.

| State Field | XML Element | Notes |
|-------------|-------------|-------|
| `plot.id` + `plot.name` | `<plot id="..." name="...">` | |
| `plot.type` | `type="..."` | `slice`, `voxel` |
| `plot.origin` | `<origin>` | Center point |
| `plot.width` | `<width>` | Plot dimensions |
| `plot.pixels` | `<pixels>` | Resolution |
| `plot.colorBy` | `color_by="..."` | `cell`, `material` |
| `plot.basis` | `basis="..."` | `xy`, `xz`, `yz` |

---

## XML Import

OpenMC Studio can parse existing OpenMC XML files back into `OpenMCState`. This is implemented in [`OpenMCStudioBackendServiceImpl.importXML()`](../../src/node/openmc-studio-backend-service.ts).

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
- Universe assignment from `$.universe` (defaults to root universe `0`)
- Root universe auto-created with ID `0`

**Settings parsing** extracts:
- Run mode, particles, batches, inactive
- Source spatial/energy distributions
- Seed, temperature, cutoff, photon transport

---

## Round-Trip Considerations

Full round-trip (state → XML → state) is **lossy** by design. The following are not preserved:

| What | Status |
|------|--------|
| Material colors | Not in OpenMC XML — UI-only |
| Cell region trees | Converted to `regionString` — tree structure lost |
| Lattice definitions | Generation is stubbed; import not implemented |
| Tally filters | Reconstructed but IDs reassigned |
| Mesh IDs | Preserved if matching |
| Plot definitions | Import not implemented |
| Project metadata | Not in OpenMC XML — use `.nuke-openmc` projects |
| Depletion settings | Written as comments only; not parsed back |
| Variance reduction | Partially written; not parsed back |

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

| XML File | Generator Method | Parser Method | Completeness |
|----------|-----------------|---------------|--------------|
| `materials.xml` | `generateMaterialsXML()` | `parseMaterialsXML()` | Full |
| `geometry.xml` | `generateGeometryXML()` | `parseGeometryXML()` | Full (CSG + DAGMC) |
| `settings.xml` | `generateSettingsXML()` | `parseSettingsXML()` | Full |
| `tallies.xml` | `generateTalliesXML()` | Not implemented | Generation only |
| `plots.xml` | `generatePlotsXML()` | Not implemented | Generation only |
