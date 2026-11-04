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

import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { describe, expect, it, vi } from 'vitest';
import { readOpenmcRegionReferences } from './openmc-region-reference-reader';

const PROJECT_PATH = '/workspace/pincell.nuke-openmc';

const PROJECT_JSON = JSON.stringify({
    version: '1.2.0',
    state: {
        settings: {
            dagmcFile: 'geometry.h5m',
            dagmcInfo: {
                filePath: 'geometry.h5m',
                materials: { fuel: { volumeCount: 1, totalTriangles: 120 } },
                volumes: [{ id: 1, material: 'fuel', numTriangles: 120 }]
            }
        },
        materials: [{ id: 1, name: 'fuel', density: 10.4, densityUnit: 'g/cm3', nukeCadMaterialId: 'cad-material-fuel' }]
    }
});

interface FileServiceOptions {
    readonly exists?: boolean;
    readonly content?: string;
    readonly existsError?: Error;
    readonly readError?: Error;
}

function createFileService(options: FileServiceOptions = {}): {
    service: Pick<FileService, 'exists' | 'readFile'>;
    exists: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
} {
    const exists = vi.fn(async () => {
        if (options.existsError) {
            throw options.existsError;
        }
        return options.exists ?? true;
    });
    const readFile = vi.fn(async () => {
        if (options.readError) {
            throw options.readError;
        }
        return { value: { toString: () => options.content ?? '' } };
    });
    return {
        service: { exists, readFile } as unknown as Pick<FileService, 'exists' | 'readFile'>,
        exists,
        readFile
    };
}

describe('readOpenmcRegionReferences', () => {
    it('returns no-saved-project without touching the filesystem', async () => {
        const { service, exists, readFile } = createFileService();

        const snapshot = await readOpenmcRegionReferences(service, undefined);

        expect(snapshot.status).toBe('no-saved-project');
        expect(snapshot.projectPath).toBeUndefined();
        expect(snapshot.dagmcGroups).toEqual([]);
        expect(snapshot.materialNames).toEqual([]);
        expect(snapshot.materialIds).toEqual([]);
        expect(snapshot.warnings).toHaveLength(1);
        expect(exists).not.toHaveBeenCalled();
        expect(readFile).not.toHaveBeenCalled();
    });

    it('treats an empty project path as no saved project', async () => {
        const { service, exists, readFile } = createFileService();

        const snapshot = await readOpenmcRegionReferences(service, '');

        expect(snapshot.status).toBe('no-saved-project');
        expect(exists).not.toHaveBeenCalled();
        expect(readFile).not.toHaveBeenCalled();
    });

    it('reports a missing project file', async () => {
        const { service, exists, readFile } = createFileService({ exists: false });

        const snapshot = await readOpenmcRegionReferences(service, PROJECT_PATH);

        expect(snapshot.status).toBe('missing-project-file');
        expect(snapshot.projectPath).toBe(PROJECT_PATH);
        expect(snapshot.dagmcGroups).toEqual([]);
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.warnings[0]).toContain(PROJECT_PATH);
        expect(exists).toHaveBeenCalledTimes(1);
        expect(exists.mock.calls[0][0]).toBeInstanceOf(URI);
        expect((exists.mock.calls[0][0] as URI).path.toString()).toBe(PROJECT_PATH);
        expect(readFile).not.toHaveBeenCalled();
    });

    it('reads and parses a saved project', async () => {
        const { service, readFile } = createFileService({ content: PROJECT_JSON });

        const snapshot = await readOpenmcRegionReferences(service, PROJECT_PATH);

        expect(snapshot.status).toBe('saved-project');
        expect(snapshot.projectPath).toBe(PROJECT_PATH);
        expect(snapshot.dagmcFile).toBe('geometry.h5m');
        expect(snapshot.dagmcGroups).toEqual(['fuel']);
        expect(snapshot.materialNames).toEqual(['fuel']);
        expect(snapshot.materialIds).toEqual(['cad-material-fuel']);
        expect(snapshot.warnings).toEqual([]);
        expect(readFile).toHaveBeenCalledTimes(1);
        expect(readFile.mock.calls[0][0]).toBeInstanceOf(URI);
    });

    it('reports an unreadable project when reading fails', async () => {
        const { service } = createFileService({ readError: new Error('permission denied') });

        const snapshot = await readOpenmcRegionReferences(service, PROJECT_PATH);

        expect(snapshot.status).toBe('unreadable-project');
        expect(snapshot.projectPath).toBe(PROJECT_PATH);
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.warnings[0]).toContain('permission denied');
    });

    it('reports an unreadable project when the existence check fails', async () => {
        const { service } = createFileService({ existsError: new Error('stat failed') });

        const snapshot = await readOpenmcRegionReferences(service, PROJECT_PATH);

        expect(snapshot.status).toBe('unreadable-project');
        expect(snapshot.warnings[0]).toContain('stat failed');
    });

    it('propagates invalid project content as invalid-project', async () => {
        const { service } = createFileService({ content: '{' });

        const snapshot = await readOpenmcRegionReferences(service, PROJECT_PATH);

        expect(snapshot.status).toBe('invalid-project');
        expect(snapshot.warnings).toHaveLength(1);
    });
});
