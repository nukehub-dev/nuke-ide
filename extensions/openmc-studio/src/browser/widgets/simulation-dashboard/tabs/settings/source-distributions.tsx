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
 * Shared distribution editors used by the source editor: one univariate editor
 * for energy, time, spatial coordinates, and mu/phi, plus table, mixture,
 * point-cloud, decay-spectrum, angle, and spatial editors.
 */

import * as React from '@theia/core/shared/react';
import { NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCDecaySpectrumUnivariate,
    OpenMCMeshSpatial,
    OpenMCMixtureUnivariate,
    OpenMCPointCloudSpatial,
    OpenMCSourceAngle,
    OpenMCSourceEnergy,
    OpenMCSourceEnergyType,
    OpenMCSourceSpatial,
    OpenMCSourceTime,
    OpenMCTabularUnivariate,
    OpenMCMesh
} from '../../../../../common/openmc-state-schema';
import {
    defaultAngleOfType,
    defaultSpatialOfType,
    defaultTimeOfType,
    defaultUnivariateOfType,
    SourceDistributionIssue,
    summarizeUnivariate,
    TABULAR_INTERPOLATION_SCHEMES
} from '../../../../../common/source-utils';
import { getMeshElementCount } from '../../../../../common/mesh-utils';

/** Domain labels for the shared univariate editor. */
type DistributionDomain = 'energy' | 'time' | 'coordinate' | 'angle-mu' | 'angle-phi';

/** All distribution types the editor can render. */
const TYPE_LABELS: Record<OpenMCSourceEnergyType, string> = {
    discrete: 'Discrete',
    uniform: 'Uniform',
    maxwell: 'Maxwell',
    watt: 'Watt',
    normal: 'Normal (Gaussian)',
    muir: 'Muir (D-T fusion)',
    powerlaw: 'Power law',
    tabular: 'Tabular',
    mixture: 'Mixture',
    'decay-spectrum': 'Decay spectrum (0.16+)'
};

/** Spatial coordinate distributions (anything OpenMC serializes except decay spectra). */
const COORDINATE_TYPES: OpenMCSourceEnergyType[] = ['discrete', 'uniform', 'maxwell', 'watt', 'normal', 'powerlaw', 'tabular', 'mixture'];

/** Energy distributions in the order the editor offers them. */
const ENERGY_TYPES: OpenMCSourceEnergyType[] = [
    'discrete',
    'uniform',
    'maxwell',
    'watt',
    'normal',
    'muir',
    'powerlaw',
    'tabular',
    'mixture',
    'decay-spectrum'
];

/** Time distributions (seconds). */
const TIME_TYPES: OpenMCSourceEnergyType[] = ['uniform', 'discrete', 'tabular', 'mixture'];

/** mu/phi distributions. */
const ANGLE_TYPES: OpenMCSourceEnergyType[] = ['discrete', 'uniform', 'powerlaw', 'tabular', 'mixture'];

/** Type-specific field labels. */
function domainLabels(domain: DistributionDomain): {
    value: string;
    probability: string;
    min: string;
    max: string;
    hint: string;
} {
    if (domain === 'time') {
        return { value: 'Time (s)', probability: 'Probability', min: 'Min time (s)', max: 'Max time (s)', hint: 'Seconds' };
    }
    if (domain === 'angle-mu') {
        return { value: 'μ', probability: 'Probability density', min: 'Min μ', max: 'Max μ', hint: 'Cosine of the polar angle' };
    }
    if (domain === 'angle-phi') {
        return { value: 'φ (rad)', probability: 'Probability density', min: 'Min φ (rad)', max: 'Max φ (rad)', hint: 'Azimuthal angle' };
    }
    if (domain === 'coordinate') {
        return { value: 'Value', probability: 'Probability density', min: 'Min', max: 'Max', hint: 'Coordinate value' };
    }
    return {
        value: 'Energy (eV)',
        probability: 'Probability density',
        min: 'Min energy (eV)',
        max: 'Max energy (eV)',
        hint: 'Energy in eV'
    };
}

/** Number input with a label and optional hint. */
function NumberField(props: {
    label: React.ReactNode;
    value: number;
    onChange: (value: number) => void;
    step?: string;
    min?: number;
    hint?: React.ReactNode;
    ariaLabel?: string;
}): React.ReactNode {
    return (
        <div className="form-group">
            <label>{props.label}</label>
            <input
                type="number"
                step={props.step ?? 'any'}
                min={props.min}
                value={Number.isFinite(props.value) ? props.value : ''}
                onChange={(event) => props.onChange(event.target.value === '' ? 0 : parseFloat(event.target.value))}
                aria-label={props.ariaLabel}
            />
            {props.hint && <span className="form-hint">{props.hint}</span>}
        </div>
    );
}

/** Three-component vector editor. */
function VectorField(props: {
    label: string;
    value: [number, number, number] | undefined;
    fallback: [number, number, number];
    onChange: (value: [number, number, number]) => void;
    hint?: React.ReactNode;
    tooltip?: string;
}): React.ReactNode {
    const current = props.value ?? props.fallback;
    const update = (index: number, value: number): void => {
        const next: [number, number, number] = [...current];
        next[index] = value;
        props.onChange(next);
    };
    return (
        <div className="source-vector-field">
            <div className="source-vector-label">
                <span>{props.label}</span>
                {props.tooltip && (
                    <Tooltip content={props.tooltip} position="top">
                        <i className="codicon codicon-info" aria-hidden="true"></i>
                    </Tooltip>
                )}
            </div>
            <div className="form-row">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                    <NumberField
                        key={axis}
                        label={axis}
                        value={current[index]}
                        onChange={(value) => update(index, value)}
                        ariaLabel={`${props.label} ${axis}`}
                    />
                ))}
            </div>
            {props.hint && <span className="form-hint source-vector-hint">{props.hint}</span>}
        </div>
    );
}

