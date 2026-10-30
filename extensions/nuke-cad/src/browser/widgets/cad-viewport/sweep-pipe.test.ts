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
import { type CurveDef, type FeatureDef, type NukeCadDocument, validateNukeCadDocument } from '../../../common/cad-document';
import type { TopologyRef } from '../../../common/topology-refs';
import { createEmptyNukeCadDocument } from '../../../common/document-templates';
import {
    buildFeaturePreviewDocument,
    collectPreviewClosure,
    helicalSweepDraftFromParams,
    loftDraftFromParams,
    moveLoftSection,
    resolveCurvePick,
    validateExtrudeDraft,
    validateHelicalSweepDraft,
    validateLoftDraft,
    validatePrimitiveDraft,
    validateRevolveDraft,
    validateSweepPipeDraft
} from './sweep-pipe';

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

function sketch(id: string, name = 'Sketch', datumId = 'datum-xy'): import('../../../common/cad-document').SketchDef {
    return { id, name, datumId, primitives: [], constraints: [] };
}

function loftDocument(): NukeCadDocument {
    const doc = createEmptyNukeCadDocument('test');
    return {
        ...doc,
        sketches: [sketch('sk1', 'Bottom'), sketch('sk2', 'Middle'), sketch('sk3', 'Top')]
    };
}

describe('validateLoftDraft', () => {
    const sketches = [sketch('sk1'), sketch('sk2'), sketch('sk3')];

    it('rejects fewer than two sections', () => {
        const result = validateLoftDraft({ sectionSketchIds: ['sk1'], ruled: false }, sketches);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('at least 2');
        }
    });

    it('rejects an empty section list', () => {
        const result = validateLoftDraft({ sectionSketchIds: [], ruled: false }, sketches);
        expect(result.ok).toBe(false);
    });

    it('rejects a section sketch that does not exist in the document', () => {
        const result = validateLoftDraft({ sectionSketchIds: ['sk1', 'missing'], ruled: false }, sketches);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('missing');
        }
    });

    it('rejects duplicate sections', () => {
        const result = validateLoftDraft({ sectionSketchIds: ['sk1', 'sk1'], ruled: false }, sketches);
        expect(result.ok).toBe(false);
    });

    it('accepts an ordered section list and keeps its order', () => {
        const result = validateLoftDraft({ sectionSketchIds: ['sk3', 'sk1', 'sk2'], ruled: true }, sketches);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params.sectionSketchIds).toEqual(['sk3', 'sk1', 'sk2']);
            expect(result.params.ruled).toBe(true);
        }
    });
});

describe('moveLoftSection', () => {
    const sections = ['a', 'b', 'c'];

    it('moves a section up without mutating the input', () => {
        const result = moveLoftSection(sections, 1, 'up');
        expect(result).toEqual(['b', 'a', 'c']);
        expect(sections).toEqual(['a', 'b', 'c']);
    });

    it('moves a section down', () => {
        expect(moveLoftSection(sections, 0, 'down')).toEqual(['b', 'a', 'c']);
        expect(moveLoftSection(sections, 1, 'down')).toEqual(['a', 'c', 'b']);
    });

    it('is a no-op out of bounds', () => {
        expect(moveLoftSection(sections, 0, 'up')).toEqual(['a', 'b', 'c']);
        expect(moveLoftSection(sections, 2, 'down')).toEqual(['a', 'b', 'c']);
        expect(moveLoftSection(sections, -1, 'up')).toEqual(['a', 'b', 'c']);
    });
});

