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
import { DagmcViewerWidget } from '../plugins/openmc/widgets/dagmc/dagmc-viewer-widget';
import { isGraveyardMaterial } from '../plugins/openmc/widgets/dagmc/dagmc-toggle-model';
import {
    dagmcOutlineVolumeMatches,
    matchesDagmcOutlineQuery,
    resolveDagmcOutlineTargetId,
    DagmcOutlineHost,
    DagmcOutlinePatch,
    DagmcOutlineSnapshot
} from './dagmc-outline-model';
import './dagmc-outline.css';

/**
 * DAGMC Outline sidebar panel: volume / material / group visibility plus
 * outline↔canvas selection for the active DAGMC viewer tab, following the
 * Viewer Settings active-widget pattern and aesthetics.
 *
 * The panel binds once — every DAGMC viewer exposes the same
 * {@link DagmcOutlineHost} surface — and holds no viewer state itself:
 * every render reads a fresh snapshot from the bound widget, and every edit
 * routes through the widget's existing toggle-model setters and
 * widget-owned selection. The binding follows the last-active DAGMC tab and
 * stays put while the panel itself has focus (typing in the search filter
 * must not unbind the viewer); closing the tab drops back to the empty
 * state. Canvas picks refresh the panel through the widget's outline-change
 * signal. Display settings stay in the Viewer Settings sidebar — this panel
 * owns visibility + selection only. Volume rows collapse to `Volume <id>`
 * with the material as a muted suffix plus a hover eye button isolating the
 * row's volume; VOLUMES/MATERIALS/GROUPS headers are sticky with count
 * badges; the header keeps the bound viewer tab label as an
 * ellipsis-truncated subtitle (full text in the Nuke tooltip, never
 * overflowing raw text, never `title=`).
 */
