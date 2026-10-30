# CAD Import

OpenMC Studio can bring CAD models into an OpenMC project and convert them into simulation geometry. The import is a single **Import CAD** action in the CSG Builder or DAGMC Editor — there is no separate import wizard, drop target, or conversion-options dialog.

---

## Supported Formats

| Format    | Extensions      | Notes                                                               |
| --------- | --------------- | ------------------------------------------------------------------- |
| **STEP**  | `.step`, `.stp` | Industry-standard CAD exchange; recommended for solid models        |
| **IGES**  | `.igs`, `.iges` | Older standard; surfaces may need healing before import             |
| **BREP**  | `.brep`         | OpenCASCADE native boundary representation; preserves topology well |
| **STL**   | `.stl`          | Tessellated surface mesh; no CAD history, but widely supported      |
| **DAGMC** | `.h5m`          | Loaded directly as faceted geometry; no CAD conversion is performed |

> **Tip:** For CAD conversion, STEP or BREP usually gives the most reliable result. IGES files occasionally lose face associations during translation, and STL files contain no volume metadata.

---

## Importing a CAD File

### From the CSG Builder

1. Open the CSG Builder (`Tools → OpenMC Studio → Geometry → CSG Builder`, `OpenMC/View: Open CSG Builder`, or the dashboard's **Edit in CSG Builder** shortcut).
2. Click **"Import CAD"** in the header.
3. Select a supported STEP/IGES/BREP/STL or DAGMC file.

### From the DAGMC Editor

1. Open the DAGMC Editor (`Tools → OpenMC Studio → Geometry → DAGMC Editor` or `OpenMC/View: Open DAGMC Editor`).
2. Click **"Import CAD"** in the header. With no file loaded, the empty state also offers **"Import CAD/DAGMC File"**.

Both entry points run the same backend conversion. If gmsh or OpenCASCADE is not available, the editor warns and suggests installing `python-gmsh` (conda) or `gmsh` (pip).

### What Happens Next

1. A loading overlay reports that the CAD file is being imported.
2. The backend analyzes the model. Free-form/NURBS surfaces are routed to a DAGMC `.h5m` conversion; models made only of analytic faces can add CSG surfaces and cells instead.
3. For a DAGMC conversion, the generated `.h5m` is written into the project directory when the project has been saved, otherwise next to the source CAD file. It uses the source base name (for example `pump.step` → `pump.h5m`).
4. For DAGMC, the project's `dagmcFile` and `dagmcInfo` are updated, so XML generation and the runner use the imported geometry immediately. For a CSG import, the converted surfaces and cells are added to the current geometry.
5. The DAGMC Editor loads the new mesh, or the CSG Builder switches to the imported surfaces. The CSG Builder surfaces the first few import warnings as toast messages; the full set is written to the console.

For a `.h5m` input, the file is loaded as-is rather than converted.

---

## Faceting Tolerance

CAD-to-DAGMC conversion tessellates curved surfaces into triangles. The tolerance is read from two OpenMC Studio preferences:

| Setting                        | ID                                         | Default  | Description                                            |
| ------------------------------ | ------------------------------------------ | -------- | ------------------------------------------------------ |
| **Default Faceting Tolerance** | `openmcStudio.defaultFacetingTolerance`    | `1.0` cm | Base tolerance for CAD-to-DAGMC conversions            |
| **Auto-Adjust Tolerance**      | `openmcStudio.autoAdjustFacetingTolerance` | `true`   | Increase tolerance automatically for very large models |

There is no per-import tolerance field. Change the preference before importing, or use the DAGMC Editor's **Faceting** tab to re-mesh an existing file.

### How Auto-Adjustment Works

When enabled, the converter checks the model's bounding-box diagonal. If the diagonal is greater than 100 cm **and** the configured tolerance is below 1.0 cm, the tolerance is raised to `diagonal / 200`, capped at 10 cm. A tolerance already at or above 1.0 cm is left unchanged. This keeps very large assemblies (for example reactor vessels) from producing unreasonably dense meshes.

---

## Units

The import action always converts with **centimeters** and a scale factor of **1.0**; there is no unit selector. OpenMC expects centimeter geometry, so scale or convert a model authored in millimeters, inches, or meters before importing.

---

## Graveyard Handling

DAGMC conversion adds a `mat:graveyard` bounding volume when the source does not already provide one. The converter checks CAD product names and volume/bounding-box heuristics, and re-tags an existing enclosing volume when it finds one. Without a graveyard volume, OpenMC cannot terminate particles that escape the model.

The DAGMC Editor also detects a missing graveyard after loading and offers **Create Graveyard Box** or **Tag existing volume N** in the Groups tab.

---

## After Import

### Assign Materials

A freshly converted DAGMC model does not know your project material library. Use the DAGMC Editor's **Overrides** tab to:

- Replace a DAGMC material tag with a project material.
- Assign or remove a material per volume.
- Enable automatic geometry/material ID conflict resolution.
- Run **Sync for Depletion** when per-cell burnup tracking needs explicit material assignments.

For analytic CSG imports, set each imported cell's fill material in the CSG Builder's cell editor.

### Validate and Run

Run `Tools → OpenMC Studio → Simulation → Validate Model` (or `OpenMC/Simulation: Validate Model`) after import, then generate XML and run as usual. The dashboard's geometry summary identifies the active DAGMC file.

### Re-Facet an Imported Model

To change the mesh resolution later, open the DAGMC Editor's **Faceting** tab:

1. Select the original STEP or IGES source (the editor can auto-detect a CAD file beside the `.h5m`).
2. Choose a tolerance preset — **Draft** (1.0 cm), **Standard** (0.5 cm), **Fine** (0.1 cm), or **Ultra** (0.01 cm) — or use the slider.
3. Optionally enable **Imprint & merge shared surfaces**.
4. Click **Generate Re-faceted H5M**.

The new file gets a `_refaceted` suffix and can be loaded immediately. Materials and the graveyard are preserved where the topology allows.

---

## Limitations

| Limitation                       | Details                                                                                      | Workaround                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **NURBS / free-form surfaces**   | Cannot be represented exactly as OpenMC CSG surfaces                                         | The importer converts them to DAGMC automatically             |
| **No import options UI**         | Units, scale, graveyard creation, and tolerance are not exposed per import                   | Set the faceting preferences, or re-facet in the DAGMC Editor |
| **No re-import merge**           | Re-importing a changed CAD file does not merge material assignments from the previous import | Reassign materials in the DAGMC Editor after importing        |
| **No geometry editing in DAGMC** | The DAGMC Editor edits material tags, groups, and overrides — not the underlying triangles   | Edit the CAD source and re-facet, or rebuild the model        |
| **Tolerance sensitivity**        | Small gaps or slivers in CAD can produce leaks                                               | Heal the CAD in a dedicated tool before import                |
| **No parameter history**         | Parametric features (fillets, chamfers, patterns) are lost on import                         | Re-apply features in the CAD tool before conversion           |

---

## Tips

- **Clean CAD first:** Remove small fillets, unnecessary detail, and internal voids before import. Simpler CAD converts faster and more accurately.
- **Check units:** The importer assumes the CAD coordinates are in centimeters.
- **Save first:** When a project is saved, the generated `.h5m` lands beside it; otherwise it lands beside the source file.
- **Validate after import:** Run **Validate Model** before the first simulation to catch unbounded or overlapping geometry.
- **Tune faceting:** Lower the default tolerance for finer meshes, or use the DAGMC Editor's Faceting tab for a one-off re-mesh.
