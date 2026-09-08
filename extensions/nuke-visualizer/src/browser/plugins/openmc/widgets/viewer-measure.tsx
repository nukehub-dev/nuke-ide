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

import * as React from 'react';

/**
 * Distance-measure label for the native 3D viewers, mounted by the native
 * VTK viewer (and its subclasses, which inherit the chrome) and the DAGMC
 * viewer.
 *
 * Same overlay pattern as `ViewerGizmo` (absolute overlay on the 3D
 * viewarea) but imperative: the host widget owns the 3D annotation (line +
 * endpoint spheres in its scene, world-anchored so they track the camera for
 * free) and drives this label straight through {@link ViewerMeasureHandle}
 * from its render-on-demand repaint — never React state, so orbiting never
 * re-renders. The host shows the label only for a committed segment and
 * unmounts it while no dataset is loaded. Styling lives in
 * `output-viewer.css` (`.viewer-measure-label`).
 */

/** Imperative measure-label driver owned by the host widget (no React state involved). */
export interface ViewerMeasureHandle {
    /** Position the label at container-relative pixels, or hide it when `visible` is false. */
    setLabel: (x: number, y: number, text: string, visible: boolean) => void;
}

export const ViewerMeasureLabel = React.forwardRef<ViewerMeasureHandle, object>((_props, ref) => {
    const labelRef = React.useRef<HTMLDivElement | null>(null);

    React.useImperativeHandle(
        ref,
        () => ({
            setLabel: (x, y, text, visible) => {
                const label = labelRef.current;
                if (!label) {
                    return;
                }
                if (!visible) {
                    label.style.display = 'none';
                    return;
                }
                label.style.display = 'block';
                // Text first so a later reader sees content and position together.
                if (label.textContent !== text) {
                    label.textContent = text;
                }
                label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -130%)`;
            }
        }),
        []
    );

    return <div ref={labelRef} className="viewer-measure-label" style={{ display: 'none' }} aria-live="polite" />;
});
