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
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF PROVIDED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * OpenMC Tally Filter Catalog
 *
 * Per-filter-type descriptors driving the tally configurator's filter builder:
 * which parameter editor each filter type needs, plus default filter values
 * matching what the schema and the tallies.xml layer expect. Filter type names
 * follow the OpenMC short names (openmc/filter.py, openmc/filter_expansion.py).
 *
 * @module openmc-studio/common
 */

import { OpenMCTallyFilter, OpenMCTallyFilterType } from './openmc-state-schema';

/** Parameter editor identifiers used by the filter builder */
export type OpenMCFilterEditor =
    | 'domain-ids'
    | 'energy-bins'
    | 'mu-bins'
    | 'polar-bins'
    | 'azimuthal-bins'
    | 'time-bins'
    | 'mesh'
    | 'delayed-groups'
    | 'energy-function'
    | 'legendre-order'
    | 'spatial-legendre'
    | 'spherical-harmonics'
    | 'zernike'
    | 'particle-types'
    | 'cell-instance-pairs'
    | 'nuclide-names'
    | 'mesh-material-pairs'
    | 'integer-bins'
    | 'reaction-bins'
    | 'particle-production'
    | 'real-bins';

/** Add-filter menu groups, ordered as shown in the builder. */
export type OpenMCFilterGroup = 'spatial' | 'energy' | 'mesh' | 'reaction' | 'advanced';

/** Descriptor for one add-filter menu group. */
export interface OpenMCFilterGroupDescriptor {
    /** Group identifier. */
    id: OpenMCFilterGroup;
    /** Group heading. */
    label: string;
    /** One-line explanation of the group. */
    tooltip: string;
}

/** Add-filter menu groups. */
export const OPENMC_FILTER_GROUPS: OpenMCFilterGroupDescriptor[] = [
    {
        id: 'spatial',
        label: 'Spatial / domain',
        tooltip: 'Bin events by where they occur: cells, materials, universes, surfaces, and cell instances'
    },
    {
        id: 'energy',
        label: 'Energy / angle',
        tooltip: 'Bin events by energy, direction, or the angle at a surface crossing'
    },
    {
        id: 'mesh',
        label: 'Mesh',
        tooltip: 'Bin events on a spatial mesh, alone or combined with materials or birth locations'
    },
    {
        id: 'reaction',
        label: 'Reaction / particle',
        tooltip: 'Bin events by reaction, incident or produced particle type, or parent nuclide'
    },
    {
        id: 'advanced',
        label: 'Advanced',
        tooltip: 'Time, expansion moments, collision count, and particle-weight bins'
    }
];

/** Descriptor for one filter type */
export interface OpenMCFilterDescriptor {
    /** Filter type (OpenMC short name) */
    type: OpenMCTallyFilterType;
    /** Human-readable label */
    label: string;
    /** Tooltip for the add-filter button */
    tooltip: string;
    /** Add-filter menu group */
    group: OpenMCFilterGroup;
    /** Which parameter editor to render */
    editor: OpenMCFilterEditor;
    /** Placeholder/hint text for text-based bin inputs */
    binHelp?: string;
    /** Default bins for a new filter of this type */
    defaultBins?: number[];
    /** Extra default fields for a new filter of this type */
    defaultValues?: Partial<OpenMCTallyFilter>;
    /** Whether this filter type needs a mesh (add button disabled without meshes) */
    requiresMesh?: boolean;
    /**
     * Whether the mesh ID is stored in `<bins>` (mesh/meshsurface/meshborn).
     * `meshmaterial` stores the mesh in a dedicated attribute instead.
     */
    meshIdInBins?: boolean;
    /** Capability gate for 0.16-only filter types. */
    requiresCompat?: 'reactionFilter' | 'particleProductionFilter';
}

