# NukeIDE

NukeIDE is an open-source Integrated Development Environment (IDE) specifically designed for nuclear simulation and engineering. Built on the extensible Theia platform, NukeIDE provides a robust and customizable environment for computational physics, reactor design, fusion energy, and radiation transport.

## Features

- **Integrated Development Environment**: A full-featured IDE powered by Theia, providing a modern code editing experience.
- **Extensible Architecture**: Easily extendable with custom extensions for specialized nuclear engineering tasks.
- **PWA Support**: Progressive Web Application (PWA) capabilities for enhanced web-based deployment.
- **Essential Extensions**: Includes core extensions for common nuclear simulation workflows.
- **Cross-Platform**: Supports both browser-based and Electron-based desktop deployments.

## Getting Started

To set up and run NukeIDE locally, follow these steps:

### Prerequisites

- Node.js (>=18)
- Yarn (>=1.7.0 <2)

### Installation

1. **Clone the repository:**

    ```bash
    git clone https://github.com/nukehub-dev/nuke-ide.git
    cd nuke-ide
    ```

2. **Install dependencies and build the project:**

    ```bash
    yarn
    ```

    This command will install all root dependencies, hoist them, and then use Lerna to install dependencies and run `prepare` scripts for all workspaces (applications and extensions).

3. **Download Theia plugins:**

    ```bash
    yarn download:plugins
    ```

    This command downloads pre-configured Theia plugins required for NukeIDE.

## Running the Application

### Browser Application

To start the browser-based version of NukeIDE:

```bash
yarn start:browser
```

### Electron Application

To start the Electron-based desktop application:

```bash
yarn start:electron
```

## Building the Project

### Build All

To build all applications and extensions:

```bash
lerna run build
```

### Build Specific Applications

- **Browser:**

    ```bash
    yarn build:browser
    ```

- **Electron:**

    ```bash
    yarn build:electron
    ```

### Build Individual Extensions

Navigate to the extension directory (e.g., `extensions/nuke-essentials`) and run:

```bash
yarn build
# or
tsc
```

## Project Structure

- `applications/`: Contains the different NukeIDE application builds (browser, electron, docker).
- `extensions/`: Houses all the custom Theia extensions developed for NukeIDE.
- `resources/`: Static assets like logos and HTML preload templates.
- `configs/`: Shared configuration files.

## Contributing

We welcome contributions to NukeIDE! Please refer to our [GitHub Issues](https://github.com/nukehub-dev/nuke-ide/issues) for ongoing tasks and discussions. For contribution guidelines, please see the repository's contributing document (if available).

## License

NukeIDE is released under the [BSD-2-Clause License](https://opensource.org/licenses/BSD-2-Clause).
