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
 * OpenMC Catalog Capabilities
 *
 * Read-only inventories of the active project's materials, tallies, and
 * geometry. The edit capabilities take numeric entity ids, so these summaries
 * are the legal way for a model to resolve those ids before choosing a
 * preview. Every handler reads the injected state manager only: no backend
 * call, no file read, and no state mutation.
 *
 * @module openmc-studio/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema,
    NukeJsonSchemaProperty
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { validateGeometryModel } from '../../common/geometry-validation';
import {
    OpenMCCell,
    OpenMCLattice,
    OpenMCMaterial,
    OpenMCRegionNode,
    OpenMCSurface,
    OpenMCTally,
    OpenMCTallyFilter
} from '../../common/openmc-state-schema';
import { OpenMCStateManager } from '../openmc-state-manager';

/** Read-only material inventory capability id. */
export const SUMMARIZE_MATERIALS_CAPABILITY_ID = 'nuke.openmc.summarizeMaterials';

/** Read-only tally inventory capability id. */
export const SUMMARIZE_TALLIES_CAPABILITY_ID = 'nuke.openmc.summarizeTallies';

/** Read-only geometry inventory capability id. */
export const SUMMARIZE_GEOMETRY_CAPABILITY_ID = 'nuke.openmc.summarizeGeometry';

/** Maximum material rows returned by {@link SUMMARIZE_MATERIALS_CAPABILITY_ID}. */
const MATERIAL_ROW_LIMIT = 200;

/** Maximum tally rows returned by {@link SUMMARIZE_TALLIES_CAPABILITY_ID}. */
const TALLY_ROW_LIMIT = 200;

/** Maximum bins sampled from one tally filter. */
const FILTER_BIN_LIMIT = 20;

/** Maximum surface rows returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const SURFACE_ROW_LIMIT = 100;

/** Maximum cell rows returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const CELL_ROW_LIMIT = 100;

/** Maximum universe rows returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const UNIVERSE_ROW_LIMIT = 100;

/** Maximum lattice rows returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const LATTICE_ROW_LIMIT = 50;

/** Maximum DAGMC volume rows returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const DAGMC_VOLUME_LIMIT = 100;

/** Maximum geometry validation findings returned by {@link SUMMARIZE_GEOMETRY_CAPABILITY_ID}. */
const GEOMETRY_ISSUE_LIMIT = 20;

const EMPTY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const GEOMETRY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        includeDagmc: {
            type: 'boolean',
            default: true,
            description: 'Include the loaded DAGMC volume list and material assignments. Defaults to true.'
        }
    },
    additionalProperties: false
};

const MATERIAL_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Material id accepted by material and tally edits.' },
        name: { type: 'string' },
        density: { type: 'number' },
        densityUnit: { type: 'string', enum: ['g/cm3', 'kg/m3', 'atom/b-cm', 'sum', 'macro'] },
        nuclideCount: { type: 'integer', description: 'Number of nuclides; the nuclide list itself is not returned.' },
        isDepletable: { type: 'boolean' },
        volume: { type: 'number', description: 'Material volume in cm³ when set.' },
        nukeCadMaterialId: { type: 'string', description: 'nuke-cad physical-model material id when imported from CAD.' },
        nukeCadParentId: { type: 'string', description: 'nuke-cad parent physical-model id when imported from CAD.' },
        temperature: { type: 'number', description: 'Material temperature in K when set.' }
    },
    required: ['id', 'density', 'densityUnit', 'nuclideCount', 'isDepletable'],
    additionalProperties: false
};

const TALLY_FILTER_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        type: { type: 'string', description: 'OpenMC tally filter type.' },
        bins: {
            type: 'array',
            items: { type: 'number' },
            description: `First ${FILTER_BIN_LIMIT} bins; empty when the filter has no numeric bins.`
        },
        binCount: { type: 'integer', description: 'Total number of bins before the sample cap.' }
    },
    required: ['type', 'bins', 'binCount'],
    additionalProperties: false
};

const TALLY_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Tally id accepted by tally edits.' },
        name: { type: 'string' },
        scores: { type: 'array', items: { type: 'string' } },
        estimator: { type: 'string', enum: ['analog', 'tracklength', 'collision'] },
        filterCount: { type: 'integer', description: 'Total number of filters on the tally.' },
        filters: { type: 'array', items: TALLY_FILTER_ROW_SCHEMA },
        nuclides: { type: 'array', items: { type: 'string' } },
        multiplyDensity: { type: 'boolean' },
        higherMoments: { type: 'boolean' }
    },
    required: ['id', 'scores', 'filterCount', 'filters', 'nuclides'],
    additionalProperties: false
};

