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
 * Project Commands
 *
 * Commands for project management (new, open, save).
 *
 * @module openmc-studio/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { OpenMCStateManager } from '../openmc-state-manager';
import { SimulationDashboardWidget } from '../widgets/simulation-dashboard/simulation-dashboard-widget';
import { OpenMCStudioBackendService, NukeCADImportResult } from '../../common/openmc-studio-protocol';
import { OpenMCMaterial } from '../../common/openmc-state-schema';

export namespace OpenMCProjectCommands {
    /** Command category for all project management commands. */
    export const CATEGORY = 'OpenMC/Project';

    /** Create a new OpenMC project, resetting the current state. */
    export const NEW_PROJECT: Command = {
        id: 'openmc.project.new',
        category: CATEGORY,
        label: 'New Project'
    };

    /** Open an existing OpenMC project from disk. */
    export const OPEN_PROJECT: Command = {
        id: 'openmc.project.open',
        category: CATEGORY,
        label: 'Open Project...'
    };

    /** Save the current OpenMC project. */
    export const SAVE_PROJECT: Command = {
        id: 'openmc.project.save',
        category: CATEGORY,
        label: 'Save Project'
    };

    /** Save the current OpenMC project under a new name or location. */
    export const SAVE_PROJECT_AS: Command = {
        id: 'openmc.project.saveAs',
        category: CATEGORY,
        label: 'Save Project As...'
    };

    /** Import a DAGMC model produced by nuke-cad into the current project. */
    export const IMPORT_NUKE_CAD: Command = {
        id: 'openmc.project.importNukeCAD',
        category: CATEGORY,
        label: 'Import from nuke-cad...'
    };
}

/**
 * Project command handler for OpenMC Studio.
 *
 * Manages project lifecycle operations including creating new projects,
 * opening existing ones, and saving project state.
 *
 * @see {@link OpenMCProjectCommands} for available command identifiers
 * @see {@link SimulationDashboardWidget} for the widget that handles persistence
 */
@injectable()
export class ProjectCommands {
    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    /**
     * Register project commands with the command registry.
     * @param registry - The Theia command registry
     */
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCProjectCommands.NEW_PROJECT, {
            execute: () => this.newProject()
        });

        registry.registerCommand(OpenMCProjectCommands.OPEN_PROJECT, {
            execute: () => this.openProject()
        });

        registry.registerCommand(OpenMCProjectCommands.SAVE_PROJECT, {
            execute: () => this.saveProject()
        });

        registry.registerCommand(OpenMCProjectCommands.SAVE_PROJECT_AS, {
            execute: () => this.saveProjectAs()
        });

        registry.registerCommand(OpenMCProjectCommands.IMPORT_NUKE_CAD, {
            execute: () => this.importNukeCAD()
        });
    }

    /**
     * Reset the application state and open a fresh project in the dashboard.
     */
    private async newProject(): Promise<void> {
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
        await this.openDashboard();
    }

    /**
     * Open the dashboard and trigger the project's open file dialog.
     */
    private async openProject(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).openProject();
        }
    }

    /**
     * Save the current project through the simulation dashboard widget.
     */
    private async saveProject(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProject();
        }
    }

    /**
     * Save the current project under a new name through the simulation dashboard widget.
     */
    private async saveProjectAs(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProjectAs();
        }
    }

    /**
     * Open or focus the simulation dashboard widget in the main area.
     */
    private async openDashboard(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    /**
     * Import a DAGMC model produced by nuke-cad into the current project.
     *
     * Prompts for the .h5m file, auto-locates the sibling .regions.json manifest,
     * populates dagmcFile/dagmcInfo, and creates placeholder OpenMC materials for
     * every manifest material name that does not already exist.
     */
    private async importNukeCAD(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Import nuke-cad DAGMC model',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'DAGMC files': ['h5m']
            }
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

        const h5mPath = uri.path.toString();
        this.messageService.info(`Importing nuke-cad model: ${h5mPath}`);

        try {
            const result: NukeCADImportResult = await this.backendService.importNukeCAD({ h5mPath });
            if (!result.success || !result.dagmcInfo) {
                this.messageService.error(result.error || 'nuke-cad import failed');
                return;
            }

            // Create placeholder materials for any manifest material names that are missing.
            // Placeholders are created from `material` (never from `materialId`); the
            // physical-model UUIDs ride along as copy-provenance metadata.
            const existingNames = new Set(this.stateManager.getState().materials.map((m) => m.name));
            const materialNames = (result.materialNames || []).filter((name) => !existingNames.has(name));
            if (materialNames.length > 0) {
                const linkByMaterial = new Map((result.materialLinks || []).map((l) => [l.material, l]));
                let nextId = this.stateManager.getNextMaterialId();
                for (const name of materialNames) {
                    const link = linkByMaterial.get(name);
                    const material: OpenMCMaterial = {
                        id: nextId++,
                        name,
                        density: 1.0,
                        densityUnit: 'g/cm3',
                        nuclides: [],
                        thermalScattering: []
                    };
                    if (link?.materialId) {
                        material.nukeCadMaterialId = link.materialId;
                    }
                    if (link?.parentId) {
                        material.nukeCadParentId = link.parentId;
                    }
                    this.stateManager.addMaterial(material);
                }
                this.messageService.info(`Created ${materialNames.length} placeholder material(s): ${materialNames.join(', ')}`);
            }

            // Update settings to point at the imported DAGMC file.
            this.stateManager.updateSettings({
                dagmcFile: result.dagmcFile,
                dagmcInfo: result.dagmcInfo
            });

            // Open the dashboard so the user sees the updated geometry/materials.
            await this.openDashboard();

            const warnings = result.warnings || [];
            if (warnings.length > 0) {
                this.messageService.warn(warnings.join('; '));
            }
            this.messageService.info(
                `Imported nuke-cad model: ${result.dagmcInfo.volumeCount} volumes, ` + `${result.dagmcInfo.vertices} triangles`
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`nuke-cad import failed: ${msg}`);
        }
    }
}
