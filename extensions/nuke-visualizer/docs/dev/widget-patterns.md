# Widget Patterns

`nuke-visualizer` uses two distinct widget patterns. Choosing the right one keeps your plugin simple and performant.

---

## Pattern A: Native 3D Widget (`NativeVtkViewerWidget`)

**Best for:** 3D visualization of converted VTK datasets (meshes, tracks, tallies, DAGMC, Exodus steps).

### How It Works

1. Frontend creates a `NativeVtkViewerWidget` (or subclass).
2. Backend runs a short-lived Python converter command that writes XML VTK and exits.
3. Frontend reads the file text and calls `setVtkText(text)`.
4. The widget parses the XML and renders it with three.js — color-by, clip, and screenshots are all client-side.

```
┌─────────────────────────────┐
│  Theia IDE (React)          │
│  ┌───────────────────────┐  │
│  │ NativeVtkViewerWidget │  │
│  │  ┌─────────────────┐  │  │
│  │  │ three.js canvas │  │  │
│  │  │ (client-side)   │  │  │
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### When to Use

- 3D visualization (VTK datasets, converted DAGMC/STEP/OpenMC outputs)
- Instant array switching without re-conversion or restarts

### Example: Base Visualizer

```typescript
// Widget creation
const widget = (await this.widgetManager.getOrCreateWidget(NativeVtkViewerWidget.ID, { uri: fileUri.toString() })) as NativeVtkViewerWidget;

// Backend converts, frontend reads + renders (no server, no port)
const result = await this.visualizerBackend.convertDagmc(filePath);
const text = (await this.fileService.read(URI.file(result.vtkPath))).value.toString();
await widget.setVtkText(text);
```

### Lifecycle

| Event          | Action                                                |
| -------------- | ----------------------------------------------------- |
| Widget created | Show loading spinner                                  |
| Convert done   | `setVtkText` parses + renders, hide spinner           |
| Widget closed  | Nothing to stop — no server was started               |
| Convert fails  | Error panel with retry (points at the generic viewer) |

### Multi-Instance

Each file gets its own widget and its own short-lived conversion:

```typescript
const widgetId = `visualizer-${filePath}`;
const widget = await this.widgetManager.getOrCreateWidget(NativeVtkViewerWidget.ID, { uri: fileUri.toString(), id: widgetId });
```

### Limitations

- **XML VTK only** — the native parser reads XML formats; anything else must convert first.
- **No server-side rendering** — very large datasets parse and render on the client.

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

## Pattern C: Hybrid (React + Native 3D)

Some features combine both patterns:

**Example: Statepoint Viewer**

- Main viewer is a **React widget** showing metadata, tables, and Plotly charts.
- Clicking "View Source" opens a **NativeVtkViewerWidget** with the converted source scatter.

**Example: Geometry Hierarchy**

- Tree is a **React widget** in the sidebar.
- Clicking "View 3D" opens a **native viewer** with the extracted geometry mesh.

---

## Sidebar Panel Contracts (Viewer Settings / DAGMC Outline)

The two visualizer sidebars share the CAD Model Outline grammar and stay
readable at the 250 px default width:

- **Section headers** are 11 px uppercase, weight 600, 0.3 px letter-spacing,
  7 px gap, with plain-integer count badges (`3`, never `03` or `0/3`).
- **Settings rows** reserve a non-shrinking label column (`flex: 0 0 auto`,
  `min-width: 82px`, `white-space: nowrap`) and let controls absorb the
  remaining width. Never shrink or ellipsize a label so a control fits; dense
  rows wrap extra controls only when the panel is too narrow.
- **Categorical color modes** report no scalar mapping through
  `ViewerSettingsSnapshot.colormap.disabled` (Solid Color and DAGMC
  Material/Volume/Group). The panel must omit the colormap, Invert/Log, range,
  threshold, and color-legend rows instead of rendering disabled controls,
  leaving Color by plus the muted `note` line. `solidColor` renders only in
  Solid Color.
- **DAGMC Outline rows** are 24 px with the same header treatment; count
  badges, material/group swatches, search, and visibility/isolate actions are
  behavior, not chrome — keep them when restyling.

---

## Decision Flowchart

```
Does your visualization need 3D rendering
(VTK datasets, converted meshes, tallies)?
│
├─ YES → Use Pattern A: Native 3D Widget
│        (NativeVtkViewerWidget or subclass)
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
| `VisualizerWidget`             | A (native)       | Base 3D mesh/DAGMC viewer          |
| `OpenMCPlotWidget`             | B (React+Plotly) | 2D tally plots (spectrum, spatial) |
| `OpenMCHeatmapWidget`          | B (React+Plotly) | 2D mesh tally slices               |
| `XSPlotWidget`                 | B (React+Plotly) | Cross-section plotting             |
| `OpenMCGeometryTreeWidget`     | B (React)        | Geometry hierarchy tree            |
| `OpenMCTallyTreeWidget`        | B (React)        | Tally list sidebar                 |
| `OpenMCStatepointViewerWidget` | B (React+Plotly) | Statepoint dashboard               |
| `OpenMCDepletionWidget`        | B (React+Plotly) | Depletion curves                   |
| `OpenMCMaterialExplorerWidget` | B (React)        | Material compositions              |
| `OpenMCOverlapWidget`          | B (React)        | Overlap checker UI                 |
