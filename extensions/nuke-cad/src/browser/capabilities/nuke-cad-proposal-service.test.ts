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
 * Tests the in-memory CAD feature proposal store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchDef } from '../../common/cad-document';
import type { OpenmcRegionBlocker } from '../../common/openmc-region-references';
import type { SketchSolveSummary } from '../sketch/sketch-edit-types';
import type { TopologyImpact, TopologyRegionRef } from '../../common/topology-impact';
import type { ImportSolidInfo } from '../../common/nuke-cad-protocol';
import type { ImportBodyDraft } from '../document/cad-document-store';
import {
    NUKE_CAD_FEATURE_PROPOSAL_LIMIT,
    NUKE_CAD_FEATURE_PROPOSAL_TTL_MS,
    NukeCadFeatureProposal,
    NukeCadFeatureProposalInput,
    NukeCadImportProposal,
    NukeCadImportProposalInput,
    NukeCadProposal,
    NukeCadProposalService,
    NukeCadSketchProposalInput,
    NukeCadTopologyProposal,
    NukeCadTopologyProposalInput,
    isImportProposal,
    isSketchProposal,
    isTopologyProposal
} from './nuke-cad-proposal-service';

const START = Date.parse('2026-01-01T00:00:00.000Z');
const DOCUMENT_PATH = '/workspace/project/pincell.nuke-cad';
const BASE_REVISION = 4;

class InspectableProposalService extends NukeCadProposalService {
    get size(): number {
        return this.proposals.size;
    }
}

function buildInput(summary = 'Increase the fuel pellet height'): NukeCadFeatureProposalInput {
    return {
        scope: 'features',
        summary,
        documentPath: DOCUMENT_PATH,
        documentEpoch: 12,
        baseRevision: BASE_REVISION,
        changes: [
            {
                path: 'features.fuel.params.length',
                label: 'fuel length',
                kind: 'update',
                before: 1,
                after: 1.2
            }
        ],
        edits: [{ featureId: 'fuel', featureType: 'pad', param: 'length', before: 1, after: 1.2 }],
        before: { fuel: { length: 1 } },
        after: { fuel: { length: 1.2 } }
    };
}

function sketchDef(id: string, name: string, radius: number): SketchDef {
    return {
        id,
        name,
        datumId: 'xy',
        primitives: [{ id: `${id}-circle`, type: 'circle', radius }],
        constraints: []
    };
}

function solverSummary(overrides: Partial<SketchSolveSummary> = {}): SketchSolveSummary {
    return {
        status: 'converged',
        dof: 0,
        fullyConstrained: true,
        conflicting: [],
        redundant: [],
        errorCount: 0,
        warningCount: 0,
        sketches: [],
        ...overrides
    };
}

function buildSketchInput(summary = 'Set the fuel pellet radius'): NukeCadSketchProposalInput {
    return {
        scope: 'sketch',
        summary,
        documentPath: DOCUMENT_PATH,
        documentEpoch: 12,
        baseRevision: BASE_REVISION,
        changes: [
            {
                path: 'sketches.pellet.dimensions.diameter',
                label: 'pellet diameter',
                kind: 'update',
                before: 1,
                after: 1.2
            }
        ],
        sketch: {
            targetSketchId: 'pellet',
            targetSketchName: 'Pellet profile',
            affectedSketchIds: ['pellet'],
            affectedFeatureIds: ['fuel'],
            beforeSketches: { pellet: sketchDef('pellet', 'Pellet profile', 1) },
            afterSketches: { pellet: sketchDef('pellet', 'Pellet profile', 1.2) },
            beforeParameters: { pelletDiameter: 1 },
            afterParameters: { pelletDiameter: 1.2 },
            solver: solverSummary(),
            edits: [
                {
                    kind: 'dimension',
                    sketchId: 'pellet',
                    sketchName: 'Pellet profile',
                    dimensionId: 'diameter',
                    dimensionKind: 'diameter',
                    before: 1,
                    after: 1.2,
                    affectedDimensionIds: ['diameter']
                }
            ]
        }
    };
}

function region(selector: string, solidIds: readonly number[] = [1]): TopologyRegionRef {
    return {
        kind: 'volume',
        selector,
        group: `${selector}_region`,
        name: `${selector}_region`,
        material: 'steel',
        materialId: `material-${selector}`,
        solidIds
    };
}

