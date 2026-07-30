/**
 * Schema migration support for `.nuke-openmc` project files.
 *
 * Project files carry a schema `version`. When the state schema evolves, add a
 * migration step to {@link MIGRATIONS} keyed by the version it upgrades FROM and
 * bump `OPENMC_STATE_SCHEMA_VERSION`. Loading runs the steps in sequence until
 * the file reaches the current version, so any older file can chain forward.
 *
 * @module openmc-studio/common
 */

import { OpenMCProjectFile, OPENMC_STATE_SCHEMA_VERSION } from './openmc-state-schema';

/** A single migration step: upgrades a project file from one schema version to the next. */
export type ProjectMigrationStep = (project: OpenMCProjectFile) => OpenMCProjectFile;

/**
 * Ordered migration steps keyed by the version they upgrade FROM.
 * Each step must return the project file stamped with the NEXT version.
 */
const MIGRATIONS: Record<string, ProjectMigrationStep> = {
    // 1.0.0 -> 1.1.0: Phase 5 foundation. No field changes yet — the bump
    // establishes the migration hook before Phase 5 workstreams extend the schema.
    '1.0.0': (project) => ({
        ...project,
        version: '1.1.0',
        state: {
            ...project.state,
            metadata: {
                ...project.state.metadata,
                version: '1.1.0'
            }
        }
    })
};

/** Result of {@link migrateProjectFile}. */
export interface ProjectMigrationResult {
    /** The project file at the current schema version. */
    project: OpenMCProjectFile;
    /** The original version, when a migration was applied. */
    migratedFrom?: string;
}

/**
 * Migrate a loaded project file to the current schema version.
 *
 * @param project - Project file as parsed from disk.
 * @returns The migrated project and the original version if a migration ran.
 * @throws Error when the file's version has no migration path (too old or newer than this build).
 */
export function migrateProjectFile(project: OpenMCProjectFile): ProjectMigrationResult {
    if (project.version === OPENMC_STATE_SCHEMA_VERSION) {
        return { project };
    }

    const from = project.version;
    let current = project;
    let guard = 0;

    while (current.version !== OPENMC_STATE_SCHEMA_VERSION) {
        const step = MIGRATIONS[current.version];
        if (!step) {
            throw new Error(
                `Unsupported .nuke-openmc schema version '${current.version}' (this build supports up to ${OPENMC_STATE_SCHEMA_VERSION})`
            );
        }
        current = step(current);
        if (++guard > 20) {
            throw new Error('Project schema migration did not converge (migration loop detected)');
        }
    }

    return { project: current, migratedFrom: from };
}
