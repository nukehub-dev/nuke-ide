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

import * as React from '@theia/core/shared/react';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCSettings } from '../../../../../common/openmc-state-schema';
import type { OpenMCCompat } from '../../../../../common/openmc-studio-protocol';
import { AdvancedSettingsGroup, SettingsValidationIssue, validateRuntimeSettings } from '../../../../../common/settings-validation';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';
import { CollapsibleSection } from './collapsible-section';

/** Props for {@link AdvancedSection}. */
export interface AdvancedSectionProps {
    /** Simulation dashboard widget host. */
    host: SimulationDashboardWidget;
    /** Current OpenMC simulation state. */
    state: OpenMCState;
    /** Probed capabilities used to gate 0.16-only settings. */
    compat?: OpenMCCompat;
    /** Whether `mpirun` was found in the environment (undefined while checking). */
    mpiAvailable?: boolean;
}

/** Search keywords for each Advanced group (setting names and XML terms). */
const GROUP_KEYWORDS: Record<AdvancedSettingsGroup, string[]> = {
    execution: [
        'execution',
        'openmp',
        'thread',
        'threads',
        'mpi',
        'mpirun',
        'process',
        'processes',
        'rank',
        'host',
        'hosts',
        'trace',
        'lost particle',
        'event_based',
        'event based',
        'generations per batch',
        'generations_per_batch',
        'write_initial_source',
        'uniform_source_sampling'
    ],
    convergence: ['convergence', 'keff', 'k-effective', 'trigger', 'keff_trigger', 'confidence', 'confidence_intervals', 'uncertainty'],
    physics: [
        'physics',
        'temperature',
        'temperature_default',
        'temperature_method',
        'temperature_tolerance',
        'temperature_multipole',
        'multipole',
        'resonance',
        'resonance_scattering',
        'free gas',
        'free_gas_threshold',
        'cutoff',
        'energy',
        'energy_neutron',
        'energy_photon',
        'time',
        'time_neutron',
        'time_photon',
        'weight',
        'shared secondary',
        'shared_secondary_bank',
        'surface grazing',
        'surface_grazing_cutoff',
        'surface_grazing_ratio',
        'fission neutrons',
        'delayed neutrons',
        'decay photons',
        'survival biasing',
        'probability tables',
        'tabular legendre',
        'max_order',
        'log grid'
    ],
    limits: [
        'limits',
        'max particle events',
        'max_particle_events',
        'max particles in flight',
        'max_particles_in_flight',
        'max secondaries',
        'max_secondaries',
        'max splits',
        'max_history_splits',
        'max write lost particles',
        'max_write_lost_particles',
        'max lost particles',
        'max_lost_particles',
        'rel_max_lost_particles'
    ],
    diagnostics: [
        'diagnostics',
        'verbosity',
        'no reduce',
        'no_reduce',
        'stride',
        'plot seed',
        'plot_seed',
        'properties file',
        'properties_file',
        'material cell offsets',
        'material_cell_offsets'
    ]
};

/**
 * Whether a group matches the current filter text.
 * @param group - Group identifier.
 * @param query - Lowercase filter text.
 * @returns True when the group should be shown.
 */
function groupMatches(group: AdvancedSettingsGroup, query: string): boolean {
    return query.length === 0 || GROUP_KEYWORDS[group].some((keyword) => keyword.includes(query));
}

/**
 * Field label with an OpenMC-term tooltip.
 * @param label - Visible label.
 * @param content - Tooltip explanation of the effect.
 * @returns Label node.
 */
function labelWithTooltip(label: string, content: string): React.ReactNode {
    return (
        <Tooltip content={content} position="top">
            <label>{label}</label>
        </Tooltip>
    );
}

/**
 * Render a numeric setting bound to a top-level settings key.
 * @param host - Simulation dashboard widget host.
 * @param settings - Current settings.
 * @param key - Numeric settings key.
 * @param label - Visible label.
 * @param hint - One-line hint.
 * @param options - Placeholder, step, and minimum.
 * @returns Form group node.
 */
