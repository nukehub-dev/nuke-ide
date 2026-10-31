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
 * Nuke Capability Registry
 *
 * Collects {@link NukeCapability} registrations from every
 * {@link NukeCapabilityContribution}, validates them defensively, and exposes a
 * stable, filterable view plus change notifications.
 *
 * @module nuke-core/browser/capabilities
 */

import { injectable, inject, named, postConstruct } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { Deferred } from '@theia/core/lib/common/promise-util';
import * as path from 'path';
import {
    NukeCapability,
    NukeCapabilityAnnotations,
    NukeCapabilityContribution,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityRisk,
    NukeJsonSchemaProperty
} from '../../common/nuke-capability-protocol';

const CAPABILITY_ID_PATTERN = /^nuke\.[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

const CAPABILITY_RISKS: readonly NukeCapabilityRisk[] = ['read', 'write', 'execute', 'destructive'];

/** Compare two strings with deterministic, locale-independent ordering. */
function compareStrings(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/**
 * Validate a capability's static contract.
 *
 * @returns Human-readable problems; an empty array means the capability is valid.
 */
export function validateCapability(capability: NukeCapability): string[] {
    const errors: string[] = [];
    if (!capability || typeof capability !== 'object') {
        return ['capability must be an object'];
    }
    if (typeof capability.id !== 'string' || !CAPABILITY_ID_PATTERN.test(capability.id)) {
        errors.push('id must match nuke.<domain>.<verbNoun>');
    }
    if (typeof capability.title !== 'string' || capability.title.trim().length === 0) {
        errors.push('title must be a non-empty string');
    }
    if (typeof capability.description !== 'string' || capability.description.trim().length === 0) {
        errors.push('description must be a non-empty string');
    }
    if (!Array.isArray(capability.category) || capability.category.some((entry) => typeof entry !== 'string')) {
        errors.push('category must be an array of strings');
    }
    const schema = capability.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        errors.push('inputSchema must be an object');
    } else {
        if (schema.type !== 'object') {
            errors.push('inputSchema.type must be "object"');
        }
        if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
            errors.push('inputSchema.properties must be an object');
        }
        if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
            errors.push('inputSchema.required must be an array of strings');
        }
    }
    if (!CAPABILITY_RISKS.includes(capability.risk)) {
        errors.push(`risk must be one of ${CAPABILITY_RISKS.join(', ')}`);
    }
    if (typeof capability.invoke !== 'function') {
        errors.push('invoke must be a function');
    }
    if (capability.when !== undefined && typeof capability.when !== 'function') {
        errors.push('when must be a function when provided');
    }
    return errors;
}

/** Describe the expected top-level JSON type of a schema property. */
function validatePrimitiveValue(property: NukeJsonSchemaProperty, value: unknown): string | undefined {
    switch (property.type) {
        case 'string':
            return typeof value === 'string' ? undefined : 'must be a string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a finite number';
        case 'integer':
            return Number.isInteger(value) ? undefined : 'must be an integer';
        case 'boolean':
            return typeof value === 'boolean' ? undefined : 'must be a boolean';
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value) ? undefined : 'must be an object';
        case 'array':
            return Array.isArray(value) ? undefined : 'must be an array';
        case 'null':
            return value === null ? undefined : 'must be null';
        default:
            return undefined;
    }
}

/**
 * Validate a capability invocation's top-level input against its input schema.
 *
 * This deliberately checks only required keys and top-level primitive types;
 * nested schemas, enums, and additional properties are left to the capability.
 *
 * @returns Human-readable problems; an empty array means the input is acceptable.
 */
export function validateCapabilityInput(capability: NukeCapability, input: unknown): string[] {
    const errors: string[] = [];
    const schema = capability.inputSchema;
    if (!schema || schema.type !== 'object' || !schema.properties) {
        return ['capability does not declare an object input schema'];
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return ['input must be an object'];
    }
    const record = input as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
        if (!(key in record) || record[key] === undefined) {
            errors.push(`missing required input "${key}"`);
        }
    }
    for (const [key, property] of Object.entries(schema.properties)) {
        if (!(key in record) || record[key] === undefined) {
            continue;
        }
        const problem = validatePrimitiveValue(property, record[key]);
        if (problem) {
            errors.push(`input "${key}" ${problem}`);
        }
    }
    return errors;
}

/**
 * Return true when `candidate` is an absolute path inside one of the absolute
 * workspace `roots`. Uses `path.relative` rather than string prefixes so sibling
 * folders and `..` traversal cannot escape a root.
 */
export function isWithinWorkspace(candidate: string, roots: readonly string[]): boolean {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
        return false;
    }
    if (!Array.isArray(roots)) {
        return false;
    }
    const normalizedCandidate = path.resolve(candidate);
    for (const root of roots) {
        if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
            continue;
        }
        const relative = path.relative(path.resolve(root), normalizedCandidate);
        if (relative === '') {
            return true;
        }
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            continue;
        }
        return true;
    }
    return false;
}

