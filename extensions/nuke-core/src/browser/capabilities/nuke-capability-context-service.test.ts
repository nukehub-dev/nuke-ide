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
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { Emitter } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { MaybePromise } from '@theia/core/lib/common/types';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import { NukeCapabilityContext, NukeCapabilityContextContribution } from '../../common/nuke-capability-protocol';
import { NukeCapabilityContextServiceImpl } from './nuke-capability-context-service';

vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

function createLogger(): ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return {
        error: vi.fn(),
        warn: vi.fn()
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

interface TestWorkspace {
    service: WorkspaceService;
    changed: Emitter<unknown>;
    setRoots(roots: string[]): void;
}

function createWorkspace(initialRoots: string[] = []): TestWorkspace {
    let roots = initialRoots;
    const changed = new Emitter<unknown>();
    const service = {
        tryGetRoots: () => roots.map((root) => ({ resource: { path: { toString: () => root } } })),
        onWorkspaceChanged: changed.event
    } as unknown as WorkspaceService;
    return {
        service,
        changed,
        setRoots: (next) => {
            roots = next;
        }
    };
}

interface TestContribution extends NukeCapabilityContextContribution {
    changed: Emitter<void>;
}

function createContribution(getContext: () => MaybePromise<Partial<NukeCapabilityContext>>): TestContribution {
    const changed = new Emitter<void>();
    return { getContext, onDidChangeContext: changed.event, changed };
}

function createService(
    contributions: NukeCapabilityContextContribution[],
    workspace: TestWorkspace = createWorkspace(['/workspace'])
): {
    service: NukeCapabilityContextServiceImpl;
    logger: ReturnType<typeof createLogger>;
    workspace: TestWorkspace;
} {
    const logger = createLogger();
    const provider: ContributionProvider<NukeCapabilityContextContribution> = {
        getContributions: () => contributions
    };
    const service = new NukeCapabilityContextServiceImpl(provider, workspace.service, logger);
    service.initialize();
    return { service, logger, workspace };
}

async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('NukeCapabilityContextService', () => {
    it('merges two contributions', async () => {
        const first = createContribution(() => ({ activeCadDocument: '/workspace/model.CAD' }));
        const second = createContribution(async () => ({ activeDataset: '/workspace/tallies.h5' }));
        const { service } = createService([first, second]);

        const context = await service.getContext();

        expect(context.activeCadDocument).toBe('/workspace/model.CAD');
        expect(context.activeDataset).toBe('/workspace/tallies.h5');
        expect(context.activeOpenmcProject).toBeUndefined();
    });

    it('always includes workspace roots and ignores contributed roots', async () => {
        const rogue = createContribution(() => ({ workspaceRoots: ['/somewhere/else'] }));
        const workspace = createWorkspace(['/workspace/one', '/workspace/two']);
        const { service } = createService([rogue], workspace);

        const context = await service.getContext();

        expect(context.workspaceRoots).toEqual(['/workspace/one', '/workspace/two']);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.workspaceRoots)).toBe(true);
    });

    it('awaits async contributions and skips failing ones', async () => {
        const failing = createContribution(() => {
            throw new Error('context failed');
        });
        const asyncContribution = createContribution(async () => {
            await Promise.resolve();
            return { activeOpenmcProject: '/workspace/project.nuke-openmc' };
        });
        const { service, logger } = createService([failing, asyncContribution]);

        const context = await service.getContext();

        expect(context.activeOpenmcProject).toBe('/workspace/project.nuke-openmc');
        expect(context.workspaceRoots).toEqual(['/workspace']);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('does not reject when reading workspace roots fails', async () => {
        const workspace = createWorkspace();
        workspace.service = {
            tryGetRoots: () => {
                throw new Error('workspace unavailable');
            },
            onWorkspaceChanged: new Emitter<unknown>().event
        } as unknown as WorkspaceService;
        const { service, logger } = createService([], workspace);

        const context = await service.getContext();

        expect(context.workspaceRoots).toEqual([]);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('fires onDidChangeContext once for two rapid changes', async () => {
        const first = createContribution(() => ({}));
        const second = createContribution(() => ({}));
        const { service } = createService([first, second]);
        const listener = vi.fn();
        service.onDidChangeContext(listener);

        first.changed.fire();
        second.changed.fire();

        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires onDidChangeContext when workspace roots change', async () => {
        const workspace = createWorkspace(['/workspace/one']);
        const { service } = createService([], workspace);
        const listener = vi.fn();
        service.onDidChangeContext(listener);

        workspace.setRoots(['/workspace/two']);
        workspace.changed.fire(undefined);

        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        await expect(service.getContext()).resolves.toMatchObject({ workspaceRoots: ['/workspace/two'] });
    });

    it('stops notifying listeners after dispose', async () => {
        const contribution = createContribution(() => ({}));
        const { service } = createService([contribution]);
        const listener = vi.fn();
        service.onDidChangeContext(listener);

        service.dispose();
        contribution.changed.fire();

        await flushMicrotasks();

        expect(listener).not.toHaveBeenCalled();
    });
});
