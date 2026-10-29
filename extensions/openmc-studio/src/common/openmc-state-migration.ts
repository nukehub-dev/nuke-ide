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

import { OpenMCProjectFile, OpenMCSource, OPENMC_STATE_SCHEMA_VERSION } from './openmc-state-schema';
import { normalizeGeometryForLoad } from './geometry-lattices';
import { normalizeLegacySource } from './source-utils';
import { migrateLegacyVarianceReduction } from './variance-reduction';

/** A single migration step: upgrades a project file from one schema version to the next. */
export type ProjectMigrationStep = (project: OpenMCProjectFile) => OpenMCProjectFile;

/**
 * Ordered migration steps keyed by the version they upgrade FROM.
 * Each step must return the project file stamped with the NEXT version.
 */
const MIGRATIONS: Record<string, ProjectMigrationStep> = {
    // 1.0.0 -> 1.1.0: migration hook bump with no field changes yet.
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
    }),
    // 1.1.0 -> 1.2.0: all fields added by the coverage workstreams are optional
    // with safe defaults, so only the version stamps change.
    '1.1.0': (project) => ({
        ...project,
        version: '1.2.0',
        state: {
            ...project.state,
            metadata: {
                ...project.state.metadata,
                version: '1.2.0'
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
    /** Non-fatal normalization notes (retired fields that were converted or dropped). */
    warnings?: string[];
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
        return normalizeProjectFile(project);
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

    return { ...normalizeProjectFile(current), migratedFrom: from };
}

/**
 * Canonicalize representation that is not tied to a schema version bump:
 * retired lattice types/fields, the root-universe flags, legacy source
 * time/angle shapes, and the single-set/sourceBiasing variance-reduction
 * shapes are normalized on every load, so old projects open unchanged and keep
 * round-tripping.
 * @param project - Parsed project file.
 * @returns Normalized project and non-fatal migration warnings.
 */
function normalizeProjectFile(project: OpenMCProjectFile): ProjectMigrationResult {
    const sources = (project.state?.settings?.sources ?? []).map((source: OpenMCSource) => normalizeLegacySource(source));
    const vrMigration = migrateLegacyVarianceReduction(project.state?.varianceReduction, sources);
    const state = {
        ...project.state,
        geometry: project.state?.geometry ? normalizeGeometryForLoad(project.state.geometry) : project.state?.geometry,
        settings: {
            ...project.state.settings,
            sources: vrMigration.sources
        },
        varianceReduction: vrMigration.varianceReduction
    };
    return {
        project: { ...project, state },
        warnings: vrMigration.warnings.length > 0 ? vrMigration.warnings : undefined
    };
}
