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

import { describe, it, expect, beforeAll, vi } from 'vitest';
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
vi.mock('@theia/core/lib/browser/theming', () => ({ ThemeService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: class {} }));
vi.mock('@theia/monaco/lib/browser/monaco-workspace', () => ({ MonacoWorkspace: class {} }));
vi.mock('@theia/monaco/lib/browser/monaco-editor-model', () => ({ MonacoEditorModel: class {} }));

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
