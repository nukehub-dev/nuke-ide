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
 * BOM panel contract tests: rows (instance id, part source, mate type, DOF
 * contribution) and click → viewport selection sync through
 * `NukeCadStateManager` (B1 `<instanceId>/…` selector keys; no-op until those
 * land). Widget-chrome free: exercises the same pure path the panel renders.
 */

import { describe, it, expect, vi } from 'vitest';
import { CadDocumentStore } from '../../document/cad-document-store';
import { buildBomRows, instanceSolidIds } from '../cad-viewport/assembly-view';

describe('bom panel rows', () => {
    it('lists one row per instance with mate type and DOF contribution', () => {
        const store = new CadDocumentStore();
        store.createDocument('bom-test');
        const a = store.addInstance('./base.nuke-cad').value!;
        const b = store.addInstance('./arm.nuke-cad').value!;
        expect(store.setGrounded(a).success).toBe(true);
        const ca = store.addConnector(a, [0, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        const cb = store.addConnector(b, [0, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        expect(store.addMate('revolute', a, ca, b, cb).success).toBe(true);

        const rows = buildBomRows(store.document!.assembly!);
        expect(rows.map((r) => r.instanceId).sort()).toEqual([a, b].sort());
        const arm = rows.find((r) => r.instanceId === b)!;
        expect(arm.part).toBe('./arm.nuke-cad');
        expect(arm.mateType).toBe('revolute');
        expect(arm.dofContribution).toBe(5);
        expect(rows.find((r) => r.instanceId === a)!.grounded).toBe(true);
    });

    it('is empty for single-part documents', () => {
        const store = new CadDocumentStore();
        store.createDocument('single');
        expect(store.document!.assembly).toBeUndefined();
    });
});

describe('bom panel selection sync', () => {
    it('click selects the instance group via the state manager', () => {
        const selectorMap = { 'inst-1/body-1': [2, 3] };
        const setSelection = vi.fn();
        const stateManager = { setSelection } as unknown as { setSelection: (s: unknown) => void };

        // Same path as CadBomPanelWidget.selectInstance.
        const selectInstance = (instanceId: string): void => {
            const solids = instanceSolidIds(selectorMap, instanceId);
            if (solids.length === 0) {
                return;
            }
            stateManager.setSelection({ solidId: solids[0], solidIds: solids });
        };

        selectInstance('inst-1');
        expect(setSelection).toHaveBeenCalledWith({ solidId: 2, solidIds: [2, 3] });
        setSelection.mockClear();
        selectInstance('missing');
        expect(setSelection).not.toHaveBeenCalled();
    });
});
