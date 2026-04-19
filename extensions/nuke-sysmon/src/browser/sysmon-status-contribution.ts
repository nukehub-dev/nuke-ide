// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { PreferenceChangeEvent } from '@theia/core/lib/common/preferences';
import { SysmonFrontendService } from './sysmon-service';
import { SYSMON_OPEN_DASHBOARD_COMMAND } from './sysmon-command-contribution';
import { SysmonPreferences, SysmonConfiguration } from './sysmon-preferences';

@injectable()
export class SysmonStatusContribution implements FrontendApplicationContribution {
    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(SysmonFrontendService)
    protected readonly sysmonService: SysmonFrontendService;

    @inject(SysmonPreferences)
    protected readonly preferences: SysmonPreferences;

    private updateInterval: NodeJS.Timeout | null = null;
    private currentIntervalMs: number = 2000;

    @postConstruct()
    protected init(): void {
        // Get initial interval from preferences
        this.currentIntervalMs = this.preferences['sysmon.updateInterval'];
        this.startUpdating();

        // Watch for preference changes
        this.preferences.onPreferenceChanged((event: PreferenceChangeEvent<SysmonConfiguration>) => {
            if (event.preferenceName === 'sysmon.updateInterval') {
                this.currentIntervalMs = this.preferences['sysmon.updateInterval'];
                this.restartUpdating();
            }
        });
    }

    private startUpdating(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.updateInterval = setInterval(() => {
            this.updateStatusBar();
        }, this.currentIntervalMs);
    }

    private restartUpdating(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        this.startUpdating();
    }

    onStop(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
    }

    private async updateStatusBar(): Promise<void> {
        try {
            const metrics = await this.sysmonService.getCurrentMetrics();
            this.renderStatusBar(metrics);
        } catch (error) {
            console.error('Failed to update system monitor:', error);
        }
    }

    private renderStatusBar(metrics: any): void {
        const cpu = Math.round(metrics.cpu.usagePercent);
        const mem = Math.round(metrics.memory.usagePercent);
        const disk = Math.round(metrics.disk.usagePercent);
        
        // Use Theia codicon icons (VS Code icon set)
        // Available icons: https://microsoft.github.io/vscode-codicons/dist/codicon.html
        this.statusBar.setElement('sysmon-main', {
            text: `$(chip) ${cpu}% $(server) ${mem}% $(database) ${disk}%`,
            tooltip: this.buildTooltip(metrics),
            alignment: StatusBarAlignment.RIGHT,
            priority: 1,
            command: SYSMON_OPEN_DASHBOARD_COMMAND.id
        });
    }

    private buildTooltip(metrics: any): string {
        // Status bar tooltips don't support multiline well, use single line format
        let tooltip = `CPU: ${metrics.cpu.usagePercent.toFixed(1)}% | Memory: ${metrics.memory.usagePercent.toFixed(1)}% | Disk: ${metrics.disk.usagePercent.toFixed(1)}%`;
        
        if (metrics.cpu.temperature) {
            tooltip += ` | Temp: ${metrics.cpu.temperature}°C`;
        }
        
        return tooltip;
    }
}
