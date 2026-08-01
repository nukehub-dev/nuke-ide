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

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

import {
    OpenMCBackendService,
    NuclearDataLibraryResult,
    NuclideDetailResult,
    NuclearDataNuclideEntry
} from '../../../../../common/openmc-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';
import { startSplitDrag } from '../drag-split';
import { XSPlotWidget } from '../plotting/xs-plot-widget';
import './nuclear-data.css';

/**
 * Nuclear Data window: read-only inspection of the configured cross_sections
 * data library. Shows the library path, a searchable nuclide table (name,
 * temperature count, reaction count), and a per-nuclide detail panel (reaction
 * MT list, temperatures, fission flag) with a direct link into the XS plot.
 */
@injectable()
export class NuclearDataWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-nuclear-data-widget';
    /** Display label for the widget title. */
    static readonly LABEL = 'Nuclear Data';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCBackendService)
    protected readonly backendService!: OpenMCBackendService;

    @inject(NukeCoreService)
    protected readonly nukeCoreService!: NukeCoreService;

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    private libraryPath: string | undefined;
    private library?: NuclearDataLibraryResult;
    private loading = false;
    private filter = '';
    private selectedNuclide?: string;
    private detail?: NuclideDetailResult;
    private detailLoading = false;

    /** Initialize widget id, title, and load the default library. */
    @postConstruct()
    protected init(): void {
        this.id = NuclearDataWidget.ID;
        this.title.label = NuclearDataWidget.LABEL;
        this.title.caption = NuclearDataWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-database';

        // Follow preference changes (e.g. the user sets the path in Settings)
        this.toDispose.push(
            this.preferenceService.onPreferenceChanged((event) => {
                if (event.preferenceName === 'nuke.openmcCrossSections') {
                    this.libraryPath = this.nukeCoreService.getCrossSectionsPath() || undefined;
                    this.selectedNuclide = undefined;
                    this.detail = undefined;
                    void this.loadLibrary();
                }
            })
        );

        // Initial load only once preferences are ready — on a browser reload the
        // layout restores this widget before user settings have loaded, and
        // reading the preference early yields the schema default ''.
        this.preferenceService.ready.then(() => {
            if (!this.libraryPath) {
                this.libraryPath = this.nukeCoreService.getCrossSectionsPath() || undefined;
            }
            void this.loadLibrary();
        });
        this.update();
    }

    /** Load (or reload) the library summary from the backend. */
    private async loadLibrary(): Promise<void> {
        // Re-resolve the preference at request time: at widget init the
        // preference service may not have loaded user settings yet (and the
        // user may have set the path since the window opened).
        if (!this.libraryPath) {
            this.libraryPath = this.nukeCoreService.getCrossSectionsPath() || undefined;
        }
        this.loading = true;
        this.library = undefined;
        this.update();
        try {
            this.library = await this.backendService.getNuclearDataLibrary({ crossSectionsPath: this.libraryPath });
            if (!this.library.success) {
                this.messageService.error(this.library.error || 'Failed to read the data library');
            } else {
                this.libraryPath = this.library.libraryPath;
            }
        } catch (error) {
            this.library = { success: false, error: String(error) };
            this.messageService.error(String(error));
        } finally {
            this.loading = false;
            this.update();
        }
    }

    /** Browse for a different cross_sections.xml and load it. */
    private async browseLibrary(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select cross_sections.xml',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'Cross Sections': ['xml'], 'All Files': ['*'] }
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (uri) {
            this.libraryPath = uri.path.toString();
            this.selectedNuclide = undefined;
            this.detail = undefined;
            await this.loadLibrary();
        }
    }

    /** Load the detail panel for a nuclide entry. */
    private async selectNuclide(entry: NuclearDataNuclideEntry): Promise<void> {
        this.selectedNuclide = entry.name;
        this.detail = undefined;
        this.detailLoading = true;
        this.update();
        try {
            this.detail = await this.backendService.getNuclideDetail({ path: entry.path });
            if (!this.detail.success) {
                this.messageService.error(this.detail.error || `Failed to read ${entry.name}`);
            }
        } catch (error) {
            this.detail = { success: false, error: String(error) };
            this.messageService.error(String(error));
        } finally {
            this.detailLoading = false;
            this.update();
        }
    }

    /** Open the XS plot widget with the selected nuclide pre-selected. */
    private async plotInXSViewer(nuclide: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<XSPlotWidget>(XSPlotWidget.ID);
        widget.selectNuclide(nuclide);
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
    }

    /** Width of the list panel in px (undefined = CSS default). */
    private panelWidth?: number;

    /**
     * Drag-to-resize the list panel (shared helper: direct DOM writes during
     * the drag, iframe click-shield, commit once on mouseup).
     */
    private startPanelDrag = (e: React.MouseEvent): void => {
        const panel = this.node.querySelector<HTMLElement>('.nuclide-list-panel');
        if (!panel) {
            return;
        }
        const startWidth = panel.getBoundingClientRect().width;
        startSplitDrag({
            event: e,
            node: this.node,
            sizeFromEvent: (start, ev) => Math.min(640, Math.max(220, startWidth + ev.clientX - start.clientX)),
            apply: (size) => {
                panel.style.width = `${size}px`;
                this.panelWidth = size;
            },
            commit: () => this.update()
        });
    };

    /** Render the widget. */
    protected render(): React.ReactNode {
        const nuclides = (this.library?.nuclides ?? []).filter((n) => n.name.toLowerCase().includes(this.filter.toLowerCase()));

        return (
            <div className="nuclear-data-widget">
                <div className="openmc-header">
                    <div className="header-info">
                        <h2>
                            <i className="codicon codicon-database"></i>
                            Nuclear Data
                        </h2>
                        <p className="header-description">Inspect the configured cross-section data library (read-only)</p>
                    </div>
                    <div className="header-actions">
                        <Tooltip content="Load a different cross_sections.xml" position="bottom">
                            <button className="theia-button secondary" onClick={() => this.browseLibrary()}>
                                <i className="codicon codicon-folder-opened"></i> Change Library…
                            </button>
                        </Tooltip>
                        <Tooltip content="Reload the library" position="bottom">
                            <button className="theia-button secondary" disabled={this.loading} onClick={() => this.loadLibrary()}>
                                <i className="codicon codicon-refresh"></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div className="library-path-row">
                    <span className="library-path-label">Library:</span>
                    <code className="library-path-value" title={this.libraryPath}>
                        {this.libraryPath ?? '(unresolved — set nuke.openmcCrossSections or Change Library…)'}
                    </code>
                </div>

                {this.loading && (
                    <div className="empty-state">
                        <i className="codicon codicon-loading codicon-modifier-spin"></i>
                        <p>Reading library…</p>
                    </div>
                )}

                {!this.loading && this.library && !this.library.success && (
                    <div className="empty-state">
                        <i className="codicon codicon-error"></i>
                        <p>{this.library.error}</p>
                        <p className="empty-hint">
                            Set the cross-sections path in preferences (nuke.openmcCrossSections) or use Change Library…
                        </p>
                    </div>
                )}

                {!this.loading && this.library?.success && (
                    <div className="nuclear-data-body">
                        <div className="nuclide-list-panel" style={this.panelWidth ? { width: this.panelWidth } : undefined}>
                            <div className="nuclide-toolbar">
                                <input
                                    type="text"
                                    placeholder={`Search ${this.library.nuclideCount} nuclides…`}
                                    value={this.filter}
                                    onChange={(e) => {
                                        this.filter = e.target.value;
                                        this.update();
                                    }}
                                />
                            </div>
                            <div className="nuclide-table-wrapper">
                                <table className="nuclide-table">
                                    <thead>
                                        <tr>
                                            <th>Nuclide</th>
                                            <th className="numeric">Temps</th>
                                            <th className="numeric">Reactions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {nuclides.map((n) => (
                                            <tr
                                                key={n.name}
                                                className={this.selectedNuclide === n.name ? 'selected' : ''}
                                                onClick={() => this.selectNuclide(n)}
                                            >
                                                <td>{n.name}</td>
                                                <td className="numeric">{n.temperatureCount}</td>
                                                <td className="numeric">{n.reactionCount}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="nuclide-list-footer">
                                {nuclides.length === this.library.nuclideCount
                                    ? `${this.library.nuclideCount} nuclides`
                                    : `${nuclides.length} of ${this.library.nuclideCount} nuclides`}
                            </div>
                        </div>

                        <div className="nuclide-split-handle" onMouseDown={this.startPanelDrag} title="Drag to resize" />

                        <div className="nuclide-detail-panel">
                            {this.detailLoading && <p className="form-hint">Loading {this.selectedNuclide}…</p>}
                            {!this.detailLoading && !this.detail && (
                                <div className="empty-state">
                                    <i className="codicon codicon-info"></i>
                                    <p>Select a nuclide to inspect its reactions</p>
                                </div>
                            )}
                            {!this.detailLoading && this.detail?.success && (
                                <>
                                    <div className="detail-header">
                                        <h4>
                                            <i className="codicon codicon-symbol-atom"></i> {this.detail.name}
                                        </h4>
                                        {this.detail.fission && <span className="fission-chip">fission</span>}
                                        <div className="header-actions">
                                            <Tooltip content="Plot cross-sections in the XS Plot viewer" position="bottom">
                                                <button
                                                    className="theia-button secondary"
                                                    onClick={() => this.plotInXSViewer(this.detail!.name!)}
                                                >
                                                    <i className="codicon codicon-graph-line"></i> Plot in XS Viewer
                                                </button>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">Temperatures:</span>
                                        <span className="temp-chips">
                                            {(this.detail.temperatures ?? []).map((t) => (
                                                <span key={t} className="temp-chip">
                                                    {t}
                                                </span>
                                            ))}
                                            {(this.detail.temperatures ?? []).length === 0 && '—'}
                                        </span>
                                    </div>
                                    <div className="detail-row">
                                        <span className="detail-label">Reactions ({this.detail.reactionCount}):</span>
                                    </div>
                                    <div className="reaction-grid">
                                        {(this.detail.reactions ?? []).map((r) => {
                                            const mtText = `MT ${r.mt}`;
                                            const chip = (
                                                <span key={r.mt} className="reaction-chip">
                                                    {r.label}
                                                </span>
                                            );
                                            // Unknown-MT labels already read "MT <n>" — no tooltip needed
                                            return r.label === mtText ? (
                                                chip
                                            ) : (
                                                <Tooltip key={r.mt} content={mtText} position="top">
                                                    {chip}
                                                </Tooltip>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                            {!this.detailLoading && this.detail && !this.detail.success && (
                                <div className="empty-state">
                                    <i className="codicon codicon-warning"></i>
                                    <p>{this.detail.error}</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    }
}
