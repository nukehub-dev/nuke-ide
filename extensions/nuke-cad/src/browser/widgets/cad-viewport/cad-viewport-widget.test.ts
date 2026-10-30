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
    ImportSolidInfo,
    InspectImportSourceResult,
    NukeCadBackendService
} from '../../../common/nuke-cad-protocol';
import type { NukeCadPreferences } from '../../nuke-cad-preferences';
import { W7X_BODY_LABELS, W7X_GEOMETRY_ASSET, W7X_GROUNDED_INSTANCE_ID } from '../../../common/w7x-generator';

// The widget module pulls Theia browser/monaco modules (CSS imports, DOM at
// import time) that the node test environment cannot load. Mock exactly those
// direct imports; every transitive local module is node-safe (proven by the
// existing pure-logic suites), so the real partial funnel still runs.
vi.mock('@theia/core/lib/browser/widgets/react-widget', () => ({ ReactWidget: class {} }));
vi.mock('@theia/core/lib/browser', () => ({ ApplicationShell: class {}, Message: class {}, WidgetManager: class {} }));
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
    options: { document?: unknown; uri?: string; open?: URI; save?: URI; inspection?: InspectImportSourceResult }
): {
    widget: any;
    addInstance: ReturnType<typeof vi.fn>;
    showSaveDialog: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
    inspectImportSource: ReturnType<typeof vi.fn>;
    addImportBodies: ReturnType<typeof vi.fn>;
    addAssemblyInstances: ReturnType<typeof vi.fn>;
    setUnits: ReturnType<typeof vi.fn>;
    setOverlapCheck: ReturnType<typeof vi.fn>;
    refreshImportSource: ReturnType<typeof vi.fn>;
    createDocument: ReturnType<typeof vi.fn>;
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
    const inspectImportSource = vi.fn().mockResolvedValue(options.inspection);
    widget.backendService = { downloadFile, inspectImportSource };
    widget.setLoading = vi.fn();
    const fileService = {
        exists: vi.fn().mockResolvedValue(false),
        createFolder: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined)
    };
    widget.fileService = fileService;
    widget.workspaceService = { ready: Promise.resolve() };
    const addImportBodies = vi.fn().mockReturnValue({
        success: true,
        value: { bodyIds: ['body-imported'], featureIds: ['feature-imported'] }
    });
    const refreshImportSource = vi.fn().mockReturnValue({ success: true, value: { featureIds: ['feature-imported'] } });
    const createDocument = vi.fn().mockReturnValue({ success: true });
    const setUnits = vi.fn().mockReturnValue({ success: true });
    const setOverlapCheck = vi.fn().mockReturnValue({ success: true });
    const addAssemblyInstances = vi.fn().mockImplementation((drafts: readonly { id?: string }[]) => ({
        success: true,
        value: drafts.map((draft, index) => draft.id ?? `instance-${index + 1}`)
    }));
    widget.documentStore = {
        document: options.document,
        uri: options.uri,
        addInstance,
        addImportBodies,
        addAssemblyInstances,
        refreshImportSource,
        createDocument,
        setUnits,
        setOverlapCheck,
        setDisplayTolerance: vi.fn().mockReturnValue({ success: true }),
        setDesignStudy: vi.fn().mockReturnValue({ success: true }),
        setUri: vi.fn(),
        setGrounded: vi.fn().mockReturnValue({ success: true })
    };
    widget.messageService = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    return {
        widget,
        addInstance,
        showSaveDialog: widget.fileDialogService.showSaveDialog,
        downloadFile,
        inspectImportSource,
        addImportBodies,
        addAssemblyInstances,
        setUnits,
        setOverlapCheck,
        refreshImportSource,
        createDocument,
        fileService
    };
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

function inspectionResult(overrides: Partial<InspectImportSourceResult> = {}): InspectImportSourceResult {
    return {
        success: true,
        sourcePath: '/work/project/assembly.parts/coil.step',
        sourceFormat: 'step',
        sourceHash: 'b'.repeat(64),
        sourceSize: 4096,
        fileUnit: 'mm',
        effectiveUnit: 'mm',
        unitsMessage: 'Source declares millimetres; scaled to document units.',
        solidCount: 2,
        solids: [
            {
                index: 1,
                name: 'Coil 1',
                faceCount: 12,
                volume: 100,
                bboxMin: [0, 0, 0],
                bboxMax: [1, 2, 3],
                center: [0.5, 1, 1.5]
            },
            {
                index: 2,
                name: 'Coil 2',
                faceCount: 14,
                volume: 200,
                bboxMin: [0, 0, 0],
                bboxMax: [2, 2, 3],
                center: [1, 1, 1.5]
            }
        ],
        ...overrides
    };
}

