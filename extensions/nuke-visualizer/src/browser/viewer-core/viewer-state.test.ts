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
 * Tests for the versioned viewer-state schema: canonical round-trips,
 * section defaults, strict rejection (types, unknown fields, non-finite and
 * out-of-range numbers), migration hooks, forward compatibility, and the
 * snapshot/patch adapters. No DOM, no three.js, no Theia.
 */

import { describe, expect, it } from 'vitest';
import type { ViewerSettingsSnapshot } from '../viewer-settings/viewer-settings-model';
import { DEFAULT_CLIP_PLANES_STATE } from './clip-plane';
import { DEFAULT_GLYPH_DENSITY, DEFAULT_GLYPH_SCALE, GLYPH_DENSITY_SPEC, GLYPH_SCALE_SPEC } from './glyph-layout';
import { MAGNITUDE_COMPONENT } from './scalar-mapping';
import { DEFAULT_VIEWER_SHADING_MODE } from './shading-mode';
import { DEFAULT_VIEWER_TOOLBAR_STATE, LINE_WIDTH_SPEC, OPACITY_SPEC, POINT_SIZE_SPEC, SOLID_COLOR } from './viewer-toolbar-model';
import { DEFAULT_OPACITY_STOPS, DEFAULT_VOLUME_TRANSFER, MAX_OPACITY_STOPS } from './volume-transfer';
import { DEFAULT_WARP_SCALE_MODE, WARP_EXAGGERATION_SPEC } from './warp-vectors';
import {
    DEFAULT_VIEWER_STATE,
    VIEWER_STATE_VERSION,
    normalizeViewerState,
    parseViewerState,
    serializeViewerState,
    viewerStateFromSnapshot,
    viewerStateToPatch,
    type ViewerCameraState,
    type ViewerState
} from './viewer-state';

const CAMERA: ViewerCameraState = {
    position: [12, 8, 6],
    target: [1, 2, 3],
    up: [0, 0, 1],
    orthographic: true
};

function fullState(): ViewerState {
    return {
        version: VIEWER_STATE_VERSION,
        camera: CAMERA,
        mapping: {
            colorBy: 'Cell: temperature',
            colormap: 'Viridis',
            component: 1,
            rangeMode: 'custom',
            range: [250, 900],
            invert: true,
            logScale: false,
            solidColor: '#ff8800',
            background: '#101020'
        },
        shading: 'edges',
        opacity: 0.6,
        pointSize: 4.5,
        lineWidth: 2.5,
        clip: {
            planes: {
                X: { enabled: true, fraction: 0.25, invert: false },
                Y: { enabled: false, fraction: 0.5, invert: true },
                Z: { enabled: true, fraction: 0.75, invert: false }
            },
            caps: false
        },
        threshold: { enabled: true, range: [10, 20] },
        warp: { enabled: true, array: 'DISP', scaleMode: 'capped', scale: 12.5 },
        glyph: { enabled: true, density: 0.35, scale: 2 },
        volume: {
            visible: true,
            smooth: true,
            opacityStops: [
                { t: 0.3, alpha: 0.1 },
                { t: 0.8, alpha: 0.9 }
            ],
            blendMode: 'composite',
            shade: true
        },
        slice: { axis: 'Y', fraction: 0.4, smooth: true },
        legend: { visible: false },
        axesGrid: { visible: true }
    };
}

function rawState(value: unknown): string {
    return JSON.stringify(value);
}

function minimalSnapshot(): ViewerSettingsSnapshot {
    return { widgetId: 'native-vtk-viewer-widget:/tmp/a.vtp', title: 'a.vtp', hasDataset: false };
}

