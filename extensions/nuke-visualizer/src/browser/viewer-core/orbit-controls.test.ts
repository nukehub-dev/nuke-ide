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
 * Tests for the shared orbit-controls fit math (no DOM, no controls
 * instance): bound centers, bounding-sphere radii, and fit distances.
 */

import { describe, expect, it } from 'vitest';
import {
    boundsCenter,
    boundsRadius,
    createCoalescedChangeNotifier,
    fitDistanceForRadius,
    ORBIT_DAMPING_FACTOR,
    ORBIT_FIT_FACTOR,
    ORBIT_MIN_DISTANCE,
    STANDARD_VIEW_DIRECTIONS,
    standardViewDirection
} from './orbit-controls';

describe('boundsCenter', () => {
    it('returns the midpoint of each axis', () => {
        expect(boundsCenter([0, -2, 4], [2, 6, 8])).toEqual([1, 2, 6]);
    });

    it('collapses degenerate bounds to the shared point', () => {
        expect(boundsCenter([3, 3, 3], [3, 3, 3])).toEqual([3, 3, 3]);
    });
});

describe('boundsRadius', () => {
    it('returns half the diagonal length', () => {
        expect(boundsRadius([0, 0, 0], [2, 0, 0])).toBeCloseTo(1, 12);
        expect(boundsRadius([-1, -1, -1], [1, 1, 1])).toBeCloseTo(Math.sqrt(3), 12);
    });

    it('returns zero for degenerate bounds', () => {
        expect(boundsRadius([5, 5, 5], [5, 5, 5])).toBe(0);
    });
});

describe('fitDistanceForRadius', () => {
    it('scales the radius by the fit factor', () => {
        expect(fitDistanceForRadius(10)).toBeCloseTo(10 * ORBIT_FIT_FACTOR, 12);
    });

    it('floors zero and negative radii at the minimum distance', () => {
        expect(fitDistanceForRadius(0)).toBe(ORBIT_MIN_DISTANCE);
        expect(fitDistanceForRadius(-4)).toBe(ORBIT_MIN_DISTANCE);
    });

    it('floors non-finite radii at the minimum distance', () => {
        expect(fitDistanceForRadius(NaN)).toBe(ORBIT_MIN_DISTANCE);
        expect(fitDistanceForRadius(Infinity)).toBe(ORBIT_MIN_DISTANCE);
    });
});

describe('standardViewDirection', () => {
    it('maps each standard view to its Y-up direction triple', () => {
        expect(standardViewDirection('iso')).toEqual([1, 1, 1]);
        expect(standardViewDirection('top')).toEqual([0, 1, 0]);
        expect(standardViewDirection('front')).toEqual([0, 0, 1]);
        expect(standardViewDirection('right')).toEqual([1, 0, 0]);
    });

    it('matches the directions record entry for entry', () => {
        for (const view of ['iso', 'top', 'front', 'right'] as const) {
            expect(standardViewDirection(view)).toEqual(STANDARD_VIEW_DIRECTIONS[view]);
        }
    });
});

describe('orbit damping', () => {
    it('pins an explicit damping factor (the orbit feel must not float with three defaults)', () => {
        expect(ORBIT_DAMPING_FACTOR).toBe(0.05);
    });
});

/** Synchronous frame stub: queued callbacks run on `flush`, like one animation frame. */
function stubFrame() {
    let nextId = 1;
    const queued = new Map<number, () => void>();
    return {
        requestAnimationFrame: (callback: () => void): number => {
            const id = nextId++;
            queued.set(id, callback);
            return id;
        },
        cancelAnimationFrame: (handle: number): void => {
            queued.delete(handle);
        },
        flush: (): void => {
            for (const [, callback] of [...queued]) {
                queued.clear();
                callback();
            }
        },
        get scheduledCount(): number {
            return queued.size;
        }
    };
}

describe('createCoalescedChangeNotifier', () => {
    it('collapses a burst of changes into one repaint per frame', () => {
        const frame = stubFrame();
        let calls = 0;
        const notifier = createCoalescedChangeNotifier(
            () => {
                calls++;
            },
            frame,
            () => false
        );
        notifier.notify();
        notifier.notify();
        notifier.notify();
        expect(notifier.pending).toBe(true);
        expect(frame.scheduledCount).toBe(1);
        frame.flush();
        expect(calls).toBe(1);
        expect(notifier.pending).toBe(false);
    });

    it('skips the repaint while the tab is hidden (camera state is already current)', () => {
        const frame = stubFrame();
        let calls = 0;
        const notifier = createCoalescedChangeNotifier(
            () => {
                calls++;
            },
            frame,
            () => true
        );
        notifier.notify();
        frame.flush();
        expect(calls).toBe(0);
        expect(notifier.pending).toBe(false);
    });

    it('cancels a scheduled repaint on dispose', () => {
        const frame = stubFrame();
        let calls = 0;
        const notifier = createCoalescedChangeNotifier(
            () => {
                calls++;
            },
            frame,
            () => false
        );
        notifier.notify();
        notifier.dispose();
        expect(notifier.pending).toBe(false);
        frame.flush();
        expect(calls).toBe(0);
    });
});
