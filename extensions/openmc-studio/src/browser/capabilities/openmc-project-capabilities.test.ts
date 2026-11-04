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

/**
 * Tests the OpenMC project creation capability against a real state manager
 * and fake backend/file services: no Theia boot, no filesystem, and no AI
 * runtime.
 */

import { describe, expect, it, vi } from 'vitest';

// The state manager only needs the event primitives and DI tokens; mock the
// browser-only Theia imports so vitest runs in node.
vi.mock('@theia/core/lib/common', () => {
    class Emitter<T> {
        private readonly listeners: ((value: T) => void)[] = [];
        readonly event = (listener: (value: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => undefined };
        };
        fire(value: T): void {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
    }
    return { Emitter, Event: class {} };
});
vi.mock('@theia/core/lib/common/message-service', () => ({ MessageService: class {} }));
vi.mock('@theia/core/lib/common/preferences', () => ({ PreferenceScope: {}, PreferenceService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));

import { Event } from '@theia/core/lib/common/event';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { OpenMCStudioBackendService, ProjectSaveRequest } from '../../common/openmc-studio-protocol';
import { createDefaultState, OpenMCStateManager } from '../openmc-state-manager';
import { CREATE_PROJECT_CAPABILITY_ID, OpenMCProjectCapabilities } from './openmc-project-capabilities';

const WORKSPACE = '/workspace';

interface FakeStat {
    isDirectory: boolean;
    isFile: boolean;
    isSymbolicLink: boolean;
}

class FakeFileService {
    readonly directories = new Set<string>([WORKSPACE, `${WORKSPACE}/projects`]);
    readonly files = new Set<string>();
    readonly symlinks = new Set<string>();

    readonly resolve = vi.fn(async (uri: URI): Promise<FakeStat> => {
        const filePath = uri.path.toString();
        if (this.symlinks.has(filePath)) {
            return { isDirectory: false, isFile: false, isSymbolicLink: true };
        }
        if (this.directories.has(filePath)) {
            return { isDirectory: true, isFile: false, isSymbolicLink: false };
        }
        if (this.files.has(filePath)) {
            return { isDirectory: false, isFile: true, isSymbolicLink: false };
        }
        throw new Error(`Not found: ${filePath}`);
    });

    readonly exists = vi.fn(async (uri: URI): Promise<boolean> => {
        const filePath = uri.path.toString();
        return this.directories.has(filePath) || this.files.has(filePath) || this.symlinks.has(filePath);
    });
}

class FakeBackend {
    result: { success: boolean; error?: string } = { success: true };

    readonly saveProject = vi.fn(async (_request: ProjectSaveRequest): Promise<{ success: boolean; error?: string }> => this.result);
}

class FakeRegistry implements NukeCapabilityRegistry {
    readonly capabilities = new Map<string, NukeCapability>();
    readonly onDidChange = Event.None;
    readonly ready = Promise.resolve();

    register(capability: NukeCapability): void {
        this.capabilities.set(capability.id, capability);
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.get(id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities.values()];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.getAll().filter((capability) => !capability.when || capability.when(context));
    }
}

interface Harness {
    stateManager: OpenMCStateManager;
    backend: FakeBackend;
    fileService: FakeFileService;
    registry: FakeRegistry;
    create(input: unknown, workspaceRoots?: readonly string[]): Promise<NukeCapabilityResult>;
}

function createStateManager(): OpenMCStateManager {
    const manager = new OpenMCStateManager();
    manager.setState(createDefaultState(), false);
    // Keep project-path notifications offline: the watcher helper is not under test here.
    const internals = manager as unknown as { workspaceService: { tryGetRoots(): readonly unknown[] } };
    internals.workspaceService = { tryGetRoots: () => [] };
    return manager;
}

function createHarness(): Harness {
    const stateManager = createStateManager();
    const backend = new FakeBackend();
    const fileService = new FakeFileService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCProjectCapabilities(
        stateManager,
        backend as unknown as OpenMCStudioBackendService,
        fileService as unknown as FileService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        backend,
        fileService,
        registry,
        create: (input, workspaceRoots = [WORKSPACE]) => {
            const capability = registry.get(CREATE_PROJECT_CAPABILITY_ID);
            if (!capability) {
                throw new Error(`Missing capability ${CREATE_PROJECT_CAPABILITY_ID}`);
            }
            return capability.invoke(input, { workspaceRoots });
        }
    };
}

describe('OpenMC project creation capability', () => {
    it('declares a confirmed write with the template and path input contract', () => {
        const harness = createHarness();
        const capability = harness.registry.get(CREATE_PROJECT_CAPABILITY_ID)!;

        expect(capability.title).toBe('Create OpenMC project');
        expect(capability.category).toEqual(['OpenMC', 'Project']);
        expect(capability.risk).toBe('write');
        expect(capability.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        });
        expect(capability.requiresConfirmation).toBe(true);
        expect(capability.undoable).toBe(false);
        expect(capability.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(capability.inputSchema.required).toEqual(['name', 'path']);
        expect(capability.inputSchema.additionalProperties).toBe(false);
        expect(Object.keys(capability.inputSchema.properties).sort()).toEqual([
            'name',
            'parameters',
            'path',
            'replaceExisting',
            'templateId'
        ]);
        expect(capability.inputSchema.properties.parameters.additionalProperties).toEqual({ type: 'number' });
        expect(capability.outputSchema?.required).toEqual(['projectPath', 'templateId', 'counts']);
    });

    it('rejects an unknown template and lists the valid ids', async () => {
        const harness = createHarness();

        const result = await harness.create({ name: 'Project', path: 'project.nuke-openmc', templateId: 'missing' });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('Unknown project template "missing"');
        expect(result.message).toContain('blank');
        expect(result.message).toContain('pin-cell');
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects an empty or whitespace-only project name', async () => {
        const harness = createHarness();

        const result = await harness.create({ name: '   ', path: 'project.nuke-openmc' });

        expect(result).toEqual({ ok: false, message: 'Project name is required.' });
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects relative and absolute paths outside the workspace', async () => {
        const harness = createHarness();

        const relative = await harness.create({ name: 'Project', path: '../outside.nuke-openmc' });
        expect(relative).toEqual({ ok: false, message: 'Project path must be inside the workspace.' });

        const absolute = await harness.create({ name: 'Project', path: '/elsewhere/outside.nuke-openmc' });
        expect(absolute).toEqual({ ok: false, message: 'Project path must be inside the workspace.' });

        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects a project path with the wrong extension', async () => {
        const harness = createHarness();

        const result = await harness.create({ name: 'Project', path: 'project.json' });

        expect(result).toEqual({ ok: false, message: 'Project path must end with .nuke-openmc.' });
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects an existing target file without overwriting it', async () => {
        const harness = createHarness();
        harness.fileService.files.add(`${WORKSPACE}/taken.nuke-openmc`);

        const result = await harness.create({ name: 'Project', path: 'taken.nuke-openmc' });

        expect(result).toEqual({ ok: false, message: `A file already exists at ${WORKSPACE}/taken.nuke-openmc.` });
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects missing parents, control characters, and overlong paths', async () => {
        const harness = createHarness();
        const cases: Array<{ input: Record<string, unknown>; message: string }> = [
            { input: { name: 'Project', path: 'missing/project.nuke-openmc' }, message: 'Project directory does not exist' },
            { input: { name: 'Project', path: 'bad\u0001project.nuke-openmc' }, message: 'control characters' },
            {
                input: { name: 'Project', path: `${'a'.repeat(1100)}.nuke-openmc` },
                message: '1024 characters or fewer'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.create(testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('rejects a path that crosses a symbolic link', async () => {
        const harness = createHarness();
        harness.fileService.symlinks.add(`${WORKSPACE}/linked`);

        const result = await harness.create({ name: 'Project', path: 'linked/project.nuke-openmc' });

        expect(result).toEqual({ ok: false, message: `Project path crosses a symbolic link: ${WORKSPACE}/linked` });
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
    });

    it('refuses to replace a dirty active project', async () => {
        const harness = createHarness();
        harness.stateManager.setProjectPath(`${WORKSPACE}/active.nuke-openmc`);
        harness.stateManager.markDirty();
        const before = harness.stateManager.getState();

        const result = await harness.create({ name: 'New', path: 'new.nuke-openmc', replaceExisting: true });

        expect(result).toEqual({ ok: false, message: 'Save or discard the current project first.' });
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
        expect(harness.stateManager.projectPath).toBe(`${WORKSPACE}/active.nuke-openmc`);
        expect(harness.stateManager.getState()).toEqual(before);
    });

    it('requires replaceExisting to switch away from a clean active project', async () => {
        const harness = createHarness();
        harness.stateManager.setProjectPath(`${WORKSPACE}/active.nuke-openmc`);

        const result = await harness.create({ name: 'New', path: 'new.nuke-openmc' });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('replaceExisting');
        expect(harness.backend.saveProject).not.toHaveBeenCalled();
        expect(harness.stateManager.projectPath).toBe(`${WORKSPACE}/active.nuke-openmc`);
    });

    it('replaces a clean active project when replaceExisting is true', async () => {
        const harness = createHarness();
        harness.stateManager.setProjectPath(`${WORKSPACE}/active.nuke-openmc`);

        const result = await harness.create({ name: 'Next', path: 'next.nuke-openmc', replaceExisting: true });

        expect(result.ok).toBe(true);
        expect(harness.stateManager.projectPath).toBe(`${WORKSPACE}/next.nuke-openmc`);
        expect(harness.stateManager.getState().metadata.name).toBe('Next');
        expect(harness.stateManager.isDirty).toBe(false);
    });

    it('leaves the active project untouched when the backend save fails', async () => {
        const harness = createHarness();
        harness.backend.result = { success: false, error: 'disk full' };
        const before = harness.stateManager.getState();

        const result = await harness.create({ name: 'New', path: 'new.nuke-openmc' });

        expect(result).toEqual({ ok: false, message: 'disk full' });
        expect(harness.stateManager.getState()).toEqual(before);
        expect(harness.stateManager.projectPath).toBeUndefined();
        expect(harness.stateManager.isDirty).toBe(false);
    });

    it('saves the template first, then installs the state, path, and clean flag', async () => {
        const harness = createHarness();

        const result = await harness.create({
            name: '  Demo Pin  ',
            path: 'projects/demo.nuke-openmc',
            templateId: 'pin-cell',
            parameters: { enrichmentPct: 3.2 }
        });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            projectPath: `${WORKSPACE}/projects/demo.nuke-openmc`,
            templateId: 'pin-cell',
            counts: { materials: 3, surfaces: 9, cells: 4, universes: 1, lattices: 0 }
        });
        expect(result.nextActions).toEqual([
            {
                capability: 'nuke.openmc.validateProject',
                reason: 'Validate the new project before adding geometry or starting a run.'
            }
        ]);

        expect(harness.backend.saveProject).toHaveBeenCalledTimes(1);
        const request = harness.backend.saveProject.mock.calls[0][0];
        expect(request.projectPath).toBe(`${WORKSPACE}/projects/demo.nuke-openmc`);
        expect(request.state.metadata.name).toBe('Demo Pin');
        expect(request.state.materials).toHaveLength(3);
        expect(request.state.materials[0].nuclides[0].fraction).toBe(3.2);

        const installed = harness.stateManager.getState();
        expect(installed.metadata.name).toBe('Demo Pin');
        expect(installed.materials).toHaveLength(3);
        expect(harness.stateManager.projectPath).toBe(`${WORKSPACE}/projects/demo.nuke-openmc`);
        expect(harness.stateManager.isDirty).toBe(false);
    });

    it('defaults to the blank template when templateId is omitted', async () => {
        const harness = createHarness();

        const result = await harness.create({ name: 'Blank', path: 'blank.nuke-openmc' });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            projectPath: `${WORKSPACE}/blank.nuke-openmc`,
            templateId: 'blank',
            counts: { materials: 0, surfaces: 0, cells: 0, universes: 1, lattices: 0 }
        });
        const request = harness.backend.saveProject.mock.calls[0][0];
        expect(request.state.metadata.name).toBe('Blank');
        expect(request.state.materials).toEqual([]);
    });
});
