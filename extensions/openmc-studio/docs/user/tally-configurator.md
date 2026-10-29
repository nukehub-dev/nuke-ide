# Tally Configurator

The Tally Configurator is the dedicated widget for defining OpenMC tallies — what to score, where to score it, and for which nuclides. It supports both standard tallies and structured mesh tallies. XML import reconstructs every supported filter, structured cell-instance/mesh-material pair, score, trigger, and derivative, and reports anything it cannot map in the dashboard's import report.

---

## Opening the Tally Configurator

### Method 1: Dashboard

In the Simulation Dashboard, go to the **Tallies** tab and click **"Open Tally Configurator"**.

### Method 2: Command Palette

`Ctrl+Shift+P` → **"OpenMC Studio: Open Tally Configurator"**

### Method 3: Menu

`Tools → OpenMC Studio → Advanced → Tally Configurator`

---

## Tally List

The left panel shows all tallies in the project. Click a tally to edit it, or click **"Add Tally"** to create a new one.

In a narrow editor panel the tally list stacks above the editor instead of squeezing both side by side; wide score/filter grids collapse to one column.

| Column            | Description                |
| ----------------- | -------------------------- |
| **ID**            | Unique tally identifier    |
| **Name**          | Descriptive label          |
| **Score Count**   | Number of scores assigned  |
| **Filter Count**  | Number of filters applied  |
| **Nuclide Count** | Number of nuclides tracked |

---

## Creating a Tally

### Step 1: Name and ID

1. Click **"Add Tally"**.
2. Enter a **Name** (e.g., "Fuel Flux", "Assembly Power").
3. The **ID** is auto-assigned; override it if needed for compatibility with external scripts.

### Step 2: Add Scores

Scores define the physical quantity to compute. Click **"Add Score"** and pick from the score catalog, which is organized into categories:

| Category                | Contents                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Basic**               | `flux`, `total`, `absorption`, `fission`, `nu-fission`                                                                                                           |
| **Neutron Reactions**   | MT-numbered reaction rates: `elastic` (MT 2), `(n,2n)` (MT 16), `(n,γ)` (MT 102), `(n,Xn)` (MT 201), …                                                           |
| **Photon Physics**      | Photon interaction scores (coherent/incoherent scatter, photoelectric, pair production) — require photon transport                                               |
| **Particle Production** | Secondary particle production (`H1`–`H3`, `He3`, `He4`)                                                                                                          |
| **Kinetics (IFP)**      | Iterated fission probability scores (`ifp-time-numerator`, `ifp-beta-numerator`, `ifp-denominator`) plus `prompt-nu-fission`, `delayed-nu-fission`, `decay-rate` |
| **Advanced**            | `scatter`, `nu-scatter`, `kappa-fission`, `current`, `events`, `pulse-height`, `inverse-velocity`, `heating`, `heating-local`, `damage-energy`                   |

Custom integer MT scores are also accepted — enter any MT number ≥ 1 directly.

> **Tip:** Multiple scores can be added to a single tally. They are computed simultaneously, which is more efficient than creating separate tallies. Deprecated upstream moment scores (`scatter-N`) are intentionally excluded from the catalog.

### Step 3: Add Filters

Filters restrict scoring to specific regions of phase space.

Click **"Add Filter"** and choose a filter type:

