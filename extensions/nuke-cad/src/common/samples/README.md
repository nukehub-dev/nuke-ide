# Example-project samples

Ready-made entries for the **New Document → Example projects** picker. The
document samples are the JSON content of a `.nuke-cad` document, imported by
`src/common/sample-projects.ts`; created documents are deep copies, never the
shared module object.

| File                         | Size   | Source                                                                                           |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `gui_pincell.json`           | 8.3 KB | Generated from `tests/e2e/assets/gui_pincell.nuke-cad` (in-repo GUI-authored pincell fixture).   |
| `tokamak_with_divertor.json` | 404 KB | Generated from `tests/e2e/assets/tokamak_with_divertor.nuke-cad` (in-repo GUI-authored fixture). |
| `w7x/w7x_geometry.json`      | 6.5 KB | Committed W7-X inventory metadata (10 coil shapes, 5 shells, source hash); not generated.        |
| `w7x/w7x_study.json`         | 2.5 KB | Committed measured 4/5/6-module coil-study reports (same source hash); not generated.            |
| `w7x/w7x_coils.json`         | 67 KB  | Committed 10 coil centerlines + reference metrics for the native shape study; not generated.     |

The `.nuke-cad`-derived JSON files are **generated, not committed**:
`scripts/copy-cad-samples.js` copies the canonical `.nuke-cad` fixtures here
during `yarn build` (and before `yarn test:ts`). The e2e assets remain the
single source of truth; edit the fixture and rebuild instead of editing the
generated JSON.

`w7x/w7x_geometry.json` is the exception: a small hand-maintained committed
asset, not a document and not generated from a fixture. It records the
reference STEP's file name, MIT license, SHA-256 hash, byte size, `m`
source/document units, display tolerance, and overlap gate, plus the expected
10 coil shapes × 5 module copies and 5 shell solids (indices, face counts,
volumes). The
generator uses it to validate the external STEP and plan 15 imported bodies and
55 assembly instances; the ~47 MB STEP itself is never bundled here.

`w7x/w7x_study.json` is the matching committed study report for the same pinned
STEP: measured module pitch/span, uncovered sector or overlap, minimum coil
clearance, and coil/coil + coil/shell intersection volumes for 4, 5, and 6
modules. **Create W7-X Coil Study…** uses it to mark each layout as a design
study; the report is a small metadata asset, never geometry.

`w7x/w7x_coils.json` holds the ten reference coil centerlines (121 samples
each, first point repeated at the end), reference volume/area/bbox/centre per
shape, the five module transforms, and the source hash/license. It is committed
metadata derived from the MIT-licensed STEP, never the STEP itself. The native
**W7-X coil shape study** card uses it to build 10 editable `coilSweep` bodies
and 50 assembly instances with no external download or `.parts` folder.

## Provenance and attribution

- **Pincell demo** — authored in this repository as a three-body GUI document
  (fuel, clad, moderator) for the nuke-cad e2e suite. No external asset is
  included.
- **Tokamak with divertor** — the document is authored in this repository
  (`src/browser/document/gui-build-tokamak.test.ts`) by rebuilding the Paramak
  `tokamak_with_pf_tf_magnets_divertor` reference model as GUI features. Paramak
  (fusion-energy/paramak, MIT) is the upstream reference for the geometry; only
  the derived JSON document is shipped here, not the reference STEP.
- **Full W7-X stellarator / W7-X generator / native coil shape study** — the
  reference STEP is not bundled. The two external cards can download
  `scaled_w7x_stellarator.step` (~47 MB; Proxima Fusion, MIT) from
  <https://github.com/proximafusion/open_stellarator_models> or take a local
  copy. The reference card imports it through the CAD assembly path; the
  generator card validates it against `w7x/w7x_geometry.json` and builds 15
  imported bodies with 55 assembly instances (valid five-module layout only).
  The STEP is stored in the saved document's `<document-stem>.parts/` folder and
  referenced relatively, so the resulting project is self-contained. The
  download runs through the NukeIDE backend, avoiding renderer
  CORS/proxy/content-blocker failures. The download URL is pinned to commit
  `af86bcaee80301e02a099f9fcecaf5849b053231` so upstream model changes cannot
  silently swap the sample.

  The native shape-study card is self-contained: it builds 10 editable
  `coilSweep` bodies from the committed `w7x/w7x_coils.json` centerlines and
  places 50 instances across five modules, with no external source or `.parts`
  folder. Its sweeps approximate the reference B-reps and block simulation
  export. Cite `Proxima_Fusion_Open_Stellarator_Models_2025` when reusing the
  model. No reference STEP, tessellation, or cache is shipped in this
  repository.

The generated pincell JSON is byte-identical to its test fixture;
`sample-projects.ts` adds display-only body colors (red fuel, grey clad) and a
`0.22` moderator opacity so the nested cylinders are visible on first open. The
generated tokamak JSON is byte-identical to its fixture; the sample decorator
adds four `booleanCut` features that trim the fixture's five known cross-body
overlaps while keeping both bodies and tool labels. The fixture itself still
carries the overlaps so the build-warning policy stays covered. The tokamak
sample's first build is expensive (23 bodies, pattern and boolean clipping);
the picker labels it **Large model**.
