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

import { describe, expect, it } from 'vitest';
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NukeActionMenu } from './nuke-action-menu';
import {
    CLOSED_NUKE_ACTION_MENU,
    availableNukeActionDescriptors,
    closeNukeActionMenu,
    edgeNukeActionMenuFocus,
    handleNukeActionMenuKey,
    moveNukeActionMenuFocus,
    openNukeActionMenu,
    selectNukeAction,
    toNukeActionDescriptors,
    type NukeActionDescriptor
} from './nuke-action-menu-model';

const SOURCE_ACTIONS = [
    { commandId: 'nuke.ai.ask', label: 'Ask About Context', description: 'Ask with the active context.' },
    { commandId: 'nuke.ai.diagnose', label: 'Diagnose Model', description: 'Read-only diagnosis.' },
    { commandId: 'nuke.ai.explain', label: 'Explain Statepoint' }
];

describe('shared action descriptors', () => {
    it('maps host actions to neutral descriptors in registry order', () => {
        expect(toNukeActionDescriptors(SOURCE_ACTIONS)).toEqual([
            { id: 'nuke.ai.ask', label: 'Ask About Context', description: 'Ask with the active context.' },
            { id: 'nuke.ai.diagnose', label: 'Diagnose Model', description: 'Read-only diagnosis.' },
            { id: 'nuke.ai.explain', label: 'Explain Statepoint', description: undefined }
        ]);
    });

    it('drops actions whose Theia command is missing', () => {
        const descriptors = availableNukeActionDescriptors(SOURCE_ACTIONS, (id) => id !== 'nuke.ai.diagnose');
        expect(descriptors.map((action) => action.id)).toEqual(['nuke.ai.ask', 'nuke.ai.explain']);
    });

    it('renders no descriptors when every command is missing', () => {
        expect(availableNukeActionDescriptors(SOURCE_ACTIONS, () => false)).toEqual([]);
    });
});

describe('shared action menu model', () => {
    it('opens on the first item and focuses it', () => {
        expect(openNukeActionMenu(3)).toEqual({ state: { open: true, activeIndex: 0 }, focus: 'item' });
        expect(openNukeActionMenu(3, 'last')).toEqual({ state: { open: true, activeIndex: 2 }, focus: 'item' });
    });

    it('closes and returns focus to the trigger', () => {
        expect(closeNukeActionMenu()).toEqual({ state: CLOSED_NUKE_ACTION_MENU, focus: 'trigger' });
    });

    it('closes on Escape and returns focus to the trigger', () => {
        const open = openNukeActionMenu(3).state;
        expect(handleNukeActionMenuKey(open, 'Escape', 3)).toEqual({ state: CLOSED_NUKE_ACTION_MENU, focus: 'trigger' });
        expect(handleNukeActionMenuKey(open, 'Tab', 3)).toBeUndefined();
    });

    it('moves focus with wrapping and jumps to the edges', () => {
        const open = openNukeActionMenu(3).state;
        expect(moveNukeActionMenuFocus(open, 1, 3).state.activeIndex).toBe(1);
        expect(moveNukeActionMenuFocus({ open: true, activeIndex: 2 }, 1, 3).state.activeIndex).toBe(0);
        expect(moveNukeActionMenuFocus(open, -1, 3).state.activeIndex).toBe(2);
        expect(edgeNukeActionMenuFocus(open, 'last', 3).state.activeIndex).toBe(2);
        expect(edgeNukeActionMenuFocus(open, 'first', 3).state.activeIndex).toBe(0);
        expect(handleNukeActionMenuKey(open, 'ArrowDown', 3)?.state.activeIndex).toBe(1);
        expect(handleNukeActionMenuKey(open, 'End', 3)?.state.activeIndex).toBe(2);
    });

    it('resolves the descriptor selected at an index', () => {
        const actions: NukeActionDescriptor[] = toNukeActionDescriptors(SOURCE_ACTIONS);
        expect(selectNukeAction(actions, 1)?.id).toBe('nuke.ai.diagnose');
        expect(selectNukeAction(actions, 3)).toBeUndefined();
    });
});

describe('NukeActionMenu', () => {
    it('renders nothing when no action survives command filtering', () => {
        const html = renderToStaticMarkup(<NukeActionMenu actions={[]} onExecute={() => undefined} />);
        expect(html).toBe('');
    });

    it('exposes an accessible trigger name and no native title', () => {
        const html = renderToStaticMarkup(
            <NukeActionMenu actions={toNukeActionDescriptors(SOURCE_ACTIONS)} onExecute={() => undefined} label="NukeAI actions" />
        );
        expect(html).toContain('aria-label="NukeAI actions"');
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain('nuke-action-menu-label');
        expect(html).not.toContain('title=');
    });

    it('uses the host icon class on the trigger', () => {
        const html = renderToStaticMarkup(
            <NukeActionMenu
                actions={toNukeActionDescriptors(SOURCE_ACTIONS)}
                onExecute={() => undefined}
                label="NukeAI actions"
                iconClass="codicon-hubot"
            />
        );
        expect(html).toContain('codicon-hubot');
        expect(html).not.toContain('codicon-ellipsis');
    });

    it('can render an icon-only trigger while keeping the accessible name', () => {
        const html = renderToStaticMarkup(
            <NukeActionMenu
                actions={toNukeActionDescriptors(SOURCE_ACTIONS)}
                onExecute={() => undefined}
                label="NukeAI actions"
                iconClass="codicon-hubot"
                showLabel={false}
            />
        );
        expect(html).toContain('aria-label="NukeAI actions"');
        expect(html).toContain('nuke-action-menu-trigger-icon-only');
        expect(html).toContain('codicon-hubot');
        expect(html).not.toContain('nuke-action-menu-label');
    });
});
