// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import { injectable, inject } from '@theia/core/shared/inversify';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { VisualizerBackendService } from '../../../../common/base-visualizer-protocol';
import { VisualizerWidget } from '../../../visualizer-widget';
import { DagmcViewerWidget } from '../widgets/dagmc/dagmc-viewer-widget';
import { parseVtmManifest } from '../widgets/dagmc/dagmc-multiblock';

/** Multiblock `.vtm` manifests (as written by `convert_h5m_to_multiblock_vtk`: `<stem>_volumes.vtm`). */
function isDagmcMultiblockFileName(baseName: string): boolean {
    return baseName.toLowerCase().endsWith('.vtm');
}

/**
 * Guess the source `.h5m` for a converter-written manifest (`<stem>_volumes.vtm`
 * → sibling `<stem>.h5m`). Used for the `dagmc.info` model metadata and the
 * trame fallback; undefined when the name carries no such hint.
 */
function siblingH5mCandidate(uri: URI): URI | undefined {
    const match = /^(.*)_volumes\.vtm$/i.exec(uri.path.base);
    return match ? uri.parent.resolve(`${match[1]}.h5m`) : undefined;
}

/**
 * Routes multiblock `.vtm` files (e.g. `tokamak_volumes.vtm` from
 * `convert_h5m_to_multiblock_vtk`) to the native DAGMC viewer via the
 * OutputViewerRegistry: the manifest loads through `setVtmFile` (FileService,
 * no trame server) and volume/material/group toggles arrive via `setModelInfo`
 * with the `dagmc.info` payload for the sibling `.h5m`.
 *
 * Native-first with a logged trame fallback: when the manifest cannot even be
 * read/parsed natively, the file opens in the classic trame viewer instead
 * (`dagmc.visualize` for the sibling `.h5m`, `base.serve` otherwise). A
 * missing `dagmc.info` payload is NOT a native failure — the viewer simply
 * renders every block without toggles.
 */
@injectable()
export class OpenMCDagmcViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-dagmc-viewer';
    readonly label = 'Native DAGMC Viewer';
    readonly priority = 100;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    canHandle(uri: URI): number {
        return isDagmcMultiblockFileName(uri.path.base) ? 600 : 0;
    }

    async open(uri: URI): Promise<void> {
        // Probe the manifest before creating any widget: a .vtm that cannot
        // be read/parsed natively takes the trame fallback (log + old path)
        // instead of stranding an error panel.
        try {
            const content = await this.fileService.read(uri);
            parseVtmManifest(content.value.toString());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
                `[dagmc-viewer] Native multiblock load failed for ${uri.path.toString()}, falling back to the trame viewer: ${message}`
            );
            await this.openLegacyViewer(uri);
            return;
        }

        const widget = await this.widgetManager.getOrCreateWidget<DagmcViewerWidget>(DagmcViewerWidget.ID, {
            id: `${DagmcViewerWidget.ID}:${uri.path.toString()}`
        });
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        try {
            await widget.setVtmFile(uri);
            await this.loadModelInfo(widget, uri);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
                `[dagmc-viewer] Native multiblock load failed for ${uri.path.toString()}, falling back to the trame viewer: ${message}`
            );
            await this.openLegacyViewer(uri);
        }
    }

    /**
     * Best-effort `dagmc.info` → `setModelInfo`: only attempted for a
     * derivable sibling `.h5m`, and failures only log — the viewer stays
     * usable with every block visible and no toggles.
     */
    protected async loadModelInfo(widget: DagmcViewerWidget, uri: URI): Promise<void> {
        const h5mUri = siblingH5mCandidate(uri);
        if (!h5mUri) {
            return;
        }
        try {
            const info = await this.visualizerBackend.getDagmcInfo(h5mUri.path.toString());
            widget.setModelInfo(info);
        } catch (error) {
            console.warn(
                `[dagmc-viewer] dagmc.info failed for ${h5mUri.path.toString()} — volume toggles unavailable:`,
                error instanceof Error ? error.message : error
            );
        }
    }

    /**
     * Old path: the classic trame viewer — `dagmc.visualize` for the sibling
     * `.h5m` when one can be guessed, `base.serve` on the `.vtm` itself
     * otherwise (mirrors `VisualizerOpenHandler`).
     */
    protected async openLegacyViewer(uri: URI): Promise<void> {
        const target = siblingH5mCandidate(uri) ?? uri;
        const widget = await this.widgetManager.getOrCreateWidget<VisualizerWidget>(VisualizerWidget.ID, {
            uri: target.toString()
        });
        widget.setUri(target);
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        await widget.loadFile(target);
    }
}
