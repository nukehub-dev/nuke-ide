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
 * Geometry e2e against a real OpenMC Python install.
 *
 * Generates geometry.xml from the state, loads it with `openmc.Geometry` and
 * compares the resulting model facts with the Python exporter's generated
 * `model.py`. Lattice ordering, transforms, periodic pairs, and albedo must
 * agree between both paths. The transport test additionally runs the OpenMC
 * binary when cross sections are available and skips cleanly otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Mock the browser-only modules in the exporter's import chain before it loads.
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from '../../browser/script-generator/python-exporter';
import { XMLGenerationService } from '../xml-generation-service';
import { OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const HAS_PYTHON = !!(PYTHON && fs.existsSync(PYTHON));
const CAN_RUN_TRANSPORT = !!(HAS_PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));

/** Metadata helper. */
function metadata(): OpenMCState['metadata'] {
    const now = new Date().toISOString();
    return { version: '1.1.0', name: 'Geometry Core E2E', created: now, modified: now };
}

/** Shared materials/settings for the geometry fixtures. */
function materialsAndSettings(): Pick<OpenMCState, 'materials' | 'settings' | 'tallies' | 'meshes'> {
    return {
        materials: [
            {
                id: 1,
                name: 'Fuel',
                density: 10,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            },
            {
                id: 2,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 20, inactive: 2, batches: 5 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

/** 2×2×1 lattice with transforms, periodic pairs, and albedo. */
function buildRectState(): OpenMCState {
    return {
        metadata: metadata(),
        geometry: {
            surfaces: [
                { id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 0.4 } },
                { id: 2, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 4, albedo: 0.9 },
                { id: 3, type: 'y-plane', coefficients: { y0: -1 }, boundary: 'periodic', periodicSurfaceId: 5, albedo: 0.9 },
                { id: 4, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic', periodicSurfaceId: 2, albedo: 0.9 },
                { id: 5, type: 'y-plane', coefficients: { y0: 1 }, boundary: 'periodic', periodicSurfaceId: 3, albedo: 0.9 },
                { id: 6, type: 'z-plane', coefficients: { z0: -10 }, boundary: 'vacuum' },
                { id: 7, type: 'z-plane', coefficients: { z0: 10 }, boundary: 'vacuum' }
            ],
            cells: [
                { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1', density: 10.4 },
                { id: 2, name: 'Gap', fillType: 'void', regionString: '1' },
                { id: 3, name: 'Coolant', fillType: 'material', fillId: 2 },
                {
                    id: 4,
                    name: 'Assembly',
                    fillType: 'lattice',
                    fillId: 10,
                    regionString: '2 -4 3 -5 6 -7',
                    rotation: [0, 0, 30],
                    translation: [0.25, -0.5, 0]
                },
                { id: 5, name: 'Outer fill', fillType: 'void' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [4] },
                { id: 1, name: 'fuel pin', cellIds: [1, 2] },
                { id: 2, name: 'coolant', cellIds: [3] },
                { id: 3, name: 'outer', cellIds: [5] }
            ],
            lattices: [
                {
                    id: 10,
                    type: 'rect',
                    name: 'Assembly',
                    lowerLeft: [-1, -1, -10],
                    pitch: [1, 1, 20],
                    dimensions: [2, 2, 1],
                    universes: [
                        [
                            [1, 2],
                            [2, 1]
                        ]
                    ],
                    outer: 3
                }
            ],
            rootUniverseId: 0
        },
        ...materialsAndSettings()
    };
}

/** 2D and 3D hexagonal lattice fixture. */
function buildHexState(orientation: 'x' | 'y', nAxial?: number): OpenMCState {
    const is3d = nAxial !== undefined && nAxial > 1;
    const ringA = [[1, 1, 1, 1, 1, 1], [2]];
    const ringB = [[2, 2, 2, 2, 2, 2], [1]];
    return {
        metadata: metadata(),
        geometry: {
            surfaces: [
                { id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 5 } },
                { id: 2, type: 'z-plane', coefficients: { z0: -10 }, boundary: 'vacuum' },
                { id: 3, type: 'z-plane', coefficients: { z0: 10 }, boundary: 'vacuum' }
            ],
            cells: [
                { id: 1, fillType: 'material', fillId: 1, regionString: '-1' },
                { id: 2, fillType: 'material', fillId: 2 },
                { id: 3, fillType: 'lattice', fillId: 20, regionString: '-1 2 -3', rotation: [0, 0, 15], translation: [0, 0, 0] },
                { id: 4, fillType: 'void' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [3] },
                { id: 1, name: 'fuel', cellIds: [1] },
                { id: 2, name: 'moderator', cellIds: [2] },
                { id: 3, name: 'outer', cellIds: [4] }
            ],
            lattices: [
                {
                    id: 20,
                    type: 'hex',
                    name: 'Hex Assembly',
                    rings: 2,
                    ...(orientation === 'x' ? { orientation: 'x' as const } : {}),
                    ...(nAxial !== undefined ? { nAxial } : {}),
                    center: is3d ? [0, 0, 0] : [0, 0],
                    pitch: is3d ? [1, 2] : [1],
                    universes: is3d ? [ringA, ringB] : [ringA],
                    outer: 3
                }
            ],
            rootUniverseId: 0
        },
        ...materialsAndSettings()
    };
}

/** Geometry facts script shared by XML and Python-export paths. */
const FACTS_SCRIPT = `
import json
import os
import openmc

materials = openmc.Materials.from_xml('materials.xml') if os.path.exists('materials.xml') else openmc.Materials()
geometry = openmc.Geometry.from_xml('geometry.xml', materials=materials)
cells = {}
surfaces = {}
for universe in geometry.get_all_universes().values():
    for cell in universe.cells.values():
        cells[str(cell.id)] = {
            'universe': universe.id,
            'fill_type': cell.fill_type,
            'fill_id': None if cell.fill is None else getattr(cell.fill, 'id', None),
            'rotation': None if cell.rotation is None else [float(x) for x in cell.rotation],
            'translation': None if cell.translation is None else [float(x) for x in cell.translation],
            'density': None if cell.density is None else float(cell.density),
        }
        if cell.region is not None:
            for surface in cell.region.get_surfaces().values():
                periodic = None
                if hasattr(surface, 'periodic_surface') and surface.periodic_surface is not None:
                    periodic = surface.periodic_surface.id
                surfaces[str(surface.id)] = {
                    'type': surface.type,
                    'boundary': surface.boundary_type,
                    'albedo': float(surface.albedo),
                    'periodic': periodic,
                }

lattices = {}
def universe_ids(value):
    if hasattr(value, 'id'):
        return value.id
    return [universe_ids(entry) for entry in value]

for cell in geometry.get_all_cells().values():
    if cell.fill_type != 'lattice' or cell.fill is None:
        continue
    lattice = cell.fill
    entry = {
        'id': lattice.id,
        'pitch': [float(x) for x in lattice.pitch],
        'outer': None if lattice.outer is None else lattice.outer.id,
    }
    if isinstance(lattice, openmc.RectLattice):
        entry['kind'] = 'rect'
        entry['lower_left'] = [float(x) for x in lattice.lower_left]
        entry['universes'] = universe_ids(lattice.universes)
    else:
        entry['kind'] = 'hex'
        entry['center'] = [float(x) for x in lattice.center]
        entry['orientation'] = lattice.orientation
        entry['num_rings'] = lattice.num_rings
        entry['num_axial'] = lattice.num_axial
        entry['universes'] = universe_ids(lattice.universes)
    lattices[str(lattice.id)] = entry

print(json.dumps({
    'root': geometry.root_universe.id,
    'cells': cells,
    'surfaces': surfaces,
    'lattices': lattices,
}, sort_keys=True))
`;

/** Run a Python script in `cwd` and parse its stdout as JSON. */
function runFactsScript(cwd: string): Record<string, any> {
    fs.writeFileSync(path.join(cwd, 'inspect_geometry.py'), FACTS_SCRIPT);
    const proc = spawnSync(PYTHON!, ['inspect_geometry.py'], {
        cwd,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS ?? '' },
        timeout: 120_000,
        encoding: 'utf-8'
    });
    expect(proc.status, `geometry inspection failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout.trim());
}

/** Generate geometry.xml for a state. */
async function generateGeometryXml(state: OpenMCState, directory: string): Promise<void> {
    const service = new XMLGenerationService();
    const result = await service.generateXML({
        state,
        outputDirectory: directory,
        files: { materials: true, geometry: true, settings: false, tallies: false, plots: false }
    });
    expect(result.success).toBe(true);
}

/** Execute the exporter-generated model.py in `directory`. */
function exportPythonModel(state: OpenMCState, directory: string): void {
    const exporter = new OpenMCPythonExporter();
    const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
        mode: 'single',
        includeComments: true
    });
    const scriptPath = path.join(directory, 'model.py');
    fs.writeFileSync(scriptPath, script);
    const proc = spawnSync(PYTHON!, [scriptPath], {
        cwd: directory,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS ?? '' },
        timeout: 120_000,
        encoding: 'utf-8'
    });
    expect(proc.status, `generated model.py failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
}

describe.skipIf(!HAS_PYTHON)('geometry core e2e (real OpenMC Python)', () => {
    let tempDirs: string[] = [];

    beforeAll(() => {
        tempDirs = [];
    });

    afterAll(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Create a temp directory tracked for cleanup. */
    function tempDir(label: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openmc-geometry-${label}-`));
        tempDirs.push(dir);
        return dir;
    }

    it('loads the generated rectangular lattice, transforms, periodic pairs, and albedo', async () => {
        const dir = tempDir('rect');
        await generateGeometryXml(buildRectState(), dir);
        const facts = runFactsScript(dir);

        expect(facts.root).toBe(0);
        expect(facts.lattices['10']).toMatchObject({
            kind: 'rect',
            pitch: [1, 1, 20],
            lower_left: [-1, -1, -10],
            outer: 3,
            universes: [
                [
                    [1, 2],
                    [2, 1]
                ]
            ]
        });
        expect(facts.cells['1']).toMatchObject({ universe: 1, fill_type: 'material', fill_id: 1, density: 10.4 });
        expect(facts.cells['4']).toMatchObject({
            universe: 0,
            fill_type: 'lattice',
            fill_id: 10,
            rotation: [0, 0, 30],
            translation: [0.25, -0.5, 0]
        });
        expect(facts.surfaces['2']).toMatchObject({ boundary: 'periodic', periodic: 4, albedo: 0.9 });
        expect(facts.surfaces['4']).toMatchObject({ boundary: 'periodic', periodic: 2, albedo: 0.9 });
    }, 30_000);

    it('loads 2D hexagonal lattices in both orientations', async () => {
        for (const orientation of ['y', 'x'] as const) {
            const dir = tempDir(`hex2d-${orientation}`);
            await generateGeometryXml(buildHexState(orientation), dir);
            const facts = runFactsScript(dir);
            const lattice = facts.lattices['20'];
            expect(lattice).toMatchObject({
                kind: 'hex',
                pitch: [1],
                center: [0, 0],
                orientation,
                num_rings: 2,
                num_axial: null,
                outer: 3
            });
            expect(lattice.universes).toEqual([[1, 1, 1, 1, 1, 1], [2]]);
        }
    }, 30_000);

    it('loads a 3D hexagonal lattice with axial pitch and levels', async () => {
        const dir = tempDir('hex3d');
        await generateGeometryXml(buildHexState('x', 2), dir);
        const facts = runFactsScript(dir);
        expect(facts.lattices['20']).toMatchObject({
            kind: 'hex',
            pitch: [1, 2],
            center: [0, 0, 0],
            orientation: 'x',
            num_rings: 2,
            num_axial: 2,
            universes: [
                [[1, 1, 1, 1, 1, 1], [2]],
                [[2, 2, 2, 2, 2, 2], [1]]
            ]
        });
    }, 30_000);

    it('produces the same geometry from the Python exporter as from XML', async () => {
        for (const [label, state] of [
            ['rect', buildRectState()],
            ['hex2d-y', buildHexState('y')],
            ['hex2d-x', buildHexState('x')],
            ['hex3d-x', buildHexState('x', 2)]
        ] as const) {
            const xmlDir = tempDir(`${label}-xml`);
            await generateGeometryXml(state, xmlDir);
            const xmlFacts = runFactsScript(xmlDir);

            const pythonDir = tempDir(`${label}-python`);
            exportPythonModel(state, pythonDir);
            const pythonFacts = runFactsScript(pythonDir);

            expect(pythonFacts).toEqual(xmlFacts);
        }
    }, 120_000);
});

describe.skipIf(!CAN_RUN_TRANSPORT)('geometry core transport e2e (real OpenMC binary)', () => {
    it('runs a 2×2 lattice and produces a statepoint', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-geometry-run-'));
        try {
            const state = buildRectState();
            state.geometry.cells[3].rotation = undefined;
            state.geometry.cells[3].translation = undefined;
            state.settings.run = { mode: 'eigenvalue', particles: 20, inactive: 2, batches: 5 };
            // Center of the fuel pin at lattice position (x=1, y=0); the origin
            // sits on lattice boundaries and would be rejected by OpenMC.
            state.settings.sources = [
                {
                    spatial: { type: 'point', origin: [0.5, -0.5, 0] },
                    energy: { type: 'discrete', energies: [2e6] }
                }
            ];

            const service = new XMLGenerationService();
            const generated = await service.generateXML({
                state,
                outputDirectory: dir,
                files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
            });
            expect(generated.success).toBe(true);

            const proc = spawnSync(OPENMC_EXE!, [], {
                cwd: dir,
                env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
                timeout: 120_000,
                encoding: 'utf-8'
            });
            expect(proc.status, `openmc failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);

            const statepoints = fs.readdirSync(dir).filter((file) => file.startsWith('statepoint') && file.endsWith('.h5'));
            expect(statepoints.length).toBeGreaterThan(0);

            const check = spawnSync(
                PYTHON!,
                ['-c', `import openmc; sp = openmc.StatePoint("${statepoints[0]}"); print(f"{sp.keff.nominal_value:.6f}")`],
                { cwd: dir, env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS }, timeout: 60_000, encoding: 'utf-8' }
            );
            expect(check.status, `statepoint read failed:\n${check.stdout}\n${check.stderr}`).toBe(0);
            expect(Number(check.stdout.trim())).toBeGreaterThan(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 180_000);
});
