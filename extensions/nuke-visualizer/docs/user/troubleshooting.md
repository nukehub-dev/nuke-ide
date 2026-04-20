# Troubleshooting Nuke Visualizer

This guide covers the most common issues and how to fix them.

---

## "Python not found" or "Failed to detect Python"

**Symptoms:**
- Error message when opening a file
- Health check shows red crosses for all packages

**Fixes:**

1. **Configure Python path** in `Settings → Nuke Utils → Python Path`.
2. **Use a conda environment** with the required packages installed:
   ```bash
   conda create -n nuke-env -c conda-forge openmc paraview trame h5py numpy
   conda activate nuke-env
   ```
3. **Run the health check** (`Tools → Visualizer → Run Health Check`) and follow the suggested install commands.
4. Check the **Nuke Visualizer** output channel for the exact missing packages.

---

## Server Starts But Widget Shows Blank

**Symptoms:**
- Status says "Server ready" but the iframe is empty or white

**Fixes:**

1. Check the **Nuke Visualizer** or **OpenMC** output channel for Python errors.
2. Verify the server URL is correct (`http://localhost:PORT`).
3. Open browser DevTools (`Ctrl+Shift+I`) and check for:
   - CSP (Content Security Policy) errors
   - iframe sandbox restrictions
   - Network connection refused
4. Try increasing the server timeout: `Settings → nukeVisualizer.serverTimeout`.

---

## "Failed to start server" / Timeout

**Symptoms:**
- Error: `Server not responding after N seconds`
- Spinner stops with an error message

**Fixes:**

1. Increase `nukeVisualizer.serverTimeout` (default 30s) to 60s or 120s.
2. For large DAGMC files, conversion can take >30s. Be patient or try a smaller file.
3. Check if another process is using the port (8080–9080 range).
4. Restart NukeIDE to clean up orphaned Python processes.

---

## Widget Reopens Instead of Creating a New One

**Symptoms:**
- Opening a different file reuses the existing tab

**Cause:**
Widget IDs must be unique per file. This is usually handled automatically, but custom integrations might reuse IDs.

**Fix:**
Ensure any custom code uses a unique widget ID:
```typescript
const widgetId = `my-plugin-${filePath}`;
```

---

## Health Check Shows Wrong Environment

**Symptoms:**
- Health check passes but the actual operation fails
- Packages are shown as missing even though they are installed somewhere

**Cause:**
Health checks verify the **currently configured** environment, not fallback environments.

**Fix:**
1. Go to `Settings → Nuke Utils`.
2. Switch to the correct Python path / conda environment.
3. Re-run the health check.

---

## Commands Don't Appear in Menus

**Symptoms:**
- `Tools → Visualizer` menu is missing items

**Fixes:**

1. Make sure the `nuke-visualizer` extension is loaded (check Theia extensions panel).
2. Reload the window (`Developer: Reload Window`).
3. Check for build errors in the extension:
   ```bash
   cd extensions/nuke-visualizer
   yarn build
   ```

---

## OpenMC-Specific Issues

### "OpenMC integration not available"

- `openmc` or `h5py` is not installed in the active Python environment.
- Run: `pip install openmc h5py numpy` or `conda install -c conda-forge openmc`

### Statepoint file won't open

- Verify the file is a valid HDF5 statepoint: `h5dump -n statepoint.h5 | head`
- Check that the file was written completely (not truncated by a crashed simulation).

### Tally overlay on geometry shows warning

- A yellow banner appears: "Spatial mismatch between tally and geometry"
- This means the tally mesh and geometry bounding boxes don't align perfectly.
- The visualization still works, but results may be misleading near boundaries.

### Cross-section plotting fails

- Ensure `OPENMC_CROSS_SECTIONS` environment variable points to a valid `cross_sections.xml`.
- Or set the path manually in the XS Plot panel.

---

## Still Stuck?

1. Check the **Output** panel (`View → Output`) and select:
   - **Nuke Visualizer** — Base visualizer and DAGMC logs
   - **OpenMC** — OpenMC plugin logs and Python stdout/stderr
2. Open **Developer Tools** (`Ctrl+Shift+I`) and check the Console for JavaScript errors.
3. File an issue at [github.com/nukehub-dev/nuke-ide/issues](https://github.com/nukehub-dev/nuke-ide/issues) with:
   - The exact error message
   - Your Python version and environment
   - The file type you're trying to visualize