function numberField(
    host: SimulationDashboardWidget,
    settings: OpenMCSettings,
    key: keyof OpenMCSettings & string,
    label: string,
    hint: string,
    options: { placeholder?: string; step?: string; min?: number; tooltip?: string; integer?: boolean; disabled?: boolean } = {}
): React.ReactNode {
    const raw = settings[key] as number | undefined;
    return (
        <div className="form-group" key={key}>
            {options.tooltip ? labelWithTooltip(label, options.tooltip) : <label>{label}</label>}
            <input
                type="number"
                min={options.min ?? 0}
                step={options.step ?? 'any'}
                value={raw ?? ''}
                aria-label={label}
                disabled={options.disabled}
                placeholder={options.placeholder ?? 'OpenMC default'}
                onChange={(e) => {
                    const value = e.target.value;
                    const parsed = options.integer === false ? parseFloat(value) : parseInt(value, 10);
                    host.updateSetting(key, (value && Number.isFinite(parsed) ? parsed : undefined) as never);
                }}
            />
            <span className="form-hint">{hint}</span>
        </div>
    );
}

/**
 * Render a numeric setting bound to a nested settings key.
 * @param host - Simulation dashboard widget host.
 * @param settings - Current settings.
 * @param parentKey - Top-level settings key owning the object.
 * @param parent - Current nested object.
 * @param childKey - Numeric key inside the object.
 * @param label - Visible label.
 * @param hint - One-line hint.
 * @param options - Placeholder, step, minimum, and tooltip.
 * @returns Form group node.
 */
function nestedNumberField<T extends object>(
    host: SimulationDashboardWidget,
    settings: OpenMCSettings,
    parentKey: keyof OpenMCSettings,
    parent: T | undefined,
    childKey: keyof T & string,
    label: string,
    hint: string,
    options: { placeholder?: string; step?: string; min?: number; tooltip?: string; integer?: boolean } = {}
): React.ReactNode {
    const raw = parent?.[childKey] as number | undefined;
    return (
        <div className="form-group" key={`${String(parentKey)}-${childKey}`}>
            {options.tooltip ? labelWithTooltip(label, options.tooltip) : <label>{label}</label>}
            <input
                type="number"
                min={options.min ?? 0}
                step={options.step ?? 'any'}
                value={raw ?? ''}
                aria-label={label}
                placeholder={options.placeholder ?? 'OpenMC default'}
                onChange={(e) => {
                    const value = e.target.value;
                    const parsed = options.integer === true ? parseInt(value, 10) : parseFloat(value);
                    const next = { ...(parent ?? ({} as T)), [childKey]: value && Number.isFinite(parsed) ? parsed : undefined };
                    host.updateSetting(parentKey, next as never);
                }}
            />
            <span className="form-hint">{hint}</span>
        </div>
    );
}

/**
 * Render a boolean advanced setting as a checkbox. Unset means OpenMC's
 * default applies.
 * @param host - Simulation dashboard widget host.
 * @param settings - Current settings.
 * @param key - Boolean settings key.
 * @param label - Checkbox label.
 * @param hint - One-line hint.
 * @param defaultValue - OpenMC's default.
 * @param disabled - Whether the control is gated by capability.
 * @param tooltip - Optional OpenMC-term tooltip.
 * @returns Checkbox form group node.
 */
function boolField(
    host: SimulationDashboardWidget,
    settings: OpenMCSettings,
    key: keyof OpenMCSettings & string,
    label: string,
    hint: string,
    defaultValue: boolean,
    disabled = false,
    tooltip?: string
): React.ReactNode {
    return (
        <div className="form-group checkbox" key={key}>
            <label>
                <input
                    type="checkbox"
                    checked={(settings[key] as boolean | undefined) ?? defaultValue}
                    disabled={disabled}
                    onChange={(e) => host.updateSetting(key, e.target.checked as never)}
                />
                {tooltip ? (
                    <Tooltip content={tooltip} position="top">
                        {label}
                    </Tooltip>
                ) : (
                    label
                )}
            </label>
            <span className="form-hint">{hint}</span>
        </div>
    );
}

/**
 * Advanced section: runtime execution controls plus convergence, physics,
 * limits, and diagnostics settings in collapsible groups with a name search.
 * Every field maps to a real OpenMC setting; 0.16-only controls are disabled
 * with a capability hint when the environment lacks them.
 * @param props - Host, state, probed compatibility, and MPI availability.
 * @returns Advanced section React node.
 */
