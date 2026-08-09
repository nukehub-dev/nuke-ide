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
 * Tests for project save/load portability of external file paths
 * (DAGMC file, MGXS library) and DAGMC path resolution during XML generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { XMLGenerationService } from './xml-generation-service';
import { OpenMCState } from '../common/openmc-state-schema';

/** Build a minimal valid state. */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Path Test', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: []
        },
        tallies: [],
        meshes: [],
        plots: []
    } as OpenMCState;
}

describe('project save/load path portability', () => {
    let tempDir: string;
    let backend: OpenMCStudioBackendServiceImpl;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-paths-'));
        backend = new OpenMCStudioBackendServiceImpl();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('saves DAGMC and MGXS paths as project-relative and reloads them absolute', async () => {
        const projectPath = path.join(tempDir, 'test.nuke-openmc');
        const dagmcPath = path.join(tempDir, 'tokamak.h5m');
        const mgxsPath = path.join(tempDir, 'mgxs.h5');
        fs.writeFileSync(dagmcPath, 'dummy');
        fs.writeFileSync(mgxsPath, 'dummy');

        const state = buildState();
        state.settings.dagmcFile = dagmcPath;
        state.settings.dagmcInfo = {
            filePath: dagmcPath,
            fileName: 'tokamak.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 1,
            materials: {},
            volumes: [],
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
        };
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = mgxsPath;

        const saveResult = await backend.saveProject({ projectPath, state, generateXml: false });
        expect(saveResult.success).toBe(true);

        // Live state must remain absolute.
        expect(state.settings.dagmcFile).toBe(dagmcPath);
        expect(state.settings.dagmcInfo!.filePath).toBe(dagmcPath);
        expect(state.settings.mgxsLibrary).toBe(mgxsPath);

        const saved = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
        expect(saved.state.settings.dagmcFile).toBe('tokamak.h5m');
        expect(saved.state.settings.dagmcInfo.filePath).toBe('tokamak.h5m');
        expect(saved.state.settings.mgxsLibrary).toBe('mgxs.h5');

        const loadResult = await backend.loadProject(projectPath);
        expect(loadResult.success).toBe(true);
        expect(loadResult.project!.state.settings.dagmcFile).toBe(dagmcPath);
        expect(loadResult.project!.state.settings.dagmcInfo!.filePath).toBe(dagmcPath);
        expect(loadResult.project!.state.settings.mgxsLibrary).toBe(mgxsPath);
    });

    it('keeps already-relative paths unchanged on save and resolves them on load', async () => {
        const projectDir = path.join(tempDir, 'subdir');
        fs.mkdirSync(projectDir);
        const projectPath = path.join(projectDir, 'test.nuke-openmc');
        const dagmcPath = path.join(projectDir, 'tokamak.h5m');
        fs.writeFileSync(dagmcPath, 'dummy');

        const state = buildState();
        state.settings.dagmcFile = 'tokamak.h5m';
        state.settings.dagmcInfo = {
            filePath: 'tokamak.h5m',
            fileName: 'tokamak.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 1,
            materials: {},
            volumes: [],
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
        };

        const saveResult = await backend.saveProject({ projectPath, state, generateXml: false });
        expect(saveResult.success).toBe(true);

        const saved = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
        expect(saved.state.settings.dagmcFile).toBe('tokamak.h5m');

        const loadResult = await backend.loadProject(projectPath);
        expect(loadResult.success).toBe(true);
        expect(loadResult.project!.state.settings.dagmcFile).toBe(dagmcPath);
        expect(loadResult.project!.state.settings.dagmcInfo!.filePath).toBe(dagmcPath);
    });

    it('does not convert absolute paths that do not exist', async () => {
        const projectPath = path.join(tempDir, 'test.nuke-openmc');
        const dagmcPath = path.join(tempDir, 'missing.h5m');

        const state = buildState();
        state.settings.dagmcFile = dagmcPath;
        state.settings.dagmcInfo = {
            filePath: dagmcPath,
            fileName: 'missing.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 1,
            materials: {},
            volumes: [],
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
        };

        const saveResult = await backend.saveProject({ projectPath, state, generateXml: false });
        expect(saveResult.success).toBe(true);

        const saved = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
        expect(saved.state.settings.dagmcFile).toBe(dagmcPath);
        expect(saved.state.settings.dagmcInfo.filePath).toBe(dagmcPath);
    });
});

describe('XML generation DAGMC path resolution', () => {
    let tempDir: string;
    let projectDir: string;
    let generator: XMLGenerationService;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-dagmc-paths-'));
        projectDir = path.join(tempDir, 'project');
        fs.mkdirSync(projectDir);
        generator = new XMLGenerationService();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('copies a project-relative DAGMC file into a run subdirectory', async () => {
        const dagmcPath = path.join(projectDir, 'tokamak.h5m');
        fs.writeFileSync(dagmcPath, 'dummy');

        const state = buildState();
        state.settings.dagmcFile = 'tokamak.h5m';
        state.settings.dagmcInfo = {
            filePath: 'tokamak.h5m',
            fileName: 'tokamak.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 1,
            materials: {},
            volumes: [],
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
        };

        // Run directories are created under the project directory, so the
        // project-relative DAGMC path resolves via outputDirectory/.. .
        const outputDir = path.join(projectDir, 'run');
        const result = await generator.generateXML({
            state,
            outputDirectory: outputDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'geometry.h5m'))).toBe(true);
        const geometryXml = fs.readFileSync(path.join(outputDir, 'geometry.xml'), 'utf-8');
        expect(geometryXml).toContain('<dagmc_universe filename="geometry.h5m"');
    });

    it('copies an absolute DAGMC file into the output directory', async () => {
        const dagmcPath = path.join(projectDir, 'tokamak.h5m');
        fs.writeFileSync(dagmcPath, 'dummy');

        const state = buildState();
        state.settings.dagmcFile = dagmcPath;
        state.settings.dagmcInfo = {
            filePath: dagmcPath,
            fileName: 'tokamak.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 1,
            materials: {},
            volumes: [],
            boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
        };

        const outputDir = path.join(tempDir, 'run');
        const result = await generator.generateXML({
            state,
            outputDirectory: outputDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'geometry.h5m'))).toBe(true);
    });
});
