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

import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { W7X_SHAPE_DEFAULTS, planW7xShapeStudy } from '../../../common/w7x-shape-study';
import {
    W7X_SHAPE_STUDY_APPROXIMATE_WARNING,
    W7X_SHAPE_STUDY_BANNER_STATUS,
    W7X_SHAPE_STUDY_BANNER_TITLE,
    W7X_SHAPE_STUDY_BANNER_WARNING,
    W7X_SHAPE_STUDY_INVENTORY,
    defaultW7xShapeStudyDraft,
    formatW7xShapeStudyReferenceVolume,
    validateW7xShapeStudyDraft,
    type W7xShapeStudyDraft
} from './w7x-shape-study-model';
import { W7X_STUDY_EXPORT_NOTE, buildW7xDesignStudyBanner } from './w7x-study-model';

const draft = (overrides: Partial<W7xShapeStudyDraft> = {}): W7xShapeStudyDraft => ({
    width: '0.37',
    height: '0.37',
    tiltDeg: '8.6',
    twistDeg: '0',
    stations: '60',
    ...overrides
});

function textContent(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(textContent).join(' ');
    }
    if (React.isValidElement(node)) {
        return textContent((node.props as { children?: React.ReactNode }).children);
    }
    return '';
}

function countElementType(node: React.ReactNode, type: string): number {
    if (Array.isArray(node)) {
        return node.reduce((total, child) => total + countElementType(child, type), 0);
    }
    if (!React.isValidElement(node)) {
        return 0;
    }
    const own = node.type === type ? 1 : 0;
    return own + countElementType((node.props as { children?: React.ReactNode }).children, type);
}

// NukeDialog's lumino import touches `document` at module load; the node test
// environment has none. Mock the exact DOM surface it probes before importing
// the dialog modules.
let ui: typeof import('./w7x-shape-study-dialog');
let bannerUi: typeof import('./w7x-study-dialog');

beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    if (g['Element'] === undefined) {
        g['Element'] = class {};
    }
    if (g['HTMLElement'] === undefined) {
        g['HTMLElement'] = class {};
    }
    if (g['DragEvent'] === undefined) {
        g['DragEvent'] = class extends Event {};
    }
    const stubElement = (): unknown => ({
        classList: { add: (): void => undefined, remove: (): void => undefined, contains: (): boolean => false },
        style: {},
        dataset: {},
        appendChild: (): void => undefined,
        removeChild: (): void => undefined,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        setAttribute: (): void => undefined,
        removeAttribute: (): void => undefined,
        getAttribute: (): string | null => null,
        querySelector: (): null => null,
        querySelectorAll: (): unknown[] => [],
        matches: (): boolean => false,
        attachShadow: (): unknown => ({})
    });
    if (g['document'] === undefined) {
        g['document'] = {
            createElement: stubElement,
            createElementNS: stubElement,
            documentElement: { style: {} },
            body: stubElement(),
            head: stubElement(),
            addEventListener: (): void => undefined,
            removeEventListener: (): void => undefined
        };
    }
    if (g['window'] === undefined) {
        g['window'] = globalThis;
    }
    if (g['localStorage'] === undefined) {
        const store = new Map<string, string>();
        g['localStorage'] = {
            getItem: (key: string): string | null => store.get(key) ?? null,
            setItem: (key: string, value: string): void => {
                store.set(key, value);
            },
            removeItem: (key: string): void => {
                store.delete(key);
            },
            clear: (): void => {
                store.clear();
            }
        };
    }
    ui = await import('./w7x-shape-study-dialog.js');
    bannerUi = await import('./w7x-study-dialog.js');
});

