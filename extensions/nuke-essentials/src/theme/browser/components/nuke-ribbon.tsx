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
 * Shared ribbon toolbar: one non-wrapping row of labelled action sections.
 *
 * Every section keeps `role="group"` + `aria-label`, shows a visible caption
 * under its buttons, and opens a portal menu for the actions that do not fit
 * inline. The host owns the action table and the measured density; the pure
 * promotion/density model lives in `nuke-ribbon-model.ts`.
 *
 * The legacy `NukeToolbar`/`NukeToolbarGroup` remain untouched for consumers
 * that still want the wrapping group layout.
 */

import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import { splitRibbonItems, type NukeRibbonDensity } from './nuke-ribbon-model';
import { Tooltip } from './tooltip';

export type { NukeRibbonDensity } from './nuke-ribbon-model';

/** One ribbon action: a promoted button and/or a menu entry. */
export interface NukeRibbonItem {
    id: string;
    /** Tooltip and menu text. */
    label: string;
    /** Tile caption in `tiles` density; falls back to `label`. */
    shortLabel?: string;
    /** Codicon class list, e.g. `codicon codicon-nuke-cad-pad`. */
    icon: string;
    disabled?: boolean;
    /** Concise explanation shown in the disabled tooltip and menu second line. */
    disabledReason?: string;
    active?: boolean;
    onClick: () => void;
}

export interface NukeRibbonProps {
    /** Section density; default `tiles`. Sections may override it. */
    density?: NukeRibbonDensity;
    /** Extra class on the ribbon root. */
    className?: string;
    /** `NukeRibbonSection` children. */
    children: React.ReactNode;
}

export interface NukeRibbonSectionProps {
    /** Visible caption and `role="group"` accessible name. */
    label: string;
    /** All actions in the section, in render order. */
    items: readonly NukeRibbonItem[];
    /** Inline count in tiles/icons density; the rest live in the caret menu. */
    promoted: number;
    /** Override the ribbon's density for this section. */
    density?: NukeRibbonDensity;
    /** Extra class on the section. */
    className?: string;
}

const NukeRibbonDensityContext = React.createContext<NukeRibbonDensity>('tiles');

/** Menu gap below/above the trigger, in viewport pixels. */
const MENU_GAP = 4;
/** Window margin used when clamping the portal. */
const MENU_MARGIN = 8;
/** Fallback menu size before the portal has been measured. */
const MENU_ESTIMATED_WIDTH = 220;
const MENU_ESTIMATED_HEIGHT = 240;

interface RibbonMenuProps {
    readonly label: string;
    readonly items: readonly NukeRibbonItem[];
    readonly anchorRef: React.RefObject<HTMLButtonElement | null>;
    /** `restoreFocus` is false for pointer outside-clicks: the clicked target keeps focus. */
    readonly onClose: (restoreFocus: boolean) => void;
}

/**
 * Portal menu for a section's non-promoted actions. Positions before paint
 * (ColorPicker / NukeSelect precedent), re-measures once mounted, closes on
 * Escape/outside click, and supports Arrow/Home/End navigation.
 */
function RibbonMenu(props: RibbonMenuProps): React.ReactElement | null {
    const [coords, setCoords] = React.useState<{ x: number; y: number } | null>(null);
    const menuRef = React.useRef<HTMLDivElement>(null);
    const focusedRef = React.useRef(false);

    const placeMenu = React.useCallback(() => {
        const trigger = props.anchorRef.current;
        if (trigger === null) {
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const width = menuRef.current?.offsetWidth ?? MENU_ESTIMATED_WIDTH;
        const height = menuRef.current?.offsetHeight ?? MENU_ESTIMATED_HEIGHT;
        let x = rect.left;
        if (x + width > window.innerWidth - MENU_MARGIN) {
            x = rect.right - width;
        }
        x = Math.min(Math.max(x, MENU_MARGIN), Math.max(window.innerWidth - width - MENU_MARGIN, MENU_MARGIN));
        let y = rect.bottom + MENU_GAP;
        if (y + height > window.innerHeight - MENU_MARGIN) {
            y = rect.top - height - MENU_GAP;
        }
        y = Math.min(Math.max(y, MENU_MARGIN), Math.max(window.innerHeight - height - MENU_MARGIN, MENU_MARGIN));
        setCoords((previous) => (previous !== null && previous.x === x && previous.y === y ? previous : { x, y }));
    }, [props.anchorRef]);

    // Position before first paint; render only once coords exist so the menu
    // never flashes at the fallback corner.
    React.useLayoutEffect(() => {
        placeMenu();
    }, [placeMenu]);

    // Re-measure after the portal exists (real width/height instead of the
    // pre-mount estimate), then focus the first enabled item once.
    React.useLayoutEffect(() => {
        if (coords === null) {
            return;
        }
        placeMenu();
        if (!focusedRef.current) {
            focusedRef.current = true;
            menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }
    });

    React.useEffect(() => {
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (menuRef.current?.contains(target) === true || props.anchorRef.current?.contains(target) === true) {
                return;
            }
            props.onClose(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                // Capture phase: consume Escape while the menu owns focus so
                // the viewport/IDE does not also react to it.
                event.preventDefault();
                event.stopPropagation();
                props.onClose(true);
                return;
            }
            if (event.key === 'Tab') {
                props.onClose(false);
                return;
            }
            const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
            if (items === undefined || items.length === 0) {
                return;
            }
            const list = Array.from(items);
            const index = list.findIndex((item) => item === document.activeElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const next = index < 0 ? (delta === 1 ? 0 : list.length - 1) : (index + delta + list.length) % list.length;
                list[next].focus();
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                list[event.key === 'Home' ? 0 : list.length - 1].focus();
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('resize', placeMenu);
        window.addEventListener('scroll', placeMenu, true);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('resize', placeMenu);
            window.removeEventListener('scroll', placeMenu, true);
        };
    }, [placeMenu, props.anchorRef, props.onClose]);

    if (coords === null) {
        return null;
    }

    return ReactDOM.createPortal(
        <div
            ref={menuRef}
            className="nuke-ribbon-menu"
            role="menu"
            aria-label={`${props.label} actions`}
            style={{ position: 'fixed', left: coords.x, top: coords.y }}
        >
            {props.items.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className={`nuke-ribbon-menu-item${item.active === true ? ' nuke-ribbon-menu-item-active' : ''}`}
                    disabled={item.disabled === true}
                    aria-disabled={item.disabled === true}
                    onClick={() => {
                        if (item.disabled === true) {
                            return;
                        }
                        props.onClose(true);
                        item.onClick();
                    }}
                >
                    <span className={`codicon ${item.icon}`} />
                    <span className="nuke-ribbon-menu-item-text">
                        <span className="nuke-ribbon-menu-item-label">{item.label}</span>
                        {item.disabled === true && item.disabledReason !== undefined && (
                            <span className="nuke-ribbon-menu-item-reason">{item.disabledReason}</span>
                        )}
                    </span>
                </button>
            ))}
        </div>,
        document.body
    );
}

