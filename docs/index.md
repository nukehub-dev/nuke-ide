# NukeIDE Documentation

NukeIDE is an open-source Integrated Development Environment (IDE) for nuclear simulation and engineering. Built on the extensible Theia platform, it combines computational physics, reactor design, fusion energy, and radiation transport workflows in one workspace.

![NukeIDE workbench with the Nuke Tools sidebar and an OpenMC Studio project](images/workbench.png)

## Start Here

| Guide                                 | What it covers                                                    |
| ------------------------------------- | ----------------------------------------------------------------- |
| [Getting Started](getting-started.md) | Clone, install, and launch the browser or desktop app             |
| [Installation](installation.md)       | Prerequisites, Python environments, Docker, and production builds |
| [Extensions](extensions.md)           | What ships in the IDE and how to add an extension                 |
| [Architecture](architecture.md)       | Repository layout, Theia integration, and Python backends         |

## Extension Guides

| Extension           | Description                                                        | Docs                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Nuke Core**       | Python environment, package management, and the Nuke Tools sidebar | [User Guide](../extensions/nuke-core/docs/user/getting-started.md) · [Dev Guide](../extensions/nuke-core/docs/dev/index.md)                                                                |
| **Nuke Visualizer** | 3D/2D nuclear data visualization                                   | [User Guide](../extensions/nuke-visualizer/docs/user/getting-started.md) · [Dev Guide](../extensions/nuke-visualizer/docs/dev/index.md)                                                    |
| **OpenMC Studio**   | No-code OpenMC simulation workspace                                | [User Guide](../extensions/openmc-studio/docs/user/getting-started.md) · [Dev Guide](../extensions/openmc-studio/docs/dev/index.md)                                                        |
| **Nuke CAD**        | Parametric CAD, meshing, DAGMC export, and FEM                     | [User Guide](../extensions/nuke-cad/docs/user/getting-started.md) · [GUI Modeler](../extensions/nuke-cad/docs/user/gui-modeler.md) · [Dev Guide](../extensions/nuke-cad/docs/dev/index.md) |

The full extension catalogue, including utility extensions, is in [Extensions](extensions.md).
