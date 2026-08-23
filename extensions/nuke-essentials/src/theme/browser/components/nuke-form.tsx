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

export interface NukeSectionProps {
    /** Section heading. */
    title?: React.ReactNode;
    /** Codicon name shown before the title (without the `codicon-` prefix). */
    icon?: string;
    /** Extra class on the section card. */
    className?: string;
    children: React.ReactNode;
}

/**
 * Card container for a group of related settings, following the
 * `settings-section` pattern used by openmc-studio widgets.
 */
export const NukeSection: React.FC<NukeSectionProps> = ({ title, icon, className, children }) => (
    <section className={`nuke-section${className ? ` ${className}` : ''}`}>
        {title !== undefined && (
            <h3 className="nuke-section-title">
                {icon !== undefined && <i className={`codicon codicon-${icon}`} />}
                {title}
            </h3>
        )}
        {children}
    </section>
);

export interface NukeFormRowProps {
    /** Label rendered above the control. */
    label?: React.ReactNode;
    /** Muted helper text rendered below the control. */
    hint?: React.ReactNode;
    /** Render as an inline checkbox row (label next to the control). */
    checkbox?: boolean;
    /** Extra class on the row. */
    className?: string;
    children: React.ReactNode;
}

/**
 * Form layout primitive: a labelled control with optional hint, following
 * the `form-group` pattern used by openmc-studio widgets. Set `checkbox`
 * for checkbox rows where the label sits next to the input.
 */
export const NukeFormRow: React.FC<NukeFormRowProps> = ({ label, hint, checkbox = false, className, children }) => (
    <div className={`nuke-form-row${checkbox ? ' checkbox' : ''}${className ? ` ${className}` : ''}`}>
        {label !== undefined && <label className="nuke-form-row-label">{label}</label>}
        <div className="nuke-form-row-control">{children}</div>
        {hint !== undefined && <span className="nuke-form-row-hint">{hint}</span>}
    </div>
);
