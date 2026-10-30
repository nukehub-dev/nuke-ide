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
 * Shared drag machinery for the sketch chrome's floating panels (toolbar and
 * popovers): pointer math, bounds clamping, session-scoped position state,
 * and Reset Position gesture handling. Positions live in React state only —
 * never the document — and die with the owning component (or the sketch
 * session, for panels whose state is hoisted to the overlay).
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import * as React from '@theia/core/shared/react';

/** Screen-space panel offset relative to the panel's positioning container. */
export interface PanelPosition {
    readonly top: number;
    readonly left: number;
}

/**
 * Sliver of an oversized panel kept inside the bounds so its drag header
 * stays reachable; panels that fit clamp flush to the edges instead.
 */
export const PANEL_HEADER_SLIVER_PX = 32;

/**
 * Clamp a proposed panel offset so the panel stays inside the canvas
 * container: wholly inside when it fits, otherwise pinned so at least
 * `minVisiblePx` of the panel (its header) remains visible and grabbable.
 */
export function clampPanelPosition(
    left: number,
    top: number,
    width: number,
    height: number,
    boundsWidth: number,
    boundsHeight: number,
    minVisiblePx: number = PANEL_HEADER_SLIVER_PX
): PanelPosition {
    const maxTop = height <= boundsHeight ? boundsHeight - height : Math.max(0, boundsHeight - minVisiblePx);
    const maxLeft = width <= boundsWidth ? boundsWidth - width : Math.max(0, boundsWidth - minVisiblePx);
    return {
        left: Math.min(Math.max(left, 0), maxLeft),
        top: Math.min(Math.max(top, 0), maxTop)
    };
}

/** Decides whether a pointer/gesture target may pick the panel up or reset it. */
export type DragTargetFilter = (target: HTMLElement) => boolean;

/** Default gate: drags never start on buttons, so header buttons stay clickable. */
export const noButtonDragTarget: DragTargetFilter = (target) => target.closest('button') === null;

/** Gate restricted to a header region (e.g. '.nuke-panel-header'); buttons excluded. */
export function headerRegionTarget(regionSelector: string): DragTargetFilter {
    return (target) => target.closest(regionSelector) !== null && target.closest('button') === null;
}

export interface DraggablePanelOptions {
    /** Where a press may pick the panel up. Default: anywhere but a button. */
    canDrag?: DragTargetFilter;
    /** Where double-click/right-click Reset Position applies. Default: same as canDrag. */
    canResetFrom?: DragTargetFilter;
    /** Right-click resets directly when true (default); set false to bind a custom context menu. */
    resetOnContextMenu?: boolean;
}

interface DragState {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly baseLeft: number;
    readonly baseTop: number;
    readonly width: number;
    readonly height: number;
    readonly boundsEl: Element;
}

export interface DraggablePanelApi {
    /** Dragged offset for the panel root; undefined means the CSS default spot. */
    readonly position: PanelPosition | undefined;
    /**
     * Inline style carrying the dragged offset; anchors the panel away from its
     * default spot and neutralizes any class-supplied right/bottom anchoring.
     */
    readonly style: React.CSSProperties | undefined;
    /** Attach to the absolutely positioned panel root element. */
    readonly panelRef: (element: HTMLElement | null) => void;
    /**
     * Spread on the same element as panelRef; routes press/reset gestures
     * through the configured gates. When resetOnContextMenu is false, bind an
     * explicit onContextMenu after spreading to override the omitted entry.
     */
    readonly handleProps: {
        readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
        readonly onDoubleClick: (event: React.MouseEvent<HTMLElement>) => void;
        readonly onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
    };
    /** True between the pointerdown and pointerup of an active drag. */
    readonly isDragging: () => boolean;
    /** Set once a drag moves beyond the click slop; consumers clear it after consuming. */
    readonly dragMovedRef: React.MutableRefObject<boolean>;
    /** Back to the CSS default spot. */
    readonly resetPosition: () => void;
}

