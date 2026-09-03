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
2. Pick a template in the dialog:
   - **Empty document** — the default, no preset parameters.
   - **Pincell starter (cm)** — pre-fills `fuelRadius`, `cladRadius`,
     and `pitch` for a lattice pincell.
   - **Tokamak starter (cm)** — pre-fills `major_radius` and `minor_radius`.
3. Save the new document with **Save CAD Document As...** to give it a name and
   location.
4. The empty document contains three canonical datum planes: XY, YZ, and XZ.

You can also create a `.nuke-cad` file directly in the Explorer; double-clicking
it opens it in the CAD viewport by default.

## Navigating the 3D viewport

- **Orbit**: left-drag.
- **Pan**: right-drag.
- **Zoom**: mouse wheel.
- **Navigation cluster** (bottom-right of the viewport): `ISO`, `T` (top),
  `F` (front), and `R` (right) snap to standard views; the remaining buttons
  fit the view and zoom in/out.
- **Shading menu** (navigation cluster): pick **Shaded**, **Shaded +
  Wireframe**, **Edges only**, or **X-ray**. In X-ray mode a **Ghost opacity**
  slider (15–60%) controls how transparent bodies render, so interior bodies
  show through. The active mode survives rebuilds. Edges only hides face
  fills for a technical-drawing look; face/solid picking is disabled while it
  is active (the viewport shows a hint).
- **Measure tool** (document toolbar Inspect group, also on the sketch
  toolbar): click two points to record a persistent distance label — 3D mode
  snaps to picked surface points, sketch mode uses the active snap settings.
  Measurements live in a list popover where individual rows can be deleted;
  they are viewport-only annotations (never saved into the document) and are
  cleared when the model rebuilds.
- **Section plane** (navigation cluster): slices the model open along an X,
  Y, or Z plane. A popover offers axis buttons, **Flip**, and a slider that
  slides the plane across the model's bounding box. Sectioning is visual
  only — exports are unaffected. Click the button again or press `Esc` to
  exit.
- **Axis gizmo** (top-right, below the toolbar): mirrors the current camera
  orientation; click an axis handle (or its opposite) to snap to that view.
- **View label** (top-left, below the toolbar): shows the active view
  (`User view` after orbiting, `Top view` after snapping) or the active sketch.
- **Fit**: `F` or the fit button frames the whole model; with a solid selected
  it frames that selection instead — `.` and double-clicking a solid also fit
  the selection.
- Press `Tab` to enter sketch mode and `Tab` again to leave it; the labeled
  **Finish Sketch** pill at the top-right does the same.

Build warnings (for example, intentional cross-body overlaps in assemblies)
appear as a compact collapsible strip at the top of the viewport: click the
warning count to expand the full list. The Model Outline's warnings box adds a
one-click **Fuse** fix for overlap warnings in document mode — see
_Getting started → Model Outline panel_.

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

The sketch toolbar has six tools (press the letter, or use the keyboard icon
on the toolbar header for the full cheat sheet — shortcuts apply while the
viewport has focus):

- **Select** (`S`) — select/drag primitives and dimension labels.
- **Point** (`P`) — place a standalone point.
- **Line** (`L`) — two clicks; near-horizontal or near-vertical lines
  automatically get a horizontal/vertical constraint (within the angle
  threshold).
- **Circle** (`C`) — center click, then radius click.
- **3-Point Arc** (`A`) — start, midpoint, end.
- **Rectangle** (`R`) — two opposite corners; creates four lines.

The snap engine prioritizes endpoint → midpoint → center → quadrant →
on-curve → grid. Hovering shows a snap marker; clicks commit the snapped
position. When a click lands on an existing endpoint or curve, an auto-
coincident or point-on-object constraint is added automatically.

The **magnet toggle** on the sketch toolbar turns snapping off entirely for
free placement, and the adjacent **S/M/L** control sets the snap radius
(6/12/24 px). The status line shows the current snap state (for example
`Snap: 12px`).

### Constrain the sketch

Use the **Constraint** dropdown (top-center of the viewport) to
add geometric constraints:

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

### Select, drag, and delete

With the **Select** tool, click a primitive (or a dimension label) to select
it — Shift+click adds to the selection, clicking empty space clears it, and
hovering outlines the primitive under the cursor. Drag a selected point to
reshape the sketch interactively: the solver applies temporary constraints
during the drag and re-solves, and the geometry updates live. Press
Delete/Backspace to remove the selection (deleting a point cascades to its
primitive). Escape works stepwise: it cancels the entity being drawn first,
then clears the selection, and finally returns you to the Select tool from
any drawing tool. The status line reminds you of these bindings while Select
is active.

### Speed-modeling interactions

A few shortcuts speed up repetitive drawing and feature creation:

