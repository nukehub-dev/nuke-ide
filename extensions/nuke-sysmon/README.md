# Nuke System Monitor Extension

Real-time system resource monitor for NukeIDE.

## Overview

`nuke-sysmon` displays CPU, memory, disk, and network usage inside the IDE. It is useful for monitoring resource consumption during heavy simulations or visualization tasks.

## Features

- **CPU Monitor** — Real-time CPU usage percentage with historical graph
- **Memory Monitor** — RAM usage and available memory
- **Disk Monitor** — Disk space usage per mounted volume
- **Network Monitor** — Network I/O statistics
- **Historical Graphs** — Trend view of resource usage over time

## Opening the Monitor

Open the **System Monitor** widget via:

- **Command Palette**: `Ctrl+Shift+P` → "System Monitor"
- **Status bar**: Click the system status indicator

## Configuration

Settings are available in **Settings → System Monitor**:

| Preference               | Description                           | Default |
| ------------------------ | ------------------------------------- | ------- |
| `sysmon.refreshInterval` | Data refresh interval in milliseconds | `2000`  |
| `sysmon.showInStatusBar` | Show compact status in the status bar | `true`  |

## License

BSD-2-Clause
