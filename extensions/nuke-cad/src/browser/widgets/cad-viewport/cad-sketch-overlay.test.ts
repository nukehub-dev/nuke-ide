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

import { describe, it, expect, beforeAll } from 'vitest';

// The overlay module pulls Theia/lumino browser code that touches the DOM at
// import time; the suite runs in the node environment, so install the minimal
// globals the import chain needs before loading it dynamically.
async function loadHelper(): Promise<typeof import('./cad-sketch-overlay.js')> {
    const g = globalThis as Record<string, unknown>;
    if (g['Element'] === undefined) {
        g['Element'] = class {};
    }
    if (g['DragEvent'] === undefined) {
        g['DragEvent'] = class extends Event {};
    }
    if (g['document'] === undefined) {
        const stubElement = (): unknown => ({
            classList: { add: (): void => undefined, remove: (): void => undefined },
            style: {},
            appendChild: (): void => undefined,
            removeChild: (): void => undefined,
            addEventListener: (): void => undefined,
            removeEventListener: (): void => undefined
        });
        g['document'] = { createElement: stubElement, documentElement: { style: {} } };
    }
    return import('./cad-sketch-overlay.js');
}

describe('formatDimensionWithUnits', () => {
    let formatDimensionWithUnits: (text: string, units: 'mm' | 'cm' | 'm' | undefined) => string;

    beforeAll(async () => {
        ({ formatDimensionWithUnits } = await loadHelper());
    });

    it('leaves text unchanged for unitless documents', () => {
        expect(formatDimensionWithUnits('12.5', undefined)).toBe('12.5');
        expect(formatDimensionWithUnits('(12.5)', undefined)).toBe('(12.5)');
    });

    it.each(['mm', 'cm', 'm'] as const)('appends the %s suffix when set', (units) => {
        expect(formatDimensionWithUnits('12.5', units)).toBe(`12.5 ${units}`);
        expect(formatDimensionWithUnits('(12.5)', units)).toBe(`(12.5) ${units}`);
    });
});
