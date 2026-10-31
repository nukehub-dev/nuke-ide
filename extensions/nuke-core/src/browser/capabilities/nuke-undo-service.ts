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
 * Nuke Undo Service
 *
 * In-memory registry of reverse handlers for applied capability changes. A
 * write capability registers an {@link NukeUndoEntry} after it applies a
 * change and returns the resulting token as `undoToken`; a consumer redeems
 * the token once to reverse that change.
 *
 * Tokens live only for the current IDE session. They are never persisted, so
 * undo does not survive an IDE restart or reload.
 *
 * @module nuke-core/browser/capabilities
 */

import { injectable } from '@theia/core/shared/inversify';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { NukeCapabilityResult } from '../../common/nuke-capability-protocol';

/** Reverse handler registered for one applied change. */
export interface NukeUndoEntry {
    readonly title: string;
    undo(): Promise<NukeCapabilityResult>;
}

/** DI symbol for the in-memory undo service. */
export const NukeUndoService = Symbol('NukeUndoService');

/** Service that stores and redeems one-shot undo handlers. */
export interface NukeUndoService {
    register(entry: NukeUndoEntry): string;
    has(token: string): boolean;
    undo(token: string): Promise<NukeCapabilityResult>;
    readonly onDidChange: Event<void>;
}

/** Message returned when a token is unknown, already redeemed, or expired. */
const UNKNOWN_TOKEN_MESSAGE = 'This change can no longer be undone.';

/** Message returned when another caller is already running the same undo handler. */
const IN_FLIGHT_MESSAGE = 'This change is already being undone.';

/** In-memory undo service. Undo state does not survive an IDE restart. */
@injectable()
export class NukeUndoServiceImpl implements NukeUndoService, Disposable {
    protected readonly entries = new Map<string, NukeUndoEntry>();
    protected readonly inFlight = new Set<string>();
    protected readonly onDidChangeEmitter = new Emitter<void>();

    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    /** Store an entry and return its opaque UUID token. */
    register(entry: NukeUndoEntry): string {
        const token = globalThis.crypto.randomUUID();
        this.entries.set(token, entry);
        this.onDidChangeEmitter.fire();
        return token;
    }

    /** True while the token has not been redeemed successfully. */
    has(token: string): boolean {
        return this.entries.has(token);
    }

    /**
     * Redeem a token. The entry runs at most once per token: a concurrent
     * duplicate call is rejected while the first call is in flight, and the
     * token is removed only after `ok: true`. A thrown handler error becomes a
     * failed result and never rejects.
     */
    async undo(token: string): Promise<NukeCapabilityResult> {
        const entry = this.entries.get(token);
        if (!entry) {
            return { ok: false, message: UNKNOWN_TOKEN_MESSAGE };
        }
        if (this.inFlight.has(token)) {
            return { ok: false, message: IN_FLIGHT_MESSAGE };
        }
        this.inFlight.add(token);
        try {
            const result = await entry.undo();
            if (result.ok) {
                this.entries.delete(token);
                this.onDidChangeEmitter.fire();
            }
            return result;
        } catch (error) {
            const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
            return { ok: false, message: `The change could not be undone${detail}.` };
        } finally {
            this.inFlight.delete(token);
        }
    }

    dispose(): void {
        this.entries.clear();
        this.inFlight.clear();
        this.onDidChangeEmitter.dispose();
    }
}
