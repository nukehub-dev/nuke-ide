# CAD Import

OpenMC Studio can import CAD geometry and convert it into forms usable by OpenMC. This enables you to bring in models from engineering design tools rather than building everything from CSG primitives.

---

## Supported Formats

| Format | Extensions | Notes |
|--------|------------|-------|
| **STEP** | `.step`, `.stp` | Industry-standard CAD exchange; recommended for solid models |
| **IGES** | `.igs`, `.iges` | Older standard; surfaces may need healing on import |
| **BREP** | `.brep` | OpenCASCADE native boundary representation; preserves topology well |
| **STL** | `.stl` | Tessellated surface mesh; no CAD history, but widely supported |

> **Tip:** For best results, use STEP or BREP. IGES files occasionally lose face associations during translation, and STL files contain no volume metadata.

---

## Faceting Tolerance Preferences

When converting CAD to DAGMC, the **faceting tolerance** controls how finely curved surfaces are tessellated into triangles. You can customize the default behavior in **Settings** (`File → Preferences → Extensions → OpenMC Studio`):

| Setting | ID | Default | Description |
|---------|-----|---------|-------------|
| **Default Faceting Tolerance** | `openmcStudio.defaultFacetingTolerance` | `0.001` cm | Base tolerance for all CAD→DAGMC conversions |
| **Auto-Adjust Tolerance** | `openmcStudio.autoAdjustFacetingTolerance` | `true` | Automatically increase tolerance for very large models (diagonal > 100 cm) |

### How Auto-Adjustment Works

When enabled, the importer checks the model's bounding-box diagonal. If the diagonal exceeds 100 cm and the tolerance is smaller than `diagonal / 500`, the tolerance is raised to `diagonal / 500`. This prevents unreasonably dense meshes on large models (e.g., tokamaks, reactor vessels) without manual intervention.

To disable auto-adjustment for a specific import, uncheck the setting above or pass `--no-auto-adjust-tol` via the CLI.

---

## Importing a CAD File

### Method 1: File Dialog

1. Go to `File → Import → CAD Geometry`.
2. Select a file with one of the supported extensions.
3. The **CAD Import Wizard** opens.

### Method 2: Drag and Drop

Drag a CAD file from your file manager directly into the OpenMC Studio window.

---

## The CAD → CSG Conversion Pipeline

The import process runs through several stages. You can monitor progress in the **CAD Import** output channel.

### Stage 1: Geometry Loading

The file is parsed using OpenCASCADE and Gmsh. The importer extracts:

- Solid volumes
- Bounding faces and edges
- Surface types (planar, cylindrical, spherical, toroidal, etc.)

During this stage a loading overlay with a progress spinner is shown for large files.

### Stage 2: Surface Recognition

Each face is analyzed and mapped to an OpenMC surface type where possible:

| CAD Surface | OpenMC Surface | Fidelity |
|-------------|----------------|----------|
| Plane | `Plane` | Exact |
| Cylinder | `XCylinder`, `YCylinder`, `ZCylinder` | Exact |
| Sphere | `Sphere` | Exact |
| Cone | `Cone` | Exact |
| Torus | `Torus` | Exact |
| Spline / NURBS | `Surface` (DAGMC) or approximated | Approximate; may require DAGMC |

### Stage 3: Volume Assembly

Recognized surfaces are combined into cell definitions. The importer attempts to:

1. Build closed regions from face loops.
2. Assign surface half-spaces to form CSG cell expressions.
3. Detect imprints and merged faces between adjacent volumes.

### Stage 4: Validation

A quick check ensures:

- All cells are bounded (no leaks to infinity).
- No overlapping regions at the tolerance level.
- Surface normals are consistent.

---

## Viewing Imported Geometry

After import, the geometry appears in the **CSG Builder** and **3D Viewer**.

### What You See

- **Wireframe overlay:** Original CAD edges shown in gray for reference.
- **CSG cells:** Colored by material or by volume ID.
- **Unmapped regions:** Highlighted in red if a face could not be translated.

### Navigation

Use the same controls as the base 3D viewer: rotate, pan, zoom, clipping planes.

---

## Editing Imported Volumes

Imported geometry is not locked. You can modify it like native CSG.

### Common Edits

| Action | How To |
|--------|--------|
| **Rename a cell** | Right-click the cell in the hierarchy tree → **Rename** |
| **Delete a volume** | Select the cell → press `Delete` or right-click → **Remove Cell** |
| **Adjust a surface** | Click the surface in the cell details → edit coefficients |
| **Add a bounding surface** | If the model is unbounded, add a large spherical or box surface and union it into the root cell |

### Re-importing

If you change the source CAD file externally:

