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
import { validRelations, type SketchEntityType } from './constraint-relations';

describe('validRelations', () => {
    it('is symmetric for all type pairs', () => {
        const types: SketchEntityType[] = ['point', 'line', 'circle', 'arc'];
        for (const a of types) {
            for (const b of types) {
                expect(validRelations(a, b)).toEqual(validRelations(b, a));
            }
        }
    });

    it('point + anything offers only coincident', () => {
        const others: SketchEntityType[] = ['point', 'line', 'circle', 'arc'];
        for (const other of others) {
            expect(validRelations('point', other)).toEqual(['coincident']);
        }
    });

    it('line + line offers coincident, parallel, perpendicular, equal', () => {
        expect(validRelations('line', 'line')).toEqual(['coincident', 'parallel', 'perpendicular', 'equal']);
    });

    it('line + circle offers tangent and coincident', () => {
        expect(validRelations('line', 'circle')).toEqual(['tangent', 'coincident']);
    });

    it('line + arc offers tangent and coincident', () => {
        expect(validRelations('line', 'arc')).toEqual(['tangent', 'coincident']);
    });

    it('circle + circle offers concentric, equal, tangent, coincident', () => {
        expect(validRelations('circle', 'circle')).toEqual(['concentric', 'equal', 'tangent', 'coincident']);
    });

    it('arc + arc offers concentric, equal, tangent, coincident', () => {
        expect(validRelations('arc', 'arc')).toEqual(['concentric', 'equal', 'tangent', 'coincident']);
    });

    it('circle + arc offers concentric, equal, tangent, coincident', () => {
        expect(validRelations('circle', 'arc')).toEqual(['concentric', 'equal', 'tangent', 'coincident']);
    });

    it('omits single-entity and value-taking constraints', () => {
        const all = new Set<string>();
        for (const a of ['point', 'line', 'circle', 'arc'] as SketchEntityType[]) {
            for (const b of ['point', 'line', 'circle', 'arc'] as SketchEntityType[]) {
                for (const kind of validRelations(a, b)) {
                    all.add(kind);
                }
            }
        }
        expect(all).toEqual(new Set(['coincident', 'parallel', 'perpendicular', 'equal', 'tangent', 'concentric']));
    });
});
