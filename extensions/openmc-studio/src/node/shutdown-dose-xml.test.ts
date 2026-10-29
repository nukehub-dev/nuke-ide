/**
 * XML boundary tests for the shutdown-dose configuration:
 * - driver-only fields never leak into settings.xml/tallies.xml;
 * - cell volumes round-trip through geometry.xml (required by cell-based R2S).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from './xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCState } from '../common/openmc-state-schema';
import { migrateProjectFile } from '../common/openmc-state-migration';
import { OPENMC_STATE_SCHEMA_VERSION } from '../common/openmc-state-schema';

function makeState(): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: OPENMC_STATE_SCHEMA_VERSION, name: 'Dose XML', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 5 }, boundary: 'vacuum' }],
            cells: [{ id: 1, name: 'activation cell', fillType: 'material', fillId: 1, regionString: '-1', volume: 523.6 }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'iron',
                density: 7.87,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'Fe56', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 2 },
            sources: [{ spatial: { type: 'point', origin: [0, 0, 0] }, energy: { type: 'discrete', energies: [1e6] } }],
            sourceRejectionFraction: 0.05
        },
        tallies: [],
        meshes: [],
        shutdownDose: {
            method: 'r2s',
            domainType: 'cell',
            cellIds: [1],
            timesteps: [1],
            timestepUnits: 'd',
            sourceRates: [1e15],
            chainFile: '/data/chain.xml',
            outputDirectory: '/tmp/dose',
            workingDirectory: '/tmp/dose',
            photonTallyIds: [1]
        }
    };
}

function tmpDirectory(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-dose-xml-'));
}

describe('shutdown-dose XML boundary', () => {
    it('keeps driver-only fields out of settings.xml and tallies.xml', async () => {
        const directory = tmpDirectory();
        const service = new XMLGenerationService();
        const result = await service.generateXML({
            state: makeState(),
            outputDirectory: directory,
            files: { materials: true, settings: true, geometry: true, tallies: true, plots: false }
        });
        expect(result.success).toBe(true);

        const settings = fs.readFileSync(path.join(directory, 'settings.xml'), 'utf-8');
        const tallies = fs.existsSync(path.join(directory, 'tallies.xml'))
            ? fs.readFileSync(path.join(directory, 'tallies.xml'), 'utf-8')
            : '';
        expect(settings).not.toMatch(/shutdown/i);
        expect(settings).not.toMatch(/decay_photons/i);
        expect(settings).not.toMatch(/d1s/i);
        expect(tallies).not.toMatch(/shutdown/i);
    });

    it('writes and imports the cell volume required by R2S activation', async () => {
        const directory = tmpDirectory();
        const state = makeState();
        const generator = new XMLGenerationService();
        const generated = await generator.generateXML({
            state,
            outputDirectory: directory,
            files: { materials: true, settings: true, geometry: true, tallies: false, plots: false }
        });
        expect(generated.success).toBe(true);

        const geometry = fs.readFileSync(path.join(directory, 'geometry.xml'), 'utf-8');
        expect(geometry).toContain('volume="523.6"');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory });
        expect(imported.success).toBe(true);
        expect(imported.state?.geometry.cells.find((cell) => cell.id === 1)?.volume).toBe(523.6);
    });

    it('preserves the shutdown-dose configuration through project migration', () => {
        const state = makeState();
        const project = {
            version: OPENMC_STATE_SCHEMA_VERSION,
            state
        };
        const migrated = migrateProjectFile(project as any);
        expect(migrated.project.state.shutdownDose).toEqual(state.shutdownDose);
    });
});
