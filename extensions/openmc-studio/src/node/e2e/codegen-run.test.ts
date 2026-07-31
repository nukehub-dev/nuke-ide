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
 * Codegen execution e2e: project fixture → OpenMCPythonExporter (the real
 * browser-side codegen class) → model.py executed with the env python (the
 * generated script exports XML via model.export_to_xml()) → the exported XML
 * runs under the real openmc binary.
 *
 * The exporter class lives in src/browser but its GENERATION methods are free
 * of DOM usage; only its file-dialog/save paths touch browser services. The
 * three browser-only modules in its import chain are mocked below so the
 * class loads under node vitest without lumino (the P6A `document is not
 * defined` failure). Gated on NUKE_TEST_PYTHON + OPENMC_CROSS_SECTIONS.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Mock the browser-only modules in the exporter's import chain BEFORE it is
// imported (vitest hoists vi.mock calls to the top of the file)
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from '../../browser/script-generator/python-exporter';
import { migrateProjectFile } from '../../common/openmc-state-migration';
import { OpenMCProjectFile, OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const PROJECTS_DIR = path.resolve(__dirname, 'projects');

const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const RUN_TIMEOUT = 120_000;

/** Load and migrate a fixture project, returning the state. */
function loadProjectState(name: string): OpenMCState {
    const raw = fs.readFileSync(path.join(PROJECTS_DIR, `${name}.nuke-openmc`), 'utf-8');
    const project = JSON.parse(raw) as OpenMCProjectFile;
    return migrateProjectFile(project).project.state;
}

/** Run the real codegen for a state and execute the generated model.py. */
function exportAndRunScript(state: OpenMCState, dir: string): void {
    const exporter = new OpenMCPythonExporter();
    const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
        mode: 'single',
        includeComments: true
    });
    expect(script).toContain('model.export_to_xml()');

    const scriptPath = path.join(dir, 'model.py');
    fs.writeFileSync(scriptPath, script);

    // The generated script builds the model with the Python API and exports XML
    const pyProc = spawnSync(PYTHON!, [scriptPath], {
        cwd: dir,
        env: {
            ...process.env,
            OPENMC_CROSS_SECTIONS: CROSS_SECTIONS,
            PATH: `${path.dirname(PYTHON!)}${path.delimiter}${process.env.PATH ?? ''}`
        },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
    expect(pyProc.status, `generated model.py failed:\n${pyProc.stdout}\n${pyProc.stderr}`).toBe(0);

    // The exported XML runs under the real openmc binary
    const proc = spawnSync(OPENMC_EXE!, [], {
        cwd: dir,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
    expect(proc.status, `openmc failed on exported XML:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
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

describe('codegen execution e2e (real OpenMC)', () => {
    let tempDirs: string[] = [];

    beforeAll(() => {
        tempDirs = [];
    });

    afterAll(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!CAN_RUN)(
        'kinetics project: generated model.py exports XML that runs; IFP tallies reach the statepoint',
        () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-codegen-'));
            tempDirs.push(dir);
            exportAndRunScript(loadProjectState('pincell-kinetics'), dir);

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);

            const keff = parseFloat(evalInStatepoint(dir, 'sp.keff.n'));
            expect(keff).toBeGreaterThan(0.2);
            expect(keff).toBeLessThan(2.5);

            const scores = evalInStatepoint(dir, '" ".join(s for t in sp.tallies.values() for s in t.scores)');
            expect(scores).toContain('ifp-time-numerator');
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN)(
        'CMFD project: generated model.py with the CMFD block exports runnable XML',
        () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-codegen-'));
            tempDirs.push(dir);
            exportAndRunScript(loadProjectState('pincell-cmfd'), dir);

            // The script carries the (commented-out) CMFD run block
            const script = fs.readFileSync(path.join(dir, 'model.py'), 'utf-8');
            expect(script).toContain('openmc.cmfd.CMFDMesh()');
            expect(script).toContain('openmc.cmfd.CMFDRun()');

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN)(
        'mesh-source project: generated model.py with MeshSource exports runnable XML',
        () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-codegen-'));
            tempDirs.push(dir);
            exportAndRunScript(loadProjectState('mesh-source'), dir);

            const script = fs.readFileSync(path.join(dir, 'model.py'), 'utf-8');
            expect(script).toContain('openmc.MeshSource(');

            const statepoints = fs.readdirSync(dir).filter((f) => f.startsWith('statepoint'));
            expect(statepoints.length).toBeGreaterThan(0);
        },
        RUN_TIMEOUT * 2
    );
});
