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
 * Imperative right-click context menu for the native 3D viewers.
 *
 * Same posture as nuke-cad's `viewport-context-menu.ts`: plain DOM (no
 * React state, no Theia ContextMenuRenderer), so the menu opens at the
 * pointer-up position without re-rendering the widget. View actions only
 * (fit, screenshot, clip toggle, per-mode shading) — never CAD feature
 * actions. The menu closes on item click, Escape, pointer-leave, or a
 * pointer-down outside it.
 *
 * Theia-free (DOM only), like the rest of viewer-core. Styling lives in
 * `widgets/output-viewer.css` (`.viewer-context-menu`), copied by the
 * extension's `copy-css` build step.
 */

import { VIEWER_SHADING_MODES, type ViewerShadingMode } from './shading-mode';

/** One menu entry: a view action with an optional icon and check mark. */
export interface ViewerContextMenuItem {
    /** Stable id routed back through `onSelect` (`shading:<mode>` for shading rows). */
    readonly id: string;
    /** Row label shown in the menu. */
    readonly label: string;
    /** Bare codicon class (`codicon-zoom-in`) rendered before the label; mirrors the CAD viewport menu. */
    readonly icon?: string;
    /** Check mark shown before the label (toggle state / active shading mode). */
    readonly checked?: boolean;
    /** Render a separator above this item (group boundaries). */
    readonly separatorAbove?: boolean;
    /** Disabled rows render dimmed and never fire `onSelect`. */
    readonly disabled?: boolean;
}

/** Client coordinates where the menu opens (the button-up position). */
export interface ViewerContextMenuPosition {
    readonly x: number;
    readonly y: number;
}

/** Maximum press-to-release travel (px) that still counts as a right-click rather than a pan. */
export const VIEWER_CONTEXT_MENU_DRAG_TOLERANCE_PX = 5;

/**
 * True when press/release client coordinates are within the no-drag
 * tolerance, so a right-drag pan never opens the menu. Pure.
 */
export function isViewerContextMenuClick(
    downX: number,
    downY: number,
    upX: number,
    upY: number,
    tolerance: number = VIEWER_CONTEXT_MENU_DRAG_TOLERANCE_PX
): boolean {
    const dx = upX - downX;
    const dy = upY - downY;
    return Math.sqrt(dx * dx + dy * dy) <= tolerance;
}

/**
 * Viewer state behind the standard view-action menu: the active shading
 * mode (checked in its group) and whether any clip plane is enabled.
 */
export interface ViewerContextMenuState {
    readonly shading: ViewerShadingMode;
    readonly clipChecked: boolean;
}

/**
 * One icon per shading row so every menu row carries a glyph (CAD viewport
 * menu grammar: icon + label on every row, check mark for the active
 * entry). Pure data, covered with the item builder.
 */
export const VIEWER_SHADING_MENU_ICONS: Record<ViewerShadingMode, string> = {
    shaded: 'codicon-circle-filled',
    edges: 'codicon-globe',
    wireframe: 'codicon-circle-outline',
    points: 'codicon-ellipsis',
    xray: 'codicon-preview'
};

/**
 * Standard view-action menu contents: Fit / Screenshot, then Clip Planes,
 * then one row per shading mode with the active mode checked. Separators
 * split the three groups. Pure (vitest-covered).
 */
export function buildViewerContextMenuItems(state: ViewerContextMenuState): ViewerContextMenuItem[] {
    return [
        { id: 'fit', label: 'Fit to View', icon: 'codicon-zoom-in' },
        { id: 'screenshot', label: 'Save Screenshot (PNG)', icon: 'codicon-device-camera' },
        {
            id: 'clip',
            label: 'Clip Planes',
            icon: 'codicon-layers',
            checked: state.clipChecked,
            separatorAbove: true
        },
        ...VIEWER_SHADING_MODES.map((mode, index) => ({
            id: `shading:${mode.id}`,
            label: mode.label,
            icon: VIEWER_SHADING_MENU_ICONS[mode.id],
            checked: mode.id === state.shading,
            separatorAbove: index === 0
        }))
    ];
}