const SURFACE_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Surface id accepted by geometry edits.' },
        name: { type: 'string' },
        type: { type: 'string', description: 'OpenMC surface type.' },
        summary: { type: 'string', description: 'Compact coefficient summary plus the boundary condition when set.' }
    },
    required: ['id', 'type', 'summary'],
    additionalProperties: false
};

const CELL_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Cell id accepted by geometry edits.' },
        name: { type: 'string' },
        fillType: { type: 'string', enum: ['material', 'universe', 'lattice', 'void'] },
        fillId: { type: 'integer', description: 'Material, universe, or lattice id for the cell fill.' },
        materialName: { type: 'string', description: 'Display name of the filling material when set.' },
        regionSummary: { type: 'string', description: 'Region string, or a compact expression rendered from the region tree.' }
    },
    required: ['id', 'fillType', 'regionSummary'],
    additionalProperties: false
};

const UNIVERSE_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Universe id accepted by geometry edits.' },
        name: { type: 'string' },
        cellCount: { type: 'integer' }
    },
    required: ['id', 'cellCount'],
    additionalProperties: false
};

const LATTICE_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'Lattice id accepted by geometry edits.' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['rect', 'hex'] },
        universeCount: { type: 'integer', description: 'Number of distinct universes placed in the lattice array.' }
    },
    required: ['id', 'type', 'universeCount'],
    additionalProperties: false
};

const DAGMC_VOLUME_ROW_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        id: { type: 'integer', description: 'DAGMC volume id accepted by DAGMC material edits.' },
        material: { type: 'string', description: 'Assigned material name; empty when unassigned.' },
        numTriangles: { type: 'integer' }
    },
    required: ['id', 'material', 'numTriangles'],
    additionalProperties: false
};

const DAGMC_SUMMARY_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        file: { type: 'string', description: 'Resolved DAGMC file path from the loaded model information.' },
        volumeCount: { type: 'integer', description: 'Total DAGMC volume count before the row cap.' },
        volumes: { type: 'array', items: DAGMC_VOLUME_ROW_SCHEMA }
    },
    required: ['file', 'volumeCount', 'volumes'],
    additionalProperties: false
};

const GEOMETRY_ISSUE_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        path: { type: 'string', description: 'State path of the affected entity when the validator reports one.' },
        message: { type: 'string' }
    },
    required: ['severity', 'message'],
    additionalProperties: false
};

const GEOMETRY_COUNTS_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        surfaces: { type: 'integer' },
        cells: { type: 'integer' },
        universes: { type: 'integer' },
        lattices: { type: 'integer' },
        rootUniverse: { type: 'integer', description: 'Root universe id; OpenMC XML always uses universe 0.' }
    },
    required: ['surfaces', 'cells', 'universes', 'lattices', 'rootUniverse'],
    additionalProperties: false
};

const SUMMARIZE_MATERIALS_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        materials: { type: 'array', description: `First ${MATERIAL_ROW_LIMIT} materials.`, items: MATERIAL_ROW_SCHEMA },
        total: { type: 'integer', description: 'Total material count before the row cap.' },
        truncated: { type: 'boolean', description: 'True when the material rows were capped.' }
    },
    required: ['materials', 'total', 'truncated'],
    additionalProperties: false
};

const SUMMARIZE_TALLIES_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        tallies: { type: 'array', description: `First ${TALLY_ROW_LIMIT} tallies.`, items: TALLY_ROW_SCHEMA },
        total: { type: 'integer', description: 'Total tally count before the row cap.' },
        truncated: { type: 'boolean', description: 'True when tally rows or filter bin samples were capped.' }
    },
    required: ['tallies', 'total', 'truncated'],
    additionalProperties: false
};

