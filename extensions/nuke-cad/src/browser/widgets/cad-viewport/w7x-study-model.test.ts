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
import { studyReport, type W7xCoilStudy, type W7xStudyModuleCount } from '../../../common/w7x-study';
import {
    W7X_STUDY_DEFAULT_MODULE_COUNT,
    W7X_STUDY_EXPORT_NOTE,
    W7X_STUDY_WARNING,
    buildW7xDesignStudyBanner,
    buildW7xStudyReportView,
    selectW7xStudyReport,
    type W7xStudyReportSet
} from './w7x-study-model';

const reports: W7xStudyReportSet = {
    4: studyReport(4),
    5: studyReport(5),
    6: studyReport(6)
};

const study = (moduleCount: W7xStudyModuleCount): W7xCoilStudy => ({ kind: 'w7x-coil-study', report: reports[moduleCount] });

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
// the dialog module.
let ui: typeof import('./w7x-study-dialog');

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
    ui = await import('./w7x-study-dialog.js');
});

describe('W7-X coil-study report model', () => {
    it('selects the committed report for the chosen module count and defaults to the valid layout', () => {
        expect(W7X_STUDY_DEFAULT_MODULE_COUNT).toBe(5);
        for (const moduleCount of [4, 5, 6] as const) {
            const report = selectW7xStudyReport(reports, moduleCount);
            expect(report.moduleCount).toBe(moduleCount);
            expect(report.valid).toBe(moduleCount === 5);
        }
    });

    it('renders the four-module gap and five coil/shell collisions', () => {
        const view = buildW7xStudyReportView(reports[4]);
        expect(view.statusLabel).toBe('Invalid layout');
        expect(view.metrics.find((metric) => metric.id === 'pitch')?.value).toBe('90°');
        expect(view.metrics.find((metric) => metric.id === 'uncovered')?.value).toBe('24.6598°');
        expect(view.metrics.find((metric) => metric.id === 'clearance')?.value).toBe('—');
        expect(view.coilCoilOverlaps).toHaveLength(0);
        expect(view.coilShellOverlaps).toHaveLength(5);
        expect(view.coilShellOverlaps[0]).toEqual({
            a: 'coil_01_m1',
            b: 'plasma',
            volume: '0.072624 m³'
        });
    });

    it('renders the five-module clearance and empty collision lists', () => {
        const view = buildW7xStudyReportView(reports[5]);
        expect(view.statusLabel).toBe('Valid layout');
        expect(view.metrics.find((metric) => metric.id === 'pitch')?.value).toBe('72°');
        expect(view.metrics.find((metric) => metric.id === 'clearance')?.value).toBe('~0.103 m');
        expect(view.coilCoilOverlaps).toHaveLength(0);
        expect(view.coilShellOverlaps).toHaveLength(0);
    });

    it('renders the six-module overlap and three coil/coil collisions', () => {
        const view = buildW7xStudyReportView(reports[6]);
        expect(view.statusLabel).toBe('Invalid layout');
        expect(view.metrics.find((metric) => metric.id === 'overlap')?.value).toBe('5.3402°');
        expect(view.coilCoilOverlaps).toHaveLength(3);
        expect(view.coilCoilOverlaps.map((overlap) => `${overlap.a}:${overlap.b}`)).toEqual([
            'coil_01_m1:coil_08_m0',
            'coil_01_m1:coil_09_m0',
            'coil_01_m1:coil_07_m0'
        ]);
    });
});

describe('W7xStudyDialog', () => {
    const render = (moduleCount?: W7xStudyModuleCount): string =>
        renderToStaticMarkup(
            React.createElement(ui.W7xStudyDialog, {
                sourceLabel: 'scaled_w7x_stellarator.step',
                reports,
                ...(moduleCount !== undefined ? { initialModuleCount: moduleCount } : {}),
                onConfirm: vi.fn(),
                onCancel: vi.fn()
            })
        );

    it('defaults to five modules and shows its valid report', () => {
        const html = render();
        expect(html).toContain('5 modules');
        expect(html).toContain('72°');
        expect(html).toContain('~0.103 m');
        expect(html).toContain('No measured coil–coil intersections.');
        expect(html).toContain('Create 5-Module Study');
    });

    it('renders the selected four-module report, warning, and export restriction', () => {
        const html = render(4);
        expect(html).toContain('Create 4-Module Study');
        expect(html).toContain('24.6598°');
        expect(html).toContain('coil_01_m1');
        expect(html).toContain('plasma');
        expect(html).toContain(W7X_STUDY_WARNING);
        expect(html).toContain(W7X_STUDY_EXPORT_NOTE);
        expect(html).toContain('40 coil + 5 shell instances');
    });

    it('renders the selected six-module collision report', () => {
        const html = render(6);
        expect(html).toContain('Create 6-Module Study');
        expect(html).toContain('5.3402°');
        expect(html).toContain('coil_01_m1');
        expect(html).toContain('coil_08_m0');
        expect(html).toContain('60 coil + 5 shell instances');
    });
});

describe('W7xDesignStudyBanner', () => {
    it('describes the four-module study, its summary, and the export block', () => {
        const model = buildW7xDesignStudyBanner(study(4));
        expect(model.kind).toBe('w7x-coil-study');
        expect(model.moduleCount).toBe(4);
        expect(model.valid).toBe(false);
        expect(model.approximate).toBe(false);
        expect(model.title).toBe('W7-X coil study · 4 modules');
        expect(model.statusLabel).toBe('Invalid layout');
        expect(model.summary).toBe(reports[4].summary);
        expect(model.warning).toBe(W7X_STUDY_WARNING);
        expect(model.exportNote).toBe(W7X_STUDY_EXPORT_NOTE);
        expect(model.ariaLabel).toContain('4 modules');
        expect(model.ariaLabel).toContain('invalid layout');
    });

    it('renders a persistent banner with no dismiss button', () => {
        const element = ui.W7xDesignStudyBanner({ study: study(4) });
        const props = element.props as {
            className?: string;
            role?: string;
            'data-study-module-count'?: number;
            'data-study-kind'?: string;
        };
        expect(props.className).toContain('invalid');
        expect(props.className).not.toContain('approximate');
        expect(props.role).toBe('status');
        expect(props['data-study-module-count']).toBe(4);
        expect(props['data-study-kind']).toBe('w7x-coil-study');
        expect(countElementType(element, 'button')).toBe(0);
        const text = textContent(element);
        expect(text).toContain('W7-X coil study · 4 modules');
        expect(text).toContain('Invalid layout');
        expect(text).toContain(reports[4].summary);
        expect(text).toContain(W7X_STUDY_WARNING);
        expect(text).toContain('Simulation export disabled');
    });

    it('keeps the banner non-dismissible for the valid five-module study', () => {
        const model = buildW7xDesignStudyBanner(study(5));
        expect(model.statusLabel).toBe('Valid layout');
        expect(model.warning).toBe('Study document — not simulation ready.');
        expect(model.exportNote).toBe(W7X_STUDY_EXPORT_NOTE);
        expect(countElementType(ui.W7xDesignStudyBanner({ study: study(5) }), 'button')).toBe(0);
    });
});
