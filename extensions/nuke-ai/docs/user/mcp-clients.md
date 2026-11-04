# External MCP Clients

NukeIDE can expose a read-only MCP endpoint for external agents and desktop MCP clients. It is off by default and
only listens on `127.0.0.1`; NukeAI's own chat does not need it.

## Enable the endpoint

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **NukeAI: Enable MCP Endpoint**.
3. Accept the default port `3210` or enter another port between 1 and 65535.

NukeIDE generates a bearer token, writes `<configDir>/nuke-ai-mcp.json`, and turns on a separate-port external API
server bound to `127.0.0.1`. A notification shows the endpoint URL, the token, and a ready-to-paste client
configuration. Choose **Copy client config** to copy the JSON snippet to the clipboard.

```json
{
  "mcpServers": {
    "nuke-ide": {
      "type": "http",
      "url": "http://127.0.0.1:3210/nuke-ai-mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Treat the token like a password. It is stored in the IDE config directory, not in the workspace or repository. Running
the enable command again generates a new token and invalidates the old one. Use the disable command rather than editing
the `nuke.ai.mcp.*` preferences by hand: the backend reads the config file, not the preference, so the command removes
both.

## What clients can do

The catalog is read live from the open IDE for every MCP session. Tools appear only when their capability is enabled in
the current context, so a CAD tool appears after a CAD document is open. The OpenMC run-status tool is always listed
when OpenMC is available; it reports `running: false` when no run is active. `tools/list` can be empty until the IDE
frontend has opened and the relevant capabilities are active.

The endpoint may expose these read-only tools:

| Tool                              | What it reads                                                   |
| --------------------------------- | --------------------------------------------------------------- |
| `nuke_cad_summarize_document`     | CAD build counts, selection, and manifest coverage              |
| `nuke_cad_inspect_selection`      | Selected and hidden solids in the active CAD document           |
| `nuke_cad_diagnose_model`         | CAD build, manifest, selection, and geometry findings           |
| `nuke_openmc_summarize_project`   | OpenMC project name, entity counts, and run settings            |
| `nuke_openmc_summarize_materials` | Material ids, density, nuclide counts, and CAD provenance       |
| `nuke_openmc_summarize_tallies`   | Tally ids, scores, filters, and estimator settings              |
| `nuke_openmc_summarize_geometry`  | CSG entity ids, DAGMC volumes, and geometry findings            |
| `nuke_openmc_validate_project`    | Geometry, materials, settings, and tally validation             |
| `nuke_openmc_get_run_status`      | Active run state and log tail                                   |
| `nuke_openmc_diagnose_project`    | Project, environment, cross-section, and DAGMC triage           |
| `nuke_openmc_diagnose_run`        | Run log tail and classified lost-particle findings              |
| `nuke_viz_summarize_statepoint`   | Batches, k-effective, and tally metadata                        |
| `nuke_viz_diagnose_statepoint`    | Statepoint uncertainty and tally coverage findings              |
| `nuke_viz_capture_view`           | Active DAGMC viewport capture; MCP omits the inline image bytes |

Every tool advertises MCP annotations that mark it read-only, idempotent, and closed-world. The catalog is dynamic:
write, execute, and destructive capabilities are never exposed, and each tool uses the live input schema and, when
declared, the output schema from its owning extension. MCP results omit inline image data, so
`nuke_viz_capture_view` reports the capture and its limitations without transferring the image.

Resources:

- `nuke://context` — active workspace roots, CAD document, OpenMC project, and visualizer dataset.
- `nuke://cad/document` — the active CAD document summary.
- `nuke://openmc/project` — the active OpenMC project summary.
- `nuke://visualizer/dataset` — the active visualizer dataset summary.
- `nuke://skills/<name>` — one packaged NukeAI skill per discovered name.

Prompts:

- `nuke-workflow` describes the CAD → DAGMC → OpenMC → visualizer workflow and lists only the tools this session exposes.
- `nuke-diagnostics` triages CAD, OpenMC project/run, and statepoint findings with the exposed read-only diagnostic
  tools, prioritizing errors before warnings and info.

No export, import, run, edit, write, or delete action is exposed by this endpoint. The prompts perform no action.

## Limits

- At most 16 concurrent MCP sessions.
- A session idle for 30 minutes is closed automatically.
- At most 60 tool or resource calls per session in any 60-second window. Additional calls return an error instead of
  running.
- At most 24 tools are advertised in one session.
- The audit ring keeps the last 200 tool-call summaries in memory. It stores a redacted input hash/summary, never file
  or resource contents, and it is lost when the IDE backend restarts.

## Disable the endpoint

Run **NukeAI: Disable MCP Endpoint** from the Command Palette. NukeIDE turns the external API off, clears the token and
MCP port, and deletes the config file. Clients can no longer connect after the server stops; once the endpoint is
enabled again, clients still holding the old token receive `401`. If the external API is running with a missing or
disabled config file, the endpoint answers `404`.

## Troubleshooting

| Response | Meaning                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `401`    | The `Authorization` header is missing or does not exactly match `Bearer <current token>`.                           |
| `403`    | The request carried an `Origin` header, came from a non-loopback address, or called a tool that is not exposed.     |
| `404`    | The endpoint is not enabled, the config file is missing or invalid, or the client sent an unknown `mcp-session-id`. |
| `503`    | The config file has no usable token, or 16 MCP sessions are already open.                                           |

Other checks:

- **Port already in use** — run the enable command again and choose another port, or free the port and retry. The IDE
  log reports the external API server failure.
- **`tools/list` is empty** — the IDE frontend has not connected or no allowlisted capability is enabled yet. Open the
  IDE window and the relevant CAD document, OpenMC project, or dataset; start a new MCP session after the catalog
  changes.
- **`NukeIDE frontend is not connected.`** — the MCP tool call arrived before the IDE frontend opened its capability
  delegate channel. Keep the IDE window open; the backend cannot read CAD or project state without it.
- **`Rate limit exceeded`** — a session made more than 60 tool or resource calls in 60 seconds. Wait for the window to roll over;
  the excess calls are audited and were not executed.
- **No CAD summary** — open a CAD document in NukeCAD. The tool still returns `isError: true` with a clear message
  when no document is active.
- **Token lost** — run the enable command again; it replaces the old token and client configuration.
- **Changes do not take effect immediately** — the backend re-reads the config file within one second. A restart is not
  required.

## Automated smoke test

After `yarn build:browser`, run `yarn test:mcp`. The opt-in Playwright test enables the endpoint through the command,
connects a real MCP client, checks the read-only tool/resource/prompt catalog and the `401`/`403` responses, then
disables the endpoint again. It uses the local browser app's `~/.nuke-ide` config directory and temporarily changes the
user-scoped external API settings, so it is not part of the regular UI suite. It refuses to run when an MCP config
already exists, so it cannot overwrite a developer's current token.

For the implementation contract, see [External MCP](../dev/mcp.md).
