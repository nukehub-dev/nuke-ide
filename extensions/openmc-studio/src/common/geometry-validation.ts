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
 * Pure validation for the CSG geometry model.
 *
 * The checks mirror the OpenMC reader contract: universe 0 is the root, cells
 * must belong to exactly one universe, lattice fills resolve to a lattice or a
 * universe (never both), and periodic boundaries must name a reciprocal plane
 * partner. Messages follow the widget contract (what is wrong + how to fix).
 *
 * @module openmc-studio/common
 */

import { hexLatticeRingSizes } from './geometry-lattices';
import {
    OpenMCBoundaryCondition,
    OpenMCGeometry,
    OpenMCHexLattice,
    OpenMCLattice,
    OpenMCRectLattice,
    OpenMCSurface
} from './openmc-state-schema';
import type { ValidationIssue } from './openmc-studio-protocol';

/** Boundary types that carry an albedo in OpenMC. */
const ALBEDO_BOUNDARIES = new Set<OpenMCBoundaryCondition>(['reflective', 'periodic', 'white']);

/** Plane surface types eligible for a periodic pair. */
const PLANE_TYPES = new Set(['x-plane', 'y-plane', 'z-plane', 'plane']);

/** Check whether every entry of a tuple is a finite number. */
function isFiniteTuple(value: unknown, length: number): value is number[] {
    return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/** Check whether a value is a positive integer. */
function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Format a list of IDs for a message. */
function formatIds(ids: number[]): string {
    return ids.map((id) => `#${id}`).join(', ');
}

/**
 * Validate the geometry model and return actionable issues.
 *
 * DAGMC models own their geometry in the `.h5m` file; callers should skip this
 * function when `settings.dagmcFile` is set.
 * @param geometry - Geometry to validate.
 * @returns Validation issues (errors block a run, warnings do not).
 */
export function validateGeometryModel(geometry: OpenMCGeometry): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const error = (message: string, suggestion: string, path?: string): void => {
        issues.push({ severity: 'error', category: 'geometry', message, suggestion, path });
    };
    const warning = (message: string, suggestion: string, path?: string): void => {
        issues.push({ severity: 'warning', category: 'geometry', message, suggestion, path });
    };

    const universes = geometry.universes ?? [];
    const cells = geometry.cells ?? [];
    const surfaces = geometry.surfaces ?? [];
    const lattices = geometry.lattices ?? [];
    const universeIds = new Set(universes.map((universe) => universe.id));
    const latticeIds = new Set(lattices.map((lattice) => lattice.id));

    if (geometry.rootUniverseId !== 0) {
        error(
            `Root universe is set to #${geometry.rootUniverseId}, but OpenMC XML has no explicit root element and uses universe 0`,
            'Set the root universe to 0; OpenMC derives the root from the universe that is not used as a fill'
        );
    }

    if (!universeIds.has(0)) {
        warning(
            'Universe 0 (the OpenMC root universe) is not listed in the model',
            'Add universe 0 or assign its cells through the Universes tab; cells without a universe are placed in 0'
        );
    }

    // A lattice and a universe sharing an ID is legal in the state but not in
    // XML: the C++ reader resolves a fill ID to a universe before a lattice.
    const collidingIds = lattices.map((lattice) => lattice.id).filter((id) => universeIds.has(id));
    if (collidingIds.length > 0) {
        error(
            `Lattice ${formatIds(collidingIds)} share an ID with a universe`,
            'Give each lattice a unique ID (lattice and universe IDs share the fill namespace)'
        );
    }

    const seenLatticeIds = new Set<number>();
    for (const lattice of lattices) {
        if (seenLatticeIds.has(lattice.id)) {
            error(`Lattice #${lattice.id} is defined more than once`, 'Remove the duplicate lattice or give it a new ID');
        }
        seenLatticeIds.add(lattice.id);
    }

    // Cell membership: a cell may belong to exactly one universe.
    const cellUniverses = new Map<number, number[]>();
    for (const universe of universes) {
        for (const cellId of universe.cellIds ?? []) {
            const memberships = cellUniverses.get(cellId) ?? [];
            memberships.push(universe.id);
            cellUniverses.set(cellId, memberships);
        }
    }
    for (const [cellId, memberships] of cellUniverses) {
        if (memberships.length > 1) {
            error(
                `Cell #${cellId} belongs to multiple universes (${formatIds(memberships)})`,
                'A cell may be defined in only one universe; remove it from the extra universes'
            );
        }
    }

    const universeHasCells = new Map<number, boolean>();
    for (const universe of universes) {
        universeHasCells.set(universe.id, (universe.cellIds ?? []).length > 0);
    }
    const unassignedCells = cells.filter((cell) => !cellUniverses.has(cell.id));
    if ((universeHasCells.get(0) ?? false) || unassignedCells.length > 0) {
        universeHasCells.set(0, true);
    } else {
        error(
            'Root universe 0 has no cells',
            'Add at least one top-level cell to universe 0; OpenMC omits empty universes from geometry.xml'
        );
    }

    const seenCellIds = new Set<number>();
    for (const cell of cells) {
        if (seenCellIds.has(cell.id)) {
            error(`Cell #${cell.id} is defined more than once`, 'Remove the duplicate cell or give it a new ID');
        }
        seenCellIds.add(cell.id);

        if (cell.rotation !== undefined) {
            if (!isFiniteTuple(cell.rotation, 3)) {
                error(
                    `Cell #${cell.id}: rotation must be three finite angles (phi, theta, psi) in degrees`,
                    'Enter three numbers; blank removes the rotation'
                );
            } else if (cell.fillType !== 'universe' && cell.fillType !== 'lattice') {
                warning(
                    `Cell #${cell.id}: rotation only affects universe/lattice fills`,
                    'Clear the rotation or change the fill to a universe or lattice'
                );
            }
        }

        if (cell.translation !== undefined) {
            if (!isFiniteTuple(cell.translation, 3)) {
                error(
                    `Cell #${cell.id}: translation must be three finite values in cm`,
                    'Enter three numbers; blank removes the translation'
                );
            } else if (cell.fillType !== 'universe' && cell.fillType !== 'lattice') {
                warning(
                    `Cell #${cell.id}: translation only affects universe/lattice fills`,
                    'Clear the translation or change the fill to a universe or lattice'
                );
            }
        }

        if (cell.density !== undefined) {
            if (typeof cell.density !== 'number' || !Number.isFinite(cell.density) || cell.density <= 0) {
                error(
                    `Cell #${cell.id}: density override must be a positive number`,
                    'Enter a density greater than zero, or clear it to use the material density'
                );
            }
        }

        if (cell.fillType === 'material' && cell.fillId === undefined) {
            error(`Cell #${cell.id} is filled with a material but has no material ID`, 'Select a material for the cell');
        }

        if (cell.fillType === 'universe') {
            if (cell.fillId === undefined) {
                error(`Cell #${cell.id} is filled with a universe but has no universe ID`, 'Select a universe for the cell');
            } else if (cell.fillId === 0) {
                error(
                    `Cell #${cell.id} fills universe 0 (the root universe)`,
                    'Universe 0 is the root and cannot be used as a fill; select a nested universe'
                );
            } else if (!universeIds.has(cell.fillId)) {
                error(
                    `Cell #${cell.id} fills universe #${cell.fillId} which does not exist`,
                    'Select an existing universe or create it in the Universes tab'
                );
            } else if (!universeHasCells.get(cell.fillId)) {
                error(
                    `Cell #${cell.id} fills universe #${cell.fillId} which has no cells`,
                    'Add at least one cell to the nested universe; OpenMC omits empty universes from geometry.xml'
                );
            }
        }

        if (cell.fillType === 'lattice') {
            if (cell.fillId === undefined) {
                error(`Cell #${cell.id} is filled with a lattice but has no lattice ID`, 'Select a lattice for the cell');
            } else if (!latticeIds.has(cell.fillId)) {
                error(
                    `Cell #${cell.id} fills lattice #${cell.fillId} which does not exist`,
                    'Select an existing lattice or create it in the Universes tab'
                );
            }
        }

        if (cell.fillType === 'void' && cell.fillId !== undefined) {
            warning(`Cell #${cell.id} is void but still carries a fill ID`, 'Clear the fill ID');
        }
    }

    for (const lattice of lattices) {
        validateLattice(lattice, universeIds, universeHasCells, error, warning);
    }

    validateSurfaceBoundaries(surfaces, error, warning);

    return issues;
}