/**
 * Non-wrapping ribbon container. `density` sets the default for every child
 * section; sections may override it individually.
 */
export const NukeRibbon: React.FC<NukeRibbonProps> = ({ density = 'tiles', className, children }) => (
    <NukeRibbonDensityContext.Provider value={density}>
        <div className={`nuke-ribbon nuke-ribbon-${density}${className ? ` ${className}` : ''}`} role="toolbar">
            {children}
        </div>
    </NukeRibbonDensityContext.Provider>
);

/**
 * One labelled ribbon section.
 *
 * In `tiles`/`icons` density the first `promoted` actions render as buttons
 * with a caption row beneath; the remaining actions open from the caret. In
 * `menus` density the section collapses to a single `caption ▾` button that
 * lists every action.
 */
export const NukeRibbonSection: React.FC<NukeRibbonSectionProps> = ({ label, items, promoted, density, className }) => {
    const inheritedDensity = React.useContext(NukeRibbonDensityContext);
    const effectiveDensity = density ?? inheritedDensity;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const closeMenu = React.useCallback((restoreFocus: boolean) => {
        setMenuOpen(false);
        if (restoreFocus) {
            triggerRef.current?.focus();
        }
    }, []);
    const split = React.useMemo(() => splitRibbonItems(items, promoted), [items, promoted]);
    const menuItems = effectiveDensity === 'menus' ? items : split.menu;

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            className={`nuke-ribbon-menu-trigger${effectiveDensity === 'menus' ? ' nuke-ribbon-menus-trigger' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${label} actions`}
            onClick={() => setMenuOpen((open) => !open)}
        >
            {effectiveDensity === 'menus' && <span className="nuke-ribbon-caption-label">{label}</span>}
            <span className="codicon codicon-chevron-down nuke-ribbon-caret" />
        </button>
    );

    return (
        <div
            className={`nuke-ribbon-section nuke-ribbon-section-${effectiveDensity}${className ? ` ${className}` : ''}`}
            role="group"
            aria-label={label}
        >
            {effectiveDensity === 'menus' ? (
                trigger
            ) : (
                <>
                    <div className="nuke-ribbon-buttons">
                        {split.promoted.map((item) => (
                            <Tooltip
                                key={item.id}
                                content={
                                    item.disabled === true && item.disabledReason !== undefined
                                        ? `${item.label} — ${item.disabledReason}`
                                        : item.label
                                }
                                position="bottom"
                            >
                                <button
                                    type="button"
                                    className={
                                        `theia-button secondary nuke-ribbon-item nuke-ribbon-item-${effectiveDensity}` +
                                        `${item.active === true ? ' active' : ''}`
                                    }
                                    disabled={item.disabled === true}
                                    aria-label={item.label}
                                    aria-pressed={item.active === undefined ? undefined : item.active}
                                    onClick={item.onClick}
                                >
                                    <span className={`codicon ${item.icon}`} />
                                    {effectiveDensity === 'tiles' && (
                                        <span className="nuke-ribbon-item-label">{item.shortLabel ?? item.label}</span>
                                    )}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                    <div className="nuke-ribbon-caption">
                        <span className="nuke-ribbon-caption-label">{label}</span>
                        {menuItems.length > 0 && trigger}
                    </div>
                </>
            )}
            {menuOpen && menuItems.length > 0 && <RibbonMenu label={label} items={menuItems} anchorRef={triggerRef} onClose={closeMenu} />}
        </div>
    );
};
