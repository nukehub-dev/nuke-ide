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
 * Inline source-distribution bias controls.
 *
 * OpenMC biases distributions, not a source-level "strength". These controls
 * therefore live inside the energy/time/direction/spatial sections of a source
 * card. Continuous univariates nest a `<bias>` distribution, Discrete/Mixture
 * carry alternative probabilities, an isotropic direction uses a
 * PolarAzimuthal bias, and point-cloud/mesh spatial distributions use per-point
 * or per-element probability arrays.
 *
 * @module openmc-studio/browser/widgets/vr
 */

import * as React from '@theia/core/shared/react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCAngleBias,
    OpenMCMuPhiAngle,
    OpenMCSourceAngle,
    OpenMCSourceEnergy,
    OpenMCSourceTime
} from '../../../../common/openmc-state-schema';
import { defaultAngleBias, defaultArrayBias, defaultUnivariateBias, stripBias } from '../../../../common/variance-reduction';
import { UnivariateEditor } from '../tabs/settings/source-distributions';

/** Continuous distribution types offered for a nested bias. */
const CONTINUOUS_BIAS_TYPES: OpenMCSourceEnergy['type'][] = ['uniform', 'maxwell', 'watt', 'normal', 'muir', 'powerlaw', 'tabular'];

/** Props shared by the inline bias controls. */
interface BiasToggleProps {
    /** Whether the distribution currently carries a bias. */
    enabled: boolean;
    /** Human label for the biased distribution (for example "energy"). */
    label: string;
    /** Toggle callback. */
    onToggle: (enabled: boolean) => void;
}

/**
 * Shared "Bias sampling" switch with the importance-sampling explanation.
 * @param props - Toggle props.
 * @returns Toggle row React node.
 */
export function BiasToggle(props: BiasToggleProps): React.ReactNode {
    return (
        <div className="source-bias-toggle">
            <label className="source-bias-toggle-label">
                <input type="checkbox" checked={props.enabled} onChange={(event) => props.onToggle(event.target.checked)} />
                <span>Bias sampling</span>
                <Tooltip
                    content="Sample the source from a different distribution and adjust each particle's weight so the reported estimate stays unbiased."
                    position="top"
                >
                    <i className="codicon codicon-info" aria-hidden="true"></i>
                </Tooltip>
            </label>
            {props.enabled && <span className="source-bias-badge">biased {props.label}</span>}
        </div>
    );
}

/**
 * Energy/time bias editor: nested continuous distribution, or an alternative
 * probability array for Discrete/Mixture.
 * @param props - Distribution and change callback.
 * @returns Bias editor React node.
 */
export function UnivariateBiasEditor(props: {
    value: OpenMCSourceEnergy;
    onChange: (value: OpenMCSourceEnergy) => void;
    domain: 'energy' | 'time';
    label: string;
}): React.ReactNode {
    const bias = props.value.bias;
    if (!bias) {
        return null;
    }
    if ('probabilities' in bias) {
        return (
            <div className="source-bias-editor">
                <label>{props.label} bias probabilities</label>
                <input
                    type="text"
                    value={bias.probabilities.join(' ')}
                    onChange={(event) => {
                        const probabilities = event.target.value
                            .trim()
                            .split(/[\s,;]+/)
                            .filter((part) => part.length > 0)
                            .map(Number)
                            .filter((value) => Number.isFinite(value));
                        props.onChange({ ...props.value, bias: { probabilities } });
                    }}
                    aria-label={`${props.label} bias probabilities`}
                />
                <span className="form-hint">
                    One non-negative probability per {props.value.type === 'mixture' ? 'mixture component' : 'sampled value'}; OpenMC
                    normalizes them.
                </span>
            </div>
        );
    }
    return (
        <div className="source-bias-editor">
            <UnivariateEditor
                value={bias.distribution}
                onChange={(distribution) => props.onChange({ ...props.value, bias: { distribution: stripBias(distribution) } })}
                domain={props.domain}
                allowedTypes={CONTINUOUS_BIAS_TYPES}
                compact
            />
            <span className="form-hint">
                The bias distribution must share the parent&apos;s support interval; a {props.domain === 'energy' ? 'Uniform' : 'time'}{' '}
                range is the usual choice.
            </span>
        </div>
    );
}

