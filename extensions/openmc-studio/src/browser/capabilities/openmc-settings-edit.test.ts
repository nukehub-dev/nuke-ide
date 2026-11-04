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
 * Tests the pure OpenMC settings edit helpers.
 */

import { describe, expect, it } from 'vitest';
import { IFP_SCORES } from '../../common/kinetics-ifp';
import type { OpenMCSettings, OpenMCTally } from '../../common/openmc-state-schema';
import {
    applySettingsChanges,
    isSettingsPath,
    MAX_PRECURSOR_GROUPS,
    OpenMCSettingsPath,
    settingsChanges,
    settingsEqual,
    settingsUpdatePatch,
    settingsValue,
    SUPPORTED_SETTINGS_PATHS,
    validateSettingsChange,
    validateSettingsChanges
} from './openmc-settings-edit';

function buildSettings(): OpenMCSettings {
    return {
        run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 },
        sources: [],
        seed: 1,
        threads: 4,
        verbosity: 5,
        energyMode: 'continuous-energy',
        photonTransport: false,
        electronTreatment: 'led',
        atomicRelaxation: true,
        sourceRejectionFraction: 0.05
    };
}

function buildAdvancedSettings(): OpenMCSettings {
    return {
        ...buildSettings(),
        output: { summary: false, tallies: true, path: 'runs/out' },
        cutoff: { energyNeutron: 1e-5, time: 1 },
        kinetics: { enabled: true, ifpNGenerations: 4, numPrecursorGroups: 6, computeBetaEff: true }
    };
}

function ifpTally(id: number, score: string, bins: number[] = []): OpenMCTally {
    return { id, scores: [score], nuclides: [], filters: bins.length > 0 ? [{ type: 'delayedgroup', bins }] : [] };
}

function ifpTallies(): OpenMCTally[] {
    return [
        ifpTally(1, IFP_SCORES.timeNumerator),
        ifpTally(2, IFP_SCORES.betaNumerator, [1, 2, 3, 4, 5, 6]),
        ifpTally(3, IFP_SCORES.denominator)
    ];
}

interface SupportedCase {
    path: OpenMCSettingsPath;
    value: unknown;
    before: unknown;
    label: string;
}

const SUPPORTED_CASES: SupportedCase[] = [
    { path: 'run.particles', value: 2000, before: 1000, label: 'Particles per batch' },
    { path: 'run.inactive', value: 20, before: 10, label: 'Inactive batches' },
    { path: 'run.batches', value: 100, before: 50, label: 'Batches' },
    { path: 'seed', value: 42, before: 1, label: 'Random number seed' },
    { path: 'threads', value: 8, before: 4, label: 'OpenMP threads' },
    { path: 'verbosity', value: 8, before: 5, label: 'Verbosity' },
    { path: 'energyMode', value: 'multigroup', before: 'continuous-energy', label: 'Energy mode' },
    { path: 'photonTransport', value: true, before: false, label: 'Photon transport' },
    { path: 'electronTreatment', value: 'ttb', before: 'led', label: 'Electron treatment' },
    { path: 'atomicRelaxation', value: false, before: true, label: 'Atomic relaxation' },
    { path: 'sourceRejectionFraction', value: 0.25, before: 0.05, label: 'Source rejection fraction' }
];

