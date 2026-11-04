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
import type { Mock } from 'vitest';
import { Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService, TextFileContent } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import * as path from 'path';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeResourceService } from './nuke-resource-service';
import type { NukeSkillRootCache } from '../skills/nuke-skill-root-cache';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({
    FileService: Symbol('FileService')
}));

const ROOT = '/extensions/nuke-ai/skills';

class FakeContextService implements NukeCapabilityContextService {
    context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };
    fail = false;

    readonly onDidChangeContext = Event.None;

    async getContext(): Promise<NukeCapabilityContext> {
        if (this.fail) {
            throw new Error('context failed');
        }
        return this.context;
    }
}

class FakeCapabilityRegistry implements NukeCapabilityRegistry {
    capabilities: NukeCapability[] = [];

    readonly onDidChange = Event.None;
    readonly ready = Promise.resolve();

    register(capability: NukeCapability): void {
        this.capabilities.push(capability);
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.find((capability) => capability.id === id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.capabilities.filter((capability) => !capability.when || capability.when(context));
    }
}

class FakeFileService {
    readonly directories = new Map<string, string[]>();
    readonly files = new Map<string, string>();
    readonly resolveCalls: string[] = [];
    readonly readCalls: string[] = [];
    readonly failingReads = new Set<string>();

    async resolve(uri: URI): Promise<FileStat> {
        const filePath = uri.path.fsPath();
        this.resolveCalls.push(filePath);
        const children = this.directories.get(filePath);
        if (!children) {
            throw new Error(`ENOENT: ${filePath}`);
        }
        return {
            resource: uri,
            isDirectory: true,
            isFile: false,
            children: children.map((name) => ({
                resource: URI.fromFilePath(path.join(filePath, name)),
                name,
                isDirectory: true,
                isFile: false
            }))
        } as unknown as FileStat;
    }

    async exists(uri: URI): Promise<boolean> {
        const filePath = uri.path.fsPath();
        return this.files.has(filePath) || this.directories.has(filePath);
    }

    async read(uri: URI): Promise<TextFileContent> {
        const filePath = uri.path.fsPath();
        this.readCalls.push(filePath);
        if (this.failingReads.has(filePath)) {
            throw new Error('permission denied');
        }
        const value = this.files.get(filePath);
        if (value === undefined) {
            throw new Error(`ENOENT: ${filePath}`);
        }
        return { value } as TextFileContent;
    }

