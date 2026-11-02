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
import {
    findOpenmcRegionBlockers,
    normalizeDagmcGroup,
    parseOpenmcRegionReferences,
    type OpenmcReferenceSnapshot
} from './openmc-region-references';
import type { TopologyChangedRegion, TopologyRegionRef } from './topology-impact';

const PROJECT_PATH = '/workspace/pincell.nuke-openmc';

const PROJECT = {
    version: '1.2.0',
    state: {
        settings: {
            dagmcFile: 'cad/geometry.h5m',
            dagmcInfo: {
                filePath: 'cad/geometry.h5m',
                materials: {
                    fuel: { volumeCount: 1, totalTriangles: 120 },
                    clad: { volumeCount: 1, totalTriangles: 80 },
                    'mat:graveyard': { volumeCount: 1, totalTriangles: 20 }
                },
                volumes: [
                    { id: 1, material: 'fuel', numTriangles: 120 },
                    { id: 2, material: 'clad', numTriangles: 80 },
                    { id: 3, material: 'graveyard', numTriangles: 20 }
                ]
            }
        },
        materials: [
            { id: 1, name: 'fuel', density: 10.4, densityUnit: 'g/cm3', nukeCadMaterialId: 'cad-material-fuel' },
            { id: 2, name: 'clad', density: 6.5, densityUnit: 'g/cm3', nukeCadMaterialId: 'cad-material-clad' },
            { id: 3, name: 'Graveyard', density: 0, densityUnit: 'g/cm3', nukeCadMaterialId: 'cad-material-graveyard' }
        ]
    }
};

const SNAPSHOT = parseOpenmcRegionReferences(PROJECT_PATH, JSON.stringify(PROJECT));

function volume(selector: string, group: string, material?: string, materialId?: string): TopologyRegionRef {
    return {
        kind: 'volume',
        selector,
        group,
        ...(material !== undefined ? { material } : {}),
        ...(materialId !== undefined ? { materialId } : {}),
        solidIds: [1]
    };
}

function changedRegion(
    overrides: Partial<TopologyChangedRegion> & Pick<TopologyChangedRegion, 'selector' | 'beforeGroup' | 'afterGroup'>
): TopologyChangedRegion {
    return {
        group: overrides.afterGroup,
        beforeSolidIds: [1],
        afterSolidIds: [1],
        ...overrides
    };
}

function savedSnapshot(overrides: Partial<OpenmcReferenceSnapshot> = {}): OpenmcReferenceSnapshot {
    return {
        status: 'saved-project',
        projectPath: PROJECT_PATH,
        dagmcGroups: ['fuel', 'clad'],
        materialNames: ['fuel', 'clad'],
        materialIds: ['cad-material-fuel', 'cad-material-clad'],
        warnings: [],
        ...overrides
    };
}

