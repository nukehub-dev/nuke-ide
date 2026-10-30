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

export interface NukeSliderProps {
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    disabled?: boolean;
    ariaLabel?: string;
    /** Hook class for the native input (preserves existing test/CSS hooks). */
    className?: string;
    /** Layout passthrough on the root. */
    style?: React.CSSProperties;
}

/**
 * Shared themed slider replacing `input[type=range]` rows across the IDE.
 *
 * A real native range input (arrows/Home/End free) with a painted track:
 * gradient fill to the value percent on Theia tokens, custom thumbs for
 * Chromium and Firefox (line width stays driver-dependent, as before).
 */
export const NukeSlider: React.FC<NukeSliderProps> = ({
    value,
    min,
    max,
    step,
    onChange,
    disabled = false,
    ariaLabel,
    className,
    style
}) => {
    const span = max - min;
    const percent = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
    return (
        <div className="nuke-slider" style={style}>
            <input
                type="range"
                className={`nuke-slider-input${className ? ` ${className}` : ''}`}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                disabled={disabled}
                aria-label={ariaLabel}
                style={{
                    background: `linear-gradient(to right, var(--theia-focusBorder) 0%, var(--theia-focusBorder) ${percent}%, var(--theia-panel-border) ${percent}%, var(--theia-panel-border) 100%)`
                }}
            />
        </div>
    );
};
