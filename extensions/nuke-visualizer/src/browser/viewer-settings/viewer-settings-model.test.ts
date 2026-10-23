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
    RANGE_SLIDER_STEPS,
    VIEWER_SETTINGS_WIDGET_IDS,
    VIEWER_SNAP_ACTIONS,
    isViewerSettingsWidgetId,
    rangeSliderToValue,
    rangeValueToSlider,
    resolveViewerSettingsTargetId,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
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

    it('binds the main-area viewer when the panel itself holds active and current', () => {
        expect(
            resolveViewerSettingsTargetId(
                'nuke-visualizer-viewer-settings-widget',
                'nuke-visualizer-viewer-settings-widget',
                'native-vtk-viewer-widget:/tmp/native-polydata.vtp'
            )
        ).toBe('native-vtk-viewer-widget:/tmp/native-polydata.vtp');
    });

    it('prefers active, then current, then the main-area tab', () => {
        expect(
            resolveViewerSettingsTargetId(
                'dagmc-viewer-widget:/tmp/a.vtm',
                'native-vtk-viewer-widget:/tmp/b.vtp',
                'tally-native-viewer-widget:/tmp/c.vti'
            )
        ).toBe('dagmc-viewer-widget:/tmp/a.vtm');
        expect(
            resolveViewerSettingsTargetId(
                'code-editor-widget',
                'native-vtk-viewer-widget:/tmp/b.vtp',
                'tally-native-viewer-widget:/tmp/c.vti'
            )
        ).toBe('native-vtk-viewer-widget:/tmp/b.vtp');
        expect(resolveViewerSettingsTargetId('code-editor-widget', 'explorer-widget', 'tally-native-viewer-widget:/tmp/c.vti')).toBe(
            'tally-native-viewer-widget:/tmp/c.vti'
        );
        expect(resolveViewerSettingsTargetId('code-editor-widget', 'explorer-widget', 'terminal-widget')).toBe(undefined);
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

describe('viewer-settings-model display contract', () => {
    it('composes a patch with every display-section field', () => {
        const patch: ViewerSettingsPatch = {
            colorBy: 'Point: flux',
            colormap: 'Cool to Warm',
            component: 0,
            range: [0, 2.5],
            invert: true,
            logScale: true,
            scalarBarVisible: false,
            solidColor: '#4A90D9',
            background: '#1E1E1E',
            shading: 'shaded',
            pointSize: 3,
            lineWidth: 2,
            opacity: 0.8
        };
        expect(patch.range).toEqual([0, 2.5]);
        expect(patch.component).toBe(0);
        expect(patch.solidColor).toBe('#4A90D9');
        expect(patch.background).toBe('#1E1E1E');
    });

    it('accepts the auto range sentinel alongside custom tuples', () => {
        const auto: ViewerSettingsPatch = { range: 'auto' };
        const custom: ViewerSettingsPatch = { range: [-1, 1] };
        expect(auto.range).toBe('auto');
        expect(custom.range).toEqual([-1, 1]);
    });

    it('carries the extended display sections on a full snapshot', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'native-vtk-viewer-widget:/tmp/mesh.vtu',
            title: 'mesh.vtu',
            hasDataset: true,
            colorBy: {
                value: 'Point: flux',
                options: [
                    { value: 'Solid Color', label: 'Solid Color' },
                    { value: 'Point: flux', label: 'Point: flux' }
                ]
            },
            component: {
                value: -1,
                options: [
                    { value: -1, label: 'Magnitude' },
                    { value: 0, label: 'X' }
                ]
            },
            colormap: {
                value: 'Cool to Warm',
                options: ['Cool to Warm'],
                disabled: false,
                invert: true,
                logScale: { value: false, disabled: true }
            },
            range: { mode: 'custom', min: 0, max: 2.5, dataMin: -0.5, dataMax: 4 },
            scalarBar: { visible: true },
            solidColor: { value: '#DDDDDD' },
            background: { value: '#1E1E1E' },
            pointSize: { value: 2, min: 1, max: 10, step: 1 },
            lineWidth: { value: 1, min: 1, max: 5, step: 0.5 },
            opacity: { value: 1, min: 0, max: 1, step: 0.05 }
        };
        expect(snapshot.component?.value).toBe(-1);
        expect(snapshot.colormap?.invert).toBe(true);
        expect(snapshot.colormap?.logScale.disabled).toBe(true);
        expect(snapshot.range?.dataMax).toBe(4);
    });

    it('leaves the extended sections absent on viewers that do not offer them', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'geometry-native-viewer-widget:/tmp/geometry.xml',
            title: 'geometry.xml',
            hasDataset: true
        };
        expect(snapshot.component).toBeUndefined();
        expect(snapshot.range).toBeUndefined();
        expect(snapshot.scalarBar).toBeUndefined();
        expect(snapshot.solidColor).toBeUndefined();
        expect(snapshot.background).toBeUndefined();
        expect(snapshot.pointSize).toBeUndefined();
        expect(snapshot.lineWidth).toBeUndefined();
        expect(snapshot.note).toBeUndefined();
    });

    it('carries an optional categorical-mode note', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'dagmc-viewer-widget:/tmp/fuel_pin_volumes.vtm',
            title: 'fuel_pin_volumes.vtm',
            hasDataset: true,
            colorBy: {
                value: 'Material',
                options: [
                    { value: 'Solid Color', label: 'Solid Color' },
                    { value: 'Material', label: 'Material' }
                ]
            },
            note: 'Color by material'
        };
        expect(snapshot.note).toBe('Color by material');
        expect(snapshot.colorBy?.value).toBe('Material');
        expect(snapshot.scalarBar).toBeUndefined();
        expect(snapshot.solidColor).toBeUndefined();
    });

    it('carries Volume and Group categorical-mode notes without a legend or solid color', () => {
        const options = [
            { value: 'Solid Color', label: 'Solid Color' },
            { value: 'Material', label: 'Material' },
            { value: 'Volume', label: 'Volume' },
            { value: 'Group', label: 'Group' }
        ];
        const volume: ViewerSettingsSnapshot = {
            widgetId: 'dagmc-viewer-widget:/tmp/fuel_pin_volumes.vtm',
            title: 'fuel_pin_volumes.vtm',
            hasDataset: true,
            colorBy: { value: 'Volume', options },
            note: 'Color by volume'
        };
        const group: ViewerSettingsSnapshot = {
            widgetId: 'dagmc-viewer-widget:/tmp/fuel_pin_volumes.vtm',
            title: 'fuel_pin_volumes.vtm',
            hasDataset: true,
            colorBy: { value: 'Group', options },
            note: 'Color by group'
        };
        expect(volume.note).toBe('Color by volume');
        expect(group.note).toBe('Color by group');
        expect(group.colorBy?.options.map((entry) => entry.value)).toEqual(['Solid Color', 'Material', 'Volume', 'Group']);
        expect(volume.scalarBar).toBeUndefined();
        expect(group.scalarBar).toBeUndefined();
        expect(volume.solidColor).toBeUndefined();
        expect(group.solidColor).toBeUndefined();
    });
});

