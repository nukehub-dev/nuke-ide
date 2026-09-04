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
 * Viewport right-click context menu: the pure menu model and solid→feature
 * attribution behind it, plus the thin imperative DOM renderer. The model
 * builder and attribution are pure so vitest covers them directly; the
 * renderer only mirrors the sketch toolbar's DIY menu pattern (fixed-position
 * panel, window pointerdown closes, Escape closes).
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import { type MeasureToolMode } from './measure-tool';

/** Feature fields the attribution needs; structural subset of `FeatureDef`. */
export interface FeatureBodyRef {
    readonly id: string;
    readonly body: string;
    readonly suppressed: boolean;
}

/**
 * Best-effort solid→feature attribution through the solid's body: the latest
 * non-suppressed feature in document order that writes the body is what "edit
 * this thing" means to a user (a pattern fuse merges many features into one
 * solid; the tip feature owns it). Returns undefined when the payload carries
 * no body id (script/STEP models) or no feature writes the body — callers must
 * disable Edit Feature rather than guess.
 */
export function attributeBodyToFeature(bodyId: string | undefined, features: readonly FeatureBodyRef[] | undefined): string | undefined {
    if (bodyId === undefined || features === undefined) {
        return undefined;
    }
    for (let i = features.length - 1; i >= 0; i--) {
        const feature = features[i];
        if (!feature.suppressed && feature.body === bodyId) {
            return feature.id;
        }
    }
    return undefined;
}

/** Actions the viewport widget dispatches for a menu item. */
export type ViewportContextMenuAction =
    | { readonly kind: 'editFeature'; readonly featureId: string }
    | { readonly kind: 'measure'; readonly tool: MeasureToolMode }
    | { readonly kind: 'fitSolid'; readonly solidId: number }
    | { readonly kind: 'hideSolid'; readonly solidId: number }
    | { readonly kind: 'isolateSolid'; readonly solidId: number }
    | { readonly kind: 'fitAll' }
    | { readonly kind: 'resetExplode' }
    | { readonly kind: 'showAll' }
    | { readonly kind: 'toggleSection' }
    /** Only ever on disabled items (the Edit Feature placeholder). */
    | { readonly kind: 'noop' };

export interface ViewportContextMenuItem {
    readonly label: string;
    readonly icon: string;
    readonly disabled?: boolean;
    /** Render a separator above this item (group boundaries). */
    readonly separatorAbove?: boolean;
    readonly action: ViewportContextMenuAction;
}

export interface ViewportContextMenuInput {
    /** The solid under the pointer, with its attributed feature when known. */
    readonly solid: { readonly solidId: number; readonly featureId?: string } | undefined;
    /** Current explode factor (0 = assembled); gates Reset Explode. */
    readonly explodeFactor: number;
    /** Hidden-solid count; gates Show All Solids. Defaults to 0. */
    readonly hiddenCount?: number;
    /** Whether the section view is active; flips the section toggle label. Defaults to false. */
    readonly sectionActive?: boolean;
}

/** Hit-test-dependent menu contents; solid menu vs empty-space menu. */
export function buildViewportContextMenu(input: ViewportContextMenuInput): readonly ViewportContextMenuItem[] {
    if (input.solid !== undefined) {
        const { solidId, featureId } = input.solid;
        return [
            {
                label: 'Edit Feature…',
                icon: 'codicon-edit',
                disabled: featureId === undefined ? true : undefined,
                action: featureId !== undefined ? { kind: 'editFeature', featureId } : { kind: 'noop' }
            },
            {
                label: 'Measure Distance',
                icon: 'codicon-nuke-cad-measure',
                separatorAbove: true,
                action: { kind: 'measure', tool: 'distance' }
            },
            {
                label: 'Measure Angle',
                icon: 'codicon-nuke-cad-measure',
                action: { kind: 'measure', tool: 'angle' }
            },
            {
                label: 'Measure Radius',
                icon: 'codicon-nuke-cad-measure',
                action: { kind: 'measure', tool: 'radius' }
            },
            {
                label: 'Fit to Solid',
                icon: 'codicon-zoom-in',
                separatorAbove: true,
                action: { kind: 'fitSolid', solidId }
            },
            {
                label: 'Hide Solid',
                icon: 'codicon-eye-closed',
                separatorAbove: true,
                action: { kind: 'hideSolid', solidId }
            },
            {
                label: 'Isolate Solid',
                icon: 'codicon-filter',
                action: { kind: 'isolateSolid', solidId }
            }
        ];
    }
    const hiddenCount = input.hiddenCount ?? 0;
    const sectionActive = input.sectionActive ?? false;
    return [
        { label: 'Fit All', icon: 'codicon-zoom-out', action: { kind: 'fitAll' } },
        {
            label: 'Reset Explode',
            icon: 'codicon-discard',
            disabled: input.explodeFactor <= 0 ? true : undefined,
            action: { kind: 'resetExplode' }
        },
        {
            label: 'Show All Solids',
            icon: 'codicon-eye',
            separatorAbove: true,
            disabled: hiddenCount <= 0 ? true : undefined,
            action: { kind: 'showAll' }
        },
        {
            label: sectionActive ? 'Hide Section View' : 'Show Section View',
            icon: 'codicon-nuke-cad-section',
            action: { kind: 'toggleSection' }
        }
    ];
}

