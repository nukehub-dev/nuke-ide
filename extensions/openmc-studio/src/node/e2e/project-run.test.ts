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
 * End-to-end tests: real .nuke-openmc project files → migration → XML
 * generation → real OpenMC runs → statepoint/artifact assertions → importXML
 * round-trip in the real environment.
 *
 * Gated on NUKE_TEST_PYTHON (an openmc-capable python whose bin/ contains the
 * openmc executable) and OPENMC_CROSS_SECTIONS; skipped otherwise. Fixture
 * projects live in ./projects as small, reviewable JSON files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { XMLGenerationService } from '../xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from '../openmc-studio-backend-service';
import { migrateProjectFile } from '../../common/openmc-state-migration';
import { OpenMCProjectFile, OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
// Depletion chain: only from NUKE_E2E_CHAIN (no default — test skips when unset)
const CHAIN = process.env.NUKE_E2E_CHAIN;
const CHAIN_OK = !!CHAIN && fs.existsSync(CHAIN);
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const PYTHON_DIR = path.resolve(__dirname, '../../../python');
const PROJECTS_DIR = path.resolve(__dirname, 'projects');

const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const SKIP_REASON = 'e2e requires NUKE_TEST_PYTHON (env python with openmc) and OPENMC_CROSS_SECTIONS';
const RUN_TIMEOUT = 120_000;

/** Repo-local DAGMC test asset (committed). */
const FUEL_PIN_H5M = path.resolve(__dirname, '../../../tests/e2e/assets/fuel_pin.h5m');

/** Feature probe: does the env's openmc have TokamakSource (0.15.4+)? */
const TOKAMAK_OK = (() => {
    if (!PYTHON) {
        return false;
    }
    const proc = spawnSync(PYTHON, ['-c', 'import openmc; print(hasattr(openmc, "TokamakSource"))'], { encoding: 'utf-8' });
    return proc.stdout?.trim() === 'True';
})();

/** Load and migrate a fixture project, returning the state. */
function loadProjectState(name: string): OpenMCState {
    const raw = fs.readFileSync(path.join(PROJECTS_DIR, `${name}.nuke-openmc`), 'utf-8');
    const project = JSON.parse(raw) as OpenMCProjectFile;
    return migrateProjectFile(project).project.state;
}

/** Generate the full XML set for a state into a fresh temp directory. */
async function generateToTempDir(state: OpenMCState): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-e2e-'));
    const service = new XMLGenerationService();
    const result = await service.generateXML({
        state,
        outputDirectory: dir,
        files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
    });
    expect(result.success).toBe(true);
    return dir;
}

