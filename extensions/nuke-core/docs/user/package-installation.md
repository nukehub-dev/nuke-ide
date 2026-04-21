# Package Installation

Install Python packages directly from NukeIDE with live terminal output, automatic package manager selection, and support for custom channels and indexes.

---

## Installing Packages via Command Palette

1. Open the **Command Palette** (`Ctrl+Shift+P` or `F1`).
2. Run **"Nuke: Install Package"**.
3. Enter the package name(s), separated by spaces (e.g., `openmc numpy scipy`).
4. Select the **package manager**:
   - **pip** — standard Python package installer
   - **conda** — for conda-only packages or conda environments
5. A terminal opens with **live output** showing download and install progress.

> **Tip:** Nuke Core automatically resolves the Python path from your currently selected environment, so you never hit PEP 668 "externally-managed environment" errors.

---

## Package Manager Selection

| Manager | When to Use | Fallback Chain |
|---------|-------------|----------------|
| **pip** | General Python packages; non-conda environments | uv → pip |
| **conda** | Conda-only packages (e.g., `paraview`, `moose`); conda envs | mamba → conda |

**Automatic behavior:**
- If you select **conda** but mamba is available, Nuke Core uses `mamba install` for faster solving.
- If you select **pip** and `uv` is installed, Nuke Core uses `uv pip install` for significantly faster installs.
- If the preferred tool fails, Nuke Core falls back to the next available option.

> **Tip:** You don't need to decide up front. The picker shows all options, and Nuke Core handles the rest.

---

## UV Support

[UV](https://github.com/astral-sh/uv) is a Rust-based Python package installer that is 10–100× faster than pip.

| UV Available? | Behavior |
|---------------|----------|
| ✅ Yes | `uv pip install <package>` is used automatically for pip installs |
| ❌ No | Falls back to standard `pip install` |

No configuration is required — Nuke Core detects `uv` in your `PATH` and uses it transparently.

---

## Live Terminal Output

All package installations run in a visible terminal widget:

- **See progress in real time** — downloads, dependency resolution, compilation
- **Catch errors immediately** — full stderr is visible if something fails
- **Handle interactive prompts** — conda solves that ask for confirmation work correctly

> **Tip:** The terminal title reflects what is being installed (e.g., "Install openmc, numpy").

---

## Installing Into Specific Environments

By default, packages install into your **currently selected** environment. To target a different one:

1. Run **"Nuke: Environment Actions"**.
2. Select the target environment.
3. Choose **"Install Packages"**.
4. Enter package names and proceed as usual.

> **Tip:** This is useful when you want to install into a secondary environment without switching your main workspace environment.

---

## Custom Channels and Indexes

### Global Defaults (Settings)

Set once in **Settings → Nuke Utils** and they apply to all installs:

| Setting | Purpose | Example |
|---------|---------|---------|
| `nuke.condaChannels` | Comma-separated conda channels | `conda-forge,nvidia` |
| `nuke.pipExtraIndexUrl` | Extra pip index for private packages | `https://pkgs.dev.azure.com/.../simple` |

### Per-Install Override

When installing via "Nuke: Install Package", Nuke Core uses the settings above automatically. For advanced use (e.g., from an extension), you can also specify channels or indexes per-install.

**Example:** Install PyTorch with CUDA from custom channels

```bash
# Equivalent manual command
conda install -c pytorch -c nvidia pytorch cuda-toolkit
```

In Nuke Core, ensure `nuke.condaChannels` includes `pytorch,nvidia,conda-forge` before running the install.

---

## Health Check Integration

Health checks can verify that specific packages are present and suggest installation when missing.

1. Run **"Nuke: Run Health Check"**.
2. If packages are missing, the output channel shows:
   - Which packages are absent
   - Suggested install commands (respecting `condaOnly` flags)
3. Run the suggested **"Nuke: Install Package"** command to fix.

> **Tip:** Extensions like `openmc-studio` and `nuke-visualizer` automatically run health checks for their required packages and prompt you to install missing ones.

---

## Summary: Quick Commands

| Goal | Command |
|------|---------|
| Install a package | `Ctrl+Shift+P` → "Nuke: Install Package" |
| Install into a specific env | `Ctrl+Shift+P` → "Nuke: Environment Actions" → select env → "Install Packages" |
| Use fastest installer | Install `uv` in your environment — Nuke Core picks it up automatically |
| Use conda-forge packages | Set `nuke.condaChannels` to `conda-forge` and select conda during install |
| Verify installed packages | `Ctrl+Shift+P` → "Nuke: Run Health Check" |
