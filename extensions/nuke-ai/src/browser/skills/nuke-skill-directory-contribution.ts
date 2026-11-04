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
 * Nuke Skill Directory Contribution
 *
 * Contributes NukeAI's packaged skill root to Theia's skill service as a
 * lowest-precedence `plugin` tier. A user skill directory therefore wins a
 * name collision without any NukeAI-specific lookup code.
 *
 * @module nuke-ai/browser/skills
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { SkillDirectoryContribution } from '@theia/ai-core/lib/browser/skill-service';
import { SkillDirectoryEntry } from '@theia/ai-core/lib/common/skill';
import { NukeSkillRootCache } from './nuke-skill-root-cache';

/** Serve the backend-owned NukeAI skill root to Theia. */
@injectable()
export class NukeSkillDirectoryContribution implements SkillDirectoryContribution {
    protected loggedRoots = false;

    constructor(
        @inject(NukeSkillRootCache) protected readonly skillRootCache: NukeSkillRootCache,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    async getSkillDirectories(): Promise<SkillDirectoryEntry[]> {
        try {
            const roots = await this.skillRootCache.getRoots();
            if (!this.loggedRoots) {
                this.loggedRoots = true;
                this.logger.info(`[NukeAi] Discovered skill root(s): ${roots.join(', ') || 'none'}`);
            }
            return roots.map((root) => ({ path: root, tier: 'plugin' as const }));
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read skill roots from the backend:', error);
            return [];
        }
    }
}
