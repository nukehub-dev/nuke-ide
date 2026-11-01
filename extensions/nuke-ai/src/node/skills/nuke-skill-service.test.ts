// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ILogger } from '@theia/core/lib/common/logger';
import { parseSkillFile, validateSkillDescription } from '@theia/ai-core/lib/common/skill';
import { NukeAISkillServiceImpl, resolveNukeAISkillRoots } from './nuke-skill-service';

const SKILL_NAMES = ['nuke-cad', 'openmc-studio', 'nuke-visualizer', 'nuke-workflow', 'nuke-diagnostics'];

const ALLOWED_CAPABILITY_IDS = new Set([
    'nuke.cad.summarizeDocument',
    'nuke.cad.inspectSelection',
    'nuke.cad.exportDagmc',
    'nuke.cad.diagnoseModel',
    'nuke.openmc.summarizeProject',
    'nuke.openmc.validateProject',
    'nuke.openmc.importCad',
    'nuke.openmc.runSimulation',
    'nuke.openmc.getRunStatus',
    'nuke.openmc.diagnoseProject',
    'nuke.openmc.diagnoseRun',
    'nuke.viz.summarizeStatepoint',
    'nuke.viz.openStatepoint',
    'nuke.viz.captureView',
    'nuke.viz.diagnoseStatepoint',
    'nuke.viz.compareStatepoints',
    'nuke.viz.analyzeTallySeries'
]);

const ALLOWED_TOOL_NAMES = [
    'nuke_cad_summarizeDocument',
    'nuke_cad_inspectSelection',
    'nuke_cad_exportDagmc',
    'nuke_cad_diagnoseModel',
    'nuke_openmc_summarizeProject',
    'nuke_openmc_validateProject',
    'nuke_openmc_importCad',
    'nuke_openmc_runSimulation',
    'nuke_openmc_getRunStatus',
    'nuke_openmc_diagnoseProject',
    'nuke_openmc_diagnoseRun',
    'nuke_viz_summarizeStatepoint',
    'nuke_viz_openStatepoint',
    'nuke_viz_captureView',
    'nuke_viz_diagnoseStatepoint',
    'nuke_viz_compareStatepoints',
    'nuke_viz_analyzeTallySeries'
];

function createLogger(): ILogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

function extensionRoot(): string {
    return path.resolve(__dirname, '..', '..', '..');
}

function readSkill(name: string): { content: string; directory: string } {
    const directory = path.join(extensionRoot(), 'skills', name);
    return {
        content: fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf-8'),
        directory
    };
}

describe('NukeAISkillServiceImpl', () => {
    it('resolves the same nuke-ai/skills root from the source and compiled service layouts', () => {
        const root = extensionRoot();
        const source = resolveNukeAISkillRoots(path.join(root, 'src', 'node', 'skills'));
        const compiled = resolveNukeAISkillRoots(path.join(root, 'lib', 'node', 'skills'));

        expect(source).toEqual([path.join(root, 'skills')]);
        expect(compiled).toEqual([path.join(root, 'skills')]);
        expect(source[0]).toMatch(/nuke-ai[\\/]skills$/);
        expect(compiled[0]).toMatch(/nuke-ai[\\/]skills$/);
    });

    it('falls back to the nuke-ai package root when the direct layout changes', () => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-ai-skill-root-'));
        try {
            fs.mkdirSync(path.join(temporary, 'skills'));
            fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: 'nuke-ai' }));
            const fromDir = path.join(temporary, 'lib', 'node', 'skills');
            fs.mkdirSync(fromDir, { recursive: true });

            expect(resolveNukeAISkillRoots(fromDir)).toEqual([path.join(temporary, 'skills')]);
        } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });

    it('falls back to the installed package when a bundled path has no skill directory', () => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-ai-missing-root-'));
        try {
            const fromDir = path.join(temporary, 'lib', 'node', 'skills');
            let roots: string[] = [];
            expect(() => {
                roots = resolveNukeAISkillRoots(fromDir);
            }).not.toThrow();
            expect(roots[0]).toMatch(/nuke-ai[\\/]skills$/);
            expect(fs.existsSync(roots[0])).toBe(true);
        } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });

    it('returns the packaged root with the five skill directories', async () => {
        const service = new NukeAISkillServiceImpl(createLogger());

        const roots = await service.getSkillRoots();

        expect(roots).toHaveLength(1);
        expect(roots[0]).toMatch(/nuke-ai[\\/]skills$/);
        for (const name of SKILL_NAMES) {
            const directory = path.join(roots[0], name);
            expect(fs.statSync(directory).isDirectory()).toBe(true);
            expect(fs.statSync(path.join(directory, 'SKILL.md')).isFile()).toBe(true);
        }
    });

    it('logs the resolved root once across repeated reads', async () => {
        const logger = createLogger();
        const service = new NukeAISkillServiceImpl(logger);

        await service.getSkillRoots();
        await service.getSkillRoots();

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(String(logger.info.mock.calls[0][0])).toContain(path.join(extensionRoot(), 'skills'));
    });

    it.each(SKILL_NAMES)('parses %s with valid frontmatter matching the directory', (name) => {
        const { content } = readSkill(name);
        const parsed = parseSkillFile(content);

        expect(parsed.metadata).toBeDefined();
        expect(parsed.metadata?.name).toBe(name);
        expect(parsed.metadata?.description.trim().length).toBeGreaterThan(0);
        expect(parsed.metadata?.description.length).toBeLessThan(1024);
        expect(validateSkillDescription(parsed.metadata as NonNullable<typeof parsed.metadata>, name)).toEqual([]);
        expect(parsed.content).not.toContain('name:');
    });

    it('uses only approved tool names, maps them from capability ids, and mentions confirmation in every skill', () => {
        const contents = SKILL_NAMES.map((name) => readSkill(name).content);
        const combined = contents.join('\n');
        const used = new Set(combined.match(/nuke\.[a-z]+\.[A-Za-z]+/g) ?? []);

        for (const id of used) {
            expect(ALLOWED_CAPABILITY_IDS.has(id), `unexpected capability id ${id}`).toBe(true);
        }
        for (const toolName of ALLOWED_TOOL_NAMES) {
            expect(combined, `missing tool ${toolName}`).toContain(toolName);
        }
        for (const content of contents) {
            expect(content.toLowerCase()).toContain('confirmation');
            expect(content.toLowerCase()).toContain('capability id');
            const mappings = [...content.matchAll(/`(nuke\.[a-z]+\.[A-Za-z]+)` is\s+exposed as `([^`]+)`/g)];
            expect(mappings.length, 'missing capability-id-to-tool mapping').toBeGreaterThan(0);
            for (const [, capabilityId, toolName] of mappings) {
                expect(ALLOWED_TOOL_NAMES).toContain(toolName);
                expect(toolName).toBe(capabilityId.replace(/\./g, '_'));
            }
        }
    });
});
