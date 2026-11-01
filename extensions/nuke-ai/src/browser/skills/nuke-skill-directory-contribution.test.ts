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
import { NukeSkillDirectoryContribution } from './nuke-skill-directory-contribution';
import { NukeSkillRootCache } from './nuke-skill-root-cache';

function createLogger(): ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function setup(getSkillRoots: () => Promise<string[]>): {
    contribution: NukeSkillDirectoryContribution;
    cache: { getRoots: Mock<() => Promise<string[]>> };
    logger: ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
    const cache = { getRoots: vi.fn<() => Promise<string[]>>(getSkillRoots) };
    const logger = createLogger();
    const contribution = new NukeSkillDirectoryContribution(cache as unknown as NukeSkillRootCache, logger);
    return { contribution, cache, logger };
}

describe('NukeSkillDirectoryContribution', () => {
    it('returns one plugin directory entry per backend root', async () => {
        const { contribution, cache } = setup(async () => ['/extensions/nuke-ai/skills', '/opt/nuke/skills']);

        const directories = await contribution.getSkillDirectories();

        expect(directories).toEqual([
            { path: '/extensions/nuke-ai/skills', tier: 'plugin' },
            { path: '/opt/nuke/skills', tier: 'plugin' }
        ]);
        expect(cache.getRoots).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list and logs when the backend is unavailable', async () => {
        const { contribution, logger } = setup(async () => {
            throw new Error('backend offline');
        });

        await expect(contribution.getSkillDirectories()).resolves.toEqual([]);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(String(logger.error.mock.calls[0][0])).toContain('Failed to read skill roots');
    });

    it('logs the discovered roots once and reuses the shared cache', async () => {
        const { contribution, cache, logger } = setup(async () => ['/extensions/nuke-ai/skills']);

        await contribution.getSkillDirectories();
        await contribution.getSkillDirectories();

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(cache.getRoots).toHaveBeenCalledTimes(2);
    });
});