/** Run the openmc binary in a working directory. */
function runOpenMC(dir: string): void {
    const proc = spawnSync(OPENMC_EXE!, [], {
        cwd: dir,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
    expect(proc.status, `openmc failed in ${dir}:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
}

/** Run a python/ driver with the env python, returning parsed stdout JSON. */
function runPythonDriver(script: string, args: string[], extraEnv: Record<string, string> = {}): any {
    const proc = spawnSync(PYTHON!, [path.join(PYTHON_DIR, script), ...args], {
        env: {
            ...process.env,
            // The drivers spawn the openmc binary themselves — make the env's
            // bin directory visible to them
            PATH: `${path.dirname(PYTHON!)}${path.delimiter}${process.env.PATH ?? ''}`,
            OPENMC_CROSS_SECTIONS: CROSS_SECTIONS,
            ...extraEnv
        },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
    expect(proc.status, `${script} failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
    const lines = proc.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
}

/** Read a value from the statepoint via the env python. */
function evalInStatepoint(dir: string, snippet: string): string {
    const script = [
        'import glob, openmc',
        'sp_path = sorted(glob.glob("statepoint*.h5"))[-1]',
        `with openmc.StatePoint(sp_path) as sp:`,
        `    print(${snippet})`
    ].join('\n');
    const proc = spawnSync(PYTHON!, ['-c', script], {
        cwd: dir,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: 60_000,
        encoding: 'utf-8'
    });
    expect(proc.status, `statepoint eval failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
    return proc.stdout.trim();
}

describe('project-file e2e (real OpenMC)', () => {
    let tempDirs: string[] = [];

    beforeAll(() => {
        if (!CAN_RUN) {
            console.warn(SKIP_REASON);
        } else if (!CHAIN_OK) {
            console.warn('NUKE_E2E_CHAIN not set or missing — depletion e2e will skip');
        }
        if (CAN_RUN && !TOKAMAK_OK) {
            console.warn('openmc has no TokamakSource (needs 0.15.4+) — tokamak e2e will skip');
        }
        tempDirs = [];
    });

    afterAll(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!CAN_RUN)(
        'kinetics project: eigenvalue run converges and IFP tallies reach the statepoint; importXML re-derives kinetics',
        async () => {
            const state = loadProjectState('pincell-kinetics');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            runOpenMC(dir);

            // k-eff plausible for a reflected pincell
            const keff = parseFloat(evalInStatepoint(dir, 'sp.keff.n'));
            expect(keff).toBeGreaterThan(0.2);
            expect(keff).toBeLessThan(2.5);

            // IFP kinetics scores must be present in the statepoint tallies
            const scores = evalInStatepoint(dir, '" ".join(s for t in sp.tallies.values() for s in t.scores)');
            expect(scores).toContain('ifp-time-numerator');
            expect(scores).toContain('ifp-beta-numerator');
            expect(scores).toContain('ifp-denominator');

            // REAL-environment round-trip: importXML re-derives kinetics from the IFP tallies
            const backend = new OpenMCStudioBackendServiceImpl();
            const imported = await backend.importXML({ directory: dir });
            expect(imported.success).toBe(true);
            expect(imported.state!.settings.kinetics?.enabled).toBe(true);
            expect(imported.state!.settings.sources).toHaveLength(1);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN)(
        'output-control project: fixed-source run writes tracks.h5',
        async () => {
            const state = loadProjectState('fixed-source-tracks');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            runOpenMC(dir);

            const tracks = path.join(dir, 'tracks.h5');
            expect(fs.existsSync(tracks)).toBe(true);
            expect(fs.statSync(tracks).size).toBeGreaterThan(0);
        },
        RUN_TIMEOUT
    );

    it.skipIf(!CAN_RUN || !CHAIN_OK)(
        'depletion project: generated XML feeds run_depletion.py and produces depletion_results.h5',
        async () => {
            const state = loadProjectState('pincell-depletion');
            state.depletion = { ...state.depletion!, chainFile: CHAIN! };
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            const result = runPythonDriver('run_depletion.py', [
                dir,
                '--time-steps',
                '86400,86400',
                '--power',
                '1',
                '--solver',
                'predictor',
                '--operator',
                'coupled',
                '--chain-file',
                CHAIN!
            ]);

            expect(result.success).toBe(true);
            expect(fs.existsSync(path.join(dir, 'depletion_results.h5'))).toBe(true);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN)(
        'volume project: run_volume_calc.py against generated XML matches analytic cell volumes',
        async () => {
            const state = loadProjectState('pincell-volume');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            const result = runPythonDriver('run_volume_calc.py', [
                dir,
                '--domain-type',
                'cell',
                '--domain-ids',
                '1,2,3',
                '--samples',
                '5000',
                '--lower-left=-0.63,-0.63,-0.5',
                '--upper-right=0.63,0.63,0.5'
            ]);

            expect(result.success).toBe(true);
            const volumes = new Map<number, number>(result.results.map((r: any) => [r.id, r.volume]));
            const analytic = new Map([
                [1, Math.PI * 0.4 * 0.4],
                [2, Math.PI * (0.5 * 0.5 - 0.4 * 0.4)],
                [3, 1.26 * 1.26 - Math.PI * 0.5 * 0.5]
            ]);
            for (const [id, expected] of analytic) {
                expect(volumes.get(id)).toBeDefined();
                expect(volumes.get(id)!).toBeGreaterThan(expected * 0.9);
                expect(volumes.get(id)!).toBeLessThan(expected * 1.1);
            }
        },
        RUN_TIMEOUT
    );

    it.skipIf(!CAN_RUN)(
        'DAGMC project: dagmc_universe geometry from fuel_pin.h5m runs to a statepoint',
        async () => {
            const state = loadProjectState('dagmc-pincell');
            // Fixture stores no absolute path; point at the repo-local asset
            state.settings.dagmcFile = FUEL_PIN_H5M;
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            // The generator copies the h5m in as geometry.h5m
            expect(fs.existsSync(path.join(dir, 'geometry.h5m'))).toBe(true);

            runOpenMC(dir);

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
            const keff = parseFloat(evalInStatepoint(dir, 'sp.keff.n'));
            // DAGMC fuel pin is a small leaky model — wide plausibility band
            expect(keff).toBeGreaterThan(0.05);
            expect(keff).toBeLessThan(2.5);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN)(
        'CMFD project: run_cmfd.py driver accelerates the pincell and reports k-eff',
        async () => {
            const state = loadProjectState('pincell-cmfd');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            const result = runPythonDriver('run_cmfd.py', [dir, '--cmfd-config', JSON.stringify(state.settings.cmfd)]);

            expect(result.success).toBe(true);
            expect(result.statepoint && fs.existsSync(result.statepoint)).toBe(true);
            expect(result.kEff.mean).toBeGreaterThan(0.2);
            expect(result.kEff.mean).toBeLessThan(2.5);
        },
        RUN_TIMEOUT
    );

    it.skipIf(!CAN_RUN)(
        'mesh-source project: fixed-source MeshSource run produces a statepoint',
        async () => {
            const state = loadProjectState('mesh-source');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            // The mesh must be emitted into settings.xml (not tallies.xml)
            const settingsXml = fs.readFileSync(path.join(dir, 'settings.xml'), 'utf-8');
            expect(settingsXml).toContain('<source type="mesh" mesh="1"');
            expect(settingsXml).toContain('<mesh id="1" type="regular">');

            runOpenMC(dir);

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
        },
        RUN_TIMEOUT
    );

    it.skipIf(!CAN_RUN)(
        'random-ray project: MGXS library generated from the model drives a random-ray run',
        async () => {
            const state = loadProjectState('random-ray');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            // Step 1: generate the multigroup library from the CE model and
            // convert the settings to random ray (driver re-exports settings.xml)
            const mgxs = runPythonDriver('generate_mgxs.py', [
                dir,
                '--groups',
                'CASMO-2',
                '--particles',
                '300',
                '--output',
                'mgxs.h5',
                '--random-ray'
            ]);
            expect(mgxs.success).toBe(true);
            expect(mgxs.randomRayApplied).toBe(true);
            expect(fs.existsSync(path.join(dir, 'mgxs.h5'))).toBe(true);

            // Step 1.5: the multigroup run needs macroscopic materials (the
            // IDE's macroscopic emission path — MGXS generation itself needs
            // the microscopic definitions, hence the two-step state).
            // Macroscopic data requires density in 'macro' units (OpenMC).
            const mgState = loadProjectState('random-ray');
            for (const mat of mgState.materials) {
                mat.macroscopic = { name: mat.name };
                mat.density = 1.0;
                mat.densityUnit = 'macro';
            }
            const service = new XMLGenerationService();
            const mgXml = await service.generateXML({
                state: mgState,
                outputDirectory: dir,
                files: { materials: true, geometry: false, settings: false, tallies: false, plots: false }
            });
            expect(mgXml.success).toBe(true);

            // Step 2: random-ray run against the generated library
            const proc = spawnSync(OPENMC_EXE!, [], {
                cwd: dir,
                env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS, OPENMC_MG_CROSS_SECTIONS: path.join(dir, 'mgxs.h5') },
                timeout: RUN_TIMEOUT,
                encoding: 'utf-8'
            });
            expect(proc.status, `openmc multigroup failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN || !TOKAMAK_OK)(
        'tokamak-source project: fixed-source TokamakSource run produces a statepoint (0.15.4+)',
        async () => {
            const state = loadProjectState('tokamak-source');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            const settingsXml = fs.readFileSync(path.join(dir, 'settings.xml'), 'utf-8');
            expect(settingsXml).toContain('<source type="tokamak"');

            runOpenMC(dir);

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
        },
        RUN_TIMEOUT
    );

    it.skipIf(!CAN_RUN)(
        'derivative project: tally derivative reaches the statepoint with its derivative group',
        async () => {
            const state = loadProjectState('pincell-derivative');
            const dir = await generateToTempDir(state);
            tempDirs.push(dir);

            // Derivative is a top-level element + an ID reference on the tally
            const talliesXml = fs.readFileSync(path.join(dir, 'tallies.xml'), 'utf-8');
            expect(talliesXml).toContain('<derivative id="1" variable="nuclide_density" material="1" nuclide="U235"/>');
            expect(talliesXml).toContain('<derivative>1</derivative>');

            runOpenMC(dir);

            // The statepoint carries the derivative definition and a
            // /tallies/derivatives group (verified layout in 0.15.3)
            const info = evalInStatepoint(
                dir,
                '"%s|%s|%s|%s" % (sp.tallies[1].derivative.variable, sp.tallies[1].derivative.material, sp.tallies[1].derivative.nuclide, "derivatives" in __import__("h5py").File(sp_path, "r")["tallies"])'
            );
            expect(info).toBe('nuclide_density|1|U235|True');
        },
        RUN_TIMEOUT
    );

    it('v1.0.0 project migrates, generates XML, and round-trips (no run)', async () => {
        const legacyPath = path.join(PROJECTS_DIR, 'migration-v1.0.0.nuke-openmc');
        if (!fs.existsSync(legacyPath)) {
            console.warn(`migration fixture not found: ${legacyPath}`);
            return;
        }
        const project = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as OpenMCProjectFile;
        const { project: migrated, migratedFrom } = migrateProjectFile(project);
        expect(migratedFrom).toBe('1.0.0');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-e2e-legacy-'));
        tempDirs.push(dir);
        const service = new XMLGenerationService();
        const genResult = await service.generateXML({
            state: migrated.state,
            outputDirectory: dir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });
        expect(genResult.success).toBe(true);

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: dir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.sources).toHaveLength(migrated.state.settings.sources.length);
        expect(imported.state!.tallies).toHaveLength(migrated.state.tallies.length);
        expect(imported.state!.meshes).toHaveLength(migrated.state.meshes.length);
    }, 60_000);
});
