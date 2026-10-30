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
 * Tests for the pure comparison-session model (no DOM, no three.js): pane
 * labels/ordering/dedupe, the shared-range union rules, and the range bus
 * (initial callback, expand/shrink dispatch, change-only notifications,
 * dispose membership, session isolation, malformed input, defensive copies).
 */

import { describe, expect, it } from 'vitest';
import {
    comparisonCameraKey,
    comparisonRangeBus,
    comparisonRangeUnion,
    comparisonViewLabel,
    createComparisonRangeBus,
    createComparisonSession,
    isComparisonViewHost,
    type ComparisonRange,
    type ComparisonRangeBus,
    type ComparisonRangeEndpoint
} from './comparison-session';

type RangeEvent = ComparisonRange | undefined;

/** Link one recorder and collect every range it receives. */
function record(bus: ComparisonRangeBus, sessionId: string, viewId: string): { events: RangeEvent[]; endpoint: ComparisonRangeEndpoint } {
    const events: RangeEvent[] = [];
    const endpoint = bus.link(sessionId, viewId, (range) => events.push(range));
    return { events, endpoint };
}

describe('comparison view labels', () => {
    it('labels the first 26 panes A through Z', () => {
        expect(comparisonViewLabel(0)).toBe('A');
        expect(comparisonViewLabel(1)).toBe('B');
        expect(comparisonViewLabel(2)).toBe('C');
        expect(comparisonViewLabel(25)).toBe('Z');
    });

    it('labels panes past Z as P27, P28, ...', () => {
        expect(comparisonViewLabel(26)).toBe('P27');
        expect(comparisonViewLabel(27)).toBe('P28');
        expect(comparisonViewLabel(51)).toBe('P52');
    });

    it('clamps malformed indices to a real pane slot', () => {
        expect(comparisonViewLabel(-1)).toBe('A');
        expect(comparisonViewLabel(Number.NaN)).toBe('A');
        expect(comparisonViewLabel(Number.POSITIVE_INFINITY)).toBe('A');
        expect(comparisonViewLabel(1.9)).toBe('B');
    });
});

describe('createComparisonSession', () => {
    it('preserves input order and labels panes by position', () => {
        const session = createComparisonSession('cmp-1', [
            { viewId: 'view-b', title: 'Case B' },
            { viewId: 'view-c', title: 'Case C' },
            { viewId: 'view-a', title: 'Case A' }
        ]);
        expect(session.id).toBe('cmp-1');
        expect(session.panes).toEqual([
            { viewId: 'view-b', label: 'A', title: 'Case B' },
            { viewId: 'view-c', label: 'B', title: 'Case C' },
            { viewId: 'view-a', label: 'C', title: 'Case A' }
        ]);
    });

    it('dedupes by viewId, keeping the first occurrence', () => {
        const session = createComparisonSession('cmp', [
            { viewId: 'view-a', title: 'First A' },
            { viewId: 'view-a', title: 'Second A' },
            { viewId: 'view-b', title: 'B' }
        ]);
        expect(session.panes).toEqual([
            { viewId: 'view-a', label: 'A', title: 'First A' },
            { viewId: 'view-b', label: 'B', title: 'B' }
        ]);
    });

    it('falls back to View <label> for blank titles', () => {
        const session = createComparisonSession('cmp', [
            { viewId: 'a', title: '' },
            { viewId: 'b', title: '   ' },
            { viewId: 'c', title: '\n\t ' },
            { viewId: 'd', title: '  Kept  ' }
        ]);
        expect(session.panes.map((pane) => pane.title)).toEqual(['View A', 'View B', 'View C', 'Kept']);
    });

    it('accepts an empty selection and skips empty view ids', () => {
        expect(createComparisonSession('empty', []).panes).toEqual([]);
        const session = createComparisonSession('cmp', [
            { viewId: '', title: 'No identity' },
            { viewId: 'view-a', title: 'A' }
        ]);
        expect(session.panes).toEqual([{ viewId: 'view-a', label: 'A', title: 'A' }]);
    });
});

