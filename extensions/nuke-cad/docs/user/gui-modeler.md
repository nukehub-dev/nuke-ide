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
2. Pick a starting point in the dialog. The **Start blank** section holds
   parameter presets:
   - **Empty document** — the default, no preset parameters.
   - **Pincell starter (cm)** — pre-fills `fuelRadius`, `cladRadius`,
     and `pitch` for a lattice pincell.
   - **Tokamak starter (cm)** — pre-fills `major_radius` and `minor_radius`.

   The **Example projects** section holds complete sample documents instead of
   presets:

   | Example project                 | What you get                                                                                                                                                           | Badge       |
   | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
   | **Pincell demo**                | Three labeled bodies (fuel, clad, moderator) with parametric sketch dimensions.                                                                                        | Fast        |
   | **Tokamak with divertor**       | 23-body sector with PF/TF coils, blankets, first walls, plasma, and a lower divertor.                                                                                  | Large model |
   | **Full W7-X stellarator**       | ~47 MB MIT-licensed reactor-scaled Proxima Fusion STEP, downloaded or chosen locally and stored in the project folder as one frozen assembly reference.                | External    |
   | **W7-X generator (parametric)** | 15 editable imported bodies (10 exact coil shapes + 5 shells) placed as 55 assembly instances; needs the same external STEP and the validated five-module layout only. | External    |
   | **W7-X coil shape study**       | 10 editable native `coilSweep` bodies × 5 modules (50 instances) from committed centerlines; no STEP, approximate reference geometry, simulation export disabled.      | Fast        |

   Choosing a bundled example first asks where to save the new `.nuke-cad`
   file, writes an editable copy there, and opens it. The two external W7-X
   cards open a choice instead: **Download 47 MB** first asks where to save the
   `.nuke-cad` project, then fetches the STEP through the NukeIDE backend (so
   browser CORS/proxy/content-blocker rules cannot block it) from
   `proximafusion/open_stellarator_models` (MIT); **Choose local STEP…** uses a
   file you already have. Either route stores the STEP in a
   `<document-stem>.parts/` folder beside the saved `.nuke-cad` and records a
   relative reference, so the project folder is self-contained and portable.
   The full W7-X card imports that STEP as one frozen assembly instance; the
   generator card inspects it against the committed inventory and builds the
   parametric project instead. A stale `<document-stem>.regions.json` left by
   an older document at the same path is moved to trash, so its old selectors
   do not leak into the new sample. Cancelling any dialog creates nothing. The
   built-in samples are never modified; edits apply only to your copy (you can
   save it again anywhere).

   The tokamak sample's first build can take a while: its 23 bodies are
   revolved, patterned, and boolean-clipped. The full W7-X STEP is deliberately
   not bundled: it is ~47 MB and not part of the repository. Both W7-X documents
   use a 0.1 display tolerance (55 solids) so their display meshes stay within
   the viewport read budget; export/FEM tolerances are unaffected. The
   generator's first build takes about 25 s.

3. Save the new document with **Save CAD Document As...** to give it a name and
   location (skipped for example projects, which are saved on creation).
4. The empty document contains three canonical datum planes: XY, YZ, and XZ.

The tokamak sample re-authors the Paramak
`tokamak_with_pf_tf_magnets_divertor` reference model as GUI features and trims
its known cross-body overlaps with four cleanup cuts. The full W7-X reference and
generator cards download or copy the MIT-licensed Proxima Fusion STEP into the
saved project's `.parts` folder. See `src/common/samples/README.md` for
bundled-sample provenance, sizes, and attribution.

The CAD viewport starts on a centered **Start a model** launcher instead of a
blank canvas. Without a document its primary action is **New Document**; inside
an empty document it becomes **Create Sketch**. Choosing **Empty document** in
the New Document picker installs the document and opens the Create Sketch plane
picker immediately; cancelling that picker reveals the launcher. Both variants
offer compact **Open CAD Model…**, **Import CAD…**, and **Import CAD as Body…**
rows. The launcher stacks when the editor is narrow and drops its supporting
copy on very narrow widths; the ribbon stays available above it.

