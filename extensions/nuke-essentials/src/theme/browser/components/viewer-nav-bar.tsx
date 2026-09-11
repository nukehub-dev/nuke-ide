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

import * as React from '@theia/core/shared/react';
import { Tooltip } from './tooltip';
import { VIEWER_NAV_ITEMS, type ViewerNavAction } from './viewer-nav-actions';

export type { ViewerNavAction } from './viewer-nav-actions';

/**
 * Shared viewer bottom bar for the 3D viewers (nuke-cad viewport and
 * nuke-visualizer native viewers): one horizontal variant with ISO/T/F/R
 * standard views, fit, and zoom in/out.
 *
 * Props-only: the host routes {@link ViewerNavAction} onto its own orbit
 * handle (snap directions differ between the Y-up visualizer and the Z-up
 * CAD viewport, so the bar never embeds directions). Host-specific extras
 * render as `children` after a divider — nuke-cad keeps its Explode
 * slider, shading, and section tools there as siblings; nuke-visualizer
 * keeps its clip toggle, section view, shading cycle, and DAGMC
 * exclude/isolate actions there (`widgets/viewer-nav-extras.tsx`,
 * stateless mirrors of the sidebars). The bar owns the overlay pill surface
 * and bottom-right placement, so both viewers converge on one chrome
 * position. Styling lives in `viewer-nav-bar.css`
 * (`.nuke-viewer-nav-bar`).
 */
export interface ViewerNavBarProps {
    /** Single action router: the host widget drives its orbit handle. */
    readonly onAction: (action: ViewerNavAction) => void;
    /** Disables every core button (no dataset loaded, or still loading). */
    readonly disabled?: boolean;
    /** Host-specific extras (CAD tools, visualizer quick actions) rendered after a divider. */
    readonly children?: React.ReactNode;
}

export const ViewerNavBar = React.forwardRef<HTMLDivElement, ViewerNavBarProps>(({ onAction, disabled, children }, ref) => (
    <div className="nuke-viewer-nav-bar" role="toolbar" aria-label="3D view controls" ref={ref}>
        {VIEWER_NAV_ITEMS.slice(0, 4).map((item) => (
            <Tooltip key={item.action} content={item.tooltip} position="left">
                <button
                    className="theia-button secondary nuke-viewer-nav-bar-button nuke-viewer-nav-bar-text"
                    disabled={disabled}
                    onClick={() => onAction(item.action)}
                >
                    {item.label}
                </button>
            </Tooltip>
        ))}
        <span className="nuke-viewer-nav-bar-divider" />
        {VIEWER_NAV_ITEMS.slice(4).map((item) => (
            <Tooltip key={item.action} content={item.tooltip} position="left">
                <button
                    className="theia-button secondary nuke-viewer-nav-bar-button"
                    disabled={disabled}
                    onClick={() => onAction(item.action)}
                >
                    <span className={`codicon codicon-${item.icon}`} />
                </button>
            </Tooltip>
        ))}
        {children !== undefined && (
            <>
                <span className="nuke-viewer-nav-bar-divider" />
                {children}
            </>
        )}
    </div>
));