/** Validate a single lattice definition. */
function validateLattice(
    lattice: OpenMCLattice,
    universeIds: Set<number>,
    universeHasCells: Map<number, boolean>,
    error: (message: string, suggestion: string, path?: string) => void,
    warning: (message: string, suggestion: string, path?: string) => void
): void {
    const path = `geometry.lattices.${lattice.id}`;

    if (lattice.outer !== undefined) {
        if (lattice.outer === 0) {
            error(
                `Lattice #${lattice.id}: outer universe is 0 (the root universe)`,
                'Universe 0 is the root and cannot be a lattice fill; select a nested universe',
                path
            );
        } else if (lattice.outer === lattice.id) {
            error(`Lattice #${lattice.id}: outer universe points at the lattice itself`, 'Select a real universe as the outer fill', path);
        } else if (!universeIds.has(lattice.outer)) {
            error(
                `Lattice #${lattice.id}: outer universe #${lattice.outer} does not exist`,
                'Select an existing universe as the outer fill or clear it',
                path
            );
        } else if (!universeHasCells.get(lattice.outer)) {
            error(
                `Lattice #${lattice.id}: outer universe #${lattice.outer} has no cells`,
                'Add at least one cell to the outer universe; OpenMC omits empty universes from geometry.xml',
                path
            );
        }
    }

    const referencedIds = Array.isArray(lattice.universes) ? (lattice.universes.flat(2) as number[]) : [];
    if (referencedIds.includes(0)) {
        error(
            `Lattice #${lattice.id}: universe 0 (the root universe) is used as a lattice fill`,
            'Universe 0 is the root and cannot be nested; assign a non-root universe to every lattice position',
            path
        );
    }

    if (lattice.type === 'rect') {
        validateRectLattice(lattice, universeIds, universeHasCells, error, warning, path);
    } else {
        validateHexLattice(lattice, universeIds, universeHasCells, error, warning, path);
    }
}

