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
    | 'particle-types';

/** Descriptor for one filter type */
export interface OpenMCFilterDescriptor {
    /** Filter type (OpenMC short name) */
    type: OpenMCTallyFilterType;
    /** Human-readable label */
    label: string;
    /** Tooltip for the add-filter button */
    tooltip: string;
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
}

/** Full OpenMC tally filter catalog */
export const OPENMC_FILTERS: OpenMCFilterDescriptor[] = [
    {
        type: 'cell',
        label: 'Cell',
        tooltip: 'Filter by cell IDs',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'cellborn',
        label: 'Cell Born',
        tooltip: 'Filter by birth cell IDs',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'cellfrom',
        label: 'Cell From',
        tooltip: 'Filter surface crossings by the cell the particle came from',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'material',
        label: 'Material',
        tooltip: 'Filter by material IDs',
        editor: 'domain-ids',
        binHelp: 'e.g. 1 2 3',
        defaultBins: []
    },
    {
        type: 'universe',
        label: 'Universe',
        tooltip: 'Filter by universe IDs',
        editor: 'domain-ids',
        binHelp: 'e.g. 0 1 2',
        defaultBins: []
    },
    {
        type: 'surface',
        label: 'Surface',
        tooltip: 'Filter by surface IDs',
        editor: 'domain-ids',
        binHelp: 'e.g. 10 20 30',
        defaultBins: []
    },
    {
        type: 'distribcell',
        label: 'Distribcell',
        tooltip: 'Filter by distributed cell ID',
        editor: 'domain-ids',
        binHelp: 'e.g. 1',
        defaultBins: []
    },
    {
        type: 'energy',
        label: 'Energy',
        tooltip: 'Filter by energy bins (eV)',
        editor: 'energy-bins',
        binHelp: 'e.g. 0 1e-5 0.625 2e7',
        defaultBins: [0, 2e7]
    },
    {
        type: 'energyout',
        label: 'Energy Out',
        tooltip: 'Filter by outgoing energy bins (eV)',
        editor: 'energy-bins',
        binHelp: 'e.g. 0 1e-5 0.625 2e7',
        defaultBins: [0, 2e7]
    },
    {
        type: 'energyfunction',
        label: 'Energy Function',
        tooltip: 'Weight events by an energy-dependent response function',
        editor: 'energy-function',
        defaultValues: { energyValues: [1e-5, 2e7], responseValues: [1, 1], interpolation: 'linear-linear' }
    },
    {
        type: 'mu',
        label: 'Mu (Angle)',
        tooltip: 'Filter by cosine of scattering angle (-1 to 1)',
        editor: 'mu-bins',
        binHelp: 'e.g. -1 0 1 (-1 to 1)',
        defaultBins: [-1, 1]
    },
    {
        type: 'polar',
        label: 'Polar',
        tooltip: 'Filter by polar angle (0 to π)',
        editor: 'polar-bins',
        binHelp: 'e.g. 0 1.5708 3.14159 (0 to π)',
        defaultBins: [0, 3.14159]
    },
    {
        type: 'azimuthal',
        label: 'Azimuthal',
        tooltip: 'Filter by azimuthal angle (0 to 2π)',
        editor: 'azimuthal-bins',
        binHelp: 'e.g. 0 3.14159 6.28318 (0 to 2π)',
        defaultBins: [0, 6.28318530718]
    },
    {
        type: 'time',
        label: 'Time',
        tooltip: 'Filter by time bins (seconds)',
        editor: 'time-bins',
        binHelp: 'e.g. 0 1e-3 1e-2 0.1 (seconds)',
        defaultBins: []
    },
    {
        type: 'delayedgroup',
        label: 'Delayed Group',
        tooltip: 'Filter by delayed neutron precursor groups (1-6)',
        editor: 'delayed-groups',
        defaultBins: [1, 2, 3, 4, 5, 6]
    },
    {
        type: 'particle',
        label: 'Particle',
        tooltip: 'Filter by particle type (1=neutron, 2=photon)',
        editor: 'particle-types',
        defaultBins: [1]
    },
    {
        type: 'mesh',
        label: 'Mesh Filter',
        tooltip: 'Filter by spatial mesh cell',
        editor: 'mesh',
        requiresMesh: true
    },
    {
        type: 'meshsurface',
        label: 'Mesh Surface',
        tooltip: 'Filter by surface crossings on a mesh',
        editor: 'mesh',
        requiresMesh: true
    },
    {
        type: 'legendre',
        label: 'Legendre',
        tooltip: 'Legendre expansion of the scattering angle cosine',
        editor: 'legendre-order',
        defaultValues: { order: 5 }
    },
    {
        type: 'spatiallegendre',
        label: 'Spatial Legendre',
        tooltip: 'Legendre expansion along a spatial axis',
        editor: 'spatial-legendre',
        defaultValues: { order: 5, axis: 'z', min: -10, max: 10 }
    },
    {
        type: 'sphericalharmonics',
        label: 'Spherical Harmonics',
        tooltip: 'Spherical harmonics expansion of direction',
        editor: 'spherical-harmonics',
        defaultValues: { order: 3, cosine: 'particle' }
    },
    {
        type: 'zernike',
        label: 'Zernike',
        tooltip: 'Zernike expansion over the unit disk',
        editor: 'zernike',
        defaultValues: { order: 5, center: { x: 0, y: 0, r: 1 } }
    },
    {
        type: 'zernikeradial',
        label: 'Zernike Radial',
        tooltip: 'Radial Zernike expansion over the unit disk',
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
        filter.bins = firstMeshId !== undefined ? [firstMeshId] : [];
    }
    return filter;
}
