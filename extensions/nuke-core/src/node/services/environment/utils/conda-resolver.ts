// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Conda Resolver
 *
 * Centralized discovery of conda/mamba installations across common locations,
 * environment variables, and PATH.
 *
 * @module nuke-core/node
 */

export interface CondaInstallation {
    /** Root directory of the installation (e.g., /home/user/miniforge3) */
    rootPath: string;
    /** Path to conda executable, if found */
    condaExe?: string;
    /** Path to mamba executable, if found */
    mambaExe?: string;
    /** Detected distribution type */
    type: 'anaconda' | 'miniconda' | 'miniforge' | 'mambaforge' | 'unknown';
}

export class CondaResolver {

    private static readonly UNIX_PATHS = [
        '~/anaconda3',
        '~/miniconda3',
        '~/miniforge3',
        '~/mambaforge',
        '~/.miniconda3',
        '~/.miniforge',
        '~/.mambaforge',
        '/opt/anaconda3',
        '/opt/miniconda3',
        '/opt/miniforge3',
        '/opt/mambaforge',
        '/usr/local/anaconda3',
        '/usr/local/miniconda3',
        '/usr/local/miniforge3',
        '/usr/local/mambaforge',
    ];

    private static readonly WINDOWS_PATHS = [
        '%USERPROFILE%\\anaconda3',
        '%USERPROFILE%\\miniconda3',
        '%USERPROFILE%\\miniforge3',
        '%USERPROFILE%\\mambaforge',
        '%LOCALAPPDATA%\\anaconda3',
        '%LOCALAPPDATA%\\miniconda3',
        '%LOCALAPPDATA%\\miniforge3',
        '%LOCALAPPDATA%\\mambaforge',
        'C:\\anaconda3',
        'C:\\miniconda3',
        'C:\\miniforge3',
        'C:\\mambaforge',
        'C:\\ProgramData\\anaconda3',
        'C:\\ProgramData\\miniconda3',
        'C:\\ProgramData\\miniforge3',
        'C:\\ProgramData\\mambaforge',
    ];

    /**
     * Find the conda executable from env vars, PATH, or common locations.
     */
    async findCondaExe(): Promise<string | undefined> {
        // 1. Check CONDA_EXE environment variable
        if (process.env.CONDA_EXE && await this.fileExists(process.env.CONDA_EXE)) {
            return process.env.CONDA_EXE;
        }

        // 2. Try `which conda` / `where conda`
        const fromPath = await this.which('conda');
        if (fromPath) {
            return fromPath;
        }

        // 3. Search common installation directories
        const installations = await this.findInstallations();
        for (const inst of installations) {
            if (inst.condaExe && await this.fileExists(inst.condaExe)) {
                return inst.condaExe;
            }
        }

        return undefined;
    }

    /**
     * Find the mamba executable from env vars, PATH, or common locations.
     */
    async findMambaExe(): Promise<string | undefined> {
        // 1. Check MAMBA_EXE environment variable
        if (process.env.MAMBA_EXE && await this.fileExists(process.env.MAMBA_EXE)) {
            return process.env.MAMBA_EXE;
        }

        // 2. Try `which mamba` / `where mamba`
        const fromPath = await this.which('mamba');
        if (fromPath) {
            return fromPath;
        }

        // 3. Search common installation directories
        const installations = await this.findInstallations();
        for (const inst of installations) {
            if (inst.mambaExe && await this.fileExists(inst.mambaExe)) {
                return inst.mambaExe;
            }
        }

        return undefined;
    }

    /**
     * Get the best available command (prefers mamba over conda).
     */
    async getBestCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined> {
        const mamba = await this.findMambaExe();
        if (mamba) {
            return { cmd: mamba, type: 'mamba' };
        }
        const conda = await this.findCondaExe();
        if (conda) {
            return { cmd: conda, type: 'conda' };
        }
        return undefined;
    }

    /**
     * Discover all conda/mamba installations on the system.
     */
    async findInstallations(): Promise<CondaInstallation[]> {
        const installations: CondaInstallation[] = [];
        const seen = new Set<string>();

        const paths = process.platform === 'win32'
            ? CondaResolver.WINDOWS_PATHS
            : CondaResolver.UNIX_PATHS;

        for (const rawPath of paths) {
            const expanded = this.expandPath(rawPath);
            if (!expanded || seen.has(expanded)) {
                continue;
            }
            seen.add(expanded);

            const installation = await this.inspectInstallation(expanded);
            if (installation) {
                installations.push(installation);
            }
        }

        // Also derive from CONDA_PREFIX if active
        if (process.env.CONDA_PREFIX) {
            const path = await import('path');
            const rootPath = path.dirname(process.env.CONDA_PREFIX); // envs/<name> -> root
            const possibleRoot = rootPath.endsWith('envs') ? path.dirname(rootPath) : process.env.CONDA_PREFIX;
            if (!seen.has(possibleRoot)) {
                seen.add(possibleRoot);
                const installation = await this.inspectInstallation(possibleRoot);
                if (installation) {
                    installations.push(installation);
                }
            }
        }

        return installations;
    }

    /**
     * Inspect a directory to see if it's a valid conda installation.
     */
    private async inspectInstallation(rootPath: string): Promise<CondaInstallation | undefined> {
        const path = await import('path');
        const fs = await import('fs');

        try {
            const stat = await fs.promises.stat(rootPath);
            if (!stat.isDirectory()) {
                return undefined;
            }
        } catch {
            return undefined;
        }

        const isWindows = process.platform === 'win32';
        const condaExe = path.join(rootPath, isWindows ? 'Scripts\\conda.exe' : 'bin/conda');
        const mambaExe = path.join(rootPath, isWindows ? 'Scripts\\mamba.exe' : 'bin/mamba');

        const hasConda = await this.fileExists(condaExe);
        const hasMamba = await this.fileExists(mambaExe);

        if (!hasConda && !hasMamba) {
            return undefined;
        }

        const type = this.detectType(rootPath);

        return {
            rootPath,
            condaExe: hasConda ? condaExe : undefined,
            mambaExe: hasMamba ? mambaExe : undefined,
            type
        };
    }

    /**
     * Detect the distribution type from the installation path name.
     */
    private detectType(rootPath: string): CondaInstallation['type'] {
        const lower = rootPath.toLowerCase();
        if (lower.includes('mambaforge')) {
            return 'mambaforge';
        }
        if (lower.includes('miniforge')) {
            return 'miniforge';
        }
        if (lower.includes('miniconda')) {
            return 'miniconda';
        }
        if (lower.includes('anaconda')) {
            return 'anaconda';
        }
        return 'unknown';
    }

    /**
     * Expand ~ and environment variables in a path.
     */
    private expandPath(rawPath: string): string | undefined {
        const os = require('os');
        let expanded = rawPath;

        // Expand ~ to home directory
        if (expanded.startsWith('~')) {
            expanded = expanded.replace('~', os.homedir());
        }

        // Expand environment variables (Windows %VAR% style)
        if (process.platform === 'win32') {
            expanded = expanded.replace(/%([^%]+)%/g, (_, varName) => process.env[varName] || '');
        }

        // Remove trailing backslashes for consistency
        expanded = expanded.replace(/\\+$/, '');

        return expanded || undefined;
    }

    /**
     * Check if a file exists.
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

    /**
     * Find a command in PATH (`which` / `where` equivalent).
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
}
