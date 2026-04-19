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
import { NukeEnvironment, NukeCoreStatusBarVisibility } from '../../common/nuke-core-protocol';
import { NukeCoreVisibilityService } from '../services/nuke-core-visibility-service';

interface EnvironmentQuickPickItem extends QuickPickItem {
    value?: NukeEnvironment | 'settings' | 'refresh' | '__create__';
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

        // Listen for fallback events - triggers status bar update to show warning
        this.nukeCore.onEnvironmentFallback(() => {
            this.updateStatusBar();
        });
        
        // Listen for preference changes (mainly workspace scope)
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'nuke.showStatusBar' || 
                event.preferenceName === 'nuke.pythonPath' || 
                event.preferenceName === 'nuke.condaEnv') {
                this.updateStatusBar();
            }
        });
        
        // Listen for visibility requests from dependent extensions
        this.visibilityService.onVisibilityChanged(() => {
            this.updateStatusBar();
        });
        
        // Poll for user preference changes every 5 seconds
        // This catches user scope changes that don't trigger onPreferenceChanged
        setInterval(() => this.checkUserPreferences(), 5000);
    }
    
    private lastUserPythonPath?: string;
    private lastUserCondaEnv?: string;
    
    private async checkUserPreferences(): Promise<void> {
        // Check if user preferences have changed
        const inspectPath = this.preferences.inspect<string>('nuke.pythonPath');
        const inspectEnv = this.preferences.inspect<string>('nuke.condaEnv');
        
        const userPythonPath = inspectPath?.globalValue?.trim();
        const userCondaEnv = inspectEnv?.globalValue?.trim();
        
        const prefsChanged = userPythonPath !== this.lastUserPythonPath || 
                           userCondaEnv !== this.lastUserCondaEnv;
        
        if (prefsChanged) {
            console.log('[NukeCore] User preferences changed via direct edit');
            this.lastUserPythonPath = userPythonPath;
            this.lastUserCondaEnv = userCondaEnv;
            this.updateStatusBar();
        }
    }

    protected async updateStatusBar(): Promise<void> {
        const showStatusBar = this.preferences.get('nuke.showStatusBar') as 'auto' | 'always' | 'never';
        
        // Never show if set to 'never'
        if (showStatusBar === 'never') {
            this.statusBar.removeElement(this.STATUS_BAR_ID);
            return;
        }

        // Get status - uses internal config state
        const status = this.nukeCore.getStatus();
        const isConfigured = status.configured;
        const visibilityRequested = this.visibilityService.isVisibilityRequested();
        
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
                priority: 200,
                onclick: () => this.showEnvironmentPickerForUnconfigured()
            });
            return;
        }

        // If we get here, either we're in 'always' mode, or an extension requested visibility
        if (!status.ready) {
            this.statusBar.setElement(this.STATUS_BAR_ID, {
                text: '$(sync~spin) Nuke: Detecting...',
                tooltip: 'Detecting environment...',
                alignment: StatusBarAlignment.RIGHT,
                priority: 200
            });
            return;
        }

        const env = status.environment;
        if (env) {
            const fallbackEnv = status.fallbackEnvironment;
            const isFallback = !!fallbackEnv;
            
            // Get the configured environment name from preferences
            const configuredCondaEnv = this.preferences.get('nuke.condaEnv') as string | undefined;
            const configuredPythonPath = this.preferences.get('nuke.pythonPath') as string | undefined;
            
            // For conda env, use the exact env name; for pythonPath, extract the name from path
            let configuredName: string | undefined;
            if (configuredCondaEnv) {
                configuredName = configuredCondaEnv;
            } else if (configuredPythonPath) {
                // Extract name from python path (e.g., /usr/bin/python3 -> python3)
                configuredName = configuredPythonPath.split('/').pop() || 'Custom';
            }
            
            const icon = this.getEnvironmentIcon(env.type);
            
            // Show the configured environment name (not the fallback) in status bar
            const displayName = configuredName || env.name;
            
            const fallbackIndicator = isFallback ? '⚠️ ' : '';
            const text = `${fallbackIndicator}${icon} ${displayName}`;
            
            const tooltip = isFallback && fallbackEnv
                ? `Configured: ${configuredName}\nActually using: ${fallbackEnv.name} (${fallbackEnv.version || 'unknown'})\nClick to switch environment`
                : `Environment: ${env.name} (${env.version || 'unknown version'})\nClick to switch environment`;
            
            this.statusBar.setElement(this.STATUS_BAR_ID, {
                text,
                tooltip,
                alignment: StatusBarAlignment.RIGHT,
                priority: 200,
                onclick: () => this.showEnvironmentPicker()
            });
        }
    }

    private getEnvironmentIcon(type: NukeEnvironment['type']): string {
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
            priority: 200
        });

        try {
            const environments = await this.nukeCore.listEnvironments(true);
            const items = this.buildPickerItems(environments);

            const placeholder = environments.length > 0
                ? 'Select Nuke environment or open settings'
                : 'No environments found. Open settings to configure.';

            const selected = await this.quickPick.show(items, { placeholder });

            if (!selected || !('value' in selected)) {
                // User cancelled
            } else if (selected.value === 'settings') {
                this.openSettings();
            } else if (selected.value === 'refresh') {
                this.showEnvironmentPickerForUnconfigured();
            } else if (selected.value === '__create__') {
                this.commandService.executeCommand('nuke.core.createEnvironment');
            } else if (selected.value) {
                await this.selectEnvironmentForFirstTime(selected.value as NukeEnvironment);
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
    protected async selectEnvironmentForFirstTime(env: NukeEnvironment): Promise<void> {
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
            priority: 200
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

            const items = this.buildPickerItems(environments, current);

            const selected = await this.quickPick.show(items, {
                placeholder: 'Select Nuke Environment'
            });

            if (!selected || !('value' in selected)) {
                // User cancelled
            } else if (selected.value === 'settings') {
                this.openSettings();
            } else if (selected.value === 'refresh') {
                this.showEnvironmentPicker();
            } else if (selected.value === '__create__') {
                this.commandService.executeCommand('nuke.core.createEnvironment');
            } else if (selected.value) {
                await this.switchToEnvironment(selected.value as NukeEnvironment);
            }
        } catch (error) {
            this.messageService.error(`Failed to list environments: ${error}`);
        } finally {
            this.updateStatusBar();
        }
    }

    protected async switchToEnvironment(env: NukeEnvironment): Promise<void> {
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

    private buildPickerItems(
        environments: NukeEnvironment[],
        current?: NukeEnvironment
    ): Array<EnvironmentQuickPickItem | QuickPickSeparator> {
        const condaEnvs = environments.filter(e => e.type === 'conda');
        const venvEnvs = environments.filter(e => e.type === 'venv' || e.type === 'virtualenv');
        const otherEnvs = environments.filter(e => !['conda', 'venv', 'virtualenv'].includes(e.type));

        const items: Array<EnvironmentQuickPickItem | QuickPickSeparator> = [];

        const addGroup = (label: string, envs: NukeEnvironment[], icon: string) => {
            if (envs.length === 0) return;
            items.push({ type: 'separator', label });
            for (const env of envs) {
                const isActive = current?.pythonPath === env.pythonPath;
                items.push({
                    label: `${isActive ? '✓ ' : ''}${icon} ${env.name}`,
                    description: env.version || '',
                    detail: env.pythonPath,
                    value: env
                });
            }
        };

        addGroup('Conda Environments', condaEnvs, '🐍');
        addGroup('Virtual Environments', venvEnvs, '📦');
        addGroup('Other', otherEnvs, '🐧');

        items.push({ type: 'separator', label: 'Actions' });
        items.push({ label: '➕ Create new environment', value: '__create__' });
        items.push({ label: '🔄 Refresh environments', value: 'refresh' });
        items.push({ label: '$(settings) Open Settings...', value: 'settings' });

        return items;
    }
}
