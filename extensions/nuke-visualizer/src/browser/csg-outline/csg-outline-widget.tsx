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

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ApplicationShell, Widget } from '@theia/core/lib/browser';
import { Message } from '@theia/core/lib/browser';
import { Disposable } from '@theia/core/lib/common/disposable';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { NukeCheckbox, NukeEmptyState, NukeSearchInput, NukeSwitch, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { GeometryNativeViewerWidget } from '../plugins/openmc/widgets/geometry-native/geometry-native-viewer-widget';
import { TallyNativeViewerWidget } from '../plugins/openmc/widgets/tally-native/tally-native-viewer-widget';
import {
    csgOutlineCellMatches,
    matchesCsgOutlineQuery,
    resolveCsgOutlineTargetId,
    CsgOutlineHost,
    CsgOutlinePatch,
    CsgOutlineSnapshot
} from './csg-outline-model';
import './csg-outline.css';

/**
 * CSG Outline sidebar panel: cell / material visibility plus
 * outline↔canvas selection for the active native geometry viewer tab
 * (DAGMC Outline parity for `geometry.xml` models). Tally overlay tabs
 * bind too, driving their CSG underlay (visibility + panel-side
 * highlight; the tally canvas has no CSG picking, so selection sync is
 * panel→canvas only there).
 *
 * The panel binds once — every geometry viewer exposes the same
 * {@link CsgOutlineHost} surface — and holds no viewer state itself:
 * every render reads a fresh snapshot from the bound widget, and every edit
 * routes through the widget's existing visibility setters and widget-owned
 * selection. The binding follows the last-active geometry tab and stays put
 * while the panel itself has focus (typing in the search filter must not
 * unbind the viewer); closing the tab drops back to the empty state. Canvas
 * picks refresh the panel through the widget's outline-change signal.
 * Display settings stay in the Viewer Settings sidebar — this panel owns
 * visibility + selection only. Cell rows collapse to the model label with
 * the material as a muted suffix plus a hover eye button isolating the
 * row's cell; CELLS/MATERIALS headers are sticky with count badges; the
 * header keeps the bound viewer tab label as an ellipsis-truncated subtitle
 * (full text in the Nuke tooltip, never overflowing raw text, never
 * `title=`).
 */
@injectable()
export class CsgOutlineWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer-csg-outline-widget';
    static readonly LABEL = 'CSG Outline';

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    protected activeViewer: Widget | undefined;
    protected outlineListener: Disposable | undefined;
    protected filter = '';
    /** Panel-local collapsed groups (CAD TreeSection pattern); viewer state is never cached here. */
    protected collapsedGroups = new Set<string>();

    @postConstruct()
    protected init(): void {
        this.id = CsgOutlineWidget.ID;
        this.title.label = CsgOutlineWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = codicon('symbol-struct');
        this.toDispose.push(this.shell.onDidChangeActiveWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(Disposable.create(() => this.outlineListener?.dispose()));
        this.refreshActiveViewer();
    }

    /**
     * Rebind to the active geometry viewer tab (active wins, otherwise
     * current, otherwise the main area's selected tab). The main-area
     * fallback is focus-independent: shell activation/current events only
     * track focus, so without it a viewer opened, restored, or finished
     * loading without a focus change leaves the panel in its empty state.
     * The binding is sticky: shell events fired by interacting
     * with this panel resolve to no viewer, and must not unbind the tab
     * being adjusted — only another geometry tab switches the binding, and a
     * disposed (closed) tab drops it.
     */
    protected refreshActiveViewer(): void {
        const active = this.shell.activeWidget;
        const current = this.shell.currentWidget;
        const main = this.shell.getCurrentWidget('main');
        const targetId = resolveCsgOutlineTargetId(active?.id, current?.id, main?.id);
        if (targetId !== undefined) {
            const next = [active, current, main].find((candidate) => candidate?.id === targetId);
            if (next !== undefined && next !== this.activeViewer) {
                this.activeViewer = next;
                this.resubscribeOutline();
            }
        } else if (this.activeViewer?.isDisposed) {
            this.activeViewer = undefined;
            this.resubscribeOutline();
        }
        this.update();
    }

    /**
     * Follow the bound widget's outline-change signal so canvas picks and
     * load completion re-render the panel without waiting for the next
     * shell activation event.
     */
    protected resubscribeOutline(): void {
        this.outlineListener?.dispose();
        this.outlineListener = undefined;
        const host = this.outlineHost();
        if (host instanceof GeometryNativeViewerWidget || host instanceof TallyNativeViewerWidget) {
            this.outlineListener = host.onDidChangeCsgOutline(() => this.update());
        }
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.refreshActiveViewer();
    }

    /** The bound viewer when the bound tab is a live geometry viewer (a single binding site, not per viewer). */
    protected outlineHost(): CsgOutlineHost | undefined {
        const viewer = this.activeViewer;
        if (!viewer || viewer.isDisposed) {
            return undefined;
        }
        if (viewer instanceof GeometryNativeViewerWidget || viewer instanceof TallyNativeViewerWidget) {
            return viewer;
        }
        return undefined;
    }

    /** Apply an outline edit through the widget's visibility setters, then re-render from the live snapshot. */
    protected applyPatch(host: CsgOutlineHost, patch: CsgOutlinePatch): void {
        host.applyCsgOutline(patch);
        this.update();
    }

    /**
     * Isolate one cell through the widget's existing visibility setters:
     * show everything, then hide every other visible cell. The target stays
     * visible whether it started hidden or not. Isolating a void cell also
     * enables the Void switch — `showAll` keeps it by design, so without
     * this the canvas would go blank instead of showing the void cell.
     */
    protected isolateCell(host: CsgOutlineHost, snapshot: CsgOutlineSnapshot, id: number): void {
        const entry = snapshot.cells.find((candidate) => candidate.id === id);
        host.applyCsgOutline({ showAll: true });
        if (!snapshot.showVoid && entry && entry.material.trim().toLowerCase() === 'void') {
            host.applyCsgOutline({ showVoid: true });
        }
        for (const candidate of snapshot.cells) {
            if (candidate.id !== id && candidate.visible) {
                host.applyCsgOutline({ toggleCell: candidate.id });
            }
        }
        this.update();
    }

    /**
     * Isolate one material through the widget's existing visibility setters
     * (same show-all-then-hide-others algebra as cells). Isolating a
     * void-only selection also enables the Void switch, otherwise the canvas
     * goes blank.
     */
    protected isolateMaterial(host: CsgOutlineHost, snapshot: CsgOutlineSnapshot, name: string): void {
        const members = snapshot.cells.filter((entry) => entry.material === name);
        host.applyCsgOutline({ showAll: true });
        if (!snapshot.showVoid && members.length > 0 && members.every((entry) => entry.material.trim().toLowerCase() === 'void')) {
            host.applyCsgOutline({ showVoid: true });
        }
        for (const entry of snapshot.materials) {
            if (entry.name !== name && entry.visible) {
                host.applyCsgOutline({ toggleMaterial: entry.name });
            }
        }
        this.update();
    }

    protected toggleGroup(id: string): void {
        if (this.collapsedGroups.has(id)) {
            this.collapsedGroups.delete(id);
        } else {
            this.collapsedGroups.add(id);
        }
        this.update();
    }

    /**
     * CAD-style collapsible section: chevron + uppercase label + count
     * badge (OutlineSection grammar). Collapse is panel-local; every row
     * hook inside keeps working unchanged.
     */
    protected renderGroup(id: string, label: string, count: number, body: React.ReactNode): React.ReactNode {
        const collapsed = this.collapsedGroups.has(id);
        return (
            <div className={`csg-outline-group${collapsed ? ' collapsed' : ''}`}>
                <div
                    className="csg-outline-group-header"
                    role="button"
                    tabIndex={0}
                    onClick={() => this.toggleGroup(id)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.toggleGroup(id);
                        }
                    }}
                >
                    <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'} csg-outline-chevron`}></i>
                    <span className="csg-outline-group-label">{label}</span>
                    <span className="csg-outline-count-badge">{count}</span>
                </div>
                {!collapsed && body}
            </div>
        );
    }

    /**
     * Live visibility dot (CAD feature-tree-status grammar): green while
     * the row is visible, muted while hidden.
     */
    protected renderStateDot(visible: boolean): React.ReactNode {
        return <span className={`csg-outline-state-dot${visible ? ' is-visible' : ' is-hidden'}`}></span>;
    }

    protected renderIsolateButton(label: string, onIsolate: () => void): React.ReactNode {
        return (
            <Tooltip content={`Isolate ${label}`} position="left">
                <button
                    type="button"
                    className="csg-outline-isolate"
                    aria-label={`Isolate ${label}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onIsolate();
                    }}
                >
                    <i className={codicon('eye')}></i>
                </button>
            </Tooltip>
        );
    }

    protected render(): React.ReactNode {
        const host = this.outlineHost();
        const snapshot = host?.getCsgOutlineSnapshot();
        if (!host || !snapshot) {
            return (
                <div className="csg-outline-panel">
                    <NukeEmptyState
                        icon="symbol-struct"
                        title="No geometry viewer open."
                        message="Cell and material visibility appear here."
                        hint="Open a geometry.xml file to browse its cells here."
                    />
                </div>
            );
        }
        return (
            <div className="csg-outline-panel">
                <div className="csg-outline-header">
                    <i className={`${codicon('symbol-struct')} csg-outline-header-icon`}></i>
                    <div className="csg-outline-header-text">
                        <span className="csg-outline-panel-name">CSG Outline</span>
                        <div className="csg-outline-title">
                            <Tooltip content={snapshot.title} position="bottom">
                                <span className="csg-outline-title-text">{snapshot.title}</span>
                            </Tooltip>
                        </div>
                    </div>
                </div>
                {!snapshot.hasDataset ? (
                    <NukeEmptyState title="No dataset loaded yet." message="Cells appear here once the viewer finishes loading its file." />
                ) : (
                    <>
                        <div className="csg-outline-status nuke-viewer-status-line">
                            <Tooltip content="Visible cells" position="bottom">
                                <span>
                                    {snapshot.visibleCount} of {snapshot.totalCount} cells
                                </span>
                            </Tooltip>
                        </div>
                        {this.renderSearch()}
                        {this.renderVoid(host, snapshot)}
                        {this.renderShowAll(host)}
                        {this.renderCells(host, snapshot)}
                        {this.renderMaterials(host, snapshot)}
                    </>
                )}
            </div>
        );
    }

    protected renderSearch(): React.ReactNode {
        return (
            <div className="csg-outline-search-tip">
                <Tooltip content="Filter cells by id, name, or material" position="bottom">
                    <NukeSearchInput
                        className="csg-outline-search"
                        placeholder="Filter cells…"
                        ariaLabel="Filter cells by id, name, or material"
                        value={this.filter}
                        onChange={(value) => {
                            this.filter = value;
                            this.update();
                        }}
                    />
                </Tooltip>
            </div>
        );
    }

    protected renderVoid(host: CsgOutlineHost, snapshot: CsgOutlineSnapshot): React.ReactNode {
        return (
            <div className="csg-outline-row csg-outline-void-row">
                {this.renderStateDot(snapshot.showVoid)}
                <NukeSwitch
                    className="csg-outline-void"
                    ariaLabel="Show void cells"
                    checked={snapshot.showVoid}
                    onChange={(checked) => this.applyPatch(host, { showVoid: checked })}
                />
                <i className={`${codicon('circle-slash')} csg-outline-row-icon`}></i>
                <Tooltip content="Show void (unfilled) cells" position="right">
                    <span className="csg-outline-row-label">Void</span>
                </Tooltip>
            </div>
        );
    }

    protected renderShowAll(host: CsgOutlineHost): React.ReactNode {
        return (
            <Tooltip content="Show every cell" position="right">
                <button className="theia-button secondary csg-outline-show-all" onClick={() => this.applyPatch(host, { showAll: true })}>
                    <i className={codicon('eye')}></i>
                    Show all
                </button>
            </Tooltip>
        );
    }

    protected renderCells(host: CsgOutlineHost, snapshot: CsgOutlineSnapshot): React.ReactNode {
        const cells = snapshot.cells.filter((entry) => csgOutlineCellMatches(entry, this.filter));
        return this.renderGroup(
            'cells',
            'Cells',
            cells.length,
            cells.length === 0 ? (
                <span className="csg-outline-hint">No cells match the filter.</span>
            ) : (
                cells.map((entry) => {
                    const detail = `${entry.label} — ${entry.material}`;
                    return (
                        <div
                            key={entry.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={entry.selected}
                            className={`csg-outline-row csg-outline-cell-row${entry.selected ? ' selected' : ''}${
                                entry.visible ? '' : ' csg-outline-row-hidden'
                            }`}
                            onClick={() => this.applyPatch(host, { selectCell: entry.selected ? null : entry.id })}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    this.applyPatch(host, { selectCell: entry.selected ? null : entry.id });
                                }
                            }}
                        >
                            {this.renderStateDot(entry.visible)}
                            <NukeCheckbox
                                className="csg-outline-cell-checkbox"
                                checked={entry.visible}
                                ariaLabel={`Toggle ${entry.label} visibility`}
                                onChange={() => this.applyPatch(host, { toggleCell: entry.id })}
                            />
                            <i className={`${codicon('symbol-field')} csg-outline-row-icon`}></i>
                            <Tooltip content={detail} position="right">
                                <span className="csg-outline-row-label">
                                    <span className="csg-outline-row-name">{entry.label}</span>
                                    <span className="csg-outline-row-material">{entry.material}</span>
                                </span>
                            </Tooltip>
                            {!entry.visible && <i className={`${codicon('eye-closed')} csg-outline-row-hidden-marker`}></i>}
                            {this.renderIsolateButton(entry.label, () => this.isolateCell(host, snapshot, entry.id))}
                        </div>
                    );
                })
            )
        );
    }

    protected renderMaterials(host: CsgOutlineHost, snapshot: CsgOutlineSnapshot): React.ReactNode {
        const materials = snapshot.materials.filter((entry) => matchesCsgOutlineQuery(`${entry.name} (${entry.cellCount})`, this.filter));
        return this.renderGroup(
            'materials',
            'Materials',
            materials.length,
            materials.map((entry) => (
                <div
                    key={entry.name}
                    role="button"
                    tabIndex={0}
                    className={`csg-outline-row csg-outline-material-row${entry.visible ? '' : ' csg-outline-row-hidden'}`}
                    onClick={() => this.applyPatch(host, { toggleMaterial: entry.name })}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.applyPatch(host, { toggleMaterial: entry.name });
                        }
                    }}
                >
                    {this.renderStateDot(entry.visible)}
                    <NukeCheckbox
                        className="csg-outline-material-checkbox"
                        checked={entry.visible}
                        ariaLabel={`Toggle material ${entry.name} visibility`}
                        onChange={() => this.applyPatch(host, { toggleMaterial: entry.name })}
                    />
                    <i className={`${codicon('symbol-color')} csg-outline-row-icon`}></i>
                    <Tooltip content={`Material ${entry.name} (${entry.cellCount} cells)`} position="right">
                        <span className="csg-outline-row-label">
                            <span className="csg-outline-row-name">{entry.name}</span>
                            <span className="csg-outline-row-material csg-outline-count-badge">{entry.cellCount}</span>
                        </span>
                    </Tooltip>
                    {!entry.visible && <i className={`${codicon('eye-closed')} csg-outline-row-hidden-marker`}></i>}
                    {this.renderIsolateButton(`material ${entry.name}`, () => this.isolateMaterial(host, snapshot, entry.name))}
                </div>
            ))
        );
    }
}
