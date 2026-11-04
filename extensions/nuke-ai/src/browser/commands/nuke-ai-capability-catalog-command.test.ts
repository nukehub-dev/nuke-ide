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
import type { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import type { QuickPickItem, QuickPickService } from '@theia/core/lib/browser/quick-input';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeAiCapabilityCatalogCommand, NukeAiCapabilityCatalogCommandContribution } from './nuke-ai-capability-catalog-command';

vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickPickService: Symbol('QuickPickService') }));
vi.mock('@theia/core/lib/browser/clipboard-service', () => ({ ClipboardService: Symbol('ClipboardService') }));

function capability(overrides: Partial<NukeCapability> = {}): NukeCapability {
    return {
        id: 'nuke.example.enabled',
        title: 'Enabled capability',
        description: 'Describe the current state.',
        category: ['Example', 'Project'],
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
        version: 2,
        tags: ['settings'],
        invoke: vi.fn(async () => ({ ok: true })),
        ...overrides
    };
}

class TestableCatalogCommand extends NukeAiCapabilityCatalogCommandContribution {
    showNow(): Promise<void> {
        return this.showCatalog();
    }
}

interface Harness {
    readonly command: TestableCatalogCommand;
    readonly quickPick: { show: ReturnType<typeof vi.fn> };
    readonly clipboard: { writeText: ReturnType<typeof vi.fn> };
    readonly messages: { info: ReturnType<typeof vi.fn> };
    readonly invoke: ReturnType<typeof vi.fn>;
}

function setup(capabilities: NukeCapability[]): Harness {
    const context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };
    const registry = {
        ready: Promise.resolve(),
        getEnabled: vi.fn(() => capabilities.filter((candidate) => !candidate.when || candidate.when(context)))
    } as unknown as NukeCapabilityRegistry;
    const contextService = {
        getContext: vi.fn(async () => context),
        onDidChangeContext: vi.fn()
    } as unknown as NukeCapabilityContextService;
    const quickPick = { show: vi.fn(async () => undefined) };
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const messages = { info: vi.fn(async () => undefined) };
    const command = new TestableCatalogCommand(
        registry,
        contextService,
        quickPick as unknown as QuickPickService,
        clipboard as unknown as ClipboardService,
        messages as unknown as MessageService
    );
    const invoke = capabilities[0]?.invoke as unknown as ReturnType<typeof vi.fn>;
    return { command, quickPick, clipboard, messages, invoke };
}

function itemsOf(call: unknown[]): QuickPickItem[] {
    return call[0] as QuickPickItem[];
}

describe('NukeAiCapabilityCatalogCommand', () => {
    it('registers the read-only catalog command in the NukeAI category', () => {
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

        expect(NukeAiCapabilityCatalogCommand).toMatchObject({
            id: 'nuke.ai.showCapabilityCatalog',
            label: 'NukeAI: Show Capability Catalog',
            category: 'NukeAI'
        });
        expect(handlers.has(NukeAiCapabilityCatalogCommand.id)).toBe(true);
    });

    it('lists enabled capabilities and omits disabled ones', async () => {
        const disabled = capability({ id: 'nuke.example.disabled', title: 'Disabled capability', when: () => false });
        const harness = setup([capability(), disabled]);

        await harness.command.showNow();

        const items = itemsOf(harness.quickPick.show.mock.calls[0] as unknown[]);
        expect(items.map((item) => item.label)).toEqual(['nuke.example.enabled']);
        expect(items[0].description).toBe('v2 · read · Enabled capability');
        expect(items[0].detail).toContain('Example / Project');
        expect(items[0].detail).toContain('Tags: settings');
        expect(items[0].detail).toContain('Available');
        expect(harness.invoke).not.toHaveBeenCalled();
    });

    it('copies the selected id and shows a read-only detail view without invoking', async () => {
        const harness = setup([capability()]);
        harness.quickPick.show
            .mockResolvedValueOnce({ id: 'nuke.example.enabled', label: 'nuke.example.enabled' })
            .mockResolvedValueOnce(undefined);

        await harness.command.showNow();

        expect(harness.clipboard.writeText).toHaveBeenCalledWith('nuke.example.enabled');
        expect(harness.quickPick.show).toHaveBeenCalledTimes(2);
        const details = itemsOf(harness.quickPick.show.mock.calls[1] as unknown[]);
        expect(details).toHaveLength(1);
        expect(details[0].label).toBe('nuke.example.enabled');
        expect(details[0].detail).toContain('Id: nuke.example.enabled');
        expect(details[0].detail).toContain('Title: Enabled capability');
        expect(details[0].detail).toContain('Version: 2');
        expect(details[0].detail).toContain('Risk: read');
        expect(details[0].detail).toContain('Tags: settings');
        expect(details[0].detail).toContain('Availability: available in the current context');
        expect(harness.invoke).not.toHaveBeenCalled();
    });

    it('does nothing after a cancelled selection', async () => {
        const harness = setup([capability()]);
        harness.quickPick.show.mockResolvedValueOnce(undefined);

        await harness.command.showNow();

        expect(harness.clipboard.writeText).not.toHaveBeenCalled();
        expect(harness.quickPick.show).toHaveBeenCalledTimes(1);
    });

    it('reports an empty catalog instead of opening an empty picker', async () => {
        const harness = setup([]);

        await harness.command.showNow();

        expect(harness.quickPick.show).not.toHaveBeenCalled();
        expect(harness.messages.info).toHaveBeenCalledWith('No capability tools are available in the current context.');
    });
});
