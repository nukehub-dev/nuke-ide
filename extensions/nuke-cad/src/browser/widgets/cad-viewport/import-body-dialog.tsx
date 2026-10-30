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
 * “Import CAD as Body…” dialog.
 *
 * Shows the inspected source solids (index/name/faces/volume/bbox), lets the
 * user select all or individual solids, choose one body for the selection or
 * one body per solid, name the body, and override the detected source unit.
 * The dialog owns only local draft state; the widget re-inspects on a unit
 * override, commits the atomic `addImportBodies` batch, saves, and rebuilds.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import * as React from '@theia/core/shared/react';
import type { DocumentUnits, ImportSourceUnit } from '../../../common/cad-document';
import type { ImportSolidInfo, InspectImportSourceResult } from '../../../common/nuke-cad-protocol';
import { NukeCheckbox, NukeDialog, NukeFormRow, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { normalizeImportSourceUnit, type ImportBodyChoice, type ImportBodyStrategy } from './import-body';

/** No-override sentinel for the source-unit select (NukeSelect needs a string). */
const DETECTED_UNIT = '';

export interface ImportBodyDialogProps {
    /** Result of `inspectImportSource` for the copied source. */
    readonly inspection: InspectImportSourceResult;
    /** Default body label (source file stem). */
    readonly sourceLabel: string;
    /** Document length unit; undefined for a legacy/empty unitless document. */
    readonly documentUnits?: DocumentUnits;
    /** True while the widget re-inspects or commits; disables the actions. */
    readonly busy?: boolean;
    readonly onConfirm: (choice: ImportBodyChoice) => void;
    readonly onCancel: () => void;
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
}

function bboxText(solid: ImportSolidInfo): string {
    if (solid.bboxMin.length < 3 || solid.bboxMax.length < 3) {
        return '—';
    }
    const size = [0, 1, 2].map((axis) => solid.bboxMax[axis] - solid.bboxMin[axis]);
    return size.map(formatNumber).join(' × ');
}

function solidLabel(solid: ImportSolidInfo): string {
    const name = solid.name?.trim();
    return name !== undefined && name.length > 0 ? name : `Solid ${solid.index}`;
}

/** Dialog-local draft state can be reset from one inspection snapshot. */
function initialSelection(solids: readonly ImportSolidInfo[]): Set<number> {
    return new Set(solids.map((solid) => solid.index));
}

export function ImportBodyDialog(props: ImportBodyDialogProps): React.ReactElement {
    const solids = React.useMemo(() => props.inspection.solids ?? [], [props.inspection]);
    const detectedUnit = normalizeImportSourceUnit(props.inspection.fileUnit) ?? normalizeImportSourceUnit(props.inspection.effectiveUnit);
    const [strategy, setStrategy] = React.useState<ImportBodyStrategy>('single');
    const [label, setLabel] = React.useState(props.sourceLabel);
    const [unit, setUnit] = React.useState<string>(DETECTED_UNIT);
    const [selected, setSelected] = React.useState<Set<number>>(() => initialSelection(solids));
    const [error, setError] = React.useState<string | undefined>(undefined);
    const busy = props.busy === true;

    const allSelected = solids.length > 0 && selected.size === solids.length;
    const bodyCount = selected.size === 0 ? 0 : strategy === 'single' ? 1 : selected.size;
    const selectionSummary =
        selected.size === 0
            ? 'No solids selected.'
            : strategy === 'single'
              ? `Creates 1 body and 1 import feature from ${selected.size} selected solid${selected.size === 1 ? '' : 's'} (1 undo entry).`
              : `Creates ${selected.size} bod${selected.size === 1 ? 'y' : 'ies'} and ${selected.size} import feature${
                    selected.size === 1 ? '' : 's'
                }, one per selected solid (1 undo entry).`;
    const displayUnit = props.inspection.effectiveUnit ?? props.documentUnits ?? 'units';

    const unitOptions = [
        { value: DETECTED_UNIT, label: detectedUnit !== undefined ? `Detected (${detectedUnit})` : 'Detected' },
        { value: 'mm', label: 'Millimetres (mm)' },
        { value: 'cm', label: 'Centimetres (cm)' },
        { value: 'm', label: 'Metres (m)' }
    ];

    const toggleSolid = (index: number, checked: boolean): void => {
        const next = new Set(selected);
        if (checked) {
            next.add(index);
        } else {
            next.delete(index);
        }
        setSelected(next);
        setError(undefined);
    };

    const toggleAll = (checked: boolean): void => {
        setSelected(checked ? initialSelection(solids) : new Set());
        setError(undefined);
    };

    const submit = (): void => {
        if (busy) {
            return;
        }
        const trimmed = label.trim();
        if (trimmed.length === 0) {
            setError('Enter a body label.');
            return;
        }
        if (selected.size === 0) {
            setError('Select at least one source solid to import.');
            return;
        }
        const override = unit === DETECTED_UNIT ? undefined : (unit as ImportSourceUnit);
        props.onConfirm({
            strategy,
            label: trimmed,
            // Selecting the detected unit is not an override; keep the params
            // minimal and skip the confirm-time re-inspection.
            sourceUnit: override === detectedUnit ? undefined : override,
            solidIndexes: [...selected].sort((a, b) => a - b)
        });
    };

    return (
        <NukeDialog
            title={
                <div className="cad-import-body-title">
                    <span>Import CAD as Body</span>
                    <span className="cad-import-body-subtitle">{props.sourceLabel}</span>
                </div>
            }
            onClose={busy ? undefined : props.onCancel}
            className="cad-import-body-dialog"
            maxWidth={760}
            footer={
                <>
                    <span className="cad-import-body-summary" role="status" aria-live="polite">
                        {selectionSummary}
                    </span>
                    <button className="theia-button secondary" onClick={props.onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button className="theia-button" onClick={submit} disabled={busy || selected.size === 0 || label.trim().length === 0}>
                        {busy ? 'Importing…' : bodyCount > 1 ? `Import ${bodyCount} Bodies` : 'Import Body'}
                    </button>
                </>
            }
        >
            <div className="cad-import-body-source">
                <span className="codicon codicon-file-symlink-file" />
                <span className="cad-import-body-source-name">{props.sourceLabel}</span>
                {props.inspection.sourceFormat !== undefined && (
                    <span className="cad-import-body-source-chip">{props.inspection.sourceFormat.toUpperCase()}</span>
                )}
                <span className="cad-import-body-source-chip">
                    {solids.length} solid{solids.length === 1 ? '' : 's'}
                </span>
                {props.inspection.sourceSize !== undefined && (
                    <span className="cad-import-body-source-chip">{formatNumber(props.inspection.sourceSize)} bytes</span>
                )}
            </div>

            <div className="cad-import-body-note">
                <span className="codicon codicon-info" />
                <span>
                    {props.inspection.unitsMessage ??
                        (props.documentUnits !== undefined
                            ? `Source numbers are scaled to the document unit (${props.documentUnits}).`
                            : 'This document has no units; native source numbers are kept.')}
                </span>
            </div>
            {props.inspection.warnings !== undefined && props.inspection.warnings.length > 0 && (
                <ul className="cad-import-body-warnings">
                    {props.inspection.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                    ))}
                </ul>
            )}

            <div className="cad-import-body-table-wrap">
                <table className="cad-import-body-table" aria-label="Source solids">
                    <thead>
                        <tr>
                            <th scope="col" className="cad-import-body-checkbox-cell">
                                <NukeCheckbox checked={allSelected} onChange={toggleAll} ariaLabel="Select all source solids" />
                            </th>
                            <th scope="col">#</th>
                            <th scope="col">Name</th>
                            <th scope="col" className="cad-import-body-number-cell">
                                Faces
                            </th>
                            <th scope="col" className="cad-import-body-number-cell">
                                Volume ({displayUnit})
                            </th>
                            <th scope="col">BBox ({displayUnit})</th>
                        </tr>
                    </thead>
                    <tbody>
                        {solids.map((solid) => {
                            const isSelected = selected.has(solid.index);
                            return (
                                <tr key={solid.index} className={isSelected ? 'selected' : undefined}>
                                    <td className="cad-import-body-checkbox-cell">
                                        <NukeCheckbox
                                            checked={isSelected}
                                            onChange={(checked) => toggleSolid(solid.index, checked)}
                                            ariaLabel={`Select ${solidLabel(solid)}`}
                                        />
                                    </td>
                                    <td className="cad-import-body-index-cell">{solid.index}</td>
                                    <td className="cad-import-body-name-cell" title={solid.name}>
                                        {solidLabel(solid)}
                                    </td>
                                    <td className="cad-import-body-number-cell">{formatNumber(solid.faceCount)}</td>
                                    <td className="cad-import-body-number-cell">{formatNumber(solid.volume)}</td>
                                    <td className="cad-import-body-bbox-cell">{bboxText(solid)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <NukeFormRow label="Body label">
                <input
                    type="text"
                    className="cad-import-body-label-input"
                    value={label}
                    aria-label="Body label"
                    onChange={(event) => {
                        setLabel(event.target.value);
                        setError(undefined);
                    }}
                />
            </NukeFormRow>

            <fieldset className="cad-import-body-strategy">
                <legend>Body strategy</legend>
                <label>
                    <input
                        type="radio"
                        name="nuke-cad-import-body-strategy"
                        checked={strategy === 'single'}
                        onChange={() => setStrategy('single')}
                    />
                    One body for selected solids
                </label>
                <label>
                    <input
                        type="radio"
                        name="nuke-cad-import-body-strategy"
                        checked={strategy === 'perSolid'}
                        onChange={() => setStrategy('perSolid')}
                    />
                    One body per selected solid
                </label>
            </fieldset>

            <NukeFormRow
                label="Source unit"
                hint="Override the unit declared by the file (for sources with metre-scale numbers but a millimetre header)."
            >
                <NukeSelect value={unit} options={unitOptions} onChange={setUnit} ariaLabel="Source unit override" />
            </NukeFormRow>

            {error !== undefined && (
                <div className="cad-import-body-error" role="alert">
                    {error}
                </div>
            )}
        </NukeDialog>
    );
}