describe('OpenMC settings edit paths', () => {
    it('lists exactly the supported run/settings paths', () => {
        expect(SUPPORTED_SETTINGS_PATHS).toEqual([
            'run.particles',
            'run.inactive',
            'run.batches',
            'seed',
            'threads',
            'verbosity',
            'energyMode',
            'photonTransport',
            'electronTreatment',
            'atomicRelaxation',
            'sourceRejectionFraction',
            'output.summary',
            'output.tallies',
            'output.path',
            'cutoff.energyNeutron',
            'cutoff.energyPhoton',
            'cutoff.time',
            'cutoff.timePhoton',
            'cutoff.weight',
            'cutoff.weightAvg',
            'kinetics.enabled',
            'kinetics.ifpNGenerations',
            'kinetics.numPrecursorGroups',
            'kinetics.computeBetaEff'
        ]);
        expect(isSettingsPath('run.particles')).toBe(true);
        expect(isSettingsPath('sources')).toBe(false);
    });

    it.each(SUPPORTED_CASES)('validates, reads, diffs, and applies $path', ({ path, value, before, label }) => {
        const settings = buildSettings();

        expect(validateSettingsChange(path, value, settings)).toBeUndefined();
        expect(settingsValue(settings, path)).toEqual(before);

        const changes = settingsChanges(settings, [{ path, value }]);
        expect(changes).toEqual([{ path, label, kind: 'update', before, after: value }]);

        const applied = applySettingsChanges(settings, [{ path, value }]);
        expect(settingsValue(applied, path)).toEqual(value);
        expect(settingsValue(settings, path)).toEqual(before);
        expect(applied).not.toBe(settings);
        expect(applied.run).not.toBe(settings.run);
        expect(applied.sources).toEqual([]);
    });

    it('rejects unknown and out-of-scope paths', () => {
        const settings = buildSettings();
        const paths = [
            'sources',
            'output.statepoint',
            'cutoff.electron',
            'kinetics.computeGenerationTime',
            'randomRay.sourceShape',
            'cmfd.enabled',
            'geometry.cells',
            'materials.0.name',
            'tallies.0.scores'
        ];

        for (const path of paths) {
            expect(validateSettingsChange(path, 1, settings)).toContain('not a supported OpenMC settings path');
            expect(() => settingsChanges(settings, [{ path, value: 1 }])).toThrow('not a supported OpenMC settings path');
            expect(() => applySettingsChanges(settings, [{ path, value: 1 }])).toThrow('not a supported OpenMC settings path');
            expect(settingsValue(settings, path)).toBeUndefined();
        }
    });

    it('accepts and diffs every advanced path', () => {
        const settings = buildAdvancedSettings();
        const cases: SupportedCase[] = [
            { path: 'output.summary', value: true, before: false, label: 'Write summary.h5' },
            { path: 'output.tallies', value: false, before: true, label: 'Write tallies.out' },
            { path: 'output.path', value: 'runs/next', before: 'runs/out', label: 'Output path' },
            { path: 'cutoff.energyNeutron', value: 1e-4, before: 1e-5, label: 'Neutron energy cutoff' },
            { path: 'cutoff.energyPhoton', value: 1e-3, before: undefined, label: 'Photon energy cutoff' },
            { path: 'cutoff.time', value: 2, before: 1, label: 'Neutron time cutoff' },
            { path: 'cutoff.timePhoton', value: 3, before: undefined, label: 'Photon time cutoff' },
            { path: 'cutoff.weight', value: 1e-38, before: undefined, label: 'Weight cutoff' },
            { path: 'cutoff.weightAvg', value: 4e-38, before: undefined, label: 'Average survival weight' },
            { path: 'kinetics.enabled', value: false, before: true, label: 'Kinetics (IFP)' },
            { path: 'kinetics.ifpNGenerations', value: 5, before: 4, label: 'IFP generations' },
            { path: 'kinetics.numPrecursorGroups', value: 8, before: 6, label: 'Precursor groups' },
            { path: 'kinetics.computeBetaEff', value: false, before: true, label: 'Compute beta-effective' }
        ];

        for (const testCase of cases) {
            const { path, value, before, label } = testCase;
            expect(validateSettingsChange(path, value, settings, { tallies: ifpTallies() })).toBeUndefined();
            expect(settingsValue(settings, path)).toEqual(before);
            expect(settingsChanges(settings, [{ path, value }], { tallies: ifpTallies() })).toEqual([
                { path, label, kind: 'update', before, after: value }
            ]);
        }
    });
});