function w7xInspectionResult(overrides: Partial<InspectImportSourceResult> = {}): InspectImportSourceResult {
    const solids: ImportSolidInfo[] = [];
    // The real reference STEP reports the assembly root product name for every
    // solid (OCCT does not expose per-solid product names here); the generator
    // must validate geometry by index/face-count/volume, not by that name.
    const inheritedProductName = 'Simplified Stellarator based on reactor scaled W7X. Model made by Proxima Fusion';
    for (const shape of W7X_GEOMETRY_ASSET.coilShapes) {
        for (const transform of shape.transforms) {
            solids.push({
                index: transform.index,
                name: inheritedProductName,
                faceCount: shape.signature.faceCount,
                volume: shape.signature.volume,
                bboxMin: [0, 0, 0],
                bboxMax: [1, 1, 1],
                center: [0.5, 0.5, 0.5]
            });
        }
    }
    for (const shell of W7X_GEOMETRY_ASSET.shells) {
        solids.push({
            index: shell.index,
            name: inheritedProductName,
            faceCount: shell.signature.faceCount,
            volume: shell.signature.volume,
            bboxMin: [0, 0, 0],
            bboxMax: [1, 1, 1],
            center: [0.5, 0.5, 0.5]
        });
    }
    solids.sort((a, b) => a.index - b.index);
    return inspectionResult({
        sourcePath: '/work/project/w7x-generator.parts/scaled_w7x_stellarator.step',
        sourceHash: W7X_GEOMETRY_ASSET.source.sourceHash,
        sourceSize: W7X_GEOMETRY_ASSET.source.sourceSize,
        fileUnit: 'mm',
        effectiveUnit: 'm',
        solidCount: 55,
        solids,
        ...overrides
    });
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

describe('CadViewportWidget W7-X generator', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    const storeBodyIds = (): string[] => W7X_BODY_LABELS.map((label, index) => `generated-${index + 1}-${label}`);

    it('copies, validates, and commits the 15 bodies and 55 placed instances in one flow', async () => {
        const { widget, inspectImportSource, addImportBodies, addAssemblyInstances, setUnits, setOverlapCheck } = makeImportWidget(
            widgetModule,
            {
                document: { name: 'w7x', units: 'm', bodies: [], features: [], curves: [] },
                save: new URI('file:///work/project/w7x-generator.nuke-cad'),
                inspection: w7xInspectionResult()
            }
        );
        stubImportCompletion(widget);
        const ids = storeBodyIds();
        addImportBodies.mockReturnValue({
            success: true,
            value: { bodyIds: ids, featureIds: ids.map((id) => `feature-${id}`) }
        });

        await widget.completeW7xGenerator(
            new URI('file:///work/project/w7x-generator.nuke-cad'),
            new URI('file:///work/shared/scaled_w7x_stellarator.step')
        );

        expect(widget.fileService.createFolder.mock.calls[0][0].toString()).toBe('file:///work/project/w7x-generator.parts');
        expect(widget.fileService.copy.mock.calls[0][1].toString()).toBe(
            'file:///work/project/w7x-generator.parts/scaled_w7x_stellarator.step'
        );
        expect(inspectImportSource).toHaveBeenCalledWith({
            sourcePath: '/work/project/w7x-generator.parts/scaled_w7x_stellarator.step',
            sourceUnit: 'm',
            targetUnits: 'm',
            maxSolids: 100
        });

        expect(addImportBodies).toHaveBeenCalledTimes(1);
        const drafts = addImportBodies.mock.calls[0][0].bodies;
        expect(drafts).toHaveLength(15);
        expect(drafts.map((draft: { name: string }) => draft.name)).toEqual(W7X_BODY_LABELS);
        expect(drafts.map((draft: { label: string }) => draft.label)).toEqual(W7X_BODY_LABELS);
        expect(drafts[0].params).toMatchObject({
            sourcePath: './w7x-generator.parts/scaled_w7x_stellarator.step',
            sourceHash: W7X_GEOMETRY_ASSET.source.sourceHash,
            sourceSize: W7X_GEOMETRY_ASSET.source.sourceSize,
            sourceFormat: 'step',
            sourceUnit: 'm',
            maxSolids: 100,
            selection: {
                mode: 'solids',
                solids: [{ index: 1, signature: W7X_GEOMETRY_ASSET.coilShapes[0].signature }]
            }
        });
        expect(drafts[14].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 55, signature: W7X_GEOMETRY_ASSET.shells[4].signature }]
        });

        expect(widget.documentStore.createDocument).toHaveBeenCalledWith('w7x-generator');
        expect(setUnits).toHaveBeenCalledWith('m');
        expect(widget.documentStore.setDisplayTolerance).toHaveBeenCalledWith(0.1);
        expect(setOverlapCheck).toHaveBeenCalledWith(false);

        expect(addAssemblyInstances).toHaveBeenCalledTimes(1);
        const instances = addAssemblyInstances.mock.calls[0][0];
        expect(instances).toHaveLength(55);
        expect(addAssemblyInstances).toHaveBeenCalledWith(instances, W7X_GROUNDED_INSTANCE_ID);
        expect(instances.filter((instance: { id: string }) => instance.id.endsWith('_m4'))).toHaveLength(10);
        expect(instances.find((instance: { id: string }) => instance.id === 'coil_01_m0')?.part).toBe(`body:${ids[0]}`);
        expect(instances.find((instance: { id: string }) => instance.id === 'coil_01_m4')?.part).toBe(`body:${ids[0]}`);
        expect(instances.find((instance: { id: string }) => instance.id === 'coil_10_m4')?.part).toBe(`body:${ids[9]}`);
        expect(instances.find((instance: { id: string }) => instance.id === 'plasma')?.part).toBe(`body:${ids[10]}`);
        expect(instances.find((instance: { id: string }) => instance.id === 'vessel')?.part).toBe(`body:${ids[14]}`);
        const rotated = instances.find((instance: { id: string }) => instance.id === 'coil_01_m1');
        expect(rotated?.placement.position).toEqual([0, 0, 0]);
        expect(rotated?.placement.orientation[2]).toBeCloseTo(Math.sin(Math.PI / 5), 12);
        expect(rotated?.placement.orientation[3]).toBeCloseTo(Math.cos(Math.PI / 5), 12);

        expect(widget.documentStore.setUri).toHaveBeenCalledWith('file:///work/project/w7x-generator.nuke-cad');
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledWith(false, 'Building W7-X generator (55 instances)…');
        expect(widget.setLoading).toHaveBeenCalledWith(true, 'Building W7-X generator (55 instances)…');
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('15 imported bodies and 55 instances'));
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('50 coils'));
        expect(widget.messageService.error).not.toHaveBeenCalled();
    });

    it('fails before creating a document when the source inventory does not match', async () => {
        const mismatch = w7xInspectionResult();
        const broken = mismatch.solids?.find((solid) => solid.index === 7);
        expect(broken).toBeDefined();
        if (broken !== undefined) {
            (broken as { faceCount: number }).faceCount = 3;
        }
        const { widget, inspectImportSource, addImportBodies, addAssemblyInstances, setUnits, setOverlapCheck, createDocument } =
            makeImportWidget(widgetModule, {
                document: { name: 'w7x', units: 'm', bodies: [], features: [], curves: [] },
                save: new URI('file:///work/project/w7x-generator.nuke-cad'),
                inspection: mismatch
            });
        stubImportCompletion(widget);

        await widget.completeW7xGenerator(
            new URI('file:///work/project/w7x-generator.nuke-cad'),
            new URI('file:///work/shared/scaled_w7x_stellarator.step')
        );

        expect(inspectImportSource).toHaveBeenCalledTimes(1);
        expect(createDocument).not.toHaveBeenCalled();
        expect(setUnits).not.toHaveBeenCalled();
        expect(setOverlapCheck).not.toHaveBeenCalled();
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(addAssemblyInstances).not.toHaveBeenCalled();
        expect(widget.documentStore.setDisplayTolerance).not.toHaveBeenCalled();
        expect(widget.documentStore.setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(
            expect.stringMatching(/does not match the validated W7-X reference inventory/)
        );
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringMatching(/Source solid 7.*expected 4 faces, found 3/));
        expect(widget.setLoading).toHaveBeenLastCalledWith(false);
    });

    it('removes a stale region manifest before replacing a same-name document', async () => {
        const { widget, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', units: 'm', bodies: [], features: [], curves: [] },
            save: new URI('file:///work/project/w7x-generator.nuke-cad'),
            inspection: w7xInspectionResult()
        });
        stubImportCompletion(widget);
        fileService.exists.mockResolvedValue(true);

        await widget.completeW7xGenerator(
            new URI('file:///work/project/w7x-generator.nuke-cad'),
            new URI('file:///work/shared/scaled_w7x_stellarator.step')
        );

        expect(fileService.delete.mock.calls[0][0].toString()).toBe('file:///work/project/w7x-generator.regions.json');
        expect(fileService.delete.mock.calls[0][1]).toEqual({ useTrash: true });
        expect(widget.messageService.warn).toHaveBeenCalledWith(expect.stringContaining('Removed stale region manifest'));
    });

    it('routes the generator sample card into the import flow with its display tolerance', async () => {
        const { widget } = makeImportWidget(widgetModule, {});
        const importCadAsAssembly = vi.fn().mockResolvedValue(undefined);
        widget.importCadAsAssembly = importCadAsAssembly;

        await widget.handleCreateSample('w7x-generator');

        expect(widget.templatePickerOpen).toBe(false);
        expect(importCadAsAssembly).toHaveBeenCalledWith(
            expect.objectContaining({
                displayTolerance: 0.1,
                forceNewDocument: true,
                copySource: true,
                clearStaleRegionManifest: true,
                generator: 'w7x'
            })
        );

        importCadAsAssembly.mockClear();
        await widget.handleCreateSample('w7x-full');
        expect(importCadAsAssembly).toHaveBeenCalledTimes(1);
        expect(importCadAsAssembly.mock.calls[0][0]).not.toHaveProperty('generator');
    });

    it('routes the generator assembly flow through completeW7xGenerator', async () => {
        const { widget, addInstance, showSaveDialog } = makeImportWidget(widgetModule, {
            open: new URI('file:///work/shared/scaled_w7x_stellarator.step'),
            save: new URI('file:///work/project/w7x-generator.nuke-cad')
        });
        const complete = vi.fn().mockResolvedValue(undefined);
        widget.completeW7xGenerator = complete;

        await widget.importCadAsAssembly({ generator: 'w7x' });

        expect(showSaveDialog).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Save W7-X Generator', inputValue: 'w7x-generator.nuke-cad' })
        );
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({ path: expect.anything() }),
            expect.objectContaining({ path: expect.anything() }),
            expect.objectContaining({ generator: 'w7x' })
        );
        expect(addInstance).not.toHaveBeenCalled();
    });

    it('routes the generator download flow through completeW7xGenerator', async () => {
        const { widget, downloadFile, showSaveDialog } = makeImportWidget(widgetModule, {
            document: { name: 'w7x', units: 'm', bodies: [], features: [], curves: [] },
            save: new URI('file:///work/project/w7x-generator.nuke-cad')
        });
        const complete = vi.fn().mockResolvedValue(undefined);
        widget.completeW7xGenerator = complete;

        await widget.handleDownloadSample('w7x-generator');

        expect(showSaveDialog).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Save W7-X Generator', inputValue: 'w7x-generator.nuke-cad' })
        );
        expect(downloadFile).toHaveBeenCalledWith(
            expect.objectContaining({ targetPath: '/work/project/w7x-generator.parts/scaled_w7x_stellarator.step' })
        );
        expect(complete).toHaveBeenCalledWith(
            expect.objectContaining({ path: expect.anything() }),
            expect.objectContaining({ path: expect.anything() }),
            expect.objectContaining({ forceNewDocument: true, clearStaleRegionManifest: true })
        );
    });
});

