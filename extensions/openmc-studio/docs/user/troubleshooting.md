# Troubleshooting OpenMC Studio

This guide covers the most common issues encountered when building, running, and analyzing simulations in OpenMC Studio, along with practical fixes.

---

## "OpenMC not found"

**Symptoms:**

- Error banner: `OpenMC Python module could not be imported`
- Health check shows a red cross next to `openmc`
- The Simulation Dashboard is disabled or grayed out

**Fixes:**

1. **Check the Python path** in `Settings → Nuke Utils → Python Path`. Make sure it points to the environment where OpenMC is installed.
2. **Run the health check:**
   - `Tools → OpenMC Studio → Environment → Run Health Check`
   - Follow the install commands shown in the output channel.
3. **Install OpenMC** if it is missing:
   ```bash
   conda install -c conda-forge openmc
   ```
   Or for a minimal pip install (openmc is not on PyPI — use the community wheel index):
   ```bash
   pip install --extra-index-url https://shimwell.github.io/wheels openmc
   ```
4. **Restart NukeIDE** after installing packages so the Python environment is re-scanned.

---

## "Cross-sections not set"

**Symptoms:**

- Error when exporting XML or starting a simulation: `No cross_section.xml file was specified`
- Materials show yellow warning icons in the Material Editor

**Fixes:**

1. Open `Settings → Nuke Utils`.
2. Locate the setting `nuke.openmcCrossSections`.
3. Set it to the absolute path of your `cross_sections.xml` file, for example:
   ```
   /home/user/nuclear_data/cross_sections.xml
   ```
4. Alternatively, set the `OPENMC_CROSS_SECTIONS` environment variable in your shell and restart NukeIDE from that shell.
5. Verify the path is valid by clicking **"Browse"** next to the setting.

> **Tip:** If you do not have cross-section data yet, download it from the OpenMC data repository.

---

## "XML generation failed"

**Symptoms:**

- Export or pre-run check fails with `XML generation failed`
- The error message references `geometry.xml` or `materials.xml`

**Fixes:**

1. **Check for missing cells:**
   - Open the CSG Builder.
   - Ensure every universe has at least one cell defined.
   - Verify the root universe is assigned.

2. **Check for invalid surfaces:**
   - Surfaces must have non-degenerate coefficients (e.g., a sphere radius must be > 0).
   - Look for red-highlighted surfaces in the geometry tree.

3. **Check lattice definitions:**
   - Ensure lattice dimensions match the universe array size.
   - Verify pitch values are positive.

4. **Run a model check:**
   - `Tools → OpenMC Studio → Simulation → Validate Model`
   - Fix any errors reported before exporting again.

---

## "Simulation fails immediately"

**Symptoms:**

- The run stops within seconds with a non-zero exit code
- The Simulation Dashboard shows `Failed` with no statepoint written

**Fixes:**

1. **Verify materials have valid nuclides:**
   - Open the Material Editor.
   - Ensure each material contains at least one nuclide or element.
   - Check that nuclide names follow OpenMC conventions (e.g., `U235`, `H1`, `O16`).

2. **Check boundary conditions:**
   - Every cell chain must eventually terminate in a surface with a boundary condition (`vacuum`, `reflective`, `periodic`, or `white`).
   - Use `Tools → OpenMC Studio → Simulation → Validate Model` to detect leaks.

3. **Check settings:**
   - `batches` and `particles` must be positive integers.
   - For eigenvalue mode, `inactive` must be less than `batches`.

4. **Review the output log:**
   - Open the **OpenMC** output channel (`View → Output → OpenMC`).
   - Scroll to the bottom for the exact Python traceback.

---

## "MPI not working"

**Symptoms:**

- Simulation runs but only uses a single CPU core
- Error: `mpiexec` not found or MPI initialization failed
- The MPI checkbox in Simulation Settings is grayed out

**Fixes:**

1. **Verify MPI is installed:**

   ```bash
   which mpiexec
   mpiexec --version
   ```

