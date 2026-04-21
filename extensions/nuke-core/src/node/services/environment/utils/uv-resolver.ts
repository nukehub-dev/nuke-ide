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
 * UV Resolver
 *
 * Discovers the `uv` executable on the system.
 * UV is an extremely fast Python package installer and resolver.
 *
 * @module nuke-core/node
 */

/**
 * Discovers the `uv` executable on the system.
 *
 * UV is an extremely fast Python package installer and resolver.
 * Searches PATH and common installation directories, caching the result.
 *
 * @see {@link CondaResolver} for conda/mamba discovery.
 */
export class UvResolver {

    private cachedUvPath?: string;

    /**
     * Find the uv executable from PATH or common locations.
     *
     * @returns Absolute path to the uv executable, or `undefined` if not found.
     */
    async findUvExe(): Promise<string | undefined> {
        if (this.cachedUvPath) {
            return this.cachedUvPath;
        }

        // 1. Try `which uv` / `where uv`
        const fromPath = await this.which('uv');
        if (fromPath) {
            this.cachedUvPath = fromPath;
            return fromPath;
        }

        // 2. Search common installation locations
        const isWindows = process.platform === 'win32';
        const home = require('os').homedir();
        const candidates = isWindows
            ? [
                `${home}\\.cargo\\bin\\uv.exe`,
                `${home}\\AppData\\Local\\Programs\\uv\\uv.exe`,
                'C:\\Program Files\\uv\\uv.exe',
            ]
            : [
                `${home}/.cargo/bin/uv`,
                `${home}/.local/bin/uv`,
                '/usr/local/bin/uv',
                '/opt/homebrew/bin/uv',
                '/usr/bin/uv',
            ];

        for (const candidate of candidates) {
            if (await this.fileExists(candidate)) {
                this.cachedUvPath = candidate;
                return candidate;
            }
        }

        return undefined;
    }

    /**
     * Check if uv is available.
     *
     * @returns `true` if the uv executable was discovered.
     * @see {@link findUvExe}
     */
    async isAvailable(): Promise<boolean> {
        const uv = await this.findUvExe();
        return uv !== undefined;
    }

    /**
     * Get the uv version.
     *
     * @returns Version string reported by `uv --version`, or `undefined` if not available.
     * @see {@link findUvExe}
     */
    async getVersion(): Promise<string | undefined> {
        const uv = await this.findUvExe();
        if (!uv) {
            return undefined;
        }
        try {
            const { execSync } = await import('child_process');
            const output = execSync(`"${uv}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            return output;
        } catch {
            return undefined;
        }
    }

    /**
     * Find a command in PATH (`which` / `where` equivalent).
     *
     * @param command - Command name to search for.
     * @returns Absolute path to the command, or `undefined` if not found in PATH.
     */
    private async which(command: string): Promise<string | undefined> {
        try {
            const { execSync } = await import('child_process');
            const isWindows = process.platform === 'win32';
            const whichCmd = isWindows ? `where ${command}` : `which ${command}`;
            const output = execSync(whichCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            const firstLine = output.split(/\r?\n/)[0];
            if (firstLine) {
                return firstLine;
            }
        } catch {
            // Not found in PATH
        }
        return undefined;
    }

    /**
     * Check if a file exists.
     *
     * @param filePath - Path to the file.
     * @returns `true` if the file exists and is accessible.
     */
    private async fileExists(filePath: string): Promise<boolean> {
        const fs = await import('fs');
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }
}
