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
import { type CurveDef, type NukeCadDocument, validateNukeCadDocument } from '../../../common/cad-document';
import { createEmptyNukeCadDocument } from '../../../common/document-templates';
import { buildFeaturePreviewDocument, resolveCurvePick, validateSweepPipeDraft } from './sweep-pipe';

function pathCurve(id = 'c1'): CurveDef {
    return {
        id,
        name: `Curve ${id}`,
        source: { kind: 'points' },
        samples: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
            [0, 1, 0]
        ]
    };
}

function sweepDocument(): NukeCadDocument {
    const doc = createEmptyNukeCadDocument('test');
    return {
        ...doc,
        parameters: { width: 2 },
        sketches: [
            {
                id: 'sk1',
                name: 'Section',
                datumId: 'datum-xy',
                primitives: [],
                constraints: []
            }
        ],
        curves: [pathCurve()]
    };
}

describe('validateSweepPipeDraft', () => {
    const curves = [pathCurve()];

    it('rejects an empty path curve selection', () => {
        const result = validateSweepPipeDraft({ type: 'sweep', pathCurveId: '', orientation: 'frenet', binormal: ['0', '0', '1'] }, curves);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Select a path curve');
        }
    });

    it('rejects a path curve that does not exist in the document', () => {
        const result = validateSweepPipeDraft(
            { type: 'sweep', pathCurveId: 'missing', orientation: 'frenet', binormal: ['0', '0', '1'] },
            curves
        );
        expect(result.ok).toBe(false);
    });

    it('accepts a frenet sweep without a binormal', () => {
        const result = validateSweepPipeDraft(
            { type: 'sweep', pathCurveId: 'c1', orientation: 'frenet', binormal: ['0', '0', '1'] },
            curves
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params.pathCurveId).toBe('c1');
            expect(result.params.orientation).toBe('frenet');
            expect(result.params.binormal).toBeUndefined();
        }
    });

    it('rejects a zero binormal for fixedBinormal', () => {
        const result = validateSweepPipeDraft(
            { type: 'sweep', pathCurveId: 'c1', orientation: 'fixedBinormal', binormal: ['0', '0', '0'] },
            curves
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Binormal');
        }
    });

    it('rejects a non-finite binormal component for fixedBinormal', () => {
        const result = validateSweepPipeDraft(
            { type: 'sweep', pathCurveId: 'c1', orientation: 'fixedBinormal', binormal: ['1', 'abc', '0'] },
            curves
        );
        expect(result.ok).toBe(false);
    });

    it('includes the binormal for a valid fixedBinormal sweep', () => {
        const result = validateSweepPipeDraft(
            { type: 'sweep', pathCurveId: 'c1', orientation: 'fixedBinormal', binormal: ['0', '0', '1'] },
            curves
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params.orientation).toBe('fixedBinormal');
            expect(result.params.binormal).toEqual([0, 0, 1]);
        }
    });

    it.each(['', '0', '-1', 'abc'])('rejects pipe radius %j', (radius) => {
        const result = validateSweepPipeDraft(
            { type: 'pipe', pathCurveId: 'c1', orientation: 'frenet', binormal: ['0', '0', '1'], radius },
            curves
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Radius');
        }
    });

    it('accepts a pipe with a positive radius', () => {
        const result = validateSweepPipeDraft(
            { type: 'pipe', pathCurveId: 'c1', orientation: 'frenet', binormal: ['0', '0', '1'], radius: '0.25' },
            curves
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params.pathCurveId).toBe('c1');
            expect(result.params).toMatchObject({ radius: 0.25 });
        }
    });
});

describe('buildFeaturePreviewDocument', () => {
    it('assembles a valid sweep mini-document with sketch, datum, and curve', () => {
        const doc = sweepDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'sweep',
            sketchId: 'sk1',
            params: { pathCurveId: 'c1', orientation: 'frenet' }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.sketches.map((s) => s.id)).toEqual(['sk1']);
        expect(preview.curves.map((c) => c.id)).toEqual(['c1']);
        expect(preview.datums.some((d) => d.id === 'datum-xy')).toBe(true);
        expect(preview.features).toHaveLength(1);
        const feature = preview.features[0];
        expect(feature.type).toBe('sweep');
        expect(feature.body).toBe('preview-body');
        expect(feature.sketchId).toBe('sk1');
        expect(feature.dependsOn).toEqual([]);
        expect(preview.bodies).toEqual([{ id: 'preview-body', name: 'Preview' }]);
        expect(preview.parameters).toEqual({ width: 2 });
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('builds a pipe preview without any sketch', () => {
        const doc = sweepDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'pipe',
            params: { pathCurveId: 'c1', radius: 0.5, orientation: 'frenet' }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.sketches).toEqual([]);
        expect(preview.features[0].sketchId).toBeUndefined();
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('returns undefined when the path curve is missing', () => {
        const doc = sweepDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'sweep',
            sketchId: 'sk1',
            params: { pathCurveId: 'missing', orientation: 'frenet' }
        });
        expect(preview).toBeUndefined();
    });

    it('returns undefined when the sweep section sketch is missing', () => {
        const doc = sweepDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'sweep',
            sketchId: 'missing',
            params: { pathCurveId: 'c1', orientation: 'frenet' }
        });
        expect(preview).toBeUndefined();
    });

    it('carries a custom (non-builtin) sketch datum into the mini-document', () => {
        const doc: NukeCadDocument = {
            ...sweepDocument(),
            datums: [...createEmptyNukeCadDocument('test').datums, { id: 'datum-custom', kind: 'offset', name: 'Offset Plane', offset: 3 }],
            sketches: [
                {
                    id: 'sk1',
                    name: 'Section',
                    datumId: 'datum-custom',
                    primitives: [],
                    constraints: []
                }
            ]
        };
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'sweep',
            sketchId: 'sk1',
            params: { pathCurveId: 'c1', orientation: 'frenet' }
        });
        expect(preview?.datums.some((d) => d.id === 'datum-custom')).toBe(true);
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });
});

describe('resolveCurvePick', () => {
    const curves = [pathCurve('c1'), pathCurve('c2')];

    it('accepts a pick for an existing curve', () => {
        expect(resolveCurvePick(curves, 'c2')).toBe('c2');
    });

    it('drops a pick for a curve that no longer exists', () => {
        expect(resolveCurvePick(curves, 'deleted')).toBeUndefined();
    });

    it('drops non-string and empty picks', () => {
        expect(resolveCurvePick(curves, undefined)).toBeUndefined();
        expect(resolveCurvePick(curves, 42)).toBeUndefined();
        expect(resolveCurvePick(curves, '')).toBeUndefined();
    });
});
