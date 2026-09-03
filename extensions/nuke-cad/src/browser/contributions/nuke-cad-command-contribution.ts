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
 * Command contribution for nuke-cad.
 *
 * @module nuke-cad/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { NukeCadCommands } from '../commands';
import { NukeCadBackendService } from '../../common/nuke-cad-protocol';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { CadDocumentStore } from '../document/cad-document-store';
import { CadViewportWidget } from '../widgets/cad-viewport/cad-viewport-widget';
import { CadOutlinePanelWidget } from '../widgets/outline-panel/outline-panel-widget';
import { CadFeatureTreeWidget } from '../widgets/feature-tree/feature-tree-widget';
import { FemPanelWidget } from '../widgets/fem-panel/fem-panel-widget';
import { FoamPanelWidget } from '../widgets/foam-panel/foam-panel-widget';

@injectable()
export class NukeCadCommandContribution implements CommandContribution {
    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(NukeCadBackendService)
    protected readonly backendService: NukeCadBackendService;

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCadCommands.OPEN_CAD_VIEWPORT, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(CadViewportWidget.ID);
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
            }
        });

        commands.registerCommand(NukeCadCommands.REBUILD_GEOMETRY, {
            execute: async () => {
                const viewport = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (this.documentStore.hasDocument) {
                    if (viewport === undefined) {
                        this.messageService.warn('Open the CAD viewport before rebuilding geometry.');
                        return;
                    }
                    await viewport.rebuildDocument();
                    return;
                }
                const scriptPath = this.stateManager.scriptPath;
                if (!scriptPath) {
                    this.messageService.warn('No CAD model is active.');
                    return;
                }
                viewport?.setLoading(true, 'Rebuilding CAD geometry...');
                try {
                    const result = await this.backendService.buildGeometry({ scriptPath });
                    if (result.success) {
                        this.stateManager.setModel({ scriptPath, result, manifest: result.regionManifest });
                        this.messageService.info(`CAD rebuild: ${result.solidCount ?? 0} solids, ${result.triangleCount ?? 0} triangles`);
                    } else {
                        const message = result.error || 'CAD rebuild failed.';
                        viewport?.showBuildError(message);
                        this.messageService.error(message);
                        console.error('[NukeCad] Rebuild failed:', result.output);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    viewport?.showBuildError(message);
                    this.messageService.error(message);
                    console.error('[NukeCad] Rebuild failed:', error);
                }
            }
        });

        commands.registerCommand(NukeCadCommands.CHECK_CAD_ENVIRONMENT, {
            execute: async () => {
                const status = await this.backendService.checkCadEnvironment();
                const optionalNote = status.missingOptional.length
                    ? ` Missing optional packages: ${status.missingOptional.join(', ')}.`
                    : '';
                if (status.ready) {
                    this.messageService.info(`CAD environment is ready.${optionalNote}`);
                } else {
                    this.messageService.warn(`Missing packages: ${status.missing.join(', ')}.${optionalNote}`);
                }
            }
        });

        commands.registerCommand(NukeCadCommands.OPEN_OUTLINE_PANEL, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(CadOutlinePanelWidget.ID);
                await this.shell.addWidget(widget, { area: 'right' });
                await this.shell.activateWidget(widget.id);
            }
        });

        commands.registerCommand(NukeCadCommands.OPEN_FEM_PANEL, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(FemPanelWidget.ID);
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
            }
        });

        commands.registerCommand(NukeCadCommands.OPEN_FOAM_PANEL, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(FoamPanelWidget.ID);
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
            }
        });

        commands.registerCommand(NukeCadCommands.NEW_SKETCH, {
            execute: async () => {
                let widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (widget === undefined) {
                    widget = await this.widgetManager.getOrCreateWidget<CadViewportWidget>(CadViewportWidget.ID);
                    await this.shell.addWidget(widget, { area: 'main' });
                }
                await this.shell.activateWidget(widget.id);
                widget.startSketchSetup();
            }
        });

        commands.registerCommand(NukeCadCommands.EDIT_SKETCH, {
            execute: async (sketchId?: string) => {
                let widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (widget === undefined) {
                    widget = await this.widgetManager.getOrCreateWidget<CadViewportWidget>(CadViewportWidget.ID);
                    await this.shell.addWidget(widget, { area: 'main' });
                }
                await this.shell.activateWidget(widget.id);
                if (typeof sketchId === 'string') {
                    widget.editSketch(sketchId);
                }
            }
        });

        commands.registerCommand(NukeCadCommands.EXIT_SKETCH, {
            execute: () => {
                const widget = this.shell.currentWidget;
                if (widget instanceof CadViewportWidget) {
                    widget.exitSketch();
                }
            }
        });

        commands.registerCommand(NukeCadCommands.NEW_DOCUMENT, {
            execute: async () => {
                let widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (widget === undefined) {
                    widget = await this.widgetManager.getOrCreateWidget<CadViewportWidget>(CadViewportWidget.ID);
                    await this.shell.addWidget(widget, { area: 'main' });
                }
                await this.shell.activateWidget(widget.id);
                widget.newDocument();
            }
        });

        commands.registerCommand(NukeCadCommands.SAVE_DOCUMENT, {
            execute: async () => {
                const widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                await widget?.saveDocument(false);
            }
        });

        commands.registerCommand(NukeCadCommands.SAVE_DOCUMENT_AS, {
            execute: async () => {
                const widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                await widget?.saveDocument(true);
            }
        });

        commands.registerCommand(NukeCadCommands.OPEN_FEATURE_TREE, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(CadFeatureTreeWidget.ID);
                await this.shell.addWidget(widget, { area: 'right' });
                await this.shell.activateWidget(widget.id);
            }
        });

        const addFeature = async (type: 'pad' | 'pocket' | 'revolve' | 'groove' | 'sweep' | 'pipe'): Promise<void> => {
            const widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
            widget?.startFeatureCreation(type);
        };

        commands.registerCommand(NukeCadCommands.ADD_FEATURE_PAD, {
            execute: () => void addFeature('pad')
        });
        commands.registerCommand(NukeCadCommands.ADD_FEATURE_POCKET, {
            execute: () => void addFeature('pocket')
        });
        commands.registerCommand(NukeCadCommands.ADD_FEATURE_REVOLVE, {
            execute: () => void addFeature('revolve')
        });
        commands.registerCommand(NukeCadCommands.ADD_FEATURE_GROOVE, {
            execute: () => void addFeature('groove')
        });
        commands.registerCommand(NukeCadCommands.ADD_FEATURE_SWEEP, {
            execute: () => void addFeature('sweep')
        });
        commands.registerCommand(NukeCadCommands.ADD_FEATURE_PIPE, {
            execute: () => void addFeature('pipe')
        });

        commands.registerCommand(NukeCadCommands.EDIT_FEATURE, {
            execute: async (featureId?: string) => {
                const widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (typeof featureId === 'string') {
                    widget?.startFeatureEdit(featureId);
                }
            }
        });

        commands.registerCommand(NukeCadCommands.EXPORT_PYTHON, {
            execute: async () => {
                const widget = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
                if (widget === undefined) {
                    const newWidget = await this.widgetManager.getOrCreateWidget<CadViewportWidget>(CadViewportWidget.ID);
                    await this.shell.addWidget(newWidget, { area: 'main' });
                    await this.shell.activateWidget(newWidget.id);
                    await newWidget.exportPython();
                    return;
                }
                await widget.exportPython();
            }
        });
    }
}
