# DI Wiring

`nuke-visualizer` uses **InversifyJS** (via Theia) for dependency injection. Understanding how the container modules work is essential for adding widgets, services, or entire plugins.

---

## Frontend Module

**File:** `src/browser/visualizer-frontend-module.ts`

This is the entry point for the browser side. It exports a `ContainerModule` that tells Inversify how to instantiate everything.

### Key Bindings

#### 1. Shared Services

```typescript
bind(PlotlyService).to(PlotlyServiceImpl).inSingletonScope();
bind(HealthCheckFramework).toSelf().inSingletonScope();
bindVisualizerPreferences(bind);
```

- `PlotlyService` — bound to implementation, one instance for the whole app.
- `HealthCheckFramework` — bound to itself, singleton.
- Preferences — bound via helper function.

#### 2. Backend RPC Proxy

```typescript
bind(VisualizerBackendService).toDynamicValue(ctx => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
    const outputChannelManager = ctx.container.get(OutputChannelManager);
    
    const client: VisualizerClient = {
        log: (msg) => { /* ... */ },
        error: (msg) => { /* ... */ },
        warn: (msg) => { /* ... */ },
        onServerStop: (port) => VisualizerWidget.onServerStop(port)
    };
    
    return connectionProvider.createProxy<VisualizerBackendService>(
        VISUALIZER_BACKEND_PATH, client
    );
}).inSingletonScope();
```

The proxy is a **dynamic value** because it needs to capture the `client` object at creation time. The `client` handles log streaming from the backend.

#### 3. Widget Factory

```typescript
bind(VisualizerWidget).toSelf().inTransientScope();
bind(WidgetFactory).toDynamicValue(context => ({
    id: VisualizerWidget.ID,
    createWidget: (options?) => {
        const widget = context.container.get<VisualizerWidget>(VisualizerWidget);
        if (options?.uri) widget.setUri(new URI(options.uri), options.volumeId);
        if (options?.id) widget.id = options.id;
        return widget;
    },
})).inSingletonScope();
```

- Widget class: `inTransientScope()` — fresh instance per tab.
- Widget factory: `inSingletonScope()` — one factory that creates instances.
- `options` can carry `uri` (file path) and `id` (custom widget ID).

#### 4. Contribution Pattern

```typescript
bindViewContribution(bind, VisualizerContribution);
bind(OpenHandler).toService(VisualizerContribution);
```

`bindViewContribution` is a Theia helper that binds a class as:
- `FrontendApplicationContribution`
- `CommandContribution`
- `MenuContribution`
- `KeybindingContribution`

`OpenHandler` lets the contribution intercept file double-clicks.

#### 5. OpenMC Plugin Bindings

The OpenMC plugin adds many bindings:

```typescript
// Backend proxy (same pattern as base)
bind(OpenMCBackendService).toDynamicValue(ctx => { /* ... */ }).inSingletonScope();

// Frontend services
bind(OpenMCService).toSelf().inSingletonScope();
bind(OpenMCWidgetFactory).toSelf().inSingletonScope();
bind(OpenMCFileDiscoveryService).toSelf().inSingletonScope();

// Contribution
bind(OpenMCContribution).toSelf().inSingletonScope();
bind(FrontendApplicationContribution).toService(OpenMCContribution);
bind(CommandContribution).toService(OpenMCContribution);
bind(MenuContribution).toService(OpenMCContribution);
bind(OpenHandler).toService(OpenMCContribution);

// Dedicated command contributions
bind(OpenMCStatepointCommands).toSelf().inSingletonScope();
bind(CommandContribution).toService(OpenMCStatepointCommands);
// ... (Geometry, Plotting, Depletion commands)

// Widget factories (one per widget type)
bind(OpenMCPlotWidget).toSelf().inTransientScope();
bind(WidgetFactory).toDynamicValue(ctx => ({
    id: OpenMCPlotWidget.ID,
    createWidget: (options?) => { /* ... */ }
})).inSingletonScope();

// Sidebar view contributions
bindViewContribution(bind, XSPlotViewContribution);
bind(FrontendApplicationContribution).toService(XSPlotViewContribution);
```

