import { describe, it, expect } from 'vitest';
import { OpenMCShutdownDoseConfig, OpenMCState } from './openmc-state-schema';
import {
    assessShutdownDoseReadiness,
    createDefaultShutdownDoseConfig,
    createDoseTally,
    getPhotonTallies,
    isPhotonTally,
    normalizeShutdownDoseSchedule,
    parseShutdownDoseTimestep,
    regularMeshesOverlap
} from './shutdown-dose';
import { generateShutdownDosePythonDriver } from './shutdown-dose-python';

function makeState(config?: OpenMCShutdownDoseConfig): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Dose', created: now, modified: now },
        geometry: {
            surfaces: [],
            cells: [
                { id: 1, name: 'fuel', fillType: 'material', fillId: 1, volume: 12.5 },
                { id: 2, name: 'void', fillType: 'void' }
            ],
            universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [{ id: 1, name: 'fuel', density: 10, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 2 },
            sources: [{ spatial: { type: 'point', origin: [0, 0, 0] }, energy: { type: 'discrete', energies: [1e6] } }],
            sourceRejectionFraction: 0.05
        },
        tallies: [
            {
                id: 7,
                name: 'photon flux',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [{ type: 'particle', bins: [2] }]
            }
        ],
        meshes: [
            { id: 3, type: 'regular', lowerLeft: [0, 0, 0], upperRight: [1, 1, 1], dimension: [2, 2, 2] },
            { id: 4, type: 'regular', lowerLeft: [2, 0, 0], upperRight: [3, 1, 1], dimension: [2, 2, 2] },
            { id: 5, type: 'regular', lowerLeft: [0.5, 0, 0], upperRight: [1.5, 1, 1], dimension: [2, 2, 2] }
        ],
        shutdownDose: config
    };
}

function r2sConfig(overrides: Partial<OpenMCShutdownDoseConfig> = {}): OpenMCShutdownDoseConfig {
    return {
        method: 'r2s',
        domainType: 'cell',
        cellIds: [1],
        timesteps: [1],
        timestepUnits: 'd',
        sourceRates: [1e15],
        chainFile: '/data/chain.xml',
        outputDirectory: '/tmp/dose',
        workingDirectory: '/tmp/dose',
        photonTallyIds: [7],
        ...overrides
    };
}

describe('shutdown-dose schedule helpers', () => {
    it('parses numeric and unit-bearing timesteps', () => {
        expect(parseShutdownDoseTimestep(2, 'h')).toEqual({ value: 2, unit: 'h' });
        expect(parseShutdownDoseTimestep('3 d', 's')).toEqual({ value: 3, unit: 'd' });
        expect(parseShutdownDoseTimestep('1.5 min', 's')).toEqual({ value: 1.5, unit: 'min' });
        expect(parseShutdownDoseTimestep('0 d', 's')).toBeUndefined();
        expect(parseShutdownDoseTimestep('abc', 's')).toBeUndefined();
    });

    it('normalizes mixed timesteps and source rates', () => {
        const config = r2sConfig({ timesteps: [1, '2 h'], sourceRates: [1e15, 0] });
        const { schedule, errors } = normalizeShutdownDoseSchedule(config);
        expect(errors).toEqual([]);
        expect(schedule).toHaveLength(2);
        expect(schedule[0].seconds).toBe(86400);
        expect(schedule[1].seconds).toBe(7200);
        expect(schedule[1].sourceRate).toBe(0);
    });

    it('reports source-rate length mismatches', () => {
        const { errors } = normalizeShutdownDoseSchedule(r2sConfig({ timesteps: [1, 1], sourceRates: [1e15] }));
        expect(errors.join(' ')).toMatch(/must match/);
    });
});

