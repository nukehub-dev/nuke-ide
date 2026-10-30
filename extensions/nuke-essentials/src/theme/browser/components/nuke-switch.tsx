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

export interface NukeSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    ariaLabel?: string;
    /** Hook class for the root button (preserves existing test/CSS hooks). */
    className?: string;
}

/**
 * Shared on/off switch for panel-level show/enable toggles (docs-kit Switch
 * spring → CSS transform transition). Per-item list visibility stays
 * `NukeCheckbox` — do not mix the two grammars in one panel.
 */
export const NukeSwitch: React.FC<NukeSwitchProps> = ({ checked, onChange, disabled = false, ariaLabel, className }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
            if (!disabled) {
                onChange(!checked);
            }
        }}
        className={`nuke-switch${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
    >
        <span className="nuke-switch-knob" aria-hidden="true" />
    </button>
);
