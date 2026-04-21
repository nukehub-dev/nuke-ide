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

/** Menu path constants for the OpenMC Studio menu hierarchy under Tools. */
export namespace OpenMCMenus {
    /** Root OpenMC Studio menu under Tools. */
    export const OPENMC = [...NukeMenus.TOOLS, '1_openmc'];
    /** Project submenu under OpenMC Studio. */
    export const OPENMC_PROJECT = [...OPENMC, '1_project'];
    /** Simulation submenu under OpenMC Studio. */
    export const OPENMC_SIMULATION = [...OPENMC, '2_simulation'];
    /** Geometry submenu under OpenMC Studio. */
    export const OPENMC_GEOMETRY = [...OPENMC, '3_geometry'];
    /** XML Configuration submenu under OpenMC Studio. */
    export const OPENMC_XML = [...OPENMC, '4_xml'];
    /** Advanced submenu under OpenMC Studio. */
    export const OPENMC_ADVANCED = [...OPENMC, '6_advanced'];
    /** Environment submenu under OpenMC Studio. */
    export const OPENMC_ENVIRONMENT = [...OPENMC, 'z_environment'];
}

/**
 * Registers the OpenMC Studio menu hierarchy and all menu actions with the Theia menu registry.
 *
 * Binds to {@link MenuContribution} in the frontend module to activate menu registration.
 * Creates submenus for Project, Simulation, Geometry, XML Configuration, Environment, and Advanced.
 *
 * @see {@link openmc-command-contribution.ts} for command definitions
 * @see {@link OpenMCMenus} for menu path constants
 */
@injectable()
export class OpenMCMenuContribution implements MenuContribution {

    /**
     * Register the full OpenMC Studio menu structure and populate each submenu with actions.
     * @param menus - The Theia menu model registry
     * @see {@link registerProjectMenus}
     * @see {@link registerSimulationMenus}
     * @see {@link registerGeometryMenus}
     * @see {@link registerXMLMenus}
     * @see {@link registerEnvironmentMenus}
     * @see {@link registerAdvancedMenus}
     */
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

    /**
     * Register Project submenu actions (New, Open, Save, Save As).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCProjectCommands}
     */
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

    /**
     * Register Simulation submenu actions (Dashboard, Run, Stop, Validate, Compare).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCSimulationCommands}
     * @see {@link OpenMCViewCommands}
     */
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

    /**
     * Register Geometry submenu actions (CSG Builder, DAGMC Editor).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCViewCommands}
     */
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

    /**
     * Register XML Configuration submenu actions (Generate, Import).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCSimulationCommands}
     */
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

    /**
     * Register Environment submenu actions (Health Check, Install OpenMC, Install DAGMC).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCEnvironmentCommands}
     */
    private registerEnvironmentMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.CHECK_HEALTH.id,
            label: 'Run Health Check',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.INSTALL_OPENMC.id,
            label: 'Install OpenMC',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCMenus.OPENMC_ENVIRONMENT, {
            commandId: OpenMCEnvironmentCommands.INSTALL_DAGMC.id,
            label: 'Install DAGMC Tools',
            order: 'c'
        });
    }

    /**
     * Register Advanced submenu actions (Tally, Depletion, Variance Reduction, Script, Optimization).
     * @param menus - The Theia menu model registry
     * @see {@link OpenMCViewCommands}
     */
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
