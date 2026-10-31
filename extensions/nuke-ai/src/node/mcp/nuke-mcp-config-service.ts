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
 * Nuke MCP Config Service
 *
 * Backend source of truth for the opt-in MCP endpoint. The enable command
 * writes `<configDir>/nuke-ai-mcp.json`; this service reads it with a short
 * cache so a toggle takes effect without restarting the IDE. Missing,
 * malformed, or invalid files fail closed. The token is never logged.
 *
 * @module nuke-ai/node/mcp
 */

import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ILogger } from '@theia/core/lib/common/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Name of the backend config file under the IDE config directory. */
export const NUKE_MCP_CONFIG_FILE = 'nuke-ai-mcp.json';

/** Cache lifetime so an enable/disable toggle is visible without a restart. */
export const NUKE_MCP_CONFIG_CACHE_MS = 1000;

/** Parsed backend configuration. */
export interface NukeAIMcpConfig {
    readonly enabled: boolean;
    readonly token: string;
    readonly port: number;
}

/** Read and validate the opt-in MCP configuration file. */
@injectable()
export class NukeAIMcpConfigService {
    protected hasCached = false;
    protected cached: NukeAIMcpConfig | undefined;
    protected cachedAt = 0;
    protected worldReadableWarned = false;

    constructor(
        @inject(EnvVariablesServer) protected readonly envVariables: EnvVariablesServer,
        @inject(ILogger) protected readonly logger: ILogger,
        @unmanaged() protected readonly now: () => number = Date.now
    ) {}

    /**
     * Return the current config, or `undefined` when it is missing or invalid.
     * The result is cached for one second so repeated MCP requests do not hit
     * the filesystem while still honoring a toggle quickly.
     */
    async getConfig(): Promise<NukeAIMcpConfig | undefined> {
        const now = this.now();
        if (this.hasCached && now - this.cachedAt < NUKE_MCP_CONFIG_CACHE_MS) {
            return this.cached;
        }
        const config = await this.readConfig();
        this.cached = config;
        this.cachedAt = now;
        this.hasCached = true;
        return config;
    }

    protected async readConfig(): Promise<NukeAIMcpConfig | undefined> {
        let configDirUri: string;
        try {
            configDirUri = await this.envVariables.getConfigDirUri();
        } catch (error) {
            this.logger.error('[NukeAI] Failed to resolve the IDE config directory for MCP.', error);
            return undefined;
        }
        const filePath = path.join(FileUri.fsPath(configDirUri), NUKE_MCP_CONFIG_FILE);
        let text: string;
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) {
                return undefined;
            }
            this.warnIfWorldReadable(filePath, stat.mode);
            text = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (!isMissingFile(error)) {
                this.logger.warn(`[NukeAI] Unable to read the MCP config at ${filePath}.`);
            }
            return undefined;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.logger.warn(`[NukeAI] Ignoring malformed MCP config at ${filePath}.`);
            return undefined;
        }
        const config = validateConfig(parsed);
        if (!config) {
            this.logger.warn(`[NukeAI] Ignoring invalid MCP config at ${filePath}.`);
        }
        return config;
    }

    protected warnIfWorldReadable(filePath: string, mode: number): void {
        if (process.platform === 'win32' || this.worldReadableWarned) {
            return;
        }
        if ((mode & 0o004) !== 0) {
            this.worldReadableWarned = true;
            this.logger.warn(
                `[NukeAI] MCP config at ${filePath} is world-readable. Restrict it to the current user (chmod 600) to protect the token.`
            );
        }
    }
}

function validateConfig(value: unknown): NukeAIMcpConfig | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.enabled !== 'boolean' || typeof record.token !== 'string') {
        return undefined;
    }
    if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) {
        return undefined;
    }
    return { enabled: record.enabled, token: record.token, port: record.port as number };
}

function isMissingFile(error: unknown): boolean {
    return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}