describe('viewer-settings-model warp contract', () => {
    it('composes a patch with every warp field', () => {
        const patch: ViewerSettingsPatch = {
            warpEnabled: true,
            warpArray: 'Point: DISP',
            warpScaleMode: 'capped',
            warpScale: 12.5
        };
        expect(patch.warpArray).toBe('Point: DISP');
        expect(patch.warpScaleMode).toBe('capped');
        expect(patch.warpScale).toBe(12.5);
    });

    it('carries the warp section on a dataset with a vector array', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'native-vtk-viewer-widget:/tmp/fem.vtu',
            title: 'fem.vtu',
            hasDataset: true,
            warp: {
                enabled: true,
                array: 'Point: DISP',
                options: [{ value: 'Point: DISP', label: 'Point: DISP' }],
                scaleMode: 'auto',
                scale: 1,
                autoScale: 23.5,
                effectiveScale: 23.5
            }
        };
        expect(snapshot.warp?.enabled).toBe(true);
        expect(snapshot.warp?.array).toBe('Point: DISP');
        expect(snapshot.warp?.effectiveScale).toBe(23.5);
    });

    it('leaves the warp section absent without a 3-component vector array', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'native-vtk-viewer-widget:/tmp/flux.vti',
            title: 'flux.vti',
            hasDataset: true
        };
        expect(snapshot.warp).toBeUndefined();
    });
});

