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

import { describe, expect, it } from 'vitest';
import type { NukeCadAssembly } from './cad-document';
import { buildAssemblyBomDelta } from './assembly-bom';

function assembly(parts: string[], groundedInstanceId = 'grounded'): NukeCadAssembly {
    return {
        instances: parts.map((part, index) => ({
            id: `instance-${index + 1}`,
            part,
            placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
        })),
        connectors: [],
        mates: [],
        groundedInstanceId
    };
}

describe('buildAssemblyBomDelta', () => {
    it('treats absent sections as empty quantities and grounding', () => {
        expect(buildAssemblyBomDelta(undefined, undefined)).toEqual({
            rows: [],
            beforeTotal: 0,
            afterTotal: 0,
            groundedBefore: '',
            groundedAfter: ''
        });
    });

    it('returns every part present before or after, sorted by exact part string', () => {
        const delta = buildAssemblyBomDelta(
            assembly(['./bracket.nuke-cad', 'body:body-1', 'body:body-1']),
            assembly(['body:body-1', './bracket.nuke-cad', './bracket.nuke-cad', './mount.nuke-cad'])
        );

        expect(delta.rows).toEqual([
            { part: './bracket.nuke-cad', before: 1, after: 2, delta: 1 },
            { part: './mount.nuke-cad', before: 0, after: 1, delta: 1 },
            { part: 'body:body-1', before: 2, after: 1, delta: -1 }
        ]);
        expect(delta.beforeTotal).toBe(3);
        expect(delta.afterTotal).toBe(4);
        expect(delta.groundedBefore).toBe('grounded');
        expect(delta.groundedAfter).toBe('grounded');
    });

    it('keeps unchanged rows with zero deltas', () => {
        const delta = buildAssemblyBomDelta(assembly(['body:body-1', 'body:body-2']), assembly(['body:body-1', 'body:body-2']));

        expect(delta.rows.map((row) => row.delta)).toEqual([0, 0]);
        expect(delta.beforeTotal).toBe(delta.afterTotal);
    });

    it('reports grounding changes exactly', () => {
        const delta = buildAssemblyBomDelta(assembly(['body:body-1'], 'base'), assembly(['body:body-1'], 'arm'));

        expect(delta.groundedBefore).toBe('base');
        expect(delta.groundedAfter).toBe('arm');
    });
});