/** Margin (px) kept between the menu and the viewport edges. */
export const VIEWER_CONTEXT_MENU_MARGIN_PX = 4;

/**
 * Clamp a measured menu rect at client (`x`, `y`) into the viewport, so
 * every row — including the first — stays fully visible. Pure
 * (vitest-covered): the renderer measures the menu AFTER it renders and
 * routes the numbers through here, never positioning from an estimate.
 */
export function clampViewerContextMenuPosition(
    x: number,
    y: number,
    menuWidth: number,
    menuHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    margin: number = VIEWER_CONTEXT_MENU_MARGIN_PX
): ViewerContextMenuPosition {
    const maxX = Math.max(margin, viewportWidth - menuWidth - margin);
    const maxY = Math.max(margin, viewportHeight - menuHeight - margin);
    return {
        x: Math.min(Math.max(x, margin), maxX),
        y: Math.min(Math.max(y, margin), maxY)
    };
}

/**
 * Open the menu at client `position` and return an idempotent close
 * function. The menu is a fixed-position div on `document.body` (never
 * inside the widget's React tree, so widget re-renders cannot disturb
 * it), measured after render and clamped into the viewport.
 */
export function openViewerContextMenu(
    position: ViewerContextMenuPosition,
    items: readonly ViewerContextMenuItem[],
    onSelect: (id: string) => void
): () => void {
    let closed = false;
    const menu = document.createElement('div');
    menu.className = 'viewer-context-menu';
    menu.setAttribute('role', 'menu');
    const close = (): void => {
        if (closed) {
            return;
        }
        closed = true;
        window.removeEventListener('keydown', handleKey, true);
        window.removeEventListener('pointerdown', handleOutside, true);
        menu.remove();
    };
    const handleKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
        }
    };
    const handleOutside = (event: PointerEvent): void => {
        if (!menu.contains(event.target as Node)) {
            close();
        }
    };
    for (const item of items) {
        if (item.separatorAbove === true) {
            const separator = document.createElement('div');
            separator.className = 'viewer-context-menu-separator';
            separator.setAttribute('role', 'separator');
            menu.appendChild(separator);
        }
        const button = document.createElement('button');
        button.className = 'viewer-context-menu-item';
        button.setAttribute('role', 'menuitem');
        button.type = 'button';
        button.disabled = item.disabled ?? false;
        if (item.icon !== undefined) {
            const icon = document.createElement('span');
            icon.className = 'viewer-context-menu-icon';
            const glyph = document.createElement('i');
            glyph.className = `codicon ${item.icon}`;
            glyph.setAttribute('aria-hidden', 'true');
            icon.appendChild(glyph);
            button.appendChild(icon);
        }
        const check = document.createElement('span');
        check.className = 'viewer-context-menu-check';
        if (item.checked === true) {
            const mark = document.createElement('i');
            mark.className = 'codicon codicon-check';
            mark.setAttribute('aria-hidden', 'true');
            check.appendChild(mark);
            button.classList.add('viewer-context-menu-item-checked');
        }
        const label = document.createElement('span');
        label.className = 'viewer-context-menu-label';
        label.textContent = item.label;
        button.appendChild(check);
        button.appendChild(label);
        button.addEventListener('click', () => {
            close();
            if (item.disabled !== true) {
                onSelect(item.id);
            }
        });
        menu.appendChild(button);
    }
    menu.addEventListener('pointerleave', () => close());
    // Measure AFTER render: append hidden so the laid-out rect reflects the
    // final styles (icons, separators, theme fonts), clamp into the
    // viewport, then show. Positioning from an estimate is what clipped the
    // first row when the menu opened near an edge.
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const clamped = clampViewerContextMenuPosition(position.x, position.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    menu.style.left = `${clamped.x}px`;
    menu.style.top = `${clamped.y}px`;
    menu.style.visibility = '';
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('pointerdown', handleOutside, true);
    return close;
}