describe('viewer-settings-model threshold contract', () => {
    it('composes a patch with every threshold field', () => {
        const enable: ViewerSettingsPatch = { thresholdEnabled: true };
        const window: ViewerSettingsPatch = { thresholdRange: [1e5, 1e6] };
        const reset: ViewerSettingsPatch = { thresholdRange: 'data' };
        expect(enable.thresholdEnabled).toBe(true);
        expect(window.thresholdRange).toEqual([1e5, 1e6]);
        expect(reset.thresholdRange).toBe('data');
    });

    it('carries the threshold section beside the range on a dataset with a color-by array', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'tally-native-viewer-widget:/tmp/tally.vti',
            title: 'tally.vti',
            hasDataset: true,
            colorBy: {
                value: 'Cell: flux',
                options: [{ value: 'Solid Color', label: 'Solid Color' }]
            },
            range: { mode: 'custom', min: 0, max: 2.5, dataMin: -0.5, dataMax: 4 },
            threshold: { enabled: true, min: 1, max: 2, dataMin: -0.5, dataMax: 4, visible: 60, total: 100 }
        };
        expect(snapshot.threshold?.enabled).toBe(true);
        expect(snapshot.threshold?.min).toBe(1);
        expect(snapshot.threshold?.visible).toBe(60);
        expect(snapshot.threshold?.total).toBe(100);
    });

    it('leaves the threshold section absent in Solid Color mode (no array to test)', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'native-vtk-viewer-widget:/tmp/mesh.vtu',
            title: 'mesh.vtu',
            hasDataset: true
        };
        expect(snapshot.threshold).toBeUndefined();
    });
});

describe('viewer-settings-model glyph contract', () => {
    it('composes a patch with every glyph field', () => {
        const patch: ViewerSettingsPatch = {
            glyphEnabled: true,
            glyphDensity: 0.25,
            glyphScale: 1.5
        };
        expect(patch.glyphEnabled).toBe(true);
        expect(patch.glyphDensity).toBe(0.25);
        expect(patch.glyphScale).toBe(1.5);
    });

    it('carries the glyph section on a viewer resolving per-point vectors', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'openmc-tracks-viewer-widget:/tmp/tracks.h5',
            title: 'tracks.h5',
            hasDataset: true,
            glyph: { enabled: true, density: 0.1, scale: 1, count: 120, total: 1200 }
        };
        expect(snapshot.glyph?.enabled).toBe(true);
        expect(snapshot.glyph?.count).toBe(120);
        expect(snapshot.glyph?.total).toBe(1200);
    });

    it('leaves the glyph section absent without per-point vectors', () => {
        const snapshot: ViewerSettingsSnapshot = {
            widgetId: 'tally-native-viewer-widget:/tmp/tally.vti',
            title: 'tally.vti',
            hasDataset: true
        };
        expect(snapshot.glyph).toBeUndefined();
    });
});

describe('viewer-settings-model range slider', () => {
    it('round-trips thumbs and values over the data span', () => {
        expect(rangeSliderToValue(0, 2, 10)).toBe(2);
        expect(rangeSliderToValue(RANGE_SLIDER_STEPS, 2, 10)).toBe(10);
        expect(rangeSliderToValue(RANGE_SLIDER_STEPS / 2, 0, 100)).toBe(50);
        expect(rangeSliderToValue(-5, 2, 10)).toBe(2);
        expect(rangeSliderToValue(RANGE_SLIDER_STEPS + 9, 2, 10)).toBe(10);
        expect(rangeValueToSlider(2, 2, 10)).toBe(0);
        expect(rangeValueToSlider(10, 2, 10)).toBe(RANGE_SLIDER_STEPS);
        expect(rangeValueToSlider(6, 2, 10)).toBe(RANGE_SLIDER_STEPS / 2);
        expect(rangeValueToSlider(-99, 2, 10)).toBe(0);
        expect(rangeValueToSlider(99, 2, 10)).toBe(RANGE_SLIDER_STEPS);
        expect(rangeValueToSlider(5, 5, 5)).toBe(0);
    });
});
