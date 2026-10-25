// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { URI } from '@theia/core/lib/common/uri';
import type {
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    GeometryBuildResult,
    NukeCadBackendService
} from '../../../common/nuke-cad-protocol';
import type { NukeCadPreferences } from '../../nuke-cad-preferences';

// The widget module pulls Theia browser/monaco modules (CSS imports, DOM at
// import time) that the node test environment cannot load. Mock exactly those
// direct imports; every transitive local module is node-safe (proven by the
// existing pure-logic suites), so the real partial funnel still runs.
vi.mock('@theia/core/lib/browser/widgets/react-widget', () => ({ ReactWidget: class {} }));
vi.mock('@theia/core/lib/browser', () => ({ Message: class {}, WidgetManager: class {} }));
vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickInputService: class {} }));
vi.mock('@theia/core/lib/browser/theming', () => ({ ThemeService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: class {} }));
vi.mock('@theia/monaco/lib/browser/monaco-workspace', () => ({ MonacoWorkspace: class {} }));
vi.mock('@theia/monaco/lib/browser/monaco-editor-model', () => ({ MonacoEditorModel: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

// Theia's nls reads localStorage at import time and lumino touches document;
// the node environment has neither.
async function loadWidget(): Promise<typeof import('./cad-viewport-widget.js')> {
    const g = globalThis as Record<string, unknown>;
    if (g['Element'] === undefined) {
        g['Element'] = class {};
    }
    if (g['HTMLElement'] === undefined) {
        g['HTMLElement'] = class {};
    }
    if (g['DragEvent'] === undefined) {
        g['DragEvent'] = class extends Event {};
    }
    if (g['document'] === undefined) {
        const stubElement = (): unknown => ({
            classList: { add: (): void => undefined, remove: (): void => undefined, contains: (): boolean => false },
            style: {},
            dataset: {},
            appendChild: (): void => undefined,
            removeChild: (): void => undefined,
            addEventListener: (): void => undefined,
            removeEventListener: (): void => undefined,
            setAttribute: (): void => undefined,
            removeAttribute: (): void => undefined,
            getAttribute: (): string | null => null,
            querySelector: (): null => null,
            querySelectorAll: (): unknown[] => [],
            matches: (): boolean => false,
            attachShadow: (): unknown => ({})
        });
        g['document'] = {
            createElement: stubElement,
            createElementNS: stubElement,
            documentElement: { style: {} },
            body: stubElement(),
            head: stubElement(),
            addEventListener: (): void => undefined,
            removeEventListener: (): void => undefined
        };
    }
    if (g['window'] === undefined) {
        g['window'] = globalThis;
    }
    if (g['localStorage'] === undefined) {
        const store = new Map<string, string>();
        g['localStorage'] = {
            getItem: (key: string): string | null => store.get(key) ?? null,
            setItem: (key: string, value: string): void => {
                store.set(key, value);
            },
            removeItem: (key: string): void => {
                store.delete(key);
            },
            clear: (): void => {
                store.clear();
            }
        };
    }
    return import('./cad-viewport-widget.js');
}

type WidgetModule = typeof import('./cad-viewport-widget.js');

interface Captured {
    partial: BuildFeaturesPartialRequest[];
    document: BuildDocumentRequest[];
}

function makeBackend(captured: Captured, withPartial: boolean): NukeCadBackendService {
    const result: GeometryBuildResult = { success: true, scriptPath: '/a/b/model.nuke-cad' };
    const backend = {
        buildDocument: async (request: BuildDocumentRequest) => {
            captured.document.push(request);
            return { ...result, scriptPath: request.scriptPath };
        },
        runFem: async () => ({ success: true }),
        listFemMaterials: async () => [],
        runJob: async () => ({ success: true, artifacts: [] }),
        cancelJob: async () => false,
        buildFoamCase: async () => ({ success: true, caseDir: '', solver: 'icoFoam', files: [] }),
        exportFoamStl: async () => ({ success: true, outputDir: '', stlFiles: [] }),
        listFoamSolvers: async () => [],
        checkCadEnvironment: async () => ({ ready: true, missing: [], missingOptional: [] })
    } as unknown as NukeCadBackendService;
    if (withPartial) {
        (backend as unknown as Record<string, unknown>)['buildFeaturesPartial'] = async (request: BuildFeaturesPartialRequest) => {
            captured.partial.push(request);
            return { ...result, scriptPath: request.scriptPath };
        };
    }
    return backend;
}

function makePreferences(sizeCapMB: number): NukeCadPreferences {
    return { 'nukeCad.resultCacheSizeMB': sizeCapMB } as unknown as NukeCadPreferences;
}

/**
 * Widget instance with only the collaborators the partial funnel needs.
 * Built without running the lumino/React constructor (no DOM in this
 * environment); the real `buildPartialWithFallback` still runs.
 */
function makeWidget(m: WidgetModule, backend: NukeCadBackendService, sizeCapMB: number): any {
    const widget = Object.create(m.CadViewportWidget.prototype);
    widget.backendService = backend;
    widget.preferences = makePreferences(sizeCapMB);
    widget.partialJobCounter = 0;
    widget.pendingPartialJobId = undefined;
    return widget;
}

/**
 * Widget instance with only the collaborators the import dialog flow needs.
 * `update` is stubbed because the lumino widget is never mounted here.
 */
function makeImportWidget(
    m: WidgetModule,
    options: { document?: unknown; uri?: string; open?: URI; save?: URI }
): {
    widget: any;
    addInstance: ReturnType<typeof vi.fn>;
    showSaveDialog: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
    fileService: {
        exists: ReturnType<typeof vi.fn>;
        createFolder: ReturnType<typeof vi.fn>;
        copy: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
    };
} {
    const addInstance = vi.fn().mockReturnValue({ success: true, value: 'instance-1' });
    const widget = Object.create(m.CadViewportWidget.prototype);
    widget.update = vi.fn();
    widget.templatePickerOpen = true;
    widget.fileDialogService = {
        showOpenDialog: vi.fn().mockResolvedValue(options.open),
        showSaveDialog: vi.fn().mockResolvedValue(options.save)
    };
    const downloadFile = vi.fn().mockResolvedValue({ success: true, path: '', bytes: 0 });
    widget.backendService = { downloadFile };
    const fileService = {
        exists: vi.fn().mockResolvedValue(false),
        createFolder: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined)
    };
    widget.fileService = fileService;
    widget.workspaceService = { ready: Promise.resolve() };
    widget.documentStore = {
        document: options.document,
        uri: options.uri,
        addInstance,
        createDocument: vi.fn().mockReturnValue({ success: true }),
        setDisplayTolerance: vi.fn().mockReturnValue({ success: true }),
        setUri: vi.fn(),
        setGrounded: vi.fn().mockReturnValue({ success: true })
    };
    widget.messageService = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    return { widget, addInstance, showSaveDialog: widget.fileDialogService.showSaveDialog, downloadFile, fileService };
}

describe('CadViewportWidget partial size-cap threading', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    it('sends the size-cap pref on every partial call alongside the cache dir', async () => {
        // Open-restore, edit rebuilds, and the manual Rebuild button all funnel
        // through buildPartialWithFallback, so one assertion covers all three.
        const captured: Captured = { partial: [], document: [] };
        const widget = makeWidget(widgetModule, makeBackend(captured, true), 512);
        await widget.buildPartialWithFallback('/a/b/model.nuke-cad', ['f1', 'f2']);
        expect(captured.partial).toHaveLength(1);
        expect(captured.partial[0].sizeCapMB).toBe(512);
        expect(captured.partial[0].cacheDir).toBe('/a/b');
        expect(captured.partial[0].featureIds).toEqual(['f1', 'f2']);
        expect(captured.document).toHaveLength(0);
    });

    it('threads the configured pref value rather than a constant', async () => {
        const captured: Captured = { partial: [], document: [] };
        const widget = makeWidget(widgetModule, makeBackend(captured, true), 2048);
        await widget.buildPartialWithFallback('/a/b/model.nuke-cad', []);
        expect(captured.partial).toHaveLength(1);
        expect(captured.partial[0].sizeCapMB).toBe(2048);
    });

    it('still falls back to a full build when partial is unimplemented', async () => {
        const captured: Captured = { partial: [], document: [] };
        const widget = makeWidget(widgetModule, makeBackend(captured, false), 512);
        await widget.buildPartialWithFallback('/a/b/model.nuke-cad', ['f1']);
        expect(captured.partial).toHaveLength(0);
        expect(captured.document).toHaveLength(1);
    });
});

function stubImportCompletion(widget: any): void {
    widget.saveDocument = vi.fn().mockResolvedValue(undefined);
    widget.rebuildDocument = vi.fn().mockResolvedValue(undefined);
    widget.clearSaveRebuildTimer = vi.fn();
    widget.rebuildTracker = { reset: vi.fn() };
}

describe('CadViewportWidget one-click CAD import', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    it('closes the template picker and leaves the document untouched when the file dialog is cancelled', async () => {
        const { widget, addInstance, showSaveDialog } = makeImportWidget(widgetModule, { open: undefined });
        await widget.importCadAsAssembly();
        expect(widget.templatePickerOpen).toBe(false);
        expect(addInstance).not.toHaveBeenCalled();
        expect(showSaveDialog).not.toHaveBeenCalled();
    });

    it('leaves the document untouched when the save prompt is cancelled after a file choice', async () => {
        const { widget, addInstance, showSaveDialog } = makeImportWidget(widgetModule, {
            document: { name: 'Untitled' },
            open: new URI('file:///work/project/model.step'),
            save: undefined
        });
        await widget.importCadAsAssembly();
        expect(addInstance).not.toHaveBeenCalled();
        expect(showSaveDialog).toHaveBeenCalledTimes(1);
        expect(widget.documentStore.uri).toBeUndefined();
    });

    it('adds a document-relative instance, saves, and rebuilds', async () => {
        const { widget, addInstance } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/project/parts/model.step')
        });
        widget.saveDocument = vi.fn().mockResolvedValue(undefined);
        widget.rebuildDocument = vi.fn().mockResolvedValue(undefined);
        widget.clearSaveRebuildTimer = vi.fn();
        widget.rebuildTracker = { reset: vi.fn() };

        await widget.importCadAsAssembly();

        expect(addInstance).toHaveBeenCalledWith('./parts/model.step');
        expect(widget.documentStore.setUri).toHaveBeenCalledWith('file:///work/project/assembly.nuke-cad');
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledTimes(1);
        expect(widget.rebuildTracker.reset).toHaveBeenCalledTimes(1);
    });

    it('keeps the existing absolute reference for a normal import', async () => {
        const { widget, addInstance, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/shared/model.step')
        });
        stubImportCompletion(widget);

        await widget.importCadAsAssembly();

        expect(fileService.copy).not.toHaveBeenCalled();
        expect(addInstance).toHaveBeenCalledWith('/work/shared/model.step');
    });

    it('copies an outside source into <document>.parts and references it relatively', async () => {
        const { widget, addInstance, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', features: [], curves: [] },
            uri: 'file:///work/project/w7x.nuke-cad',
            open: new URI('file:///work/shared/scaled_w7x_stellarator.step')
        });
        stubImportCompletion(widget);

        await widget.importCadAsAssembly({ copySource: true });

        expect(fileService.createFolder.mock.calls[0][0].toString()).toBe('file:///work/project/w7x.parts');
        const [source, target, copyOptions] = fileService.copy.mock.calls[0];
        expect(source.toString()).toBe('file:///work/shared/scaled_w7x_stellarator.step');
        expect(target.toString()).toBe('file:///work/project/w7x.parts/scaled_w7x_stellarator.step');
        expect(copyOptions).toEqual({ overwrite: true });
        expect(addInstance).toHaveBeenCalledWith('./w7x.parts/scaled_w7x_stellarator.step');
    });

    it('does not copy a source already inside the document folder', async () => {
        const { widget, addInstance, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/project/parts/model.step')
        });
        stubImportCompletion(widget);

        await widget.importCadAsAssembly({ copySource: true });

        expect(fileService.exists).not.toHaveBeenCalled();
        expect(fileService.copy).not.toHaveBeenCalled();
        expect(addInstance).toHaveBeenCalledWith('./parts/model.step');
    });

    it('aborts without touching the document when copying the source fails', async () => {
        const { widget, addInstance, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', features: [], curves: [] },
            uri: 'file:///work/project/w7x.nuke-cad',
            open: new URI('file:///work/shared/scaled_w7x_stellarator.step')
        });
        stubImportCompletion(widget);
        fileService.copy.mockRejectedValue(new Error('disk full'));

        await widget.importCadAsAssembly({ copySource: true });

        expect(addInstance).not.toHaveBeenCalled();
        expect(widget.documentStore.setUri).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to copy'));
    });

    it('downloads the W7-X source through the backend and imports it', async () => {
        const { widget, addInstance, downloadFile, showSaveDialog } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', features: [], curves: [] },
            save: new URI('file:///work/project/w7x.nuke-cad')
        });
        stubImportCompletion(widget);
        widget.setLoading = vi.fn();

        await widget.handleDownloadSample('w7x-full');

        expect(showSaveDialog).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Save W7-X Project', inputValue: 'w7x-stellarator.nuke-cad' })
        );
        expect(downloadFile).toHaveBeenCalledWith({
            url: expect.stringContaining('proximafusion/open_stellarator_models'),
            targetPath: '/work/project/w7x.parts/scaled_w7x_stellarator.step',
            timeoutSeconds: 300
        });
        expect(addInstance).toHaveBeenCalledWith('./w7x.parts/scaled_w7x_stellarator.step');
        expect(widget.documentStore.setDisplayTolerance).toHaveBeenCalledWith(0.1);
        expect(widget.setLoading).toHaveBeenNthCalledWith(1, true, expect.stringContaining('Downloading'));
        expect(widget.setLoading).toHaveBeenLastCalledWith(false);
    });

    it('removes a stale region manifest when creating a W7-X sample', async () => {
        const { widget, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', features: [], curves: [] },
            save: new URI('file:///work/project/w7x.nuke-cad')
        });
        stubImportCompletion(widget);
        widget.setLoading = vi.fn();
        fileService.exists.mockResolvedValue(true);

        await widget.handleDownloadSample('w7x-full');

        expect(fileService.delete.mock.calls[0][0].toString()).toBe('file:///work/project/w7x.regions.json');
        expect(fileService.delete.mock.calls[0][1]).toEqual({ useTrash: true });
        expect(widget.messageService.warn).toHaveBeenCalledWith(expect.stringContaining('Removed stale region manifest'));
    });

    it('does not create a document when the W7-X download fails', async () => {
        const { widget, addInstance, downloadFile } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', features: [], curves: [] },
            save: new URI('file:///work/project/w7x.nuke-cad')
        });
        stubImportCompletion(widget);
        widget.setLoading = vi.fn();
        downloadFile.mockResolvedValue({ success: false, error: 'NetworkError when attempting to fetch resource.' });

        await widget.handleDownloadSample('w7x-full');

        expect(addInstance).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to download'));
        expect(widget.setLoading).toHaveBeenLastCalledWith(false);
    });
});
