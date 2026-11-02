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
import { ToolCallContent, ToolCallContentResult } from '@theia/ai-core/lib/common/language-model';
import {
    MAX_JSON_DETAILS_LENGTH,
    MAX_SUMMARY_VALUE_LENGTH,
    formatChangeValue,
    formatJsonDetails,
    summarizeNukeToolResult,
    summaryEntries,
    toolLabel
} from './nuke-tool-call-summary';

function content(...blocks: ToolCallContentResult[]): ToolCallContent {
    return { content: blocks };
}

function envelope(payload: Record<string, unknown>): ToolCallContentResult {
    return { type: 'text', text: JSON.stringify(payload) };
}

describe('summarizeNukeToolResult', () => {
    it('parses the JSON envelope after the human-readable message', () => {
        const summary = summarizeNukeToolResult(
            content(
                { type: 'text', text: 'Exported the DAGMC model.' },
                envelope({
                    ok: true,
                    data: { solidCount: 3 },
                    warnings: ['Graveyard added.'],
                    nextActions: [{ capability: 'nuke.openmc.importCad', reason: 'Import the model next.' }],
                    handle: 'project-1',
                    artifacts: [{ kind: 'file', label: 'DAGMC model', path: '/workspace/model.h5m' }]
                }),
                { type: 'text', text: 'DAGMC model: /workspace/model.h5m' }
            )
        );

        expect(summary.ok).toBe(true);
        expect(summary.message).toBe('Exported the DAGMC model.');
        expect(summary.data).toEqual({ solidCount: 3 });
        expect(summary.warnings).toEqual(['Graveyard added.']);
        expect(summary.nextActions).toEqual([{ capability: 'nuke.openmc.importCad', reason: 'Import the model next.' }]);
        expect(summary.artifacts).toEqual([{ kind: 'file', label: 'DAGMC model', path: '/workspace/model.h5m', uri: undefined }]);
        expect(summary.rawText).toEqual(['Exported the DAGMC model.', 'DAGMC model: /workspace/model.h5m']);
        expect(summary.errors).toEqual([]);
    });

    it('parses a change set and undo token from the envelope', () => {
        const summary = summarizeNukeToolResult(
            content({
                type: 'text',
                text: JSON.stringify({
                    ok: true,
                    changeSet: {
                        id: 'proposal-1',
                        title: 'Run settings',
                        summary: 'Increase batches.',
                        changes: [
                            { path: 'run.batches', label: 'Batches', kind: 'update', before: 100, after: 200 },
                            { path: 'run.inactive', label: 'Inactive batches', kind: 'update', before: 10, after: 20 }
                        ],
                        applyCapability: 'nuke.openmc.applySettings'
                    },
                    undoToken: 'undo-1'
                })
            })
        );

        expect(summary.changeSet).toEqual({
            id: 'proposal-1',
            title: 'Run settings',
            summary: 'Increase batches.',
            changes: [
                { path: 'run.batches', label: 'Batches', kind: 'update', before: 100, after: 200 },
                { path: 'run.inactive', label: 'Inactive batches', kind: 'update', before: 10, after: 20 }
            ],
            applyCapability: 'nuke.openmc.applySettings'
        });
        expect(summary.undoToken).toBe('undo-1');
    });

    it('accepts a change set without an apply capability after apply', () => {
        const summary = summarizeNukeToolResult({
            ok: true,
            changeSet: {
                id: 'proposal-1',
                title: 'Run settings',
                summary: 'Applied.',
                changes: [{ path: 'run.batches', label: 'Batches', kind: 'update', before: 100, after: 200 }]
            },
            undoToken: 'undo-1'
        });

        expect(summary.changeSet?.applyCapability).toBeUndefined();
        expect(summary.undoToken).toBe('undo-1');
    });

    it('keeps malformed change sets and undo tokens out of the summary', () => {
        const malformed = [
            { ok: true, changeSet: 'not-a-change-set' },
            { ok: true, changeSet: { id: 'proposal-1', changes: 'not-an-array' } },
            { ok: true, changeSet: { id: 'proposal-1', changes: [] } },
            { ok: true, changeSet: { id: 'proposal-1', changes: [{ label: 'Missing path' }] } },
            { ok: true, undoToken: 42 },
            { ok: true, undoToken: '   ' }
        ];

        for (const payload of malformed) {
            const summary = summarizeNukeToolResult(payload);
            expect(summary.changeSet).toBeUndefined();
            expect(summary.undoToken).toBeUndefined();
        }
    });

    it('fills a missing change title and label with safe defaults', () => {
        const summary = summarizeNukeToolResult({
            changeSet: {
                changes: [{ path: 'run.batches' }]
            }
        });

        expect(summary.changeSet?.title).toBe('Proposed changes');
        expect(summary.changeSet?.id).toBe('');
        expect(summary.changeSet?.summary).toBe('');
        expect(summary.changeSet?.changes).toEqual([
            { path: 'run.batches', label: 'run.batches', kind: 'update', before: undefined, after: undefined }
        ]);
    });

    it('accepts a plain string result as the message', () => {
        const summary = summarizeNukeToolResult('Done.');

        expect(summary.ok).toBeUndefined();
        expect(summary.message).toBe('Done.');
        expect(summary.rawText).toEqual(['Done.']);
        expect(summary.data).toBeUndefined();
    });

    it('parses an envelope supplied as a plain JSON string', () => {
        const summary = summarizeNukeToolResult(JSON.stringify({ ok: true, data: { running: true } }));

        expect(summary.ok).toBe(true);
        expect(summary.data).toEqual({ running: true });
        expect(summary.rawText).toEqual([]);
    });

    it('accepts a plain envelope object', () => {
        const summary = summarizeNukeToolResult({ ok: true, data: { solidCount: 2 }, warnings: ['Check units.'] });

        expect(summary.ok).toBe(true);
        expect(summary.data).toEqual({ solidCount: 2 });
        expect(summary.warnings).toEqual(['Check units.']);
    });

    it('collects error blocks without losing the message', () => {
        const summary = summarizeNukeToolResult(
            content({ type: 'error', data: 'Export failed.' }, { type: 'text', text: 'Export failed.' }, envelope({ ok: false }))
        );

        expect(summary.ok).toBe(false);
        expect(summary.message).toBe('Export failed.');
        expect(summary.errors).toEqual(['Export failed.']);
    });

    it('uses the first error as the message when no text block exists', () => {
        const summary = summarizeNukeToolResult(content({ type: 'error', data: 'Boom.' }));

        expect(summary.message).toBe('Boom.');
        expect(summary.errors).toEqual(['Boom.']);
    });

    it('extracts images as data URLs instead of raw base64 text', () => {
        const summary = summarizeNukeToolResult(content({ type: 'image', base64data: 'iVBORw0KGgo=', mimeType: 'image/png' }));

        expect(summary.images).toEqual([
            {
                src: 'data:image/png;base64,iVBORw0KGgo=',
                mimeType: 'image/png',
                alt: 'Tool result image (image/png)'
            }
        ]);
        expect(summary.rawText).toEqual([]);
        expect(summary.rawText.join('\n')).not.toContain('iVBORw0KGgo=');
    });

    it('extracts HTML blocks with their title', () => {
        const summary = summarizeNukeToolResult(
            content({ type: 'html', html: '<p>Report</p>', title: 'Summary' }, { type: 'html', html: '<p>Other</p>' })
        );

        expect(summary.rawHtml).toEqual([
            { html: '<p>Report</p>', title: 'Summary' },
            { html: '<p>Other</p>', title: 'Tool result preview' }
        ]);
    });

    it('keeps malformed JSON visible as text and never throws', () => {
        const broken = '{"ok": true, "data": {';
        const summary = summarizeNukeToolResult(content({ type: 'text', text: broken }));

        expect(summary.message).toBe(broken);
        expect(summary.rawText).toEqual([broken]);
        expect(summary.ok).toBeUndefined();
        expect(summary.data).toBeUndefined();
    });

    it('returns an empty summary for an undefined result', () => {
        const summary = summarizeNukeToolResult(undefined);

        expect(summary).toEqual({
            ok: undefined,
            message: undefined,
            data: undefined,
            warnings: [],
            nextActions: [],
            artifacts: [],
            images: [],
            errors: [],
            rawText: [],
            rawHtml: []
        });
    });

    it('reads warnings nested in CAD data when the envelope has none', () => {
        const summary = summarizeNukeToolResult(
            content(envelope({ ok: true, data: { solidCount: 1, warnings: ['Open edges detected.'] } }))
        );

        expect(summary.warnings).toEqual(['Open edges detected.']);
    });
});