describe('validateHelicalSweepDraft', () => {
    const valid = {
        axis: 'Z' as const,
        startRadius: '2',
        pitch: '1.5',
        turns: '4',
        leftHanded: false,
        orientation: 'fixedBinormal' as const,
        binormal: ['0', '0', '1'] as [string, string, string]
    };

    it.each([
        ['startRadius', '0'],
        ['startRadius', '-1'],
        ['startRadius', 'abc'],
        ['pitch', '0'],
        ['turns', '-2']
    ])('rejects %s=%j', (name, value) => {
        const result = validateHelicalSweepDraft({ ...valid, [name]: value });
        expect(result.ok).toBe(false);
    });

    it('rejects a zero binormal for fixedBinormal', () => {
        const result = validateHelicalSweepDraft({ ...valid, binormal: ['0', '0', '0'] });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Binormal');
        }
    });

    it('rejects a non-finite binormal component for fixedBinormal', () => {
        const result = validateHelicalSweepDraft({ ...valid, binormal: ['1', 'x', '0'] });
        expect(result.ok).toBe(false);
    });

    it('includes the binormal for a valid fixedBinormal draft', () => {
        const result = validateHelicalSweepDraft(valid);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toMatchObject({
                axis: 'Z',
                startRadius: 2,
                pitch: 1.5,
                turns: 4,
                leftHanded: false,
                orientation: 'fixedBinormal',
                binormal: [0, 0, 1]
            });
        }
    });

    it('omits the binormal for a frenet draft and honors leftHanded', () => {
        const result = validateHelicalSweepDraft({ ...valid, orientation: 'frenet', leftHanded: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params.orientation).toBe('frenet');
            expect(result.params.binormal).toBeUndefined();
            expect(result.params.leftHanded).toBe(true);
        }
    });
});

describe('buildFeaturePreviewDocument loft/helicalSweep', () => {
    it('assembles a loft mini-document with N section sketches and no curves', () => {
        const doc = loftDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'loft',
            params: { sectionSketchIds: ['sk1', 'sk2', 'sk3'], ruled: false }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.sketches.map((s) => s.id)).toEqual(['sk1', 'sk2', 'sk3']);
        expect(preview.curves).toEqual([]);
        const feature = preview.features[0];
        expect(feature.type).toBe('loft');
        expect(feature.body).toBe('preview-body');
        expect(feature.sketchId).toBeUndefined();
        expect(feature.params).toEqual({ sectionSketchIds: ['sk1', 'sk2', 'sk3'], ruled: false });
        expect(preview.bodies).toEqual([{ id: 'preview-body', name: 'Preview' }]);
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('deduplicates a datum shared by multiple section sketches', () => {
        const doc = loftDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'loft',
            params: { sectionSketchIds: ['sk1', 'sk2'], ruled: true }
        });
        expect(preview?.datums.filter((d) => d.id === 'datum-xy')).toHaveLength(1);
    });

    it('carries a custom section datum into the loft mini-document', () => {
        const doc: NukeCadDocument = {
            ...loftDocument(),
            datums: [...createEmptyNukeCadDocument('test').datums, { id: 'datum-custom', kind: 'offset', name: 'Offset', offset: 3 }],
            sketches: [sketch('sk1', 'Bottom', 'datum-custom'), sketch('sk2', 'Top')]
        };
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'loft',
            params: { sectionSketchIds: ['sk1', 'sk2'], ruled: false }
        });
        expect(preview?.datums.some((d) => d.id === 'datum-custom')).toBe(true);
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('returns undefined when a loft section sketch is missing', () => {
        const doc = loftDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'loft',
            params: { sectionSketchIds: ['sk1', 'missing'], ruled: false }
        });
        expect(preview).toBeUndefined();
    });

    it('assembles a helical sweep mini-document with its sketch and no curve', () => {
        const doc = loftDocument();
        const preview = buildFeaturePreviewDocument(doc, {
            type: 'helicalSweep',
            sketchId: 'sk1',
            params: {
                axis: 'Z',
                startRadius: 2,
                pitch: 1,
                turns: 3,
                leftHanded: false,
                orientation: 'fixedBinormal',
                binormal: [0, 0, 1]
            }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.sketches.map((s) => s.id)).toEqual(['sk1']);
        expect(preview.curves).toEqual([]);
        expect(preview.features[0].type).toBe('helicalSweep');
        expect(preview.features[0].sketchId).toBe('sk1');
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });
});

