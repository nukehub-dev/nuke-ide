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
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import type { StandardView } from '../../../viewer-core/orbit-controls';

/**
 * CAD-style navigation cluster for the native 3D viewers, shared by the
 * generic VTK viewer (and its tally/output subclasses, which inherit the
 * header) and the DAGMC viewer.
 *
 * UX mirrors nuke-cad's bottom-right nav cluster (ISO / T / F / R standard
 * views, fit, zoom in/out) minus the CAD-only shading/section/explode
 * controls: this cluster drives the viewer-core orbit handle only (standard
 * views keep the current target and distance; zoom dollies toward/away from
 * the target). Host widgets render it over the 3D viewarea and translate
 * {@link ViewerNavAction} onto their orbit handle. Styling lives in
 * `output-viewer.css` (`.viewer-nav-cluster`).
 */
export type ViewerNavAction = StandardView | 'fit' | 'zoom-in' | 'zoom-out';

export interface ViewerNavClusterProps {
    /** Single action router: the host widget drives its orbit handle. */
    readonly onAction: (action: ViewerNavAction) => void;
    /** Disables every button (no dataset loaded, or still loading). */
    readonly disabled?: boolean;
}

export const ViewerNavCluster: React.FC<ViewerNavClusterProps> = ({ onAction, disabled }) => (
    <div className="viewer-nav-cluster" role="toolbar" aria-label="3D view controls">
        <Tooltip content="Iso view" position="left">
            <button
                className="theia-button secondary viewer-nav-button viewer-nav-text"
                disabled={disabled}
                onClick={() => onAction('iso')}
            >
                ISO
            </button>
        </Tooltip>
        <Tooltip content="Top view" position="left">
            <button
                className="theia-button secondary viewer-nav-button viewer-nav-text"
                disabled={disabled}
                onClick={() => onAction('top')}
            >
                T
            </button>
        </Tooltip>
        <Tooltip content="Front view" position="left">
            <button
                className="theia-button secondary viewer-nav-button viewer-nav-text"
                disabled={disabled}
                onClick={() => onAction('front')}
            >
                F
            </button>
        </Tooltip>
        <Tooltip content="Right view" position="left">
            <button
                className="theia-button secondary viewer-nav-button viewer-nav-text"
                disabled={disabled}
                onClick={() => onAction('right')}
            >
                R
            </button>
        </Tooltip>
        <span className="viewer-nav-divider" />
        <Tooltip content="Fit view" position="left">
            <button className="theia-button secondary viewer-nav-button" disabled={disabled} onClick={() => onAction('fit')}>
                <span className={codicon('screen-full')} />
            </button>
        </Tooltip>
        <Tooltip content="Zoom in" position="left">
            <button className="theia-button secondary viewer-nav-button" disabled={disabled} onClick={() => onAction('zoom-in')}>
                <span className={codicon('zoom-in')} />
            </button>
        </Tooltip>
        <Tooltip content="Zoom out" position="left">
            <button className="theia-button secondary viewer-nav-button" disabled={disabled} onClick={() => onAction('zoom-out')}>
                <span className={codicon('zoom-out')} />
            </button>
        </Tooltip>
    </div>
);
