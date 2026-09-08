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
import {
    VIEWER_SETTINGS_WIDGET_IDS,
    VIEWER_SNAP_ACTIONS,
    isViewerSettingsWidgetId,
    resolveViewerSettingsTargetId,
    viewerSnapDirection
} from './viewer-settings-model';

describe('viewer-settings-model binding', () => {
    it('matches every bound viewer base id', () => {
        for (const id of VIEWER_SETTINGS_WIDGET_IDS) {
            expect(isViewerSettingsWidgetId(id)).toBe(true);
        }
    });

    it('matches per-file instance ids carrying a path suffix', () => {
        expect(isViewerSettingsWidgetId('native-vtk-viewer-widget:/tmp/native-polydata.vtp')).toBe(true);
        expect(isViewerSettingsWidgetId('dagmc-viewer-widget:/tmp/native-volumes.vtm')).toBe(true);
        expect(isViewerSettingsWidgetId('tally-native-viewer-widget:/tmp/tally.vti')).toBe(true);
        expect(isViewerSettingsWidgetId('geometry-native-viewer-widget:/tmp/geometry.xml')).toBe(true);
        expect(isViewerSettingsWidgetId('exodus-time-slider-widget:/tmp/series.e')).toBe(true);
    });

    it('rejects non-viewer widgets and near-miss prefixes', () => {
        expect(isViewerSettingsWidgetId('nuke-cad-outline-panel-widget')).toBe(false);
        expect(isViewerSettingsWidgetId('nuke-visualizer-viewer-settings-widget')).toBe(false);
        expect(isViewerSettingsWidgetId('native-vtk-viewer-widget-extra')).toBe(false);
        expect(isViewerSettingsWidgetId('')).toBe(false);
    });

    it('prefers the active tab over the current tab', () => {
        expect(resolveViewerSettingsTargetId('dagmc-viewer-widget:/tmp/a.vtm', 'native-vtk-viewer-widget:/tmp/b.vtp')).toBe(
            'dagmc-viewer-widget:/tmp/a.vtm'
        );
    });

    it('falls back to the current tab when the active tab is not a viewer', () => {
        expect(resolveViewerSettingsTargetId('code-editor-widget', 'native-vtk-viewer-widget:/tmp/b.vtp')).toBe(
            'native-vtk-viewer-widget:/tmp/b.vtp'
        );
    });

    it('resolves to nothing when no tab is a viewer', () => {
        expect(resolveViewerSettingsTargetId('code-editor-widget', 'explorer-widget')).toBe(undefined);
        expect(resolveViewerSettingsTargetId(undefined, undefined)).toBe(undefined);
    });
});

describe('viewer-settings-model snap actions', () => {
    it('offers ISO/T/F/R/X/Y/Z exactly once each', () => {
        expect(VIEWER_SNAP_ACTIONS.map((action) => action.id)).toEqual(['iso', 'top', 'front', 'right', 'x', 'y', 'z']);
    });

    it('maps every button to a non-zero direction', () => {
        for (const action of VIEWER_SNAP_ACTIONS) {
            const [x, y, z] = viewerSnapDirection(action.id);
            expect(Math.sqrt(x * x + y * y + z * z)).toBeGreaterThan(0);
        }
    });

    it('keeps cluster views and axis snaps geometrically consistent', () => {
        expect(viewerSnapDirection('x')).toEqual(viewerSnapDirection('right'));
        expect(viewerSnapDirection('y')).toEqual(viewerSnapDirection('top'));
        expect(viewerSnapDirection('z')).toEqual(viewerSnapDirection('front'));
    });
});
