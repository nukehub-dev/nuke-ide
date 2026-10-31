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

import { describe, expect, it, vi } from 'vitest';
import { ToolCallContentResult, ToolCallTextResult } from '@theia/ai-core/lib/common/language-model';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { toToolCallContent } from './nuke-tool-result';

function textBlocks(content: ToolCallContentResult[]): string[] {
    return content.filter((item): item is ToolCallTextResult => item.type === 'text').map((item) => item.text);
}

function jsonBlock(content: ToolCallContentResult[]): Record<string, unknown> {
    const block = textBlocks(content).find((text) => text.startsWith('{"ok"'));
    expect(block).toBeDefined();
    return JSON.parse(block as string) as Record<string, unknown>;
}

function fakeFileService(files: Record<string, Uint8Array>, sizes: Record<string, number> = {}): FileService {
    return {
        resolve: vi.fn(async (uri: { path: { toString(): string } }) => {
            const target = uri.path.toString();
            const bytes = files[target];
            if (!bytes) {
                throw new Error(`not found: ${target}`);
            }
            return {
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                size: sizes[target] ?? bytes.byteLength,
                resource: uri
            };
        }),
        readFile: vi.fn(async (uri: { path: { toString(): string } }) => {
            const target = uri.path.toString();
            const bytes = files[target];
            if (!bytes) {
                throw new Error(`not found: ${target}`);
            }
            return { value: BinaryBuffer.wrap(bytes) };
        })
    } as unknown as FileService;
}

