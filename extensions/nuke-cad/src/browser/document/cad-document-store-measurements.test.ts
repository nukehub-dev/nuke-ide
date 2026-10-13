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
import { CadDocumentStore, RESULT_CACHE_BUILDER_VERSION, RESULT_CACHE_OCP_UNKNOWN, computeResultCacheKeys } from './cad-document-store';
import {
    NUKE_CAD_SCHEMA_VERSION,
    migrateNukeCadDocument,
    validateNukeCadDocument,
    type NukeCadDocument,
    type SavedMeasurement
} from '../../common/cad-document';
import { generatePythonScript } from '../../common/python-codegen';
import {
    createMeasureAngle,
    createMeasureRadius,
    createMeasureSegment,
    fromSavedMeasurement,
    restoreSavedMeasurements,
    toSavedMeasurement,
    type Measurement
} from '../widgets/cad-viewport/measure-tool';

function minimalDoc(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [],
        features: [],
        curves: []
    };
}

function savedDistance(id = 'measurement-1'): SavedMeasurement {
    return {
        id,
        kind: 'distance',
        points: [
            [0, 0, 0],
            [3, 4, 0]
        ],
        label: '5',
        createdAt: '2026-10-13T00:00:00.000Z'
    };
}

function storeWithDoc(doc: NukeCadDocument = minimalDoc()): CadDocumentStore {
    const store = new CadDocumentStore();
    const loaded = store.loadDocument(doc);
    expect(loaded.success).toBe(true);
    return store;
}

describe('saved-measurement schema', () => {
    it('treats an absent block as none (valid, v3, no migration)', () => {
        expect(validateNukeCadDocument(minimalDoc()).valid).toBe(true);
        const migrated = migrateNukeCadDocument(minimalDoc());
        expect(migrated.migratedFrom).toBeUndefined();
        expect(migrated.document.measurements).toBeUndefined();
    });

    it('migrates v2 to v3 without a measurements block', () => {
        const v2 = { ...minimalDoc(), version: 2 } as unknown as Record<string, unknown>;
        delete v2.curves;
        const migrated = migrateNukeCadDocument(v2);
        expect(migrated.document.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(migrated.migratedFrom).toBe(2);
        expect(migrated.document.measurements).toBeUndefined();
    });

    it('accepts one entry per kind', () => {
        const doc = minimalDoc();
        doc.measurements = [
            savedDistance(),
            {
                id: 'measurement-2',
                kind: 'angle',
                points: [
                    [1, 0, 0],
                    [0, 0, 0],
                    [0, 1, 0]
                ],
                label: '90°',
                createdAt: '2026-10-13T00:00:00.000Z'
            },
            {
                id: 'measurement-3',
                kind: 'radius',
                points: [
                    [1, 2, 3],
                    [3.5, 2, 3]
                ],
                label: 'R 2.5',
                createdAt: '2026-10-13T00:00:00.000Z'
            }
        ];
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('rejects unknown kinds', () => {
        const doc = minimalDoc();
        doc.measurements = [{ ...savedDistance(), kind: 'volume' as 'distance' }];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((issue) => issue.path === 'measurements[0].kind')).toBe(true);
    });

    it('rejects wrong point counts per kind', () => {
        for (const entry of [
            { ...savedDistance(), points: [[0, 0, 0]] },
            {
                ...savedDistance(),
                kind: 'angle' as const,
                points: [
                    [0, 0, 0],
                    [1, 0, 0]
                ]
            },
            {
                ...savedDistance(),
                kind: 'radius' as const,
                points: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [2, 0, 0]
                ]
            }
        ]) {
            const doc = minimalDoc();
            doc.measurements = [entry as unknown as SavedMeasurement];
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((issue) => issue.path === 'measurements[0].points')).toBe(true);
        }
    });

    it('rejects non-finite points, non-string labels, and empty timestamps', () => {
        const bad: SavedMeasurement[] = [
            {
                ...savedDistance(),
                points: [
                    [0, 0, Infinity],
                    [1, 0, 0]
                ]
            },
            { ...savedDistance(), label: 5 as unknown as string },
            { ...savedDistance(), createdAt: '' }
        ];
        for (const entry of bad) {
            const doc = minimalDoc();
            doc.measurements = [entry];
            expect(validateNukeCadDocument(doc).valid).toBe(false);
        }
    });

    it('rejects duplicate measurement ids', () => {
        const doc = minimalDoc();
        doc.measurements = [savedDistance('measurement-1'), savedDistance('measurement-1')];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((issue) => issue.path === 'measurements[1].id')).toBe(true);
    });
});

