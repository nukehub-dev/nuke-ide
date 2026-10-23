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
    | { readonly kind: 'hideSolids'; readonly solidIds: readonly number[] }
    | { readonly kind: 'isolateSolids'; readonly solidIds: readonly number[] }
    | { readonly kind: 'fitAll' }
    | { readonly kind: 'resetExplode' }
    | { readonly kind: 'showAll' }
    | { readonly kind: 'toggleSection' }
    | { readonly kind: 'clearSelection' }
    | { readonly kind: 'revealFeature'; readonly featureId: string }
    /** Open the anchored candidate list for overlapping faces under the pointer. */
    | { readonly kind: 'selectOther' }
    /** Open the per-body Appearance dialog (display-only color/opacity override). */
    | { readonly kind: 'appearance'; readonly bodyId: string }
    /** Only ever on disabled items (the Edit Feature placeholder). */
    | { readonly kind: 'noop' };

export interface ViewportContextMenuItem {
    readonly label: string;
    readonly icon: string;
    readonly disabled?: boolean;
    /** Concise native tooltip on a disabled item. */
    readonly reason?: string;
    /** Render a separator above this item (group boundaries). */
    readonly separatorAbove?: boolean;
    /**
     * Right-aligned key hint. Only real bindings belong here (`F` fits the
     * view/selection, `Esc` clears selection) — never advertise a key that
     * does nothing in this viewport.
     */
    readonly hint?: string;
    readonly action: ViewportContextMenuAction;
}

export interface ViewportContextMenuInput {
    /** The solid under the pointer, with its attributed feature and body when known. */
    readonly solid: { readonly solidId: number; readonly featureId?: string; readonly bodyId?: string } | undefined;
    /** Current explode factor (0 = assembled); gates Reset Explode. */
    readonly explodeFactor: number;
    /** Hidden-solid count; gates Show All Solids. Defaults to 0. */
    readonly hiddenCount?: number;
    /** Whether the section view is active; flips the section toggle label. Defaults to false. */
    readonly sectionActive?: boolean;
    /**
     * Multi-selected solid ids (primary first). When the solid under the
     * pointer belongs to a multi-selection, bulk Hide/Isolate Selected
     * items act on the whole set. Defaults to [].
     */
    readonly selectedIds?: readonly number[];
    /** Whether the viewport has a selection; gates Clear Selection. Defaults to false. */
    readonly hasSelection?: boolean;
    /**
     * Distinct faces under the context-menu pointer. Select Other… appears
     * only when more than one candidate exists. Defaults to 0.
     */
    readonly selectOtherCount?: number;
}

