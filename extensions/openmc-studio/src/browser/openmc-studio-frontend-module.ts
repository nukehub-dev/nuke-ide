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
 * OpenMC Studio Frontend Module
 *
 * Entry point for the OpenMC Studio Theia extension on the frontend.
 * Registers services, commands, menus, widget factories, and preference
 * bindings within the Inversify container.
 *
 * @module openmc-studio/browser
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import {
    WebSocketConnectionProvider,
    FrontendApplicationContribution,
    OpenHandler,
    WidgetFactory
} from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common/command';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';

// Protocol imports
import {
    OpenMCStudioBackendService,
    OpenMCStudioClient,
    OPENMC_STUDIO_BACKEND_PATH
} from '../common/openmc-studio-protocol';

// Service imports
import { OpenMCStudioService } from './openmc-studio-service';
import { OpenMCStateManager } from './openmc-state-manager';
import { OpenMCXMLGenerationService } from './xml-generator/xml-generation-service';
import { OpenMCSimulationRunner } from './widgets/simulation-dashboard/simulation-runner';
import { OpenMCPythonExporter } from './script-generator/python-exporter';

// New modular services
import {
    OpenMCEnvironmentService,
    OpenMCHealthService,
    OpenMCInstallerService
} from './services';

// Command imports
import {
    EnvironmentCommands,
    ProjectCommands,
    SimulationCommands,
    ViewCommands
} from './commands';

// Modular contributions
import {
    OpenMCCommandContribution,
    OpenMCMenuContribution,
    OpenMCToolbarContribution,
    OpenMCOpenHandlerContribution
} from './contributions';

// Widget imports
import { SimulationDashboardWidget } from './widgets/simulation-dashboard/simulation-dashboard-widget';
import { CSGBuilderWidget } from './widgets/csg-builder/csg-builder-widget';
import { DAGMCEditorWidget } from './widgets/dagmc-editor/dagmc-editor-widget';
import { TallyConfiguratorWidget } from './widgets/tally-configurator/tally-configurator-widget';
import { SimulationComparisonWidget } from './widgets/simulation-comparison/comparison-widget';
import { OptimizationWidget } from './widgets/optimization/optimization-widget';

// Preferences
import { bindOpenMCStudioPreferences } from './openmc-studio-preferences';

// Import CSS
import './widgets/simulation-dashboard/simulation-dashboard.css';
import './widgets/csg-builder/csg-builder.css';
import './widgets/dagmc-editor/dagmc-editor.css';
import './widgets/tally-configurator/tally-configurator.css';
import './widgets/simulation-comparison/comparison.css';
import './widgets/optimization/optimization.css';

/**
 * The OpenMC Studio frontend {@link ContainerModule}.
 *
 * Binds all services, contributions, and widget factories required by the
 * OpenMC Studio extension. This module is loaded automatically by Theia
 * when the extension is present.
 */
