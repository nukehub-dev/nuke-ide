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
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    NukeToolCallResponseLike,
    NukeToolCard,
    NukeToolCardAction,
    NukeToolCardProps,
    canHandleNukeToolCall,
    readIssues,
    readStatus
} from './nuke-tool-call-card';
import { NukeToolCallSummary } from './nuke-tool-call-summary';

function summary(overrides: Partial<NukeToolCallSummary> = {}): NukeToolCallSummary {
    return {
        ok: true,
        message: undefined,
        data: undefined,
        warnings: [],
        nextActions: [],
        artifacts: [],
        images: [],
        errors: [],
        rawText: [],
        rawHtml: [],
        ...overrides
    };
}

function renderCard(overrides: Partial<NukeToolCardProps> = {}): string {
    return renderToStaticMarkup(
        <NukeToolCard toolName="nuke_cad_summarizeDocument" summary={summary()} issues={[]} status="done" details={{}} {...overrides} />
    );
}

interface ActionButtonProps {
    className?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
}

function collectActionButtons(
    node: React.ReactNode,
    found: React.ReactElement<ActionButtonProps>[] = []
): React.ReactElement<ActionButtonProps>[] {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectActionButtons(child, found);
        }
        return found;
    }
    if (!React.isValidElement<ActionButtonProps>(node)) {
        return found;
    }
    const props = node.props;
    if (typeof props.className === 'string' && props.className.split(/\s+/).includes('nuke-tool-card-action-button')) {
        found.push(node);
    }
    collectActionButtons(props.children, found);
    return found;
}

describe('NukeToolCard', () => {
    it('renders a done card with title, status, summary entries, warnings, artifact, and next actions', () => {
        const onOpenArtifact = vi.fn();
        const exportSummary = summary({
            message: 'Exported the DAGMC model.',
            data: { solidCount: 3, success: true },
            warnings: ['Graveyard added.'],
            nextActions: [{ capability: 'nuke.openmc.importCad', reason: 'Import the model next.' }],
            artifacts: [{ kind: 'file', label: 'DAGMC model', path: '/workspace/model.h5m' }]
        });
        const html = renderCard({
            toolName: 'nuke_cad_exportDagmc',
            summary: exportSummary,
            details: { arguments: { path: '/workspace/model.h5m' }, result: exportSummary },
            onOpenArtifact
        });

        expect(html).toContain('nuke-tool-card-done');
        expect(html).toContain('data-status="done"');
        expect(html).toContain('DAGMC export');
        expect(html).toContain('>Done<');
        expect(html).toContain('Exported the DAGMC model.');
        expect(html).toContain('Solids');
        expect(html).toContain('>3<');
        expect(html).toContain('Warnings');
        expect(html).toContain('Graveyard added.');
        expect(html).toContain('nuke-tool-card-artifact');
        expect(html).toContain('<button type="button" class="nuke-tool-card-artifact">');
        expect(html).toContain('DAGMC model');
        expect(html).toContain('nuke-tool-card-artifact-target');
        expect(html).toContain('Next actions');
        expect(html).toContain('DAGMC import');
        expect(html).toContain('Import the model next.');
        expect(html).toContain('Ask NukeAI');
        expect(html).toContain('theia-button secondary nuke-tool-card-action-button');
        expect(html).toContain('disabled=""');
        expect(html).toContain('Raw details');
        expect(html).toContain('solidCount');
        expect(html).not.toContain('onclick');
    });

    it('renders a failed card with the error message and errors list', () => {
        const html = renderCard({
            toolName: 'nuke_cad_exportDagmc',
            status: 'failed',
            summary: summary({
                ok: false,
                message: 'DAGMC export failed.',
                errors: ['Permission denied.']
            })
        });

        expect(html).toContain('nuke-tool-card-failed');
        expect(html).toContain('data-status="failed"');
        expect(html).toContain('codicon-error');
        expect(html).toContain('>Failed<');
        expect(html).toContain('DAGMC export failed.');
        expect(html).toContain('Errors');
        expect(html).toContain('Permission denied.');
    });

    it('renders warning status and warnings', () => {
        const html = renderCard({
            status: 'warning',
            summary: summary({ warnings: ['Open edges detected.'] })
        });

        expect(html).toContain('nuke-tool-card-warning');
        expect(html).toContain('data-status="warning"');
        expect(html).toContain('codicon-warning');
        expect(html).toContain('>Warning<');
        expect(html).toContain('Warnings');
        expect(html).toContain('Open edges detected.');
    });

    it('renders image previews as data URLs and HTML previews in a sandboxed iframe', () => {
        const html = renderCard({
            summary: summary({
                images: [
                    {
                        src: 'data:image/png;base64,iVBORw0KGgo=',
                        mimeType: 'image/png',
                        alt: 'Tool result image (image/png)'
                    }
                ],
                rawHtml: [{ html: '<p>Report</p>', title: 'Summary' }]
            })
        });

        expect(html).toContain('nuke-tool-card-images');
        expect(html).toContain('<img');
        expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
        expect(html).toContain('alt="Tool result image (image/png)"');
        expect(html).toContain('<iframe');
        expect(html).toContain('sandbox=""');
        expect(html).toContain('srcDoc="&lt;p&gt;Report&lt;/p&gt;"');
        expect(html).toContain('title="Summary"');
    });

    it('renders Run and Ask NukeAI buttons with their matching callbacks', () => {
        const onRunAction = vi.fn();
        const onAskAction = vi.fn();
        const tree = NukeToolCard({
            toolName: 'nuke_cad_exportDagmc',
            summary: summary({
                nextActions: [
                    { capability: 'nuke.openmc.summarizeProject', reason: 'Check the project.' },
                    { capability: 'nuke.openmc.importCad', reason: 'Import the model next.' }
                ]
            }),
            issues: [],
            status: 'done',
            details: {},
            canRunDirectly: (capabilityId) => capabilityId === 'nuke.openmc.summarizeProject',
            onRunAction,
            onAskAction
        });

        const buttons = collectActionButtons(tree);
        expect(buttons).toHaveLength(2);
        expect(buttons[0].props.className).toBe('theia-button secondary nuke-tool-card-action-button');
        expect(buttons[0].props.children).toBe('Run');
        expect(buttons[0].props.disabled).toBe(false);
        expect(buttons[1].props.children).toBe('Ask NukeAI');
        expect(buttons[1].props.disabled).toBe(false);

        buttons[0].props.onClick?.();
        expect(onRunAction).toHaveBeenCalledWith({
            label: 'OpenMC project',
            reason: 'Check the project.',
            capability: 'nuke.openmc.summarizeProject',
            direct: true
        } satisfies NukeToolCardAction);
        expect(onAskAction).not.toHaveBeenCalled();

        buttons[1].props.onClick?.();
        expect(onAskAction).toHaveBeenCalledWith({
            label: 'DAGMC import',
            reason: 'Import the model next.',
            capability: 'nuke.openmc.importCad',
            direct: false
        } satisfies NukeToolCardAction);
        expect(onRunAction).toHaveBeenCalledTimes(1);
    });

    it('renders disabled action buttons when the matching callback is missing', () => {
        const tree = NukeToolCard({
            toolName: 'nuke_cad_exportDagmc',
            summary: summary({ nextActions: [{ capability: 'nuke.cad.summarizeDocument', reason: 'Summarize the model.' }] }),
            issues: [],
            status: 'done',
            details: {},
            canRunDirectly: () => true
        });

        const buttons = collectActionButtons(tree);
        expect(buttons).toHaveLength(1);
        expect(buttons[0].props.children).toBe('Run');
        expect(buttons[0].props.disabled).toBe(true);
        expect(buttons[0].props.onClick).toBeUndefined();
    });
});

