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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCState } from '../common/openmc-state-schema';
import { XMLGenerationService } from './xml-generation-service';
import { OpenMCPythonExporter } from '../browser/script-generator/python-exporter';

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.2.0', name: 'Export check', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 5 },
            sources: [{ spatial: { type: 'point', origin: [0, 0, 0] }, energy: { type: 'discrete', energies: [1e6] } }]
        },
        tallies: [{ id: 1, name: 'Flux', scores: ['flux'], nuclides: ['total'], filters: [] }],
        derivedTallies: [
            {
                id: 1,
                name: 'Double flux',
                expression: {
                    kind: 'binary',
                    op: '*',
                    left: { kind: 'tally', tallyId: 1, score: 'flux' },
                    right: { kind: 'scalar', value: 2 }
                },
                unit: 'cm^-2'
            }
        ],
        meshes: []
    };
}

describe('derived tallies never enter simulation exports', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-derived-export-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('writes only simulation tallies to tallies.xml', async () => {
        const service = new XMLGenerationService();
        const result = await service.generateXML({
            state: buildState(),
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: false, tallies: true, plots: false }
        });
        expect(result.success).toBe(true);
        expect(result.warnings?.some((warning) => warning.includes('Derived tallies are analysis-only'))).toBe(true);
        const xml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect(xml).toContain('<tally id="1"');
        expect(xml.match(/<tally /g)).toHaveLength(1);
        expect(xml.toLowerCase()).not.toContain('derived');
        expect(xml).not.toContain('Double flux');
    });

    it('does not emit derived-tally definitions into the Python model', () => {
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(state: OpenMCState, options: object): string }).generateModelScript(
            buildState(),
            { mode: 'single', includeComments: true }
        );
        expect(script).toContain('tally_1 = openmc.Tally(name="Flux", tally_id=1)');
        expect(script).toContain('Derived tallies are analysis-only and are not part of this simulation script.');
        expect(script).not.toContain('Double flux');
        expect(script).not.toContain('derived_tally');
    });
});