| Filter               | Description                              | Parameters                                       |
| -------------------- | ---------------------------------------- | ------------------------------------------------ |
| `energy`             | Energy bins                              | Lower/upper bounds (eV)                          |
| `energyout`          | Outgoing energy bins                     | Lower/upper bounds (eV)                          |
| `mu`                 | Cosine of scattering angle               | Bin edges (−1 to 1)                              |
| `polar`              | Polar angle                              | Bin edges (0 to π radians)                       |
| `azimuthal`          | Azimuthal angle                          | Bin edges (0 to 2π radians)                      |
| `cell`               | Specific cells                           | List of cell IDs                                 |
| `cellborn`           | Cell where particle was born             | List of cell IDs                                 |
| `cellfrom`           | Cell particle just left                  | List of cell IDs                                 |
| `surface`            | Surface crossings                        | List of surface IDs                              |
| `material`           | Specific materials                       | List of material IDs                             |
| `universe`           | Specific universes                       | List of universe IDs                             |
| `distribcell`        | Instances of a cell in a lattice         | Cell ID                                          |
| `mesh`               | Mesh element bins                        | Mesh definition + optional transform (see below) |
| `delayedgroup`       | Delayed neutron precursor group          | Group numbers (1–6)                              |
| `energyfunction`     | Functional energy filter                 | Energy-response pairs                            |
| `legendre`           | Legendre scattering moments              | Order (P0, P1, P2, ...)                          |
| `spatiallegendre`    | Spatial Legendre expansion               | Axis, order                                      |
| `sphericalharmonics` | Spherical harmonics moments              | Order                                            |
| `zernike`            | Zernike polynomial moments               | Order, radial basis                              |
| `zernikeradial`      | Radial-only Zernike moments              | Order                                            |
| `particle`           | Incident particle type                   | Presets (neutron … He3) or a custom PDG number   |
| `time`               | Time bins                                | Lower/upper bounds (s)                           |
| `meshsurface`        | Current crossing a mesh surface          | Mesh definition                                  |
| `materialfrom`       | Material the particle came from          | Material IDs                                     |
| `cellinstance`       | One repeated instance of a cell          | Cell ID + instance index (0 = first)             |
| `parentnuclide`      | Parent nuclide of the event              | Nuclide names (e.g. `U235`, `Am242m`)            |
| `meshborn`           | Mesh element where the particle was born | Mesh definition + optional transform             |
| `meshmaterial`       | Mesh element + material pairs            | Zero-based element + material ID per row         |
| `collision`          | Number of collisions                     | Positive whole collision numbers, ascending      |
| `reaction`           | ENDF reaction (0.16+)                    | MT number or name, searchable picker             |
| `particleproduction` | Secondary particle type + energy (0.16+) | Particle names + optional energy boundaries      |
| `musurface`          | Surface-crossing angle cosine            | Bin edges from −1 to 1                           |
| `weight`             | Incoming particle weight                 | Non-negative boundaries, ascending               |

The add-filter menu groups these into **Spatial / domain**, **Energy / angle**, **Mesh**,
**Reaction / particle**, and **Advanced**. Filters can be reordered with the arrow buttons; the order
is the tally bin order and is written unchanged to XML and Python.

**Filter Examples:**

- **Energy spectrum:** `energy` filter with bins `[1e-5, 1e-3, 1e-1, 1, 1e3, 1e5, 2e7]` eV.
- **Cell-averaged flux:** `cell` filter with the target cell ID + `flux` score.
- **Material-wise power:** `material` filter with fuel material IDs + `kappa-fission` score.

### Structured Filters

**Cell instance** (`cellinstance`) bins one occurrence of a repeated cell, so different lattice
positions can be scored separately. Each row combines a cell picker with an instance index:
instance `0` is the first occurrence in the geometry, `1` the second, and so on. Without a cell in the
project yet, type the cell ID directly; the picker appears as soon as geometry exists.

**Mesh material** (`meshmaterial`) bins one mesh element/material combination per row. Element indices
are zero-based, matching `openmc.MeshMaterialFilter`, and the editor shows the mesh's element count
when it is known. Add one row per combination; the pair count is shown above the table.

**Reaction** (`reaction`, OpenMC 0.16+) uses a searchable MT/name picker with common reactions pinned.
Typing an MT number such as `102` adds OpenMC's canonical `(n,gamma)` name. Unknown names are rejected
inline instead of being written to the deck.

**Particle** (`particle`) bins events by the incident particle. Check the common presets or add a
custom PDG number; the control previews the canonical OpenMC name (for example `He4` for
`1000020040`). Neutron, photon, electron, and positron work on both supported OpenMC releases;
proton, deuteron, triton, alpha, He3, and custom nuclides require OpenMC 0.16's PDG-backed
`ParticleType`. On 0.15.3 those bins stay in the project with an inline warning and are omitted from
generated XML/Python.