The document toolbar carries a **Units** dropdown (`Unitless`, `mm`, `cm`,
`m`). Declared units tag future numeric inputs (curve expressions may then
carry unit syntax); changing units never rescales existing numbers. STEP and
IGES imports read the file's length unit: a new document adopts it, and a
mismatch against declared document units scales the geometry by the exact
factor (reported in the import message).

**Command search** floats over the bottom-left of the canvas as a **Search** pill
(magnifier + `/` keycap), outside the document toolbar so a dense ribbon never
covers it. Click it or press `/` in the viewport to filter every toolbar action —
including the ones that normally live in a section's caret menu — by name,
short label, or section caption. An empty field lists the first actions in
ribbon order. Use `↑`/`↓` and `Enter` (or click a row) to run the highlighted
command; disabled commands stay listed, cannot run, and show the same reason in
a muted line under the row (for example, **Pad** asks you to select a sketch
first). `Esc` or `Tab` closes the search without clearing the current
selection. The `/` shortcut works in document mode only, never while typing in
a field and never while a task panel, feature dialog, pick mode, measure
session, or shortcut bar owns the keys.

Disabled toolbar actions stay visible and explain themselves: hover a disabled
button for `<action> — <reason>`, or open its section's caret menu to read that
reason as a muted second line under the action.

Ribbon buttons show text under their icons by default. Turn off **Show text
under ribbon icons** (`nukeCad.ribbonLabels`) to render compact icon-only
buttons; sections still collapse to caption menus when the toolbar is narrow.
Every section's caret menu lists all of its commands, including the ones
already inline. Use the pin button next to a row to **Pin to toolbar** (render
it inline in that section) or **Unpin from toolbar** (return it to the menu).
Pins persist in `nukeCad.ribbonPins`; a section renders at most eight inline
buttons, defaults included.

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
  pinned row removes the saved copy too. Label and popover values follow the
  Model Outline's **Document** section **Precision** row (default 2 length /
  1 angle decimal place, trimmed).
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
- **Origin axes** (Model Outline → **Origin**): the viewport draws the
  world-origin triad in X red, Y green, and Z blue, scaled to the model so it
  stays legible at any size. The **Show axes** master switch turns the whole
  triad on or off; below it, one compact row of three equal-width **X / Y / Z**
  chips hides or shows one axis at a time. A pressed chip is tinted in its
  triad color, and with the master switch off the chips are muted and disabled
  but remember their state until you switch the triad back on. Both the master
  and per-axis choices persist as user preferences
  (`nukeCad.showOriginAxes` plus `nukeCad.showOriginX` / `showOriginY` /
  `showOriginZ`, all on by default).
  The axes only appear once a model is loaded — the empty viewport, the
  welcome card, and an empty document show none — and are display-only: they
  never change geometry, builds, exports, or the exported script, and
  disappear while you sketch (setup or session).
- **Orientation cube** (top-right, below the toolbar, shared with the native VTK viewers): mirrors the current camera
  orientation; click an axis knob (or its opposite) to snap to that view.
- **View badge** (top-left, below the toolbar, shared with the native VTK viewers): shows the active view
  (`User view` after orbiting, `Top view` after snapping) or the active sketch.
- **Named views** (Model Outline → **Named Views**): **Save current view**
  (the `+` button) prompts for a name and stores the live camera pose in the
  document, so it survives save/reopen and rides undo/redo. Click a row to
  restore that camera; the hover trash button deletes it. Named views are
  display-only and never rebuild geometry.
- **Fit**: `F` or the fit button frames the whole model; with a solid selected
  it frames that selection instead — `.` and double-clicking a solid also fit
  the selection.