describe('OpenMC settings edit validation', () => {
    it.each([
        ['run.particles', 0],
        ['run.particles', 1.5],
        ['run.particles', '1000'],
        ['run.batches', 0],
        ['run.batches', -4],
        ['seed', -1],
        ['seed', 2.5],
        ['threads', 0],
        ['threads', 3.2],
        ['verbosity', 0],
        ['verbosity', 11],
        ['verbosity', 2.5],
        ['energyMode', 'thermal'],
        ['photonTransport', 'true'],
        ['electronTreatment', 'bremsstrahlung'],
        ['atomicRelaxation', 1],
        ['sourceRejectionFraction', -0.01],
        ['sourceRejectionFraction', 1.01],
        ['sourceRejectionFraction', Number.NaN],
        ['sourceRejectionFraction', '0.5']
    ])('rejects %s = %s', (path, value) => {
        expect(validateSettingsChange(path, value, buildSettings())).toBeDefined();
    });

    it('accepts boundary values for integer ranges', () => {
        const settings = buildSettings();
        expect(validateSettingsChange('run.particles', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('run.inactive', 0, settings)).toBeUndefined();
        expect(validateSettingsChange('run.batches', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('seed', 0, settings)).toBeUndefined();
        expect(validateSettingsChange('threads', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('verbosity', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('verbosity', 10, settings)).toBeUndefined();
        expect(validateSettingsChange('sourceRejectionFraction', 0, settings)).toBeUndefined();
        expect(validateSettingsChange('sourceRejectionFraction', 1, settings)).toBeUndefined();
    });

    it('allows run.inactive only when the current run mode has inactive batches', () => {
        const eigenvalue = buildSettings();
        expect(validateSettingsChange('run.inactive', 5, eigenvalue)).toBeUndefined();

        const fixedSourceWithoutInactive = buildSettings();
        fixedSourceWithoutInactive.run = { mode: 'fixed source', particles: 100, batches: 10 };
        expect(validateSettingsChange('run.inactive', 5, fixedSourceWithoutInactive)).toContain('not available in the current run mode');

        const fixedSourceWithInactive = buildSettings();
        fixedSourceWithInactive.run = { mode: 'fixed source', particles: 100, batches: 10, inactive: 2 };
        expect(validateSettingsChange('run.inactive', 5, fixedSourceWithInactive)).toBeUndefined();

        const volume = buildSettings();
        volume.run = { mode: 'volume', samples: 100 };
        expect(validateSettingsChange('run.inactive', 0, volume)).toContain('not available in the current run mode');
        expect(() => settingsChanges(volume, [{ path: 'run.inactive', value: 0 }])).toThrow('not available in the current run mode');
    });

    it('rejects a value that would not change anything', () => {
        const settings = buildSettings();
        expect(() => settingsChanges(settings, [{ path: 'run.particles', value: 1000 }])).toThrow('already set to the requested value');
        expect(() => settingsChanges(settings, [{ path: 'photonTransport', value: false }])).toThrow('already set to the requested value');
    });

    it('builds labelled before/after diffs for several edits without mutating settings', () => {
        const settings = buildSettings();
        const changes = settingsChanges(settings, [
            { path: 'run.particles', value: 5000 },
            { path: 'sourceRejectionFraction', value: 0 }
        ]);

        expect(changes).toEqual([
            { path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 5000 },
            { path: 'sourceRejectionFraction', label: 'Source rejection fraction', kind: 'update', before: 0.05, after: 0 }
        ]);
        expect(settings.run).toEqual({ mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 });
    });

    it('deep-clones settings before applying and preserves untouched fields', () => {
        const settings = buildSettings();
        const original = JSON.parse(JSON.stringify(settings)) as OpenMCSettings;
        const applied = applySettingsChanges(settings, [
            { path: 'run.batches', value: 80 },
            { path: 'verbosity', value: 2 }
        ]);

        expect(applied).not.toBe(settings);
        expect(applied.run).not.toBe(settings.run);
        expect(applied.run).toEqual({ mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 80 });
        expect(applied.verbosity).toBe(2);
        expect(settings).toEqual(original);
    });
});

describe('OpenMC advanced settings validation', () => {
    it.each([
        ['output.summary', 'true'],
        ['output.tallies', 1],
        ['output.path', ''],
        ['output.path', '   '],
        ['output.path', 42],
        ['output.path', 'bad\u0000path'],
        ['output.path', 'x'.repeat(256)],
        ['cutoff.energyNeutron', 0],
        ['cutoff.energyNeutron', -1],
        ['cutoff.energyNeutron', Number.NaN],
        ['cutoff.energyNeutron', '1e-5'],
        ['cutoff.energyPhoton', 0],
        ['cutoff.energyPhoton', -2],
        ['cutoff.time', 0],
        ['cutoff.timePhoton', -1],
        ['cutoff.weight', 0],
        ['cutoff.weightAvg', Number.NaN],
        ['kinetics.enabled', 'true'],
        ['kinetics.computeBetaEff', 1],
        ['kinetics.ifpNGenerations', 0],
        ['kinetics.ifpNGenerations', -1],
        ['kinetics.ifpNGenerations', 1.5],
        ['kinetics.ifpNGenerations', '4'],
        ['kinetics.numPrecursorGroups', 0],
        ['kinetics.numPrecursorGroups', -1],
        ['kinetics.numPrecursorGroups', 1.5],
        ['kinetics.numPrecursorGroups', MAX_PRECURSOR_GROUPS + 1],
        ['kinetics.numPrecursorGroups', '6']
    ])('rejects %s = %s', (path, value) => {
        expect(validateSettingsChange(path, value, buildSettings(), { tallies: ifpTallies() })).toBeDefined();
    });

    it('accepts boundary values for advanced paths', () => {
        const settings = buildSettings();
        expect(validateSettingsChange('cutoff.energyNeutron', 1e-12, settings)).toBeUndefined();
        expect(validateSettingsChange('kinetics.ifpNGenerations', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('kinetics.ifpNGenerations', 10, settings)).toBeUndefined();
        expect(validateSettingsChange('kinetics.numPrecursorGroups', 1, settings)).toBeUndefined();
        expect(validateSettingsChange('kinetics.numPrecursorGroups', MAX_PRECURSOR_GROUPS, settings)).toBeUndefined();
        expect(validateSettingsChange('output.path', 'x'.repeat(255), settings)).toBeUndefined();
        expect(validateSettingsChange('output.path', 'runs/summary', settings)).toBeUndefined();
        expect(validateSettingsChange('kinetics.enabled', true, settings, { tallies: ifpTallies() })).toBeUndefined();
    });

    it('requires the IFP tallies the dashboard generates before enabling kinetics', () => {
        const settings = buildSettings();
        const missing = validateSettingsChange('kinetics.enabled', true, settings, { tallies: [] });
        expect(missing).toContain('IFP tallies');
        expect(missing).toContain(IFP_SCORES.timeNumerator);
        expect(missing).toContain(IFP_SCORES.betaNumerator);
        expect(missing).toContain(IFP_SCORES.denominator);

        const timeOnly = validateSettingsChange('kinetics.enabled', true, settings, {
            tallies: [ifpTally(1, IFP_SCORES.timeNumerator)]
        });
        expect(timeOnly).toContain(IFP_SCORES.betaNumerator);
        expect(timeOnly).toContain(IFP_SCORES.denominator);

        expect(() => settingsChanges(settings, [{ path: 'kinetics.enabled', value: true }], { tallies: [] })).toThrow(
            'requires the IFP tallies'
        );
        expect(
            settingsChanges(
                settings,
                [
                    { path: 'kinetics.enabled', value: true },
                    { path: 'kinetics.computeBetaEff', value: false }
                ],
                { tallies: [ifpTally(1, IFP_SCORES.timeNumerator), ifpTally(2, IFP_SCORES.denominator)] }
            )
        ).toHaveLength(2);
    });

    it('enforces ifpNGenerations at or below run.inactive in both directions', () => {
        const settings = buildSettings();
        expect(() => settingsChanges(settings, [{ path: 'kinetics.ifpNGenerations', value: 11 }])).toThrow('must not exceed run.inactive');
        expect(() => settingsChanges(settings, [{ path: 'kinetics.ifpNGenerations', value: 10 }])).not.toThrow();

        const enabled = buildAdvancedSettings();
        expect(() => settingsChanges(enabled, [{ path: 'run.inactive', value: 3 }])).toThrow('must not exceed run.inactive');
        expect(() => settingsChanges(enabled, [{ path: 'run.inactive', value: 4 }])).not.toThrow();

        expect(
            validateSettingsChanges(settings, [
                { path: 'kinetics.ifpNGenerations', value: 8 },
                { path: 'run.inactive', value: 5 }
            ])
        ).toContain('must not exceed run.inactive');
    });

    it('rejects a nested value that would not change anything', () => {
        const settings = buildAdvancedSettings();
        expect(() => settingsChanges(settings, [{ path: 'output.summary', value: false }])).toThrow('already set to the requested value');
        expect(() => settingsChanges(settings, [{ path: 'cutoff.energyNeutron', value: 1e-5 }])).toThrow(
            'already set to the requested value'
        );
        expect(() => settingsChanges(settings, [{ path: 'kinetics.enabled', value: true }], { tallies: ifpTallies() })).toThrow(
            'already set to the requested value'
        );
    });

    it('applies nested paths without replacing unrelated keys', () => {
        const settings = buildAdvancedSettings();
        const original = JSON.parse(JSON.stringify(settings)) as OpenMCSettings;
        const applied = applySettingsChanges(settings, [
            { path: 'output.summary', value: true },
            { path: 'cutoff.energyNeutron', value: 1e-4 },
            { path: 'kinetics.enabled', value: false }
        ]);

        expect(applied).not.toBe(settings);
        expect(applied.output).toEqual({ summary: true, tallies: true, path: 'runs/out' });
        expect(applied.output).not.toBe(settings.output);
        expect(applied.cutoff).toEqual({ energyNeutron: 1e-4, time: 1 });
        expect(applied.kinetics).toEqual({ enabled: false, ifpNGenerations: 4, numPrecursorGroups: 6, computeBetaEff: true });
        expect(settings).toEqual(original);
    });

    it('builds a top-level patch that preserves unrelated nested keys for undo', () => {
        const settings = buildAdvancedSettings();
        const patch = settingsUpdatePatch(settings, [
            { path: 'output.summary', value: false },
            { path: 'cutoff.energyNeutron', value: 1e-6 },
            { path: 'kinetics.enabled', value: true }
        ]);

        expect(Object.keys(patch).sort()).toEqual(['cutoff', 'kinetics', 'output']);
        expect(patch.output).toEqual({ summary: false, tallies: true, path: 'runs/out' });
        expect(patch.cutoff).toEqual({ energyNeutron: 1e-6, time: 1 });
        expect(patch.kinetics).toEqual({ enabled: true, ifpNGenerations: 4, numPrecursorGroups: 6, computeBetaEff: true });
    });
});

describe('OpenMC settings equality', () => {
    it('compares primitives, arrays, and objects for stale checks', () => {
        expect(settingsEqual(1, 1)).toBe(true);
        expect(settingsEqual(1, 2)).toBe(false);
        expect(settingsEqual(undefined, undefined)).toBe(true);
        expect(settingsEqual(undefined, null)).toBe(false);
        expect(settingsEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(settingsEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(settingsEqual([1, 2], [2, 1])).toBe(false);
        expect(settingsEqual({ a: undefined }, {})).toBe(true);
        expect(settingsEqual({ a: undefined }, { a: 1 })).toBe(false);
        expect(settingsEqual({ run: { particles: 1 } }, { run: { particles: 1, inactive: undefined } })).toBe(true);
    });
});
