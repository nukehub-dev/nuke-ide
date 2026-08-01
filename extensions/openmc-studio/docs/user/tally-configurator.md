# Tally Configurator

The Tally Configurator is the dedicated widget for defining OpenMC tallies — what to score, where to score it, and for which nuclides. It supports both standard tallies and structured mesh tallies.

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

| Filter               | Description                      | Parameters                  |
| -------------------- | -------------------------------- | --------------------------- |
| `energy`             | Energy bins                      | Lower/upper bounds (eV)     |
| `energyout`          | Outgoing energy bins             | Lower/upper bounds (eV)     |
| `mu`                 | Cosine of scattering angle       | Bin edges (−1 to 1)         |
| `polar`              | Polar angle                      | Bin edges (0 to π radians)  |
| `azimuthal`          | Azimuthal angle                  | Bin edges (0 to 2π radians) |
| `cell`               | Specific cells                   | List of cell IDs            |
| `cellborn`           | Cell where particle was born     | List of cell IDs            |
| `cellfrom`           | Cell particle just left          | List of cell IDs            |
| `surface`            | Surface crossings                | List of surface IDs         |
| `material`           | Specific materials               | List of material IDs        |
| `universe`           | Specific universes               | List of universe IDs        |
| `distribcell`        | Instances of a cell in a lattice | Cell ID                     |
| `mesh`               | Structured mesh bins             | Mesh definition (see below) |
| `delayedgroup`       | Delayed neutron precursor group  | Group numbers (1–6)         |
| `energyfunction`     | Functional energy filter         | Energy-response pairs       |
| `legendre`           | Legendre scattering moments      | Order (P0, P1, P2, ...)     |
| `spatiallegendre`    | Spatial Legendre expansion       | Axis, order                 |
| `sphericalharmonics` | Spherical harmonics moments      | Order                       |
| `zernike`            | Zernike polynomial moments       | Order, radial basis         |
| `zernikeradial`      | Radial-only Zernike moments      | Order                       |
| `particle`           | Particle type                    | `neutron`, `photon`         |
| `time`               | Time bins                        | Lower/upper bounds (s)      |
| `meshsurface`        | Current crossing a mesh surface  | Mesh definition             |

**Filter Examples:**

- **Energy spectrum:** `energy` filter with bins `[1e-5, 1e-3, 1e-1, 1, 1e3, 1e5, 2e7]` eV.
- **Cell-averaged flux:** `cell` filter with the target cell ID + `flux` score.
- **Material-wise power:** `material` filter with fuel material IDs + `kappa-fission` score.

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

Mesh tallies score quantities on a structured grid, producing spatially resolved results ideal for 3D visualization.

### Creating a Mesh

1. In the Tally Configurator, click **"Add Mesh"**.
2. Choose a mesh type:

| Mesh Type       | Description                | Parameters                                                  |
| --------------- | -------------------------- | ----------------------------------------------------------- |
| **Regular**     | Cartesian rectangular grid | `x`, `y`, `z` lower/upper bounds and divisions              |
| **Cylindrical** | `r`, `θ`, `z` grid         | `r` (cm), `θ` (radians), `z` (cm) bounds and divisions      |
| **Spherical**   | `r`, `θ`, `φ` grid         | `r` (cm), `θ` (polar), `φ` (azimuthal) bounds and divisions |

### Regular Mesh Configuration

| Parameter         | Description                  | Example             |
| ----------------- | ---------------------------- | ------------------- |
| **X Min / X Max** | Bounding box in X            | `-10.0` to `10.0`   |
| **Y Min / Y Max** | Bounding box in Y            | `-10.0` to `10.0`   |
| **Z Min / Z Max** | Bounding box in Z            | `-100.0` to `100.0` |
| **X Divisions**   | Number of mesh elements in X | `20`                |
| **Y Divisions**   | Number of mesh elements in Y | `20`                |
| **Z Divisions**   | Number of mesh elements in Z | `200`               |

### Cylindrical Mesh Configuration

| Parameter                 | Description        | Example                  |
| ------------------------- | ------------------ | ------------------------ |
| **R Min / R Max**         | Inner/outer radius | `0.0` to `10.0`          |
| **Theta Min / Theta Max** | Angular range      | `0.0` to `6.283185` (2π) |
| **Z Min / Z Max**         | Axial range        | `-100.0` to `100.0`      |
| **R Divisions**           | Radial elements    | `10`                     |
| **Theta Divisions**       | Angular sectors    | `16`                     |
| **Z Divisions**           | Axial elements     | `100`                    |

### Assigning a Mesh Filter

1. Create or edit a tally.
2. Add a `mesh` filter.
3. Select the mesh you defined from the dropdown.
4. The tally now scores on every mesh element.

> **Tip:** Fine mesh tallies increase memory usage and simulation time. Start coarse and refine as needed. Use the mesh preview button to visualize the grid overlay on your geometry.

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