- **Context menu**: right-click the canvas (no pick mode or sketch session
  active) for a context menu instead of the browser default. On a solid it
  offers **Edit Feature…** (the solid is attributed to the latest feature that
  wrote its body — disabled when no feature matches, e.g. script/STEP models),
  **Find in Feature Tree** (selects the owning feature and opens the panel;
  omitted for unattributed solids), **Appearance…** (per-body display color
  and opacity, see [Bodies](#bodies)), **Measure Distance / Angle / Radius**,
  **Fit to Solid** (`F`), **Hide / Isolate Solid** plus bulk variants for a
  multi-selection, and **Clear Selection** (`Esc`) while something is selected;
  on empty space it offers **Clear Selection** first when a selection exists,
  then **Fit All**, **Show All Solids** (disabled when nothing is hidden), a
  **Section View** toggle, and **Reset Explode** (disabled at 0%). Shortcut
  hints appear only for real bindings. It closes on a click elsewhere or `Esc`;
  with no menu open, `Esc` clears the current selection.
- **Select Other**: when more than one face lies under the pointer (nested or
  overlapping solids), the context menu adds **Select Other…**. It opens a
  candidate list at the pointer with each face's body, face index, and ray
  distance (nearest first); picking a row selects that face. **Alt+click**
  cycles the same candidates without opening the menu — each Alt+click moves
  from the current face to the next one, starting at the nearest when the
  current selection is not under the pointer, and wrapping at the end.
  Candidates are distinct faces, so a ray that enters and exits the same shell
  is listed once. Alt+click applies only to normal document selection (not
  during sketch, measure, or a pick mode), and `Ctrl`/`Cmd`-click stays the
  additive multi-select gesture.
- **Multi-select**: `Ctrl`/`Cmd`-click solids in the viewport (or rows in the
  Model Outline BODIES section) to accumulate a selection; `Ctrl`/`Cmd`-click
  again to drop one, or `Ctrl`/`Cmd`-drag a rectangle to add every solid whose
  face centers fall inside it. While `Ctrl`/`Cmd` is held the camera stays frozen
  (three.js would otherwise pan on modifier-drag) and the cursor turns into a
  crosshair, so hover+click across the model never moves the view.
  Right-clicking a selected solid then offers **Hide /
  Isolate Selected (N)** for the whole set alongside the single-solid items;
  empty-space click clears (plain click only).
- Press `Tab` to enter sketch mode and `Tab` again to leave it; the labeled
  **Finish Sketch** pill at the top-right does the same. The blue dot beside
  the pill marks unsaved document changes.

Build warnings (for example, intentional cross-body overlaps in assemblies)
appear as a compact badge at the top-left of the viewport, below the document
toolbar when one is open. Click **N build warnings** to open the full list in a
popover; click the count again, click elsewhere, or press `Escape` to close it.
The badge never stretches or covers the sketch constraint bar or **Finish
Sketch** pill, and its **X** dismisses the warnings until the next build. The
Model Outline's warnings box groups
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
2. Click **New Sketch** in the document toolbar to create a sketch. To edit an
   existing sketch, select its row in the Feature Tree and click **Edit
   Selected Sketch** — it reopens directly on its stored plane.
3. For a new sketch, the **Create Sketch** task panel appears at the top-right
   below the toolbar — the ribbon stays visible and **New Sketch** (or **Edit
   Selected Sketch** when editing) stays pressed. Choose `XY`, `YZ`, or `XZ`,
   optionally enter an offset, then click **Start Sketch**. To sketch on a face
   of an existing body, click **On Face…**, then click the desired face in the
   viewport. The panel also offers **3-Point** (plane through three
   coordinates), **Midplane** (midway between two picked faces), and
   **Line-2Pt** (an axis through two coordinates, for pattern axes only —
   sketches cannot be placed on it).
4. **Cancel**, the panel's close button, or `Esc` in the offset field closes
   the panel and returns to document mode without creating a sketch.

The viewport switches to an orthographic view looking straight at the datum,
grays out the 3D model, and shows a sketch grid (toggle it from the toolbar's
**Grid** button).

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
(6/12/24 px). The **Grid** button next to them shows or hides the sketch grid.
The status line's snap and grid badges mirror both toggles (for example
`Snap 12px` and `Grid`).

### Constrain the sketch

The constraint bar at the top-center of the viewport has icon chips for the
most-used constraints — Coincident, Horizontal, Vertical, Parallel,
Perpendicular, Tangent, Equal, Distance, Radius, and Angle — plus a **More**
dropdown for Fix, Concentric, Symmetry, and Point on Object. Click a chip to
start that constraint; click the active chip again, choose **None** in the
**More** dropdown, or start another constraint to cancel. The bar shows how
many primitives it still needs, for example `2 / 2 selected`.

- Coincident, fix, horizontal, vertical
- Parallel, perpendicular, tangent
- Equal, concentric, symmetry
- Point on object
- Axis-locked distance (`DistanceX`/`DistanceY`), diameter, block
  (freeze-in-place)

Most constraints are applied by selecting the required number of primitives.
`distance`, `radius`, and `angle` additionally ask for a numeric value or
parameter name. The **More** dropdown shows the active kind while one of its
constraints is armed and falls back to **More** otherwise.

- **Right-click menu** — right-click a sketch entity to see only the
  constraints that fit the current selection: Horizontal/Vertical and **Add
  Length Dimension…** on a line, Parallel/Perpendicular/Equal and **Add Angle
  Dimension…** on two lines, Tangent on a line and circle/arc, Concentric/
  Equal/Tangent on two curves, Coincident and **Add Distance Dimension…** on
  two points, Point on Object on a point plus curve, and Fix on a point. The
  menu also offers **Make Construction/Normal**, **Delete**, and **Clear
  Selection**. Dimension actions open the value box with the targets already
  chosen. Right-click empty canvas for **Fit Sketch**, **Show/Hide Grid**, and
  **Finish Sketch**; right-click during a drawing or constraint gesture
  cancels it instead of opening the menu.

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
local parameters. New parameters merge into the document parameter table when
you finish the sketch, so later features and sketches can reference them.
Parameters bound to a driving dimension cannot be removed until the dimension
is unbound.

### Select, drag, and delete

With the **Select** tool, click a primitive (or a dimension label) to select
it — Ctrl/Cmd+click adds to the selection, clicking empty space clears it, and
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

The status line at the bottom keeps transient hints on the left (shortcuts,
auto-constraints, reference ambiguity) and solver badges on the right:
conflicting and redundant constraint counts when present, the remaining
degrees of freedom (`12 DOF`) or **Fully constrained**, and the snap/grid
state. Click the line when diagnostics exist to open the **Solver Diagnostics**
popover and see which constraints are conflicting, redundant, or partially
redundant. The diagnostics also flag missing coincident constraints on
touching endpoints, open profile vertices, and whether the sketch is fully
constrained.

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
its buttons into two labelled columns (Draw & edit / Reference / Inspect /
Transform) and scrolls under the fixed **SKETCH** header when the palette is
taller than the canvas, so every tool stays reachable above the status line.
The active tool is highlighted.
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

### Importing CAD as a body

**Import CAD as Body…** turns a STEP/STP, IGES/IGS, or BREP file into editable
body features instead of a frozen assembly reference. Find it on the welcome
card, the empty-document card, in the Document ribbon group, in the CAD Studio
menu, or through command search.

1. Pick the exchange file; with no saved document, choose where the `.nuke-cad`
   should live next. Cancelling any dialog changes nothing.
2. The source is copied into `<document-stem>.parts/` when it lives outside the
   document folder, then inspected. The dialog lists each source solid with its
   index, product name, face count, volume, and bounding box.
3. Select all solids or individual rows, then choose **One body for selected
   solids** (default) or **One body per selected solid**. The footer previews
   how many bodies and import features the choice creates.
4. Name the body and, when the file header lies about its unit, override
   **Source unit**. Numbers scale to the document unit; a unitless document
   keeps the native source numbers.
5. **Import Body** commits the bodies and import features in one undo entry,
   saves, and rebuilds.

The import is a B-rep snapshot: downstream booleans, dress-ups
(fillet/chamfer/draft/shell), Move, patterns, mirror, lattices, suppression,
and assembly instances all work on the body, and imported bodies are valid
pattern/mirror sources. The raw source surfaces are not editable — replacing
the source file and refreshing is the way to change them; imported features
have no parameter-edit dialog and no ghost preview. The feature stores the
source's SHA-256 hash, so a changed file fails the build with a clear refresh
message instead of silently using new geometry. **Refresh Import Sources**
(CAD Studio → Geometry or the Command Palette) re-hashes changed sources and
updates every feature sharing one source in one commit per source. Export
Python emits a runnable source reader that verifies the hash/size, selects the
same solids, and applies the import placement.

### Appearance

Right-click a solid and choose **Appearance…** to override that body's display
look without changing its geometry:

- **Color** — the solid fill color (`#rrggbb`, picked from the shared palette
  or typed as hex).
- **Opacity** — 0–100% in 5% steps, set with the slider or the number field.
- **Preset** — pick a saved appearance to fill the draft, **Save preset…** to
  store the current color/opacity under a name, or the trash button to delete
  the selected preset. Presets are user settings (they follow the IDE profile,
  not the document) and saving under an existing name replaces it.

With more than one body selected (Ctrl/Cmd-click solids), the dialog also
offers **Apply to all selected bodies**. Leave it off to change only the body
you opened the dialog for; check it to write the same color/opacity to every
selected body. The update is one undoable document change.

**OK** stores the override in the document (it survives save/reopen and rides
undo/redo); **Remove override** returns the body to the theme-adaptive default;
**Cancel** or closing the dialog discards the draft. Overrides are
**display-only**: they never affect builds, exports, DAGMC/FEM output, or
Export Python. Selection highlighting still uses the shared focus color; in
X-ray mode the ghost opacity wins over the per-body value, and shaded-wireframe
/ edges-only modes keep bodies fully opaque.

When **Color by material** is on (the **Display** group in the Model Outline's
**Document** section, or the `nukeCad.colorByMaterial` setting), bodies without
an explicit appearance color take the deterministic palette color of their
material tag — the same color the native DAGMC viewer uses for that material,
including the muted grey graveyard swatch. The same group shows a compact
material legend (one swatch + tag per distinct body material). An explicit
appearance color always wins, and appearance opacity stays independent of the
material color. The switch is display-only: it never changes the document,
builds, or exports.

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
- **Move** — rigidly translate a body's accumulated shape by a non-zero
  `dx`/`dy`/`dz` in document units (e.g. lower a frame by entering a
  negative `dz`). Find it
  in the document toolbar's **Dress-up** group (no sketch or edit mode needed):
  the target body arrives pre-selected from the viewport selection, the dialog
  previews the move ghosted, and later features chain through it.
- **Linear Pattern** — replicate a solid-producing feature along `X`, `Y`, or
  `Z`.
- **Circular Pattern** — replicate a solid-producing feature around a global
  axis or a datum axis (including two-point line datums).
- **Mirror** — mirror a solid-producing feature across a coordinate plane or a
  datum plane.
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
   button next to a listed edge to delete it. Enable **Tangent chain** before
   picking to add every edge of the same solid that continues tangent to the
   picked edge (15° tolerance), instead of only the clicked edge.
3. Enter a **Radius**.
4. Click **Create** to add the fillet feature.

### Chamfer

1. Select the target body and pick edges the same way as fillet, including the
   optional **Tangent chain** expansion for edge picks.
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
`groove`, `sweep`, `pipe`, `loft`, `helicalSweep`, `primitive`, or an imported
body feature) on the same body. The source feature must be earlier in the
document order, and the pattern feature itself targets the source's body. A
per-instance **Scale** scales each copy about its own center (`1` = unchanged).