2. **Check the number of processes:**
   - In the Simulation Dashboard, ensure **MPI Processes** is set to a value greater than 1.
   - Do not exceed the number of physical cores on your machine.

3. **Install MPI-enabled OpenMC:**

   ```bash
   conda install -c conda-forge "openmc=*=mpi*"
   ```

   Or ensure your pip-installed OpenMC was built with MPI support.

4. **Check environment consistency:**
   - The `mpiexec` on your PATH must match the MPI library that OpenMC was compiled against (usually OpenMPI or MPICH).

---

## "DAGMC file won't open"

**Symptoms:**

- Error when loading a `.h5m` file in the DAGMC Editor
- Blank 3D view after clicking a DAGMC file
- Error: `pydagmc` or `moab` not found

**Fixes:**

1. **Install DAGMC dependencies:**

   ```bash
   conda install -c conda-forge pydagmc moab ocp
   ```

2. **Verify the file:**

   ```bash
   h5dump -n model.h5m | head
   ```

   You should see DAGMC group names such as `/tstt`.

3. **Check the health check:**
   - `Tools → OpenMC Studio → Environment → Run Health Check`
   - Confirm `pydagmc` and `moab` show green checks.

4. **For large files:**
   - Loading may take 30–60 seconds. Increase the server timeout in `Settings → nukeVisualizer.serverTimeout` if needed.

---

## "Some DAGMC volumes failed to load"

**Symptoms:**

- Warning toast: "Skipped N volumes"
- Some volumes are missing from the DAGMC Editor grid
- Error in output channel: `MB_INDEX_OUT_OF_RANGE` or similar

**Fixes:**

1. **Understand the warning:** The DAGMC Editor skips individual volumes that have corrupt or unreadable triangle data, then loads all remaining valid volumes. This is intentional — the file itself may be partially invalid.

2. **Re-facet from source CAD:** If you have the original CAD file:
   - Use **CAD Import** to re-convert to DAGMC with current settings.
   - The native writer handles edge cases (empty elements, invalid topology) better than older pipelines.

3. **Check with `pydagmc` directly:**

   ```python
   from pydagmc import Model
   m = Model("model.h5m")
   for v in m.volumes:
       try:
           print(f"Vol {v.id}: {v.num_triangles} triangles")
       except Exception as e:
           print(f"Vol {v.id}: FAILED - {e}")
   ```

4. **For N volumes skipped on first load only:** If the warning appears immediately after import but the editor still shows all volumes, this is a benign timing message. No action needed.

---

## "CAD import mesh is too dense / too coarse"

**Symptoms:**

- DAGMC file is unexpectedly large (hundreds of MB) or tiny (few triangles)
- Visual inspection shows jagged or oversimplified surfaces
- Import takes much longer than expected

**Fixes:**

1. **Use the Faceting tab to re-export with a new tolerance:**
   - Open the DAGMC Editor, switch to the **Faceting** tab.
   - Select the original source CAD file (STEP/IGES).
   - Choose a preset: **Draft (1 cm)** for fast previews, **Standard (0.5 cm)** for balanced quality, **Fine (0.1 cm)** for production, or **Ultra (0.01 cm)** for high fidelity.
   - Review the triangle estimate in the impact preview gauge.
   - Click **Generate Re-faceted H5M**.

2. **Adjust the default faceting tolerance for future imports:**
   - Open `Settings → Extensions → OpenMC Studio → Default Faceting Tolerance`
   - Lower values = finer mesh, larger file; higher values = coarser mesh, smaller file
   - Default is `0.001` cm. Try `0.01` for faster draft conversions, `0.0001` for high-fidelity final meshes.

3. **Disable auto-adjustment for precise control:**
   - Uncheck `Settings → Extensions → OpenMC Studio → Auto-Adjust Faceting Tolerance`
   - This prevents the importer from raising the tolerance for large models.
   - Useful when you need consistent mesh density regardless of model size.

4. **For very large models (tokamaks, vessels):**
   - Keep auto-adjustment **enabled** (default). The importer automatically scales tolerance to `bbox_diagonal / 500`.
   - If the mesh is still too dense, use the **Draft** preset in the Faceting tab.

