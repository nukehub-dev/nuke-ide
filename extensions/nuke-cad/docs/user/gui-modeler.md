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

The document toolbar carries a **Units** dropdown (`Unitless`, `mm`, `cm`,
`m`). Declared units tag future numeric inputs (curve expressions may then
carry unit syntax); changing units never rescales existing numbers. STEP and
IGES imports read the file's length unit: a new document adopts it, and a
mismatch against declared document units scales the geometry by the exact
factor (reported in the import message).

You can also create a `.nuke-cad` file directly in the Explorer; double-clicking
it opens it in the CAD viewport by default.

## Navigating the 3D viewport

- **Orbit**: left-drag.
- **Pan**: right-drag.
- **Zoom**: mouse wheel.
- **Navigation style** (`nukeCad.navigationStyle` setting): `orbit` as above;
  `solidworks` reserves left-drag for selection with middle-drag orbit;
  `tinkercad` orbits on right-drag with middle-drag pan; `touchpad` uses
  one-finger pan and two-finger dolly-rotate. Right-click context menus work
  in every style.
- **Viewer bottom bar** (bottom-right of the viewport, shared with the native VTK viewers): `ISO`, `T` (top),
  `F` (front), and `R` (right) snap to standard views; the remaining core buttons
  fit the view and zoom in/out. Shading, section, and Explode stay CAD-only tools on the same bar.
- **Shading menu** (bottom bar): pick **Shaded**, **Shaded +
  Wireframe**, **Edges only**, or **X-ray**. In X-ray mode a **Ghost opacity**
  slider (15–60%) controls how transparent bodies render, so interior bodies
  show through. The active mode survives rebuilds. Edges only hides face
  fills for a technical-drawing look; face/solid picking is disabled while it
  is active (the viewport shows a hint).
- **Measure tool** (document toolbar Inspect group, also on the sketch
  toolbar): the Measurements popover selects the mode — **Distance** clicks
  two points, **Angle** clicks three (A, vertex B, then C; the overlay draws
  segments BA/BC and labels the angle at B), and **Radius** clicks a circular
  edge in the 3D view (radius and diameter come from the edge's geometric
  fingerprint, or a circle fit when no center is known; non-circular edges
  are rejected with a warning). 3D mode snaps to picked surface points,
  sketch mode always measures distance with the active snap settings.
  Measurements live in a list popover where individual rows can be deleted;
  they are viewport-only annotations (never saved into the document) and are
  cleared when the model rebuilds. Pinning a row (3D measurements only)
  saves it into the document's `measurements` block instead: pinned rows
  survive rebuilds and re-render afterwards, ride snapshot undo/redo like
  any other edit, and never affect builds, exports, or the exported script.
  Unpinning keeps the row on screen as an ephemeral measurement; deleting a
  pinned row removes the saved copy too.
- **Section plane** (bottom bar): slices the model open along an X,
  Y, or Z plane. A popover offers axis buttons, **Flip**, and a slider that
  slides the plane across the model's bounding box. Sectioning is visual
  only — exports are unaffected. Click the button again or press `Esc` to
  exit. The shading and section popovers share one slot: opening one closes
  the other, and picking a mode, pressing `Esc`, or clicking the canvas
  closes it.
- **Explode view** (bottom bar): the **Explode** slider (0–100%)
  moves every solid away from the model center along the direction to its
  own centroid, so a fused multi-part body (for example a circular pattern)
  separates into its solids — faces and edge lines move together. Travel is
  capped at 0.35× the model diagonal at 100% so large assemblies stay
  framed; press `F` to refit while exploded. Explode is
  a viewport-only transform: it is never saved into the document, resets to
  0 when the model reloads or rebuilds, and picking keeps working on
  displaced solids. Measurements already on screen keep their original
  world positions — they are **not** re-anchored to moved solids — so set
  the slider back to 0 before reading measurements taken on the assembled
  model.
- **Canvas background** (`nukeCad.viewportBackground` setting): `theme`
  (default, follows the active Theia theme), `dark`, `light`, or `gradient`.
- **Orientation cube** (top-right, below the toolbar, shared with the native VTK viewers): mirrors the current camera
  orientation; click an axis knob (or its opposite) to snap to that view.
- **View badge** (top-left, below the toolbar, shared with the native VTK viewers): shows the active view
  (`User view` after orbiting, `Top view` after snapping) or the active sketch.
- **Fit**: `F` or the fit button frames the whole model; with a solid selected
  it frames that selection instead — `.` and double-clicking a solid also fit
  the selection.