### Linear pattern

1. Select the target body.
2. Choose the **Source feature** (the solid-producing feature to replicate).
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
(`pad`/`revolve`/`sweep`/`pipe`/`loft`/`helicalSweep`/imported bodies) or cut for
subtractive sources
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

### Coil sweep

**Add Coil Sweep Feature** (Additive ribbon or command search) sweeps a
rectangular section along a document curve. Pick the path curve, then set:

- **Width** and **height** of the rectangle.
- **Tilt** — rotates the section out of the tangent-normal plane (`-89..89°`).
- **Twist** — rotates the section progressively around the tangent from start
  to end.
- **Stations** — loft resolution (`8..720`, default 60).

Coil sweeps need no sketch and work as pattern, mirror, and lattice sources and
as assembly bodies. They have no live preview in this release. For circular
sections use **Pipe**; for a sketch section use **Sweep**.

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

Reopening the CAD viewport restores the active model and re-opens the Feature
Tree and Model Outline panels. Both panels are also available as **Feature
Tree** and **Model Outline** buttons in the Inspect ribbon and command search.

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
  suppress, move up/down, edit parameters (not imported features, which show
  their source file instead), and delete — including boolean features.

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

Imported bodies are exported as runnable `_import_body(...)` /
`_place_import(...)` calls: the source is resolved beside the script, its
SHA-256 and size are checked, the same 1-based solids are selected, and the
source unit/placement is applied. Grounded assemblies always get the placement
helper and a final `model` compound, so a W7-X generator export runs directly
in the script pipeline.