---

## "Statepoint comparison shows no data"

**Symptoms:**

- The Simulation Comparison widget is empty after loading statepoints
- Error banner: `Incompatible statepoint version`

**Fixes:**

1. **Check statepoint versions:**
   - Hover over each loaded statepoint in the Comparison widget.
   - The tooltip shows the OpenMC version that wrote it.
   - All files should share the same major version for full compatibility.

2. **Verify run mode:**
   - k-effective comparisons require `eigenvalue` mode statepoints.
   - Fixed-source statepoints will not show k-effective data.

3. **Check file integrity:**

   ```bash
   h5dump -n statepoint.h5 | head
   ```

   If this fails, the file was truncated (likely by a crashed simulation).

4. **Re-run the simulation** with the same OpenMC version if version mismatch is unavoidable.

---

## Health Check Warnings

The environment health check (`Tools → OpenMC Studio → Environment → Run Health Check`) may report warnings even when things appear to work. Here is how to interpret them.

| Warning                    | Meaning                                                                       | Suggested Fix                                                 |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `openmc` version mismatch  | Installed version differs from the version used to create the current project | Update OpenMC, or verify the project XML is still compatible  |
| `h5py` missing             | Cannot read statepoint or depletion HDF5 files                                | `conda install -c conda-forge h5py` or `pip install h5py`     |
| `numpy` outdated           | Some features rely on newer NumPy APIs                                        | `pip install -U numpy`                                        |
| `pydagmc` missing          | DAGMC geometry features are disabled                                          | Install only if you work with `.h5m` files                    |
| `moab` missing             | CAD import and DAGMC conversion are limited                                   | Install only if you need CAD → DAGMC workflows                |
| `OCP` missing              | Refacet and CAD import fallback are unavailable                               | Install if you need to re-facet or convert STEP/IGES to DAGMC |
| `mpi4py` missing           | MPI parallel execution is unavailable                                         | Install only if you plan to run multi-process simulations     |
| Cross-section path invalid | `nuke.openmcCrossSections` points to a missing file                           | Update the path in settings to a valid `cross_sections.xml`   |
| Python path not set        | NukeIDE does not know which interpreter to use                                | Set `Settings → Nuke Utils → Python Path`                     |

> **Tip:** Warnings in yellow are advisory; red crosses indicate blockers. You can often proceed with yellow warnings if you are not using the related feature.

---

## Before You Ask

If you are still stuck, run through this checklist before opening an issue or asking for help.

- [ ] I have run the health check and installed any missing dependencies shown in red.
- [ ] I have verified my Python path points to the correct environment.
- [ ] I have restarted NukeIDE after installing packages or changing settings.
- [ ] I have checked the **OpenMC** output channel for the exact error message and traceback.
- [ ] I have checked the **Developer Tools** console (`Ctrl+Shift+I`) for JavaScript errors.
- [ ] I have run `Validate Model` on my simulation and fixed all reported errors.
- [ ] I have confirmed my `cross_sections.xml` path is valid and the file exists.
- [ ] I have verified the statepoint / DAGMC file is not truncated (`h5dump -n file.h5`).
- [ ] I can reproduce the issue after reloading the window (`Developer: Reload Window`).

---

## Still Stuck?

1. Check the **Output** panel (`View → Output`) and select:
   - **OpenMC** — Simulation logs, Python stdout/stderr, XML export errors
   - **OpenMC Studio** — Extension initialization, UI state, project events
   - **Nuke Visualizer** — 3D viewer and DAGMC rendering logs
2. Open **Developer Tools** (`Ctrl+Shift+I`) and check the Console for JavaScript errors.
3. File an issue at [github.com/nukehub-dev/nuke-ide/issues](https://github.com/nukehub-dev/nuke-ide/issues) with:
   - The exact error message or traceback
   - Your OpenMC version and Python environment details
   - The steps to reproduce the problem
   - Whether the issue happens with a specific project or all projects