- **Context menu**: right-click the canvas (no pick mode or sketch session
  active) for a context menu instead of the browser default. On a solid it
  offers **Edit Feature…** (the solid is attributed to the latest feature that
  wrote its body — disabled when no feature matches, e.g. script/STEP models),
  **Measure Distance / Angle / Radius**, **Fit to Solid**, and **Hide /
  Isolate Solid**; on empty space it offers **Fit All**, **Show All Solids**
  (disabled when nothing is hidden), a **Section View** toggle, and **Reset
  Explode** (disabled at 0%). It closes on a click elsewhere or `Esc`.
- Press `Tab` to enter sketch mode and `Tab` again to leave it; the labeled
  **Finish Sketch** pill at the top-right does the same.

Build warnings (for example, intentional cross-body overlaps in assemblies)
appear as a compact collapsible strip at the top of the viewport: click the
warning count to expand the full list. The Model Outline's warnings box groups
DAGMC export diagnostics (overlap, seal, sense, imprint stages, inspection)
with per-group repair hints and adds a
one-click **Fuse** fix for overlap warnings in document mode — see
_Getting started → Model Outline panel_. Every imprint fallback is reported
with its stage; nothing is ever retried silently, and the model is never
modified to force an export.

## Sketch mode walkthrough

### Enter sketch mode

1. Open the Feature Tree panel with **Open Feature Tree** (or `CAD Studio →
Geometry`).
2. Click **New Sketch** in the document toolbar, or right-click a datum in the
   feature tree and choose **Edit Sketch**.
3. The **Sketch Plane** picker appears. Choose `XY`, `YZ`, or `XZ`, optionally
   enter an offset, then click **Start Sketch**. To sketch on a face of an
   existing body, click **On Face…**, then click the desired face in the
   viewport. The picker also offers **3-Point** (plane through three
   coordinates), **Midplane** (midway between two picked faces), and
   **Line-2Pt** (an axis through two coordinates, for pattern axes only —
   sketches cannot be placed on it).

The viewport switches to an orthographic view looking straight at the datum,
grays out the 3D model, and shows a sketch grid.

### Draw with snap and auto-constraints

