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
 * E2E for the one-click CE → multi-group conversion (P9B): a real CE pincell
 * fixture is converted by the python driver, the state-mapping logic applies
 * the conversion, the converted project runs multi-group for real, and the
 * revert restores the originals. Full profile only: gated on NUKE_TEST_PYTHON
 * (env python with openmc) and OPENMC_CROSS_SECTIONS.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { XMLGenerationService } from '../xml-generation-service';
import { migrateProjectFile } from '../../common/openmc-state-migration';
import { computeMgConversion, computeMgRevert } from '../../common/mg-conversion';
import { OpenMCProjectFile, OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const PYTHON_DIR = path.resolve(__dirname, '../../../python');
const PROJECTS_DIR = path.resolve(__dirname, 'projects');

const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const SKIP_REASON = 'e2e requires NUKE_TEST_PYTHON (env python with openmc) and OPENMC_CROSS_SECTIONS';
const RUN_TIMEOUT = 120_000;

const tempDirs: string[] = [];
afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function loadProjectState(name: string): OpenMCState {
    const raw = fs.readFileSync(path.join(PROJECTS_DIR, `${name}.nuke-openmc`), 'utf-8');
    const project = JSON.parse(raw) as OpenMCProjectFile;
    return migrateProjectFile(project).project.state;
}

async function generateToTempDir(state: OpenMCState): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-mgconv-e2e-'));
    tempDirs.push(dir);
    const service = new XMLGenerationService();
    const result = await service.generateXML({
        state,
        outputDirectory: dir,
        files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
    });
    expect(result.success).toBe(true);
    return dir;
}

function runPythonDriver(script: string, args: string[], extraEnv: Record<string, string> = {}): any {
    const proc = spawnSync(PYTHON!, [path.join(PYTHON_DIR, script), ...args], {
        env: {
            ...process.env,
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

describe.skipIf(!CAN_RUN)(`mg conversion e2e (real OpenMC) — ${SKIP_REASON}`, () => {
    it(
        'CE pincell converts to multi-group, runs MG for real, and reverts cleanly',
        async () => {
            const state = loadProjectState('random-ray');
            const originalNames = state.materials.map((m) => m.name);
            expect(state.settings.energyMode ?? 'continuous-energy').toBe('continuous-energy');
            expect(state.materials.every((m) => !m.macroscopic)).toBe(true);

            // Step 1: convert with the real driver
            const dir = await generateToTempDir(state);
            const result = runPythonDriver('convert_to_multigroup_project.py', [
                dir,
                '--groups',
                'CASMO-2',
                '--particles',
                '300',
                '--output',
                'mgxs.h5'
            ]);
            expect(result.success).toBe(true);
            expect(fs.existsSync(result.mgxsPath)).toBe(true);
            expect(result.xsDataNames.map((m: any) => m.materialName).sort()).toEqual([...originalNames].sort());

            // Step 2: apply the conversion via the shared state logic
            const updates = computeMgConversion(state, result.xsDataNames, result.mgxsPath);
            expect(updates.convertedNames.sort()).toEqual([...originalNames].sort());
            for (const material of updates.materials) {
                expect(material.macroscopic).toEqual({ name: material.name });
                expect(material.densityUnit).toBe('macro');
                expect(material.density).toBe(1.0);
            }
            expect(updates.settings).toEqual({ energyMode: 'multigroup', mgxsLibrary: result.mgxsPath });
            // Backup stashes the untouched originals
            expect(updates.mgBackup.materials.map((m) => m.name)).toEqual(originalNames);
            expect(updates.mgBackup.materials.every((m) => !m.macroscopic)).toBe(true);

            // Step 3: the converted project actually runs multi-group
            const mgState: OpenMCState = {
                ...state,
                materials: updates.materials,
                settings: { ...state.settings, ...updates.settings },
                metadata: { ...state.metadata, mgBackup: updates.mgBackup }
            };
            const mgDir = await generateToTempDir(mgState);
            const proc = spawnSync(OPENMC_EXE!, [], {
                cwd: mgDir,
                env: {
                    ...process.env,
                    OPENMC_CROSS_SECTIONS: CROSS_SECTIONS,
                    OPENMC_MG_CROSS_SECTIONS: result.mgxsPath
                },
                timeout: RUN_TIMEOUT,
                encoding: 'utf-8'
            });
            expect(proc.status, `openmc multigroup failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);

            // Step 4: revert restores the originals
            const revert = computeMgRevert(mgState);
            expect(revert).toBeDefined();
            expect(revert!.materials.map((m) => m.name)).toEqual(originalNames);
            expect(revert!.materials.every((m) => !m.macroscopic)).toBe(true);
            expect(revert!.energyMode).toBe(state.settings.energyMode);
        },
        RUN_TIMEOUT * 2
    );
});