describe('readStatus', () => {
    it('derives failed, warning, and done states from the result and issues', () => {
        expect(readStatus(summary(), [])).toBe('done');
        expect(readStatus(summary({ warnings: ['Check units.'] }), [])).toBe('warning');
        expect(readStatus(summary({ ok: false }), [])).toBe('failed');
        expect(readStatus(summary(), [{ severity: 'warning', message: 'No tallies.' }])).toBe('warning');
        expect(readStatus(summary(), [{ severity: 'error', message: 'Missing material.' }])).toBe('failed');
    });
});

describe('readIssues', () => {
    it('reads string and structured issues with severity, category, and suggestion', () => {
        expect(
            readIssues({
                issues: [
                    'Check units.',
                    { severity: 'warning', message: 'No tallies.', category: 'tallies', suggestion: 'Add a tally.' },
                    { message: '   ' }
                ]
            })
        ).toEqual([
            { severity: 'info', message: 'Check units.' },
            { severity: 'warning', message: 'No tallies.', category: 'tallies', suggestion: 'Add a tally.' }
        ]);
        expect(readIssues(undefined)).toEqual([]);
        expect(readIssues({ issues: 'none' })).toEqual([]);
    });
});

describe('canHandleNukeToolCall', () => {
    function response(overrides: Partial<NukeToolCallResponseLike> = {}): NukeToolCallResponseLike {
        return {
            kind: 'toolCall',
            name: 'nuke_cad_exportDagmc',
            finished: true,
            isAwaitingUserConfirmation: false,
            ...overrides
        };
    }

    it('claims a finished, non-awaiting Nuke tool call', () => {
        expect(canHandleNukeToolCall(response())).toBe(30);
    });

    it('rejects a running call', () => {
        expect(canHandleNukeToolCall(response({ finished: false }))).toBe(-1);
    });

    it('rejects a call awaiting user confirmation', () => {
        expect(canHandleNukeToolCall(response({ isAwaitingUserConfirmation: true }))).toBe(-1);
    });

    it('rejects a non-Nuke tool name', () => {
        expect(canHandleNukeToolCall(response({ name: 'other_tool' }))).toBe(-1);
        expect(canHandleNukeToolCall(response({ name: undefined }))).toBe(-1);
    });

    it('rejects a non-tool-call response', () => {
        expect(canHandleNukeToolCall(response({ kind: 'markdownContent' }))).toBe(-1);
    });
});