@injectable()
export class DagmcOutlineWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer-dagmc-outline-widget';
    static readonly LABEL = 'DAGMC Outline';

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    protected activeViewer: Widget | undefined;
    protected outlineListener: Disposable | undefined;
    protected filter = '';
    /** Panel-local collapsed groups (CAD TreeSection pattern); viewer state is never cached here. */
    protected collapsedGroups = new Set<string>();

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = DagmcOutlineWidget.ID;
        this.title.label = DagmcOutlineWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = codicon('layers');
        this.toDispose.push(this.shell.onDidChangeActiveWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(Disposable.create(() => this.outlineListener?.dispose()));
        this.refreshActiveViewer();
    }

    /**
     * Rebind to the active DAGMC viewer tab (active wins, otherwise
     * current, otherwise the main area's selected tab). The main-area
     * fallback is focus-independent: shell activation/current events only
     * track focus, so without it a viewer opened, restored, or finished
     * loading without a focus change leaves the panel in its empty state.
     * The binding is sticky: shell events fired by interacting
     * with this panel resolve to no viewer, and must not unbind the tab
     * being adjusted — only another DAGMC tab switches the binding, and a
     * disposed (closed) tab drops it.
     */
    protected refreshActiveViewer(): void {
        const active = this.shell.activeWidget;
        const current = this.shell.currentWidget;
        const main = this.shell.getCurrentWidget('main');
        const targetId = resolveDagmcOutlineTargetId(active?.id, current?.id, main?.id);
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
        if (host instanceof DagmcViewerWidget) {
            this.outlineListener = host.onDidChangeDagmcOutline(() => this.update());
        }
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.refreshActiveViewer();
    }

    /** The bound viewer when the bound tab is a live DAGMC viewer (a single binding site, not per viewer). */
    protected outlineHost(): DagmcOutlineHost | undefined {
        const viewer = this.activeViewer;
        if (!viewer || viewer.isDisposed) {
            return undefined;
        }
        if (viewer instanceof DagmcViewerWidget) {
            return viewer;
        }
        return undefined;
    }

    /** Apply an outline edit through the widget's visibility setters, then re-render from the live snapshot. */
    protected applyPatch(host: DagmcOutlineHost, patch: DagmcOutlinePatch): void {
        host.applyDagmcOutline(patch);
        this.update();
    }

    /**
     * Isolate one volume through the widget's existing visibility setters:
     * show everything, then hide every other visible volume. The target
     * stays visible whether it started hidden or not. Isolating a graveyard
     * volume also enables the Graveyard switch — `showAll` keeps it by
     * design, so without this the canvas would go blank instead of showing
     * the graveyard.
     */
    protected isolateVolume(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot, id: number): void {
        const entry = snapshot.volumes.find((candidate) => candidate.id === id);
        host.applyDagmcOutline({ showAll: true });
        if (!snapshot.showGraveyard && entry?.material !== undefined && isGraveyardMaterial(entry.material)) {
            host.applyDagmcOutline({ showGraveyard: true });
        }
        for (const candidate of snapshot.volumes) {
            if (candidate.id !== id && candidate.visible) {
                host.applyDagmcOutline({ toggleVolume: candidate.id });
            }
        }
        this.update();
    }

    /**
     * Isolate one material or group through the widget's existing visibility
     * setters (same show-all-then-hide-others algebra as volumes, one patch
     * field per entry — no contract change). Isolating the Graveyard
     * material (or a graveyard-only group) also enables the Graveyard
     * switch, otherwise the canvas goes blank.
     */
    protected isolateNamed(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot, kind: 'material' | 'group', name: string): void {
        const entries = kind === 'material' ? snapshot.materials : snapshot.groups;
        let needsGraveyard: boolean;
        if (kind === 'material') {
            needsGraveyard = isGraveyardMaterial(name);
        } else {
            const members = snapshot.volumes.filter((entry) => entry.groups.includes(name));
            needsGraveyard =
                members.length > 0 && members.every((entry) => entry.material !== undefined && isGraveyardMaterial(entry.material));
        }
        host.applyDagmcOutline({ showAll: true });
        if (needsGraveyard && !snapshot.showGraveyard) {
            host.applyDagmcOutline({ showGraveyard: true });
        }
        for (const entry of entries) {
            if (entry.name !== name && entry.visible) {
                host.applyDagmcOutline(kind === 'material' ? { toggleMaterial: entry.name } : { toggleGroup: entry.name });
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
            <div className={`dagmc-outline-group${collapsed ? ' collapsed' : ''}`}>
                <div
                    className="dagmc-outline-group-header"
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
                    <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'} dagmc-outline-chevron`}></i>
                    <span className="dagmc-outline-group-label">{label}</span>
                    <span className="dagmc-outline-count-badge">{count}</span>
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
        return <span className={`dagmc-outline-state-dot${visible ? ' is-visible' : ' is-hidden'}`}></span>;
    }

    protected renderIsolateButton(label: string, onIsolate: () => void): React.ReactNode {
        return (
            <Tooltip content={`Isolate ${label}`} position="left">
                <button
                    type="button"
                    className="dagmc-outline-isolate"
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
        const snapshot = host?.getDagmcOutlineSnapshot();
        if (!host || !snapshot) {
            return (
                <div className="dagmc-outline-panel">
                    <NukeEmptyState
                        icon="layers"
                        title="No DAGMC viewer open."
                        message="Volume, material, and group visibility appear here."
                        hint="Open a .vtm or .h5m file to browse its volumes here."
                    />
                </div>
            );
        }
        return (
            <div className="dagmc-outline-panel">
                <div className="dagmc-outline-header">
                    <i className={`${codicon('layers')} dagmc-outline-header-icon`}></i>
                    <div className="dagmc-outline-header-text">
                        <span className="dagmc-outline-panel-name">DAGMC Outline</span>
                        <div className="dagmc-outline-title">
                            <Tooltip content={snapshot.title} position="bottom">
                                <span className="dagmc-outline-title-text">{snapshot.title}</span>
                            </Tooltip>
                        </div>
                    </div>
                </div>
                {!snapshot.hasDataset ? (
                    <NukeEmptyState
                        title="No dataset loaded yet."
                        message="Volumes appear here once the viewer finishes loading its file."
                    />
                ) : (
                    <>
                        <div className="dagmc-outline-status nuke-viewer-status-line">
                            <Tooltip content="Visible volumes" position="bottom">
                                <span>
                                    {snapshot.visibleCount} of {snapshot.totalCount} volumes
                                </span>
                            </Tooltip>
                        </div>
                        {this.renderSearch()}
                        {this.renderGraveyard(host, snapshot)}
                        {this.renderShowAll(host)}
                        {this.renderVolumes(host, snapshot)}
                        {snapshot.hasModelInfo ? (
                            <>
                                {this.renderMaterials(host, snapshot)}
                                {this.renderGroups(host, snapshot)}
                            </>
                        ) : (
                            <div className="dagmc-outline-banner dagmc-outline-hint">
                                <i className={`${codicon('info')} dagmc-outline-banner-icon`}></i>
                                <span>Material and group info need model info (dagmc.info).</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    }

    protected renderSearch(): React.ReactNode {
        return (
            <div className="dagmc-outline-search-tip">
                <Tooltip content="Filter volumes by id, material, or group" position="bottom">
                    <NukeSearchInput
                        className="dagmc-outline-search"
                        placeholder="Filter volumes…"
                        ariaLabel="Filter volumes by id, material, or group"
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

    protected renderGraveyard(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot): React.ReactNode {
        return (
            <div className="dagmc-outline-row dagmc-outline-graveyard-row">
                {this.renderStateDot(snapshot.showGraveyard)}
                <NukeSwitch
                    className="dagmc-outline-graveyard"
                    ariaLabel="Show graveyard termination volumes"
                    checked={snapshot.showGraveyard}
                    onChange={(checked) => this.applyPatch(host, { showGraveyard: checked })}
                />
                <i className={`${codicon('trash')} dagmc-outline-row-icon`}></i>
                <Tooltip content="Show graveyard termination volumes" position="right">
                    <span className="dagmc-outline-row-label">Graveyard</span>
                </Tooltip>
            </div>
        );
    }

    protected renderShowAll(host: DagmcOutlineHost): React.ReactNode {
        return (
            <Tooltip content="Show every volume" position="right">
                <button className="theia-button secondary dagmc-outline-show-all" onClick={() => this.applyPatch(host, { showAll: true })}>
                    <i className={codicon('eye')}></i>
                    Show all
                </button>
            </Tooltip>
        );
    }

    protected renderVolumes(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot): React.ReactNode {
        const volumes = snapshot.volumes.filter((entry) => dagmcOutlineVolumeMatches(entry, this.filter));
        return this.renderGroup(
            'volumes',
            'Volumes',
            volumes.length,
            volumes.length === 0 ? (
                <span className="dagmc-outline-hint">No volumes match the filter.</span>
            ) : (
                volumes.map((entry) => {
                    const detail = entry.material
                        ? `${entry.label} — ${entry.material}${entry.groups.length > 0 ? ` — ${entry.groups.join(', ')}` : ''}`
                        : entry.label;
                    return (
                        <div
                            key={entry.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={entry.selected}
                            className={`dagmc-outline-row dagmc-outline-volume-row${entry.selected ? ' selected' : ''}${
                                entry.visible ? '' : ' dagmc-outline-row-hidden'
                            }`}
                            onClick={() => this.applyPatch(host, { selectVolume: entry.selected ? null : entry.id })}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    this.applyPatch(host, { selectVolume: entry.selected ? null : entry.id });
                                }
                            }}
                        >
                            {this.renderStateDot(entry.visible)}
                            <NukeCheckbox
                                className="dagmc-outline-volume-checkbox"
                                checked={entry.visible}
                                ariaLabel={`Toggle ${entry.label} visibility`}
                                onChange={() => this.applyPatch(host, { toggleVolume: entry.id })}
                            />
                            <i className={`${codicon('database')} dagmc-outline-row-icon`}></i>
                            <Tooltip content={detail} position="right">
                                <span className="dagmc-outline-row-label">
                                    <span className="dagmc-outline-row-name">{entry.label}</span>
                                    {entry.material !== undefined && <span className="dagmc-outline-row-material">{entry.material}</span>}
                                </span>
                            </Tooltip>
                            {!entry.visible && <i className={`${codicon('eye-closed')} dagmc-outline-row-hidden-marker`}></i>}
                            {this.renderIsolateButton(entry.label, () => this.isolateVolume(host, snapshot, entry.id))}
                        </div>
                    );
                })
            )
        );
    }

    protected renderMaterials(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot): React.ReactNode {
        const materials = snapshot.materials.filter((entry) =>
            matchesDagmcOutlineQuery(`${entry.name} (${entry.volumeCount})`, this.filter)
        );
        return this.renderGroup(
            'materials',
            'Materials',
            materials.length,
            materials.map((entry) => (
                <div
                    key={entry.name}
                    role="button"
                    tabIndex={0}
                    className={`dagmc-outline-row dagmc-outline-material-row${entry.visible ? '' : ' dagmc-outline-row-hidden'}`}
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
                        className="dagmc-outline-material-checkbox"
                        checked={entry.visible}
                        ariaLabel={`Toggle material ${entry.name} visibility`}
                        onChange={() => this.applyPatch(host, { toggleMaterial: entry.name })}
                    />
                    <i className={`${codicon('symbol-color')} dagmc-outline-row-icon`}></i>
                    <Tooltip content={`Material ${entry.name} (${entry.volumeCount} volumes)`} position="right">
                        <span className="dagmc-outline-row-label">
                            <span className="dagmc-outline-row-name">{entry.name}</span>
                            <span className="dagmc-outline-row-material dagmc-outline-count-badge">{entry.volumeCount}</span>
                        </span>
                    </Tooltip>
                    {!entry.visible && <i className={`${codicon('eye-closed')} dagmc-outline-row-hidden-marker`}></i>}
                    {this.renderIsolateButton(`material ${entry.name}`, () => this.isolateNamed(host, snapshot, 'material', entry.name))}
                </div>
            ))
        );
    }

    protected renderGroups(host: DagmcOutlineHost, snapshot: DagmcOutlineSnapshot): React.ReactNode {
        const groups = snapshot.groups.filter((entry) => matchesDagmcOutlineQuery(`${entry.name} (${entry.volumeCount})`, this.filter));
        return this.renderGroup(
            'groups',
            'Groups',
            groups.length,
            groups.map((entry) => (
                <div
                    key={entry.name}
                    role="button"
                    tabIndex={0}
                    className={`dagmc-outline-row dagmc-outline-group-row${entry.visible ? '' : ' dagmc-outline-row-hidden'}`}
                    onClick={() => this.applyPatch(host, { toggleGroup: entry.name })}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.applyPatch(host, { toggleGroup: entry.name });
                        }
                    }}
                >
                    {this.renderStateDot(entry.visible)}
                    <NukeCheckbox
                        className="dagmc-outline-group-checkbox"
                        checked={entry.visible}
                        ariaLabel={`Toggle group ${entry.name} visibility`}
                        onChange={() => this.applyPatch(host, { toggleGroup: entry.name })}
                    />
                    <i className={`${codicon('folder')} dagmc-outline-row-icon`}></i>
                    <Tooltip content={`Group ${entry.name} (${entry.volumeCount} volumes)`} position="right">
                        <span className="dagmc-outline-row-label">
                            <span className="dagmc-outline-row-name">{entry.name}</span>
                            <span className="dagmc-outline-row-material dagmc-outline-count-badge">{entry.volumeCount}</span>
                        </span>
                    </Tooltip>
                    {!entry.visible && <i className={`${codicon('eye-closed')} dagmc-outline-row-hidden-marker`}></i>}
                    {this.renderIsolateButton(`group ${entry.name}`, () => this.isolateNamed(host, snapshot, 'group', entry.name))}
                </div>
            ))
        );
    }
}