describe('edit-parameters prefill helpers', () => {
    it('round-trips a loft draft through params', () => {
        const params = { sectionSketchIds: ['sk2', 'sk1'], ruled: true };
        const draft = loftDraftFromParams(params);
        expect(draft.sectionSketchIds).toEqual(['sk2', 'sk1']);
        expect(draft.ruled).toBe(true);
        const validation = validateLoftDraft(draft, [sketch('sk1'), sketch('sk2')]);
        expect(validation.ok).toBe(true);
        if (validation.ok) {
            expect(validation.params).toEqual(params);
        }
    });

    it('defaults a loft draft to empty sections and a smooth skin', () => {
        expect(loftDraftFromParams({})).toEqual({ sectionSketchIds: [], ruled: false });
    });

    it('round-trips a helical sweep draft through params', () => {
        const params = {
            axis: 'X',
            startRadius: 3,
            pitch: 2,
            turns: 5,
            leftHanded: true,
            orientation: 'fixedBinormal' as const,
            binormal: [1, 0, 0] as [number, number, number]
        };
        const draft = helicalSweepDraftFromParams(params);
        expect(draft).toEqual({
            axis: 'X',
            startRadius: '3',
            pitch: '2',
            turns: '5',
            leftHanded: true,
            orientation: 'fixedBinormal',
            binormal: ['1', '0', '0']
        });
        const validation = validateHelicalSweepDraft(draft);
        expect(validation.ok).toBe(true);
        if (validation.ok) {
            expect(validation.params).toEqual(params);
        }
    });

    it('prefills the binormal to the axis unit when the stored feature omits it', () => {
        const draft = helicalSweepDraftFromParams({ axis: 'Y', startRadius: 1, pitch: 1, turns: 2, orientation: 'fixedBinormal' });
        expect(draft.binormal).toEqual(['0', '1', '0']);
        expect(draft.axis).toBe('Y');
    });

    it('prefills a helical sweep draft with sane defaults', () => {
        const draft = helicalSweepDraftFromParams({});
        expect(draft.axis).toBe('Z');
        expect(draft.orientation).toBe('fixedBinormal');
        expect(draft.binormal).toEqual(['0', '0', '1']);
        expect(validateHelicalSweepDraft(draft).ok).toBe(true);
    });
});

function faceRef(featureId: string): TopologyRef {
    return { featureId, kind: 'face', fingerprint: { surfaceType: 'plane', area: 1, center: [0, 0, 0] } };
}

function edgeRef(featureId: string): TopologyRef {
    return { featureId, kind: 'edge', fingerprint: { curveType: 'line', length: 1, start: [0, 0, 0], end: [1, 0, 0] } };
}

