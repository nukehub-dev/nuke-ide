// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Project-template contract tests: every template builds a real state with
 * resolvable references, and that state generates a complete XML set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from '../node/xml-generation-service';
import { DEFAULT_OPENMC_COMPAT } from './openmc-studio-protocol';
import { validateGeometryModel } from './geometry-validation';
import { validateSourceDistributions } from './source-utils';
import { validateTallyFilterSet } from './tally-filter-validation';
import { validateRuntimeSettings } from './settings-validation';
import { computeReadiness } from './run-readiness';
import { OPENMC_STATE_SCHEMA_VERSION, OpenMCState } from './openmc-state-schema';
import {
    PROJECT_TEMPLATE_DEFINITIONS,
    buildProjectTemplate,
    createBlankProjectState,
    listProjectTemplates,
    previewProjectTemplate
} from './project-templates';

const COMPAT = {
    ...DEFAULT_OPENMC_COMPAT,
    raySourceFormat: 'wrapper' as const,
    adjointSource: true,
    tokamakSource: true,
    decaySpectrum: true,
    s2SampleMethod: true,
    depletionSubsteps: true,
    depletionKeffSearch: true,
    depletionExternalSourceRate: true,
    depletionContinuation: true,
    sharedSecondaryBank: true,
    surfaceGrazing: true,
    meshFilterRotation: true,
    sourceBias: true,
    reactionFilter: true,
    particleProductionFilter: true
};

const RUNNABLE_TEMPLATES = ['pin-cell', 'fuel-assembly', 'full-core', 'shielding', 'criticallity-safety'] as const;

