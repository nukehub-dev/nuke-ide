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

import { describe, expect, it } from 'vitest';
import type { ImportSolidInfo } from '../../../common/nuke-cad-protocol';
import {
    defaultImportBodyLabel,
    importSourceBaseName,
    inferImportSourceFormat,
    normalizeImportSourceUnit,
    planImportBodies,
    type ImportBodySourceIdentity
} from './import-body';

const HASH = 'a'.repeat(64);

const solid = (index: number, name?: string, faceCount = 6, volume = 1000): ImportSolidInfo => ({
    index,
    name,
    faceCount,
    volume,
    bboxMin: [0, 0, 0],
    bboxMax: [10, 10, 10],
    center: [5, 5, 5]
});

const source = (overrides: Partial<ImportBodySourceIdentity> = {}): ImportBodySourceIdentity => ({
    sourcePath: './model.parts/part.step',
    sourceHash: HASH,
    sourceSize: 2048,
    sourceFormat: 'step',
    maxSolids: 500,
    ...overrides
});

describe('import source labels and formats', () => {
    it('derives the default body label from the source stem', () => {
        expect(defaultImportBodyLabel('scaled_w7x_stellarator.step')).toBe('scaled_w7x_stellarator');
        expect(defaultImportBodyLabel('/a/b/coil.STP')).toBe('coil');
        expect(defaultImportBodyLabel('C:\\models\\shell.iges')).toBe('shell');
        expect(defaultImportBodyLabel('.step')).toBe('Imported body');
    });

    it('infers exchange formats from the file extension', () => {
        expect(inferImportSourceFormat('a.step')).toBe('step');
        expect(inferImportSourceFormat('a.STP')).toBe('step');
        expect(inferImportSourceFormat('a.igs')).toBe('iges');
        expect(inferImportSourceFormat('a.brep')).toBe('brep');
        expect(inferImportSourceFormat('a.txt')).toBeUndefined();
        expect(inferImportSourceFormat('no-extension')).toBeUndefined();
    });

    it('normalizes backend unit spellings for the detected-unit select', () => {
        expect(normalizeImportSourceUnit('MM')).toBe('mm');
        expect(normalizeImportSourceUnit('millimetre')).toBe('mm');
        expect(normalizeImportSourceUnit('centimeters')).toBe('cm');
        expect(normalizeImportSourceUnit('Metre')).toBe('m');
        expect(normalizeImportSourceUnit('inch')).toBeUndefined();
        expect(normalizeImportSourceUnit(undefined)).toBeUndefined();
    });

    it('keeps only the basename of POSIX and Windows paths', () => {
        expect(importSourceBaseName('./w7x.parts/source.step')).toBe('source.step');
        expect(importSourceBaseName('C:\\parts\\source.brep')).toBe('source.brep');
    });
});

