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

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { isSummaryFileName } from '../../../output-viewer/output-file-patterns';
import { OpenMCGeometryContribution } from './openmc-geometry-contribution';

/**
 * Routes OpenMC `summary.h5` (geometry/materials exchange file) to the
 * geometry hierarchy + 3D view. The backend converts the HDF5 to
 * geometry.xml/materials.xml on the fly (`convert_summary_to_xml`).
 */
@injectable()
export class OpenMCSummaryViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-summary-viewer';
    readonly label = 'OpenMC Summary (Geometry)';
    readonly priority = 100;

    @inject(OpenMCGeometryContribution)
    protected readonly geometry!: OpenMCGeometryContribution;

    canHandle(uri: URI): number {
        return isSummaryFileName(uri.path.base) ? 600 : 0;
    }

    async open(uri: URI): Promise<void> {
        await this.geometry.openGeometry3DForFile(uri);
    }
}
