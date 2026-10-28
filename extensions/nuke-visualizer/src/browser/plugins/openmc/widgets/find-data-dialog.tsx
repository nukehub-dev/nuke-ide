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
 * Props-only Find Data dialog body (D2): pick a point/cell array, type a
 * closed selection query, preview the live match count, then hand the chosen
 * tuple indices to the host.
 *
 * No Theia DI, no store, no global state: the host owns dataset filtering,
 * selection lifetime, 3D highlighting, and CSV delivery. `onSelect` receives
 * a fresh `Uint32Array` (ascending tuple indices) for the active association
 * and array; `onClear` clears the host's transient selection; the optional
 * `onExtractCsv` receives the same triple so the host can write a CSV or open
 * the selection in another tab. The component never mutates array data.
 *
 * The card is self-contained (title + form + actions). Hosts can float it in
 * a `.find-data-dialog` popover, or wrap it in `NukeDialog`/`NukePanel` for a
 * modal/docked placement.
 */

import * as React from 'react';
import { NukeBadge, NukeEmptyState, NukeSelect, type NukeSelectOption } from 'nuke-essentials/lib/theme/browser/components';
import {
    SelectionQueryError,
    evaluateSelectionQuery,
    formatSelectionNumber,
    formatSelectionSummary,
    parseSelectionQuery,
    selectionTupleCount,
    type SelectionQueryResult,
    type SelectionQuerySource
} from '../../../viewer-core/selection-query';
import './find-data-dialog.css';

/** Dataset association the query runs against. */
export type FindDataAssociation = 'point' | 'cell';

/**
 * One queryable array. The first five fields mirror a parsed VTK data array;
 * `names`/`associations` are optional categorical labels and per-tuple ids
 * (without `associations`, `id` means the 0-based tuple index).
 */
export interface FindDataArray {
    readonly name: string;
    readonly association: FindDataAssociation;
    readonly components: number;
    readonly values: ArrayLike<number>;
    readonly range: readonly [number, number];
    readonly names?: readonly string[];
    readonly associations?: ArrayLike<number>;
}

/** Host contract for the Find Data dialog. */
export interface FindDataDialogProps {
    readonly arrays: readonly FindDataArray[];
    /** Highlight/apply the selection; indices are ascending tuple indices. */
    readonly onSelect: (association: FindDataAssociation, name: string, indices: Uint32Array) => void;
    /** Clear the host's transient selection. */
    readonly onClear: () => void;
    /** Optional CSV/extract action with the same selection triple. */
    readonly onExtractCsv?: (association: FindDataAssociation, name: string, indices: Uint32Array) => void;
}

interface QueryEvaluation {
    readonly result?: SelectionQueryResult;
    readonly error?: string;
}

/** Debounce window for re-running the query while typing (large arrays scan linearly). */
const QUERY_DEBOUNCE_MS = 120;

function toSource(array: FindDataArray): SelectionQuerySource {
    return {
        values: array.values,
        components: array.components,
        names: array.names,
        associations: array.associations
    };
}

function toSelectOptions(arrays: readonly FindDataArray[]): NukeSelectOption[] {
    return arrays.map((array) => ({
        value: array.name,
        label: array.components > 1 ? `${array.name} (${array.components} components)` : array.name
    }));
}

function evaluate(text: string, array: FindDataArray | undefined): QueryEvaluation {
    if (array === undefined || text.trim().length === 0) {
        return {};
    }
    try {
        const query = parseSelectionQuery(text);
        return { result: evaluateSelectionQuery(query, toSource(array)) };
    } catch (error) {
        return { error: error instanceof SelectionQueryError ? error.message : String(error) };
    }
}

