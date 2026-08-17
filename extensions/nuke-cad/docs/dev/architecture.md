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
├── python/                # geometry_service.py, region_manifest.py, ocp_compat.py
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

## Future phases

- Phase 2: imprint/merge DAGMC export (shared converter owned by nuke-cad).
- Phase 3: gmsh/netgen meshing service + ExodusII export.
- Phase 5: CalculiX FEM job builder/runner.
