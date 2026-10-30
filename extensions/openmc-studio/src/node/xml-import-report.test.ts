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
 * XML import report tests: lossy/unsupported constructs must be classified as
 * ignored or needs-attention, never silently dropped, and DAGMC geometry must
 * retain its mesh reference.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';

let tempRoot: string;

/** Write a file into a fresh directory. */
function writeFixture(name: string, files: Record<string, string>): string {
    const directory = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
    for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(directory, file), content);
    }
    return directory;
}

const MATERIALS = `<?xml version="1.0"?>
<materials>
  <material id="1" name="Fuel">
    <density units="g/cm3" value="10.4"/>
    <nuclide ao="1" name="U235"/>
  </material>
</materials>`;

const GEOMETRY_WITH_LOSSY_CONSTRUCTS = `<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 10" boundary="vacuum" albedo="0.7"/>
  <cell id="1" material="1" region="-1"/>
  <cell id="2" material="void" region="+1" rotation="1 0 0 0 1 0 0 0 1"/>
</geometry>`;

const SETTINGS_WITH_WW_WITHOUT_ENERGY = `<?xml version="1.0"?>
<settings>
  <run_mode>eigenvalue</run_mode>
  <particles>100</particles>
  <batches>5</batches>
  <inactive>2</inactive>
  <weight_windows id="1">
    <mesh>1</mesh>
    <particle_type>neutron</particle_type>
    <lower_ww_bounds>0.5</lower_ww_bounds>
    <upper_ww_bounds>1.0</upper_ww_bounds>
  </weight_windows>
  <mesh id="1" type="regular">
    <lower_left>-10 -10 -10</lower_left>
    <upper_right>10 10 10</upper_right>
    <dimension>2 2 2</dimension>
  </mesh>
</settings>`;

const TALLIES_WITH_PARTICLE_NAME = `<?xml version="1.0"?>
<tallies>
  <filter id="1" type="particle">
    <bins>muon</bins>
  </filter>
  <tally id="1" name="Muon flux">
    <filters>1</filters>
    <scores>flux</scores>
  </tally>
</tallies>`;

describe('XML import report', () => {
    beforeAll(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-import-report-'));
    });

    afterAll(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('reports imported counts plus ignored and needs-attention constructs', async () => {
        const directory = writeFixture('lossy', {
            'materials.xml': MATERIALS,
            'geometry.xml': GEOMETRY_WITH_LOSSY_CONSTRUCTS,
            'settings.xml': SETTINGS_WITH_WW_WITHOUT_ENERGY,
            'tallies.xml': TALLIES_WITH_PARTICLE_NAME
        });
        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.importXML({ directory });

        expect(result.success, result.errors.join('; ')).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.report).toBeDefined();
        const report = result.report!;
        expect(report.imported).toMatchObject({
            materials: 1,
            surfaces: 1,
            cells: 2,
            tallies: 1,
            meshes: 1,
            sources: 0
        });
        expect(report.files).toEqual(expect.arrayContaining(['materials.xml', 'geometry.xml', 'settings.xml', 'tallies.xml']));
        expect(report.ignored.some((message) => message.includes('9-element rotation'))).toBe(true);
        expect(report.needsAttention.some((message) => message.includes('albedo'))).toBe(true);
        expect(report.ignored.some((message) => message.includes('muon'))).toBe(true);
        expect(result.warnings.some((message) => message.includes('9-element rotation'))).toBe(true);

        // A weight-window set without energy bounds must not abort settings import.
        expect(result.state?.varianceReduction?.weightWindows).toHaveLength(1);
        expect(result.state?.varianceReduction?.weightWindows?.[0].lowerBound).toBe(0.5);
    });

    it('keeps a DAGMC geometry reference and flags the mesh metadata boundary', async () => {
        const directory = writeFixture('dagmc', {
            'materials.xml': MATERIALS,
            'geometry.xml': `<?xml version="1.0"?>
<geometry>
  <dagmc_universe filename="model.h5m" id="1" auto_geom_ids="true"/>
</geometry>`,
            'settings.xml': `<?xml version="1.0"?>
<settings>
  <run_mode>eigenvalue</run_mode>
  <particles>100</particles>
  <batches>5</batches>
  <inactive>2</inactive>
</settings>`
        });
        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.importXML({ directory });

        expect(result.success, result.errors.join('; ')).toBe(true);
        expect(result.state?.settings.dagmcFile).toBe('model.h5m');
        expect(result.state?.geometry.cells).toEqual([]);
        expect(result.report?.needsAttention.some((message) => message.includes('DAGMC'))).toBe(true);
    });

    it('classifies every warning into exactly one report bucket', async () => {
        const directory = writeFixture('buckets', {
            'materials.xml': MATERIALS,
            'geometry.xml': GEOMETRY_WITH_LOSSY_CONSTRUCTS,
            'settings.xml': SETTINGS_WITH_WW_WITHOUT_ENERGY
        });
        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.importXML({ directory });
        const report = result.report!;
        expect(report.ignored.length + report.needsAttention.length).toBe(result.warnings.length);
        for (const message of result.warnings) {
            expect(report.ignored.includes(message) || report.needsAttention.includes(message)).toBe(true);
        }
    });
});
