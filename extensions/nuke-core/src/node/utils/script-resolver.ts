// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Shared helper for resolving Python script paths in Electron packaged apps.
 *
 * Files inside `app.asar` cannot be read by external Python processes.
 * This helper checks multiple locations in order of reliability and returns
 * the first path that exists (preferring locations outside the ASAR).
 */

import * as path from 'path';
import * as fs from 'fs';
import { resolveAsarUnpacked } from './asar-helper';

export interface ResolvePythonScriptOptions {
    /** npm package name, e.g. 'nuke-visualizer' or 'openmc-studio' */
    packageName: string;
    /** Python script file name, e.g. 'server.py' */
    scriptName: string;
    /** Sub-directory under extraResources/python/ (defaults to packageName) */
    extraResourcesSubdir?: string;
}

/**
 * Resolve the absolute path to a Python script bundled with a Theia extension.
 *
 * Checks locations in this order:
 * 1. `extraResources` path — completely outside ASAR (most reliable for external processes)
 * 2. `require.resolve` path with `asarUnpack` fallback — inside node_modules
 * 3. `extensions/` directory inside the app ASAR
 * 4. Development fallbacks relative to source and CWD
 *
 * @returns The absolute path, or `undefined` if the script cannot be found.
 */
export function resolvePythonScript(options: ResolvePythonScriptOptions): string | undefined {
    const { packageName, scriptName, extraResourcesSubdir = packageName } = options;
    const isInsideAsar = __dirname.includes('.asar');
    const candidates: string[] = [];

    // 1. extraResources path (completely outside ASAR)
    if (isInsideAsar && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'python', extraResourcesSubdir, scriptName));
    }

    // 2. require.resolve path (works in dev + packaged with asarUnpack)
    try {
        const extensionPath = path.dirname(require.resolve(`${packageName}/package.json`));
        candidates.push(path.resolve(extensionPath, 'python', scriptName));
    } catch {
        // ignore — package may not be resolvable in all contexts
    }

    // 3. extensions/ directory inside app (copied by electron-builder from ../../extensions)
    const appRoot = isInsideAsar
        ? path.join(process.resourcesPath, 'app.asar')
        : path.resolve(__dirname, '../../../../applications/electron');
    candidates.push(path.resolve(appRoot, 'extensions', packageName, 'python', scriptName));

    // 4. Development fallbacks (monorepo layout)
    candidates.push(path.resolve(__dirname, '../../../python', scriptName));
    candidates.push(path.resolve(__dirname, `../../../../extensions/${packageName}/python`, scriptName));
    candidates.push(path.resolve(process.cwd(), `extensions/${packageName}/python`, scriptName));

    for (const candidate of candidates) {
        const unpacked = resolveAsarUnpacked(candidate);
        if (fs.existsSync(unpacked)) {
            return unpacked;
        }
    }

    return undefined;
}

/**
 * Build the list of candidate paths without checking existence.
 * Useful for logging or debugging.
 */
export function buildPythonScriptCandidates(options: ResolvePythonScriptOptions): string[] {
    const { packageName, scriptName, extraResourcesSubdir = packageName } = options;
    const isInsideAsar = __dirname.includes('.asar');
    const candidates: string[] = [];

    if (isInsideAsar && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'python', extraResourcesSubdir, scriptName));
    }

    try {
        const extensionPath = path.dirname(require.resolve(`${packageName}/package.json`));
        candidates.push(path.resolve(extensionPath, 'python', scriptName));
    } catch {
        // ignore
    }

    const appRoot = isInsideAsar
        ? path.join(process.resourcesPath, 'app.asar')
        : path.resolve(__dirname, '../../../../applications/electron');
    candidates.push(path.resolve(appRoot, 'extensions', packageName, 'python', scriptName));

    candidates.push(path.resolve(__dirname, '../../../python', scriptName));
    candidates.push(path.resolve(__dirname, `../../../../extensions/${packageName}/python`, scriptName));
    candidates.push(path.resolve(process.cwd(), `extensions/${packageName}/python`, scriptName));

    return candidates;
}