- **Context shortcut bar (`Q`)** — press `Q` anywhere in the viewport to open a
  small floating toolbar at the cursor. In sketch mode it lists the six sketch
  tools plus the construction-geometry toggle; in document mode it lists
  feature-creation actions (New Sketch, Pad, Pocket, Revolve, Groove, Fillet,
  Chamfer, Draft, Shell, Linear/Circular Pattern, Mirror, Hole). Click an item
  to execute and close the bar; press `Escape` or move the pointer outside the
  viewport to close without action.
- **Constraint relation popover** — in sketch mode, hold `Ctrl` and click a
  second entity to select exactly two primitives. A popover appears at the
  cursor listing the geometric relations valid for that pair (for example,
  parallel/perpendicular/equal for two lines, tangent for a line and a circle).
  Click a relation to apply it; the popover closes on `Escape`, click-away, or
  when the selection changes to anything other than two entities.
- **Auto-dimension on creation** — enable `nukeCad.sketchAutoDimension` in
  preferences. When active, finishing a line, circle, or 3-point arc opens a
  small inline input near the cursor. Type a value or parameter name and press
  `Enter` to create a driving dimension immediately; press `Escape` to skip it.
  Rectangle and point are not auto-dimensioned.

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
- **Exit**: click the **Finish Sketch** pill at the top-right of the viewport,
  or run **Exit Sketch** from the Command Palette. The sketch is merged back
  into the document and the viewport returns to the 3D view.

The sketch toolbar floats and can be dragged anywhere in the canvas by its
**SKETCH** header (the collapsed hamburger drags too). Right-click or
double-click it and choose **Reset Position** to put it back in the corner.
The other sketch panels — Parameters, Solver Diagnostics, External Geometry,
Keyboard Shortcuts, and Measurements — drag the same way: grab the panel
header to move it, right-click or double-click the header to reset it to its
default spot. Panels always stay inside the canvas. The toolbar body groups
its buttons into two columns (draw / modify & constraint / lists), and the
active tool is highlighted.
Dimension labels shift apart automatically when they would overlap; drag a
label to pin it to a spot of your choosing — pinned labels keep their
placement while you zoom and pan, and unpinned labels keep auto-shifting.
Deleting the dimension clears its pin.

## Bodies

A `.nuke-cad` v2 document contains one or more solid **bodies**. Each body is an
independent accumulator of material; features target a body by id. New bodies are
created from the document toolbar or the **Add Body** command in the Feature
Tree. A body can be renamed and can carry an optional **Label** that maps to the
region manifest for DAGMC/mesh export.

Bodies let you model multi-part assemblies: for example, a pincell can have
separate `clad`, `fuel`, and `moderator` bodies that touch but remain distinct
solids. Bodies that overlap in space must be merged with a boolean feature; the
builder raises an error if two non-consumed bodies occupy the same volume.

## Features

Sketches become solid features through the document toolbar or the **Add**
commands in the Feature Tree:

- **Pad** — extrude a sketch additively into a body.
- **Pocket** — extrude a sketch as a cut (requires an existing solid body).
- **Revolve** — revolve a sketch around `X`, `Y`, or `Z` by an angle in `(0, 360]`.
- **Groove** — revolve-cut (requires an existing solid body).
- **Boolean Fuse** — union one or more tool bodies into a target body.
- **Boolean Cut** — subtract one or more tool bodies from a target body.
- **Boolean Common** — intersect a target body with one or more tool bodies.
- **Fillet** — round selected edges of a body.
- **Chamfer** — bevel selected edges with symmetric, two-distance, or
  distance-angle modes.
- **Draft** — taper selected faces by an angle along a pull direction.
- **Shell** — hollow a body by a uniform wall thickness, optionally leaving
  selected faces open.
- **Linear Pattern** — replicate a sketch-based solid feature along `X`, `Y`, or
  `Z`.
- **Circular Pattern** — replicate a sketch-based solid feature around a global
  axis or a datum axis.
- **Mirror** — mirror a sketch-based solid feature across a coordinate plane or
  a datum plane.
- **Hole** — place a simple, counterbore, or countersink hole on a planar face.

Each solid feature dialog asks for the target body, extrude direction/revolve
axis, length or angle, and an optional **Label**. Boolean dialogs ask for a
target body, one or more tool bodies, and whether to keep the tool bodies after
the operation. Labels are important because they map to the region manifest: a
labeled body or feature becomes a named volume in `selector_map`, and the
`.regions.json` sidecar can then assign it a material name such as `fuel` or
`clad`. Those material names flow into the DAGMC `.h5m` as `mat:<name>` groups
and into OpenMC Studio on import.

## Dress-up features

Dress-up features modify the existing B-rep of a body after its solid features.
They are available from the document toolbar and the Feature Tree **Add** menu.

### Fillet

