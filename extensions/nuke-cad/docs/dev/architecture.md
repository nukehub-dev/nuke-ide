# Nuke CAD architecture

## Layout

```
extensions/nuke-cad/
├── package.json
├── tsconfig.json
├── src/
│   ├── common/            # RPC protocol, packages.json
│   ├── browser/           # widgets, commands, contributions, state
│   └── node/              # backend service that spawns Python
├── python/                # geometry_service.py, dagmc_export.py, mesh_service.py,
│                          # fem_service.py, region_manifest.py, ocp_compat.py
├── tests/python/          # pytest suite
└── docs/                  # user/dev docs
```

## Runtime

The TypeScript backend uses `nuke-core`'s Python environment detection to find
the active interpreter, then spawns `python/geometry_service.py` with the user
script as an argument. The Python service follows the repo's stdout-JSON
protocol: progress lines on stderr, one final JSON object on stdout.

The frontend receives the result, caches the active `CadModel` in
`NukeCadStateManager`, and renders `model.tess.json` in a three.js viewport.

## Python geometry service

`geometry_service.py`:

1. Executes the user script with `runpy.run_path` in a dedicated namespace.
2. Extracts the `model` global and normalizes it to an OCP `TopoDS_Shape`.
3. Writes a canonical STEP file.
4. Tessellates with `BRepMesh_IncrementalMesh` and writes `model.tess.json`.
5. Loads and validates `model.regions.json` if present.
6. Exports a DAGMC `.h5m` file via `dagmc_export.py`.

## DAGMC export (`dagmc_export.py`)

The DAGMC pipeline is intentionally separated from the viewport tessellation
path. It uses gmsh's OpenCASCADE kernel for robust imprint/merge:

1. Load the canonical STEP file into an OCP `TopoDS_Shape`.
2. Optionally auto-create a `mat:graveyard` bounding volume with an OCP boolean
   cut (ported from openmc-studio's converter).
3. Write the shape to a temporary STEP file.
4. Load the temp STEP into gmsh and run `occ.fragment` on all volumes. This
   splits touching faces at their shared boundaries so adjacent solids receive
   exact, coincident surfaces.
5. Generate a 2D surface mesh in gmsh.
6. Extract triangle buffers and surface-to-volume adjacencies via
   `gmsh.model.getAdjacencies`.
7. Write a tagged DAGMC H5M file via pymoab: `CATEGORY`, `GEOM_DIMENSION`,
   `GLOBAL_ID`, `NAME`, `GEOM_SENSE_2`, and `FACETING_TOL`.
8. Bind region-manifest selectors to `mat:<name>` material groups; unmanifested
   volumes fall back to `mat_<vol_id-1>`.

## Meshing service (`mesh_service.py`)

The meshing service turns the canonical STEP file into FEM volume meshes:

1. Load the STEP file into gmsh's OpenCASCADE kernel and run `occ.fragment`
   on all volumes so touching solids remain distinct while sharing exact
   coincident faces.
2. Apply a global size field and per-region size fields. Manifest volume
   entries may include `meshSize` to refine specific regions; these are
   implemented as gmsh `MathEval` fields restricted to the target volumes.
3. Generate a 3D tetrahedral mesh with the HXT algorithm
   (`Mesh.Algorithm3D = 10`).
4. Write the native `.msh` file and convert it to:
   - `.e` ExodusII via a custom netCDF4 writer with named element blocks
     and side sets.
   - `.inp` CalculiX/Abaqus via meshio.
   - `.vtk` VTK unstructured grid via meshio.
5. Write a `mesh.report.json` with element counts and tetrahedral quality
   metrics (dihedral angles and edge-length aspect ratios).

Netgen is accepted as an `engine` value for forward compatibility but is
not wired yet.

## FEM service (`fem_service.py`)

The FEM service generates a CalculiX input deck from a gmsh `.msh` file and
optionally runs CalculiX:

1. Read the gmsh `.msh` via the gmsh API and build dense node/element arrays
   plus named volume blocks and surface sets from physical groups.
2. Write a CalculiX `.inp` file with nodes, elements, materials, solid
   sections, boundary conditions, gravity loads, and output requests.
3. Optionally run the `ccx` executable (resolved from `NUKE_CCX`, `PATH`, or
   an explicit request path) and capture its stdout/stderr to a log file.
4. Parse the resulting `.frd` file for nodal displacements (`DISP`) and
   temperatures (`TEMP`) and write a legacy VTK unstructured grid that
   nuke-visualizer can open.

Boundary conditions are bound to named surface sets from the mesh or region
manifest. Supported types: fixed (`ENCASTRE`), prescribed displacement,
pressure (approximated as distributed nodal forces), temperature, and heat
flux (approximated as nodal heat flow). Pressure and heat flux use the
surface triangle area for distribution, so they are accurate in net load but
approximate in local distribution.

## Future phases

- Phase 6: OpenFOAM case scaffolding; MOOSE LSP; remote run abstraction.
