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
 * Tests the OpenMC Python export capability against fake services: no Theia
 * boot, no save dialog, no file writes, and no AI runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { Event } from '@theia/core/lib/common/event';
import { URI } from '@theia/core/lib/common/uri';

// Keep the suite in the Node environment: these services pull in browser DOM modules.
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('../openmc-state-manager', () => ({ OpenMCStateManager: class OpenMCStateManager {} }));
vi.mock('../script-generator/python-exporter', () => ({ OpenMCPythonExporter: class OpenMCPythonExporter {} }));

import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { OpenMCStateManager } from '../openmc-state-manager';
import type { OpenMCPythonExporter, PythonExportOptions, PythonExportResult } from '../script-generator/python-exporter';
import { EXPORT_PYTHON_CAPABILITY_ID, OpenMCScriptCapabilities } from './openmc-script-capabilities';

const WORKSPACE = '/workspace';
const PROJECT_PATH = `${WORKSPACE}/pincell.nuke-openmc`;

interface FileEntry {
    isFile?: boolean;
    isDirectory?: boolean;
    isSymbolicLink?: boolean;
    size?: number;
    realPath?: string;
}

class FakeFileService {
    readonly entries = new Map<string, FileEntry>();
    resolve = vi.fn(async (uri: URI): Promise<FileStat> => {
        const target = uri.path.toString();
        const entry = this.entries.get(target);
        if (!entry) {
            throw new Error(`Not found: ${target}`);
        }
        return {
            resource: uri,
            name: path.posix.basename(target),
            isFile: entry.isFile ?? false,
            isDirectory: entry.isDirectory ?? false,
            isSymbolicLink: entry.isSymbolicLink ?? false,
            isReadonly: false,
            size: entry.size,
            realPath: entry.realPath
        } as FileStat & { realPath?: string };
    });

    seed(target: string, entry: FileEntry = {}): void {
        this.entries.set(target, entry);
    }
}

class FakeStateManager {
    constructor(public projectPath?: string) {}
}

class FakeExporter {
    result: PythonExportResult = { success: true, files: [`${WORKSPACE}/model.py`] };
    readonly calls: Array<Partial<PythonExportOptions>> = [];
    exportToPython = vi.fn(async (options?: Partial<PythonExportOptions>): Promise<PythonExportResult> => {
        this.calls.push(options ?? {});
        return this.result;
    });
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
    stateManager: FakeStateManager;
    exporter: FakeExporter;
    fileService: FakeFileService;
    registry: FakeRegistry;
    invoke(input: unknown, workspaceRoots?: readonly string[]): Promise<NukeCapabilityResult>;
}

function createHarness(options: { saved?: boolean; projectPath?: string } = {}): Harness {
    const projectPath = options.saved === false ? undefined : (options.projectPath ?? PROJECT_PATH);
    const stateManager = new FakeStateManager(projectPath);
    const exporter = new FakeExporter();
    const fileService = new FakeFileService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCScriptCapabilities(
        stateManager as unknown as OpenMCStateManager,
        exporter as unknown as OpenMCPythonExporter,
        fileService as unknown as FileService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        exporter,
        fileService,
        registry,
        invoke: (input, workspaceRoots = [WORKSPACE]) => {
            const capability = registry.get(EXPORT_PYTHON_CAPABILITY_ID);
            if (!capability) {
                throw new Error(`Missing capability ${EXPORT_PYTHON_CAPABILITY_ID}`);
            }
            return capability.invoke(input, { workspaceRoots });
        }
    };
}