/** Document chaining every reference type the preview closure must follow. */
function closureDocument(): NukeCadDocument {
    const doc = createEmptyNukeCadDocument('closure');
    const feature = (id: string, partial: Partial<FeatureDef>): FeatureDef => ({
        id,
        name: id,
        type: 'pad',
        body: 'b1',
        params: {},
        suppressed: false,
        dependsOn: [],
        ...partial
    });
    return {
        ...doc,
        bodies: [
            { id: 'b1', name: 'Body 1' },
            { id: 'b2', name: 'Body 2' }
        ],
        datums: [
            ...doc.datums,
            { id: 'datum-face', kind: 'face', name: 'Face', reference: faceRef('f1') },
            { id: 'datum-mid', kind: 'midplane', name: 'Mid', faces: [faceRef('f1'), faceRef('f2')] }
        ],
        sketches: [
            { id: 'sk1', name: 'S1', datumId: 'datum-xy', primitives: [], constraints: [] },
            { id: 'sk2', name: 'S2', datumId: 'datum-face', primitives: [], constraints: [] },
            { id: 'sk3', name: 'S3', datumId: 'datum-xy', primitives: [], constraints: [], externalRefs: [edgeRef('f1')] },
            { id: 'sk4', name: 'S4', datumId: 'datum-mid', primitives: [], constraints: [] }
        ],
        curves: [pathCurve()],
        features: [
            feature('f1', { sketchId: 'sk1', params: { length: 10 } }),
            feature('f2', { type: 'pocket', sketchId: 'sk2', params: { length: 5 }, dependsOn: ['f1'] }),
            feature('f3', { type: 'fillet', params: { edges: [edgeRef('f1')], radius: 1 }, dependsOn: ['f2'] }),
            feature('f4', {
                type: 'linearPattern',
                params: { source: 'f1', count: 2, spacing: 5, axis: 'x' },
                dependsOn: ['f3']
            }),
            feature('f5', { type: 'mirror', params: { source: 'f1', plane: 'XY' }, dependsOn: ['f4'] }),
            feature('f6', { type: 'multiTransform', params: { first: 'f4', second: 'f5' }, dependsOn: ['f5'] }),
            feature('f7', {
                type: 'sweep',
                sketchId: 'sk1',
                params: { pathCurveId: 'c1', orientation: 'frenet' },
                dependsOn: ['f6']
            }),
            feature('f8', {
                type: 'loft',
                params: { sectionSketchIds: ['sk1', 'sk3'], ruled: false },
                dependsOn: ['f7']
            }),
            feature('f9', {
                type: 'pocket',
                sketchId: 'sk3',
                params: { end: 'upToFace', upToFace: faceRef('f1') },
                dependsOn: ['f8']
            }),
            feature('f10', {
                type: 'booleanFuse',
                params: { targetBody: 'b1', toolBodies: ['b2'] },
                dependsOn: ['f9']
            }),
            feature('f11', {
                type: 'hole',
                params: { face: faceRef('f1'), center: [0, 0], diameter: 5 },
                dependsOn: ['f10']
            }),
            feature('f12', { type: 'primitive', body: 'b2', params: { shape: 'box', dimensions: [1, 2, 3], datumId: 'datum-xy' } })
        ]
    };
}

const emptySeeds = { featureIds: [], sketchIds: [], curveIds: [], bodyIds: [] };

describe('collectPreviewClosure', () => {
    it('collects a dress-up seed transitively in document order', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, featureIds: ['f3'] });
        expect(closure.features.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
        expect(closure.sketches.map((s) => s.id)).toEqual(['sk1', 'sk2']);
        expect(closure.datums.map((d) => d.id)).toEqual(['datum-xy', 'datum-face']);
        expect(closure.bodies.map((b) => b.id)).toEqual(['b1']);
        expect(closure.curves).toEqual([]);
    });

    it('follows pattern source/first/second links', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, featureIds: ['f6'] });
        expect(closure.features.map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    });

    it('follows sketch externalRefs to their producing features', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, sketchIds: ['sk3'] });
        expect(closure.sketches.map((s) => s.id)).toEqual(['sk1', 'sk3']);
        expect(closure.features.map((f) => f.id)).toEqual(['f1']);
        expect(closure.datums.map((d) => d.id)).toEqual(['datum-xy']);
    });

    it('follows datum face references', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, sketchIds: ['sk2'] });
        expect(closure.features.map((f) => f.id)).toEqual(['f1']);
        expect(closure.datums.map((d) => d.id)).toEqual(['datum-xy', 'datum-face']);
    });

    it('follows midplane datum faces', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, sketchIds: ['sk4'] });
        expect(closure.features.map((f) => f.id)).toEqual(['f1', 'f2']);
        expect(closure.datums.map((d) => d.id)).toEqual(['datum-xy', 'datum-face', 'datum-mid']);
    });

    it('follows sweep pathCurveId and loft sectionSketchIds', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, featureIds: ['f7', 'f8'] });
        expect(closure.curves.map((c) => c.id)).toEqual(['c1']);
        // sk2 arrives transitively through the f7->f6->...->f2 dependency chain.
        expect(closure.sketches.map((s) => s.id)).toEqual(['sk1', 'sk2', 'sk3']);
    });

    it('follows upToFace refs and boolean toolBodies', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, featureIds: ['f9', 'f10'] });
        expect(closure.features.map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10']);
        expect(closure.bodies.map((b) => b.id)).toEqual(['b1', 'b2']);
    });

    it('passes seeded bodies and curves through with no outgoing edges', () => {
        const closure = collectPreviewClosure(closureDocument(), { ...emptySeeds, bodyIds: ['b2'], curveIds: ['c1'] });
        expect(closure.bodies.map((b) => b.id)).toEqual(['b2']);
        expect(closure.curves.map((c) => c.id)).toEqual(['c1']);
        expect(closure.features).toEqual([]);
    });

    it('skips unknown ids and leaves the input document untouched', () => {
        const doc = closureDocument();
        const before = JSON.stringify(doc);
        const closure = collectPreviewClosure(doc, {
            featureIds: ['missing'],
            sketchIds: ['missing'],
            curveIds: ['missing'],
            bodyIds: ['missing']
        });
        expect(closure.features).toEqual([]);
        expect(closure.sketches).toEqual([]);
        expect(closure.datums).toEqual([]);
        expect(closure.curves).toEqual([]);
        expect(closure.bodies).toEqual([]);
        expect(JSON.stringify(doc)).toBe(before);
    });
});

