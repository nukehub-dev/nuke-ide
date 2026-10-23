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
