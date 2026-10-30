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
import { NukeCadPreferenceSchema } from './nuke-cad-preferences';

describe('NukeCadPreferenceSchema rebuildOnEdit', () => {
    it('defaults to auto so existing behavior is unchanged', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.rebuildOnEdit'];
        expect(prop.type).toBe('string');
        expect(prop.default).toBe('auto');
    });

    it('allows only auto and manual', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.rebuildOnEdit'];
        expect(prop.enum).toEqual(['auto', 'manual']);
    });
});

describe('NukeCadPreferenceSchema navigationStyle', () => {
    it('defaults to orbit so existing behavior is unchanged', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.navigationStyle'];
        expect(prop.type).toBe('string');
        expect(prop.default).toBe('orbit');
    });

    it('offers the four button-table styles', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.navigationStyle'];
        expect(prop.enum).toEqual(['orbit', 'solidworks', 'tinkercad', 'touchpad']);
    });
});

describe('NukeCadPreferenceSchema resultCacheSizeMB', () => {
    it('defaults to 1024 MB', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.resultCacheSizeMB'];
        expect(prop.type).toBe('number');
        expect(prop.default).toBe(1024);
    });

    it('requires at least 1 MB', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.resultCacheSizeMB'];
        expect(prop.minimum).toBe(1);
    });
});

describe('NukeCadPreferenceSchema display precision', () => {
    it('defaults to two length decimals and one angle decimal', () => {
        expect(NukeCadPreferenceSchema.properties['nukeCad.lengthDecimals'].default).toBe(2);
        expect(NukeCadPreferenceSchema.properties['nukeCad.angleDecimals'].default).toBe(1);
    });

    it('accepts zero through six decimals', () => {
        for (const name of ['nukeCad.lengthDecimals', 'nukeCad.angleDecimals']) {
            const prop = NukeCadPreferenceSchema.properties[name];
            expect(prop.type).toBe('number');
            expect(prop.minimum).toBe(0);
            expect(prop.maximum).toBe(6);
        }
    });
});

describe('NukeCadPreferenceSchema ribbon customization', () => {
    it('shows ribbon labels by default', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.ribbonLabels'];
        expect(prop.type).toBe('boolean');
        expect(prop.default).toBe(true);
    });

    it('defaults to no pinned commands and keeps the id list unique', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.ribbonPins'];
        expect(prop.type).toBe('array');
        expect(prop.default).toEqual([]);
        expect(prop.uniqueItems).toBe(true);
        expect((prop.items as { type?: string }).type).toBe('string');
    });
});

describe('NukeCadPreferenceSchema appearance presets', () => {
    it('defaults to an empty preset library', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.appearancePresets'];
        expect(prop.type).toBe('array');
        expect(prop.default).toEqual([]);
    });

    it('describes the preset item shape', () => {
        const items = NukeCadPreferenceSchema.properties['nukeCad.appearancePresets'].items as {
            type?: string;
            required?: string[];
            properties?: Record<string, { type?: string; minLength?: number; pattern?: string; minimum?: number; maximum?: number }>;
        };
        expect(items.type).toBe('object');
        expect(items.required).toEqual(['name', 'color', 'opacity']);
        expect(items.properties?.name.type).toBe('string');
        expect(items.properties?.name.minLength).toBe(1);
        expect(items.properties?.color.pattern).toBe('^#[0-9a-fA-F]{6}$');
        expect(items.properties?.opacity.minimum).toBe(0);
        expect(items.properties?.opacity.maximum).toBe(1);
    });
});

describe('NukeCadPreferenceSchema color by material', () => {
    it('defaults off so explicit appearance and the theme base are unchanged', () => {
        const prop = NukeCadPreferenceSchema.properties['nukeCad.colorByMaterial'];
        expect(prop.type).toBe('boolean');
        expect(prop.default).toBe(false);
    });

    it('documents that explicit appearance colors win', () => {
        expect(NukeCadPreferenceSchema.properties['nukeCad.colorByMaterial'].description).toContain('Explicit body appearance colors win');
    });
});

describe('NukeCadPreferenceSchema origin axes', () => {
    it('shows the world-origin triad and all three axes by default', () => {
        for (const name of ['nukeCad.showOriginAxes', 'nukeCad.showOriginX', 'nukeCad.showOriginY', 'nukeCad.showOriginZ']) {
            const prop = NukeCadPreferenceSchema.properties[name];
            expect(prop.type).toBe('boolean');
            expect(prop.default).toBe(true);
        }
    });

    it('describes the master switch and each axis in its own setting', () => {
        expect(NukeCadPreferenceSchema.properties['nukeCad.showOriginAxes'].description).toContain('world-origin axis triad');
        expect(NukeCadPreferenceSchema.properties['nukeCad.showOriginX'].description).toContain('X axis');
        expect(NukeCadPreferenceSchema.properties['nukeCad.showOriginY'].description).toContain('Y axis');
        expect(NukeCadPreferenceSchema.properties['nukeCad.showOriginZ'].description).toContain('Z axis');
    });
});