describe('toolLabel', () => {
    it('maps every Nuke capability tool to a short label', () => {
        expect(toolLabel('nuke_cad_summarizeDocument')).toBe('CAD summary');
        expect(toolLabel('nuke_cad_inspectSelection')).toBe('CAD selection');
        expect(toolLabel('nuke_cad_diagnoseModel')).toBe('CAD diagnosis');
        expect(toolLabel('nuke_cad_previewFeatureChange')).toBe('CAD feature preview');
        expect(toolLabel('nuke_cad_applyFeatureChange')).toBe('CAD feature applied');
        expect(toolLabel('nuke_cad_listSketchDimensions')).toBe('CAD sketch dimensions');
        expect(toolLabel('nuke_cad_previewSketchChange')).toBe('CAD sketch preview');
        expect(toolLabel('nuke_cad_applySketchChange')).toBe('CAD sketch applied');
        expect(toolLabel('nuke_cad_previewTopologyChange')).toBe('CAD topology preview');
        expect(toolLabel('nuke_cad_applyTopologyChange')).toBe('CAD topology applied');
        expect(toolLabel('nuke_cad_inspectImportSource')).toBe('CAD import source');
        expect(toolLabel('nuke_cad_previewImportBodies')).toBe('CAD import preview');
        expect(toolLabel('nuke_cad_applyImportBodies')).toBe('CAD import applied');
        expect(toolLabel('nuke_cad_summarizeAssembly')).toBe('CAD assembly summary');
        expect(toolLabel('nuke_cad_previewAssemblyChange')).toBe('CAD assembly preview');
        expect(toolLabel('nuke_cad_applyAssemblyChange')).toBe('CAD assembly applied');
        expect(toolLabel('nuke_cad_summarizeDrawing')).toBe('CAD drawing summary');
        expect(toolLabel('nuke_cad_previewDrawingChange')).toBe('CAD drawing preview');
        expect(toolLabel('nuke_cad_applyDrawingChange')).toBe('CAD drawing applied');
        expect(toolLabel('nuke_cad_exportDagmc')).toBe('DAGMC export');
        expect(toolLabel('nuke_openmc_summarizeProject')).toBe('OpenMC project');
        expect(toolLabel('nuke_openmc_validateProject')).toBe('OpenMC validation');
        expect(toolLabel('nuke_openmc_diagnoseProject')).toBe('OpenMC diagnosis');
        expect(toolLabel('nuke_openmc_diagnoseRun')).toBe('Run diagnosis');
        expect(toolLabel('nuke_openmc_previewSettings')).toBe('Settings preview');
        expect(toolLabel('nuke_openmc_applySettings')).toBe('Settings applied');
        expect(toolLabel('nuke_openmc_previewMaterialChange')).toBe('Material preview');
        expect(toolLabel('nuke_openmc_applyMaterialChange')).toBe('Material applied');
        expect(toolLabel('nuke_openmc_previewTallyChange')).toBe('Tally preview');
        expect(toolLabel('nuke_openmc_applyTallyChange')).toBe('Tally applied');
        expect(toolLabel('nuke_openmc_importCad')).toBe('DAGMC import');
        expect(toolLabel('nuke_openmc_runSimulation')).toBe('OpenMC run');
        expect(toolLabel('nuke_openmc_getRunStatus')).toBe('Run status');
        expect(toolLabel('nuke_viz_summarizeStatepoint')).toBe('Statepoint summary');
        expect(toolLabel('nuke_viz_diagnoseStatepoint')).toBe('Statepoint diagnosis');
        expect(toolLabel('nuke_viz_compareStatepoints')).toBe('Statepoint comparison');
        expect(toolLabel('nuke_viz_analyzeTallySeries')).toBe('Tally series analysis');
        expect(toolLabel('nuke_viz_openStatepoint')).toBe('Open statepoint');
        expect(toolLabel('nuke_viz_captureView')).toBe('Viewport capture');
    });

    it('humanizes unknown tool names and handles empty input', () => {
        expect(toolLabel('nuke_custom_tool')).toBe('Custom tool');
        expect(toolLabel('nuke_cad_exportDagmcExtra')).toBe('Cad export Dagmc Extra');
        expect(toolLabel('')).toBe('Nuke tool');
    });
});

