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

import { describe, expect, it } from 'vitest';
import { ToolRequestParameterProperty } from '@theia/ai-core/lib/common/language-model';
import { NukeJsonSchema } from 'nuke-core/lib/common/nuke-capability-protocol';
import { toToolName, toToolParameters } from './nuke-tool-schema';

describe('toToolName', () => {
    it('replaces dots and other unsafe characters with underscores', () => {
        expect(toToolName('nuke.cad.exportDagmc')).toBe('nuke_cad_exportDagmc');
        expect(toToolName('nuke.cad.export DAGMC!')).toBe('nuke_cad_export_DAGMC');
    });

    it('collapses repeated underscores and trims them from both ends', () => {
        expect(toToolName('...nuke..cad...exportDagmc...')).toBe('nuke_cad_exportDagmc');
        expect(toToolName('nuke---cad')).toBe('nuke---cad');
    });

    it('caps names at 128 characters without a trailing underscore', () => {
        const name = toToolName(`nuke.${'a'.repeat(200)}`);
        expect(name).toHaveLength(128);
        expect(name.endsWith('_')).toBe(false);
    });
});

describe('toToolParameters', () => {
    it('converts flat schemas and preserves JSON Schema keywords', () => {
        const schema: NukeJsonSchema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                path: { type: 'string', description: 'File path', minLength: 1, pattern: '^/' },
                mode: { type: 'string', enum: ['fast', 'full'], default: 'fast' },
                count: { type: 'integer', minimum: 1, maximum: 10 }
            },
            required: ['path', 'mode']
        };

        const parameters = toToolParameters(schema);

        expect(parameters.type).toBe('object');
        expect(parameters.required).toEqual(['path', 'mode']);
        expect(parameters).not.toHaveProperty('additionalProperties');
        expect(parameters.properties.path).toMatchObject({
            type: 'string',
            description: 'File path',
            minLength: 1,
            pattern: '^/'
        });
        expect(parameters.properties.mode).toMatchObject({ type: 'string', enum: ['fast', 'full'], default: 'fast' });
        expect(parameters.properties.count).toMatchObject({ type: 'integer', minimum: 1, maximum: 10 });
    });

    it('converts nested objects, arrays, anyOf, and nested additionalProperties', () => {
        const schema: NukeJsonSchema = {
            type: 'object',
            properties: {
                tags: { type: 'array', items: { type: 'string' } },
                filter: {
                    anyOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            properties: { name: { type: 'string' } },
                            required: ['name'],
                            additionalProperties: false
                        }
                    ]
                },
                nested: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                    additionalProperties: false
                }
            }
        };

        const parameters = toToolParameters(schema);
        const tags = parameters.properties.tags as ToolRequestParameterProperty & { items: ToolRequestParameterProperty };
        const filter = parameters.properties.filter as ToolRequestParameterProperty & {
            anyOf: ToolRequestParameterProperty[];
        };
        const filterObject = filter.anyOf[1] as ToolRequestParameterProperty & {
            properties: Record<string, ToolRequestParameterProperty>;
            required: string[];
        };
        const nested = parameters.properties.nested as ToolRequestParameterProperty & {
            properties: Record<string, ToolRequestParameterProperty>;
            required: string[];
            additionalProperties: boolean;
        };

        expect(tags.items.type).toBe('string');
        expect(filter.anyOf[0].type).toBe('string');
        expect(filterObject.properties.name.type).toBe('string');
        expect(filterObject.required).toEqual(['name']);
        expect(nested.properties.path.type).toBe('string');
        expect(nested.required).toEqual(['path']);
        expect(nested.additionalProperties).toBe(false);
    });

    it('throws a descriptive error for non-object schemas', () => {
        expect(() => toToolParameters({ type: 'array', properties: {} } as unknown as NukeJsonSchema)).toThrow(
            /must declare type "object"/
        );
        expect(() => toToolParameters({ type: 'object' } as NukeJsonSchema)).toThrow(/must declare a "properties" object/);
        expect(() => toToolParameters(undefined as unknown as NukeJsonSchema)).toThrow(/must be a JSON object schema/);
    });
});
