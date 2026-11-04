# Document Templates and Parametric Components

Nuke CAD ships two separate starting-point registries for new documents. They
share the New Document picker but have different contracts and different
creation flows.

| Registry            | Module                              | Shipped entries    | What it supplies                                                          |
| ------------------- | ----------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| Parameter presets   | `src/common/document-templates.ts`  | `empty`, `tokamak` | A shallow `parameters` map merged over an empty schema-v3 document.       |
| Component templates | `src/common/component-templates.ts` | `pincell`          | A complete validated document plus typed, bounded, unit-aware parameters. |

Parameter presets carry no geometry and store no template metadata in the
document. `applyDocumentTemplate` only merges the preset values into the empty
document, so the user still authors every sketch and feature. Component
templates are the geometry-bearing starters: the template body contains the
bodies, sketches, and features, and creation installs a copy at a user-chosen
path.

## `ComponentTemplate` contract

```ts
interface ComponentTemplate {
  id: string; // lowercase kebab-case, stable
  name: string;
  description: string;
  category: 'primitives' | 'mechanical' | 'nuclear' | 'assembly';
  keywords: readonly string[];
  parameters: readonly ComponentTemplateParameter[];
  document: NukeCadDocument; // validated v3 body, declared units, no import features
}
```

| Parameter field | Contract                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`          | Document parameter name for a canonical input, or an alias name when `derived` is set.                              |
| `label`         | Non-empty UI/diff label.                                                                                            |
| `kind`          | `length`, `angle`, `ratio`, or `count`.                                                                             |
| `unit`          | `mm`/`cm`/`m` for length, `deg` for angle, `1` for ratio and count.                                                 |
| `default`       | Finite default in the declared unit; must fall inside `min`/`max` when present.                                     |
| `min`, `max`    | Optional inclusive bounds in the declared unit.                                                                     |
| `step`          | Optional positive finite UI step.                                                                                   |
| `description`   | Optional one-line help.                                                                                             |
| `pair`          | Optional mutual counterpart, used for radius/diameter aliases. The declaration must name another parameter.         |
| `derived`       | Optional `{ parameter, factor }` alias: the input is stored in the named document parameter after `input × factor`. |

Resolution rules in `resolveComponentTemplateParameters`:

- Length inputs may be supplied in a caller `unit` (`mm`, `cm`, or `m`) and are
  converted to the parameter's declared unit before range checks. Other kinds
  ignore the caller unit.
- `count` overrides must be positive integers; every numeric override must be
  finite. Unknown parameter names reject the whole request.
- `min`/`max` are validated in the declared unit. A derived alias is also
  checked against its target parameter's range after the factor conversion.
- A `pair` must be mutual. Supplying both sides at once is accepted only when
  they describe the same value after conversion (`1e-9` relative tolerance);
  otherwise resolution fails with both names.
- Every template parameter maps to a document parameter, or declares a
  `derived` target that is a document parameter. Every document parameter must
  also be declared by a template parameter. A derived alias is never itself a
  document parameter.
- Defaults are resolved for every declared parameter, so the returned
  `resolved` list is complete and in declaration order. `derived: true` means
  the value came from a default or from the paired counterpart.

`componentParameterSketchIds(document, name)` reports every sketch whose
dimensions or constraints reference a parameter, plus every parametric curve
whose `x(t)`/`y(t)`/`z(t)` expression consumes it. Creation re-solves each
changed document parameter through the existing
`NukeCadSketchEditService.prepare` transaction. That transaction cascades a
parameter to all affected sketches and curves, and the creation flow walks
changed parameters sequentially against the evolving candidate document.

Templates are self-contained by contract: the document declares `units`, carries
no `import` features, and every body has a non-empty label. Material tags are
optional but must pass `validateBodyMaterialTag`; a tag carries into the region
manifest like any user-authored body material.

## Admission checklist

Add a component template only when all of these hold:

1. **Canonical fixture.** The document body comes from a validated `.nuke-cad`
   fixture (or generated sample JSON derived from one), never a hand-edited
   copy. The pincell body is generated from
   `tests/e2e/assets/gui_pincell.nuke-cad`.
2. **Declared ↔ referenced parameters.** `validateComponentTemplateLibrary()`
   returns no errors: every document parameter is declared, every declared
   canonical parameter is a document parameter, and every derived alias points
   at a document parameter. Every sketch dimension, constraint value, and curve
   expression that looks like a parameter names a declared document parameter.
3. **Units and bounds.** The document declares `mm`, `cm`, or `m`; each
   parameter unit matches its kind; defaults lie inside their bounds; count
   bounds are positive integers.
4. **Labels and materials.** Every body carries a label. Domain material tags
   are optional, valid, and appropriate to the body (the pincell uses `UO2`,
   `Zircaloy-4`, and `H2O`).
5. **At most 12 parameters.** The registry caps a template at
   `MAX_COMPONENT_TEMPLATE_PARAMETERS`; keep the surface small enough for a
   review card.
6. **Self-contained body.** No `import` features and no external file
   references, so `prepareDocumentCreation` can build in the private preview
   directory.
7. **Real build.** A prepare run must solve every changed sketch and produce at
   least one solid from the shipped defaults and from representative overrides.
8. **Docs and changelog.** Update this page, the user guide, the CAD AI
   capability page when the contract changes, and `CHANGELOG.md`.

## Stability rules

- Ids, parameter names, categories, keywords, and body labels are public
  contract. Saved documents, review rows, and AI tool calls reference parameter
  names, so do not rename or repurpose one.
- Adding a parameter with a default is additive. Removing a parameter,
  changing its meaning, or changing its default/min/max is a user-visible
  change that needs migration and release notes.
- Keep the template document on the current schema version and run it through
  `validateNukeCadDocument`. Schema migrations apply to saved copies, not to the
  registry body.
- A component template is not user-editable and accepts no model-authored
  geometry, JSON, or code. The model supplies a template id and number inputs
  only.
- Registry order does not control the picker; `listComponentTemplates` ranks
  exact id, keyword/id substring, name, then description matches and caps the
  result at 50.

## Shipped entry: `pincell`

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Id          | `pincell`                                                                                         |
| Category    | `nuclear`                                                                                         |
| Units       | `cm`                                                                                              |
| Keywords    | `pincell`, `pin cell`, `fuel`, `clad`, `moderator`, `lattice`, `reactor`, `pwr`                   |
| Source body | `tests/e2e/assets/gui_pincell.nuke-cad` (generated JSON under `src/common/samples/`)              |
| Bodies      | `fuel` → `UO2`, `clad` → `Zircaloy-4`, `moderator` → `H2O`; each labelled and built as a 1 cm pad |

| Parameter      | Default | Bounds    | Alias / storage                                          |
| -------------- | ------- | --------- | -------------------------------------------------------- |
| `fuelRadius`   | `0.4`   | `0.01–10` | Paired with `fuelDiameter`                               |
| `cladRadius`   | `0.5`   | `0.02–12` | Paired with `cladDiameter`                               |
| `pitch`        | `1.26`  | `0.02–20` | Step `0.01`; square lattice center-to-center spacing     |
| `fuelDiameter` | `0.8`   | target's  | Alias: stores `fuelRadius = input × 0.5` (`factor: 0.5`) |
| `cladDiameter` | `1.0`   | target's  | Alias: stores `cladRadius = input × 0.5` (`factor: 0.5`) |

The pincell's three sketches drive the fuel cylinder, the clad annulus, and the
moderator block. `fuelRadius`, `cladRadius`, and `pitch` are the canonical
document parameters; the two diameter aliases resolve through the same values so
a caller can speak in either vocabulary without creating a second source of
truth.

## Related pages

- [GUI modeler](../user/gui-modeler.md) — picker sections and the creation flow.
- [CAD AI capabilities](ai-capabilities.md) — the gated list/prepare/create
  capabilities.
- [Document schema](document-schema.md) — schema-v3 blocks and validation.
