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

export interface NukePanelProps {
    /** Title shown in the panel header. */
    title: React.ReactNode;
    /** When provided, a close button is rendered in the header. */
    onClose?: () => void;
    /** Extra class on the panel; use it for positioning (the panel does not position itself). */
    className?: string;
    /** Inline style overrides (e.g. position, width). */
    style?: React.CSSProperties;
    /** Extra class on the scrollable body. */
    bodyClassName?: string;
    children: React.ReactNode;
}

/**
 * Floating panel with a header, optional close button, and a scrollable
 * body. The panel does not position itself; callers supply placement via
 * `className`/`style` (e.g. absolute overlay coordinates).
 */
export const NukePanel: React.FC<NukePanelProps> = ({ title, onClose, className, style, bodyClassName, children }) => (
    <div className={`nuke-panel${className ? ` ${className}` : ''}`} style={style}>
        <div className="nuke-panel-header">
            <div className="nuke-panel-title">{title}</div>
            {onClose !== undefined && (
                <button className="theia-button secondary nuke-panel-close" onClick={onClose} title="Close">
                    <span className="codicon codicon-close" />
                </button>
            )}
        </div>
        <div className={`nuke-panel-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
    </div>
);
