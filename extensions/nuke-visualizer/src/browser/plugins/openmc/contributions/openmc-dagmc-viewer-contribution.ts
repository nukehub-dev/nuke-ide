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
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { VisualizerBackendService } from '../../../../common/base-visualizer-protocol';
import { VisualizerWidget } from '../../../visualizer-widget';
import { DagmcOutlineWidget } from '../../../dagmc-outline/dagmc-outline-widget';
import { DagmcViewerWidget } from '../widgets/dagmc/dagmc-viewer-widget';

/** Multiblock `.vtm` manifests (as written by `convert_h5m_to_multiblock_vtk`: `<stem>_volumes.vtm`). */
function isDagmcMultiblockFileName(baseName: string): boolean {
    return baseName.toLowerCase().endsWith('.vtm');
}

/** Raw DAGMC `.h5m` files, converted to multiblock `.vtm` on open. */
function isDagmcH5mFileName(baseName: string): boolean {
    return baseName.toLowerCase().endsWith('.h5m');
}

/**
 * Claim scores: `.h5m` beats the generic visualizer opener (1000) so DAGMC
 * files land in the isolating multiblock viewer; `.vtm` keeps its 600.
 */
export const DAGMC_H5M_CLAIM_SCORE = 1100;
export const DAGMC_VTM_CLAIM_SCORE = 600;

/**
 * Guess the source `.h5m` for a converter-written manifest (`<stem>_volumes.vtm`
 * → sibling `<stem>.h5m`). Used for the `dagmc.info` model metadata;
 * undefined when the name carries no such hint.
 */
function siblingH5mCandidate(uri: URI): URI | undefined {
    const match = /^(.*)_volumes\.vtm$/i.exec(uri.path.base);
    return match ? uri.parent.resolve(`${match[1]}.h5m`) : undefined;
}

/**
 * Routes DAGMC files to the native DAGMC viewer via the
 * OutputViewerRegistry:
 *
 * - `.h5m` (claimed at 1100, beating the generic visualizer's 1000): the
 *   viewer tab opens immediately with a loading overlay
 *   (`beginPendingLoad`), then converts to a multiblock `.vtm` through
 *   `VisualizerBackendService.convertDagmcMultiblock` (cached) and loads it
 *   through `setVtmFile` with `dagmc.info` toggles for the source file —
 *   every DAGMC file gets volume/material/group isolation for free.
 *   Conversion failure shows the error panel in the same tab (with a
 *   one-shot jump to the generic single-file viewer) instead of leaving a
 *   toast-only dead end.
 * - `.vtm` manifests (600): the tab opens immediately and loads directly
 *   as before; an unreadable manifest shows the in-tab error panel naming
 *   the generic VTK viewer as the alternative.
 *
 * Native-only: the manifest loads through `setVtmFile` (FileService,
 * no trame server) and volume/material/group toggles arrive via `setModelInfo`
 * with the `dagmc.info` payload.
 *
 * The single-file fallback stays working: `openGenericViewer` (the
 * `base.convert-dagmc` convert-then-probe flow) backs the error panel's
 * "Open in generic viewer" action.
 *
 * Every open also reveals the DAGMC Outline sidebar (without stealing
 * focus from the viewer), mirroring how the CAD open handler reveals its
 * Model Outline panels.
 *
 * A missing `dagmc.info` payload is NOT a native failure — the viewer simply
 * renders every block without toggles.
 */