describe('OpenMC Python export capability', () => {
    it('requires a saved project', async () => {
        const harness = createHarness({ saved: false });

        const result = await harness.invoke({});

        expect(result).toEqual({ ok: false, message: 'Save the OpenMC project before exporting a Python script.' });
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('rejects an explicit path outside the workspace', async () => {
        const harness = createHarness();

        const result = await harness.invoke({ path: '/tmp/model.py' });

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/outside every workspace root/);
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('rejects an existing file when overwrite is not set', async () => {
        const harness = createHarness();
        harness.fileService.seed(`${WORKSPACE}/model.py`, { isFile: true, size: 100 });

        const result = await harness.invoke({ path: `${WORKSPACE}/model.py` });

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/already exists/);
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('replaces an existing file when overwrite is true', async () => {
        const harness = createHarness();
        harness.fileService.seed(`${WORKSPACE}/model.py`, { isFile: true, size: 128 });

        const result = await harness.invoke({ path: `${WORKSPACE}/model.py`, overwrite: true });

        expect(harness.exporter.exportToPython).toHaveBeenCalledTimes(1);
        expect(harness.exporter.calls[0]).toEqual({
            mode: 'single',
            targetPath: `${WORKSPACE}/model.py`,
            includeComments: true,
            includeShebang: true
        });
        expect(result).toEqual({
            ok: true,
            data: { paths: [`${WORKSPACE}/model.py`], fileCount: 1, bytes: 128 }
        });
    });

    it('derives model.py beside the saved project by default', async () => {
        const harness = createHarness();

        const result = await harness.invoke({});

        expect(harness.exporter.calls[0]).toEqual({
            mode: 'single',
            targetPath: `${WORKSPACE}/model.py`,
            includeComments: true,
            includeShebang: true
        });
        expect(result).toEqual({ ok: true, data: { paths: [`${WORKSPACE}/model.py`], fileCount: 1 } });
    });

    it('passes exporter failures through', async () => {
        const harness = createHarness();
        harness.exporter.result = { success: false, files: [], error: 'Disk is full.' };

        const result = await harness.invoke({ path: `${WORKSPACE}/export.py` });

        expect(result).toEqual({ ok: false, message: 'Disk is full.' });
    });

    it('requires an existing directory for separate mode', async () => {
        const harness = createHarness();
        harness.fileService.seed(`${WORKSPACE}/model.py`, { isFile: true });

        const fileResult = await harness.invoke({ mode: 'separate', path: `${WORKSPACE}/model.py` });
        const missingResult = await harness.invoke({ mode: 'separate', path: `${WORKSPACE}/missing` });

        expect(fileResult.ok).toBe(false);
        expect(fileResult.message).toMatch(/must be a directory/);
        expect(missingResult.ok).toBe(false);
        expect(missingResult.message).toMatch(/does not exist/);
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('writes separate files into the validated directory', async () => {
        const harness = createHarness();
        harness.fileService.seed(`${WORKSPACE}/scripts`, { isDirectory: true });
        harness.exporter.result = {
            success: true,
            files: [`file://${WORKSPACE}/scripts/materials.py`, `file://${WORKSPACE}/scripts/model.py`]
        };

        const result = await harness.invoke({ mode: 'separate', path: `${WORKSPACE}/scripts` });

        expect(harness.exporter.calls[0]).toEqual({
            mode: 'separate',
            outputDirectory: `${WORKSPACE}/scripts`,
            includeComments: true,
            includeShebang: true
        });
        expect(result).toEqual({
            ok: true,
            data: {
                paths: [`${WORKSPACE}/scripts/materials.py`, `${WORKSPACE}/scripts/model.py`],
                fileCount: 2
            }
        });
    });

    it('defaults separate mode to the project directory', async () => {
        const harness = createHarness();
        harness.exporter.result = { success: true, files: [`file://${WORKSPACE}/materials.py`] };

        const result = await harness.invoke({ mode: 'separate' });

        expect(harness.exporter.calls[0]).toEqual({
            mode: 'separate',
            outputDirectory: WORKSPACE,
            includeComments: true,
            includeShebang: true
        });
        expect(result.ok).toBe(true);
    });

    it('rejects symlinked path segments', async () => {
        const harness = createHarness();
        harness.fileService.seed(`${WORKSPACE}/linked`, { isDirectory: true, isSymbolicLink: true });

        const result = await harness.invoke({ path: `${WORKSPACE}/linked/model.py` });

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/symbolic links/);
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('rejects control characters and overlong paths', async () => {
        const harness = createHarness();

        const controlResult = await harness.invoke({ path: `${WORKSPACE}/bad\u0001name.py` });
        const longResult = await harness.invoke({ path: `${WORKSPACE}/${'a'.repeat(1030)}.py` });

        expect(controlResult.ok).toBe(false);
        expect(controlResult.message).toMatch(/control characters/);
        expect(longResult.ok).toBe(false);
        expect(longResult.message).toMatch(/longer than 1024/);
        expect(harness.exporter.exportToPython).not.toHaveBeenCalled();
    });

    it('does not use the console or DOM', async () => {
        const spies = [
            vi.spyOn(console, 'log'),
            vi.spyOn(console, 'info'),
            vi.spyOn(console, 'warn'),
            vi.spyOn(console, 'error'),
            vi.spyOn(console, 'debug')
        ];
        try {
            const harness = createHarness();

            const result = await harness.invoke({});

            expect(result.ok).toBe(true);
            for (const spy of spies) {
                expect(spy).not.toHaveBeenCalled();
            }
            expect((globalThis as { document?: unknown }).document).toBeUndefined();
        } finally {
            for (const spy of spies) {
                spy.mockRestore();
            }
        }
    });
});
