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
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, OpenHandler, FrontendApplicationContribution, FrontendApplication, WidgetManager } from '@theia/core/lib/browser';
import { OpenViewArguments } from '@theia/core/lib/browser/shell/view-contribution';
import URI from '@theia/core/lib/common/uri';
import { VisualizerWidget } from './visualizer-widget';
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { VisualizerBackendService, BASE_VISUALIZER_REQUIREMENTS } from '../common/base-visualizer-protocol';
import { OPENMC_REQUIREMENTS } from '../common/openmc-protocol';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService, NukeCoreService } from 'nuke-core/lib/common';
import { HealthCheckFramework } from './services/health-check-framework';
import { MessageService } from '@theia/core/lib/common';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';

export const VisualizerCommand = {
    id: VisualizerWidget.ID,
    label: 'Open Visualizer'
};

export const VisualizerHealthCheckCommand = {
    id: 'nuke-visualizer.health-check',
    label: 'Run Health Check',
    category: 'Visualizer'
};

export const InstallBaseVisualizerCommand = {
    id: 'nuke-visualizer.install-base',
    label: 'Install Base Visualizer Dependencies',
    category: 'Visualizer'
};

export const InstallOpenMCCommand = {
    id: 'nuke-visualizer.install-openmc',
    label: 'Install OpenMC Dependencies',
    category: 'Visualizer'
};

export namespace NukeVisualizerMenus {
    /** Root Visualizer menu under Tools */
    export const VISUALIZER = [...NukeMenus.TOOLS, '2_visualizer'];

    /** Environment submenu under Visualizer */
    export const ENVIRONMENT = [...VISUALIZER, 'z_environment'];

    /** OpenMC plugin submenu under Visualizer */
    export const OPENMC = [...VISUALIZER, '1_openmc'];

    // OpenMC sub-menus (kept for backward compatibility during migration)
    export const OPENMC_STATEPOINT = [...OPENMC, '1_statepoint'];
    export const OPENMC_TALLY = [...OPENMC, '2_tally'];
    export const OPENMC_DEPLETION = [...OPENMC, '3_depletion'];
    export const OPENMC_GEOMETRY = [...OPENMC, '4_geometry'];
    export const OPENMC_MATERIAL = [...OPENMC, '5_material'];
    export const OPENMC_PLOT = [...OPENMC, '6_plot'];

    // Deprecated aliases — will be removed in Phase 5
    /** @deprecated Use OPENMC_STATEPOINT */
    export const VISUALIZER_STATEPOINT = OPENMC_STATEPOINT;
    /** @deprecated Use OPENMC_TALLY */
    export const VISUALIZER_TALLY = OPENMC_TALLY;
    /** @deprecated Use OPENMC_DEPLETION */
    export const VISUALIZER_DEPLETION = OPENMC_DEPLETION;
    /** @deprecated Use OPENMC_GEOMETRY */
    export const VISUALIZER_GEOMETRY = OPENMC_GEOMETRY;
    /** @deprecated Use OPENMC_MATERIAL */
    export const VISUALIZER_MATERIAL = OPENMC_MATERIAL;
    /** @deprecated Use OPENMC_PLOT */
    export const VISUALIZER_PLOT = OPENMC_PLOT;
}

@injectable()
export class VisualizerContribution extends AbstractViewContribution<VisualizerWidget> implements OpenHandler, FrontendApplicationContribution {
    readonly id = 'nuke-visualizer.opener';
    readonly label = 'Open in Nuke Visualizer';

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend: VisualizerBackendService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(FrontendApplication)
    protected readonly app: FrontendApplication;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly visibilityService: NukeCoreStatusBarVisibilityService;

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

