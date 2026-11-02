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
 * Presentational CAD edit review panel.
 *
 * Renders NukeAI CAD edit proposals (feature-parameter and sketch-dimension
 * changes) with their document binding, parameter diff, build impact, and
 * Apply/Dismiss actions, plus the applied entries that can still be undone in
 * this session. The widget in `review-panel-widget.tsx` owns all service
 * interaction; this module stays a pure, hook-free function of its props so it
 * can be rendered in tests with `renderToStaticMarkup`.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeBadge } from 'nuke-essentials/lib/theme/browser/components/nuke-badge';
import { NukeEmptyState } from 'nuke-essentials/lib/theme/browser/components/nuke-empty-state';
import { NukeFormRow, NukeSection } from 'nuke-essentials/lib/theme/browser/components/nuke-form';
import { NukeLoadingOverlay } from 'nuke-essentials/lib/theme/browser/components/nuke-loading-overlay';
import type { SketchSolveSummary } from '../../sketch/sketch-edit-types';

/** Before/after count for one build-impact metric. */
export interface CadReviewImpactPair {
    readonly before: number;
    readonly after: number;
}

/** Axis-aligned bounding box attached to a proposal impact. */
export interface CadReviewBoundingBox {
    readonly min: readonly number[];
    readonly max: readonly number[];
}

/** Build impact recorded when the proposal preview ran. */
export interface CadReviewImpact {
    readonly solids?: CadReviewImpactPair;
    readonly faces?: CadReviewImpactPair;
    readonly triangles?: CadReviewImpactPair;
    readonly boundingBox?: {
        readonly before?: CadReviewBoundingBox;
        readonly after?: CadReviewBoundingBox;
    };
}

/** Successful preview-build counts attached to a proposal. */
export interface CadReviewBuild {
    readonly success?: boolean;
    readonly solidCount?: number;
    readonly faceCount?: number;
    readonly triangleCount?: number;
}

/** Solver and affected-sketch context attached to a sketch proposal. */
export interface CadReviewSketchContext {
    readonly targetSketchId: string;
    readonly targetSketchName: string;
    readonly affectedSketchIds: readonly string[];
    readonly solver: SketchSolveSummary;
}

/** One proposal as rendered by the panel. */
export interface CadReviewProposalView {
    readonly id: string;
    readonly summary: string;
    readonly documentPath: string;
    readonly changes: readonly NukeChange[];
    readonly scope?: 'features' | 'sketch';
    readonly applyCapability?: string;
    readonly sketch?: CadReviewSketchContext;
    readonly impact?: CadReviewImpact;
    readonly build?: CadReviewBuild;
}

/** One successfully applied proposal retained for session undo. */
export interface CadReviewAppliedEntry {
    readonly proposalId: string;
    readonly summary: string;
    /** Compact primary change shown in the sidebar; falls back to `summary`. */
    readonly detail?: string;
    /** Opaque `NukeUndoService` token; empty when the apply returned none. */
    readonly undoToken: string;
    readonly scope?: 'features' | 'sketch';
}

/** Props for the pure review panel view. */
export interface CadReviewPanelViewProps {
    readonly proposals: readonly CadReviewProposalView[];
    readonly applied: readonly CadReviewAppliedEntry[];
    /** `nukeCad.aiAuthoringEnabled`; when false the panel only explains the gate. */
    readonly authoringEnabled: boolean;
    /** True while the apply capability is running. */
    readonly applying: boolean;
    /** Applied proposal ids whose undo token is still redeemable. */
    readonly undoableProposalIds: readonly string[];
    readonly onApply: (proposalId: string) => void;
    readonly onDismiss: (proposalId: string) => void;
    readonly onUndo: (proposalId: string) => void;
    readonly onOpenSettings?: () => void;
}

const CHANGE_VALUE_LIMIT = 120;

