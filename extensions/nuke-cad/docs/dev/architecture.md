# Nuke CAD architecture

## Layout

```
extensions/nuke-cad/
├── package.json
├── tsconfig.json
├── src/
│   ├── common/            # RPC protocol, packages.json
│   ├── browser/           # widgets, commands, contributions, state, preferences
│   └── node/              # backend service that spawns Python
├── python/                # geometry_service.py, dagmc_export.py, mesh_service.py,
│                          # fem_service.py, foam_service.py, region_manifest.py,
│                          # job_service.py, ocp_compat.py
├── tests/python/          # pytest unit suite (minimal profile)
├── tests/e2e/             # pytest e2e layer (@pytest.mark.e2e, env-gated)
└── docs/                  # user/dev docs
```

## Runtime

The TypeScript backend uses `nuke-core`'s Python environment detection to find
the active interpreter, then spawns `python/geometry_service.py` with the user
script as an argument. The Python service follows the repo's stdout-JSON
protocol: progress lines on stderr, one final JSON object on stdout.

Spawned services are tracked in a backend job registry with a one-hour default
timeout, a 1 MB output tail, and a `cancelJob(jobId)` RPC that kills the
process group (used by the FEM panel's **Stop** button); remaining jobs are
killed when the backend stops. STEP-source models are always spawned with
`--no-dagmc`/`--no-mesh` — DAGMC and FEM mesh export only run for script
builds unless explicitly requested.

The frontend receives the result, caches the active `CadModel` in
`NukeCadStateManager`, and renders `model.tess.json` in a three.js viewport.
Saving a script-source model's `.py` file debounce-triggers a rebuild; build
errors surface in a dismissible banner inside the viewport.

`NukeCadFrontendService.buildGeometry` resolves the faceting tolerance from
the `nukeCad.facetingTolerance` preference (default 0.001, schema in
`src/browser/nuke-cad-preferences.ts`) unless the caller passes an explicit
tolerance, so open, rebuild, and **Open CAD Model...** all honor the user's
default. openmc-studio keeps its own `openmcStudio.defaultFacetingTolerance`;
nuke-cad is optional and carries no dependency on it.

The **Model Outline** panel (`src/browser/widgets/outline-panel/`, widget ID
`nuke-cad-outline-panel-widget`) renders the active model's manifest volumes
and surfaces as a read-only tree with count badges and a build-warnings box
(positional `mat_<id>` rows when no manifest exists). Picking syncs both ways
through `NukeCadStateManager`: a row click highlights the whole solid in the
viewport (the viewport learned whole-solid highlight for solidId-only
selections), and a viewport pick selects the row, scrolls it into view, and
expands its section.

## Python geometry service

`geometry_service.py`:

1. Executes the user script in an isolated subprocess (120 s default timeout,
   `--script-timeout` to adjust) and reads back the normalized model payload;
   `SystemExit` and unsupported model types are reported as structured errors.
2. Extracts the `model` global and normalizes it to an OCP `TopoDS_Shape`.
3. Writes a canonical STEP file.
4. Tessellates with `BRepMesh_IncrementalMesh` and writes `model.tess.json`.
   Selectors come from real build123d labels and CadQuery assembly names.
5. Loads and validates `model.regions.json` if present.
6. Exports a DAGMC `.h5m` file via `dagmc_export.py` (skipped for
   `--from-step` imports unless `--dagmc`/`--mesh` opt in).

## DAGMC export (`dagmc_export.py`)

The DAGMC pipeline is intentionally separated from the viewport tessellation
path. It uses gmsh's OpenCASCADE kernel for robust imprint/merge:

1. Load the canonical STEP file into an OCP `TopoDS_Shape`.
2. Optionally auto-create a `mat:graveyard` bounding volume with an OCP boolean
   cut (ported from openmc-studio's converter).
3. Write the shape to a temporary STEP file.
4. Load the temp STEP into gmsh and run `occ.fragment` on all volumes. This
   splits touching faces at their shared boundaries so adjacent solids receive
   exact, coincident surfaces. Volume identity across the fragment uses the
   fragment's returned mapping, followed by `removeAllDuplicates`; the temp
   STEP rewrite is skipped entirely when the shape is unmodified.
5. Generate a 2D surface mesh in gmsh.
6. Extract triangle buffers and surface-to-volume adjacencies via
   `gmsh.model.getAdjacencies`.
7. Write a tagged DAGMC H5M file via pymoab: `CATEGORY`, `GEOM_DIMENSION`,
   `GLOBAL_ID`, `NAME`, `GEOM_SENSE_2`, and `FACETING_TOL`.
8. Bind region-manifest selectors to `mat:<name>` material groups; unmanifested
   volumes fall back to `mat:mat_<vol_id-1>` (the `mat:` prefix is what OpenMC
   recognizes).
9. Verify the export: surface-sense verification is a hard error (every
   exported surface must have sense 1 or 2), watertightness holes mark the
   result `sealed=False` with a warning, edges shared by more than two
   surfaces are reported as a `nonManifoldEdges` diagnostic (multi-volume
   imprint seams legitimately have incidence 3), and a bbox +
   `BRepClass3d_SolidClassifier` overlap check is reported as `overlapCheck`.

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
     and side sets (SEACAS TETRA(4) node-numbering convention).
   - `.inp` CalculiX/Abaqus via meshio.
   - `.vtk` VTK unstructured grid via meshio.
5. Write a `mesh.report.json` with element counts and tetrahedral quality
   metrics (dihedral angles — a regular tetrahedron measures 70.53° — and
   edge-length aspect ratios). An explicit `max_size` request overrides
   `mesh_size`; second-order meshes report `elementTypes: tetra10`.

Netgen is a supported alternative engine (`engine='netgen'`). It loads the
STEP via `netgen.occ.OCCGeometry`, maps per-region `meshSize` to
`solid.maxh`, maps surface names to boundary-condition names, resolves the
selector map via gmsh COM matching, and converges into the same meshio-based
report/Exodus/INP/VTK pipeline as gmsh. Limitations: linear tets only
(order > 1 warns), and the `.msh` artifact is gmsh-2.2 ASCII via meshio. A
missing netgen install returns a structured error. Netgen comes from the
`ngsolve` pip wheel (installs netgen-mesher, which bundles its own OCCT
7.8.1).

## E2E tests (`tests/e2e/`)

The e2e layer runs the full pipeline against real dependencies — e.g. the
pincell DAGMC test builds a labeled build123d pincell, exports STEP, produces
an imprinted h5m (asserting `mat:fuel/clad/moderator/graveyard` groups), and
runs a real OpenMC simulation asserting zero lost particles. Tests carry the
`@pytest.mark.e2e` marker, are gated on `NUKE_TEST_PYTHON` +
`OPENMC_CROSS_SECTIONS`, and skip cleanly when those are unset.

## FEM service (`fem_service.py`)

The FEM service generates a CalculiX input deck from a gmsh `.msh` file and
optionally runs CalculiX:

1. Read the gmsh `.msh` via the gmsh API and build dense node/element arrays
   plus named volume blocks and surface sets from physical groups (vectorized
   assignment; unnamed elements fall back to a single block).
2. Write a CalculiX `.inp` file with nodes, elements, materials, solid
   sections, boundary conditions, gravity loads, and output requests.
3. Optionally run the `ccx` executable (resolved from `NUKE_CCX`, `PATH`, or
   an explicit request path) with a one-hour default timeout (`ccxTimeout`
   request field), streaming stdout/stderr to `<stem>.ccx.log` and returning
   a 1 MB JSON tail.
4. Parse the resulting `.frd` file (CalculiX's real fixed-width format) for
   nodal displacements (`DISP`) and temperatures (`NDTEMP`) and write a
   legacy VTK unstructured grid that nuke-visualizer can open.

Boundary conditions are bound to named surface sets from the mesh or region
manifest. Supported types: fixed (dof-range `*Boundary` card, `nset, 1, 3` —
CalculiX does not accept `ENCASTRE`), prescribed displacement,
pressure (approximated as distributed nodal forces), temperature, and heat
flux (approximated as nodal heat flow). Pressure and heat flux use the
surface triangle area for distribution, so they are accurate in net load but
approximate in local distribution.

## Generic job runner (`job_service.py`)

The run-layer abstraction for solver hooks. A request declares a working
directory, command, optional environment overlay, artifact glob patterns,
timeout, and log file path (the full request schema is documented in the
module docstring). The service creates the working directory, runs the
command as a local subprocess in its own process group — so timeouts and
cancellation kill the whole tree — captures stdout/stderr, and returns the
exit code plus any matched artifact paths. Remote/SSH/container execution can
be added later without changing the request schema.

## OpenFOAM service (`foam_service.py`)

Scaffolds a solver-ready OpenFOAM case from the region manifest and
optionally exports per-solid STL patch geometry from the canonical STEP file.

Case scaffolding writes:

- `system/controlDict` — solver application and time controls.
- `system/fvSchemes` — conservative default schemes.
- `system/fvSolution` — SIMPLE/linear solver settings.
- `constant/transportProperties` — viscosity and optional Pr/TRef for
  buoyant solvers.
- `0/U`, `0/p`, and optionally `0/T` — field files with boundary conditions
  derived from manifest surface names and a boundary-condition editor.

STL export loads the canonical STEP file in-module via `STEPControl_Reader`
(with the `ocp_compat` TopoDS downcast — there is no `cad_conversion`
dependency) and writes one binary STL per solid, named by manifest selector
or `solid_<index>.stl`, with sanitized filenames and a checked writer return.
These files are intended for the `constant/triSurface` directory when the
OpenFOAM meshing workflow uses surface meshes.

Heavy OCP/build123d imports are optional so the module remains importable in
the minimal pytest profile.
