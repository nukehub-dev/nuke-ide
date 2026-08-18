# Getting started with Nuke CAD

Nuke CAD is a script-first parametric CAD extension. Your geometry source of
truth is a Python script using **build123d** or **CadQuery**.

## Quick start

### From a script

1. Create a new file `model.py` in your workspace.
2. Write a build123d model and assign it to a top-level variable called `model`:

```python
from build123d import *

model = Box(10, 10, 10) - Cylinder(3, 10)
```

3. Right-click `model.py` and choose **Open in CAD Viewport**, or run the
   **CAD Viewport** command from the Nuke Tools sidebar. (Double-clicking a
   `.py` file opens the text editor, not the viewport — use **Open With…** to
   pick the CAD Viewport.)
4. The geometry service builds a STEP file and a triangle stream beside your
   script (`model.step`, `model.tess.json`) and renders them in the viewport.
   Saving the script automatically triggers a rebuild; build failures appear
   in a dismissible error banner at the top of the viewport.

### From a STEP file

1. Double-click any `.step`, `.stp`, or `.brep` file in the Explorer — it opens
   in nuke-cad by default.
2. Or open the **CAD Viewport** and click **Open CAD Model...** to browse for a
   `.py` script or `.step` / `.stp` file.
3. The file is read through OCP, tessellated, and displayed. DAGMC and FEM
   mesh export are skipped for STEP imports to keep loading fast — only
   script builds produce `.h5m`/`.msh` artifacts by default.

## Region manifest

Assign materials and names by creating a sidecar file named
`model.regions.json`:

```json
{
  "version": 1,
  "volumes": [{ "selector": "fuel", "name": "fuel", "material": "UO2" }],
  "surfaces": [{ "selector": "clad.outer", "name": "clad_outer", "role": "boundary" }]
}
```

The manifest is validated when the geometry rebuilds. Unknown selectors and
missing materials are reported as warnings.

## Model Outline panel

The **Model Outline** panel gives a structured tree view of the active model:

- Open it with the **Open Model Outline** command, or from the Nuke Tools
  sidebar under `CAD Studio → Geometry`. It docks in the right panel area.
- Volumes are listed with their manifest name, material, and tags; surfaces
  with their name and role. Sections are collapsible and carry count badges,
  and build warnings appear in a box at the top. Models without a manifest
  fall back to positional `mat_<id>` rows.
- Picking is synced with the viewport in both directions: clicking a row
  highlights the whole solid in the viewport, and picking a face/solid in the
  viewport selects the matching row (scrolling it into view and expanding its
  section).
- The panel is read-only. Its manifest button opens the model's
  `.regions.json` in the text editor (disabled when no manifest exists).

## Preferences

- `nukeCad.facetingTolerance` (default `0.001`) sets the faceting tolerance
  used for geometry builds — both the viewport tessellation and the DAGMC
  export. Smaller values give finer meshes at the cost of build time. It
  applies to builds started after the change; an explicit per-build tolerance
  still wins.

## Export artifacts

When the geometry service runs a script build it writes several files beside
`model.py` (STEP imports write only the STEP/tessellation pair):

| File                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `model.step`              | Canonical B-rep exchange format                    |
| `model.tess.json`         | Viewport triangle stream                           |
| `model.h5m`               | DAGMC faceted geometry for OpenMC                  |
| `model.msh` / `model.e`   | FEM volume mesh (gmsh native / ExodusII)           |
| `model.inp` / `model.vtk` | CalculiX/Abaqus and VTK mesh exports               |
| `model.regions.json`      | Named volumes, materials, surfaces, and mesh sizes |
| `model.mesh.report.json`  | Mesh quality metrics                               |

### Meshing engines

FEM volume meshing defaults to gmsh (HXT tetrahedral algorithm). Passing
`engine='netgen'` to the mesh service switches to netgen (`netgen.occ`), which
honors the same per-region `meshSize` refinement and named-surface boundary
conditions and produces the same `.msh` / `.e` / `.inp` / `.vtk` artifacts and
quality report. Netgen generates linear tets only (higher-order requests fall
back with a warning) and requires the `ngsolve` pip wheel
(`pip install ngsolve`); if netgen is not installed you get a structured
error, not a silent gmsh fallback.

## Use in OpenMC Studio

The fastest path from a Nuke CAD model to an OpenMC simulation is through the
DAGMC export:

1. Build your model and make sure `model.h5m` is produced.
2. In OpenMC Studio, choose `Project → Import from nuke-cad...`.
3. Select `model.h5m`. OpenMC Studio reads the sibling `model.regions.json`
   manifest, sets the DAGMC geometry, and creates placeholder materials for
   each manifest material name.
4. Fill in nuclide compositions in the Materials tab and run.

## FEM analysis with CalculiX

1. Build or import a CAD model so that a `.msh` file exists beside it.
2. Open the **FEM Analysis** panel from the Nuke Tools sidebar
   (`CAD Studio → FEM`).
3. Choose the analysis type (Static Structural, Steady-State Thermal, or
   Frequency).
4. Assign a material to each mesh block.
5. Add boundary conditions on named surfaces from the region manifest or mesh
   sidesets: fixed constraints, displacements, pressure, temperature, or heat
   flux.
6. Click **Run FEM**. The service writes a `<stem>.fem.inp` file, runs
   CalculiX, and produces `<stem>.fem.vtk`. While a run is in flight the
   panel shows a **Stop** button that cancels the ccx process. Runs time out
   after one hour by default (adjustable via the `ccxTimeout` request field),
   and ccx output is streamed to `<stem>.ccx.log` next to the input deck.
7. Click **Open VTK Result** to visualize displacements or temperatures in
   nuke-visualizer.

CalculiX (`ccx`) must be available on `PATH` or pointed to with the `NUKE_CCX`
environment variable.

## OpenFOAM case scaffolding

1. Build or import a CAD model so that a `model.step` file exists.
2. Create a region manifest with named surfaces for boundary patches
   (e.g., `inlet`, `outlet`, `walls`).
3. Open the **OpenFOAM Case** panel from the Nuke Tools sidebar
   (`CAD Studio → CFD`).
4. Select a solver (icoFoam, simpleFoam, buoyantBoussinesqSimpleFoam, or
   chtMultiRegionSimpleFoam).
5. Edit boundary conditions: name, type, and value for each patch.
6. Click **Scaffold Case** to create a case directory with controlDict,
   fvSchemes, fvSolution, transportProperties, and field files.
7. Click **Export STL** to write one STL file per solid from `model.step` into
   `constant/triSurface` for surface-based OpenFOAM meshing.

The case can then be meshed with `blockMesh` / `snappyHexMesh` or the STL
patch geometry and run with the selected OpenFOAM solver.

## Next steps

- Add the CAD toolchain and CalculiX to your active Python environment (see
  the Environment section in Nuke Tools). The health check treats OCP,
  build123d, and gmsh (plus numpy) as required and reports everything else
  as optional; the required set is what a working CAD backend needs.
- Refine mesh size per region with the optional `meshSize` field in the
  manifest.