    constructor() {
        super({
            widgetId: VisualizerWidget.ID,
            widgetName: VisualizerWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main',
            }
        });
    }

    async onStart(app: FrontendApplication): Promise<void> {
        // Multi-instance support enabled, no longer need to force-close singletons
    }

    override registerCommands(commands: CommandRegistry): void {
        // Register base visualizer health requirements eagerly (not in onStart)
        this.healthCheckFramework.registerHealthRequirements({
            id: 'base-visualizer',
            name: 'Base Visualizer',
            packages: BASE_VISUALIZER_REQUIREMENTS
        });
        commands.registerCommand(VisualizerCommand, {
            execute: () => this.openView({ reveal: true, activate: true }),
        });
        commands.registerCommand(VisualizerHealthCheckCommand, {
            execute: () => this.runHealthCheck(),
        });
        commands.registerCommand(InstallBaseVisualizerCommand, {
            execute: () => this.installBaseVisualizerDeps(),
        });
        commands.registerCommand(InstallOpenMCCommand, {
            execute: () => this.installOpenMCDeps(),
        });
    }

    protected async runHealthCheck(): Promise<void> {
        const report = await this.healthCheckFramework.runAllHealthChecks();
        const env = await this.nukeCore.getSelectedEnvironment();
        const envName = env?.name || 'current environment';
        const channel = this.outputChannelManager.getChannel('Nuke Visualizer');

        channel.clear();
        channel.appendLine('═'.repeat(50));
        channel.appendLine(` Nuke Visualizer Health Check — ${envName}`);
        channel.appendLine('═'.repeat(50));

        // Count totals across all plugins
        let totalErrors = 0;
        let totalWarnings = 0;

        for (const plugin of report.plugins) {
            channel.appendLine('');
            channel.appendLine(` ${plugin.pluginName}`);
            channel.appendLine('─'.repeat(40));

            // Show infrastructure checks first
            const infraChecks = plugin.checks.filter(c => !c.name.startsWith('Package:'));
            for (const check of infraChecks) {
                const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
                channel.appendLine(` ${icon} ${check.name}: ${check.message}`);
                if (!check.passed) {
                    if (check.severity === 'error') totalErrors++;
                    else totalWarnings++;
                }
            }

            // Show package checks (use backend message which includes versions)
            const packageChecks = plugin.checks.filter(c => c.name.startsWith('Package:'));
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
            this.messageService.warn(
                `Health check found missing packages in ${envName}. See Nuke Visualizer output.`
            );
        }
    }

    override registerMenus(menus: MenuModelRegistry): void {
        menus.registerSubmenu(NukeVisualizerMenus.VISUALIZER, 'Visualizer');
        menus.registerMenuAction(NukeVisualizerMenus.VISUALIZER, {
            commandId: VisualizerCommand.id,
            label: VisualizerCommand.label,
            order: '0_main'
        });
        menus.registerSubmenu(NukeVisualizerMenus.ENVIRONMENT, 'Environment');
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: VisualizerHealthCheckCommand.id,
            label: VisualizerHealthCheckCommand.label,
            order: 'a'
        });
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: InstallBaseVisualizerCommand.id,
            label: InstallBaseVisualizerCommand.label,
            order: 'b'
        });
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: InstallOpenMCCommand.id,
            label: InstallOpenMCCommand.label,
            order: 'c'
        });
    }

    canHandle(uri: URI): number {
        const ext = uri.path.ext.toLowerCase();
        // Prioritize nuclear engineering file formats
        if (ext === '.h5m') {
            return 1000; // High priority for DAGMC files
        }
        if (['.vtk', '.vtu', '.vtp', '.vts', '.vtr', '.pvtu', '.pvtp'].includes(ext)) {
            return 500; // Medium priority for VTK files
        }
        if (['.stl', '.ply', '.obj'].includes(ext)) {
            return 100; // Low priority for mesh files
        }
        return 0;
    }

    override async openView(args?: Partial<OpenViewArguments>): Promise<VisualizerWidget> {
        const widget = await super.openView(args);
        const handle = this.visibilityService.requestVisibility('nuke-visualizer');
        widget.disposed.connect(() => handle.dispose());
        return widget;
    }

    private async installBaseVisualizerDeps(): Promise<void> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: BASE_VISUALIZER_REQUIREMENTS,
            title: 'Install Base Visualizer Dependencies'
        });
        if (result.success) {
            this.messageService.info('Base visualizer dependencies installed.');
        }
    }

    private async installOpenMCDeps(): Promise<void> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: OPENMC_REQUIREMENTS,
            title: 'Install OpenMC Dependencies'
        });
        if (result.success) {
            this.messageService.info('OpenMC dependencies installed.');
        }
    }

    async open(uri: URI): Promise<VisualizerWidget> {
        const filePath = uri.path.toString();
        
        // Find existing widget for this file
        const widgets = this.app.shell.getWidgets('main');
        const existing = widgets.find(w => w instanceof VisualizerWidget && w.id.endsWith(filePath)) as VisualizerWidget;
        
        if (existing) {
            console.log(`[Visualizer] Found existing widget for ${filePath}, activating: ${existing.id}`);
            this.app.shell.activateWidget(existing.id);
            await existing.loadFile(uri);
            return existing;
        }

        console.log(`[Visualizer] Creating new widget for ${filePath}`);
        
        // Create new widget via factory with options
        const widget = await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { 
            uri: uri.toString() 
        }) as VisualizerWidget;
        
        // Ensure ID is unique and set correctly
        widget.setUri(uri);

        // Add to shell if not already there
        if (!widget.isAttached) {
            this.app.shell.addWidget(widget, { area: 'main' });
        }
        
        // Reveal and activate
        this.app.shell.activateWidget(widget.id);

        // Load the file
        await widget.loadFile(uri);

        // Request status bar visibility while this widget is open
        const handle = this.visibilityService.requestVisibility('nuke-visualizer');
        widget.disposed.connect(() => handle.dispose());
        
        return widget;
    }
}
