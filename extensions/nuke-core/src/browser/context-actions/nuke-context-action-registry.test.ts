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
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { ILogger } from '@theia/core/lib/common/logger';
import { NukeContextAction, NukeContextActionContribution, NukeContextActionScope } from '../../common/nuke-context-action-protocol';
import { NukeContextActionRegistryImpl, compareContextActions, validateContextAction } from './nuke-context-action-registry';

function createLogger(): ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return {
        error: vi.fn(),
        warn: vi.fn()
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

function action(overrides: Partial<NukeContextAction> = {}): NukeContextAction {
    return {
        id: 'nuke-ai.cad.viewport.ask',
        scope: 'cad.viewport',
        label: 'Ask About Context',
        commandId: 'nuke.ai.ask',
        ...overrides
    };
}

function createRegistry(contributions: NukeContextActionContribution[] = []): {
    registry: NukeContextActionRegistryImpl;
    logger: ReturnType<typeof createLogger>;
} {
    const logger = createLogger();
    const provider: ContributionProvider<NukeContextActionContribution> = {
        getContributions: () => contributions
    };
    return { registry: new NukeContextActionRegistryImpl(provider, logger), logger };
}

describe('NukeContextActionRegistry', () => {
    it('runs contributions once and exposes their actions', () => {
        const register = vi.fn((registry: NukeContextActionRegistryImpl) => registry.register(action()));
        const { registry } = createRegistry([{ registerContextActions: register }]);

        expect(registry.getActions('cad.viewport').map((entry) => entry.id)).toEqual(['nuke-ai.cad.viewport.ask']);
        expect(registry.getActions('cad.viewport')).toHaveLength(1);
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('keeps the first registration for a duplicate id', () => {
        const { registry, logger } = createRegistry();
        registry.register(action({ id: 'nuke-ai.cad.viewport.keep', label: 'First' }));
        registry.register(action({ id: 'nuke-ai.cad.viewport.keep', label: 'Second' }));

        expect(registry.getActions('cad.viewport')).toHaveLength(1);
        expect(registry.getActions('cad.viewport')[0].label).toBe('First');
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid actions', () => {
        const invalid: NukeContextAction[] = [
            action({ id: '' }),
            action({ label: '   ' }),
            action({ commandId: '' }),
            action({ scope: 'cad.other' as unknown as NukeContextActionScope }),
            action({ when: 'not a function' as unknown as NukeContextAction['when'] })
        ];
        for (const entry of invalid) {
            const { registry, logger } = createRegistry();
            registry.register(entry);
            expect(registry.getActions('cad.viewport')).toHaveLength(0);
            expect(logger.error).toHaveBeenCalledTimes(1);
        }
    });

    it('sorts by group, order, then label, and keeps scopes separate', () => {
        const { registry } = createRegistry([
            {
                registerContextActions: (target) => {
                    target.register(action({ id: 'z', label: 'Zeta', group: 'b', order: 'a' }));
                    target.register(action({ id: 'b', label: 'Beta', group: 'a', order: 'b' }));
                    target.register(action({ id: 'a', label: 'Alpha', group: 'a', order: 'a' }));
                    target.register(action({ id: 'c', label: 'Alpha', group: 'a', order: 'b', scope: 'openmc.run' }));
                    target.register(action({ id: 'd', label: 'Delta' }));
                }
            }
        ]);

        expect(registry.getActions('cad.viewport').map((entry) => entry.id)).toEqual(['d', 'a', 'b', 'z']);
        expect(registry.getActions('openmc.run').map((entry) => entry.id)).toEqual(['c']);
        expect(registry.getActions('visualizer.tally')).toEqual([]);
    });

    it('skips actions whose when predicate is false or throws', () => {
        const { registry, logger } = createRegistry();
        registry.register(action({ id: 'always' }));
        registry.register(action({ id: 'hidden', when: () => false }));
        registry.register(
            action({
                id: 'throwing',
                when: () => {
                    throw new Error('boom');
                }
            })
        );

        expect(registry.getActions('cad.viewport').map((entry) => entry.id)).toEqual(['always']);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('fires onDidChange after the initial pass and later accepted registrations', () => {
        const { registry } = createRegistry([{ registerContextActions: (target) => target.register(action()) }]);
        const listener = vi.fn();
        registry.onDidChange(listener);

        // First use runs the contribution pass and reports it once.
        expect(registry.getActions('cad.viewport')).toHaveLength(1);
        expect(listener).toHaveBeenCalledTimes(1);

        registry.register(action({ id: 'second' }));
        expect(listener).toHaveBeenCalledTimes(2);

        registry.register(action({ id: 'second', label: 'Duplicate' }));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('compares and validates exported helpers directly', () => {
        expect(validateContextAction(action())).toEqual([]);
        expect(validateContextAction(action({ id: '   ' }))).toContain('id must be a non-empty string');
        expect(compareContextActions(action({ label: 'A' }), action({ label: 'B' }))).toBeLessThan(0);
    });
});
