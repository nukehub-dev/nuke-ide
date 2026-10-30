# Environment Management

Nuke Core automatically discovers Python environments across your system and lets you switch, create, and delete them without leaving the IDE.

---

## Supported Environment Types

| Type                  | Auto-Detected? | Creation Supported? | Notes                                                                 |
| --------------------- | -------------- | ------------------- | --------------------------------------------------------------------- |
| **Conda**             | Yes            | Yes                 | Anaconda, Miniconda, Miniforge, Mambaforge; includes `~/.conda/envs/` |
| **Mamba**             | Yes (as conda) | Yes                 | Faster solver; preferred over conda when available                    |
| **Venv / Virtualenv** | Yes            | Yes (venv only)     | Discovered in workspace and standard locations                        |
| **Poetry**            | Yes            | No                  | Discovered via `poetry env list --full-path`                          |
| **Pyenv**             | Yes            | No                  | Discovered via `pyenv versions --bare`                                |
| **System Python**     | Yes            | No                  | Linux/macOS `/usr/bin/python*`, Windows Python launcher               |

> **Tip:** Nuke Core scans all standard installation locations and environment variables (`CONDA_EXE`, `PATH`, etc.) so you rarely need to configure paths manually.

---

## Switching Environments

### Via Status Bar

1. Click the **🐍 environment indicator** in the bottom status bar.
2. Pick an environment from the grouped list:
   - **Conda** — all conda/mamba environments
   - **Venv** — workspace and system virtual environments
   - **Other** — poetry, pyenv, system Python
3. Selecting a different environment switches to it. Selecting the currently active one opens its actions instead.

### Via Command Palette

1. Open the Command Palette (`Ctrl+Shift+P` or `F1`).
2. Run **"Nuke: Switch Environment"**.
3. Select the environment you want.

### Environment Actions

For more options on a specific environment, run **"Nuke: Environment Actions"**:

| Action                                         | What it does                                          |
| ---------------------------------------------- | ----------------------------------------------------- |
| Re-select                                      | Activate the selected environment                     |
| Open Terminal (conda run)                      | Launch a terminal with a conda environment activated  |
| Install Packages                               | Open the package installer targeting this environment |
| Update from environment.yml / requirements.txt | Re-apply the workspace file when present              |
| Copy Python Path                               | Copy the executable path to your clipboard            |
| Delete Environment                             | Remove the environment (if deletable)                 |

> **Tip:** Clicking the active environment in the status-bar picker opens this actions menu. The status bar has no separate right-click menu.

---

## Creating New Environments

### Conda Environment

1. Run **"Nuke: Create Environment"** from the Command Palette.
2. Select **"Conda Environment"** as the type.
3. Enter a **name** for the environment (e.g., `openmc`).
4. Enter an optional **Python version** (e.g., `3.13`).
5. A terminal opens with **live output** while the environment is created.

> **Tip:** Mamba is used automatically if installed (faster solving). Nuke Core falls back to conda if mamba is not available.

### Venv Environment

1. Run **"Nuke: Create Environment"**.
2. Select **"Virtualenv (venv)"** as the type.
3. Enter the environment name and an optional Python executable path. Nuke Core creates the venv in the workspace root (`.venv/`).
4. A terminal opens with live output during creation.

> **Note:** If `.venv` already exists, Nuke Core warns you and offers to switch to it instead.

---

## Deleting Environments

1. Run **"Nuke: Delete Environment"** from the Command Palette.
2. Select the environment to delete.
3. **Type the environment name** to confirm deletion.

**What can be deleted:**

| Deletable? | Environment Types                                         |
| ---------- | --------------------------------------------------------- |
| ✅ Yes     | Venvs, virtualenvs, and conda envs in `~/.nuke-ide/envs/` |
| ❌ No      | System Python, pyenv, poetry, and base conda environments |

> **Warning:** Deletion is permanent. The type-to-confirm step prevents accidental removal.

---

## Workspace Auto-Detect

Nuke Core scans your workspace for common Python configuration files and suggests setup actions automatically.

| File Detected                          | Suggested Action                                          |
| -------------------------------------- | --------------------------------------------------------- |
| `environment.yml` / `environment.yaml` | Create or update a conda environment from the file        |
| `requirements.txt`                     | Install dependencies with pip into the active environment |

**How it works:**

1. Open a workspace containing one of these files.
2. Nuke Core shows a notification with the applicable action: **Create from environment.yml**, **Update from environment.yml**, **Install requirements.txt**, or **Install with pip**.
3. Commands run in a **live terminal** so you can watch progress.

> **Tip:** Dismissed prompts are remembered per-workspace (stored in `localStorage`) so you won't be nagged repeatedly.

---

## Summary: Common Tasks

| Task                      | Command / Action                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Switch environment        | Status bar click → "Switch Environment" or `Ctrl+Shift+P` → "Nuke: Switch Environment" |
| Open terminal in env      | `Ctrl+Shift+P` → "Nuke: Environment Actions" → "Open Terminal"                         |
| Create conda env          | `Ctrl+Shift+P` → "Nuke: Create Environment" → select conda                             |
| Create venv               | `Ctrl+Shift+P` → "Nuke: Create Environment" → select venv                              |
| Delete env                | `Ctrl+Shift+P` → "Nuke: Delete Environment" → type to confirm                          |
| Let workspace auto-detect | Just open a folder with `environment.yml` or `requirements.txt`                        |
