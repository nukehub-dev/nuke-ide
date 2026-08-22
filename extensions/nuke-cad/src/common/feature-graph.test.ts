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
import { FeatureGraph } from './feature-graph';
import type { FeatureDef } from './cad-document';

function feature(id: string, dependsOn: string[] = [], suppressed = false): FeatureDef {
    return { id, name: id, type: 'pad', body: 'body-1', params: { length: 1 }, suppressed, dependsOn };
}

describe('FeatureGraph', () => {
    it('orders a linear chain', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['b'])]);
        expect(graph.topologicalOrder()).toEqual(['a', 'b', 'c']);
    });

    it('orders a diamond', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['a']), feature('d', ['b', 'c'])]);
        const order = graph.topologicalOrder();
        expect(order[0]).toBe('a');
        expect(order[3]).toBe('d');
        expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
        expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    });

    it('rejects dependency cycles with readable member list', () => {
        const graph = new FeatureGraph([feature('a', ['b']), feature('b', ['a'])]);
        expect(() => graph.topologicalOrder()).toThrow(/cycle detected.*a.*b/);
    });

    it('plans a minimal dirty subtree', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['a']), feature('d', ['b', 'c'])]);
        graph.markDirty(['b']);
        const plan = graph.recomputePlan();
        expect(plan.order).toEqual(['b', 'd']);
        expect(plan.entries.map((e) => e.featureId)).toEqual(['b', 'd']);
        expect(plan.stale).toHaveLength(0);
    });

    it('propagates dirtiness through transitive dependents', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['b']), feature('d', ['c'])]);
        graph.markDirty(['a']);
        const plan = graph.recomputePlan();
        expect(plan.order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('omits suppressed features and marks their dependents stale', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a'], true), feature('c', ['b'])]);
        graph.markDirty(['a']);
        const plan = graph.recomputePlan();
        expect(plan.order).toEqual(['a']);
        expect(plan.stale).toContain('c');
    });

    it('supports multiple independent dirty roots', () => {
        const graph = new FeatureGraph([feature('a'), feature('b'), feature('c', ['a', 'b'])]);
        graph.markDirty(['a', 'b']);
        const plan = graph.recomputePlan();
        expect(plan.order).toContain('a');
        expect(plan.order).toContain('b');
        expect(plan.order.indexOf('c')).toBeGreaterThan(plan.order.indexOf('a') ?? -1);
        expect(plan.order.indexOf('c')).toBeGreaterThan(plan.order.indexOf('b') ?? -1);
    });

    it('clears dirty state with markClean after a successful rebuild', () => {
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['b'])]);
        graph.markDirty(['a']);
        const first = graph.recomputePlan();
        expect(first.order).toEqual(['a', 'b', 'c']);

        graph.markClean(['a', 'b', 'c']);
        const second = graph.recomputePlan();
        expect(second.order).toHaveLength(0);
        expect(second.stale).toHaveLength(0);
    });

    it('rejects marking unknown features as clean', () => {
        const graph = new FeatureGraph([feature('a')]);
        expect(() => graph.markClean(['missing'])).toThrow(/unknown feature/);
    });

    it('preserves document order as the topological tiebreak', () => {
        // Input order is b, c; both depend on a and both precede d.
        const graph = new FeatureGraph([feature('a'), feature('b', ['a']), feature('c', ['a']), feature('d', ['b', 'c'])]);
        expect(graph.topologicalOrder()).toEqual(['a', 'b', 'c', 'd']);
    });
});
