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

export interface NukeCheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    ariaLabel?: string;
    /** Hook class for the root label (preserves existing test/CSS hooks). */
    className?: string;
    /** Row content rendered after the box (text, icons). */
    children?: React.ReactNode;
}

/**
 * Shared themed checkbox replacing builtin checkbox inputs across the IDE.
 *
 * A real native input (focus + Space free, AT honest) under a painted box
 * on Theia checkbox tokens with a codicon check. The root stops click
 * propagation: checkboxes live inside clickable outline rows whose own
 * click must not fire (the input already stopped its own).
 */
export const NukeCheckbox: React.FC<NukeCheckboxProps> = ({ checked, onChange, disabled = false, ariaLabel, className, children }) => (
    <label
        className={`nuke-checkbox${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}`}
        onClick={(e) => e.stopPropagation()}
    >
        <input
            type="checkbox"
            className="nuke-checkbox-input"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            disabled={disabled}
            aria-label={ariaLabel}
        />
        <span className="nuke-checkbox-box" aria-hidden="true">
            <i className="codicon codicon-check" />
        </span>
        {children}
    </label>
);
