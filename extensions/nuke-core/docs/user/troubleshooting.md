# Troubleshooting Nuke Core

Common issues and how to fix them. If you're stuck after working through this guide, see the [Before You Ask](#before-you-ask-checklist) checklist.

---

## "Python not found" or "No Python environment configured"

**Symptoms:**

- Status bar shows ⚠️ or no environment label
- Health check fails at "Configured Python Environment"
- Commands like "Nuke: Install Package" warn about missing Python

**Fixes:**

1. **Check your settings.** Open `Settings → Nuke Utils` and verify that either `nuke.pythonPath` or `nuke.condaEnv` is set correctly.
2. **Run a health check.** `Ctrl+Shift+P` → "Nuke: Run Health Check" for specific failure details.
3. **Confirm the path exists.** In a terminal, run:
   ```bash
   ls -la $(which python)
   # or for conda
   conda env list
   ```
4. **Use auto-detect.** Run "Nuke: Switch Environment" — Nuke Core may find a valid environment automatically.

> **Tip:** You only need to set `nuke.pythonPath` **or** `nuke.condaEnv`, not both. If both are set, `pythonPath` wins.

---

## "Package installation failed"

**Symptoms:**

- Terminal shows red errors during install
- Package not available after install completes
- Network timeout or 404 errors

**Fixes:**

| Cause                | Fix                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Network / firewall   | Check your connection; try again. Corporate proxies may need `HTTP_PROXY` set.                                                        |
| Wrong channels       | Add the correct channel to `nuke.condaChannels` (e.g., `conda-forge,nvidia`).                                                         |
| Package not on conda | Select **pip** instead of conda for the install.                                                                                      |
| Permission denied    | Install into a user-owned environment (conda env or venv), not system Python.                                                         |
| PEP 668 error        | Nuke Core avoids this automatically by resolving the environment's Python path. If you see it, switch to a venv or conda environment. |

> **Tip:** Read the last few lines of the terminal output — the error message usually tells you exactly what went wrong.

---

## Status bar not showing

**Symptoms:**

- No 🐍 environment indicator at the bottom of the window
- Cannot click to switch environments

**Fixes:**

1. **Check `nuke.showStatusBar`.**
   - `auto` — hides once the environment is configured (intended behavior)
   - `never` — always hidden
   - `always` — forces it to show
2. **If using the MS Python extension**, set `nuke.showStatusBar` to `"auto"` or `"always"`. The MS extension may be taking status bar space.
3. **Reload the window** (`Ctrl+Shift+P` → "Developer: Reload Window") if you just changed the setting.

> **Tip:** Even when the status bar is hidden, all functionality is available via the Command Palette (`Ctrl+Shift+P`) under the "Nuke:" prefix.

---

## "Environment not detected"

**Symptoms:**

- "Nuke: Switch Environment" shows fewer environments than expected
- Your conda env or venv is missing from the list

**Fixes:**

1. **Verify the environment exists:**
   ```bash
   conda env list
   # or
   ls -la /path/to/your/.venv/bin/python
   ```
2. **Check standard paths.** Nuke Core scans common locations, but non-standard paths may be missed.
3. **Set it manually.** Use `nuke.pythonPath` (full path to the Python executable) or `nuke.condaEnv` (environment name) as a workaround.
4. **Restart NukeIDE** after installing a new environment — detection runs at startup and on demand.

> **Tip:** Workspace venvs (e.g., `./.venv`) are detected automatically when the workspace is opened.

---

## "Cross-sections error" (OpenMC)

**Symptoms:**

- OpenMC simulations fail with "cross sections not set"
- Health check warns about missing cross-sections path

**Fixes:**

1. **Set the path in Settings:**
   - Open `Settings → Nuke Utils`
   - Set `nuke.openmcCrossSections` to the full path of your `cross_sections.xml`
2. **Or use the environment variable:**
   ```bash
   export OPENMC_CROSS_SECTIONS=/path/to/cross_sections.xml
   ```
3. **Verify the file exists:**
   ```bash
   ls -la /path/to/cross_sections.xml
   ```

> **Tip:** Download cross-section data from the [OpenMC website](https://openmc.org/).

---

## Conflicts with Microsoft Python Extension

**Symptoms:**

- Two Python indicators in the status bar
- Confusion about which environment is "active"

**Fixes:**

| Goal                                     | What to do                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Avoid duplicate status bars              | Set `nuke.showStatusBar` to `"auto"` (default). Nuke Core hides its indicator once configured; MS Python extension takes over. |
| Use MS Python for IntelliSense/debugging | Keep it installed and configured normally.                                                                                     |
| Use Nuke Core for nuclear workflows      | Use "Nuke:" commands for environment creation, OpenMC validation, health checks, and package installs.                         |
| Hide Nuke Core completely                | Set `nuke.showStatusBar` to `"never"` and use Command Palette for all Nuke actions.                                            |

> **Tip:** The two extensions complement each other. MS Python handles the language server; Nuke Core handles nuclear-specific environment validation and tooling.

---

## "Nuke: Create Environment" hangs or fails

**Symptoms:**

- Terminal opens but nothing happens
- Conda solver takes a very long time

**Fixes:**

1. **Use mamba if possible.** Install mamba in your base conda environment — Nuke Core prefers it automatically for faster solving.
2. **Check your channels.** Add `conda-forge` to `nuke.condaChannels` if it isn't there.
3. **Check disk space and memory.** Creating environments requires free space (~1–3 GB for scientific stacks).
4. **Try a simpler spec.** Start with just Python, then install packages afterward via "Nuke: Install Package".

---

## Before You Ask Checklist

If you're still stuck, run through this list before filing an issue:

- [ ] I have set `nuke.pythonPath` or `nuke.condaEnv` in Settings
- [ ] I ran **"Nuke: Run Health Check"** and read the output
- [ ] I ran **"Nuke: Show Diagnostics"** and checked for obvious errors
- [ ] The Python path I configured actually exists (verified in a terminal)
- [ ] I tried reloading the window (`Developer: Reload Window`)
- [ ] I checked the **Nuke Core** output channel (`View → Output`)
- [ ] I know whether the MS Python extension is also installed
- [ ] For install failures, I read the full terminal output including the last error line

**If you file an issue, include:**

1. The exact error message (copy-paste from the output channel or terminal)
2. Your operating system and NukeIDE version
3. The output of **"Nuke: Show Diagnostics"** (sanitized if needed)
4. What you were trying to do when the error occurred
