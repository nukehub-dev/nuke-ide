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

import * as React from '@theia/core/shared/react';

export interface NukeToolbarProps {
    /** Extra class on the toolbar container. */
    className?: string;
    children: React.ReactNode;
}

/**
 * Toolbar container for grouped controls.
 *
 * Lays out `NukeToolbarGroup` children in a wrapping flex row; adjacent
 * groups are visually separated. The caller is responsible for constraining
 * the width (e.g. `max-width`) so wrapping engages before the toolbar
 * overflows its container.
 */
export const NukeToolbar: React.FC<NukeToolbarProps> = ({ className, children }) => (
    <div className={`nuke-toolbar${className ? ` ${className}` : ''}`} role="toolbar">
        {children}
    </div>
);

export interface NukeToolbarGroupProps {
    /** Accessible label describing the group. */
    label?: string;
    /** Extra class on the group. */
    className?: string;
    children: React.ReactNode;
}

/**
 * Logical group of toolbar controls. Groups never wrap internally; the
 * toolbar wraps between groups.
 */
export const NukeToolbarGroup: React.FC<NukeToolbarGroupProps> = ({ label, className, children }) => (
    <div className={`nuke-toolbar-group${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
        {children}
    </div>
);