export const FindDataDialog: React.FC<FindDataDialogProps> = ({ arrays, onSelect, onClear, onExtractCsv }) => {
    const associations = React.useMemo(() => {
        const unique: FindDataAssociation[] = [];
        for (const array of arrays) {
            if (!unique.includes(array.association)) {
                unique.push(array.association);
            }
        }
        return unique;
    }, [arrays]);
    const [association, setAssociation] = React.useState<FindDataAssociation>(() => arrays[0]?.association ?? 'point');
    const [arrayName, setArrayName] = React.useState(() => arrays[0]?.name ?? '');
    const [queryText, setQueryText] = React.useState('');
    const [liveText, setLiveText] = React.useState('');

    React.useEffect(() => {
        const timer = window.setTimeout(() => setLiveText(queryText), QUERY_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [queryText]);

    const activeAssociation = associations.includes(association) ? association : associations[0];
    const associationArrays = React.useMemo(
        () => arrays.filter((array) => array.association === activeAssociation),
        [arrays, activeAssociation]
    );
    const activeArray = associationArrays.find((array) => array.name === arrayName) ?? associationArrays[0];
    const arrayOptions = React.useMemo(() => toSelectOptions(associationArrays), [associationArrays]);
    const associationOptions = React.useMemo<NukeSelectOption[]>(
        () => associations.map((value) => ({ value, label: value === 'point' ? 'Point' : 'Cell' })),
        [associations]
    );

    const evaluation = React.useMemo(() => evaluate(liveText, activeArray), [liveText, activeArray]);
    const result = evaluation.result;
    const tupleTotal = activeArray ? selectionTupleCount(toSource(activeArray)) : 0;
    const canApply = activeArray !== undefined && result !== undefined && result.matched > 0;

    const apply = (): void => {
        if (activeArray !== undefined && result !== undefined && result.matched > 0) {
            onSelect(activeArray.association, activeArray.name, result.indices);
        }
    };
    const extract = (): void => {
        if (activeArray !== undefined && result !== undefined && result.matched > 0 && onExtractCsv !== undefined) {
            onExtractCsv(activeArray.association, activeArray.name, result.indices);
        }
    };
    const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter' && canApply) {
            event.preventDefault();
            apply();
        }
    };

    return (
        <div className="find-data-dialog" role="group" aria-label="Find Data">
            <div className="find-data-dialog-title">
                <span className="codicon codicon-search" aria-hidden="true" />
                <span>Find Data</span>
                {activeArray !== undefined && (
                    <span className="find-data-dialog-range">
                        Range {formatSelectionNumber(activeArray.range[0])} … {formatSelectionNumber(activeArray.range[1])} ·{' '}
                        {tupleTotal.toLocaleString()} tuples
                    </span>
                )}
            </div>
            {arrays.length === 0 ? (
                <NukeEmptyState
                    icon="database"
                    title="No arrays to query"
                    message="This dataset has no point or cell arrays."
                    hint="Load a VTK dataset with named data arrays first."
                />
            ) : (
                <>
                    <div className="openmc-output-viewer-control find-data-dialog-row">
                        <span className="find-data-dialog-label">Association</span>
                        <NukeSelect
                            className="find-data-dialog-select"
                            ariaLabel="Array association"
                            value={activeAssociation ?? ''}
                            onChange={(value) => setAssociation(value === 'cell' ? 'cell' : 'point')}
                            options={associationOptions}
                        />
                        <span className="find-data-dialog-label">Array</span>
                        <NukeSelect
                            className="find-data-dialog-select find-data-dialog-array"
                            ariaLabel="Data array"
                            value={activeArray?.name ?? ''}
                            onChange={setArrayName}
                            options={arrayOptions}
                            disabled={arrayOptions.length <= 1}
                        />
                    </div>
                    <div className="openmc-output-viewer-control find-data-dialog-row">
                        <span className="find-data-dialog-label">Query</span>
                        <input
                            type="text"
                            className="find-data-dialog-query"
                            aria-label="Selection query"
                            placeholder="value >= 1.5 and id != 0"
                            value={queryText}
                            onChange={(event) => setQueryText(event.target.value)}
                            onKeyDown={onQueryKeyDown}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </div>
                    <div className="find-data-dialog-status">
                        {result !== undefined ? (
                            <NukeBadge className="find-data-dialog-count">{formatSelectionSummary(result)}</NukeBadge>
                        ) : (
                            <span className="find-data-dialog-idle">
                                {evaluation.error !== undefined ? 'Fix the query to preview matches.' : 'Type a query to preview matches.'}
                            </span>
                        )}
                        {activeArray?.names !== undefined && <span className="find-data-dialog-capability">name queries available</span>}
                    </div>
                    {evaluation.error !== undefined && (
                        <div className="find-data-dialog-error" role="alert">
                            <span className="codicon codicon-warning" aria-hidden="true" />
                            <span>{evaluation.error}</span>
                        </div>
                    )}
                    <div className="find-data-dialog-grammar" aria-label="Query grammar">
                        <code>value &gt;= 1.5</code>
                        <code>value in [0, 10]</code>
                        <code>id == 42</code>
                        <code>name contains fuel</code>
                        <span>combine with and</span>
                    </div>
                    <div className="find-data-dialog-actions">
                        <button type="button" className="theia-button secondary" onClick={onClear}>
                            Clear
                        </button>
                        <button
                            type="button"
                            className="theia-button secondary"
                            onClick={extract}
                            disabled={!canApply || onExtractCsv === undefined}
                        >
                            Extract CSV
                        </button>
                        <button type="button" className="theia-button" onClick={apply} disabled={!canApply}>
                            Select
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};
