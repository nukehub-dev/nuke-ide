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

/**
 * Frontend proxy for the nuke-cad backend service.
 *
 * @module nuke-cad/browser
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    NukeCadBackendService,
    GeometryBuildRequest,
    GeometryBuildResult,
    BuildDocumentRequest,
    FemRunRequest,
    FemRunResult,
    FemMaterial,
    JobRunRequest,
    JobRunResult,
    FoamCaseRequest,
    FoamCaseResult,
    FoamStlExportRequest,
    FoamStlExportResult,
    CadBoundingBox
} from '../common/nuke-cad-protocol';
import { NukeCadPreferences } from './nuke-cad-preferences';
import { computeDisplayTolerance, isDisplayBuild, withTriangleBudgetWarning } from './nuke-cad-display-utils';

@injectable()
export class NukeCadFrontendService implements NukeCadBackendService {
    /** Cache of the last successful bounding box per source path for iterative tolerance adaptation. */
    private readonly lastBoundingBox = new Map<string, CadBoundingBox>();

    constructor(
        private readonly proxy: NukeCadBackendService,
        private readonly preferences: NukeCadPreferences
    ) {}

    buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult> {
        const sourceType = this.resolveSourceType(request);
        const tolerance = this.resolveTolerance(request, sourceType);
        return this.proxy.buildGeometry({ ...request, tolerance }).then((result) => this.postProcessResult(request, result, sourceType));
    }

    buildDocument(request: BuildDocumentRequest): Promise<GeometryBuildResult> {
        const tolerance = this.resolveTolerance(request, 'document');
        return this.proxy.buildDocument({ ...request, tolerance }).then((result) => this.postProcessResult(request, result, 'document'));
    }

    runFem(request: FemRunRequest): Promise<FemRunResult> {
        return this.proxy.runFem(request);
    }

    listFemMaterials(): Promise<FemMaterial[]> {
        return this.proxy.listFemMaterials();
    }

    runJob(request: JobRunRequest): Promise<JobRunResult> {
        return this.proxy.runJob(request);
    }

    cancelJob(jobId: string): Promise<boolean> {
        return this.proxy.cancelJob(jobId);
    }

    buildFoamCase(request: FoamCaseRequest): Promise<FoamCaseResult> {
        return this.proxy.buildFoamCase(request);
    }

    exportFoamStl(request: FoamStlExportRequest): Promise<FoamStlExportResult> {
        return this.proxy.exportFoamStl(request);
    }

    listFoamSolvers(): Promise<string[]> {
        return this.proxy.listFoamSolvers();
    }

    checkCadEnvironment(): Promise<{ ready: boolean; missing: string[]; missingOptional: string[] }> {
        return this.proxy.checkCadEnvironment();
    }

    /**
     * Resolve the source type for a ``buildGeometry`` request from its path or
     * explicit ``sourceType`` field.
     */
    private resolveSourceType(request: GeometryBuildRequest): 'script' | 'step' {
        const ext = request.scriptPath.split('.').pop()?.toLowerCase();
        return request.sourceType ?? (ext === 'step' || ext === 'stp' || ext === 'brep' ? 'step' : 'script');
    }

    /**
     * Pick the faceting tolerance for a build request.
     *
     * Export builds (script builds and any request with ``exportDagmc`` or
     * ``exportMesh`` set to ``true``) use ``nukeCad.facetingTolerance``.
     * Display-only builds use ``nukeCad.displayFacetingTolerance``, optionally
     * adapted by the previous build's bounding box to keep triangle count near
     * ``nukeCad.maxDisplayTriangles``.
     */
    private resolveTolerance(request: GeometryBuildRequest | BuildDocumentRequest, sourceType: 'script' | 'step' | 'document'): number {
        if (request.tolerance !== undefined) {
            return request.tolerance;
        }
        if (isDisplayBuild(request, sourceType)) {
            const displayTolerance = this.preferences.get('nukeCad.displayFacetingTolerance', 0.01);
            const maxTriangles = this.preferences.get('nukeCad.maxDisplayTriangles', 2_000_000);
            const previousBox = this.lastBoundingBox.get(request.scriptPath);
            return computeDisplayTolerance(displayTolerance, maxTriangles, previousBox);
        }
        return this.preferences.get('nukeCad.facetingTolerance', 0.001);
    }

    /**
     * Cache the bounding box of successful builds and attach display-only warnings.
     */
    private postProcessResult(
        request: GeometryBuildRequest | BuildDocumentRequest,
        result: GeometryBuildResult,
        sourceType: 'script' | 'step' | 'document'
    ): GeometryBuildResult {
        if (result.success && result.boundingBox) {
            this.lastBoundingBox.set(request.scriptPath, result.boundingBox);
        }
        if (isDisplayBuild(request, sourceType) && result.success) {
            const maxTriangles = this.preferences.get('nukeCad.maxDisplayTriangles', 2_000_000);
            return withTriangleBudgetWarning(result, maxTriangles);
        }
        return result;
    }
}
