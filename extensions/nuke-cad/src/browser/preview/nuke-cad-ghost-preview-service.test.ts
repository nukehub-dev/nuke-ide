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
 * Tests the ghost-preview state store and its proposal lifecycle.
 */

import { describe, expect, it, vi } from 'vitest';
import { Emitter, Event } from '@theia/core/lib/common/event';
import type { NukeCadProposalService } from '../capabilities/nuke-cad-proposal-service';
import type { ParsedTessData } from '../viewer-core/tess-reuse';
import { NukeCadGhostPreviewService, NukeCadGhostPreviewState } from './nuke-cad-ghost-preview-service';

class FakeProposalService {
    protected readonly live = new Set<string>();
    protected readonly emitter = new Emitter<void>();

    readonly onDidChange: Event<void> = this.emitter.event;

    has(id: string): boolean {
        return this.live.has(id);
    }

    add(id: string): void {
        this.live.add(id);
    }

    remove(id: string): void {
        this.live.delete(id);
    }

    fire(): void {
        this.emitter.fire();
    }

    dispose(): void {
        this.emitter.dispose();
    }
}

const TESS_DATA: ParsedTessData = {
    version: 1,
    tolerance: 0.1,
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
    solids: [],
    faces: [],
    edges: [],
    curves: []
};

function previewState(proposalId: string): NukeCadGhostPreviewState {
    return {
        proposalId,
        tessData: TESS_DATA,
        changedSolidIds: [1],
        addedSolidIds: [2],
        removedSolidIds: [3],
        changedBodyIds: ['housing']
    };
}

function createService(): { ghost: NukeCadGhostPreviewService; proposals: FakeProposalService } {
    const proposals = new FakeProposalService();
    const ghost = new NukeCadGhostPreviewService(proposals as unknown as NukeCadProposalService);
    return { ghost, proposals };
}

describe('NukeCadGhostPreviewService', () => {
    it('stores the shown state and emits it', () => {
        const { ghost } = createService();
        const listener = vi.fn();
        ghost.onDidChange(listener);
        const state = previewState('proposal-1');

        ghost.show(state);

        expect(ghost.state).toBe(state);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(state);
    });

    it('emits undefined when cleared', () => {
        const { ghost } = createService();
        const listener = vi.fn();
        ghost.onDidChange(listener);
        ghost.show(previewState('proposal-1'));

        ghost.clear();

        expect(ghost.state).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith(undefined);
    });

    it('does not emit when cleared without a state', () => {
        const { ghost } = createService();
        const listener = vi.fn();
        ghost.onDidChange(listener);

        ghost.clear();

        expect(listener).not.toHaveBeenCalled();
    });

    it('replaces the previous state and emits again', () => {
        const { ghost } = createService();
        const listener = vi.fn();
        ghost.onDidChange(listener);
        const first = previewState('proposal-1');
        const second = previewState('proposal-2');

        ghost.show(first);
        ghost.show(second);

        expect(ghost.state).toBe(second);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith(second);
    });

    it('clears the ghost when its proposal disappears', () => {
        const { ghost, proposals } = createService();
        proposals.add('proposal-1');
        const listener = vi.fn();
        ghost.onDidChange(listener);
        ghost.show(previewState('proposal-1'));

        proposals.fire();
        expect(ghost.state).toBeDefined();
        expect(listener).toHaveBeenCalledTimes(1);

        proposals.remove('proposal-1');
        proposals.fire();
        expect(ghost.state).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith(undefined);
    });

    it('stops emitting after dispose', () => {
        const { ghost, proposals } = createService();
        const listener = vi.fn();
        ghost.onDidChange(listener);
        ghost.show(previewState('proposal-1'));

        ghost.dispose();
        ghost.show(previewState('proposal-2'));
        ghost.clear();
        proposals.fire();

        expect(ghost.state).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
