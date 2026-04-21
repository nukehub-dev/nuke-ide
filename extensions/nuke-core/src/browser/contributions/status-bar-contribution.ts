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

import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar';
import { QuickPickService, QuickPickItem, QuickPickSeparator } from '@theia/core/lib/browser/quick-input';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { PreferenceService } from '@theia/core/lib/common/preferences';

import { EnvironmentActionsHelper, NukeCoreService } from '../services';
import { NukeEnvironment, NukeCoreStatusBarVisibility } from '../../common/nuke-core-protocol';
import { NukeCoreVisibilityService } from '../services/nuke-core-visibility-service';

/**
 * Quick pick item extension carrying an environment or action value.
 */
interface EnvironmentQuickPickItem extends QuickPickItem {
    value?: NukeEnvironment | 'settings' | 'refresh' | '__create__';
}

/**
 * Contributes a status-bar entry that displays and controls the active Nuke Python environment.
 *
 * Binds to Theia's {@link FrontendApplicationContribution} lifecycle and reacts to
 * environment changes, preference updates and visibility requests from dependent extensions.
 *
 * ### DI Bindings
 * - `StatusBar` – entry point to Theia's status bar API.
 * - `NukeCoreService` – source of truth for the current environment & configuration.
 * - `QuickPickService` – displays the environment selector.
 * - `MessageService` – user-facing notifications.
 * - `CommandService` – opens settings and triggers environment creation commands.
 * - `EnvironmentActionsHelper` – executes post-selection actions (e.g. environment management).
 * - `PreferenceService` – reads `nuke.*` preferences.
 * - `NukeCoreStatusBarVisibility` – allows other extensions to force the status bar to show.
 *
 * @see {@link NukeCoreService}
 * @see {@link NukeCoreVisibilityService}
 */
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

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;
    
    @inject(NukeCoreStatusBarVisibility)
    protected readonly visibilityService: NukeCoreVisibilityService;

    private readonly STATUS_BAR_ID = 'nuke-core.environment';

    /**
     * Lifecycle hook invoked when the frontend application starts.
     * Registers listeners and performs the initial status-bar render.
     */
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
    
    /**
     * Polls user-scope preferences every 5 seconds to catch edits that do not
     * fire {@link PreferenceService.onPreferenceChanged} (e.g. manual settings.json edits).
     * Triggers a status-bar refresh when a drift is detected.
     */
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

    /**
     * Renders or updates the status-bar element based on the current configuration,
     * environment state and visibility preferences.
     *
     * Behaviour matrix:
     * - `never`  → removes the element.
     * - `auto`   → shows only when un-configured or when an extension requests visibility.
     * - `always` → always shows (spinner while detecting, then resolved env info).
     *
     * @returns A promise that resolves once the status bar has been updated.
     */
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
                priority: 2,
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
                priority: 2
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
                priority: 2,
                onclick: () => this.showEnvironmentPicker()
            });
        }
    }

    /**
     * Returns an emoji icon representing the given environment type.
     *
     * @param type - The environment type (conda, venv, poetry, etc.).
     * @returns A single-character emoji string.
     */
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
     * Displays the environment quick-pick when no Python interpreter is configured yet.
     * Allows the user to select a discovered environment, open settings, refresh the list
     * or create a new environment.
     *
     * @returns A promise that resolves once the picker is dismissed and the status bar updated.
     * @see {@link showEnvironmentPicker}
     * @see {@link buildPickerItems}
     */
    protected async showEnvironmentPickerForUnconfigured(): Promise<void> {
        this.statusBar.setElement(this.STATUS_BAR_ID, {
            text: '$(sync~spin) Loading...',
            alignment: StatusBarAlignment.RIGHT,
            priority: 2
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
     * Configures nuke-core with the selected environment for the first time.
     *
     * @param env - The environment to activate.
     * @returns A promise that resolves once the switch attempt finishes.
     * @see {@link NukeCoreService.switchToEnvironment}
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

    /**
     * Displays the environment quick-pick for an already-configured workspace.
     * If the user clicks the currently active entry, {@link EnvironmentActionsHelper.showEnvActions}
     * is presented instead of re-switching.
     *
     * @returns A promise that resolves once the picker is dismissed and the status bar updated.
     * @see {@link showEnvironmentPickerForUnconfigured}
     * @see {@link switchToEnvironment}
     */
    protected async showEnvironmentPicker(): Promise<void> {
        // Show loading indicator
        this.statusBar.setElement(this.STATUS_BAR_ID, {
            text: '$(sync~spin) Loading...',
            alignment: StatusBarAlignment.RIGHT,
            priority: 2
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
                const env = selected.value as NukeEnvironment;
                if (current && current.pythonPath === env.pythonPath) {
                    // Clicked the currently active env — show actions instead of re-switching
                    await this.envActions.showEnvActions(env);
                } else {
                    await this.switchToEnvironment(env);
                }
            }
        } catch (error) {
            this.messageService.error(`Failed to list environments: ${error}`);
        } finally {
            this.updateStatusBar();
        }
    }

    /**
     * Delegates to {@link NukeCoreService.switchToEnvironment} and surfaces the result
     * via {@link MessageService}.
     *
     * @param env - The target environment.
     * @returns A promise that resolves once the switch attempt finishes.
     */
    protected async switchToEnvironment(env: NukeEnvironment): Promise<void> {
        try {
            await this.nukeCore.switchToEnvironment(env);
            this.messageService.info(`Switched to ${env.name}`);
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
        }
    }

    /**
     * Opens the Theia preferences view filtered to `nuke.` settings.
     */
    protected openSettings(): void {
        // Open settings and filter for Nuke Utils (search for 'nuke' which will show all nuke.* preferences)
        this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id, 'nuke.');
    }

    /**
     * Builds grouped quick-pick items for the environment selector.
     *
     * @param environments - All discovered environments.
     * @param current - The currently active environment (used to render a check-mark).
     * @returns A list of quick-pick items and separators ready for {@link QuickPickService.show}.
     */
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
