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
 * Nuke Tool Schema
 *
 * Converts Nuke capability identifiers and JSON schemas into the shapes
 * Theia's {@link ToolRequest} expects. Conversion is intentionally lossless for
 * JSON Schema keywords: only the top-level `additionalProperties` keyword is
 * dropped because {@link ToolRequestParameters} does not declare it.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ToolRequestParameterProperty, ToolRequestParameters } from '@theia/ai-core/lib/common/language-model';
import { NukeJsonSchema, NukeJsonSchemaProperty } from 'nuke-core/lib/common/nuke-capability-protocol';

const MAX_TOOL_NAME_LENGTH = 128;

/** JSON Schema keywords whose value is a single nested schema. */
const SCHEMA_OBJECT_KEYWORDS = new Set([
    'additionalProperties',
    'contains',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties'
]);

/** JSON Schema keywords whose value is an array of nested schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** JSON Schema keywords whose value maps names to nested schemas. */
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']);

/** Convert a capability id to a provider-safe tool name. */
export function toToolName(capabilityId: string): string {
    return capabilityId
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, MAX_TOOL_NAME_LENGTH)
        .replace(/_+$/g, '');
}

/** Convert a capability's input schema to Theia tool parameters. */
export function toToolParameters(schema: NukeJsonSchema): ToolRequestParameters {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error('Capability input schema must be a JSON object schema.');
    }
    if (schema.type !== 'object') {
        throw new Error('Capability input schema must declare type "object".');
    }
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
        throw new Error('Capability input schema must declare a "properties" object.');
    }
    const parameters: ToolRequestParameters = {
        type: 'object',
        properties: toParameterProperties(schema.properties)
    };
    if (Array.isArray(schema.required)) {
        parameters.required = [...schema.required];
    }
    return parameters;
}

function toParameterProperties(properties: Record<string, NukeJsonSchemaProperty>): Record<string, ToolRequestParameterProperty> {
    const converted: Record<string, ToolRequestParameterProperty> = {};
    for (const [name, property] of Object.entries(properties)) {
        converted[name] = toParameterProperty(property);
    }
    return converted;
}

function toParameterProperty(property: NukeJsonSchemaProperty): ToolRequestParameterProperty {
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
        throw new Error('Capability input schema contains a non-object property.');
    }
    const converted: Record<string, unknown> = {};
    for (const [keyword, value] of Object.entries(property)) {
        if (value === undefined) {
            continue;
        }
        if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value)) {
            const nested: Record<string, ToolRequestParameterProperty> = {};
            for (const [name, child] of Object.entries(value)) {
                nested[name] = toParameterProperty(child as NukeJsonSchemaProperty);
            }
            converted[keyword] = nested;
        } else if (SCHEMA_OBJECT_KEYWORDS.has(keyword) && isRecord(value)) {
            converted[keyword] = toParameterProperty(value as NukeJsonSchemaProperty);
        } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
            converted[keyword] = value.map((entry) =>
                isRecord(entry) ? toParameterProperty(entry as NukeJsonSchemaProperty) : cloneValue(entry)
            );
        } else {
            converted[keyword] = cloneValue(value);
        }
    }
    return converted as ToolRequestParameterProperty;
}

function cloneValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneValue(entry));
    }
    if (isRecord(value)) {
        const cloned: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            cloned[key] = cloneValue(entry);
        }
        return cloned;
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
