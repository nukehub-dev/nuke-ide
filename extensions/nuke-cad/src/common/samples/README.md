# Example-project samples

Ready-made documents for the **New Document → Example projects** picker. Each
generated file is the JSON content of a `.nuke-cad` document and is imported by
`src/common/sample-projects.ts`; created documents are deep copies, never the
shared module object.

| File                         | Size   | Source                                                                                           |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `gui_pincell.json`           | 8.3 KB | Generated from `tests/e2e/assets/gui_pincell.nuke-cad` (in-repo GUI-authored pincell fixture).   |
| `tokamak_with_divertor.json` | 404 KB | Generated from `tests/e2e/assets/tokamak_with_divertor.nuke-cad` (in-repo GUI-authored fixture). |

The JSON files are **generated, not committed**: `scripts/copy-cad-samples.js`
copies the canonical `.nuke-cad` fixtures here during `yarn build` (and before
`yarn test:ts`). The e2e assets remain the single source of truth; edit the
fixture and rebuild instead of editing the generated JSON.

## Provenance and attribution

- **Pincell demo** — authored in this repository as a three-body GUI document
  (fuel, clad, moderator) for the nuke-cad e2e suite. No external asset is
  included.
- **Tokamak with divertor** — the document is authored in this repository
  (`src/browser/document/gui-build-tokamak.test.ts`) by rebuilding the Paramak
  `tokamak_with_pf_tf_magnets_divertor` reference model as GUI features. Paramak
  (fusion-energy/paramak, MIT) is the upstream reference for the geometry; only
  the derived JSON document is shipped here, not the reference STEP.
- **Full W7-X stellarator** — not bundled. The example card can download the
  external `scaled_w7x_stellarator.step` (~47 MB; Proxima Fusion, MIT) from
  <https://github.com/proximafusion/open_stellarator_models> or take a local
  copy, then imports it through the CAD assembly path. The STEP is stored in the
  saved document's `<document-stem>.parts/` folder and referenced relatively, so
  the resulting project is self-contained. The download runs through the NukeIDE
  backend, avoiding renderer CORS/proxy/content-blocker failures. The download URL is pinned to commit
  `af86bcaee80301e02a099f9fcecaf5849b053231` so upstream model changes cannot
  silently swap the sample. Cite `Proxima_Fusion_Open_Stellarator_Models_2025`
  when reusing the model. No reference STEP, tessellation, or cache is shipped
  in this repository.

The generated pincell JSON is byte-identical to its test fixture;
`sample-projects.ts` adds display-only body colors (red fuel, grey clad) and a
`0.22` moderator opacity so the nested cylinders are visible on first open. The
generated tokamak JSON is byte-identical to its fixture; the sample decorator
adds four `booleanCut` features that trim the fixture's five known cross-body
overlaps while keeping both bodies and tool labels. The fixture itself still
carries the overlaps so the build-warning policy stays covered. The tokamak
sample's first build is expensive (23 bodies, pattern and boolean clipping);
the picker labels it **Large model**.
