# Project Management

OpenMC Studio uses `.nuke-openmc` project files to bundle your entire simulation — geometry, materials, settings, tallies, and results — into a single portable workspace.

---

## Creating a New Project

### Method 1: From Scratch

1. Go to `File → New → OpenMC Project`.
2. Choose a **project template** (see below).
3. Select a folder to save the `.nuke-openmc` file.
4. The project loads in the **Project Explorer** sidebar.

### Method 2: From Current Workspace

If you already have `geometry.xml`, `materials.xml`, and `settings.xml` open:

1. Go to `File → Save Workspace as Project`.
2. Enter a project name.
3. All open files and simulator state are bundled into the new `.nuke-openmc` file.

---

## Saving the Current State

A `.nuke-openmc` file is a compressed archive containing:

| Entry | Description |
|-------|-------------|
| `manifest.json` | Project metadata and file index |
| `geometry.xml` | CSG geometry definition |
| `materials.xml` | Material compositions |
| `settings.xml` | Simulation settings |
| `tallies.xml` *(optional)* | Tally definitions |
| `plots.xml` *(optional)* | Plot specifications |
| `statepoints/` *(optional)* | Result `.h5` files included in the project |
| `cad/` *(optional)* | Imported CAD source files |

### Save vs. Save As

| Action | Behavior |
|--------|----------|
| **Save Project** | Overwrites the existing `.nuke-openmc` file with current state |
| **Save Project As** | Creates a new `.nuke-openmc` file; leaves the original untouched |

> **Tip:** Enable `Auto-save on simulation complete` in project settings to automatically capture statepoints after each run.

---

## Opening an Existing Project

### Method 1: File Dialog
`File → Open Project` → select any `.nuke-openmc` file.

### Method 2: Explorer
Double-click a `.nuke-openmc` file in the Explorer sidebar.

### Method 3: Recent Projects
`File → Open Recent → OpenMC Projects`

### What Happens on Open

1. The archive is extracted to a temporary workspace.
2. All XML files are parsed and loaded into the appropriate editors:
   - `geometry.xml` → CSG Builder
   - `materials.xml` → Material Editor
   - `settings.xml` → Simulation Settings panel
3. Included statepoints are listed in the **Results** tab.

---

## Project Templates

Templates give you a verified starting point instead of a blank slate.

| Template | Description | Included Files |
|----------|-------------|----------------|
| **Blank** | Empty project with default placeholders | `geometry.xml`, `materials.xml`, `settings.xml` |
| **PWR Pin Cell** | Infinite fuel pin with water coolant | Pin-cell geometry, UO2 + Zircaloy + H2O materials |
| **BWR Assembly** | 8×8 fuel assembly with cruciform control blade | Assembly lattice, gadolinia pins, void slots |
| **CANDU Bundle** | 37-element natural uranium bundle | Bundle geometry, D2O coolant, pressure tube |
| **Sphere of Plutonium** | Bare critical sphere (Godiva-like) | Simple sphere, Pu-239 metal |
| **Depletion Problem** | 2D pin cell with chain file ready | Geometry, materials, depletion settings, sample chain XML |

### Creating a Custom Template

1. Set up a project exactly as you want it.
2. Go to `Project → Save as Template`.
3. Give it a name and description.
4. It appears in the template list for future new projects.

---

## Project Metadata

View and edit metadata in the **Project Info** panel (`Project → Project Info`).

| Field | Editable? | Description |
|-------|-----------|-------------|
| **Name** | Yes | Display name of the project |
| **Description** | Yes | Free-text notes about the model |
| **Author** | Yes | User or team name |
| **Created** | No | Timestamp of first save |
| **Modified** | No | Timestamp of last save |
| **OpenMC Version** | No | Version used to generate the XML files |
| **UUID** | No | Unique project identifier |

> **Tip:** Use the Description field to record modeling assumptions, reference data sources, or validation benchmarks the project targets.

---

## Exporting to Python Script

The **Python Exporter** generates a standalone `.py` script that reproduces your project using the OpenMC Python API.

### How to Export

1. Open the project you want to export.
2. Go to `Project → Export → Python Script`.
3. Choose what to include:
   - Geometry
   - Materials
   - Settings
   - Tallies
   - Plots
4. Select a destination path.
5. Click **"Export"**.

### What You Get

A single `.py` file containing:

```python
import openmc

# Materials
fuel = openmc.Material(name="UO2")
# ...

# Geometry
# ...

# Settings
settings = openmc.Settings()
# ...

# Tallies
# ...

# Export to XML
openmc.run()
```

> **Tip:** The exported script is ideal for version control, batch submissions on HPC clusters, or sharing with users who do not use OpenMC Studio.

---

## XML Import / Export Workflow

You can exchange models with standard OpenMC command-line workflows using XML import and export.

### Exporting to XML

1. `Project → Export → OpenMC XML`.
2. Choose a destination folder.
3. The following files are written:
   - `geometry.xml`
   - `materials.xml`
   - `settings.xml`
   - `tallies.xml` (if tallies exist)
   - `plots.xml` (if plots exist)

### Importing from XML

1. `Project → Import → OpenMC XML`.
2. Select the folder containing `geometry.xml` (and optionally `materials.xml`, `settings.xml`).
3. A new untitled project is created and populated from the XML files.

### Round-Trip Safety

| Feature | Preserved? | Notes |
|---------|------------|-------|
| CSG geometry | Yes | All surfaces, cells, lattices |
| Materials & nuclides | Yes | Densities, enrichment, S(a,b) tables |
| Settings | Yes | Batches, particles, temperature methods |
| Tallies | Yes | Filters, scores, nuclides |
| DAGMC geometry | Partial | DAGMC file path is preserved; the `.h5m` itself is not embedded |
| Results / statepoints | No | XML workflow does not include `.h5` results |