---

## Backend Module

**File:** `src/node/visualizer-backend-module.ts`

The backend module binds RPC handlers and backend services.

### Base Visualizer Backend

```typescript
bind(VisualizerBackendServiceImpl).toSelf().inSingletonScope();
bind(VisualizerBackendService).toService(VisualizerBackendServiceImpl);
bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler<VisualizerClient>(VISUALIZER_BACKEND_PATH, client => {
        const server = ctx.container.get<VisualizerBackendServiceImpl>(VisualizerBackendServiceImpl);
        server.setClient(client);
        return server;
    })
).inSingletonScope();
```

- `VisualizerBackendServiceImpl` is the actual implementation.
- `VisualizerBackendService` is the interface token.
- `RpcConnectionHandler` creates a new handler per WebSocket connection. It injects the `client` so the backend can stream logs.

### OpenMC Backend

```typescript
bind(OpenMCBackendServiceImpl).toSelf().inSingletonScope();
bind(OpenMCBackendService).toService(OpenMCBackendServiceImpl);
bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler<VisualizerClient>(OPENMC_BACKEND_PATH, client => {
        const server = ctx.container.get<OpenMCBackendServiceImpl>(OpenMCBackendServiceImpl);
        server.setClient(client);
        return server;
    })
).inSingletonScope();
```

---

## Scope Reference

| Scope | Meaning | When to Use |
|-------|---------|-------------|
| `inSingletonScope()` | One instance per container | Services, frameworks, factories |
| `inTransientScope()` | New instance every time | Widgets (so each tab is independent) |
| `toDynamicValue()` | Factory function | RPC proxies that need client setup |
| `toConstantValue()` | Static value | No-op contributions, config objects |

---

## Common Patterns

### Adding a New Widget

```typescript
// 1. Define the widget class
@injectable()
export class MyWidget extends ReactWidget {
    static readonly ID = 'my-widget';
    // ...
}

// 2. Bind in frontend module
bind(MyWidget).toSelf().inTransientScope();
bind(WidgetFactory).toDynamicValue(ctx => ({
    id: MyWidget.ID,
    createWidget: () => ctx.container.get(MyWidget)
})).inSingletonScope();

// 3. Open it
const widget = await widgetManager.getOrCreateWidget(MyWidget.ID);
await shell.addWidget(widget, { area: 'main' });
```

### Adding a New Command

```typescript
// 1. Define command
export namespace MyCommands {
    export const DO_STUFF = { id: 'my.doStuff', label: 'Do Stuff' };
}

// 2. Implement CommandContribution
@injectable()
export class MyCommandContribution implements CommandContribution {
    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(MyCommands.DO_STUFF, {
            execute: () => { /* ... */ }
        });
    }
}

// 3. Bind
bind(MyCommandContribution).toSelf().inSingletonScope();
bind(CommandContribution).toService(MyCommandContribution);
```

### Adding a New Menu Item

```typescript
// In the same CommandContribution or a separate MenuContribution
registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(NukeVisualizerMenus.VISUALIZER, {
        commandId: MyCommands.DO_STUFF.id,
        label: 'Do Stuff',
        order: 'a'
    });
}
```

---

## Troubleshooting DI Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No matching bindings found" | Symbol not bound in module | Add `bind(MyService).toSelf()` |
| Widget not created | WidgetFactory missing or wrong ID | Check `id` matches `WidgetFactory` |
| Command not in palette | `CommandContribution` not bound | `bind(CommandContribution).toService(...)` |
| RPC call fails | Path mismatch or handler not bound | Verify `MY_BACKEND_PATH` matches both sides |
| Singleton state leaks | Widget in singleton scope | Use `inTransientScope()` for widgets |
