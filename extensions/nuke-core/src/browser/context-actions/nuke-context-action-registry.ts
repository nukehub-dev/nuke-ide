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
 * Nuke Context Action Registry
 *
 * Collects neutral menu actions from every {@link NukeContextActionContribution},
 * validates them defensively, deduplicates by id, and exposes a stable,
 * scope-filtered view plus change notifications. Predicates are synchronous and
 * a throwing predicate hides its action instead of breaking the menu.
 *
 * @module nuke-core/browser/context-actions
 */

import { injectable, inject, named, postConstruct } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import {
    NUKE_CONTEXT_ACTION_SCOPES,
    NukeContextAction,
    NukeContextActionContribution,
    NukeContextActionRegistry,
    NukeContextActionScope
} from '../../common/nuke-context-action-protocol';

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

/** Validate a context action's static contract. */
export function validateContextAction(action: NukeContextAction): string[] {
    const errors: string[] = [];
    if (!action || typeof action !== 'object') {
        return ['action must be an object'];
    }
    if (typeof action.id !== 'string' || action.id.trim().length === 0) {
        errors.push('id must be a non-empty string');
    }
    if (!NUKE_CONTEXT_ACTION_SCOPES.includes(action.scope)) {
        errors.push(`scope must be one of ${NUKE_CONTEXT_ACTION_SCOPES.join(', ')}`);
    }
    if (typeof action.label !== 'string' || action.label.trim().length === 0) {
        errors.push('label must be a non-empty string');
    }
    if (typeof action.commandId !== 'string' || action.commandId.trim().length === 0) {
        errors.push('commandId must be a non-empty string');
    }
    if (action.group !== undefined && typeof action.group !== 'string') {
        errors.push('group must be a string when provided');
    }
    if (action.order !== undefined && typeof action.order !== 'string') {
        errors.push('order must be a string when provided');
    }
    if (action.when !== undefined && typeof action.when !== 'function') {
        errors.push('when must be a function when provided');
    }
    return errors;
}

/** Stable menu order: group, then order, then label, then id. */
export function compareContextActions(left: NukeContextAction, right: NukeContextAction): number {
    return (
        compareStrings(left.group ?? '', right.group ?? '') ||
        compareStrings(left.order ?? '', right.order ?? '') ||
        compareStrings(left.label, right.label) ||
        compareStrings(left.id, right.id)
    );
}

/**
 * Registry implementation. Contributions run once on first use; a throwing
 * contribution is logged and never prevents later contributions from
 * registering.
 */
@injectable()
export class NukeContextActionRegistryImpl implements NukeContextActionRegistry {
    protected readonly actions = new Map<string, NukeContextAction>();
    protected readonly sources = new Map<string, string>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected currentSource: string | undefined;
    protected initializing = false;
    protected initialized = false;

    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        @inject(ContributionProvider)
        @named(NukeContextActionContribution)
        protected readonly contributions: ContributionProvider<NukeContextActionContribution>,
        @inject(ILogger)
        protected readonly logger: ILogger
    ) {}

    /** Start the initial contribution pass eagerly without making DI resolution async. */
    @postConstruct()
    protected initializeEagerly(): void {
        this.ensureInitialized();
    }

    register(action: NukeContextAction): void {
        this.ensureInitialized();
        const source = this.currentSource ?? 'direct registration';
        const errors = validateContextAction(action);
        if (errors.length > 0) {
            this.logger.error(`[NukeContextActionRegistry] Rejected action from ${source}: ${errors.join('; ')}`);
            return;
        }
        const existingSource = this.sources.get(action.id);
        if (existingSource !== undefined) {
            this.logger.error(
                `[NukeContextActionRegistry] Duplicate action id ${action.id}: keeping ${existingSource}, ignoring ${source}`
            );
            return;
        }
        this.actions.set(action.id, action);
        this.sources.set(action.id, source);
        if (this.initialized) {
            this.onDidChangeEmitter.fire();
        }
    }

    getActions(scope: NukeContextActionScope): readonly NukeContextAction[] {
        this.ensureInitialized();
        return Array.from(this.actions.values())
            .filter((action) => action.scope === scope)
            .filter((action) => this.isEnabled(action))
            .sort(compareContextActions);
    }

    /** Run every contribution once. Safe to call more than once. */
    protected ensureInitialized(): void {
        if (this.initialized || this.initializing) {
            return;
        }
        this.initializing = true;
        try {
            for (const contribution of this.contributions.getContributions()) {
                this.currentSource = this.describeContribution(contribution);
                try {
                    contribution.registerContextActions(this);
                } catch (error) {
                    this.logger.error(`[NukeContextActionRegistry] Contribution ${this.currentSource} failed:`, error);
                }
            }
        } catch (error) {
            this.logger.error('[NukeContextActionRegistry] Failed to collect context-action contributions:', error);
        } finally {
            this.currentSource = undefined;
            this.initializing = false;
            this.initialized = true;
            this.onDidChangeEmitter.fire();
        }
    }

    /** Evaluate `when`; a throw is logged and treated as disabled. */
    protected isEnabled(action: NukeContextAction): boolean {
        if (!action.when) {
            return true;
        }
        try {
            return action.when();
        } catch (error) {
            this.logger.error(`[NukeContextActionRegistry] when() failed for ${action.id}:`, error);
            return false;
        }
    }

    protected describeContribution(contribution: NukeContextActionContribution): string {
        const name = (contribution as { constructor?: { name?: string } }).constructor?.name;
        return name ? `contribution ${name}` : 'anonymous contribution';
    }
}