describe('comparisonRangeUnion', () => {
    it('returns undefined for no ranges', () => {
        expect(comparisonRangeUnion([])).toBeUndefined();
        expect(comparisonRangeUnion([undefined, undefined])).toBeUndefined();
    });

    it('returns undefined when every range is unusable', () => {
        const ranges: (ComparisonRange | undefined)[] = [
            undefined,
            [Number.NaN, 1],
            [0, Number.POSITIVE_INFINITY],
            [5, 1],
            [1] as unknown as ComparisonRange,
            null as unknown as ComparisonRange,
            [0, 1, 2] as unknown as ComparisonRange
        ];
        expect(comparisonRangeUnion(ranges)).toBeUndefined();
    });

    it('unions finite ranges to the smallest minimum and largest maximum', () => {
        expect(
            comparisonRangeUnion([
                [-2, 3],
                [0, 10],
                [4, 4]
            ])
        ).toEqual([-2, 10]);
        expect(comparisonRangeUnion([[0, 10]])).toEqual([0, 10]);
        expect(
            comparisonRangeUnion(
                new Set<ComparisonRange>([
                    [5, 6],
                    [1, 2]
                ])
            )
        ).toEqual([1, 6]);
    });

    it('skips inverted and non-finite ranges but keeps the usable ones', () => {
        const ranges: (ComparisonRange | undefined)[] = [
            [5, 1],
            [Number.NaN, 2],
            [-3, 4],
            [1, Number.NEGATIVE_INFINITY],
            [2, 8]
        ];
        expect(comparisonRangeUnion(ranges)).toEqual([-3, 8]);
    });
});

