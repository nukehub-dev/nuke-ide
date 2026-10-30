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

| Extension           | Description                                                        | Docs                                                                                                                        |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Nuke Core**       | Python environment, package management, and the Nuke Tools sidebar | [User Guide](/nuke-core/user/getting-started) · [Dev Guide](/nuke-core/dev/index)                                           |
| **Nuke Visualizer** | 3D/2D nuclear data visualization                                   | [User Guide](/nuke-visualizer/user/getting-started) · [Dev Guide](/nuke-visualizer/dev/index)                               |
| **OpenMC Studio**   | No-code OpenMC simulation workspace                                | [User Guide](/openmc-studio/user/getting-started) · [Dev Guide](/openmc-studio/dev/index)                                   |
| **Nuke CAD**        | Parametric CAD, meshing, DAGMC export, and FEM                     | [User Guide](/nuke-cad/user/getting-started) · [GUI Modeler](/nuke-cad/user/gui-modeler) · [Dev Guide](/nuke-cad/dev/index) |

The full extension catalogue, including utility extensions, is in [Extensions](extensions.md).