describe('saved-measurement store mutations', () => {
    it('pins measurements with generated ids through the normal commit path', () => {
        const store = storeWithDoc();
        let changes = 0;
        store.onChange(() => {
            changes += 1;
        });
        const before = store.drawingVersion;
        const result = store.addMeasurement({
            kind: 'distance',
            points: [
                [0, 0, 0],
                [3, 4, 0]
            ],
            label: '5'
        });
        expect(result.success).toBe(true);
        expect(result.value).toMatch(/^measurement-/);
        expect(store.document!.measurements).toHaveLength(1);
        expect(store.document!.measurements![0].label).toBe('5');
        expect(store.document!.measurements![0].createdAt.length).toBeGreaterThan(0);
        expect(store.dirty).toBe(true);
        expect(changes).toBe(1);
        // Pinning is annotation state: it never bumps the drawing version.
        expect(store.drawingVersion).toBe(before);
    });

    it('copies points so later caller edits cannot corrupt the stored entry', () => {
        const store = storeWithDoc();
        const points: [number, number, number][] = [
            [0, 0, 0],
            [3, 4, 0]
        ];
        const result = store.addMeasurement({ kind: 'distance', points, label: '5' });
        expect(result.success).toBe(true);
        points[0][0] = 999;
        expect(store.document!.measurements![0].points[0]).toEqual([0, 0, 0]);
    });

    it('rejects unknown kinds, wrong arity, and non-finite points before commit', () => {
        const store = storeWithDoc();
        expect(
            store.addMeasurement({
                kind: 'volume' as 'distance',
                points: [
                    [0, 0, 0],
                    [1, 0, 0]
                ],
                label: 'x'
            }).success
        ).toBe(false);
        expect(store.addMeasurement({ kind: 'distance', points: [[0, 0, 0]], label: 'x' }).success).toBe(false);
        expect(
            store.addMeasurement({
                kind: 'angle',
                points: [
                    [0, 0, 0],
                    [1, 0, 0]
                ],
                label: 'x'
            }).success
        ).toBe(false);
        expect(
            store.addMeasurement({
                kind: 'distance',
                points: [
                    [0, 0, Infinity],
                    [1, 0, 0]
                ],
                label: 'x'
            }).success
        ).toBe(false);
        expect(
            store.addMeasurement({
                kind: 'distance',
                points: [
                    [0, 0, 0],
                    [1, 0, 0]
                ],
                label: 5 as unknown as string
            }).success
        ).toBe(false);
        expect(store.document!.measurements).toBeUndefined();
        expect(store.canUndo).toBe(false);
    });

    it('rejects duplicate ids', () => {
        const store = storeWithDoc();
        const first = store.addMeasurement({
            id: 'measurement-keep',
            kind: 'distance',
            points: [
                [0, 0, 0],
                [1, 0, 0]
            ],
            label: '1'
        });
        expect(first.success).toBe(true);
        const second = store.addMeasurement({
            id: 'measurement-keep',
            kind: 'distance',
            points: [
                [0, 0, 0],
                [2, 0, 0]
            ],
            label: '2'
        });
        expect(second.success).toBe(false);
        expect(store.document!.measurements).toHaveLength(1);
    });

    it('unpins by id and rejects unknown ids', () => {
        const store = storeWithDoc();
        const id = store.addMeasurement({
            kind: 'distance',
            points: [
                [0, 0, 0],
                [1, 0, 0]
            ],
            label: '1'
        }).value!;
        expect(store.removeMeasurement('measurement-missing').success).toBe(false);
        expect(store.removeMeasurement(id).success).toBe(true);
        expect(store.document!.measurements).toHaveLength(0);
    });

    it('covers pin and unpin with undo/redo', () => {
        const store = storeWithDoc();
        const id = store.addMeasurement({
            kind: 'distance',
            points: [
                [0, 0, 0],
                [1, 0, 0]
            ],
            label: '1'
        }).value!;
        expect(store.canUndo).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.measurements).toBeUndefined();
        expect(store.canRedo).toBe(true);
        expect(store.redo().success).toBe(true);
        expect(store.document!.measurements).toHaveLength(1);
        expect(store.removeMeasurement(id).success).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.measurements!.map((m) => m.id)).toEqual([id]);
    });

    it('persists the block through serialization', () => {
        const store = storeWithDoc();
        store.addMeasurement({
            kind: 'distance',
            points: [
                [0, 0, 0],
                [1, 0, 0]
            ],
            label: '1'
        });
        const parsed = JSON.parse(store.toJson()!) as NukeCadDocument;
        expect(parsed.measurements).toHaveLength(1);
        expect(validateNukeCadDocument(parsed).valid).toBe(true);
    });
});

