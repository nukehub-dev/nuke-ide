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
 * Nuke Tool Call Renderer
 *
 * Renders a finished Nuke capability call as a compact chat card instead of a
 * raw JSON dump. The renderer only claims completed calls that are not waiting
 * for confirmation; every other state falls through to Theia's default tool
 * renderer so progress and Allow/Deny controls keep working unchanged.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ChatResponseContent, ToolCallChatResponseContent } from '@theia/ai-chat/lib/common';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import { OpenerService, open } from '@theia/core/lib/browser';
import { URI } from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import {
    NukeToolCallArtifact,
    NukeToolCallHtml,
    NukeToolCallImage,
    NukeToolCallSummary,
    NukeToolCallSummaryEntry,
    formatJsonDetails,
    summarizeNukeToolResult,
    summaryEntries,
    toolLabel
} from './nuke-tool-call-summary';

type CardStatus = 'done' | 'warning' | 'failed';

interface CardIssue {
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
    readonly category?: string;
    readonly suggestion?: string;
}

@injectable()
export class NukeToolCallRenderer implements ChatResponsePartRenderer<ToolCallChatResponseContent> {
    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    canHandle(response: ChatResponseContent): number {
        if (
            ToolCallChatResponseContent.is(response) &&
            typeof response.name === 'string' &&
            response.name.startsWith('nuke_') &&
            response.finished &&
            !response.isAwaitingUserConfirmation
        ) {
            return 30;
        }
        return -1;
    }

    render(response: ToolCallChatResponseContent, _parentNode: ResponseNode): React.ReactNode {
        const summary = summarizeNukeToolResult(response.result);
        const issues = readIssues(summary.data);
        const status = readStatus(summary, issues);
        const errors = summary.errors.filter((error) => error !== summary.message);
        const entries = summaryEntries(summary.data);
        const title = toolLabel(response.name ?? '');
        const actionRows = summary.nextActions.map((action) => ({
            label: actionLabel(action.capability),
            reason: action.reason
        }));
        const details = { arguments: parseArguments(response.arguments), result: summary };

        return (
            <div className={`nuke-tool-card nuke-tool-card-${status}`} data-status={status}>
                <div className="nuke-tool-card-header">
                    <span className={`nuke-tool-card-icon codicon ${statusIcon(status)}`} aria-hidden="true" />
                    <span className="nuke-tool-card-title">{title}</span>
                    <span className="nuke-tool-card-status">{statusLabel(status)}</span>
                </div>

                {summary.message && <p className="nuke-tool-card-message">{summary.message}</p>}

                {entries.length > 0 && <SummaryGrid entries={entries} />}

                {issues.length > 0 && <IssueList issues={issues} />}

                {errors.length > 0 && (
                    <CardSection title="Errors">
                        <ul className="nuke-tool-card-list nuke-tool-card-errors">
                            {errors.map((error, index) => (
                                <li key={`${index}-${error}`}>{error}</li>
                            ))}
                        </ul>
                    </CardSection>
                )}

                {summary.warnings.length > 0 && (
                    <CardSection title="Warnings">
                        <ul className="nuke-tool-card-list nuke-tool-card-warnings">
                            {summary.warnings.map((warning, index) => (
                                <li key={`${index}-${warning}`}>{warning}</li>
                            ))}
                        </ul>
                    </CardSection>
                )}

                {summary.images.length > 0 && (
                    <CardSection title="Preview">
                        <div className="nuke-tool-card-images">
                            {summary.images.map((image, index) => (
                                <ToolImage key={`${index}-${image.mimeType}`} image={image} />
                            ))}
                        </div>
                    </CardSection>
                )}

                {summary.rawHtml.length > 0 && (
                    <CardSection title="HTML preview">
                        <div className="nuke-tool-card-html-blocks">
                            {summary.rawHtml.map((html, index) => (
                                <ToolHtml key={`${index}-${html.title}`} html={html} />
                            ))}
                        </div>
                    </CardSection>
                )}

                {summary.artifacts.length > 0 && (
                    <CardSection title="Artifacts">
                        <div className="nuke-tool-card-artifacts">
                            {summary.artifacts.map((artifact, index) => (
                                <ArtifactButton
                                    key={`${index}-${artifact.label}`}
                                    artifact={artifact}
                                    onOpen={this.openArtifact.bind(this)}
                                />
                            ))}
                        </div>
                    </CardSection>
                )}

                {actionRows.length > 0 && (
                    <CardSection title="Next actions">
                        <ul className="nuke-tool-card-list nuke-tool-card-actions">
                            {actionRows.map((action, index) => (
                                <li key={`${index}-${action.label}`}>
                                    <span className="nuke-tool-card-action-label">{action.label}</span>
                                    <span className="nuke-tool-card-action-reason">{action.reason}</span>
                                </li>
                            ))}
                        </ul>
                    </CardSection>
                )}

                <details className="nuke-tool-card-details">
                    <summary>Raw details</summary>
                    <pre className="nuke-tool-card-details-json">{formatJsonDetails(details)}</pre>
                </details>
            </div>
        );
    }

