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
 * The floating card drags by its header and collapses to that header; position
 * is session-scoped UI state via `useDraggablePanel`, never document state.
 * Rows carry a **Ground here** action writing `groundedInstanceId` through the
 * store (explicit only — never defaulted), plus rename/delete affordances
 * and a DOF readout via `assemblyDofRemaining` beside the count.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import type { AssemblySection } from '../../document/cad-document-store';
import { assemblyDofRemaining } from './assembly-view';
import { headerRegionTarget, useDraggablePanel } from './draggable-panel';

interface AssemblyInstanceListProps {
    readonly assembly: AssemblySection | undefined;
    readonly onGround: (instanceId: string) => void;
    readonly onSelect: (instanceId: string) => void;
    readonly onDelete: (instanceId: string) => void;
    readonly onRename: (instanceId: string, newId: string) => void;
    readonly onAddInstance: (part: string) => void;
    readonly onAddMate: () => void;
}

const ASSEMBLY_HEADER_TARGET = headerRegionTarget('.cad-assembly-header');
const ASSEMBLY_PART_TITLE =
    'Part source: a .nuke-cad document path, an imported STEP/IGES/BREP file path, or body:<id> from this document.';

export function AssemblyInstanceList(props: AssemblyInstanceListProps): React.ReactElement {
    const [part, setPart] = React.useState('');
    const [renamingId, setRenamingId] = React.useState<string | undefined>(undefined);
    const [renameValue, setRenameValue] = React.useState('');
    const [collapsed, setCollapsed] = React.useState(false);
    const partInputId = React.useId();
    const drag = useDraggablePanel({ canDrag: ASSEMBLY_HEADER_TARGET, canResetFrom: ASSEMBLY_HEADER_TARGET });
    const assembly = props.assembly;
    const instances = assembly !== undefined ? assembly.instances : [];
    const instanceCount = instances.length;
    const hasInstances = instanceCount > 0;
    const dof = assembly !== undefined ? assemblyDofRemaining(assembly) : 0;
    const canAdd = part.trim().length > 0;

    const submitAdd = (): void => {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
            return;
        }
        props.onAddInstance(trimmed);
        setPart('');
    };

    return (
        <div
            ref={drag.panelRef}
            className={`cad-assembly-panel${collapsed ? ' collapsed' : ''}`}
            style={drag.style}
            role="region"
            aria-label="Assembly"
        >
            <div className="cad-assembly-header" title="Drag to move; double-click or right-click to reset position" {...drag.handleProps}>
                <i className="codicon codicon-nuke-cad-assembly" />
                <span className="cad-assembly-title">Assembly</span>
                <span className="cad-assembly-count">{instanceCount} instances</span>
                <span className="cad-assembly-spacer" />
                {hasInstances && (
                    <span className="cad-assembly-dof" title="Remaining rigid-body DOFs: 6 per ungrounded instance minus constrained DOFs">
                        {dof} DOF
                    </span>
                )}
                <button
                    type="button"
                    className="theia-button secondary cad-assembly-collapse"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? 'Expand assembly panel' : 'Collapse assembly panel'}
                    title={collapsed ? 'Expand assembly panel' : 'Collapse assembly panel'}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <span className={`codicon ${collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}`} />
                </button>
            </div>
            {!collapsed && (
                <div className="cad-assembly-body">
                    {!hasInstances ? (
                        <div className="cad-assembly-empty">
                            <div className="cad-assembly-empty-title">No instances yet.</div>
                            <div className="cad-assembly-empty-hint">
                                Add a .nuke-cad part, a STEP file, or a body:&lt;id&gt; from this document.
                            </div>
                        </div>
                    ) : (
                        <div className="cad-assembly-rows">
                            {instances.map((instance) => {
                                const grounded = assembly?.groundedInstanceId === instance.id;
                                return (
                                    <div key={instance.id} className={`cad-assembly-row${grounded ? ' grounded' : ''}`}>
                                        <span className="codicon codicon-nuke-cad-cube cad-assembly-icon" />
                                        {renamingId === instance.id ? (
                                            <input
                                                className="cad-assembly-rename-input"
                                                type="text"
                                                aria-label={`Rename instance ${instance.id}`}
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
                                            <span
                                                className="cad-assembly-grounded-badge"
                                                title="Grounded instance (fixed in assembly space)"
                                            >
                                                grounded
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                className="theia-button secondary cad-assembly-action"
                                                title="Ground here — fix this instance in assembly space"
                                                onClick={() => props.onGround(instance.id)}
                                            >
                                                Ground here
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="theia-button secondary cad-assembly-action cad-assembly-delete"
                                            title="Delete instance (cascades to its connectors and mates)"
                                            aria-label={`Delete instance ${instance.id}`}
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
                        <div className="cad-assembly-add-row">
                            <label className="cad-assembly-add-label" htmlFor={partInputId}>
                                Part
                            </label>
                            <input
                                id={partInputId}
                                className="cad-assembly-part-input"
                                type="text"
                                aria-label="Assembly part"
                                placeholder="./part.nuke-cad, .step, or body:<id>"
                                title={ASSEMBLY_PART_TITLE}
                                value={part}
                                onChange={(e) => setPart(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        submitAdd();
                                    }
                                }}
                            />
                        </div>
                        <div className="cad-assembly-add-actions">
                            {hasInstances && (
                                <button type="button" className="theia-button secondary cad-assembly-add-mate" onClick={props.onAddMate}>
                                    <span className="codicon codicon-nuke-cad-mate" /> Mate…
                                </button>
                            )}
                            <button
                                type="button"
                                className={canAdd ? 'theia-button' : 'theia-button secondary'}
                                disabled={!canAdd}
                                onClick={submitAdd}
                            >
                                <span className="codicon codicon-add" /> Instance
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
