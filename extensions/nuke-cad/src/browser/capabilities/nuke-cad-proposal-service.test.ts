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
import {
    NUKE_CAD_FEATURE_PROPOSAL_LIMIT,
    NUKE_CAD_FEATURE_PROPOSAL_TTL_MS,
    NukeCadFeatureProposalInput,
    NukeCadProposalService
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

        const stored = service.get(created.id)!;
        expect(stored.summary).toBe('Increase the fuel pellet height');
        expect(stored.before).toEqual({ fuel: { length: 1 } });
        expect(stored.after).toEqual({ fuel: { length: 1.2 } });
        expect(stored.changes[0].after).toBe(1.2);
        expect(stored.edits[0].after).toBe(1.2);

        (stored.before.fuel as { length?: number }).length = 123;
        (stored.after.fuel as { length?: number }).length = 123;
        (stored.changes[0] as { after?: unknown }).after = 123;
        (stored.edits[0] as { after?: number }).after = 123;

        const reread = service.get(created.id)!;
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
});
