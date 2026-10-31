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
 * NukeAI Capability Catalog Command
 *
 * Read-only quick pick over the capabilities enabled in the current context.
 * Each row shows the id, title, risk, version, category, tags, and availability.
 * Selecting a row copies its id and opens a read-only detail view; a capability
 * handler is never invoked from the catalog.
 *
 * @module nuke-ai/browser/commands
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { QuickPickService } from '@theia/core/lib/browser/quick-input';
import { NukeCapabilityContextService, NukeCapabilityRegistry } from 'nuke-core/lib/common/nuke-capability-protocol';
import { buildCapabilityCatalog, formatCapabilityDetails } from 'nuke-core/lib/browser/capabilities/nuke-capability-catalog';

/** Read-only capability catalog command. */
export const NukeAiCapabilityCatalogCommand = {
    id: 'nuke.ai.showCapabilityCatalog',
    label: 'NukeAI: Show Capability Catalog',
    category: 'NukeAI'
} as Command;

/** Show every capability that is enabled in the current context. */
@injectable()
export class NukeAiCapabilityCatalogCommandContribution implements CommandContribution {
    constructor(
        @inject(NukeCapabilityRegistry) protected readonly registry: NukeCapabilityRegistry,
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(QuickPickService) protected readonly quickPick: QuickPickService,
        @inject(ClipboardService) protected readonly clipboard: ClipboardService,
        @inject(MessageService) protected readonly messages: MessageService
    ) {}

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeAiCapabilityCatalogCommand, { execute: () => this.showCatalog() });
    }

    protected async showCatalog(): Promise<void> {
        await this.registry.ready;
        const context = await this.contextService.getContext();
        const capabilities = this.registry.getEnabled(context);
        // `getEnabled` already evaluated `when`, so every listed row is available.
        const entries = buildCapabilityCatalog(capabilities);
        if (entries.length === 0) {
            await this.messages.info('No capability tools are available in the current context.');
            return;
        }
        const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
        const items = entries.map((entry) => ({
            id: entry.id,
            label: entry.id,
            description: `v${entry.version} · ${entry.risk} · ${entry.title}`,
            detail: [
                entry.category,
                entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : 'No tags',
                entry.available ? 'Available' : 'Unavailable'
            ].join(' · ')
        }));
        const selected = await this.quickPick.show(items, {
            title: 'Capability Catalog',
            placeholder: 'Select a capability to copy its id and view details. Nothing is invoked.'
        });
        if (!selected) {
            return;
        }
        const capability = byId.get(selected.id);
        const entry = entries.find((candidate) => candidate.id === selected.id);
        if (!capability || !entry) {
            return;
        }
        await this.clipboard.writeText(capability.id);
        await this.quickPick.show(
            [
                {
                    label: capability.id,
                    description: `v${entry.version} · ${entry.risk} · ${capability.title}`,
                    detail: formatCapabilityDetails(entry, capability).join('\n')
                }
            ],
            {
                title: 'Capability Details (read-only)',
                placeholder: 'Read-only details. Selecting an entry never invokes a capability.'
            }
        );
    }
}
