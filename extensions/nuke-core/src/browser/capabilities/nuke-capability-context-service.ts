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
 * Nuke Capability Context Service
 *
 * Merges ambient context published by {@link NukeCapabilityContextContribution}s
 * with the current workspace roots and emits one debounced change notification
 * when any source changes.
 *
 * @module nuke-core/browser/capabilities
 */

import { injectable, inject, named, postConstruct } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import {
    NukeCapabilityContext,
    NukeCapabilityContextContribution,
    NukeCapabilityContextService
} from '../../common/nuke-capability-protocol';

/** Merged context implementation with workspace-root ownership and debounced change events. */
@injectable()
export class NukeCapabilityContextServiceImpl implements NukeCapabilityContextService, Disposable {
    protected readonly onDidChangeContextEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection();
    protected changeScheduled = false;
    protected initialized = false;

    readonly onDidChangeContext: Event<void> = this.onDidChangeContextEmitter.event;

    constructor(
        @inject(ContributionProvider)
        @named(NukeCapabilityContextContribution)
        protected readonly contributions: ContributionProvider<NukeCapabilityContextContribution>,
        @inject(WorkspaceService)
        protected readonly workspaceService: WorkspaceService,
        @inject(ILogger)
        protected readonly logger: ILogger
    ) {}

    /** Subscribe to contribution and workspace change events. Safe to call more than once. */
    @postConstruct()
    initialize(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        for (const contribution of this.getContributions()) {
            try {
                const event = contribution.onDidChangeContext;
                if (event) {
                    this.toDispose.push(event(() => this.scheduleChange()));
                }
            } catch (error) {
                this.logger.error(
                    `[NukeCapabilityContextService] Failed to subscribe to ${this.describeContribution(contribution)}:`,
                    error
                );
            }
        }
        try {
            this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.scheduleChange()));
        } catch (error) {
            this.logger.error('[NukeCapabilityContextService] Failed to subscribe to workspace changes:', error);
        }
    }

    async getContext(): Promise<NukeCapabilityContext> {
        this.initialize();
        const merged: Partial<NukeCapabilityContext> = {};
        for (const contribution of this.getContributions()) {
            try {
                const partial = await contribution.getContext();
                if (partial && typeof partial === 'object') {
                    Object.assign(merged, partial);
                }
            } catch (error) {
                this.logger.error(
                    `[NukeCapabilityContextService] Context contribution ${this.describeContribution(contribution)} failed:`,
                    error
                );
            }
        }
        const workspaceRoots = Object.freeze(this.readWorkspaceRoots());
        const context: NukeCapabilityContext = { ...merged, workspaceRoots };
        return Object.freeze(context);
    }

    dispose(): void {
        this.toDispose.dispose();
        this.onDidChangeContextEmitter.dispose();
    }

    protected getContributions(): readonly NukeCapabilityContextContribution[] {
        try {
            return this.contributions.getContributions();
        } catch (error) {
            this.logger.error('[NukeCapabilityContextService] Failed to collect context contributions:', error);
            return [];
        }
    }

    protected readWorkspaceRoots(): string[] {
        try {
            return this.workspaceService
                .tryGetRoots()
                .map((root) => root.resource.path.toString())
                .filter((root) => root.length > 0 && path.isAbsolute(root));
        } catch (error) {
            this.logger.error('[NukeCapabilityContextService] Failed to read workspace roots:', error);
            return [];
        }
    }

    protected scheduleChange(): void {
        if (this.changeScheduled) {
            return;
        }
        this.changeScheduled = true;
        queueMicrotask(() => {
            this.changeScheduled = false;
            this.onDidChangeContextEmitter.fire();
        });
    }

    protected describeContribution(contribution: NukeCapabilityContextContribution): string {
        const name = (contribution as { constructor?: { name?: string } }).constructor?.name;
        return name ? `contribution ${name}` : 'anonymous contribution';
    }
}
