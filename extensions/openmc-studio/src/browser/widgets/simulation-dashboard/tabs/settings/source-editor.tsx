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
    OpenMCMesh,
    OpenMCSource,
    OpenMCSourceAngle,
    OpenMCSourceEnergy,
    OpenMCSourceTime,
    OpenMCSourceType
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
import {
    defaultArrayBias,
    defaultUnivariateBias,
    reconcileUnivariateBias,
    sourceHasBias,
    spatialBiasSupport
} from '../../../../../common/variance-reduction';
import { getMeshElementCount } from '../../../../../common/mesh-utils';
import { AngleEditor, SourceIssueList, SourceSnapAction, SpatialEditor, TimeEditor, UnivariateEditor } from './source-distributions';
import {
    AngleBiasEditor,
    ArrayBiasEditor,
    BiasToggle,
    defaultIsotropicBias,
    UnivariateBiasEditor,
    UnsupportedSpatialBiasNote
} from '../../vr/source-biasing-editor';

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
    const biased = sourceHasBias(props.source as OpenMCSource);
    return (
        <div className="source-summary-card" aria-label="Source summary">
            <i className="codicon codicon-info" aria-hidden="true"></i>
            <Tooltip content={summary} position="bottom">
                <span className="source-summary-text">{summary}</span>
            </Tooltip>
            {biased && (
                <Tooltip
                    content="One or more source distributions are biased. OpenMC adjusts particle weights so the estimate stays unbiased."
                    position="bottom"
                >
                    <span className="source-bias-badge">biased</span>
                </Tooltip>
            )}
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
    compat?: OpenMCCompat;
}): React.ReactNode {
    const source = props.source;
    const issues = validateSourceDistributions(source, props.meshes ?? []);
    const issuesFor = (scope: SourceDistributionIssue['scope']): SourceDistributionIssue[] =>
        issues.filter((issue) => issue.scope === scope);
    const snapActions = props.snapActions?.[source.spatial.type];
    const spatialBias = spatialBiasSupport(source.spatial.type);
    const biasUnsupported = props.compat?.sourceBias === false;
    const biasUnsupportedNote = (
        <div className="source-bias-unsupported">
            <i className="codicon codicon-info" aria-hidden="true"></i>
            <span>
                Source bias requires OpenMC 0.16.0 or newer. The configured bias is kept in the project but omitted from this environment.
            </span>
        </div>
    );
    const angle = source.angle ?? ({ type: 'isotropic' } as OpenMCSourceAngle);
    const angleIsIsotropic = angle.type === 'isotropic';
    const energyBiasSupported = source.energy.type !== 'decay-spectrum';
    const timeBiasSupported = !!source.time && source.time.type !== 'delta';
    const currentTimeBias = source.time && source.time.type !== 'delta' && 'bias' in source.time ? source.time.bias : undefined;
    const spatial = source.spatial;
    const selectedMesh = spatial.type === 'mesh' ? props.meshes?.find((mesh) => mesh.id === spatial.meshId) : undefined;
    const meshElementCount = selectedMesh ? getMeshElementCount(selectedMesh) : undefined;

    /** Keep a compatible bias when only the distribution parameters change. */
    const updateEnergy = (energy: OpenMCIndependentSource['energy']): void => {
        if (!source.energy.bias) {
            props.onUpdate({ energy });
            return;
        }
        if (energy.type === source.energy.type) {
            props.onUpdate({ energy: { ...energy, bias: source.energy.bias } });
        } else {
            props.onUpdate({ energy: reconcileUnivariateBias({ ...energy, bias: defaultUnivariateBias(energy) }) });
        }
    };

    const toggleEnergyBias = (enabled: boolean): void => {
        props.onUpdate({
            energy: { ...source.energy, bias: enabled ? defaultUnivariateBias(source.energy) : undefined }
        });
    };

    const updateTime = (time: OpenMCSourceTime | undefined): void => {
        if (!time) {
            props.onUpdate({ time: undefined });
            return;
        }
        const previous = source.time;
        if (previous && previous.type !== 'delta' && 'bias' in previous && previous.bias && time.type !== 'delta') {
            if (time.type === previous.type) {
                props.onUpdate({ time: { ...time, bias: previous.bias } });
                return;
            }
            props.onUpdate({ time: reconcileUnivariateBias({ ...time, bias: defaultUnivariateBias(time) }) as OpenMCSourceTime });
            return;
        }
        props.onUpdate({ time });
    };

    const toggleTimeBias = (enabled: boolean): void => {
        if (!source.time || source.time.type === 'delta') {
            return;
        }
        props.onUpdate({
            time: { ...source.time, bias: enabled ? defaultUnivariateBias(source.time) : undefined }
        });
    };

    const updateAngle = (next: OpenMCSourceAngle): void => {
        if (next.type === 'isotropic' && angle.type === 'isotropic' && angle.bias) {
            props.onUpdate({ angle: { ...next, bias: angle.bias } });
        } else {
            props.onUpdate({ angle: next });
        }
    };

    const toggleAngleBias = (enabled: boolean): void => {
        if (!angleIsIsotropic) {
            return;
        }
        props.onUpdate({
            angle: enabled ? { type: 'isotropic', bias: defaultIsotropicBias() } : { type: 'isotropic' }
        });
    };

    const toggleSpatialBias = (enabled: boolean): void => {
        const spatial = source.spatial;
        if (!enabled) {
            props.onUpdate({ spatial: { ...spatial, bias: undefined } as OpenMCIndependentSource['spatial'] });
            return;
        }
        if (spatial.type === 'pointcloud') {
            props.onUpdate({
                spatial: {
                    ...spatial,
                    strengths: spatial.strengths ?? spatial.positions.map(() => 1),
                    bias: defaultArrayBias(spatial.positions.length)
                }
            });
            return;
        }
        if (spatial.type === 'mesh') {
            const expected = meshElementCount ?? spatial.strengths?.length ?? 1;
            props.onUpdate({
                spatial: {
                    ...spatial,
                    strengths: spatial.strengths ?? Array.from({ length: expected }, () => 1),
                    bias: defaultArrayBias(expected)
                }
            });
        }
    };

    const energySummary = summarizeUnivariate(source.energy, 'energy');
    const angleSummary = `${summarizeAngle(source.angle)}${angleIsIsotropic && angle.bias ? ' · biased' : ''}`;

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
                {spatialBias === 'array' && (
                    <>
                        <BiasToggle enabled={!!(source.spatial as { bias?: unknown }).bias} label="spatial" onToggle={toggleSpatialBias} />
                        {spatial.type === 'pointcloud' && spatial.bias && (
                            <ArrayBiasEditor
                                probabilities={spatial.bias.probabilities}
                                expected={spatial.positions.length}
                                label="Point-cloud"
                                onChange={(probabilities: number[]) => {
                                    if (spatial.type !== 'pointcloud') {
                                        return;
                                    }
                                    props.onUpdate({ spatial: { ...spatial, bias: { probabilities } } });
                                }}
                            />
                        )}
                        {spatial.type === 'mesh' && spatial.bias && (
                            <ArrayBiasEditor
                                probabilities={spatial.bias.probabilities}
                                expected={meshElementCount ?? spatial.strengths?.length}
                                label="Mesh spatial"
                                onChange={(probabilities: number[]) => {
                                    if (spatial.type !== 'mesh') {
                                        return;
                                    }
                                    props.onUpdate({ spatial: { ...spatial, bias: { probabilities } } });
                                }}
                            />
                        )}
                        <span className="form-hint source-bias-transport-note">
                            OpenMC serializes point-cloud/mesh bias for Python; the 0.16 XML transport reader rejects these array-bias
                            nodes.
                        </span>
                    </>
                )}
                {spatialBias === 'none' && <UnsupportedSpatialBiasNote />}
                {spatialBias === 'array' && biasUnsupported && biasUnsupportedNote}
            </SourceSection>

            <SourceSection
                title="Energy Distribution"
                icon="pulse"
                summary={`${energySummary}${source.energy.bias ? ' · biased' : ''}`}
                issues={issuesFor('energy')}
            >
                <UnivariateEditor
                    value={source.energy}
                    onChange={updateEnergy}
                    domain="energy"
                    decayUnsupportedReason={props.decayUnsupportedReason}
                />
                {energyBiasSupported ? (
                    <>
                        <BiasToggle enabled={!!source.energy.bias} label="energy" onToggle={toggleEnergyBias} />
                        <UnivariateBiasEditor value={source.energy} onChange={updateEnergy} domain="energy" label="Energy" />
                    </>
                ) : (
                    <div className="source-bias-unsupported">
                        <i className="codicon codicon-info" aria-hidden="true"></i>
                        <span>OpenMC decay spectra do not accept a bias distribution; use another energy type to bias sampling.</span>
                    </div>
                )}
                {biasUnsupported && biasUnsupportedNote}
            </SourceSection>

            <SourceSection
                title="Direction"
                icon="compass"
                summary={angleSummary}
                issues={issuesFor('angle')}
                defaultOpen={source.angle !== undefined && source.angle.type !== 'isotropic'}
            >
                <AngleEditor value={source.angle} onChange={updateAngle} />
                {angleIsIsotropic ? (
                    <>
                        <BiasToggle enabled={!!angle.bias} label="direction" onToggle={toggleAngleBias} />
                        <AngleBiasEditor angle={angle} onChange={updateAngle} />
                    </>
                ) : (
                    <span className="form-hint">
                        OpenMC only supports angle bias for isotropic sources; use an isotropic direction with a bias.
                    </span>
                )}
                {biasUnsupported && biasUnsupportedNote}
            </SourceSection>

            <SourceSection
                title="Time"
                icon="watch"
                summary={`${summarizeTime(source.time)}${currentTimeBias ? ' · biased' : ''}`}
                issues={issuesFor('time')}
                defaultOpen={source.time !== undefined}
            >
                <TimeEditor value={source.time} onChange={updateTime} />
                {timeBiasSupported ? (
                    <>
                        <BiasToggle enabled={!!currentTimeBias} label="time" onToggle={toggleTimeBias} />
                        {source.time && source.time.type !== 'delta' && (
                            <UnivariateBiasEditor
                                value={source.time as OpenMCSourceEnergy}
                                onChange={(value: OpenMCSourceEnergy) => updateTime(value as OpenMCSourceTime)}
                                domain="time"
                                label="Time"
                            />
                        )}
                    </>
                ) : (
                    source.time && <span className="form-hint">A delta birth time has no distribution to bias.</span>
                )}
                {biasUnsupported && biasUnsupportedNote}
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
