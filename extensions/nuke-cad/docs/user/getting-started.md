# Getting started with Nuke CAD

Nuke CAD is a script-first parametric CAD extension. Your geometry source of
truth is a Python script using **build123d** or **CadQuery**.

## Quick start

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

## Next steps

- Add the CAD toolchain to your active Python environment (see the Environment
  section in Nuke Tools).
- Refine mesh size per region with the optional `meshSize` field in the
  manifest.
