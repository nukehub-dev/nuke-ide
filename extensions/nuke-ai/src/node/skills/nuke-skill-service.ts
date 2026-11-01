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
 * Nuke AI Skill Service
 *
 * Resolves the directory that contains NukeAI's packaged `SKILL.md` folders.
 * The direct layout is `<extension>/lib/node/skills` at runtime and
 * `<extension>/src/node/skills` in tests, so the root is three levels up from
 * the compiled service file. If a packaging layout changes that relationship,
 * the service walks up to the `nuke-ai` package root instead of guessing.
 *
 * @module nuke-ai/node/skills
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { NukeAISkillService } from '../../common/nuke-ai-protocol';

/** Relative location of the skill root from both the source and compiled service files. */
const DIRECT_SKILL_ROOT_FROM_DIRNAME = ['..', '..', '..', 'skills'];

/** Maximum number of parent directories inspected when looking for the package root. */
const MAX_PACKAGE_ROOT_DEPTH = 12;

/** Read the packaged skill root and log it once. */
@injectable()
export class NukeAISkillServiceImpl implements NukeAISkillService {
    protected roots: string[] | undefined;
    protected logged = false;

    constructor(@inject(ILogger) protected readonly logger: ILogger) {}

    async getSkillRoots(): Promise<string[]> {
        if (!this.roots) {
            this.roots = resolveNukeAISkillRoots(__dirname, this.logger);
        }
        if (!this.logged) {
            this.logged = true;
            this.logger.info(`[NukeAi] Skill root: ${this.roots.join(', ')}`);
        }
        return [...this.roots];
    }
}

/**
 * Resolve the skill root without reading any skill content.
 *
 * The direct path is accepted only when it is literally
 * `<somewhere>/nuke-ai/skills` and exists. Otherwise the `nuke-ai` package
 * root is located from `fromDir` and its `skills` directory is used. This
 * function never throws; a missing installation still returns a stable path.
 */
export function resolveNukeAISkillRoots(fromDir: string = __dirname, logger?: ILogger): string[] {
    const direct = path.resolve(fromDir, ...DIRECT_SKILL_ROOT_FROM_DIRNAME);
    if (isNukeAiSkillsDirectory(direct)) {
        return [direct];
    }
    const packageRoot = findNukeAiPackageRoot(fromDir);
    const resolved = packageRoot ? path.join(packageRoot, 'skills') : (findInstalledSkillRoot() ?? direct);
    logger?.warn(`[NukeAi] Expected the skill root at ${direct} but resolved ${resolved}.`);
    return [resolved];
}

/**
 * Find the installed `nuke-ai/skills` directory when the running file lives in
 * a bundled application instead of the extension package. `require.resolve`
 * covers workspace and packaged node_modules layouts; the remaining candidates
 * cover the browser/Electron bundles and a repository-root working directory.
 */
function findInstalledSkillRoot(): string | undefined {
    const candidates: string[] = [];
    try {
        candidates.push(path.join(path.dirname(require.resolve('nuke-ai/package.json')), 'skills'));
    } catch {
        // The package may be bundled without a resolvable package.json.
    }
    candidates.push(
        path.resolve(__dirname, '../../../../extensions/nuke-ai/skills'),
        path.resolve(process.cwd(), 'extensions/nuke-ai/skills'),
        path.resolve(process.cwd(), '../extensions/nuke-ai/skills')
    );
    for (const candidate of candidates) {
        if (isNukeAiSkillsDirectory(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** True when the candidate is an existing `nuke-ai/skills` directory. */
function isNukeAiSkillsDirectory(candidate: string): boolean {
    return path.basename(candidate) === 'skills' && path.basename(path.dirname(candidate)) === 'nuke-ai' && existsSync(candidate);
}

/** Walk up from `fromDir` until a package.json naming `nuke-ai` is found. */
function findNukeAiPackageRoot(fromDir: string): string | undefined {
    let current = path.resolve(fromDir);
    for (let depth = 0; depth < MAX_PACKAGE_ROOT_DEPTH; depth++) {
        try {
            const parsed = JSON.parse(readFileSync(path.join(current, 'package.json'), 'utf-8')) as { name?: unknown };
            if (parsed.name === 'nuke-ai') {
                return current;
            }
        } catch {
            // Keep walking; a missing or malformed package.json is not fatal here.
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}