describe('CadViewportWidget W7-X coil study', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    const storeBodyIds = (): string[] => W7X_BODY_LABELS.map((label, index) => `study-${index + 1}-${label}`);

    const createStudyWidget = (inspection: InspectImportSourceResult = w7xInspectionResult()): ReturnType<typeof makeImportWidget> => {
        const result = makeImportWidget(widgetModule, {
            document: { name: 'w7x', units: 'm', bodies: [], features: [], curves: [] },
            save: new URI('file:///work/project/w7x-coil-study.nuke-cad'),
            open: new URI('file:///work/shared/scaled_w7x_stellarator.step'),
            inspection
        });
        stubImportCompletion(result.widget);
        const ids = storeBodyIds();
        result.addImportBodies.mockReturnValue({
            success: true,
            value: { bodyIds: ids, featureIds: ids.map((id) => `feature-${id}`) }
        });
        return result;
    };

    it('copies, inspects, pins, and shows the 4/5/6-module report dialog before committing', async () => {
        const { widget, inspectImportSource, addImportBodies, fileService } = createStudyWidget();

        await widget.createW7xCoilStudy();

        expect(fileService.createFolder.mock.calls[0][0].toString()).toBe('file:///work/project/w7x-coil-study.parts');
        expect(fileService.copy.mock.calls[0][1].toString()).toBe('file:///work/project/w7x-coil-study.parts/scaled_w7x_stellarator.step');
        expect(inspectImportSource).toHaveBeenCalledWith({
            sourcePath: '/work/project/w7x-coil-study.parts/scaled_w7x_stellarator.step',
            sourceUnit: 'm',
            targetUnits: 'm',
            maxSolids: 100
        });
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(widget.w7xStudyDialog).toMatchObject({
            sourceLabel: 'scaled_w7x_stellarator.step',
            relativeSourcePath: './w7x-coil-study.parts/scaled_w7x_stellarator.step',
            sourceHash: W7X_GEOMETRY_ASSET.source.sourceHash,
            sourceSize: W7X_GEOMETRY_ASSET.source.sourceSize
        });
        expect(widget.w7xStudyDialog.reports[4].valid).toBe(false);
        expect(widget.w7xStudyDialog.reports[5].valid).toBe(true);
        expect(widget.w7xStudyDialog.reports[6].valid).toBe(false);
        expect(widget.messageService.error).not.toHaveBeenCalled();
    });

    it('commits a 4-module study with 15 bodies, 40 coils + 5 shells, and design-study metadata', async () => {
        const { widget, addImportBodies, addAssemblyInstances, setUnits, setOverlapCheck, createDocument } = createStudyWidget();

        await widget.createW7xCoilStudy();
        await widget.handleW7xStudyConfirm(4);

        expect(createDocument).toHaveBeenCalledWith('w7x-coil-study');
        expect(setUnits).toHaveBeenCalledWith('m');
        expect(widget.documentStore.setDisplayTolerance).toHaveBeenCalledWith(0.1);
        expect(setOverlapCheck).toHaveBeenCalledWith(false);

        const study = widget.documentStore.setDesignStudy.mock.calls[0][0];
        expect(study.kind).toBe('w7x-coil-study');
        expect(study.report.moduleCount).toBe(4);
        expect(study.report.valid).toBe(false);
        expect(study.report.uncoveredSectorDeg).toBeCloseTo(24.6598, 4);
        expect(study.report.coilShellOverlaps).toHaveLength(5);

        expect(addImportBodies).toHaveBeenCalledTimes(1);
        const drafts = addImportBodies.mock.calls[0][0].bodies;
        expect(drafts).toHaveLength(15);
        expect(drafts.map((draft: { name: string }) => draft.name)).toEqual(W7X_BODY_LABELS);
        expect(drafts[0].params).toMatchObject({
            sourcePath: './w7x-coil-study.parts/scaled_w7x_stellarator.step',
            sourceHash: W7X_GEOMETRY_ASSET.source.sourceHash,
            sourceSize: W7X_GEOMETRY_ASSET.source.sourceSize,
            sourceFormat: 'step',
            sourceUnit: 'm',
            maxSolids: 100
        });

        expect(addAssemblyInstances).toHaveBeenCalledTimes(1);
        const instances = addAssemblyInstances.mock.calls[0][0];
        expect(instances).toHaveLength(45);
        expect(addAssemblyInstances).toHaveBeenCalledWith(instances, W7X_GROUNDED_INSTANCE_ID);
        expect(instances.filter((instance: { id: string }) => instance.id.endsWith('_m3'))).toHaveLength(10);
        expect(instances.filter((instance: { id: string }) => instance.id.endsWith('_m4'))).toHaveLength(0);
        expect(instances.find((instance: { id: string }) => instance.id === 'coil_01_m1')?.placement.orientation[2]).toBeCloseTo(
            Math.sin(Math.PI / 4),
            12
        );

        expect(widget.documentStore.setUri).toHaveBeenCalledWith('file:///work/project/w7x-coil-study.nuke-cad');
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledWith(false, 'Building W7-X coil study (4 modules)…');
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('45 instances'));
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('40 coils + 5 shells'));
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('simulation export is disabled'));
        expect(widget.messageService.error).not.toHaveBeenCalled();
        expect(widget.w7xStudyDialog).toBeUndefined();
    });

    it('commits a 6-module study with 65 instances and the six-module report', async () => {
        const { widget, addAssemblyInstances } = createStudyWidget();

        await widget.createW7xCoilStudy();
        await widget.handleW7xStudyConfirm(6);

        const study = widget.documentStore.setDesignStudy.mock.calls[0][0];
        expect(study.report.moduleCount).toBe(6);
        expect(study.report.moduleOverlapDeg).toBeCloseTo(5.3402, 4);
        expect(study.report.coilCoilOverlaps).toHaveLength(3);

        const instances = addAssemblyInstances.mock.calls[0][0];
        expect(instances).toHaveLength(65);
        expect(addAssemblyInstances).toHaveBeenCalledWith(instances, W7X_GROUNDED_INSTANCE_ID);
        expect(instances.filter((instance: { id: string }) => instance.id.endsWith('_m5'))).toHaveLength(10);
        expect(widget.rebuildDocument).toHaveBeenCalledWith(false, 'Building W7-X coil study (6 modules)…');
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('60 coils + 5 shells'));
    });

    it('rejects a source with the right inventory but the wrong pinned hash without creating a document', async () => {
        const { widget, createDocument, addImportBodies, addAssemblyInstances, setUnits, setOverlapCheck } = createStudyWidget(
            w7xInspectionResult({ sourceHash: 'f'.repeat(64) })
        );

        await widget.createW7xCoilStudy();

        expect(widget.w7xStudyDialog).toBeUndefined();
        expect(createDocument).not.toHaveBeenCalled();
        expect(setUnits).not.toHaveBeenCalled();
        expect(setOverlapCheck).not.toHaveBeenCalled();
        expect(widget.documentStore.setDesignStudy).not.toHaveBeenCalled();
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(addAssemblyInstances).not.toHaveBeenCalled();
        expect(widget.documentStore.setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringMatching(/pinned reference STEP/));
        expect(widget.setLoading).toHaveBeenLastCalledWith(false);
    });

    it('leaves the document untouched when the selected-step inspection fails', async () => {
        const { widget, createDocument, addImportBodies, addAssemblyInstances } = createStudyWidget({
            success: false,
            error: 'not a STEP file'
        });

        await widget.createW7xCoilStudy();

        expect(widget.w7xStudyDialog).toBeUndefined();
        expect(createDocument).not.toHaveBeenCalled();
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(addAssemblyInstances).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith('not a STEP file');
    });
});

