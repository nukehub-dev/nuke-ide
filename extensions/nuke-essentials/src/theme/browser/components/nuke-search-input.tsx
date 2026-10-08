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

export interface NukeSearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    /** Hook class for the native input (preserves existing test/CSS hooks). */
    className?: string;
    disabled?: boolean;
}

/**
 * Shared search field replacing filter inputs across the IDE: codicon
 * magnifier, Theia input chrome, and a clear button while non-empty
 * (Escape clears too, keeping focus for the next query).
 */
export const NukeSearchInput: React.FC<NukeSearchInputProps> = ({
    value,
    onChange,
    placeholder = 'Filter…',
    ariaLabel,
    className,
    disabled = false
}) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const clear = () => {
        onChange('');
        inputRef.current?.focus();
    };
    return (
        <div className="nuke-search-input">
            <i className="codicon codicon-search nuke-search-input-icon" />
            <input
                ref={inputRef}
                type="search"
                className={`nuke-search-input-field${className ? ` ${className}` : ''}`}
                placeholder={placeholder}
                aria-label={ariaLabel}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape' && value !== '') {
                        e.stopPropagation();
                        clear();
                    }
                }}
                disabled={disabled}
            />
            {value !== '' && !disabled && (
                <button type="button" className="nuke-search-clear" aria-label="Clear search" onClick={clear}>
                    <i className="codicon codicon-close" />
                </button>
            )}
        </div>
    );
};
