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
import { NukeCadCommands } from '../commands';
import { NukeCadBackendService } from '../../common/nuke-cad-protocol';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { CadViewportWidget } from '../widgets/cad-viewport/cad-viewport-widget';
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
                const scriptPath = this.stateManager.scriptPath;
                if (!scriptPath) {
                    this.messageService.warn('No CAD model is active.');
                    return;
                }
                const viewport = await this.widgetManager.getWidget<CadViewportWidget>(CadViewportWidget.ID);
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
    }
}
