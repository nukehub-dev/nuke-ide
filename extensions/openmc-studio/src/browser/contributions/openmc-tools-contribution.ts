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
 * OpenMC Studio Tools Contribution
 *
 * Registers OpenMC Studio commands into the Nuke Tools sidebar.
 *
 * @module openmc-studio/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsRegistry, NukeToolsItem } from 'nuke-core/lib/common/nuke-tools-protocol';
import { OpenMCProjectCommands, OpenMCSimulationCommands, OpenMCViewCommands, OpenMCEnvironmentCommands } from '../commands';
import { OpenMCStateManager } from '../openmc-state-manager';

@injectable()
export class OpenMCToolsContribution implements NukeToolsContribution {
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    registerTools(registry: NukeToolsRegistry): void {
        const projectEnabled = () => this.stateManager.projectPath !== undefined;

        const item = (def: Omit<NukeToolsItem, 'enabled' | 'onDidChangeEnabled'> & { requiresProject?: boolean }): void => {
            registry.registerItem({
                ...def,
                enabled: def.requiresProject ? projectEnabled : undefined,
                onDidChangeEnabled: def.requiresProject ? this.stateManager.onProjectPathChange : undefined
            });
        };

        // Project
        item({
            id: 'openmc.project.new',
            label: 'New Project',
            commandId: OpenMCProjectCommands.NEW_PROJECT.id,
            category: ['OpenMC Studio', 'Project'],
            sectionOrder: 'c',
            categoryOrder: 'a',
            order: 'a',
            icon: 'new-file',
            description: 'Create a new OpenMC Studio project.'
        });

        item({
            id: 'openmc.project.open',
            label: 'Open Project...',
            commandId: OpenMCProjectCommands.OPEN_PROJECT.id,
            category: ['OpenMC Studio', 'Project'],
            sectionOrder: 'c',
            categoryOrder: 'a',
            order: 'b',
            icon: 'folder-opened',
            description: 'Open an existing OpenMC Studio project.'
        });

        item({
            id: 'openmc.project.save',
            label: 'Save Project',
            commandId: OpenMCProjectCommands.SAVE_PROJECT.id,
            category: ['OpenMC Studio', 'Project'],
            sectionOrder: 'c',
            categoryOrder: 'a',
            order: 'c',
            icon: 'save',
            description: 'Save the current OpenMC Studio project.',
            requiresProject: true
        });

        item({
            id: 'openmc.project.saveAs',
            label: 'Save Project As...',
            commandId: OpenMCProjectCommands.SAVE_PROJECT_AS.id,
            category: ['OpenMC Studio', 'Project'],
            sectionOrder: 'c',
            categoryOrder: 'a',
            order: 'd',
            icon: 'save-as',
            description: 'Save the current project under a new name.',
            requiresProject: true
        });

        // Geometry
        item({
            id: 'openmc.geometry.csgBuilder',
            label: 'CSG Builder',
            commandId: OpenMCViewCommands.OPEN_CSG_BUILDER.id,
            category: ['OpenMC Studio', 'Geometry'],
            sectionOrder: 'c',
            categoryOrder: 'b',
            order: 'a',
            icon: 'layout',
            description: 'Open the constructive solid geometry builder.'
        });

        item({
            id: 'openmc.geometry.dagmcEditor',
            label: 'DAGMC Editor',
            commandId: OpenMCViewCommands.OPEN_DAGMC_EDITOR.id,
            category: ['OpenMC Studio', 'Geometry'],
            sectionOrder: 'c',
            categoryOrder: 'b',
            order: 'b',
            icon: 'server-process',
            description: 'Open the DAGMC geometry editor.'
        });

        // Simulation
        item({
            id: 'openmc.simulation.dashboard',
            label: 'Simulation Dashboard',
            commandId: OpenMCViewCommands.OPEN_SIMULATION_DASHBOARD.id,
            category: ['OpenMC Studio', 'Simulation'],
            sectionOrder: 'c',
            categoryOrder: 'c',
            order: 'a',
            icon: 'dashboard',
            description: 'Open the simulation dashboard.'
        });

        item({
            id: 'openmc.simulation.validate',
            label: 'Validate Model',
            commandId: OpenMCSimulationCommands.VALIDATE_MODEL.id,
            category: ['OpenMC Studio', 'Simulation'],
            sectionOrder: 'c',
            categoryOrder: 'c',
            order: 'b',
            icon: 'check',
            description: 'Validate the current OpenMC model.',
            requiresProject: true
        });

        // XML Configuration
        item({
            id: 'openmc.simulation.generateXML',
            label: 'Generate XML Files',
            commandId: OpenMCSimulationCommands.GENERATE_XML.id,
            category: ['OpenMC Studio', 'XML Configuration'],
            sectionOrder: 'c',
            categoryOrder: 'd',
            order: 'a',
            icon: 'file-code',
            description: 'Generate OpenMC XML input files from the project.',
            requiresProject: true
        });

        item({
            id: 'openmc.simulation.importXML',
            label: 'Import from XML...',
            commandId: OpenMCSimulationCommands.IMPORT_XML.id,
            category: ['OpenMC Studio', 'XML Configuration'],
            sectionOrder: 'c',
            categoryOrder: 'd',
            order: 'b',
            icon: 'file-symlink-file',
            description: 'Import an OpenMC project from existing XML files.'
        });

        // Advanced
        item({
            id: 'openmc.advanced.tallyConfigurator',
            label: 'Tally Configurator',
            commandId: OpenMCViewCommands.OPEN_TALLY_CONFIGURATOR.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'a',
            icon: 'checklist',
            description: 'Configure simulation tallies.',
            requiresProject: true
        });

        item({
            id: 'openmc.advanced.depletion',
            label: 'Depletion Dashboard',
            commandId: OpenMCViewCommands.OPEN_DEPLETION.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'b',
            icon: 'history',
            description: 'Open the depletion analysis dashboard.',
            requiresProject: true
        });

        item({
            id: 'openmc.advanced.varianceReduction',
            label: 'Variance Reduction',
            commandId: OpenMCViewCommands.OPEN_VARIANCE_REDUCTION.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'c',
            icon: 'filter',
            description: 'Configure variance reduction settings.',
            requiresProject: true
        });

        item({
            id: 'openmc.advanced.scriptGenerator',
            label: 'Generate Python Script',
            commandId: OpenMCViewCommands.OPEN_SCRIPT_GENERATOR.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'd',
            icon: 'code',
            description: 'Generate a Python script from the current project.',
            requiresProject: true
        });

        item({
            id: 'openmc.advanced.optimization',
            label: 'Optimization Study',
            commandId: OpenMCViewCommands.OPEN_OPTIMIZATION.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'e',
            icon: 'rocket',
            description: 'Open the optimization study widget.'
        });

        item({
            id: 'openmc.advanced.volumeCalc',
            label: 'Volume Calculation',
            commandId: OpenMCViewCommands.OPEN_VOLUME_CALC.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'f',
            icon: 'symbol-ruler',
            description: 'Open the stochastic volume calculation widget.',
            requiresProject: true
        });

        item({
            id: 'openmc.advanced.nativePlotting',
            label: 'Native Plotting',
            commandId: OpenMCViewCommands.OPEN_NATIVE_PLOTTING.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'g',
            icon: 'graph',
            description: 'Open the native OpenMC plotting widget.'
        });

        item({
            id: 'openmc.advanced.mgxsGenerator',
            label: 'MGXS Generator',
            commandId: OpenMCViewCommands.OPEN_MGXS_GENERATOR.id,
            category: ['OpenMC Studio', 'Advanced'],
            sectionOrder: 'c',
            categoryOrder: 'e',
            order: 'h',
            icon: 'circuit-board',
            description: 'Open the multi-group cross-section generator.',
            requiresProject: true
        });

        // Environment
        item({
            id: 'openmc.environment.checkHealth',
            label: 'Run Health Check',
            commandId: OpenMCEnvironmentCommands.CHECK_HEALTH.id,
            category: ['OpenMC Studio', 'Environment'],
            sectionOrder: 'c',
            categoryOrder: 'f',
            order: 'a',
            icon: 'pass',
            description: 'Run an OpenMC environment health check.'
        });

        item({
            id: 'openmc.environment.installOpenMC',
            label: 'Install OpenMC',
            commandId: OpenMCEnvironmentCommands.INSTALL_OPENMC.id,
            category: ['OpenMC Studio', 'Environment'],
            sectionOrder: 'c',
            categoryOrder: 'f',
            order: 'b',
            icon: 'cloud-download',
            description: 'Install OpenMC into the active environment.'
        });

        item({
            id: 'openmc.environment.installDAGMC',
            label: 'Install DAGMC Tools',
            commandId: OpenMCEnvironmentCommands.INSTALL_DAGMC.id,
            category: ['OpenMC Studio', 'Environment'],
            sectionOrder: 'c',
            categoryOrder: 'f',
            order: 'c',
            icon: 'tools',
            description: 'Install DAGMC tools into the active environment.'
        });
    }
}
