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
 * Mate creation dialog.
 *
 * Mate-type dropdown in `MATE_TYPES` order, connector A/B pickers fed by the
 * viewport connector-pick mode (click adds to the dialog, right-click/Escape
 * cancels, picks guarded by `resolveConnectorPick`), a free-DOF hint line
 * from `freeDofsForMateType`, and the shared ghosted-preview checkbox driving
 * the `cad-preview` group (preview = both connectors at their solved poses;
 * failures clear silently).
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { MATE_TYPES, type AssemblyConnector, type AssemblyInstance, type MateType } from '../../../common/assembly-document';
import { freeDofHintText, resolveConnectorPick } from './assembly-view';
import { NukeDialog, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';

/** Draft mate submitted by the dialog. */
export interface MateDraft {
    readonly type: MateType;
    readonly instanceA: string;
    readonly connectorA: string;
    readonly instanceB: string;
    readonly connectorB: string;
}

interface MateDialogProps {
    readonly instances: readonly AssemblyInstance[];
    readonly connectors: readonly AssemblyConnector[];
    /** Connector picked in the viewport for side A/B (mirrors dress-up pick flow). */
    readonly pickedConnectorA?: string;
    readonly pickedConnectorB?: string;
    /** Enter viewport connector-pick mode for one side (click adds, right-click/Escape cancels). */
    readonly onPickConnector: (side: 'A' | 'B') => void;
    /** Ghosted preview toggle (both connectors at solved poses in `cad-preview`). */
    readonly previewEnabled: boolean;
    readonly onPreviewChange: (enabled: boolean) => void;
    readonly onSubmit: (draft: MateDraft) => void;
    readonly onClose: () => void;
}

function connectorLabel(connectors: readonly AssemblyConnector[], id: string | undefined): string {
    if (id === undefined || id === '') {
        return 'Pick in viewport…';
    }
    const connector = connectors.find((c) => c.id === id);
    return connector !== undefined ? `${connector.id} (${connector.instanceId})` : 'Pick in viewport…';
}

export function MateDialog(props: MateDialogProps): React.ReactElement {
    const [mateType, setMateType] = React.useState<MateType>('fixed');
    const [connectorA, setConnectorA] = React.useState(props.pickedConnectorA ?? '');
    const [connectorB, setConnectorB] = React.useState(props.pickedConnectorB ?? '');
    const [error, setError] = React.useState<string | undefined>(undefined);

    // Viewport picks flow in while the dialog stays open.
    React.useEffect(() => {
        if (props.pickedConnectorA !== undefined) {
            setConnectorA(props.pickedConnectorA);
        }
    }, [props.pickedConnectorA]);
    React.useEffect(() => {
        if (props.pickedConnectorB !== undefined) {
            setConnectorB(props.pickedConnectorB);
        }
    }, [props.pickedConnectorB]);

    const resolvedA = resolveConnectorPick(props.connectors, props.instances, connectorA);
    const resolvedB = resolveConnectorPick(props.connectors, props.instances, connectorB);

    const submit = (): void => {
        if (resolvedA === undefined || resolvedB === undefined) {
            setError('Pick two connectors in the viewport first (right-click or Escape cancels the pick).');
            return;
        }
        if (resolvedA.instanceId === resolvedB.instanceId) {
            setError('A mate cannot connect an instance to itself — pick connectors on two different instances.');
            return;
        }
        props.onSubmit({
            type: mateType,
            instanceA: resolvedA.instanceId,
            connectorA: resolvedA.id,
            instanceB: resolvedB.instanceId,
            connectorB: resolvedB.id
        });
    };

    return (
        <NukeDialog
            title="Add Mate"
            onClose={props.onClose}
            footer={
                <>
                    <button className="theia-button" onClick={submit}>
                        <span className="codicon codicon-check" /> Create
                    </button>
                    <button className="theia-button secondary" onClick={props.onClose}>
                        <span className="codicon codicon-close" /> Cancel
                    </button>
                </>
            }
        >
            {error !== undefined && <div className="cad-feature-dialog-error">{error}</div>}
            <div className="cad-feature-dialog-row">
                Mate type
                <NukeSelect
                    ariaLabel="Mate type"
                    value={mateType}
                    options={MATE_TYPES.map((type) => ({ value: type, label: type }))}
                    onChange={(value) => setMateType(value as MateType)}
                />
            </div>
            <div className="cad-feature-dialog-hint">{freeDofHintText(mateType)}</div>
            <div className="cad-feature-dialog-row">
                <span>Connector A</span>
                <span className="cad-mate-connector-label">{connectorLabel(props.connectors, connectorA)}</span>
                <button className="theia-button secondary" onClick={() => props.onPickConnector('A')}>
                    <span className="codicon codicon-target" /> Pick A
                </button>
            </div>
            <div className="cad-feature-dialog-row">
                <span>Connector B</span>
                <span className="cad-mate-connector-label">{connectorLabel(props.connectors, connectorB)}</span>
                <button className="theia-button secondary" onClick={() => props.onPickConnector('B')}>
                    <span className="codicon codicon-target" /> Pick B
                </button>
            </div>
            <label className="cad-feature-dialog-row check">
                <input type="checkbox" checked={props.previewEnabled} onChange={(e) => props.onPreviewChange(e.target.checked)} />
                Preview (ghosted build)
            </label>
        </NukeDialog>
    );
}