/** Derive MCP-style behavior hints from a risk classification. */
export function deriveAnnotations(risk: NukeCapabilityRisk): NukeCapabilityAnnotations {
    switch (risk) {
        case 'read':
            return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
        case 'destructive':
            return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
        case 'write':
        case 'execute':
        default:
            return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    }
}

/**
 * Registry implementation. Contributions run once during `initialize`, and a
 * failing contribution never prevents later contributions from registering or
 * rejects {@link ready}.
 */
@injectable()
export class NukeCapabilityRegistryImpl implements NukeCapabilityRegistry {
    protected readonly capabilities = new Map<string, NukeCapability>();
    protected readonly sources = new Map<string, string>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly readyDeferred = new Deferred<void>();
    protected currentSource: string | undefined;
    protected initialPassComplete = false;
    protected initialized = false;

    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    /** Resolves after the initial contribution pass; starts the pass if it has not run yet. */
    get ready(): Promise<void> {
        void this.initialize();
        return this.readyDeferred.promise;
    }

    constructor(
        @inject(ContributionProvider)
        @named(NukeCapabilityContribution)
        protected readonly contributions: ContributionProvider<NukeCapabilityContribution>,
        @inject(ILogger)
        protected readonly logger: ILogger
    ) {}

    /** Start the initial contribution pass eagerly without making DI resolution async. */
    @postConstruct()
    protected initializeEagerly(): void {
        void this.initialize();
    }

    /** Run every contribution once. Safe to call more than once. */
    initialize(): Promise<void> {
        return this.runInitialPass();
    }

    protected async runInitialPass(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        try {
            const contributions = this.contributions.getContributions();
            for (const contribution of contributions) {
                this.currentSource = this.describeContribution(contribution);
                try {
                    await contribution.registerCapabilities(this);
                } catch (error) {
                    this.logger.error(`[NukeCapabilityRegistry] Contribution ${this.currentSource} failed:`, error);
                }
            }
        } catch (error) {
            this.logger.error('[NukeCapabilityRegistry] Failed to collect capability contributions:', error);
        } finally {
            this.currentSource = undefined;
            this.initialPassComplete = true;
            this.readyDeferred.resolve();
            this.onDidChangeEmitter.fire();
        }
    }

    register(capability: NukeCapability): void {
        const source = this.currentSource ?? 'direct registration';
        const errors = validateCapability(capability);
        if (errors.length > 0) {
            this.logger.error(`[NukeCapabilityRegistry] Rejected capability from ${source}: ${errors.join('; ')}`);
            return;
        }
        const existingSource = this.sources.get(capability.id);
        if (existingSource !== undefined) {
            this.logger.error(
                `[NukeCapabilityRegistry] Duplicate capability id ${capability.id}: keeping ${existingSource}, ignoring ${source}`
            );
            return;
        }
        const normalized = this.normalizeCapability(capability, source);
        this.capabilities.set(normalized.id, normalized);
        this.sources.set(normalized.id, source);
        if (this.initialPassComplete) {
            this.onDidChangeEmitter.fire();
        }
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.get(id);
    }

    getAll(): readonly NukeCapability[] {
        return Array.from(this.capabilities.values()).sort(
            (left, right) =>
                compareStrings(left.category.join('/'), right.category.join('/')) ||
                compareStrings(left.title, right.title) ||
                compareStrings(left.id, right.id)
        );
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.getAll().filter((capability) => {
            if (!capability.when) {
                return true;
            }
            try {
                return capability.when(context);
            } catch (error) {
                this.logger.error(`[NukeCapabilityRegistry] when() failed for ${capability.id}:`, error);
                return false;
            }
        });
    }

    /** Attach derived annotations when omitted and warn about explicit contradictions. */
    protected normalizeCapability(capability: NukeCapability, source: string): NukeCapability {
        if (!capability.annotations) {
            return { ...capability, annotations: deriveAnnotations(capability.risk) };
        }
        const derived = deriveAnnotations(capability.risk);
        const contradictions = (Object.keys(capability.annotations) as Array<keyof NukeCapabilityAnnotations>).filter(
            (key) => capability.annotations?.[key] !== undefined && capability.annotations[key] !== derived[key]
        );
        if (contradictions.length > 0) {
            this.logger.warn(
                `[NukeCapabilityRegistry] Capability ${capability.id} from ${source} has annotations that contradict risk ${capability.risk}: ` +
                    contradictions.join(', ')
            );
        }
        return capability;
    }

    protected describeContribution(contribution: NukeCapabilityContribution): string {
        const name = (contribution as { constructor?: { name?: string } }).constructor?.name;
        return name ? `contribution ${name}` : 'anonymous contribution';
    }
}
