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
 * Health Command Contribution
 *
 * Registers commands and menu items for monitoring Nuke Core health,
 * viewing runtime diagnostics, and validating configuration.
 *
 * DI bindings:
 * - {@link NukeCoreService} – backend health, diagnostics, and validation APIs
 * - {@link MessageService} – user-facing toast notifications
 * - {@link OutputChannelManager} – output channel for structured results
 *
 * @see {@link NukeCoreCommands}
 *
 * @module nuke-core/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OutputChannelManager, OutputChannel } from '@theia/output/lib/browser/output-channel';
import { NukeCoreService } from '../services';
import { NukeCoreCommands } from './index';
import { NukeMenus } from '../nuke-core-menus';

@injectable()
export class NukeHealthCommandContribution implements CommandContribution, MenuContribution {

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(OutputChannelManager)
    protected readonly outputManager: OutputChannelManager;

    private outputChannel?: OutputChannel;

    /**
     * Registers health-related commands with the application command registry.
     *
     * @param commands - Theia command registry to register against.
     */
    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCoreCommands.HEALTH_CHECK, {
            execute: () => this.runHealthCheck()
        });

        commands.registerCommand(NukeCoreCommands.DIAGNOSTICS, {
            execute: () => this.showDiagnostics()
        });

        commands.registerCommand(NukeCoreCommands.VALIDATE_CONFIG, {
            execute: () => this.validateConfig()
        });
    }

    /**
     * Adds health commands to the Nuke Tools menu.
     *
     * @param menus - Theia menu model registry.
     */
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.HEALTH_CHECK.id,
            label: 'Run Health Check',
            order: 'c'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.VALIDATE_CONFIG.id,
            label: 'Validate Configuration',
            order: 'd'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.DIAGNOSTICS.id,
            label: 'Show Diagnostics',
            order: 'e'
        });
    }

    /**
     * Runs a full health check and renders the results to the Nuke Core output channel.
     *
     * @returns Resolves when results have been displayed.
     */
    protected async runHealthCheck(): Promise<void> {
        this.messageService.info('Running health check...', { timeout: 2000 });

        try {
            const result = await this.nukeCore.healthCheck();

            const lines: string[] = ['=== Nuke Core Health Check ===\n'];

            for (const check of result.checks) {
                const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
                lines.push(`${icon} ${check.name}: ${check.message}`);
                if (check.suggestion) {
                    lines.push(`  → ${check.suggestion}`);
                }
            }

            lines.push('');
            lines.push(result.healthy ? '✓ Overall: Healthy' : '✗ Overall: Issues Found');

            this.showOutput('Health Check', lines.join('\n'));

            if (result.healthy) {
                this.messageService.info('Health check passed!');
            } else {
                this.messageService.warn('Health check found issues. See output for details.');
            }
        } catch (error) {
            this.messageService.error(`Health check failed: ${error}`);
        }
    }

    /**
     * Fetches runtime diagnostics from the backend and displays them as formatted JSON
     * in the Nuke Core output channel.
     *
     * @returns Resolves when diagnostics have been displayed.
     */
    protected async showDiagnostics(): Promise<void> {
        try {
            const diagnostics = await this.nukeCore.getDiagnostics();
            const formatted = JSON.stringify(diagnostics, null, 2);
            this.showOutput('Diagnostics', formatted);
            this.messageService.info('Diagnostics displayed in output panel');
        } catch (error) {
            this.messageService.error(`Failed to get diagnostics: ${error}`);
        }
    }

    /**
     * Validates the current Nuke Core configuration and renders any errors or warnings
     * to the Nuke Core output channel.
     *
     * @returns Resolves when validation results have been displayed.
     */
    protected async validateConfig(): Promise<void> {
        try {
            const result = await this.nukeCore.validateConfig();

            const lines: string[] = ['=== Configuration Validation ===\n'];

            if (result.errors.length === 0 && result.warnings.length === 0) {
                lines.push('✓ Configuration is valid!');
            } else {
                for (const error of result.errors) {
                    lines.push(`✗ Error - ${error.field}: ${error.message}`);
                    if (error.value) {
                        lines.push(`  Current value: ${error.value}`);
                    }
                }

                for (const warning of result.warnings) {
                    lines.push(`⚠ Warning - ${warning.field}: ${warning.message}`);
                    if (warning.value) {
                        lines.push(`  Current value: ${warning.value}`);
                    }
                }
            }

            this.showOutput('Configuration Validation', lines.join('\n'));

            if (result.valid) {
                this.messageService.info('Configuration is valid!');
            } else {
                this.messageService.error('Configuration has errors. See output for details.');
            }
        } catch (error) {
            this.messageService.error(`Validation failed: ${error}`);
        }
    }

    /**
     * Appends content to the shared Nuke Core output channel and reveals it.
     *
     * @param title - Logical title of the output section (used for channel retrieval on first call).
     * @param content - Text to append to the channel.
     */
    protected showOutput(title: string, content: string): void {
        if (!this.outputChannel) {
            this.outputChannel = this.outputManager.getChannel('Nuke Core');
        }
        this.outputChannel.clear();
        this.outputChannel.appendLine(content);
        this.outputChannel.show();
    }
}
