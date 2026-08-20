# GUI parametric modeler

Nuke CAD now has a second authoring mode alongside Python scripts: **`.nuke-cad`
documents** store parameters, datum planes, sketches, and a feature tree as JSON.
You edit them graphically in the CAD viewport and get the same STEP, DAGMC, and
FEM artifacts as a script build.

## Two authoring modes

| Mode                       | Source of truth                                               | Best for                                                                 |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Script** (`.py`)         | A build123d/CadQuery script with a top-level `model` variable | Complex programmatic geometry, reusable libraries, version-control diffs |
| **Document** (`.nuke-cad`) | A JSON feature tree edited through the GUI                    | Rapid parametric parts, design tables, visual sketch-driven modeling     |

Both modes end at the same geometry service: the viewport tessellation, STEP
export, region manifest, DAGMC `.h5m`, and FEM meshes are authoring-mode-agnostic.
You can open a `.nuke-cad` file, export the STEP, and import it into OpenMC
Studio the same way you would a script build.

## Creating a `.nuke-cad` document

1. Run **New CAD Document** from the Command Palette or the Nuke Tools sidebar
   (`CAD Studio → Geometry`).
2. Save the new document with **Save CAD Document As...** to give it a name and
   location.
3. The empty document contains three canonical datum planes: XY, YZ, and XZ.

You can also create a `.nuke-cad` file directly in the Explorer; double-clicking
it opens it in the CAD viewport by default.

## Sketch mode walkthrough

### Enter sketch mode

1. Open the Feature Tree panel with **Open Feature Tree** (or `CAD Studio →
Geometry`).
2. Click **New Sketch** in the document toolbar, or right-click a datum in the
   feature tree and choose **Edit Sketch**.
3. The **Sketch Plane** picker appears. Choose `XY`, `YZ`, or `XZ`, optionally
   enter an offset, then click **Start Sketch**. To sketch on a face of an
   existing body, click **On Face…**, then click the desired face in the
   viewport.

The viewport switches to an orthographic view looking straight at the datum,
grays out the 3D model, and shows a sketch grid.

### Draw with snap and auto-constraints

The sketch toolbar has six tools:

- **Select** — select/drag primitives and dimension labels.
- **Point** — place a standalone point.
- **Line** — two clicks; near-horizontal or near-vertical lines automatically
  get a horizontal/vertical constraint (within the angle threshold).
- **Circle** — center click, then radius click.
- **3-Point Arc** — start, midpoint, end.
- **Rectangle** — two opposite corners; creates four lines.

The snap engine prioritizes endpoint → midpoint → center → quadrant →
on-curve → grid. Hovering shows a snap marker; clicks commit the snapped
position. When a click lands on an existing endpoint or curve, an auto-
coincident or point-on-object constraint is added automatically.

### Constrain the sketch

Use the **Constraint** dropdown in the overlay to add geometric constraints:

- Coincident, fix, horizontal, vertical
- Parallel, perpendicular, tangent
- Equal, concentric, symmetry
- Point on object

Most constraints are applied by selecting the required number of primitives.
`distance`, `radius`, and `angle` additionally ask for a numeric value or
parameter name.

### Dimension and parameters

Driving dimensions control geometry; reference dimensions just measure it.

- Click a dimension label to open the **Dimension** popover.
- Enter a literal number or a parameter name to bind the dimension.
- Toggle **Driving** to convert between driving and reference.

Open the **Parameters** panel from the toolbar to add, edit, or remove sketch-
local parameters. Parameters bound to a driving dimension cannot be removed
until the dimension is unbound.

### Drag

In select mode, drag a point to reshape the sketch interactively. The solver
applies temporary constraints during the drag and re-solves; the geometry updates
live. Dropped points keep their solved coordinates.

### External geometry

You can project edges or faces from existing solid bodies into the active sketch
as construction geometry:

1. Click the **External Geometry** tool in the sketch toolbar (it targets the
   most recent non-suppressed solid-producing feature).
2. Click a face or edge of the body in the viewport.
3. The picked entity is added to the sketch's **External Geometry** list and,
   after the next rebuild, is projected into the sketch plane as dashed
   construction geometry.

External geometry does not become part of the sketch's output wires or faces; it
is only a reference for snapping and constraints. You can remove a reference
from the list at any time.

### Diagnostics, pan, zoom, and exit

The status line at the bottom shows remaining degrees of freedom, conflicting
constraints, redundant constraints, and the last auto-constraints applied. Click
it when diagnostics exist to open the **Solver Diagnostics** popover and see
which constraints are conflicting or redundant.

- **Pan**: middle-drag or Shift+left-drag.
- **Zoom**: mouse wheel around the cursor.
- **Exit**: click the **Exit Sketch** button in the toolbar or run **Exit
  Sketch** from the Command Palette. The sketch is merged back into the document
  and the viewport returns to the 3D view.

## Features

Sketches become solid features through the document toolbar or the **Add**
commands in the Feature Tree:

- **Pad** — extrude a sketch additively.
- **Pocket** — extrude a sketch as a cut (requires an existing solid).
- **Revolve** — revolve a sketch around `X`, `Y`, or `Z` by an angle in `(0, 360]`.
- **Groove** — revolve-cut (requires an existing solid).

Each feature dialog asks for an extrude direction/revolve axis, length or angle,
and an optional **Label**. Labels are important because they map to the region
manifest: a labeled pad becomes a named volume in `selector_map`, and the
`.regions.json` sidecar can then assign it a material name such as `fuel` or
`clad`. Those material names flow into the DAGMC `.h5m` as `mat:<name>` groups
and into OpenMC Studio on import.

## Feature tree

The **Feature Tree** panel shows three sections:

- **Datums** — XY, YZ, XZ, and any offset datum planes.
- **Sketches** — one row per sketch; click to select, click the edit button to
  re-enter sketch mode.
- **Features** — one row per feature in build order, with status markers from
  the last rebuild (`built`, `stale`, or `failed`) and reference-resolution
  badges when topological references are ambiguous or unmatched. Each row has
  actions for suppress, edit parameters, and delete.

Suppressed features are omitted from the build and mark downstream features as
stale. Deleting a feature with dependents is rejected until the dependencies are
removed or edited.

## Save and rebuild

- **Save CAD Document** writes the JSON file. Saving does not rebuild.
- **Rebuild CAD Geometry** runs the document builder, writes the STEP/tessellation
  artifacts, and refreshes the viewport. The document is also rebuilt when it is
  first opened.
- Build errors surface in a dismissible banner in the viewport and in the feature
  tree status markers.

## Current limitations

This release supports the core workflow. These features are not implemented yet:

- Fillets, chamfers, drafts, shells, holes, mirrors, and patterns.
- Up-to-face / up-to-body extrude termination.
- Boolean feature types (`booleanFuse`, `booleanCut`, `booleanCommon`).

Script mode is unaffected and remains the full-power path for any geometry that
exceeds the GUI modeler's current scope.