describe('shutdown-dose readiness', () => {
    it('accepts a complete cell-based R2S configuration', () => {
        const state = makeState(r2sConfig());
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.ready).toBe(true);
        expect(readiness.errors).toEqual([]);
        expect(readiness.warnings.some((issue) => issue.field === 'domains')).toBe(true);
    });

    it('blocks cells without a volume and tallies without a photon filter', () => {
        const state = makeState(r2sConfig({ photonTallyIds: [9] }));
        state.geometry.cells[0].volume = undefined;
        state.tallies.push({ id: 9, scores: ['flux'], nuclides: ['total'], filters: [] });
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.ready).toBe(false);
        expect(readiness.errors.map((issue) => issue.message).join(' ')).toMatch(/no volume/i);
        expect(readiness.errors.map((issue) => issue.message).join(' ')).toMatch(/does not target photons/i);
    });

    it('requires a chain file and photon tallies', () => {
        const state = makeState(r2sConfig({ chainFile: undefined, photonTallyIds: [] }));
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.ready).toBe(false);
        expect(readiness.errors.map((issue) => issue.field)).toEqual(expect.arrayContaining(['chain', 'tallies']));
    });

    it('warns about overlapping regular meshes', () => {
        const state = makeState(r2sConfig({ domainType: 'mesh', cellIds: undefined, meshIds: [3, 4, 5] }));
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.warnings.some((issue) => /overlapping bounds/.test(issue.message))).toBe(true);
    });

    it('validates the D1S time index', () => {
        const state = makeState(r2sConfig({ method: 'd1s', domainType: undefined, cellIds: undefined, d1sTimeIndex: 99 }));
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.ready).toBe(false);
        expect(readiness.errors.some((issue) => issue.field === 'd1s')).toBe(true);
    });

    it('blocks R2S on eigenvalue models', () => {
        const state = makeState(r2sConfig());
        state.settings.run = { mode: 'eigenvalue', particles: 100, inactive: 2, batches: 5 };
        const readiness = assessShutdownDoseReadiness(state);
        expect(readiness.errors.some((issue) => issue.field === 'method')).toBe(true);
    });
});

describe('shutdown-dose tally helpers', () => {
    it('detects photon tallies and lists them', () => {
        const state = makeState();
        expect(isPhotonTally(state.tallies[0])).toBe(true);
        expect(getPhotonTallies(state)).toHaveLength(1);
    });

    it('creates an energy-function dose tally from supplied coefficients', () => {
        const tally = createDoseTally(
            12,
            { dataSource: 'icrp116', doseQuantity: 'effective', geometry: 'AP', interpolation: 'log-log' },
            [1e-5, 1, 2e7],
            [1, 2, 3],
            4
        );
        expect(tally.id).toBe(12);
        expect(tally.scores).toEqual(['flux']);
        expect(tally.filters[0]).toEqual({ type: 'particle', bins: [2] });
        expect(tally.filters[1]).toMatchObject({ type: 'energyfunction', energyValues: [1e-5, 1, 2e7], responseValues: [1, 2, 3] });
        expect(tally.filters[2]).toEqual({ type: 'mesh', bins: [], meshId: 4 });
    });

    it('detects overlapping and disjoint regular meshes', () => {
        const state = makeState();
        expect(regularMeshesOverlap(state.meshes[0] as any, state.meshes[1] as any)).toBe(false);
        expect(regularMeshesOverlap(state.meshes[0] as any, state.meshes[2] as any)).toBe(true);
    });

    it('seeds defaults from the project', () => {
        const state = makeState();
        state.depletion = { enabled: true, chainFile: '/data/chain.xml', timeSteps: [1] };
        const config = createDefaultShutdownDoseConfig(state);
        expect(config.method).toBe('r2s');
        expect(config.chainFile).toBe('/data/chain.xml');
        expect(config.photonTallyIds).toEqual([7]);
    });
});

describe('shutdown-dose Python export', () => {
    it('emits an equivalent R2S driver', () => {
        const lines = generateShutdownDosePythonDriver(r2sConfig({ byParentNuclide: true, matVolSamples: 5000 })).join('\n');
        expect(lines).toContain('openmc.deplete.R2SManager');
        expect(lines).toContain('r2s.photon_model.tallies = openmc.Tallies([tally_7])');
        expect(lines).toContain('chain_file="/data/chain.xml"');
        expect(lines).toContain('by_parent_nuclide=True');
        expect(lines).toContain("mat_vol_kwargs={'n_samples': 5000}");
    });

    it('emits an equivalent D1S driver', () => {
        const lines = generateShutdownDosePythonDriver(
            r2sConfig({ method: 'd1s', photonTallyIds: [7], d1sTimeIndex: -1, d1sSumNuclides: true })
        ).join('\n');
        expect(lines).toContain('from openmc.deplete import d1s');
        expect(lines).toContain('model.settings.use_decay_photons = True');
        expect(lines).toContain('d1s.prepare_tallies(model, d1s_nuclides, chain_file="/data/chain.xml")');
        expect(lines).toContain('sum_nuclides=True');
    });
});