1. Select the target body.
2. Click **Pick edges** and select one or more edges in the viewport. Hover
   highlights the candidate edge; click adds it to the list. Use the remove
   button next to a listed edge to delete it.
3. Enter a **Radius**.
4. Click **Create** to add the fillet feature.

### Chamfer

1. Select the target body and pick edges the same way as fillet.
2. Choose a mode:
   - **Symmetric** — one **Distance** applied to both sides of the edge.
   - **Two distances** — two values (`distances[0]` and `distances[1]`).
   - **Distance-angle** — one **Distance** and an **Angle** in degrees.
3. Click **Create**.

### Draft

1. Select the target body.
2. Click **Pick faces** and select the faces to taper.
3. Enter a **Draft angle** in degrees.
4. Set the **Pull direction** vector (the direction along which the faces are
   tapered; the default is `+Z`).
5. Click **Create**.

### Shell

1. Select the target body.
2. Choose whether to hollow the entire body or leave selected faces open:
   - **Hollow all faces** — uniform wall thickness everywhere.
   - **Pick faces** — select faces to remove; all remaining faces are offset
     inward by the thickness.
3. Enter a **Thickness**.
4. Click **Create**.

All dress-up targets are stored as `TopologyRef`s — geometric fingerprints of
edges or faces — so the feature remains parametric: if an earlier edit changes
the B-rep, the reference resolver attempts to find the matching entity again and
reports `ambiguous` or `unmatched` status in the Feature Tree if it cannot.

## Patterns

Patterns replicate an existing sketch-based solid feature (`pad`, `pocket`,
`revolve`, or `groove`) on the same body. The source feature must be earlier in
the document order, and the pattern feature itself targets the source's body.

### Linear pattern

1. Select the target body.
2. Choose the **Source feature** (the sketch-based solid feature to replicate).
3. Enter **Count** (total number of occurrences, including the original) and
   **Spacing**.
4. Pick the **Axis** (`X`, `Y`, or `Z`).
5. Click **Create**.

The first instance is the original source feature; additional instances are
spaced at `k * spacing` along the chosen axis.

### Circular pattern

1. Select the target body and **Source feature**.
2. Enter **Count** and the total **Angle** in degrees (default `360`).
3. Choose the rotation axis:
   - **Global axis** — `X`, `Y`, or `Z` through the origin.
   - **Datum axis** — a datum plane whose normal defines the axis through its
     origin.
4. Click **Create**.

A full `360°` sweep places instances at `k * 360/count` with no duplicate at
`2π`. A partial sweep distributes instances evenly between the start angle and
the sweep angle and requires count ≥ 2.

## Mirror

1. Select the target body and the **Source feature** to mirror.
2. Choose the mirror plane:
   - **Coordinate plane** — `XY`, `YZ`, or `XZ`.
   - **Datum plane** — any datum in the document.
3. Click **Create**.

The mirrored copy is appended for additive sources (`pad`/`revolve`) or cut for
subtractive sources (`pocket`/`groove`). Overlapping mirror copies of additive
sources fail with the same clear overlap error as overlapping additive features.

## Hole wizard

The hole wizard places a cylindrical, counterbore, or countersink hole on a
planar face of an existing body.

1. Select the target body.
2. Click **Pick face**; the viewport enters hole face-pick mode. Hover
   highlights candidate faces and a click sets the hole center at the pointer
   position on the face. Right-click or Escape cancels the pick.
3. Choose the **Preset**:
   - **Simple** — straight cylinder.
   - **Counterbore** — cylinder with a larger cylindrical clearance at the top.
   - **Countersink** — cylinder with a conical clearance at the top.
4. Enter **Diameter**. For a blind hole, enter **Depth**; omit depth for a
   through-hole.
5. For counterbore, enter **Counterbore diameter** and **Counterbore depth**.
6. For countersink, enter **Countersink diameter** and **Countersink angle**.
7. Click **Create**.

The placement face is stored as a `TopologyRef`, so the hole survives parametric
edits that reshape the body as long as the resolver can still identify the face.

## 3D curves

Curves are lightweight 3D polylines stored in the `.nuke-cad` document. They are
useful for centerlines, coil paths, or any geometry that is not a solid body but
needs to be visualized and exported.

### Adding and editing curves

1. Open the Feature Tree and click the **+** button in the **CURVES** section
   header.
