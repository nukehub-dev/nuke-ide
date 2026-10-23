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

/**
 * Per-body Appearance dialog.
 *
 * Local draft state over a body's display-only `appearance` override: color
 * (`#rrggbb`) and opacity. OK submits both values as an override, Remove
 * override clears the document entry, Cancel/close discards the draft. The
 * dialog never touches the document itself — the widget owns store calls and
 * error reporting.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import * as React from '@theia/core/shared/react';
import type { BodyAppearance } from '../../../common/cad-document';
import { ColorPicker, NukeDialog, NukeFormRow, NukeSlider } from 'nuke-essentials/lib/theme/browser/components';
import { BODY_APPEARANCE_DEFAULT_COLOR, BODY_APPEARANCE_DEFAULT_OPACITY } from './body-appearance';

export interface BodyAppearanceTarget {
    readonly bodyId: string;
    /** Body display label (`name` / `name · label`) shown as the dialog subtitle. */
    readonly label: string;
}

export interface BodyAppearanceDialogProps {
    readonly target: BodyAppearanceTarget;
    /** Current document override, or undefined when the body follows the theme. */
    readonly appearance?: BodyAppearance;
    readonly onApply: (appearance: BodyAppearance) => void;
    readonly onRemove: () => void;
    readonly onClose: () => void;
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
}

export function BodyAppearanceDialog(props: BodyAppearanceDialogProps): React.ReactElement {
    const [color, setColor] = React.useState(props.appearance?.color ?? BODY_APPEARANCE_DEFAULT_COLOR);
    const [opacityPercent, setOpacityPercent] = React.useState(
        clampPercent((props.appearance?.opacity ?? BODY_APPEARANCE_DEFAULT_OPACITY) * 100)
    );
    const hasOverride = props.appearance !== undefined;

    const submit = (): void => {
        props.onApply({ color, opacity: opacityPercent / 100 });
    };

    return (
        <NukeDialog
            title={
                <div className="cad-body-appearance-title">
                    <span>Appearance</span>
                    <span className="cad-body-appearance-subtitle">{props.target.label}</span>
                </div>
            }
            onClose={props.onClose}
            maxWidth={360}
            footer={
                <>
                    {hasOverride && (
                        <button className="theia-button secondary cad-body-appearance-remove" onClick={props.onRemove}>
                            <span className="codicon codicon-discard" /> Remove override
                        </button>
                    )}
                    <button className="theia-button secondary" onClick={props.onClose}>
                        Cancel
                    </button>
                    <button className="theia-button" onClick={submit}>
                        OK
                    </button>
                </>
            }
        >
            <NukeFormRow label="Color">
                <ColorPicker value={color} onChange={setColor} />
            </NukeFormRow>
            <NukeFormRow label="Opacity">
                <div className="cad-body-appearance-opacity">
                    <NukeSlider
                        value={opacityPercent}
                        min={0}
                        max={100}
                        step={5}
                        onChange={(value) => setOpacityPercent(clampPercent(value))}
                        ariaLabel="Opacity"
                    />
                    <input
                        className="cad-body-appearance-percent"
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        value={opacityPercent}
                        aria-label="Opacity percent"
                        onChange={(event) => {
                            const next = Number(event.target.value);
                            if (event.target.value !== '' && Number.isFinite(next)) {
                                setOpacityPercent(clampPercent(next));
                            }
                        }}
                    />
                    <span className="cad-body-appearance-percent-unit">%</span>
                </div>
            </NukeFormRow>
        </NukeDialog>
    );
}
