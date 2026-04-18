// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar';
import { QuickPickService, QuickPickItem, QuickPickSeparator } from '@theia/core/lib/browser/quick-input';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { NukeCoreService } from '../services/nuke-core-service';
import { PythonEnvironment, NukeCoreStatusBarVisibility } from '../../common/nuke-core-protocol';
import { NukeCoreVisibilityService } from '../services/nuke-core-visibility-service';

interface EnvironmentQuickPickItem extends QuickPickItem {
    value?: PythonEnvironment | 'settings' | 'refresh';
}

@injectable()
export class NukeCoreStatusBarContribution implements FrontendApplicationContribution {
    
    @inject(StatusBar)
    protected readonly statusBar: StatusBar;
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;
    
    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(CommandService)
    protected readonly commandService: CommandService;
    
    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;
    
    @inject(NukeCoreStatusBarVisibility)
    protected readonly visibilityService: NukeCoreVisibilityService;

    private readonly STATUS_BAR_ID = 'nuke-core.environment';

    onStart(): void {
        // Initial update
        this.updateStatusBar();
        
        // Listen for status changes
        this.nukeCore.onStatusChanged(() => {
            this.updateStatusBar();
        });

        // Listen for environment changes
        this.nukeCore.onEnvironmentChanged(() => {
            this.updateStatusBar();
        });

        // Listen for preference changes
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'nuke.showStatusBar' || 
                event.preferenceName === 'nuke.pythonPath' || 
                event.preferenceName === 'nuke.condaEnv') {
                console.log(`[NukeCore] Status bar updating due to preference change: ${event.preferenceName}`);
                this.updateStatusBar();
            }
        });
        
        // Listen for visibility requests from dependent extensions
        this.visibilityService.onVisibilityChanged(() => {
            console.log('[NukeCore] Status bar updating due to visibility request change');
            this.updateStatusBar();
        });
    }

    protected async updateStatusBar(): Promise<void> {
        const showStatusBar = this.preferences.get('nuke.showStatusBar') as 'auto' | 'always' | 'never';
        
        // Never show if set to 'never'
        if (showStatusBar === 'never') {
            this.statusBar.removeElement(this.STATUS_BAR_ID);
            return;
        }

        const isConfigured = this.nukeCore.isConfigured();
        const visibilityRequested = this.visibilityService.isVisibilityRequested();
        console.log(`[NukeCore] Status bar update - configured: ${isConfigured}, visibilityRequested: ${visibilityRequested}`);
        
        // In 'auto' mode:
        // - Show when not configured (prompt user to configure)
        // - Show when an extension requests visibility (e.g., nuke-visualizer is open)
        // - Hide when configured and no visibility request
        if (showStatusBar === 'auto' && isConfigured && !visibilityRequested) {
            this.statusBar.removeElement(this.STATUS_BAR_ID);
            return;
        }
        
        if (!isConfigured) {
            this.statusBar.setElement(this.STATUS_BAR_ID, {
                text: '$(warning) Nuke: Not Configured',
                tooltip: 'Click to select environment',
                alignment: StatusBarAlignment.RIGHT,
                priority: 100,
                onclick: () => this.showEnvironmentPickerForUnconfigured()
            });
            return;
        }

        // If we get here, either we're in 'always' mode, or an extension requested visibility
        const status = this.nukeCore.getStatus();
        
        if (!status.ready) {
            this.statusBar.setElement(this.STATUS_BAR_ID, {
                text: '$(sync~spin) Nuke: Detecting...',
                tooltip: 'Detecting environment...',
                alignment: StatusBarAlignment.RIGHT,
                priority: 100
            });
            return;
        }

        const env = status.environment;
        if (env) {
            // Get the configured environment name from preferences (not the fallback)
            const configuredCondaEnv = this.preferences.get('nuke.condaEnv') as string | undefined;
            const configuredPythonPath = this.preferences.get('nuke.pythonPath') as string | undefined;
            const configuredName = configuredCondaEnv || (configuredPythonPath ? 'Custom' : undefined);
            
            // Check if we're using a fallback (configured != actual)
            const isFallback = configuredName && configuredName !== env.name;
            
            const icon = this.getEnvironmentIcon(env.type);
            const displayName = configuredName || env.name;
            const fallbackIndicator = isFallback ? '⚠️ ' : '';
            const text = `${fallbackIndicator}${icon} ${displayName}`;
            
            const tooltip = isFallback 
                ? `Configured: ${displayName}\nActually using: ${env.name} (${env.version || 'unknown'})\nClick to switch environment`
                : `Environment: ${env.name} (${env.version || 'unknown version'})\nClick to switch environment`;
            
            this.statusBar.setElement(this.STATUS_BAR_ID, {
                text,
                tooltip,
                alignment: StatusBarAlignment.RIGHT,
                priority: 100,
                onclick: () => this.showEnvironmentPicker()
            });
        }
    }

    private getEnvironmentIcon(type: PythonEnvironment['type']): string {
        switch (type) {
            case 'conda': return '🐍';
            case 'venv':
            case 'virtualenv': return '📦';
            case 'poetry': return '📜';
            case 'pyenv': return '🔧';
            case 'system': return '🐧';
            default: return '🐍';
        }
    }

    /**
     * Show picker when Python is not configured - allows selecting from available environments
     * or opening settings for manual configuration
     */
    protected async showEnvironmentPickerForUnconfigured(): Promise<void> {
        this.statusBar.setElement(this.STATUS_BAR_ID, {
            text: '$(sync~spin) Loading...',
            alignment: StatusBarAlignment.RIGHT,
            priority: 100
        });

        try {
            // Search for available environments
            const environments = await this.nukeCore.listEnvironments(true);

            const items: Array<EnvironmentQuickPickItem | QuickPickSeparator> = [];

            // If we found environments, show them
            if (environments.length > 0) {
                items.push(
                    { type: 'separator' as const, label: 'Available Environments' },
                    ...environments.map(env => ({
                        label: `${env.type === 'conda' ? '🐍' : env.type === 'system' ? '🐧' : '📦'} ${env.name}`,
                        description: env.version || '',
                        detail: env.pythonPath,
                        value: env
                    }))
                );
            }

            // Always show actions
            items.push(
                { type: 'separator' as const, label: 'Actions' },
                { label: '$(settings) Open Settings...', value: 'settings' },
                { label: '$(refresh) Refresh', value: 'refresh' }
            );

            const placeholder = environments.length > 0 
                ? 'Select Python environment or open settings'
                : 'No environments found. Open settings to configure.';

            const selected = await this.quickPick.show(items, { placeholder });

            if (!selected) {
                // User cancelled
            } else if (selected.value === 'settings') {
                this.openSettings();
            } else if (selected.value === 'refresh') {
                this.showEnvironmentPickerForUnconfigured();
            } else if (selected.value) {
                // User selected an environment
                await this.selectEnvironmentForFirstTime(selected.value as PythonEnvironment);
            }
        } catch (error) {
            this.messageService.error(`Failed to list environments: ${error}`);
        } finally {
            this.updateStatusBar();
        }
    }

    /**
     * Select environment for the first time - configures nuke-core with the selected environment
     */
    protected async selectEnvironmentForFirstTime(env: PythonEnvironment): Promise<void> {
        try {
            await this.nukeCore.switchToEnvironment(env);
            this.messageService.info(`Configured Python: ${env.name}`);
            // Status bar will update automatically via preference change event
        } catch (error) {
            this.messageService.error(`Failed to configure environment: ${error}`);
        }
    }

    protected async showEnvironmentPicker(): Promise<void> {
        // Show loading indicator
        this.statusBar.setElement(this.STATUS_BAR_ID, {
            text: '$(sync~spin) Loading...',
            alignment: StatusBarAlignment.RIGHT,
            priority: 100
        });

        try {
            const environments = await this.nukeCore.listEnvironments(true);
            const current = await this.nukeCore.getSelectedEnvironment();

            if (environments.length === 0) {
                const items: Array<EnvironmentQuickPickItem | QuickPickSeparator> = [
                    { label: '$(settings) Open Settings', value: 'settings' },
                    { label: '$(refresh) Refresh', value: 'refresh' }
                ];
                const choice = await this.quickPick.show(items, { placeholder: 'No Python environments found' });

                if (choice?.value === 'settings') {
                    this.openSettings();
                } else if (choice?.value === 'refresh') {
                    this.showEnvironmentPicker();
                }
                return;
            }

            const items: Array<EnvironmentQuickPickItem | QuickPickSeparator> = [
                // Environments first
                ...environments.map(env => ({
                    label: `${env.type === 'conda' ? '🐍' : env.type === 'system' ? '🐧' : '📦'} ${env.name}`,
                    description: env.version || '',
                    detail: env.pythonPath,
                    value: env,
                    picked: current?.pythonPath === env.pythonPath
                })),
                // Separator
                { type: 'separator' as const, label: 'Actions' },
                // Action items
                { label: '$(settings) Open Settings...', value: 'settings' },
                { label: '$(refresh) Refresh List', value: 'refresh' }
            ];

            const selected = await this.quickPick.show(items, {
                placeholder: 'Select Python Environment'
            });

            if (!selected) {
                // User cancelled
            } else if (selected.value === 'settings') {
                this.openSettings();
            } else if (selected.value === 'refresh') {
                this.showEnvironmentPicker();
            } else if (selected.value) {
                await this.switchToEnvironment(selected.value as PythonEnvironment);
            }
        } catch (error) {
            this.messageService.error(`Failed to list environments: ${error}`);
        } finally {
            this.updateStatusBar();
        }
    }

    protected async switchToEnvironment(env: PythonEnvironment): Promise<void> {
        try {
            await this.nukeCore.switchToEnvironment(env);
            this.messageService.info(`Switched to ${env.name}`);
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
        }
    }

    protected openSettings(): void {
        // Open settings and filter for Nuke Utils (search for 'nuke' which will show all nuke.* preferences)
        this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id, 'nuke.');
    }
}