/** Full OpenMC tally filter catalog */
export const OPENMC_FILTERS: OpenMCFilterDescriptor[] = [
    {
        type: 'cell',
        label: 'Cell',
        tooltip: 'Filter by cell IDs',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'cellborn',
        label: 'Cell Born',
        tooltip: 'Filter by birth cell IDs',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'cellfrom',
        label: 'Cell From',
        tooltip: 'Filter surface crossings by the cell the particle came from',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'material',
        label: 'Material',
        tooltip: 'Filter by material IDs',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'materialfrom',
        label: 'Material From',
        tooltip: 'Bin events by the material the particle came from',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 (material IDs)',
        defaultBins: []
    },
    {
        type: 'universe',
        label: 'Universe',
        tooltip: 'Filter by universe IDs',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 0 1 2',
        defaultBins: []
    },
    {
        type: 'surface',
        label: 'Surface',
        tooltip: 'Filter by surface IDs',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 10 20 30',
        defaultBins: []
    },
    {
        type: 'distribcell',
        label: 'Distribcell',
        tooltip: 'Filter by distributed cell ID',
        group: 'spatial',
        editor: 'domain-ids',
        binHelp: 'e.g. 1',
        defaultBins: []
    },
    {
        type: 'cellinstance',
        label: 'Cell Instance',
        tooltip: 'Bin events by a specific cell instance in a lattice or repeated structure',
        group: 'spatial',
        editor: 'cell-instance-pairs',
        binHelp: 'cell ID + instance (0 = first occurrence)',
        defaultValues: { pairs: [] }
    },
    {
        type: 'energy',
        label: 'Energy',
        tooltip: 'Filter by energy bins (eV)',
        group: 'energy',
        editor: 'energy-bins',
        binHelp: 'e.g. 0 1e-5 0.625 2e7',
        defaultBins: [0, 2e7]
    },
    {
        type: 'energyout',
        label: 'Energy Out',
        tooltip: 'Filter by outgoing energy bins (eV)',
        group: 'energy',
        editor: 'energy-bins',
        binHelp: 'e.g. 0 1e-5 0.625 2e7',
        defaultBins: [0, 2e7]
    },
    {
        type: 'energyfunction',
        label: 'Energy Function',
        tooltip: 'Weight events by an energy-dependent response function',
        group: 'energy',
        editor: 'energy-function',
        defaultValues: { energyValues: [1e-5, 2e7], responseValues: [1, 1], interpolation: 'linear-linear' }
    },
    {
        type: 'mu',
        label: 'Mu (Angle)',
        tooltip: 'Filter by cosine of scattering angle (-1 to 1)',
        group: 'energy',
        editor: 'mu-bins',
        binHelp: 'e.g. -1 0 1 (-1 to 1)',
        defaultBins: [-1, 1]
    },
    {
        type: 'musurface',
        label: 'Mu Surface',
        tooltip: 'Bin surface crossings by the cosine of the angle between the particle direction and the surface normal',
        group: 'energy',
        editor: 'mu-bins',
        binHelp: 'e.g. -1 0 1 (requires a surface filter and current score)',
        defaultBins: [-1, 1]
    },
    {
        type: 'polar',
        label: 'Polar',
        tooltip: 'Filter by polar angle (0 to π)',
        group: 'energy',
        editor: 'polar-bins',
        binHelp: 'e.g. 0 1.5708 3.14159 (0 to π)',
        defaultBins: [0, 3.14159]
    },
    {
        type: 'azimuthal',
        label: 'Azimuthal',
        tooltip: 'Filter by azimuthal angle (0 to 2π)',
        group: 'energy',
        editor: 'azimuthal-bins',
        binHelp: 'e.g. 0 3.14159 6.28318 (0 to 2π)',
        defaultBins: [0, 6.28318530718]
    },
    {
        type: 'time',
        label: 'Time',
        tooltip: 'Filter by time bins (seconds)',
        group: 'advanced',
        editor: 'time-bins',
        binHelp: 'e.g. 0 1e-3 1e-2 0.1 (seconds)',
        defaultBins: []
    },
    {
        type: 'delayedgroup',
        label: 'Delayed Group',
        tooltip: 'Filter by delayed neutron precursor groups (1-6)',
        group: 'reaction',
        editor: 'delayed-groups',
        defaultBins: [1, 2, 3, 4, 5, 6]
    },
    {
        type: 'particle',
        label: 'Particle',
        tooltip: 'Filter by particle type (1=neutron, 2=photon)',
        group: 'reaction',
        editor: 'particle-types',
        defaultBins: [1]
    },
    {
        type: 'parentnuclide',
        label: 'Parent Nuclide',
        tooltip: 'Bin events by the parent nuclide that produced the particle',
        group: 'reaction',
        editor: 'nuclide-names',
        binHelp: 'e.g. U235 Pu239',
        defaultValues: { nuclideBins: [] }
    },
    {
        type: 'reaction',
        label: 'Reaction',
        tooltip: 'Bin events by ENDF reaction (MT number or name)',
        group: 'reaction',
        editor: 'reaction-bins',
        binHelp: 'e.g. (n,gamma) or 102',
        defaultValues: { reactionBins: [] },
        requiresCompat: 'reactionFilter'
    },
    {
        type: 'particleproduction',
        label: 'Particle Production',
        tooltip: 'Bin secondary particles by particle type and optional energy',
        group: 'reaction',
        editor: 'particle-production',
        binHelp: 'particle types + energy boundaries (eV)',
        defaultValues: { particleTypes: ['photon'], productionEnergyBins: [] },
        requiresCompat: 'particleProductionFilter'
    },
    {
        type: 'mesh',
        label: 'Mesh Filter',
        tooltip: 'Filter by spatial mesh cell',
        group: 'mesh',
        editor: 'mesh',
        requiresMesh: true,
        meshIdInBins: true
    },
    {
        type: 'meshsurface',
        label: 'Mesh Surface',
        tooltip: 'Filter by surface crossings on a mesh',
        group: 'mesh',
        editor: 'mesh',
        requiresMesh: true,
        meshIdInBins: true
    },
    {
        type: 'meshborn',
        label: 'Mesh Born',
        tooltip: 'Bin events by the mesh element where the particle was born',
        group: 'mesh',
        editor: 'mesh',
        binHelp: 'select a mesh above',
        requiresMesh: true,
        meshIdInBins: true
    },
    {
        type: 'meshmaterial',
        label: 'Mesh Material',
        tooltip: 'Bin events by mesh element and material pairs',
        group: 'mesh',
        editor: 'mesh-material-pairs',
        binHelp: 'zero-based mesh element + material ID',
        requiresMesh: true,
        meshIdInBins: false,
        defaultValues: { pairs: [] }
    },
    {
        type: 'collision',
        label: 'Collision',
        tooltip: 'Bin events by the number of collisions the particle has undergone',
        group: 'advanced',
        editor: 'integer-bins',
        binHelp: 'e.g. 1 2 3 (positive collision counts, ascending)',
        defaultBins: [1]
    },
    {
        type: 'weight',
        label: 'Weight',
        tooltip: 'Bin events by incoming particle weight',
        group: 'advanced',
        editor: 'real-bins',
        binHelp: 'e.g. 0 0.5 1 2 (ascending, non-negative)',
        defaultBins: [0, 1]
    },
    {
        type: 'legendre',
        label: 'Legendre',
        tooltip: 'Legendre expansion of the scattering angle cosine',
        group: 'advanced',
        editor: 'legendre-order',
        defaultValues: { order: 5 }
    },
    {
        type: 'spatiallegendre',
        label: 'Spatial Legendre',
        tooltip: 'Legendre expansion along a spatial axis',
        group: 'advanced',
        editor: 'spatial-legendre',
        defaultValues: { order: 5, axis: 'z', min: -10, max: 10 }
    },
    {
        type: 'sphericalharmonics',
        label: 'Spherical Harmonics',
        tooltip: 'Spherical harmonics expansion of direction',
        group: 'advanced',
        editor: 'spherical-harmonics',
        defaultValues: { order: 3, cosine: 'particle' }
    },
    {
        type: 'zernike',
        label: 'Zernike',
        tooltip: 'Zernike expansion over the unit disk',
        group: 'advanced',
        editor: 'zernike',
        defaultValues: { order: 5, center: { x: 0, y: 0, r: 1 } }
    },
    {
        type: 'zernikeradial',
        label: 'Zernike Radial',
        tooltip: 'Radial Zernike expansion over the unit disk',
        group: 'advanced',
        editor: 'zernike',
        defaultValues: { order: 5, center: { x: 0, y: 0, r: 1 } }
    }
];