describe('planImportBodies', () => {
    it('creates one body from every selected solid with inspection signatures', () => {
        const plan = planImportBodies(source(), { strategy: 'single', label: 'Coil pack', solidIndexes: [2, 1] }, [
            solid(1, 'Coil A', 8, 12.5),
            solid(2, 'Coil B', 10, 20)
        ]);
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts).toHaveLength(1);
        expect(plan.drafts[0].name).toBe('Coil pack');
        expect(plan.drafts[0].label).toBeUndefined();
        expect(plan.drafts[0].params).toEqual({
            sourcePath: './model.parts/part.step',
            sourceHash: HASH,
            sourceSize: 2048,
            sourceFormat: 'step',
            maxSolids: 500,
            selection: {
                mode: 'solids',
                solids: [
                    { index: 1, signature: { faceCount: 8, volume: 12.5 } },
                    { index: 2, signature: { faceCount: 10, volume: 20 } }
                ]
            }
        });
    });

    it('creates one body per selected solid with product names and unique fallbacks', () => {
        const plan = planImportBodies(source(), { strategy: 'perSolid', label: 'Shell', solidIndexes: [1, 2, 3] }, [
            solid(1, 'Vacuum vessel', 8, 10),
            solid(2, 'Vacuum vessel', 9, 11),
            solid(3)
        ]);
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts.map((draft) => draft.name)).toEqual(['Vacuum vessel', 'Vacuum vessel 2', 'Shell 3']);
        expect(plan.drafts.map((draft) => draft.label)).toEqual([undefined, 'Vacuum vessel', undefined]);
        expect(plan.drafts[0].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 1, signature: { faceCount: 8, volume: 10 } }]
        });
    });

    it('keeps generated names unique against existing bodies', () => {
        const plan = planImportBodies(source(), { strategy: 'single', label: 'Coil', solidIndexes: [1] }, [solid(1)], ['Coil', 'Coil 2']);
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts[0].name).toBe('Coil 3');
    });

    it('includes a source-unit override only when provided', () => {
        const overridden = planImportBodies(source(), { strategy: 'single', label: 'W7X', sourceUnit: 'm', solidIndexes: [1] }, [solid(1)]);
        expect(overridden.ok).toBe(true);
        if (!overridden.ok) {
            return;
        }
        expect(overridden.drafts[0].params.sourceUnit).toBe('m');

        const detected = planImportBodies(source(), { strategy: 'single', label: 'W7X', solidIndexes: [1] }, [solid(1)]);
        expect(detected.ok).toBe(true);
        if (!detected.ok) {
            return;
        }
        expect(detected.drafts[0].params.sourceUnit).toBeUndefined();
    });

    it('omits optional source fields the inspection did not report', () => {
        const plan = planImportBodies(
            source({ sourceSize: undefined, sourceFormat: undefined, maxSolids: undefined }),
            { strategy: 'single', label: 'Body', solidIndexes: [1] },
            [solid(1)]
        );
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts[0].params).not.toHaveProperty('sourceSize');
        expect(plan.drafts[0].params).not.toHaveProperty('sourceFormat');
        expect(plan.drafts[0].params).not.toHaveProperty('maxSolids');
    });

    it('uses the single selected solid product name as the body label', () => {
        const plan = planImportBodies(source(), { strategy: 'single', label: 'Header', solidIndexes: [1] }, [solid(1, 'Coil 1')]);
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts[0]).toMatchObject({ name: 'Header', label: 'Coil 1' });
    });

    it('rejects an empty label, no selection, unknown solids, and bad hashes', () => {
        expect(planImportBodies(source(), { strategy: 'single', label: '  ', solidIndexes: [1] }, [solid(1)])).toEqual({
            ok: false,
            error: 'Enter a body label.'
        });
        expect(planImportBodies(source(), { strategy: 'single', label: 'Body', solidIndexes: [] }, [solid(1)])).toEqual({
            ok: false,
            error: 'Select at least one source solid to import.'
        });
        expect(planImportBodies(source(), { strategy: 'single', label: 'Body', solidIndexes: [4] }, [solid(1)])).toEqual({
            ok: false,
            error: 'Source solid 4 is no longer present. Re-inspect the source and try again.'
        });
        expect(
            planImportBodies(source({ sourceHash: 'nope' }), { strategy: 'single', label: 'Body', solidIndexes: [1] }, [solid(1)])
        ).toEqual({
            ok: false,
            error: 'The source inspection did not return a valid SHA-256 hash.'
        });
    });

    it('deduplicates and sorts selected solid indexes', () => {
        const plan = planImportBodies(source(), { strategy: 'single', label: 'Body', solidIndexes: [2, 2, 1, 0, -1] }, [
            solid(1),
            solid(2)
        ]);
        expect(plan.ok).toBe(true);
        if (!plan.ok) {
            return;
        }
        expect(plan.drafts[0].params.selection).toEqual({
            mode: 'solids',
            solids: [
                { index: 1, signature: { faceCount: 6, volume: 1000 } },
                { index: 2, signature: { faceCount: 6, volume: 1000 } }
            ]
        });
    });
});
