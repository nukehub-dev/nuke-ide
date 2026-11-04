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
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NukeEmptyState } from './nuke-empty-state';

describe('NukeEmptyState', () => {
    it('renders the plain icon variant by default', () => {
        const html = renderToStaticMarkup(<NukeEmptyState icon="layers" title="Empty" message="Nothing here." />);
        expect(html).toContain('nuke-empty-state-icon');
        expect(html).toContain('codicon-layers');
        expect(html).not.toContain('nuke-empty-state-illustration');
    });

    it('renders the illustration tile for a codicon when requested', () => {
        const html = renderToStaticMarkup(<NukeEmptyState variant="illustration" icon="layers" title="Empty" message="Nothing here." />);
        expect(html).toContain('nuke-empty-state-illustration');
        expect(html).toContain('nuke-empty-state-illustration-icon');
        expect(html).toContain('codicon-layers');
        expect(html).not.toContain('nuke-empty-state-icon');
    });

    it('prefers a custom illustration and renders the content slots', () => {
        const html = renderToStaticMarkup(
            <NukeEmptyState iconNode={<span data-testid="custom-icon" />} title="No data" message="Open a file." hint="Supported formats">
                <button>Browse</button>
            </NukeEmptyState>
        );
        expect(html).toContain('data-testid="custom-icon"');
        expect(html).toContain('No data');
        expect(html).toContain('Open a file.');
        expect(html).toContain('Supported formats');
        expect(html).toContain('Browse');
    });
});
