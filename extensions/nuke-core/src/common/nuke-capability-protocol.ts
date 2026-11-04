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
 * Nuke Capability Protocol
 *
 * Neutral cross-extension contract for exposing actions to capability
 * consumers. The contract has no AI or domain dependency: extensions contribute
 * {@link NukeCapability} handlers through {@link NukeCapabilityContribution},
 * and consumers (including an optional AI adapter) read them from
 * {@link NukeCapabilityRegistry}.
 *
 * @module nuke-core/common
 */

import type { Event } from '@theia/core/lib/common/event';
import type { MaybePromise } from '@theia/core/lib/common/types';

/** Risk classification for a capability. */
export type NukeCapabilityRisk = 'read' | 'write' | 'execute' | 'destructive';

/** Minimal JSON-schema shape used for capability inputs and outputs. */
export interface NukeJsonSchemaProperty {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
    description?: string;
    enum?: readonly unknown[];
    default?: unknown;
    items?: NukeJsonSchemaProperty;
    properties?: Record<string, NukeJsonSchemaProperty>;
    required?: readonly string[];
    additionalProperties?: boolean | NukeJsonSchemaProperty;
    anyOf?: readonly NukeJsonSchemaProperty[];
    [key: string]: unknown;
}

/** Top-level object schema for a capability's structured input. */
export interface NukeJsonSchema extends NukeJsonSchemaProperty {
    type: 'object';
    properties: Record<string, NukeJsonSchemaProperty>;
    required?: readonly string[];
    additionalProperties?: boolean;
}

/** MCP-style behavior hints derived from or supplied alongside a risk level. */
export interface NukeCapabilityAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

/** Worked example attached to a capability description. */
export interface NukeCapabilityExample {
    readonly description: string;
    readonly input: unknown;
}

/** Ambient state available to capability predicates and invocations. */
export interface NukeCapabilityContext {
    readonly workspaceRoots: readonly string[];
    readonly activeCadDocument?: string;
    readonly activeOpenmcProject?: string;
    readonly activeDataset?: string;
    /** True while at least one DAGMC viewer is open in the main area. */
    readonly hasDagmcViewer?: boolean;
    readonly signal?: AbortSignal;
}

/** A file, image, plot, table, or JSON payload produced by a capability. */
export interface NukeArtifact {
    readonly kind: 'file' | 'image' | 'plot' | 'table' | 'json';
    readonly label: string;
    readonly path?: string;
    readonly uri?: string;
    readonly mimeType?: string;
}

/** A truthful preview of capability output. */
export interface NukePreview {
    readonly kind: 'image' | 'svg' | 'html' | 'markdown';
    readonly data?: string;
    readonly path?: string;
    readonly mimeType?: string;
    readonly caption?: string;
    readonly truthful: boolean;
    readonly limitations?: readonly string[];
}

/** Suggested follow-up capability. */
export interface NukeNextAction {
    readonly capability: string;
    readonly reason: string;
}

/** Kind of edit described by a {@link NukeChange}. */
export type NukeChangeKind = 'add' | 'update' | 'remove';

/** One path-level edit proposed or applied by a capability. */
export interface NukeChange {
    readonly path: string;
    readonly label: string;
    readonly kind: NukeChangeKind;
    readonly before?: unknown;
    readonly after?: unknown;
}

/** Structured preview of the edits a write capability will apply. */
export interface NukeChangeSet {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly changes: readonly NukeChange[];
    /** Write capability that applies this proposal; omitted after apply. */
    readonly applyCapability?: string;
}

/** Structured result envelope returned by every capability invocation. */
export interface NukeCapabilityResult {
    readonly ok: boolean;
    readonly data?: unknown;
    readonly message?: string;
    readonly warnings?: readonly string[];
    readonly artifacts?: readonly NukeArtifact[];
    readonly preview?: NukePreview;
    readonly changeSet?: NukeChangeSet;
    readonly undoToken?: string;
    readonly nextActions?: readonly NukeNextAction[];
    readonly handle?: string;
}

/** A single action exposed by a domain extension. */
export interface NukeCapability {
    /** Stable identifier: `nuke.<domain>.<verbNoun>`. */
    readonly id: string;
    /**
     * Additive contract version. Defaults to `1` when omitted.
     *
     * Adding optional input fields, results, tags, or examples stays backward
     * compatible and keeps the version. A breaking change to the input/output
     * schema or to the meaning of an existing field bumps it. Consumers report
     * the version; they do not negotiate or enforce it.
     */
    readonly version?: number;
    readonly title: string;
    readonly description: string;
    readonly category: readonly string[];
    readonly inputSchema: NukeJsonSchema;
    readonly outputSchema?: NukeJsonSchema;
    readonly risk: NukeCapabilityRisk;
    readonly annotations?: NukeCapabilityAnnotations;
    readonly requiresConfirmation?: boolean;
    readonly undoable?: boolean;
    readonly tags?: readonly string[];
    readonly examples?: readonly NukeCapabilityExample[];
    readonly when?: (context: NukeCapabilityContext) => boolean;
    invoke(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult>;
}

/** DI symbol for the capability contribution provider. */
export const NukeCapabilityContribution = Symbol('NukeCapabilityContribution');

/** Contribution point for registering capabilities. */
export interface NukeCapabilityContribution {
    registerCapabilities(registry: NukeCapabilityRegistry): MaybePromise<void>;
}

/** DI symbol for the capability registry. */
export const NukeCapabilityRegistry = Symbol('NukeCapabilityRegistry');

/** Registry through which capabilities are discovered and invoked. */
export interface NukeCapabilityRegistry {
    register(capability: NukeCapability): void;
    get(id: string): NukeCapability | undefined;
    getAll(): readonly NukeCapability[];
    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[];
    readonly ready: Promise<void>;
    readonly onDidChange: Event<void>;
}

/** DI symbol for the capability context contribution provider. */
export const NukeCapabilityContextContribution = Symbol('NukeCapabilityContextContribution');

/** Contribution point for ambient capability context. */
export interface NukeCapabilityContextContribution {
    getContext(): MaybePromise<Partial<NukeCapabilityContext>>;
    readonly onDidChangeContext?: Event<void>;
}

/** DI symbol for the capability context service. */
export const NukeCapabilityContextService = Symbol('NukeCapabilityContextService');

/** Service that exposes a merged, frozen capability context snapshot. */
export interface NukeCapabilityContextService {
    getContext(): Promise<NukeCapabilityContext>;
    readonly onDidChangeContext: Event<void>;
}
