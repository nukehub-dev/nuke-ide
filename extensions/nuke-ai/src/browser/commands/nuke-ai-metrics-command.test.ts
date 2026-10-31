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
import { Command, CommandHandler, CommandRegistry } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import type { QuickPickItem, QuickPickService } from '@theia/core/lib/browser/quick-input';
import { NukeAiMetricEntry, NukeAiMetricsService } from '../capabilities/nuke-ai-metrics-service';
import { NukeAiMetricsCommand, NukeAiMetricsCommandContribution } from './nuke-ai-metrics-command';

vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickPickService: Symbol('QuickPickService') }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: Symbol('FileService') }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: Symbol('WorkspaceService') }));

function entry(index: number, overrides: Partial<NukeAiMetricEntry> = {}): NukeAiMetricEntry {
    return {
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        capabilityId: 'nuke.example.describe',
        version: 2,
        risk: 'read',
        ok: true,
        durationMs: index,
        ...overrides
    };
}

class TestableMetricsCommand extends NukeAiMetricsCommandContribution {
    showNow(): Promise<void> {
        return this.showMetrics();
    }
}

interface Harness {
    readonly command: TestableMetricsCommand;
    readonly quickPick: { show: ReturnType<typeof vi.fn> };
    readonly messages: { info: ReturnType<typeof vi.fn> };
}

function setup(entries: NukeAiMetricEntry[]): Harness {
    const metrics = {
        readEntries: vi.fn(async () => entries)
    } as unknown as NukeAiMetricsService;
    const quickPick = { show: vi.fn(async () => undefined) };
    const messages = { info: vi.fn(async () => undefined) };
    const command = new TestableMetricsCommand(metrics, quickPick as unknown as QuickPickService, messages as unknown as MessageService);
    return { command, quickPick, messages };
}

function itemsOf(call: unknown[]): QuickPickItem[] {
    return call[0] as QuickPickItem[];
}

describe('NukeAiMetricsCommand', () => {
    it('registers the read-only metrics command in the NukeAI category', () => {
        const { command } = setup([]);
        const handlers = new Map<string, CommandHandler>();
        const registry = {
            registerCommand: (candidate: Command, handler?: CommandHandler): Disposable => {
                if (handler) {
                    handlers.set(candidate.id, handler);
                }
                return Disposable.NULL;
            }
        } as unknown as CommandRegistry;

        command.registerCommands(registry);

        expect(NukeAiMetricsCommand).toMatchObject({
            id: 'nuke.ai.showToolMetrics',
            label: 'NukeAI: Show Tool Metrics',
            category: 'NukeAI'
        });
        expect(handlers.has(NukeAiMetricsCommand.id)).toBe(true);
    });

    it('shows the newest 20 invocations first', async () => {
        const entries = Array.from({ length: 25 }, (_, index) => entry(index));
        const harness = setup(entries);
        harness.quickPick.show.mockResolvedValueOnce({ mode: 'recent' }).mockResolvedValueOnce(undefined);

        await harness.command.showNow();

        const items = itemsOf(harness.quickPick.show.mock.calls[1] as unknown[]);
        expect(items).toHaveLength(20);
        expect(items[0].label).toBe('nuke.example.describe');
        expect(items[0].description).toBe('ok · 24 ms');
        expect(items[0].detail).toContain('2026-01-01T00:00:24.000Z');
        expect(items[0].detail).toContain('v2');
        expect(items[0].detail).toContain('read');
        expect(items[19].detail).toContain('2026-01-01T00:00:05.000Z');
    });

    it('shows aggregate counts by capability', async () => {
        const harness = setup([
            entry(1),
            entry(2, { capabilityId: 'nuke.example.write', risk: 'write', version: 3, ok: false, durationMs: 8 }),
            entry(3, { capabilityId: 'nuke.example.write', risk: 'write', version: 3, ok: false, durationMs: 12 })
        ]);
        harness.quickPick.show.mockResolvedValueOnce({ mode: 'summary' }).mockResolvedValueOnce(undefined);

        await harness.command.showNow();

        const items = itemsOf(harness.quickPick.show.mock.calls[1] as unknown[]);
        expect(items.map((item) => item.label)).toEqual(['nuke.example.write', 'nuke.example.describe']);
        expect(items[0].description).toBe('2 calls · 2 failed');
        expect(items[0].detail).toContain('Average 10 ms');
        expect(items[1].description).toBe('1 call · 0 failed');
    });

    it('reports an empty journal instead of opening an empty view', async () => {
        const harness = setup([]);
        harness.quickPick.show.mockResolvedValueOnce({ mode: 'recent' });

        await harness.command.showNow();

        expect(harness.quickPick.show).toHaveBeenCalledTimes(1);
        expect(harness.messages.info).toHaveBeenCalledWith('No tool metrics have been recorded yet.');
    });

    it('does nothing after a cancelled choice', async () => {
        const harness = setup([entry(1)]);
        harness.quickPick.show.mockResolvedValueOnce(undefined);

        await harness.command.showNow();

        expect(harness.quickPick.show).toHaveBeenCalledTimes(1);
        expect(harness.messages.info).not.toHaveBeenCalled();
    });
});