1. Right-click the imported root node.
2. Choose **"Re-import from Source"**.
3. Your material assignments and cell renames are preserved where topology matches.

---

## Assigning Materials to Imported Regions

After conversion, all cells start with a **void** fill.

### Quick Assignment

1. In the **CSG Builder** tree, click a cell.
2. In the detail panel, open the **Material** dropdown.
3. Select an existing material or click **"Create New Material"**.

### Bulk Assignment

1. Select multiple cells with `Ctrl+Click` or `Shift+Click`.
2. Right-click → **"Assign Material to Selection"**.
3. Choose the material.

### Mapping by Name

If your CAD file contains volume names or colors from the source tool:

1. Use the **Auto-Material Map** feature in the Simulation Dashboard after import.
2. Match CAD volume names or colors to materials in your project.
3. Click **"Apply Mapping"**.

---

## Current Limitations and Known Issues

The CAD import pipeline is under active development. The following limitations apply:

### CAD → CSG Conversion

| Limitation | Details | Workaround |
|------------|---------|------------|
| **NURBS / spline surfaces** | Cannot be represented exactly as OpenMC CSG surfaces | Use DAGMC workflow instead; or approximate with planes/cylinders |
| **Complex assemblies** | Large assemblies with hundreds of parts may timeout during translation | Import sub-assemblies individually; merge manually |
| **Tolerance sensitivity** | Small gaps or slivers in CAD cause cell leaks | Heal the CAD in a dedicated tool (e.g., FreeCAD, CAD Assistant) before import |
| **No parameter history** | Parametric features (fillets, chamfers, patterns) are lost on import | Re-apply features in OpenMC Studio if needed |

### DAGMC Path

For models that cannot be expressed in pure CSG, OpenMC Studio supports DAGMC `.h5m` files. The CAD import widget offers a **"Export to DAGMC"** button that routes the model through the MOAB pipeline instead of CSG conversion.

### Surface Support Matrix

| CAD Surface | OpenMC Surface | Fidelity | Notes |
|-------------|----------------|----------|-------|
| Plane | `Plane`, `XPlane`, `YPlane`, `ZPlane` | Exact | Always exact |
| Sphere | `Sphere` | Exact | Always exact |
| Cylinder | `XCylinder`, `YCylinder`, `ZCylinder`, `Cylinder` | Exact | Axis-aligned or general |
| Cone | `XCone`, `YCone`, `ZCone` | Exact | Axis-aligned only |
| Torus | `XTorus`, `YTorus`, `ZTorus` | Exact | Axis-aligned only |
| General quadric | `Quadric` | Exact | 10-coefficient fallback |
| NURBS / B-Spline / Bezier | DAGMC `.h5m` | Exact | Auto-converted to faceted geometry via native `pymoab` writer |
| Spline (other) | DAGMC `.h5m` | Exact | Auto-converted to faceted geometry via native `pymoab` writer |

### NURBS Auto-Fallback

When the importer detects NURBS, B-Spline, or Bezier surfaces that cannot be expressed as OpenMC CSG primitives, it **automatically converts the model to DAGMC `.h5m` format** instead of failing or producing poor approximations. You will see a notification in the CAD Import output channel when this happens.

The DAGMC conversion uses a **native H5M writer** built on `pymoab` and `h5py`. This writer handles:

- Triangle mesh extraction from Gmsh
- Automatic quadrilateral splitting
- Full DAGMC tagging (`CATEGORY`, `GEOM_DIMENSION`, `GEOM_SENSE_2`, `GLOBAL_ID`, `NAME`, material groups)
- Graceful handling of empty element lists

To override the automatic behavior:

| Override | Effect |
|----------|--------|
| `--force-csg` | Force CSG conversion even if NURBS are present (analytic faces become CSG; NURBS faces are skipped with warnings) |
| `--force-dagmc` | Force DAGMC output even for purely analytic models |

### Advanced Topology

The converter analyzes multi-solid assemblies and:

- Detects shared faces between adjacent volumes
- Merges coincident coplanar surfaces to reduce CSG complexity
- Preserves solid boundaries for closed-cell validation


---

## Tips

- **Clean CAD first:** Remove small fillets, unnecessary detail, and internal voids before import. Simpler CAD converts faster and more accurately.
- **Check units:** OpenMC expects centimeters. Verify that your CAD model is not in millimeters or inches.
- **Validate after import:** Always run `Validate Model` (`Tools → OpenMC Studio → Simulation → Validate Model`) after importing CAD.
- **Save early:** Importing large CAD files can take several minutes. Save the project immediately after a successful import.
- **Tune faceting tolerance:** For very large models, consider disabling auto-adjustment and setting a custom tolerance if you need higher fidelity.
