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
 * Generalized-particle e2e against a real OpenMC 0.16 install.
 *
 * The first case parses the generated settings.xml/tallies.xml with the real
 * OpenMC Python API and asserts the canonical particle names. The second case
 * exports the same model through the Python exporter, runs it to XML with the
 * real OpenMC Python API, then runs a short photon fixed-source transport and
 * inspects the statepoint particle-filter bins.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// The exporter's import chain reaches three browser-only Theia modules; the
// generation methods themselves are DOM-free (same mock set as the codegen run test).
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { XMLGenerationService } from '../xml-generation-service';
import { OpenMCPythonExporter } from '../../browser/script-generator/python-exporter';
import { OpenMCState } from '../../common/openmc-state-schema';
import { DEFAULT_OPENMC_COMPAT, OpenMCCompat } from '../../common/openmc-studio-protocol';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const HAS_PYTHON = !!(PYTHON && fs.existsSync(PYTHON));
const CAN_RUN = !!(HAS_PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));

function probeGeneralizedParticles(): boolean {
    if (!HAS_PYTHON) {
        return false;
    }
    const result = spawnSync(
        PYTHON!,
        ['-c', "import openmc; p = openmc.ParticleType('He4'); assert str(p) == 'He4' and p.pdg_number == 1000020040; print('ok')"],
        { encoding: 'utf-8' }
    );
    return result.status === 0 && result.stdout.includes('ok');
}

const HAS_GENERALIZED = probeGeneralizedParticles();

const tempDirs: string[] = [];
afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const COMPAT: OpenMCCompat = {
    ...DEFAULT_OPENMC_COMPAT,
    generalizedParticles: true,
    particleProductionFilter: true
};

const HE4 = { name: 'He4', pdg: 1000020040 };
const PHOTON = { name: 'photon', pdg: 22 };
const ELECTRON = { name: 'electron', pdg: 11 };

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.2.0', name: 'Particle Types E2E', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, name: 'Shield', fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Hydrogen',
                density: 0.001,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 60, batches: 3 },
            sources: [
                {
                    spatial: { type: 'point', origin: [0, 0, 0] },
                    energy: { type: 'discrete', energies: [1e5] },
                    particle: PHOTON
                }
            ],
            photonTransport: true,
            seed: 7
        },
        tallies: [
            {
                id: 1,
                name: 'Photon flux',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [{ type: 'particle', bins: [], particleBins: [PHOTON, ELECTRON] }]
            }
        ],
        meshes: [],
        plots: []
    };
}

function metadataCompat(): OpenMCCompat {
    return COMPAT;
}

describe.skipIf(!HAS_GENERALIZED)('generalized particles with the real OpenMC Python API', () => {
    it('parses the generated source and particle filter with canonical names', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-particles-api-'));
        tempDirs.push(dir);
        const state = buildState();
        state.settings.sources[0] = {
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e5] },
            particle: HE4
        };
        state.tallies[0].filters = [
            { type: 'particle', bins: [], particleBins: [HE4, PHOTON, ELECTRON] },
            { type: 'particleproduction', bins: [], particleTypes: [HE4, PHOTON], productionEnergyBins: [0, 2e7] }
        ];

        const generator = new XMLGenerationService();
        const result = await generator.generateXML({
            state,
            outputDirectory: dir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false },
            randomRayCompat: metadataCompat()
        });
        expect(result.success).toBe(true);

        const script = `
import sys
import xml.etree.ElementTree as ET
import openmc

settings = ET.parse(sys.argv[1]).getroot()
source = openmc.IndependentSource.from_xml_element(settings.find('source'))
assert str(source.particle) == 'He4', source.particle
assert source.particle.pdg_number == 1000020040, source.particle

tallies = ET.parse(sys.argv[2]).getroot()
filters = [openmc.Filter.from_xml_element(elem) for elem in tallies.findall('filter')]
particle = next(f for f in filters if f.short_name.lower() == 'particle')
assert [str(b) for b in particle.bins] == ['He4', 'photon', 'electron'], particle.bins
production = next(f for f in filters if f.short_name.lower() == 'particleproduction')
assert [str(p) for p in production.particles] == ['He4', 'photon'], production.particles
print('particles-ok')
`;
        const parsed = spawnSync(PYTHON!, ['-c', script, path.join(dir, 'settings.xml'), path.join(dir, 'tallies.xml')], {
            encoding: 'utf-8'
        });
        expect(parsed.status, `${parsed.stdout}\n${parsed.stderr}`).toBe(0);
        expect(parsed.stdout).toContain('particles-ok');
    }, 120_000);

    it.skipIf(!CAN_RUN)(
        'runs a photon source through the Python exporter and reads the statepoint filter',
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-particles-run-'));
            tempDirs.push(dir);
            const state = buildState();

            const exporter = new OpenMCPythonExporter();
            const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
                mode: 'single',
                includeComments: false,
                includeShebang: false,
                compat: COMPAT
            });
            fs.writeFileSync(path.join(dir, 'model.py'), script);

            const exported = spawnSync(PYTHON!, ['model.py'], {
                cwd: dir,
                encoding: 'utf-8',
                env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS }
            });
            expect(exported.status, `${exported.stdout}\n${exported.stderr}`).toBe(0);
            expect(fs.existsSync(path.join(dir, 'tallies.xml'))).toBe(true);

            const run = spawnSync(OPENMC_EXE!, [], {
                cwd: dir,
                encoding: 'utf-8',
                env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
                timeout: 120_000
            });
            expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

            const statepoint = spawnSync(
                PYTHON!,
                [
                    '-c',
                    `
import glob
import sys
import openmc
sp = openmc.StatePoint(sorted(glob.glob('statepoint*.h5'))[-1])
tally = sp.get_tally(id=1)
particle = next(f for f in tally.filters if f.short_name.lower() == 'particle')
assert [str(b) for b in particle.bins] == ['photon', 'electron'], particle.bins
print('statepoint-ok')
`,
                    dir
                ],
                { cwd: dir, encoding: 'utf-8' }
            );
            expect(statepoint.status, `${statepoint.stdout}\n${statepoint.stderr}`).toBe(0);
            expect(statepoint.stdout).toContain('statepoint-ok');
        },
        180_000
    );
});
