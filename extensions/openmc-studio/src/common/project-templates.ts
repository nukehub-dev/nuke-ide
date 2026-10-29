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
 * Runnable project templates for common OpenMC models.
 *
 * Every builder returns a complete {@link OpenMCState} using the same schema
 * as an imported or user-authored project — there is no second template
 * format. Templates are intentionally small enough to run in seconds, but
 * they use real materials, geometry, sources, and tallies.
 *
 * @module openmc-studio/common
 */

import {
    OPENMC_STATE_SCHEMA_VERSION,
    OpenMCCell,
    OpenMCLattice,
    OpenMCMaterial,
    OpenMCNuclide,
    OpenMCProjectTemplate,
    OpenMCProjectTemplateType,
    OpenMCSurface,
    OpenMCSurfaceType,
    OpenMCTally,
    OpenMCState
} from './openmc-state-schema';

/** Numeric template parameter values keyed by parameter name. */
export type ProjectTemplateParameters = Record<string, number | string | undefined>;

/** Materials shared by the reactor templates. */
const UO2_FUEL_RADIUS = 0.4096;
const CLAD_INNER_RADIUS = 0.418;
const CLAD_OUTER_RADIUS = 0.475;
const GUIDE_INNER_RADIUS = 0.561;
const GUIDE_OUTER_RADIUS = 0.602;
const DEFAULT_PIN_PITCH = 1.26;
const DEFAULT_ACTIVE_HEIGHT = 100;

/** 17x17 PWR guide-tube rows/columns (zero-based). The center is the instrument tube. */
const GUIDE_GRID = [2, 5, 8, 11, 14];

/** Natural zirconium isotope abundances (atomic). */
const NATURAL_ZIRCONIUM: OpenMCNuclide[] = [
    { name: 'Zr90', fraction: 0.5145, fractionType: 'ao' },
    { name: 'Zr91', fraction: 0.1122, fractionType: 'ao' },
    { name: 'Zr92', fraction: 0.1715, fractionType: 'ao' },
    { name: 'Zr94', fraction: 0.1738, fractionType: 'ao' },
    { name: 'Zr96', fraction: 0.028, fractionType: 'ao' }
];

/** Natural lead isotope abundances (atomic). */
const NATURAL_LEAD: OpenMCNuclide[] = [
    { name: 'Pb204', fraction: 0.014, fractionType: 'ao' },
    { name: 'Pb206', fraction: 0.241, fractionType: 'ao' },
    { name: 'Pb207', fraction: 0.221, fractionType: 'ao' },
    { name: 'Pb208', fraction: 0.524, fractionType: 'ao' }
];

/** Clamp a numeric parameter to a safe range. */
function numericParameter(parameters: ProjectTemplateParameters, key: string, fallback: number, min: number, max: number): number {
    const value = Number(parameters[key]);
    const selected = Number.isFinite(value) ? value : fallback;
    return Math.min(Math.max(selected, min), max);
}

/** Round a display/preview value without changing the model precision materially. */
function round(value: number, digits = 3): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/** Format an enrichment percentage for names and previews. */
function formatPercent(value: number): string {
    return `${round(value, 2)}%`;
}

/** Build a surface with the schema's discriminated union kept in one place. */
function surface(
    id: number,
    type: OpenMCSurfaceType,
    coefficients: OpenMCSurface['coefficients'],
    extra: Pick<OpenMCSurface, 'boundary' | 'name' | 'periodicSurfaceId' | 'albedo'> = {}
): OpenMCSurface {
    return { id, type, coefficients, ...extra } as OpenMCSurface;
}

/** Build a cell with a compact, explicit region string. */
function cell(id: number, fillType: OpenMCCell['fillType'], fillId: number | undefined, regionString: string, name?: string): OpenMCCell {
    return { id, name, fillType, fillId, regionString };
}

