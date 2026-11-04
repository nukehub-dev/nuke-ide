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

/**
 * Nuke Preview Gallery Widget
 *
 * Read-only gallery of the preview bundles persisted by {@link NukePreviewStore}.
 * Cards open the preview file, or the result snapshot when a bundle has no
 * preview, through the Theia opener. The widget never deletes, regenerates, or
 * writes previews; its only state is the current scan.
 *
 * @module nuke-ai/browser/preview
 */

import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { OpenerService, open } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { NukePreviewGalleryEntry, NukePreviewGalleryService } from './nuke-preview-gallery-service';
import './nuke-preview-gallery.css';

/** Widget id and label used by the command contribution. */
export const NUKE_PREVIEW_GALLERY_WIDGET_ID = 'nuke-ai-preview-gallery';

/** Props for the pure gallery view. */
export interface NukePreviewGalleryViewProps {
    readonly entries: readonly NukePreviewGalleryEntry[];
    readonly loading: boolean;
    readonly error?: string;
    readonly onOpen: (entry: NukePreviewGalleryEntry) => void;
    readonly onRefresh: () => void;
}

/** Render the preview gallery without Theia services or DOM access. */
export function NukePreviewGalleryView({ entries, loading, error, onOpen, onRefresh }: NukePreviewGalleryViewProps): React.ReactElement {
    return (
        <div className="nuke-preview-gallery" data-loading={loading ? 'true' : 'false'}>
            <header className="nuke-preview-gallery-header">
                <div className="nuke-preview-gallery-heading">
                    <h2 className="nuke-preview-gallery-title">Preview Gallery</h2>
                    <p className="nuke-preview-gallery-subtitle">
                        Read-only history of previews captured by NukeAI actions in this workspace.
                    </p>
                </div>
                <button
                    type="button"
                    className="theia-button secondary nuke-preview-gallery-refresh"
                    onClick={onRefresh}
                    disabled={loading}
                >
                    <span className="codicon codicon-refresh" aria-hidden="true" />
                    Refresh
                </button>
            </header>
            {error && (
                <div className="nuke-preview-gallery-error" role="alert">
                    <span className="codicon codicon-error" aria-hidden="true" />
                    <span>{error}</span>
                </div>
            )}
            {loading && entries.length === 0 && (
                <p className="nuke-preview-gallery-loading" role="status">
                    Scanning saved previews…
                </p>
            )}
            {!loading && entries.length === 0 && !error && (
                <div className="nuke-preview-gallery-empty" data-state="empty">
                    <span className="codicon codicon-device-camera nuke-preview-gallery-empty-icon" aria-hidden="true" />
                    <h3 className="nuke-preview-gallery-empty-title">No previews yet</h3>
                    <p className="nuke-preview-gallery-empty-text">
                        Previews appear here after a NukeAI action captures a viewport or returns a result with a preview or artifact. Ask
                        NukeAI to capture the active DAGMC view, then refresh this gallery.
                    </p>
                </div>
            )}
            {entries.length > 0 && (
                <ul className="nuke-preview-gallery-grid">
                    {entries.map((entry) => (
                        <li key={`${entry.sessionId}/${entry.bundleId}`} className="nuke-preview-gallery-item">
                            <button
                                type="button"
                                className="nuke-preview-gallery-card"
                                data-session-id={entry.sessionId}
                                data-bundle-id={entry.bundleId}
                                onClick={() => onOpen(entry)}
                            >
                                <span className="nuke-preview-gallery-thumbnail" aria-hidden="true">
                                    <span className={`codicon codicon-${entryIcon(entry.previewPath)}`} />
                                </span>
                                <span className="nuke-preview-gallery-card-body">
                                    <span className="nuke-preview-gallery-card-title">
                                        {entry.caption ?? entry.capabilityId ?? entry.bundleId}
                                    </span>
                                    <span className="nuke-preview-gallery-card-meta">
                                        <span>{entry.capabilityId ?? 'NukeAI preview'}</span>
                                        <span>{formatTimestamp(entry.createdAt)}</span>
                                    </span>
                                    <span className="nuke-preview-gallery-card-file">
                                        {entry.previewPath ? fileName(entry.previewPath) : 'result.json'}
                                    </span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <p className="nuke-preview-gallery-note">
                Preview files live under <code>.nuke-ide/ai/previews</code>. To remove them, delete that folder in the file explorer; the
                IDE recreates it on the next capture.
            </p>
        </div>
    );
}

/** Theia widget that scans and displays the persisted preview history. */
@injectable()
export class NukePreviewGalleryWidget extends ReactWidget {
    static readonly ID = NUKE_PREVIEW_GALLERY_WIDGET_ID;
    static readonly LABEL = 'NukeAI Preview Gallery';

    @inject(NukePreviewGalleryService)
    protected readonly galleryService: NukePreviewGalleryService;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(ILogger)
    protected readonly logger: ILogger;

    protected entries: readonly NukePreviewGalleryEntry[] = [];
    protected loading = true;
    protected error: string | undefined;

    constructor() {
        super();
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = NukePreviewGalleryWidget.ID;
        this.title.label = NukePreviewGalleryWidget.LABEL;
        this.title.caption = NukePreviewGalleryWidget.LABEL;
        this.title.closable = true;
        this.addClass('nuke-preview-gallery-widget');
        void this.refresh();
    }

    /** Rescan the preview history. Never writes or deletes anything. */
    async refresh(): Promise<void> {
        this.loading = true;
        this.error = undefined;
        this.update();
        try {
            this.entries = await this.galleryService.list();
        } catch (error) {
            this.logger.error('[NukeAI] Failed to scan the preview gallery.', error);
            this.error = 'Could not scan the saved previews. Open the workspace folder and try again.';
            this.entries = [];
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected async openEntry(entry: NukePreviewGalleryEntry): Promise<void> {
        const target = entry.previewPath ?? entry.resultPath;
        if (!target) {
            return;
        }
        try {
            await open(this.openerService, URI.fromFilePath(target));
        } catch (error) {
            this.logger.warn(`[NukeAI] Could not open the preview at ${target}.`, error);
        }
    }

    protected render(): React.ReactNode {
        return (
            <NukePreviewGalleryView
                entries={this.entries}
                loading={this.loading}
                error={this.error}
                onOpen={(entry) => void this.openEntry(entry)}
                onRefresh={() => void this.refresh()}
            />
        );
    }
}

function entryIcon(previewPath: string | undefined): string {
    const extension = previewPath?.split('.').pop()?.toLowerCase();
    switch (extension) {
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'webp':
        case 'svg':
            return 'device-camera';
        case 'html':
            return 'browser';
        case 'txt':
            return 'note';
        default:
            return 'file';
    }
}

function fileName(target: string): string {
    const parts = target.split(/[\\/]/);
    return parts[parts.length - 1] || target;
}

function formatTimestamp(value: string): string {
    const time = Date.parse(value);
    if (Number.isNaN(time)) {
        return value;
    }
    return new Date(time).toISOString().replace('T', ' ').slice(0, 16);
}
