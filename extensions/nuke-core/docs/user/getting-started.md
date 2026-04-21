# Getting Started with Nuke Core

This guide walks you through first-time setup: configuring your Python environment, understanding the status bar, and running your first health check.

---

## Prerequisites

Before you begin, you need a Python installation on your system.

| Requirement | Required? | Notes |
|-------------|-----------|-------|
| Python 3.8+ | Yes | System Python, pyenv, or any managed installation |
| Conda or Mamba | Recommended | For environment creation and conda-only packages (e.g., `paraview`) |
| UV | Optional | Significantly faster pip installs if available |

> **Tip:** If you don't have Python installed yet, [Miniforge](https://github.com/conda-forge/miniforge) is the easiest way to get both Python and conda on Linux/macOS/Windows.

---

## Step-by-Step Setup

### 1. Open NukeIDE Settings

1. Go to **File → Preferences → Settings** (or press `Ctrl+,`).
2. In the search box, type **"Nuke Utils"**.

---

### 2. Configure Your Python Path

Set at least one of the following:

| Setting | What to enter | Example |
|---------|---------------|---------|
| `nuke.pythonPath` | Full path to a Python executable | `/home/user/.conda/envs/openmc/bin/python` |
| `nuke.condaEnv` | Name of an existing conda environment | `openmc` |

> **Tip:** You only need to set **one** of these. If both are set, `nuke.pythonPath` takes priority.

**How to find your Python path:**

```bash
# If using conda
which python
# or
conda run -n myenv which python

# If using pyenv
pyenv which python

# If using system Python
python3 -c "import sys; print(sys.executable)"
```

---

### 3. Understand the Status Bar

Nuke Core shows the active Python environment in the bottom status bar.

| Indicator | Meaning |
|-----------|---------|
| 🐍 `conda: openmc` | Active conda environment named `openmc` |
| 🐍 `venv: .venv` | Active virtual environment in workspace |
| 🐍 `system: 3.11` | System Python (version 3.11) |
| ⚠️ (no label) | Python not configured — click to set up |

**Click the status bar item to:**
- **Switch environment** — pick from grouped list (Conda, Venv, Other)
- **Open actions menu** — Terminal, Install Packages, Copy Python Path

#### Status Bar Visibility

Control when the status bar appears with `nuke.showStatusBar`:

| Mode | Behavior | Best for |
|------|----------|----------|
| `auto` (default) | Shows only when environment is **not** configured; hides once set up | Using alongside MS Python extension |
| `always` | Always visible | Prefer quick-click environment switching |
| `never` | Hidden; use Command Palette only | Minimal UI preference |

> **Tip:** Set to `"auto"` if you also use the Microsoft Python extension. This avoids duplicate status bar items.

---

### 4. Run Your First Health Check

Verify everything is working:

1. Open the **Command Palette** (`Ctrl+Shift+P` or `F1`).
2. Type **"Nuke: Run Health Check"** and press Enter.
3. Check the **"Nuke Core"** output channel for results:
   - ✓ Green checks = ready to go
   - ✗ Red crosses = follow the suggested fixes

**Default checks include:**
- Configured Python environment availability
- Conda / Mamba availability
- UV availability
- Active environment status

> **Tip:** You can also run `Nuke: Validate Configuration` for a quick settings-only check, or `Nuke: Show Diagnostics` for full system details.

---

### 5. Set OpenMC Cross-Sections (Optional)

If you work with OpenMC, set the path to your cross-sections library:

1. In **Settings → Nuke Utils**, find `nuke.openmcCrossSections`.
2. Enter the full path to your `cross_sections.xml` file.

**Example:**

```
/home/user/nuclear-data/cross_sections.xml
```

> **Tip:** You can also set `nuke.openmcChainFile` if you run depletion simulations.

---

## Quick Reference: Your First Workflow

| Step | Action | Where |
|------|--------|-------|
| 1 | Install Python / conda | Your OS package manager or [miniforge](https://github.com/conda-forge/miniforge) |
| 2 | Open Settings (`Ctrl+,`) | `File → Preferences → Settings` |
| 3 | Set `nuke.pythonPath` or `nuke.condaEnv` | Search "Nuke Utils" |
| 4 | Run health check | `Ctrl+Shift+P` → "Nuke: Run Health Check" |
| 5 | Check status bar | Bottom of the window — should show your environment |
| 6 | (Optional) Set cross-sections path | `nuke.openmcCrossSections` in Settings |

---

## Next Steps

- [Manage environments](environment-management.md) — switch, create, delete, and auto-detect
- [Install packages](package-installation.md) — pip, uv, conda with live terminal output
- [Troubleshoot issues](troubleshooting.md) — fixes for common problems