describe('parseOpenmcRegionReferences', () => {
    it('reads DAGMC groups and material provenance from a wrapped project state', () => {
        expect(SNAPSHOT).toEqual({
            status: 'saved-project',
            projectPath: PROJECT_PATH,
            dagmcFile: 'cad/geometry.h5m',
            dagmcGroups: ['fuel', 'clad'],
            materialNames: ['fuel', 'clad'],
            materialIds: ['cad-material-fuel', 'cad-material-clad'],
            warnings: []
        });
    });

    it('accepts a raw state object from older files', () => {
        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, JSON.stringify(PROJECT.state));

        expect(snapshot.status).toBe('saved-project');
        expect(snapshot.dagmcFile).toBe('cad/geometry.h5m');
        expect(snapshot.dagmcGroups).toEqual(['fuel', 'clad']);
        expect(snapshot.materialNames).toEqual(['fuel', 'clad']);
    });

    it('tolerates an unknown schema version', () => {
        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, JSON.stringify({ ...PROJECT, version: '99.0.0' }));

        expect(snapshot.status).toBe('saved-project');
        expect(snapshot.dagmcGroups).toEqual(['fuel', 'clad']);
    });

    it('trims and dedupes groups and material keys while ignoring graveyard', () => {
        const json = JSON.stringify({
            state: {
                settings: {
                    dagmcInfo: {
                        materials: { ' fuel ': {}, fuel: {}, 'mat:graveyard': {}, Graveyard: {} },
                        volumes: [{ material: ' fuel ' }, { material: 'clad' }, { material: 'fuel' }, { material: '' }]
                    }
                },
                materials: [
                    { name: ' fuel ', nukeCadMaterialId: ' cad-a ' },
                    { name: 'fuel', nukeCadMaterialId: 'cad-a' },
                    { name: 'Graveyard', nukeCadMaterialId: 'cad-material-graveyard' },
                    { name: '', nukeCadMaterialId: '' }
                ]
            }
        });

        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, json);

        expect(snapshot.dagmcGroups).toEqual(['fuel', 'clad']);
        expect(snapshot.materialNames).toEqual(['fuel']);
        expect(snapshot.materialIds).toEqual(['cad-a']);
    });

    it('falls back to dagmcInfo.filePath when settings.dagmcFile is absent', () => {
        const json = JSON.stringify({
            state: {
                settings: {
                    dagmcInfo: {
                        filePath: 'cad/fallback.h5m',
                        materials: {},
                        volumes: []
                    }
                }
            }
        });

        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, json);

        expect(snapshot.dagmcFile).toBe('cad/fallback.h5m');
        expect(snapshot.dagmcGroups).toEqual([]);
    });

    it('returns empty reference sets when the project has no DAGMC data', () => {
        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, JSON.stringify({ version: '1.2.0', state: { materials: [] } }));

        expect(snapshot).toEqual({
            status: 'saved-project',
            projectPath: PROJECT_PATH,
            dagmcGroups: [],
            materialNames: [],
            materialIds: [],
            warnings: []
        });
    });

    it('returns invalid-project for malformed JSON without throwing', () => {
        expect(() => parseOpenmcRegionReferences(PROJECT_PATH, '{')).not.toThrow();
        const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, '{');

        expect(snapshot.status).toBe('invalid-project');
        expect(snapshot.projectPath).toBe(PROJECT_PATH);
        expect(snapshot.dagmcGroups).toEqual([]);
        expect(snapshot.materialNames).toEqual([]);
        expect(snapshot.materialIds).toEqual([]);
        expect(snapshot.warnings).toHaveLength(1);
        expect(snapshot.warnings[0]).toContain('not valid JSON');
    });

    it('returns invalid-project for non-object payloads and unreadable state', () => {
        for (const json of ['null', '[]', '"text"']) {
            const snapshot = parseOpenmcRegionReferences(PROJECT_PATH, json);
            expect(snapshot.status).toBe('invalid-project');
            expect(snapshot.warnings[0]).toContain('does not contain a JSON object');
        }

        const wrapped = parseOpenmcRegionReferences(PROJECT_PATH, JSON.stringify({ version: '1.2.0', state: 42 }));
        expect(wrapped.status).toBe('invalid-project');
        expect(wrapped.warnings[0]).toContain('no readable state object');
    });
});

describe('normalizeDagmcGroup', () => {
    it('trims and removes a mat tag prefix without changing case', () => {
        expect(normalizeDagmcGroup('  mat:fuel  ')).toBe('fuel');
        expect(normalizeDagmcGroup('MAT: clad')).toBe('clad');
        expect(normalizeDagmcGroup('Clad')).toBe('Clad');
        expect(normalizeDagmcGroup('   ')).toBe('');
    });
});

