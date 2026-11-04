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
import { NukeToolsItem, NukeToolsRegistry } from 'nuke-core/lib/common/nuke-tools-protocol';
import { NukeMcpCommands } from '../mcp/nuke-mcp-commands';
import { NukeAiCommands } from './nuke-ai-commands';
import { NukeAiToolsContribution } from './nuke-ai-tools-contribution';

// The MCP command module only needs its DI tokens in a Node test; the real
// browser implementations pull in Lumino DOM code that is irrelevant here.
vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickInputService: Symbol('QuickInputService') }));
vi.mock('@theia/core/lib/browser/clipboard-service', () => ({ ClipboardService: Symbol('ClipboardService') }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: Symbol('FileService') }));

class FakeToolsRegistry implements NukeToolsRegistry {
    readonly items: NukeToolsItem[] = [];

    registerItem(item: NukeToolsItem): void {
        this.items.push(item);
    }
}

function registeredItems(): NukeToolsItem[] {
    const registry = new FakeToolsRegistry();
    new NukeAiToolsContribution().registerTools(registry);
    return registry.items;
}

describe('NukeAiToolsContribution', () => {
    it('registers eight contextual actions, one run action, six diagnostics actions, and two external MCP controls', () => {
        const items = registeredItems();

        expect(items).toHaveLength(17);
        expect(items.filter((item) => item.category.length === 1)).toHaveLength(8);
        expect(items.filter((item) => item.category.join('/') === 'NukeAI/Run')).toHaveLength(1);
        expect(items.filter((item) => item.category.join('/') === 'NukeAI/Diagnostics')).toHaveLength(6);
        expect(items.filter((item) => item.category.join('/') === 'NukeAI/External MCP')).toHaveLength(2);
    });

    it('uses unique ids, the NukeAI section first, and command ids that exist', () => {
        const items = registeredItems();
        const ids = items.map((item) => item.id);

        expect(new Set(ids).size).toBe(ids.length);
        for (const item of items) {
            expect(item.sectionOrder).toBe('0');
            expect(item.categoryOrder).toBe('a');
            expect(item.category[0]).toBe('NukeAI');
            expect(item.description?.trim().length).toBeGreaterThan(0);
            expect(item.keywords?.length).toBeGreaterThan(0);
        }
    });

    it('maps the eight actions to their NukeAI commands and codicons', () => {
        const items = registeredItems().filter((item) => item.category.length === 1);

        expect(items.map((item) => item.commandId)).toEqual([
            NukeAiCommands.ASK.id,
            NukeAiCommands.ATTACH_CONTEXT.id,
            NukeAiCommands.CHECK_CAD.id,
            NukeAiCommands.EXPLAIN_SELECTION.id,
            NukeAiCommands.VALIDATE_OPENMC.id,
            NukeAiCommands.EXPLAIN_RUN.id,
            NukeAiCommands.EXPLAIN_STATEPOINT.id,
            NukeAiCommands.CAPTURE_VIEW.id
        ]);
        expect(items.map((item) => item.icon)).toEqual([
            'comment-discussion',
            'link',
            'beaker',
            'selection',
            'checklist',
            'debug-alt',
            'graph',
            'device-camera'
        ]);
    });

    it('maps the run refresh action to its command and subgroup', () => {
        const items = registeredItems().filter((item) => item.category.join('/') === 'NukeAI/Run');

        expect(items.map((item) => item.commandId)).toEqual([NukeAiCommands.REFRESH_RUN.id]);
        expect(items.map((item) => item.label)).toEqual(['Refresh Active Run Status']);
        expect(items.map((item) => item.icon)).toEqual(['refresh']);
    });

    it('maps the six diagnostics actions to their NukeAI commands and codicons', () => {
        const items = registeredItems().filter((item) => item.category.join('/') === 'NukeAI/Diagnostics');

        expect(items.map((item) => item.commandId)).toEqual([
            NukeAiCommands.DIAGNOSE_CAD.id,
            NukeAiCommands.DIAGNOSE_OPENMC.id,
            NukeAiCommands.DIAGNOSE_CSG.id,
            NukeAiCommands.DIAGNOSE_DAGMC.id,
            NukeAiCommands.DIAGNOSE_RUN.id,
            NukeAiCommands.DIAGNOSE_STATEPOINT.id
        ]);
        expect(items.map((item) => item.icon)).toEqual(['checklist', 'checklist', 'symbol-structure', 'layers', 'debug-alt', 'graph']);
        expect(items.map((item) => item.order)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(items.map((item) => item.label)).toEqual([
            'Diagnose Active CAD Model',
            'Diagnose OpenMC Project',
            'Diagnose CSG Geometry',
            'Diagnose DAGMC Model',
            'Diagnose OpenMC Run',
            'Diagnose Active Statepoint'
        ]);
    });

    it('maps the external MCP entries to the enable and disable commands', () => {
        const items = registeredItems().filter((item) => item.category.join('/') === 'NukeAI/External MCP');

        expect(items.map((item) => item.commandId)).toEqual([NukeMcpCommands.ENABLE.id, NukeMcpCommands.DISABLE.id]);
        expect(items.map((item) => item.icon)).toEqual(['plug', 'debug-disconnect']);
    });
});