2. In the curve dialog, choose the source type:
   - **Points** — paste or type an explicit list of `[x, y, z]` samples, or
     **Load from file** to read them from a CSV/whitespace-separated text file.
   - **Parametric** — enter expressions for `x(t)`, `y(t)`, and `z(t)`, plus the
     `t` range and sample count. The expression editor supports the same
     arithmetic, functions, and constants used elsewhere in Nuke CAD
     (`+ - * / ^`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sqrt`, `abs`,
     `exp`, `log`, `min`, `max`, `pi`, `e`) and resolves document parameters by
     name.
   - **Fourier** — enter the toroidal mode number `nfp`, harmonic order, and
     cos/sin coefficients for each spatial axis. The series is sampled uniformly
     over `[0, 2π)`.
3. Click **OK**. The curve is resampled from the source recipe and added to the
   document.

### Curve behavior

- Curves appear in the Feature Tree under the **CURVES** section. Selecting a
  curve highlights its polyline in the viewport.
- You can rename or delete a curve from its row in the Feature Tree.
- Curves are independent of solid bodies: they do not participate in boolean
  operations or feature dependencies.
- A curve whose last sample meets the first is built as a closed periodic
  wire; parametric and Fourier loops close automatically, while a points list
  closes by repeating the first point at the end.
- **Export as Python** writes each curve as a `bd.Spline` call over its sample
  points.
- The geometry service builds a B-spline wire for each curve and includes it in
  the tessellation output, so curves render in the viewport even when the
  document contains no solid bodies.

## Feature tree

The **Feature Tree** panel shows four sections:

- **Bodies** — one row per body; click to select (the body's solids highlight
  in the viewport), double-click the name (or click the edit button) to
  rename. New bodies are added from the document toolbar.
- **Datums** — XY, YZ, XZ, and any offset or face datum planes.
- **Sketches** — one row per sketch; click to select, click the edit button to
  re-enter sketch mode.
- **Features** — one row per feature in build order, showing its target body and
  (for booleans) the target/tool bodies. Clicking a feature highlights its
  body's solids in the viewport. Status markers from the last rebuild
  (`built`, `stale`, or `failed`) and reference-resolution badges when
  topological references are ambiguous or unmatched. Each row has actions for
  suppress, move up/down, edit parameters, and delete; boolean features cannot
  be edited.

Suppressed features are omitted from the build and mark downstream features as
stale. Deleting a feature with dependents prompts you to either cancel or
**cascade delete** the feature plus all of its transitive dependents (including
pattern/mirror `source` references). Reordering with the up/down arrows preserves
the `dependsOn` precedence rule; invalid moves are rejected with a clear error.

### Reference repair

Topological references sometimes become ambiguous or unmatched after a parametric
edit. The feature tree shows an **ambiguous** or **unmatched** badge; click the
badge to open the repair popover. It lists the current fingerprint and the top
scoring candidate(s) from the rebuilt B-rep — unmatched references also offer up
to three best candidates. Picking a candidate updates the reference fingerprint
in place and triggers a rebuild so you can verify the repair.

### Export as Python

The document toolbar and feature tree header both offer **Export as Python**.
This writes a one-way, deterministic build123d-style script from the current
`.nuke-cad` document: parameters become module-level variables, sketches become
builder functions, and features are emitted in dependency order. Topology-
reference-dependent items (face datums, external geometry, fillet/chamfer edges,
draft/shell faces, and hole placement faces) are emitted as clearly marked
`# TODO(manual):` comments so nothing is silently dropped. The export is not
round-trippable; it is intended as readable output for downstream editing.

## Save and rebuild

- **Save CAD Document** writes the JSON file. Saving does not rebuild.
- **Rebuild CAD Geometry** runs the document builder, writes the STEP/tessellation
  artifacts, and refreshes the viewport. The document is also rebuilt when it is
  first opened.
- Build errors surface in a dismissible banner in the viewport and in the feature
  tree status markers.

## Demo model: tokamak with divertor

A complete `.nuke-cad` demo model is maintained at
`tests/e2e/assets/tokamak_with_divertor.nuke-cad`. It rebuilds the paramak
`tokamak_with_pf_tf_magnets_divertor` STEP as a GUI-authored document:

- 22 labeled bodies: TF coils, PF coils and cases, center column, inboard/outboard
  blankets and first walls, plasma, divertor, and six TF inner legs.
- Revolved poloidal layers, a rectangular TF coil profile padded toroidally and
  patterned 7 times over 180°, boolean clipping to the half-model symmetry plane,
  and a lower divertor volume.

The plasma-facing boundaries in the reference STEP are periodic BSplines. The
GUI modeler expresses them with dense polylines sampled from the STEP edges
(chordal approximation, up to 255 segments per boundary). DAGMC faceting is chordal
anyway, so this is at or below the pipeline's geometric resolution. The drift
test compares the rebuilt per-body volumes against the STEP reference; spline-
approximated bodies are held to a 1e-3 relative tolerance, while bodies with only
planar/cylindrical/conical faces are held to 1e-6 plus an exact face-count check.

## Current limitations

This release supports the core workflow. These features are not implemented yet:

- Up-to-face / up-to-body extrude termination.
- Direct viewport picking of tool bodies for booleans (use the dialog dropdowns
  instead).

Script mode is unaffected and remains the full-power path for any geometry that
exceeds the GUI modeler's current scope.
