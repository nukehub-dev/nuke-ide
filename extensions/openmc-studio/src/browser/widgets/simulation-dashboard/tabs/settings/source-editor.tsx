// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Collapsible source-editor shell: source-type selector, summary card, and the
 * independent-source sections (spatial, energy, direction, time, constraints,
 * advanced). Only the selected spatial/energy/angle/time type renders fields.
 */

import * as React from '@theia/core/shared/react';
import { NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCIndependentSource,
    OpenMCSource,
    OpenMCSourceType,
    OpenMCSourceTime,
    OpenMCMesh
} from '../../../../../common/openmc-state-schema';
import { OpenMCCompat } from '../../../../../common/openmc-studio-protocol';
import {
    summarizeAngle,
    summarizeSpatial,
    summarizeSource,
    summarizeTime,
    summarizeUnivariate,
    SourceDistributionIssue,
    validateSourceDistributions
} from '../../../../../common/source-utils';
import { AngleEditor, SourceIssueList, SourceSnapAction, SpatialEditor, TimeEditor, UnivariateEditor } from './source-distributions';

/** One collapsible editor section inside a source card. */
export interface SourceSectionProps {
    title: string;
    icon?: string;
    summary?: string;
    defaultOpen?: boolean;
    issues?: SourceDistributionIssue[];
    children?: React.ReactNode;
}

/**
 * Collapsible source section with a keyboard-accessible header and a compact
 * summary chip. Issue counts surface even while collapsed.
 */
export function SourceSection(props: SourceSectionProps): React.ReactNode {
    const [open, setOpen] = React.useState(props.defaultOpen ?? true);
    const issues = props.issues ?? [];
    return (
        <section className={`source-section${open ? ' expanded' : ''}`}>
            <button type="button" className="source-section-header" aria-expanded={open} onClick={() => setOpen(!open)}>
                <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true"></i>
                {props.icon && <i className={`codicon codicon-${props.icon}`} aria-hidden="true"></i>}
                <span className="source-section-title">{props.title}</span>
                {issues.length > 0 && (
                    <Tooltip content={`${issues.length} validation issue${issues.length === 1 ? '' : 's'} — expand to fix`} position="top">
                        <span className="source-section-issue-count">
                            <i className="codicon codicon-warning" aria-hidden="true"></i>
                            {issues.length}
                        </span>
                    </Tooltip>
                )}
                {props.summary && (
                    <span className="source-summary-anchor">
                        <Tooltip content={props.summary} position="top">
                            <span className="summary-chip source-summary-chip">{props.summary}</span>
                        </Tooltip>
                    </span>
                )}
            </button>
            {open && (
                <div className="source-section-body">
                    {props.children}
                    {issues.length > 0 && <SourceIssueList issues={issues} />}
                </div>
            )}
        </section>
    );
}

/** Human label for a source type. */
export function sourceTypeLabel(type: OpenMCSourceType | undefined): string {
    switch (type ?? 'independent') {
        case 'file':
            return 'File source';
        case 'compiled':
            return 'Compiled source';
        case 'mesh':
            return 'Mesh source';
        case 'tokamak':
            return 'Tokamak source';
        default:
            return 'Independent source';
    }
}

/** Source type selector: segmented control normally, select in narrow panels. */
export function SourceTypeSelector(props: {
    source: OpenMCSource;
    compat?: OpenMCCompat;
    onChange: (type: OpenMCSourceType) => void;
}): React.ReactNode {
    const current = props.source.type ?? 'independent';
    const types: { value: OpenMCSourceType; label: string }[] = [
        { value: 'independent', label: 'Independent' },
        { value: 'file', label: 'File' },
        { value: 'compiled', label: 'Compiled' },
        { value: 'mesh', label: 'Mesh' },
        { value: 'tokamak', label: 'Tokamak' }
    ];
    const tokamakUnsupported = props.compat !== undefined && !props.compat.tokamakSource;
    return (
        <div className="source-type-controls">
            <div className="source-type-segments segmented-control" role="group" aria-label="Source type">
                {types.map((type) => {
                    const disabled = type.value === 'tokamak' && tokamakUnsupported && current !== 'tokamak';
                    const button = (
                        <button
                            key={type.value}
                            type="button"
                            className={`segment${current === type.value ? ' active' : ''}`}
                            aria-pressed={current === type.value}
                            disabled={disabled}
                            onClick={() => props.onChange(type.value)}
                        >
                            {type.label}
                        </button>
                    );
                    return disabled ? (
                        <Tooltip key={type.value} content="TokamakSource requires OpenMC ≥ 0.16.0" position="top">
                            <span className="source-type-disabled-wrap">{button}</span>
                        </Tooltip>
                    ) : (
                        button
                    );
                })}
            </div>
            <div className="source-type-select-control">
                <NukeSelect
                    value={current}
                    options={types.map((type) => ({
                        value: type.value,
                        label: type.value === 'tokamak' && tokamakUnsupported ? 'Tokamak (requires OpenMC ≥ 0.16.0)' : type.label,
                        disabled: type.value === 'tokamak' && tokamakUnsupported && current !== 'tokamak'
                    }))}
                    onChange={(value: string) => props.onChange(value as OpenMCSourceType)}
                    ariaLabel="Source type"
                />
            </div>
        </div>
    );
}

