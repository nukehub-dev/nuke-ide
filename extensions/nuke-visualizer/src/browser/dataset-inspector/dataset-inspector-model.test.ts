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
 * Tests for the dataset inspector host contract (no DOM, no Theia): the
 * structural host guard and the remembered-association array resolution.
 */

import { describe, expect, it } from 'vitest';
import type { DatasetSummary } from '../viewer-core/dataset-inspector';
import { isViewerDatasetHost, resolveDatasetSelection } from './dataset-inspector-model';

const SUMMARY: DatasetSummary = {
    kind: 'polydata',
    nPoints: 4,
    nCells: 2,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    arrays: [
        { name: 'temp', association: 'point', components: 1, range: [0, 1], tupleCount: 4 },
        { name: 'id', association: 'cell', components: 1, range: [0, 2], tupleCount: 2 },
        { name: 'disp', association: 'point', components: 3, range: [0, 1], tupleCount: 4 }
    ]
};

describe('isViewerDatasetHost', () => {
    it('accepts objects implementing both host methods', () => {
        const host = { getDatasetSummary: () => undefined, getDatasetTable: () => undefined };
        expect(isViewerDatasetHost(host)).toBe(true);
    });

    it('rejects undefined, partial surfaces, and unrelated widgets', () => {
        expect(isViewerDatasetHost(undefined)).toBe(false);
        expect(isViewerDatasetHost({})).toBe(false);
        expect(isViewerDatasetHost({ getDatasetSummary: () => undefined })).toBe(false);
        expect(isViewerDatasetHost({ getDatasetTable: () => undefined })).toBe(false);
        expect(isViewerDatasetHost({ getDatasetSummary: 'nope', getDatasetTable: () => undefined })).toBe(false);
    });
});

describe('resolveDatasetSelection', () => {
    it('keeps the remembered association/name while it exists', () => {
        const selection = resolveDatasetSelection(SUMMARY, 'cell', 'id');
        expect(selection?.association).toBe('cell');
        expect(selection?.array.name).toBe('id');
    });

    it('falls back to the first array of the remembered association', () => {
        expect(resolveDatasetSelection(SUMMARY, 'cell', 'gone')?.array.name).toBe('id');
        expect(resolveDatasetSelection(SUMMARY, 'point', 'gone')?.array.name).toBe('temp');
    });

    it('falls back to the first array when the remembered association has none', () => {
        const pointsOnly: DatasetSummary = { ...SUMMARY, arrays: [SUMMARY.arrays[2]] };
        const selection = resolveDatasetSelection(pointsOnly, 'cell', 'id');
        expect(selection?.association).toBe('point');
        expect(selection?.array.name).toBe('disp');
    });

    it('starts at the first array without a remembered selection', () => {
        expect(resolveDatasetSelection(SUMMARY, undefined, undefined)?.array.name).toBe('temp');
    });

    it('returns undefined for a dataset without arrays', () => {
        expect(resolveDatasetSelection({ ...SUMMARY, arrays: [] }, 'point', 'temp')).toBeUndefined();
    });
});