    addSkill(root: string, name: string, content: string): void {
        const children = this.directories.get(root) ?? [];
        this.directories.set(root, [...children, name]);
        this.files.set(path.join(root, name, 'SKILL.md'), content);
    }
}

function createLogger(): ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function capability(
    id: string,
    invoke: (input: unknown, context: NukeCapabilityContext) => Promise<NukeCapabilityResult>,
    when?: (context: NukeCapabilityContext) => boolean
): NukeCapability {
    return {
        id,
        title: id,
        description: `${id} description`,
        category: ['Test'],
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
        when,
        invoke
    };
}

interface SetupOptions {
    context?: Partial<NukeCapabilityContext>;
    contextFails?: boolean;
    capabilities?: NukeCapability[];
    skillRoots?: string[];
    skillRootsFail?: boolean;
}

interface Setup {
    service: NukeResourceService;
    contextService: FakeContextService;
    registry: FakeCapabilityRegistry;
    fileService: FakeFileService;
    skillService: { getSkillRoots: Mock<() => Promise<string[]>> };
    logger: ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function setup(options: SetupOptions = {}): Setup {
    const contextService = new FakeContextService();
    contextService.context = { ...contextService.context, ...options.context };
    contextService.fail = options.contextFails ?? false;
    const registry = new FakeCapabilityRegistry();
    registry.capabilities = options.capabilities ?? [];
    const fileService = new FakeFileService();
    const skillService = {
        getSkillRoots: vi.fn<() => Promise<string[]>>(async () => {
            if (options.skillRootsFail) {
                throw new Error('skill backend offline');
            }
            return options.skillRoots ?? [];
        })
    };
    const skillRootCache = { getRoots: vi.fn(() => skillService.getSkillRoots()) };
    const logger = createLogger();
    const service = new NukeResourceService(
        contextService,
        registry,
        fileService as unknown as FileService,
        skillRootCache as unknown as NukeSkillRootCache,
        logger
    );
    return { service, contextService, registry, fileService, skillService, logger };
}

function summaryCapabilities(): NukeCapability[] {
    return [
        capability('nuke.cad.summarizeDocument', async () => ({
            ok: true,
            data: { documentPath: '/workspace/model.nuke-cad', solidCount: 3 }
        })),
        capability('nuke.openmc.summarizeProject', async () => ({
            ok: true,
            data: { projectPath: '/workspace/project.nuke-openmc', name: 'Pincell' }
        })),
        capability('nuke.viz.summarizeStatepoint', async () => ({
            ok: true,
            data: { file: '/workspace/statepoint.100.h5', batches: 50, kEff: 1.01 }
        }))
    ];
}

describe('NukeResourceService', () => {
    it('always lists the context resource when nothing else is available', async () => {
        const { service } = setup();

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context']);
        expect(resources[0]).toMatchObject({
            name: 'Nuke context',
            mimeType: 'application/json'
        });
    });

    it('lists CAD, OpenMC, and visualizer summaries only when each activity is active', async () => {
        const { service } = setup({
            context: { activeCadDocument: '/workspace/model.nuke-cad' },
            capabilities: summaryCapabilities()
        });

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context', 'nuke://cad/document']);
    });

    it('lists active resources and skills once their capabilities exist', async () => {
        const { service, fileService } = setup({
            context: {
                activeCadDocument: '/workspace/model.nuke-cad',
                activeOpenmcProject: '/workspace/project.nuke-openmc',
                activeDataset: '/workspace/statepoint.100.h5'
            },
            capabilities: summaryCapabilities(),
            skillRoots: [ROOT]
        });
        fileService.addSkill(ROOT, 'nuke-cad', '# Nuke CAD');
        fileService.addSkill(ROOT, 'openmc-studio', '# OpenMC Studio');

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual([
            'nuke://context',
            'nuke://cad/document',
            'nuke://openmc/project',
            'nuke://visualizer/dataset',
            'nuke://skills/nuke-cad',
            'nuke://skills/openmc-studio'
        ]);
        expect(resources[4]).toMatchObject({
            name: 'nuke-cad',
            mimeType: 'text/markdown'
        });
    });

    it('does not list an active resource when its capability is missing', async () => {
        const { service } = setup({
            context: { activeCadDocument: '/workspace/model.nuke-cad' },
            capabilities: []
        });

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context']);
    });

    it('respects a when() predicate that disables the summary capability', async () => {
        const { service } = setup({
            context: { activeCadDocument: '/workspace/model.nuke-cad' },
            capabilities: [
                capability(
                    'nuke.cad.summarizeDocument',
                    async () => ({ ok: true }),
                    () => false
                )
            ]
        });

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context']);
    });

    it('reads the context resource as formatted JSON', async () => {
        const { service, contextService } = setup({
            context: {
                workspaceRoots: ['/workspace'],
                activeCadDocument: '/workspace/model.nuke-cad'
            }
        });

        const content = await service.read('nuke://context');

        expect(JSON.parse(content)).toEqual(contextService.context);
        expect(content).toContain('\n  "workspaceRoots": [');
    });

    it('reads a CAD summary through the capability registry with an empty input', async () => {
        const invoke = vi.fn(async () => ({ ok: true, data: { documentPath: '/workspace/model.nuke-cad' } }));
        const { service, contextService } = setup({
            context: { activeCadDocument: '/workspace/model.nuke-cad' },
            capabilities: [capability('nuke.cad.summarizeDocument', invoke)]
        });

        const content = await service.read('nuke://cad/document');

        expect(invoke).toHaveBeenCalledWith({}, contextService.context);
        expect(JSON.parse(content)).toEqual({ documentPath: '/workspace/model.nuke-cad' });
    });

    it('returns the capability message when a summary fails', async () => {
        const { service } = setup({
            context: { activeOpenmcProject: '/workspace/project.nuke-openmc' },
            capabilities: [
                capability('nuke.openmc.summarizeProject', async () => ({
                    ok: false,
                    message: 'No OpenMC project is active.'
                }))
            ]
        });

        const content = await service.read('nuke://openmc/project');

        expect(content).toContain('No OpenMC project is active.');
    });

    it('returns a clear error when a capability throws', async () => {
        const { service } = setup({
            context: { activeDataset: '/workspace/statepoint.100.h5' },
            capabilities: [
                capability('nuke.viz.summarizeStatepoint', async () => {
                    throw new Error('statepoint unreadable');
                })
            ]
        });

        const content = await service.read('nuke://visualizer/dataset');

        expect(content).toContain('Unable to read nuke://visualizer/dataset');
        expect(content).toContain('statepoint unreadable');
    });

    it('refuses an inactive resource even when it is read directly', async () => {
        const { service } = setup({
            capabilities: summaryCapabilities()
        });

        const content = await service.read('nuke://cad/document');

        expect(content).toContain('not available');
        expect(content).toContain('no active CAD document');
    });

    it('lists skills from the backend root and reads the matching SKILL.md', async () => {
        const { service, fileService, skillService } = setup({
            skillRoots: [ROOT]
        });
        fileService.addSkill(ROOT, 'nuke-cad', '---\nname: nuke-cad\n---\n# Nuke CAD');

        const resources = await service.getResources();
        const content = await service.read('nuke://skills/nuke-cad');

        expect(resources.map((resource) => resource.uri)).toContain('nuke://skills/nuke-cad');
        expect(content).toBe('---\nname: nuke-cad\n---\n# Nuke CAD');
        expect(skillService.getSkillRoots).toHaveBeenCalledTimes(2);
        expect(fileService.readCalls).toEqual([path.join(ROOT, 'nuke-cad', 'SKILL.md')]);
        for (const filePath of fileService.readCalls) {
            expect(filePath.startsWith(ROOT + path.sep)).toBe(true);
        }
    });

    it('returns a clear error for a skill that does not exist', async () => {
        const { service } = setup({ skillRoots: [ROOT] });

        await expect(service.read('nuke://skills/nuke-cad')).resolves.toBe('Skill not found: nuke-cad.');
    });

    it('returns the underlying error when a skill file cannot be read', async () => {
        const { service, fileService } = setup({ skillRoots: [ROOT] });
        const target = path.join(ROOT, 'nuke-cad', 'SKILL.md');
        fileService.files.set(target, '# Nuke CAD');
        fileService.failingReads.add(target);

        const content = await service.read('nuke://skills/nuke-cad');

        expect(content).toBe('Unable to read nuke://skills/nuke-cad: permission denied');
    });

    it.each([
        'nuke://skills/../secret',
        'nuke://skills/..',
        'nuke://skills/',
        'nuke://skills//etc/passwd',
        'nuke://skills/nuke-cad/../../secret',
        'nuke://skills/%2e%2e%2fsecret'
    ])('rejects the scoped skill URI %s without reading a file', async (uri) => {
        const { service, fileService, skillService } = setup({ skillRoots: [ROOT] });

        const content = await service.read(uri);

        expect(content).toContain('invalid skill name');
        expect(fileService.readCalls).toEqual([]);
        expect(skillService.getSkillRoots).not.toHaveBeenCalled();
    });

    it('returns an empty skill list and logs when the backend skill roots fail', async () => {
        const { service, logger } = setup({ skillRootsFail: true });

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context']);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(String(logger.error.mock.calls[0][0])).toContain('Failed to read skill roots');
    });

    it('returns a clear error when the skill service is unavailable at read time', async () => {
        const { service } = setup({ skillRootsFail: true });

        const content = await service.read('nuke://skills/nuke-cad');

        expect(content).toBe('Unable to read nuke://skills/nuke-cad: the skill service is unavailable.');
    });

    it('keeps the context resource available when context collection fails', async () => {
        const { service, logger } = setup({ contextFails: true, capabilities: summaryCapabilities() });

        const resources = await service.getResources();
        const contextContent = await service.read('nuke://context');
        const cadContent = await service.read('nuke://cad/document');

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context']);
        expect(contextContent).toContain('context failed');
        expect(cadContent).toContain('context unavailable');
        expect(logger.error).toHaveBeenCalled();
    });

    it('returns a clear error for an unknown resource URI', async () => {
        const { service } = setup();

        await expect(service.read('nuke://unknown')).resolves.toBe('Unknown resource: nuke://unknown');
    });

    it('does not list skill directories without a SKILL.md file', async () => {
        const { service, fileService, skillService } = setup({ skillRoots: [ROOT] });
        fileService.addSkill(ROOT, 'nuke-cad', '# Nuke CAD');
        fileService.directories.set(ROOT, ['nuke-cad', 'not-a-skill']);

        const resources = await service.getResources();

        expect(resources.map((resource) => resource.uri)).toEqual(['nuke://context', 'nuke://skills/nuke-cad']);
        expect(await skillService.getSkillRoots()).toEqual([ROOT]);
    });
});