/** Parse pasted rows into numeric columns. */
function parsePastedRows(text: string): number[][] | undefined {
    const rows = text
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) =>
            line
                .split(/[\s,;]+/)
                .filter((part) => part.length > 0)
                .map(Number)
        );
    if (rows.length === 0 || rows.some((row) => row.some((value) => !Number.isFinite(value)))) {
        return undefined;
    }
    return rows;
}

/** Inline paste box used by table editors. */
function PasteBox(props: { hint: string; onApply: (text: string) => string | undefined }): React.ReactNode {
    const [text, setText] = React.useState('');
    const [error, setError] = React.useState<string | undefined>();
    return (
        <div className="source-paste-box">
            <textarea
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                    setError(undefined);
                }}
                placeholder={props.hint}
                aria-label="Paste distribution rows"
                rows={3}
            />
            {error && (
                <span className="source-issue-fix" role="alert">
                    {error}
                </span>
            )}
            <div className="source-paste-actions">
                <button
                    className="theia-button secondary small"
                    onClick={() => {
                        const errorText = props.onApply(text);
                        if (errorText) {
                            setError(errorText);
                        } else {
                            setText('');
                        }
                    }}
                >
                    <i className="codicon codicon-check"></i> Apply
                </button>
                <button className="theia-button secondary small" onClick={() => setText('')}>
                    Clear
                </button>
            </div>
        </div>
    );
}

