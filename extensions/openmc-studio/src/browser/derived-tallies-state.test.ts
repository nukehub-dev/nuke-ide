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

import { describe, expect, it, vi } from 'vitest';

// The state manager only needs the event primitives and DI tokens for these
// CRUD tests; mock the browser-only Theia imports so vitest runs in node.
vi.mock('@theia/core/lib/common', () => {
    class Emitter<T> {
        private readonly listeners: ((value: T) => void)[] = [];
        readonly event = (listener: (value: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => undefined };
        };
        fire(value: T): void {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
    }
    return { Emitter, Event: class {} };
});
vi.mock('@theia/core/lib/common/message-service', () => ({ MessageService: class {} }));
vi.mock('@theia/core/lib/common/preferences', () => ({ PreferenceScope: {}, PreferenceService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCDerivedTally } from '../common/openmc-state-schema';
import { createDefaultState, OpenMCStateManager } from './openmc-state-manager';

function derived(id: number, name: string): OpenMCDerivedTally {
    return {
        id,
        name,
        expression: { kind: 'tally', tallyId: 1, score: 'flux' },
        unit: 'ratio',
        color: '#4a9eff'
    };
}

describe('derived-tally state CRUD', () => {
    it('starts from a state without derived tallies and assigns increasing IDs', () => {
        const manager = new OpenMCStateManager();
        manager.setState(createDefaultState(), false);

        expect(manager.getState().derivedTallies).toBeUndefined();
        expect(manager.getNextDerivedTallyId()).toBe(1);

        manager.addDerivedTally(derived(1, 'Flux ratio'));
        expect(manager.getNextDerivedTallyId()).toBe(2);
        expect(manager.isDirty).toBe(true);
        expect(manager.getState().derivedTallies).toHaveLength(1);
    });

    it('updates and deletes derived tallies while isolating returned copies', () => {
        const manager = new OpenMCStateManager();
        manager.setState(createDefaultState(), false);
        manager.addDerivedTally(derived(2, 'Capture / fission'));

        const copy = manager.getState();
        copy.derivedTallies![0].name = 'mutated copy';
        expect(manager.getState().derivedTallies![0].name).toBe('Capture / fission');

        manager.updateDerivedTally(2, { name: 'Capture-to-fission', unit: 'ratio' });
        expect(manager.getState().derivedTallies![0]).toMatchObject({ name: 'Capture-to-fission', unit: 'ratio' });

        manager.removeDerivedTally(2);
        expect(manager.getState().derivedTallies).toEqual([]);
        expect(manager.getNextDerivedTallyId()).toBe(1);
    });

    it('emits add/update/delete state-change events for derived tallies', () => {
        const manager = new OpenMCStateManager();
        manager.setState(createDefaultState(), false);
        const events: Array<{ path: string; type: string }> = [];
        manager.onStateChange((event) => events.push({ path: event.path, type: event.type }));

        manager.addDerivedTally(derived(1, 'Ratio'));
        manager.updateDerivedTally(1, { description: 'updated' });
        manager.removeDerivedTally(1);

        expect(events).toEqual([
            { path: 'derivedTallies.1', type: 'add' },
            { path: 'derivedTallies.1', type: 'update' },
            { path: 'derivedTallies.1', type: 'delete' }
        ]);
    });

    it('round-trips derived tallies through the persisted project state', () => {
        const manager = new OpenMCStateManager();
        manager.setState(createDefaultState(), false);
        manager.addDerivedTally(derived(3, 'Scaled flux'));

        const payload = JSON.parse(JSON.stringify({ version: '1.2.0', state: manager.getState() }));
        const restored = new OpenMCStateManager();
        restored.setState(payload.state, false);

        expect(restored.getState().derivedTallies).toEqual([derived(3, 'Scaled flux')]);
    });
});
