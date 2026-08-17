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

## Next steps

- Add the CAD toolchain to your active Python environment (see the Environment
  section in Nuke Tools).
- In later phases, export directly to DAGMC `.h5m` and FEM meshes.