/** Paged value/probability table shared by discrete and tabular editors. */
function ValueProbabilityTable(props: {
    values: number[];
    probabilities?: number[];
    onValues: (values: number[]) => void;
    onProbabilities: (probabilities: number[] | undefined) => void;
    valueLabel: string;
    probabilityLabel: string;
    requireProbabilities: boolean;
    hint?: string;
}): React.ReactNode {
    const [pasteOpen, setPasteOpen] = React.useState(false);
    const pageSize = 100;
    const [page, setPage] = React.useState(0);
    const rowCount = Math.max(props.values.length, props.probabilities?.length ?? 0);
    const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
    const start = Math.min(page, pageCount - 1) * pageSize;
    const end = Math.min(start + pageSize, rowCount);
    const probabilities = props.probabilities;

    const updateValue = (index: number, value: number): void => {
        const next = [...props.values];
        next[index] = value;
        props.onValues(next);
    };
    const updateProbability = (index: number, value: number): void => {
        const next =
            probabilities && probabilities.length === props.values.length
                ? [...probabilities]
                : props.values.map(() => 1 / Math.max(1, props.values.length));
        next[index] = value;
        props.onProbabilities(next);
    };
    const addRow = (): void => {
        props.onValues([...props.values, 0]);
        if (props.probabilities) {
            props.onProbabilities([...props.probabilities, 0]);
        }
    };
    const removeRow = (index: number): void => {
        props.onValues(props.values.filter((_, i) => i !== index));
        if (props.probabilities) {
            props.onProbabilities(props.probabilities.filter((_, i) => i !== index));
        }
    };

    return (
        <div className="source-table-block">
            <div className="source-table-toolbar">
                <span className="source-table-count">
                    {rowCount} row{rowCount === 1 ? '' : 's'}
                </span>
                <button className="theia-button secondary small" onClick={addRow}>
                    <i className="codicon codicon-add"></i> Add row
                </button>
                <button className="theia-button secondary small" onClick={() => setPasteOpen(!pasteOpen)}>
                    <i className="codicon codicon-clippy"></i> Paste
                </button>
            </div>
            {pasteOpen && (
                <PasteBox
                    hint={
                        props.requireProbabilities
                            ? 'One row per line: value probability'
                            : 'One value per line, optionally followed by a probability'
                    }
                    onApply={(text) => {
                        const rows = parsePastedRows(text);
                        if (!rows) {
                            return 'Paste numbers only — one row per line, separated by spaces, commas, or semicolons.';
                        }
                        const hasSecondColumn = rows.some((row) => row.length >= 2);
                        if (props.requireProbabilities && rows.some((row) => row.length < 2)) {
                            return `Every row needs a ${props.valueLabel.toLowerCase()} and a probability.`;
                        }
                        if (rows.some((row) => row.length > 2)) {
                            return 'Each row accepts at most two columns: value and probability.';
                        }
                        props.onValues(rows.map((row) => row[0]));
                        props.onProbabilities(hasSecondColumn ? rows.map((row) => row[1] ?? 0) : undefined);
                        return undefined;
                    }}
                />
            )}
            <div className="source-table-scroll">
                <table className="source-table">
                    <thead>
                        <tr>
                            <th>{props.valueLabel}</th>
                            <th>
                                {props.probabilityLabel}
                                {!props.requireProbabilities && <span className="source-table-optional"> (optional)</span>}
                            </th>
                            <th aria-label="Actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
                            const index = start + offset;
                            return (
                                <tr key={index}>
                                    <td>
                                        <input
                                            type="number"
                                            step="any"
                                            value={Number.isFinite(props.values[index]) ? props.values[index] : ''}
                                            onChange={(event) =>
                                                updateValue(index, event.target.value === '' ? 0 : parseFloat(event.target.value))
                                            }
                                            aria-label={`${props.valueLabel} row ${index + 1}`}
                                        />
                                    </td>
                                    <td>
                                        <input
                                            type="number"
                                            step="any"
                                            min={0}
                                            value={
                                                probabilities?.[index] !== undefined && Number.isFinite(probabilities[index])
                                                    ? probabilities[index]
                                                    : ''
                                            }
                                            placeholder={props.requireProbabilities ? '' : 'equal'}
                                            onChange={(event) =>
                                                updateProbability(index, event.target.value === '' ? 0 : parseFloat(event.target.value))
                                            }
                                            aria-label={`${props.probabilityLabel} row ${index + 1}`}
                                        />
                                    </td>
                                    <td>
                                        <Tooltip content="Remove row" position="top">
                                            <button className="theia-button secondary small" onClick={() => removeRow(index)}>
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {pageCount > 1 && (
                <div className="source-table-pager">
                    <button className="theia-button secondary small" disabled={page <= 0} onClick={() => setPage(Math.max(0, page - 1))}>
                        Previous
                    </button>
                    <span>
                        Rows {start + 1}–{end} of {rowCount}
                    </span>
                    <button
                        className="theia-button secondary small"
                        disabled={page >= pageCount - 1}
                        onClick={() => setPage(Math.min(pageCount - 1, page + 1))}
                    >
                        Next
                    </button>
                </div>
            )}
            {props.hint && <span className="form-hint">{props.hint}</span>}
        </div>
    );
}

/** Tabular distribution editor (x/probability table + interpolation). */
function TabularEditor(props: {
    value: OpenMCTabularUnivariate;
    onChange: (value: OpenMCSourceEnergy) => void;
    domain: DistributionDomain;
}): React.ReactNode {
    const labels = domainLabels(props.domain);
    return (
        <>
            <ValueProbabilityTable
                values={props.value.energies}
                probabilities={props.value.probabilities}
                onValues={(energies) => props.onChange({ ...props.value, energies })}
                onProbabilities={(probabilities) => props.onChange({ ...props.value, probabilities: probabilities ?? [] })}
                valueLabel={props.domain === 'time' ? 'Time (s)' : props.domain === 'energy' ? 'Energy (eV)' : 'x'}
                probabilityLabel={labels.probability}
                requireProbabilities
                hint="Rows must be sorted with strictly increasing values and non-negative densities."
            />
            <div className="form-group">
                <label>Interpolation</label>
                <NukeSelect
                    value={props.value.interpolation ?? 'linear-linear'}
                    options={TABULAR_INTERPOLATION_SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
                    onChange={(value: string) =>
                        props.onChange({ ...props.value, interpolation: value as OpenMCTabularUnivariate['interpolation'] })
                    }
                    ariaLabel="Tabular interpolation"
                />
            </div>
        </>
    );
}

/** Mixture distribution editor with inline component distributions. */
function MixtureEditor(props: {
    value: OpenMCMixtureUnivariate;
    onChange: (value: OpenMCSourceEnergy) => void;
    domain: DistributionDomain;
    allowedTypes: OpenMCSourceEnergyType[];
    depth: number;
}): React.ReactNode {
    const sum = props.value.probability.reduce((total, p) => total + (Number.isFinite(p) ? p : 0), 0);
    const updateComponent = (index: number, distribution: OpenMCSourceEnergy): void => {
        const distributions = [...props.value.distributions];
        distributions[index] = distribution;
        props.onChange({ ...props.value, distributions });
    };
    return (
        <div className="source-mixture-editor">
            <div className={`source-probability-sum${Math.abs(sum - 1) > 1e-6 ? ' invalid' : ''}`}>
                <i className={`codicon codicon-${Math.abs(sum - 1) > 1e-6 ? 'warning' : 'check'}`}></i>
                <span>
                    Probability sum: {sum.toFixed(6)}
                    {Math.abs(sum - 1) > 1e-6 && ' — adjust the component probabilities to sum to 1'}
                </span>
            </div>
            {props.value.distributions.map((distribution, index) => (
                <div className="source-mixture-row" key={index}>
                    <div className="source-mixture-header">
                        <NumberField
                            label={`Component ${index + 1} probability`}
                            value={props.value.probability[index] ?? 0}
                            min={0}
                            onChange={(probability) => {
                                const probabilities = [...props.value.probability];
                                probabilities[index] = probability;
                                props.onChange({ ...props.value, probability: probabilities });
                            }}
                        />
                        <div className="source-mixture-summary">{summarizeUnivariate(distribution, props.domain)}</div>
                        <Tooltip content="Remove component" position="top">
                            <button
                                className="theia-button secondary small"
                                onClick={() =>
                                    props.onChange({
                                        ...props.value,
                                        probability: props.value.probability.filter((_, i) => i !== index),
                                        distributions: props.value.distributions.filter((_, i) => i !== index)
                                    })
                                }
                            >
                                <i className="codicon codicon-trash"></i>
                            </button>
                        </Tooltip>
                    </div>
                    <UnivariateEditor
                        value={distribution}
                        onChange={(next) => updateComponent(index, next)}
                        domain={props.domain}
                        allowedTypes={props.allowedTypes}
                        compact
                        depth={props.depth + 1}
                    />
                </div>
            ))}
            <button
                className="theia-button secondary small"
                onClick={() => {
                    const childType = props.allowedTypes[0] ?? 'discrete';
                    props.onChange({
                        ...props.value,
                        probability: [...props.value.probability, 0],
                        distributions: [...props.value.distributions, defaultUnivariateOfType(childType, props.domain)]
                    });
                }}
            >
                <i className="codicon codicon-add"></i> Add component
            </button>
        </div>
    );
}

/** Decay-spectrum editor (nuclide/density table + volume). */
function DecaySpectrumEditor(props: {
    value: OpenMCDecaySpectrumUnivariate;
    onChange: (value: OpenMCSourceEnergy) => void;
}): React.ReactNode {
    return (
        <div className="source-decay-editor">
            <div className="source-table-scroll">
                <table className="source-table">
                    <thead>
                        <tr>
                            <th>Nuclide</th>
                            <th>
                                Atom density (atom/b-cm)
                                <Tooltip
                                    content="Positive atom density in atom/b-cm; the chain must contain a decay photon spectrum for the nuclide."
                                    position="top"
                                >
                                    <i className="codicon codicon-info" aria-hidden="true"></i>
                                </Tooltip>
                            </th>
                            <th aria-label="Actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {props.value.nuclides.map((nuclide, index) => (
                            <tr key={index}>
                                <td>
                                    <input
                                        type="text"
                                        value={nuclide.name}
                                        placeholder="Cs137"
                                        onChange={(event) => {
                                            const nuclides = props.value.nuclides.map((entry, i) =>
                                                i === index ? { ...entry, name: event.target.value } : entry
                                            );
                                            props.onChange({ ...props.value, nuclides });
                                        }}
                                        aria-label={`Nuclide ${index + 1}`}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="number"
                                        step="any"
                                        min={0}
                                        value={Number.isFinite(nuclide.density) ? nuclide.density : ''}
                                        onChange={(event) => {
                                            const nuclides = props.value.nuclides.map((entry, i) =>
                                                i === index
                                                    ? { ...entry, density: event.target.value === '' ? 0 : parseFloat(event.target.value) }
                                                    : entry
                                            );
                                            props.onChange({ ...props.value, nuclides });
                                        }}
                                        aria-label={`Nuclide density ${index + 1}`}
                                    />
                                </td>
                                <td>
                                    <Tooltip content="Remove nuclide" position="top">
                                        <button
                                            className="theia-button secondary small"
                                            onClick={() =>
                                                props.onChange({
                                                    ...props.value,
                                                    nuclides: props.value.nuclides.filter((_, i) => i !== index)
                                                })
                                            }
                                        >
                                            <i className="codicon codicon-trash"></i>
                                        </button>
                                    </Tooltip>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <button
                        className="theia-button secondary small"
                        onClick={() => props.onChange({ ...props.value, nuclides: [...props.value.nuclides, { name: '', density: 0 }] })}
                    >
                        <i className="codicon codicon-add"></i> Add nuclide
                    </button>
                </div>
                <NumberField
                    label="Source volume (cm³)"
                    value={props.value.volume}
                    min={0}
                    onChange={(volume) => props.onChange({ ...props.value, volume })}
                    hint="Used with atom densities to compute the photon emission rate"
                />
            </div>
            <span className="form-hint">
                Decay spectra require OpenMC 0.16+ and a depletion chain at runtime. R2S/D1S workflows use this energy type for shutdown
                photon sources.
            </span>
        </div>
    );
}

/**
 * The one shared univariate editor. Renders only the selected type's fields.
 */
export function UnivariateEditor(props: {
    value: OpenMCSourceEnergy;
    onChange: (value: OpenMCSourceEnergy) => void;
    domain: DistributionDomain;
    allowedTypes?: OpenMCSourceEnergyType[];
    compact?: boolean;
    depth?: number;
    decayUnsupportedReason?: string;
}): React.ReactNode {
    const depth = props.depth ?? 0;
    const allowed = (props.allowedTypes ?? (props.domain === 'energy' ? ENERGY_TYPES : COORDINATE_TYPES)).filter(
        (type) => props.domain === 'energy' || type !== 'decay-spectrum'
    );
    const options = allowed.map((type) => ({
        value: type,
        label:
            type === 'decay-spectrum' && props.decayUnsupportedReason
                ? `${TYPE_LABELS[type]} — ${props.decayUnsupportedReason}`
                : TYPE_LABELS[type],
        disabled: type === 'decay-spectrum' && !!props.decayUnsupportedReason
    }));
    if (!allowed.includes(props.value.type)) {
        options.push({ value: props.value.type, label: `${TYPE_LABELS[props.value.type] ?? props.value.type} (current)`, disabled: false });
    }
    const labels = domainLabels(props.domain);
    const value = props.value;
    return (
        <div className={`source-univariate${props.compact ? ' compact' : ''}`} data-distribution-type={value.type}>
            <div className="form-group">
                <label>
                    {props.domain === 'energy' ? 'Energy Distribution' : props.domain === 'time' ? 'Time Distribution' : 'Distribution'}
                </label>
                <NukeSelect
                    value={value.type}
                    options={options}
                    onChange={(type: string) => props.onChange(defaultUnivariateOfType(type as OpenMCSourceEnergyType, props.domain))}
                    ariaLabel={`${props.domain} distribution type`}
                />
                {value.type === 'decay-spectrum' && props.decayUnsupportedReason && (
                    <span className="form-hint source-warning">
                        {props.decayUnsupportedReason} — the source will be omitted from settings.xml until a compatible environment is
                        selected.
                    </span>
                )}
            </div>

            {value.type === 'discrete' && (
                <ValueProbabilityTable
                    values={value.energies}
                    probabilities={value.probabilities}
                    onValues={(energies) => props.onChange({ ...value, energies })}
                    onProbabilities={(probabilities) => props.onChange({ ...value, probabilities })}
                    valueLabel={labels.value}
                    probabilityLabel={labels.probability}
                    requireProbabilities={false}
                    hint="Leave probabilities empty to sample every value equally."
                />
            )}

            {value.type === 'uniform' && (
                <div className="form-row">
                    <NumberField label={labels.min} value={value.min} onChange={(min) => props.onChange({ ...value, min })} />
                    <NumberField label={labels.max} value={value.max} onChange={(max) => props.onChange({ ...value, max })} />
                </div>
            )}

            {value.type === 'maxwell' && (
                <div className="form-row">
                    <NumberField
                        label="Maxwell θ (eV)"
                        value={value.temperature}
                        min={0}
                        onChange={(temperature) => props.onChange({ ...value, temperature })}
                        hint="Effective temperature theta in eV"
                    />
                </div>
            )}

            {value.type === 'watt' && (
                <div className="form-row">
                    <NumberField label="Watt a (eV)" value={value.a} min={0} onChange={(a) => props.onChange({ ...value, a })} />
                    <NumberField label="Watt b (1/eV)" value={value.b} min={0} onChange={(b) => props.onChange({ ...value, b })} />
                </div>
            )}

            {value.type === 'normal' && (
                <div className="form-row">
                    <NumberField label="Mean (eV)" value={value.mean} onChange={(mean) => props.onChange({ ...value, mean })} />
                    <NumberField
                        label="Std dev (eV)"
                        value={value.stdDev}
                        min={0}
                        onChange={(stdDev) => props.onChange({ ...value, stdDev })}
                    />
                </div>
            )}

            {value.type === 'muir' && (
                <div className="form-row">
                    <NumberField label="Mean energy e0 (eV)" value={value.e0} min={0} onChange={(e0) => props.onChange({ ...value, e0 })} />
                    <NumberField label="Mass ratio" value={value.m_rat} min={0} onChange={(m_rat) => props.onChange({ ...value, m_rat })} />
                    <NumberField label="Ion temp kt (eV)" value={value.kt} min={0} onChange={(kt) => props.onChange({ ...value, kt })} />
                </div>
            )}

            {value.type === 'powerlaw' && (
                <>
                    <div className="form-row">
                        <NumberField label="Lower bound a" value={value.a} min={0} onChange={(a) => props.onChange({ ...value, a })} />
                        <NumberField label="Upper bound b" value={value.b} min={0} onChange={(b) => props.onChange({ ...value, b })} />
                        <NumberField label="Exponent n" value={value.n} onChange={(n) => props.onChange({ ...value, n })} />
                    </div>
                    <span className="form-hint">Density p(x) ∝ xⁿ on [a, b]; n = 0 is uniform, n = −1 is 1/x.</span>
                </>
            )}

            {value.type === 'tabular' && <TabularEditor value={value} onChange={props.onChange} domain={props.domain} />}

            {value.type === 'mixture' && (
                <MixtureEditor
                    value={value}
                    onChange={props.onChange}
                    domain={props.domain}
                    allowedTypes={allowed.filter((type) => depth < 3 || type !== 'mixture')}
                    depth={depth}
                />
            )}

            {value.type === 'decay-spectrum' && <DecaySpectrumEditor value={value} onChange={props.onChange} />}
        </div>
    );
}

/** Angle editor: isotropic, monodirectional, or mu-phi. */
export function AngleEditor(props: {
    value: OpenMCSourceAngle | undefined;
    onChange: (value: OpenMCSourceAngle) => void;
}): React.ReactNode {
    const value = props.value ?? { type: 'isotropic' as const };
    const allowed = ANGLE_TYPES;
    return (
        <div className="source-angle-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Direction</label>
                    <NukeSelect
                        value={value.type}
                        options={[
                            { value: 'isotropic', label: 'Isotropic' },
                            { value: 'monodirectional', label: 'Monodirectional' },
                            { value: 'mu-phi', label: 'Polar-azimuthal (mu-phi)' }
                        ]}
                        onChange={(type: string) => props.onChange(defaultAngleOfType(type as OpenMCSourceAngle['type']))}
                        ariaLabel="Source direction type"
                    />
                </div>
            </div>
            {value.type === 'monodirectional' && (
                <VectorField
                    label="Reference direction"
                    value={value.referenceUvW}
                    fallback={[0, 0, 1]}
                    onChange={(referenceUvW) => props.onChange({ ...value, referenceUvW })}
                    tooltip="Direction of every emitted particle. OpenMC normalizes the vector, so only its direction matters."
                    hint="Must be a non-zero vector."
                />
            )}
            {value.type === 'mu-phi' && (
                <>
                    <VectorField
                        label="Polar reference (uvw)"
                        value={value.referenceUvW}
                        fallback={[0, 0, 1]}
                        onChange={(referenceUvW) => props.onChange({ ...value, referenceUvW })}
                        tooltip="Direction from which the polar angle (mu) is measured. OpenMC normalizes it."
                        hint="Must be non-zero and not parallel to the azimuthal reference."
                    />
                    <VectorField
                        label="Azimuthal reference (vwu)"
                        value={value.referenceVwu}
                        fallback={[1, 0, 0]}
                        onChange={(referenceVwu) => props.onChange({ ...value, referenceVwu })}
                        tooltip="Direction from which the azimuthal angle (phi) is measured. OpenMC normalizes it."
                        hint="Must be non-zero and not parallel to the polar reference."
                    />
                    <div className="source-subdistribution">
                        <h4>Mu (cosine of polar angle)</h4>
                        <UnivariateEditor
                            value={value.mu}
                            onChange={(mu) => props.onChange({ ...value, mu })}
                            domain="angle-mu"
                            allowedTypes={allowed}
                        />
                    </div>
                    <div className="source-subdistribution">
                        <h4>Phi (azimuthal angle, radians)</h4>
                        <UnivariateEditor
                            value={value.phi}
                            onChange={(phi) => props.onChange({ ...value, phi })}
                            domain="angle-phi"
                            allowedTypes={allowed}
                        />
                    </div>
                </>
            )}
            {value.type === 'isotropic' && <span className="form-hint">Particles are emitted uniformly over the unit sphere.</span>}
        </div>
    );
}

/** Time editor (seconds) wrapping the shared univariate editor. */
export function TimeEditor(props: {
    value: OpenMCSourceTime | undefined;
    onChange: (value: OpenMCSourceTime | undefined) => void;
}): React.ReactNode {
    const mode = props.value?.type ?? 'none';
    return (
        <div className="source-time-editor">
            <div className="form-group">
                <label>Time Mode</label>
                <NukeSelect
                    value={mode}
                    options={[
                        { value: 'none', label: 'Born at t = 0 (default)' },
                        { value: 'delta', label: 'Delta (single time)' },
                        { value: 'uniform', label: 'Uniform range' },
                        { value: 'discrete', label: 'Discrete times' },
                        { value: 'tabular', label: 'Tabular' },
                        { value: 'mixture', label: 'Mixture' }
                    ]}
                    onChange={(value: string) => {
                        if (value === 'none') {
                            props.onChange(undefined);
                        } else if (value === 'delta') {
                            props.onChange(defaultTimeOfType('delta'));
                        } else {
                            props.onChange(defaultTimeOfType(value as OpenMCSourceTime['type']));
                        }
                    }}
                    ariaLabel="Source time mode"
                />
            </div>
            {props.value?.type === 'delta' && (
                <div className="form-row">
                    <NumberField
                        label="Particle time (s)"
                        value={props.value.time}
                        min={0}
                        onChange={(time) => props.onChange({ type: 'delta', time })}
                        hint="OpenMC tracks particle time in seconds from birth."
                    />
                </div>
            )}
            {props.value && props.value.type !== 'delta' && (
                <UnivariateEditor
                    value={props.value}
                    onChange={(value) => props.onChange(value as OpenMCSourceTime)}
                    domain="time"
                    allowedTypes={TIME_TYPES}
                />
            )}
            <span className="form-hint">All time values are seconds; OpenMC time starts at particle birth.</span>
        </div>
    );
}

/** Point-cloud editor with optional per-point strengths. */
function PointCloudEditor(props: { value: OpenMCPointCloudSpatial; onChange: (value: OpenMCPointCloudSpatial) => void }): React.ReactNode {
    const [pasteOpen, setPasteOpen] = React.useState(false);
    const pageSize = 50;
    const [page, setPage] = React.useState(0);
    const positions = props.value.positions;
    const strengths = props.value.strengths;
    const pageCount = Math.max(1, Math.ceil(positions.length / pageSize));
    const start = Math.min(page, pageCount - 1) * pageSize;
    const end = Math.min(start + pageSize, positions.length);

    const updatePosition = (index: number, axis: number, value: number): void => {
        const next = positions.map((position, i) => (i === index ? ([...position] as [number, number, number]) : position));
        next[index][axis] = value;
        props.onChange({ ...props.value, positions: next });
    };
    const addRow = (): void => {
        props.onChange({
            ...props.value,
            positions: [...positions, [0, 0, 0]],
            strengths: strengths ? [...strengths, 1] : undefined
        });
    };
    const removeRow = (index: number): void => {
        props.onChange({
            ...props.value,
            positions: positions.filter((_, i) => i !== index),
            strengths: strengths ? strengths.filter((_, i) => i !== index) : undefined
        });
    };

    return (
        <div className="source-pointcloud-editor">
            <div className="source-table-toolbar">
                <span className="source-table-count">
                    {positions.length} point{positions.length === 1 ? '' : 's'}
                </span>
                <button className="theia-button secondary small" onClick={addRow}>
                    <i className="codicon codicon-add"></i> Add point
                </button>
                <button className="theia-button secondary small" onClick={() => setPasteOpen(!pasteOpen)}>
                    <i className="codicon codicon-clippy"></i> Paste CSV
                </button>
                <button
                    className="theia-button secondary small"
                    onClick={() =>
                        props.onChange({
                            ...props.value,
                            strengths: strengths ? undefined : positions.map(() => 1)
                        })
                    }
                >
                    <i className="codicon codicon-symbol-number"></i> {strengths ? 'Clear strengths' : 'Add strengths'}
                </button>
            </div>
            {pasteOpen && (
                <PasteBox
                    hint="One point per line: x y z [strength]"
                    onApply={(text) => {
                        const rows = parsePastedRows(text);
                        if (!rows) {
                            return 'Paste numbers only — one point per line, separated by spaces, commas, or semicolons.';
                        }
                        if (rows.some((row) => row.length < 3 || row.length > 4)) {
                            return 'Each row needs x, y, z and an optional strength (3 or 4 columns).';
                        }
                        props.onChange({
                            ...props.value,
                            positions: rows.map((row) => [row[0], row[1], row[2]] as [number, number, number]),
                            strengths: rows.some((row) => row.length === 4) ? rows.map((row) => row[3] ?? 1) : undefined
                        });
                        return undefined;
                    }}
                />
            )}
            <div className="source-table-scroll">
                <table className="source-table source-pointcloud-table">
                    <thead>
                        <tr>
                            <th>X</th>
                            <th>Y</th>
                            <th>Z</th>
                            <th>
                                Strength
                                {!strengths && <span className="source-table-optional"> (optional)</span>}
                            </th>
                            <th aria-label="Actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
                            const index = start + offset;
                            const position = positions[index];
                            return (
                                <tr key={index}>
                                    {[0, 1, 2].map((axis) => (
                                        <td key={axis}>
                                            <input
                                                type="number"
                                                step="any"
                                                value={Number.isFinite(position[axis]) ? position[axis] : ''}
                                                onChange={(event) =>
                                                    updatePosition(
                                                        index,
                                                        axis,
                                                        event.target.value === '' ? 0 : parseFloat(event.target.value)
                                                    )
                                                }
                                                aria-label={`Point ${index + 1} ${['x', 'y', 'z'][axis]}`}
                                            />
                                        </td>
                                    ))}
                                    <td>
                                        <input
                                            type="number"
                                            step="any"
                                            min={0}
                                            disabled={!strengths}
                                            value={
                                                strengths?.[index] !== undefined && Number.isFinite(strengths[index])
                                                    ? strengths[index]
                                                    : ''
                                            }
                                            placeholder={strengths ? '' : 'equal'}
                                            onChange={(event) => {
                                                if (!strengths) {
                                                    return;
                                                }
                                                const next = [...strengths];
                                                next[index] = event.target.value === '' ? 0 : parseFloat(event.target.value);
                                                props.onChange({ ...props.value, strengths: next });
                                            }}
                                            aria-label={`Point ${index + 1} strength`}
                                        />
                                    </td>
                                    <td>
                                        <Tooltip content="Remove point" position="top">
                                            <button className="theia-button secondary small" onClick={() => removeRow(index)}>
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {pageCount > 1 && (
                <div className="source-table-pager">
                    <button className="theia-button secondary small" disabled={page <= 0} onClick={() => setPage(page - 1)}>
                        Previous
                    </button>
                    <span>
                        Points {start + 1}–{end} of {positions.length}
                    </span>
                    <button className="theia-button secondary small" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
                        Next
                    </button>
                </div>
            )}
            <span className="form-hint">Positions are in the model's length units. Large clouds are paged; paste replaces the table.</span>
        </div>
    );
}

/** Mesh spatial distribution editor. */
function MeshSpatialEditor(props: {
    value: OpenMCMeshSpatial;
    onChange: (value: OpenMCMeshSpatial) => void;
    meshes: OpenMCMesh[];
}): React.ReactNode {
    const selected = props.meshes.find((mesh) => mesh.id === props.value.meshId);
    const elementCount = selected ? getMeshElementCount(selected) : undefined;
    return (
        <div className="source-mesh-spatial-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Mesh</label>
                    <NukeSelect
                        value={String(props.value.meshId ?? '')}
                        options={[
                            { value: '', label: 'Select mesh…' },
                            ...props.meshes.map((mesh) => ({
                                value: String(mesh.id),
                                label: `${mesh.name || `Mesh ${mesh.id}`} (${mesh.type})`
                            }))
                        ]}
                        onChange={(value: string) => props.onChange({ ...props.value, meshId: value ? parseInt(value) : undefined })}
                        ariaLabel="Mesh spatial distribution mesh"
                    />
                    <span className="form-hint">
                        {props.meshes.length === 0
                            ? 'No meshes defined — create one in the Tally Configurator first.'
                            : elementCount !== undefined
                              ? `${elementCount} element${elementCount === 1 ? '' : 's'}`
                              : 'Mesh grid is incomplete'}
                    </span>
                </div>
                <div className="form-group">
                    <label>Element strengths</label>
                    <input
                        type="text"
                        value={(props.value.strengths ?? []).join(' ')}
                        placeholder="Equal (optional)"
                        onChange={(event) => {
                            const strengths = event.target.value
                                .trim()
                                .split(/[\s,;]+/)
                                .filter((part) => part.length > 0)
                                .map(Number)
                                .filter((value) => Number.isFinite(value));
                            props.onChange({ ...props.value, strengths: strengths.length > 0 ? strengths : undefined });
                        }}
                        aria-label="Mesh element strengths"
                    />
                    <span className="form-hint">One strength per element, or leave empty to sample elements uniformly.</span>
                </div>
            </div>
            <div className="form-row">
                <label className="source-inline-checkbox">
                    <input
                        type="checkbox"
                        checked={props.value.volumeNormalized ?? true}
                        onChange={(event) => props.onChange({ ...props.value, volumeNormalized: event.target.checked })}
                    />
                    Multiply strengths by element volume
                </label>
            </div>
            <span className="form-hint">
                Mesh spatial sampling picks an element by relative strength and a uniform position inside it. For per-element
                energy/direction distributions, use a Mesh source instead.
            </span>
        </div>
    );
}

/** Snap action shown above the convenience spatial editors. */
export interface SourceSnapAction {
    label: string;
    icon: string;
    action: () => void;
}

/** Spatial distribution editor. */
export function SpatialEditor(props: {
    value: OpenMCSourceSpatial;
    onChange: (value: OpenMCSourceSpatial) => void;
    snapActions?: SourceSnapAction[];
    onSnap?: () => void;
    meshes?: OpenMCMesh[];
}): React.ReactNode {
    const value = props.value;
    return (
        <div className="source-spatial-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Spatial Distribution</label>
                    <NukeSelect
                        value={value.type}
                        options={[
                            { value: 'point', label: 'Point' },
                            { value: 'box', label: 'Box' },
                            { value: 'sphere', label: 'Sphere' },
                            { value: 'cylinder', label: 'Cylinder' },
                            { value: 'cartesian', label: 'Cartesian independent (x/y/z)' },
                            { value: 'cylindrical', label: 'Cylindrical independent (r/phi/z)' },
                            { value: 'spherical', label: 'Spherical independent (r/cos θ/phi)' },
                            { value: 'pointcloud', label: 'Point cloud' },
                            { value: 'mesh', label: 'Mesh spatial' }
                        ]}
                        onChange={(type: string) => props.onChange(defaultSpatialOfType(type as OpenMCSourceSpatial['type']))}
                        ariaLabel="Spatial distribution"
                    />
                </div>
                {props.onSnap && (
                    <div className="form-group source-snap-action">
                        <label aria-hidden="true">&nbsp;</label>
                        <button className="theia-button secondary snap-main-btn" onClick={props.onSnap}>
                            <i className="codicon codicon-target"></i>
                            <span>Snap to Geometry</span>
                        </button>
                    </div>
                )}
            </div>

            {props.snapActions && props.snapActions.length > 0 && (
                <div className="source-quick-snaps">
                    <span className="quick-snaps-label">Quick Position:</span>
                    <div className="quick-snaps-buttons">
                        {props.snapActions.map((button, index) => (
                            <button key={index} className="theia-button secondary small" onClick={button.action}>
                                <i className={`codicon codicon-${button.icon}`}></i>
                                {button.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {value.type === 'point' && (
                <div className="form-row">
                    {[0, 1, 2].map((index) => (
                        <NumberField
                            key={index}
                            label={['X', 'Y', 'Z'][index]}
                            value={value.origin[index]}
                            onChange={(next) => {
                                const origin: [number, number, number] = [...value.origin];
                                origin[index] = next;
                                props.onChange({ ...value, origin });
                            }}
                        />
                    ))}
                </div>
            )}

            {value.type === 'box' && (
                <>
                    <div className="form-row">
                        {[0, 1, 2].map((index) => (
                            <NumberField
                                key={index}
                                label={`Min ${['X', 'Y', 'Z'][index]}`}
                                value={value.lowerLeft[index]}
                                onChange={(next) => {
                                    const lowerLeft: [number, number, number] = [...value.lowerLeft];
                                    lowerLeft[index] = next;
                                    props.onChange({ ...value, lowerLeft });
                                }}
                            />
                        ))}
                    </div>
                    <div className="form-row">
                        {[0, 1, 2].map((index) => (
                            <NumberField
                                key={index}
                                label={`Max ${['X', 'Y', 'Z'][index]}`}
                                value={value.upperRight[index]}
                                onChange={(next) => {
                                    const upperRight: [number, number, number] = [...value.upperRight];
                                    upperRight[index] = next;
                                    props.onChange({ ...value, upperRight });
                                }}
                            />
                        ))}
                    </div>
                </>
            )}

            {value.type === 'sphere' && (
                <>
                    <div className="form-row">
                        {[0, 1, 2].map((index) => (
                            <NumberField
                                key={index}
                                label={`Center ${['X', 'Y', 'Z'][index]}`}
                                value={value.center[index]}
                                onChange={(next) => {
                                    const center: [number, number, number] = [...value.center];
                                    center[index] = next;
                                    props.onChange({ ...value, center });
                                }}
                            />
                        ))}
                        <NumberField
                            label="Radius"
                            value={value.radius}
                            min={0}
                            onChange={(radius) => props.onChange({ ...value, radius })}
                        />
                    </div>
                </>
            )}

            {value.type === 'cylinder' && (
                <>
                    <div className="form-row">
                        {[0, 1, 2].map((index) => (
                            <NumberField
                                key={index}
                                label={`Center ${['X', 'Y', 'Z'][index]}`}
                                value={value.center[index]}
                                onChange={(next) => {
                                    const center: [number, number, number] = [...value.center];
                                    center[index] = next;
                                    props.onChange({ ...value, center });
                                }}
                            />
                        ))}
                        <NumberField
                            label="Radius"
                            value={value.radius}
                            min={0}
                            onChange={(radius) => props.onChange({ ...value, radius })}
                        />
                        <NumberField
                            label="Height"
                            value={value.height}
                            min={0}
                            onChange={(height) => props.onChange({ ...value, height })}
                        />
                        <div className="form-group">
                            <label>Axis</label>
                            <NukeSelect
                                value={value.axis}
                                options={[
                                    { value: 'x', label: 'X' },
                                    { value: 'y', label: 'Y' },
                                    { value: 'z', label: 'Z' }
                                ]}
                                onChange={(axis: string) => props.onChange({ ...value, axis: axis as 'x' | 'y' | 'z' })}
                                ariaLabel="Cylinder axis"
                            />
                        </div>
                    </div>
                </>
            )}

            {value.type === 'cartesian' && (
                <div className="source-coordinate-grid">
                    {(['x', 'y', 'z'] as const).map((axis) => (
                        <div className="source-coordinate-editor" key={axis}>
                            <h4>{axis.toUpperCase()} coordinate</h4>
                            <UnivariateEditor
                                value={value[axis]}
                                onChange={(next) => props.onChange({ ...value, [axis]: next })}
                                domain="coordinate"
                                allowedTypes={COORDINATE_TYPES}
                            />
                        </div>
                    ))}
                </div>
            )}

            {value.type === 'cylindrical' && (
                <>
                    <div className="source-coordinate-grid">
                        <div className="source-coordinate-editor">
                            <h4>R coordinate</h4>
                            <UnivariateEditor
                                value={value.r}
                                onChange={(r) => props.onChange({ ...value, r })}
                                domain="coordinate"
                                allowedTypes={COORDINATE_TYPES}
                            />
                        </div>
                        <div className="source-coordinate-editor">
                            <h4>Phi coordinate (rad)</h4>
                            <UnivariateEditor
                                value={value.phi}
                                onChange={(phi) => props.onChange({ ...value, phi })}
                                domain="angle-phi"
                                allowedTypes={ANGLE_TYPES}
                            />
                        </div>
                        <div className="source-coordinate-editor">
                            <h4>Z coordinate</h4>
                            <UnivariateEditor
                                value={value.z}
                                onChange={(z) => props.onChange({ ...value, z })}
                                domain="coordinate"
                                allowedTypes={COORDINATE_TYPES}
                            />
                        </div>
                    </div>
                    <VectorField
                        label="Origin"
                        value={value.origin}
                        fallback={[0, 0, 0]}
                        onChange={(origin) => props.onChange({ ...value, origin })}
                        tooltip="Origin of the cylindrical reference frame."
                    />
                    <VectorField
                        label="r direction"
                        value={value.rDir}
                        fallback={[1, 0, 0]}
                        onChange={(rDir) => props.onChange({ ...value, rDir })}
                        tooltip="Direction of the cylinder r axis at phi = 0. Must be perpendicular to z_dir."
                    />
                    <VectorField
                        label="z direction"
                        value={value.zDir}
                        fallback={[0, 0, 1]}
                        onChange={(zDir) => props.onChange({ ...value, zDir })}
                        tooltip="Direction of the cylinder z axis. OpenMC normalizes it."
                    />
                </>
            )}

            {value.type === 'spherical' && (
                <>
                    <div className="source-coordinate-grid">
                        <div className="source-coordinate-editor">
                            <h4>R coordinate</h4>
                            <UnivariateEditor
                                value={value.r}
                                onChange={(r) => props.onChange({ ...value, r })}
                                domain="coordinate"
                                allowedTypes={COORDINATE_TYPES}
                            />
                        </div>
                        <div className="source-coordinate-editor">
                            <h4>Cos θ coordinate</h4>
                            <UnivariateEditor
                                value={value.cosTheta}
                                onChange={(cosTheta) => props.onChange({ ...value, cosTheta })}
                                domain="coordinate"
                                allowedTypes={COORDINATE_TYPES}
                            />
                        </div>
                        <div className="source-coordinate-editor">
                            <h4>Phi coordinate (rad)</h4>
                            <UnivariateEditor
                                value={value.phi}
                                onChange={(phi) => props.onChange({ ...value, phi })}
                                domain="angle-phi"
                                allowedTypes={ANGLE_TYPES}
                            />
                        </div>
                    </div>
                    <VectorField
                        label="Origin"
                        value={value.origin}
                        fallback={[0, 0, 0]}
                        onChange={(origin) => props.onChange({ ...value, origin })}
                        tooltip="Center of the spherical reference frame."
                    />
                </>
            )}

            {value.type === 'pointcloud' && <PointCloudEditor value={value} onChange={props.onChange} />}

            {value.type === 'mesh' && <MeshSpatialEditor value={value} onChange={props.onChange} meshes={props.meshes ?? []} />}
        </div>
    );
}

/** Render source validation findings with cause + fix. */
export function SourceIssueList(props: { issues: SourceDistributionIssue[] }): React.ReactNode {
    if (props.issues.length === 0) {
        return null;
    }
    return (
        <div className="source-issues" role="status">
            {props.issues.map((issue, index) => (
                <div className="source-issue" key={index}>
                    <i className="codicon codicon-error" aria-hidden="true"></i>
                    <div>
                        <span className="source-issue-message">{issue.message}</span>
                        <span className="source-issue-fix">{issue.suggestion}</span>
                    </div>
                </div>
            ))}
        </div>
    );
}
