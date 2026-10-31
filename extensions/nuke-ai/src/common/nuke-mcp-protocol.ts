// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Nuke MCP Protocol
 *
 * Static catalog for the external MCP endpoint. The initial catalog exposes exactly one
 * read-only capability, two resources, and one prompt; the schemas mirror the
 * CAD capability contract in `nuke-cad` without importing that extension.
 *
 * @module nuke-ai/common
 */

import type { NukeJsonSchema } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCapabilityDescriptor } from './nuke-capability-delegate';

/** MCP tool name for the single read-only CAD capability. */
export const SPIKE_TOOL_NAME = 'nuke_cad_summarize_document';

/** MCP resource URI for the active IDE context snapshot. */
export const SPIKE_CONTEXT_RESOURCE_URI = 'nuke://context';

/** MCP resource URI for the active CAD document summary. */
export const SPIKE_CAD_RESOURCE_URI = 'nuke://cad/document';

/** MCP prompt that describes the CAD to OpenMC workflow. */
export const NUKE_WORKFLOW_PROMPT_NAME = 'nuke-workflow';

const SUMMARIZE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        includeSolids: { type: 'boolean', default: false, description: 'Include per-solid summaries.' }
    },
    additionalProperties: false
};

const SUMMARIZE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Absolute path to the active CAD source.' },
        success: { type: 'boolean', description: 'Whether the active build succeeded.' },
        solidCount: { type: 'integer', description: 'Number of solid volumes in the model.' },
        faceCount: { type: 'integer', description: 'Total number of faces across all solids.' },
        triangleCount: { type: 'integer', description: 'Total number of tessellation triangles.' },
        boundingBox: {
            type: 'object',
            description: 'Model bounding box in model units.',
            properties: {
                min: { type: 'array', items: { type: 'number' } },
                max: { type: 'array', items: { type: 'number' } }
            }
        },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Build diagnostics.' },
        selection: {
            type: 'object',
            description: 'Current viewport selection.',
            properties: {
                solidId: { type: 'integer', description: 'Primary selected solid.' },
                faceId: { type: 'integer', description: 'Precise face of the primary solid.' },
                solidIds: { type: 'array', items: { type: 'integer' }, description: 'All highlighted solids.' }
            },
            additionalProperties: false
        },
        manifest: {
            type: 'object',
            description: 'Region manifest loaded for the active build.',
            properties: {
                volumes: { type: 'array', items: { type: 'object' } },
                surfaces: { type: 'array', items: { type: 'object' } }
            }
        },
        solids: {
            type: 'array',
            description: 'Per-solid summaries; present only when includeSolids is true.',
            items: {
                type: 'object',
                properties: {
                    solidId: { type: 'integer' },
                    bodyId: { type: 'string' },
                    faceCount: { type: 'integer' },
                    edgeCount: { type: 'integer' },
                    triangleCount: { type: 'integer' },
                    properties: { type: 'object', description: 'Volume, area, bounding box, and center of mass when available.' }
                },
                required: ['solidId', 'faceCount', 'edgeCount', 'triangleCount'],
                additionalProperties: false
            }
        }
    },
    required: ['documentPath', 'success', 'selection'],
    additionalProperties: false
};

/**
 * The only capability exposed over the external MCP endpoint.
 *
 * Keep this schema structurally equal to `nuke-cad`'s
 * `nuke.cad.summarizeDocument` capability. The endpoint is read-only: never add
 * export, run, or write capabilities to this catalog.
 */
export const SPIKE_CAPABILITY: NukeCapabilityDescriptor = {
    id: 'nuke.cad.summarizeDocument',
    title: 'Summarize CAD document',
    description: 'Return build counts, selection, region manifest, and optional per-solid summaries for the active CAD document.',
    category: ['CAD'],
    inputSchema: SUMMARIZE_INPUT_SCHEMA,
    outputSchema: SUMMARIZE_OUTPUT_SCHEMA,
    risk: 'read',
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
    },
    tags: ['cad', 'read']
};

/** Prompt text describing the CAD to DAGMC to OpenMC to visualizer flow. */
export const NUKE_WORKFLOW_PROMPT = [
    'Walk through the NukeIDE CAD-to-simulation workflow without changing anything.',
    '',
    'This endpoint exposes one read-only tool, `nuke_cad_summarize_document` (capability',
    '`nuke.cad.summarizeDocument`). The other capability IDs below describe the workflow but are not',
    'callable through this endpoint.',
    '',
    '1. Read `nuke.cad.summarizeDocument` for the active CAD document.',
    '2. Use `nuke.cad.inspectSelection` when a viewport selection matters.',
    '3. After the user confirms, `nuke.cad.exportDagmc` exports the DAGMC model and region manifest.',
    '4. `nuke.openmc.importCad` attaches that model to an OpenMC project.',
    '5. `nuke.openmc.validateProject`, then `nuke.openmc.runSimulation`, then `nuke.openmc.getRunStatus` cover the run.',
    '6. `nuke.viz.openStatepoint` and `nuke.viz.summarizeStatepoint` inspect the resulting statepoint.',
    '',
    'The prompt itself performs no write action. Export, import, and run capabilities require explicit confirmation.'
].join('\n');
