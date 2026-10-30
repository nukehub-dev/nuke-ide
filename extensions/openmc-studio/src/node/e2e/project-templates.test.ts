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
 * Real-OpenMC smoke runs for every runnable project template.
 *
 * The run count is reduced after building the template so the test checks
 * transport, not statistics. Gated on NUKE_TEST_PYTHON (an OpenMC-capable
 * python whose bin/ contains `openmc`) and OPENMC_CROSS_SECTIONS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { XMLGenerationService } from '../xml-generation-service';
import { buildProjectTemplate } from '../../common/project-templates';
import { OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const SKIP_REASON = 'template e2e requires NUKE_TEST_PYTHON (env python with openmc) and OPENMC_CROSS_SECTIONS';

const RUNNABLE_TEMPLATES = ['pin-cell', 'fuel-assembly', 'full-core', 'shielding', 'criticallity-safety'] as const;
const RUN_TIMEOUT = 120_000;

/** Reduce the template run to a smoke-test length without changing the model. */
function shortenRun(state: OpenMCState): void {
    if (state.settings.run.mode === 'eigenvalue') {
        state.settings.run.particles = 100;
        state.settings.run.inactive = 2;
        state.settings.run.batches = 5;
    } else if (state.settings.run.mode === 'fixed source') {
        state.settings.run.particles = 250;
        state.settings.run.batches = 5;
    }
}

/** Run OpenMC and return the process result. */
function runOpenMC(directory: string): ReturnType<typeof spawnSync> {
    return spawnSync(OPENMC_EXE!, [], {
        cwd: directory,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
}

/** Read a scalar from the generated statepoint. */
function evalInStatepoint(directory: string, snippet: string): string {
    const script = [
        'import glob, openmc',
        'sp_path = sorted(glob.glob("statepoint*.h5"))[-1]',
        'with openmc.StatePoint(sp_path) as sp:',
        `    print(${snippet})`
    ].join('\n');
    const result = spawnSync(PYTHON!, ['-c', script], {
        cwd: directory,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: 60_000,
        encoding: 'utf-8'
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
}

describe('project templates e2e (real OpenMC)', () => {
    const tempDirs: string[] = [];

    beforeAll(() => {
        if (!CAN_RUN) {
            console.warn(SKIP_REASON);
        }
    });

    afterAll(() => {
        for (const directory of tempDirs) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it.skipIf(!CAN_RUN)('pin cell and shielding complete a short transport run', async () => {
        for (const templateId of ['pin-cell', 'shielding'] as const) {
            const state = buildProjectTemplate(templateId);
            shortenRun(state);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openmc-template-${templateId}-`));
            tempDirs.push(directory);
            const service = new XMLGenerationService();
            const generated = await service.generateXML({
                state,
                outputDirectory: directory,
                files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
            });
            expect(generated.success, generated.error).toBe(true);

            const run = runOpenMC(directory);
            expect(run.status, `openmc failed for ${templateId}:\n${run.stdout}\n${run.stderr}`).toBe(0);
            expect(
                fs.readdirSync(directory).some((file) => file.startsWith('statepoint') && file.endsWith('.h5')),
                templateId
            ).toBe(true);
            expect(evalInStatepoint(directory, 'len(sp.tallies)')).toBe('1');
        }
    });

    it.skipIf(!CAN_RUN)('every runnable template initializes and transports particles without lost-particle errors', async () => {
        for (const templateId of RUNNABLE_TEMPLATES) {
            const state = buildProjectTemplate(templateId);
            shortenRun(state);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openmc-template-${templateId}-`));
            tempDirs.push(directory);
            const service = new XMLGenerationService();
            const generated = await service.generateXML({
                state,
                outputDirectory: directory,
                files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
            });
            expect(generated.success, generated.error).toBe(true);

            const run = runOpenMC(directory);
            expect(run.status, `openmc failed for ${templateId}:\n${run.stdout}\n${run.stderr}`).toBe(0);
            expect(run.stderr, templateId).not.toContain('lost particle');
            expect(run.stdout, templateId).not.toContain('could not be located in any cell');
        }
    });
});
