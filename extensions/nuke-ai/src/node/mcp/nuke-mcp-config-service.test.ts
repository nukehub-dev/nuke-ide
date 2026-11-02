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

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { NUKE_MCP_CONFIG_CACHE_MS, NUKE_MCP_CONFIG_FILE, NukeAIMcpConfigService } from './nuke-mcp-config-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function temporaryConfigDir(): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nuke-ai-mcp-config-'));
    temporaryDirectories.push(directory);
    return directory;
}

function environment(directory: string): EnvVariablesServer {
    return {
        getConfigDirUri: async () => URI.fromFilePath(directory).toString()
    } as unknown as EnvVariablesServer;
}

function createLogger(): ILogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };
}

async function writeConfig(directory: string, value: unknown): Promise<void> {
    await fs.writeFile(path.join(directory, NUKE_MCP_CONFIG_FILE), JSON.stringify(value), 'utf8');
}

describe('NukeAIMcpConfigService', () => {
    it('is disabled when the config file is missing', async () => {
        const logger = createLogger();
        const service = new NukeAIMcpConfigService(environment(temporaryConfigDir()), logger);

        expect(await service.getConfig()).toBeUndefined();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('reads a valid enabled config without logging the token', async () => {
        const directory = temporaryConfigDir();
        await writeConfig(directory, { enabled: true, token: 'super-secret-token', port: 3210 });
        const logger = createLogger();

        const config = await new NukeAIMcpConfigService(environment(directory), logger).getConfig();

        expect(config).toEqual({ enabled: true, token: 'super-secret-token', port: 3210 });
        expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls])).not.toContain(
            'super-secret-token'
        );
    });

    it('returns a disabled config so the contribution can answer 404', async () => {
        const directory = temporaryConfigDir();
        await writeConfig(directory, { enabled: false, token: 'super-secret-token', port: 3210 });

        const config = await new NukeAIMcpConfigService(environment(directory), createLogger()).getConfig();

        expect(config?.enabled).toBe(false);
    });

    it('treats malformed JSON as disabled instead of crashing', async () => {
        const directory = temporaryConfigDir();
        await fs.writeFile(path.join(directory, NUKE_MCP_CONFIG_FILE), '{not-json', 'utf8');
        const logger = createLogger();

        const config = await new NukeAIMcpConfigService(environment(directory), logger).getConfig();

        expect(config).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    });

    it.each([
        ['non-object', []],
        ['missing token', { enabled: true, port: 3210 }],
        ['non-string token', { enabled: true, token: 42, port: 3210 }],
        ['non-boolean enabled', { enabled: 'yes', token: 'secret', port: 3210 }],
        ['port out of range', { enabled: true, token: 'secret', port: 70000 }],
        ['fractional port', { enabled: true, token: 'secret', port: 3210.5 }]
    ])('treats an invalid config (%s) as disabled', async (_label, value) => {
        const directory = temporaryConfigDir();
        await writeConfig(directory, value);

        expect(await new NukeAIMcpConfigService(environment(directory), createLogger()).getConfig()).toBeUndefined();
    });

    it('refreshes after the one-second cache window', async () => {
        const directory = temporaryConfigDir();
        await writeConfig(directory, { enabled: true, token: 'secret', port: 3210 });
        let now = 1_000;
        const service = new NukeAIMcpConfigService(environment(directory), createLogger(), () => now);

        expect((await service.getConfig())?.enabled).toBe(true);

        await writeConfig(directory, { enabled: false, token: 'secret', port: 3210 });
        now += NUKE_MCP_CONFIG_CACHE_MS - 1;
        expect((await service.getConfig())?.enabled).toBe(true);

        now += 1;
        expect((await service.getConfig())?.enabled).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('tightens a world-readable config file to owner-only without logging the token', async () => {
        const directory = temporaryConfigDir();
        const filePath = path.join(directory, NUKE_MCP_CONFIG_FILE);
        await writeConfig(directory, { enabled: true, token: 'super-secret-token', port: 3210 });
        await fs.chmod(filePath, 0o644);
        const logger = createLogger();
        let now = 0;
        const service = new NukeAIMcpConfigService(environment(directory), logger, () => now);

        await service.getConfig();
        now += NUKE_MCP_CONFIG_CACHE_MS;
        await service.getConfig();

        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
        expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls])).not.toContain(
            'super-secret-token'
        );
    });
});
