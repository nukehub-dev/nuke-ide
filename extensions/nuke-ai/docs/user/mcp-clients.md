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

The endpoint exposes one read-only tool, `nuke_cad_summarize_document`, for the active CAD document. It advertises MCP
annotations that mark it read-only, idempotent, and closed-world. Two resources are available:

- `nuke://context` — active workspace roots, CAD document, OpenMC project, and visualizer dataset.
- `nuke://cad/document` — the active CAD document summary.

One prompt, `nuke-workflow`, describes the CAD → DAGMC → OpenMC → visualizer workflow and names the capability IDs
involved. The prompt performs no action.

No export, import, run, write, or delete action is exposed by this endpoint.

## Disable the endpoint

Run **NukeAI: Disable MCP Endpoint** from the Command Palette. NukeIDE turns the external API off, clears the token and
MCP port, and deletes the config file. Clients can no longer connect after the server stops; once the endpoint is
enabled again, clients still holding the old token receive `401`. If the external API is running with a missing or
disabled config file, the endpoint answers `404`.

## Troubleshooting

| Response | Meaning                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `401`    | The `Authorization` header is missing or does not exactly match `Bearer <current token>`.                           |
| `403`    | The request carried an `Origin` header. External MCP clients must be native clients, not browser pages.             |
| `404`    | The endpoint is not enabled, the config file is missing or invalid, or the client sent an unknown `mcp-session-id`. |
| `503`    | The config file has no usable token, or 16 MCP sessions are already open.                                           |

Other checks:

- **Port already in use** — run the enable command again and choose another port, or free the port and retry. The IDE
  log reports the external API server failure.
- **`NukeIDE frontend is not connected.`** — the MCP tool call arrived before the IDE frontend opened its capability
  delegate channel. Keep the IDE window open; the backend cannot read CAD state without it.
- **No CAD summary** — open a CAD document in NukeCAD. The tool still returns `isError: true` with a clear message
  when no document is active.
- **Token lost** — run the enable command again; it replaces the old token and client configuration.
- **Changes do not take effect immediately** — the backend re-reads the config file within one second. A restart is not
  required.

## Automated smoke test

After `yarn build:browser`, run `yarn test:mcp`. The opt-in Playwright test enables the endpoint through the command,
connects a real MCP client, checks the tool/resource/prompt catalog and the `401`/`403` responses, then disables the
endpoint again. It uses the local browser app's `~/.nuke-ide` config directory and temporarily changes the user-scoped
external API settings, so it is not part of the regular UI suite. It refuses to run when an MCP config already exists,
so it cannot overwrite a developer's current token.

For the implementation contract, see [External MCP](../dev/mcp.md).