export function AdvancedSection(props: AdvancedSectionProps): React.ReactNode {
    const { host, state } = props;
    const settings = state.settings;
    const [query, setQuery] = React.useState('');
    const normalizedQuery = query.trim().toLowerCase();
    const validation = validateRuntimeSettings(settings, props.compat);
    const supportsSharedBank = props.compat?.sharedSecondaryBank === true;
    const supportsSurfaceGrazing = props.compat?.surfaceGrazing === true;

    const issuesFor = (group: AdvancedSettingsGroup): SettingsValidationIssue[] => validation.filter((issue) => issue.group === group);
    const statusFor = (group: AdvancedSettingsGroup): 'error' | 'warning' | undefined => {
        const issues = issuesFor(group);
        return issues.some((issue) => issue.severity === 'error') ? 'error' : issues.length > 0 ? 'warning' : undefined;
    };
    const statusMessageFor = (group: AdvancedSettingsGroup): string | undefined => {
        const issues = issuesFor(group);
        if (issues.length === 0) {
            return undefined;
        }
        const first = issues[0];
        return issues.length === 1
            ? `${first.message}. ${first.suggestion}`
            : `${first.message} (+${issues.length - 1} more). ${first.suggestion}`;
    };

    const groupNode = (group: AdvancedSettingsGroup, title: string, icon: string, children: React.ReactNode): React.ReactNode => {
        if (!groupMatches(group, normalizedQuery)) {
            return null;
        }
        return (
            <CollapsibleSection
                key={`${group}-${normalizedQuery ? 'search' : 'idle'}`}
                title={title}
                icon={icon}
                defaultOpen={normalizedQuery.length > 0}
                className={`advanced-group advanced-group-${group}`}
                status={statusFor(group)}
                statusMessage={statusMessageFor(group)}
            >
                {children}
            </CollapsibleSection>
        );
    };

    const execution = (
        <>
            <div className="form-row">
                {numberField(host, settings, 'threads', 'OpenMP threads', 'Per MPI rank (openmc -s N); empty uses all hardware threads', {
                    min: 1,
                    step: '1',
                    tooltip: 'OpenMP threads control shared-memory parallelism inside each OpenMC process. They multiply with MPI ranks.'
                })}
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.mpi?.enabled ?? false}
                            onChange={(e) =>
                                host.updateSetting('mpi', {
                                    ...settings.mpi,
                                    enabled: e.target.checked,
                                    processes: settings.mpi?.processes ?? (e.target.checked ? 2 : undefined)
                                })
                            }
                        />
                        Enable MPI
                    </label>
                    <span className="form-hint">
                        {props.mpiAvailable === false
                            ? 'mpirun was not found by the health check — install an MPI runtime first'
                            : 'Launch OpenMC through mpirun (requires an MPI-enabled OpenMC build)'}
                    </span>
                </div>
            </div>
            {settings.mpi?.enabled && (
                <div className="form-row">
                    {nestedNumberField(
                        host,
                        settings,
                        'mpi',
                        settings.mpi,
                        'processes',
                        'MPI processes',
                        'Ranks launched with mpirun -np N; threads apply per rank',
                        {
                            min: 1,
                            step: '1',
                            placeholder: '2',
                            integer: true
                        }
                    )}
                    <div className="form-group">
                        {labelWithTooltip(
                            'MPI hosts',
                            'Optional mpirun --host list. Leave empty to let the scheduler or local host list decide.'
                        )}
                        <input
                            type="text"
                            value={(settings.mpi?.hosts ?? []).join(', ')}
                            placeholder="node1, node2"
                            onChange={(e) => {
                                const hosts = e.target.value
                                    .split(',')
                                    .map((host) => host.trim())
                                    .filter((host) => host.length > 0);
                                host.updateSetting('mpi', { ...settings.mpi, hosts: hosts.length > 0 ? hosts : undefined });
                            }}
                        />
                        <span className="form-hint">Comma-separated hostnames; leave empty for local launch</span>
                    </div>
                </div>
            )}
            <div className="form-row">
                <div className="form-group">
                    {labelWithTooltip(
                        'Trace particle',
                        'Prints detailed event information for one particle. Batch, generation, and particle are 1-based.'
                    )}
                    <div className="trace-inputs">
                        {(['Batch', 'Generation', 'Particle'] as const).map((label, index) => (
                            <input
                                key={label}
                                type="number"
                                min={1}
                                step="1"
                                aria-label={`Trace ${label.toLowerCase()}`}
                                placeholder={label}
                                value={settings.trace?.[index] ?? ''}
                                onChange={(e) => {
                                    const next = [...(settings.trace ?? [0, 0, 0])] as [number, number, number];
                                    next[index] = parseInt(e.target.value, 10) || 0;
                                    host.updateSetting('trace', next.some((value) => value > 0) ? next : undefined);
                                }}
                            />
                        ))}
                    </div>
                    <span className="form-hint warning-text">
                        <i className="codicon codicon-warning"></i> Large output — use only for debugging lost particles.
                    </span>
                </div>
                {numberField(
                    host,
                    settings,
                    'generationsPerBatch',
                    'Generations per batch',
                    'Eigenvalue source iterations per batch (default 1)',
                    {
                        min: 1,
                        step: '1'
                    }
                )}
            </div>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'eventBased',
                    'Event-based parallelism',
                    'Schedule by event instead of by history',
                    false,
                    false,
                    'Event-based parallelism uses max particles in flight instead of one history per thread.'
                )}
                {boolField(
                    host,
                    settings,
                    'writeInitialSource',
                    'Write initial source',
                    'Write the initial source distribution to file',
                    false
                )}
                {boolField(
                    host,
                    settings,
                    'uniformSourceSampling',
                    'Uniform source sampling',
                    'Sample sources uniformly and apply strengths as weights',
                    false
                )}
            </div>
        </>
    );

    const convergence = (
        <>
            <div className="form-row">
                <div className="form-group">
                    {labelWithTooltip(
                        'k-eff trigger type',
                        'Precision metric on the combined k-effective: relative error, standard deviation, or variance.'
                    )}
                    <NukeSelect
                        value={settings.keffTrigger?.type ?? 'rel_err'}
                        options={[
                            { value: 'rel_err', label: 'Relative error' },
                            { value: 'std_dev', label: 'Standard deviation' },
                            { value: 'variance', label: 'Variance' }
                        ]}
                        onChange={(value: string) =>
                            host.updateSetting('keffTrigger', {
                                threshold: settings.keffTrigger?.threshold ?? 0.001,
                                type: value as 'variance' | 'std_dev' | 'rel_err'
                            })
                        }
                        ariaLabel="k-eff trigger type"
                    />
                </div>
                <div className="form-group">
                    {labelWithTooltip(
                        'k-eff trigger threshold',
                        'Simulation continues past the batch count until this k-eff precision is met.'
                    )}
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={settings.keffTrigger?.threshold ?? ''}
                        placeholder="e.g. 0.001"
                        onChange={(e) => {
                            const threshold = e.target.value ? parseFloat(e.target.value) : undefined;
                            host.updateSetting(
                                'keffTrigger',
                                threshold !== undefined ? { type: settings.keffTrigger?.type ?? 'rel_err', threshold } : undefined
                            );
                        }}
                    />
                    <span className="form-hint">Set a value to enable; requires eigenvalue mode</span>
                </div>
            </div>
            {boolField(
                host,
                settings,
                'confidenceIntervals',
                'Confidence intervals',
                'Report tally uncertainties as 95% confidence-interval half-widths',
                false,
                false,
                'OpenMC confidence_intervals is a fixed 95% two-sided interval; it has no configurable level.'
            )}
            <span className="form-hint">The entropy mesh and CMFD controls live in the Convergence section above.</span>
        </>
    );

    const physics = (
        <>
            <div className="form-row">
                {nestedNumberField(
                    host,
                    settings,
                    'temperature',
                    settings.temperature,
                    'default',
                    'Default temperature (K)',
                    'Applied when a cell/material has no explicit temperature',
                    {
                        min: 0,
                        step: 'any',
                        placeholder: '293.6',
                        tooltip: 'OpenMC temperature_default; the default is 293.6 K.',
                        integer: false
                    }
                )}
                {nestedNumberField(
                    host,
                    settings,
                    'temperature',
                    settings.temperature,
                    'tolerance',
                    'Temperature tolerance (K)',
                    'Nearest-method tolerance or interpolation bound allowance',
                    {
                        min: 0,
                        tooltip: 'OpenMC temperature_tolerance; the default is 10 K.',
                        integer: false
                    }
                )}
            </div>
            <div className="form-row">
                <div className="form-group">
                    {labelWithTooltip(
                        'Temperature method',
                        'Nearest uses the closest available cross-section temperature within tolerance; interpolation blends data.'
                    )}
                    <NukeSelect
                        value={settings.temperature?.method ?? 'nearest'}
                        options={[
                            { value: 'nearest', label: 'Nearest' },
                            { value: 'interpolation', label: 'Interpolation' }
                        ]}
                        onChange={(value: string) =>
                            host.updateSetting('temperature', {
                                ...settings.temperature,
                                method: value as 'nearest' | 'interpolation'
                            })
                        }
                        ariaLabel="Temperature method"
                    />
                </div>
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.temperature?.multipole ?? false}
                            onChange={(e) => host.updateSetting('temperature', { ...settings.temperature, multipole: e.target.checked })}
                        />
                        Windowed multipole
                    </label>
                    <span className="form-hint">
                        Doppler-broaden resolved resonances from multipole data; incompatible with photon transport
                    </span>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.resonanceScattering?.enable ?? false}
                            onChange={(e) =>
                                host.updateSetting('resonanceScattering', {
                                    ...settings.resonanceScattering,
                                    enable: e.target.checked,
                                    method: settings.resonanceScattering?.method ?? 'rvs'
                                })
                            }
                        />
                        Resonance elastic scattering
                    </label>
                    <span className="form-hint">Correct target motion for heavy nuclides (typically Z &gt; 40)</span>
                </div>
                <div className="form-group">
                    {labelWithTooltip(
                        'Resonance method',
                        'RVS samples relative velocity; DBRC rejects Doppler-broadened scattering targets.'
                    )}
                    <NukeSelect
                        value={settings.resonanceScattering?.method ?? 'rvs'}
                        options={[
                            { value: 'rvs', label: 'RVS (relative velocity sampling)' },
                            { value: 'dbrc', label: 'DBRC (Doppler broadening rejection)' }
                        ]}
                        onChange={(value: string) =>
                            host.updateSetting('resonanceScattering', {
                                ...settings.resonanceScattering,
                                method: value as 'rvs' | 'dbrc'
                            })
                        }
                        ariaLabel="Resonance scattering method"
                    />
                </div>
            </div>
            <div className="form-row">
                {nestedNumberField(
                    host,
                    settings,
                    'resonanceScattering',
                    settings.resonanceScattering,
                    'energyMin',
                    'Resonance energy min (eV)',
                    'Below this energy the constant-cross-section model applies',
                    {
                        min: 0,
                        placeholder: '0.01',
                        integer: false
                    }
                )}
                {nestedNumberField(
                    host,
                    settings,
                    'resonanceScattering',
                    settings.resonanceScattering,
                    'energyMax',
                    'Resonance energy max (eV)',
                    'Above this energy the target-at-rest kernel applies',
                    {
                        min: 0,
                        placeholder: '1000',
                        integer: false
                    }
                )}
                {numberField(
                    host,
                    settings,
                    'freeGasThreshold',
                    'Free-gas threshold (kT)',
                    'Elastic scattering uses the free-gas model below this energy multiplier',
                    {
                        min: 0,
                        placeholder: '400',
                        integer: false,
                        tooltip: 'OpenMC free_gas_threshold; values are multiples of kT (default 400).'
                    }
                )}
            </div>
            <h4>
                <i className="codicon codicon-symbol-numeric"></i> Energy, time, and weight cutoffs
            </h4>
            <div className="form-row">
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'energyNeutron',
                    'Neutron energy cutoff (eV)',
                    'Neutrons below this energy are killed',
                    { min: 0 }
                )}
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'energyPhoton',
                    'Photon energy cutoff (eV)',
                    'Photons below this energy are killed',
                    { min: 0 }
                )}
            </div>
            <div className="form-row">
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'time',
                    'Neutron time cutoff (s)',
                    'Neutrons above this time are killed',
                    { min: 0 }
                )}
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'timePhoton',
                    'Photon time cutoff (s)',
                    'Photons above this time are killed',
                    { min: 0 }
                )}
            </div>
            <div className="form-row">
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'weight',
                    'Weight cutoff',
                    'Below this weight particles undergo Russian roulette',
                    { min: 0 }
                )}
                {nestedNumberField(
                    host,
                    settings,
                    'cutoff',
                    settings.cutoff,
                    'weightAvg',
                    'Average survival weight',
                    'Weight assigned after Russian roulette survival',
                    { min: 0 }
                )}
            </div>
            <h4>
                <i className="codicon codicon-settings-gear"></i> Secondary banks and surfaces
            </h4>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'sharedSecondaryBank',
                    'Shared secondary bank',
                    supportsSharedBank
                        ? 'Collect, sort, and load-balance secondaries across MPI ranks'
                        : 'Requires OpenMC 0.16.0+ — omitted with this environment',
                    false,
                    !supportsSharedBank,
                    'OpenMC shared_secondary_bank; auto-enabled for fixed-source weight-window runs when unset.'
                )}
            </div>
            <div className="form-row">
                {numberField(
                    host,
                    settings,
                    'surfaceGrazingCutoff',
                    'Surface grazing cutoff',
                    'Cosine cutoff for surface flux; values in (0, 1)',
                    {
                        min: 0,
                        placeholder: '0.001',
                        integer: false,
                        disabled: !supportsSurfaceGrazing,
                        tooltip: supportsSurfaceGrazing
                            ? 'OpenMC surface_grazing_cutoff (0.16.0+).'
                            : 'Requires OpenMC 0.16.0+; omitted with this environment.'
                    }
                )}
                {numberField(
                    host,
                    settings,
                    'surfaceGrazingRatio',
                    'Surface grazing ratio',
                    'Substitution ratio for grazing surface crossings',
                    {
                        min: 0,
                        placeholder: '0.5',
                        integer: false,
                        disabled: !supportsSurfaceGrazing,
                        tooltip: supportsSurfaceGrazing
                            ? 'OpenMC surface_grazing_ratio (0.16.0+).'
                            : 'Requires OpenMC 0.16.0+; omitted with this environment.'
                    }
                )}
            </div>
            <h4>
                <i className="codicon codicon-flame"></i> Particle creation and scattering
            </h4>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'createFissionNeutrons',
                    'Create fission neutrons',
                    'Off suppresses fission sites (fixed-source photon/electron problems)',
                    true
                )}
                {boolField(host, settings, 'createDelayedNeutrons', 'Create delayed neutrons', 'Include delayed neutrons in fission', true)}
                {boolField(
                    host,
                    settings,
                    'delayedPhotonScaling',
                    'Delayed photon scaling',
                    'Scale fission photon yield for delayed photon energy',
                    true
                )}
                {boolField(
                    host,
                    settings,
                    'useDecayPhotons',
                    'Use decay photons',
                    'Produce decay photons from neutron reactions instead of prompt photons',
                    false
                )}
                {boolField(host, settings, 'survivalBiasing', 'Survival biasing', 'Use implicit capture instead of absorption', true)}
                {boolField(host, settings, 'probabilityTables', 'Probability tables', 'Unresolved-resonance probability tables', true)}
            </div>
            <div className="form-row">
                {numberField(host, settings, 'maxOrder', 'Max scattering order', 'Global P_N ceiling in multi-group mode', {
                    min: 0,
                    step: '1',
                    placeholder: 'Library maximum'
                })}
                {numberField(host, settings, 'logGridBins', 'Log grid bins', 'Bins for the logarithmic energy grid search', {
                    min: 1,
                    step: '1'
                })}
            </div>
            <div className="form-row">
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.tabularLegendre?.enable ?? false}
                            onChange={(e) =>
                                host.updateSetting('tabularLegendre', { ...settings.tabularLegendre, enable: e.target.checked })
                            }
                        />
                        Tabular Legendre conversion
                    </label>
                    <span className="form-hint">Convert multi-group scattering moment kernels to tabular distributions</span>
                </div>
                {nestedNumberField(
                    host,
                    settings,
                    'tabularLegendre',
                    settings.tabularLegendre,
                    'numPoints',
                    'Tabular points',
                    'Points per tabular scattering distribution',
                    {
                        min: 1,
                        step: '1',
                        integer: true
                    }
                )}
            </div>
        </>
    );

    const limits = (
        <>
            <div className="form-row">
                {numberField(host, settings, 'maxLostParticles', 'Max lost particles', 'Abort after this many lost particles', {
                    min: 1,
                    step: '1'
                })}
                {numberField(
                    host,
                    settings,
                    'relLostParticleRate',
                    'Relative lost-particle rate',
                    'Abort when the lost fraction exceeds this value',
                    {
                        min: 0,
                        integer: false
                    }
                )}
                {numberField(
                    host,
                    settings,
                    'maxWriteLostParticles',
                    'Max lost-particle files',
                    'Particle restart files written per rank',
                    {
                        min: 1,
                        step: '1',
                        tooltip: 'OpenMC max_write_lost_particles; the Python API requires a positive value.'
                    }
                )}
            </div>
            <div className="form-row">
                {numberField(host, settings, 'maxParticleEvents', 'Max particle events', 'Maximum events one particle may undergo', {
                    min: 1,
                    step: '1',
                    placeholder: '1000000'
                })}
                {numberField(
                    host,
                    settings,
                    'maxParticlesInFlight',
                    'Max particles in flight',
                    'Concurrent particles in event-based mode',
                    {
                        min: 1,
                        step: '1',
                        placeholder: '100000'
                    }
                )}
                {numberField(host, settings, 'maxSecondaries', 'Max secondaries', 'Maximum secondary bank size', {
                    min: 1,
                    step: '1',
                    placeholder: '10000'
                })}
                {numberField(host, settings, 'maxHistorySplits', 'Max history splits', 'Maximum splits per particle history', {
                    min: 1,
                    step: '1',
                    placeholder: '10000000',
                    tooltip: 'OpenMC max_history_splits; max_splits is deprecated and not emitted.'
                })}
            </div>
        </>
    );

    const diagnostics = (
        <>
            <div className="form-row">
                <div className="form-group">
                    {labelWithTooltip('Verbosity', 'OpenMC output level: 1 is silent, 7 is the default, 10 prints event diagnostics.')}
                    <input
                        type="number"
                        min={1}
                        max={10}
                        step="1"
                        value={settings.verbosity ?? ''}
                        placeholder="7"
                        onChange={(e) => host.updateSetting('verbosity', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                    />
                    <span className="form-hint">Standard-output detail from 1 (quiet) to 10 (event level)</span>
                </div>
                {numberField(host, settings, 'stride', 'Random-number stride', 'Random numbers allocated per source history', {
                    min: 1,
                    step: '1',
                    placeholder: '152917'
                })}
                {numberField(host, settings, 'plotSeed', 'Plot seed', 'Seed for plot color generation', {
                    min: 1,
                    step: '1',
                    placeholder: '1'
                })}
            </div>
            <div className="form-row">
                <div className="form-group">
                    {labelWithTooltip(
                        'Properties file',
                        'HDF5 file that overrides cell temperatures/densities and material densities at startup.'
                    )}
                    <input
                        type="text"
                        value={settings.propertiesFile ?? ''}
                        placeholder="/path/to/properties.h5"
                        onChange={(e) => host.updateSetting('propertiesFile', e.target.value || undefined)}
                    />
                    <span className="form-hint">OpenMC properties_file path; relative paths resolve from the run directory</span>
                </div>
            </div>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'noReduce',
                    'No tally reduction',
                    'Keep per-rank tally realizations in MPI runs',
                    false,
                    false,
                    'OpenMC no_reduce; can improve parallel efficiency for large tally data.'
                )}
                {boolField(
                    host,
                    settings,
                    'materialCellOffsets',
                    'Material/cell offsets',
                    'Precompute material and cell index offsets (OpenMC default on)',
                    true,
                    false,
                    'OpenMC material_cell_offsets; only disable for geometry debugging.'
                )}
            </div>
        </>
    );

    return (
        <div className="advanced-section">
            <div className="advanced-search">
                <i className="codicon codicon-search"></i>
                <input
                    type="search"
                    value={query}
                    placeholder="Filter settings (e.g. threads, keff_trigger, cutoff)"
                    aria-label="Filter advanced settings"
                    onChange={(e) => setQuery(e.target.value)}
                />
                {query.length > 0 && (
                    <Tooltip content="Clear the settings filter" position="top">
                        <button className="theia-button secondary small" onClick={() => setQuery('')} aria-label="Clear filter">
                            <i className="codicon codicon-close"></i>
                        </button>
                    </Tooltip>
                )}
            </div>
            {normalizedQuery.length > 0 &&
                !(Object.keys(GROUP_KEYWORDS) as AdvancedSettingsGroup[]).some((group) => groupMatches(group, normalizedQuery)) && (
                    <div className="advanced-empty">
                        <i className="codicon codicon-search"></i>
                        <p>No setting matches “{query}”. Try threads, mpi, keff_trigger, free_gas_threshold, or max_secondaries.</p>
                    </div>
                )}
            {groupNode('execution', 'Execution', 'openmc-run', execution)}
            {groupNode('convergence', 'Convergence', 'openmc-plot', convergence)}
            {groupNode('physics', 'Physics', 'symbol-misc', physics)}
            {groupNode('limits', 'Limits', 'dashboard', limits)}
            {groupNode('diagnostics', 'Diagnostics', 'output', diagnostics)}
        </div>
    );
}
