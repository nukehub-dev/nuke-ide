# Getting started with Nuke CAD

Nuke CAD has two authoring modes: script-based `.py` files and GUI-edited
`.nuke-cad` documents. This guide covers scripts and STEP imports; the
[GUI parametric modeler guide](gui-modeler.md) covers the document workflow.

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

### Material property cards

A volume's `material` is just a name. The property payload behind the name
(an isotropic `{E, nu, rho, k, cp, alpha}` card, plus an optional `yield`
strength) comes from an additive top-level `materials` block:

```json
{
  "version": 1,
  "volumes": [{ "selector": "fuel", "material": "my_alloy" }],
  "materials": { "my_alloy": { "E": 200e9, "nu": 0.3, "rho": 7800.0, "yield": 250e6 } }
}
```

Units are `E` in Pa, `nu` dimensionless, `rho` in kg/m³, `k` in W/(m·K),
`cp` in J/(kg·K), `alpha` in 1/K, and `yield` (yield strength) in Pa; every
field is optional and unknown fields are rejected so typos fail loudly.
`yield` enables the FEM safety-factor result (`yield` over von Mises,
per node): materials without it simply omit the safety factor for their
blocks and the run warns about the omission instead of inventing a
strength. No built-in card sets `yield`. When the FEM service builds a
deck, a material name resolves manifest-first, then against the built-in
cards (`structural_steel`, `aluminum`, `copper`, `uo2`, `zircaloy`,
`concrete`); an unlisted name fails the run with a clear error instead of a
silent default. The thermal fields (`k`, `cp`) are additionally stored for
future coupled-physics coupling and are reserved for that use. The OpenMC
side is untouched: placeholder materials still flow from the name alone.

## Model Outline panel

The **Model Outline** panel gives a structured tree view of the active model:

- Open it with the **Open Model Outline** command, from the Nuke Tools
  sidebar under `CAD Studio → Geometry`, or just open a CAD model — the
  panel (and the Feature Tree) reveal themselves automatically. It docks in
  the right panel area.
- Volumes are listed with their manifest name, material, and tags; surfaces
  with their name and role. Sections are collapsible and carry count badges,
  and build warnings appear in a box at the top. Models without a manifest
  fall back to positional `mat_<id>` rows.
- Picking is synced with the viewport in both directions: clicking a row
  highlights the whole solid in the viewport, and picking a face/solid in the
  viewport selects the matching row (scrolling it into view and expanding its
  section). `Ctrl`/`Cmd`-click a row (or a table row) to add it to a
  multi-selection — every selected solid highlights in the viewport, and the
  most recently clicked one drives the Properties section and fit-to-selection.
- **Hide / Isolate** — hovering a mapped row reveals two actions: the eye
  toggles the row's solids in the viewport, and the filter button **isolates**
  it (hides every other solid). Hidden rows stay listed, dimmed with an
  eye-closed marker, and a **Show all** button appears in the panel header
  while anything is hidden. Hiding is viewport-only — it never changes the
  document or exports, and it resets when a different model loads.
- **Properties** — when a solid is selected, a properties section shows its
  volume, area, bounding-box size (dx/dy/dz), center of mass, and face/edge/
  triangle counts (model units; em-dashes when a value is unavailable). The
  pin button freezes the current solid's data so it stays visible while the
  selection changes. Decimal places follow the **Precision** row in Document
  Settings.
- **Table view** — the header toggle switches the volume list to a sortable
  table (Solid, Body label, Volume, Area, Faces, Tris). Click a header to
  sort; click a row to select that solid in the viewport (`Ctrl`/`Cmd`-click
  multi-selects). Values are model units with SI suffixes at the same
  precision.
- **Build warnings** — cross-body overlap warnings (`bodies 'x' and 'y'
overlap … but are not merged by a boolean`) carry a **Fuse** button when the
  model was built from an open `.nuke-cad` document. Clicking it appends a
  `booleanFuse` feature that merges the overlapping pair and rebuilds, which
  clears that warning. Assemblies that overlap on purpose can keep the
  warnings — they never block a build. Script and STEP-imported models have no
  document to edit, so no button is offered.
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
quality report. The netgen path imprints the geometry first (touching solids
share one face) and supports second-order meshes: `order=2` produces real
tetra10/triangle6 elements, `order > 2` clamps to 2 with a warning, and
curved-boundary mid-nodes are a best-effort projection (verified for
straight-edged geometry). Install netgen via conda (`conda install -c
conda-forge ngsolve`, preferred) or the `ngsolve` pip wheel; if netgen is not
installed you get a structured error, not a silent gmsh fallback.

### Mesh repair

A defective surface mesh (duplicate facets, pinholes, rough tessellation)
can be repaired in place before the quality report is written: pass
`--repair <op,...>` to the mesh service CLI (or `repairs=[...]` to
`mesh_step`). The ops run in the listed order after mesh generation, the
repaired mesh is rewritten to `model.msh`, and per-op counts land in
`model.mesh.report.json` under `repairs`, so the report certifies the
repaired mesh.

| Op                        | Effect                                                  |
| ------------------------- | ------------------------------------------------------- |
| `remove_duplicate_facets` | Drop exact-duplicate and degenerate (zero-area) facets  |
| `fill_holes`              | Fan-fill closed boundary loops (hole rims)              |
| `smooth_laplacian`        | Laplacian smoothing with boundary preservation          |
| `decimate`                | Reduce the triangle count toward a 50% target reduction |

`fill_holes` only fills closed rims of 32 or fewer edges; larger loops,
degenerate loops, and open (dangling/non-manifold) chains are left unfilled
and reported in the result warnings — never silently capped.
`smooth_laplacian` pins boundary nodes so seals never drift, caps iterations
at 100, and reports the deviation introduced as `max_deviation`.
`decimate` is surface-only: on a volume mesh it refuses loudly instead of
orphaning tetrahedra. Repairs are mesh-only (B-rep and documents are never
touched), and every op failure names the op instead of skipping silently.

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

Load details: a `pressure` condition applies a uniform normal traction to
the named surface (element-face pressure loads — positive compresses,
negative pulls; any direction vector is ignored since traction follows
the face normal), and a `temperature` condition prescribes nodal
temperatures on the surface. Static Structural is the default analysis
type; Steady-State Thermal and Frequency are selected per run.
Stress runs additionally produce `von_mises` and `max_principal`
color-by arrays derived from the nodal stresses, plus a `safety_factor`
array (`yield` over von Mises) wherever the block's material card carries
a `yield` strength — nodes without one read as missing and the run warns
which materials were skipped.

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
