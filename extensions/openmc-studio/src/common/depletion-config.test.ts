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

import { describe, expect, it } from 'vitest';

import {
    getDepletionCapabilityIssues,
    getDepletionSubsteps,
    hasDriverOnlyDepletionSettings,
    parseDepletionBlock,
    summarizeContinuation,
    summarizeExternalSourceRates,
    summarizeExternalSourceRatesText,
    summarizeReactivityControl,
    validateDepletionAdvanced
} from './depletion-config';
import { OpenMCDepletion, OpenMCState } from './openmc-state-schema';
import { OpenMCCompat } from './openmc-studio-protocol';

function buildState(depletion: Partial<OpenMCDepletion>): OpenMCState {
    return {
        metadata: { version: '1.1.0', name: 'depletion-test', created: '', modified: '' },
        geometry: {
            surfaces: [],
            cells: [
                {
                    id: 1,
                    name: 'fuel',
                    fillType: 'material',
                    fillId: 1
                },
                {
                    id: 7,
                    name: 'control rod',
                    fillType: 'material',
                    fillId: 2
                }
            ],
            universes: [{ id: 0, name: 'root', cellIds: [1, 7] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'fuel',
                density: 10,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'U235', fraction: 1, fractionType: 'ao' },
                    { name: 'U238', fraction: 3, fractionType: 'ao' }
                ],
                thermalScattering: [],
                isDepletable: true,
                volume: 100
            },
            {
                id: 2,
                name: 'borated water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'H1', fraction: 2, fractionType: 'ao' },
                    { name: 'O16', fraction: 1, fractionType: 'ao' }
                ],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: []
        },
        tallies: [],
        meshes: [],
        depletion: {
            enabled: true,
            chainFile: '/chains/chain.xml',
            power: 1e6,
            timeSteps: [86400, 86400],
            ...depletion
        }
    } as OpenMCState;
}

function buildControl(overrides: Record<string, unknown> = {}): any {
    return {
        enabled: true,
        parameter: 'cell-translation',
        cellId: 7,
        axis: 'z',
        x0: 0,
        x1: 10,
        bracket: [-20, 20],
        targetKeff: 1.0,
        kTol: 1e-4,
        sigmaFinal: 3e-4,
        maxIterations: 50,
        onFailure: 'fail',
        ...overrides
    };
}

describe('parseDepletionBlock', () => {
    it('parses the driver-only advanced fields and unescapes JSON', () => {
        const xml = `<settings><depletion>
            <chain_file>/chains/chain.xml</chain_file>
            <time_steps>86400 43200</time_steps>
            <power>1000000</power>
            <operator>coupled</operator>
            <solver>cecm</solver>
            <normalization>source-rate</normalization>
            <substeps>3</substeps>
            <reactivity_control>{&quot;enabled&quot;:true,&quot;parameter&quot;:&quot;cell-translation&quot;,&quot;cellId&quot;:7,&quot;axis&quot;:&quot;z&quot;,&quot;x0&quot;:0,&quot;x1&quot;:10,&quot;bracket&quot;:[-20,20]}</reactivity_control>
            <external_source_rates>[{&quot;material&quot;:1,&quot;composition&quot;:[{&quot;name&quot;:&quot;U235&quot;,&quot;weightPercent&quot;:100}],&quot;rate&quot;:-1e-6,&quot;units&quot;:&quot;g/s&quot;,&quot;timesteps&quot;:[0]}]</external_source_rates>
            <continue_from_results>/runs/old/depletion_results.h5</continue_from_results>
            <continue_timesteps>true</continue_timesteps>
        </depletion></settings>`;

        const parsed = parseDepletionBlock(xml);
        expect(parsed?.warnings).toEqual([]);
        expect(parsed?.depletion.timeSteps).toEqual([86400, 43200]);
        expect(parsed?.depletion.substeps).toBe(3);
        expect(parsed?.depletion.reactivityControl).toMatchObject({ cellId: 7, axis: 'z', bracket: [-20, 20] });
        expect(parsed?.depletion.externalSourceRates?.[0]).toMatchObject({ material: 1, rate: -1e-6, units: 'g/s' });
        expect(parsed?.depletion.continueFromResults).toBe('/runs/old/depletion_results.h5');
        expect(parsed?.depletion.continueTimesteps).toBe(true);
    });

    it('reports malformed JSON instead of dropping the field', () => {
        const xml = '<settings><depletion><reactivity_control>{not-json}</reactivity_control></depletion></settings>';
        const parsed = parseDepletionBlock(xml);
        expect(parsed?.warnings[0]).toContain('<reactivity_control>');
        expect(parsed?.depletion.reactivityControl).toBeUndefined();
    });

    it('returns undefined when no depletion block exists', () => {
        expect(parseDepletionBlock('<settings></settings>')).toBeUndefined();
    });
});

