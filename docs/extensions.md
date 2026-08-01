# Extensions

NukeIDE's functionality is delivered through Theia extensions. Each extension adds commands, views, widgets, and backend services to the IDE.

## Core Extensions

### Nuke Core

The foundational extension for Python environment management and shared infrastructure.

- Auto-detect, create, and switch Python environments (conda, venv, poetry, pyenv)
- Install packages with live terminal output (pip, uv, conda)
- Run health checks and diagnostics
- Context-aware status bar with quick-switcher
- Workspace auto-detection for `environment.yml` and `requirements.txt`

[User Guide](/nuke-core/user/getting-started) · [Developer Guide](/nuke-core/dev/index)

---

### Nuke Visualizer

Advanced 3D and 2D visualization for nuclear engineering data.

**Plugins:**

- **Base Visualizer** — VTK, DAGMC (.h5m), STL, PLY, OBJ meshes
- **OpenMC Plugin** — Statepoints (incl. IFP kinetics), tallies, cross-sections, depletion results, geometry, materials, nuclear data browsing, and output viewers for particle tracks, collision tracks, weight windows, and random ray results

[User Guide](/nuke-visualizer/user/getting-started) · [Developer Guide](/nuke-visualizer/dev/index)

---

### OpenMC Studio

No-code graphical workspace for OpenMC Monte Carlo neutron transport simulations.

- Simulation dashboard: settings, sources, materials, depletion (with custom chain builder), variance reduction, random ray, and a readiness-checked run tab with kinetics (IFP)
- CSG builder and DAGMC editor (material overrides, depletion sync)
- Tally configurator with score catalog, filter builders, triggers, and derivatives
- Optimization framework: parameter sweeps and criticality (k-eff) search
- Volume calculation, native plotting (slice/voxel/ray-trace), and MGXS generator
- Simulation comparison and project management
- CAD import (STEP/IGES to DAGMC or CSG)

[User Guide](/openmc-studio/user/getting-started) · [Developer Guide](/openmc-studio/dev/index)

## Utility Extensions

| Extension               | Purpose                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **nuke-essentials**     | Common UI components, commands, and utilities shared across NukeIDE extensions                                               |
| **nuke-sysmon**         | System resource monitoring inside the IDE                                                                                    |
| **nuke-fileinfo**       | File properties and metadata viewer (MIME types, permissions, checksums, Git info)                                           |
| **nuke-docs**           | Native in-IDE documentation widget (Help → NukeIDE Documentation)                                                            |
| **nukelab-integration** | NukeLab gateway integration: account context, navigation, logout, app install, and interaction-gated idle-activity heartbeat |

## Adding a New Extension

1. Create a new folder under `extensions/<your-extension>`.
2. Add a `package.json` with Theia contribution metadata.
3. Implement frontend and/or backend contributions.
4. Add a `docs/` folder with user and developer guides.
5. Register the extension in `applications/browser/package.json` and `applications/electron/package.json`.

For more details, see the developer guides for [Nuke Visualizer](/nuke-visualizer/dev/adding-a-plugin) and [OpenMC Studio](/openmc-studio/dev/adding-a-widget).
