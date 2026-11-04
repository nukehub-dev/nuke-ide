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
 * Nuke Tool Call Card
 *
 * Pure presentational card markup for a finished Nuke capability call. The card
 * owns only summary formatting and rendering; opening artifacts, applying a
 * change set, and undoing an applied change stay with the Theia-aware renderer
 * and next-action service so this module can run in a plain Node test
 * environment.
 *
 * @module nuke-ai/browser/capabilities
 */

import * as React from '@theia/core/shared/react';
import {
    NukeToolCallArtifact,
    NukeToolCallChangeSet,
    NukeToolCallHtml,
    NukeToolCallImage,
    NukeToolCallSummary,
    NukeToolCallSummaryEntry,
    formatChangeValue,
    formatJsonDetails,
    summaryEntries,
    toolLabel
} from './nuke-tool-call-summary';

/** Visual status of a finished tool call. */
export type NukeToolCardStatus = 'done' | 'warning' | 'failed';

/** One issue read from a tool result payload. */
export interface NukeToolCardIssue {
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
    readonly category?: string;
    readonly suggestion?: string;
}

/** One follow-up suggestion shown at the bottom of a card. */
export interface NukeToolCardAction {
    readonly label: string;
    readonly reason: string;
    readonly capability: string;
    readonly direct: boolean;
}

/** The subset of a Theia chat response needed to claim a finished Nuke tool call. */
export interface NukeToolCallResponseLike {
    readonly kind: string;
    readonly name?: string;
    readonly finished?: boolean;
    readonly isAwaitingUserConfirmation?: boolean;
}

/** Props for the pure tool-call card. */
export interface NukeToolCardProps {
    readonly toolName: string;
    readonly summary: NukeToolCallSummary;
    readonly issues: readonly NukeToolCardIssue[];
    readonly status: NukeToolCardStatus;
    readonly details: unknown;
    readonly onOpenArtifact?: (artifact: NukeToolCallArtifact) => void | Promise<void>;
    readonly canRunDirectly?: (capabilityId: string) => boolean;
    readonly onRunAction?: (action: NukeToolCardAction) => void | Promise<void>;
    readonly onAskAction?: (action: NukeToolCardAction) => void | Promise<void>;
    readonly onApplyChangeSet?: (changeSet: NukeToolCallChangeSet) => void | Promise<void>;
    readonly onUndo?: (undoToken: string) => void | Promise<void>;
}

/**
 * Claim only finished, non-awaiting Nuke capability calls.
 *
 * Returning -1 for every other state keeps Theia's progress and confirmation UI
 * in charge of running calls and Allow/Deny prompts.
 */
export function canHandleNukeToolCall(response: NukeToolCallResponseLike): number {
    if (
        response.kind === 'toolCall' &&
        typeof response.name === 'string' &&
        response.name.startsWith('nuke_') &&
        response.finished === true &&
        !response.isAwaitingUserConfirmation
    ) {
        return 30;
    }
    return -1;
}

