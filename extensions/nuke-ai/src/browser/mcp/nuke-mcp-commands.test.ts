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

import { describe, expect, it, vi } from 'vitest';
import { PreferenceScope } from '@theia/core/lib/common/preferences';
import { URI } from '@theia/core/lib/common/uri';
import type { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import type { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import type { ILogger } from '@theia/core/lib/common/logger';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { QuickInputService } from '@theia/core/lib/browser/quick-input';
import { NukeMcpCommandContribution, buildMcpClientConfig, mcpEndpointUrl, resolveMcpConfigUri } from './nuke-mcp-commands';

// The command only needs the DI tokens in a Node test; the real browser
// implementations pull in Lumino DOM code that is irrelevant here.
vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickInputService: Symbol('QuickInputService') }));
vi.mock('@theia/core/lib/browser/clipboard-service', () => ({ ClipboardService: Symbol('ClipboardService') }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: Symbol('FileService') }));

const CONFIG_DIR = 'file:///tmp/nuke-config';
const CONFIG_URI = resolveMcpConfigUri(CONFIG_DIR);

class TestableCommands extends NukeMcpCommandContribution {
    enableNow(): Promise<void> {
        return this.enable();
    }

    disableNow(): Promise<void> {
        return this.disable();
    }
}

interface Harness {
    readonly commands: TestableCommands;
    readonly files: Map<string, string>;
    readonly preferences: Map<string, unknown>;
    readonly set: ReturnType<typeof vi.fn>;
    readonly write: ReturnType<typeof vi.fn>;
    readonly deleteFile: ReturnType<typeof vi.fn>;
    readonly messageService: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function createHarness(options: { writeError?: Error; failPreferenceOnce?: string; portAnswer?: string | null } = {}): Harness {
    const files = new Map<string, string>();
    const preferences = new Map<string, unknown>();
    let failedPreference = false;
    const set = vi.fn(async (name: string, value: unknown) => {
        if (options.failPreferenceOnce === name && !failedPreference) {
            failedPreference = true;
            throw new Error('preference write failed');
        }
        preferences.set(name, value);
    });
    const write = vi.fn(async (uri: URI, content: string) => {
        if (options.writeError) {
            throw options.writeError;
        }
        files.set(uri.toString(), content);
        return {};
    });
    const deleteFile = vi.fn(async (uri: URI) => {
        files.delete(uri.toString());
    });
    const fileService = {
        write,
        delete: deleteFile,
        exists: vi.fn(async (uri: URI) => files.has(uri.toString()))
    } as unknown as FileService;
    const envVariables = {
        getConfigDirUri: vi.fn(async () => CONFIG_DIR)
    } as unknown as EnvVariablesServer;
    const quickInput = {
        input: vi.fn(async () => (options.portAnswer === null ? undefined : (options.portAnswer ?? '3210')))
    } as unknown as QuickInputService;
    const messageService = {
        info: vi.fn(async () => undefined),
        warn: vi.fn(async () => undefined),
        error: vi.fn(async () => undefined)
    };
    const clipboard = { writeText: vi.fn() } as unknown as ClipboardService;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
    const commands = new TestableCommands(
        { set } as unknown as PreferenceService,
        fileService,
        envVariables,
        quickInput,
        messageService as unknown as MessageService,
        clipboard,
        logger
    );
    return { commands, files, preferences, set, write, deleteFile, messageService };
}

function writtenConfig(files: Map<string, string>): { enabled: boolean; token: string; port: number } {
    const content = files.get(CONFIG_URI.toString());
    if (!content) {
        throw new Error('MCP config was not written');
    }
    return JSON.parse(content);
}

describe('NukeMcpCommandContribution', () => {
    it('writes a token config and turns on the loopback external API', async () => {
        const harness = createHarness();

        await harness.commands.enableNow();

        const config = writtenConfig(harness.files);
        expect(config.enabled).toBe(true);
        expect(config.port).toBe(3210);
        expect(config.token).toMatch(/^[0-9a-f-]{36}$/);
        expect(harness.set).toHaveBeenCalledWith('externalApi.delivery', 'separatePort', PreferenceScope.User);
        expect(harness.set).toHaveBeenCalledWith('externalApi.hostname', '127.0.0.1', PreferenceScope.User);
        expect(harness.set).toHaveBeenCalledWith('externalApi.token', config.token, PreferenceScope.User);
        expect(harness.messageService.info).toHaveBeenCalledWith(expect.stringContaining(mcpEndpointUrl(3210)), 'Copy client config');
        expect(buildMcpClientConfig(3210, config.token).mcpServers['nuke-ide'].headers.Authorization).toBe(`Bearer ${config.token}`);
    });

    it('does nothing when the port prompt is cancelled', async () => {
        const harness = createHarness({ portAnswer: null });

        await harness.commands.enableNow();

        expect(harness.write).not.toHaveBeenCalled();
        expect(harness.set).not.toHaveBeenCalled();
    });

    it('rejects an invalid port before writing anything', async () => {
        const harness = createHarness({ portAnswer: '0' });

        await harness.commands.enableNow();

        expect(harness.messageService.warn).toHaveBeenCalledWith('MCP port must be an integer between 1 and 65535.');
        expect(harness.write).not.toHaveBeenCalled();
        expect(harness.set).not.toHaveBeenCalled();
    });

    it('rolls back the config and delivery when a preference write fails', async () => {
        const harness = createHarness({ failPreferenceOnce: 'externalApi.delivery' });

        await harness.commands.enableNow();

        expect(harness.files.size).toBe(0);
        expect(harness.preferences.get('externalApi.delivery')).toBe('off');
        expect(harness.preferences.get('nuke.ai.mcp.enabled')).toBe(false);
        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('preference write failed'));
    });

    it('reports a config write failure and leaves preferences untouched', async () => {
        const harness = createHarness({ writeError: new Error('disk full') });

        await harness.commands.enableNow();

        expect(harness.set).not.toHaveBeenCalledWith('externalApi.delivery', 'separatePort', PreferenceScope.User);
        expect(harness.preferences.get('externalApi.delivery')).toBe('off');
        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });

    it('turns delivery off, resets preferences, and deletes the config on disable', async () => {
        const harness = createHarness();
        await harness.commands.enableNow();

        await harness.commands.disableNow();

        expect(harness.files.size).toBe(0);
        expect(harness.preferences.get('externalApi.delivery')).toBe('off');
        expect(harness.preferences.get('nuke.ai.mcp.enabled')).toBe(false);
        expect(harness.preferences.get('externalApi.token')).toBeUndefined();
        expect(harness.preferences.get('nuke.ai.mcp.port')).toBeUndefined();
        expect(harness.messageService.info).toHaveBeenCalledWith('MCP endpoint disabled.');
    });
});
