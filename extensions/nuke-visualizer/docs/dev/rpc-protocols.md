# RPC Protocols

The frontend and backend communicate via **JSON-RPC over WebSocket**. Protocol files in `src/common/` define the contract: TypeScript interfaces that both sides import.

---

## Protocol File Pattern

Every plugin follows the same convention:

```typescript
// src/common/my-plugin-protocol.ts

export const MyBackendService = Symbol('MyBackendService');
export const MY_BACKEND_PATH = '/services/my-plugin';

export interface MyBackendService {
  // Server management
  startServer(filePath: string): Promise<{ port: number; url: string }>;
  stopServer(port: number): Promise<void>;

  // Domain methods
  getData(filePath: string): Promise<MyData>;
}

export interface MyData {
  value: number;
  label: string;
}

export const MY_REQUIREMENTS: PackageDependency[] = [{ name: 'my-package', required: true }];
```

**Rules:**

- Use `Symbol('Name')` for the service token.
- Export a constant path string starting with `/services/`.
- Export requirements as `PackageDependency[]`.
- Keep interfaces serializable (no functions, no class instances).

---

## Base Visualizer Protocol

**File:** `src/common/base-visualizer-protocol.ts`

Defines the contract for the base 3D mesh visualizer.

### Service Interface

```typescript
export interface VisualizerBackendService {
  // Server lifecycle
  startServer(filePath?: string, config?: PythonConfig, theme?: string): Promise<ServerInfo>;
  stopServer(port: number): Promise<void>;

  // Environment
  checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo>;

  // File conversion
  convertDagmc(filePath: string, volumeId?: number): Promise<string>;

  // Visualization controls (placeholders for future API)
  getVisualizationState(port: number): Promise<VisualizationState>;
  updateVisualizationState(port: number, state: Partial<VisualizationState>): Promise<void>;
  resetCamera(port: number): Promise<boolean>;
  setCameraView(port: number, viewType: CameraViewType): Promise<boolean>;
  captureScreenshot(port: number, options: ScreenshotOptions): Promise<ScreenshotResult>;

  // Client for log streaming
  setClient(client: VisualizerClient): void;
}
```

### VisualizerClient

The backend calls methods on the frontend via this client interface:

```typescript
export interface VisualizerClient {
  log(message: string): void; // stdout
  error(message: string): void; // stderr / errors
  warn(message: string): void; // warnings (shown as toast)
  onServerStop(port: number): void; // server process exited
}
```

### Key Types

| Type                 | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `VisualizationState` | Opacity, representation, colorBy, colorMap, clip settings, background |
| `CameraViewType`     | `isometric`, `front`, `back`, `left`, `right`, `top`, `bottom`        |
| `ScreenshotOptions`  | Format, resolution, transparent background                            |
| `PlotlyFigure`       | Generic figure for PlotlyService                                      |

---

## OpenMC Protocol

**File:** `src/common/openmc-protocol.ts`

The largest protocol (~1400 lines), covering all OpenMC domain types.

### Service Interface

```typescript
export interface OpenMCBackendService {
  setPythonConfig(config: PythonConfig): Promise<void>;
  setClient(client: VisualizerClient): void;

  // Statepoint
  loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo>;
  listTallies(statepointPath: string): Promise<OpenMCTallyInfo[]>;
  getStatepointFullInfo(statepointPath: string): Promise<OpenMCStatepointFullInfo>;
  getKGenerationData(statepointPath: string): Promise<OpenMCKGenerationData>;

  // Tally visualization
  visualizeMeshTally(statepointPath, tallyId, score?, nuclide?): Promise<OpenMCVisualizationResult>;
  visualizeSource(sourcePath: string): Promise<OpenMCVisualizationResult>;
  visualizeTallyOnGeometry(geometryPath, statepointPath, tallyId, score?, filterGraveyard?): Promise<OpenMCVisualizationResult>;

  // Plot data
  getEnergySpectrum(statepointPath, tallyId, scoreIndex?, nuclideIndex?): Promise<OpenMCSpectrumData>;
  getSpatialPlot(statepointPath, tallyId, axis, scoreIndex?, nuclideIndex?): Promise<OpenMCSpatialPlotData>;
  getHeatmapSlice(statepointPath, tallyId, plane, sliceIndex, scoreIndex?, nuclideIndex?): Promise<OpenMCHeatmapData>;
  getAllHeatmapSlices(statepointPath, tallyId, plane, scoreIndex?, nuclideIndex?): Promise<OpenMCHeatmapData[]>;

  // XS plotting
  getXSData(request: XSPlotRequest): Promise<XSPlotData>;
  getAvailableNuclides(crossSectionsPath?): Promise<string[]>;
  getAvailableThermalMaterials(crossSectionsPath?): Promise<string[]>;
  getGroupStructures(): Promise<XSGroupStructuresResponse>;

  // Depletion
  getDepletionSummary(filePath: string): Promise<OpenMCDepletionSummary>;
  getDepletionMaterials(filePath: string): Promise<OpenMCDepletionMaterial[]>;
  getDepletionData(filePath, materialIndex, nuclides?, includeActivity?): Promise<OpenMCDepletionResponse>;

  // Geometry
  getGeometryHierarchy(filePath: string): Promise<OpenMCGeometryResponse>;
  visualizeGeometry(filePath, highlightCellIds?, overlaps?): Promise<{ success; port?; url?; error? }>;
  checkOverlaps(request: OpenMCOverlapRequest): Promise<OpenMCOverlapResponse>;
  getOverlapVisualization(geometryPath, overlaps): Promise<OpenMCOverlapVizData>;

  // Materials
  getMaterials(filePath: string): Promise<OpenMCMaterialsResponse>;
  getMaterialCellLinkage(materialsPath, geometryPath): Promise<OpenMCMaterialCellLinkageResponse>;
  mixMaterials(request: OpenMCMaterialMixRequest): Promise<OpenMCMaterialMixResponse>;
  addMaterial(filePath: string, materialXml: string): Promise<void>;

  // Server lifecycle
  stopServer(port: number): Promise<void>;
  checkOpenMCAvailable(): Promise<{ available; message; warning? }>;
  checkOpenMCPythonAvailable(): Promise<{ available; message; warning? }>;
}
```

