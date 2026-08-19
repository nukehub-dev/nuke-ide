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
    FoamStlExportResult
} from '../common/nuke-cad-protocol';
import { NukeCadPreferences } from './nuke-cad-preferences';

@injectable()
export class NukeCadFrontendService implements NukeCadBackendService {
    constructor(
        private readonly proxy: NukeCadBackendService,
        private readonly preferences: NukeCadPreferences
    ) {}

    buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult> {
        // Fall back to the user preference when the caller did not pick a
        // tolerance explicitly; the preference is read per build so changes
        // apply to subsequent builds (no live-rebuild). The backend forwards
        // it to geometry_service.py's --tolerance, which also feeds the DAGMC
        // export faceting.
        const tolerance = request.tolerance ?? this.preferences.get('nukeCad.facetingTolerance', 0.001);
        return this.proxy.buildGeometry({ ...request, tolerance });
    }

    buildDocument(request: BuildDocumentRequest): Promise<GeometryBuildResult> {
        // Apply the same faceting-tolerance preference fallback as script builds.
        const tolerance = request.tolerance ?? this.preferences.get('nukeCad.facetingTolerance', 0.001);
        return this.proxy.buildDocument({ ...request, tolerance });
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
}
