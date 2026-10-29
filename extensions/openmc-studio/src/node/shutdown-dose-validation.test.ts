/**
 * Backend-side shutdown-dose validation: filesystem checks layered on the pure
 * readiness rules (chain exists, run directory exists).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenMCRunnerService } from './openmc-runner-service';
import { OpenMCShutdownDoseConfig, OpenMCState } from '../common/openmc-state-schema';

function makeState(config: OpenMCShutdownDoseConfig): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Dose', created: now, modified: now },
        geometry: {
            surfaces: [],
            cells: [{ id: 1, fillType: 'material', fillId: 1, volume: 1 }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [{ id: 1, name: 'iron', density: 1, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }],
        settings: {
            run: { mode: 'fixed source', particles: 10, batches: 1 },
            sources: [{ spatial: { type: 'point', origin: [0, 0, 0] }, energy: { type: 'discrete', energies: [1e6] } }],
            sourceRejectionFraction: 0
        },
        tallies: [{ id: 1, scores: ['flux'], nuclides: ['total'], filters: [{ type: 'particle', bins: [2] }] }],
        meshes: [],
        shutdownDose: config
    };
}

function makeConfig(directory: string, chain: string): OpenMCShutdownDoseConfig {
    return {
        method: 'r2s',
        domainType: 'cell',
        cellIds: [1],
        timesteps: [1],
        timestepUnits: 'd',
        sourceRates: [1e15],
        chainFile: chain,
        photonTallyIds: [1],
        outputDirectory: directory,
        workingDirectory: directory
    };
}

describe('OpenMCRunnerService.validateShutdownDose', () => {
    it('accepts an existing chain and run directory', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-dose-validate-'));
        const chain = path.join(directory, 'chain.xml');
        fs.writeFileSync(chain, '<depletion_chain/>');
        const service = new OpenMCRunnerService();
        const result = await service.validateShutdownDose({
            state: makeState(makeConfig(directory, chain)),
            config: makeConfig(directory, chain)
        });
        expect(result.success).toBe(true);
        expect(result.ready).toBe(true);
    });

    it('reports a missing chain file and run directory', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-dose-validate-'));
        const missingChain = path.join(directory, 'missing-chain.xml');
        const missingDirectory = path.join(directory, 'missing-run');
        const config = makeConfig(missingDirectory, missingChain);
        const service = new OpenMCRunnerService();
        const result = await service.validateShutdownDose({ state: makeState(config), config });
        expect(result.ready).toBe(false);
        expect(result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.field)).toEqual(
            expect.arrayContaining(['chain', 'output'])
        );
    });
});