const SUMMARIZE_GEOMETRY_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        counts: GEOMETRY_COUNTS_SCHEMA,
        surfaces: { type: 'array', description: `First ${SURFACE_ROW_LIMIT} surfaces.`, items: SURFACE_ROW_SCHEMA },
        cells: { type: 'array', description: `First ${CELL_ROW_LIMIT} cells.`, items: CELL_ROW_SCHEMA },
        universes: { type: 'array', description: `First ${UNIVERSE_ROW_LIMIT} universes.`, items: UNIVERSE_ROW_SCHEMA },
        lattices: { type: 'array', description: `First ${LATTICE_ROW_LIMIT} lattices.`, items: LATTICE_ROW_SCHEMA },
        dagmc: { ...DAGMC_SUMMARY_SCHEMA, description: `Loaded DAGMC model summary; volumes capped at ${DAGMC_VOLUME_LIMIT}.` },
        issues: { type: 'array', description: `First ${GEOMETRY_ISSUE_LIMIT} CSG validation findings.`, items: GEOMETRY_ISSUE_SCHEMA },
        truncated: { type: 'boolean', description: 'True when any row or finding list was capped.' }
    },
    required: ['counts', 'surfaces', 'cells', 'universes', 'lattices', 'issues', 'truncated'],
    additionalProperties: false
};

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** True for a non-empty display name. */
function hasText(value: string | undefined): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** Compact coefficient summary for one surface. */
function surfaceSummary(surface: OpenMCSurface): string {
    const coefficients = surface.coefficients as unknown as Record<string, number>;
    let summary: string;
    switch (surface.type) {
        case 'sphere':
            summary = `center=(${coefficients.x0}, ${coefficients.y0}, ${coefficients.z0}) r=${coefficients.r}`;
            break;
        case 'x-plane':
            summary = `x0=${coefficients.x0}`;
            break;
        case 'y-plane':
            summary = `y0=${coefficients.y0}`;
            break;
        case 'z-plane':
            summary = `z0=${coefficients.z0}`;
            break;
        case 'x-cylinder':
            summary = `center=(${coefficients.y0}, ${coefficients.z0}) r=${coefficients.r}`;
            break;
        case 'y-cylinder':
            summary = `center=(${coefficients.x0}, ${coefficients.z0}) r=${coefficients.r}`;
            break;
        case 'z-cylinder':
            summary = `center=(${coefficients.x0}, ${coefficients.y0}) r=${coefficients.r}`;
            break;
        case 'plane':
            summary = `a=${coefficients.a} b=${coefficients.b} c=${coefficients.c} d=${coefficients.d}`;
            break;
        case 'x-cone':
        case 'y-cone':
        case 'z-cone':
            summary = `center=(${coefficients.x0}, ${coefficients.y0}, ${coefficients.z0}) r2=${coefficients.r2}`;
            break;
        case 'x-torus':
        case 'y-torus':
        case 'z-torus':
            summary = `center=(${coefficients.x0}, ${coefficients.y0}, ${coefficients.z0}) a=${coefficients.a} b=${coefficients.b} c=${coefficients.c}`;
            break;
        case 'cylinder':
            summary = `center=(${coefficients.x0}, ${coefficients.y0}, ${coefficients.z0}) axis=(${coefficients.vx}, ${coefficients.vy}, ${coefficients.vz}) r=${coefficients.r}`;
            break;
        case 'quadric':
            summary = Object.entries(coefficients)
                .map(([key, value]) => `${key}=${value}`)
                .join(' ');
            break;
        default:
            summary = Object.entries(coefficients)
                .map(([key, value]) => `${key}=${value}`)
                .join(' ');
            break;
    }
    return hasText(surface.boundary) ? `${summary} boundary=${surface.boundary}` : summary;
}

/** Render a region tree as a compact boolean expression. */
function regionExpression(node: OpenMCRegionNode): string {
    if (node.type === 'surface') {
        if (node.surfaceId === undefined) {
            return 'surface?';
        }
        return `${node.surfaceId >= 0 ? '+' : ''}${node.surfaceId}`;
    }
    if (node.type === 'cell') {
        return node.cellId === undefined ? 'cell?' : `cell#${node.cellId}`;
    }

    const children = node.children ?? [];
    if (children.length === 0) {
        return '';
    }
    const operand = (child: OpenMCRegionNode): string =>
        child.type === 'operator' ? `(${regionExpression(child)})` : regionExpression(child);
    if (node.operator === 'complement') {
        return `~${operand(children[0])}`;
    }
    const separator = node.operator === 'union' ? ' | ' : node.operator === 'difference' ? ' - ' : ' ';
    return children.map(operand).join(separator);
}

/** Region summary for a cell: prefer the serialized string, then the tree. */
function cellRegionSummary(cell: OpenMCCell): string {
    const regionString = cell.regionString?.trim();
    if (regionString) {
        return regionString;
    }
    if (cell.region) {
        return regionExpression(cell.region) || 'unbounded';
    }
    return 'unbounded';
}

/** Count distinct universes placed in a lattice array. */
function latticeUniverseCount(lattice: OpenMCLattice): number {
    const universeIds = new Set<number>();
    for (const axialSlice of lattice.universes ?? []) {
        for (const ringOrRow of axialSlice ?? []) {
            for (const universeId of ringOrRow ?? []) {
                if (typeof universeId === 'number') {
                    universeIds.add(universeId);
                }
            }
        }
    }
    return universeIds.size;
}

