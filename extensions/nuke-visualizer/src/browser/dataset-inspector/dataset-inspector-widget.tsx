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
import { ApplicationShell, Message, Widget } from '@theia/core/lib/browser';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { NukeEmptyState, NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    DEFAULT_DATASET_TABLE_ROWS,
    DatasetArrayInfo,
    DatasetAssociation,
    DatasetBounds,
    DatasetSummary,
    DatasetTable,
    formatDatasetNumber,
    tableToCsv
} from '../viewer-core/dataset-inspector';
import { isViewerDatasetHost, resolveDatasetSelection, ViewerDatasetHost } from './dataset-inspector-model';
import './dataset-inspector.css';

const DATASET_KIND_LABELS: Record<DatasetSummary['kind'], string> = {
    polydata: 'PolyData',
    rectilinear: 'Rectilinear grid',
    image: 'Image data'
};

/** Plain-integer count (section badges and counts never zero-pad). */
function formatCount(value: number): string {
    return Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : '0';
}

/** Deterministic grouped count for the table status, independent of the runtime locale. */
const TABLE_COUNT_FORMAT = new Intl.NumberFormat('en-US');

function formatTableCount(value: number): string {
    return TABLE_COUNT_FORMAT.format(Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
}

/** `[x, y, z]` coordinate triple with the inspector's display formatting. */
function formatVector(values: readonly [number, number, number]): string {
    return `[${values.map((value) => formatDatasetNumber(value)).join(', ')}]`;
}

/**
 * Dataset Inspector sidebar panel: summary, array catalogue, and a paged
 * spreadsheet preview for the active dataset viewer.
 *
 * Follows the Viewer Settings binding contract: the panel binds once to the
 * active viewer tab that implements {@link ViewerDatasetHost} (active wins,
 * else current, else the main area's selected tab), holds no dataset state
 * of its own, and reads a fresh summary/table on every render. The binding
 * is sticky while the panel itself has focus, and a closed tab drops back to
 * the empty state. Array selection and collapsed sections are panel-local UI
 * state only; the table always renders the first
 * {@link DEFAULT_DATASET_TABLE_ROWS} rows (the Copy CSV action copies the
 * same window), so a 100k-row array never materializes in the DOM.
 */
@injectable()
export class DatasetInspectorWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer-dataset-inspector-widget';
    static readonly LABEL = 'Dataset Inspector';

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    protected activeViewer: Widget | undefined;
    /** Panel-local collapsed sections (Viewer Settings / CAD TreeSection pattern). */
    protected collapsedSections = new Set<string>();
    protected selectedAssociation: DatasetAssociation | undefined;
    protected selectedName: string | undefined;
    protected copyStatus: string | undefined;
    protected copyStatusTimer: number | undefined;

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = DatasetInspectorWidget.ID;
        this.title.label = DatasetInspectorWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = codicon('table');
        this.toDispose.push(this.shell.onDidChangeActiveWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => this.refreshActiveViewer()));
        this.refreshActiveViewer();
    }

    override dispose(): void {
        this.clearCopyTimer();
        super.dispose();
    }

    /**
     * Rebind to the active dataset host tab (active wins, otherwise current,
     * otherwise the main area's current tab — the panel itself holds both
     * active and current right after opening). The binding is sticky: shell
     * events fired by interacting with this panel must not unbind the
     * inspected tab; only another host tab switches the binding, and a
     * disposed (closed) tab drops it.
     */
    protected refreshActiveViewer(): void {
        const active = this.shell.activeWidget;
        const current = this.shell.currentWidget;
        const main = this.shell.getCurrentWidget('main');
        const candidates: (Widget | undefined)[] = [active, current, main];
        const next = candidates.find((candidate) => candidate !== undefined && candidate !== this && isViewerDatasetHost(candidate));
        if (next !== undefined) {
            if (next !== this.activeViewer) {
                this.activeViewer = next;
                this.resetSelection();
            }
        } else if (this.activeViewer?.isDisposed) {
            this.activeViewer = undefined;
            this.resetSelection();
        }
        this.update();
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.refreshActiveViewer();
    }

    /** The bound viewer when the bound tab is a live dataset host (a single binding site, not per viewer). */
    protected datasetHost(): ViewerDatasetHost | undefined {
        const viewer = this.activeViewer;
        if (!viewer || viewer.isDisposed) {
            return undefined;
        }
        return isViewerDatasetHost(viewer) ? viewer : undefined;
    }

    /** The bound tab label shown as the header subtitle. */
    protected boundLabel(): string | undefined {
        const viewer = this.activeViewer;
        return viewer && !viewer.isDisposed ? viewer.title.label : undefined;
    }

    /** Forget the array choice when the bound dataset changes (names are dataset-local). */
    protected resetSelection(): void {
        this.selectedAssociation = undefined;
        this.selectedName = undefined;
        this.copyStatus = undefined;
        this.clearCopyTimer();
    }

    protected toggleSection(id: string): void {
        if (this.collapsedSections.has(id)) {
            this.collapsedSections.delete(id);
        } else {
            this.collapsedSections.add(id);
        }
        this.update();
    }

    protected selectAssociation(association: DatasetAssociation, summary: DatasetSummary): void {
        const first = summary.arrays.find((entry) => entry.association === association);
        this.selectedAssociation = association;
        this.selectedName = first?.name;
        this.clearCopyStatus();
        this.update();
    }

    protected selectArray(association: DatasetAssociation, name: string): void {
        this.selectedAssociation = association;
        this.selectedName = name;
        this.clearCopyStatus();
        this.update();
    }

    /** Copy the displayed CSV window to the clipboard with transient feedback. */
    protected copyTable(table: DatasetTable): void {
        const copied = table.rows(0, DEFAULT_DATASET_TABLE_ROWS).length;
        const write = navigator.clipboard?.writeText(tableToCsv(table));
        if (write === undefined) {
            this.flashCopyStatus('Clipboard unavailable');
            return;
        }
        void write.then(
            () => this.flashCopyStatus(`Copied ${formatCount(copied)} ${copied === 1 ? 'row' : 'rows'}`),
            () => this.flashCopyStatus('Copy failed')
        );
    }

    protected flashCopyStatus(message: string): void {
        this.copyStatus = message;
        this.clearCopyTimer();
        this.copyStatusTimer = window.setTimeout(() => {
            this.copyStatusTimer = undefined;
            this.copyStatus = undefined;
            this.update();
        }, 2500);
        this.update();
    }

    protected clearCopyStatus(): void {
        this.clearCopyTimer();
        this.copyStatus = undefined;
    }

    protected clearCopyTimer(): void {
        if (this.copyStatusTimer !== undefined) {
            window.clearTimeout(this.copyStatusTimer);
            this.copyStatusTimer = undefined;
        }
    }

    /**
     * CAD-style panel header: fixed panel name with an accent icon plus the
     * bound viewer tab label as an ellipsis-truncated subtitle (full text in
     * the Nuke tooltip, never `title=`).
     */
    protected renderHeader(subtitle: string | undefined, subtitleTooltip: string): React.ReactNode {
        return (
            <div className="dataset-inspector-header">
                <i className={`${codicon('table')} dataset-inspector-header-icon`}></i>
                <div className="dataset-inspector-header-text">
                    <span className="dataset-inspector-header-name">Dataset Inspector</span>
                    {subtitle !== undefined ? (
                        <Tooltip content={subtitleTooltip} position="bottom">
                            <span className="dataset-inspector-title">{subtitle}</span>
                        </Tooltip>
                    ) : (
                        <span className="dataset-inspector-title dataset-inspector-title-empty">No viewer open</span>
                    )}
                </div>
            </div>
        );
    }

    /**
     * CAD-style collapsible section: chevron + icon + uppercase label +
     * plain-integer count badge. Collapse is panel-local; the body keeps
     * every control hook unchanged.
     */
    protected renderSection(id: string, label: string, icon: string, count: number, body: React.ReactNode): React.ReactNode {
        const collapsed = this.collapsedSections.has(id);
        return (
            <div className={`dataset-inspector-section${collapsed ? ' collapsed' : ''}`}>
                <div
                    className="dataset-inspector-category-header"
                    role="button"
                    tabIndex={0}
                    onClick={() => this.toggleSection(id)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.toggleSection(id);
                        }
                    }}
                >
                    <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`}></i>
                    <i className={`codicon codicon-${icon} dataset-inspector-section-icon`}></i>
                    <span>{label}</span>
                    <span className="dataset-inspector-count-badge">{count}</span>
                </div>
                {!collapsed && <div className="dataset-inspector-section-body">{body}</div>}
            </div>
        );
    }

    protected render(): React.ReactNode {
        const host = this.datasetHost();
        const subtitle = this.boundLabel();
        if (!host) {
            return (
                <div className="dataset-inspector-panel">
                    {this.renderHeader(undefined, '')}
                    <NukeEmptyState
                        icon="table"
                        title="No dataset viewer open"
                        message="Open a VTK, DAGMC, tally, or Exodus file to inspect its dataset arrays here."
                        hint="The inspector follows the active viewer tab."
                    />
                </div>
            );
        }
        const summary = host.getDatasetSummary();
        return (
            <div className="dataset-inspector-panel">
                {this.renderHeader(subtitle, subtitle ?? '')}
                {summary === undefined ? (
                    <NukeEmptyState
                        icon="database"
                        title="No dataset loaded yet"
                        message="The summary and array tables appear once the viewer finishes loading its file."
                    />
                ) : (
                    <>
                        {this.renderSummarySection(summary)}
                        {this.renderArraysSection(summary)}
                        {this.renderStatsSection(host, summary)}
                        {this.renderTableSection(host, summary)}
                    </>
                )}
            </div>
        );
    }

    protected renderSummarySection(summary: DatasetSummary): React.ReactNode {
        const bounds = summary.bounds;
        const rows = [
            this.renderSummaryRow('info', 'Kind', DATASET_KIND_LABELS[summary.kind] ?? summary.kind),
            this.renderSummaryRow('symbol-numeric', 'Points', formatCount(summary.nPoints)),
            this.renderSummaryRow('symbol-field', 'Cells', formatCount(summary.nCells)),
            bounds !== undefined && this.renderBoundsRow(bounds)
        ].filter((row) => row !== undefined && row !== false);
        return this.renderSection('summary', 'Summary', 'info', rows.length, <>{rows}</>);
    }

    protected renderSummaryRow(icon: string, label: string, value: string): React.ReactNode {
        return (
            <div className="dataset-inspector-row" key={label.toLowerCase()}>
                <span className="dataset-inspector-row-label">
                    <i className={`codicon codicon-${icon} dataset-inspector-row-icon`}></i>
                    {label}
                </span>
                <span className="dataset-inspector-value">{value}</span>
            </div>
        );
    }

    protected renderBoundsRow(bounds: DatasetBounds): React.ReactNode {
        const text = `${formatVector(bounds.min)} → ${formatVector(bounds.max)}`;
        return (
            <div className="dataset-inspector-row dataset-inspector-bounds" key="bounds">
                <span className="dataset-inspector-row-label">
                    <i className="codicon codicon-globe dataset-inspector-row-icon"></i>
                    Bounds
                </span>
                <span className="dataset-inspector-bounds-value" aria-label={`Dataset bounds ${text}`}>
                    {text}
                </span>
            </div>
        );
    }

    protected renderArraysSection(summary: DatasetSummary): React.ReactNode {
        const arrays = summary.arrays;
        const body =
            arrays.length === 0 ? (
                <div className="dataset-inspector-muted">No data arrays.</div>
            ) : (
                <>{arrays.map((array) => this.renderArrayRow(array))}</>
            );
        return this.renderSection('arrays', 'Arrays', 'symbol-array', arrays.length, body);
    }

    protected renderArrayRow(array: DatasetArrayInfo): React.ReactNode {
        const components = array.components === 1 ? '1 component' : `${formatCount(array.components)} components`;
        const range = `[${formatDatasetNumber(array.range[0])}, ${formatDatasetNumber(array.range[1])}]`;
        return (
            <div className="dataset-inspector-array-row" key={`${array.association}:${array.name}`}>
                <div className="dataset-inspector-array-line">
                    <i
                        className={`codicon codicon-${array.association === 'point' ? 'symbol-parameter' : 'symbol-field'} dataset-inspector-array-icon`}
                    ></i>
                    <Tooltip content={array.name} position="left">
                        <span className="dataset-inspector-array-name">{array.name}</span>
                    </Tooltip>
                    <span className={`dataset-inspector-association ${array.association}`}>
                        {array.association === 'point' ? 'P' : 'C'}
                    </span>
                </div>
                <div className="dataset-inspector-array-meta">
                    <span>{components}</span>
                    <span className="dataset-inspector-array-range">{range}</span>
                    <span>{formatCount(array.tupleCount)} tuples</span>
                </div>
            </div>
        );
    }

    /**
     * Descriptive statistics for the currently selected array. Optional
     * host method; older hosts simply omit the section. Cell arrays on
     * measurable geometry also show the integral and the summed volume/area.
     */
    protected renderStatsSection(host: ViewerDatasetHost, summary: DatasetSummary): React.ReactNode {
        if (host.getDatasetStats === undefined) {
            return undefined;
        }
        const selection = resolveDatasetSelection(summary, this.selectedAssociation, this.selectedName);
        if (!selection) {
            return undefined;
        }
        const stats = host.getDatasetStats(selection.association, selection.array.name);
        if (!stats) {
            return undefined;
        }
        const rows: React.ReactNode[] = [
            this.renderSummaryRow('symbol-numeric', 'Count', `${formatCount(stats.count)} values`),
            this.renderSummaryRow('arrow-down', 'Min', formatDatasetNumber(stats.min)),
            this.renderSummaryRow('graph', 'Q1', formatDatasetNumber(stats.q1)),
            this.renderSummaryRow('graph', 'Median', formatDatasetNumber(stats.median)),
            this.renderSummaryRow('graph', 'Q3', formatDatasetNumber(stats.q3)),
            this.renderSummaryRow('arrow-up', 'Max', formatDatasetNumber(stats.max)),
            this.renderSummaryRow('pulse', 'Mean', formatDatasetNumber(stats.mean)),
            this.renderSummaryRow('symbol-numeric', 'Std', formatDatasetNumber(stats.std))
        ];
        if (stats.total !== undefined) {
            rows.push(
                this.renderSummaryRow(
                    'combine',
                    stats.measure === 'volume' ? 'Integral (volume)' : 'Integral (area)',
                    formatDatasetNumber(stats.total)
                )
            );
        }
        if (stats.measureTotal !== undefined) {
            rows.push(
                this.renderSummaryRow('ruler', stats.measure === 'volume' ? 'Volume' : 'Area', formatDatasetNumber(stats.measureTotal))
            );
        }
        return this.renderSection('stats', 'Statistics', 'graph', rows.length, <>{rows}</>);
    }

    protected renderTableSection(host: ViewerDatasetHost, summary: DatasetSummary): React.ReactNode {
        const selection = resolveDatasetSelection(summary, this.selectedAssociation, this.selectedName);
        if (!selection) {
            return this.renderSection('table', 'Table', 'table', 0, <div className="dataset-inspector-muted">No arrays to inspect.</div>);
        }
        const association = selection.association;
        const table = host.getDatasetTable(association, selection.array.name);
        const pointCount = summary.arrays.filter((array) => array.association === 'point').length;
        const cellCount = summary.arrays.filter((array) => array.association === 'cell').length;
        const options = summary.arrays
            .filter((array) => array.association === association)
            .map((array) => ({ value: array.name, label: array.name }));
        const rows = table ? table.rows(0, DEFAULT_DATASET_TABLE_ROWS) : [];
        const shown = rows.length;
        const body = (
            <div className="dataset-inspector-table-section">
                <div className="dataset-inspector-row">
                    <span className="dataset-inspector-row-label">
                        <i className="codicon codicon-symbol-parameter dataset-inspector-row-icon"></i>
                        Association
                    </span>
                    <div className="dataset-inspector-association-toggle" role="group" aria-label="Data array association">
                        {this.renderAssociationButton('point', 'Point', pointCount, association, summary)}
                        {this.renderAssociationButton('cell', 'Cell', cellCount, association, summary)}
                    </div>
                </div>
                <div className="dataset-inspector-row">
                    <span className="dataset-inspector-row-label">
                        <i className="codicon codicon-symbol-array dataset-inspector-row-icon"></i>
                        Array
                    </span>
                    <NukeSelect
                        className="dataset-inspector-array-select"
                        ariaLabel="Inspector data array"
                        value={selection.array.name}
                        options={options}
                        onChange={(name) => this.selectArray(association, name)}
                    />
                </div>
                {table ? (
                    <>
                        <div className="dataset-inspector-table-status">
                            <span>
                                Showing {formatTableCount(shown)} of {formatTableCount(table.rowCount)} rows
                            </span>
                            <Tooltip content="Copy the displayed rows as CSV" position="top">
                                <button
                                    className="theia-button secondary dataset-inspector-copy"
                                    aria-label="Copy table rows as CSV"
                                    onClick={() => this.copyTable(table)}
                                >
                                    Copy CSV
                                </button>
                            </Tooltip>
                            {this.copyStatus !== undefined && <span className="dataset-inspector-copy-status">{this.copyStatus}</span>}
                        </div>
                        {this.renderTable(table, rows, `${association} array ${selection.array.name}`)}
                    </>
                ) : (
                    <div className="dataset-inspector-muted">No table available for this array.</div>
                )}
            </div>
        );
        return this.renderSection('table', 'Table', 'table', table ? table.rowCount : 0, body);
    }

    protected renderAssociationButton(
        association: DatasetAssociation,
        label: string,
        count: number,
        active: DatasetAssociation,
        summary: DatasetSummary
    ): React.ReactNode {
        const noun = count === 1 ? 'array' : 'arrays';
        return (
            <Tooltip key={association} content={`${formatCount(count)} ${label.toLowerCase()} data ${noun}`} position="top">
                <button
                    className={`theia-button secondary dataset-inspector-association-button${active === association ? ' active' : ''}`}
                    aria-pressed={active === association}
                    aria-label={`Show ${label.toLowerCase()} data arrays`}
                    disabled={count === 0}
                    onClick={() => this.selectAssociation(association, summary)}
                >
                    {label}
                </button>
            </Tooltip>
        );
    }

    protected renderTable(table: DatasetTable, rows: string[][], ariaLabel: string): React.ReactNode {
        return (
            <div className="dataset-inspector-table-wrap">
                <table className="dataset-inspector-table" aria-label={ariaLabel}>
                    <thead>
                        <tr>
                            <th scope="col">#</th>
                            {table.columns.map((column, index) => (
                                <th key={`${column}-${index}`} scope="col">
                                    {column}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                <th scope="row" className="dataset-inspector-row-number">
                                    {rowIndex + 1}
                                </th>
                                {row.map((cell, cellIndex) => (
                                    <td key={cellIndex}>{cell}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }
}