/** Validate a rectangular lattice's shape and references. */
function validateRectLattice(
    lattice: OpenMCRectLattice & { id: number },
    universeIds: Set<number>,
    universeHasCells: Map<number, boolean>,
    error: (message: string, suggestion: string, path?: string) => void,
    _warning: (message: string, suggestion: string, path?: string) => void,
    path: string
): void {
    const dimensions = lattice.dimensions;
    if (!Array.isArray(dimensions) || (dimensions.length !== 2 && dimensions.length !== 3) || !dimensions.every(isPositiveInteger)) {
        error(
            `Lattice #${lattice.id}: dimensions must be two or three positive integers (nx, ny[, nz])`,
            'Enter the number of lattice cells per axis',
            path
        );
        return;
    }

    const dimensionCount = dimensions.length;
    const pitch = lattice.pitch;
    if (
        !Array.isArray(pitch) ||
        pitch.length !== dimensionCount ||
        !pitch.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
    ) {
        error(
            `Lattice #${lattice.id}: pitch must contain ${dimensionCount} positive numbers (one per dimension)`,
            'Enter a positive center-to-center distance for every dimension',
            path
        );
    }

    const lowerLeft = lattice.lowerLeft;
    if (!Array.isArray(lowerLeft) || lowerLeft.length !== dimensionCount || !lowerLeft.every((entry) => Number.isFinite(entry))) {
        error(
            `Lattice #${lattice.id}: lower-left must contain ${dimensionCount} finite coordinates`,
            'Enter the lower-left corner in cm (one coordinate per dimension)',
            path
        );
    }

    const [nx, ny, nz = 1] = dimensions;
    const universes = lattice.universes;
    let shapeValid = Array.isArray(universes) && universes.length === nz;
    const referencedIds: number[] = [];
    for (let z = 0; shapeValid && z < nz; z++) {
        if (!Array.isArray(universes[z]) || universes[z].length !== ny) {
            shapeValid = false;
            break;
        }
        for (let y = 0; y < ny; y++) {
            const row = universes[z][y];
            if (!Array.isArray(row) || row.length !== nx) {
                shapeValid = false;
                break;
            }
            referencedIds.push(...row);
        }
    }

    if (!shapeValid) {
        error(
            `Lattice #${lattice.id}: universe array shape does not match dimensions ${dimensions.join('×')}`,
            `Fill exactly ${nz} × ${ny} × ${nx} universe positions (${nx * ny * nz} total)`,
            path
        );
    }

    const missing = Array.from(new Set(referencedIds.filter((id) => !universeIds.has(id))));
    if (missing.length > 0) {
        error(
            `Lattice #${lattice.id}: universe ${formatIds(missing)} ${missing.length === 1 ? 'does not exist' : 'do not exist'}`,
            'Assign existing universes to every lattice position or create the missing universes',
            path
        );
    }
    const empty = Array.from(new Set(referencedIds.filter((id) => universeIds.has(id) && !universeHasCells.get(id))));
    if (empty.length > 0) {
        error(
            `Lattice #${lattice.id}: universe ${formatIds(empty)} ${empty.length === 1 ? 'has' : 'have'} no cells`,
            'Add at least one cell to each lattice universe; OpenMC omits empty universes from geometry.xml',
            path
        );
    }
}

