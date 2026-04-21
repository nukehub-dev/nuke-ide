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

## Importing a CAD File

### Method 1: File Dialog

1. Go to `File → Import → CAD Geometry`.
2. Select a file with one of the supported extensions.
3. The **CAD Import Wizard** opens.

### Method 2: Explorer

Right-click a CAD file in the Explorer and choose **"Import as OpenMC Geometry"**.

### Method 3: Drag and Drop

Drag a CAD file from your file manager directly into the OpenMC Studio window.

---

## The CAD → CSG Conversion Pipeline

The import process runs through several stages. You can monitor progress in the **CAD Import** output channel.

### Stage 1: Geometry Loading

The file is parsed using OpenCASCADE. The importer extracts:

- Solid volumes
- Bounding faces and edges
- Surface types (planar, cylindrical, spherical, toroidal, etc.)

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
| **Adjust a surface** | Double-click the surface in the cell details → edit coefficients |
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

### Placeholder Directory

> **Note:** The internal `python/cad_conversion/` directory is currently a placeholder. Full automated CAD-to-CSG translation for arbitrary NURBS and advanced topological operations is not yet implemented. STEP/IGES/BREP imports work for models composed of analytic surfaces (planes, cylinders, spheres, cones, tori). For everything else, use the DAGMC export path or build CSG manually.

---

## Tips

- **Clean CAD first:** Remove small fillets, unnecessary detail, and internal voids before import. Simpler CAD converts faster and more accurately.
- **Check units:** OpenMC expects centimeters. Verify that your CAD model is not in millimeters or inches.
- **Validate after import:** Always run `Validate Model` (`Tools → OpenMC Studio → Simulation → Validate Model`) after importing CAD.
- **Save early:** Importing large CAD files can take several minutes. Save the project immediately after a successful import.
