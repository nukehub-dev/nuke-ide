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

import { describe, expect, it, vi } from 'vitest';
import { ILogger } from '@theia/core/lib/common/logger';
import type { NukeCapabilityDescriptor } from '../../common/nuke-capability-delegate';
import { MCP_MAX_TOOLS } from '../../common/nuke-mcp-protocol';
import { buildReadOnlyToolCatalog } from './nuke-mcp-catalog';

function logger(): ILogger & { debug: ReturnType<typeof vi.fn> } {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & { debug: ReturnType<typeof vi.fn> };
}

function descriptor(id: string, overrides: Partial<NukeCapabilityDescriptor> = {}): NukeCapabilityDescriptor {
    return {
        id,
        title: `Title ${id}`,
        description: `Description for ${id}.`,
        category: ['Test'],
        inputSchema: {
            type: 'object',
            properties: { verbose: { type: 'boolean' } },
            additionalProperties: false
        },
        risk: 'read',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        ...overrides
    };
}

describe('buildReadOnlyToolCatalog', () => {
    it('registers allowlisted read-only capabilities with sanitized annotations', () => {
        const result = buildReadOnlyToolCatalog(
            [
                descriptor('nuke.cad.summarizeDocument', {
                    outputSchema: {
                        type: 'object',
                        properties: { success: { type: 'boolean' } },
                        required: ['success'],
                        additionalProperties: false
                    }
                }),
                descriptor('nuke.viz.summarizeStatepoint')
            ],
            logger()
        );

        expect(result.tools.map((tool) => tool.name)).toEqual(['nuke_cad_summarize_document', 'nuke_viz_summarize_statepoint']);
        expect(result.tools[0]).toMatchObject({
            capabilityId: 'nuke.cad.summarizeDocument',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        });
        expect(result.tools[0].outputSchema).toBeDefined();
        expect(result.tools[1].outputSchema).toBeUndefined();
    });

    it('never registers write, execute, confirmation, or destructive capabilities', () => {
        const result = buildReadOnlyToolCatalog(
            [
                descriptor('nuke.openmc.diagnoseProject'),
                descriptor('nuke.openmc.runSimulation', { risk: 'execute', requiresConfirmation: true }),
                descriptor('nuke.openmc.applySettings', { risk: 'write', requiresConfirmation: true }),
                descriptor('nuke.cad.exportDagmc', { risk: 'execute' }),
                descriptor('nuke.openmc.validateProject', {
                    risk: 'read',
                    annotations: { readOnlyHint: false, destructiveHint: false }
                }),
                descriptor('nuke.openmc.getRunStatus', {
                    risk: 'read',
                    annotations: { readOnlyHint: true, destructiveHint: true }
                }),
                descriptor('nuke.cad.inspectSelection', { risk: 'read', requiresConfirmation: true })
            ],
            logger()
        );

        expect(result.tools.map((tool) => tool.capabilityId)).toEqual(['nuke.openmc.diagnoseProject']);
        expect(result.skipped).toEqual(
            expect.arrayContaining([
                'nuke.openmc.runSimulation',
                'nuke.openmc.applySettings',
                'nuke.cad.exportDagmc',
                'nuke.openmc.validateProject',
                'nuke.openmc.getRunStatus',
                'nuke.cad.inspectSelection'
            ])
        );
    });

    it('skips unregistered allowlist entries and unallowlisted read capabilities', () => {
        const result = buildReadOnlyToolCatalog(
            [descriptor('nuke.cad.summarizeDocument'), descriptor('nuke.openmc.previewSettings')],
            logger()
        );

        expect(result.tools.map((tool) => tool.capabilityId)).toEqual(['nuke.cad.summarizeDocument']);
        expect(result.skipped).toContain('nuke.openmc.previewSettings');
        expect(result.skipped).toContain('nuke.openmc.validateProject');
    });

    it('skips malformed names and unconvertible input schemas', () => {
        const result = buildReadOnlyToolCatalog(
            [
                descriptor('nuke.cad.summarizeDocument', {
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
                }),
                descriptor('nuke.viz.captureView', { inputSchema: null as unknown as NukeCapabilityDescriptor['inputSchema'] })
            ],
            logger()
        );

        expect(result.tools.map((tool) => tool.capabilityId)).toEqual(['nuke.cad.summarizeDocument']);
        expect(result.skipped).toContain('nuke.viz.captureView');
    });

    it(`caps the catalog at ${MCP_MAX_TOOLS} tools`, () => {
        const allowlist = Array.from({ length: MCP_MAX_TOOLS + 8 }, (_, index) => `nuke.test.capability${index}`);
        const descriptors = allowlist.map((id) => descriptor(id));
        const result = buildReadOnlyToolCatalog(descriptors, logger(), { allowlist });

        expect(result.tools).toHaveLength(MCP_MAX_TOOLS);
        expect(result.skipped).toHaveLength(8);
    });

    it('logs skipped IDs at debug level', () => {
        const testLogger = logger();
        buildReadOnlyToolCatalog([descriptor('nuke.openmc.runSimulation', { risk: 'execute' })], testLogger);

        expect(testLogger.debug).toHaveBeenCalledWith(expect.stringContaining('nuke.openmc.runSimulation'));
    });

    it('drops an output schema that cannot be converted but keeps the tool', () => {
        const testLogger = logger();
        const result = buildReadOnlyToolCatalog(
            [
                descriptor('nuke.cad.diagnoseModel', {
                    outputSchema: { type: 'object' } as unknown as NukeCapabilityDescriptor['outputSchema']
                })
            ],
            testLogger
        );

        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].outputSchema).toBeUndefined();
        expect(testLogger.debug).toHaveBeenCalledWith(expect.stringContaining('output schema'));
    });
});
