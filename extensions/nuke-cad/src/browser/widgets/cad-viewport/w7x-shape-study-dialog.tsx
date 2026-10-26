// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * W7-X native coil shape-study configuration dialog.
 *
 * The module count is locked to the valid five-module layout; only the
 * section width/height, tilt, twist, and loft stations are editable. The
 * dialog never mutates the document: it validates the draft and hands a
 * complete config to the viewport widget on Create.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { NukeDialog } from 'nuke-essentials/lib/theme/browser/components';
import type { W7xShapeStudyConfig } from '../../../common/w7x-shape-study';
import {
    W7X_SHAPE_STUDY_APPROXIMATE_WARNING,
    W7X_SHAPE_STUDY_INVENTORY,
    W7X_SHAPE_STUDY_NO_PREVIEW_NOTE,
    defaultW7xShapeStudyDraft,
    formatW7xShapeStudyReferenceVolume,
    validateW7xShapeStudyDraft,
    type W7xShapeStudyDraft
} from './w7x-shape-study-model';
import { W7X_STUDY_EXPORT_NOTE } from './w7x-study-model';

export interface W7xShapeStudyDialogProps {
    /** Initial parameter values; defaults to the planner defaults. */
    readonly initialConfig?: W7xShapeStudyConfig;
    /** True while the widget plans/installs/saves the document. */
    readonly busy?: boolean;
    readonly onConfirm: (config: W7xShapeStudyConfig) => void;
    readonly onCancel: () => void;
}

function field(
    draft: W7xShapeStudyDraft,
    key: keyof W7xShapeStudyDraft,
    setDraft: (next: W7xShapeStudyDraft) => void
): (event: React.ChangeEvent<HTMLInputElement>) => void {
    return (event) => setDraft({ ...draft, [key]: event.target.value });
}

/** Dialog body + footer; local state is the five editable parameter strings. */
export function W7xShapeStudyDialog(props: W7xShapeStudyDialogProps): React.ReactElement {
    const [draft, setDraft] = React.useState<W7xShapeStudyDraft>(() => defaultW7xShapeStudyDraft(props.initialConfig));
    const busy = props.busy === true;
    const validation = validateW7xShapeStudyDraft(draft);

    return (
        <NukeDialog
            title="Create W7-X Coil Shape Study"
            onClose={busy ? undefined : props.onCancel}
            className="cad-w7x-study-dialog cad-w7x-shape-study-dialog"
            maxWidth={680}
            footer={
                <>
                    <span className="cad-w7x-study-footer-note" role="status" aria-live="polite">
                        Creates 10 native coil bodies and 50 instances across 5 modules.
                    </span>
                    <button className="theia-button secondary" onClick={props.onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button
                        className="theia-button"
                        onClick={() => {
                            if (validation.ok) {
                                props.onConfirm(validation.config);
                            }
                        }}
                        disabled={busy || !validation.ok}
                    >
                        {busy ? 'Creating study…' : 'Create Study'}
                    </button>
                </>
            }
        >
            <div className="cad-w7x-study-inventory" aria-label="Shape-study inventory">
                {W7X_SHAPE_STUDY_INVENTORY}
            </div>

            <div className="cad-w7x-study-warning" role="alert">
                <span className="codicon codicon-warning" />
                <div>
                    <strong>{W7X_SHAPE_STUDY_APPROXIMATE_WARNING}</strong>
                    <div>
                        Ten native sweeps are placed across the five valid modules for visual comparison and editing.{' '}
                        {W7X_STUDY_EXPORT_NOTE}; use the imported W7-X generator when exact reference geometry is required.
                    </div>
                </div>
            </div>

            <div className="cad-w7x-shape-grid">
                <label className="cad-feature-dialog-row">
                    Section width (m)
                    <input type="number" min={0} step="any" value={draft.width} onChange={field(draft, 'width', setDraft)} autoFocus />
                </label>
                <label className="cad-feature-dialog-row">
                    Section height (m)
                    <input type="number" min={0} step="any" value={draft.height} onChange={field(draft, 'height', setDraft)} />
                </label>
                <label className="cad-feature-dialog-row">
                    Tilt (°)
                    <input type="number" min={-89} max={89} step="any" value={draft.tiltDeg} onChange={field(draft, 'tiltDeg', setDraft)} />
                </label>
                <label className="cad-feature-dialog-row">
                    Twist (°)
                    <input type="number" step="any" value={draft.twistDeg} onChange={field(draft, 'twistDeg', setDraft)} />
                </label>
                <label className="cad-feature-dialog-row">
                    Stations
                    <input type="number" min={8} max={720} step={1} value={draft.stations} onChange={field(draft, 'stations', setDraft)} />
                </label>
            </div>

            <div className="cad-w7x-shape-note">
                <span>
                    Reference total coil volume (one module): <strong>{formatW7xShapeStudyReferenceVolume()}</strong> · display only
                </span>
                <span className="cad-w7x-shape-note-muted">{W7X_SHAPE_STUDY_NO_PREVIEW_NOTE}</span>
            </div>

            {!validation.ok && (
                <div className="cad-feature-dialog-error" role="alert">
                    {validation.error}
                </div>
            )}
        </NukeDialog>
    );
}