describe('summaryEntries', () => {
    it('summarizes CAD document counts and selection', () => {
        const entries = summaryEntries({
            documentPath: '/workspace/models/pin/pin.nuke-cad',
            success: true,
            solidCount: 3,
            faceCount: 18,
            triangleCount: 2048,
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
            warnings: [],
            selection: { solidId: 2 }
        });

        expect(entries).toEqual([
            { label: 'Document', value: '\u2026/pin/pin.nuke-cad' },
            { label: 'Build succeeded', value: 'Yes' },
            { label: 'Solids', value: '3' },
            { label: 'Faces', value: '18' },
            { label: 'Triangles', value: '2048' },
            { label: 'Selected solid', value: '2' }
        ]);
    });

    it('summarizes OpenMC validation counters and issue count', () => {
        const entries = summaryEntries({
            valid: false,
            issues: [
                { severity: 'error', message: 'Missing material.' },
                { severity: 'warning', message: 'No tallies.' }
            ],
            summary: { errors: 1, warnings: 1, info: 0 }
        });

        expect(entries).toEqual([
            { label: 'Valid', value: 'No' },
            { label: 'Errors', value: '1' },
            { label: 'Warnings', value: '1' },
            { label: 'Info', value: '0' },
            { label: 'Issues', value: '2 items' }
        ]);
    });

    it('summarizes OpenMC run status', () => {
        const entries = summaryEntries({
            running: true,
            processId: 1234,
            workingDirectory: '/workspace/runs/run-1',
            startTime: '2026-10-31T10:00:00.000Z',
            logFilePath: '/workspace/runs/run-1/openmc.log',
            logTail: 'Iteration 1'
        });

        expect(entries).toEqual([
            { label: 'Running', value: 'Yes' },
            { label: 'Process ID', value: '1234' },
            { label: 'Run directory', value: '/workspace/runs/run-1' },
            { label: 'Started', value: '2026-10-31T10:00:00.000Z' },
            { label: 'Log file', value: '\u2026/run-1/openmc.log' },
            { label: 'Log tail', value: 'Iteration 1' }
        ]);
    });

    it('summarizes statepoint k-eff, batches, and tallies', () => {
        const entries = summaryEntries({
            file: '/workspace/statepoint.100.h5',
            batches: 100,
            generationsPerBatch: 50,
            kEff: 1.2345,
            kEffStd: 0.0004,
            nTallies: 2,
            tallyIds: [1, 2],
            tallies: [{ id: 1 }, { id: 2 }]
        });

        expect(entries).toEqual([
            { label: 'Statepoint', value: '/workspace/statepoint.100.h5' },
            { label: 'k-eff', value: '1.2345' },
            { label: 'k-eff uncertainty', value: '0.0004' },
            { label: 'Batches', value: '100' },
            { label: 'Generations / batch', value: '50' },
            { label: 'Tallies', value: '2' },
            { label: 'Tally IDs', value: '1, 2' }
        ]);
    });

    it('falls back to primitive top-level fields and skips nested objects', () => {
        const entries = summaryEntries({
            foo: 'bar',
            enabled: true,
            tags: ['alpha', 'beta'],
            nested: { important: true },
            objects: [{ id: 1 }]
        });

        expect(entries).toEqual([
            { label: 'Foo', value: 'bar' },
            { label: 'Enabled', value: 'Yes' },
            { label: 'Tags', value: 'alpha, beta' }
        ]);
    });

    it('truncates long values and caps the grid at eight entries', () => {
        const long = 'x'.repeat(MAX_SUMMARY_VALUE_LENGTH * 3);
        const entries = summaryEntries({
            note: long,
            first: 1,
            second: 2,
            third: 3,
            fourth: 4,
            fifth: 5,
            sixth: 6,
            seventh: 7,
            eighth: 8
        });

        expect(entries).toHaveLength(8);
        expect(entries[0].value).toHaveLength(MAX_SUMMARY_VALUE_LENGTH);
        expect(entries[0].value.endsWith('\u2026')).toBe(true);
    });

    it('does not repeat warnings or the message in the grid', () => {
        const entries = summaryEntries({ message: 'Ready.', warnings: ['Check units.'], solidCount: 1 });

        expect(entries).toEqual([{ label: 'Solids', value: '1' }]);
    });

    it('returns no entries for non-object data', () => {
        expect(summaryEntries(undefined)).toEqual([]);
        expect(summaryEntries('text')).toEqual([]);
        expect(summaryEntries([1, 2])).toEqual([]);
    });
});

