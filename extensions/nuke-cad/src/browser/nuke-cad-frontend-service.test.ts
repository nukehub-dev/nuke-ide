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

import { describe, it, expect } from 'vitest';
import { NukeCadFrontendService } from './nuke-cad-frontend-service';
import type {
    NukeCadBackendService,
    GeometryBuildResult,
    GeometryBuildRequest,
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    InspectImportSourceRequest
} from '../common/nuke-cad-protocol';
import type { NukeCadPreferences } from './nuke-cad-preferences';

const MODEL_PATH = '/tmp/model.nuke-cad';
const STEP_PATH = '/tmp/model.step';
const SCRIPT_PATH = '/tmp/model.py';

type CapturedRequest = GeometryBuildRequest | BuildDocumentRequest | BuildFeaturesPartialRequest;

function makeProxy(capture: { requests: CapturedRequest[] }): NukeCadBackendService {
    const result: GeometryBuildResult = {
        success: true,
        scriptPath: MODEL_PATH,
        triangleCount: 100,
        boundingBox: { min: [0, 0, 0], max: [10, 10, 10] }
    };
    return {
        buildGeometry: async (request: GeometryBuildRequest) => {
            capture.requests.push(request);
            return { ...result, scriptPath: request.scriptPath };
        },
        buildDocument: async (request: BuildDocumentRequest) => {
            capture.requests.push(request);
            return { ...result, scriptPath: request.scriptPath };
        },
        buildFeaturesPartial: async (request: BuildFeaturesPartialRequest) => {
            capture.requests.push(request);
            return { ...result, scriptPath: request.scriptPath };
        },
        buildDrawing: async () => ({ success: false, error: 'not stubbed' }),
        inspectImportSource: async (request: InspectImportSourceRequest) => ({
            success: true,
            sourcePath: request.sourcePath,
            solidCount: 0,
            solids: []
        }),
        runFem: async () => ({ success: true }),
        listFemMaterials: async () => [],
        runJob: async () => ({ success: true, artifacts: [] }),
        cancelJob: async () => false,
        buildFoamCase: async () => ({ success: true, caseDir: '', solver: 'icoFoam', files: [] }),
        exportFoamStl: async () => ({ success: true, outputDir: '', stlFiles: [] }),
        listFoamSolvers: async () => [],
        downloadFile: async () => ({ success: false, error: 'not stubbed' }),
        checkCadEnvironment: async () => ({ ready: true, missing: [], missingOptional: [] })
    };
}

function makePreferences(values?: Partial<Record<string, number>>): NukeCadPreferences {
    const defaults: Record<string, number> = {
        'nukeCad.facetingTolerance': 0.001,
        'nukeCad.displayFacetingTolerance': 0.01,
        'nukeCad.maxDisplayTriangles': 2_000_000
    };
    return {
        get: <T>(key: string, defaultValue: T) => ((values?.[key] ?? defaults[key]) as unknown as T) ?? defaultValue
    } as NukeCadPreferences;
}