function topologyImpact(overrides: Partial<TopologyImpact> = {}): TopologyImpact {
    return {
        solids: { before: 2, after: 3 },
        faces: { before: 20, after: 28 },
        triangles: { before: 800, after: 1000 },
        addedSolidIds: [3],
        removedSolidIds: [],
        changedSolidIds: [1, 2],
        addedRegions: [region('insert')],
        removedRegions: [],
        changedRegions: [],
        addedGroups: ['insert_region'],
        removedGroups: [],
        selectorMapChanged: true,
        regionCoverageChanged: true,
        requiresAcknowledgement: true,
        ...overrides
    };
}

function buildTopologyInput(summary = 'Open the coolant hole through the wall'): NukeCadTopologyProposalInput {
    return {
        scope: 'topology',
        summary,
        documentPath: DOCUMENT_PATH,
        documentEpoch: 12,
        baseRevision: BASE_REVISION,
        changes: [
            {
                path: 'features.coolant.params.depth',
                label: 'Feature coolant hole depth',
                kind: 'remove',
                before: 2,
                after: undefined
            }
        ],
        topology: {
            actions: [{ featureId: 'coolant', action: 'holeDepthMode', mode: 'through' }],
            before: { coolant: { diameter: 1, depth: 2 } },
            after: { coolant: { diameter: 1 } },
            topology: topologyImpact(),
            afterRegions: [region('fuel'), region('insert')],
            blockedRegions: [],
            openmcStatus: 'saved-project',
            openmcProjectPath: '/workspace/project/pincell.nuke-openmc',
            openmcWarnings: []
        }
    };
}

function importSolid(index: number, name: string): ImportSolidInfo {
    return {
        index,
        name,
        faceCount: 6,
        volume: index * 10,
        bboxMin: [0, 0, 0],
        bboxMax: [index, 1, 1],
        center: [index / 2, 0.5, 0.5]
    };
}

function importDraft(name: string): ImportBodyDraft {
    return {
        name,
        label: name,
        material: 'steel',
        params: {
            sourcePath: './gui_pincell.step',
            sourceHash: 'a'.repeat(64),
            sourceSize: 4096,
            sourceFormat: 'step',
            selection: { mode: 'solids', solids: [{ index: 1, signature: { faceCount: 6, volume: 10 } }] }
        }
    };
}

function buildImportInput(summary = 'Import 2 solids from gui_pincell.step as 2 bodies'): NukeCadImportProposalInput {
    return {
        scope: 'import',
        summary,
        documentPath: DOCUMENT_PATH,
        documentEpoch: 12,
        baseRevision: BASE_REVISION,
        changes: [
            { path: 'bodies.fuel', label: 'Body fuel', kind: 'add', after: 'fuel' },
            { path: 'bodies.clad', label: 'Body clad', kind: 'add', after: 'clad' }
        ],
        import: {
            source: {
                path: '/workspace/project/gui_pincell.step',
                sourceHash: 'a'.repeat(64),
                sourceSize: 4096,
                sourceFormat: 'step',
                fileUnit: 'mm',
                effectiveUnit: 'mm',
                unitScaleFactor: 1,
                unitsMessage: 'The source declares millimetres.',
                sourceUnit: 'mm'
            },
            documentUnits: 'mm',
            strategy: 'perSolid',
            label: 'gui_pincell',
            solidCount: 3,
            solidIndexes: [1, 2],
            selectedSolids: [importSolid(1, 'fuel'), importSolid(2, 'clad')],
            drafts: [importDraft('fuel'), importDraft('clad')],
            bodies: [
                { name: 'fuel', label: 'fuel', material: 'steel', featureName: 'fuel' },
                { name: 'clad', label: 'clad', material: 'steel', featureName: 'clad' }
            ],
            warnings: ['No material tag was set.']
        }
    };
}

function blocker(): OpenmcRegionBlocker {
    const blocked = region('fuel', [1]);
    return {
        region: blocked,
        reference: 'steel',
        kind: 'material',
        message: "OpenMC material 'steel' still references region 'fuel'."
    };
}

function featureProposal(proposal: NukeCadProposal | undefined): NukeCadFeatureProposal {
    if (proposal === undefined || proposal.scope !== 'features') {
        throw new Error('Expected a feature proposal');
    }
    return proposal;
}

function topologyProposal(proposal: NukeCadProposal | undefined): NukeCadTopologyProposal {
    if (proposal === undefined || proposal.scope !== 'topology') {
        throw new Error('Expected a topology proposal');
    }
    return proposal;
}

