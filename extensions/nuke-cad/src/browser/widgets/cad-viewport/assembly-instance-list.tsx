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
 * Assembly instance list for the CAD viewport (Wave B2).
 *
 * Rows carry a **Ground here** action writing `groundedInstanceId` through
 * the store (explicit only — never defaulted), plus rename/delete affordances
 * and a DOF readout via `countAssemblyDof` beside the list.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import type { AssemblySection } from '../../document/cad-document-store';
import { assemblyDofRemaining } from './assembly-view';

interface AssemblyInstanceListProps {
    readonly assembly: AssemblySection | undefined;
    readonly onGround: (instanceId: string) => void;
    readonly onSelect: (instanceId: string) => void;
    readonly onDelete: (instanceId: string) => void;
    readonly onRename: (instanceId: string, newId: string) => void;
    readonly onAddInstance: (part: string) => void;
    readonly onAddMate: () => void;
}

export function AssemblyInstanceList(props: AssemblyInstanceListProps): React.ReactElement {
    const [part, setPart] = React.useState('');
    const [renamingId, setRenamingId] = React.useState<string | undefined>(undefined);
    const [renameValue, setRenameValue] = React.useState('');
    const assembly = props.assembly;
    const dof = assembly !== undefined ? assemblyDofRemaining(assembly) : 0;

    const submitAdd = (): void => {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
            return;
        }
        props.onAddInstance(trimmed);
        setPart('');
    };

    return (
        <div className="cad-assembly-panel">
            <div className="cad-assembly-header">
                <i className="codicon codicon-nuke-cad-assembly" />
                <span>Assembly</span>
                {assembly !== undefined && assembly.instances.length > 0 && (
                    <span className="cad-assembly-dof" title="Remaining rigid-body DOFs: 6 per ungrounded instance minus constrained DOFs">
                        {dof} DOF
                    </span>
                )}
            </div>
            {assembly === undefined || assembly.instances.length === 0 ? (
                <div className="cad-assembly-empty">No instances yet — add a part below to start an assembly.</div>
            ) : (
                <div className="cad-assembly-rows">
                    {assembly.instances.map((instance) => {
                        const grounded = assembly.groundedInstanceId === instance.id;
                        return (
                            <div key={instance.id} className={`cad-assembly-row${grounded ? ' grounded' : ''}`}>
                                <span className="codicon codicon-nuke-cad-cube cad-assembly-icon" />
                                {renamingId === instance.id ? (
                                    <input
                                        className="cad-assembly-rename-input"
                                        value={renameValue}
                                        autoFocus
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                props.onRename(instance.id, renameValue.trim());
                                                setRenamingId(undefined);
                                            } else if (e.key === 'Escape') {
                                                setRenamingId(undefined);
                                            }
                                        }}
                                        onBlur={() => setRenamingId(undefined)}
                                    />
                                ) : (
                                    <span
                                        className="cad-assembly-label"
                                        title={`${instance.part}${grounded ? ' (grounded)' : ''} — click to select, double-click to rename`}
                                        onClick={() => props.onSelect(instance.id)}
                                        onDoubleClick={() => {
                                            setRenamingId(instance.id);
                                            setRenameValue(instance.id);
                                        }}
                                    >
                                        {instance.id}
                                    </span>
                                )}
                                <span className="cad-assembly-part" title={instance.part}>
                                    {instance.part}
                                </span>
                                {grounded ? (
                                    <span className="cad-assembly-grounded-badge" title="Grounded instance (fixed in assembly space)">
                                        grounded
                                    </span>
                                ) : (
                                    <button
                                        className="theia-button secondary cad-assembly-action"
                                        title="Ground here — fix this instance in assembly space"
                                        onClick={() => props.onGround(instance.id)}
                                    >
                                        Ground here
                                    </button>
                                )}
                                <button
                                    className="theia-button secondary cad-assembly-action"
                                    title="Delete instance (cascades to its connectors and mates)"
                                    onClick={() => props.onDelete(instance.id)}
                                >
                                    <span className="codicon codicon-trash" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
            <div className="cad-assembly-add">
                <input
                    className="cad-assembly-part-input"
                    placeholder="Part: ./bracket.nuke-cad or body:<id>"
                    value={part}
                    onChange={(e) => setPart(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            submitAdd();
                        }
                    }}
                />
                <button className="theia-button secondary" onClick={submitAdd}>
                    <span className="codicon codicon-add" /> Instance
                </button>
                {assembly !== undefined && assembly.instances.length > 0 && (
                    <button className="theia-button secondary" onClick={props.onAddMate}>
                        <span className="codicon codicon-nuke-cad-mate" /> Mate…
                    </button>
                )}
            </div>
        </div>
    );
}