/**
 * Parent dispatch sketch (not wired — the widget owns this):
 * hideSolid -> stateManager.setHiddenSolidIds([...hidden, solidId])
 * isolateSolid -> setHiddenSolidIds(summaries.map(s => s.solidId).filter(id => id !== solidId))
 * showAll -> stateManager.setHiddenSolidIds([])
 * toggleSection -> onSetSectionActive(!sectionActive)
 */

/**
 * Render the menu at a container-relative anchor and invoke `onAction` for the
 * chosen item. Clamps the panel inside the container. Closes on any window
 * pointerdown outside the menu or on Escape; returns the close function so the
 * viewport cleanup can dismiss it too. Choosing an item hands focus back to
 * the container, since the pressed button leaves the DOM with the menu.
 */
export function openViewportContextMenu(
    container: HTMLElement,
    items: readonly ViewportContextMenuItem[],
    anchor: { readonly x: number; readonly y: number },
    onAction: (action: ViewportContextMenuAction) => void
): () => void {
    const menu = document.createElement('div');
    menu.className = 'cad-viewport-context-menu';
    for (const item of items) {
        if (item.separatorAbove === true) {
            const separator = document.createElement('div');
            separator.className = 'cad-viewport-context-menu-separator';
            menu.appendChild(separator);
        }
        const button = document.createElement('button');
        button.className = 'cad-viewport-context-menu-item';
        button.disabled = item.disabled === true;
        const icon = document.createElement('span');
        icon.className = `codicon ${item.icon}`;
        button.appendChild(icon);
        button.appendChild(document.createTextNode(item.label));
        button.addEventListener('click', () => {
            close();
            if (item.disabled !== true) {
                onAction(item.action);
                // The pressed button leaves the DOM with the menu, dropping
                // focus to the body and silencing the viewport's keyboard
                // handling; hand focus back so Escape ends a measure tool and
                // the Q/F shortcuts keep working. Dialog actions re-take focus
                // on their auto-focused field when they mount.
                container.focus({ preventScroll: true });
            }
        });
        menu.appendChild(button);
    }
    container.appendChild(menu);
    // Clamp after layout so the fully-sized panel stays inside the canvas.
    const maxLeft = Math.max(0, container.clientWidth - menu.offsetWidth);
    const maxTop = Math.max(0, container.clientHeight - menu.offsetHeight);
    menu.style.left = `${Math.min(Math.max(anchor.x, 0), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(anchor.y, 0), maxTop)}px`;

    const onWindowPointerDown = (event: PointerEvent): void => {
        if (event.target instanceof Node && menu.contains(event.target)) {
            return;
        }
        close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
        }
    };
    // The menu outlives a pointer gesture: pointerdown (not click) closes, and
    // the menu's own presses must not trip the window listener.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('keydown', onKeyDown, true);

    function close(): void {
        window.removeEventListener('pointerdown', onWindowPointerDown);
        window.removeEventListener('keydown', onKeyDown, true);
        menu.remove();
    }
    return close;
}
