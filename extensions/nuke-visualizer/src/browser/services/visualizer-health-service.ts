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
import { MessageService } from '@theia/core/lib/common';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { NukeCoreService } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';
import { BASE_VISUALIZER_REQUIREMENTS } from '../../common/base-visualizer-protocol';
import { OPENMC_REQUIREMENTS } from '../../common/openmc-protocol';
import { HealthCheckFramework } from '../services/health-check-framework';

@injectable()
export class VisualizerHealthService {
    @inject(HealthCheckFramework)
    protected readonly healthCheckFramework: HealthCheckFramework;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(OutputChannelManager)
    protected readonly outputChannelManager: OutputChannelManager;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    registerBaseRequirements(): void {
        this.healthCheckFramework.registerHealthRequirements({
            id: 'base-visualizer',
            name: 'Base Visualizer',
            packages: BASE_VISUALIZER_REQUIREMENTS
        });
    }

    async runHealthCheck(): Promise<void> {
        const report = await this.healthCheckFramework.runAllHealthChecks();
        const env = await this.nukeCore.getSelectedEnvironment();
        const envName = env?.name || 'current environment';
        const channel = this.outputChannelManager.getChannel('Nuke Visualizer');

        channel.clear();
        channel.appendLine('═'.repeat(50));
        channel.appendLine(` Nuke Visualizer Health Check — ${envName}`);
        channel.appendLine('═'.repeat(50));

        let totalErrors = 0;
        let totalWarnings = 0;

        for (const plugin of report.plugins) {
            channel.appendLine('');
            channel.appendLine(` ${plugin.pluginName}`);
            channel.appendLine('─'.repeat(40));

            const infraChecks = plugin.checks.filter((c) => !c.name.startsWith('Package:'));
            for (const check of infraChecks) {
                const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
                channel.appendLine(` ${icon} ${check.name}: ${check.message}`);
                if (!check.passed) {
                    if (check.severity === 'error') totalErrors++;
                    else totalWarnings++;
                }
            }

            const packageChecks = plugin.checks.filter((c) => c.name.startsWith('Package:'));
            for (const check of packageChecks) {
                const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
                channel.appendLine(` ${icon} ${check.message}`);
                if (!check.passed && check.suggestion) {
                    channel.appendLine(`   → ${check.suggestion}`);
                }
                if (!check.passed) {
                    if (check.severity === 'error') totalErrors++;
                    else totalWarnings++;
                }
            }
        }

        channel.appendLine('');
        if (report.healthy) {
            channel.appendLine('✓ All visualization plugins are healthy!');
        } else {
            channel.appendLine(` Summary: ${totalErrors} errors, ${totalWarnings} warnings`);
        }
        channel.appendLine('═'.repeat(50));
        channel.show({ preserveFocus: true });

        if (report.healthy) {
            this.messageService.info('All visualization plugins are healthy!');
        } else {
            this.messageService.warn(`Health check found missing packages in ${envName}. See Nuke Visualizer output.`);
        }
    }

    async installBaseVisualizerDeps(): Promise<void> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: BASE_VISUALIZER_REQUIREMENTS,
            title: 'Install Base Visualizer Dependencies'
        });
        if (result.success) {
            this.messageService.info('Base visualizer dependencies installed.');
        }
    }

    async installOpenMCDeps(): Promise<void> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: OPENMC_REQUIREMENTS,
            title: 'Install OpenMC Dependencies'
        });
        if (result.success) {
            this.messageService.info('OpenMC dependencies installed.');
        }
    }
}