@injectable()
export class OpenMCDagmcViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-dagmc-viewer';
    readonly label = 'DAGMC Viewer';
    readonly priority = 100;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    canHandle(uri: URI): number {
        const base = uri.path.base;
        if (isDagmcH5mFileName(base)) {
            return DAGMC_H5M_CLAIM_SCORE;
        }
        return isDagmcMultiblockFileName(base) ? DAGMC_VTM_CLAIM_SCORE : 0;
    }

    async open(uri: URI): Promise<void> {
        if (isDagmcH5mFileName(uri.path.base)) {
            await this.openH5m(uri);
            return;
        }
        await this.openManifest(uri);
    }

    /**
     * Open an `.h5m` instantly: the viewer tab (with its loading overlay)
     * appears before `base.convert-dagmc-multiblock` runs. Conversion
     * failure lands in the tab's error panel — with a one-shot jump to the
     * generic single-file viewer — instead of blocking the open.
     */
    protected async openH5m(uri: URI): Promise<void> {
        const h5mPath = uri.path.toString();
        const existing = this.findViewerForH5m(h5mPath);
        const widget = existing ?? (await this.createViewerWidget(h5mPath));
        if (existing) {
            await this.revealDagmcOutline();
            this.shell.activateWidget(existing.id);
            return;
        }
        widget.beginPendingLoad(uri.path.base, `Converting ${uri.path.base} to multiblock…`, h5mPath);
        widget.setGenericFallback(() => this.openGenericViewer(uri));
        try {
            const vtmPath = await this.visualizerBackend.convertDagmcMultiblock(h5mPath);
            await this.loadManifest(widget, new URI(vtmPath), h5mPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            widget.failPendingLoad(`Multiblock conversion failed: ${message}`);
            this.messageService.error(
                `Multiblock conversion failed for ${h5mPath} (${message}); use the error panel to open ${uri.path.base} in the generic viewer instead.`
            );
        }
    }

    /** Open the generic single-file viewer (the `base.convert-dagmc` convert-then-probe flow). */
    protected async openGenericViewer(uri: URI): Promise<void> {
        const widget = (await this.widgetManager.getOrCreateWidget<VisualizerWidget>(VisualizerWidget.ID, {
            uri: uri.toString()
        })) as VisualizerWidget;
        widget.setUri(uri);
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        await widget.loadFile(uri);
    }

    protected async openManifest(uri: URI, h5mPath?: string): Promise<void> {
        const widget = await this.createViewerWidget(uri.path.toString());
        await this.loadManifest(widget, uri, h5mPath);
    }

    /**
     * Create (or reuse) the per-file viewer tab, reveal the DAGMC Outline
     * sidebar without stealing focus, and activate the viewer — all before
     * any conversion or file read runs, so the tab appears instantly.
     */
    protected async createViewerWidget(idSuffix: string): Promise<DagmcViewerWidget> {
        const widget = await this.widgetManager.getOrCreateWidget<DagmcViewerWidget>(DagmcViewerWidget.ID, {
            id: `${DagmcViewerWidget.ID}:${idSuffix}`
        });
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        await this.revealDagmcOutline();
        this.shell.activateWidget(widget.id);
        return widget;
    }

    /**
     * Reveal the DAGMC Outline sidebar when a viewer tab opens (mirrors the
     * CAD open handler's model-panel reveal): the panel is never activated,
     * so focus stays in the viewer. Always `revealWidget`, even right after
     * `addWidget` — adding to a collapsed side area attaches the panel
     * without expanding it, so add-only leaves it in the DOM but hidden.
     */
    protected async revealDagmcOutline(): Promise<void> {
        const panel = await this.widgetManager.getOrCreateWidget(DagmcOutlineWidget.ID);
        if (!panel.isAttached) {
            await this.shell.addWidget(panel, { area: 'right' });
        }
        await this.shell.revealWidget(panel.id);
    }

    /** Reuse the live tab when the same `.h5m` is opened again (it re-ids to the `.vtm` path on load). */
    protected findViewerForH5m(h5mPath: string): DagmcViewerWidget | undefined {
        for (const widget of this.widgetManager.getWidgets(DagmcViewerWidget.ID)) {
            if (widget instanceof DagmcViewerWidget && !widget.isDisposed && widget.h5mSourcePath === h5mPath) {
                return widget;
            }
        }
        return undefined;
    }

    /** Load the manifest into an already-open tab; failures surface in-tab naming the generic viewer. */
    protected async loadManifest(widget: DagmcViewerWidget, uri: URI, h5mPath?: string): Promise<void> {
        try {
            await widget.setVtmFile(uri);
            await this.loadModelInfo(widget, uri, h5mPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(
                `Failed to load DAGMC multiblock ${uri.path.toString()}: ${message}. Try opening it in the generic VTK viewer instead.`
            );
        }
    }

    /**
     * Best-effort `dagmc.info` → `setModelInfo`: for converted `.h5m` opens
     * the source path is known directly; for `.vtm` opens it is derived
     * from the sibling name. Failures only log — the viewer stays usable
     * with every block visible and no toggles.
     */
    protected async loadModelInfo(widget: DagmcViewerWidget, uri: URI, h5mPath?: string): Promise<void> {
        const h5mUri = h5mPath !== undefined ? new URI(h5mPath) : siblingH5mCandidate(uri);
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
}