    protected async openArtifact(artifact: NukeToolCallArtifact): Promise<void> {
        try {
            const uri =
                artifact.path !== undefined
                    ? URI.fromFilePath(artifact.path)
                    : artifact.uri !== undefined
                      ? new URI(artifact.uri)
                      : undefined;
            if (!uri) {
                return;
            }
            await open(this.openerService, uri);
        } catch {
            // An opener may reject for a removed or unsupported artifact; the card stays usable.
        }
    }
}

function SummaryGrid({ entries }: { entries: readonly NukeToolCallSummaryEntry[] }): React.ReactNode {
    return (
        <dl className="nuke-tool-card-grid">
            {entries.map((entry, index) => (
                <div className="nuke-tool-card-entry" key={`${index}-${entry.label}`}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function IssueList({ issues }: { issues: readonly CardIssue[] }): React.ReactNode {
    return (
        <CardSection title="Issues">
            <ul className="nuke-tool-card-list nuke-tool-card-issues">
                {issues.map((issue, index) => (
                    <li key={`${index}-${issue.message}`} data-severity={issue.severity}>
                        <span className={`nuke-tool-card-issue-badge nuke-tool-card-issue-${issue.severity}`}>
                            {severityLabel(issue.severity)}
                        </span>
                        <span className="nuke-tool-card-issue-message">{issue.message}</span>
                        {issue.category && <span className="nuke-tool-card-issue-meta">{issue.category}</span>}
                        {issue.suggestion && <span className="nuke-tool-card-issue-suggestion">{issue.suggestion}</span>}
                    </li>
                ))}
            </ul>
        </CardSection>
    );
}

function CardSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
    return (
        <section className="nuke-tool-card-section">
            <span className="nuke-tool-card-section-title">{title}</span>
            {children}
        </section>
    );
}

function ToolImage({ image }: { image: NukeToolCallImage }): React.ReactNode {
    return (
        <figure className="nuke-tool-card-figure">
            <img className="nuke-tool-card-image" src={image.src} alt={image.alt} />
        </figure>
    );
}

function ToolHtml({ html }: { html: NukeToolCallHtml }): React.ReactNode {
    return <iframe className="nuke-tool-card-html" sandbox="" srcDoc={html.html} title={html.title} />;
}

function ArtifactButton({
    artifact,
    onOpen
}: {
    artifact: NukeToolCallArtifact;
    onOpen: (artifact: NukeToolCallArtifact) => Promise<void>;
}): React.ReactNode {
    const target = artifact.path ?? artifact.uri;
    if (!target) {
        return (
            <span className="nuke-tool-card-artifact nuke-tool-card-artifact-static">
                <span className="codicon codicon-file" aria-hidden="true" />
                <span>{artifact.label}</span>
            </span>
        );
    }
    return (
        <button type="button" className="nuke-tool-card-artifact" onClick={() => void onOpen(artifact)}>
            <span className="codicon codicon-go-to-file" aria-hidden="true" />
            <span className="nuke-tool-card-artifact-label">{artifact.label}</span>
            <span className="nuke-tool-card-artifact-target">{shortTarget(target)}</span>
        </button>
    );
}

function readStatus(summary: NukeToolCallSummary, issues: readonly CardIssue[]): CardStatus {
    if (summary.ok === false || summary.errors.length > 0 || issues.some((issue) => issue.severity === 'error')) {
        return 'failed';
    }
    if (summary.warnings.length > 0 || issues.some((issue) => issue.severity === 'warning')) {
        return 'warning';
    }
    return 'done';
}

function readIssues(data: unknown): CardIssue[] {
    if (!isRecord(data) || !Array.isArray(data.issues)) {
        return [];
    }
    const issues: CardIssue[] = [];
    for (const entry of data.issues) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
            issues.push({ severity: 'info', message: entry });
            continue;
        }
        if (!isRecord(entry) || typeof entry.message !== 'string' || entry.message.trim().length === 0) {
            continue;
        }
        issues.push({
            severity: readSeverity(entry.severity),
            message: entry.message,
            category: typeof entry.category === 'string' ? entry.category : undefined,
            suggestion: typeof entry.suggestion === 'string' ? entry.suggestion : undefined
        });
    }
    return issues;
}

function readSeverity(value: unknown): CardIssue['severity'] {
    return value === 'error' || value === 'warning' ? value : 'info';
}

function statusLabel(status: CardStatus): string {
    switch (status) {
        case 'failed':
            return 'Failed';
        case 'warning':
            return 'Warning';
        default:
            return 'Done';
    }
}

function statusIcon(status: CardStatus): string {
    switch (status) {
        case 'failed':
            return 'codicon-error';
        case 'warning':
            return 'codicon-warning';
        default:
            return 'codicon-pass-filled';
    }
}

function severityLabel(severity: CardIssue['severity']): string {
    return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function parseArguments(raw: string | undefined): unknown {
    if (!raw || raw.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function actionLabel(capability: string): string {
    if (!capability) {
        return 'Next step';
    }
    return toolLabel(capability.replace(/\./g, '_'));
}

function shortTarget(target: string): string {
    const normalized = target.replace(/\\/g, '/');
    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    if (segments.length <= 3) {
        return target;
    }
    return `\u2026/${segments.slice(-2).join('/')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