describe('comparison range bus', () => {
    it('calls a new listener immediately with the current union', () => {
        const bus = createComparisonRangeBus();
        const first = record(bus, 'session', 'view-a');
        expect(first.events).toEqual([undefined]);
        first.endpoint.publish([0, 10]);
        const late = record(bus, 'session', 'view-b');
        expect(late.events).toEqual([[0, 10]]);
        expect(bus.union('session')).toEqual([0, 10]);
        first.endpoint.dispose();
        late.endpoint.dispose();
    });

    it('notifies every listener (publisher included) when the union expands or shrinks', () => {
        const bus = createComparisonRangeBus();
        const a = record(bus, 'session', 'view-a');
        const b = record(bus, 'session', 'view-b');
        a.events.length = 0;
        b.events.length = 0;

        a.endpoint.publish([0, 10]);
        expect(a.events).toEqual([[0, 10]]);
        expect(b.events).toEqual([[0, 10]]);

        b.endpoint.publish([5, 20]);
        expect(a.events).toEqual([
            [0, 10],
            [0, 20]
        ]);
        expect(b.events).toEqual([
            [0, 10],
            [0, 20]
        ]);

        a.endpoint.publish([8, 9]);
        expect(a.events).toEqual([
            [0, 10],
            [0, 20],
            [5, 20]
        ]);
        expect(b.events).toEqual([
            [0, 10],
            [0, 20],
            [5, 20]
        ]);

        b.endpoint.publish(undefined);
        expect(a.events).toEqual([
            [0, 10],
            [0, 20],
            [5, 20],
            [8, 9]
        ]);
        expect(b.events).toEqual([
            [0, 10],
            [0, 20],
            [5, 20],
            [8, 9]
        ]);
        expect(bus.union('session')).toEqual([8, 9]);
    });

    it('does not dispatch when the union is unchanged', () => {
        const bus = createComparisonRangeBus();
        const a = record(bus, 'session', 'view-a');
        const b = record(bus, 'session', 'view-b');
        expect(a.events).toHaveLength(1);
        expect(b.events).toHaveLength(1);

        a.endpoint.publish([0, 10]);
        expect(a.events).toHaveLength(2);
        expect(b.events).toHaveLength(2);

        // Same range again: no dispatch.
        a.endpoint.publish([0, 10]);
        expect(a.events).toHaveLength(2);
        expect(b.events).toHaveLength(2);

        // A narrower range inside the existing union: no dispatch.
        b.endpoint.publish([2, 8]);
        expect(a.events).toHaveLength(2);
        expect(b.events).toHaveLength(2);

        // Removing the wide range shrinks the union: one dispatch.
        a.endpoint.publish(undefined);
        expect(a.events).toHaveLength(3);
        expect(b.events).toHaveLength(3);
        expect(a.events[2]).toEqual([2, 8]);
        expect(b.events[2]).toEqual([2, 8]);
    });

    it('stops dispatching when a listener republishes what it received', () => {
        const bus = createComparisonRangeBus();
        const seen: RangeEvent[] = [];
        let echoing!: ComparisonRangeEndpoint;
        echoing = bus.link('session', 'view-a', (range) => {
            seen.push(range);
            if (range) {
                echoing.publish(range);
            }
        });
        const other = record(bus, 'session', 'view-b');
        expect(seen).toEqual([undefined]);

        echoing.publish([0, 10]);
        expect(seen).toEqual([undefined, [0, 10]]);
        expect(other.events).toEqual([undefined, [0, 10]]);

        echoing.dispose();
        other.endpoint.dispose();
    });

    it('dispose removes the view range and listener and updates the survivors', () => {
        const bus = createComparisonRangeBus();
        const a = record(bus, 'session', 'view-a');
        const b = record(bus, 'session', 'view-b');
        a.endpoint.publish([0, 10]);
        b.endpoint.publish([5, 20]);
        a.events.length = 0;
        b.events.length = 0;

        a.endpoint.dispose();
        expect(a.events).toEqual([]);
        expect(b.events).toEqual([[5, 20]]);
        expect(bus.union('session')).toEqual([5, 20]);

        // A disposed endpoint is inert, and double dispose is safe.
        a.endpoint.publish([-5, 5]);
        a.endpoint.dispose();
        expect(a.events).toEqual([]);
        expect(b.events).toEqual([[5, 20]]);
        expect(bus.union('session')).toEqual([5, 20]);
    });

    it('drops the session once its last listener and range are gone', () => {
        const bus = createComparisonRangeBus();
        const a = record(bus, 'session', 'view-a');
        a.endpoint.publish([0, 10]);
        expect(bus.union('session')).toEqual([0, 10]);

        a.endpoint.dispose();
        expect(bus.union('session')).toBeUndefined();

        // A fresh link starts from scratch (no stale union in the pruned session).
        const fresh = record(bus, 'session', 'view-a');
        expect(fresh.events).toEqual([undefined]);
        expect(bus.union('session')).toBeUndefined();
        fresh.endpoint.dispose();
    });

    it('isolates sessions and the same view id in different sessions', () => {
        const bus = createComparisonRangeBus();
        const one = record(bus, 'session-one', 'view-a');
        const two = record(bus, 'session-two', 'view-a');
        one.events.length = 0;
        two.events.length = 0;

        one.endpoint.publish([0, 10]);
        expect(one.events).toEqual([[0, 10]]);
        expect(two.events).toEqual([]);
        expect(bus.union('session-two')).toBeUndefined();

        two.endpoint.publish([100, 200]);
        expect(two.events).toEqual([[100, 200]]);
        expect(one.events).toEqual([[0, 10]]);
        expect(bus.union('session-one')).toEqual([0, 10]);
        expect(bus.union('session-two')).toEqual([100, 200]);
    });

    it('treats undefined and malformed publishes as range removal', () => {
        const bus = createComparisonRangeBus();
        const a = record(bus, 'session', 'view-a');
        a.events.length = 0;

        a.endpoint.publish([0, 10]);
        a.endpoint.publish([Number.NaN, 5]);
        expect(a.events).toEqual([[0, 10], undefined]);
        expect(bus.union('session')).toBeUndefined();

        // Removing an absent range changes nothing.
        a.endpoint.publish([5, 1]);
        expect(a.events).toHaveLength(2);

        a.endpoint.publish([0, 10]);
        a.endpoint.publish([1] as unknown as ComparisonRange);
        expect(a.events).toEqual([[0, 10], undefined, [0, 10], undefined]);
        expect(bus.union('session')).toBeUndefined();
        a.endpoint.dispose();
    });

    it('never aliases caller or listener ranges', () => {
        const bus = createComparisonRangeBus();
        const received: RangeEvent[] = [];
        const publisher = bus.link('session', 'view-a', (range) => received.push(range));
        const published: [number, number] = [0, 10];
        publisher.publish(published);

        // Caller mutation does not corrupt the stored range.
        published[0] = -100;
        published[1] = 100;
        expect(bus.union('session')).toEqual([0, 10]);

        // Listener mutation does not corrupt the stored range.
        (received[1] as [number, number])[0] = 500;
        expect(bus.union('session')).toEqual([0, 10]);

        // Each listener gets its own copy, and union() hands out a copy.
        const later: RangeEvent[] = [];
        const follower = bus.link('session', 'view-b', (range) => later.push(range));
        expect(later).toEqual([[0, 10]]);
        (later[0] as [number, number])[1] = 999;
        expect((received[1] as [number, number])[0]).toBe(500);
        expect(bus.union('session')).toEqual([0, 10]);

        const snapshot = bus.union('session') as [number, number];
        snapshot[0] = 1234;
        expect(bus.union('session')).toEqual([0, 10]);

        publisher.dispose();
        follower.dispose();
    });

    it('hands an inert endpoint to an empty session id', () => {
        const bus = createComparisonRangeBus();
        let calls = 0;
        const keyless = bus.link('', 'view-a', () => calls++);
        keyless.publish([0, 10]);
        expect(calls).toBe(0);
        expect(bus.union('')).toBeUndefined();
        keyless.dispose();
    });

    it('exposes the shared module-level bus', () => {
        const events: RangeEvent[] = [];
        const endpoint = comparisonRangeBus.link('shared-session', 'view-a', (range) => events.push(range));
        expect(events).toEqual([undefined]);
        endpoint.publish([1, 2]);
        expect(events).toEqual([undefined, [1, 2]]);
        expect(comparisonRangeBus.union('shared-session')).toEqual([1, 2]);
        endpoint.dispose();
        expect(comparisonRangeBus.union('shared-session')).toBeUndefined();
    });
});