describe('CadViewportWidget W7-X coil shape study', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    function makeShapeWidget(options: { save?: URI; loadResult?: { success: boolean; error?: string } } = {}): {
        widget: any;
        showSaveDialog: ReturnType<typeof vi.fn>;
        loadDocument: ReturnType<typeof vi.fn>;
        setUri: ReturnType<typeof vi.fn>;
    } {
        const widget = Object.create(widgetModule.CadViewportWidget.prototype);
        widget.update = vi.fn();
        widget.templatePickerOpen = true;
        const showSaveDialog = vi.fn().mockResolvedValue(options.save);
        widget.fileDialogService = { showSaveDialog };
        widget.workspaceService = { ready: Promise.resolve() };
        widget.setLoading = vi.fn();
        const loadDocument = vi.fn().mockReturnValue(options.loadResult ?? { success: true });
        const setUri = vi.fn();
        widget.documentStore = {
            document: { name: 'current', units: 'm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/current.nuke-cad',
            loadDocument,
            setUri
        };
        widget.messageService = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
        widget.saveDocument = vi.fn().mockResolvedValue(undefined);
        widget.rebuildDocument = vi.fn().mockResolvedValue(undefined);
        widget.clearSaveRebuildTimer = vi.fn();
        widget.rebuildTracker = { reset: vi.fn() };
        return { widget, showSaveDialog, loadDocument, setUri };
    }

    it('asks for the destination first and opens the config dialog without touching the document', async () => {
        const { widget, showSaveDialog, loadDocument } = makeShapeWidget({
            save: new URI('file:///work/project/w7x-coil-shape-study.nuke-cad')
        });

        await widget.createW7xShapeStudy();

        expect(showSaveDialog).toHaveBeenCalledWith({
            title: 'Save W7-X Coil Shape Study',
            inputValue: 'w7x-coil-shape-study.nuke-cad',
            filters: { 'CAD Document': ['nuke-cad'] }
        });
        expect(widget.w7xShapeStudyDialog).toMatchObject({ targetUri: expect.anything() });
        expect(widget.w7xShapeStudyDialog.targetUri.toString()).toBe('file:///work/project/w7x-coil-shape-study.nuke-cad');
        expect(loadDocument).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('changes nothing when the destination dialog is cancelled', async () => {
        const { widget, loadDocument } = makeShapeWidget({ save: undefined });

        await widget.createW7xShapeStudy();

        expect(widget.w7xShapeStudyDialog).toBeUndefined();
        expect(loadDocument).not.toHaveBeenCalled();
        expect(widget.documentStore.setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('installs the planned document atomically, saves, and rebuilds once', async () => {
        const { widget, loadDocument, setUri } = makeShapeWidget({
            save: new URI('file:///work/project/w7x-coil-shape-study.nuke-cad')
        });
        const config = { width: 0.4, height: 0.3, tiltDeg: 10, twistDeg: 0, stations: 80 };

        await widget.createW7xShapeStudy();
        await widget.handleW7xShapeStudyConfirm(config);

        expect(loadDocument).toHaveBeenCalledTimes(1);
        const document = loadDocument.mock.calls[0][0];
        expect(document.name).toBe('w7x-coil-shape-study');
        expect(document.bodies).toHaveLength(10);
        expect(document.curves).toHaveLength(10);
        expect(document.features).toHaveLength(10);
        expect(document.features.every((feature: { type: string }) => feature.type === 'coilSweep')).toBe(true);
        expect(document.features[0].params).toMatchObject(config);
        expect(document.assembly.instances).toHaveLength(50);
        expect(document.designStudy.kind).toBe('w7x-coil-shape-study');
        expect(document.designStudy.report.bodyCount).toBe(10);
        expect(document.designStudy.report.coilCount).toBe(50);

        expect(setUri).toHaveBeenCalledWith('file:///work/project/w7x-coil-shape-study.nuke-cad');
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledWith(false, 'Building W7-X coil shape study (50 native coils)…');
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('10 native coil bodies'));
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('50 instances'));
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('simulation export is disabled'));
        expect(widget.messageService.error).not.toHaveBeenCalled();
        expect(widget.w7xShapeStudyDialog).toBeUndefined();
    });

    it('leaves the current document untouched when planning fails before load', async () => {
        const { widget, loadDocument, setUri } = makeShapeWidget({
            save: new URI('file:///work/project/w7x-coil-shape-study.nuke-cad')
        });

        await widget.createW7xShapeStudy();
        await widget.handleW7xShapeStudyConfirm({ width: 0, height: 0.3, tiltDeg: 10, twistDeg: 0, stations: 80 });

        expect(loadDocument).not.toHaveBeenCalled();
        expect(setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringMatching(/No document was created/));
        // The dialog survives a failed commit so the user can retry.
        expect(widget.w7xShapeStudyDialog).toBeDefined();
    });

    it('does not save or rebuild when loadDocument rejects the planned document', async () => {
        const { widget, loadDocument, setUri } = makeShapeWidget({
            save: new URI('file:///work/project/w7x-coil-shape-study.nuke-cad'),
            loadResult: { success: false, error: 'invalid document' }
        });

        await widget.createW7xShapeStudy();
        await widget.handleW7xShapeStudyConfirm({ width: 0.37, height: 0.37, tiltDeg: 8.6, twistDeg: 0, stations: 60 });

        expect(loadDocument).toHaveBeenCalledTimes(1);
        expect(setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringContaining('invalid document'));
    });

    it('routes the native sample card into the shape-study flow', async () => {
        const { widget } = makeShapeWidget({ save: undefined });
        const create = vi.fn().mockResolvedValue(undefined);
        widget.createW7xShapeStudy = create;

        await widget.handleCreateSample('w7x-coil-shape');

        expect(create).toHaveBeenCalledTimes(1);
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });
});

describe('CadViewportWidget viewport reopen restore', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    function makeRestoreWidget(model?: unknown): any {
        const widget = Object.create(widgetModule.CadViewportWidget.prototype);
        widget.tessData = undefined;
        widget.loading = false;
        widget.loadingMessage = '';
        widget.rebuildPromise = undefined;
        widget.tessLoadInFlight = false;
        widget.tessLoadToken = 0;
        widget.update = vi.fn();
        widget.messageService = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
        widget.stateManager = { model };
        widget.documentStore = {
            document: { name: 'shape', units: 'm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/shape.nuke-cad'
        };
        widget.rebuildDocument = vi.fn().mockResolvedValue(undefined);
        widget.setLoading = vi.fn();
        widget.loadTessellation = vi.fn().mockImplementation(async () => {
            widget.tessData = { solids: [] };
            widget.loading = false;
        });
        return widget;
    }

    it('restores the existing tessellation without a backend rebuild', async () => {
        const widget = makeRestoreWidget({
            scriptPath: 'file:///work/project/shape.nuke-cad',
            result: { tessPath: 'file:///work/project/shape.tess.json' }
        });

        await widget.restoreViewportModel();

        expect(widget.loadTessellation).toHaveBeenCalledWith('file:///work/project/shape.tess.json', 1);
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('falls back to a cached document rebuild when no model is available', async () => {
        const widget = makeRestoreWidget(undefined);

        await widget.restoreViewportModel();

        expect(widget.loadTessellation).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).toHaveBeenCalledWith(true);
        expect(widget.setLoading).toHaveBeenCalledWith(true, 'Restoring CAD viewport…');
        expect(widget.setLoading).toHaveBeenCalledWith(false);
    });

    it('does nothing when geometry is already on screen', async () => {
        const widget = makeRestoreWidget(undefined);
        widget.tessData = { solids: [] };

        await widget.restoreViewportModel();

        expect(widget.loadTessellation).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('skips the restore while the New Document picker is open', async () => {
        const widget = makeRestoreWidget({
            scriptPath: 'file:///work/project/shape.nuke-cad',
            result: { tessPath: 'file:///work/project/shape.tess.json' }
        });
        widget.templatePickerOpen = true;

        await widget.restoreViewportModel();

        expect(widget.loadTessellation).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('clears the previous model and invalidates late build results for a new document', () => {
        const widget = makeRestoreWidget({
            scriptPath: 'file:///work/project/shape.nuke-cad',
            result: { tessPath: 'file:///work/project/shape.tess.json' }
        });
        widget.tessData = { solids: [{ solidId: 1 }] };
        widget.loadedTessPath = 'file:///work/project/shape.tess.json';
        widget.stateManager.setModel = vi.fn();
        widget.stateManager.setSolidSummaries = vi.fn();
        widget.clearSaveRebuildTimer = vi.fn();
        widget.rebuildTracker = { reset: vi.fn() };
        widget.rebuildToken = 4;
        widget.viewportGeneration = 2;

        (widget as { clearViewportModel: () => void }).clearViewportModel();

        expect(widget.stateManager.setModel).toHaveBeenCalledWith(undefined);
        expect(widget.stateManager.setSolidSummaries).toHaveBeenCalledWith([]);
        expect(widget.tessData).toBeUndefined();
        expect(widget.loadedTessPath).toBeUndefined();
        expect(widget.rebuildToken).toBe(5);
        expect(widget.viewportGeneration).toBe(3);
        expect(widget.rebuildPromise).toBeUndefined();
        expect(widget.rebuildTracker.reset).toHaveBeenCalled();
    });
});

describe('CadViewportWidget import CAD as body', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    it('leaves everything untouched when the file picker is cancelled', async () => {
        const { widget, createDocument, addImportBodies, inspectImportSource, fileService } = makeImportWidget(widgetModule, {
            open: undefined
        });

        await widget.importCadAsBody();

        expect(widget.templatePickerOpen).toBe(false);
        expect(createDocument).not.toHaveBeenCalled();
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(inspectImportSource).not.toHaveBeenCalled();
        expect(fileService.copy).not.toHaveBeenCalled();
    });

    it('leaves the document untouched when the save prompt is cancelled', async () => {
        const { widget, createDocument, addImportBodies, inspectImportSource, fileService, showSaveDialog } = makeImportWidget(
            widgetModule,
            {
                open: new URI('file:///work/shared/coil.step'),
                save: undefined
            }
        );

        await widget.importCadAsBody();

        expect(showSaveDialog).toHaveBeenCalledTimes(1);
        expect(createDocument).not.toHaveBeenCalled();
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(inspectImportSource).not.toHaveBeenCalled();
        expect(fileService.copy).not.toHaveBeenCalled();
    });

    it('copies the source, inspects on the copied path, and commits the confirmed batch', async () => {
        const { widget, inspectImportSource, addImportBodies, fileService } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', units: 'mm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/shared/coil.step'),
            inspection: inspectionResult()
        });
        stubImportCompletion(widget);

        await widget.importCadAsBody();

        expect(fileService.createFolder.mock.calls[0][0].toString()).toBe('file:///work/project/assembly.parts');
        expect(fileService.copy.mock.calls[0][1].toString()).toBe('file:///work/project/assembly.parts/coil.step');
        expect(inspectImportSource).toHaveBeenCalledWith({
            sourcePath: '/work/project/assembly.parts/coil.step',
            maxSolids: 500,
            targetUnits: 'mm'
        });
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(widget.importBodyDialog).toMatchObject({
            sourceLabel: 'coil',
            relativeSourcePath: './assembly.parts/coil.step',
            createDocument: false
        });

        await widget.handleImportBodyConfirm({ strategy: 'single', label: 'coil', solidIndexes: [1, 2] });

        expect(inspectImportSource).toHaveBeenCalledTimes(1);
        expect(addImportBodies).toHaveBeenCalledTimes(1);
        expect(addImportBodies.mock.calls[0][0]).toEqual({
            bodies: [
                {
                    name: 'coil',
                    params: {
                        sourcePath: './assembly.parts/coil.step',
                        sourceHash: 'b'.repeat(64),
                        sourceSize: 4096,
                        sourceFormat: 'step',
                        maxSolids: 500,
                        selection: {
                            mode: 'solids',
                            solids: [
                                { index: 1, signature: { faceCount: 12, volume: 100 } },
                                { index: 2, signature: { faceCount: 14, volume: 200 } }
                            ]
                        }
                    }
                }
            ]
        });
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledTimes(1);
        expect(widget.importBodyDialog).toBeUndefined();
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('Imported 1 body'));
    });

    it('creates the document only after a confirmed unitless import and re-inspects a source-unit override', async () => {
        const initial = inspectionResult({
            sourcePath: '/work/project/scale.parts/scale.step',
            sourceHash: 'c'.repeat(64),
            sourceSize: 2048
        });
        const reinspected = inspectionResult({
            sourcePath: '/work/project/scale.parts/scale.step',
            sourceHash: 'd'.repeat(64),
            sourceSize: 2048,
            fileUnit: 'mm',
            effectiveUnit: 'm'
        });
        const { widget, inspectImportSource, addImportBodies, createDocument } = makeImportWidget(widgetModule, {
            open: new URI('file:///work/shared/scale.step'),
            save: new URI('file:///work/project/scale.nuke-cad'),
            inspection: initial
        });
        inspectImportSource.mockResolvedValueOnce(initial).mockResolvedValueOnce(reinspected);
        stubImportCompletion(widget);

        await widget.importCadAsBody();

        expect(createDocument).not.toHaveBeenCalled();
        expect(inspectImportSource).toHaveBeenCalledWith({
            sourcePath: '/work/project/scale.parts/scale.step',
            maxSolids: 500
        });
        expect(widget.importBodyDialog.documentUnits).toBeUndefined();

        await widget.handleImportBodyConfirm({
            strategy: 'perSolid',
            label: 'Shell',
            sourceUnit: 'm',
            solidIndexes: [1, 2]
        });

        expect(inspectImportSource).toHaveBeenLastCalledWith({
            sourcePath: '/work/project/scale.parts/scale.step',
            maxSolids: 500,
            sourceUnit: 'm'
        });
        expect(createDocument).toHaveBeenCalledTimes(1);
        expect(widget.documentStore.setUri).toHaveBeenCalledWith('file:///work/project/scale.nuke-cad');
        const drafts = addImportBodies.mock.calls[0][0].bodies;
        expect(drafts.map((draft: { name: string }) => draft.name)).toEqual(['Coil 1', 'Coil 2']);
        expect(drafts[0].params.sourceHash).toBe('d'.repeat(64));
        expect(drafts[0].params.sourceUnit).toBe('m');
        expect(drafts[0].params.sourcePath).toBe('./scale.parts/scale.step');
        expect(drafts[1].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 2, signature: { faceCount: 14, volume: 200 } }]
        });
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledTimes(1);
    });

    it('reports inspection failures without mutating the document', async () => {
        const { widget, addImportBodies, createDocument, inspectImportSource } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', units: 'mm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/shared/coil.step'),
            inspection: { success: false, error: 'not a STEP file' }
        });
        stubImportCompletion(widget);

        await widget.importCadAsBody();

        expect(inspectImportSource).toHaveBeenCalledTimes(1);
        expect(addImportBodies).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(widget.importBodyDialog).toBeUndefined();
        expect(widget.messageService.error).toHaveBeenCalledWith('not a STEP file');
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
    });

    it('keeps the dialog open when the confirmed selection is stale after re-inspection', async () => {
        const initial = inspectionResult();
        const reinspected = inspectionResult({ solids: [inspectionResult().solids![0]] });
        const { widget, inspectImportSource, addImportBodies } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', units: 'mm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/shared/coil.step'),
            inspection: initial
        });
        inspectImportSource.mockResolvedValueOnce(initial).mockResolvedValueOnce(reinspected);
        stubImportCompletion(widget);

        await widget.importCadAsBody();
        await widget.handleImportBodyConfirm({ strategy: 'single', label: 'coil', sourceUnit: 'cm', solidIndexes: [1, 2] });

        expect(addImportBodies).not.toHaveBeenCalled();
        expect(widget.importBodyDialog).toBeDefined();
        expect(widget.importBodyBusy).toBe(false);
        expect(widget.messageService.error).toHaveBeenCalledWith(expect.stringContaining('Source solid 2 is no longer present'));
    });

    it('leaves the document unchanged when the atomic store batch rejects the drafts', async () => {
        const { widget, addImportBodies } = makeImportWidget(widgetModule, {
            document: { name: 'assembly', units: 'mm', bodies: [], features: [], curves: [] },
            uri: 'file:///work/project/assembly.nuke-cad',
            open: new URI('file:///work/shared/coil.step'),
            inspection: inspectionResult()
        });
        addImportBodies.mockReturnValue({ success: false, error: 'rejected batch' });
        stubImportCompletion(widget);

        await widget.importCadAsBody();
        await widget.handleImportBodyConfirm({ strategy: 'single', label: 'coil', solidIndexes: [1] });

        expect(addImportBodies).toHaveBeenCalledTimes(1);
        expect(widget.documentStore.setUri).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.importBodyDialog).toBeDefined();
        expect(widget.messageService.error).toHaveBeenCalledWith('rejected batch');
    });
});