/**
 * Isotropic angle bias editor (PolarAzimuthal).
 * @param props - Isotropic angle, change callback, and toggle.
 * @returns Angle bias editor React node.
 */
export function AngleBiasEditor(props: { angle: OpenMCSourceAngle; onChange: (angle: OpenMCSourceAngle) => void }): React.ReactNode {
    if (props.angle.type !== 'isotropic' || !props.angle.bias) {
        return null;
    }
    const bias = props.angle.bias.distribution;
    return (
        <div className="source-bias-editor">
            <div className="source-bias-subhead">Biased polar-azimuthal sampling</div>
            <UnivariateEditor
                value={bias.mu}
                onChange={(mu) => props.onChange({ type: 'isotropic', bias: { distribution: { ...bias, mu } } })}
                domain="angle-mu"
                compact
            />
            <UnivariateEditor
                value={bias.phi}
                onChange={(phi) => props.onChange({ type: 'isotropic', bias: { distribution: { ...bias, phi } } })}
                domain="angle-phi"
                compact
            />
            <span className="form-hint">mu must cover [-1, 1] and phi [0, 2π]; OpenMC rejects a narrower angle bias.</span>
        </div>
    );
}

/** Default bias for a time distribution (delta cannot be biased). */
export function defaultTimeBias(time: OpenMCSourceTime): OpenMCSourceEnergy['bias'] {
    if (time.type === 'delta') {
        return undefined;
    }
    return defaultUnivariateBias(time);
}

/** Default bias for an isotropic angle. */
export function defaultIsotropicBias(): OpenMCAngleBias {
    return defaultAngleBias();
}

/**
 * Build a default `mu-phi` bias object for UI state.
 * @returns Polar-azimuthal bias distribution.
 */
export function defaultPolarBias(): OpenMCMuPhiAngle {
    return defaultAngleBias().distribution;
}

/**
 * Array bias editor for point-cloud / mesh spatial distributions.
 * @param props - Current probabilities, expected count, and change callback.
 * @returns Array bias editor React node.
 */
export function ArrayBiasEditor(props: {
    probabilities: number[];
    expected: number | undefined;
    label: string;
    onChange: (probabilities: number[]) => void;
}): React.ReactNode {
    const [text, setText] = React.useState(props.probabilities.join(' '));
    const count = props.probabilities.length;
    return (
        <div className="source-bias-editor source-array-bias">
            <div className="source-array-bias-header">
                <label>{props.label} bias probabilities</label>
                <span className="source-array-bias-summary">
                    {count} value{count === 1 ? '' : 's'}
                    {props.expected !== undefined ? ` · ${props.expected} required` : ''}
                </span>
            </div>
            <textarea
                value={text}
                rows={3}
                onChange={(event) => {
                    setText(event.target.value);
                    const probabilities = event.target.value
                        .trim()
                        .split(/[\s,;]+/)
                        .filter((part) => part.length > 0)
                        .map(Number)
                        .filter((value) => Number.isFinite(value));
                    props.onChange(probabilities);
                }}
                aria-label={`${props.label} bias probabilities`}
            />
            <div className="source-array-bias-actions">
                <button
                    type="button"
                    className="theia-button secondary small"
                    onClick={() => {
                        const next = defaultArrayBias(props.expected ?? count).probabilities;
                        setText(next.join(' '));
                        props.onChange(next);
                    }}
                >
                    <i className="codicon codicon-refresh"></i> Uniform
                </button>
            </div>
            <span className="form-hint">
                Enter one non-negative probability per point or mesh element. OpenMC normalizes the array and adjusts weights to keep the
                estimate unbiased.
            </span>
        </div>
    );
}

/** Truthful note for spatial types OpenMC cannot bias. */
export function UnsupportedSpatialBiasNote(): React.ReactNode {
    return (
        <div className="source-bias-unsupported">
            <i className="codicon codicon-info" aria-hidden="true"></i>
            <span>OpenMC does not support bias for this spatial type. Use a point-cloud or mesh spatial distribution, or bias energy.</span>
        </div>
    );
}
