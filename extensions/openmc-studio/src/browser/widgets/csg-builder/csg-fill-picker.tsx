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
import { NukeSearchInput } from 'nuke-essentials/lib/theme/browser/components';

import { buildFillTargetGroups, FillTarget, FillTargetKind, filterFillTargetGroups, findFillTarget } from '../../../common/geometry-editor';
import { OpenMCFillType, OpenMCState } from '../../../common/openmc-state-schema';

export interface CSGFillTargetPickerProps {
    /** Current model (materials, universes, lattices). */
    state: OpenMCState;
    /** Selected fill type. */
    fillType: OpenMCFillType;
    /** Selected target id (unused for void). */
    fillId?: number;
    /** Select a material/universe/lattice target. */
    onSelect: (kind: FillTargetKind, id: number) => void;
    /** Clear the fill (void). */
    onSelectVoid: () => void;
}

/**
 * Searchable, type-grouped fill picker for the cell editor. Rows show
 * `#id name` plus a type badge; universe 0 is never offered because OpenMC
 * cannot use the root universe as a fill.
 */
export const CSGFillTargetPicker: React.FC<CSGFillTargetPickerProps> = ({ state, fillType, fillId, onSelect, onSelectVoid }) => {
    const [query, setQuery] = React.useState('');
    const groups = React.useMemo(() => buildFillTargetGroups(state), [state.materials, state.geometry.universes, state.geometry.lattices]);
    const filtered = React.useMemo(() => filterFillTargetGroups(groups, query), [groups, query]);
    const selected =
        fillType === 'material' || fillType === 'universe' || fillType === 'lattice' ? findFillTarget(groups, fillType, fillId) : undefined;
    const isEmpty = groups.length === 0;

    return (
        <div className="csg-fill-picker">
            <div className="csg-fill-picker-header">
                <div className="csg-fill-current" aria-live="polite">
                    {selected ? (
                        <>
                            <span className={`fill-target-badge ${selected.kind}`}>{selected.badge}</span>
                            <span className="csg-fill-current-label">{selected.label}</span>
                        </>
                    ) : (
                        <>
                            <span className="fill-target-badge void">Void</span>
                            <span className="csg-fill-current-label">Empty space (no material)</span>
                        </>
                    )}
                </div>
                {selected && (
                    <button type="button" className="theia-button secondary small" onClick={onSelectVoid}>
                        <i className="codicon codicon-circle-outline" aria-hidden="true"></i>
                        Void
                    </button>
                )}
            </div>

            {isEmpty ? (
                <div className="csg-fill-empty">
                    <i className="codicon codicon-info" aria-hidden="true"></i>
                    <span>
                        No materials, universes, or lattices yet. Create one in the Materials, Universes, or Lattices tab, or keep this cell
                        void.
                    </span>
                </div>
            ) : (
                <>
                    <NukeSearchInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search fills by #id or name…"
                        ariaLabel="Search fill targets"
                        className="csg-fill-search"
                    />
                    <div className="csg-fill-target-list" role="group" aria-label="Fill targets">
                        {filtered.length === 0 ? (
                            <span className="csg-fill-empty-text">No fills match “{query}”.</span>
                        ) : (
                            filtered.map((group) => (
                                <div key={group.kind} className="csg-fill-target-group" data-kind={group.kind}>
                                    <div className="csg-fill-target-group-header">{group.label}</div>
                                    {group.targets.map((target) => (
                                        <FillTargetRow
                                            key={`${target.kind}-${target.id}`}
                                            target={target}
                                            selected={selected?.kind === target.kind && selected.id === target.id}
                                            onSelect={() => onSelect(target.kind, target.id)}
                                        />
                                    ))}
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

interface FillTargetRowProps {
    target: FillTarget;
    selected: boolean;
    onSelect: () => void;
}

/** One focusable fill target row. */
const FillTargetRow: React.FC<FillTargetRowProps> = ({ target, selected, onSelect }) => (
    <button
        type="button"
        className={`csg-fill-target ${target.kind}${selected ? ' selected' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
    >
        <span className={`fill-target-badge ${target.kind}`}>{target.badge}</span>
        <span className="csg-fill-target-label">{target.label}</span>
        {selected && <i className="codicon codicon-check" aria-hidden="true"></i>}
    </button>
);
