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

/**
 * Shared dataset/view badge for the 3D viewers (nuke-cad viewport and
 * nuke-visualizer native viewers): a muted top-left pill naming what is on
 * screen. Nuke-cad passes the active view (`User view` after orbiting,
 * `Top view` after snapping); the visualizer passes the dataset label
 * (file name). Presentational by design (like `Logo`): the host owns the
 * text, so there is no state and no pure helper to unit-test. Placement
 * (top-left offsets below the toolbar chrome) stays with the host
 * extension; the pill look lives in `view-badge.css` (`.nuke-view-badge`).
 */
export interface ViewBadgeProps {
    /** Pill text (view name or dataset label). */
    readonly text: string;
    /** Native tooltip (the pill itself never uses the Nuke Tooltip). */
    readonly title?: string;
}

export const ViewBadge: React.FC<ViewBadgeProps> = ({ text, title }) => (
    <div className="nuke-view-badge" title={title ?? text}>
        {text}
    </div>
);
