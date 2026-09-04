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
import { hiddenBodyIds, visibleCurveIds } from './curve-visibility';

describe('curve-visibility', () => {
    it('shows every curve when nothing is hidden', () => {
        const visible = visibleCurveIds(['w7x'], [{ curveId: 'w7x', bodyId: 'coil-body' }], new Map([[0, 'coil-body']]), new Set());
        expect([...visible]).toEqual(['w7x']);
    });

    it('hides the curve when its only consuming body is fully hidden', () => {
        // The reported defect: hiding the copper body left the centerline loop.
        const solidToBody = new Map([[0, 'coil-body']]);
        expect(visibleCurveIds(['w7x'], [{ curveId: 'w7x', bodyId: 'coil-body' }], solidToBody, new Set([0])).size).toBe(0);
    });

    it('keeps the curve when any consuming solid stays visible', () => {
        const solidToBody = new Map([
            [0, 'coil-body'],
            [1, 'coil-body']
        ]);
        const visible = visibleCurveIds(['w7x'], [{ curveId: 'w7x', bodyId: 'coil-body' }], solidToBody, new Set([0]));
        expect([...visible]).toEqual(['w7x']);
    });

    it('always shows unreferenced construction curves', () => {
        const solidToBody = new Map([[0, 'coil-body']]);
        const visible = visibleCurveIds(['sketch-aid'], [], solidToBody, new Set([0]));
        expect([...visible]).toEqual(['sketch-aid']);
    });

    it('hides a shared curve only when all consuming bodies are hidden', () => {
        const solidToBody = new Map([
            [0, 'body-a'],
            [1, 'body-b']
        ]);
        const users = [
            { curveId: 'shared', bodyId: 'body-a' },
            { curveId: 'shared', bodyId: 'body-b' }
        ];
        expect(visibleCurveIds(['shared'], users, solidToBody, new Set([0])).has('shared')).toBe(true);
        expect(visibleCurveIds(['shared'], users, solidToBody, new Set([0, 1])).has('shared')).toBe(false);
    });

    it('never treats a body without tessellated solids as hidden', () => {
        expect(hiddenBodyIds(new Map(), new Set([0])).size).toBe(0);
        const visible = visibleCurveIds(['w7x'], [{ curveId: 'w7x', bodyId: 'ghost-body' }], new Map(), new Set([0]));
        expect([...visible]).toEqual(['w7x']);
    });
});
