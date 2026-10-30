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
 * Pure action model for the shared {@link ViewerNavBar}: one bottom-bar
 * variant (ISO/T/F/R + fit + zoom) used by the nuke-cad viewport and the
 * nuke-visualizer native viewers.
 *
 * The actions are view names only — the host maps them onto its own orbit
 * handle, whose snap directions differ (Y-up three.js convention in
 * nuke-visualizer, Z-up in nuke-cad). Icons are Theia codicon class names
 * (plain strings, no `@theia/*` import) so this module stays Theia-free.
 */

/** View actions offered by the shared viewer bottom bar. */
export type ViewerNavAction = 'iso' | 'top' | 'front' | 'right' | 'fit' | 'zoom-in' | 'zoom-out';

/** One bottom-bar control: a text button (`label`), an icon button (`icon`), or neither (invalid). */
export interface ViewerNavItem {
    readonly action: ViewerNavAction;
    readonly tooltip: string;
    /** Text caption for the standard-view buttons (ISO/T/F/R). */
    readonly label?: string;
    /** Codicon name (without the `codicon-` prefix) for the fit/zoom buttons. */
    readonly icon?: string;
}

/** The seven bottom-bar controls in render order (standard views, then fit + zoom). */
export const VIEWER_NAV_ITEMS: readonly ViewerNavItem[] = [
    { action: 'iso', label: 'ISO', tooltip: 'Iso view' },
    { action: 'top', label: 'T', tooltip: 'Top view' },
    { action: 'front', label: 'F', tooltip: 'Front view' },
    { action: 'right', label: 'R', tooltip: 'Right view' },
    { action: 'fit', icon: 'screen-full', tooltip: 'Fit view' },
    { action: 'zoom-in', icon: 'zoom-in', tooltip: 'Zoom in' },
    { action: 'zoom-out', icon: 'zoom-out', tooltip: 'Zoom out' }
];

/** Type guard for action strings arriving from untyped call sites. */
export function isViewerNavAction(action: string): action is ViewerNavAction {
    return VIEWER_NAV_ITEMS.some((item) => item.action === action);
}
