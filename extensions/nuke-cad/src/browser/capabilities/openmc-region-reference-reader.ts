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
 * Read-only file reader for OpenMC DAGMC region references.
 *
 * The caller passes the active `.nuke-openmc` path from the authoring context;
 * this module only stats and reads that one file. It never reads the referenced
 * `.h5m` model and never writes anything.
 *
 * @module nuke-cad/browser/capabilities
 */

import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { parseOpenmcRegionReferences } from '../../common/openmc-region-references';
import type { OpenmcReferenceSnapshot } from '../../common/openmc-region-references';

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function unavailableSnapshot(
    status: 'no-saved-project' | 'missing-project-file' | 'unreadable-project',
    projectPath: string | undefined,
    warning: string
): OpenmcReferenceSnapshot {
    return {
        status,
        ...(projectPath !== undefined ? { projectPath } : {}),
        dagmcGroups: [],
        materialNames: [],
        materialIds: [],
        warnings: [warning]
    };
}

/**
 * Read the active OpenMC project and extract DAGMC/material references.
 *
 * @param fileService - File service used to stat and read the project file.
 * @param projectPath - Path of the active `.nuke-openmc` project, when saved.
 * @returns The reference snapshot; failures degrade to a status plus warning.
 */
export async function readOpenmcRegionReferences(
    fileService: Pick<FileService, 'exists' | 'readFile'>,
    projectPath: string | undefined
): Promise<OpenmcReferenceSnapshot> {
    if (!projectPath) {
        return unavailableSnapshot('no-saved-project', undefined, 'No saved OpenMC project is open; DAGMC references cannot be checked.');
    }

    const uri = new URI(projectPath);
    let exists: boolean;
    try {
        exists = await fileService.exists(uri);
    } catch (error) {
        return unavailableSnapshot(
            'unreadable-project',
            projectPath,
            `OpenMC project '${projectPath}' could not be inspected: ${errorText(error)}`
        );
    }
    if (!exists) {
        return unavailableSnapshot('missing-project-file', projectPath, `OpenMC project '${projectPath}' does not exist.`);
    }

    try {
        const content = await fileService.readFile(uri);
        return parseOpenmcRegionReferences(projectPath, content.value.toString());
    } catch (error) {
        return unavailableSnapshot(
            'unreadable-project',
            projectPath,
            `OpenMC project '${projectPath}' could not be read: ${errorText(error)}`
        );
    }
}
