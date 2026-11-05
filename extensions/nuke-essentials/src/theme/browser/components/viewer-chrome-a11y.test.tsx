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
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NukeDialog } from './nuke-dialog';
import { NukePanel } from './nuke-panel';
import { ViewBadge } from './view-badge';
import { ViewCube } from './view-cube';
import { ViewerNavBar } from './viewer-nav-bar';

describe('viewer chrome accessibility', () => {
    it('labels the icon-only bottom-bar buttons', () => {
        const html = renderToStaticMarkup(<ViewerNavBar onAction={() => undefined} />);
        expect(html).toContain('aria-label="Fit view"');
        expect(html).toContain('aria-label="Zoom in"');
        expect(html).toContain('aria-label="Zoom out"');
        expect(html).not.toContain('title=');
    });

    it('labels every ViewCube knob with its signed axis', () => {
        const html = renderToStaticMarkup(<ViewCube onSnap={() => undefined} />);
        expect(html).toContain('aria-label="Snap to X view"');
        expect(html).toContain('aria-label="Snap to -X view"');
        expect(html).not.toContain('title=');
    });

    it('labels the shared dialog and panel close buttons without native titles', () => {
        const dialog = renderToStaticMarkup(
            <NukeDialog title="Test dialog" onClose={() => undefined}>
                Body
            </NukeDialog>
        );
        expect(dialog).toContain('aria-label="Close"');
        expect(dialog).not.toContain('title=');

        const panel = renderToStaticMarkup(
            <NukePanel title="Test panel" onClose={() => undefined}>
                Body
            </NukePanel>
        );
        expect(panel).toContain('aria-label="Close"');
        expect(panel).not.toContain('title=');
    });

    it('renders the dataset badge without a native title tooltip', () => {
        const html = renderToStaticMarkup(<ViewBadge text="fuel_pin.vtk" />);
        expect(html).toContain('fuel_pin.vtk');
        expect(html).not.toContain('title=');
    });
});
