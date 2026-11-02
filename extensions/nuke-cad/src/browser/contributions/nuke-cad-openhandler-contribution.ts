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
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';

import { NukeCadBackendService } from '../../common/nuke-cad-protocol';
import { NukeCadStateManager, sandboxedGeometryResult } from '../state/nuke-cad-state-manager';
import { NukeCadPreferences } from '../nuke-cad-preferences';
import { CadViewportWidget } from '../widgets/cad-viewport/cad-viewport-widget';
import { CadOutlinePanelWidget } from '../widgets/outline-panel/outline-panel-widget';
import { CadFeatureTreeWidget } from '../widgets/feature-tree/feature-tree-widget';

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

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCadPreferences)
    protected readonly preferences: NukeCadPreferences;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

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
        await this.revealModelPanels();
        await this.shell.activateWidget(widget.id);

        if (ext === '.nuke-cad') {
            await this.openDocument(uri, widget);
            return;
        }

        const sourceType: 'script' | 'step' = ext === '.py' ? 'script' : 'step';
        widget.setLoading(true, sourceType === 'step' ? 'Importing STEP file...' : 'Building CAD geometry...');
        try {
            if (ext === '.py' && this.preferences['nukeCad.scriptAuthoringEnabled'] === true) {
                await this.openSandboxedScript(filePath, widget);
                return;
            }
            const result = await this.backendService.buildGeometry({
                scriptPath: filePath,
                sourceType,
                exportDagmc: sourceType === 'script' ? undefined : false,
                exportMesh: sourceType === 'script' ? undefined : false
            });
            if (result.success) {
                this.stateManager.setModel({ scriptPath: filePath, result, manifest: result.regionManifest });
            } else {
                widget.showBuildError(result.error || 'Failed to load CAD model.');
                this.messageService.error(result.error || 'Failed to load CAD model.');
                console.error('[NukeCad] Open handler failed:', result.output);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            widget.showBuildError(message);
            this.messageService.error(message);
        } finally {
            widget.setLoading(false);
        }
    }

    /**
     * Open a Python script through the bubblewrap sandbox when script
     * authoring is enabled. There is no unsandboxed fallback.
     */
    protected async openSandboxedScript(filePath: string, widget: CadViewportWidget): Promise<void> {
        let status: Awaited<ReturnType<NukeCadBackendService['getScriptSandboxStatus']>>;
        try {
            status = await this.backendService.getScriptSandboxStatus();
        } catch (error) {
            const message = `The bubblewrap script sandbox could not be probed: ${error instanceof Error ? error.message : String(error)}`;
            widget.showBuildError(message);
            this.messageService.error(message);
            return;
        }
        if (!status.available) {
            const reason = status.reason !== undefined && status.reason.length > 0 ? ` ${status.reason}` : '';
            const message = `Script authoring is enabled, but the bubblewrap sandbox is unavailable; this script cannot be opened unsandboxed.${reason}`;
            widget.showBuildError(message);
            this.messageService.error(message);
            return;
        }
        const workspaceRoot = this.containingWorkspaceRoot(filePath);
        if (workspaceRoot === undefined) {
            const message = 'The CAD script is outside every workspace root.';
            widget.showBuildError(message);
            this.messageService.error(message);
            return;
        }
        const outputDirectory = path.join(workspaceRoot, '.nuke-ide', 'ai', 'cad-scripts', `open-${globalThis.crypto.randomUUID()}`, 'out');
        try {
            await this.fileService.createFolder(new URI(outputDirectory), { fromUserGesture: false }).catch(() => undefined);
            const result = await this.backendService.buildSandboxedScript({
                scriptPath: filePath,
                workspaceRoot,
                outputDirectory,
                tolerance: 0.1,
                timeoutSeconds: 120,
                memoryLimitMb: 4096,
                processLimit: 128,
                fileSizeLimitMb: 512,
                jobId: `cad-ai-script-open-${globalThis.crypto.randomUUID()}`
            });
            if (!result.success) {
                const message = result.error || 'The sandboxed CAD script build failed.';
                widget.showBuildError(message);
                this.messageService.error(message);
                return;
            }
            const geometry = sandboxedGeometryResult(result);
            this.stateManager.setModel({
                scriptPath: filePath,
                result: geometry,
                manifest: geometry.regionManifest,
                sandboxed: true
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            widget.showBuildError(message);
            this.messageService.error(message);
        }
    }

    /** Deepest workspace root containing the script, when one is open. */
    protected containingWorkspaceRoot(scriptPath: string): string | undefined {
        const roots = this.workspaceService.tryGetRoots().map((root) => root.resource.path.toString());
        return roots
            .filter((root) => path.isAbsolute(root) && (scriptPath === root || scriptPath.startsWith(`${root}${path.sep}`)))
            .map((root) => path.resolve(root))
            .sort((left, right) => right.length - left.length)[0];
    }

    /**
     * Mirrors the `nuke.cad.openOutlinePanel` / `nuke.cad.openFeatureTree` command
     * handlers (right shell area). Attached panels are only revealed so no duplicate
     * widget appears; both panels tolerate a missing model while geometry builds.
     */
    private async revealModelPanels(): Promise<void> {
        for (const id of [CadOutlinePanelWidget.ID, CadFeatureTreeWidget.ID]) {
            const panel = await this.widgetManager.getOrCreateWidget(id);
            if (!panel.isAttached) {
                await this.shell.addWidget(panel, { area: 'right' });
                await this.shell.activateWidget(panel.id);
            } else {
                await this.shell.revealWidget(panel.id);
            }
        }
    }

    private async openDocument(uri: URI, widget: CadViewportWidget): Promise<void> {
        await widget.openModel(uri);
    }
}