describe('CadViewportWidget refresh import sources', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    const importFeature = (id: string, sourcePath: string, sourceHash: string, sourceSize: number): unknown => ({
        id,
        name: id,
        type: 'import',
        body: 'body-1',
        params: { sourcePath, sourceHash, sourceSize, selection: { mode: 'all' } },
        suppressed: false,
        dependsOn: []
    });

    it('re-inspects every unique source and refreshes changed identities in one pass', async () => {
        const document = {
            name: 'w7x',
            units: 'm',
            bodies: [],
            features: [
                importFeature('f1', './w7x.parts/coil.step', '0'.repeat(64), 10),
                importFeature('f2', './w7x.parts/coil.step', '0'.repeat(64), 10),
                importFeature('f3', '/work/shared/shell.brep', '1'.repeat(64), 20)
            ],
            curves: []
        };
        const { widget, inspectImportSource, refreshImportSource } = makeImportWidget(widgetModule, {
            document,
            uri: 'file:///work/project/w7x.nuke-cad'
        });
        inspectImportSource.mockImplementation(async ({ sourcePath }: { sourcePath: string }) =>
            sourcePath.endsWith('coil.step')
                ? inspectionResult({ sourceHash: '2'.repeat(64), sourceSize: 11 })
                : inspectionResult({ sourceHash: '3'.repeat(64), sourceSize: 21 })
        );
        stubImportCompletion(widget);

        await widget.refreshImportSources();

        expect(inspectImportSource.mock.calls.map((call) => (call[0] as { sourcePath: string }).sourcePath)).toEqual([
            '/work/project/w7x.parts/coil.step',
            '/work/shared/shell.brep'
        ]);
        expect(refreshImportSource.mock.calls).toEqual([
            ['./w7x.parts/coil.step', '2'.repeat(64), 11],
            ['/work/shared/shell.brep', '3'.repeat(64), 21]
        ]);
        expect(widget.saveDocument).toHaveBeenCalledWith(false);
        expect(widget.rebuildDocument).toHaveBeenCalledTimes(1);
        expect(widget.messageService.info).toHaveBeenCalledWith(expect.stringContaining('Refreshed 2 import sources'));
    });

    it('does nothing when every source hash and size is current', async () => {
        const document = {
            name: 'w7x',
            units: 'm',
            bodies: [],
            features: [importFeature('f1', './w7x.parts/coil.step', '2'.repeat(64), 11)],
            curves: []
        };
        const { widget, inspectImportSource, refreshImportSource } = makeImportWidget(widgetModule, {
            document,
            uri: 'file:///work/project/w7x.nuke-cad'
        });
        inspectImportSource.mockResolvedValue(inspectionResult({ sourceHash: '2'.repeat(64), sourceSize: 11 }));
        stubImportCompletion(widget);

        await widget.refreshImportSources();

        expect(refreshImportSource).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.info).toHaveBeenCalledWith('Import sources are up to date.');
    });

    it('warns without mutating when a source cannot be inspected', async () => {
        const document = {
            name: 'w7x',
            units: 'm',
            bodies: [],
            features: [importFeature('f1', './w7x.parts/coil.step', '0'.repeat(64), 10)],
            curves: []
        };
        const { widget, inspectImportSource, refreshImportSource } = makeImportWidget(widgetModule, {
            document,
            uri: 'file:///work/project/w7x.nuke-cad'
        });
        inspectImportSource.mockResolvedValue({ success: false, error: 'missing file' });
        stubImportCompletion(widget);

        await widget.refreshImportSources();

        expect(refreshImportSource).not.toHaveBeenCalled();
        expect(widget.saveDocument).not.toHaveBeenCalled();
        expect(widget.rebuildDocument).not.toHaveBeenCalled();
        expect(widget.messageService.warn).toHaveBeenCalledWith(expect.stringContaining('missing file'));
    });
});

