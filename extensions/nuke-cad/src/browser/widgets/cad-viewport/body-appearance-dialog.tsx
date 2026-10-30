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
import {
    ColorPicker,
    NukeCheckbox,
    NukeDialog,
    NukeFormRow,
    NukeSelect,
    NukeSlider,
    Tooltip
} from 'nuke-essentials/lib/theme/browser/components';
import { BODY_APPEARANCE_DEFAULT_COLOR, BODY_APPEARANCE_DEFAULT_OPACITY, type AppearancePreset } from './body-appearance';

export interface BodyAppearanceTarget {
    readonly bodyId: string;
    /** Body display label (`name` / `name · label`) shown as the dialog subtitle. */
    readonly label: string;
}

export interface BodyAppearanceDialogProps {
    readonly target: BodyAppearanceTarget;
    /** Current document override, or undefined when the body follows the theme. */
    readonly appearance?: BodyAppearance;
    /** User-level presets (already normalized by the widget). */
    readonly presets: readonly AppearancePreset[];
    /** Every distinct body id owning the current viewport selection. */
    readonly selectionBodyIds?: readonly string[];
    readonly onApply: (appearance: BodyAppearance) => void;
    /** OK with "Apply to all selected bodies" checked. */
    readonly onApplyToBodies?: (bodyIds: readonly string[], appearance: BodyAppearance) => void;
    readonly onRemove: () => void;
    /** Remove override with "Apply to all selected bodies" checked. */
    readonly onRemoveFromBodies?: (bodyIds: readonly string[]) => void;
    /** Ask for a name and persist the given appearance as a user preset; resolves to the saved name. */
    readonly onSavePreset?: (appearance: BodyAppearance) => Promise<string | undefined>;
    readonly onDeletePreset?: (name: string) => Promise<void>;
    readonly onClose: () => void;
}

const NO_PRESET = '';

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
}

export function BodyAppearanceDialog(props: BodyAppearanceDialogProps): React.ReactElement {
    const [color, setColor] = React.useState(props.appearance?.color ?? BODY_APPEARANCE_DEFAULT_COLOR);
    const [opacityPercent, setOpacityPercent] = React.useState(
        clampPercent((props.appearance?.opacity ?? BODY_APPEARANCE_DEFAULT_OPACITY) * 100)
    );
    const [selectedPreset, setSelectedPreset] = React.useState(NO_PRESET);
    const [applyToSelection, setApplyToSelection] = React.useState(false);
    const hasOverride = props.appearance !== undefined;
    const selectionBodyIds = props.selectionBodyIds ?? [];
    const canApplyToSelection = selectionBodyIds.length > 1;
    const activePreset =
        selectedPreset !== NO_PRESET && props.presets.some((preset) => preset.name === selectedPreset) ? selectedPreset : NO_PRESET;

    const draftAppearance = (): BodyAppearance => ({ color, opacity: opacityPercent / 100 });

    const selectPreset = (name: string): void => {
        setSelectedPreset(name);
        if (name === NO_PRESET) {
            return;
        }
        const preset = props.presets.find((entry) => entry.name === name);
        if (preset !== undefined) {
            setColor(preset.color);
            setOpacityPercent(clampPercent(preset.opacity * 100));
        }
    };

    const savePreset = async (): Promise<void> => {
        if (props.onSavePreset === undefined) {
            return;
        }
        const saved = await props.onSavePreset(draftAppearance());
        if (saved !== undefined) {
            setSelectedPreset(saved);
        }
    };

    const deletePreset = async (): Promise<void> => {
        if (activePreset === NO_PRESET || props.onDeletePreset === undefined) {
            return;
        }
        await props.onDeletePreset(activePreset);
        setSelectedPreset(NO_PRESET);
    };

    const submit = (): void => {
        const appearance = draftAppearance();
        if (applyToSelection && canApplyToSelection && props.onApplyToBodies !== undefined) {
            props.onApplyToBodies(selectionBodyIds, appearance);
            return;
        }
        props.onApply(appearance);
    };

    const remove = (): void => {
        if (applyToSelection && canApplyToSelection && props.onRemoveFromBodies !== undefined) {
            props.onRemoveFromBodies(selectionBodyIds);
            return;
        }
        props.onRemove();
    };

    const presetOptions = [
        { value: NO_PRESET, label: 'None' },
        ...props.presets.map((preset) => ({ value: preset.name, label: preset.name }))
    ];

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
                        <button className="theia-button secondary cad-body-appearance-remove" onClick={remove}>
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
            <NukeFormRow label="Preset">
                <div className="cad-body-appearance-preset">
                    <NukeSelect
                        value={activePreset}
                        options={presetOptions}
                        onChange={selectPreset}
                        ariaLabel="Appearance preset"
                        placeholder="None"
                        style={{ flex: '1 1 auto', minWidth: 0 }}
                    />
                    <button
                        className="theia-button secondary cad-body-appearance-preset-save"
                        onClick={() => void savePreset()}
                        disabled={props.onSavePreset === undefined}
                        title="Save the current color and opacity as a preset"
                    >
                        Save preset…
                    </button>
                    <Tooltip content="Delete preset" position="left">
                        <button
                            className="theia-button secondary cad-body-appearance-preset-delete"
                            onClick={() => void deletePreset()}
                            disabled={activePreset === NO_PRESET || props.onDeletePreset === undefined}
                            aria-label="Delete preset"
                        >
                            <span className="codicon codicon-trash" />
                        </button>
                    </Tooltip>
                </div>
            </NukeFormRow>
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
            {canApplyToSelection && (
                <NukeFormRow checkbox>
                    <NukeCheckbox checked={applyToSelection} onChange={setApplyToSelection} ariaLabel="Apply to all selected bodies">
                        Apply to all selected bodies
                    </NukeCheckbox>
                </NukeFormRow>
            )}
        </NukeDialog>
    );
}