### CAD and DAGMC export

Every document build also writes `<document>.step` beside the `.nuke-cad`
(assembly STEP keeps one product per instance), so `w7x-generator.step` is the
exact placed CAD export. A tessellation cache hit reuses an unchanged STEP
(matching its `.step.key` sidecar) instead of rewriting it. DAGMC `.h5m` is
an export build, not the viewport's
display build: run `geometry_service.py <document.nuke-cad> --from-document
--no-mesh --tolerance 0.01 --no-auto-tolerance` (DAGMC is enabled by default)
or use the script/export pipeline, then choose **Project → Import from
nuke-cad...** in OpenMC Studio and select the `.h5m` with its sibling
`.regions.json`.

Large W7-X assemblies take much longer to imprint than the display build; this
is a one-time export. Reuse a matching existing `.h5m` instead of re-running it
after every edit. The thin gap/firstwall/vessel shells need the fine tolerance:
the default auto-adjust would relax it to `diagonal/200` (about 0.12 m on
W7-X), which under-resolves those layers and makes a transport mesh lose
particles.

## Document section

The top of the **Model Outline** carries a collapsible **Document** section for
`.nuke-cad` documents (the gear header's hover title still reads "Document
settings"). It summarizes the open document and is read-only apart from the
units, display-precision, and display-only coloring choices:

- **Units** — the same `Unitless`/`mm`/`cm`/`m` choice as the document
  toolbar. Declared units tag future numeric inputs only; changing them never
  rescales existing parameters, curves, or sketch coordinates.
- **Precision** — maximum decimal places for readouts, split into length
  (default 2) and angle (default 1), each 0–6. Values are rounded and trailing
  zeros stay trimmed, so the defaults read `5` and `45.5°` rather than `5.00`
  and `45.50°`. The setting applies to viewport measurement labels, the
  Measurements popover, and the Model Outline's property/table readouts; it
  never changes geometry or exports. The same values live in the
  `nukeCad.lengthDecimals` / `nukeCad.angleDecimals` settings.
- **Parameters** — the number of document parameters. Edit them in the
  [Parameters spreadsheet](#parameters-spreadsheet) below.
- **Display** — a `DISPLAY` subhead for the display-only material coloring.
  **Color by material** colors each body from its material tag with the shared
  deterministic palette (the same swatch the native viewers use for DAGMC
  color-by). Untagged bodies keep the theme body color, and an explicit
  per-body appearance color still wins. The switch is display-only: no
  rebuild, no document or export change. The same setting is
  `nukeCad.colorByMaterial` (off by default). While the switch is on, a
  compact **material legend** lists each distinct body material (up to eight,
  case-insensitive duplicates collapsed to the first spelling) with its
  viewport swatch; with no tagged body it reads **No material tags yet**. The
  legend is hidden while the switch is off.
- **Design Properties** — the document **Name**, its **Source** (the model
  file, or `In-memory document` when unsaved), the **Bodies** count, and the
  **Schema** version.

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
mates between named connector frames.

**Import CAD…** on either empty-state card (and **Import CAD as Assembly…** in
the Document ribbon or command search) wraps an external STEP/STP/IGES/IGS/BREP
file in one step: pick the CAD file, confirm where the `.nuke-cad` lives when
needed, and the file appears as a grounded instance in the Assembly card. An
open document is saved in place; a new document is created at the chosen path.
The first instance is grounded automatically so the import builds and renders
immediately. The instance stores a document-relative path when the file is in
or below the document folder (`./model.step`, `./sub/model.step`) and an
absolute path otherwise, so keep external parts with the document when moving
or sharing it. The two W7-X examples are the exception: they download or copy
the STEP into `<document-stem>.parts/` first and store a relative path, making
the saved project folder self-contained. For editable bodies instead of a
frozen instance, use **Import CAD as Body…** (see [Bodies](#bodies)).

1. Add an **Instance** for each part (same-document body, document path, or
   CAD file path).
2. Add **Connectors** (named frames) on the instances to join.
3. Add a **Mate** between two connectors (one mate per part pair); the mate
   type sets which degrees of freedom stay free (shown as a hint).
4. **Ground** exactly one instance; mates solve outward from ground in
   closed form. Ungrounded, unmated instances keep their stored placement.

The **Assembly** card floats over the viewport under the document toolbar. Drag
its header to move it; double-click or right-click the header to return it to
the default spot. The chevron collapses the card to its header (the instance
count stays visible) and expands it again without losing the dragged position.
Type a part source in the **Part** field — `body:<id>` for a body in this
document, `./bracket.nuke-cad` for another parametric document, or a
`.step`/`.stp`/`.iges`/`.brep` file path — then press Enter or **Instance**. The
button stays disabled while the field is empty; **Mate…** appears beside it once
the assembly has an instance.

The **BOM** panel (`CAD Studio → BOM`) lists instance, part source, mate
type, and DOF contribution; clicking a row selects the instance in the
viewport. Assembly STEP export keeps one product per instance; DAGMC export
imprints the placed solids (overlap stays a warning — assemblies overlap
intentionally).

### W7-X generator (parametric)

The **W7-X generator (parametric)** example card and the **Create W7-X
Generator…** command build the validated five-module device from the same
MIT-licensed reference STEP. The card offers download or local copy; the command
opens the file picker. Both ask for a destination (default
`w7x-generator.nuke-cad`), verify the STEP against the committed inventory,
then create 15 imported bodies — 10 exact coil shapes plus plasma, gap,
firstwall, blanket, and vessel — and place 55 assembly instances: 50 coils
(10 shapes × 5 modules at 72° steps) plus 5 shells. The first build takes about
25 s at a 0.1 display tolerance.

The coil bodies are editable like any imported body, and editing one updates
all five of its module instances because they reference `body:<id>`. The
generator is valid-only: it always builds 5 modules / 50 coils and offers no
module-count control; that is the physically valid W7-X. The full W7-X
reference card remains the single frozen STEP assembly.

### W7-X coil-count study (experimental)

**Create W7-X Coil Study…** (Document ribbon or command search) builds the same
15 imported bodies as a 4-, 5-, or 6-module study, with 40/50/60 coil instances
plus the five shells. Pick a local reference STEP, choose the destination, then
choose the module count in the study dialog. The dialog reports the measured
module pitch, module span, uncovered sector or overlap, minimum adjacent coil
clearance, and coil/coil and coil/shell intersection volumes.

These layouts are design studies, not W7-X configurations. Four modules leave a
24.66° uncovered sector and drive the shifted coils through every shell; six
modules overlap adjacent modules by 5.34° and produce coil/coil interference.
Only five modules is valid. A study document carries a persistent banner with
the measured summary and **Simulation export disabled**; DAGMC and FEM mesh
export are rejected by the backend, while display builds and STEP export still
work. Use the valid five-module generator for simulation-ready geometry.

### W7-X coil shape study (native, experimental)

The **W7-X coil shape study (native)** card and **Create W7-X Coil Shape
Study…** command build a self-contained editable device without the 47 MB STEP:
10 native coil-sweep bodies across the five valid modules (50 instances). The
dialog sets section width/height (default 0.37 m), section tilt (8.6°), twist,
and stations (60). Each body is a normal **Coil Sweep** feature, so editing its
width, height, tilt, twist, or path updates all five module instances.

The native sweeps approximate the reference B-reps (about 0.55% total volume
at defaults, with per-coil deviations under ~1.1%). The document carries a
persistent **Approximate coils** banner and blocks DAGMC/FEM export. Use the
imported-body generator when exact reference geometry is required, and the
coil-count study when comparing 4/5/6 modules.

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

**Open Drawing Sheet** (`CAD Studio → Drawings`) opens the drawing workspace
for the current document:

1. Choose a sheet size (A4/A3) and a front/top/right base view on the empty
   workspace. The first sheet can also be created from the toolbar.
2. The toolbar groups sheet, view, dimension, and output actions: add base,
   projected, section, or detail views, **Pick in viewport** for dimensions,
   **Save**, **Refresh**, and **SVG**/**DXF** export.
3. The sheet is rendered as a framed drawing with a title block. Use the
   zoom controls, mouse wheel, or middle-drag to pan; **Fit sheet** resets the
   view. Grid and 5 mm snapping have their own toggles.
4. The right inspector lists the sheet, the selected view, its scale,
   hidden-line toggle, delete actions, all views, and all dimensions. **Fit**
   chooses a standard scale for the selected view from its linework; a new
   base view that would sit as a dot at 1:1 auto-fits once.
5. Drag views by their label or anywhere in their body area (5 mm snap when
   enabled); projected views stay aligned to their parent. Dimensions stay
   associative — they recompute from the 3D model on every build and flag
   `stale` when their reference breaks.

Drawing edits are saved before the linework is rebuilt, so the HLR service
always reads the current sheet. Export SVG (native) or DXF (visible/hidden/
section/dimension layers) from the sheet. PDF export is not in this release.

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
- **Large documents:** every edit rebuilds the dirty feature closure by default
  (`nukeCad.rebuildOnEdit: auto`). For models where each edit is expensive
  (patterned assemblies), switch the setting to `manual`: edits then only mark
  the model stale until **Rebuild CAD Geometry** runs. Suppressing an expensive
  pattern/mirror feature in the Feature Tree has the same effect for that
  subtree and composes with either mode.
- **Per-document display detail:** a document may carry a positive
  `displayTolerance` to override the viewport faceting tolerance without
  changing export/FEM settings. The built-in tokamak sample uses 0.015 so its
  cut-trimmed tessellation remains under the browser read budget.
- **Result cache:** a full build stores per-feature B-reps plus a doc-level
  tessellation blob in a `<stem>.nuke-cache.zip` sidecar next to the document.
  Later edits rebuild only the dirty closure, and reopening a document restores
  it from the cache without re-meshing. The first build of a document (or one
  after the sidecar is evicted, deleted, or invalidated by a version change)
  executes every feature because the cache is cold; it primes the sidecar so the
  next edit is already partial. `nukeCad.resultCacheSizeMB` (default 1024 MB)
  caps the sidecar size before old entries are evicted.

## Demo model: tokamak with divertor

A complete `.nuke-cad` demo model is maintained at
`tests/e2e/assets/tokamak_with_divertor.nuke-cad` and is also available from
**New CAD Document → Example projects → Tokamak with divertor**. It rebuilds the
paramak `tokamak_with_pf_tf_magnets_divertor` STEP as a GUI-authored document:

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