describe('buildFeaturePreviewDocument with history', () => {
    it('replays history verbatim and puts the draft on preview-body', () => {
        const doc = closureDocument();
        const preview = buildFeaturePreviewDocument(
            doc,
            { type: 'pad', sketchId: 'sk3', params: { length: 5, axis: 'z', symmetric: false } },
            ['f1']
        );
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.features.map((f) => f.id)).toEqual(['f1', 'preview-feature']);
        expect(preview.features[0]).toBe(doc.features[0]);
        const draft = preview.features[1];
        expect(draft.type).toBe('pad');
        expect(draft.body).toBe('preview-body');
        expect(draft.sketchId).toBe('sk3');
        expect(draft.dependsOn).toEqual([]);
        expect(preview.bodies.map((b) => b.id)).toEqual(['b1', 'preview-body']);
        expect(preview.sketches.map((s) => s.id)).toEqual(['sk1', 'sk3']);
        expect(preview.datums.some((d) => d.id === 'datum-xy')).toBe(true);
        expect(preview.parameters).toEqual(doc.parameters);
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('accepts history as feature records', () => {
        const doc = closureDocument();
        const preview = buildFeaturePreviewDocument(doc, { type: 'revolve', sketchId: 'sk3', params: { axis: 'z', angle: 270 } }, [
            doc.features[0]
        ]);
        expect(preview?.features.map((f) => f.id)).toEqual(['f1', 'preview-feature']);
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('builds a primitive preview without history', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'primitive',
            params: { shape: 'box', dimensions: [1, 2, 3] }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        expect(preview.features.map((f) => f.id)).toEqual(['preview-feature']);
        expect(preview.features[0].sketchId).toBeUndefined();
        expect(preview.bodies).toEqual([{ id: 'preview-body', name: 'Preview' }]);
        expect(preview.datums.some((d) => d.id === 'datum-xy')).toBe(true);
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('carries a dress-up draft through opaquely without history', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'fillet',
            params: { edges: [edgeRef('f1')], radius: 1 }
        });
        expect(preview).toBeDefined();
        // The edge target rides along through the closure so the backend can
        // resolve it (or fail silently when it cannot).
        expect(preview?.features.map((f) => f.id)).toEqual(['f1', 'preview-feature']);
        expect(preview?.sketches.map((s) => s.id)).toEqual(['sk1']);
        expect(preview?.bodies.map((b) => b.id)).toEqual(['b1', 'preview-body']);
    });

    it('resolves a dress-up draft against its history', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), { type: 'fillet', params: { edges: [edgeRef('f2')], radius: 1 } }, [
            'f1',
            'f2'
        ]);
        expect(preview?.features.map((f) => f.id)).toEqual(['f1', 'f2', 'preview-feature']);
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('includes boolean bodies from the draft and the history', () => {
        const preview = buildFeaturePreviewDocument(
            closureDocument(),
            { type: 'booleanFuse', params: { targetBody: 'b1', toolBodies: ['b2'] } },
            ['f1']
        );
        expect(preview?.bodies.map((b) => b.id)).toEqual(['b1', 'b2', 'preview-body']);
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('returns undefined when a history-path draft sketch is missing', () => {
        const preview = buildFeaturePreviewDocument(
            closureDocument(),
            { type: 'pad', sketchId: 'missing', params: { length: 5, axis: 'z', symmetric: false } },
            ['f1']
        );
        expect(preview).toBeUndefined();
    });

    it('returns undefined when a history-path sweep curve is missing', () => {
        const preview = buildFeaturePreviewDocument(
            closureDocument(),
            { type: 'sweep', sketchId: 'sk1', params: { pathCurveId: 'missing', orientation: 'frenet' } },
            ['f1']
        );
        expect(preview).toBeUndefined();
    });

    it('returns undefined when the primitive datum is missing', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'primitive',
            params: { shape: 'box', dimensions: [1, 2, 3], datumId: 'missing' }
        });
        expect(preview).toBeUndefined();
    });

    it('skips unknown history ids', () => {
        const preview = buildFeaturePreviewDocument(
            closureDocument(),
            { type: 'pad', sketchId: 'sk1', params: { length: 5, axis: 'z', symmetric: false } },
            ['missing']
        );
        expect(preview?.features.map((f) => f.id)).toEqual(['preview-feature']);
    });
});