/** One material row without the nuclide list. */
function materialRow(material: OpenMCMaterial): Record<string, unknown> {
    return {
        id: material.id,
        ...(hasText(material.name) ? { name: material.name } : {}),
        density: material.density,
        densityUnit: material.densityUnit,
        nuclideCount: Array.isArray(material.nuclides) ? material.nuclides.length : 0,
        isDepletable: material.isDepletable === true,
        ...(material.volume !== undefined ? { volume: material.volume } : {}),
        ...(material.nukeCadMaterialId !== undefined ? { nukeCadMaterialId: material.nukeCadMaterialId } : {}),
        ...(material.nukeCadParentId !== undefined ? { nukeCadParentId: material.nukeCadParentId } : {}),
        ...(material.temperature !== undefined ? { temperature: material.temperature } : {})
    };
}

/** One tally filter row with a bounded bin sample. */
function tallyFilterRow(filter: OpenMCTallyFilter): Record<string, unknown> {
    const bins = Array.isArray(filter.bins) ? filter.bins : [];
    return {
        type: filter.type,
        bins: bins.slice(0, FILTER_BIN_LIMIT),
        binCount: bins.length
    };
}

/** One tally row with bounded filter bins. */
function tallyRow(tally: OpenMCTally): Record<string, unknown> {
    const filters = Array.isArray(tally.filters) ? tally.filters : [];
    return {
        id: tally.id,
        ...(hasText(tally.name) ? { name: tally.name } : {}),
        scores: [...(tally.scores ?? [])],
        ...(tally.estimator !== undefined ? { estimator: tally.estimator } : {}),
        filterCount: filters.length,
        filters: filters.map(tallyFilterRow),
        nuclides: [...(tally.nuclides ?? [])],
        ...(tally.multiplyDensity !== undefined ? { multiplyDensity: tally.multiplyDensity } : {}),
        ...(tally.higherMoments !== undefined ? { higherMoments: tally.higherMoments } : {})
    };
}

/**
 * Registers the read-only OpenMC catalog summaries with the nuke-core
 * registry. The class intentionally depends on the state manager only.
 */