describe('toToolCallContent', () => {
    it('renders a human-readable message and a JSON block for data', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                message: 'Exported.',
                data: { path: '/tmp/model.h5m' },
                warnings: ['graveyard added'],
                nextActions: [{ capability: 'nuke.openmc.importCad', reason: 'Run the model next.' }],
                handle: 'project-1'
            })
        ).content;

        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({ type: 'text', text: 'Exported.' });
        expect(jsonBlock(content)).toEqual({
            ok: true,
            data: { path: '/tmp/model.h5m' },
            warnings: ['graveyard added'],
            nextActions: [{ capability: 'nuke.openmc.importCad', reason: 'Run the model next.' }],
            handle: 'project-1'
        });
    });

    it('falls back to Done. and Failed. when no message is provided', async () => {
        const success = textBlocks((await toToolCallContent({ ok: true })).content);
        expect(success).toEqual(['Done.']);

        const failure = (await toToolCallContent({ ok: false })).content;
        expect(failure[0]).toEqual({ type: 'error', data: 'Failed.' });
        expect(failure[1]).toEqual({ type: 'text', text: 'Failed.' });
    });

    it('puts the error block first for failed results', async () => {
        const content = (await toToolCallContent({ ok: false, message: 'Export failed.', data: { stage: 2 } })).content;

        expect(content[0]).toEqual({ type: 'error', data: 'Export failed.' });
        expect(content[1]).toEqual({ type: 'text', text: 'Export failed.' });
        expect(jsonBlock(content.slice(2))).toEqual({ ok: false, data: { stage: 2 } });
    });

    it('omits the JSON block when data is undefined', async () => {
        const content = (await toToolCallContent({ ok: true, warnings: ['ignored'] })).content;
        expect(content).toEqual([{ type: 'text', text: 'Done.' }]);
    });

    it('appends one line per artifact using the path or uri', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                message: 'Files ready.',
                artifacts: [
                    { kind: 'file', label: 'DAGMC', path: '/tmp/model.h5m' },
                    { kind: 'image', label: 'Plot', uri: 'nuke://plot/1' },
                    { kind: 'json', label: 'Report' }
                ]
            })
        ).content;

        expect(content).toHaveLength(2);
        expect(content[1]).toEqual({
            type: 'text',
            text: 'DAGMC: /tmp/model.h5m\nPlot: nuke://plot/1\nReport'
        });
    });

    it('truncates long strings inside the JSON block at 8 KiB', async () => {
        const log = 'log line '.repeat(2000);
        const content = (await toToolCallContent({ ok: true, data: { log } })).content;
        const json = jsonBlock(content);

        expect(typeof json.data).toBe('object');
        const bounded = (json.data as { log: string }).log;
        expect(bounded.length).toBeLessThanOrEqual(8 * 1024);
        expect(bounded.endsWith('[truncated]')).toBe(true);
    });

    it('replaces the whole JSON payload when it exceeds 32 KiB', async () => {
        const entries = Array.from({ length: 48 }, (_, index) => `${index} ${'entry '.repeat(240)}`);
        const content = (await toToolCallContent({ ok: true, data: { entries } })).content;
        const json = jsonBlock(content);

        expect(json.ok).toBe(true);
        expect(json.truncated).toBe(true);
        expect(String(json.note)).toContain('[truncated]');
        expect(JSON.stringify(json).length).toBeLessThanOrEqual(32 * 1024);
    });

    it('omits inline base64 payloads instead of sending them to the model', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                data: {
                    dataUri: `data:image/png;base64,${'A'.repeat(500)}`,
                    bare: 'A'.repeat(9000)
                }
            })
        ).content;
        const json = jsonBlock(content);
        const data = json.data as { dataUri: string; bare: string };

        expect(data.dataUri).toBe('[base64 omitted]');
        expect(data.bare).toBe('[base64 omitted]');
        expect(JSON.stringify(json)).not.toContain('AAAAAAAA');
    });

    it('renders an image data URI with its caption and limitations', async () => {
        const base64 = 'iVBORw0KGgo=';
        const content = (
            await toToolCallContent({
                ok: true,
                message: 'Captured.',
                preview: {
                    kind: 'image',
                    data: `data:image/png;base64,${base64}`,
                    mimeType: 'image/png',
                    caption: 'Active DAGMC viewport',
                    truthful: true,
                    limitations: ['Current camera and visibility state.']
                }
            })
        ).content;

        expect(content).toContainEqual({ type: 'image', base64data: base64, mimeType: 'image/png' });
        expect(textBlocks(content)).toContain('Preview: Active DAGMC viewport\nLimitations: Current camera and visibility state.');
    });

    it('reads a path preview through the file service', async () => {
        const target = '/workspace/preview.png';
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const fileService = fakeFileService({ [target]: bytes });

        const content = (
            await toToolCallContent(
                {
                    ok: true,
                    preview: { kind: 'image', path: target, caption: 'Path preview', truthful: true }
                },
                fileService
            )
        ).content;

        expect(content).toContainEqual({ type: 'image', base64data: 'AQIDBA==', mimeType: 'image/png' });
    });

    it('falls back to a text link for a path preview without a file service', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                preview: { kind: 'image', path: '/workspace/preview.png', caption: 'Path preview', truthful: true }
            })
        ).content;

        expect(textBlocks(content).join('\n')).toContain('Preview image: /workspace/preview.png');
        expect(textBlocks(content).join('\n')).toContain('no file service is available');
    });

    it('renders an html preview block with the caption as its title', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                preview: { kind: 'html', data: '<p>Report</p>', caption: 'Summary', truthful: true }
            })
        ).content;

        expect(content).toContainEqual({ type: 'html', html: '<p>Report</p>', title: 'Summary' });
    });

    it('returns a text link for an oversized image preview', async () => {
        const target = '/workspace/huge.png';
        const fileService = fakeFileService({ [target]: new Uint8Array([1]) }, { [target]: 4 * 1024 * 1024 + 1 });

        const content = (
            await toToolCallContent(
                {
                    ok: true,
                    preview: { kind: 'image', path: target, caption: 'Huge', truthful: true }
                },
                fileService
            )
        ).content;

        expect(textBlocks(content).join('\n')).toContain('Preview image: /workspace/huge.png');
        expect(textBlocks(content).join('\n')).toContain('larger than 4 MiB');
    });

    it('falls back to text for a malformed data URI', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                preview: { kind: 'image', data: 'data:image/png;base64,', caption: 'Broken', truthful: true }
            })
        ).content;

        expect(content).toContainEqual({ type: 'text', text: 'Preview unavailable: the preview data URI is malformed.' });
        expect(textBlocks(content)).toContain('Preview: Broken');
    });

    it('never puts raw preview base64 in the JSON block', async () => {
        const base64 = 'A'.repeat(600);
        const content = (
            await toToolCallContent({
                ok: true,
                preview: {
                    kind: 'image',
                    data: `data:image/png;base64,${base64}`,
                    mimeType: 'image/png',
                    caption: 'Viewport',
                    truthful: true
                }
            })
        ).content;
        const json = jsonBlock(content);

        expect(JSON.stringify(json)).not.toContain('AAAAAAAA');
        const preview = json.preview as { data: string; path?: string };
        expect(preview.data).toBe('[preview omitted]');
        expect(preview.path).toBeUndefined();
    });

    it('marks an approximate preview as approximate', async () => {
        const content = (
            await toToolCallContent({
                ok: true,
                preview: { kind: 'markdown', data: 'Approximation', caption: 'Sketch', truthful: false }
            })
        ).content;

        expect(textBlocks(content)).toContain('Preview: Sketch\nPreview is approximate');
    });
});