export function useDraggablePanel(options: DraggablePanelOptions = {}): DraggablePanelApi {
    const [position, setPosition] = React.useState<PanelPosition | undefined>(undefined);
    const panelElementRef = React.useRef<HTMLElement | null>(null);
    const dragRef = React.useRef<DragState | undefined>(undefined);
    const dragMovedRef = React.useRef(false);
    const optionsRef = React.useRef(options);
    optionsRef.current = options;

    const onWindowDragMove = React.useCallback((event: PointerEvent): void => {
        const drag = dragRef.current;
        if (drag === undefined || event.pointerId !== drag.pointerId) {
            return;
        }
        if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
            dragMovedRef.current = true;
        }
        const boundsRect = drag.boundsEl.getBoundingClientRect();
        const next = clampPanelPosition(
            drag.baseLeft + event.clientX - drag.startX,
            drag.baseTop + event.clientY - drag.startY,
            drag.width,
            drag.height,
            boundsRect.width,
            boundsRect.height
        );
        setPosition(next);
    }, []);

    const onWindowDragEnd = React.useCallback((): void => {
        dragRef.current = undefined;
        window.removeEventListener('pointermove', onWindowDragMove);
        window.removeEventListener('pointerup', onWindowDragEnd);
    }, [onWindowDragMove]);

    React.useEffect(() => {
        return () => {
            window.removeEventListener('pointermove', onWindowDragMove);
            window.removeEventListener('pointerup', onWindowDragEnd);
        };
    }, [onWindowDragMove, onWindowDragEnd]);

    const onPointerDown = React.useCallback(
        (event: React.PointerEvent<HTMLElement>): void => {
            if (event.button !== 0) {
                return;
            }
            const target = event.target instanceof HTMLElement ? event.target : null;
            const canDrag = optionsRef.current.canDrag ?? noButtonDragTarget;
            if (target === null || !canDrag(target)) {
                return;
            }
            const panel = panelElementRef.current;
            const bounds = panel !== null ? panel.offsetParent : null;
            if (panel === null || bounds === null) {
                return;
            }
            const panelRect = panel.getBoundingClientRect();
            const boundsRect = bounds.getBoundingClientRect();
            dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                baseLeft: panelRect.left - boundsRect.left,
                baseTop: panelRect.top - boundsRect.top,
                width: panelRect.width,
                height: panelRect.height,
                boundsEl: bounds
            };
            dragMovedRef.current = false;
            window.addEventListener('pointermove', onWindowDragMove);
            window.addEventListener('pointerup', onWindowDragEnd);
            event.preventDefault();
        },
        [onWindowDragMove, onWindowDragEnd]
    );

    const resetPosition = React.useCallback((): void => {
        setPosition(undefined);
    }, []);

    const resetFromTarget = (target: HTMLElement | null): boolean => {
        const opts = optionsRef.current;
        const canResetFrom = opts.canResetFrom ?? opts.canDrag ?? noButtonDragTarget;
        return target !== null && canResetFrom(target);
    };

    const onDoubleClick = React.useCallback(
        (event: React.MouseEvent<HTMLElement>): void => {
            if (resetFromTarget(event.target instanceof HTMLElement ? event.target : null)) {
                resetPosition();
            }
        },
        [resetPosition]
    );

    const onContextMenu = React.useCallback(
        (event: React.MouseEvent<HTMLElement>): void => {
            if (optionsRef.current.resetOnContextMenu === false) {
                return;
            }
            if (resetFromTarget(event.target instanceof HTMLElement ? event.target : null)) {
                event.preventDefault();
                resetPosition();
            }
        },
        [resetPosition]
    );

    const panelRef = React.useCallback((element: HTMLElement | null): void => {
        panelElementRef.current = element;
    }, []);

    const isDragging = React.useCallback((): boolean => dragRef.current !== undefined, []);

    const handleProps = {
        onPointerDown,
        onDoubleClick,
        ...(options.resetOnContextMenu === false ? {} : { onContextMenu })
    };

    return {
        position,
        style: position !== undefined ? { top: position.top, left: position.left, right: 'auto', bottom: 'auto' } : undefined,
        panelRef,
        handleProps,
        isDragging,
        dragMovedRef,
        resetPosition
    };
}