function fullSnapshot(): ViewerSettingsSnapshot {
    return {
        widgetId: 'native-vtk-viewer-widget:/tmp/a.vtp',
        title: 'a.vtp',
        hasDataset: true,
        colorBy: { value: 'Cell: temperature', options: [{ value: 'Cell: temperature', label: 'Cell: temperature' }] },
        colormap: {
            value: 'Viridis',
            options: ['Viridis'],
            disabled: false,
            invert: true,
            logScale: { value: false, disabled: false }
        },
        component: { value: 1, options: [{ value: MAGNITUDE_COMPONENT, label: 'Magnitude' }] },
        range: { mode: 'custom', min: 250, max: 900, dataMin: 200, dataMax: 1000 },
        threshold: { enabled: true, min: 10, max: 20, dataMin: 0, dataMax: 100, visible: 5, total: 10 },
        scalarBar: { visible: false },
        volume: {
            visible: true,
            smooth: true,
            opacityStops: [
                { t: 0.3, alpha: 0.1 },
                { t: 0.8, alpha: 0.9 }
            ],
            blendMode: 'composite',
            shade: true
        },
        slice: { axis: 'Y', fraction: 0.4, smooth: true },
        warp: {
            enabled: true,
            array: 'DISP',
            options: [{ value: 'DISP', label: 'DISP' }],
            scaleMode: 'capped',
            scale: 12.5,
            autoScale: 1,
            effectiveScale: 12.5
        },
        glyph: { enabled: true, density: 0.35, scale: 2, count: 10, total: 100 },
        solidColor: { value: '#ff8800' },
        background: { value: '#101020' },
        shading: { value: 'edges' },
        clip: {
            state: {
                X: { enabled: true, fraction: 0.25, invert: false },
                Y: { enabled: false, fraction: 0.5, invert: true },
                Z: { enabled: true, fraction: 0.75, invert: false }
            },
            tab: 'Z',
            caps: false
        },
        measure: { active: true },
        opacity: { value: 0.6, ...OPACITY_SPEC },
        pointSize: { value: 4.5, ...POINT_SIZE_SPEC },
        lineWidth: { value: 2.5, ...LINE_WIDTH_SPEC }
    };
}

describe('serializeViewerState / parseViewerState', () => {
    it('round-trips a fully populated state and re-serializes canonically', () => {
        const state = fullState();
        const text = serializeViewerState(state);
        const parsed = parseViewerState(text);
        expect(parsed).toEqual(state);
        expect(serializeViewerState(parsed as ViewerState)).toBe(text);
    });

    it('writes schema-order keys and stamps the version', () => {
        const text = serializeViewerState(DEFAULT_VIEWER_STATE);
        expect(Object.keys(JSON.parse(text))).toEqual([
            'version',
            'camera',
            'mapping',
            'shading',
            'opacity',
            'pointSize',
            'lineWidth',
            'clip',
            'threshold',
            'warp',
            'glyph',
            'volume',
            'slice',
            'legend',
            'axesGrid'
        ]);
        expect(JSON.parse(text).version).toBe(VIEWER_STATE_VERSION);
        expect(text).toBe(serializeViewerState(JSON.parse(text)));
    });

    it('omits non-applicable optional fields', () => {
        const json = JSON.parse(serializeViewerState(DEFAULT_VIEWER_STATE));
        expect(json.mapping).not.toHaveProperty('range');
        expect(json.mapping).not.toHaveProperty('solidColor');
        expect(json.mapping).not.toHaveProperty('background');
        expect(json.threshold).not.toHaveProperty('range');
    });

    it('throws when handed a state that violates the schema', () => {
        expect(() => serializeViewerState({ ...DEFAULT_VIEWER_STATE, opacity: Number.NaN })).toThrow(TypeError);
        expect(() => serializeViewerState({ ...DEFAULT_VIEWER_STATE, shading: 'glow' as never })).toThrow(TypeError);
    });
});