describe('CadViewportWidget document open arbitration', () => {
    let widgetModule: WidgetModule;

    beforeAll(async () => {
        widgetModule = await loadWidget();
    });

    it('ignores a slower open after a newer document has been installed', async () => {
        const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        };
        const readA = deferred<{ value: { toString(): string } }>();
        const readB = deferred<{ value: { toString(): string } }>();
        const documents: unknown[] = [];
        const widget = Object.create(widgetModule.CadViewportWidget.prototype);
        Object.assign(widget, {
            documentOpenGeneration: 0,
            viewportGeneration: 0,
            rebuildToken: 0,
            rebuildPending: false,
            rebuildPromise: undefined,
            pendingPartialJobId: undefined,
            loading: false,
            tessData: undefined,
            loadedTessPath: undefined,
            tessLoadInFlight: false,
            buildError: undefined,
            buildWarnings: [],
            buildStale: false,
            saveRebuildTimer: undefined,
            stateManager: { setModel: vi.fn(), setSolidSummaries: vi.fn() },
            rebuildTracker: { reset: vi.fn() },
            update: vi.fn(),
            setLoading: vi.fn(),
            resetSketchSavePromptState: vi.fn(),
            invalidateTessellation: vi.fn(),
            tryOpenFastPath: vi.fn().mockResolvedValue(false),
            rebuildDocument: vi.fn().mockResolvedValue(undefined),
            messageService: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
            fileService: {
                read: vi.fn((uri: URI) => (uri.toString().endsWith('/a.nuke-cad') ? readA.promise : readB.promise))
            },
            documentStore: {
                loadDocument: vi.fn((doc: unknown) => {
                    documents.push(doc);
                    return { success: true };
                }),
                setUri: vi.fn(),
                markSaved: vi.fn(),
                document: undefined,
                uri: undefined
            }
        });

        const openA = (widget as any).openDocumentModel(new URI('file:///tmp/a.nuke-cad'), '/tmp/a.nuke-cad');
        const openB = (widget as any).openDocumentModel(new URI('file:///tmp/b.nuke-cad'), '/tmp/b.nuke-cad');
        readB.resolve({ value: { toString: () => '{"name":"B"}' } });
        await openB;
        readA.resolve({ value: { toString: () => '{"name":"A"}' } });
        await openA;

        expect(documents).toEqual([{ name: 'B' }]);
        expect(widget.documentStore.setUri).toHaveBeenCalledTimes(1);
        expect(widget.rebuildDocument).toHaveBeenCalledTimes(1);
        expect(widget.setLoading).not.toHaveBeenLastCalledWith(true);
    });
});