export default new ContainerModule((bind: interfaces.Bind) => {
    console.log('[OpenMC Studio] Initializing frontend module...');

    // ============================================================================
    // Preferences
    // ============================================================================
    bindOpenMCStudioPreferences(bind);

    // ============================================================================
    // Backend Service Proxy
    // ============================================================================
    bind(OpenMCStudioBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);

        const client: OpenMCStudioClient = {
            log: (message: string) => {
                window.dispatchEvent(new CustomEvent('openmc-output', { detail: { type: 'stdout', data: message } }));
            },
            error: (message: string) => {
                window.dispatchEvent(new CustomEvent('openmc-output', { detail: { type: 'stderr', data: message } }));
            },
            warn: (message: string) => {
                window.dispatchEvent(new CustomEvent('openmc-output', { detail: { type: 'stderr', data: message } }));
            },
            onSimulationStatus: (event) => {
                window.dispatchEvent(new CustomEvent('openmc-simulation-status', { detail: event }));
            },
            onProgress: () => {},
            onStateChange: () => {},
            onOptimizationProgress: (event) => {
                window.dispatchEvent(new CustomEvent('openmc-optimization-progress', { detail: event }));
            },
            onOptimizationIterationComplete: (runId, result) => {
                window.dispatchEvent(new CustomEvent('openmc-optimization-iteration', { detail: { runId, result } }));
            }
        };

        return connectionProvider.createProxy<OpenMCStudioBackendService>(OPENMC_STUDIO_BACKEND_PATH, client);
    }).inSingletonScope();

    // ============================================================================
    // Core Services
    // ============================================================================
    bind(OpenMCStudioService).toSelf().inSingletonScope();
    bind(OpenMCStateManager).toSelf().inSingletonScope();
    bind(OpenMCXMLGenerationService).toSelf().inSingletonScope();
    bind(OpenMCSimulationRunner).toSelf().inSingletonScope();
    bind(OpenMCPythonExporter).toSelf().inSingletonScope();

    // ============================================================================
    // Environment & Health Services
    // ============================================================================
    bind(OpenMCEnvironmentService).toSelf().inSingletonScope();
    bind(OpenMCHealthService).toSelf().inSingletonScope();
    bind(OpenMCInstallerService).toSelf().inSingletonScope();

    // ============================================================================
    // Command Modules
    // ============================================================================
    bind(EnvironmentCommands).toSelf().inSingletonScope();
    bind(ProjectCommands).toSelf().inSingletonScope();
    bind(SimulationCommands).toSelf().inSingletonScope();
    bind(ViewCommands).toSelf().inSingletonScope();

    // ============================================================================
    // Modular Contributions
    // ============================================================================
    bind(OpenMCCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCCommandContribution);

    bind(OpenMCMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(OpenMCMenuContribution);

    bind(OpenMCToolbarContribution).toSelf().inSingletonScope();
    bind(TabBarToolbarContribution).toService(OpenMCToolbarContribution);

    // OpenHandler for .nuke-openmc files
    bind(OpenMCOpenHandlerContribution).toSelf().inSingletonScope();
    bind(OpenHandler).toService(OpenMCOpenHandlerContribution);
    bind(FrontendApplicationContribution).toService(OpenMCOpenHandlerContribution);

    // ============================================================================
    // Widget Factories
    // ============================================================================
    bind(SimulationDashboardWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: SimulationDashboardWidget.ID,
        createWidget: () => container.get(SimulationDashboardWidget)
    })).inSingletonScope();

    bind(CSGBuilderWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: CSGBuilderWidget.ID,
        createWidget: () => container.get(CSGBuilderWidget)
    })).inSingletonScope();

    bind(DAGMCEditorWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: DAGMCEditorWidget.ID,
        createWidget: () => container.get(DAGMCEditorWidget)
    })).inSingletonScope();

    bind(TallyConfiguratorWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: TallyConfiguratorWidget.ID,
        createWidget: () => container.get(TallyConfiguratorWidget)
    })).inSingletonScope();

    bind(SimulationComparisonWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: SimulationComparisonWidget.ID,
        createWidget: () => container.get(SimulationComparisonWidget)
    })).inSingletonScope();

    bind(OptimizationWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: OptimizationWidget.ID,
        createWidget: () => container.get(OptimizationWidget)
    }));

    console.log('[OpenMC Studio] Frontend module initialized');
});

// Re-exports for consumers of the frontend module.
/** @see {@link OpenMCStudioService} */
export { OpenMCStudioService } from './openmc-studio-service';
/** @see {@link OpenMCStateManager} */
export { OpenMCStateManager } from './openmc-state-manager';
/** @see {@link OpenMCEnvironmentService} */
export { OpenMCEnvironmentService, OpenMCEnvironmentStatus } from './services';
/** @see {@link OpenMCHealthService} */
export { OpenMCHealthService, HealthCheckResult, HealthCheckIssue, HealthCheckItem } from './services';
/** @see {@link OpenMCInstallerService} */
export { OpenMCInstallerService, InstallOption, InstallResult } from './services';
