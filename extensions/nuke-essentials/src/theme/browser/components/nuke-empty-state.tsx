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

export interface NukeEmptyStateProps {
    /** Codicon name shown above the title (without the `codicon-` prefix). */
    icon?: string;
    /** Custom illustration shown above the title; takes precedence over `icon`. */
    iconNode?: React.ReactNode;
    /** Primary heading. */
    title?: React.ReactNode;
    /** Descriptive message below the title. */
    message?: React.ReactNode;
    /** Small muted footer text (e.g. supported formats). */
    hint?: React.ReactNode;
    /** Extra class on the panel. */
    className?: string;
    /** Action buttons; rendered in a wrapping, centered row. */
    children?: React.ReactNode;
}

/**
 * Centered empty-state panel: a codicon or custom illustration, title, message,
 * optional hint, and an optional wrapping action row. Extends the ad-hoc
 * `EmptyState` pattern from `loading-spinner.tsx` with a title/hint and
 * theme-token CSS classes.
 */
export const NukeEmptyState: React.FC<NukeEmptyStateProps> = ({ icon, iconNode, title, message, hint, className, children }) => (
    <div className={`nuke-empty-state${className ? ` ${className}` : ''}`}>
        {iconNode !== undefined ? (
            <div className="nuke-empty-state-illustration" aria-hidden="true">
                {iconNode}
            </div>
        ) : (
            icon !== undefined && <span className={`codicon codicon-${icon} nuke-empty-state-icon`} />
        )}
        {title !== undefined && <div className="nuke-empty-state-title">{title}</div>}
        {message !== undefined && <div className="nuke-empty-state-message">{message}</div>}
        {hint !== undefined && <div className="nuke-empty-state-hint">{hint}</div>}
        {children !== undefined && <div className="nuke-empty-state-actions">{children}</div>}
    </div>
);