### Key Domain Types

| Type                      | Description                                                           |
| ------------------------- | --------------------------------------------------------------------- |
| `OpenMCTallyInfo`         | ID, name, scores, nuclides, filters, hasMesh                          |
| `OpenMCStatepointInfo`    | File, batches, kEff, nTallies                                         |
| `OpenMCGeometryHierarchy` | Universes, cells, surfaces, lattices                                  |
| `XSPlotRequest`           | Nuclides, reactions, temperature, energy range, materials, flux, etc. |
| `XSPlotData`              | Array of `XSCurveData` + temperature + warnings                       |
| `OpenMCDepletionSummary`  | nMaterials, nSteps, nNuclides, timePoints, burnup                     |

---

## Wiring Frontend Proxy

In `visualizer-frontend-module.ts`:

```typescript
import { MyBackendService, MY_BACKEND_PATH } from '../common/my-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';

bind(MyBackendService)
  .toDynamicValue((ctx) => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
    const outputChannelManager = ctx.container.get(OutputChannelManager);

    const client: VisualizerClient = {
      log: (msg) => outputChannelManager.getChannel('My Plugin').appendLine(msg),
      error: (msg) => outputChannelManager.getChannel('My Plugin').appendLine(`ERROR: ${msg}`),
      warn: (msg) => {
        const messageService = ctx.container.get(MessageService);
        messageService.warn(msg);
      },
      onServerStop: (port) => {
        console.log(`[My Plugin] Server on port ${port} stopped`);
      }
    };

    return connectionProvider.createProxy<MyBackendService>(MY_BACKEND_PATH, client);
  })
  .inSingletonScope();
```

**Important:** Pass the `client` as the second argument to `createProxy`. This registers the frontend's `VisualizerClient` implementation so the backend can stream logs and warnings.

---

## Wiring Backend Handler

In `visualizer-backend-module.ts`:

```typescript
import { MyBackendServiceImpl } from './plugins/my-plugin/my-backend-service';
import { MyBackendService, MY_BACKEND_PATH } from '../common/my-protocol';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';

bind(MyBackendServiceImpl).toSelf().inSingletonScope();
bind(MyBackendService).toService(MyBackendServiceImpl);
bind(ConnectionHandler)
  .toDynamicValue(
    (ctx) =>
      new RpcConnectionHandler<VisualizerClient>(MY_BACKEND_PATH, (client) => {
        const server = ctx.container.get<MyBackendServiceImpl>(MyBackendServiceImpl);
        server.setClient(client);
        return server;
      })
  )
  .inSingletonScope();
```

---

## Adding a New Protocol

1. Create `src/common/my-protocol.ts` with:
   - `Symbol('MyBackendService')`
   - `MY_BACKEND_PATH = '/services/my-plugin'`
   - `MyBackendService` interface
   - Domain types
   - `MY_REQUIREMENTS: PackageDependency[]`
2. Wire frontend proxy in `visualizer-frontend-module.ts`
3. Wire backend handler in `visualizer-backend-module.ts`
4. Implement backend service in `src/node/plugins/my-plugin/`
5. Implement frontend service in `src/browser/plugins/my-plugin/`

See [Adding a Plugin](adding-a-plugin.md) for the complete walkthrough.
