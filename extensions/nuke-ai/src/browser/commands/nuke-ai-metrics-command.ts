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
 * NukeAI Tool Metrics Command
 *
 * Read-only view over the local tool invocation journal. It offers the last 20
 * invocations or aggregate success/failure counts per capability. It never
 * invokes a capability and never writes or deletes the journal.
 *
 * @module nuke-ai/browser/commands
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickItem, QuickPickService } from '@theia/core/lib/browser/quick-input';
import { NUKE_AI_METRICS_RECENT_LIMIT, NukeAiMetricsService, summarizeMetrics } from '../capabilities/nuke-ai-metrics-service';

/** Read-only tool metrics command. */
export const NukeAiMetricsCommand = {
    id: 'nuke.ai.showToolMetrics',
    label: 'NukeAI: Show Tool Metrics',
    category: 'NukeAI'
} as Command;

interface MetricsChoice extends QuickPickItem {
    readonly mode: 'recent' | 'summary';
}

/** Show recent local tool calls or per-capability totals. */
@injectable()
export class NukeAiMetricsCommandContribution implements CommandContribution {
    constructor(
        @inject(NukeAiMetricsService) protected readonly metrics: NukeAiMetricsService,
        @inject(QuickPickService) protected readonly quickPick: QuickPickService,
        @inject(MessageService) protected readonly messages: MessageService
    ) {}

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeAiMetricsCommand, { execute: () => this.showMetrics() });
    }

    protected async showMetrics(): Promise<void> {
        const choice = await this.quickPick.show<MetricsChoice>(
            [
                {
                    label: 'Recent invocations',
                    description: `Last ${NUKE_AI_METRICS_RECENT_LIMIT} tool calls`,
                    mode: 'recent'
                },
                {
                    label: 'Counts by capability',
                    description: 'Total, succeeded, and failed calls',
                    mode: 'summary'
                }
            ],
            {
                title: 'Tool Metrics',
                placeholder: 'Choose a read-only view of the local tool metrics.'
            }
        );
        if (!choice) {
            return;
        }
        const entries = await this.metrics.readEntries();
        if (entries.length === 0) {
            await this.messages.info('No tool metrics have been recorded yet.');
            return;
        }
        if (choice.mode === 'summary') {
            const summaries = summarizeMetrics(entries);
            const items = summaries.map((summary) => ({
                label: summary.capabilityId,
                description: `${summary.count} call${summary.count === 1 ? '' : 's'} · ${summary.failed} failed`,
                detail: `Average ${summary.averageDurationMs} ms · last ${summary.lastTimestamp}`
            }));
            await this.quickPick.show(items, {
                title: 'Tool Metrics by Capability (read-only)',
                placeholder: 'Read-only totals; nothing is invoked.'
            });
            return;
        }
        const recent = entries.slice(-NUKE_AI_METRICS_RECENT_LIMIT).reverse();
        const items = recent.map((entry) => ({
            label: entry.capabilityId,
            description: `${entry.ok ? 'ok' : 'failed'} · ${entry.durationMs} ms`,
            detail: `${entry.timestamp} · v${entry.version} · ${entry.risk}`
        }));
        await this.quickPick.show(items, {
            title: 'Recent Tool Metrics (read-only)',
            placeholder: 'Newest first; nothing is invoked.'
        });
    }
}
