# Skills

NukeAI ships domain skills as `SKILL.md` files under `extensions/nuke-ai/skills/`. Theia discovers them as a
lowest-precedence `plugin` tier, so a user skill with the same name in the workspace or config directory wins.

## Layout

```text
extensions/nuke-ai/skills/
├── nuke-cad/SKILL.md
├── openmc-studio/SKILL.md
├── nuke-visualizer/SKILL.md
├── nuke-workflow/SKILL.md
└── nuke-diagnostics/SKILL.md
```

The backend `NukeAISkillService` exposes only the root directory over JSON-RPC at
`/services/nuke-ai/skills`. `NukeSkillDirectoryContribution` contributes that root to Theia's
`SkillDirectoryContribution` provider. The root is resolved from the compiled service file and falls back to the
`nuke-ai` package root if a packaging layout changes the relative depth; the resolved path is logged once. Skill
content is read by Theia's own `DefaultSkillService` through `FileService`, never by the backend service.

## Frontmatter rules

Every `SKILL.md` starts with YAML frontmatter:

```yaml
---
name: nuke-cad
description: One sentence describing when the skill applies.
---
```

- `name` must exactly match the directory name and be lowercase kebab-case with digits allowed.
- `description` must be non-empty and under 1024 characters.
- Theia rejects invalid frontmatter, a name/directory mismatch, and duplicate names across roots; the skill is
  skipped and the reason is logged by `DefaultSkillService`.

## How Theia exposes skills

Theia's `DefaultSkillService` scans the contributed root and parses each `SKILL.md`. `SkillPromptCoordinator` then
registers one synthetic prompt fragment per skill with `commandName = skill.qualifiedName`. Plugin-tier skills have
no qualifier, so the chat exposes them as slash commands:

- `/nuke-cad`
- `/openmc-studio`
- `/nuke-visualizer`
- `/nuke-workflow`
- `/nuke-diagnostics`

The same skills appear under **Generic Capabilities → Skills** in the chat input and through the `{{skills}}`
variable. A slash command loads the skill content through `~{getSkillFileContent}`; the model can also load a skill
by name when a conversation needs progressive disclosure.

## Content rules

- Use only the approved chat tool names:
  `nuke_cad_summarizeDocument`, `nuke_cad_inspectSelection`, `nuke_cad_diagnoseModel`, `nuke_cad_exportDagmc`,
  `nuke_cad_listSketchDimensions`, `nuke_cad_previewFeatureChange`, `nuke_cad_applyFeatureChange`,
  `nuke_cad_previewSketchChange`, `nuke_cad_applySketchChange`, `nuke_cad_previewTopologyChange`,
  `nuke_cad_applyTopologyChange`, `nuke_cad_inspectImportSource`, `nuke_cad_previewImportBodies`,
  `nuke_cad_applyImportBodies`, `nuke_cad_summarizeAssembly`, `nuke_cad_previewAssemblyChange`,
  `nuke_cad_applyAssemblyChange`, `nuke_cad_summarizeDrawing`, `nuke_cad_previewDrawingChange`,
  `nuke_cad_applyDrawingChange`, `nuke_cad_inspectScriptSource`, `nuke_cad_previewScriptChange`,
  `nuke_cad_applyScriptChange`, `nuke_openmc_summarizeProject`, `nuke_openmc_validateProject`,
  `nuke_openmc_importCad`, `nuke_openmc_runSimulation`, `nuke_openmc_getRunStatus`, `nuke_openmc_diagnoseProject`,
  `nuke_openmc_diagnoseRun`, `nuke_viz_summarizeStatepoint`, `nuke_viz_openStatepoint`, `nuke_viz_captureView`,
  `nuke_viz_diagnoseStatepoint`, `nuke_viz_compareStatepoints`, `nuke_viz_analyzeTallySeries`.
- Call instructions use the sanitized tool names. Each skill includes one short mapping note because the
  capability id stays the stable registry identifier: `nuke.cad.summarizeDocument` is exposed as
  `nuke_cad_summarizeDocument`, and the remaining ids replace dots with underscores in the same way.
- State that write and execute tools ask for confirmation and require explicit user intent.
- Script guidance states the two default-off switches, the Linux+bubblewrap requirement, that inspected source text goes to
  the model provider, that preview runs without network/workspace and writes nothing, and that apply is panel-only with a
  hidden approval nonce, backup, and undo. Never describe a chat-side script apply.
- Keep paths absolute and inside the workspace, as the capabilities enforce.
- Keep each skill under roughly 150 lines; split into sibling files referenced relative to `SKILL.md` only when
  the content genuinely needs it.
- Do not cite planning material, edit capability behavior in prose, or invent ids, paths, or result fields.

## Adding a skill

1. Create `skills/<lowercase-kebab-name>/SKILL.md` with valid frontmatter.
2. Verify `name` equals the directory and `description` is under 1024 characters.
3. Keep the skill read-only guidance: it explains when and how to call existing capabilities but never adds a
   transport or a private tool.
4. Add the skill to the frontmatter parsing test in `src/node/skills/nuke-skill-service.test.ts` by updating its
   skill-name list.
5. Run `npx vitest run extensions/nuke-ai` and `npx lerna run build --scope nuke-ai`.
