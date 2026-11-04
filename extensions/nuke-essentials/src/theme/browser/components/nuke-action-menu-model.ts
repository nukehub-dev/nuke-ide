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
 * Pure model for the shared action menu.
 *
 * Kept free of React, Theia, and domain imports so menu state, keyboard
 * movement, descriptor mapping, and the missing-command filter stay unit
 * testable in the Node vitest environment.
 */

/** One row rendered by the action menu. */
export interface NukeActionDescriptor {
    /** Stable identifier passed back to the host's execute callback. */
    readonly id: string;
    /** User-facing row label. */
    readonly label: string;
    /** Optional second line explaining what the action does. */
    readonly description?: string;
}

/** Minimal structural shape of a command-backed host action. */
export interface NukeCommandActionLike {
    readonly commandId: string;
    readonly label: string;
    readonly description?: string;
}

/** Map host actions to neutral menu descriptors without dropping any. */
export function toNukeActionDescriptors(actions: readonly NukeCommandActionLike[]): NukeActionDescriptor[] {
    return actions.map((action) => ({ id: action.commandId, label: action.label, description: action.description }));
}

/**
 * Map host actions and drop rows whose Theia command is not installed. The
 * shared component never imports nuke-ai: hosts supply the command lookup so
 * an exclusion build renders no menu at all.
 */
export function availableNukeActionDescriptors(
    actions: readonly NukeCommandActionLike[],
    hasCommand: (commandId: string) => boolean
): NukeActionDescriptor[] {
    return toNukeActionDescriptors(actions.filter((action) => hasCommand(action.commandId)));
}

/** Menu visibility and the currently focused item. */
export interface NukeActionMenuState {
    readonly open: boolean;
    /** Index into the descriptor array; -1 when closed. */
    readonly activeIndex: number;
}

/** Where focus belongs after a menu transition. */
export type NukeActionMenuFocus = 'none' | 'item' | 'trigger';

/** A menu transition plus its focus intent, applied by the React component. */
export interface NukeActionMenuTransition {
    readonly state: NukeActionMenuState;
    readonly focus: NukeActionMenuFocus;
}

export const CLOSED_NUKE_ACTION_MENU: NukeActionMenuState = { open: false, activeIndex: -1 };

/** Open the menu on the first or last item. */
export function openNukeActionMenu(actionCount: number, edge: 'first' | 'last' = 'first'): NukeActionMenuTransition {
    if (actionCount <= 0) {
        return { state: CLOSED_NUKE_ACTION_MENU, focus: 'none' };
    }
    return { state: { open: true, activeIndex: edge === 'last' ? actionCount - 1 : 0 }, focus: 'item' };
}

/** Close the menu and return focus to the trigger. */
export function closeNukeActionMenu(): NukeActionMenuTransition {
    return { state: CLOSED_NUKE_ACTION_MENU, focus: 'trigger' };
}

/** Move focus by one row, wrapping at either end. */
export function moveNukeActionMenuFocus(state: NukeActionMenuState, delta: number, actionCount: number): NukeActionMenuTransition {
    if (!state.open || actionCount <= 0) {
        return { state: CLOSED_NUKE_ACTION_MENU, focus: 'none' };
    }
    const current = state.activeIndex >= 0 ? state.activeIndex : 0;
    const next = (((current + delta) % actionCount) + actionCount) % actionCount;
    return { state: { open: true, activeIndex: next }, focus: 'item' };
}

/** Jump to the first or last row. */
export function edgeNukeActionMenuFocus(state: NukeActionMenuState, edge: 'first' | 'last', actionCount: number): NukeActionMenuTransition {
    if (!state.open || actionCount <= 0) {
        return { state: CLOSED_NUKE_ACTION_MENU, focus: 'none' };
    }
    return { state: { open: true, activeIndex: edge === 'last' ? actionCount - 1 : 0 }, focus: 'item' };
}

/** Resolve the descriptor selected at an index. */
export function selectNukeAction<T extends NukeActionDescriptor>(actions: readonly T[], index: number): T | undefined {
    return index >= 0 && index < actions.length ? actions[index] : undefined;
}

/** Keyboard keys the menu owns while it is open. */
export type NukeActionMenuKey = 'Escape' | 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Translate a menu key into a state transition. Returns undefined for keys the
 * menu does not own (Tab/Enter/Space stay native). Closing always asks the
 * component to return focus to the trigger.
 */
export function handleNukeActionMenuKey(
    state: NukeActionMenuState,
    key: string,
    actionCount: number
): NukeActionMenuTransition | undefined {
    if (!state.open) {
        return undefined;
    }
    switch (key as NukeActionMenuKey) {
        case 'Escape':
            return closeNukeActionMenu();
        case 'ArrowDown':
            return moveNukeActionMenuFocus(state, 1, actionCount);
        case 'ArrowUp':
            return moveNukeActionMenuFocus(state, -1, actionCount);
        case 'Home':
            return edgeNukeActionMenuFocus(state, 'first', actionCount);
        case 'End':
            return edgeNukeActionMenuFocus(state, 'last', actionCount);
        default:
            return undefined;
    }
}
