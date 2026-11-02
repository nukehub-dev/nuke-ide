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
 * Nuke MCP Commands
 *
 * Owns the external API configuration for the opt-in MCP endpoint. Enabling
 * writes a token to the IDE config directory and pushes the external API
 * preferences; disabling turns the external API off and removes the token and
 * config file. Both commands are idempotent.
 *
 * @module nuke-ai/browser/mcp
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ILogger } from '@theia/core/lib/common/logger';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { QuickInputService } from '@theia/core/lib/browser/quick-input';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core/lib/common/uri';
import { NUKE_MCP_DEFAULT_PORT } from './nuke-mcp-preferences';

/** Name of the backend config file under the IDE config directory. */
export const NUKE_MCP_CONFIG_FILE_NAME = 'nuke-ai-mcp.json';

/** Action offered by the enable notification. */
export const COPY_CLIENT_CONFIG_ACTION = 'Copy client config';

/** Commands that enable and disable the external MCP endpoint. */
export const NukeMcpCommands = {
    ENABLE: {
        id: 'nuke.ai.mcp.enable',
        label: 'NukeAI: Enable MCP Endpoint',
        category: 'NukeAI'
    } as Command,
    DISABLE: {
        id: 'nuke.ai.mcp.disable',
        label: 'NukeAI: Disable MCP Endpoint',
        category: 'NukeAI'
    } as Command
};

/** Shape written to `<configDir>/nuke-ai-mcp.json`. */
export interface NukeMcpFileConfig {
    enabled: boolean;
    token: string;
    port: number;
}

/** Ready-to-paste client configuration for common MCP clients. */
export function buildMcpClientConfig(
    port: number,
    token: string
): {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
} {
    return {
        mcpServers: {
            'nuke-ide': {
                type: 'http',
                url: mcpEndpointUrl(port),
                headers: { Authorization: `Bearer ${token}` }
            }
        }
    };
}

/** Serialize the client configuration with the stable formatting shown in the notification. */
export function buildMcpClientConfigSnippet(port: number, token: string): string {
    return JSON.stringify(buildMcpClientConfig(port, token), null, 2);
}

/** Loopback URL served by the external API contribution. */
export function mcpEndpointUrl(port: number): string {
    return `http://127.0.0.1:${port}/nuke-ai-mcp`;
}

/** Resolve the backend config file next to the IDE's other user settings. */
export function resolveMcpConfigUri(configDirUri: string): URI {
    return new URI(configDirUri).resolve(NUKE_MCP_CONFIG_FILE_NAME);
}

/** Enable or disable the external MCP endpoint from the command palette. */
@injectable()
export class NukeMcpCommandContribution implements CommandContribution {
    constructor(
        @inject(PreferenceService) protected readonly preferences: PreferenceService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(EnvVariablesServer) protected readonly envVariables: EnvVariablesServer,
        @inject(QuickInputService) protected readonly quickInput: QuickInputService,
        @inject(MessageService) protected readonly messageService: MessageService,
        @inject(ClipboardService) protected readonly clipboard: ClipboardService,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeMcpCommands.ENABLE, { execute: () => this.enable() });
        commands.registerCommand(NukeMcpCommands.DISABLE, { execute: () => this.disable() });
    }

    protected async enable(): Promise<void> {
        const answer = await this.quickInput.input({
            title: 'Enable MCP Endpoint',
            prompt: 'Port for the loopback MCP endpoint (1-65535)',
            value: String(NUKE_MCP_DEFAULT_PORT),
            placeHolder: String(NUKE_MCP_DEFAULT_PORT)
        });
        if (answer === undefined) {
            return;
        }
        const port = Number(answer.trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            this.messageService.warn('MCP port must be an integer between 1 and 65535.');
            return;
        }

        const token = globalThis.crypto.randomUUID();
        const configUri = resolveMcpConfigUri(await this.envVariables.getConfigDirUri());
        const config: NukeMcpFileConfig = { enabled: true, token, port };
        try {
            await this.fileService.write(configUri, `${JSON.stringify(config, null, 2)}\n`);

            // Write the token before turning delivery on so the endpoint never
            // starts unprotected, even briefly.
            await this.setUserPreference('nuke.ai.mcp.enabled', true);
            await this.setUserPreference('nuke.ai.mcp.port', port);
            await this.setUserPreference('externalApi.token', token);
            await this.setUserPreference('externalApi.hostname', '127.0.0.1');
            await this.setUserPreference('externalApi.port', port);
            await this.setUserPreference('externalApi.delivery', 'separatePort');
        } catch (error) {
            await this.rollbackEnable(configUri);
            this.logger.error('[NukeAI] Failed to enable the MCP endpoint.', error);
            this.messageService.error(`Failed to enable the MCP endpoint: ${errorMessage(error)}`);
            return;
        }

        const snippet = buildMcpClientConfigSnippet(port, token);
        const message = [`MCP endpoint: ${mcpEndpointUrl(port)}`, `Bearer token: ${token}`, '', 'Client configuration:', snippet].join(
            '\n'
        );
        this.logger.info(`[NukeAI] MCP endpoint enabled at ${mcpEndpointUrl(port)}.`);
        const action = await this.messageService.info(message, COPY_CLIENT_CONFIG_ACTION);
        if (action === COPY_CLIENT_CONFIG_ACTION) {
            await this.clipboard.writeText(snippet);
        }
    }

    protected async disable(): Promise<void> {
        try {
            await this.setUserPreference('externalApi.delivery', 'off');
            await this.setUserPreference('nuke.ai.mcp.enabled', false);
            await this.setUserPreference('externalApi.token', undefined);
            await this.setUserPreference('nuke.ai.mcp.port', undefined);

            const configUri = resolveMcpConfigUri(await this.envVariables.getConfigDirUri());
            await this.deleteConfigFile(configUri);
            this.messageService.info('MCP endpoint disabled.');
        } catch (error) {
            this.logger.error('[NukeAI] Failed to disable the MCP endpoint.', error);
            this.messageService.error(`Failed to disable the MCP endpoint: ${errorMessage(error)}`);
        }
    }

    /** Remove partial state when enabling fails before the endpoint is usable. */
    protected async rollbackEnable(configUri: URI): Promise<void> {
        await this.deleteConfigFile(configUri);
        await this.setUserPreference('externalApi.delivery', 'off').catch(() => undefined);
        await this.setUserPreference('externalApi.token', undefined).catch(() => undefined);
        await this.setUserPreference('nuke.ai.mcp.enabled', false).catch(() => undefined);
        await this.setUserPreference('nuke.ai.mcp.port', undefined).catch(() => undefined);
    }

    protected async deleteConfigFile(configUri: URI): Promise<void> {
        try {
            if (await this.fileService.exists(configUri)) {
                await this.fileService.delete(configUri, { useTrash: false });
            }
        } catch (error) {
            this.logger.warn('[NukeAI] Could not remove the MCP config file.', error);
        }
    }

    protected setUserPreference(name: string, value: unknown): Promise<void> {
        return this.preferences.set(name, value, PreferenceScope.User);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
