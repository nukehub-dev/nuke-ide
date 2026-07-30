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

/** Props for {@link CollapsibleSection}. */
export interface CollapsibleSectionProps {
    /** Section title shown in the header. */
    title: string;
    /** Optional codicon name (without the `codicon-` prefix) shown before the title. */
    icon?: string;
    /** Whether the section starts expanded (default: true). */
    defaultOpen?: boolean;
    /** Optional actions rendered in the header (clicks do not toggle the section). */
    actions?: React.ReactNode;
    children?: React.ReactNode;
}

/**
 * Collapsible wrapper around a settings section: a clickable `h3` header with a
 * chevron that shows/hides the section content. Uses the existing
 * `settings-section` styling.
 * @param props - {@link CollapsibleSectionProps}.
 * @returns The section React element.
 */
export function CollapsibleSection(props: CollapsibleSectionProps): React.ReactNode {
    const [open, setOpen] = React.useState(props.defaultOpen ?? true);

    return (
        <div className="settings-section">
            <h3 onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
                <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`}></i>
                {props.icon && <i className={`codicon codicon-${props.icon}`}></i>}
                {props.title}
                {props.actions && <span onClick={(e) => e.stopPropagation()}>{props.actions}</span>}
            </h3>
            {open && props.children}
        </div>
    );
}