/** Validate a hexagonal lattice's shape and references. */
function validateHexLattice(
    lattice: OpenMCHexLattice & { id: number },
    universeIds: Set<number>,
    universeHasCells: Map<number, boolean>,
    error: (message: string, suggestion: string, path?: string) => void,
    _warning: (message: string, suggestion: string, path?: string) => void,
    path: string
): void {
    if (!isPositiveInteger(lattice.rings)) {
        error(
            `Lattice #${lattice.id}: n_rings must be a positive integer`,
            'Enter at least one ring (the center ring counts as one)',
            path
        );
        return;
    }

    const orientation = lattice.orientation ?? 'y';
    if (orientation !== 'x' && orientation !== 'y') {
        error(`Lattice #${lattice.id}: orientation must be 'x' or 'y'`, 'Choose the hexagon orientation in the lattice editor', path);
    }

    const nAxial = lattice.nAxial;
    if (nAxial !== undefined && !isPositiveInteger(nAxial)) {
        error(
            `Lattice #${lattice.id}: n_axial must be a positive integer`,
            'Enter the number of axial positions or leave it blank for a 2D lattice',
            path
        );
        return;
    }

    const is3d = nAxial !== undefined && nAxial > 1;
    const axialSlices = is3d ? (nAxial as number) : 1;
    const centerLength = is3d ? 3 : 2;
    if (!isFiniteTuple(lattice.center, centerLength)) {
        error(
            `Lattice #${lattice.id}: center must contain ${centerLength} finite coordinates`,
            is3d ? 'Enter the full 3D center (x, y, z) for an axial lattice' : 'Enter the 2D center (x, y)',
            path
        );
    }

    const pitchLength = is3d ? 2 : 1;
    if (
        !Array.isArray(lattice.pitch) ||
        lattice.pitch.length !== pitchLength ||
        !lattice.pitch.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
    ) {
        error(
            `Lattice #${lattice.id}: pitch must contain ${pitchLength} positive number(s)`,
            is3d ? 'Enter radial and axial pitches' : 'Enter the radial pitch',
            path
        );
    }

    const ringSizes = hexLatticeRingSizes(lattice.rings);
    const universes = lattice.universes;
    let shapeValid = Array.isArray(universes) && universes.length === axialSlices;
    const referencedIds: number[] = [];
    for (let z = 0; shapeValid && z < axialSlices; z++) {
        const rings = universes[z];
        if (!Array.isArray(rings) || rings.length !== lattice.rings) {
            shapeValid = false;
            break;
        }
        for (let ring = 0; ring < lattice.rings; ring++) {
            const entries = rings[ring];
            if (!Array.isArray(entries) || entries.length !== ringSizes[ring]) {
                shapeValid = false;
                break;
            }
            referencedIds.push(...entries);
        }
    }

    if (!shapeValid) {
        error(
            `Lattice #${lattice.id}: universe array shape does not match ${lattice.rings} rings${
                is3d ? ` × ${axialSlices} axial levels` : ''
            }`,
            `Fill ${ringSizes.join(' + ')} positions per axial level (outermost ring first)`,
            path
        );
    }

    const missing = Array.from(new Set(referencedIds.filter((id) => !universeIds.has(id))));
    if (missing.length > 0) {
        error(
            `Lattice #${lattice.id}: universe ${formatIds(missing)} ${missing.length === 1 ? 'does not exist' : 'do not exist'}`,
            'Assign existing universes to every ring position or create the missing universes',
            path
        );
    }
    const empty = Array.from(new Set(referencedIds.filter((id) => universeIds.has(id) && !universeHasCells.get(id))));
    if (empty.length > 0) {
        error(
            `Lattice #${lattice.id}: universe ${formatIds(empty)} ${empty.length === 1 ? 'has' : 'have'} no cells`,
            'Add at least one cell to each lattice universe; OpenMC omits empty universes from geometry.xml',
            path
        );
    }

    if (nAxial === 1) {
        _warning(
            `Lattice #${lattice.id}: n_axial = 1 is serialized as a 2D lattice`,
            'Leave n_axial blank for a 2D lattice; use a value greater than 1 for a 3D lattice',
            path
        );
    }
}

