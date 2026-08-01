# Output Viewers

How OpenMC output files (`tracks.h5`, `weight_windows.h5`, …) become interactive 3D viewers: the **OutputViewerRegistry** routes files to contributions, each contribution **converts** the file to VTK via the Python backend, **serves** it with a trame server, and embeds the server in an **iframe**.

---

## OutputViewerRegistry

`src/browser/output-viewer/output-viewer-registry.ts` collects `OutputViewerContribution` instances (DI, same provider pattern as other registries):

```typescript
interface OutputViewerContribution {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  canHandle(uri: URI): number; // score > 0 if this viewer claims the file
  open(uri: URI): Promise<void>;
}
```

- Filename matching lives in `src/browser/output-viewer/output-file-patterns.ts` — one place to add a new recognized pattern.
- Both open handlers consult the registry **first**: `VisualizerOpenHandler` ("Open in Nuke Visualizer") and the OpenMC plugin's `OpenMCContribution` ("OpenMC Files"). Double-clicking a recognized file therefore routes automatically — there is no manual "Open as" step (except random ray results, whose plain `.vtk`/`.h5` names are not distinctive; those open via the `openmc.open-random-ray-results` command).
- Built-in contributions: tracks, collision tracks, weight windows, particle restart (the last is a React summary — no 3D conversion).

To add a viewer: add a pattern, implement the contribution, bind it with `bind(OutputViewerContribution).to(...).inSingletonScope()`.

---

## Convert → Serve → Iframe

3D output viewers extend `OpenMCOutputViewerWidget` (`src/browser/plugins/openmc/widgets/output-viewer-widget.tsx`), which implements the whole pipeline; subclasses only provide `convert(filePath)` and panel content.

```
reload()
  └─ subclass.convert(filePath)            # RPC → OpenMCOutputService (node)
  │    └─ python server.py openmc.<cmd>    # plugins/openmc/lib/output_vtk.py
  │         tracks-vtk / collision-vtk / weight-windows-vtk [--mesh-id] / voxel-vtk
  │         → writes .vtp / .vtr / .vti (numpy-only geometry; vtk imports lazily for the write)
  └─ restartServer(vtkPath)
       └─ VisualizerBackendService.startServer(filePath, config?, theme?, colorBy?)
            └─ python server.py base.serve --port p --file f [--theme dark|light] [--color-by c]
       └─ <iframe src={toProxiedVisualizerUrl(serverUrl)}>   # via /visualizer/<port>/ reverse proxy
```

### The `--color-by` Contract

`--color-by` is an argument of **`base.serve`**, not of the converters. Format: `'Solid Color' | 'Point: <array>' | 'Cell: <array>'`, validated against the arrays the loaded dataset actually has (`state.available_arrays`). The widget passes its current color-by selection on every server (re)start; users can also switch arrays in the trame UI's Display Controls drawer. Converters decide _which_ arrays exist — e.g. weight windows write one cell-data array per (bound, group) named `lower_g<i>` / `upper_g<i>`, which is what makes Color By act as the group/bound selector.

### Server Lifecycle

- `startServer` waits for the server's `ACTUAL_PORT:` line; the timeout scales with file size via the `nukeVisualizer.serverTimeout` + `nukeVisualizer.serverTimeoutPerMB` preferences.
- Servers bind `127.0.0.1` only and are reached through the Theia backend reverse proxy (`src/node/visualizer-proxy-contribution.ts`), so iframes work in both browser and Electron deployments.
- The widget kills its server on dispose (`stopServer(port)`); parameter changes (filters, mesh selection) re-run `reload()` — convert again, restart the server.

### Multi-Mesh Weight Windows

`weight_windows_to_vtk(path, output_path, mesh_id)` anchors the conversion to one mesh; windows on other meshes are skipped and reported in the result (`convertedWindows` / `skippedWindows`). The widget shows a mesh selector when the file's info reports more than one mesh ID, and passes the selection through the `meshId` RPC parameter to the `--mesh-id` CLI argument.

---

## Key Files

| Purpose                    | File                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| Viewer registry            | `src/browser/output-viewer/output-viewer-registry.ts`                        |
| Filename patterns          | `src/browser/output-viewer/output-file-patterns.ts`                          |
| Viewer base class          | `src/browser/plugins/openmc/widgets/output-viewer-widget.tsx`                |
| Backend conversion service | `src/node/plugins/openmc/services/openmc-output-service.ts`                  |
| VTK converters (Python)    | `python/plugins/openmc/lib/output_vtk.py`                                    |
| Trame server command       | `python/plugins/base/commands/serve.py`                                      |
| URL proxying               | `src/browser/visualizer-url.ts`, `src/node/visualizer-proxy-contribution.ts` |