/** Compact summary card above the independent-source editor. */
export function SourceSummaryCard(props: { source: OpenMCIndependentSource }): React.ReactNode {
    const summary = summarizeSource(props.source);
    return (
        <div className="source-summary-card" aria-label="Source summary">
            <i className="codicon codicon-info" aria-hidden="true"></i>
            <Tooltip content={summary} position="bottom">
                <span className="source-summary-text">{summary}</span>
            </Tooltip>
        </div>
    );
}

/** Ordered independent-source editor sections. */
export function IndependentSourceEditor(props: {
    source: OpenMCIndependentSource;
    onUpdate: (updates: Partial<OpenMCIndependentSource>) => void;
    snapActions?: Record<string, SourceSnapAction[]>;
    onSnap?: () => void;
    meshes?: OpenMCMesh[];
    constraints?: React.ReactNode;
    decayUnsupportedReason?: string;
}): React.ReactNode {
    const source = props.source;
    const issues = validateSourceDistributions(source, props.meshes ?? []);
    const issuesFor = (scope: SourceDistributionIssue['scope']): SourceDistributionIssue[] =>
        issues.filter((issue) => issue.scope === scope);
    const snapActions = props.snapActions?.[source.spatial.type];

    return (
        <div className="source-editor independent-source-editor">
            <SourceSummaryCard source={source} />

            <SourceSection
                title="Spatial Distribution"
                icon="globe"
                summary={summarizeSpatial(source.spatial)}
                issues={issuesFor('spatial')}
            >
                <SpatialEditor
                    value={source.spatial}
                    onChange={(spatial) => props.onUpdate({ spatial })}
                    snapActions={snapActions}
                    onSnap={['point', 'box', 'sphere'].includes(source.spatial.type) ? props.onSnap : undefined}
                    meshes={props.meshes}
                />
            </SourceSection>

            <SourceSection
                title="Energy Distribution"
                icon="pulse"
                summary={summarizeUnivariate(source.energy, 'energy')}
                issues={issuesFor('energy')}
            >
                <UnivariateEditor
                    value={source.energy}
                    onChange={(energy) => props.onUpdate({ energy })}
                    domain="energy"
                    decayUnsupportedReason={props.decayUnsupportedReason}
                />
            </SourceSection>

            <SourceSection
                title="Direction"
                icon="compass"
                summary={summarizeAngle(source.angle)}
                issues={issuesFor('angle')}
                defaultOpen={source.angle !== undefined && source.angle.type !== 'isotropic'}
            >
                <AngleEditor value={source.angle} onChange={(angle) => props.onUpdate({ angle })} />
            </SourceSection>

            <SourceSection
                title="Time"
                icon="watch"
                summary={summarizeTime(source.time)}
                issues={issuesFor('time')}
                defaultOpen={source.time !== undefined}
            >
                <TimeEditor value={source.time} onChange={(time: OpenMCSourceTime | undefined) => props.onUpdate({ time })} />
            </SourceSection>

            {props.constraints}

            <SourceSection title="Advanced" icon="settings-gear" summary="Strength and particle" defaultOpen={false}>
                <div className="form-row">
                    <div className="form-group">
                        <label>Strength (relative weight)</label>
                        <input
                            type="number"
                            min={0}
                            step="any"
                            value={source.strength ?? 1}
                            onChange={(event) => props.onUpdate({ strength: parseFloat(event.target.value) || 1 })}
                        />
                        <span className="form-hint">Relative probability when multiple sources are defined.</span>
                    </div>
                    <div className="form-group">
                        <label>Particle Type</label>
                        <NukeSelect
                            value={source.particle ?? 'neutron'}
                            options={[
                                { value: 'neutron', label: 'Neutron' },
                                { value: 'photon', label: 'Photon' }
                            ]}
                            onChange={(value: string) => props.onUpdate({ particle: value as 'neutron' | 'photon' })}
                            ariaLabel="Particle type"
                        />
                    </div>
                </div>
            </SourceSection>
        </div>
    );
}
