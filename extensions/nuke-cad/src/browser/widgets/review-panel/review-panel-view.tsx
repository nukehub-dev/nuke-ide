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
 * Renders NukeAI CAD edit proposals (feature-parameter, sketch-dimension,
 * topology, import, assembly-placement, and drawing-sheet changes) with their
 * document binding, plan or parameter diff, build and region impact, and
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
import { NukeCheckbox } from 'nuke-essentials/lib/theme/browser/components/nuke-checkbox';
import { NukeEmptyState } from 'nuke-essentials/lib/theme/browser/components/nuke-empty-state';
import { NukeFormRow, NukeSection } from 'nuke-essentials/lib/theme/browser/components/nuke-form';
import { NukeLoadingOverlay } from 'nuke-essentials/lib/theme/browser/components/nuke-loading-overlay';
import type { AssemblyBomDelta } from '../../../common/assembly-bom';
import type { InstancePlacement } from '../../../common/assembly-document';
import {
    formatDrawingScale,
    type DrawingDimensionKind,
    type DrawingSheetSize,
    type DrawingViewKind,
    type DrawingViewOrientation
} from '../../../common/cad-drawing';
import type { AssemblyPlacementPlan, AssemblyRemovedRegion } from '../../../common/cad-assembly-edit';
import type { OpenmcReferenceSnapshot, OpenmcRegionBlocker } from '../../../common/openmc-region-references';
import type { TopologyChangedRegion, TopologyImpact, TopologyRegionRef } from '../../../common/topology-impact';
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

/** Region and OpenMC impact attached to a topology proposal. */
export interface CadReviewTopologyContext {
    readonly impact: TopologyImpact;
    readonly blockedRegions: readonly OpenmcRegionBlocker[];
    readonly openmcStatus: OpenmcReferenceSnapshot['status'];
    readonly openmcProjectPath?: string;
    readonly openmcWarnings: readonly string[];
}

/** Placement, BOM, collision, and region impact attached to an assembly proposal. */
export interface CadReviewAssemblyContext {
    readonly placements: readonly AssemblyPlacementPlan[];
    readonly bomDelta: AssemblyBomDelta;
    readonly collisionWarnings: readonly string[];
    readonly overlapCheck: boolean;
    readonly removedSelectorKeys: readonly string[];
    readonly removedRegions: readonly AssemblyRemovedRegion[];
    readonly blockedRegions: readonly OpenmcRegionBlocker[];
    readonly openmcStatus: OpenmcReferenceSnapshot['status'];
    readonly openmcProjectPath?: string;
    readonly openmcWarnings: readonly string[];
    readonly requiresAcknowledgement: boolean;
}

/** One planned body/feature created by an import proposal. */
export interface CadReviewImportBody {
    readonly name: string;
    readonly label?: string;
    readonly material?: string;
    readonly featureName: string;
}

/** Source, unit, solid-selection, and plan metadata attached to an import proposal. */
export interface CadReviewImportContext {
    readonly sourcePath: string;
    readonly sourceHash: string;
    readonly sourceSize?: number;
    readonly sourceFormat?: string;
    readonly fileUnit?: string;
    readonly effectiveUnit?: string;
    readonly unitScaleFactor?: number;
    readonly unitsMessage?: string;
    readonly documentUnits?: string;
    readonly solidCount: number;
    readonly selectedSolidCount: number;
    readonly strategy: 'single' | 'perSolid';
    readonly bodies: readonly CadReviewImportBody[];
    readonly warnings: readonly string[];
}

/** One planned per-view scale or hidden-line change on a drawing sheet. */
export interface CadReviewDrawingViewChange {
    readonly id: string;
    readonly kind: DrawingViewKind;
    readonly orientation: DrawingViewOrientation;
    readonly scaleBefore: number;
    readonly scaleAfter: number;
    readonly showHiddenBefore: boolean;
    readonly showHiddenAfter: boolean;
}

/** One planned dimension-visibility change on a drawing sheet; hidden dimensions stay on the sheet. */
export interface CadReviewDrawingDimensionChange {
    readonly id: string;
    readonly kind: DrawingDimensionKind;
    readonly viewId: string;
    readonly visibleBefore: boolean;
    readonly visibleAfter: boolean;
}

