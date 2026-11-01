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
import type { Mock } from 'vitest';
import { ILogger } from '@theia/core/lib/common/logger';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging';
import { NukeAISkillServicePath } from '../../common/nuke-ai-protocol';
import { NukeSkillRootCache } from './nuke-skill-root-cache';

function createLogger(): ILogger & { warn: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & { warn: ReturnType<typeof vi.fn> };
}

interface Setup {
    cache: NukeSkillRootCache;
    provider: { createProxy: ReturnType<typeof vi.fn> };
    skillService: { getSkillRoots: Mock<() => Promise<string[]>> };
}

function setup(getSkillRoots: () => Promise<string[]>): Setup {
    const skillService = { getSkillRoots: vi.fn<() => Promise<string[]>>(getSkillRoots) };
    const provider = { createProxy: vi.fn(() => skillService) };
    const cache = new NukeSkillRootCache(provider as unknown as WebSocketConnectionProvider, createLogger());
    return { cache, provider, skillService };
}

describe('NukeSkillRootCache', () => {
    it('resolves the backend skill roots once and reuses them', async () => {
        const { cache, provider, skillService } = setup(async () => ['/extensions/nuke-ai/skills']);

        await expect(cache.getRoots()).resolves.toEqual(['/extensions/nuke-ai/skills']);
        await expect(cache.getRoots()).resolves.toEqual(['/extensions/nuke-ai/skills']);

        expect(provider.createProxy).toHaveBeenCalledWith(NukeAISkillServicePath);
        expect(provider.createProxy).toHaveBeenCalledTimes(1);
        expect(skillService.getSkillRoots).toHaveBeenCalledTimes(1);
    });

    it('clears a failed lookup so the next request retries', async () => {
        let attempt = 0;
        const { cache, provider } = setup(async () => {
            attempt += 1;
            if (attempt === 1) {
                throw new Error('backend offline');
            }
            return ['/extensions/nuke-ai/skills'];
        });

        await expect(cache.getRoots()).rejects.toThrow('backend offline');
        await expect(cache.getRoots()).resolves.toEqual(['/extensions/nuke-ai/skills']);

        expect(provider.createProxy).toHaveBeenCalledTimes(2);
    });

    it('warms the cache on application start without surfacing failures', async () => {
        const { cache, skillService } = setup(async () => ['/extensions/nuke-ai/skills']);

        cache.onStart();
        await expect.poll(() => skillService.getSkillRoots.mock.calls.length).toBe(1);
    });
});
