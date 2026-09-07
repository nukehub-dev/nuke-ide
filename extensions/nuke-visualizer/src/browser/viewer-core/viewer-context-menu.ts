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
 * (fit, screenshot, clip toggle, shading cycle) — never CAD feature
 * actions. The menu closes on item click, Escape, pointer-leave, or a
 * pointer-down outside it.
 *
 * Theia-free (DOM only), like the rest of viewer-core. Styling lives in
 * `widgets/output-viewer.css` (`.viewer-context-menu`), copied by the
 * extension's `copy-css` build step.
 */

/** One menu entry: a view action with an optional check mark. */
export interface ViewerContextMenuItem {
    /** Stable id routed back through `onSelect`. */
    readonly id: string;
    /** Row label shown in the menu. */
    readonly label: string;
    /** Check mark shown before the label (toggle state). */
    readonly checked?: boolean;
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
 * Open the menu at client `position` and return an idempotent close
 * function. The menu is a fixed-position div on `document.body` (never
 * inside the widget's React tree, so widget re-renders cannot disturb
 * it), clamped into the viewport.
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
        const button = document.createElement('button');
        button.className = 'viewer-context-menu-item';
        button.setAttribute('role', 'menuitem');
        button.type = 'button';
        button.disabled = item.disabled ?? false;
        const check = document.createElement('span');
        check.className = 'viewer-context-menu-check';
        check.textContent = item.checked ? '✓' : '';
        const label = document.createElement('span');
        label.textContent = item.label;
        button.appendChild(check);
        button.appendChild(label);
        button.addEventListener('click', () => {
            close();
            onSelect(item.id);
        });
        menu.appendChild(button);
    }
    menu.addEventListener('pointerleave', () => close());
    document.body.appendChild(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(position.x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(position.y, window.innerHeight - height - 4))}px`;
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('pointerdown', handleOutside, true);
    return close;
}