describe('W7-X shape-study dialog model', () => {
    it('starts from the planner defaults', () => {
        expect(defaultW7xShapeStudyDraft()).toEqual({
            width: '0.37',
            height: '0.37',
            tiltDeg: '8.6',
            twistDeg: '0',
            stations: '60'
        });
        expect(W7X_SHAPE_DEFAULTS).toEqual({ width: 0.37, height: 0.37, tiltDeg: 8.6, twistDeg: 0, stations: 60 });
    });

    it('validates the five parameters without clamping', () => {
        expect(validateW7xShapeStudyDraft(draft())).toEqual({ ok: true, config: W7X_SHAPE_DEFAULTS });
        expect(validateW7xShapeStudyDraft(draft({ width: '0' }))).toEqual({
            ok: false,
            error: 'Section width must be a positive number.'
        });
        expect(validateW7xShapeStudyDraft(draft({ height: 'nan' }))).toEqual({
            ok: false,
            error: 'Section height must be a positive number.'
        });
        expect(validateW7xShapeStudyDraft(draft({ tiltDeg: '89.5' }))).toEqual({
            ok: false,
            error: 'Tilt must be between -89 and 89 degrees.'
        });
        expect(validateW7xShapeStudyDraft(draft({ twistDeg: '' }))).toEqual({
            ok: false,
            error: 'Twist must be a finite number of degrees.'
        });
        expect(validateW7xShapeStudyDraft(draft({ stations: '7' }))).toEqual({
            ok: false,
            error: 'Stations must be a whole number between 8 and 720.'
        });
        expect(validateW7xShapeStudyDraft(draft({ stations: '60.5' })).ok).toBe(false);
        expect(validateW7xShapeStudyDraft(draft({ tiltDeg: '-89', stations: '720' })).ok).toBe(true);
    });

    it('formats the exact one-module reference volume', () => {
        expect(formatW7xShapeStudyReferenceVolume()).toBe('27.608505577 m³');
        expect(W7X_SHAPE_STUDY_INVENTORY).toBe('5 modules · 50 coils · 10 native bodies');
    });
});

describe('W7xShapeStudyDialog', () => {
    it('renders the locked inventory, defaults, warning, export restriction, and reference volume', () => {
        const html = renderToStaticMarkup(
            React.createElement(ui.W7xShapeStudyDialog, {
                onConfirm: vi.fn(),
                onCancel: vi.fn()
            })
        );
        expect(html).toContain(W7X_SHAPE_STUDY_INVENTORY);
        expect(html).toContain('Section width (m)');
        expect(html).toContain('value="0.37"');
        expect(html).toContain('value="8.6"');
        expect(html).toContain('value="60"');
        expect(html).toContain(W7X_SHAPE_STUDY_APPROXIMATE_WARNING);
        expect(html).toContain(W7X_STUDY_EXPORT_NOTE);
        expect(html).toContain('27.608505577 m³');
        expect(html).toContain('Creates 10 native coil bodies and 50 instances across 5 modules.');
        expect(html).toContain('Create Study');
    });

    it('never renders a ghost-preview control', () => {
        const html = renderToStaticMarkup(
            React.createElement(ui.W7xShapeStudyDialog, {
                onConfirm: vi.fn(),
                onCancel: vi.fn()
            })
        );
        expect(html).toContain('Coil sweeps have no live preview in this release.');
        expect(html).not.toContain('Preview (ghosted build)');
    });
});

describe('W7-X shape-study banner', () => {
    const study = planW7xShapeStudy().designStudy;

    it('builds the approximate, permanent shape-study banner model', () => {
        const model = buildW7xDesignStudyBanner(study);
        expect(model.kind).toBe('w7x-coil-shape-study');
        expect(model.moduleCount).toBe(5);
        expect(model.valid).toBe(true);
        expect(model.approximate).toBe(true);
        expect(model.title).toBe(W7X_SHAPE_STUDY_BANNER_TITLE);
        expect(model.title).toBe('W7-X coil shape study · 5 modules');
        expect(model.statusLabel).toBe(W7X_SHAPE_STUDY_BANNER_STATUS);
        expect(model.statusLabel).toBe('Approximate coils');
        expect(model.summary).toBe(study.report.summary);
        expect(model.warning).toBe(W7X_SHAPE_STUDY_BANNER_WARNING);
        expect(model.warning).toBe('Native sweeps approximate the reference B-rep.');
        expect(model.exportNote).toBe(W7X_STUDY_EXPORT_NOTE);
        expect(model.ariaLabel).toContain('approximate geometry');
    });

    it('renders the banner text with no dismiss control', () => {
        const element = bannerUi.W7xDesignStudyBanner({ study });
        const props = element.props as { className?: string; role?: string; 'data-study-kind'?: string };
        expect(props.className).toContain('approximate');
        expect(props.role).toBe('status');
        expect(props['data-study-kind']).toBe('w7x-coil-shape-study');
        expect(countElementType(element, 'button')).toBe(0);
        const text = textContent(element);
        expect(text).toContain('W7-X coil shape study · 5 modules');
        expect(text).toContain('Approximate coils');
        expect(text).toContain(study.report.summary);
        expect(text).toContain('Native sweeps approximate the reference B-rep.');
        expect(text).toContain('Simulation export disabled');
    });
});