describe('validateExtrudeDraft', () => {
    const blind = { type: 'pad' as const, length: '10', axis: 'z' as const, symmetric: false, twoSided: false, end: 'blind' as const };

    it('accepts a blind pad and keeps the dialog conventions', () => {
        const result = validateExtrudeDraft(blind);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toEqual({ length: 10, axis: 'z', symmetric: false });
        }
    });

    it('keeps twoSided only when set', () => {
        const result = validateExtrudeDraft({ ...blind, type: 'pocket', symmetric: true, twoSided: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toMatchObject({ length: 10, symmetric: true, twoSided: true });
        }
    });

    it.each(['', '0', '-2', 'abc'])('rejects length %j', (length) => {
        const result = validateExtrudeDraft({ ...blind, length });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Length');
        }
    });

    it.each(['upToFirst', 'upToLast', 'upToFace', 'throughAll'] as const)('refuses to preview %s ends', (end) => {
        const result = validateExtrudeDraft({ ...blind, end });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('blind');
        }
    });
});

describe('validateRevolveDraft', () => {
    it('accepts an axis and an angle in (0, 360]', () => {
        const result = validateRevolveDraft({ axis: 'z', angle: '270' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toEqual({ axis: 'z', angle: 270 });
        }
    });

    it('rejects an unknown axis', () => {
        const result = validateRevolveDraft({ axis: 'q', angle: '90' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Axis');
        }
    });

    it.each(['0', '-5', '361', 'abc', ''])('rejects angle %j', (angle) => {
        const result = validateRevolveDraft({ axis: 'x', angle });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Angle');
        }
    });
});

describe('validatePrimitiveDraft', () => {
    it('accepts a box on the default datum', () => {
        const result = validatePrimitiveDraft({ shape: 'box', dimensions: ['2', '3', '4'], datumId: '' }, []);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toEqual({ shape: 'box', dimensions: [2, 3, 4] });
        }
    });

    it('reads only the shape arity and keeps a known datum', () => {
        const doc = closureDocument();
        const result = validatePrimitiveDraft({ shape: 'sphere', dimensions: ['5', 'nope', 'nope'], datumId: 'datum-xy' }, doc.datums);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toEqual({ shape: 'sphere', dimensions: [5], datumId: 'datum-xy' });
        }
    });

    it('rejects non-positive dimensions', () => {
        const result = validatePrimitiveDraft({ shape: 'cylinder', dimensions: ['2', '0'], datumId: '' }, []);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Dimensions');
        }
    });

    it('rejects a short dimension list', () => {
        expect(validatePrimitiveDraft({ shape: 'box', dimensions: ['1'], datumId: '' }, []).ok).toBe(false);
    });

    it('rejects an unknown datum when the datum list is provided', () => {
        const result = validatePrimitiveDraft({ shape: 'box', dimensions: ['1', '2', '3'], datumId: 'missing' }, closureDocument().datums);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('missing');
        }
    });

    it('passes a datum through opaquely without the datum list', () => {
        const result = validatePrimitiveDraft({ shape: 'box', dimensions: ['1', '2', '3'], datumId: 'datum-custom' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toMatchObject({ datumId: 'datum-custom' });
        }
    });
});

