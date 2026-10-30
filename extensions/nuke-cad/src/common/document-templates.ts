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
 * Data-only document templates for the New Document picker.
 *
 * Templates are shallow parameter presets merged over an empty v3 document at
 * creation time. No template metadata is stored in the document itself.
 *
 * @module nuke-cad/common
 */

import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument } from './cad-document';

/** A preset applied to a new empty document. */
export interface DocumentTemplate {
    /** Stable template identifier. */
    readonly id: string;
    /** Short human-readable name. */
    readonly name: string;
    /** One-line description shown in the picker. */
    readonly description: string;
    /** Document-level parameters merged over the empty document. */
    readonly parameters: Record<string, number>;
}

/**
 * Built-in document templates shipped with the CAD modeler.
 *
 * Empty is first and is the no-op default. Preset parameter names are chosen to
 * match the terminology used in their respective demo models.
 */
export const DOCUMENT_TEMPLATES: ReadonlyArray<DocumentTemplate> = [
    {
        id: 'empty',
        name: 'Empty document',
        description: 'Start from scratch with the default datum planes.',
        parameters: {}
    },
    {
        id: 'pincell',
        name: 'Pincell starter (cm)',
        description: 'Fuel/clad radii and pitch for a simple lattice pincell.',
        parameters: {
            fuelRadius: 0.4,
            cladRadius: 0.5,
            pitch: 1.26
        }
    },
    {
        id: 'tokamak',
        name: 'Tokamak starter (cm)',
        description: 'Major and minor radius presets for a tokamak-scale device.',
        parameters: {
            major_radius: 450,
            minor_radius: 150
        }
    }
];

/** Look up a built-in template by id. */
export function getDocumentTemplate(id: string): DocumentTemplate | undefined {
    return DOCUMENT_TEMPLATES.find((t) => t.id === id);
}

/** Create a fresh empty v3 document with the canonical datum planes. */
export function createEmptyNukeCadDocument(name: string): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name,
        parameters: {},
        datums: [
            { id: 'datum-xy', kind: 'XY', name: 'XY Plane' },
            { id: 'datum-yz', kind: 'YZ', name: 'YZ Plane' },
            { id: 'datum-xz', kind: 'XZ', name: 'XZ Plane' }
        ],
        bodies: [],
        sketches: [],
        features: [],
        curves: []
    };
}

/**
 * Merge a template over an empty document.
 *
 * Returns a new document whose parameters are the union of the empty document
 * parameters and the template parameters. The empty template is a no-op.
 */
export function applyDocumentTemplate(doc: NukeCadDocument, templateId: string): NukeCadDocument {
    const template = getDocumentTemplate(templateId);
    if (template === undefined) {
        return doc;
    }
    return {
        ...doc,
        parameters: { ...doc.parameters, ...template.parameters }
    };
}