/** Sheet, view, dimension, and safety context attached to a drawing proposal. */
export interface CadReviewDrawingContext {
    readonly sheet: {
        readonly id: string;
        readonly name: string;
        readonly sizeBefore: DrawingSheetSize;
        readonly sizeAfter: DrawingSheetSize;
    };
    readonly viewChanges: readonly CadReviewDrawingViewChange[];
    readonly dimensionChanges: readonly CadReviewDrawingDimensionChange[];
    readonly warnings: readonly string[];
    readonly titleBlockEditable: boolean;
    readonly requiresDrawingRefresh: boolean;
}

/** One proposal as rendered by the panel. */
export interface CadReviewProposalView {
    readonly id: string;
    readonly summary: string;
    readonly documentPath: string;
    readonly changes: readonly NukeChange[];
    readonly scope?: 'features' | 'sketch' | 'topology' | 'import' | 'assembly' | 'drawing';
    readonly applyCapability?: string;
    readonly sketch?: CadReviewSketchContext;
    readonly topology?: CadReviewTopologyContext;
    readonly importContext?: CadReviewImportContext;
    readonly assembly?: CadReviewAssemblyContext;
    readonly drawing?: CadReviewDrawingContext;
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
    readonly scope?: 'features' | 'sketch' | 'topology' | 'import' | 'assembly' | 'drawing';
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
    /** Topology proposal ids whose region impact the user acknowledged. */
    readonly acknowledgedProposalIds?: readonly string[];
    readonly onAcknowledge?: (proposalId: string, acknowledged: boolean) => void;
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

function ImpactSummary(props: {
    readonly impact?: CadReviewImpact;
    readonly build?: CadReviewBuild;
    readonly hideCounts?: boolean;
}): React.ReactElement | null {
    const impact = props.impact;
    const build = props.build;
    const rows = props.hideCounts
        ? []
        : IMPACT_ROWS.map((row) => ({ ...row, pair: impact?.[row.key] as CadReviewImpactPair | undefined })).filter(
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

/** Compact solid-id list for a changed region; an empty list reads as `none`. */
function formatSolidIds(ids: readonly number[]): string {
    return ids.length === 0 ? 'none' : ids.map((id) => `#${id}`).join(', ');
}

function findRegionBlocker(region: TopologyRegionRef, blockers: readonly OpenmcRegionBlocker[]): OpenmcRegionBlocker | undefined {
    return blockers.find((blocker) => blocker.region.kind === region.kind && blocker.region.selector === region.selector);
}

function RegionRowGroup(props: { readonly title: string; readonly children: React.ReactNode }): React.ReactElement {
    return (
        <div className="cad-review-region-section">
            <span className="cad-review-region-section-title">{props.title}</span>
            {props.children}
        </div>
    );
}

function AddedRegionRow(props: { readonly region: TopologyRegionRef }): React.ReactElement {
    const region = props.region;
    return (
        <div className="cad-review-region-row cad-review-region-added">
            <span className="cad-review-region-selector">{region.selector}</span>
            <span className="cad-review-region-group">{region.group}</span>
            <span className="cad-review-region-solids">{pluralize(region.solidIds.length, 'solid')}</span>
        </div>
    );
}

function RemovedRegionRow(props: { readonly region: TopologyRegionRef; readonly blocker?: OpenmcRegionBlocker }): React.ReactElement {
    const region = props.region;
    return (
        <div className="cad-review-region-row cad-review-region-removed">
            <span className="cad-review-region-selector">{region.selector}</span>
            <span className="cad-review-region-group">{region.group}</span>
            {props.blocker !== undefined && <NukeBadge className="cad-review-region-blocked">Blocked by OpenMC</NukeBadge>}
            {props.blocker !== undefined && <span className="cad-review-region-blocker">{props.blocker.message}</span>}
        </div>
    );
}

function ChangedRegionRow(props: { readonly region: TopologyChangedRegion }): React.ReactElement {
    const region = props.region;
    return (
        <div className="cad-review-region-row cad-review-region-changed">
            <span className="cad-review-region-selector">{region.selector}</span>
            {region.beforeGroup !== region.afterGroup ? (
                <span className="cad-review-region-group-change">{`${region.beforeGroup} \u2192 ${region.afterGroup}`}</span>
            ) : (
                <span className="cad-review-region-group">{region.group}</span>
            )}
            <span className="cad-review-region-solids">{`${formatSolidIds(region.beforeSolidIds)} \u2192 ${formatSolidIds(
                region.afterSolidIds
            )}`}</span>
        </div>
    );
}

function OpenmcImpactLine(props: { readonly topology: CadReviewTopologyContext }): React.ReactElement {
    const topology = props.topology;
    const firstBlocker = topology.blockedRegions[0];
    if (firstBlocker !== undefined) {
        return (
            <p className="cad-review-topology-openmc is-error" role="alert">
                {`${firstBlocker.message} Update the OpenMC project first; apply stays blocked until reference '${firstBlocker.reference}' is removed.`}
            </p>
        );
    }
    if (topology.openmcStatus === 'no-saved-project') {
        return (
            <p className="cad-review-topology-openmc is-warning">
                OpenMC references were not checked because no saved OpenMC project is active.
            </p>
        );
    }
    if (topology.openmcStatus === 'saved-project') {
        const project =
            topology.openmcProjectPath !== undefined ? documentBasename(topology.openmcProjectPath) : 'the saved OpenMC project';
        return <p className="cad-review-topology-openmc is-muted">{`OpenMC: ${project} \u00b7 checked against the saved project file`}</p>;
    }
    return (
        <p className="cad-review-topology-openmc is-warning">
            {topology.openmcWarnings[0] ?? 'OpenMC references could not be checked for this change.'}
        </p>
    );
}

function RegionImpact(props: {
    readonly proposalId: string;
    readonly topology: CadReviewTopologyContext;
    readonly acknowledged: boolean;
    readonly onAcknowledge?: (proposalId: string, acknowledged: boolean) => void;
}): React.ReactElement {
    const impact = props.topology.impact;
    const solidDeltas = [
        { key: 'added', count: impact.addedSolidIds.length, label: 'added solid' },
        { key: 'removed', count: impact.removedSolidIds.length, label: 'removed solid' },
        { key: 'changed', count: impact.changedSolidIds.length, label: 'changed solid' }
    ].filter((delta) => delta.count > 0);
    const hasRegionChanges = impact.addedRegions.length > 0 || impact.removedRegions.length > 0 || impact.changedRegions.length > 0;
    const topologyCountsChanged =
        impact.solids.before !== impact.solids.after ||
        impact.faces.before !== impact.faces.after ||
        impact.triangles.before !== impact.triangles.after ||
        impact.addedSolidIds.length > 0 ||
        impact.removedSolidIds.length > 0 ||
        impact.changedSolidIds.length > 0;
    return (
        <div className="cad-review-topology" role="group" aria-label="Region impact">
            <span className="cad-review-topology-title">Region impact</span>
            <div className="cad-review-impact-counts">
                <NukeBadge className="cad-review-impact-badge">
                    {`Solids ${formatNumber(impact.solids.before)} \u2192 ${formatNumber(impact.solids.after)}`}
                </NukeBadge>
                <NukeBadge className="cad-review-impact-badge">
                    {`Faces ${formatNumber(impact.faces.before)} \u2192 ${formatNumber(impact.faces.after)}`}
                </NukeBadge>
                <NukeBadge className="cad-review-impact-badge">
                    {`Triangles ${formatNumber(impact.triangles.before)} \u2192 ${formatNumber(impact.triangles.after)}`}
                </NukeBadge>
            </div>
            {solidDeltas.length > 0 && (
                <div className="cad-review-topology-deltas">
                    {solidDeltas.map((delta) => (
                        <NukeBadge key={delta.key} className="cad-review-impact-badge">
                            {pluralize(delta.count, delta.label)}
                        </NukeBadge>
                    ))}
                </div>
            )}
            {impact.addedRegions.length > 0 && (
                <RegionRowGroup title="Added regions">
                    {impact.addedRegions.map((region) => (
                        <AddedRegionRow key={`${region.kind}:${region.selector}`} region={region} />
                    ))}
                </RegionRowGroup>
            )}
            {impact.removedRegions.length > 0 && (
                <RegionRowGroup title="Removed regions">
                    {impact.removedRegions.map((region) => (
                        <RemovedRegionRow
                            key={`${region.kind}:${region.selector}`}
                            region={region}
                            blocker={findRegionBlocker(region, props.topology.blockedRegions)}
                        />
                    ))}
                </RegionRowGroup>
            )}
            {impact.changedRegions.length > 0 && (
                <RegionRowGroup title="Changed regions">
                    {impact.changedRegions.map((region) => (
                        <ChangedRegionRow key={region.selector} region={region} />
                    ))}
                </RegionRowGroup>
            )}
            {!hasRegionChanges && topologyCountsChanged && (
                <p className="cad-review-topology-none">No named region changes, but the solid or face topology changed.</p>
            )}
            <OpenmcImpactLine topology={props.topology} />
            <NukeCheckbox
                className="cad-review-topology-ack"
                checked={props.acknowledged}
                onChange={(checked) => props.onAcknowledge?.(props.proposalId, checked)}
                ariaLabel="Acknowledge solid and region impact"
            >
                <span className="cad-review-topology-ack-label">I understand the solid and region impact</span>
            </NukeCheckbox>
        </div>
    );
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

function unitLabel(unit: string | undefined): string {
    const trimmed = unit?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : 'unknown';
}

/** Compact source, unit, and body plan for an import proposal. */
function ImportPlan(props: { readonly context: CadReviewImportContext }): React.ReactElement {
    const context = props.context;
    const scale = context.unitScaleFactor;
    return (
        <div className="cad-review-import" role="group" aria-label="Import plan">
            <span className="cad-review-import-section-title">Import plan</span>
            <div className="cad-review-import-source">
                <span className="codicon codicon-file-symlink-file" aria-hidden="true" />
                <span className="cad-review-import-source-name">{documentBasename(context.sourcePath)}</span>
                {context.sourceFormat !== undefined && (
                    <NukeBadge className="cad-review-import-chip">{context.sourceFormat.toUpperCase()}</NukeBadge>
                )}
                {context.sourceSize !== undefined && (
                    <NukeBadge className="cad-review-import-chip">{`${formatNumber(context.sourceSize)} bytes`}</NukeBadge>
                )}
            </div>
            <span className="cad-review-import-source-path">{context.sourcePath}</span>
            <div className="cad-review-import-units">
                <span className="cad-review-import-line">
                    {`File ${unitLabel(context.fileUnit)} \u00b7 effective ${unitLabel(context.effectiveUnit)} \u00b7 document ${unitLabel(
                        context.documentUnits
                    )}`}
                </span>
                {scale !== undefined && Number.isFinite(scale) && scale !== 1 && (
                    <NukeBadge className="cad-review-import-chip">{`Scale \u00d7${formatNumber(scale)}`}</NukeBadge>
                )}
            </div>
            {context.unitsMessage !== undefined && context.unitsMessage.length > 0 && (
                <p className="cad-review-import-message">{context.unitsMessage}</p>
            )}
            <div className="cad-review-import-solids">
                <span className="cad-review-import-line">
                    {`${pluralize(context.solidCount, 'source solid')} \u00b7 ${context.selectedSolidCount} selected`}
                </span>
                <NukeBadge className="cad-review-import-chip">
                    {context.strategy === 'single' ? 'Single body' : 'One body per solid'}
                </NukeBadge>
            </div>
            {context.bodies.length > 0 && (
                <div className="cad-review-import-plan">
                    <span className="cad-review-import-section-title">Planned bodies</span>
                    {context.bodies.map((body, index) => {
                        const material = body.material?.trim();
                        const hasMaterial = material !== undefined && material.length > 0;
                        return (
                            <div key={`${index}-${body.name}`} className="cad-review-import-body-row">
                                <div className="cad-review-import-body-head">
                                    <span className="cad-review-import-body-name">{body.name}</span>
                                    {body.label !== undefined && body.label.length > 0 && body.label !== body.name && (
                                        <span className="cad-review-import-body-label">{body.label}</span>
                                    )}
                                </div>
                                <div className="cad-review-import-body-meta">
                                    <span
                                        className={hasMaterial ? 'cad-review-import-material' : 'cad-review-import-material is-placeholder'}
                                    >
                                        {hasMaterial ? material : 'No material tag'}
                                    </span>
                                    <span className="cad-review-import-feature">{`Feature ${body.featureName}`}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            {context.warnings.length > 0 && (
                <ul className="cad-review-import-warnings">
                    {context.warnings.map((warning, index) => (
                        <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** Sheet, view-scale/hidden-line, dimension-visibility, and title-block summary for a drawing proposal. */
function DrawingPlan(props: { readonly context: CadReviewDrawingContext }): React.ReactElement {
    const context = props.context;
    const sheet = context.sheet;
    return (
        <div className="cad-review-drawing" role="group" aria-label="Drawing settings">
            <span className="cad-review-drawing-section-title">Drawing settings</span>
            <div className="cad-review-drawing-sheet">
                <span className="cad-review-drawing-sheet-name">{sheet.name}</span>
                <span className="cad-review-drawing-sheet-size">
                    <span className="cad-review-drawing-before">{sheet.sizeBefore}</span>
                    <span className="cad-review-drawing-arrow" aria-hidden="true">
                        {'\u2192'}
                    </span>
                    <span className="cad-review-drawing-after">{sheet.sizeAfter}</span>
                </span>
            </div>
            {context.viewChanges.length > 0 && (
                <div className="cad-review-drawing-views" role="group" aria-label="View changes">
                    <span className="cad-review-drawing-section-title">Views</span>
                    {context.viewChanges.map((change) => (
                        <div key={change.id} className="cad-review-drawing-row cad-review-drawing-view-row">
                            <div className="cad-review-drawing-row-head">
                                <span className="cad-review-drawing-id">{change.id}</span>
                                <span className="cad-review-drawing-kind">{change.kind}</span>
                                <span className="cad-review-drawing-orientation">{change.orientation}</span>
                            </div>
                            <div className="cad-review-drawing-row-meta">
                                <span className="cad-review-drawing-meta-label">Scale</span>
                                <span className="cad-review-drawing-before">{formatDrawingScale(change.scaleBefore)}</span>
                                <span className="cad-review-drawing-arrow" aria-hidden="true">
                                    {'\u2192'}
                                </span>
                                <span className="cad-review-drawing-after">{formatDrawingScale(change.scaleAfter)}</span>
                            </div>
                            <div className="cad-review-drawing-row-meta">
                                <span className="cad-review-drawing-meta-label">Hidden lines</span>
                                <span className="cad-review-drawing-before">{change.showHiddenBefore ? 'On' : 'Off'}</span>
                                <span className="cad-review-drawing-arrow" aria-hidden="true">
                                    {'\u2192'}
                                </span>
                                <span className="cad-review-drawing-after">{change.showHiddenAfter ? 'On' : 'Off'}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {context.dimensionChanges.length > 0 && (
                <div className="cad-review-drawing-dimensions" role="group" aria-label="Dimension visibility changes">
                    <span className="cad-review-drawing-section-title">Dimensions</span>
                    {context.dimensionChanges.map((change) => (
                        <div key={change.id} className="cad-review-drawing-row cad-review-drawing-dimension-row">
                            <div className="cad-review-drawing-row-head">
                                <span className="cad-review-drawing-id">{change.id}</span>
                                <span className="cad-review-drawing-kind">{change.kind}</span>
                                <span className="cad-review-drawing-view">{`view ${change.viewId}`}</span>
                            </div>
                            <div className="cad-review-drawing-row-meta">
                                <span className="cad-review-drawing-meta-label">Visibility</span>
                                <span className="cad-review-drawing-before">{change.visibleBefore ? 'Visible' : 'Hidden'}</span>
                                <span className="cad-review-drawing-arrow" aria-hidden="true">
                                    {'\u2192'}
                                </span>
                                <span className="cad-review-drawing-after">{change.visibleAfter ? 'Visible' : 'Hidden'}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <p className="cad-review-drawing-note">
                Sheet edits do not rebuild 3D geometry and have no viewport ghost; hidden dimensions are not deleted.
            </p>
            <p className="cad-review-drawing-title-block">Title block is fixed and read-only in this slice.</p>
            {context.warnings.length > 0 && (
                <ul className="cad-review-drawing-warnings">
                    {context.warnings.map((warning, index) => (
                        <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function ProposalCard(props: {
    readonly proposal: CadReviewProposalView;
    readonly applying: boolean;
    readonly acknowledged: boolean;
    readonly onApply: (proposalId: string) => void;
    readonly onDismiss: (proposalId: string) => void;
    readonly onAcknowledge?: (proposalId: string, acknowledged: boolean) => void;
}): React.ReactElement {
    const proposal = props.proposal;
    const fallbackTitle =
        proposal.scope === 'sketch'
            ? 'Sketch change'
            : proposal.scope === 'topology'
              ? 'Topology change'
              : proposal.scope === 'import'
                ? 'Import bodies'
                : proposal.scope === 'assembly'
                  ? 'Assembly change'
                  : proposal.scope === 'drawing'
                    ? 'Drawing settings'
                    : 'Feature change';
    const blocked =
        (proposal.topology !== undefined && proposal.topology.blockedRegions.length > 0) ||
        (proposal.assembly !== undefined && proposal.assembly.blockedRegions.length > 0);
    const requiresAcknowledgement =
        proposal.scope === 'topology' ||
        proposal.topology?.impact.requiresAcknowledgement === true ||
        (proposal.scope === 'assembly' && proposal.assembly?.requiresAcknowledgement === true);
    const applyDisabled = props.applying || blocked || (requiresAcknowledgement && !props.acknowledged);
    return (
        <NukeSection
            className="cad-review-proposal"
            icon="git-compare"
            title={
                <span className="cad-review-proposal-title">
                    {proposal.summary.length > 0 ? proposal.summary : fallbackTitle}
                    {proposal.scope === 'topology' && <NukeBadge className="cad-review-topology-badge">Topology</NukeBadge>}
                    {proposal.scope === 'import' && <NukeBadge className="cad-review-import-badge">Import</NukeBadge>}
                    {proposal.scope === 'assembly' && <NukeBadge className="cad-review-assembly-badge">Assembly</NukeBadge>}
                    {proposal.scope === 'drawing' && <NukeBadge className="cad-review-drawing-badge">Drawing</NukeBadge>}
                </span>
            }
        >
            <div className="cad-review-document">
                <span className="cad-review-document-name">{documentBasename(proposal.documentPath)}</span>
                <span className="cad-review-document-path">{proposal.documentPath}</span>
            </div>
            {proposal.sketch !== undefined && <SketchContext sketch={proposal.sketch} />}
            {proposal.scope === 'drawing' && proposal.drawing !== undefined && <DrawingPlan context={proposal.drawing} />}
            {proposal.scope === 'import' && proposal.importContext !== undefined && <ImportPlan context={proposal.importContext} />}
            {proposal.scope === 'assembly' && proposal.assembly !== undefined && (
                <AssemblyPlan
                    proposalId={proposal.id}
                    context={proposal.assembly}
                    acknowledged={props.acknowledged}
                    onAcknowledge={props.onAcknowledge}
                />
            )}
            {proposal.scope !== 'import' && proposal.scope !== 'assembly' && proposal.scope !== 'drawing' && (
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
            )}
            {proposal.topology !== undefined && (
                <RegionImpact
                    proposalId={proposal.id}
                    topology={proposal.topology}
                    acknowledged={props.acknowledged}
                    onAcknowledge={props.onAcknowledge}
                />
            )}
            <ImpactSummary impact={proposal.impact} build={proposal.build} hideCounts={proposal.scope === 'topology'} />
            <div className="cad-review-actions">
                <button
                    type="button"
                    className="theia-button cad-review-apply"
                    onClick={() => props.onApply(proposal.id)}
                    disabled={applyDisabled}
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
                                    {entry.scope === 'sketch'
                                        ? 'Sketch dimension'
                                        : entry.scope === 'topology'
                                          ? 'Topology change'
                                          : entry.scope === 'import'
                                            ? 'CAD import'
                                            : entry.scope === 'assembly'
                                              ? 'Assembly change'
                                              : entry.scope === 'drawing'
                                                ? 'Drawing change'
                                                : 'Feature parameter'}
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

const ASSEMBLY_KIND_LABELS: Readonly<Record<AssemblyPlacementPlan['kind'], string>> = {
    add: 'Add',
    remove: 'Remove',
    place: 'Place'
};

/** Compact placement line; raw matrices show their translation, never 16 numbers. */
function formatAssemblyPlacement(placement: InstancePlacement): string {
    if ('matrix' in placement) {
        const matrix = placement.matrix;
        return `Position ${formatPoint([matrix[3], matrix[7], matrix[11]])}`;
    }
    return `Position ${formatPoint(placement.position)} \u00b7 Orientation ${formatPoint(placement.orientation)}`;
}

function AssemblyPlacementRow(props: { readonly plan: AssemblyPlacementPlan }): React.ReactElement {
    const plan = props.plan;
    const before = plan.before;
    const after = plan.after;
    const snapshot = after ?? before;
    const solidIds = snapshot?.solidIds ?? [];
    return (
        <div className={`cad-review-assembly-row is-${plan.kind}`}>
            <div className="cad-review-assembly-row-head">
                <span className={`cad-review-assembly-kind is-${plan.kind}`}>{ASSEMBLY_KIND_LABELS[plan.kind]}</span>
                <span className="cad-review-assembly-instance">{plan.instanceId}</span>
                <span className="cad-review-assembly-part">{plan.part}</span>
            </div>
            {plan.kind === 'place' && before !== undefined && after !== undefined && (
                <div className="cad-review-assembly-placement">
                    <span className="cad-review-assembly-before">{formatAssemblyPlacement(before.placement)}</span>
                    <span className="cad-review-assembly-arrow" aria-hidden="true">
                        {'\u2192'}
                    </span>
                    <span className="cad-review-assembly-after">{formatAssemblyPlacement(after.placement)}</span>
                </div>
            )}
            {plan.kind !== 'place' && snapshot !== undefined && (
                <div className="cad-review-assembly-placement">
                    <span className={plan.kind === 'remove' ? 'cad-review-assembly-before' : 'cad-review-assembly-after'}>
                        {formatAssemblyPlacement(snapshot.placement)}
                    </span>
                </div>
            )}
            {solidIds.length > 0 && <span className="cad-review-assembly-solids">{pluralize(solidIds.length, 'solid')}</span>}
        </div>
    );
}

function AssemblyBomDeltaTable(props: { readonly delta: AssemblyBomDelta }): React.ReactElement {
    const delta = props.delta;
    const hasChanges = delta.rows.some((row) => row.delta !== 0);
    return (
        <div className="cad-review-assembly-bom">
            <span className="cad-review-assembly-section-title">Bill of materials</span>
            {!hasChanges ? (
                <span className="cad-review-assembly-bom-none">No quantity change</span>
            ) : (
                <>
                    {delta.rows.map((row) => {
                        const direction = row.delta > 0 ? 'is-increase' : row.delta < 0 ? 'is-decrease' : 'is-none';
                        return (
                            <div key={row.part} className="cad-review-assembly-bom-row">
                                <span className="cad-review-assembly-part">{row.part}</span>
                                <span className="cad-review-assembly-bom-counts">
                                    {`${formatNumber(row.before)} \u2192 ${formatNumber(row.after)}`}
                                </span>
                                <NukeBadge className={`cad-review-assembly-delta ${direction}`}>
                                    {row.delta > 0 ? `+${row.delta}` : String(row.delta)}
                                </NukeBadge>
                            </div>
                        );
                    })}
                    <span className="cad-review-assembly-bom-total">
                        {`Total instances ${formatNumber(delta.beforeTotal)} \u2192 ${formatNumber(delta.afterTotal)}`}
                    </span>
                </>
            )}
        </div>
    );
}

function AssemblyCollisions(props: { readonly context: CadReviewAssemblyContext }): React.ReactElement {
    const context = props.context;
    return (
        <div className="cad-review-assembly-collisions">
            <span className="cad-review-assembly-section-title">Collision warnings</span>
            {!context.overlapCheck ? (
                <p className="cad-review-assembly-overlap is-muted">Instance overlap checks are disabled for this document.</p>
            ) : context.collisionWarnings.length > 0 ? (
                <ul className="cad-review-assembly-collision-list">
                    {context.collisionWarnings.map((warning, index) => (
                        <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                </ul>
            ) : (
                <p className="cad-review-assembly-overlap is-muted">No instance collisions detected.</p>
            )}
        </div>
    );
}

function AssemblyRemovedRegions(props: {
    readonly proposalId: string;
    readonly context: CadReviewAssemblyContext;
    readonly acknowledged: boolean;
    readonly onAcknowledge?: (proposalId: string, acknowledged: boolean) => void;
}): React.ReactElement {
    const context = props.context;
    const firstBlocker = context.blockedRegions[0];
    return (
        <div className="cad-review-assembly-regions" role="group" aria-label="Assembly region impact">
            <span className="cad-review-assembly-section-title">Region impact</span>
            {context.removedSelectorKeys.length > 0 && (
                <div className="cad-review-assembly-region-block">
                    <span className="cad-review-assembly-region-label">Removed selectors</span>
                    <ul className="cad-review-assembly-region-keys">
                        {context.removedSelectorKeys.map((key) => (
                            <li key={key} className="cad-review-region-selector">
                                {key}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {context.removedRegions.map((region) => (
                <div key={`${region.group}:${region.selector}`} className="cad-review-region-row cad-review-region-removed">
                    <span className="cad-review-region-selector">{region.selector}</span>
                    <span className="cad-review-region-group">{region.group}</span>
                    <span className="cad-review-assembly-region-material">{region.material ?? 'No material tag'}</span>
                </div>
            ))}
            {firstBlocker !== undefined ? (
                <p className="cad-review-assembly-openmc is-error" role="alert">
                    {`${firstBlocker.message} Update the OpenMC project first; apply stays blocked until reference '${firstBlocker.reference}' is removed.`}
                </p>
            ) : context.openmcStatus === 'no-saved-project' ? (
                <p className="cad-review-assembly-openmc is-warning">
                    OpenMC references were not checked because no saved OpenMC project is active.
                </p>
            ) : context.openmcStatus === 'saved-project' ? (
                <p className="cad-review-assembly-openmc is-muted">{`OpenMC: ${
                    context.openmcProjectPath !== undefined ? documentBasename(context.openmcProjectPath) : 'the saved OpenMC project'
                } \u00b7 checked against the saved project file`}</p>
            ) : (
                <p className="cad-review-assembly-openmc is-warning">
                    {context.openmcWarnings[0] ?? 'OpenMC references could not be checked for this change.'}
                </p>
            )}
            <NukeCheckbox
                className="cad-review-assembly-ack"
                checked={props.acknowledged}
                onChange={(checked) => props.onAcknowledge?.(props.proposalId, checked)}
                ariaLabel="Acknowledge assembly region impact"
            >
                <span className="cad-review-assembly-ack-label">I understand the region impact</span>
            </NukeCheckbox>
        </div>
    );
}

/** Placement rows, BOM delta, collision warnings, and optional removal acknowledgement. */
function AssemblyPlan(props: {
    readonly proposalId: string;
    readonly context: CadReviewAssemblyContext;
    readonly acknowledged: boolean;
    readonly onAcknowledge?: (proposalId: string, acknowledged: boolean) => void;
}): React.ReactElement {
    const context = props.context;
    return (
        <div className="cad-review-assembly" role="group" aria-label="Assembly plan">
            <span className="cad-review-assembly-section-title">Assembly plan</span>
            <div className="cad-review-assembly-rows">
                {context.placements.map((plan) => (
                    <AssemblyPlacementRow key={`${plan.kind}:${plan.instanceId}`} plan={plan} />
                ))}
            </div>
            <AssemblyBomDeltaTable delta={context.bomDelta} />
            <AssemblyCollisions context={context} />
            <p className="cad-review-assembly-note">
                Ghost highlighting uses positional solid matching for repeated body ids; treat per-instance highlights as approximate.
            </p>
            {context.requiresAcknowledgement && (
                <AssemblyRemovedRegions
                    proposalId={props.proposalId}
                    context={context}
                    acknowledged={props.acknowledged}
                    onAcknowledge={props.onAcknowledge}
                />
            )}
        </div>
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
                            acknowledged={props.acknowledgedProposalIds?.includes(proposal.id) === true}
                            onApply={props.onApply}
                            onDismiss={props.onDismiss}
                            onAcknowledge={props.onAcknowledge}
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
