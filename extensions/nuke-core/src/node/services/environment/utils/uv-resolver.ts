// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * UV Resolver
 *
 * Discovers the `uv` executable on the system.
 * UV is an extremely fast Python package installer and resolver.
 *
 * @module nuke-core/node
 */

export class UvResolver {

    private cachedUvPath?: string;

    /**
     * Find the uv executable from PATH or common locations.
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
     */
    async isAvailable(): Promise<boolean> {
        const uv = await this.findUvExe();
        return uv !== undefined;
    }

    /**
     * Get the uv version.
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