@injectable()
export class OpenMCCatalogCapabilities implements NukeCapabilityContribution {
    constructor(@inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: SUMMARIZE_MATERIALS_CAPABILITY_ID,
            title: 'Summarize OpenMC materials',
            description:
                'Read-only material inventory for the active OpenMC project: up to 200 rows with each material id, name, density and unit, ' +
                'nuclide count (never the nuclide list), depletability, volume, temperature, and nuke-cad provenance ids. Use the returned ids ' +
                'with nuke.openmc.previewMaterialChange and nuke.openmc.applyMaterialChange.',
            category: ['OpenMC', 'Materials'],
            inputSchema: EMPTY_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_MATERIALS_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [{ description: 'List every material id before previewing a material change.', input: {} }],
            when: () => true,
            invoke: async () => this.summarizeMaterials()
        });

        registry.register({
            id: SUMMARIZE_TALLIES_CAPABILITY_ID,
            title: 'Summarize OpenMC tallies',
            description:
                'Read-only tally inventory for the active OpenMC project: up to 200 rows with each tally id, name, scores, estimator, filter ' +
                'count, filter types with up to 20 sample bins plus full bin counts, nuclides, multiply-density, and higher-moments flags. ' +
                'Use the returned ids with nuke.openmc.previewTallyChange and nuke.openmc.applyTallyChange.',
            category: ['OpenMC', 'Tallies'],
            inputSchema: EMPTY_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_TALLIES_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [{ description: 'List every tally id before previewing a tally change.', input: {} }],
            when: () => true,
            invoke: async () => this.summarizeTallies()
        });

        registry.register({
            id: SUMMARIZE_GEOMETRY_CAPABILITY_ID,
            title: 'Summarize OpenMC geometry',
            description:
                'Read-only geometry inventory for the active OpenMC project: CSG counts plus up to 100 surfaces, 100 cells, 100 universes, ' +
                'and 50 lattices with ids, names, types, and compact coefficient or region summaries, the first 20 CSG validation findings, ' +
                'and (unless includeDagmc is false) up to 100 DAGMC volumes with material assignments. Use these ids with ' +
                'nuke.openmc.previewGeometryChange and nuke.openmc.previewDagmcChange.',
            category: ['OpenMC', 'Geometry'],
            inputSchema: GEOMETRY_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_GEOMETRY_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                { description: 'List CSG and DAGMC ids before a geometry or DAGMC volume edit.', input: {} },
                { description: 'Omit the DAGMC volume list for a CSG-only inventory.', input: { includeDagmc: false } }
            ],
            when: () => true,
            invoke: async (input) => this.summarizeGeometry(input)
        });
    }

    protected summarizeMaterials(): NukeCapabilityResult {
        const materials = this.stateManager.getState().materials ?? [];
        return {
            ok: true,
            data: {
                materials: materials.slice(0, MATERIAL_ROW_LIMIT).map(materialRow),
                total: materials.length,
                truncated: materials.length > MATERIAL_ROW_LIMIT
            }
        };
    }

    protected summarizeTallies(): NukeCapabilityResult {
        const tallies = this.stateManager.getState().tallies ?? [];
        const truncated =
            tallies.length > TALLY_ROW_LIMIT ||
            tallies.some((tally) => (tally.filters ?? []).some((filter) => (filter.bins?.length ?? 0) > FILTER_BIN_LIMIT));
        return {
            ok: true,
            data: {
                tallies: tallies.slice(0, TALLY_ROW_LIMIT).map(tallyRow),
                total: tallies.length,
                truncated
            }
        };
    }

    protected summarizeGeometry(input: unknown): NukeCapabilityResult {
        const state = this.stateManager.getState();
        const geometry = state.geometry;
        const surfaces = geometry.surfaces ?? [];
        const cells = geometry.cells ?? [];
        const universes = geometry.universes ?? [];
        const lattices = geometry.lattices ?? [];
        const includeDagmc = readRecord(input).includeDagmc !== false;

        // DAGMC projects own their geometry in the .h5m file, so CSG validation
        // findings would describe lists that the model does not use.
        const findings = state.settings.dagmcFile ? [] : validateGeometryModel(geometry);
        const issues = findings.slice(0, GEOMETRY_ISSUE_LIMIT).map((issue) => ({
            severity: issue.severity,
            ...(issue.path !== undefined ? { path: issue.path } : {}),
            message: issue.message
        }));

        const dagmcInfo = includeDagmc ? state.settings.dagmcInfo : undefined;
        const dagmcVolumes = dagmcInfo?.volumes ?? [];
        const dagmc = dagmcInfo
            ? {
                  file: hasText(dagmcInfo.filePath) ? dagmcInfo.filePath : (state.settings.dagmcFile ?? ''),
                  volumeCount: typeof dagmcInfo.volumeCount === 'number' ? dagmcInfo.volumeCount : dagmcVolumes.length,
                  volumes: dagmcVolumes.slice(0, DAGMC_VOLUME_LIMIT).map((volume) => ({
                      id: volume.id,
                      material: volume.material,
                      numTriangles: volume.numTriangles
                  }))
              }
            : undefined;

        const truncated =
            surfaces.length > SURFACE_ROW_LIMIT ||
            cells.length > CELL_ROW_LIMIT ||
            universes.length > UNIVERSE_ROW_LIMIT ||
            lattices.length > LATTICE_ROW_LIMIT ||
            findings.length > GEOMETRY_ISSUE_LIMIT ||
            dagmcVolumes.length > DAGMC_VOLUME_LIMIT;

        return {
            ok: true,
            data: {
                counts: {
                    surfaces: surfaces.length,
                    cells: cells.length,
                    universes: universes.length,
                    lattices: lattices.length,
                    rootUniverse: geometry.rootUniverseId
                },
                surfaces: surfaces.slice(0, SURFACE_ROW_LIMIT).map((surface) => ({
                    id: surface.id,
                    ...(hasText(surface.name) ? { name: surface.name } : {}),
                    type: surface.type,
                    summary: surfaceSummary(surface)
                })),
                cells: cells.slice(0, CELL_ROW_LIMIT).map((cell) => ({
                    id: cell.id,
                    ...(hasText(cell.name) ? { name: cell.name } : {}),
                    fillType: cell.fillType,
                    ...(cell.fillId !== undefined ? { fillId: cell.fillId } : {}),
                    ...(hasText(cell.materialName) ? { materialName: cell.materialName } : {}),
                    regionSummary: cellRegionSummary(cell)
                })),
                universes: universes.slice(0, UNIVERSE_ROW_LIMIT).map((universe) => ({
                    id: universe.id,
                    ...(hasText(universe.name) ? { name: universe.name } : {}),
                    cellCount: (universe.cellIds ?? []).length
                })),
                lattices: lattices.slice(0, LATTICE_ROW_LIMIT).map((lattice) => ({
                    id: lattice.id,
                    ...(hasText(lattice.name) ? { name: lattice.name } : {}),
                    type: lattice.type,
                    universeCount: latticeUniverseCount(lattice)
                })),
                ...(dagmc ? { dagmc } : {}),
                issues,
                truncated
            }
        };
    }
}
