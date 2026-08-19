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
 * Open handler contribution for CAD model scripts.
 *
 * Allows ``.py`` files to be opened in the CAD viewport. The file is treated as
 * a build123d/CadQuery script and rebuilt automatically.
 *
 * @module nuke-cad/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { OpenHandler, ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core/lib/common/uri';

import { NukeCadBackendService } from '../../common/nuke-cad-protocol';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { CadDocumentStore } from '../document/cad-document-store';
import { CadViewportWidget } from '../widgets/cad-viewport/cad-viewport-widget';

@injectable()
export class NukeCadOpenHandler implements OpenHandler {
    readonly id = 'nuke-cad-open-handler';
    readonly label = 'Open in CAD Viewport';
    readonly iconClass = 'codicon codicon-globe';

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

    @inject(MessageService)
    protected readonly messageService: MessageService;

    canHandle(uri: URI): number {
        const ext = uri.path.ext.toLowerCase();
        if (ext === '.nuke-cad') {
            // Native document format: open in the CAD viewport by default.
            return 500;
        }
        if (ext === '.py') {
            // Stay below the editor's priority (EditorManager.canHandle === 100):
            // plain .py files (e.g. openmc-studio model.py) must keep opening in
            // the text editor by default. The CAD viewport remains available for
            // .py via "Open With…" without hijacking every Python file in the IDE.
            return 50;
        }
        if (['.step', '.stp', '.brep'].includes(ext)) {
            // Higher priority than nuke-visualizer so STEP files open in nuke-cad by default.
            return 500;
        }
        return 0;
    }

    async open(uri: URI): Promise<void> {
        const filePath = uri.path.toString();
        const ext = uri.path.ext.toLowerCase();

        const widget = await this.widgetManager.getOrCreateWidget<CadViewportWidget>(CadViewportWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);

        if (ext === '.nuke-cad') {
            await this.openDocument(uri, filePath, widget);
            return;
        }

        const sourceType: 'script' | 'step' = ext === '.py' ? 'script' : 'step';
        const result = await this.backendService.buildGeometry({
            scriptPath: filePath,
            sourceType,
            exportDagmc: sourceType === 'script' ? undefined : false,
            exportMesh: sourceType === 'script' ? undefined : false
        });
        if (result.success) {
            this.stateManager.setModel({ scriptPath: filePath, result, manifest: result.regionManifest });
        } else {
            this.messageService.error(result.error || 'Failed to load CAD model.');
            console.error('[NukeCad] Open handler failed:', result.output);
        }
    }

    private async openDocument(uri: URI, filePath: string, widget: CadViewportWidget): Promise<void> {
        try {
            const content = await this.fileService.read(uri);
            const json = JSON.parse(content.value.toString()) as unknown;
            const result = this.documentStore.loadDocument(json);
            if (!result.success) {
                this.messageService.error(result.error || 'Failed to load .nuke-cad document.');
                return;
            }
            this.documentStore.setUri(uri.toString());
            this.documentStore.markSaved();
            widget.setLoading(true, 'Building CAD geometry...');
            const buildResult = await this.backendService.buildDocument({ scriptPath: filePath });
            this.documentStore.setFeatureResults(buildResult.featureResults ?? []);
            if (buildResult.success) {
                this.stateManager.setModel({ scriptPath: filePath, result: buildResult, manifest: buildResult.regionManifest });
            } else {
                widget.showBuildError(buildResult.error || 'Document build failed.');
                this.messageService.error(buildResult.error || 'Document build failed.');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to open .nuke-cad document: ${message}`);
            console.error('[NukeCad] Open document failed:', error);
        } finally {
            widget.setLoading(false);
        }
    }
}
