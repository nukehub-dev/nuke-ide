# Widget Patterns

`nuke-visualizer` uses two distinct widget patterns. Choosing the right one keeps your plugin simple and performant.

---

## Pattern A: Iframe Widget (`VisualizerWidget`)

**Best for:** Python servers that render their own UI (Trame, Dash, Flask, etc.)

### How It Works

1. Frontend creates a `VisualizerWidget` (or subclass).
2. Backend spawns a Python process that starts an HTTP server.
3. Widget sets an `<iframe src="http://localhost:PORT">`.
4. The Python server renders the full 3D/interactive UI.

```
┌─────────────────────────────┐
│  Theia IDE (React)          │
│  ┌───────────────────────┐  │
│  │ <iframe>              │  │
│  │  ┌─────────────────┐  │  │
│  │  │  Trame/Dash UI  │  │  │
│  │  │  (Python server)│  │  │
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### When to Use

- 3D visualization (ParaView/Trame, VTK, OpenGL)
- Complex interactive controls that are easier in Python
- Existing Python web UIs you want to embed

### Example: Base Visualizer

```typescript
// Widget creation
const widget = (await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { uri: fileUri.toString() })) as VisualizerWidget;

// Backend starts server
const server = await this.visualizerBackend.startServer(filePath, undefined, theme);

// Widget points iframe to server
widget.setServerUrl(server.url, server.port);
```

### Lifecycle

| Event          | Action                                          |
| -------------- | ----------------------------------------------- |
| Widget created | Show loading spinner                            |
| Server starts  | Poll `http://localhost:PORT` every 2s           |
| Server ready   | Set iframe `src`, hide spinner                  |
| Widget closed  | Call `backend.stopServer(port)`                 |
| Server crashes | `VisualizerClient.onServerStop()` clears iframe |

### Multi-Instance

Each file gets its own widget and its own Python server:

```typescript
const widgetId = `visualizer-${filePath}`;
const widget = await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { uri: fileUri.toString(), id: widgetId });
```

### Limitations

- **No direct React control** over the inner UI (must use iframe postMessage or server API).
- **CSP concerns** — iframe sandbox must allow `allow-same-origin allow-scripts`.
- **One process per widget** — can be heavy for many tabs.

---

## Pattern B: React Widget + Plotly

**Best for:** 2D plots, tables, trees, and forms that live natively in the IDE.

### How It Works

1. Frontend creates a custom `ReactWidget`.
2. Data is fetched from the backend via RPC.
3. The widget renders with React + Plotly.js directly.
4. No Python server needed — data is JSON, rendering is client-side.

```
┌─────────────────────────────┐
│  Theia IDE (React)          │
│  ┌───────────────────────┐  │
│  │  ReactWidget          │  │
│  │  ┌─────────────────┐  │  │
│  │  │  Plotly.js Chart│  │  │
│  │  │  (Client-side)  │  │  │
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### When to Use

- 2D line charts, bar charts, heatmaps
- Data tables and trees (material list, geometry hierarchy)
- Forms and configuration panels
- Any UI where you need tight IDE integration (drag-drop, context menus)

### Example: OpenMC Plot Widget

```typescript
@injectable()
export class OpenMCPlotWidget extends ReactWidget {
    static readonly ID = 'openmc-plot-widget';
    private figure?: PlotlyFigure;

    setFigure(figure: PlotlyFigure): void {
        this.figure = figure;
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.figure) return <div>No data</div>;
        return <PlotlyComponent data={this.figure.data} layout={this.figure.layout} />;
    }
}
```

### Example: Spectrum Plot (No Python Server)

```typescript
// Frontend service fetches data
const data = await this.openmcBackend.getEnergySpectrum(statepointPath, tallyId);

// Convert to Plotly trace
const trace = PlotlyUtils.createSpectrumTrace(data, 'Flux');

// Show in React widget
await this.plotlyService.showPlot({
  data: [trace],
  layout: { xaxis: { type: 'log' }, yaxis: { type: 'log' } },
  title: 'Energy Spectrum'
});
```

### Lifecycle

| Event          | Action                                              |
| -------------- | --------------------------------------------------- |
| Widget created | Render empty state                                  |
| Data requested | Show loading indicator                              |
| Data received  | `setFigure()` or `setState()` triggers React render |
| Widget closed  | Nothing special (no server to kill)                 |

### Advantages

- **Lightweight** — no Python process.
- **Full React control** — buttons, sliders, forms work naturally.
- **IDE-native** — theming, context menus, keyboard shortcuts integrate seamlessly.

---

## Pattern C: Hybrid (React + Iframe)

Some features combine both patterns:

**Example: Statepoint Viewer**

- Main viewer is a **React widget** showing metadata, tables, and Plotly charts.
- Clicking "View Source" spawns a **VisualizerWidget** with an iframe for the 3D scatter plot.

**Example: Geometry Hierarchy**

- Tree is a **React widget** in the sidebar.
- Clicking "View 3D" spawns a **VisualizerWidget** with a Python server rendering the geometry.

---

## Decision Flowchart

```
Does your visualization need a Python rendering library
(Paraview, VTK, OpenMC 3D, custom GL)?
│
├─ YES → Use Pattern A: Iframe Widget
│        (VisualizerWidget or subclass)
│
└─ NO  → Is it 2D data that can be rendered with Plotly/Charts?
         │
         ├─ YES → Use Pattern B: React Widget + Plotly
         │         (OpenMCPlotWidget, custom ReactWidget)
         │
         └─ NO  → Use Pattern B: React Widget
                    (Trees, tables, forms — pure React)
```

---

## Widget Reference

| Widget                         | Pattern          | Purpose                            |
| ------------------------------ | ---------------- | ---------------------------------- |
| `VisualizerWidget`             | A (iframe)       | Base 3D mesh/DAGMC viewer          |
| `OpenMCPlotWidget`             | B (React+Plotly) | 2D tally plots (spectrum, spatial) |
| `OpenMCHeatmapWidget`          | B (React+Plotly) | 2D mesh tally slices               |
| `XSPlotWidget`                 | B (React+Plotly) | Cross-section plotting             |
| `OpenMCGeometryTreeWidget`     | B (React)        | Geometry hierarchy tree            |
| `OpenMCTallyTreeWidget`        | B (React)        | Tally list sidebar                 |
| `OpenMCStatepointViewerWidget` | B (React+Plotly) | Statepoint dashboard               |
| `OpenMCDepletionWidget`        | B (React+Plotly) | Depletion curves                   |
| `OpenMCMaterialExplorerWidget` | B (React)        | Material compositions              |
| `OpenMCOverlapWidget`          | B (React)        | Overlap checker UI                 |
| `OpenMCGeometry3DWidget`       | A (iframe)       | 3D geometry renderer               |
