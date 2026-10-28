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

import { describe, expect, it } from 'vitest';
import { detectPlotlyTheme, resolvePlotlyThemeColors } from './plotly-theme';

describe('Plotly theme fallbacks', () => {
    it('defaults to dark without a browser document', () => {
        expect(detectPlotlyTheme()).toBe('dark');
    });

    it('resolves deterministic dark and light fallback palettes', () => {
        expect(resolvePlotlyThemeColors('dark')).toEqual({
            foreground: '#d4d4d4',
            descriptionForeground: '#9e9e9e',
            panelBorder: '#3c3c3c',
            editorBackground: '#1e1e1e',
            editorWidgetBackground: '#252526'
        });
        expect(resolvePlotlyThemeColors('light')).toEqual({
            foreground: '#333333',
            descriptionForeground: '#666666',
            panelBorder: '#dddddd',
            editorBackground: '#ffffff',
            editorWidgetBackground: '#f3f3f3'
        });
    });
});