describe('defaults', () => {
    it('fills every missing section from the defaults', () => {
        expect(parseViewerState(rawState({ version: 1 }))).toEqual(DEFAULT_VIEWER_STATE);
        expect(normalizeViewerState({ version: 1 })).toEqual(DEFAULT_VIEWER_STATE);
    });

    it('fills missing fields inside a present section', () => {
        const camera = parseViewerState(rawState({ version: 1, camera: { position: [2, 3, 4] } }))?.camera;
        expect(camera).toEqual({ position: [2, 3, 4], target: [0, 0, 0], up: [0, 1, 0], orthographic: false });

        const clip = parseViewerState(rawState({ version: 1, clip: { caps: false } }))?.clip;
        expect(clip).toEqual({ planes: DEFAULT_CLIP_PLANES_STATE, caps: false });

        const threshold = parseViewerState(rawState({ version: 1, threshold: { enabled: true } }))?.threshold;
        expect(threshold).toEqual({ enabled: true });
    });

    it('matches the viewer factory defaults', () => {
        expect(DEFAULT_VIEWER_STATE.mapping.colorBy).toBe(SOLID_COLOR);
        expect(DEFAULT_VIEWER_STATE.mapping.colormap).toBe(DEFAULT_VIEWER_TOOLBAR_STATE.colormap);
        expect(DEFAULT_VIEWER_STATE.mapping.component).toBe(MAGNITUDE_COMPONENT);
        expect(DEFAULT_VIEWER_STATE.mapping.rangeMode).toBe('auto');
        expect(DEFAULT_VIEWER_STATE.shading).toBe(DEFAULT_VIEWER_SHADING_MODE);
        expect(DEFAULT_VIEWER_STATE.opacity).toBe(OPACITY_SPEC.defaultValue);
        expect(DEFAULT_VIEWER_STATE.pointSize).toBe(POINT_SIZE_SPEC.defaultValue);
        expect(DEFAULT_VIEWER_STATE.lineWidth).toBe(LINE_WIDTH_SPEC.defaultValue);
        expect(DEFAULT_VIEWER_STATE.clip.caps).toBe(true);
        expect(DEFAULT_VIEWER_STATE.warp).toEqual({ enabled: false, array: '', scaleMode: DEFAULT_WARP_SCALE_MODE, scale: 1 });
        expect(DEFAULT_VIEWER_STATE.glyph).toEqual({ enabled: false, density: DEFAULT_GLYPH_DENSITY, scale: DEFAULT_GLYPH_SCALE });
        expect(DEFAULT_VIEWER_STATE.volume.opacityStops).toEqual(DEFAULT_OPACITY_STOPS);
        expect(DEFAULT_VIEWER_STATE.volume.blendMode).toBe(DEFAULT_VOLUME_TRANSFER.blendMode);
        expect(DEFAULT_VIEWER_STATE.slice).toEqual({ axis: 'Z', fraction: 0.5, smooth: false });
        expect(DEFAULT_VIEWER_STATE.legend).toEqual({ visible: true });
        expect(DEFAULT_VIEWER_STATE.axesGrid).toEqual({ visible: false });
    });
});

describe('invalid payloads', () => {
    it('rejects malformed JSON and non-object roots without throwing', () => {
        for (const text of ['', '   ', 'not json', 'null', '[]', '42', '"text"', '{}', '{"version":1}extra']) {
            expect(parseViewerState(text)).toBeUndefined();
        }
    });

    it('rejects missing, future, and malformed versions', () => {
        expect(parseViewerState(rawState({ version: 2 }))).toBeUndefined();
        expect(parseViewerState(rawState({ ...fullState(), version: 2 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1.5 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: '1' }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: -1 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 0 }))).toBeUndefined();
    });

    it('rejects unknown fields at every level', () => {
        expect(parseViewerState(rawState({ version: 1, futureSection: {} }))).toBeUndefined();
        expect(
            parseViewerState(
                rawState({ version: 1, camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 1, 0], orthographic: false, fov: 45 } })
            )
        ).toBeUndefined();
        expect(
            parseViewerState(
                rawState({
                    version: 1,
                    clip: {
                        planes: {
                            X: { enabled: true, fraction: 0.5, invert: false, flip: false },
                            Y: { enabled: false, fraction: 0.5, invert: false },
                            Z: { enabled: false, fraction: 0.5, invert: false }
                        }
                    }
                })
            )
        ).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: [{ t: 0, alpha: 1, color: '#fff' }] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, legend: { visible: true, title: 'T' } }))).toBeUndefined();
    });

    it('rejects wrong field types and unknown enum values', () => {
        expect(parseViewerState(rawState({ version: 1, opacity: '0.5' }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, shading: 'glow' }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, clip: { caps: 'yes' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, threshold: { enabled: 1 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, warp: { scaleMode: 'huge' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, glyph: { enabled: 'yes' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, volume: { blendMode: 'average' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, slice: { axis: 'W' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, axesGrid: { visible: 1 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, legend: { visible: 'yes' } }))).toBeUndefined();
    });

    it('rejects degenerate camera poses', () => {
        expect(
            parseViewerState(rawState({ version: 1, camera: { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0] } }))
        ).toBeUndefined();
        expect(
            parseViewerState(rawState({ version: 1, camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 0] } }))
        ).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, camera: { position: [1, 1], target: [0, 0, 0], up: [0, 1, 0] } }))).toBeUndefined();
    });
});

