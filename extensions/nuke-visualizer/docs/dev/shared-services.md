# Shared Services

These services are the reusable backbone of `nuke-visualizer`. Every plugin — Base Visualizer, OpenMC, or your own — should use them instead of reinventing infrastructure.

---

## HealthCheckFramework

**File:** `src/browser/services/health-check-framework.ts`

Plugin-agnostic dependency verification. Each plugin registers its package requirements; the framework runs unified health checks across all registered plugins.

### Usage

```typescript
@inject(HealthCheckFramework)
protected readonly healthFramework: HealthCheckFramework;

@postConstruct()
protected init(): void {
    this.healthFramework.registerHealthRequirements({
        id: 'my-plugin',
        name: 'My Plugin',
        packages: [
            { name: 'my-package', required: true },
            { name: 'optional-pkg', required: false, condaOnly: true }
        ]
    });
}
```

### API

| Method | Description |
|--------|-------------|
| `registerHealthRequirements(req)` | Register a plugin's package requirements |
| `getRequirements(pluginId)` | Get registered requirements for a plugin |
| `getAllRequirements()` | Get all registered requirements |
| `runHealthCheck(pluginId)` | Run health check for one plugin |
| `runAllHealthChecks()` | Run health checks for all plugins |

### Health Check Result

```typescript
interface UnifiedHealthReport {
    healthy: boolean;           // true if ALL plugins pass
    plugins: PluginHealthReport[];
}

interface PluginHealthReport {
    pluginId: string;
    pluginName: string;
    healthy: boolean;           // true if all required packages found
    checks: HealthCheckItem[];
}
```

### Integration with Nuke Core

Health checks delegate actual package detection to `NukeCoreService` (from `nuke-core`). The framework does not know about conda, pip, or uv — it just asks nuke-core "are these packages available?" and formats the result.

---

## PythonCommandHelper

**File:** `src/node/services/python-command-helper.ts`

The single point of contact for all Python operations on the backend. Detects interpreters, executes scripts, and parses JSON output.

### Usage

```typescript
@inject(PythonCommandHelper)
protected readonly pythonHelper: PythonCommandHelper;

async runAnalysis(filePath: string): Promise<MyResult> {
    // Detect Python with required packages
    const python = await this.pythonHelper.detectPython(MY_REQUIREMENTS);
    
    // Execute a script and parse JSON output
    const result = await this.pythonHelper.executeScriptJson<MyResult>(
        'my_script.py',
        ['analyze', filePath],
        { requirements: MY_REQUIREMENTS }
    );
    return result;
}
```

### API

| Method | Description |
|--------|-------------|
| `detectPython(requirements?, envs?)` | Find a Python with required packages |
| `detectPythonForBaseVisualizer(envs?)` | Shorthand for base viz requirements |
| `checkPackages(command, requirements?)` | Check if a specific Python has packages |
| `executeScript(path, args, options?)` | Run a script, return `{stdout, stderr, status}` |
| `executeScriptJson(path, args, options?)` | Run a script and parse stdout as JSON |
| `findScript(name)` | Resolve a script in `python/` directory |
| `getExtensionPath()` | Get root path of nuke-visualizer |

### Script Discovery

`findScript('my_script.py')` searches in this order:
1. `lib/python/my_script.py` (installed)
2. `src/python/my_script.py` (development)
3. Fallback relative paths from `__dirname`

Always use `findScript()` instead of hardcoding paths.

---

## PlotlyService

**File:** `src/browser/plotly/plotly-service.ts`

Displays interactive 2D plots in IDE-native widgets. Uses Plotly.js — no Python server needed.

### Usage

```typescript
@inject(PlotlyService)
protected readonly plotlyService: PlotlyService;

async showSpectrum(data: OpenMCSpectrumData): Promise<void> {
    const trace = PlotlyUtils.createSpectrumTrace(data, 'Flux Spectrum');
    const figure: PlotlyFigure = {
        data: [trace],
        layout: { xaxis: { type: 'log' }, yaxis: { type: 'log' } },
        title: 'Energy Spectrum'
    };
    await this.plotlyService.showPlot(figure, 'my-spectrum-widget');
}
```

### API

| Method | Description |
|--------|-------------|
| `showPlot(figure, widgetId?)` | Create or update a plot widget with the given figure |

### PlotlyFigure

```typescript
interface PlotlyFigure {
    data: Partial<Plotly.Data>[];
    layout: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    title?: string;
    id?: string;
}
```

### PlotlyUtils

**File:** `src/browser/plotly/plotly-utils.ts`

Helper namespace for converting domain data to Plotly traces:

| Function | Input | Output |
|----------|-------|--------|
| `createSpectrumTrace(data, name)` | `OpenMCSpectrumData` | Scatter trace with error bars |
| `createSpatialTrace(data, name)` | `OpenMCSpatialPlotData` | Scatter trace with error bars |
| `createMultiScoreTraces(data, type)` | `OpenMCMultiScoreData` | Array of traces |

---

## VisualizerWidget

**File:** `src/browser/visualizer-widget.tsx`

The standard iframe-based widget for Python-rendered visualizations (Trame, Dash, etc.).

### Usage

```typescript
// Create via WidgetFactory
const widget = await this.widgetManager.getOrCreateWidget(
    VisualizerWidget.ID,
    { uri: fileUri.toString(), id: 'my-prefix-' + filePath }
) as VisualizerWidget;

// Set the server URL once the Python server is ready
widget.setServerUrl('http://127.0.0.1:8080', 8080);
```

### Key Properties & Methods

| Member | Description |
|--------|-------------|
| `static ID` | Widget type identifier (`nuke-visualizer.widget`) |
| `setUri(uri, volumeId?)` | Associate a file and update the widget ID |
| `setServerUrl(url, port)` | Point the iframe to a running server |
| `getServerPort()` | Get the current server port |
| `loadFile(uri)` | Full lifecycle: start server, convert if needed, set URL |
| `static onServerStop(port)` | Static callback when any server stops |

### States

The widget renders different UI based on state:

- **Empty:** Shows "No Visualization Loaded" with a browse button
- **Loading:** Animated spinner with status message
- **Warning:** Yellow banner (non-fatal issues like spatial mismatch)
- **Error:** Red banner with retry button
- **Active:** iframe showing the Python server UI

### Multi-Instance

VisualizerWidget is bound with `inTransientScope()` so each tab gets a fresh instance. The widget ID is derived from the file path to prevent duplicates:

```typescript
widget.id = `${VisualizerWidget.ID}:${filePath}`;
```

---

## NukeCoreService

**Not defined in nuke-visualizer** — imported from `nuke-core`.

The frontend counterpart to `PythonCommandHelper`. Provides:

| Event | Fires When |
|-------|-----------|
| `onEnvironmentChanged` | User switches Python env |
| `onEnvironmentFallback` | Fallback env is used because primary lacks packages |

Plugins should listen to these events and clear cached data when the environment changes:

```typescript
this.nukeCoreService.onEnvironmentChanged(event => {
    this.clearStatepoint();
    this.messageService.info('Environment changed — reload your data.');
});
```

---

## Summary: Which Service Do I Need?

| Task | Service |
|------|---------|
| Check if Python packages are installed | `HealthCheckFramework` |
| Run a Python script | `PythonCommandHelper` |
| Show a 2D chart | `PlotlyService` |
| Embed a Python server UI | `VisualizerWidget` |
| React to env changes | `NukeCoreService` |
| Log to output channel | `OutputChannelManager` (Theia) |
| Show toast notifications | `MessageService` (Theia) |