**Particle production** (`particleproduction`, OpenMC 0.16+) selects secondary particles (photon,
neutron, electron, positron, proton, deuteron, triton, alpha, He3, or a custom nuclide/PDG number)
and optional strictly increasing energy boundaries in eV. It is most useful with the `events`
score. On environments older than OpenMC 0.16 the filter stays in the project but is omitted from
generated XML/Python with a warning.

**Mu surface** (`musurface`) bins surface crossings by the cosine of the angle between the particle
direction and the surface normal. It needs a `surface` filter and the `current` score; the editor
warns when either is missing.

### Tally Output Options

- **Multiply by density** (default on) writes `multiply_density="false"` only when disabled. Turn it
  off for scores already normalized per unit mass or atom.
- **Accumulate higher moments** writes `<higher_moments>true</higher_moments>` and
  `tally.higher_moments = True` in the Python export.

Sparse storage (`sparse`) and per-batch statistics (`with_batch_statistics`) are statepoint/Python
analysis options, not simulation input; they have no editor control and are not written to
`tallies.xml`.

### Random Ray Filters

Random ray supports the filters listed by OpenMC: `cell`, `cellinstance`, `distribcell`, `energy`,
`material`, `mesh`, and `universe`. The readiness checklist rejects other filters in multi-group mode
with a message naming the tally and filter.

### Step 4: Add Nuclides

Nuclides define which isotopes the tally tracks.

| Option           | Description                                       |
| ---------------- | ------------------------------------------------- |
| `total`          | Sum over all nuclides in the material (default)   |
| `all`            | Separate result for every nuclide in the material |
| Specific nuclide | e.g., `U235`, `U238`, `Pu239`                     |

Click **"Add Nuclide"** and type a nuclide name. Repeat for each nuclide you need.

> **Tip:** For depletion tallies, use `all` to get per-nuclide reaction rates needed by the depletion solver.

---

## Mesh Tallies

Mesh tallies score quantities on a structured or unstructured grid, producing spatially resolved results ideal for 3D visualization.

### Creating a Mesh

1. In the Tally Configurator, open the **Meshes** tab.
2. Click **"Add"**.
3. Pick one of the five type cards (or the type select in a narrow panel):

| Mesh Type        | Description                         | Parameters                                                             |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| **Regular**      | Even Cartesian rectangular grid     | `x`, `y`, `z` lower/upper bounds and divisions                         |
| **Rectilinear**  | Cartesian grid with explicit planes | `x`, `y`, `z` boundary lists, or lower/upper bounds + divisions helper |
| **Cylindrical**  | `r`, `φ`, `z` grid                  | `r` (cm), `φ` (radians), `z` (cm) boundaries                           |
| **Spherical**    | `r`, `θ`, `φ` grid                  | `r` (cm), `θ` (polar), `φ` (azimuthal) boundaries                      |
| **Unstructured** | External MOAB or Exodus mesh        | file, library, length multiplier, optional MOAB search options         |

### Regular Mesh Configuration

| Parameter       | Description          | Example          |
| --------------- | -------------------- | ---------------- |
| **Lower Left**  | Bounding box minimum | `-10, -10, -100` |
| **Upper Right** | Bounding box maximum | `10, 10, 100`    |
| **Dimension**   | Cells in X, Y, Z     | `20, 20, 200`    |

Use **Set from Geometry Bounds** when a DAGMC model is loaded to fill the bounds automatically.

### Rectilinear Mesh Configuration

Each axis uses a token editor. Boundaries include both endpoints and must strictly increase; at least
two values are required. The editor shows the cell count per axis and the total element count, and
reports invalid input inline instead of discarding it.

- Type space- or comma-separated values, e.g. `0 0.5 1 2 4`.
- Remove individual boundaries from the token row under the input.
- **From bounds + divisions** fills all three axes with evenly spaced boundaries: enter lower/upper
  and a division count per axis, then click **Apply to grids**.

