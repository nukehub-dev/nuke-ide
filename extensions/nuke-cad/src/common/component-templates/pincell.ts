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
 * Nuclear component template: the three-body PWR pin cell.
 *
 * @module nuke-cad/common
 */

import type { NukeCadDocument } from '../cad-document';
import pincellJson from '../samples/gui_pincell.json';
import type { ComponentTemplate } from './types';

const PINCELL_MATERIALS: Readonly<Record<string, string>> = {
    fuel: 'UO2',
    clad: 'Zircaloy-4',
    moderator: 'H2O'
};

function buildPincellDocument(): NukeCadDocument {
    const document = JSON.parse(JSON.stringify(pincellJson)) as NukeCadDocument;
    document.units = 'cm';
    for (const body of document.bodies) {
        // The bundled sample decorates this shared JSON at runtime; a template
        // body stays presentation-neutral and only carries its material tag.
        delete body.appearance;
        const material = body.label !== undefined ? PINCELL_MATERIALS[body.label] : undefined;
        if (material !== undefined) {
            body.material = material;
        }
    }
    return document;
}

/**
 * The pincell is the fuel/clad/moderator starter: a three-body lattice cell
 * whose fuel and clad radii plus square pitch drive three solved sketches.
 * Radius/diameter aliases resolve through `derived` so a caller can speak in
 * either vocabulary.
 */
export const PINCELL_COMPONENT_TEMPLATE: ComponentTemplate = {
    id: 'pincell',
    name: 'Pincell',
    description: 'Three-body PWR pin cell with fuel, Zircaloy clad, and a water moderator matrix.',
    category: 'nuclear',
    keywords: ['pincell', 'pin cell', 'fuel', 'clad', 'moderator', 'lattice', 'reactor', 'pwr'],
    parameters: [
        {
            name: 'fuelRadius',
            label: 'Fuel radius',
            kind: 'length',
            unit: 'cm',
            default: 0.4,
            min: 0.01,
            max: 10,
            description: 'Radius of the fuel pellet.',
            pair: 'fuelDiameter'
        },
        {
            name: 'cladRadius',
            label: 'Clad radius',
            kind: 'length',
            unit: 'cm',
            default: 0.5,
            min: 0.02,
            max: 12,
            description: 'Outer radius of the cladding cylinder.',
            pair: 'cladDiameter'
        },
        {
            name: 'pitch',
            label: 'Pitch',
            kind: 'length',
            unit: 'cm',
            default: 1.26,
            min: 0.02,
            max: 20,
            description: 'Center-to-center spacing of the square lattice.',
            step: 0.01
        },
        {
            name: 'fuelDiameter',
            label: 'Fuel diameter',
            kind: 'length',
            unit: 'cm',
            default: 0.8,
            description: 'Fuel pellet diameter; equivalent to twice the fuel radius.',
            pair: 'fuelRadius',
            derived: { parameter: 'fuelRadius', factor: 0.5 }
        },
        {
            name: 'cladDiameter',
            label: 'Clad diameter',
            kind: 'length',
            unit: 'cm',
            default: 1,
            description: 'Cladding outside diameter; equivalent to twice the clad radius.',
            pair: 'cladRadius',
            derived: { parameter: 'cladRadius', factor: 0.5 }
        }
    ],
    document: buildPincellDocument()
};
