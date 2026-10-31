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
 * Nuke MCP Catalog
 *
 * Projects live capability descriptors onto the explicit external MCP
 * allowlist. A descriptor is registered only when it is enabled, read-only,
 * unconfirmed, free of write or destructive annotations, and convertible to a
 * portable tool name and Zod input schema. Everything else is skipped at
 * debug level.
 *
 * @module nuke-ai/node/mcp
 */

import { fromJSONSchema } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ILogger } from '@theia/core/lib/common/logger';
import type { NukeCapabilityDescriptor } from '../../common/nuke-capability-delegate';
import {
    buildMcpToolDescription,
    MCP_MAX_TOOLS,
    MCP_READ_ONLY_CAPABILITY_IDS,
    MCP_TOOL_NAME_PATTERN,
    isReadOnlyMcpCapability,
    toMcpToolName
} from '../../common/nuke-mcp-protocol';

/** Zod schema produced by the JSON Schema bridge. */
export type NukeMcpZodSchema = ReturnType<typeof fromJSONSchema>;

/** One live read-only tool registered with an MCP session. */
export interface NukeMcpCatalogTool {
    readonly name: string;
    readonly capabilityId: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: NukeMcpZodSchema;
    readonly outputSchema?: NukeMcpZodSchema;
    readonly annotations: ToolAnnotations;
    readonly descriptor: NukeCapabilityDescriptor;
}

/** Result of one catalog projection. */
export interface NukeMcpCatalog {
    readonly tools: readonly NukeMcpCatalogTool[];
    readonly skipped: readonly string[];
}

/** Optional catalog bounds; production always uses the protocol defaults. */
export interface NukeMcpCatalogOptions {
    readonly allowlist?: readonly string[];
    readonly maxTools?: number;
}

/**
 * Build the per-session tool catalog from live frontend descriptors. Invalid or
 * unsafe entries never abort the rest of the catalog.
 */
export function buildReadOnlyToolCatalog(
    descriptors: readonly NukeCapabilityDescriptor[],
    logger: ILogger,
    options: NukeMcpCatalogOptions = {}
): NukeMcpCatalog {
    const allowlist = options.allowlist ?? MCP_READ_ONLY_CAPABILITY_IDS;
    const maxTools = options.maxTools ?? MCP_MAX_TOOLS;
    const tools: NukeMcpCatalogTool[] = [];
    const skipped: string[] = [];
    const allowlistSet = new Set(allowlist);
    const byId = new Map<string, NukeCapabilityDescriptor>();
    for (const descriptor of descriptors) {
        if (!isDescriptor(descriptor)) {
            debug(logger, 'MCP skipped a malformed capability descriptor.');
            continue;
        }
        byId.set(descriptor.id, descriptor);
        if (!allowlistSet.has(descriptor.id)) {
            skipped.push(descriptor.id);
            debug(logger, `MCP skipped ${descriptor.id}: not in the read-only allowlist.`);
        }
    }

    const names = new Set<string>();
    for (const capabilityId of allowlist) {
        if (tools.length >= maxTools) {
            skipped.push(capabilityId);
            debug(logger, `MCP skipped ${capabilityId}: catalog reached ${maxTools} tools.`);
            continue;
        }
        const descriptor = byId.get(capabilityId);
        if (!descriptor) {
            skipped.push(capabilityId);
            debug(logger, `MCP skipped ${capabilityId}: the capability is not enabled or registered.`);
            continue;
        }
        if (!isReadOnlyMcpCapability(descriptor)) {
            skipped.push(capabilityId);
            debug(logger, `MCP skipped ${capabilityId}: the capability is not a confirmed read-only action.`);
            continue;
        }
        let name: string;
        try {
            name = toMcpToolName(capabilityId);
        } catch (error) {
            skipped.push(capabilityId);
            debug(logger, `MCP skipped ${capabilityId}: ${errorMessage(error)}`);
            continue;
        }
        if (!MCP_TOOL_NAME_PATTERN.test(name) || names.has(name)) {
            skipped.push(capabilityId);
            debug(logger, `MCP skipped ${capabilityId}: the tool name ${name} is invalid or duplicated.`);
            continue;
        }
        const inputSchema = convertSchema(descriptor.inputSchema, capabilityId, 'input', logger);
        if (!inputSchema) {
            skipped.push(capabilityId);
            continue;
        }
        const outputSchema = descriptor.outputSchema ? convertSchema(descriptor.outputSchema, capabilityId, 'output', logger) : undefined;
        names.add(name);
        tools.push({
            name,
            capabilityId,
            title: descriptor.title,
            description: buildMcpToolDescription(descriptor),
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            annotations: readOnlyAnnotations(descriptor),
            descriptor
        });
    }
    return { tools, skipped };
}

function isDescriptor(value: unknown): value is NukeCapabilityDescriptor {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<NukeCapabilityDescriptor>;
    return (
        typeof record.id === 'string' && record.id.length > 0 && typeof record.title === 'string' && typeof record.description === 'string'
    );
}

function convertSchema(
    schema: NukeCapabilityDescriptor['inputSchema'] | undefined,
    capabilityId: string,
    kind: 'input' | 'output',
    logger: ILogger
): NukeMcpZodSchema | undefined {
    if (!schema || typeof schema !== 'object' || schema.type !== 'object' || typeof schema.properties !== 'object') {
        debug(logger, `MCP skipped the ${kind} schema for ${capabilityId}: it is not an object schema.`);
        return undefined;
    }
    try {
        return fromJSONSchema(schema as unknown as Parameters<typeof fromJSONSchema>[0]);
    } catch (error) {
        debug(logger, `MCP could not convert the ${kind} schema for ${capabilityId}: ${errorMessage(error)}`);
        return undefined;
    }
}

function readOnlyAnnotations(descriptor: NukeCapabilityDescriptor): ToolAnnotations {
    const annotations = descriptor.annotations;
    return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: annotations?.idempotentHint ?? true,
        openWorldHint: annotations?.openWorldHint ?? false
    };
}

function debug(logger: ILogger, message: string): void {
    try {
        void Promise.resolve(logger.debug(`[NukeAI] ${message}`)).catch(() => undefined);
    } catch {
        // Logging must never break catalog construction.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
