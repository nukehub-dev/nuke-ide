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
 * Shared pipeline helpers for the capability-to-card contract tests.
 *
 * The helpers deliberately take a real {@link NukeCapabilityResult} and run it
 * through the same bounded conversion, summary parser, and pure card the chat
 * renderer uses. Expectations are derived from the capability result instead of
 * a hand-written `ToolCallContent` shape.
 */

import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import { toToolCallContent } from '../../extensions/nuke-ai/src/browser/capabilities/nuke-tool-result';
import {
    formatChangeValue,
    summarizeNukeToolResult,
    type NukeToolCallChange,
    type NukeToolCallChangeSet,
    type NukeToolCallSummary
} from '../../extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-summary';
import {
    NukeToolCard,
    readIssues,
    readStatus,
    type NukeToolCardIssue,
    type NukeToolCardProps
} from '../../extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-card';

/** One rendered capability card plus the parsed summary it came from. */
export interface RenderedCapabilityCard {
    readonly result: NukeCapabilityResult;
    readonly summary: NukeToolCallSummary;
    readonly issues: readonly NukeToolCardIssue[];
    readonly tree: React.ReactNode;
    readonly html: string;
    readonly bodyHtml: string;
}

/** One rendered diff row extracted from the card markup. */
export interface RenderedChangeRow {
    readonly kind: string;
    readonly label: string;
    readonly path: string;
    readonly before: string;
    readonly after: string;
}

/** Run a real capability result through result conversion, parsing, and the pure card. */
export async function renderCapabilityCard(
    toolName: string,
    result: NukeCapabilityResult,
    handlers: Partial<NukeToolCardProps> = {}
): Promise<RenderedCapabilityCard> {
    const content = await toToolCallContent(result);
    const summary = summarizeNukeToolResult(content);
    const issues = readIssues(summary.data);
    const status = readStatus(summary, issues);
    const details = { arguments: undefined, result: summary };
    const tree = NukeToolCard({ toolName, summary, issues, status, details, ...handlers });
    const html = renderToStaticMarkup(tree as React.ReactElement);
    return { result, summary, issues, tree, html, bodyHtml: cardBody(html) };
}

/** Strip the bounded raw-details block so assertions only see card body text. */
export function cardBody(html: string): string {
    return html.replace(/<details[\s\S]*?<\/details>/g, '');
}

/** Extract rendered change rows from the card markup. */
export function renderedChangeRows(html: string): RenderedChangeRow[] {
    const rowPattern = /<li class="nuke-tool-card-change" data-kind="([^"]*)">([\s\S]*?)<\/li>/g;
    const rows: RenderedChangeRow[] = [];
    for (const match of html.matchAll(rowPattern)) {
        const body = match[2];
        rows.push({
            kind: decodeHtml(match[1]),
            label: fieldText(body, 'nuke-tool-card-change-label'),
            path: fieldText(body, 'nuke-tool-card-change-path'),
            before: fieldText(body, 'nuke-tool-card-change-before'),
            after: fieldText(body, 'nuke-tool-card-change-after')
        });
    }
    return rows;
}

/** Expected row values for one capability change, using the card's own formatter. */
export function expectedChangeRow(change: NukeToolCallChange): RenderedChangeRow {
    return {
        kind: change.kind,
        label: change.label,
        path: change.path,
        before: formatChangeValue(change.before),
        after: formatChangeValue(change.after)
    };
}

/** Assert every rendered diff row matches the capability change set. */
export function expectChangeRows(html: string, changeSet: NukeToolCallChangeSet): void {
    const rows = renderedChangeRows(html);
    if (rows.length !== changeSet.changes.length) {
        throw new Error(`Expected ${changeSet.changes.length} diff rows but rendered ${rows.length}.`);
    }
    const expected = changeSet.changes.map(expectedChangeRow);
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
        throw new Error(
            `Rendered diff rows do not match the capability change set.\nActual: ${JSON.stringify(rows)}\nExpected: ${JSON.stringify(expected)}`
        );
    }
}

/** Assert the card body never exposes the raw result envelope. */
export function expectNoRawJson(bodyHtml: string): void {
    const forbidden = [
        '"ok"',
        '&quot;ok&quot;',
        '"changeSet"',
        '&quot;changeSet&quot;',
        '"proposalId"',
        '&quot;proposalId&quot;',
        '"applyCapability"',
        '&quot;applyCapability&quot;',
        '"undoToken"',
        '&quot;undoToken&quot;'
    ];
    for (const token of forbidden) {
        if (bodyHtml.includes(token)) {
            throw new Error(`Raw JSON token ${token} leaked into the card body.`);
        }
    }
}

/** Buttons of one card class, expanded through the card's pure function components. */
export function collectButtons(
    node: React.ReactNode,
    className: string,
    found: React.ReactElement<ButtonProps>[] = []
): React.ReactElement<ButtonProps>[] {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectButtons(child, className, found);
        }
        return found;
    }
    if (!React.isValidElement<ButtonProps>(node)) {
        return found;
    }
    const props = node.props;
    if (typeof props.className === 'string' && props.className.split(/\s+/).includes(className)) {
        found.push(node);
    }
    if (typeof node.type === 'function') {
        collectButtons((node.type as (componentProps: ButtonProps) => React.ReactNode)(props), className, found);
        return found;
    }
    collectButtons(props.children, className, found);
    return found;
}

/** Props the card uses for apply, undo, artifact, and next-action buttons. */
export interface ButtonProps {
    readonly className?: string;
    readonly children?: React.ReactNode;
    readonly disabled?: boolean;
    readonly onClick?: () => void;
}

/** Escape text the way React escapes child text in static markup. */
export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function fieldText(body: string, className: string): string {
    const pattern = new RegExp(`<span class="${className}">([\\s\\S]*?)</span>`);
    const match = body.match(pattern);
    return match ? decodeHtml(match[1]) : '';
}

function decodeHtml(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}