/** Fresh empty state with the same defaults as a blank project. */
function baseState(name: string, description?: string): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: {
            version: OPENMC_STATE_SCHEMA_VERSION,
            name,
            description,
            created: now,
            modified: now
        },
        geometry: {
            surfaces: [],
            cells: [],
            universes: [{ id: 0, name: 'root', cellIds: [] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [],
        settings: {
            run: { mode: 'eigenvalue', particles: 2000, inactive: 20, batches: 100 },
            sources: []
        },
        tallies: [],
        meshes: []
    };
}

/** Uranium dioxide fuel at the requested U-235 enrichment (atom %). */
function uo2Fuel(enrichmentPct: number): OpenMCMaterial {
    return {
        id: 1,
        name: `UO2 (${formatPercent(enrichmentPct)} U-235)`,
        density: 10.4,
        densityUnit: 'g/cm3',
        nuclides: [
            { name: 'U235', fraction: enrichmentPct, fractionType: 'ao' },
            { name: 'U238', fraction: 100 - enrichmentPct, fractionType: 'ao' },
            { name: 'O16', fraction: 200, fractionType: 'ao' }
        ],
        thermalScattering: [],
        color: '#f37524'
    };
}

/** Zircaloy-4 cladding (natural zirconium with a representative density). */
function zircaloy(): OpenMCMaterial {
    return {
        id: 2,
        name: 'Zircaloy-4',
        density: 6.55,
        densityUnit: 'g/cm3',
        nuclides: NATURAL_ZIRCONIUM.map((nuclide) => ({ ...nuclide })),
        thermalScattering: [],
        color: '#9aa5b1'
    };
}

/** Light-water moderator with the NNDC/OpenMC thermal scattering name. */
function water(): OpenMCMaterial {
    return {
        id: 3,
        name: 'Light water',
        density: 0.997,
        densityUnit: 'g/cm3',
        nuclides: [
            { name: 'H1', fraction: 2, fractionType: 'ao' },
            { name: 'O16', fraction: 1, fractionType: 'ao' }
        ],
        thermalScattering: [{ name: 'c_H_in_H2O', fraction: 1 }],
        color: '#3b82f6'
    };
}

/** Natural lead shielding material. */
function lead(): OpenMCMaterial {
    return {
        id: 4,
        name: 'Lead',
        density: 11.34,
        densityUnit: 'g/cm3',
        nuclides: NATURAL_LEAD.map((nuclide) => ({ ...nuclide })),
        thermalScattering: [],
        color: '#64748b'
    };
}

/** Highly enriched uranium metal for the criticality-safety demonstration. */
function heuMetal(enrichmentPct: number): OpenMCMaterial {
    return {
        id: 1,
        name: `HEU metal (${formatPercent(enrichmentPct)} U-235)`,
        density: 18.75,
        densityUnit: 'g/cm3',
        nuclides: [
            { name: 'U235', fraction: enrichmentPct, fractionType: 'ao' },
            { name: 'U238', fraction: 100 - enrichmentPct, fractionType: 'ao' }
        ],
        thermalScattering: [],
        color: '#eab308'
    };
}

/** Pin-cell surfaces (radial boundaries optional for standalone vs. lattice use). */
function pinSurfaces(pitch: number, height: number, radialBoundary?: 'reflective'): OpenMCSurface[] {
    return [
        surface(1, 'z-cylinder', { x0: 0, y0: 0, r: UO2_FUEL_RADIUS }, { name: 'Fuel outer radius' }),
        surface(2, 'z-cylinder', { x0: 0, y0: 0, r: CLAD_INNER_RADIUS }, { name: 'Clad inner radius' }),
        surface(3, 'z-cylinder', { x0: 0, y0: 0, r: CLAD_OUTER_RADIUS }, { name: 'Clad outer radius' }),
        surface(4, 'x-plane', { x0: -pitch / 2 }, radialBoundary ? { boundary: radialBoundary } : {}),
        surface(5, 'x-plane', { x0: pitch / 2 }, radialBoundary ? { boundary: radialBoundary } : {}),
        surface(6, 'y-plane', { y0: -pitch / 2 }, radialBoundary ? { boundary: radialBoundary } : {}),
        surface(7, 'y-plane', { y0: pitch / 2 }, radialBoundary ? { boundary: radialBoundary } : {}),
        surface(8, 'z-plane', { z0: -height / 2 }),
        surface(9, 'z-plane', { z0: height / 2 })
    ];
}

/** Fuel-pin universe cells (fuel, gap, clad, moderator). */
function pinCells(): OpenMCCell[] {
    return [
        cell(1, 'material', 1, '-1 +8 -9', 'Fuel pellet'),
        cell(2, 'void', undefined, '+1 -2 +8 -9', 'Fuel-clad gap'),
        cell(3, 'material', 2, '+2 -3 +8 -9', 'Cladding'),
        cell(4, 'material', 3, '+3 +4 -5 +6 -7 +8 -9', 'Moderator')
    ];
}

/** One fuel pin universe plus the guide/instrument tube universes. */
function pinUniverses(): OpenMCState['geometry']['universes'] {
    return [
        { id: 0, name: 'root', cellIds: [] },
        { id: 10, name: 'Fuel pin', cellIds: [1, 2, 3, 4] },
        { id: 11, name: 'Guide tube', cellIds: [5, 6, 7] },
        { id: 12, name: 'Instrument tube', cellIds: [13, 14, 15] }
    ];
}

/** Guide and instrument tube cells shared by the assembly/lattice templates. */
function tubeCells(): OpenMCCell[] {
    return [
        cell(5, 'void', undefined, '-10 +8 -9', 'Guide tube void'),
        cell(6, 'material', 2, '+10 -11 +8 -9', 'Guide tube cladding'),
        cell(7, 'material', 3, '+11 +4 -5 +6 -7 +8 -9', 'Guide tube moderator'),
        cell(13, 'void', undefined, '-10 +8 -9', 'Instrument tube void'),
        cell(14, 'material', 2, '+10 -11 +8 -9', 'Instrument tube cladding'),
        cell(15, 'material', 3, '+11 +4 -5 +6 -7 +8 -9', 'Instrument tube moderator')
    ];
}

/** Guide/instrument tube cylinders. */
function tubeSurfaces(): OpenMCSurface[] {
    return [
        surface(10, 'z-cylinder', { x0: 0, y0: 0, r: GUIDE_INNER_RADIUS }, { name: 'Guide tube inner radius' }),
        surface(11, 'z-cylinder', { x0: 0, y0: 0, r: GUIDE_OUTER_RADIUS }, { name: 'Guide tube outer radius' })
    ];
}

/** Build the 17x17 universe array with 24 guide tubes and one instrument tube. */
function pwrAssemblyUniverses(): number[][][] {
    const guidePositions = new Set<string>();
    for (const row of GUIDE_GRID) {
        for (const column of GUIDE_GRID) {
            if (row === 8 && column === 8) {
                continue;
            }
            guidePositions.add(`${row},${column}`);
        }
    }
    const rows: number[][] = [];
    for (let row = 0; row < 17; row++) {
        const universes: number[] = [];
        for (let column = 0; column < 17; column++) {
            if (row === 8 && column === 8) {
                universes.push(12);
            } else if (guidePositions.has(`${row},${column}`)) {
                universes.push(11);
            } else {
                universes.push(10);
            }
        }
        rows.push(universes);
    }
    return [rows];
}

/** Simple 3x3 demonstration assembly: eight fuel pins around one guide tube. */
function demonstrationAssemblyUniverses(): number[][][] {
    const rows: number[][] = [];
    for (let row = 0; row < 3; row++) {
        const universes: number[] = [];
        for (let column = 0; column < 3; column++) {
            universes.push(row === 1 && column === 1 ? 11 : 10);
        }
        rows.push(universes);
    }
    return [rows];
}

/** A simple initial fission source over a box. */
function boxSource(lowerLeft: [number, number, number], upperRight: [number, number, number]): OpenMCState['settings']['sources'][number] {
    return {
        spatial: { type: 'box', lowerLeft, upperRight },
        energy: { type: 'discrete', energies: [2e6] },
        particle: 'neutron',
        strength: 1
    };
}

/** K-eff/fission tally for a single fuel cell. */
function fuelTally(name: string, cellId: number): OpenMCTally {
    return {
        id: 1,
        name,
        scores: ['fission', 'nu-fission'],
        nuclides: ['total'],
        filters: [{ type: 'cell', bins: [cellId] }]
    };
}

/** Pin-cell template: one fuel pin with reflective radial and vacuum axial boundaries. */
function buildPinCell(parameters: ProjectTemplateParameters): OpenMCState {
    const enrichment = numericParameter(parameters, 'enrichmentPct', 4.5, 0.7, 20);
    const pitch = numericParameter(parameters, 'pitchCm', DEFAULT_PIN_PITCH, 1.0, 3.0);
    const height = DEFAULT_ACTIVE_HEIGHT;
    const state = baseState(
        `Pin Cell (${formatPercent(enrichment)} UO2)`,
        'Single UO2 fuel pin with zircaloy cladding and light-water moderator.'
    );
    state.materials = [uo2Fuel(enrichment), zircaloy(), water()];
    state.geometry.surfaces = pinSurfaces(pitch, height, 'reflective').map((entry) => {
        if (entry.id === 8 || entry.id === 9) {
            return { ...entry, boundary: 'vacuum' as const };
        }
        return entry;
    });
    state.geometry.cells = pinCells();
    state.geometry.universes = [{ id: 0, name: 'root', cellIds: [1, 2, 3, 4] }];
    state.tallies = [fuelTally('Fuel fission rate', 1)];
    state.settings.sources = [boxSource([-pitch / 2, -pitch / 2, -height / 2], [pitch / 2, pitch / 2, height / 2])];
    return state;
}

/** 17x17 PWR fuel assembly template using the lattice model. */
function buildFuelAssembly(parameters: ProjectTemplateParameters): OpenMCState {
    const enrichment = numericParameter(parameters, 'enrichmentPct', 4.5, 0.7, 20);
    const pitch = numericParameter(parameters, 'pitchCm', DEFAULT_PIN_PITCH, 1.21, 3.0);
    const height = DEFAULT_ACTIVE_HEIGHT;
    const state = baseState(
        `17x17 PWR Assembly (${formatPercent(enrichment)} UO2)`,
        'A 17x17 pressurized-water reactor fuel assembly with guide and instrument tubes.'
    );
    state.materials = [uo2Fuel(enrichment), zircaloy(), water()];
    state.geometry.surfaces = [
        ...pinSurfaces(pitch, height),
        ...tubeSurfaces(),
        surface(16, 'x-plane', { x0: (-17 * pitch) / 2 }, { boundary: 'reflective', name: 'Assembly -x' }),
        surface(17, 'x-plane', { x0: (17 * pitch) / 2 }, { boundary: 'reflective', name: 'Assembly +x' }),
        surface(18, 'y-plane', { y0: (-17 * pitch) / 2 }, { boundary: 'reflective', name: 'Assembly -y' }),
        surface(19, 'y-plane', { y0: (17 * pitch) / 2 }, { boundary: 'reflective', name: 'Assembly +y' }),
        surface(20, 'z-plane', { z0: -height / 2 }, { boundary: 'vacuum', name: 'Assembly bottom' }),
        surface(21, 'z-plane', { z0: height / 2 }, { boundary: 'vacuum', name: 'Assembly top' })
    ];
    state.geometry.cells = [...pinCells(), ...tubeCells(), cell(8, 'lattice', 100, '+16 -17 +18 -19 +20 -21', 'Fuel assembly')];
    state.geometry.universes = [...pinUniverses(), { id: 0, name: 'root', cellIds: [8] }];
    const assembly: OpenMCLattice = {
        id: 100,
        type: 'rect',
        name: '17x17 PWR assembly',
        lowerLeft: [(-17 * pitch) / 2, (-17 * pitch) / 2, -height / 2],
        pitch: [pitch, pitch, height],
        dimensions: [17, 17, 1],
        universes: pwrAssemblyUniverses()
    };
    state.geometry.lattices = [assembly];
    state.tallies = [
        {
            id: 1,
            name: 'Assembly pin fission distribution',
            scores: ['fission', 'nu-fission'],
            nuclides: ['total'],
            filters: [{ type: 'distribcell', bins: [1] }]
        },
        {
            id: 2,
            name: 'Assembly axial leakage',
            scores: ['current'],
            nuclides: ['total'],
            filters: [{ type: 'surface', bins: [20, 21] }]
        }
    ];
    state.settings.run = { mode: 'eigenvalue', particles: 2000, inactive: 20, batches: 100 };
    state.settings.sources = [
        boxSource([(-17 * pitch) / 2, (-17 * pitch) / 2, -height / 2], [(17 * pitch) / 2, (17 * pitch) / 2, height / 2])
    ];
    return state;
}

/** Simplified 3x3 assembly demonstration core (not a production benchmark). */
function buildFullCore(parameters: ProjectTemplateParameters): OpenMCState {
    const enrichment = numericParameter(parameters, 'enrichmentPct', 4.5, 0.7, 20);
    const pitch = DEFAULT_PIN_PITCH;
    const height = DEFAULT_ACTIVE_HEIGHT;
    const assemblySize = 3 * pitch;
    const state = baseState(
        `Demonstration Core (${formatPercent(enrichment)} UO2)`,
        'Simplified 3x3 assembly demonstration core with 3x3 pin assemblies. For workflow demonstration only, not a benchmark.'
    );
    state.materials = [uo2Fuel(enrichment), zircaloy(), water()];
    state.geometry.surfaces = [
        ...pinSurfaces(pitch, height),
        ...tubeSurfaces(),
        surface(16, 'x-plane', { x0: -assemblySize / 2 }, { name: 'Assembly -x' }),
        surface(17, 'x-plane', { x0: assemblySize / 2 }, { name: 'Assembly +x' }),
        surface(18, 'y-plane', { y0: -assemblySize / 2 }, { name: 'Assembly -y' }),
        surface(19, 'y-plane', { y0: assemblySize / 2 }, { name: 'Assembly +y' }),
        surface(20, 'z-plane', { z0: -height / 2 }, { boundary: 'vacuum', name: 'Core bottom' }),
        surface(21, 'z-plane', { z0: height / 2 }, { boundary: 'vacuum', name: 'Core top' }),
        surface(24, 'x-plane', { x0: (-3 * assemblySize) / 2 }, { boundary: 'reflective', name: 'Core -x' }),
        surface(25, 'x-plane', { x0: (3 * assemblySize) / 2 }, { boundary: 'reflective', name: 'Core +x' }),
        surface(26, 'y-plane', { y0: (-3 * assemblySize) / 2 }, { boundary: 'reflective', name: 'Core -y' }),
        surface(27, 'y-plane', { y0: (3 * assemblySize) / 2 }, { boundary: 'reflective', name: 'Core +y' })
    ];
    state.geometry.cells = [
        ...pinCells(),
        ...tubeCells().filter((entry) => entry.id < 13),
        cell(8, 'lattice', 200, '+16 -17 +18 -19 +8 -9', 'Demonstration assembly'),
        cell(9, 'lattice', 300, '+24 -25 +26 -27 +20 -21', 'Demonstration core')
    ];
    state.geometry.lattices = [
        {
            id: 200,
            type: 'rect',
            name: '3x3 demonstration assembly',
            lowerLeft: [-assemblySize / 2, -assemblySize / 2, -height / 2],
            pitch: [pitch, pitch, height],
            dimensions: [3, 3, 1],
            universes: demonstrationAssemblyUniverses()
        },
        {
            id: 300,
            type: 'rect',
            name: '3x3 demonstration core',
            lowerLeft: [(-3 * assemblySize) / 2, (-3 * assemblySize) / 2, -height / 2],
            pitch: [assemblySize, assemblySize, height],
            dimensions: [3, 3, 1],
            universes: [
                [
                    [20, 20, 20],
                    [20, 20, 20],
                    [20, 20, 20]
                ]
            ]
        }
    ];
    state.geometry.universes = [
        ...pinUniverses().filter((universe) => universe.id !== 0 && universe.id !== 12),
        { id: 20, name: 'Demonstration assembly', cellIds: [8] },
        { id: 0, name: 'root', cellIds: [9] }
    ];
    state.tallies = [fuelTally('Core fuel fission distribution', 1)];
    state.tallies[0].filters = [{ type: 'distribcell', bins: [1] }];
    state.settings.run = { mode: 'eigenvalue', particles: 2000, inactive: 20, batches: 80 };
    state.settings.sources = [
        boxSource(
            [(-3 * assemblySize) / 2, (-3 * assemblySize) / 2, -height / 2],
            [(3 * assemblySize) / 2, (3 * assemblySize) / 2, height / 2]
        )
    ];
    return state;
}

/** Fixed-source shielding model with a lead slab and a detector tally. */
function buildShielding(parameters: ProjectTemplateParameters): OpenMCState {
    const sourceEnergyMeV = numericParameter(parameters, 'sourceEnergyMeV', 14.1, 0.1, 20);
    const shieldThickness = numericParameter(parameters, 'shieldThicknessCm', 20, 1, 30);
    const shieldStart = -30;
    const shieldEnd = shieldStart + shieldThickness;
    const detectorEnd = shieldEnd + 1;
    const state = baseState(
        `Shielding (${round(sourceEnergyMeV, 2)} MeV Neutrons)`,
        'Fixed-source slab model: a monoenergetic neutron source, a lead shield, and a thin detector cell.'
    );
    state.materials = [lead()];
    state.geometry.surfaces = [
        surface(1, 'x-plane', { x0: -50 }, { boundary: 'vacuum', name: 'Source boundary' }),
        surface(2, 'x-plane', { x0: shieldStart }, { name: 'Shield front' }),
        surface(3, 'x-plane', { x0: shieldEnd }, { name: 'Shield back' }),
        surface(4, 'x-plane', { x0: detectorEnd }, { name: 'Detector back' }),
        surface(5, 'x-plane', { x0: 50 }, { boundary: 'vacuum', name: 'Downstream boundary' }),
        surface(6, 'y-plane', { y0: -20 }, { boundary: 'vacuum' }),
        surface(7, 'y-plane', { y0: 20 }, { boundary: 'vacuum' }),
        surface(8, 'z-plane', { z0: -20 }, { boundary: 'vacuum' }),
        surface(9, 'z-plane', { z0: 20 }, { boundary: 'vacuum' })
    ];
    state.geometry.cells = [
        cell(1, 'void', undefined, '1 -2 6 -7 8 -9', 'Source region'),
        cell(2, 'material', 4, '2 -3 6 -7 8 -9', 'Lead shield'),
        cell(3, 'void', undefined, '3 -4 6 -7 8 -9', 'Detector'),
        cell(4, 'void', undefined, '4 -5 6 -7 8 -9', 'Downstream region')
    ];
    state.geometry.universes = [{ id: 0, name: 'root', cellIds: [1, 2, 3, 4] }];
    state.settings = {
        run: { mode: 'fixed source', particles: 5000, batches: 50 },
        sources: [
            {
                spatial: { type: 'box', lowerLeft: [-45, -5, -5], upperRight: [-35, 5, 5] },
                energy: { type: 'discrete', energies: [sourceEnergyMeV * 1e6] },
                particle: 'neutron',
                strength: 1
            }
        ],
        sourceRejectionFraction: 0
    };
    state.tallies = [
        {
            id: 1,
            name: 'Detector flux',
            scores: ['flux'],
            nuclides: ['total'],
            filters: [{ type: 'cell', bins: [3] }]
        }
    ];
    return state;
}

/** Criticality-safety sphere with a vacuum boundary and a fission tally. */
function buildCriticalitySafety(parameters: ProjectTemplateParameters): OpenMCState {
    const enrichment = numericParameter(parameters, 'enrichmentPct', 93.5, 1, 100);
    const radius = numericParameter(parameters, 'radiusCm', 8, 2, 20);
    const state = baseState(
        'Criticality Safety (HEU Sphere)',
        'Bare highly enriched uranium metal sphere in vacuum. A simple criticality-safety screening case.'
    );
    state.materials = [heuMetal(enrichment)];
    state.geometry.surfaces = [surface(1, 'sphere', { x0: 0, y0: 0, z0: 0, r: radius }, { boundary: 'vacuum', name: 'Sphere boundary' })];
    state.geometry.cells = [cell(1, 'material', 1, '-1', 'Fissile sphere')];
    state.geometry.universes = [{ id: 0, name: 'root', cellIds: [1] }];
    state.tallies = [fuelTally('Sphere fission rate', 1)];
    state.settings.run = { mode: 'eigenvalue', particles: 2000, inactive: 20, batches: 100 };
    state.settings.sources = [
        {
            spatial: { type: 'sphere', center: [0, 0, 0], radius: Math.max(radius * 0.8, 0.1) },
            energy: { type: 'discrete', energies: [2e6] },
            particle: 'neutron',
            strength: 1
        }
    ];
    return state;
}

/** Template cards shown in the New Project dialog. */
export const PROJECT_TEMPLATE_DEFINITIONS: OpenMCProjectTemplate[] = [
    {
        id: 'blank',
        name: 'Blank Project',
        description: 'Start with an empty model and the default eigenvalue settings.',
        icon: 'codicon codicon-new-file',
        whatYouGet: ['Empty geometry, materials, and tallies', 'Default eigenvalue run settings', 'Everything you add later is yours'],
        parameters: [],
        requires: 'Nothing to open. Cross sections are needed to run.',
        defaultState: {}
    },
    {
        id: 'pin-cell',
        name: 'Pin Cell',
        description: 'One UO2 fuel pin with cladding and light-water moderator.',
        icon: 'codicon codicon-openmc-cell',
        whatYouGet: [
            'UO2 fuel at the selected enrichment',
            'Zircaloy cladding and water moderator',
            'Reflective radial and vacuum axial boundaries',
            'Fuel fission tally'
        ],
        parameters: [
            { key: 'enrichmentPct', label: 'U-235 enrichment', unit: '%', default: 4.5, min: 0.7, max: 20, step: 0.1 },
            { key: 'pitchCm', label: 'Pin pitch', unit: 'cm', default: DEFAULT_PIN_PITCH, min: 1.0, max: 3.0, step: 0.01 }
        ],
        requires: 'Needs an OpenMC environment and cross sections to run.',
        defaultState: {}
    },
    {
        id: 'fuel-assembly',
        name: '17x17 PWR Assembly',
        description: 'A full 17x17 fuel assembly with guide and instrument tubes.',
        icon: 'codicon codicon-openmc-lattice',
        whatYouGet: [
            '17x17 rectangular lattice',
            '264 fuel pins, 24 guide tubes, and 1 instrument tube',
            'Assembly fission-distribution and axial-leakage tallies'
        ],
        parameters: [
            { key: 'enrichmentPct', label: 'U-235 enrichment', unit: '%', default: 4.5, min: 0.7, max: 20, step: 0.1 },
            { key: 'pitchCm', label: 'Pin pitch', unit: 'cm', default: DEFAULT_PIN_PITCH, min: 1.21, max: 3.0, step: 0.01 }
        ],
        requires: 'Needs an OpenMC environment and cross sections to run.',
        defaultState: {}
    },
    {
        id: 'full-core',
        name: 'Demonstration Core',
        description: 'A small 3x3 assembly core for workflow demonstrations.',
        icon: 'codicon codicon-openmc-grid',
        whatYouGet: [
            '3x3 assembly core with nested 3x3 pin lattices',
            '72 fuel pins and 9 guide tubes',
            'Reflective radial and vacuum axial boundaries',
            'Clearly labeled demonstration, not a benchmark'
        ],
        parameters: [{ key: 'enrichmentPct', label: 'U-235 enrichment', unit: '%', default: 4.5, min: 0.7, max: 20, step: 0.1 }],
        requires: 'Needs an OpenMC environment and cross sections to run. Not a production benchmark.',
        demonstration: true,
        defaultState: {}
    },
    {
        id: 'shielding',
        name: 'Shielding',
        description: 'Fixed-source neutrons through a lead slab into a detector cell.',
        icon: 'codicon codicon-openmc-mask',
        whatYouGet: ['Monoenergetic neutron source', 'Lead shield with adjustable thickness', 'Detector cell with a flux tally'],
        parameters: [
            { key: 'sourceEnergyMeV', label: 'Source energy', unit: 'MeV', default: 14.1, min: 0.1, max: 20, step: 0.1 },
            { key: 'shieldThicknessCm', label: 'Lead thickness', unit: 'cm', default: 20, min: 1, max: 30, step: 1 }
        ],
        requires: 'Needs an OpenMC environment and cross sections to run.',
        defaultState: {}
    },
    {
        id: 'criticallity-safety',
        name: 'Criticality Safety',
        description: 'A bare HEU sphere with a vacuum boundary and fission tally.',
        icon: 'codicon codicon-openmc-atom',
        whatYouGet: [
            'Highly enriched uranium metal sphere',
            'Vacuum boundary and eigenvalue settings',
            'Fission tally for k-eff screening'
        ],
        parameters: [
            { key: 'enrichmentPct', label: 'U-235 enrichment', unit: '%', default: 93.5, min: 1, max: 100, step: 0.5 },
            { key: 'radiusCm', label: 'Sphere radius', unit: 'cm', default: 8, min: 2, max: 20, step: 0.1 }
        ],
        requires: 'Needs an OpenMC environment and cross sections to run.',
        defaultState: {}
    }
];

/**
 * Return template descriptors with fully built default states.
 * The picker uses the metadata and preview helpers; backend callers may use
 * `defaultState` directly as an initial project.
 */
export function listProjectTemplates(): OpenMCProjectTemplate[] {
    return PROJECT_TEMPLATE_DEFINITIONS.map((template) => ({ ...template, defaultState: buildProjectTemplate(template.id) }));
}

/** Normalize legacy/alternate ids to the canonical template type. */
export function normalizeProjectTemplateId(id: string): OpenMCProjectTemplateType {
    if (id === 'criticality-safety') {
        return 'criticallity-safety';
    }
    return id as OpenMCProjectTemplateType;
}

/** Look up a template definition by id. */
export function getProjectTemplate(id: string): OpenMCProjectTemplate | undefined {
    const normalized = normalizeProjectTemplateId(id);
    return PROJECT_TEMPLATE_DEFINITIONS.find((template) => template.id === normalized);
}

/** Build the initial state for a template. */
export function buildProjectTemplate(id: string, parameters: ProjectTemplateParameters = {}): OpenMCState {
    const normalized = normalizeProjectTemplateId(id);
    switch (normalized) {
        case 'pin-cell':
            return buildPinCell(parameters);
        case 'fuel-assembly':
            return buildFuelAssembly(parameters);
        case 'full-core':
            return buildFullCore(parameters);
        case 'shielding':
            return buildShielding(parameters);
        case 'criticallity-safety':
            return buildCriticalitySafety(parameters);
        default:
            return baseState('Untitled Project');
    }
}

/** Short one-line summary of what a template will create. */
export function previewProjectTemplate(id: string, parameters: ProjectTemplateParameters = {}): string {
    const normalized = normalizeProjectTemplateId(id);
    switch (normalized) {
        case 'pin-cell': {
            const enrichment = numericParameter(parameters, 'enrichmentPct', 4.5, 0.7, 20);
            const pitch = numericParameter(parameters, 'pitchCm', DEFAULT_PIN_PITCH, 1.0, 3.0);
            return `1 fuel pin · ${formatPercent(enrichment)} UO2 · ${round(pitch, 2)} cm pitch`;
        }
        case 'fuel-assembly': {
            const enrichment = numericParameter(parameters, 'enrichmentPct', 4.5, 0.7, 20);
            return `17x17 lattice · 264 fuel pins · 24 guide tubes · 1 instrument tube · ${formatPercent(enrichment)} UO2`;
        }
        case 'full-core':
            return '3x3 assemblies · 81 pin positions · 72 fuel pins · reflective radial core';
        case 'shielding': {
            const energy = numericParameter(parameters, 'sourceEnergyMeV', 14.1, 0.1, 20);
            const thickness = numericParameter(parameters, 'shieldThicknessCm', 20, 1, 30);
            return `${round(energy, 2)} MeV source · ${round(thickness, 2)} cm lead · detector flux tally`;
        }
        case 'criticallity-safety': {
            const radius = numericParameter(parameters, 'radiusCm', 8, 2, 20);
            return `${round(radius, 2)} cm HEU sphere · vacuum boundary · fission tally`;
        }
        default:
            return 'Empty model · default eigenvalue settings';
    }
}

/** Build the default state used by the blank template. */
export function createBlankProjectState(): OpenMCState {
    return baseState('Untitled Project');
}
