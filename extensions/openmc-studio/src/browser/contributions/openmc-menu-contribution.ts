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
 * OpenMC Menu Contribution
 * 
 * Registers all menus and menu actions.
 * 
 * @module openmc-studio/browser/contributions
 */

import { injectable } from '@theia/core/shared/inversify';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';
import { OpenMCProjectCommands } from '../commands/project-commands';
import { OpenMCSimulationCommands } from '../commands/simulation-commands';
import { OpenMCViewCommands } from '../commands/view-commands';
import { OpenMCEnvironmentCommands } from '../commands/environment-commands';

export namespace OpenMCMenus {
    export const OPENMC = [...NukeMenus.TOOLS, '1_openmc'];
    export const OPENMC_PROJECT = [...OPENMC, '1_project'];
    export const OPENMC_SIMULATION = [...OPENMC, '2_simulation'];
    export const OPENMC_GEOMETRY = [...OPENMC, '3_geometry'];
    export const OPENMC_XML = [...OPENMC, '4_xml'];
    export const OPENMC_ENVIRONMENT = [...OPENMC, '5_environment'];
    export const OPENMC_ADVANCED = [...OPENMC, '6_advanced'];
}

@injectable()
export class OpenMCMenuContribution implements MenuContribution {

    registerMenus(menus: MenuModelRegistry): void {
        // Main OpenMC menu
        menus.registerSubmenu(OpenMCMenus.OPENMC, 'OpenMC Studio');
        
        // Submenus
        menus.registerSubmenu(OpenMCMenus.OPENMC_PROJECT, 'Project');
        menus.registerSubmenu(OpenMCMenus.OPENMC_SIMULATION, 'Simulation');
        menus.registerSubmenu(OpenMCMenus.OPENMC_GEOMETRY, 'Geometry');
        menus.registerSubmenu(OpenMCMenus.OPENMC_XML, 'XML Configuration');
        menus.registerSubmenu(OpenMCMenus.OPENMC_ENVIRONMENT, 'Environment');
        menus.registerSubmenu(OpenMCMenus.OPENMC_ADVANCED, 'Advanced');

        // Project menu items
        this.registerProjectMenus(menus);
        
        // Simulation menu items
        this.registerSimulationMenus(menus);
        
        // Geometry menu items
        this.registerGeometryMenus(menus);
        
        // XML menu items
        this.registerXMLMenus(menus);
        
        // Environment menu items
        this.registerEnvironmentMenus(menus);
        
        // Advanced menu items
        this.registerAdvancedMenus(menus);
    }

    private registerProjectMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_PROJECT, {
            commandId: OpenMCProjectCommands.NEW_PROJECT.id,
            label: 'New Project',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_PROJECT, {
            commandId: OpenMCProjectCommands.OPEN_PROJECT.id,
            label: 'Open Project...',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_PROJECT, {
            commandId: OpenMCProjectCommands.SAVE_PROJECT.id,
            label: 'Save Project',
            order: 'c'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_PROJECT, {
            commandId: OpenMCProjectCommands.SAVE_PROJECT_AS.id,
            label: 'Save Project As...',
            order: 'd'
        });
    }

    private registerSimulationMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_SIMULATION, {
            commandId: OpenMCViewCommands.OPEN_SIMULATION_DASHBOARD.id,
            label: 'Simulation Dashboard',
            order: '0'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_SIMULATION, {
            commandId: OpenMCSimulationCommands.RUN_SIMULATION.id,
            label: 'Run Simulation',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_SIMULATION, {
            commandId: OpenMCSimulationCommands.STOP_SIMULATION.id,
            label: 'Stop Simulation',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_SIMULATION, {
            commandId: OpenMCSimulationCommands.VALIDATE_MODEL.id,
            label: 'Validate Model',
            order: 'c'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_SIMULATION, {
            commandId: OpenMCViewCommands.OPEN_SIMULATION_COMPARISON.id,
            label: 'Compare Simulations',
            order: 'd'
        });
    }

    private registerGeometryMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCViewCommands.OPEN_CSG_BUILDER.id,
            label: 'CSG Builder',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCViewCommands.OPEN_DAGMC_EDITOR.id,
            label: 'DAGMC Editor',
            order: 'b'
        });
    }

    private registerXMLMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_XML, {
            commandId: OpenMCSimulationCommands.GENERATE_XML.id,
            label: 'Generate XML Files',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_XML, {
            commandId: OpenMCSimulationCommands.IMPORT_XML.id,
            label: 'Import from XML...',
            order: 'b'
        });
    }

    private registerEnvironmentMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.CHECK_HEALTH.id,
            label: 'Check Environment Health',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.SWITCH_ENVIRONMENT.id,
            label: 'Switch Environment',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.REFRESH_ENVIRONMENT.id,
            label: 'Refresh Status',
            order: 'c'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.INSTALL_OPENMC.id,
            label: 'Install OpenMC',
            order: 'd'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.INSTALL_DAGMC.id,
            label: 'Install DAGMC Tools',
            order: 'e'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.SHOW_DIAGNOSTICS.id,
            label: 'Show Diagnostics',
            order: 'f'
        });
    }

    private registerAdvancedMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_ADVANCED, {
            commandId: OpenMCViewCommands.OPEN_TALLY_CONFIGURATOR.id,
            label: 'Tally Configurator',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ADVANCED, {
            commandId: OpenMCViewCommands.OPEN_DEPLETION.id,
            label: 'Depletion Dashboard',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ADVANCED, {
            commandId: OpenMCViewCommands.OPEN_VARIANCE_REDUCTION.id,
            label: 'Variance Reduction',
            order: 'c'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ADVANCED, {
            commandId: OpenMCViewCommands.OPEN_SCRIPT_GENERATOR.id,
            label: 'Generate Python Script',
            order: 'd'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ADVANCED, {
            commandId: OpenMCViewCommands.OPEN_OPTIMIZATION.id,
            label: 'Optimization Study',
            order: 'e'
        });
    }
}
