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
                universes: [{ id: 0, name: 'root', cellIds: [], isRoot: true }],
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
        expect(result.project).toBe(project);
    });

    it('migrates a 1.0.0 file to the current version, preserving state', () => {
        const project = makeProject('1.0.0');
        const stateBefore = JSON.parse(JSON.stringify(project.state));

        const result = migrateProjectFile(project);

        expect(result.migratedFrom).toBe('1.0.0');
        expect(result.project.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
        expect(result.project.state.metadata.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
        // No field changes in 1.0.0 -> 1.1.0: everything except the version stamps is identical
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
});
