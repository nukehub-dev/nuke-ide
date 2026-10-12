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
 * Tests for geometry auto-detection (DOM/Theia-free): the well-known-name,
 * parent-walk, project-pinning, and lone-file rules over a stub store, plus
 * the path and project-document helpers.
 */

import { describe, expect, it } from 'vitest';
import {
    GeometryDiscoveryStore,
    autoDetectGeometryPath,
    dagmcFileFromProjectDoc,
    isAbsoluteUri,
    joinPath,
    parentDir,
    uriToPath
} from './openmc-file-discovery-model';

/** In-memory directory tree: dir path -> files (name -> text content). */
type StubTree = Record<string, Record<string, string>>;

function stubStore(tree: StubTree): GeometryDiscoveryStore {
    const filesIn = (dir: string): Record<string, string> | undefined =>
        Object.prototype.hasOwnProperty.call(tree, dir) ? tree[dir] : undefined;
    const split = (path: string): [string, string] => {
        const slash = path.lastIndexOf('/');
        return [path.slice(0, slash), path.slice(slash + 1)];
    };
    return {
        listFiles: async (dir: string) => {
            const files = filesIn(dir);
            return files === undefined ? undefined : Object.keys(files);
        },
        readText: async (path: string) => {
            const [dir, name] = split(path);
            const files = filesIn(dir);
            if (files === undefined || !Object.prototype.hasOwnProperty.call(files, name)) {
                return undefined;
            }
            return files[name];
        },
        fileExists: async (path: string) => {
            const [dir, name] = split(path);
            const files = filesIn(dir);
            return files !== undefined && Object.prototype.hasOwnProperty.call(files, name);
        }
    };
}

describe('dagmcFileFromProjectDoc', () => {
    it('reads settings.dagmcFile and rejects anything else', () => {
        expect(dagmcFileFromProjectDoc({ state: { settings: { dagmcFile: 'model.h5m' } } })).toBe('model.h5m');
        expect(dagmcFileFromProjectDoc({ state: { settings: {} } })).toBeUndefined();
        expect(dagmcFileFromProjectDoc({ state: {} })).toBeUndefined();
        expect(dagmcFileFromProjectDoc({})).toBeUndefined();
        expect(dagmcFileFromProjectDoc(null)).toBeUndefined();
        expect(dagmcFileFromProjectDoc('model.h5m')).toBeUndefined();
        expect(dagmcFileFromProjectDoc({ state: { settings: { dagmcFile: '' } } })).toBeUndefined();
        expect(dagmcFileFromProjectDoc({ state: { settings: { dagmcFile: 7 } } })).toBeUndefined();
    });
});

describe('parentDir / joinPath / uriToPath', () => {
    it('walks paths without URI machinery', () => {
        expect(parentDir('/ws/w7x/output')).toBe('/ws/w7x');
        expect(parentDir('/ws')).toBeUndefined();
        expect(parentDir('/')).toBeUndefined();
        expect(joinPath('/ws/w7x', 'model.h5m')).toBe('/ws/w7x/model.h5m');
        expect(joinPath('/ws/w7x/', 'model.h5m')).toBe('/ws/w7x/model.h5m');
        expect(isAbsoluteUri('file:///data/m.h5m')).toBe(true);
        expect(isAbsoluteUri('model.h5m')).toBe(false);
        expect(uriToPath('file:///data/m.h5m')).toBe('/data/m.h5m');
        expect(uriToPath('/data/m.h5m')).toBe('/data/m.h5m');
        expect(uriToPath('vault:m.h5m')).toBeUndefined();
    });
});

describe('autoDetectGeometryPath well-known names', () => {
    it('finds geometry.xml beside the statepoint', async () => {
        const store = stubStore({ '/ws/pincell/output': { 'statepoint.10.h5': '', 'geometry.xml': '<geometry/>' } });
        await expect(autoDetectGeometryPath('/ws/pincell/output', store, '/ws')).resolves.toBe('/ws/pincell/output/geometry.xml');
    });

    it('finds geometry.xml one level up', async () => {
        const store = stubStore({
            '/ws/pincell/output': { 'statepoint.10.h5': '' },
            '/ws/pincell': { 'geometry.xml': '<geometry/>' }
        });
        await expect(autoDetectGeometryPath('/ws/pincell/output', store, '/ws')).resolves.toBe('/ws/pincell/geometry.xml');
    });

    it('prefers the closer directory over a farther match', async () => {
        const store = stubStore({
            '/ws/proj/output': { 'statepoint.10.h5': '', 'geometry.xml': '<near/>' },
            '/ws/proj': { 'geometry.xml': '<far/>' }
        });
        await expect(autoDetectGeometryPath('/ws/proj/output', store, '/ws')).resolves.toBe('/ws/proj/output/geometry.xml');
    });
});

