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

import * as React from '@theia/core/shared/react';
import { Tooltip } from './tooltip';
import {
    CLOSED_NUKE_ACTION_MENU,
    closeNukeActionMenu,
    handleNukeActionMenuKey,
    openNukeActionMenu,
    selectNukeAction,
    type NukeActionDescriptor,
    type NukeActionMenuState
} from './nuke-action-menu-model';

export type { NukeActionDescriptor } from './nuke-action-menu-model';

export interface NukeActionMenuProps {
    /** Command-backed rows in registry order. */
    readonly actions: readonly NukeActionDescriptor[];
    /** Invoked with the selected descriptor; hosts route it to their command registry. */
    readonly onExecute: (action: NukeActionDescriptor) => void;
    /** Trigger text; also the accessible name and tooltip. Defaults to `Actions`. */
    readonly label?: string;
    /** Extra class on the root (spacing for the host toolbar). */
    readonly className?: string;
    /** Menu alignment relative to the trigger; defaults to `end`. */
    readonly align?: 'start' | 'end';
}

/**
 * Compact presentational action menu for host toolbars.
 *
 * The component knows nothing about NukeAI, capabilities, or any domain. Hosts
 * map their own descriptors and execute callback. Keyboard contract: Enter or
 * Space opens the menu (native button behaviour), ArrowDown/ArrowUp open and
 * move between items (wrapping), Home/End jump, Escape closes, outside clicks
 * close, and every close returns focus to the trigger. The trigger collapses
 * to its icon under a narrow container query while keeping the accessible
 * name and shared Tooltip. With no actions it renders nothing, so exclusion
 * builds never show an empty control.
 */
export const NukeActionMenu: React.FC<NukeActionMenuProps> = ({ actions, onExecute, label = 'Actions', className, align = 'end' }) => {
    const [state, setState] = React.useState<NukeActionMenuState>(CLOSED_NUKE_ACTION_MENU);
    const rootRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = React.useId();

    const actionKey = actions.map((action) => action.id).join('\u0000');
    React.useEffect(() => {
        setState(CLOSED_NUKE_ACTION_MENU);
    }, [actionKey]);

    React.useEffect(() => {
        if (!state.open || state.activeIndex < 0) {
            return;
        }
        itemRefs.current[state.activeIndex]?.focus();
    }, [state.open, state.activeIndex]);

    const close = React.useCallback(() => {
        const transition = closeNukeActionMenu();
        setState(transition.state);
        if (transition.focus === 'trigger') {
            triggerRef.current?.focus();
        }
    }, []);

    React.useEffect(() => {
        if (!state.open) {
            return undefined;
        }
        const onPointerDown = (event: MouseEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) {
                close();
            }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        return () => document.removeEventListener('mousedown', onPointerDown, true);
    }, [state.open, close]);

    if (actions.length === 0) {
        return null;
    }

    const open = (edge: 'first' | 'last' = 'first'): void => {
        setState(openNukeActionMenu(actions.length, edge).state);
    };

    const toggle = (): void => {
        if (state.open) {
            close();
        } else {
            open();
        }
    };

    const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open(event.key === 'ArrowUp' ? 'last' : 'first');
        }
    };

    const onRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        const transition = handleNukeActionMenuKey(state, event.key, actions.length);
        if (transition === undefined) {
            return;
        }
        event.preventDefault();
        if (event.key === 'Escape') {
            event.stopPropagation();
        }
        setState(transition.state);
        if (transition.focus === 'trigger') {
            triggerRef.current?.focus();
        }
    };

    const execute = (index: number): void => {
        const action = selectNukeAction(actions, index);
        if (action === undefined) {
            return;
        }
        close();
        onExecute(action);
    };

    return (
        <div ref={rootRef} className={`nuke-action-menu${className !== undefined ? ` ${className}` : ''}`} onKeyDown={onRootKeyDown}>
            <Tooltip content={label} position="bottom">
                <button
                    ref={triggerRef}
                    type="button"
                    className="theia-button secondary nuke-action-menu-trigger"
                    aria-label={label}
                    aria-haspopup="menu"
                    aria-expanded={state.open}
                    aria-controls={state.open ? menuId : undefined}
                    onClick={toggle}
                    onKeyDown={onTriggerKeyDown}
                >
                    <span className="codicon codicon-ellipsis nuke-action-menu-icon" aria-hidden="true" />
                    <span className="nuke-action-menu-label">{label}</span>
                </button>
            </Tooltip>
            {state.open && (
                <div id={menuId} className={`nuke-action-menu-popup nuke-action-menu-popup-${align}`} role="menu" aria-label={label}>
                    {actions.map((action, index) => (
                        <button
                            key={action.id}
                            ref={(element) => {
                                itemRefs.current[index] = element;
                            }}
                            type="button"
                            className="nuke-action-menu-item"
                            role="menuitem"
                            tabIndex={-1}
                            onFocus={() => setState((previous) => ({ ...previous, activeIndex: index }))}
                            onClick={() => execute(index)}
                        >
                            <span className="nuke-action-menu-item-label">{action.label}</span>
                            {action.description !== undefined && (
                                <span className="nuke-action-menu-item-description">{action.description}</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