describe('NukeCadFrontendService', () => {
    it('uses display tolerance for document builds', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(capture.requests).toHaveLength(1);
        expect(capture.requests[0].tolerance).toBe(0.01);
    });

    it('uses display tolerance for STEP imports', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildGeometry({ scriptPath: STEP_PATH, exportDagmc: false, exportMesh: false });
        expect(capture.requests[0].tolerance).toBe(0.01);
    });

    it('uses export tolerance for script builds', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildGeometry({ scriptPath: SCRIPT_PATH });
        expect(capture.requests[0].tolerance).toBe(0.001);
    });

    it('uses export tolerance when DAGMC export is explicitly requested', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildDocument({ scriptPath: MODEL_PATH, exportDagmc: true });
        expect(capture.requests[0].tolerance).toBe(0.001);
    });

    it('uses explicit per-request tolerance when provided', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildDocument({ scriptPath: MODEL_PATH, tolerance: 0.123 });
        expect(capture.requests[0].tolerance).toBe(0.123);
    });

    it('adapts display tolerance from previous bounding box', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        // First build: no previous box, uses display tolerance.
        await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(capture.requests[0].tolerance).toBe(0.01);

        // Second build: previous box diagonal is sqrt(10^2*3) ~ 17.32.
        // Heuristic = (17.32 / sqrt(2_000_000)) * 0.5 ~ 0.0061, which is
        // smaller than 0.01, so display tolerance wins.
        await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(capture.requests[1].tolerance).toBe(0.01);
    });

    it('coarsens display tolerance for large bounding boxes', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const proxy = makeProxy(capture);
        proxy.buildDocument = async (request: BuildDocumentRequest) => {
            capture.requests.push(request);
            return {
                success: true,
                scriptPath: request.scriptPath,
                triangleCount: 100,
                boundingBox: { min: [0, 0, 0], max: [10_000, 10_000, 10_000] }
            };
        };
        const service = new NukeCadFrontendService(proxy, makePreferences());

        await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(capture.requests[0].tolerance).toBe(0.01);

        // Diagonal is sqrt(3)*10_000 ~ 17320.5.
        // Heuristic = (17320.5 / sqrt(2_000_000)) * 0.5 ~ 6.12.
        // This is coarser than 0.01, so it wins.
        await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(capture.requests[1].tolerance).toBeGreaterThan(0.01);
    });

    it('adds a warning when display triangle count exceeds budget', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const proxy = makeProxy(capture);
        proxy.buildDocument = async (request: BuildDocumentRequest) => {
            capture.requests.push(request);
            return {
                success: true,
                scriptPath: request.scriptPath,
                triangleCount: 5_000_000,
                boundingBox: { min: [0, 0, 0], max: [10, 10, 10] }
            };
        };
        const service = new NukeCadFrontendService(proxy, makePreferences({ 'nukeCad.maxDisplayTriangles': 2_000_000 }));
        const result = await service.buildDocument({ scriptPath: MODEL_PATH });
        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBe(1);
        expect(result.warnings![0]).toContain('5,000,000');
        expect(result.warnings![0]).toContain('2,000,000');
    });

    it('forwards partial rebuilds with the resolved document tolerance', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const service = new NukeCadFrontendService(makeProxy(capture), makePreferences());
        await service.buildFeaturesPartial({ scriptPath: MODEL_PATH, featureIds: ['f1', 'f2'], cacheDir: '/tmp/out' });
        expect(capture.requests).toHaveLength(1);
        const request = capture.requests[0] as BuildFeaturesPartialRequest;
        expect(request.featureIds).toEqual(['f1', 'f2']);
        expect(request.cacheDir).toBe('/tmp/out');
        expect(request.tolerance).toBe(0.01);
    });

    it('post-processes partial rebuild results like document builds', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const proxy = makeProxy(capture);
        proxy.buildFeaturesPartial = async (request: BuildFeaturesPartialRequest) => {
            capture.requests.push(request);
            return {
                success: true,
                scriptPath: request.scriptPath,
                triangleCount: 5_000_000,
                boundingBox: { min: [0, 0, 0], max: [10, 10, 10] }
            };
        };
        const service = new NukeCadFrontendService(proxy, makePreferences({ 'nukeCad.maxDisplayTriangles': 2_000_000 }));
        const result = await service.buildFeaturesPartial({ scriptPath: MODEL_PATH, featureIds: ['f1'] });
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain('5,000,000');
        expect(result.warnings![0]).toContain('2,000,000');
    });

    it('does not warn for export builds regardless of triangle count', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const proxy = makeProxy(capture);
        proxy.buildGeometry = async (request: GeometryBuildRequest) => {
            capture.requests.push(request);
            return {
                success: true,
                scriptPath: request.scriptPath,
                triangleCount: 5_000_000,
                boundingBox: { min: [0, 0, 0], max: [10, 10, 10] }
            };
        };
        const service = new NukeCadFrontendService(proxy, makePreferences());
        const result = await service.buildGeometry({ scriptPath: SCRIPT_PATH });
        expect(result.warnings).toBeUndefined();
    });

    it('delegates import inspection without injecting build options', async () => {
        const capture: { requests: CapturedRequest[] } = { requests: [] };
        const proxy = makeProxy(capture);
        const seen: InspectImportSourceRequest[] = [];
        proxy.inspectImportSource = async (request: InspectImportSourceRequest) => {
            seen.push(request);
            return { success: true, sourcePath: request.sourcePath, solidCount: 2, solids: [] };
        };
        const service = new NukeCadFrontendService(proxy, makePreferences());
        const request: InspectImportSourceRequest = { sourcePath: STEP_PATH, sourceUnit: 'm', targetUnits: 'mm', maxSolids: 10 };
        const result = await service.inspectImportSource(request);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(request);
        expect(result).toEqual({ success: true, sourcePath: STEP_PATH, solidCount: 2, solids: [] });
        expect(capture.requests).toHaveLength(0);
    });
});