/** Hit-test-dependent menu contents; solid menu vs empty-space menu. */
export function buildViewportContextMenu(input: ViewportContextMenuInput): readonly ViewportContextMenuItem[] {
    const hasSelection = input.hasSelection === true;
    if (input.solid !== undefined) {
        const { solidId, featureId, bodyId } = input.solid;
        const selectedIds = (input.selectedIds ?? []).filter((id, index, all) => all.indexOf(id) === index);
        const bulkIds = selectedIds.length > 1 && selectedIds.includes(solidId) ? selectedIds : undefined;
        const selectOtherCount = input.selectOtherCount ?? 0;
        return [
            {
                label: 'Edit Feature…',
                icon: 'codicon-edit',
                disabled: featureId === undefined ? true : undefined,
                reason: featureId === undefined ? 'No feature writes this body.' : undefined,
                action: featureId !== undefined ? { kind: 'editFeature', featureId } : { kind: 'noop' }
            },
            ...(featureId !== undefined
                ? [
                      {
                          label: 'Find in Feature Tree',
                          icon: 'codicon-list-tree',
                          separatorAbove: true,
                          action: { kind: 'revealFeature', featureId } as const
                      }
                  ]
                : []),
            // Select Other belongs to the pick group: it disambiguates the
            // faces under the pointer, independent of feature attribution.
            ...(selectOtherCount > 1
                ? [
                      {
                          label: 'Select Other…',
                          icon: 'codicon-layers',
                          hint: 'Alt+click',
                          action: { kind: 'selectOther' } as const
                      }
                  ]
                : []),
            ...(bodyId !== undefined
                ? [
                      {
                          label: 'Appearance…',
                          icon: 'codicon-symbol-color',
                          action: { kind: 'appearance', bodyId } as const
                      }
                  ]
                : []),
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
                hint: 'F',
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
            },
            ...(bulkIds !== undefined
                ? [
                      {
                          label: `Hide Selected (${bulkIds.length})`,
                          icon: 'codicon-eye-closed',
                          separatorAbove: true,
                          action: { kind: 'hideSolids', solidIds: bulkIds } as const
                      },
                      {
                          label: `Isolate Selected (${bulkIds.length})`,
                          icon: 'codicon-filter',
                          action: { kind: 'isolateSolids', solidIds: bulkIds } as const
                      }
                  ]
                : []),
            ...(hasSelection
                ? [
                      {
                          label: 'Clear Selection',
                          icon: 'codicon-clear-all',
                          hint: 'Esc',
                          separatorAbove: true,
                          action: { kind: 'clearSelection' } as const
                      }
                  ]
                : [])
        ];
    }
    const hiddenCount = input.hiddenCount ?? 0;
    const sectionActive = input.sectionActive ?? false;
    return [
        ...(hasSelection
            ? [
                  {
                      label: 'Clear Selection',
                      icon: 'codicon-clear-all',
                      hint: 'Esc',
                      action: { kind: 'clearSelection' } as const
                  }
              ]
            : []),
        // No hint here: F fits the selected solid when one exists, so it is
        // not the Fit All binding.
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
 * hideSolids -> setHiddenSolidIds([...hidden, ...solidIds])
 * isolateSolids -> setHiddenSolidIds(allSolidIds.filter(id => !keep.has(id))) over the bodies owning solidIds
 * showAll -> stateManager.setHiddenSolidIds([])
 * toggleSection -> onSetSectionActive(!sectionActive)
 * clearSelection -> onClearSelection() (document selection + viewport highlight)
 * revealFeature -> onRevealFeature(featureId) (select in the tree, then open its panel)
 * selectOther -> open the anchored candidate popover for the right-click ray
 */

/**
 * Render the menu at a container-relative anchor and invoke `onAction` for the
 * chosen item. Clamps the panel inside the container. Closes on any window
 * pointerdown outside the menu or on Escape; returns the close function so the
 * viewport cleanup can dismiss it too. `onClose` fires for those dismissals and
 * for external `close()` calls, but not for an item dispatch, whose action may
 * still need data captured at open time. Choosing an item hands focus back to
 * the container, since the pressed button leaves the DOM with the menu.
 */
export function openViewportContextMenu(
    container: HTMLElement,
    items: readonly ViewportContextMenuItem[],
    anchor: { readonly x: number; readonly y: number },
    onAction: (action: ViewportContextMenuAction) => void,
    onClose?: () => void
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
        if (item.disabled === true && item.reason !== undefined) {
            button.title = item.reason;
        }
        const icon = document.createElement('span');
        icon.className = `codicon ${item.icon}`;
        button.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'cad-viewport-context-menu-label';
        label.textContent = item.label;
        button.appendChild(label);
        if (item.hint !== undefined) {
            const hint = document.createElement('span');
            hint.className = 'cad-viewport-context-menu-hint';
            hint.textContent = item.hint;
            button.appendChild(hint);
            button.setAttribute('aria-keyshortcuts', item.hint === 'Esc' ? 'Escape' : item.hint);
        }
        button.addEventListener('click', () => {
            close(false);
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
        close(true);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close(true);
        }
    };
    // The menu outlives a pointer gesture: pointerdown (not click) closes, and
    // the menu's own presses must not trip the window listener.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('keydown', onKeyDown, true);

    function close(dismiss: boolean): void {
        window.removeEventListener('pointerdown', onWindowPointerDown);
        window.removeEventListener('keydown', onKeyDown, true);
        menu.remove();
        if (dismiss) {
            onClose?.();
        }
    }
    return () => close(true);
}
