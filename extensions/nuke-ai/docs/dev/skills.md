# Skills

NukeAI ships domain skills as `SKILL.md` files under `extensions/nuke-ai/skills/`. Theia discovers them as a
lowest-precedence `plugin` tier, so a user skill with the same name in the workspace or config directory wins.

## Layout

```text
extensions/nuke-ai/skills/
├── nuke-cad/SKILL.md
├── openmc-studio/SKILL.md
├── nuke-visualizer/SKILL.md
└── nuke-workflow/SKILL.md
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

The same skills appear under **Generic Capabilities → Skills** in the chat input and through the `{{skills}}`
variable. A slash command loads the skill content through `~{getSkillFileContent}`; the model can also load a skill
by name when a conversation needs progressive disclosure.

## Content rules

- Use only capability ids that exist in the capability registry. The current approved set is:
  `nuke.cad.summarizeDocument`, `nuke.cad.inspectSelection`, `nuke.cad.exportDagmc`,
  `nuke.openmc.summarizeProject`, `nuke.openmc.validateProject`, `nuke.openmc.importCad`,
  `nuke.openmc.runSimulation`, `nuke.openmc.getRunStatus`, `nuke.viz.summarizeStatepoint`,
  `nuke.viz.openStatepoint`, `nuke.viz.captureView`.
- State that write and execute tools ask for confirmation and require explicit user intent.
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