/** Validate structural references that the generators rely on. */
function expectResolvableState(state: OpenMCState): void {
    expect(state.metadata.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
    expect(state.geometry.rootUniverseId).toBe(0);
    expect(state.geometry.universes.some((universe) => universe.id === 0)).toBe(true);

    const surfaceIds = new Set(state.geometry.surfaces.map((surface) => surface.id));
    const materialIds = new Set(state.materials.map((material) => material.id));
    const cellIds = new Set(state.geometry.cells.map((cell) => cell.id));
    const universeIds = new Set(state.geometry.universes.map((universe) => universe.id));
    const latticeIds = new Set(state.geometry.lattices.map((lattice) => lattice.id));

    expect(surfaceIds.size).toBe(state.geometry.surfaces.length);
    expect(materialIds.size).toBe(state.materials.length);
    expect(cellIds.size).toBe(state.geometry.cells.length);

    for (const cell of state.geometry.cells) {
        if (cell.fillType === 'material' && cell.fillId !== undefined) {
            expect(materialIds.has(cell.fillId), `cell ${cell.id} references material ${cell.fillId}`).toBe(true);
        }
        if (cell.fillType === 'universe' && cell.fillId !== undefined) {
            expect(universeIds.has(cell.fillId), `cell ${cell.id} references universe ${cell.fillId}`).toBe(true);
        }
        if (cell.fillType === 'lattice' && cell.fillId !== undefined) {
            expect(latticeIds.has(cell.fillId), `cell ${cell.id} references lattice ${cell.fillId}`).toBe(true);
        }
        for (const match of (cell.regionString ?? '').matchAll(/(\d+)/g)) {
            expect(surfaceIds.has(Number(match[1])), `cell ${cell.id} references surface ${match[1]}`).toBe(true);
        }
    }

    const cellsInUniverses = new Set(state.geometry.universes.flatMap((universe) => universe.cellIds));
    for (const cell of state.geometry.cells) {
        expect(cellsInUniverses.has(cell.id), `cell ${cell.id} belongs to a universe`).toBe(true);
    }

    for (const lattice of state.geometry.lattices) {
        for (const universeId of lattice.universes.flat(2)) {
            expect(universeIds.has(universeId), `lattice ${lattice.id} references universe ${universeId}`).toBe(true);
        }
    }

    for (const issue of validateGeometryModel(state.geometry)) {
        expect(issue.severity, `${issue.message} (${issue.suggestion})`).not.toBe('error');
    }
    for (const issue of validateRuntimeSettings(state.settings, COMPAT)) {
        expect(issue.severity, `${issue.message} (${issue.suggestion})`).not.toBe('error');
    }
    for (const source of state.settings.sources) {
        if ((source.type ?? 'independent') === 'independent') {
            for (const issue of validateSourceDistributions(source as any, state.meshes)) {
                expect(issue.message, issue.suggestion).toBeUndefined();
            }
        }
    }
    for (const tally of state.tallies) {
        for (const issue of validateTallyFilterSet(
            { filters: tally.filters, scores: tally.scores },
            { cells: state.geometry.cells, materials: state.materials, meshes: state.meshes }
        )) {
            expect(issue.severity, `${issue.message} (${issue.fix})`).not.toBe('error');
        }
    }
}

describe('project templates', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-templates-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('exposes every template with coherent card metadata', () => {
        const ids = PROJECT_TEMPLATE_DEFINITIONS.map((template) => template.id);
        expect(ids).toEqual(['blank', 'pin-cell', 'fuel-assembly', 'full-core', 'shielding', 'criticallity-safety']);
        expect(previewProjectTemplate('blank')).toContain('Empty model');
        for (const template of PROJECT_TEMPLATE_DEFINITIONS) {
            expect(template.name.length).toBeGreaterThan(0);
            expect(template.description.length).toBeGreaterThan(0);
            expect(template.icon).toMatch(/^codicon /);
            expect((template.whatYouGet ?? []).length).toBeGreaterThan(0);
            for (const parameter of template.parameters ?? []) {
                expect(parameter.label.length).toBeGreaterThan(0);
                expect(Number.isFinite(parameter.default)).toBe(true);
                if (parameter.min !== undefined) {
                    expect(parameter.default).toBeGreaterThanOrEqual(parameter.min);
                }
                if (parameter.max !== undefined) {
                    expect(parameter.default).toBeLessThanOrEqual(parameter.max);
                }
            }
        }
    });

    it('lists fully built default states for the template picker', () => {
        const templates = listProjectTemplates();
        expect(templates).toHaveLength(PROJECT_TEMPLATE_DEFINITIONS.length);
        for (const template of templates) {
            expect(template.defaultState.metadata?.version).toBe(OPENMC_STATE_SCHEMA_VERSION);
            if (template.id !== 'blank') {
                expect(template.defaultState.geometry?.cells.length).toBeGreaterThan(0);
                expect(template.defaultState.materials?.length).toBeGreaterThan(0);
            }
        }
    });

    it('builds a blank state with no fabricated model data', () => {
        const state = createBlankProjectState();
        expect(state.materials).toEqual([]);
        expect(state.geometry.cells).toEqual([]);
        expect(state.tallies).toEqual([]);
        expect(state.meshes).toEqual([]);
    });

    it.each(RUNNABLE_TEMPLATES)('%s builds a resolvable state and complete XML set', async (templateId) => {
        const state = buildProjectTemplate(templateId);
        expectResolvableState(state);

        const dir = fs.mkdtempSync(path.join(tempDir, `${templateId}-`));
        const service = new XMLGenerationService();
        const result = await service.generateXML({
            state,
            outputDirectory: dir,
            randomRayCompat: COMPAT,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });
        expect(result.success, result.error).toBe(true);
        for (const file of ['materials.xml', 'geometry.xml', 'settings.xml', 'tallies.xml']) {
            expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
        }
    });

    it('applies meaningful parameters to the assembly template', () => {
        const state = buildProjectTemplate('fuel-assembly', { enrichmentPct: 3.2, pitchCm: 1.3 });
        const fuel = state.materials.find((material) => material.id === 1);
        expect(fuel?.nuclides.find((nuclide) => nuclide.name === 'U235')?.fraction).toBeCloseTo(3.2, 6);
        expect(previewProjectTemplate('fuel-assembly', { enrichmentPct: 3.2 })).toContain('3.2%');
        expect(previewProjectTemplate('fuel-assembly')).toContain('264 fuel pins');
        expect(previewProjectTemplate('fuel-assembly')).toContain('24 guide tubes');
    });

    it('marks every runnable template as ready in the setup checklist', () => {
        for (const templateId of RUNNABLE_TEMPLATES) {
            const state = buildProjectTemplate(templateId);
            const readiness = computeReadiness(state);
            expect(readiness.ready, `${templateId}: ${readiness.missing.join(', ')}`).toBe(true);
        }
    });

    it('labels the demonstration core clearly', () => {
        const state = buildProjectTemplate('full-core');
        expect(state.metadata.description?.toLowerCase()).toContain('demonstration');
        expect(state.metadata.description?.toLowerCase()).toContain('not a benchmark');
        expect(previewProjectTemplate('full-core')).toContain('3x3 assemblies');
    });
});