/** Render a diff value compactly; long structured values are truncated. */
function formatReviewValue(value: unknown): string {
    if (value === undefined) {
        return '\u2014';
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'string') {
        return truncate(value.length === 0 ? '""' : value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        const serialized = JSON.stringify(value);
        return truncate(serialized ?? String(value));
    } catch {
        return truncate(String(value));
    }
}

function truncate(value: string): string {
    return value.length > CHANGE_VALUE_LIMIT ? `${value.slice(0, CHANGE_VALUE_LIMIT - 1)}\u2026` : value;
}

function formatNumber(value: number): string {
    return Number.isFinite(value) && !Number.isInteger(value) ? String(Number(value.toFixed(3))) : String(value);
}

function formatPoint(point: readonly number[]): string {
    return `[${point.map((value) => formatNumber(value)).join(', ')}]`;
}

function formatBoundingBox(box: CadReviewBoundingBox): string {
    return `${formatPoint(box.min)} \u2013 ${formatPoint(box.max)}`;
}

function documentBasename(path: string): string {
    const name = path.replace(/\\/g, '/').split('/').pop();
    return name !== undefined && name.length > 0 ? name : path;
}

const IMPACT_ROWS: ReadonlyArray<{ readonly key: keyof CadReviewImpact; readonly label: string }> = [
    { key: 'solids', label: 'Solids' },
    { key: 'faces', label: 'Faces' },
    { key: 'triangles', label: 'Triangles' }
];

function ImpactSummary(props: { readonly impact?: CadReviewImpact; readonly build?: CadReviewBuild }): React.ReactElement | null {
    const impact = props.impact;
    const build = props.build;
    const rows = IMPACT_ROWS.map((row) => ({ ...row, pair: impact?.[row.key] as CadReviewImpactPair | undefined })).filter(
        (row): row is { key: keyof CadReviewImpact; label: string; pair: CadReviewImpactPair } => row.pair !== undefined
    );
    const beforeBox = impact?.boundingBox?.before;
    const afterBox = impact?.boundingBox?.after;
    const box = afterBox ?? beforeBox;
    const hasBuild = build !== undefined;
    if (rows.length === 0 && box === undefined && !hasBuild) {
        return null;
    }
    const boxText =
        beforeBox !== undefined && afterBox !== undefined
            ? `${formatBoundingBox(beforeBox)} \u2192 ${formatBoundingBox(afterBox)}`
            : box !== undefined
              ? formatBoundingBox(box)
              : undefined;
    return (
        <div className="cad-review-impact">
            <span className="cad-review-impact-title">Impact</span>
            {rows.length > 0 && (
                <div className="cad-review-impact-counts">
                    {rows.map((row) => (
                        <NukeBadge key={row.key} className="cad-review-impact-badge">
                            {`${row.label} ${formatNumber(row.pair.before)} \u2192 ${formatNumber(row.pair.after)}`}
                        </NukeBadge>
                    ))}
                </div>
            )}
            {boxText !== undefined && <span className="cad-review-bbox">{`Bounding box: ${boxText}`}</span>}
            {build !== undefined && (
                <span className="cad-review-build">
                    {`Build: ${formatNumber(build.solidCount ?? 0)} solids \u00b7 ${formatNumber(build.faceCount ?? 0)} faces \u00b7 ${formatNumber(
                        build.triangleCount ?? 0
                    )} triangles`}
                </span>
            )}
        </div>
    );
}

function pluralize(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

interface SketchIssue {
    readonly key: 'error' | 'warning';
    readonly label: string;
    readonly severity: 'error' | 'warning';
}

/** Compact solver issue labels; conflicting constraints name the error cause. */
function sketchIssues(solver: SketchSolveSummary): readonly SketchIssue[] {
    const issues: SketchIssue[] = [];
    if (solver.errorCount > 0) {
        issues.push({
            key: 'error',
            label:
                solver.conflicting.length > 0
                    ? pluralize(solver.conflicting.length, 'conflicting constraint')
                    : pluralize(solver.errorCount, 'solver error'),
            severity: 'error'
        });
    }
    if (solver.warningCount > 0) {
        issues.push({ key: 'warning', label: pluralize(solver.warningCount, 'warning'), severity: 'warning' });
    }
    return issues;
}

function SketchContext(props: { readonly sketch: CadReviewSketchContext }): React.ReactElement {
    const sketch = props.sketch;
    const solver = sketch.solver;
    const affectedCount = sketch.affectedSketchIds.length;
    return (
        <div className="cad-review-sketch-context" role="group" aria-label={`Sketch context for ${sketch.targetSketchName}`}>
            <span className="cad-review-sketch-name">{`Sketch ${sketch.targetSketchName}`}</span>
            <NukeBadge className="cad-review-sketch-solver">
                {solver.fullyConstrained ? 'Fully constrained' : `${solver.dof} DOF`}
            </NukeBadge>
            {affectedCount > 1 && <NukeBadge className="cad-review-sketch-affected">{`${affectedCount} affected sketches`}</NukeBadge>}
            {sketchIssues(solver).map((issue) => (
                <NukeBadge key={issue.key} className={`cad-review-sketch-issue cad-review-sketch-${issue.severity}`}>
                    {issue.label}
                </NukeBadge>
            ))}
        </div>
    );
}

function ProposalCard(props: {
    readonly proposal: CadReviewProposalView;
    readonly applying: boolean;
    readonly onApply: (proposalId: string) => void;
    readonly onDismiss: (proposalId: string) => void;
}): React.ReactElement {
    const proposal = props.proposal;
    const fallbackTitle = proposal.scope === 'sketch' ? 'Sketch change' : 'Feature change';
    return (
        <NukeSection
            className="cad-review-proposal"
            icon="git-compare"
            title={<span className="cad-review-proposal-title">{proposal.summary.length > 0 ? proposal.summary : fallbackTitle}</span>}
        >
            <div className="cad-review-document">
                <span className="cad-review-document-name">{documentBasename(proposal.documentPath)}</span>
                <span className="cad-review-document-path">{proposal.documentPath}</span>
            </div>
            {proposal.sketch !== undefined && <SketchContext sketch={proposal.sketch} />}
            <div className="cad-review-changes">
                {proposal.changes.map((change, index) => (
                    <NukeFormRow key={`${index}-${change.path}`} label={change.label} className="cad-review-change-row">
                        <span className="cad-review-diff" data-kind={change.kind}>
                            <span className="cad-review-diff-before">{formatReviewValue(change.before)}</span>
                            <span className="cad-review-diff-arrow" aria-hidden="true">
                                {'\u2192'}
                            </span>
                            <span className="cad-review-diff-after">{formatReviewValue(change.after)}</span>
                        </span>
                    </NukeFormRow>
                ))}
            </div>
            <ImpactSummary impact={proposal.impact} build={proposal.build} />
            <div className="cad-review-actions">
                <button
                    type="button"
                    className="theia-button cad-review-apply"
                    onClick={() => props.onApply(proposal.id)}
                    disabled={props.applying}
                >
                    Apply
                </button>
                <button
                    type="button"
                    className="theia-button secondary cad-review-dismiss"
                    onClick={() => props.onDismiss(proposal.id)}
                    disabled={props.applying}
                >
                    Dismiss
                </button>
            </div>
        </NukeSection>
    );
}

function AppliedSection(props: {
    readonly applied: readonly CadReviewAppliedEntry[];
    readonly applying: boolean;
    readonly undoableProposalIds: readonly string[];
    readonly onUndo: (proposalId: string) => void;
}): React.ReactElement {
    return (
        <NukeSection className="cad-review-applied-section" icon="check" title="Applied this session">
            {props.applied.map((entry) => {
                const undoable = entry.undoToken.length > 0 && props.undoableProposalIds.includes(entry.proposalId);
                return (
                    <div key={`${entry.proposalId}-${entry.undoToken}`} className="cad-review-applied">
                        <div className="cad-review-applied-body">
                            <span className="cad-review-applied-summary">
                                <span className="cad-review-applied-kind">
                                    {entry.scope === 'sketch' ? 'Sketch dimension' : 'Feature parameter'}
                                </span>
                                <span className="cad-review-applied-detail">
                                    {entry.detail ?? (entry.summary.length > 0 ? entry.summary : 'CAD edit')}
                                </span>
                            </span>
                            <NukeBadge className="cad-review-applied-badge">Applied</NukeBadge>
                        </div>
                        <button
                            type="button"
                            className="theia-button secondary cad-review-undo"
                            onClick={() => props.onUndo(entry.proposalId)}
                            disabled={!undoable || props.applying}
                            aria-label={`Undo ${entry.summary.length > 0 ? entry.summary : 'CAD edit'}`}
                        >
                            Undo
                        </button>
                    </div>
                );
            })}
        </NukeSection>
    );
}

/**
 * Pure review panel: header, proposal cards, applied-undo entries, and the
 * apply-progress overlay. No service access and no hooks, so tests can call it
 * directly and render the result to static markup.
 */
export function CadReviewPanelView(props: CadReviewPanelViewProps): React.ReactElement {
    const showProposals = props.authoringEnabled && (props.proposals.length > 0 || props.applied.length > 0);
    return (
        <div className="cad-review-panel" aria-busy={props.applying}>
            <div className="cad-review-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-git-compare" />
                        CAD Edit Review
                        {props.authoringEnabled && props.proposals.length > 0 && (
                            <NukeBadge className="cad-review-count">{props.proposals.length}</NukeBadge>
                        )}
                    </h2>
                    <p className="header-description">Review AI-proposed CAD edits before applying them.</p>
                </div>
            </div>

            <div className="cad-review-content">
                {!props.authoringEnabled && (
                    <NukeEmptyState
                        className="cad-review-empty"
                        icon="lock"
                        title="AI authoring is off"
                        message={
                            <>
                                Turn on AI authoring in <strong>Settings → Nuke CAD → AI Authoring</strong> to review proposed CAD edits
                                here.
                            </>
                        }
                    >
                        {props.onOpenSettings !== undefined && (
                            <button type="button" className="theia-button secondary" onClick={props.onOpenSettings}>
                                Open Settings
                            </button>
                        )}
                    </NukeEmptyState>
                )}

                {props.authoringEnabled && !showProposals && (
                    <NukeEmptyState
                        className="cad-review-empty"
                        icon="git-compare"
                        title="No proposed edits"
                        message="NukeAI CAD edit previews appear here with their diff, impact, and Apply/Dismiss actions."
                    />
                )}

                {showProposals && props.proposals.length === 0 && (
                    <p className="cad-review-no-pending">No pending proposals. Applied changes can still be undone below.</p>
                )}

                {showProposals &&
                    props.proposals.map((proposal) => (
                        <ProposalCard
                            key={proposal.id}
                            proposal={proposal}
                            applying={props.applying}
                            onApply={props.onApply}
                            onDismiss={props.onDismiss}
                        />
                    ))}

                {showProposals && props.applied.length > 0 && (
                    <AppliedSection
                        applied={props.applied}
                        applying={props.applying}
                        undoableProposalIds={props.undoableProposalIds}
                        onUndo={props.onUndo}
                    />
                )}
            </div>

            {props.applying && (
                <NukeLoadingOverlay message="Applying CAD change..." subMessage="Saving the document and scheduling a rebuild." />
            )}
        </div>
    );
}