describe('saved-measurement overlay conversion', () => {
    it('round-trips distance segments with their endpoints', () => {
        const segment = createMeasureSegment('m1', 'model3d', [0, 0, 0], [3, 4, 0]);
        const saved = toSavedMeasurement(segment);
        expect(saved.kind).toBe('distance');
        expect(saved.points).toEqual([
            [0, 0, 0],
            [3, 4, 0]
        ]);
        expect(saved.label).toBe('5');
        const restored = fromSavedMeasurement(saved)!;
        expect(restored.id).toBe('m1');
        expect((restored as { distance: number }).distance).toBe(5);
    });

    it('round-trips angle triples with the vertex angle', () => {
        const angle = createMeasureAngle('m2', 'model3d', [1, 0, 0], [0, 0, 0], [0, 1, 0]);
        const restored = fromSavedMeasurement(toSavedMeasurement(angle))!;
        expect((restored as { angle: number }).angle).toBeCloseTo(90, 12);
    });

    it('round-trips radius via center plus rim point', () => {
        const radius = createMeasureRadius('m3', [1, 2, 3], 2.5);
        const saved = toSavedMeasurement(radius);
        expect(saved.kind).toBe('radius');
        expect(saved.points).toEqual([
            [1, 2, 3],
            [3.5, 2, 3]
        ]);
        const restored = fromSavedMeasurement(saved)!;
        expect((restored as { radius: number }).radius).toBeCloseTo(2.5, 12);
        expect((restored as { diameter: number }).diameter).toBeCloseTo(5, 12);
    });

    it('restores every entry as a model3d overlay measurement', () => {
        const restored = restoreSavedMeasurements([savedDistance()]);
        expect(restored).toHaveLength(1);
        expect(restored[0].kind).toBe('model3d');
    });

    it('skips malformed entries and treats absent as none', () => {
        expect(restoreSavedMeasurements(undefined)).toEqual([]);
        const malformed: SavedMeasurement[] = [
            { ...savedDistance(), points: [[0, 0, 0]] },
            { ...savedDistance(), kind: 'orbit' as 'distance' },
            {
                ...savedDistance(),
                points: [
                    [0, 0, NaN],
                    [1, 0, 0]
                ]
            }
        ];
        expect(restoreSavedMeasurements(malformed)).toEqual([]);
        expect(restoreSavedMeasurements([savedDistance(), ...malformed])).toHaveLength(1);
    });

    it('re-renders pinned entries from the store after a rebuild clears the session list', () => {
        const store = storeWithDoc();
        // The session list holds one unpinned ephemeral entry plus the pinned one.
        const ephemeral: Measurement[] = [createMeasureSegment('measure-9', 'model3d', [0, 0, 0], [1, 0, 0])];
        const pinned = toSavedMeasurement(createMeasureSegment('measure-1', 'model3d', [0, 0, 0], [3, 4, 0]));
        const savedId = store.addMeasurement({ kind: pinned.kind, points: [...pinned.points], label: pinned.label }).value!;
        expect(ephemeral).toHaveLength(1);
        // Rebuild: the session list is dropped and only the store block restores.
        const restored = restoreSavedMeasurements(store.document?.measurements);
        expect(restored.map((m) => m.id)).toEqual([savedId]);
        expect((restored[0] as { distance: number }).distance).toBe(5);
    });
});

describe('saved measurements never reach backend inputs', () => {
    const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };

    function docWithMeasurements(): NukeCadDocument {
        const doc = minimalDoc();
        doc.measurements = [
            { ...savedDistance(), id: 'measurement-sentinel', label: 'MEASUREMENT-SENTINEL-42' },
            {
                id: 'measurement-2',
                kind: 'angle',
                points: [
                    [1, 0, 0],
                    [0, 0, 0],
                    [0, 1, 0]
                ],
                label: 'MEASUREMENT-SENTINEL-ANGLE',
                createdAt: '2026-10-13T00:00:00.000Z'
            }
        ];
        return doc;
    }

    it('leaves the exported Python script byte-identical', () => {
        expect(generatePythonScript(docWithMeasurements())).toBe(generatePythonScript(minimalDoc()));
        expect(generatePythonScript(docWithMeasurements())).not.toContain('SENTINEL');
    });

    it('leaves result-cache content keys unchanged', () => {
        expect(computeResultCacheKeys(docWithMeasurements(), versions)).toEqual(computeResultCacheKeys(minimalDoc(), versions));
    });
});
