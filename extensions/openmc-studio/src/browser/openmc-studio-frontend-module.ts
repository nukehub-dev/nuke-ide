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

/**
 * OpenMC Studio Frontend Module
 * 
 * This is the entry point for the OpenMC Studio Theia extension on the frontend.
 * It configures dependency injection and registers contributions.
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
import { OpenMCSimulationRunner } from './simulation-dashboard/simulation-runner';
import { OpenMCPythonExporter } from './script-generator/python-exporter';

// Contribution imports
import { OpenMCStudioContribution } from './openmc-studio-contribution';

// Preferences
import { bindOpenMCStudioPreferences } from './openmc-studio-preferences';

import { SimulationDashboardWidget } from './simulation-dashboard/simulation-dashboard-widget';
import { CSGBuilderWidget } from './csg-builder/csg-builder-widget';
import { DAGMCEditorWidget } from './dagmc-editor/dagmc-editor-widget';
import { DAGMCEditorContribution } from './dagmc-editor/dagmc-editor-contribution';
import { TallyConfiguratorWidget } from './tally-configurator/tally-configurator-widget';
import { TallyConfiguratorContribution } from './tally-configurator/tally-configurator-contribution';
import { SimulationComparisonWidget } from './simulation-comparison/comparison-widget';
import { SimulationComparisonContribution } from './simulation-comparison/comparison-contribution';

// Import CSS
import './simulation-dashboard/simulation-dashboard.css';
import './csg-builder/csg-builder.css';
import './dagmc-editor/dagmc-editor.css';
import './tally-configurator/tally-configurator.css';
import './simulation-comparison/comparison.css';

// ============================================================================
// Dependency Injection Bindings
// ============================================================================

export default new ContainerModule((bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind) => {
    console.log('[OpenMC Studio] Initializing frontend module...');

    // ============================================================================
    // Preferences
    // ============================================================================
    
    bindOpenMCStudioPreferences(bind);

    // ============================================================================
    // Backend Service Proxy
    // ============================================================================
    
    // Create proxy for backend service communication with client
    bind(OpenMCStudioBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        
        // Create client object that forwards messages via window event
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
            onStateChange: () => {}
        };
        
        return connectionProvider.createProxy<OpenMCStudioBackendService>(OPENMC_STUDIO_BACKEND_PATH, client);
    }).inSingletonScope();

    // ============================================================================
    // Frontend Services
    // ============================================================================
    
    // Main OpenMC Studio service
    bind(OpenMCStudioService).toSelf().inSingletonScope();
    
    // State manager for the current simulation state
    bind(OpenMCStateManager).toSelf().inSingletonScope();
    
    // XML generation service
    bind(OpenMCXMLGenerationService).toSelf().inSingletonScope();
    
    // Python script generator
    bind(OpenMCPythonExporter).toSelf().inSingletonScope();
    
    // Simulation runner
    bind(OpenMCSimulationRunner).toSelf().inSingletonScope();

    // ============================================================================
    // Contributions
    // ============================================================================
    
    // Main contribution (commands, menus, toolbar, open handler)
    bind(OpenMCStudioContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCStudioContribution);
    bind(MenuContribution).toService(OpenMCStudioContribution);
    bind(TabBarToolbarContribution).toService(OpenMCStudioContribution);
    bind(OpenHandler).toService(OpenMCStudioContribution);
    bind(FrontendApplicationContribution).toService(OpenMCStudioContribution);

    // ============================================================================
    // Widget Factories (Phase 1+)
    // ============================================================================
    
    // Simulation Dashboard Widget - Phase 1
    bind(SimulationDashboardWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: SimulationDashboardWidget.ID,
        createWidget: () => container.get(SimulationDashboardWidget)
    })).inSingletonScope();
    
    // CSG Builder Widget - Phase 2
    bind(CSGBuilderWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: CSGBuilderWidget.ID,
        createWidget: () => container.get(CSGBuilderWidget)
    })).inSingletonScope();
    
    // DAGMC Editor Widget - Phase 4
    bind(DAGMCEditorWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: DAGMCEditorWidget.ID,
        createWidget: () => container.get(DAGMCEditorWidget)
    })).inSingletonScope();
    
    // DAGMC Editor Contribution
    bind(DAGMCEditorContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(DAGMCEditorContribution);
    bind(MenuContribution).toService(DAGMCEditorContribution);
    bind(FrontendApplicationContribution).toService(DAGMCEditorContribution);
    
    // Tally Configurator Widget - Phase 3
    bind(TallyConfiguratorWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: TallyConfiguratorWidget.ID,
        createWidget: () => container.get(TallyConfiguratorWidget)
    })).inSingletonScope();

    // Tally Configurator Contribution
    bind(TallyConfiguratorContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(TallyConfiguratorContribution);
    bind(MenuContribution).toService(TallyConfiguratorContribution);
    bind(FrontendApplicationContribution).toService(TallyConfiguratorContribution);

    // Simulation Comparison Widget - Phase 4D
    bind(SimulationComparisonWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: SimulationComparisonWidget.ID,
        createWidget: () => container.get(SimulationComparisonWidget)
    })).inSingletonScope();

    // Simulation Comparison Contribution
    bind(SimulationComparisonContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(SimulationComparisonContribution);
    bind(MenuContribution).toService(SimulationComparisonContribution);
    bind(FrontendApplicationContribution).toService(SimulationComparisonContribution);

    console.log('[OpenMC Studio] Frontend module initialized');
});

// ============================================================================
// Re-export for convenience
// ============================================================================

export { OpenMCStudioService } from './openmc-studio-service';
export { OpenMCStateManager } from './openmc-state-manager';
