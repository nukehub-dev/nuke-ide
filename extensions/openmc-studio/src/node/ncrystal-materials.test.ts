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
 * Tests for NCrystal material support (`OpenMCMaterial.ncrystalCfg`): the cfg
 * must reach materials.xml as the `<material cfg="...">` attribute (otherwise
 * the material silently runs on plain ACE data) and survive the XML import
 * round-trip. The Python exporter's `from_ncrystal` branch is not covered
 * here — the exporter import chain needs a DOM (no jsdom in vitest).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from './xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCState, OpenMCMaterial } from '../common/openmc-state-schema';

const NCRYSTAL_CFG = 'LiquidWaterH2O_T293.6K.ncmat;temp=293.6K';

function ncrystalWater(): OpenMCMaterial {
    return {
        id: 1,
        name: 'NCrystal water',
        density: 0.9982,
        densityUnit: 'g/cm3',
        nuclides: [
            { name: 'H1', fraction: 2.0, fractionType: 'ao' },
            { name: 'O16', fraction: 1.0, fractionType: 'ao' }
        ],
        thermalScattering: [],
        temperature: 293.6,
        ncrystalCfg: NCRYSTAL_CFG
    };
}

function buildState(material: OpenMCMaterial): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'ncrystal-test', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1 }],
            universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [material],
        settings: {
            run: { mode: 'eigenvalue', particles: 1000, inactive: 20, batches: 100 },
            sources: []
        },
        tallies: [],
        meshes: []
    };
}

describe('NCrystal materials', () => {
    const tempDirs: string[] = [];

    function tempDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrystal-mat-'));
        tempDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    it('emits the cfg attribute on <material> and keeps the flattened nuclides', async () => {
        const dir = tempDir();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state: buildState(ncrystalWater()),
            outputDirectory: dir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(dir, 'materials.xml'), 'utf-8');
        expect(materialsXml).toContain(`cfg="${NCRYSTAL_CFG}"`);
        // Flattened composition stays (non-scattering reactions, tallies)
        expect(materialsXml).toContain('<nuclide ao="2" name="H1"/>');
        expect(materialsXml).toContain('<nuclide ao="1" name="O16"/>');
    });

    it('omits the cfg attribute for plain materials', async () => {
        const dir = tempDir();
        const plain = ncrystalWater();
        delete plain.ncrystalCfg;
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state: buildState(plain),
            outputDirectory: dir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(dir, 'materials.xml'), 'utf-8');
        expect(materialsXml).not.toContain('cfg=');
    });

    it('parses the cfg attribute back on XML import (round-trip)', async () => {
        const dir = tempDir();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state: buildState(ncrystalWater()),
            outputDirectory: dir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: dir });
        expect(imported.success).toBe(true);
        const material = imported.state!.materials.find((m) => m.id === 1);
        expect(material?.ncrystalCfg).toBe(NCRYSTAL_CFG);
    });
});