### Unstructured Mesh Configuration

| Parameter             | Description                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Mesh file**         | Path to the mesh file; **Browse** filters `.h5m`, `.h5`, `.vtk`, `.e`, `.exo`, `.ex2` |
| **Library**           | **MOAB** (HDF5/VTK/Exodus) or **libMesh** (Exodus only)                               |
| **Length multiplier** | Multiplies every mesh coordinate; default `1` (use `100` for metres-authored files)   |
| **Advanced options**  | MOAB `AdaptiveKDTree` parameters, e.g. `MAX_DEPTH=20;PLANE_SET=2;`                    |

The editor shows the file name and size, warns when the file is missing, and reports an extension
that does not match the selected library. Paths inside the project are stored project-relative when
the project is saved. Unstructured tallies also require an OpenMC binary built with MOAB or libMesh
support; the panel names the missing Python package when the MOAB package is unavailable.

### Assigning a Mesh Filter

1. Create or edit a tally.
2. Add a `mesh` filter.
3. Select the mesh you defined from the dropdown (the type is shown next to the name).
4. The tally now scores on every mesh element.

### Mesh Filter Transforms

Mesh filters support an optional rigid transform under **Mesh transform** in the filter editor:

- **Translate mesh (cm)** — shift the mesh by X/Y/Z for this filter only. Applies to `mesh`,
  `meshsurface`, `meshborn`, and `meshmaterial`.
- **Rotate mesh (degrees)** — rotate by `phi`, `theta`, `psi` using OpenMC's intrinsic Tait-Bryan
  convention (`Rz(psi) Ry(theta) Rx(phi)`). Applies to `mesh`, `meshsurface`, and `meshborn`; OpenMC's
  mesh-material filter has no rotation attribute. Rotation requires OpenMC 0.16 or newer.

Configured transforms show `translated` / `rotated` badges on the filter. On environments without
mesh-filter rotation, the editor shows an inline warning and generated XML omits the rotation instead
of writing input OpenMC cannot read.

> **Tip:** Fine mesh tallies increase memory usage and simulation time. Start coarse and refine as needed. Mesh results appear in the Statepoint Viewer after a run; unstructured tallies route to the VTK viewer when available.

---

## Tally Estimators

Each tally can use a specific statistical estimator:

| Estimator     | Description                                | When to Use                                     |
| ------------- | ------------------------------------------ | ----------------------------------------------- |
| `analog`      | Scores only when the event actually occurs | Rare events, verification                       |
| `tracklength` | Scores along entire particle tracks        | Flux, most efficient for optically thin regions |
| `collision`   | Scores at every collision                  | Default for many reaction rates                 |

Select the estimator in the tally detail panel. The default is `collision` for most scores and `tracklength` for `flux`.

---

## Triggers

Tally triggers automatically stop the simulation when a convergence criterion is met.

1. In the tally detail panel, expand **Triggers**.
2. Click **"Add Trigger"**.

| Trigger Type           | Description                                                 | Threshold Example |
| ---------------------- | ----------------------------------------------------------- | ----------------- |
| **Relative Error**     | Stop when relative standard deviation falls below threshold | `0.05` (5%)       |
| **Variance**           | Stop when variance falls below threshold                    | `1e-4`            |
| **Standard Deviation** | Stop when standard deviation falls below threshold          | `0.01`            |

Each trigger also supports:

- **Ignore zeros** — skip zero-valued tally bins when evaluating convergence (useful for sparse mesh tallies).
- **Score subset** — restrict the trigger to specific scores (none checked = all of the tally's scores).

Run-level trigger evaluation is configured in **Settings → Output → Tally Triggers**: the **Batch Interval** (how often triggers are evaluated, default 1) and **Max Batches** (safety cap). Trigger activation in `settings.xml` is emitted automatically whenever any tally has triggers.

> **Tip:** Triggers are evaluated at the end of each batch. Only active batches count toward trigger statistics.

---

## Tally Derivatives

A tally derivative perturbs a **material** and scores the sensitivity of the tally to that perturbation (one `openmc.TallyDerivative` per tally).

1. In the tally detail panel, expand **Derivative**.
2. Choose the perturbed **Variable**:

| Variable            | Description                        | Extra Field                                      |
| ------------------- | ---------------------------------- | ------------------------------------------------ |
| **Density**         | Perturb the material's density     | —                                                |
| **Nuclide Density** | Perturb one nuclide's density      | Perturbed Nuclide (from the material's nuclides) |
| **Temperature**     | Perturb the material's temperature | —                                                |

