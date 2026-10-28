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
 * Bill-of-materials panel.
 *
 * Lists one row per assembly instance — instance id, part source, joining
 * mate type, DOF contribution — with a click selecting the instance's solids
 * in the viewport through the shared {@link NukeCadStateManager}. Opened via
 * the `nuke.cad.openBomPanel` command (right area) or the Nuke Tools sidebar
 * (`CAD Studio → BOM`).
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common/disposable';
import { NukeCadStateManager } from '../../state/nuke-cad-state-manager';
import { CadDocumentStore, getAssemblySection } from '../../document/cad-document-store';
import { buildBomRows, instanceSolidIds, type BomRow } from '../cad-viewport/assembly-view';
import './bom-panel.css';

@injectable()
export class CadBomPanelWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-bom-panel-widget';
    static readonly LABEL = 'BOM';

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = CadBomPanelWidget.ID;
        this.title.label = CadBomPanelWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-nuke-cad-bom';

        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.update())));
        this.toDispose.push(this.stateManager.onModelChange(() => this.update()));
        this.update();
    }

    /**
     * Select an instance's solids in the viewport via the shared state
     * manager. A no-op while the assembly's `<instanceId>/…` selector keys have not
     * landed (nothing built for the instance yet).
     */
    protected selectInstance(instanceId: string): void {
        const solids = instanceSolidIds(this.stateManager.model?.result.selectorMap, instanceId);
        if (solids.length === 0) {
            return;
        }
        this.stateManager.setSelection({ solidId: solids[0], solidIds: solids });
    }

    protected render(): React.ReactNode {
        const assembly = this.documentStore.document !== undefined ? getAssemblySection(this.documentStore.document) : undefined;
        const rows: BomRow[] = assembly !== undefined ? buildBomRows(assembly) : [];
        return (
            <CadBomPanelComponent
                rows={rows}
                hasModel={this.stateManager.model !== undefined}
                onSelect={(instanceId) => this.selectInstance(instanceId)}
            />
        );
    }
}

interface CadBomPanelComponentProps {
    readonly rows: readonly BomRow[];
    readonly hasModel: boolean;
    readonly onSelect: (instanceId: string) => void;
}

function CadBomPanelComponent(props: CadBomPanelComponentProps): React.ReactElement {
    return (
        <div className="cad-bom-panel">
            <div className="cad-bom-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-nuke-cad-bom" />
                        BOM
                    </h2>
                    <p className="header-description">
                        {props.rows.length === 0
                            ? 'No assembly instances'
                            : `${props.rows.length} instance${props.rows.length === 1 ? '' : 's'}`}
                    </p>
                </div>
            </div>
            {props.rows.length === 0 ? (
                <div className="cad-bom-empty">
                    <i className="codicon codicon-nuke-cad-bom" />
                    <p>No assembly instances.</p>
                    <span className="empty-hint">Add part instances in the CAD viewport assembly panel to list them here.</span>
                </div>
            ) : (
                <div className="cad-bom-table">
                    <div className="cad-bom-head">
                        <span className="cad-bom-th">Instance</span>
                        <span className="cad-bom-th">Part source</span>
                        <span className="cad-bom-th">Mate</span>
                        <span className="cad-bom-th num">DOF</span>
                    </div>
                    {props.rows.map((row) => (
                        <div key={row.instanceId} className="cad-bom-tr" onClick={() => props.onSelect(row.instanceId)}>
                            <span className="cad-bom-cell instance" title={row.grounded ? `${row.instanceId} (grounded)` : row.instanceId}>
                                <i className="codicon codicon-nuke-cad-cube" />
                                {row.instanceId}
                                {row.grounded && <span className="cad-bom-grounded">grounded</span>}
                            </span>
                            <span className="cad-bom-cell part" title={row.part}>
                                {row.part}
                            </span>
                            <span className="cad-bom-cell mate">{row.mateType ?? '—'}</span>
                            <span className="cad-bom-cell num">
                                {row.grounded ? '0 (ground)' : row.mateType === undefined ? '6 (free)' : `−${row.dofContribution}`}
                            </span>
                        </div>
                    ))}
                    {!props.hasModel && <div className="cad-bom-hint">Build the document to enable viewport selection sync.</div>}
                </div>
            )}
        </div>
    );
}
