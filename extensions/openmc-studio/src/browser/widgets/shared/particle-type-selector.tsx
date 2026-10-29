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
 * Shared particle selector for sources, tally filters, particle-production
 * filters, and weight windows. Presets cover OpenMC's common particles; a
 * custom control accepts any PDG number and previews the canonical OpenMC
 * name. Unsupported particles stay visible with an inline explanation instead
 * of being silently dropped.
 *
 * @module openmc-studio/browser/widgets/shared
 */

import * as React from '@theia/core/shared/react';
import { NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import type { OpenMCCompat } from '../../../common/openmc-studio-protocol';
import {
    isParticleSupported,
    OPENMC_PARTICLE_PRESETS,
    OpenMCParticlePreset,
    OpenMCParticleScope,
    OpenMCParticleType,
    particleSupportIssue,
    particleTypeKey,
    particleTypeLabel,
    particleTypeTooltip,
    resolveParticleType
} from '../../../common/particle-types';

/** Value used by the selector for the custom-PDG branch. */
const CUSTOM_PARTICLE = '__custom__';

/** Props shared by the single and multi selectors. */
export interface ParticleSelectorCommonProps {
    /** Where the selector is used; controls OpenMC's supported set. */
    scope: OpenMCParticleScope;
    /** Probed capabilities; undefined keeps all presets selectable while the probe runs. */
    compat?: OpenMCCompat;
    /** Accessible name for the selector and its custom field. */
    ariaLabel: string;
    /** Optional visible label. */
    label?: string;
    /** Limit presets to these canonical names (weight windows: neutron/photon). */
    allowedNames?: readonly string[];
    /** Offer the custom-PDG branch. Defaults to true. */
    allowCustom?: boolean;
    /** Whether the control is disabled. */
    disabled?: boolean;
}

function presetsFor(props: ParticleSelectorCommonProps): OpenMCParticlePreset[] {
    const allowed = props.allowedNames ? new Set(props.allowedNames.map((name) => name.toLowerCase())) : undefined;
    return OPENMC_PARTICLE_PRESETS.filter((preset) => !allowed || allowed.has(preset.name.toLowerCase()));
}

function resolveValue(value: OpenMCParticleType | string | undefined): OpenMCParticleType | undefined {
    if (!value) {
        // An unset source particle means OpenMC's neutron default; keeping the
        // selector on the effective particle avoids a blank control.
        return { name: 'neutron', pdg: 2112 };
    }
    const result = resolveParticleType(value);
    return result.ok ? result.particle : { name: String((value as OpenMCParticleType).name ?? value) };
}

/** Warning shown when the configured particle is outside the probed surface. */
function ParticleSupportWarning(props: {
    particle: OpenMCParticleType;
    scope: OpenMCParticleScope;
    compat?: OpenMCCompat;
}): React.ReactNode {
    const issue = particleSupportIssue(props.particle, props.scope, props.compat);
    if (!issue) {
        return null;
    }
    return (
        <div className="particle-type-warning" role="status">
            <i className="codicon codicon-warning" aria-hidden="true"></i>
            <span>{issue}</span>
        </div>
    );
}

/**
 * Numeric PDG field with a live canonical-name preview.
 */
const CustomPdgField: React.FC<{
    value?: OpenMCParticleType;
    onChange: (particle: OpenMCParticleType) => void;
    ariaLabel: string;
    disabled?: boolean;
}> = ({ value, onChange, ariaLabel, disabled }) => {
    const [text, setText] = React.useState(value?.pdg !== undefined ? String(value.pdg) : '');
    const [error, setError] = React.useState<string | undefined>();
    const lastPdg = value?.pdg;

    React.useEffect(() => {
        if (lastPdg !== undefined) {
            setText(String(lastPdg));
            setError(undefined);
        }
    }, [lastPdg]);

    const preview = React.useMemo(() => {
        const trimmed = text.trim();
        if (!trimmed) {
            return { error: 'Enter a PDG number to resolve its OpenMC name' } as const;
        }
        const result = resolveParticleType(Number(trimmed));
        if (!result.ok) {
            return { error: result.error } as const;
        }
        return { particle: result.particle! } as const;
    }, [text]);

    const resolvedPreview = 'particle' in preview ? preview.particle : undefined;

    const update = (next: string): void => {
        setText(next);
        if (!next.trim()) {
            setError(undefined);
            return;
        }
        const result = resolveParticleType(Number(next.trim()));
        if (result.ok) {
            setError(undefined);
            onChange(result.particle!);
        } else {
            setError(result.error);
        }
    };

    return (
        <div className="particle-type-custom">
            <div className="particle-type-custom-field">
                <label className="particle-type-custom-label" htmlFor={`${ariaLabel}-custom-pdg`}>
                    Custom PDG
                </label>
                <input
                    id={`${ariaLabel}-custom-pdg`}
                    type="number"
                    step={1}
                    value={text}
                    disabled={disabled}
                    aria-label={`${ariaLabel} custom PDG`}
                    placeholder="e.g. 1000020040"
                    onChange={(event) => update(event.target.value)}
                />
            </div>
            {!resolvedPreview ? (
                <span className="particle-type-preview particle-type-preview-error">{error ?? (preview as { error?: string }).error}</span>
            ) : (
                <span className="particle-type-preview">
                    <i className="codicon codicon-arrow-right" aria-hidden="true"></i>
                    <strong>{resolvedPreview.name}</strong>
                    <span>· PDG {resolvedPreview.pdg}</span>
                </span>
            )}
        </div>
    );
};

/**
 * Single particle selector: segmented presets on wide panels, a select in
 * narrow containers, and a custom-PDG field when requested.
 */
export const ParticleTypeSelector: React.FC<
    ParticleSelectorCommonProps & {
        value?: OpenMCParticleType | string;
        onChange: (particle: OpenMCParticleType) => void;
    }
> = (props) => {
    const particle = resolveValue(props.value);
    const preset = particle
        ? OPENMC_PARTICLE_PRESETS.find((candidate) => candidate.pdg === particle.pdg || candidate.name === particle.name)
        : undefined;
    const [customMode, setCustomMode] = React.useState(!preset && !!particle);
    const presets = presetsFor(props);
    const allowCustom = props.allowCustom !== false;

    React.useEffect(() => {
        if (!particle) {
            return;
        }
        const matched = OPENMC_PARTICLE_PRESETS.find((candidate) => candidate.pdg === particle.pdg || candidate.name === particle.name);
        if (!matched) {
            setCustomMode(true);
        }
    }, [particle?.name, particle?.pdg]);

    const selectValue = customMode ? CUSTOM_PARTICLE : (preset?.name ?? CUSTOM_PARTICLE);
    const tooltip = particle ? particleTypeTooltip(particle) : 'Choose the particle OpenMC samples or bins';

    const choosePreset = (next: OpenMCParticlePreset): void => {
        setCustomMode(false);
        props.onChange({ name: next.name, pdg: next.pdg });
    };

    return (
        <div className="particle-type-selector" data-particle-scope={props.scope}>
            <div className="particle-type-label-row">
                {props.label && <label className="particle-type-label">{props.label}</label>}
                <Tooltip content={tooltip} position="bottom">
                    <i className="codicon codicon-info particle-type-info" tabIndex={0} aria-label={`${props.ariaLabel} help`}></i>
                </Tooltip>
            </div>
            <div className="particle-type-select-wrap">
                <div className="particle-type-segments" role="group" aria-label={props.ariaLabel}>
                    {presets.map((candidate) => {
                        const supported = isParticleSupported(candidate, props.scope, props.compat);
                        const button = (
                            <button
                                key={candidate.name}
                                type="button"
                                className={`segment${!customMode && preset?.name === candidate.name ? ' active' : ''}`}
                                aria-pressed={!customMode && preset?.name === candidate.name}
                                disabled={props.disabled || (!supported && preset?.name !== candidate.name)}
                                onClick={() => choosePreset(candidate)}
                            >
                                {candidate.label}
                            </button>
                        );
                        return supported ? (
                            button
                        ) : (
                            <Tooltip
                                key={candidate.name}
                                content={particleSupportIssue(candidate, props.scope, props.compat) ?? ''}
                                position="top"
                            >
                                <span className="particle-type-disabled-wrap">{button}</span>
                            </Tooltip>
                        );
                    })}
                    {allowCustom && (
                        <button
                            type="button"
                            className={`segment${customMode ? ' active' : ''}`}
                            aria-pressed={customMode}
                            disabled={props.disabled}
                            onClick={() => setCustomMode(true)}
                        >
                            Custom PDG…
                        </button>
                    )}
                </div>
                <div className="particle-type-select-control">
                    <NukeSelect
                        value={selectValue}
                        options={[
                            ...presets.map((candidate) => ({
                                value: candidate.name,
                                label: candidate.label,
                                disabled: props.disabled || !isParticleSupported(candidate, props.scope, props.compat)
                            })),
                            ...(allowCustom ? [{ value: CUSTOM_PARTICLE, label: 'Custom PDG…' }] : [])
                        ]}
                        onChange={(value: string) => {
                            if (value === CUSTOM_PARTICLE) {
                                setCustomMode(true);
                                return;
                            }
                            const next = presets.find((candidate) => candidate.name === value);
                            if (next) {
                                choosePreset(next);
                            }
                        }}
                        ariaLabel={props.ariaLabel}
                    />
                </div>
            </div>
            {customMode && allowCustom && (
                <CustomPdgField value={particle} onChange={props.onChange} ariaLabel={props.ariaLabel} disabled={props.disabled} />
            )}
            {props.scope === 'weight-window' && (
                <span className="form-hint">OpenMC weight windows only apply to neutrons and photons.</span>
            )}
            {particle && <ParticleSupportWarning particle={particle} scope={props.scope} compat={props.compat} />}
            {!particle && props.value !== undefined && (
                <div className="particle-type-warning" role="status">
                    <i className="codicon codicon-warning" aria-hidden="true"></i>
                    <span>The stored particle value is not recognized; choose a preset or enter a valid PDG number.</span>
                </div>
            )}
        </div>
    );
};

/**
 * Multi-select particle control for tally `particle` and
 * `particleproduction` filters: preset checkboxes plus a custom-PDG adder.
 */
export const ParticleTypeMultiSelector: React.FC<
    ParticleSelectorCommonProps & {
        value: OpenMCParticleType[];
        onChange: (particles: OpenMCParticleType[]) => void;
    }
> = (props) => {
    const selected = props.value;
    const presets = presetsFor(props);
    const allowCustom = props.allowCustom !== false;
    const [custom, setCustom] = React.useState<OpenMCParticleType | undefined>();
    const [customVersion, setCustomVersion] = React.useState(0);
    const selectedKeys = new Set(selected.map((particle) => particleTypeKey(particle)));
    const extras = selected.filter(
        (particle) => !presets.some((candidate) => candidate.name === particle.name || candidate.pdg === particle.pdg)
    );

    const toggle = (candidate: OpenMCParticlePreset): void => {
        const exists = selected.some(
            (particle) => particle.name === candidate.name || (candidate.pdg !== undefined && particle.pdg === candidate.pdg)
        );
        props.onChange(
            exists
                ? selected.filter(
                      (particle) => particle.name !== candidate.name && (candidate.pdg === undefined || particle.pdg !== candidate.pdg)
                  )
                : [...selected, { name: candidate.name, pdg: candidate.pdg }]
        );
    };

    const addCustom = (): void => {
        if (!custom) {
            return;
        }
        if (!selectedKeys.has(particleTypeKey(custom))) {
            props.onChange([...selected, custom]);
        }
        setCustom(undefined);
        setCustomVersion((version) => version + 1);
    };

    return (
        <div className="particle-type-multi" data-particle-scope={props.scope}>
            {props.label && <label className="particle-type-label">{props.label}</label>}
            <div className="particle-type-checks">
                {presets.map((candidate) => {
                    const supported = isParticleSupported(candidate, props.scope, props.compat);
                    const checked = selectedKeys.has(particleTypeKey({ name: candidate.name, pdg: candidate.pdg }));
                    const label = (
                        <label key={candidate.name} className={`particle-type-check${supported ? '' : ' unsupported'}`}>
                            <input
                                type="checkbox"
                                checked={checked}
                                disabled={props.disabled || (!supported && !checked)}
                                aria-label={candidate.label}
                                onChange={() => toggle(candidate)}
                            />
                            <span>{candidate.label}</span>
                        </label>
                    );
                    return supported ? (
                        label
                    ) : (
                        <Tooltip
                            key={candidate.name}
                            content={particleSupportIssue(candidate, props.scope, props.compat) ?? ''}
                            position="top"
                        >
                            <span className="particle-type-disabled-wrap">{label}</span>
                        </Tooltip>
                    );
                })}
            </div>
            {extras.length > 0 && (
                <div className="particle-type-chips">
                    {extras.map((particle) => (
                        <span className="particle-type-chip" key={particleTypeKey(particle)}>
                            <Tooltip content={particleTypeTooltip(particle)} position="top">
                                <span>{particleTypeLabel(particle)}</span>
                            </Tooltip>
                            <Tooltip content={`Remove ${particleTypeLabel(particle)}`} position="top">
                                <button
                                    type="button"
                                    className="particle-type-chip-remove"
                                    aria-label={`Remove particle ${particle.name}`}
                                    disabled={props.disabled}
                                    onClick={() =>
                                        props.onChange(selected.filter((value) => particleTypeKey(value) !== particleTypeKey(particle)))
                                    }
                                >
                                    <i className="codicon codicon-close" aria-hidden="true"></i>
                                </button>
                            </Tooltip>
                        </span>
                    ))}
                </div>
            )}
            {allowCustom && (
                <div className="particle-type-add-custom">
                    <CustomPdgField
                        key={`custom-${customVersion}`}
                        value={custom}
                        onChange={setCustom}
                        ariaLabel={props.ariaLabel}
                        disabled={props.disabled}
                    />
                    <button type="button" className="theia-button secondary small" disabled={props.disabled || !custom} onClick={addCustom}>
                        <i className="codicon codicon-add" aria-hidden="true"></i> Add particle
                    </button>
                </div>
            )}
            <div className="particle-type-warnings">
                {selected.map((particle) => (
                    <ParticleSupportWarning key={particleTypeKey(particle)} particle={particle} scope={props.scope} compat={props.compat} />
                ))}
            </div>
        </div>
    );
};
