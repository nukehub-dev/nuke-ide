import { describe, it, expect } from 'vitest';
import { OpenMCProjectFile, OPENMC_STATE_SCHEMA_VERSION } from './openmc-state-schema';
import { migrateProjectFile } from './openmc-state-migration';

function makeProject(version: string): OpenMCProjectFile {
    return {
        version,
        state: {
            metadata: {
                version,
                name: 'Test Project',
                description: '',
                created: '2026-01-01T00:00:00.000Z',
                modified: '2026-01-01T00:00:00.000Z'
            },
            geometry: {
                surfaces: [],
                cells: [],
                universes: [{ id: 0, name: 'root', cellIds: [] }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [],
            settings: {
                run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 100 },
                sources: [],
                sourceRejectionFraction: 0
            },
            tallies: [],
            meshes: []
        }
    } as OpenMCProjectFile;
}

describe('migrateProjectFile', () => {
    it('passes through a file already at the current version', () => {
        const project = makeProject(OPENMC_STATE_SCHEMA_VERSION);
        const result = migrateProjectFile(project);
        expect(result.migratedFrom).toBeUndefined();
        expect(result.project).toEqual(project);
    });

    it('migrates a 1.0.0 file to the current version, preserving state', () => {
        const project = makeProject('1.0.0');
        const stateBefore = JSON.parse(JSON.stringify(project.state));

        const result = migrateProjectFile(project);

        expect(result.migratedFrom).toBe('1.0.0');
        expect(result.project.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
        expect(result.project.state.metadata.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
        // No field changes across the no-op migration chain: everything except the version stamps is identical
        const migratedState = JSON.parse(JSON.stringify(result.project.state));
        migratedState.metadata.version = '1.0.0';
        expect(migratedState).toEqual(stateBefore);
    });

    it('rejects a version with no migration path', () => {
        expect(() => migrateProjectFile(makeProject('0.9.0'))).toThrow(/Unsupported .nuke-openmc schema version/);
    });

    it('rejects a file newer than this build', () => {
        expect(() => migrateProjectFile(makeProject('99.0.0'))).toThrow(/Unsupported .nuke-openmc schema version/);
    });

    it('normalizes legacy lattice representation on load', () => {
        const project = makeProject(OPENMC_STATE_SCHEMA_VERSION);
        project.state.geometry.lattices = [
            {
                id: 7,
                type: 'x-hex',
                rings: 2,
                center: [0, 0],
                pitch: [1],
                universes: [[[1, 1, 1, 1, 1, 1], [1]]]
            } as unknown as OpenMCProjectFile['state']['geometry']['lattices'][number]
        ];
        const result = migrateProjectFile(project);
        expect(result.project.state.geometry.lattices[0]).toMatchObject({ type: 'hex', orientation: 'x' });
    });
});

describe('source shape normalization', () => {
    it('converts legacy time/angle params on current-version files', () => {
        const project = makeProject(OPENMC_STATE_SCHEMA_VERSION);
        project.state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'discrete', energies: [1e6] },
                angle: { type: 'polar-azimuthal', params: { mu: 1, phi: 0 } },
                time: { type: 'uniform', params: { min: 0, max: 1e-3 } }
            }
        ] as any;
        const result = migrateProjectFile(project);
        const source = result.project.state.settings.sources[0] as any;
        expect(source.time).toEqual({ type: 'uniform', min: 0, max: 1e-3 });
        expect(source.angle).toMatchObject({
            type: 'mu-phi',
            mu: { type: 'discrete', energies: [1], probabilities: [1] },
            phi: { type: 'discrete', energies: [0], probabilities: [1] }
        });
    });
});

describe('variance-reduction normalization', () => {
    it('migrates a single weight-window object and the retired source-biasing control', () => {
        const project = makeProject(OPENMC_STATE_SCHEMA_VERSION);
        project.state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'uniform', min: 1e5, max: 2e7 }
            }
        ];
        project.state.varianceReduction = {
            weightWindows: { meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] } as any,
            sourceBiasing: { energyBias: { type: 'uniform', min: 1e6, max: 1.4e7 } }
        };

        const result = migrateProjectFile(project);
        const vr = result.project.state.varianceReduction;
        expect(vr?.weightWindows).toEqual([{ id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] }]);
        expect(vr?.weightWindowsOn).toBe(true);
        expect(vr?.sourceBiasing).toBeUndefined();
        const source = result.project.state.settings.sources[0] as any;
        expect(source.energy.bias).toEqual({ distribution: { type: 'uniform', min: 1e6, max: 1.4e7 } });
        expect(result.warnings?.some((warning) => warning.includes('source-biasing control'))).toBe(true);
    });

    it('leaves an unbiased current project without warnings', () => {
        const project = makeProject(OPENMC_STATE_SCHEMA_VERSION);
        const result = migrateProjectFile(project);
        expect(result.warnings).toBeUndefined();
        expect(result.project.state.varianceReduction).toBeUndefined();
    });
});
