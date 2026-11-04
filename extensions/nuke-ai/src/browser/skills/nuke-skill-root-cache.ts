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
 * Nuke Skill Root Cache
 *
 * Resolves the backend-owned skill root once and shares it with every frontend
 * consumer. The cache is warmed during application start so a nested
 * backend-to-frontend-to-backend RPC (for example an MCP resource request that
 * asks the frontend for resources while the frontend asks the backend for skill
 * roots) never has to perform that lookup for the first time.
 *
 * @module nuke-ai/browser/skills
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ILogger } from '@theia/core/lib/common/logger';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging';
import { NukeAISkillService, NukeAISkillServicePath } from '../../common/nuke-ai-protocol';

/** Share one backend skill-root lookup across the frontend. */
@injectable()
export class NukeSkillRootCache implements FrontendApplicationContribution {
    protected roots: Promise<string[]> | undefined;

    constructor(
        @inject(WebSocketConnectionProvider) protected readonly connectionProvider: WebSocketConnectionProvider,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /** Warm the cache once the frontend starts; failures are retried on demand. */
    onStart(): void {
        void this.getRoots().catch(() => undefined);
    }

    /** Return the cached roots, resolving them once on first use. */
    getRoots(): Promise<string[]> {
        if (!this.roots) {
            const service = this.connectionProvider.createProxy<NukeAISkillService>(NukeAISkillServicePath);
            this.roots = service.getSkillRoots().then(
                (roots) => [...roots],
                (error) => {
                    this.roots = undefined;
                    this.logger.warn('[NukeAi] Failed to cache the skill root; retrying on the next request.');
                    throw error;
                }
            );
        }
        return this.roots;
    }
}
