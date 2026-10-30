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

import * as React from 'react';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCBinnedPair, OpenMCCell, OpenMCMaterial, OpenMCMesh } from '../../../../common/openmc-state-schema';
import { getMeshElementCount } from '../../../../common/mesh-utils';
import { getReactionLabel, normalizeReactionBin, PINNED_REACTIONS, searchReactions } from '../../../../common/reaction-catalog';
import type { OpenMCParticleType } from '../../../../common/particle-types';
import type { OpenMCCompat } from '../../../../common/openmc-studio-protocol';
import { ParticleTypeMultiSelector } from '../../shared/particle-type-selector';

/**
 * Two-column cell/instance table with a geometry-backed cell picker.
 */
export const CellInstancePairsEditor: React.FC<{
    pairs: OpenMCBinnedPair[];
    cells: OpenMCCell[];
    onChange: (pairs: OpenMCBinnedPair[]) => void;
}> = ({ pairs, cells, onChange }) => {
    const updateRow = (row: number, updates: Partial<OpenMCBinnedPair>) => {
        const next = pairs.map((pair, index) => (index === row ? { ...pair, ...updates } : pair));
        onChange(next);
    };
    const removeRow = (row: number) => onChange(pairs.filter((_, index) => index !== row));
    const addRow = () => onChange([...pairs, { first: cells[0]?.id ?? 1, second: 0 }]);

    return (
        <div className="form-group filter-pair-editor">
            <div className="filter-pair-heading">
                <label>Cell instances</label>
                <span className="filter-pair-count">
                    {pairs.length} pair{pairs.length === 1 ? '' : 's'}
                </span>
            </div>
            <div className="filter-pair-scroll">
                <table className="filter-pair-table">
                    <thead>
                        <tr>
                            <th scope="col">Cell</th>
                            <th scope="col">Instance</th>
                            <th scope="col" aria-label="Actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {pairs.length === 0 && (
                            <tr>
                                <td colSpan={3} className="filter-pair-empty">
                                    No cell instances yet. Add the cell and instance (0 is the first occurrence).
                                </td>
                            </tr>
                        )}
                        {pairs.map((pair, row) => (
                            <tr key={row}>
                                <td>
                                    {cells.length > 0 ? (
                                        <NukeSelect
                                            value={String(pair.first)}
                                            options={cells.map((cell) => ({
                                                value: String(cell.id),
                                                label: `${cell.name || `Cell ${cell.id}`} · ${cell.id}`
                                            }))}
                                            onChange={(value: string) => updateRow(row, { first: parseInt(value, 10) || 0 })}
                                            ariaLabel={`Cell instance ${row + 1} cell`}
                                        />
                                    ) : (
                                        <input
                                            type="number"
                                            min={1}
                                            step={1}
                                            value={pair.first}
                                            aria-label={`Cell instance ${row + 1} cell`}
                                            onChange={(e) => updateRow(row, { first: parseInt(e.target.value, 10) || 0 })}
                                        />
                                    )}
                                </td>
                                <td>
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={pair.second}
                                        aria-label={`Cell instance ${row + 1} instance`}
                                        onChange={(e) => updateRow(row, { second: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </td>
                                <td>
                                    <Tooltip content="Remove this cell instance" position="top">
                                        <button
                                            className="remove-filter-btn"
                                            aria-label={`Remove cell instance ${row + 1}`}
                                            onClick={() => removeRow(row)}
                                        >
                                            <i className="codicon codicon-trash"></i>
                                        </button>
                                    </Tooltip>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <button className="add-button filter-pair-add" onClick={addRow}>
                + Add cell instance
            </button>
            <p className="form-hint">
                Instance 0 is the first occurrence of the cell in the geometry; lattice repeats use 1, 2, and so on.
                {cells.length === 0 && ' No cells are defined yet, so enter the cell ID directly.'}
            </p>
        </div>
    );
};

/**
 * Mesh element + material pair table. Element indices are zero-based to match
 * `openmc.MeshMaterialFilter`.
 */
export const MeshMaterialPairsEditor: React.FC<{
    pairs: OpenMCBinnedPair[];
    materials: OpenMCMaterial[];
    mesh?: OpenMCMesh;
    onChange: (pairs: OpenMCBinnedPair[]) => void;
}> = ({ pairs, materials, mesh, onChange }) => {
    const elementCount = mesh ? getMeshElementCount(mesh) : undefined;
    const updateRow = (row: number, updates: Partial<OpenMCBinnedPair>) => {
        const next = pairs.map((pair, index) => (index === row ? { ...pair, ...updates } : pair));
        onChange(next);
    };
    const removeRow = (row: number) => onChange(pairs.filter((_, index) => index !== row));
    const addRow = () => onChange([...pairs, { first: 0, second: materials[0]?.id ?? 1 }]);

    return (
        <div className="form-group filter-pair-editor">
            <div className="filter-pair-heading">
                <label>Mesh element / material pairs</label>
                <span className="filter-pair-count">
                    {pairs.length} pair{pairs.length === 1 ? '' : 's'}
                    {elementCount !== undefined ? ` · ${elementCount} elements` : ''}
                </span>
            </div>
            <div className="filter-pair-scroll">
                <table className="filter-pair-table">
                    <thead>
                        <tr>
                            <th scope="col">Element (0-based)</th>
                            <th scope="col">Material</th>
                            <th scope="col" aria-label="Actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {pairs.length === 0 && (
                            <tr>
                                <td colSpan={3} className="filter-pair-empty">
                                    No element/material pairs yet. Element indices start at 0.
                                </td>
                            </tr>
                        )}
                        {pairs.map((pair, row) => (
                            <tr key={row}>
                                <td>
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={pair.first}
                                        aria-label={`Mesh material ${row + 1} element`}
                                        onChange={(e) => updateRow(row, { first: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </td>
                                <td>
                                    {materials.length > 0 ? (
                                        <NukeSelect
                                            value={String(pair.second)}
                                            options={materials.map((material) => ({
                                                value: String(material.id),
                                                label: `${material.name || `Material ${material.id}`} · ${material.id}`
                                            }))}
                                            onChange={(value: string) => updateRow(row, { second: parseInt(value, 10) || 0 })}
                                            ariaLabel={`Mesh material ${row + 1} material`}
                                        />
                                    ) : (
                                        <input
                                            type="number"
                                            min={1}
                                            step={1}
                                            value={pair.second}
                                            aria-label={`Mesh material ${row + 1} material`}
                                            onChange={(e) => updateRow(row, { second: parseInt(e.target.value, 10) || 0 })}
                                        />
                                    )}
                                </td>
                                <td>
                                    <Tooltip content="Remove this element/material pair" position="top">
                                        <button
                                            className="remove-filter-btn"
                                            aria-label={`Remove mesh material ${row + 1}`}
                                            onClick={() => removeRow(row)}
                                        >
                                            <i className="codicon codicon-trash"></i>
                                        </button>
                                    </Tooltip>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <button className="add-button filter-pair-add" onClick={addRow}>
                + Add element/material
            </button>
            <p className="form-hint">
                Each row scores one mesh element/material combination; element indices are zero-based and pairs keep the order shown here.
            </p>
        </div>
    );
};

/**
 * Parent-nuclide name list with an add field and removable chips.
 */
export const NuclideBinsEditor: React.FC<{ values: string[]; onChange: (values: string[]) => void }> = ({ values, onChange }) => {
    const [draft, setDraft] = React.useState('');
    const addNames = () => {
        const names = draft
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
        if (names.length === 0) {
            return;
        }
        const next = [...values];
        for (const name of names) {
            if (!next.includes(name)) {
                next.push(name);
            }
        }
        onChange(next);
        setDraft('');
    };
    return (
        <div className="form-group filter-name-editor">
            <label>Parent nuclides</label>
            {values.length > 0 && (
                <div className="filter-chip-list">
                    {values.map((name) => (
                        <span className="filter-chip" key={name}>
                            {name}
                            <Tooltip content={`Remove ${name}`} position="top">
                                <button
                                    className="filter-chip-remove"
                                    aria-label={`Remove parent nuclide ${name}`}
                                    onClick={() => onChange(values.filter((value) => value !== name))}
                                >
                                    <i className="codicon codicon-close"></i>
                                </button>
                            </Tooltip>
                        </span>
                    ))}
                </div>
            )}
            <div className="filter-name-row">
                <input
                    type="text"
                    value={draft}
                    aria-label="Parent nuclide names"
                    placeholder="e.g. U235 Pu239"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addNames();
                        }
                    }}
                />
                <button className="add-button" onClick={addNames} disabled={!draft.trim()}>
                    + Add
                </button>
            </div>
            <p className="form-hint">Only events whose parent nuclide matches one of these names are binned.</p>
        </div>
    );
};

/**
 * Searchable ENDF MT/name picker with common reactions pinned.
 */
export const ReactionBinsEditor: React.FC<{ values: string[]; onChange: (values: string[]) => void }> = ({ values, onChange }) => {
    const [query, setQuery] = React.useState('');
    const [error, setError] = React.useState<string | undefined>();
    const results = searchReactions(query);
    const addReaction = (bin: string) => {
        const canonical = normalizeReactionBin(bin);
        if (!canonical) {
            setError(`"${bin}" is not a known OpenMC reaction. Use a valid MT number or reaction name such as (n,gamma).`);
            return;
        }
        setError(undefined);
        if (!values.includes(canonical)) {
            onChange([...values, canonical]);
        }
        setQuery('');
    };
    const addFromQuery = () => {
        if (query.trim()) {
            addReaction(query);
        }
    };

    return (
        <div className="form-group filter-reaction-editor">
            <label>Reactions</label>
            {values.length > 0 && (
                <div className="filter-chip-list">
                    {values.map((name) => (
                        <span className="filter-chip" key={name}>
                            {getReactionLabel(name)}
                            <Tooltip content={`Remove ${name}`} position="top">
                                <button
                                    className="filter-chip-remove"
                                    aria-label={`Remove reaction ${name}`}
                                    onClick={() => onChange(values.filter((value) => value !== name))}
                                >
                                    <i className="codicon codicon-close"></i>
                                </button>
                            </Tooltip>
                        </span>
                    ))}
                </div>
            )}
            <div className="filter-name-row">
                <input
                    type="text"
                    value={query}
                    aria-label="Search reactions"
                    placeholder="Search name or MT, e.g. (n,gamma) or 102"
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setError(undefined);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addFromQuery();
                        }
                    }}
                />
                <button className="add-button" onClick={addFromQuery} disabled={!query.trim()}>
                    + Add
                </button>
            </div>
            {error && <p className="validation-error">{error}</p>}
            <div className="filter-reaction-suggestions" aria-label="Pinned reactions">
                {PINNED_REACTIONS.map((reaction) => (
                    <button
                        key={reaction.mt}
                        className="filter-reaction-suggestion"
                        aria-label={`Add reaction ${reaction.name}`}
                        onClick={() => addReaction(reaction.name)}
                    >
                        {reaction.name} <span>MT {reaction.mt}</span>
                    </button>
                ))}
            </div>
            {query.trim() && results.length > 0 && (
                <div className="filter-reaction-results">
                    {results.map((reaction) => (
                        <button
                            key={`${reaction.mt}-${reaction.name}`}
                            className="filter-reaction-suggestion"
                            aria-label={`Add reaction ${reaction.name}`}
                            onClick={() => addReaction(reaction.name)}
                        >
                            {reaction.name} <span>MT {reaction.mt}</span>
                        </button>
                    ))}
                </div>
            )}
            <p className="form-hint">
                Bins keep their insertion order. Integer MT numbers are converted to OpenMC's canonical reaction name.
            </p>
        </div>
    );
};

/**
 * Secondary-particle multi-select with optional energy binning.
 */
export const ParticleProductionEditor: React.FC<{
    particles: OpenMCParticleType[];
    energies: number[];
    supported?: boolean;
    compat?: OpenMCCompat;
    onChange: (updates: { particleTypes?: OpenMCParticleType[]; productionEnergyBins?: number[] }) => void;
}> = ({ particles, energies, supported, compat, onChange }) => (
    <div className="form-group filter-particle-production">
        <ParticleTypeMultiSelector
            value={particles}
            onChange={(particleTypes) => onChange({ particleTypes })}
            scope="particle-production"
            compat={compat}
            ariaLabel="Secondary particles"
            label="Secondary particles"
        />
        <div className="form-group">
            <label>Secondary energy boundaries (eV, optional)</label>
            <input
                type="text"
                value={energies.join(' ')}
                aria-label="Secondary energy boundaries (eV)"
                placeholder="e.g. 0 1e5 1e6 2e7 (leave empty for un-binned production)"
                onChange={(e) =>
                    onChange({
                        productionEnergyBins: e.target.value
                            .split(/[\s,]+/)
                            .map((value) => parseFloat(value))
                            .filter((value) => !isNaN(value))
                    })
                }
            />
            <p className="form-hint">
                Optional strictly increasing boundaries; {Math.max(energies.length - 1, 0)} energy bin
                {energies.length - 1 === 1 ? '' : 's'} for each selected particle. Pair with the events score.
            </p>
        </div>
        {supported === false && (
            <p className="validation-warning">
                <i className="codicon codicon-warning"></i>
                This filter requires OpenMC 0.16 or newer. It stays in the project but is omitted from generated XML/Python until the
                environment is updated.
            </p>
        )}
    </div>
);