describe('non-finite and out-of-range numeric fields', () => {
    it('rejects Infinity that JSON exponent syntax produces', () => {
        expect(parseViewerState('{"version":1,"opacity":1e999}')).toBeUndefined();
        expect(parseViewerState('{"version":1,"camera":{"position":[1e999,0,0],"target":[0,0,0],"up":[0,1,0]}}')).toBeUndefined();
        expect(parseViewerState('{"version":1,"threshold":{"enabled":true,"range":[0,1e999]}}')).toBeUndefined();
        expect(parseViewerState('{"version":1,"volume":{"opacityStops":[{"t":0,"alpha":1e999}]}}')).toBeUndefined();
    });

    it('rejects NaN and Infinity in an already-parsed object', () => {
        expect(normalizeViewerState({ ...DEFAULT_VIEWER_STATE, opacity: Number.NaN })).toBeUndefined();
        expect(normalizeViewerState({ ...DEFAULT_VIEWER_STATE, pointSize: Number.POSITIVE_INFINITY })).toBeUndefined();
        expect(normalizeViewerState({ ...DEFAULT_VIEWER_STATE, lineWidth: Number.NEGATIVE_INFINITY })).toBeUndefined();
        expect(
            normalizeViewerState({ ...DEFAULT_VIEWER_STATE, camera: { ...DEFAULT_VIEWER_STATE.camera, position: [0, Number.NaN, 0] } })
        ).toBeUndefined();
        expect(
            normalizeViewerState({
                ...DEFAULT_VIEWER_STATE,
                volume: { ...DEFAULT_VIEWER_STATE.volume, opacityStops: [{ t: Number.NaN, alpha: 1 }] }
            })
        ).toBeUndefined();
    });

    it('rejects out-of-range display sliders', () => {
        expect(parseViewerState(rawState({ version: 1, opacity: 1.01 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, opacity: -0.01 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, pointSize: 0 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, pointSize: 21 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, lineWidth: 0.1 }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, lineWidth: 11 }))).toBeUndefined();
    });

    it('normalizes negative zero so round-trips are exact', () => {
        const state = normalizeViewerState({ ...DEFAULT_VIEWER_STATE, camera: { ...CAMERA, target: [-0, 0, -0] } });
        expect(state?.camera.target).toEqual([0, 0, 0]);
        expect(Object.is(state?.camera.target[0], 0)).toBe(true);
    });
});