/**
 * Look up the descriptor for a filter type.
 * @param type - Filter type.
 * @returns The descriptor, or undefined for unknown types.
 */
export function getFilterDescriptor(type: OpenMCTallyFilterType): OpenMCFilterDescriptor | undefined {
    return OPENMC_FILTERS.find((f) => f.type === type);
}

/**
 * Group the filter catalog for the add-filter menu.
 *
 * @returns One entry per menu group, each with its filters in catalog order.
 */
export function getFiltersByGroup(): Array<OpenMCFilterGroupDescriptor & { filters: OpenMCFilterDescriptor[] }> {
    return OPENMC_FILTER_GROUPS.map((group) => ({
        ...group,
        filters: OPENMC_FILTERS.filter((filter) => filter.group === group.id)
    }));
}

/**
 * Create a new filter of the given type with catalog defaults.
 * @param type - Filter type.
 * @param firstMeshId - ID of the first available mesh (for mesh-based filters).
 * @returns A new filter with default values.
 */
export function createDefaultFilter(type: OpenMCTallyFilterType, firstMeshId?: number): OpenMCTallyFilter {
    const descriptor = getFilterDescriptor(type);
    const filter: OpenMCTallyFilter = {
        type,
        bins: descriptor?.defaultBins ? [...descriptor.defaultBins] : [],
        ...(descriptor?.defaultValues ?? {})
    };
    if (descriptor?.requiresMesh) {
        filter.meshId = firstMeshId ?? 0;
        if (descriptor.meshIdInBins !== false) {
            filter.bins = firstMeshId !== undefined ? [firstMeshId] : [];
        }
    }
    return filter;
}