/** Read structured issues from a tool result's `data.issues` field. */
export function readIssues(data: unknown): NukeToolCardIssue[] {
    if (!isRecord(data) || !Array.isArray(data.issues)) {
        return [];
    }
    const issues: NukeToolCardIssue[] = [];
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

/** Derive a card status from the result and its issues. */
export function readStatus(summary: NukeToolCallSummary, issues: readonly NukeToolCardIssue[]): NukeToolCardStatus {
    if (summary.ok === false || summary.errors.length > 0 || issues.some((issue) => issue.severity === 'error')) {
        return 'failed';
    }
    if (summary.warnings.length > 0 || issues.some((issue) => issue.severity === 'warning')) {
        return 'warning';
    }
    return 'done';
}

/** Human-readable label for a card status. */
export function statusLabel(status: NukeToolCardStatus): string {
    switch (status) {
        case 'failed':
            return 'Failed';
        case 'warning':
            return 'Warning';
        default:
            return 'Done';
    }
}

/** Render a finished Nuke capability result as a compact chat card. */
export function NukeToolCard({
    toolName,
    summary,
    issues,
    status,
    details,
    onOpenArtifact,
    canRunDirectly,
    onRunAction,
    onAskAction,
    onApplyChangeSet,
    onUndo
}: NukeToolCardProps): React.ReactNode {
    const entries = summaryEntries(summary.data);
    const errors = summary.errors.filter((error) => error !== summary.message);
    const actionRows = summary.nextActions.map((action): NukeToolCardAction => ({
        label: actionLabel(action.capability),
        reason: action.reason,
        capability: action.capability,
        direct: canRunDirectly ? canRunDirectly(action.capability) : false
    }));

    return (
        <div className={`nuke-tool-card nuke-tool-card-${status}`} data-status={status}>
            <div className="nuke-tool-card-header">
                <span className={`nuke-tool-card-icon codicon ${statusIcon(status)}`} aria-hidden="true" />
                <span className="nuke-tool-card-title">{toolLabel(toolName)}</span>
                <span className="nuke-tool-card-status">{statusLabel(status)}</span>
            </div>

            {summary.message && <p className="nuke-tool-card-message">{summary.message}</p>}

            {entries.length > 0 && <SummaryGrid entries={entries} />}

            {summary.changeSet && (
                <ChangeSet changeSet={summary.changeSet} undoToken={summary.undoToken} onApply={onApplyChangeSet} onUndo={onUndo} />
            )}

            {!summary.changeSet && summary.undoToken && (
                <CardSection title="Change">
                    <div className="nuke-tool-card-change-actions">
                        <UndoButton token={summary.undoToken} onUndo={onUndo} />
                    </div>
                </CardSection>
            )}

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
                            <ArtifactButton key={`${index}-${artifact.label}`} artifact={artifact} onOpen={onOpenArtifact} />
                        ))}
                    </div>
                </CardSection>
            )}

            {actionRows.length > 0 && (
                <CardSection title="Next actions">
                    <ul className="nuke-tool-card-list nuke-tool-card-actions">
                        {actionRows.map((action, index) => {
                            const handler = action.direct ? onRunAction : onAskAction;
                            return (
                                <li key={`${index}-${action.capability}-${action.label}`}>
                                    <button
                                        type="button"
                                        className="theia-button secondary nuke-tool-card-action-button"
                                        onClick={handler ? () => void handler(action) : undefined}
                                        disabled={!handler}
                                    >
                                        {action.direct ? 'Run' : 'Ask NukeAI'}
                                    </button>
                                    <span className="nuke-tool-card-action-body">
                                        <span className="nuke-tool-card-action-label">{action.label}</span>
                                        {action.reason && <span className="nuke-tool-card-action-reason">{action.reason}</span>}
                                    </span>
                                </li>
                            );
                        })}
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

function ChangeSet({
    changeSet,
    undoToken,
    onApply,
    onUndo
}: {
    changeSet: NukeToolCallChangeSet;
    undoToken?: string;
    onApply?: NukeToolCardProps['onApplyChangeSet'];
    onUndo?: NukeToolCardProps['onUndo'];
}): React.ReactNode {
    const canApply = changeSet.applyCapability !== undefined;
    return (
        <CardSection title="Changes">
            <div className="nuke-tool-card-change-set">
                <div className="nuke-tool-card-change-heading">
                    <span className="nuke-tool-card-change-title">{changeSet.title}</span>
                    {changeSet.summary.length > 0 && <span className="nuke-tool-card-change-summary">{changeSet.summary}</span>}
                </div>
                <ul className="nuke-tool-card-list nuke-tool-card-changes">
                    {changeSet.changes.map((change, index) => (
                        <li key={`${index}-${change.path}`} className="nuke-tool-card-change" data-kind={change.kind}>
                            <span className="nuke-tool-card-change-body">
                                <span className="nuke-tool-card-change-label">{change.label}</span>
                                <span className="nuke-tool-card-change-path">{change.path}</span>
                            </span>
                            <span className="nuke-tool-card-change-values">
                                <span className="nuke-tool-card-change-before">{formatChangeValue(change.before)}</span>
                                <span className="nuke-tool-card-change-arrow" aria-hidden="true">
                                    {'\u2192'}
                                </span>
                                <span className="nuke-tool-card-change-after">{formatChangeValue(change.after)}</span>
                            </span>
                        </li>
                    ))}
                </ul>
                {(canApply || undoToken) && (
                    <div className="nuke-tool-card-change-actions">
                        {canApply && (
                            <button
                                type="button"
                                className="theia-button nuke-tool-card-apply-button"
                                onClick={onApply ? () => void onApply(changeSet) : undefined}
                                disabled={!onApply}
                            >
                                Apply with NukeAI
                            </button>
                        )}
                        {undoToken && <UndoButton token={undoToken} onUndo={onUndo} />}
                    </div>
                )}
            </div>
        </CardSection>
    );
}

function UndoButton({ token, onUndo }: { token: string; onUndo?: NukeToolCardProps['onUndo'] }): React.ReactNode {
    return (
        <button
            type="button"
            className="theia-button secondary nuke-tool-card-undo-button"
            onClick={onUndo ? () => void onUndo(token) : undefined}
            disabled={!onUndo}
        >
            Undo
        </button>
    );
}

function IssueList({ issues }: { issues: readonly NukeToolCardIssue[] }): React.ReactNode {
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
    onOpen?: NukeToolCardProps['onOpenArtifact'];
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
        <button type="button" className="nuke-tool-card-artifact" onClick={onOpen ? () => void onOpen(artifact) : undefined}>
            <span className="codicon codicon-go-to-file" aria-hidden="true" />
            <span className="nuke-tool-card-artifact-label">{artifact.label}</span>
            <span className="nuke-tool-card-artifact-target">{shortTarget(target)}</span>
        </button>
    );
}

function readSeverity(value: unknown): NukeToolCardIssue['severity'] {
    return value === 'error' || value === 'warning' ? value : 'info';
}

function statusIcon(status: NukeToolCardStatus): string {
    switch (status) {
        case 'failed':
            return 'codicon-error';
        case 'warning':
            return 'codicon-warning';
        default:
            return 'codicon-pass-filled';
    }
}

function severityLabel(severity: NukeToolCardIssue['severity']): string {
    return severity.charAt(0).toUpperCase() + severity.slice(1);
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
