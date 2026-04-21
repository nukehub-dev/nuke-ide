# Environment Management

Nuke Core automatically discovers Python environments across your system and lets you switch, create, and delete them without leaving the IDE.

---

## Supported Environment Types

| Type | Auto-Detected? | Creation Supported? | Notes |
|------|----------------|---------------------|-------|
| **Conda** | Yes | Yes | Anaconda, Miniconda, Miniforge, Mambaforge; includes `~/.conda/envs/` |
| **Mamba** | Yes (as conda) | Yes | Faster solver; preferred over conda when available |
| **Venv / Virtualenv** | Yes | Yes (venv only) | Discovered in workspace and standard locations |
| **Poetry** | Yes | No | Discovered via `poetry env list --full-path` |
| **Pyenv** | Yes | No | Discovered via `pyenv versions --bare` |
| **System Python** | Yes | No | Linux/macOS `/usr/bin/python*`, Windows Python launcher |

> **Tip:** Nuke Core scans all standard installation locations and environment variables (`CONDA_EXE`, `PATH`, etc.) so you rarely need to configure paths manually.

---

## Switching Environments

### Via Status Bar

1. Click the **🐍 environment indicator** in the bottom status bar.
2. Select **"Switch Environment"** from the menu.
3. Pick an environment from the grouped list:
   - **Conda** — all conda/mamba environments
   - **Venv** — workspace and system virtual environments
   - **Other** — poetry, pyenv, system Python

### Via Command Palette

1. Open the Command Palette (`Ctrl+Shift+P` or `F1`).
2. Run **"Nuke: Switch Environment"**.
3. Select the environment you want.

### Environment Actions

For more options on a specific environment, run **"Nuke: Environment Actions"**:

| Action | What it does |
|--------|--------------|
| Switch | Activate the selected environment |
| Open Terminal | Launch a terminal with the environment activated |
| Install Packages | Open the package installer targeting this environment |
| Copy Python Path | Copy the executable path to your clipboard |
| Delete | Remove the environment (if deletable) |

> **Tip:** Right-clicking the status bar item also opens the actions menu for the current environment.

---

## Creating New Environments

### Conda Environment

1. Run **"Nuke: Create Environment"** from the Command Palette.
2. Select **"conda"** as the type.
3. Enter a **name** for the environment (e.g., `openmc`).
4. Choose a **Python version** (e.g., `3.11`).
5. (Optional) Add extra packages or custom channels.
6. A terminal opens with **live output** while the environment is created.

> **Tip:** Mamba is used automatically if installed (faster solving). Nuke Core falls back to conda if mamba is not available.

### Venv Environment

1. Run **"Nuke: Create Environment"**.
2. Select **"venv"** as the type.
3. Choose a location:
   - **Workspace root** — creates `.venv/` in your project
   - **Custom path** — specify any directory
4. A terminal opens with live output during creation.

> **Note:** If a venv already exists at the chosen location, Nuke Core warns you and offers to switch to it instead.

---

## Deleting Environments

1. Run **"Nuke: Delete Environment"** from the Command Palette.
2. Select the environment to delete.
3. **Type the environment name** to confirm deletion.

**What can be deleted:**

| Deletable? | Environment Types |
|------------|-------------------|
| ✅ Yes | Venvs, virtualenvs, and conda envs in `~/.nuke-ide/envs/` |
| ❌ No | System Python, pyenv, poetry, and base conda environments |

> **Warning:** Deletion is permanent. The type-to-confirm step prevents accidental removal.

---

## Workspace Auto-Detect

Nuke Core scans your workspace for common Python configuration files and suggests setup actions automatically.

| File Detected | Suggested Action |
|---------------|------------------|
| `environment.yml` / `environment.yaml` | Create a conda environment from the file |
| `requirements.txt` | Install dependencies via pip into the active environment |

**How it works:**
1. Open a workspace containing one of these files.
2. Nuke Core shows a notification suggesting the appropriate action.
3. Click **"Create Environment"** or **"Install Dependencies"** to proceed.
4. Commands run in a **live terminal** so you can watch progress.

> **Tip:** Dismissed prompts are remembered per-workspace (stored in `localStorage`) so you won't be nagged repeatedly.

---

## Summary: Common Tasks

| Task | Command / Action |
|------|------------------|
| Switch environment | Status bar click → "Switch Environment" or `Ctrl+Shift+P` → "Nuke: Switch Environment" |
| Open terminal in env | `Ctrl+Shift+P` → "Nuke: Environment Actions" → "Open Terminal" |
| Create conda env | `Ctrl+Shift+P` → "Nuke: Create Environment" → select conda |
| Create venv | `Ctrl+Shift+P` → "Nuke: Create Environment" → select venv |
| Delete env | `Ctrl+Shift+P` → "Nuke: Delete Environment" → type to confirm |
| Let workspace auto-detect | Just open a folder with `environment.yml` or `requirements.txt` |
