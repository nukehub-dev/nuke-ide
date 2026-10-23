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

/**
 * CAD command search popover, anchored under the document toolbar.
 *
 * Filters the shared CAD command registry (including the menu-only tails) and
 * runs the chosen action on Enter/click. Disabled rows stay listed, state why
 * they cannot run, and are inert. Escape and Tab close the popover and consume
 * the key so the viewport/Theia handlers do not also react. The popover is
 * absolutely positioned inside the toolbar's containing block — never
 * portaled — so it stays glued under the bar.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import * as React from '@theia/core/shared/react';
import { NukeSearchInput } from 'nuke-essentials/lib/theme/browser/components';
import { filterCadCommandActions, type CadCommandSearchAction } from './cad-command-search-model';

export interface CadCommandSearchProps {
    readonly open: boolean;
    readonly actions: readonly CadCommandSearchAction[];
    readonly onClose: () => void;
}

/** Marks the toolbar trigger so the outside-pointerdown closer ignores it (its click toggles). */
export const CAD_COMMAND_SEARCH_TRIGGER_ATTRIBUTE = 'data-cad-command-search-trigger';

export function CadCommandSearch(props: CadCommandSearchProps): React.ReactElement | null {
    const [query, setQuery] = React.useState('');
    const [activeIndex, setActiveIndex] = React.useState(0);
    const rootRef = React.useRef<HTMLDivElement>(null);

    const matches = React.useMemo(() => filterCadCommandActions(props.actions, query), [props.actions, query]);
    // Queries can shrink the list under a stale index; clamp instead of
    // resetting on every filter pass so arrow navigation stays predictable.
    const active = matches.length === 0 ? undefined : matches[Math.min(activeIndex, matches.length - 1)];

    const runAction = React.useCallback(
        (action: CadCommandSearchAction | undefined): void => {
            if (action === undefined || action.disabled === true) {
                return;
            }
            // Close first: the action may open a feature dialog that owns focus
            // and Escape from here on.
            props.onClose();
            action.onClick();
        },
        [props.onClose]
    );

    // Every open starts a fresh query and puts the caret in the search field.
    React.useEffect(() => {
        if (!props.open) {
            return;
        }
        setQuery('');
        setActiveIndex(0);
        rootRef.current?.querySelector<HTMLInputElement>('.nuke-search-input-field')?.focus();
    }, [props.open]);

    // Window CAPTURE phase: claim navigation/Enter/Escape/Tab before the
    // viewport's capture handler and Theia's keybinding registry see them.
    React.useEffect(() => {
        if (!props.open) {
            return undefined;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
                return;
            }
            if (event.key === 'Tab') {
                event.stopPropagation();
                props.onClose();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (matches.length === 0) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                setActiveIndex((current) => {
                    const base = Math.min(current, matches.length - 1);
                    return (base + delta + matches.length) % matches.length;
                });
                return;
            }
            if (event.key === 'Enter') {
                // The search owns Enter even on a disabled/no-match selection:
                // never let it fall through to a default button or Theia.
                event.preventDefault();
                event.stopPropagation();
                if (active === undefined || active.disabled === true) {
                    return;
                }
                runAction(active);
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [props.open, props.onClose, matches, active, runAction]);

    // Pointerdown outside the card closes it; the toolbar trigger is excluded
    // because its own click toggles (closing on pointerdown first would make the
    // following click reopen it).
    React.useEffect(() => {
        if (!props.open) {
            return undefined;
        }
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Node && rootRef.current?.contains(target) === true) {
                return;
            }
            if (target instanceof Element && target.closest(`[${CAD_COMMAND_SEARCH_TRIGGER_ATTRIBUTE}]`) !== null) {
                return;
            }
            props.onClose();
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [props.open, props.onClose]);

    if (!props.open) {
        return null;
    }

    return (
        <div ref={rootRef} className="cad-command-search-popover" role="dialog" aria-label="Search CAD commands">
            <NukeSearchInput
                value={query}
                onChange={(value) => {
                    setQuery(value);
                    setActiveIndex(0);
                }}
                placeholder="Search CAD commands…"
                ariaLabel="Search CAD commands"
                className="cad-command-search-input"
            />
            <div className="cad-command-search-results" role="listbox" aria-label="CAD commands">
                {matches.length === 0 ? (
                    <div className="cad-command-search-empty">No matching commands</div>
                ) : (
                    matches.map((action, index) => (
                        <button
                            key={action.id}
                            type="button"
                            role="option"
                            aria-selected={action === active}
                            className={`cad-command-search-item${action === active ? ' active' : ''}`}
                            disabled={action.disabled === true}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => runAction(action)}
                        >
                            <span className={`codicon ${action.icon} cad-command-search-icon`} />
                            <span className="cad-command-search-text">
                                <span className="cad-command-search-label">{action.label}</span>
                                {action.disabled === true && action.disabledReason !== undefined && (
                                    <span className="cad-command-search-reason">{action.disabledReason}</span>
                                )}
                            </span>
                            <span className="cad-command-search-group">{action.group}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
