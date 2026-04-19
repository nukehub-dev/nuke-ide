// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Health Command Contribution
 *
 * Commands: Health Check, Show Diagnostics, Validate Configuration
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

    protected showOutput(title: string, content: string): void {
        if (!this.outputChannel) {
            this.outputChannel = this.outputManager.getChannel('Nuke Core');
        }
        this.outputChannel.clear();
        this.outputChannel.appendLine(content);
        this.outputChannel.show();
    }
}
