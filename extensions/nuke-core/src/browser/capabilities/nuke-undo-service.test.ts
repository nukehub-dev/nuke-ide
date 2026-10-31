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

import { describe, it, expect, vi } from 'vitest';
import { NukeCapabilityResult } from '../../common/nuke-capability-protocol';
import { NukeUndoEntry, NukeUndoServiceImpl } from './nuke-undo-service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function entry(undo: () => Promise<NukeCapabilityResult>, title = 'Settings change'): NukeUndoEntry {
    return { title, undo };
}

describe('NukeUndoService', () => {
    it('registers an entry under a UUID token and redeems it once', async () => {
        const service = new NukeUndoServiceImpl();
        const undo = vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true, message: 'Settings change undone.' }));

        const token = service.register(entry(undo));

        expect(token).toMatch(UUID_PATTERN);
        expect(service.has(token)).toBe(true);
        await expect(service.undo(token)).resolves.toEqual({ ok: true, message: 'Settings change undone.' });
        expect(undo).toHaveBeenCalledTimes(1);
        expect(service.has(token)).toBe(false);
        await expect(service.undo(token)).resolves.toEqual({
            ok: false,
            message: 'This change can no longer be undone.'
        });
    });

    it('returns a failed result for an unknown token', async () => {
        const service = new NukeUndoServiceImpl();

        await expect(service.undo('unknown-token')).resolves.toEqual({
            ok: false,
            message: 'This change can no longer be undone.'
        });
    });

    it('keeps the token when the undo handler fails', async () => {
        const service = new NukeUndoServiceImpl();
        const undo = vi
            .fn<() => Promise<NukeCapabilityResult>>()
            .mockResolvedValueOnce({ ok: false, message: 'Settings changed since the preview.' })
            .mockResolvedValueOnce({ ok: true });
        const token = service.register(entry(undo));

        await expect(service.undo(token)).resolves.toEqual({ ok: false, message: 'Settings changed since the preview.' });
        expect(service.has(token)).toBe(true);

        await expect(service.undo(token)).resolves.toEqual({ ok: true });
        expect(undo).toHaveBeenCalledTimes(2);
        expect(service.has(token)).toBe(false);
    });

    it('converts a thrown handler error into a failed result and keeps the token', async () => {
        const service = new NukeUndoServiceImpl();
        const undo = vi.fn(async (): Promise<NukeCapabilityResult> => {
            throw new Error('state unavailable');
        });
        const token = service.register(entry(undo));

        await expect(service.undo(token)).resolves.toEqual({
            ok: false,
            message: 'The change could not be undone: state unavailable.'
        });
        expect(service.has(token)).toBe(true);
    });

    it('fires onDidChange on registration and successful undo only', async () => {
        const service = new NukeUndoServiceImpl();
        const listener = vi.fn();
        service.onDidChange(listener);

        const failed = service.register(entry(async () => ({ ok: false })));
        expect(listener).toHaveBeenCalledTimes(1);

        await service.undo(failed);
        expect(listener).toHaveBeenCalledTimes(1);

        const succeeded = service.register(entry(async () => ({ ok: true })));
        expect(listener).toHaveBeenCalledTimes(2);

        await service.undo(succeeded);
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('runs the entry only once for concurrent calls with the same token', async () => {
        const service = new NukeUndoServiceImpl();
        let resolveUndo: (result: NukeCapabilityResult) => void = () => undefined;
        const pending = new Promise<NukeCapabilityResult>((resolve) => {
            resolveUndo = resolve;
        });
        const undo = vi.fn(() => pending);
        const token = service.register(entry(undo));

        const first = service.undo(token);
        const second = service.undo(token);

        await expect(second).resolves.toEqual({
            ok: false,
            message: 'This change is already being undone.'
        });
        expect(undo).toHaveBeenCalledTimes(1);

        resolveUndo({ ok: true });
        await expect(first).resolves.toEqual({ ok: true });
        expect(service.has(token)).toBe(false);
    });
});
