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