/** Validate surface albedo and periodic pair reciprocity. */
function validateSurfaceBoundaries(
    surfaces: OpenMCSurface[],
    error: (message: string, suggestion: string, path?: string) => void,
    warning: (message: string, suggestion: string, path?: string) => void
): void {
    const byId = new Map(surfaces.map((surface) => [surface.id, surface]));

    for (const surface of surfaces) {
        const path = `geometry.surfaces.${surface.id}`;

        if (surface.albedo !== undefined) {
            if (typeof surface.albedo !== 'number' || !Number.isFinite(surface.albedo) || surface.albedo <= 0) {
                error(
                    `Surface #${surface.id}: albedo must be a finite number greater than zero`,
                    'Enter a positive importance multiplier (1 is the default)',
                    path
                );
            } else if (!surface.boundary || !ALBEDO_BOUNDARIES.has(surface.boundary)) {
                warning(
                    `Surface #${surface.id}: albedo only applies to reflective, periodic, and white boundaries`,
                    'Set a capable boundary condition or clear the albedo (OpenMC would ignore it)',
                    path
                );
            } else if (surface.albedo > 1) {
                warning(
                    `Surface #${surface.id}: albedo ${surface.albedo} is greater than 1`,
                    'Albedos above 1 increase particle importance and can produce unphysical results',
                    path
                );
            }
        }

        if (surface.boundary === 'periodic') {
            if (!PLANE_TYPES.has(surface.type)) {
                error(
                    `Surface #${surface.id}: periodic boundaries must be planes`,
                    'Use an x-plane, y-plane, z-plane, or general plane for periodicity',
                    path
                );
            }
            if (surface.periodicSurfaceId === undefined) {
                error(
                    `Surface #${surface.id}: periodic boundary has no partner surface`,
                    'Select the opposite plane as the periodic partner on both surfaces',
                    path
                );
                continue;
            }
            if (surface.periodicSurfaceId === surface.id) {
                error(
                    `Surface #${surface.id}: a periodic surface cannot pair with itself`,
                    'Select a different plane as the periodic partner',
                    path
                );
                continue;
            }
            const partner = byId.get(surface.periodicSurfaceId);
            if (!partner) {
                error(
                    `Surface #${surface.id}: periodic partner #${surface.periodicSurfaceId} does not exist`,
                    'Select an existing plane or clear the partner',
                    path
                );
                continue;
            }
            if (partner.boundary !== 'periodic') {
                error(
                    `Surface #${surface.id}: periodic partner #${partner.id} is not periodic`,
                    `Set surface #${partner.id} to the periodic boundary condition`,
                    path
                );
            }
            if (partner.periodicSurfaceId !== surface.id) {
                error(
                    `Surface #${surface.id}: periodic partner #${partner.id} does not point back`,
                    `Set surface #${partner.id}'s periodic partner to #${surface.id}`,
                    path
                );
            }
        } else if (surface.periodicSurfaceId !== undefined) {
            error(
                `Surface #${surface.id}: periodic partner is set but the boundary is not periodic`,
                'Set the boundary condition to periodic or clear the partner',
                path
            );
        }
    }
}