3. Select the **Perturbed Material** (requires at least one material in the project).

Derivatives are exported as top-level `<derivative>` elements in `tallies.xml`, referenced by the owning tally.

---

## Derived Tallies

The **Derived Tallies** tab combines existing tally scores into ratios, sums, differences, products,
and scalar-scaled expressions without writing Python. Derived tallies are **post-processing only**:
they are stored in the `.nuke-openmc` project, evaluated against a statepoint, and never written to
`tallies.xml` or the OpenMC Python model.

### Building an Expression

1. Create at least one simulation tally with a score.
2. Open the **Derived Tallies** tab and click **Create Derived Tally**.
3. Choose a **Tally**, its **Score**, and optionally one **Nuclide** (or keep all scored nuclides), then
   click **Add operand**. A scalar constant can be added from the same row.
4. Build the expression with the operator buttons (`+`, `−`, `×`, `÷`, parentheses). Backspace removes
   the last token; **Clear** resets the expression. With the token editor focused, Backspace removes the
   last token, Enter adds the selected operand, and Escape cancels the draft.
5. Set the **Name**, optional **Unit** (used in plot labels), **Color**, and description, then save.

The **Formula** preview shows the canonical expression, for example
`T1[(n,gamma)] / T2[fission]`, and the preview reports how many result bins the current filters and
nuclides will produce. A single energy filter plots as a spectrum; other filter combinations plot one
bar per result bin and list the decoded filter labels in the bins table.

### Validation

The builder blocks saving when:

- the expression is empty or malformed,
- an operand references a tally, score, or nuclide that does not exist,
- the expression divides by a scalar zero,
- two reference tallies use the same filter type with different bins (the axes cannot be aligned),
- or the name duplicates another derived tally.

Messages state what is wrong and how to fix it. When a simulation tally is deleted, existing derived
tallies that reference it show the missing-tally error instead of silently dropping the term.

> **Uncertainty caveat:** result uncertainties use OpenMC's independent-tally propagation. Correlated
> tallies can under-predict the true uncertainty.

### Viewing Results

Open a `statepoint*.h5` file beside the project. The Statepoint Viewer discovers the owning
`.nuke-openmc` project, evaluates the persisted derived tallies, and lists them in the **Tallies** tab
with a **DERIVED** badge. Each card shows the formula, unit, aggregate mean (or sum of bins) and
standard deviation, and actions to plot the bins, show the per-filter-bin table, export CSV, or compare
the same derived tally across sibling statepoints.

The **Simulation Comparison** widget has a matching **Derived** tab: load statepoints from the same
project and compare each derived tally's aggregate value and uncertainty across runs by ID/name.

---

## Export and Import

### Export Tally Configuration

Click **"Export"** in the Tally Configurator toolbar to save the current tally setup as a JSON file. This is useful for:

- Sharing tally definitions across projects
- Version-controlling tally configurations independently

### Import Tally Configuration

Click **"Import"** and select a previously exported JSON file to load tally definitions into the current project.

---

## Tips

- **Flux-to-dose conversion:** Add an `energyfunction` filter with ICRP flux-to-dose response data to compute dose rates directly.
- **Mesh alignment:** Align mesh boundaries with geometry boundaries to avoid artificial gradients at material interfaces.
- **Memory warning:** The Tally Configurator shows an estimated memory usage indicator based on the product of filter bins, scores, and nuclides.
- **Tally naming:** Use consistent naming conventions (e.g., `<location>_<quantity>_<filter>`) so results are easy to identify in the Statepoint Viewer.