describe('isComparisonViewHost', () => {
    it('accepts a widget exposing the full comparison surface', () => {
        const host = {
            id: 'dagmc-viewer-widget:/tmp/a.vtm',
            joinComparison: () => undefined,
            leaveComparison: () => undefined,
            getComparisonView: () => undefined,
            syncComparisonCamera: () => undefined
        };
        expect(isComparisonViewHost(host)).toBe(true);
    });

    it('rejects missing methods and non-objects', () => {
        expect(isComparisonViewHost(undefined)).toBe(false);
        expect(isComparisonViewHost(null)).toBe(false);
        expect(isComparisonViewHost('host')).toBe(false);
        expect(isComparisonViewHost({ id: 'x' })).toBe(false);
        expect(isComparisonViewHost({ id: 'x', joinComparison: () => undefined })).toBe(false);
        expect(
            isComparisonViewHost({
                id: 42,
                joinComparison: () => undefined,
                leaveComparison: () => undefined,
                getComparisonView: () => undefined,
                syncComparisonCamera: () => undefined
            })
        ).toBe(false);
    });
});

describe('comparisonCameraKey', () => {
    it('prefixes the session id with comparison:', () => {
        expect(comparisonCameraKey('cmp-1')).toBe('comparison:cmp-1');
        expect(comparisonCameraKey('')).toBe('comparison:');
    });

    it('gives distinct keys to distinct sessions', () => {
        expect(comparisonCameraKey('one')).not.toBe(comparisonCameraKey('two'));
    });
});
