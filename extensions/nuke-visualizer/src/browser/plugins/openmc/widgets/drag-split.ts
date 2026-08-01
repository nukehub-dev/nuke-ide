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
 * Shared drag-to-resize helper for widget split handles.
 *
 * Two properties make a custom splitter feel right:
 * - during the drag the size is written directly to the DOM (`apply`), with
 *   no React re-render per pixel — `commit` runs once on mouseup;
 * - iframes inside the widget are click-shielded (`pointer-events: none`)
 *   for the duration of the drag, because an iframe (e.g. the trame 3D view)
 *   swallows every mouse event once the cursor crosses into it, which jams a
 *   plain document-level mousemove/mouseup drag.
 */

/** Minimal mouse-event shape the helper needs (React's MouseEvent qualifies). */
export interface SplitDragStartEvent {
    clientX: number;
    clientY: number;
    preventDefault(): void;
}

export interface SplitDragOptions {
    /** The mousedown event on the drag handle */
    event: SplitDragStartEvent;
    /** Widget root node — iframes inside are click-shielded during the drag */
    node: HTMLElement;
    /** Compute the new size (px) from the current mouse position */
    sizeFromEvent(startEvent: SplitDragStartEvent, ev: MouseEvent): number;
    /** Apply a size live during the drag (direct DOM write) */
    apply(size: number): void;
    /** Called once on mouseup with the last applied size */
    commit(size: number): void;
}

/** Start a drag-to-resize interaction. See module docstring for the contract. */
export function startSplitDrag(options: SplitDragOptions): void {
    options.event.preventDefault();

    const iframes = Array.from(options.node.querySelectorAll('iframe'));
    for (const iframe of iframes) {
        iframe.style.pointerEvents = 'none';
    }

    let size = 0;
    const onMove = (ev: MouseEvent): void => {
        size = options.sizeFromEvent(options.event, ev);
        options.apply(size);
    };
    const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        for (const iframe of iframes) {
            iframe.style.pointerEvents = '';
        }
        options.commit(size);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
