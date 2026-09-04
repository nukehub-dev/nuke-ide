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
import { attributeBodyToFeature, buildViewportContextMenu, type FeatureBodyRef } from './viewport-context-menu';

const feature = (id: string, body: string, suppressed = false): FeatureBodyRef => ({ id, body, suppressed });

describe('attributeBodyToFeature', () => {
    it('resolves to the latest non-suppressed feature writing the body', () => {
        const features = [feature('pad-1', 'body-a'), feature('fillet-1', 'body-a'), feature('pad-2', 'body-b')];
        expect(attributeBodyToFeature('body-a', features)).toBe('fillet-1');
        expect(attributeBodyToFeature('body-b', features)).toBe('pad-2');
    });

    it('skips suppressed features', () => {
        const features = [feature('pad-1', 'body-a'), feature('fillet-1', 'body-a', true)];
        expect(attributeBodyToFeature('body-a', features)).toBe('pad-1');
    });

    it('returns undefined without a body id (script/STEP models)', () => {
        expect(attributeBodyToFeature(undefined, [feature('pad-1', 'body-a')])).toBeUndefined();
    });

    it('returns undefined when no feature writes the body', () => {
        expect(attributeBodyToFeature('body-x', [feature('pad-1', 'body-a')])).toBeUndefined();
        expect(attributeBodyToFeature('body-a', undefined)).toBeUndefined();
    });
});

describe('buildViewportContextMenu', () => {
    it('offers Edit Feature (attributed), the three measure tools, Fit to Solid, Hide and Isolate on a solid', () => {
        const items = buildViewportContextMenu({ solid: { solidId: 3, featureId: 'pad-1' }, explodeFactor: 0 });
        expect(items.map((item) => item.label)).toEqual([
            'Edit Feature…',
            'Measure Distance',
            'Measure Angle',
            'Measure Radius',
            'Fit to Solid',
            'Hide Solid',
            'Isolate Solid'
        ]);
        expect(items[0].disabled).toBeUndefined();
        expect(items[0].action).toEqual({ kind: 'editFeature', featureId: 'pad-1' });
        expect(items[1].action).toEqual({ kind: 'measure', tool: 'distance' });
        expect(items[2].action).toEqual({ kind: 'measure', tool: 'angle' });
        expect(items[3].action).toEqual({ kind: 'measure', tool: 'radius' });
        expect(items[4].action).toEqual({ kind: 'fitSolid', solidId: 3 });
        expect(items[5].separatorAbove).toBe(true);
        expect(items[5].disabled).toBeUndefined();
        expect(items[5].action).toEqual({ kind: 'hideSolid', solidId: 3 });
        expect(items[6].disabled).toBeUndefined();
        expect(items[6].action).toEqual({ kind: 'isolateSolid', solidId: 3 });
    });

    it('disables Edit Feature when attribution fails instead of guessing', () => {
        const items = buildViewportContextMenu({ solid: { solidId: 3 }, explodeFactor: 0 });
        expect(items[0].disabled).toBe(true);
        expect(items[0].action).toEqual({ kind: 'noop' });
    });

    it('offers Fit All, Reset Explode, Show All Solids, and the section toggle on empty space', () => {
        const items = buildViewportContextMenu({ solid: undefined, explodeFactor: 0 });
        expect(items.map((item) => item.label)).toEqual(['Fit All', 'Reset Explode', 'Show All Solids', 'Show Section View']);
        expect(items[0].disabled).toBeUndefined();
        expect(items[1].disabled).toBe(true);

        const exploded = buildViewportContextMenu({ solid: undefined, explodeFactor: 0.5 });
        expect(exploded[1].disabled).toBeUndefined();
        expect(exploded[1].action).toEqual({ kind: 'resetExplode' });
    });

    it('disables Show All Solids when nothing is hidden', () => {
        const byDefault = buildViewportContextMenu({ solid: undefined, explodeFactor: 0 });
        expect(byDefault[2].disabled).toBe(true);
        expect(byDefault[2].action).toEqual({ kind: 'showAll' });

        const explicitZero = buildViewportContextMenu({ solid: undefined, explodeFactor: 0, hiddenCount: 0 });
        expect(explicitZero[2].disabled).toBe(true);

        const someHidden = buildViewportContextMenu({ solid: undefined, explodeFactor: 0, hiddenCount: 2 });
        expect(someHidden[2].disabled).toBeUndefined();
        expect(someHidden[2].action).toEqual({ kind: 'showAll' });
    });

    it('flips the section toggle label with sectionActive', () => {
        const inactive = buildViewportContextMenu({ solid: undefined, explodeFactor: 0 });
        expect(inactive[3].label).toBe('Show Section View');
        expect(inactive[3].disabled).toBeUndefined();
        expect(inactive[3].action).toEqual({ kind: 'toggleSection' });

        const active = buildViewportContextMenu({ solid: undefined, explodeFactor: 0, sectionActive: true });
        expect(active[3].label).toBe('Hide Section View');
        expect(active[3].action).toEqual({ kind: 'toggleSection' });
    });
});
