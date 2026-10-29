import { describe, expect, it, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from './python-exporter';
import { OpenMCState } from '../../common/openmc-state-schema';
import { DEFAULT_OPENMC_COMPAT, OpenMCCompat } from '../../common/openmc-studio-protocol';

const GENERALIZED_COMPAT: OpenMCCompat = {
    ...DEFAULT_OPENMC_COMPAT,
    generalizedParticles: true,
    particleProductionFilter: true
};
const RELEASE_COMPAT: OpenMCCompat = { ...DEFAULT_OPENMC_COMPAT, generalizedParticles: false };

const HE4 = { name: 'He4', pdg: 1000020040 };
const ELECTRON = { name: 'electron', pdg: 11 };
const PHOTON = { name: 'photon', pdg: 22 };
const NEUTRON = { name: 'neutron', pdg: 2112 };

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.2.0', name: 'Particles', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 2 },
            sources: [
                {
                    spatial: { type: 'point', origin: [0, 0, 0] },
                    energy: { type: 'discrete', energies: [2e6] },
                    particle: HE4
                }
            ]
        },
        tallies: [
            {
                id: 1,
                scores: ['flux'],
                nuclides: ['total'],
                filters: [{ type: 'particle', bins: [], particleBins: [ELECTRON, PHOTON, HE4] }]
            },
            {
                id: 2,
                scores: ['events'],
                nuclides: ['total'],
                filters: [
                    {
                        type: 'particleproduction',
                        bins: [],
                        particleTypes: [HE4, PHOTON],
                        productionEnergyBins: [0, 2e7]
                    }
                ]
            }
        ],
        meshes: [{ type: 'regular', id: 5, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [2, 2, 2] }],
        varianceReduction: {
            weightWindows: [{ id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7], particleType: PHOTON }],
            weightWindowGenerator: { particleType: NEUTRON }
        },
        plots: []
    };
}

describe('Python exporter particle snapshots', () => {
    it('emits canonical particle names for sources, filters, production, and weight windows', () => {
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(
            buildState(),
            { mode: 'single', includeComments: false, includeShebang: false, compat: GENERALIZED_COMPAT }
        );
        expect(script).toContain('source_0.particle = "He4"');
        expect(script).toContain('filter_1_0 = openmc.ParticleFilter(["electron", "photon", "He4"])');
        expect(script).toContain('filter_2_0 = openmc.ParticleProductionFilter(["He4", "photon"], energies=[0, 20000000])');
        expect(script).toContain('particle_type="photon"');
        expect(script).toContain('particle_type="neutron"');
    });

    it('falls back and omits unsupported particles on release environments', () => {
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(
            buildState(),
            { mode: 'single', includeComments: false, includeShebang: false, compat: RELEASE_COMPAT }
        );
        expect(script).toContain('source_0.particle = "neutron"');
        expect(script).toContain('# Source particle "He4" requires OpenMC 0.16 or newer; wrote neutron instead');
        expect(script).toContain('filter_1_0 = openmc.ParticleFilter(["electron", "photon"])');
        expect(script).toContain("particle filter bins 'He4' require OpenMC 0.16 or newer and were omitted");
    });
});
