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
 * Tests for {@link selectOutputViewer}: scoring, priority tie-break, and the
 * no-match case. The matching logic is pure, so no DI container is needed.
 */

import { describe, expect, it } from 'vitest';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution, selectOutputViewer } from './output-viewer-registry';

function fakeContribution(id: string, baseNames: string[], score: number, priority: number): OutputViewerContribution {
    return {
        id,
        label: id,
        priority,
        canHandle: (uri: URI) => (baseNames.includes(uri.path.base.toLowerCase()) ? score : 0),
        open: async () => undefined
    };
}

describe('selectOutputViewer', () => {
    const tracksViewer = fakeContribution('tracks-viewer', ['tracks.h5'], 500, 10);
    const weightWindowsViewer = fakeContribution('weight-windows-viewer', ['weight_windows.h5'], 500, 10);

    it('returns undefined when no contribution matches', () => {
        const uri = new URI('file:///run/statepoint.100.h5');
        expect(selectOutputViewer(uri, [tracksViewer, weightWindowsViewer])).toBeUndefined();
        expect(selectOutputViewer(uri, [])).toBeUndefined();
    });

    it('returns the single matching contribution', () => {
        const uri = new URI('file:///run/tracks.h5');
        expect(selectOutputViewer(uri, [weightWindowsViewer, tracksViewer])).toBe(tracksViewer);
    });

    it('picks the highest score when several contributions match', () => {
        const genericH5 = fakeContribution('generic-h5', ['tracks.h5'], 100, 99);
        const uri = new URI('file:///run/tracks.h5');
        // Higher score wins even with lower priority
        expect(selectOutputViewer(uri, [genericH5, tracksViewer])).toBe(tracksViewer);
    });

    it('breaks score ties by priority', () => {
        const lowPriority = fakeContribution('low', ['tracks.h5'], 500, 1);
        const highPriority = fakeContribution('high', ['tracks.h5'], 500, 20);
        const uri = new URI('file:///run/tracks.h5');
        expect(selectOutputViewer(uri, [lowPriority, highPriority])).toBe(highPriority);
        // Order of registration must not matter
        expect(selectOutputViewer(uri, [highPriority, lowPriority])).toBe(highPriority);
    });

    it('keeps the first contribution when score and priority tie', () => {
        const first = fakeContribution('first', ['tracks.h5'], 500, 10);
        const second = fakeContribution('second', ['tracks.h5'], 500, 10);
        const uri = new URI('file:///run/tracks.h5');
        expect(selectOutputViewer(uri, [first, second])).toBe(first);
    });

    it('ignores contributions that score zero', () => {
        const zero = fakeContribution('zero', ['other.h5'], 0, 1000);
        const uri = new URI('file:///run/other.h5');
        expect(selectOutputViewer(uri, [zero])).toBeUndefined();
    });
});