describe('findOpenmcRegionBlockers', () => {
    it('blocks a removed group that the project still references', () => {
        const blockers = findOpenmcRegionBlockers({ removedRegions: [volume('clad', 'clad', 'clad')], changedRegions: [] }, [], SNAPSHOT);

        expect(blockers).toHaveLength(2);
        expect(blockers[0]).toMatchObject({ kind: 'dagmc-group', reference: 'clad' });
        expect(blockers[0].region.selector).toBe('clad');
        expect(blockers[0].message).toBe("OpenMC material 'clad' still references DAGMC group 'clad'.");
        expect(blockers[1]).toMatchObject({ kind: 'material', reference: 'clad' });
    });

    it('normalizes a mat-prefixed removed group before matching', () => {
        const blockers = findOpenmcRegionBlockers({ removedRegions: [volume('clad', 'mat:clad')], changedRegions: [] }, [], SNAPSHOT);

        expect(blockers).toHaveLength(1);
        expect(blockers[0].reference).toBe('clad');
    });

    it('blocks the retired group of a changed region', () => {
        const changed = changedRegion({
            selector: 'clad',
            beforeGroup: 'clad',
            afterGroup: 'clad_v2',
            beforeMaterial: 'clad',
            afterMaterial: 'clad'
        });

        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [], changedRegions: [changed] },
            [volume('clad', 'clad_v2', 'clad')],
            SNAPSHOT
        );

        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatchObject({ kind: 'dagmc-group', reference: 'clad' });
        expect(blockers[0].region.group).toBe('clad');
        expect(blockers[0].region.solidIds).toEqual([1]);
    });

    it('does not block a retired group that another after region still uses', () => {
        const changed = changedRegion({
            selector: 'clad',
            beforeGroup: 'clad',
            afterGroup: 'clad_v2',
            beforeMaterial: 'clad',
            afterMaterial: 'clad'
        });

        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [], changedRegions: [changed] },
            [volume('clad', 'clad_v2', 'clad'), volume('legacy', 'clad', 'legacy-material')],
            SNAPSHOT
        );

        expect(blockers).toEqual([]);
    });

    it('ignores changed regions whose group and material are unchanged', () => {
        const changed = changedRegion({
            selector: 'clad',
            beforeGroup: 'clad',
            afterGroup: 'clad',
            beforeMaterial: 'clad',
            afterMaterial: 'clad',
            beforeSolidIds: [1],
            afterSolidIds: [1, 2]
        });

        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [], changedRegions: [changed] },
            [volume('clad', 'clad', 'clad')],
            SNAPSHOT
        );

        expect(blockers).toEqual([]);
    });

    it('blocks a removed region whose material name is still defined', () => {
        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [volume('legacy', 'legacy', 'fuel')], changedRegions: [] },
            [],
            SNAPSHOT
        );

        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatchObject({ kind: 'material', reference: 'fuel' });
        expect(blockers[0].message).toContain("OpenMC material 'fuel'");
        expect(blockers[0].message).toContain("region 'legacy'");
    });

    it('blocks a removed region whose nuke-cad material id is still defined', () => {
        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [volume('legacy', 'legacy', 'legacy-material', 'cad-material-fuel')], changedRegions: [] },
            [],
            SNAPSHOT
        );

        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatchObject({ kind: 'material-id', reference: 'cad-material-fuel' });
        expect(blockers[0].message).toContain("nuke-cad id 'cad-material-fuel'");
    });

    it('reports material-name and material-id references separately', () => {
        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [volume('legacy', 'legacy', 'fuel', 'cad-material-fuel')], changedRegions: [] },
            [],
            SNAPSHOT
        );

        expect(blockers.map((blocker) => blocker.kind)).toEqual(['material', 'material-id']);
    });

    it('does not block a shared material key that remains in the after regions', () => {
        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [volume('legacy', 'legacy', 'clad')], changedRegions: [] },
            [volume('other', 'other', 'clad')],
            SNAPSHOT
        );

        expect(blockers).toEqual([]);
    });

    it('blocks the old material of a changed region', () => {
        const changed = changedRegion({
            selector: 'legacy',
            beforeGroup: 'legacy',
            afterGroup: 'legacy',
            beforeMaterial: 'fuel',
            afterMaterial: 'clad'
        });

        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [], changedRegions: [changed] },
            [volume('legacy', 'legacy', 'clad')],
            SNAPSHOT
        );

        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatchObject({ kind: 'material', reference: 'fuel' });
    });

    it('deduplicates blockers by selector, reference, and kind', () => {
        const region = volume('clad', 'clad');
        const blockers = findOpenmcRegionBlockers({ removedRegions: [region, region], changedRegions: [] }, [], SNAPSHOT);

        expect(blockers).toHaveLength(1);
    });

    it('ignores surfaces and graveyard regions', () => {
        const surface: TopologyRegionRef = { kind: 'surface', selector: 'wall', group: 'clad', solidIds: [] };
        const blockers = findOpenmcRegionBlockers(
            {
                removedRegions: [surface, volume('burial', 'graveyard', 'Graveyard')],
                changedRegions: []
            },
            [],
            SNAPSHOT
        );

        expect(blockers).toEqual([]);
    });

    it('returns no blockers when no project is saved', () => {
        const blockers = findOpenmcRegionBlockers(
            { removedRegions: [volume('clad', 'clad', 'clad')], changedRegions: [] },
            [],
            savedSnapshot({ status: 'no-saved-project' })
        );

        expect(blockers).toEqual([]);
    });

    it('returns no blockers for an unreadable or invalid project', () => {
        for (const status of ['missing-project-file', 'unreadable-project', 'invalid-project'] as const) {
            const blockers = findOpenmcRegionBlockers(
                { removedRegions: [volume('clad', 'clad', 'clad')], changedRegions: [] },
                [],
                savedSnapshot({ status, warnings: ['project unavailable'] })
            );
            expect(blockers).toEqual([]);
        }
    });
});