function importProposal(proposal: NukeCadProposal | undefined): NukeCadImportProposal {
    if (proposal === undefined || proposal.scope !== 'import') {
        throw new Error('Expected an import proposal');
    }
    return proposal;
}

function advance(milliseconds: number): void {
    vi.setSystemTime(Date.now() + milliseconds);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('NukeCadProposalService', () => {
    it('creates a proposal bound to the previewed document revision', () => {
        const service = new NukeCadProposalService();
        const proposal = service.create(buildInput());

        expect(proposal).toEqual({ ...buildInput(), id: expect.any(String), createdAt: START });
        expect(proposal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(proposal.scope).toBe('features');
        expect(proposal.documentPath).toBe(DOCUMENT_PATH);
        expect(proposal.documentEpoch).toBe(12);
        expect(proposal.baseRevision).toBe(BASE_REVISION);
        expect(proposal.createdAt).toBe(START);
        expect(service.has(proposal.id)).toBe(true);
        expect(service.get(proposal.id)).toEqual(proposal);
    });

    it('returns detached clones on create and on every read', () => {
        const service = new NukeCadProposalService();
        const input = buildInput();
        const created = service.create(input);

        input.before.fuel = { length: 99 };
        input.after.fuel = { length: 99 };
        (input.changes[0] as { after?: unknown }).after = 99;
        (input.edits[0] as { after?: number }).after = 99;
        (input as { summary: string }).summary = 'Mutated input';

        (created.before.fuel as { length?: number }).length = 99;
        (created.after.fuel as { length?: number }).length = 99;
        (created.changes[0] as { after?: unknown }).after = 99;
        (created.edits[0] as { after?: number }).after = 99;
        (created as { summary: string }).summary = 'Mutated return';

        const stored = featureProposal(service.get(created.id));
        expect(stored.summary).toBe('Increase the fuel pellet height');
        expect(stored.before).toEqual({ fuel: { length: 1 } });
        expect(stored.after).toEqual({ fuel: { length: 1.2 } });
        expect(stored.changes[0].after).toBe(1.2);
        expect(stored.edits[0].after).toBe(1.2);

        (stored.before.fuel as { length?: number }).length = 123;
        (stored.after.fuel as { length?: number }).length = 123;
        (stored.changes[0] as { after?: unknown }).after = 123;
        (stored.edits[0] as { after?: number }).after = 123;

        const reread = featureProposal(service.get(created.id));
        expect(reread.before).toEqual({ fuel: { length: 1 } });
        expect(reread.after).toEqual({ fuel: { length: 1.2 } });
        expect(reread.changes[0].after).toBe(1.2);
        expect(reread.edits[0].after).toBe(1.2);
        expect(service.get(created.id)).not.toBe(service.get(created.id));
    });

    it('reports presence and removes proposals by id', () => {
        const service = new NukeCadProposalService();
        const proposal = service.create(buildInput());

        expect(service.has(proposal.id)).toBe(true);
        service.remove(proposal.id);
        expect(service.has(proposal.id)).toBe(false);
        expect(service.get(proposal.id)).toBeUndefined();
        expect(() => service.remove(proposal.id)).not.toThrow();
    });

    it('expires proposals at the ten-minute TTL', () => {
        const service = new NukeCadProposalService();
        const proposal = service.create(buildInput());

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS - 1);
        expect(service.has(proposal.id)).toBe(true);
        expect(service.get(proposal.id)).toBeDefined();

        advance(1);
        expect(service.has(proposal.id)).toBe(false);
        expect(service.get(proposal.id)).toBeUndefined();
    });

    it('prunes expired proposals on demand', () => {
        const service = new InspectableProposalService();
        const proposal = service.create(buildInput());

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS - 1);
        expect(service.size).toBe(1);

        advance(1);
        service.prune();
        expect(service.size).toBe(0);
        expect(service.get(proposal.id)).toBeUndefined();
    });

    it('prunes expired proposals before creating a new one', () => {
        const service = new InspectableProposalService();
        const first = service.create(buildInput('First'));

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS);
        const second = service.create(buildInput('Second'));

        expect(service.size).toBe(1);
        expect(service.get(first.id)).toBeUndefined();
        expect(service.get(second.id)?.summary).toBe('Second');
    });

    it('keeps at most twenty proposals and evicts the oldest', () => {
        const service = new InspectableProposalService();
        const ids: string[] = [];
        for (let index = 0; index < NUKE_CAD_FEATURE_PROPOSAL_LIMIT + 1; index++) {
            ids.push(service.create(buildInput(`Change ${index + 1}`)).id);
        }

        expect(service.size).toBe(NUKE_CAD_FEATURE_PROPOSAL_LIMIT);
        expect(service.has(ids[0])).toBe(false);
        for (const id of ids.slice(1)) {
            expect(service.has(id)).toBe(true);
        }
        expect(service.get(ids[1])?.summary).toBe('Change 2');
        expect(service.get(ids[NUKE_CAD_FEATURE_PROPOSAL_LIMIT])?.summary).toBe(`Change ${NUKE_CAD_FEATURE_PROPOSAL_LIMIT + 1}`);
    });

    it('lists live proposals as detached clones', () => {
        const service = new NukeCadProposalService();
        const first = service.create(buildInput('First'));
        const second = service.create(buildInput('Second'));

        const listed = service.list();
        expect(listed.map((proposal) => proposal.id)).toEqual([first.id, second.id]);
        expect(listed[0]).not.toBe(first);
        expect(listed[1]).not.toBe(second);

        (listed[0] as { summary: string }).summary = 'Mutated list entry';
        expect(service.get(first.id)?.summary).toBe('First');
        expect(service.list()[0].summary).toBe('First');
        expect(service.list()).not.toBe(service.list());
    });

    it('fires on create and on remove only when the set changes', () => {
        const service = new NukeCadProposalService();
        const onChange = vi.fn();
        const subscription = service.onDidChange(onChange);

        const first = service.create(buildInput('First'));
        expect(onChange).toHaveBeenCalledTimes(1);

        const second = service.create(buildInput('Second'));
        expect(onChange).toHaveBeenCalledTimes(2);

        service.remove(first.id);
        expect(onChange).toHaveBeenCalledTimes(3);

        service.remove(first.id);
        expect(onChange).toHaveBeenCalledTimes(3);

        service.remove(second.id);
        expect(onChange).toHaveBeenCalledTimes(4);

        subscription.dispose();
    });

    it('announces expiry only through an explicit prune', () => {
        const service = new InspectableProposalService();
        const onChange = vi.fn();
        service.onDidChange(onChange);

        service.create(buildInput('First'));
        expect(onChange).toHaveBeenCalledTimes(1);

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS);
        service.prune();
        expect(service.size).toBe(0);
        expect(onChange).toHaveBeenCalledTimes(2);

        service.prune();
        expect(onChange).toHaveBeenCalledTimes(2);

        service.create(buildInput('Second'));
        expect(onChange).toHaveBeenCalledTimes(3);

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS);
        service.create(buildInput('Third'));
        expect(service.size).toBe(1);
        expect(onChange).toHaveBeenCalledTimes(4);
    });

    it('expires proposals silently during get and has', () => {
        const service = new InspectableProposalService();
        const onChange = vi.fn();
        service.onDidChange(onChange);

        const proposal = service.create(buildInput());
        expect(onChange).toHaveBeenCalledTimes(1);

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS);
        expect(service.has(proposal.id)).toBe(false);
        expect(service.get(proposal.id)).toBeUndefined();
        expect(service.size).toBe(0);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('expires proposals silently during list', () => {
        const service = new InspectableProposalService();
        const onChange = vi.fn();
        service.onDidChange(onChange);

        service.create(buildInput());
        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS);

        expect(service.list()).toEqual([]);
        expect(service.size).toBe(0);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('keeps impact and build metadata through clone round trips', () => {
        const service = new NukeCadProposalService();
        const input: NukeCadFeatureProposalInput = {
            ...buildInput('Imprint the pellet'),
            impact: {
                solids: { before: 2, after: 3 },
                faces: { before: 13, after: 21 },
                triangles: { before: 800, after: 1200 },
                boundingBox: {
                    before: { min: [0, 0, 0], max: [1, 1, 1] },
                    after: { min: [-1, -1, -1], max: [2, 2, 2] }
                }
            },
            build: { success: true, solidCount: 3, faceCount: 21, triangleCount: 1200 }
        };
        const impact = input.impact!;
        const build = input.build!;

        const created = service.create(input);
        (impact.solids as { before: number }).before = 99;
        impact.boundingBox.before!.min[0] = 99;
        (build as { success: boolean }).success = false;
        (build as { solidCount: number }).solidCount = 99;

        expect(created.impact).toEqual({
            solids: { before: 2, after: 3 },
            faces: { before: 13, after: 21 },
            triangles: { before: 800, after: 1200 },
            boundingBox: {
                before: { min: [0, 0, 0], max: [1, 1, 1] },
                after: { min: [-1, -1, -1], max: [2, 2, 2] }
            }
        });
        expect(created.build).toEqual({ success: true, solidCount: 3, faceCount: 21, triangleCount: 1200 });

        created.impact!.boundingBox.after!.max[0] = 42;
        (created.build as { triangleCount: number }).triangleCount = 42;

        const stored = service.get(created.id)!;
        expect(stored.impact).toEqual({
            solids: { before: 2, after: 3 },
            faces: { before: 13, after: 21 },
            triangles: { before: 800, after: 1200 },
            boundingBox: {
                before: { min: [0, 0, 0], max: [1, 1, 1] },
                after: { min: [-1, -1, -1], max: [2, 2, 2] }
            }
        });
        expect(stored.build).toEqual({ success: true, solidCount: 3, faceCount: 21, triangleCount: 1200 });
        expect(stored).not.toBe(created);
        expect(stored.impact).not.toBe(created.impact);
        expect(stored.build).not.toBe(created.build);

        const listed = service.list()[0];
        expect(listed.impact).toEqual(stored.impact);
        expect(listed.build).toEqual(stored.build);
        expect(listed).not.toBe(stored);

        const plain = service.create(buildInput('Plain'));
        expect(plain.impact).toBeUndefined();
        expect(plain.build).toBeUndefined();
        expect('impact' in plain).toBe(false);
        expect('build' in plain).toBe(false);
    });

    it('stores detached sketch snapshots for sketch proposals', () => {
        const service = new NukeCadProposalService();
        const input = buildSketchInput();
        const created = service.create(input);

        expect(created.sketch.targetSketchName).toBe('Pellet profile');
        expect(created.sketch.affectedSketchIds).toEqual(['pellet']);

        input.sketch.beforeSketches.pellet.name = 'Mutated input';
        (input.sketch.afterSketches.pellet.primitives[0] as { radius?: number }).radius = 99;
        (input.sketch.beforeParameters as { pelletDiameter?: number }).pelletDiameter = 99;
        (input.sketch.afterParameters as { pelletDiameter?: number }).pelletDiameter = 99;
        (input.sketch.solver as { dof: number }).dof = 5;
        (input.sketch.edits[0] as { after?: number }).after = 99;

        expect(created.sketch.beforeSketches.pellet.name).toBe('Pellet profile');
        expect(created.sketch.afterSketches.pellet.primitives[0]).toEqual({ id: 'pellet-circle', type: 'circle', radius: 1.2 });
        expect(created.sketch.beforeParameters).toEqual({ pelletDiameter: 1 });
        expect(created.sketch.afterParameters).toEqual({ pelletDiameter: 1.2 });
        expect(created.sketch.solver.dof).toBe(0);
        expect(created.sketch.edits[0].after).toBe(1.2);

        (created.sketch.beforeSketches.pellet as { name: string }).name = 'Mutated return';
        (created.sketch.afterSketches.pellet.primitives[0] as { radius?: number }).radius = 42;
        (created.sketch.edits[0] as { after?: number }).after = 42;
        (created.sketch.solver as { dof: number }).dof = 42;

        const stored = service.get(created.id);
        if (stored === undefined || !isSketchProposal(stored)) {
            throw new Error('Expected a sketch proposal');
        }
        expect(stored.sketch.beforeSketches.pellet.name).toBe('Pellet profile');
        expect(stored.sketch.afterSketches.pellet.primitives[0]).toEqual({ id: 'pellet-circle', type: 'circle', radius: 1.2 });
        expect(stored.sketch.edits[0].after).toBe(1.2);
        expect(stored.sketch.solver.dof).toBe(0);
        expect(service.get(created.id)).not.toBe(service.get(created.id));

        const listed = service.list();
        expect(listed).toHaveLength(1);
        if (!isSketchProposal(listed[0])) {
            throw new Error('Expected a sketch proposal');
        }
        (listed[0].sketch.afterSketches.pellet as { name: string }).name = 'Mutated list';
        expect(stored.sketch.afterSketches.pellet.name).toBe('Pellet profile');
    });

    it('keeps feature and sketch proposals in one store and narrows by scope', () => {
        const service = new NukeCadProposalService();
        const feature = service.create(buildInput('Feature change'));
        const sketch = service.create(buildSketchInput('Sketch change'));

        const listed = service.list();
        expect(listed.map((entry) => entry.id)).toEqual([feature.id, sketch.id]);
        expect(listed.map((entry) => entry.scope)).toEqual(['features', 'sketch']);

        expect(isSketchProposal(listed[0])).toBe(false);
        expect(isSketchProposal(listed[1])).toBe(true);
        const narrowed = listed[1];
        if (!isSketchProposal(narrowed)) {
            throw new Error('Expected a sketch proposal');
        }
        expect(narrowed.sketch.targetSketchId).toBe('pellet');
        expect(narrowed.applyCapability).toBe('nuke.cad.applySketchChange');
    });

    it('preserves an explicit apply capability for every proposal scope', () => {
        const service = new NukeCadProposalService();
        const feature = service.create({ ...buildInput('Feature change'), applyCapability: 'nuke.test.applyFeature' });
        const sketch = service.create({ ...buildSketchInput('Sketch change'), applyCapability: 'nuke.test.applySketch' });
        const topology = service.create({ ...buildTopologyInput('Topology change'), applyCapability: 'nuke.test.applyTopology' });
        const imported = service.create({ ...buildImportInput('Import change'), applyCapability: 'nuke.test.applyImport' });

        expect(feature.applyCapability).toBe('nuke.test.applyFeature');
        expect(sketch.applyCapability).toBe('nuke.test.applySketch');
        expect(topology.applyCapability).toBe('nuke.test.applyTopology');
        expect(imported.applyCapability).toBe('nuke.test.applyImport');
        expect(service.get(feature.id)?.applyCapability).toBe('nuke.test.applyFeature');
        expect(service.get(sketch.id)?.applyCapability).toBe('nuke.test.applySketch');
        expect(service.get(topology.id)?.applyCapability).toBe('nuke.test.applyTopology');
        expect(service.get(imported.id)?.applyCapability).toBe('nuke.test.applyImport');
        expect(service.create(buildInput('Default feature')).applyCapability).toBeUndefined();
    });

    it('creates a topology proposal with detached actions, snapshots, regions, and OpenMC state', () => {
        const service = new NukeCadProposalService();
        const input = buildTopologyInput();
        const blocked = blocker();
        (input.topology as { blockedRegions: readonly OpenmcRegionBlocker[] }).blockedRegions = [blocked];
        (input.topology as { openmcWarnings: readonly string[] }).openmcWarnings = ['Project was saved by an older IDE build.'];
        const created = service.create(input);

        expect(created.scope).toBe('topology');
        expect(created.applyCapability).toBe('nuke.cad.applyTopologyChange');
        expect(created.createdAt).toBe(START);
        expect(created.topology.actions).toEqual([{ featureId: 'coolant', action: 'holeDepthMode', mode: 'through' }]);
        expect(created.topology.before).toEqual({ coolant: { diameter: 1, depth: 2 } });
        expect(created.topology.topology.solids).toEqual({ before: 2, after: 3 });
        expect(created.topology.afterRegions.map((entry) => entry.selector)).toEqual(['fuel', 'insert']);
        expect(created.topology.blockedRegions[0].reference).toBe('steel');
        expect(created.topology.openmcStatus).toBe('saved-project');
        expect(created.topology.openmcProjectPath).toBe('/workspace/project/pincell.nuke-openmc');

        (input.topology.actions[0] as { featureId: string }).featureId = 'mutated-input';
        (input.topology.before.coolant as { depth?: number }).depth = 99;
        (input.topology.after.coolant as { diameter?: number }).diameter = 99;
        (input.topology.topology.addedRegions[0] as { selector: string }).selector = 'mutated-input';
        (input.topology.topology.solids as { after: number }).after = 99;
        (input.topology.afterRegions[0] as { selector: string }).selector = 'mutated-input';
        (input.topology.blockedRegions[0] as { message: string }).message = 'Mutated input blocker';
        (input.topology.openmcWarnings as string[]).push('Mutated input warning');

        (created.topology.actions[0] as { featureId: string }).featureId = 'mutated-return';
        (created.topology.before.coolant as { depth?: number }).depth = 42;
        (created.topology.after.coolant as { diameter?: number }).diameter = 42;
        (created.topology.topology.addedRegions[0] as { selector: string }).selector = 'mutated-return';
        (created.topology.topology.solids as { after: number }).after = 42;
        (created.topology.afterRegions[0] as { selector: string }).selector = 'mutated-return';
        (created.topology.blockedRegions[0] as { message: string }).message = 'Mutated return blocker';
        (created.topology.openmcWarnings as string[]).push('Mutated return warning');

        const stored = topologyProposal(service.get(created.id));
        expect(stored.topology.actions[0].featureId).toBe('coolant');
        expect(stored.topology.before).toEqual({ coolant: { diameter: 1, depth: 2 } });
        expect(stored.topology.after).toEqual({ coolant: { diameter: 1 } });
        expect(stored.topology.topology.addedRegions[0].selector).toBe('insert');
        expect(stored.topology.topology.solids).toEqual({ before: 2, after: 3 });
        expect(stored.topology.afterRegions.map((entry) => entry.selector)).toEqual(['fuel', 'insert']);
        expect(stored.topology.blockedRegions[0].reference).toBe('steel');
        expect(stored.topology.blockedRegions[0].kind).toBe('material');
        expect(stored.topology.blockedRegions[0].message).toBe("OpenMC material 'steel' still references region 'fuel'.");
        expect(stored.topology.openmcWarnings).toEqual(['Project was saved by an older IDE build.']);
        expect(stored.topology).not.toBe(created.topology);
        expect(stored.topology.actions).not.toBe(created.topology.actions);
        expect(stored.topology.afterRegions).not.toBe(created.topology.afterRegions);
        expect(stored.topology.blockedRegions).not.toBe(created.topology.blockedRegions);
        expect(service.get(created.id)).not.toBe(service.get(created.id));

        const listed = topologyProposal(service.list()[0]);
        expect(listed).not.toBe(stored);
        (listed.topology.actions[0] as { featureId: string }).featureId = 'mutated-list';
        (listed.topology.afterRegions[0] as { selector: string }).selector = 'mutated-list';
        expect(topologyProposal(service.get(created.id)).topology.actions[0].featureId).toBe('coolant');
        expect(topologyProposal(service.get(created.id)).topology.afterRegions[0].selector).toBe('fuel');
    });

    it('keeps feature, sketch, and topology proposals in one store and narrows topology by scope', () => {
        const service = new NukeCadProposalService();
        const feature = service.create(buildInput('Feature change'));
        const sketch = service.create(buildSketchInput('Sketch change'));
        const topology = service.create(buildTopologyInput('Topology change'));

        const listed = service.list();
        expect(listed.map((entry) => entry.id)).toEqual([feature.id, sketch.id, topology.id]);
        expect(listed.map((entry) => entry.scope)).toEqual(['features', 'sketch', 'topology']);
        expect(listed.map((entry) => isTopologyProposal(entry))).toEqual([false, false, true]);

        const narrowed = listed[2];
        if (!isTopologyProposal(narrowed)) {
            throw new Error('Expected a topology proposal');
        }
        expect(narrowed.topology.actions[0].action).toBe('holeDepthMode');
        expect(narrowed.topology.topology.requiresAcknowledgement).toBe(true);
        expect(isSketchProposal(narrowed)).toBe(false);
        expect(topology.scope).toBe('topology');
    });

    it('creates an import proposal with detached source, solids, drafts, and warnings', () => {
        const service = new NukeCadProposalService();
        const input = buildImportInput();
        const created = service.create(input);

        expect(created.scope).toBe('import');
        expect(created.applyCapability).toBe('nuke.cad.applyImportBodies');
        expect(created.createdAt).toBe(START);
        expect(created.import.source).toEqual(input.import.source);
        expect(created.import.drafts).toEqual(input.import.drafts);
        expect(created.import.solidCount).toBe(3);
        expect(created.import.selectedSolids.map((solid) => solid.index)).toEqual([1, 2]);
        expect(created.import.warnings).toEqual(['No material tag was set.']);

        (input.import.source as { sourceHash: string }).sourceHash = 'b'.repeat(64);
        (input.import.selectedSolids[0] as { faceCount: number }).faceCount = 99;
        (input.import.selectedSolids[0].bboxMin as number[])[0] = 99;
        (input.import.drafts[0].params as { sourceHash: string }).sourceHash = 'b'.repeat(64);
        (input.import.drafts[0] as { material?: string }).material = 'mutated-input';
        (input.import.bodies[0] as { name: string }).name = 'mutated-input';
        (input.import.warnings as string[]).push('Mutated input warning');

        (created.import.source as { sourceHash: string }).sourceHash = 'c'.repeat(64);
        (created.import.selectedSolids[0] as { faceCount: number }).faceCount = 42;
        (created.import.drafts[0] as { material?: string }).material = 'mutated-return';
        (created.import.bodies[0] as { name: string }).name = 'mutated-return';
        (created.import.warnings as string[]).push('Mutated return warning');

        const stored = importProposal(service.get(created.id));
        expect(stored.import.source.sourceHash).toBe('a'.repeat(64));
        expect(stored.import.selectedSolids[0].faceCount).toBe(6);
        expect(stored.import.selectedSolids[0].bboxMin).toEqual([0, 0, 0]);
        expect(stored.import.drafts[0].params).toMatchObject({ sourceHash: 'a'.repeat(64), sourcePath: './gui_pincell.step' });
        expect(stored.import.drafts[0].material).toBe('steel');
        expect(stored.import.bodies[0].name).toBe('fuel');
        expect(stored.import.warnings).toEqual(['No material tag was set.']);
        expect(stored.import).not.toBe(created.import);

        const listed = importProposal(service.list()[0]);
        expect(listed).not.toBe(stored);
        (listed.import.drafts[0] as { material?: string }).material = 'mutated-list';
        (listed.import.selectedSolids[0] as { volume: number }).volume = 0;
        expect(importProposal(service.get(created.id)).import.drafts[0].material).toBe('steel');
        expect(importProposal(service.get(created.id)).import.selectedSolids[0].volume).toBe(10);
    });

    it('keeps import proposals in one store with every other scope and narrows them', () => {
        const service = new NukeCadProposalService();
        const feature = service.create(buildInput('Feature change'));
        const sketch = service.create(buildSketchInput('Sketch change'));
        const topology = service.create(buildTopologyInput('Topology change'));
        const imported = service.create(buildImportInput('Import change'));

        const listed = service.list();
        expect(listed.map((entry) => entry.id)).toEqual([feature.id, sketch.id, topology.id, imported.id]);
        expect(listed.map((entry) => entry.scope)).toEqual(['features', 'sketch', 'topology', 'import']);
        expect(listed.map((entry) => isImportProposal(entry))).toEqual([false, false, false, true]);

        const narrowed = listed[3];
        if (!isImportProposal(narrowed)) {
            throw new Error('Expected an import proposal');
        }
        expect(narrowed.import.strategy).toBe('perSolid');
        expect(narrowed.import.label).toBe('gui_pincell');
        expect(isSketchProposal(narrowed)).toBe(false);
        expect(isTopologyProposal(narrowed)).toBe(false);
        expect(imported.scope).toBe('import');
    });

    it('applies the TTL and FIFO policy to import proposals', () => {
        const service = new InspectableProposalService();
        const ids: string[] = [];
        for (let index = 0; index < NUKE_CAD_FEATURE_PROPOSAL_LIMIT + 1; index++) {
            ids.push(service.create(buildImportInput(`Import change ${index + 1}`)).id);
        }

        expect(service.size).toBe(NUKE_CAD_FEATURE_PROPOSAL_LIMIT);
        expect(service.has(ids[0])).toBe(false);
        expect(service.get(ids[1])?.summary).toBe('Import change 2');

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS - 1);
        expect(service.has(ids[1])).toBe(true);
        advance(1);
        expect(service.list()).toEqual([]);
        expect(service.size).toBe(0);
    });

    it('applies the TTL and FIFO policy to topology proposals', () => {
        const service = new InspectableProposalService();
        const ids: string[] = [];
        for (let index = 0; index < NUKE_CAD_FEATURE_PROPOSAL_LIMIT + 1; index++) {
            ids.push(service.create(buildTopologyInput(`Topology change ${index + 1}`)).id);
        }

        expect(service.size).toBe(NUKE_CAD_FEATURE_PROPOSAL_LIMIT);
        expect(service.has(ids[0])).toBe(false);
        expect(service.get(ids[1])?.summary).toBe('Topology change 2');

        advance(NUKE_CAD_FEATURE_PROPOSAL_TTL_MS - 1);
        expect(service.has(ids[1])).toBe(true);
        advance(1);
        expect(service.list()).toEqual([]);
        expect(service.size).toBe(0);
    });
});
