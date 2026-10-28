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
import type { ProjectedAxisLabel } from '../viewer-core/axes-grid';
import './axes-grid-overlay.css';

/**
 * Presentational HTML labels for the axes grid.
 *
 * The host widget owns the 3D lines (`viewer-core/axes-grid.ts`) and the
 * per-frame projection (`projectAxisLabels`), then passes the already
 * projected CSS-pixel label list here. This component only paints them:
 * no Theia imports, no global state, no subscriptions, no camera math.
 * Styling follows the active theme through `axes-grid-overlay.css`.
 */
export interface AxesGridOverlayProps {
    /** Projected labels from `projectAxisLabels` (already sorted and de-overlapped). */
    readonly labels: readonly ProjectedAxisLabel[];
    /** Viewport width in CSS pixels (same value used for projection). */
    readonly width: number;
    /** Viewport height in CSS pixels (same value used for projection). */
    readonly height: number;
    /** Hide the whole overlay (grid toggle off, no dataset, ...). */
    readonly visible: boolean;
    /** Extra class on the overlay root for host placement. */
    readonly className?: string;
}

export const AxesGridOverlay: React.FC<AxesGridOverlayProps> = ({ labels, width, height, visible, className }) => {
    if (!visible || !labels || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || labels.length === 0) {
        return null;
    }
    const rootClass = className ? `axes-grid-overlay ${className}` : 'axes-grid-overlay';
    return (
        <div className={rootClass} style={{ width, height }} aria-hidden="true">
            {labels.map((label, index) => {
                if (!Number.isFinite(label.x) || !Number.isFinite(label.y) || label.text.length === 0) {
                    return null;
                }
                const titleClass = label.kind === 'title' ? ' axes-grid-overlay-label-title' : '';
                return (
                    <span
                        key={`${label.axis}-${label.kind}-${index}`}
                        className={`axes-grid-overlay-label${titleClass}`}
                        style={{ left: label.x, top: label.y }}
                    >
                        {label.text}
                    </span>
                );
            })}
        </div>
    );
};