describe('autoDetectGeometryPath project pinning', () => {
    const project = (dagmcFile: string): string => JSON.stringify({ version: '1.1.0', state: { settings: { dagmcFile } } });

    it('resolves a project-relative dagmcFile in the parent directory', async () => {
        const store = stubStore({
            '/ws/w7x/output': { 'statepoint.10.h5': '' },
            '/ws/w7x': { 'w7x.nuke-openmc': project('scaled.h5m'), 'scaled.h5m': 'h5m' }
        });
        await expect(autoDetectGeometryPath('/ws/w7x/output', store, '/ws')).resolves.toBe('/ws/w7x/scaled.h5m');
    });

    it('prefers the project dagmcFile over a co-located geometry.xml', async () => {
        const store = stubStore({
            '/ws/w7x/output': { 'statepoint.10.h5': '' },
            '/ws/w7x': {
                'w7x.nuke-openmc': project('scaled.h5m'),
                'scaled.h5m': 'h5m',
                'geometry.xml': '<geometry/>'
            }
        });
        await expect(autoDetectGeometryPath('/ws/w7x/output', store, '/ws')).resolves.toBe('/ws/w7x/scaled.h5m');
    });

    it('resolves an absolute dagmcFile', async () => {
        const store = stubStore({
            '/ws/w7x/output': { 'statepoint.10.h5': '' },
            '/ws/w7x': { 'w7x.nuke-openmc': project('file:///data/scaled.h5m') },
            '/data': { 'scaled.h5m': 'h5m' }
        });
        await expect(autoDetectGeometryPath('/ws/w7x/output', store, '/ws')).resolves.toBe('/data/scaled.h5m');
    });

    it('ignores a dangling dagmcFile and keeps walking', async () => {
        const store = stubStore({
            '/ws/w7x/output': { 'statepoint.10.h5': '' },
            '/ws/w7x': { 'w7x.nuke-openmc': project('gone.h5m'), 'geometry.xml': '<geometry/>' }
        });
        await expect(autoDetectGeometryPath('/ws/w7x/output', store, '/ws')).resolves.toBe('/ws/w7x/geometry.xml');
    });

    it('ignores an unparseable project file', async () => {
        const store = stubStore({
            '/ws/w7x/output': { 'statepoint.10.h5': '' },
            '/ws/w7x': { 'w7x.nuke-openmc': '{oops', 'geometry.xml': '<geometry/>' }
        });
        await expect(autoDetectGeometryPath('/ws/w7x/output', store, '/ws')).resolves.toBe('/ws/w7x/geometry.xml');
    });
});

describe('autoDetectGeometryPath lone-file fallback', () => {
    it('takes a single non-backup h5m with no project around', async () => {
        const store = stubStore({ '/ws/a/output': { 'statepoint.10.h5': '' }, '/ws/a': { 'model.h5m': 'h5m' } });
        await expect(autoDetectGeometryPath('/ws/a/output', store, '/ws')).resolves.toBe('/ws/a/model.h5m');
    });

    it('prefers the real file over a backup twin', async () => {
        const store = stubStore({
            '/ws/a/output': { 'statepoint.10.h5': '' },
            '/ws/a': { 'model.h5m': 'h5m', 'model.orig.h5m': 'h5m' }
        });
        await expect(autoDetectGeometryPath('/ws/a/output', store, '/ws')).resolves.toBe('/ws/a/model.h5m');
    });

    it('takes a lone backup file as a last resort', async () => {
        const store = stubStore({ '/ws/a/output': { 'statepoint.10.h5': '' }, '/ws/a': { 'model.orig.h5m': 'h5m' } });
        await expect(autoDetectGeometryPath('/ws/a/output', store, '/ws')).resolves.toBe('/ws/a/model.orig.h5m');
    });

    it('gives up on several distinct candidates (manual picker upstream)', async () => {
        const store = stubStore({
            '/ws/a/output': { 'statepoint.10.h5': '' },
            '/ws/a': { 'one.h5m': 'h5m', 'two.h5m': 'h5m' }
        });
        await expect(autoDetectGeometryPath('/ws/a/output', store, '/ws')).resolves.toBeUndefined();
    });

    it('gives up with nothing around', async () => {
        const store = stubStore({ '/ws/a/output': { 'statepoint.10.h5': '' }, '/ws/a': {} });
        await expect(autoDetectGeometryPath('/ws/a/output', store, '/ws')).resolves.toBeUndefined();
    });
});