describe('validateDepletionAdvanced', () => {
    it('accepts a valid control-rod search and external rate', () => {
        const state = buildState({
            substeps: 2,
            reactivityControl: buildControl(),
            externalSourceRates: [
                {
                    material: 1,
                    composition: [{ name: 'U235', weightPercent: 100 }],
                    rate: -1e-6,
                    units: 'g/s',
                    timesteps: [0, 1]
                }
            ]
        });
        expect(validateDepletionAdvanced(state)).toEqual([]);
    });

    it('rejects invalid substeps, brackets, guesses, and missing cells', () => {
        const state = buildState({
            substeps: 0,
            reactivityControl: buildControl({ cellId: 99, x0: -30, x1: -30, bracket: [20, -20] })
        });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'substeps' && issue.severity === 'error')).toBe(true);
        expect(issues.some((issue) => issue.field === 'reactivityControl.cellId' && issue.severity === 'error')).toBe(true);
        expect(issues.some((issue) => issue.field === 'reactivityControl.bracket' && issue.severity === 'error')).toBe(true);
        expect(issues.some((issue) => issue.field === 'reactivityControl.x1' && issue.severity === 'error')).toBe(true);
    });

    it('rejects decay-only indices outside the timeline', () => {
        const state = buildState({ decayOnlySteps: [5] });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'decayOnlySteps' && issue.severity === 'error')).toBe(true);
    });

    it('rejects a nuclide that is not in the selected material', () => {
        const state = buildState({
            reactivityControl: {
                ...buildControl(),
                parameter: 'nuclide-density',
                materialId: 1,
                nuclide: 'Gd155'
            }
        });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'reactivityControl.nuclide' && issue.severity === 'error')).toBe(true);
    });

    it('rejects unknown materials and non-depletable external-rate targets', () => {
        const state = buildState({
            externalSourceRates: [
                {
                    material: 2,
                    composition: [{ name: 'U235', weightPercent: 100 }],
                    rate: 1
                },
                {
                    material: 99,
                    composition: [{ name: 'U235', weightPercent: 100 }],
                    rate: 1
                }
            ]
        });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'externalSourceRates.0.material' && issue.severity === 'error')).toBe(true);
        expect(issues.some((issue) => issue.field === 'externalSourceRates.1.material' && issue.severity === 'error')).toBe(true);
    });

    it('warns on compositions that do not total 100% and rejects duplicates', () => {
        const state = buildState({
            externalSourceRates: [
                {
                    material: 1,
                    composition: [
                        { name: 'U235', weightPercent: 60 },
                        { name: 'U238', weightPercent: 20 }
                    ],
                    rate: 1
                },
                {
                    material: 1,
                    composition: [
                        { name: 'U235', weightPercent: 60 },
                        { name: 'U235', weightPercent: 40 }
                    ],
                    rate: 1
                }
            ]
        });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'externalSourceRates.0.composition' && issue.severity === 'warning')).toBe(true);
        expect(issues.some((issue) => issue.field === 'externalSourceRates.1.composition.1.name' && issue.severity === 'error')).toBe(true);
    });

    it('requires a previous results file when continuing timesteps', () => {
        const state = buildState({ continueTimesteps: true });
        const issues = validateDepletionAdvanced(state);
        expect(issues.some((issue) => issue.field === 'continuation' && issue.severity === 'error')).toBe(true);
    });

    it('ignores advanced fields when depletion is disabled', () => {
        const state = buildState({ enabled: false, substeps: 0, continueTimesteps: true });
        expect(validateDepletionAdvanced(state)).toEqual([]);
    });
});

describe('summaries and capability probes', () => {
    it('summarizes feed and removal rates by unit', () => {
        const totals = summarizeExternalSourceRates([
            { material: 1, composition: [{ name: 'U235', weightPercent: 100 }], rate: 2, units: 'g/s' },
            { material: 1, composition: [{ name: 'U235', weightPercent: 100 }], rate: -0.5, units: 'g/s' },
            { material: 1, composition: [{ name: 'Xe135', weightPercent: 100 }], rate: -1, units: 'g/d' }
        ]);
        expect(totals).toEqual({ count: 3, feed: { 'g/s': 2 }, removal: { 'g/s': 0.5, 'g/d': 1 } });
        expect(summarizeExternalSourceRatesText(undefined)).toBe('');
        expect(summarizeExternalSourceRatesText([{ material: 1, composition: [], rate: 1 }])).toContain('1 rate');
    });

    it('summarizes reactivity control and continuation', () => {
        expect(summarizeReactivityControl(buildControl())).toBe('Cell #7 z-translation');
        expect(summarizeReactivityControl(buildControl({ parameter: 'nuclide-density', materialId: 1, nuclide: 'U235' }))).toBe(
            'Material #1 U235 density'
        );
        expect(summarizeContinuation(buildState({}).depletion!)).toBe('');
        expect(
            summarizeContinuation(buildState({ continueFromResults: '/runs/old/depletion_results.h5', continueTimesteps: true }).depletion!)
        ).toBe('Continue timesteps from depletion_results.h5');
    });

    it('flags driver-only settings and 0.16 capabilities', () => {
        const simple = buildState({ substeps: 1 });
        expect(hasDriverOnlyDepletionSettings(simple.depletion!)).toBe(false);
        const advanced = buildState({ substeps: 2, reactivityControl: buildControl() });
        expect(hasDriverOnlyDepletionSettings(advanced.depletion!)).toBe(true);

        const noCapabilities: OpenMCCompat = {
            raySourceFormat: 'direct',
            adjointSource: false,
            tokamakSource: false,
            s2SampleMethod: false,
            depletionSubsteps: false,
            depletionKeffSearch: false,
            depletionExternalSourceRate: false,
            depletionContinuation: false
        };
        const issues = getDepletionCapabilityIssues(
            {
                ...advanced.depletion!,
                externalSourceRates: [{ material: 1, composition: [{ name: 'U235', weightPercent: 100 }], rate: 1 }],
                continueFromResults: '/tmp/old.h5'
            },
            noCapabilities
        );
        expect(issues.map((issue) => issue.field)).toEqual(['substeps', 'reactivityControl', 'externalSourceRates', 'continuation']);
    });

    it('defaults substeps to one', () => {
        expect(getDepletionSubsteps({ timeSteps: [] })).toBe(1);
        expect(getDepletionSubsteps({ timeSteps: [], substeps: 4 })).toBe(4);
    });
});
