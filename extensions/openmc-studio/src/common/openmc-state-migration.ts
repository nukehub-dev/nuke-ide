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

import { OpenMCProjectFile, OpenMCSource, OpenMCTallyFilter, OPENMC_STATE_SCHEMA_VERSION } from './openmc-state-schema';
import { normalizeGeometryForLoad } from './geometry-lattices';
import { normalizeLegacySource } from './source-utils';
import { migrateLegacyVarianceReduction } from './variance-reduction';
import { normalizeParticleType, particleFromLegacyBin } from './particle-types';

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
    const sources = (project.state?.settings?.sources ?? []).map((source: OpenMCSource) =>
        normalizeSourceParticles(normalizeLegacySource(source))
    );
    const vrMigration = migrateLegacyVarianceReduction(project.state?.varianceReduction, sources);
    const state = {
        ...project.state,
        geometry: project.state?.geometry ? normalizeGeometryForLoad(project.state.geometry) : project.state?.geometry,
        settings: {
            ...project.state.settings,
            sources: vrMigration.sources
        },
        tallies: (project.state?.tallies ?? []).map((tally) => ({
            ...tally,
            filters: (tally.filters ?? []).map(normalizeFilterParticles)
        })),
        varianceReduction: normalizeVarianceReductionParticles(vrMigration.varianceReduction)
    };
    return {
        project: { ...project, state },
        warnings: vrMigration.warnings.length > 0 ? vrMigration.warnings : undefined
    };
}

/** Normalize a source's particle string/legacy value to the shared model. */
function normalizeSourceParticles(source: OpenMCSource): OpenMCSource {
    const particle = normalizeParticleType((source as { particle?: unknown }).particle);
    const next = { ...source } as OpenMCSource & { particle?: ReturnType<typeof normalizeParticleType> };
    if (particle) {
        next.particle = particle;
    } else {
        delete next.particle;
    }
    if (next.type === 'mesh') {
        const meshSource = next as OpenMCSource & { sources: OpenMCSource[] };
        meshSource.sources = meshSource.sources.map(normalizeSourceParticles);
    }
    return next;
}

/** Normalize a tally filter's particle fields to the shared model. */
function normalizeFilterParticles(filter: OpenMCTallyFilter): OpenMCTallyFilter {
    const next: OpenMCTallyFilter = { ...filter };
    if (filter.type === 'particle') {
        if (filter.particleBins && filter.particleBins.length > 0) {
            next.particleBins = filter.particleBins.map((value) => normalizeParticleType(value) ?? { name: value.name });
        } else {
            const derived = filter.bins
                .map((bin) => particleFromLegacyBin(bin))
                .filter((particle): particle is NonNullable<typeof particle> => particle !== undefined);
            next.particleBins = derived;
        }
    }
    if (filter.type === 'particleproduction' && filter.particleTypes) {
        next.particleTypes = filter.particleTypes.map(
            (value) => normalizeParticleType(value) ?? { name: (value as { name?: string }).name ?? String(value) }
        );
    }
    return next;
}

/** Normalize weight-window and generator particle types to the shared model. */
function normalizeVarianceReductionParticles(
    varianceReduction: OpenMCProjectFile['state']['varianceReduction']
): OpenMCProjectFile['state']['varianceReduction'] {
    if (!varianceReduction) {
        return varianceReduction;
    }
    const next = { ...varianceReduction };
    if (next.weightWindows) {
        next.weightWindows = next.weightWindows.map((set) => {
            const particleType = normalizeParticleType(set.particleType);
            const normalized = { ...set };
            if (particleType) {
                normalized.particleType = particleType;
            } else {
                delete normalized.particleType;
            }
            return normalized;
        });
    }
    if (next.weightWindowGenerator) {
        const particleType = normalizeParticleType(next.weightWindowGenerator.particleType);
        const normalized = { ...next.weightWindowGenerator };
        if (particleType) {
            normalized.particleType = particleType;
        } else {
            delete normalized.particleType;
        }
        next.weightWindowGenerator = normalized;
    }
    return next;
}
