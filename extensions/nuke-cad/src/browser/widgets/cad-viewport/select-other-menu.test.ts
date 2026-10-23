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
import * as THREE from 'three';
import { buildSelectOtherRows } from './select-other-menu';
import { type FacePickCandidate } from './face-picker';

const mesh = {} as THREE.Mesh;

const candidate = (solidId: number, faceId: number, distance: number, bodyId?: string): FacePickCandidate => ({
    solidId,
    faceId,
    bodyId,
    distance,
    mesh
});

const document = {
    bodies: [
        { id: 'body-1', name: 'clad-body', label: 'clad' },
        { id: 'body-2', name: 'fuel-body' }
    ]
};

describe('buildSelectOtherRows', () => {
    it('labels rows from the document body label, then name, then solid fallback', () => {
        const rows = buildSelectOtherRows([candidate(1, 3, 1, 'body-1'), candidate(2, 4, 2, 'body-2'), candidate(9, 5, 3)], document);
        expect(rows.map((row) => row.bodyLabel)).toEqual(['clad', 'fuel-body', 'Solid 9']);
    });

    it('falls back to Solid <id> when there is no document (script/STEP models)', () => {
        const rows = buildSelectOtherRows([candidate(7, 2, 1.5)], undefined);
        expect(rows).toEqual([
            {
                solidId: 7,
                faceId: 2,
                bodyLabel: 'Solid 7',
                detail: 'face 2',
                distanceLabel: '1.5'
            }
        ]);
    });

    it('formats distances with the passed length decimals', () => {
        const rows = buildSelectOtherRows([candidate(1, 1, 2.3456)], document, 1);
        expect(rows[0].distanceLabel).toBe('2.3');
        expect(buildSelectOtherRows([candidate(1, 1, 2.3456)], document, 3)[0].distanceLabel).toBe('2.346');
        expect(buildSelectOtherRows([candidate(1, 1, 2.3456)], document, 0)[0].distanceLabel).toBe('2');
    });

    it('preserves candidate order and carries solid/face identity plus the face detail', () => {
        const rows = buildSelectOtherRows([candidate(4, 11, 3), candidate(2, 9, 1)], document);
        expect(rows.map((row) => ({ solidId: row.solidId, faceId: row.faceId, detail: row.detail }))).toEqual([
            { solidId: 4, faceId: 11, detail: 'face 11' },
            { solidId: 2, faceId: 9, detail: 'face 9' }
        ]);
    });
});