The sketch toolbar has nine tools (press the letter, or use the keyboard icon
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
- **Ellipse** (`E`) — center click, major-axis endpoint click, then a third
  click whose perpendicular distance to the major axis sets the minor radius.
  An equal-radius third click is rejected with a hint (use the Circle tool
  instead); a minor radius above the major radius is clamped with a hint.
- **B-spline** (`B`) — click to place control polygon poles; the curve is
  drawn through the polygon (clamped, interpolating the first and last pole).
  Press **Enter** or **double-click** to finish (two or more poles; a lone
  pole is discarded), or **Escape** to cancel.
- **Slot** (`O`) — two center clicks plus a width click; creates two lines
  joined by tangent arcs with equal radii. A zero width is rejected with a
  hint.
- **Trim** (`T`) — click a segment to clip it back to the nearest
  intersections; constraints on removed portions are cleaned up.
- **Extend** (`X`) — click near an open line/arc end to extend it to the
  next curve.
- **Split** (`D`) — click a point on a curve to break it in two.
- **Sketch Fillet** (`J`) — click two lines, then a point setting the
  radius; **Sketch Chamfer** (`K`) works the same with a distance point.
- **Polyline** (`W`) — chained line/arc segments (`M` toggles line/arc),
  double-click or Enter finishes.
- **Polygon** (`Y`) — center and vertex clicks (`M` cycles sides 3–12);
  **Arc Slot** (`U`) — center, start, end, and width clicks.
- Rectangle modes (`M` while drawing): corner, center, or rounded.
- The diagnostics popover offers **Remove redundants** in one click.

### Transform selection

With entities selected, the transform group offers **Move** (`V`) and
**Copy** (`G`, click base then target points), **Rotate** (`I`, click center
then an angle point), and **Mirror** (`N`, exactly one selected line as the
axis, mirrored copies plus symmetry constraints). **Scale**, **Rectangular
Array** (rows/columns/spacing), and **Offset** (distance, with an auto-trim
checkbox that miter-joins overlaps, on by default) open inline
popovers; **Join** connects two selected open endpoints immediately.

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
- Axis-locked distance (`DistanceX`/`DistanceY`), diameter, block
  (freeze-in-place)

Most constraints are applied by selecting the required number of primitives.
`distance`, `radius`, and `angle` additionally ask for a numeric value or
parameter name.

Curve-level constraints (horizontal/vertical, tangent, equal, concentric,
point-on-object, radius/diameter) apply to lines, circles, and arcs. Ellipses
and B-splines only accept point-level constraints on their points — the
ellipse center/focus and the B-spline poles are ordinary sketch points, so
coincident, fix, distance, and symmetry work on them.

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
  small floating toolbar at the cursor. In sketch mode it lists the eight sketch
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
  Rectangle, point, ellipse, and B-spline are not auto-dimensioned.

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

### Carbon copy

To reuse another sketch's content, select it in the Feature Tree, enter the
target sketch, and click the **Carbon Copy** toolbar button: the source
sketch's primitives, constraints, and dimensions are imported with fresh ids
(construction flags and parameter bindings preserved). Copying a sketch onto
itself is rejected.

### Diagnostics, pan, zoom, and exit

The status line at the bottom shows remaining degrees of freedom, conflicting
constraints, redundant constraints, and the last auto-constraints applied. Click
it when diagnostics exist to open the **Solver Diagnostics** popover and see
which constraints are conflicting, redundant, or partially redundant. The
diagnostics also flag missing coincident constraints on touching endpoints,
open profile vertices, and whether the sketch is fully constrained.

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

- **Pad** — extrude a sketch additively into a body. Besides a blind
  length, the end can terminate at the first/last face hit, at a picked
  face, at another body, or through the whole body, optionally two-sided.
- **Pocket** — extrude a sketch as a cut (requires an existing solid body),
  with the same end conditions as pad.
- **Revolve** — revolve a sketch around `X`, `Y`, or `Z` by an angle in `(0, 360]`,
  blind or through-all.
- **Groove** — revolve-cut (requires an existing solid body), blind or
  through-all.
- **Primitive** — place a box, cylinder, sphere, cone, or torus on a datum,
  no sketch required; optionally subtractive (cuts into an existing body).
- **Sweep** — sweep a sketch section along a 3D curve.
- **Pipe** — sweep a circular section of a given radius along a 3D curve (no
  sketch required).
- **Loft** — join two or more ordered sketch sections into a single solid.
- **Helical Sweep** — sweep a sketch section along an analytic helix (spring,
  coil, or twisted path); optionally subtractive.
- **Boolean Fuse** — union one or more tool bodies into a target body.
- **Boolean Cut** — subtract one or more tool bodies from a target body.
- **Boolean Common** — intersect a target body with one or more tool bodies.
- **Fillet** — round selected edges of a body.
- **Chamfer** — bevel selected edges with symmetric, two-distance, or
  distance-angle modes.
- **Draft** — taper selected faces by an angle along a pull direction, with
  an optional neutral plane.
- **Shell** — hollow a body by a uniform wall thickness, optionally leaving
  selected faces open.
- **Defeature** — delete selected faces (small holes, logos, and other
  detail to remove before meshing/export).
- **Linear Pattern** — replicate a sketch-based solid feature along `X`, `Y`, or
  `Z`.
- **Circular Pattern** — replicate a sketch-based solid feature around a global
  axis or a datum axis (including two-point line datums).
- **Mirror** — mirror a sketch-based solid feature across a coordinate plane or
  a datum plane.
- **Multi-Transform** — chain two pattern/mirror features on the same body.
- **Hole** — place a simple, counterbore, countersink, or counterdrill hole
  on a planar face, with optional taper, drill-point angle, and a cosmetic
  thread flag.

Each solid feature dialog asks for the target body, extrude direction/revolve
axis, length or angle, and an optional **Label**. Every dialog also offers a
**Preview** checkbox that ghosts the tentative result in the viewport while
you edit (blind ends and valid inputs only; cuts and dress-ups preview
against the body's current geometry). Boolean dialogs ask for a
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
   tapered; the default is `+Z`), and optionally pick a **Neutral plane**.
5. Click **Create**.

### Defeature

1. Select the target body.
2. Click **Pick faces** and select the faces to delete (heals the solid).
3. Click **Create**.

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

Patterns replicate an existing solid feature (`pad`, `pocket`, `revolve`,
`groove`, `sweep`, `pipe`, `loft`, `helicalSweep`, or `primitive`) on the same
body. The source feature must be earlier in the document order, and the
pattern feature itself targets the source's body. A per-instance **Scale**
scales each copy about its own center (`1` = unchanged).

### Linear pattern

1. Select the target body.
2. Choose the **Source feature** (the sketch-based solid feature to replicate).
3. Enter **Count** (total number of occurrences, including the original) and
   **Spacing**.
4. Pick the **Axis** (`X`, `Y`, or `Z`) or a **Datum axis** (two-point line
   datum, or a plane datum normal).
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

### Multi-transform

Chain two pattern/mirror features on the same body (the first earlier in
document order): pick both sources and the body. The second transform applies
over the first transform's full instance set.

### Lattice

Replicate a solid feature over a **Rectangular** grid (`rows` × `cols`,
`pitch`, optional second pitch) or a **Hexagonal** ring (`rings`) for fuel
assemblies and blanket modules. Each cell gets a label
(`<prefix>_r<row>c<col>`, previewed live in the dialog) that becomes a DAGMC
group on export, so cells resolve to individual volumes. Overlapping cells
fuse like pattern instances; lattices can themselves be pattern/mirror
sources, but not nested inside another lattice.

## Mirror

1. Select the target body and the **Source feature** to mirror.
2. Choose the mirror plane:
   - **Coordinate plane** — `XY`, `YZ`, or `XZ`.
   - **Datum plane** — any datum in the document.
3. Click **Create**.

The mirrored copy is appended for additive sources
(`pad`/`revolve`/`sweep`/`pipe`/`loft`/`helicalSweep`) or cut for subtractive
sources
(`pocket`/`groove`). Overlapping mirror copies of additive
sources fail with the same clear overlap error as overlapping additive features.

## Hole wizard

The hole wizard places a cylindrical, counterbore, countersink, or
counterdrill hole on a planar face of an existing body.

1. Select the target body.
2. Click **Pick face**; the viewport enters hole face-pick mode. Hover
   highlights candidate faces and a click sets the hole center at the pointer
   position on the face. Right-click or Escape cancels the pick.
3. Choose the **Preset**:
   - **Simple** — straight cylinder.
   - **Counterbore** — cylinder with a larger cylindrical clearance at the top.
   - **Countersink** — cylinder with a conical clearance at the top.
   - **Counterdrill** — stepped cylinder with a flat seat.
4. Enter **Diameter**. For a blind hole, enter **Depth**; omit depth for a
   through-hole. A **Taper angle** widens the mouth; a **Drill-point angle**
   adds a conical tip to blind holes (blank = flat).
5. For counterbore, enter **Counterbore diameter** and **Counterbore depth**.
6. For countersink, enter **Countersink diameter** and **Countersink angle**.
7. For counterdrill, enter **Counterdrill diameter** and **Counterdrill depth**.
8. A **Thread** preset: **None**, **Cosmetic** (stored for downstream use
   without modeling threads), or **Modeled** (cuts a real ISO thread into a
   simple blind hole; counterbore/taper combinations are rejected).
9. Click **Create**.

The placement face is stored as a `TopologyRef`, so the hole survives parametric
edits that reshape the body as long as the resolver can still identify the face.

## Sweep and pipe

Sweep and pipe solidify a section swept along a 3D curve (see
[3D curves](#3d-curves)). Both are additive-only: they can start a new body or
fuse into an existing one, and patterns and mirror can replicate them like any
other solid feature.

### Sweep

1. Select a closed sketch — it becomes the section profile.
2. Choose the **Path curve** from the dropdown, or click **Pick in viewport**
   and click a curve directly. Hover highlights the candidate curve; right-click
   or Escape cancels the pick.
3. Choose the **Orientation**:
   - **Frenet** — the section frame follows the path (default).
   - **Fixed binormal** — locks the section's binormal to a fixed `[x, y, z]`
     vector you provide; useful when the Frenet frame would twist on planar or
     gently curving paths.
4. Optionally enable **Preview** to ghost the swept solid in the viewport while
   you edit. The preview builds the tentative feature through the normal
   geometry pipeline, so it shows exactly the shape the feature adds.
5. Click **Create**.

The section is automatically repositioned to the path start, oriented by the
path tangent; the sketch plane itself only defines the section shape.

### Pipe

Pipe is a sweep with a circular section — no sketch needed.

1. Choose the **Path curve** (dropdown or viewport pick).
2. Enter the **Radius**.
3. Choose the **Orientation** as for sweep.
4. Click **Create**.

## Loft and helical sweep

Loft and helical sweep build solids without a document curve: a loft joins
ordered sketch sections, and a helical sweep derives its path from parameters.
Both are additive-only (they can start a new body or fuse into an existing
one) and can be replicated by patterns and mirror like any other solid
feature.

### Loft

A loft joins two or more sketch sections into a single solid. Unlike sweep,
the sections are used **as positioned** on their datum planes — sketch on an
offset datum to place that section in space.

1. Click **Loft** in the Additive toolbar group (no sketch selection needed).
2. Build the ordered **Sections** list: pick document sketches from the
   **Add section…** dropdown, remove a row with its × button, and reorder
   sections with the up/down buttons. Sections are joined in list order.
3. Choose the skin:
   - unchecked (default) — a smooth skin blends between the sections.
   - **Ruled** — a straight skin runs between the sections; it requires
     compatible profiles (matching vertex counts) and fails with a clear
     error otherwise — try the smooth skin.
4. Choose the target body (**New body** or an existing one) and click
   **Create**.

Each section must be a single closed profile without inner loops (a sketch
with holes fails with a named error). A section-sketch edit dirties the loft
exactly like a sketch edit dirties a pad, and a sketch used as a section
cannot be deleted until the loft is removed.

Optionally enable **Preview** to ghost the lofted solid in the viewport while
you edit. The preview builds the tentative feature — all section sketches plus
the draft loft — through the normal geometry pipeline.

### Helical Sweep

A helical sweep sweeps a sketch section along an analytic helix — springs,
coils, or twisted paths — generated from parameters rather than a document
curve.

1. Select a closed sketch — it becomes the section profile.
2. Click **Helical Sweep** in the Additive toolbar group.
3. Choose the helix **Axis** (`X`, `Y`, or `Z` through the origin).
4. Enter **Start radius** (distance from the axis to the helix start),
   **Pitch** (axial rise per turn), and **Turns**. The swept height is
   `pitch × turns`.
5. Optionally check **Left-handed** to flip the winding direction.
6. Choose the **Orientation**:
   - **Fixed binormal** (default) — the section keeps its attitude like a
     stretched spring (no roll); the binormal vector is prefilled to the axis
     direction and can be edited.
   - **Frenet** — the section frame follows the helix, twisting the profile
     along the path.
7. Optionally enable **Preview** to ghost the swept solid while you edit.
8. Click **Create**.

The section is automatically repositioned to the helix start; like sweep, a
section wider than the coil radius fails with the self-intersection error.

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
     name. When the document declares `units` (`mm`/`cm`/`m`), expressions may
     carry units (`10mm`, `1cm`) and each coordinate coerces to the document
     unit; without declared units, unit syntax is rejected.
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
  suppress, move up/down, edit parameters, and delete — including boolean
  features.

### Editing a feature

To change an existing feature's parameters instead of deleting and recreating
it, use any of:

- The feature tree row's **edit parameters** pencil — the feature dialog
  reopens prefilled with the feature's current parameters (target/tool bodies
  for booleans, edges/faces for dress-ups, sections for lofts); confirming
  updates the feature and rebuilds.
- The **Edit Feature** command in the Command Palette — it edits the feature
  currently selected in the Feature Tree (select a row first).
- The **viewport context menu** (below) — right-click the solid and choose
  **Edit Feature…**.

Feature dialogs float: drag them by their header to move them out of the
model's way, and double-click (or right-click) the header to snap them back to
the center.

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

## Parameters spreadsheet

The **Model Outline** panel carries a **Parameters** section for `.nuke-cad`
documents: a sortable table of `{name, value, unit, used-by}` rows over the
document parameters. The unit column shows the declared document unit (`—`
when the document is unit-less); parameters are plain numbers in that unit.

- Click a value to edit it in place. Values accept plain numbers or
  expressions over the other parameters (`width * 2 + 1`), evaluated with the
  same expression parser as curve sources — there is no new syntax to learn.
  Invalid input shows the validator reason inline (unknown name, syntax
  error, division by zero) and never commits. On documents with a declared
  unit, unit literals coerce to that unit (`10mm`→10 in a `mm` document);
  unit-less documents accept plain numbers only.
- The **Used by** column counts everything a rename-free edit would rebuild:
  sketches referencing the parameter (driving-dimension bindings and
  parameter-valued constraints), curve expressions naming it, the features
  consuming those sketches/curves, and their transitive dependents through
  the feature graph. Hover a cell for the full referrer list.
- Add rows with the name/value footer; delete rows with the per-row button.
  Adding a duplicate name is rejected, and deleting a referenced parameter is
  rejected with the referrer list — unbind the dimension or rewrite the curve
  expression first, the same way deleting a referenced sketch works.
- Edits write through the normal document mutation path: schema validation,
  snapshot undo/redo, and rebuild scheduling all behave exactly like any
  other edit (`auto` rebuilds immediately, `manual` marks the model stale
  until **Rebuild CAD Geometry** runs).

The panel header's **BOM** button exports a bill of materials as CSV
(`instance/body, label, material, volume`): one row per built solid from the
per-solid summaries, joined with manifest labels and materials (in-CAD body
tags fill gaps until the next export picks them up). Assembly documents keep
their `<instance>/<label>` selector keys in the first column. This is a
spreadsheet export, not a stored object — the BOM always derives from the
current build.

## Assemblies

An assembly instantiates parts — bodies of the same document, other
`.nuke-cad` documents, or STEP/IGES/BREP files — and positions them with
mates between named connector frames:

1. Add an **Instance** for each part (same-document body, document path, or
   CAD file path).
2. Add **Connectors** (named frames) on the instances to join.
3. Add a **Mate** between two connectors (one mate per part pair); the mate
   type sets which degrees of freedom stay free (shown as a hint).
4. **Ground** exactly one instance; mates solve outward from ground in
   closed form. Ungrounded, unmated instances keep their stored placement.

The **BOM** panel (`CAD Studio → BOM`) lists instance, part source, mate
type, and DOF contribution; clicking a row selects the instance in the
viewport. Assembly STEP export keeps one product per instance; DAGMC export
imprints the placed solids (overlap stays a warning — assemblies overlap
intentionally).

## Materials

A Feature Tree body row carries a **tag button**: enter a bare material name
(`UO2`, never `mat:`-prefixed) to tag the body. Tags merge into the region
manifest on every build and persist `<stem>.regions.json` beside the
document, so **Import from nuke-cad...** in OpenMC Studio resolves them to
placeholder materials automatically. An explicit sidecar entry for the same
body always wins over the tag. Tagging never triggers a rebuild and is fully
undo-covered. DAGMC group names stay label-based; the material travels
through the sidecar link.

## Drawings

**Open Drawing Sheet** (`CAD Studio → Drawings`) creates a single-sheet 2D
drawing of the document (A4/A3 landscape):

1. Create a sheet, then a base view (front/top/right preset).
2. Add projected, section (axis/fraction/flip), or detail views from a
   selected parent view; drag views on the sheet (5 mm snap).
3. Dimension with the dimension tool: **Pick in viewport**, then click one
   model edge (radius/diameter) or two (distance). Dimensions stay
   associative — they recompute from the 3D model on every build and flag
   `stale` when their reference breaks.

Export SVG (native) or DXF (visible/hidden/section/dimension layers) from
the sheet. PDF export is not in this release.

## Undo and redo

The document toolbar offers **Undo** (`Ctrl+Z`) and **Redo** (`Ctrl+Shift+Z`
/ `Ctrl+Y`) over committed document changes (depth 100). Sketch strokes are
not individual steps — one undo step covers everything saved with the
sketch. Undo and redo rebuild exactly like a normal edit.

## Save and rebuild

- **Save CAD Document** writes the JSON file. Saving does not rebuild.
- **Rebuild CAD Geometry** runs the document builder, writes the STEP/tessellation
  artifacts, and refreshes the viewport. The document is also rebuilt when it is
  first opened.
- Build errors surface in a dismissible banner in the viewport and in the feature
  tree status markers.
- **Large documents:** every edit rebuilds by default (`nukeCad.rebuildOnEdit:
auto`). For models where each rebuild is expensive (patterned assemblies),
  switch the setting to `manual`: edits then only mark the model stale until
  **Rebuild CAD Geometry** runs — opening still always builds. Suppressing an
  expensive pattern/mirror feature in the Feature Tree has the same effect for
  that subtree and composes with either mode.
- **Result cache:** rebuilds persist per-feature B-reps plus a doc-level
  tessellation blob to a `<stem>.nuke-cache.zip` sidecar next to the document,
  so edits rebuild only the dirty closure and cache-hit opens skip meshing.
  `nukeCad.resultCacheSizeMB` (default 1024 MB) caps the sidecar size before
  old entries are evicted.

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

- Direct viewport picking of tool bodies for booleans (use the dialog dropdowns
  instead).

Script mode is unaffected and remains the full-power path for any geometry that
exceeds the GUI modeler's current scope.