describe('buildFeaturePreviewDocument modifier retarget', () => {
    it('retargets a fillet draft onto the referenced body with its full chain', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'fillet',
            params: { edges: [edgeRef('f2')], radius: 1 },
            bodyId: 'b1'
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        // The whole b1 chain (f1..f11) replays so the edge fingerprint resolves;
        // f10 names tool body b2, so b2's chain (f12) rides along too rather
        // than replaying the boolean against an empty tool body.
        expect(preview.features.map((f) => f.id)).toEqual([
            'f1',
            'f2',
            'f3',
            'f4',
            'f5',
            'f6',
            'f7',
            'f8',
            'f9',
            'f10',
            'f11',
            'f12',
            'preview-feature'
        ]);
        const draft = preview.features[preview.features.length - 1];
        expect(draft.type).toBe('fillet');
        expect(draft.body).toBe('b1');
        expect(preview.bodies.map((b) => b.id)).toEqual(['b1', 'b2', 'preview-body']);
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('retargets a pocket draft onto its body', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'pocket',
            sketchId: 'sk3',
            params: { length: 2 },
            bodyId: 'b1'
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        const draft = preview.features[preview.features.length - 1];
        expect(draft.type).toBe('pocket');
        expect(draft.body).toBe('b1');
        expect(draft.sketchId).toBe('sk3');
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('keeps a pocket without a body on preview-body', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'pocket',
            sketchId: 'sk3',
            params: { length: 2 }
        });
        expect(preview?.features[preview.features.length - 1].body).toBe('preview-body');
    });

    it('retargets a booleanFuse onto the target body with both chains', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'booleanFuse',
            params: { targetBody: 'b1', toolBodies: ['b2'] }
        });
        expect(preview).toBeDefined();
        if (preview === undefined) {
            return;
        }
        // b2's primitive chain rides along with b1's so the tools exist.
        expect(preview.features.map((f) => f.id)).toContain('f12');
        const draft = preview.features[preview.features.length - 1];
        expect(draft.body).toBe('b1');
        expect(preview.bodies.map((b) => b.id)).toContain('b2');
        expect(validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('retargets a hole onto its body', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'hole',
            params: { face: faceRef('f1'), center: [0, 0], diameter: 5 },
            bodyId: 'b1'
        });
        expect(preview?.features[preview.features.length - 1].body).toBe('b1');
        expect(preview !== undefined && validateNukeCadDocument(preview).valid).toBe(true);
    });

    it('falls back to preview-body when the named body is absent', () => {
        const preview = buildFeaturePreviewDocument(closureDocument(), {
            type: 'fillet',
            params: { edges: [edgeRef('f2')], radius: 1 },
            bodyId: 'nope'
        });
        expect(preview?.features[preview.features.length - 1].body).toBe('preview-body');
    });
});