describe('mapping', () => {
    it('accepts a custom range and normalizes inverted endpoints', () => {
        const state = parseViewerState(
            rawState({
                version: 1,
                mapping: {
                    colorBy: 'Point: flux',
                    colormap: 'Plasma',
                    component: -1,
                    rangeMode: 'custom',
                    range: [900, 250],
                    invert: true,
                    logScale: true
                }
            })
        );
        expect(state?.mapping).toEqual({
            colorBy: 'Point: flux',
            colormap: 'Plasma',
            component: MAGNITUDE_COMPONENT,
            rangeMode: 'custom',
            range: [250, 900],
            invert: true,
            logScale: true
        });
    });

    it('requires a range in custom mode and forbids one in auto mode', () => {
        expect(parseViewerState(rawState({ version: 1, mapping: { rangeMode: 'custom' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { rangeMode: 'auto', range: [0, 1] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { rangeMode: 'custom', range: [0, 1, 2] } }))).toBeUndefined();
    });

    it('rejects invalid components and empty names', () => {
        expect(parseViewerState(rawState({ version: 1, mapping: { component: -2 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { component: 64 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { component: 1.5 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { colorBy: '' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { colormap: '' } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, mapping: { background: 7 } }))).toBeUndefined();
    });

    it('keeps optional solid color and background', () => {
        const state = parseViewerState(rawState({ version: 1, mapping: { solidColor: '#123456', background: 'rgb(1, 2, 3)' } }));
        expect(state?.mapping.solidColor).toBe('#123456');
        expect(state?.mapping.background).toBe('rgb(1, 2, 3)');
    });
});

describe('clip, threshold, warp', () => {
    it('round-trips per-axis clip planes and caps', () => {
        const state = parseViewerState(
            rawState({
                version: 1,
                clip: {
                    planes: {
                        X: { enabled: true, fraction: 0.25, invert: false },
                        Y: { enabled: false, fraction: 0.5, invert: true },
                        Z: { enabled: true, fraction: 0.75, invert: false }
                    },
                    caps: false
                }
            })
        );
        expect(state?.clip).toEqual(fullState().clip);
    });

    it('rejects clip fractions outside [0, 1] and unknown axes', () => {
        const fractions = [1.01, -0.01];
        for (const fraction of fractions) {
            expect(
                parseViewerState(rawState({ version: 1, clip: { planes: { X: { enabled: true, fraction, invert: false } } } }))
            ).toBeUndefined();
        }
        expect(
            parseViewerState(
                rawState({
                    version: 1,
                    clip: {
                        planes: {
                            X: { enabled: true, fraction: 0.5, invert: false },
                            Y: { enabled: false, fraction: 0.5, invert: false },
                            Z: { enabled: false, fraction: 0.5, invert: false },
                            W: { enabled: false, fraction: 0.5, invert: false }
                        }
                    }
                })
            )
        ).toBeUndefined();
    });

    it('round-trips threshold state and normalizes inverted windows', () => {
        expect(parseViewerState(rawState({ version: 1, threshold: { enabled: true, range: [20, 10] } }))?.threshold).toEqual({
            enabled: true,
            range: [10, 20]
        });
        expect(parseViewerState(rawState({ version: 1, threshold: { enabled: false } }))?.threshold).toEqual({ enabled: false });
    });

    it('rejects threshold ranges with invalid endpoints', () => {
        expect(parseViewerState(rawState({ version: 1, threshold: { range: [0] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, threshold: { range: [0, '1'] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, threshold: { range: [0, 1], mode: 'custom' } }))).toBeUndefined();
    });

    it('round-trips warp state and keeps a selected array while disabled', () => {
        expect(
            parseViewerState(rawState({ version: 1, warp: { enabled: true, array: 'DISP', scaleMode: 'capped', scale: 12.5 } }))?.warp
        ).toEqual({ enabled: true, array: 'DISP', scaleMode: 'capped', scale: 12.5 });
        expect(parseViewerState(rawState({ version: 1, warp: { enabled: false, array: 'DISP' } }))?.warp).toEqual({
            enabled: false,
            array: 'DISP',
            scaleMode: DEFAULT_WARP_SCALE_MODE,
            scale: 1
        });
    });

    it('rejects enabling warp without an array and exaggerations outside the slider', () => {
        expect(parseViewerState(rawState({ version: 1, warp: { enabled: true } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, warp: { array: 7 } }))).toBeUndefined();
        for (const scale of [WARP_EXAGGERATION_SPEC.max + 1, WARP_EXAGGERATION_SPEC.min - 1]) {
            expect(parseViewerState(rawState({ version: 1, warp: { array: 'DISP', scale } }))).toBeUndefined();
        }
    });
});

describe('glyph, volume, slice, legend, axes grid', () => {
    it('round-trips glyph density and scale', () => {
        expect(parseViewerState(rawState({ version: 1, glyph: { enabled: true, density: 0.35, scale: 2 } }))?.glyph).toEqual({
            enabled: true,
            density: 0.35,
            scale: 2
        });
    });

    it('rejects glyph values outside the slider ranges', () => {
        for (const density of [GLYPH_DENSITY_SPEC.min - 0.01, GLYPH_DENSITY_SPEC.max + 0.01]) {
            expect(parseViewerState(rawState({ version: 1, glyph: { density } }))).toBeUndefined();
        }
        for (const scale of [GLYPH_SCALE_SPEC.min - 0.01, GLYPH_SCALE_SPEC.max + 0.01]) {
            expect(parseViewerState(rawState({ version: 1, glyph: { scale } }))).toBeUndefined();
        }
    });

    it('sorts volume opacity stops and collapses duplicate positions', () => {
        const state = parseViewerState(
            rawState({
                version: 1,
                volume: {
                    visible: true,
                    opacityStops: [
                        { t: 0.8, alpha: 0.9 },
                        { t: 0.5, alpha: 0.2 },
                        { t: 0.5, alpha: 0.7 },
                        { t: 0.1, alpha: 0.05 }
                    ],
                    blendMode: 'composite',
                    shade: true
                }
            })
        );
        expect(state?.volume).toEqual({
            visible: true,
            smooth: false,
            opacityStops: [
                { t: 0.1, alpha: 0.05 },
                { t: 0.5, alpha: 0.7 },
                { t: 0.8, alpha: 0.9 }
            ],
            blendMode: 'composite',
            shade: true
        });
    });

    it('rejects malformed or oversized opacity ramps', () => {
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: [] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: [{ t: 1.2, alpha: 1 }] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: [{ t: 0.5, alpha: -0.1 }] } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: [{ t: 0.5 }] } }))).toBeUndefined();
        const tooMany = Array.from({ length: MAX_OPACITY_STOPS + 1 }, (_, index) => ({
            t: index / MAX_OPACITY_STOPS,
            alpha: 1
        }));
        expect(parseViewerState(rawState({ version: 1, volume: { opacityStops: tooMany } }))).toBeUndefined();
    });

    it('round-trips slice state and rejects out-of-range fractions', () => {
        expect(parseViewerState(rawState({ version: 1, slice: { axis: 'Y', fraction: 0.4, smooth: true } }))?.slice).toEqual({
            axis: 'Y',
            fraction: 0.4,
            smooth: true
        });
        expect(parseViewerState(rawState({ version: 1, slice: { fraction: 1.01 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, slice: { fraction: -0.01 } }))).toBeUndefined();
        expect(parseViewerState(rawState({ version: 1, slice: { smooth: 1 } }))).toBeUndefined();
    });

    it('round-trips the legend and axes-grid flags', () => {
        const state = parseViewerState(rawState({ version: 1, legend: { visible: false }, axesGrid: { visible: true } }));
        expect(state?.legend).toEqual({ visible: false });
        expect(state?.axesGrid).toEqual({ visible: true });
        expect(parseViewerState(rawState({ version: 1 }))?.legend).toEqual({ visible: true });
        expect(parseViewerState(rawState({ version: 1 }))?.axesGrid).toEqual({ visible: false });
    });
});

describe('migrations and forward compatibility', () => {
    it('rejects future versions even when a migration is registered for them', () => {
        const future = { ...fullState(), version: 2 };
        const migrations = { 2: () => ({ version: 1 }) };
        expect(parseViewerState(rawState(future), { migrations })).toBeUndefined();
    });

    it('upgrades an older payload through a registered hook', () => {
        const legacy = rawState({ version: 0, opacity: 0.5 });
        expect(parseViewerState(legacy)).toBeUndefined();
        const state = parseViewerState(legacy, {
            migrations: { 0: (raw) => ({ version: 1, opacity: raw['opacity'] }) }
        });
        expect(state?.opacity).toBe(0.5);
        expect(state?.camera).toEqual(DEFAULT_VIEWER_STATE.camera);
    });

    it('rejects hooks that throw, return non-objects, or skip a version', () => {
        const legacy = rawState({ version: 0 });
        expect(
            parseViewerState(legacy, {
                migrations: {
                    0: () => {
                        throw new Error('migration boom');
                    }
                }
            })
        ).toBeUndefined();
        expect(parseViewerState(legacy, { migrations: { 0: () => undefined } })).toBeUndefined();
        expect(parseViewerState(legacy, { migrations: { 0: () => ({ version: 2 }) } })).toBeUndefined();
        expect(parseViewerState(legacy, { migrations: {} })).toBeUndefined();
    });
});

describe('adapters', () => {
    it('maps a restored state onto the settings patch', () => {
        const state = fullState();
        const patch = viewerStateToPatch(state);
        expect(patch.colorBy).toBe(state.mapping.colorBy);
        expect(patch.colormap).toBe(state.mapping.colormap);
        expect(patch.component).toBe(1);
        expect(patch.range).toEqual([250, 900]);
        expect(patch.invert).toBe(true);
        expect(patch.logScale).toBe(false);
        expect(patch.solidColor).toBe('#ff8800');
        expect(patch.background).toBe('#101020');
        expect(patch.scalarBarVisible).toBe(false);
        expect(patch.shading).toBe('edges');
        expect(patch.clip).toEqual(state.clip.planes);
        expect(patch.clipCaps).toBe(false);
        expect(patch.opacity).toBe(0.6);
        expect(patch.pointSize).toBe(4.5);
        expect(patch.lineWidth).toBe(2.5);
        expect(patch.thresholdEnabled).toBe(true);
        expect(patch.thresholdRange).toEqual([10, 20]);
        expect(patch.warpEnabled).toBe(true);
        expect(patch.warpArray).toBe('DISP');
        expect(patch.warpScaleMode).toBe('capped');
        expect(patch.warpScale).toBe(12.5);
        expect(patch.glyphEnabled).toBe(true);
        expect(patch.glyphDensity).toBe(0.35);
        expect(patch.glyphScale).toBe(2);
        expect(patch.volumeVisible).toBe(true);
        expect(patch.volumeSmooth).toBe(true);
        expect(patch.volumeOpacityStops).toEqual(state.volume.opacityStops);
        expect(patch.volumeBlendMode).toBe('composite');
        expect(patch.volumeShade).toBe(true);
        expect(patch.sliceAxis).toBe('Y');
        expect(patch.sliceFraction).toBe(0.4);
        expect(patch.sliceSmooth).toBe(true);
        expect(patch.measureActive).toBeUndefined();
        expect(patch.clipTab).toBeUndefined();
        expect(patch.snap).toBeUndefined();
        expect(patch.stepIndex).toBeUndefined();
    });

    it('sends auto/data resets for a default state', () => {
        const patch = viewerStateToPatch(DEFAULT_VIEWER_STATE);
        expect(patch.range).toBe('auto');
        expect(patch.thresholdRange).toBe('data');
        expect(patch.scalarBarVisible).toBe(true);
        expect(patch.solidColor).toBeUndefined();
        expect(patch.background).toBeUndefined();
    });

    it('captures a full snapshot plus camera pose', () => {
        const state = viewerStateFromSnapshot(fullSnapshot(), CAMERA);
        expect(state).toEqual({ ...fullState(), axesGrid: { visible: false } });
    });

    it('falls back to defaults for sections the viewer does not report', () => {
        expect(viewerStateFromSnapshot(minimalSnapshot(), CAMERA)).toEqual({ ...DEFAULT_VIEWER_STATE, camera: CAMERA });
    });

    it('stores a threshold window only when it differs from the data range', () => {
        const snapshot = fullSnapshot();
        const sameAsData: ViewerSettingsSnapshot = {
            ...snapshot,
            threshold: { enabled: true, min: 0, max: 100, dataMin: 0, dataMax: 100, visible: 10, total: 10 }
        };
        expect(viewerStateFromSnapshot(sameAsData, CAMERA)?.threshold).toEqual({ enabled: true });
        expect(viewerStateFromSnapshot(snapshot, CAMERA)?.threshold).toEqual({ enabled: true, range: [10, 20] });
    });

    it('rejects unusable camera poses', () => {
        const degenerate: ViewerCameraState = { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], orthographic: false };
        expect(viewerStateFromSnapshot(minimalSnapshot(), degenerate)).toBeUndefined();
        expect(viewerStateFromSnapshot(minimalSnapshot(), CAMERA)?.camera).toEqual(CAMERA);
    });
});