describe('formatChangeValue', () => {
    it('formats primitive, missing, and structured diff values', () => {
        expect(formatChangeValue(undefined)).toBe('\u2014');
        expect(formatChangeValue(null)).toBe('null');
        expect(formatChangeValue(200)).toBe('200');
        expect(formatChangeValue(false)).toBe('false');
        expect(formatChangeValue('continuous-energy')).toBe('continuous-energy');
        expect(formatChangeValue('')).toBe('""');
        expect(formatChangeValue({ mode: 'multigroup' })).toBe('{"mode":"multigroup"}');
        expect(formatChangeValue([1, 2])).toBe('[1,2]');
    });

    it('bounds long diff values', () => {
        const formatted = formatChangeValue('x'.repeat(MAX_SUMMARY_VALUE_LENGTH * 2));

        expect(formatted).toHaveLength(MAX_SUMMARY_VALUE_LENGTH);
        expect(formatted.endsWith('\u2026')).toBe(true);
    });
});

describe('formatJsonDetails', () => {
    it('pretty-prints structured values', () => {
        const details = formatJsonDetails({ ok: true, data: { solidCount: 1 } });

        expect(details).toContain('\n  "ok": true');
        expect(details).toContain('"solidCount": 1');
    });

    it('replaces circular references and serializes big integers', () => {
        const big = (globalThis as unknown as { BigInt?: (value: number) => unknown }).BigInt?.(1);
        const circular: Record<string, unknown> = { value: big };
        circular.self = circular;

        const details = formatJsonDetails(circular);

        expect(details).toContain('[circular]');
        expect(details).toContain('"1"');
    });

    it('serializes errors without throwing', () => {
        const details = formatJsonDetails({ error: new Error('kaput') });

        expect(details).toContain('"message": "kaput"');
    });

    it('bounds large details to the details limit', () => {
        const details = formatJsonDetails({ value: 'x'.repeat(MAX_JSON_DETAILS_LENGTH * 2) });

        expect(details.length).toBeLessThanOrEqual(MAX_JSON_DETAILS_LENGTH + 20);
        expect(details.endsWith('[truncated]')).toBe(true);
    });

    it('returns an empty string for undefined', () => {
        expect(formatJsonDetails(undefined)).toBe('');
    });
});
