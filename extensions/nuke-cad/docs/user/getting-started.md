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
   **CAD Viewport** command from the Nuke Tools sidebar.
4. The geometry service builds a STEP file and a triangle stream beside your
   script (`model.step`, `model.tess.json`) and renders them in the viewport.

### From a STEP file

1. Double-click any `.step`, `.stp`, or `.brep` file in the Explorer — it opens
   in nuke-cad by default.
2. Or open the **CAD Viewport** and click **Open CAD Model...** to browse for a
   `.py` script or `.step` / `.stp` file.
3. The file is read through OCP, tessellated, and displayed. The same DAGMC and
   FEM export pipeline runs, writing artifacts beside the source file.

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

## Export artifacts

When the geometry service runs it writes several files beside `model.py`:

| File                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `model.step`              | Canonical B-rep exchange format                    |
| `model.tess.json`         | Viewport triangle stream                           |
| `model.h5m`               | DAGMC faceted geometry for OpenMC                  |
| `model.msh` / `model.e`   | FEM volume mesh (gmsh native / ExodusII)           |
| `model.inp` / `model.vtk` | CalculiX/Abaqus and VTK mesh exports               |
| `model.regions.json`      | Named volumes, materials, surfaces, and mesh sizes |
| `model.mesh.report.json`  | Mesh quality metrics                               |

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
   CalculiX, and produces `<stem>.fem.vtk`.
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
  the Environment section in Nuke Tools).
- Refine mesh size per region with the optional `meshSize` field in the
  manifest.
