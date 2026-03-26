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
    OpenHandler
} from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common/command';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';

// Protocol imports
import {
    OpenMCStudioBackendService,
    OPENMC_STUDIO_BACKEND_PATH
} from '../common/openmc-studio-protocol';

// Service imports
import { OpenMCStudioService } from './openmc-studio-service';
import { OpenMCStateManager } from './openmc-state-manager';
import { OpenMCXMLGenerationService } from './xml-generator/xml-generation-service';
import { OpenMCSimulationRunner } from './simulation-dashboard/simulation-runner';

// Contribution imports
import { OpenMCStudioContribution } from './openmc-studio-contribution';

// Preferences
import { bindOpenMCStudioPreferences } from './openmc-studio-preferences';

import { WidgetFactory } from '@theia/core/lib/browser';
import { SimulationDashboardWidget } from './simulation-dashboard/simulation-dashboard-widget';
// import { CSGBuilderWidget } from './csg-builder/csg-builder-widget';
// import { TallyConfiguratorWidget } from './tally-configurator/tally-configurator-widget';

// Import CSS
import './simulation-dashboard/simulation-dashboard.css';

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
    
    // Create proxy for backend service communication
    bind(OpenMCStudioBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        return connectionProvider.createProxy<OpenMCStudioBackendService>(OPENMC_STUDIO_BACKEND_PATH);
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
    // bind(CSGBuilderWidget).toSelf();
    // bind(WidgetFactory).toDynamicValue(({ container }) => ({
    //     id: CSGBuilderWidget.ID,
    //     createWidget: () => container.get(CSGBuilderWidget)
    // })).inSingletonScope();
    
    // Tally Configurator Widget - Phase 3
    // bind(TallyConfiguratorWidget).toSelf();
    // bind(WidgetFactory).toDynamicValue(({ container }) => ({
    //     id: TallyConfiguratorWidget.ID,
    //     createWidget: () => container.get(TallyConfiguratorWidget)
    // })).inSingletonScope();

    console.log('[OpenMC Studio] Frontend module initialized');
});

// ============================================================================
// Re-export for convenience
// ============================================================================

export { OpenMCStudioService } from './openmc-studio-service';
export { OpenMCStateManager } from './openmc-state-manager';
