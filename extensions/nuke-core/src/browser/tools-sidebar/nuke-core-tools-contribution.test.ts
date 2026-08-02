// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { describe, it, expect } from 'vitest';
import { NukeToolsItem, NukeToolsRegistry } from '../../common/nuke-tools-protocol';
import { NukeCoreCommands } from '../commands/nuke-core-commands';
import { NukeCoreToolsContribution } from './nuke-core-tools-contribution';

describe('NukeCoreToolsContribution', () => {
    it('registers all core tool categories', () => {
        const items: NukeToolsItem[] = [];
        const registry: NukeToolsRegistry = {
            registerItem: (item) => items.push(item)
        };

        new NukeCoreToolsContribution().registerTools(registry);

        const categories = new Set(items.map((i) => i.category[0]));
        expect(categories).toContain('Environment');
        expect(categories).toContain('Packages');
        expect(categories).toContain('Health & Diagnostics');
        expect(items).toHaveLength(8);
    });

    it('uses existing NukeCore command ids', () => {
        const items: NukeToolsItem[] = [];
        const registry: NukeToolsRegistry = {
            registerItem: (item) => items.push(item)
        };

        new NukeCoreToolsContribution().registerTools(registry);

        expect(items.some((i) => i.commandId === NukeCoreCommands.SWITCH_ENVIRONMENT.id)).toBe(true);
        expect(items.some((i) => i.commandId === NukeCoreCommands.HEALTH_CHECK.id)).toBe(true);
        expect(items.some((i) => i.commandId === NukeCoreCommands.INSTALL_PACKAGE.id)).toBe(true);
    });
});
