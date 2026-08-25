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
 * Model outline / region manifest panel.
 *
 * Shows the active CAD model's named volumes and surfaces from its
 * ``<model>.regions.json`` manifest (positional ``mat_<id>`` rows when the
 * model carries no manifest) and keeps a two-way picking sync with the CAD
 * viewport through the shared {@link NukeCadStateManager}: clicking a row
 * selects the mapped solid(s) in the viewport, and a viewport pick selects
 * the matching row here. The panel is read-only; the only action is opening
 * the manifest sidecar in the editor.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core/lib/common/uri';

import { RegionManifestData } from '../../../common/nuke-cad-protocol';
import { NukeCadStateManager, CadModel, CadSelection, SolidSummary } from '../../state/nuke-cad-state-manager';
import {
    bboxSize,
    compareSolidRows,
    formatQuantity,
    formatSi,
    formatVec3,
    MISSING_VALUE,
    SolidSortKey,
    SolidTableRow
} from './solid-summaries';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './outline-panel.css';

@injectable()
export class CadOutlinePanelWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-outline-panel-widget';
    static readonly LABEL = 'Model Outline';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(FileService)
    protected readonly fileService: FileService;

    private selection: CadSelection = {};
    private summaries: readonly SolidSummary[] = [];
    private manifestExists = false;
    /** Monotonically increasing token; stale manifest-existence probes are dropped. */
    private manifestCheckToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = CadOutlinePanelWidget.ID;
        this.title.label = CadOutlinePanelWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-nuke-cad-outline';

        this.selection = this.stateManager.selection;
        this.summaries = this.stateManager.solidSummaries;
        this.toDispose.push(this.stateManager.onModelChange(() => this.handleModelChange()));
        this.toDispose.push(
            this.stateManager.onSelectionChange((selection) => {
                this.selection = selection;
                this.update();
            })
        );
        this.toDispose.push(
            this.stateManager.onSolidSummariesChange((summaries) => {
                this.summaries = summaries;
                this.update();
            })
        );
        this.refreshManifestExists();
        this.update();
    }

    private handleModelChange(): void {
        this.refreshManifestExists();
        this.update();
    }

    /** URI of the ``<model>.regions.json`` sidecar beside the active model source. */
    private get manifestUri(): URI | undefined {
        const scriptPath = this.stateManager.scriptPath;
        if (!scriptPath) {
            return undefined;
        }
        return new URI(scriptPath.replace(/\.[^/\\.]+$/, '') + '.regions.json');
    }

    private get manifestFileName(): string {
        const scriptPath = this.stateManager.scriptPath;
        const base = scriptPath?.split(/[\\/]/).pop() ?? 'model';
        return base.replace(/\.[^.]+$/, '') + '.regions.json';
    }

    private refreshManifestExists(): void {
        const token = ++this.manifestCheckToken;
        const uri = this.manifestUri;
        this.manifestExists = false;
        if (!uri) {
            return;
        }
        this.fileService
            .exists(uri)
            .then((exists) => {
                if (token === this.manifestCheckToken) {
                    this.manifestExists = exists;
                    this.update();
                }
            })
            .catch(() => undefined);
    }

    /** Open the manifest sidecar in the editor (read-only panel; editing happens there). */
    private async openManifest(): Promise<void> {
        const uri = this.manifestUri;
        if (!uri) {
            return;
        }
        try {
            const opener = await this.openerService.getOpener(uri);
            await opener.open(uri);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Could not open region manifest: ${message}`);
        }
    }

    protected render(): React.ReactNode {
        return (
            <CadOutlinePanelComponent
                model={this.stateManager.model}
                selection={this.selection}
                summaries={this.summaries}
                manifestExists={this.manifestExists}
                manifestFileName={this.manifestFileName}
                onSelect={(solidId) => this.stateManager.setSelection({ solidId })}
                onOpenManifest={() => this.openManifest()}
            />
        );
    }
}

interface OutlineRowData {
    readonly key: string;
    readonly label: string;
    readonly detail?: string;
    readonly tags?: readonly string[];
    /** 1-based solid indices the row maps to via the build-time selector map; empty when unmapped. */
    readonly solidIndices: readonly number[];
}

function buildVolumeRows(model: CadModel): OutlineRowData[] {
    const selectorMap = model.result.selectorMap ?? {};
    const manifest = model.manifest;
    if (manifest) {
        return manifest.volumes.map((volume) => ({
            key: `volume:${volume.selector}`,
            label: volume.name ?? volume.selector,
            detail: volume.material,
            tags: volume.tags,
            solidIndices: selectorMap[volume.selector] ?? []
        }));
    }
    // Positional fallback for unmanifested models (STEP imports, plain scripts).
    const rows: OutlineRowData[] = [];
    for (let i = 1; i <= (model.result.solidCount ?? 0); i++) {
        rows.push({ key: `solid:${i}`, label: `mat_${i}`, solidIndices: [i] });
    }
    return rows;
}

function buildSurfaceRows(manifest: RegionManifestData, selectorMap: Record<string, number[]>): OutlineRowData[] {
    return manifest.surfaces.map((surface) => ({
        key: `surface:${surface.selector}`,
        label: surface.name ?? surface.selector,
        detail: surface.role,
        solidIndices: selectorMap[surface.selector] ?? []
    }));
}

/** First manifest label per solid index (positional ``mat_<id>`` when unmapped). */
function buildSolidLabelMap(model: CadModel | undefined): Map<number, string> {
    const map = new Map<number, string>();
    if (!model) {
        return map;
    }
    for (const row of buildVolumeRows(model)) {
        for (const solidIndex of row.solidIndices) {
            if (!map.has(solidIndex)) {
                map.set(solidIndex, row.label);
            }
        }
    }
    return map;
}

/** Union of manifest solids and tessellated solids, labeled for the table view. */
function buildSolidTableRows(model: CadModel | undefined, summaries: readonly SolidSummary[]): SolidTableRow[] {
    const labelBySolid = buildSolidLabelMap(model);
    const summaryById = new Map(summaries.map((summary) => [summary.solidId, summary]));
    const solidIds = new Set<number>([...labelBySolid.keys(), ...summaries.map((summary) => summary.solidId)]);
    return Array.from(solidIds)
        .sort((a, b) => a - b)
        .map((solidId) => ({
            solidId,
            label: labelBySolid.get(solidId) ?? `mat_${solidId}`,
            summary: summaryById.get(solidId)
        }));
}

interface CadOutlinePanelComponentProps {
    readonly model?: CadModel;
    readonly selection: CadSelection;
    readonly summaries: readonly SolidSummary[];
    readonly manifestExists: boolean;
    readonly manifestFileName: string;
    readonly onSelect: (solidId: number) => void;
    readonly onOpenManifest: () => void;
}

/** A pinned properties snapshot: summary plus its resolved body label. */
interface SolidPropertiesEntry {
    readonly summary: SolidSummary;
    readonly label: string;
}

function CadOutlinePanelComponent(props: CadOutlinePanelComponentProps): React.ReactElement {
    const [volumesCollapsed, setVolumesCollapsed] = React.useState(false);
    const [surfacesCollapsed, setSurfacesCollapsed] = React.useState(false);
    const [viewMode, setViewMode] = React.useState<'list' | 'table'>('list');
    const [sort, setSort] = React.useState<{ key: SolidSortKey; descending: boolean }>({ key: 'solidId', descending: false });
    const [pinnedEntry, setPinnedEntry] = React.useState<SolidPropertiesEntry | undefined>(undefined);

    const model = props.model;
    const selectedSolid = props.selection.solidId;
    const selectorMap = model?.result.selectorMap ?? {};
    const volumeRows = model ? buildVolumeRows(model) : [];
    const surfaceRows = model?.manifest ? buildSurfaceRows(model.manifest, selectorMap) : [];
    const summaries = props.summaries;

    // A viewport pick expands the collapsed section holding the matching row.
    React.useEffect(() => {
        if (selectedSolid === undefined) {
            return;
        }
        if (volumeRows.some((row) => row.solidIndices.includes(selectedSolid))) {
            setVolumesCollapsed(false);
        }
        if (surfaceRows.some((row) => row.solidIndices.includes(selectedSolid))) {
            setSurfacesCollapsed(false);
        }
        // Row lists are derived from the model; only the selection drives expansion.
    }, [selectedSolid]);

    const labelBySolid = buildSolidLabelMap(model);
    const followEntry: SolidPropertiesEntry | undefined = (() => {
        if (selectedSolid === undefined) {
            return undefined;
        }
        const summary = summaries.find((candidate) => candidate.solidId === selectedSolid);
        return summary ? { summary, label: labelBySolid.get(summary.solidId) ?? `mat_${summary.solidId}` } : undefined;
    })();
    const displayEntry = pinnedEntry ?? followEntry;

    const handleTogglePin = (): void => {
        if (pinnedEntry) {
            setPinnedEntry(undefined);
        } else if (followEntry) {
            setPinnedEntry(followEntry);
        }
    };

    const handleSort = (key: SolidSortKey): void => {
        setSort((previous) => ({ key, descending: previous.key === key ? !previous.descending : false }));
    };

    const tableRows =
        viewMode === 'table' ? buildSolidTableRows(model, summaries).sort((a, b) => compareSolidRows(a, b, sort.key, sort.descending)) : [];

    const scriptName = model?.scriptPath.split(/[\\/]/).pop();
    const warnings = model?.result.warnings ?? [];

    return (
        <div className="cad-outline-panel">
            <div className="cad-outline-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-nuke-cad-outline" />
                        Model Outline
                    </h2>
                    <p className="header-description">{scriptName ?? 'No CAD model open'}</p>
                </div>
                {model && (
                    <div className="header-actions">
                        <Tooltip content={viewMode === 'list' ? 'Show as spreadsheet table' : 'Show as list'} position="left">
                            <button
                                className="theia-button secondary view-toggle-button"
                                onClick={() => setViewMode(viewMode === 'list' ? 'table' : 'list')}
                            >
                                <i className={`codicon ${viewMode === 'list' ? 'codicon-table' : 'codicon-list-tree'}`} />
                            </button>
                        </Tooltip>
                        <Tooltip
                            content={
                                props.manifestExists
                                    ? `Open ${props.manifestFileName} in the editor`
                                    : `${props.manifestFileName} does not exist beside the model`
                            }
                            position="left"
                        >
                            <button
                                className="theia-button secondary manifest-button"
                                onClick={props.onOpenManifest}
                                disabled={!props.manifestExists}
                            >
                                <i className="codicon codicon-json" />
                                Manifest
                            </button>
                        </Tooltip>
                    </div>
                )}
            </div>

            {!model && (
                <div className="cad-outline-empty">
                    <i className="codicon codicon-nuke-cad-outline" />
                    <p>No CAD model is open.</p>
                    <span className="empty-hint">Open a model in the CAD viewport to inspect its volumes and surfaces.</span>
                </div>
            )}

            {model && (
                <div className="cad-outline-content">
                    {warnings.length > 0 && (
                        <div className="cad-outline-warning-box">
                            <i className="codicon codicon-warning" />
                            <div className="warning-content">
                                <strong>Build warnings</strong>
                                {warnings.map((warning, index) => (
                                    <p key={index}>{warning}</p>
                                ))}
                            </div>
                        </div>
                    )}

                    {!model.manifest && (
                        <div className="cad-outline-hint">
                            No region manifest (<code>{props.manifestFileName}</code>) for this model; showing positional solids.
                        </div>
                    )}

                    {displayEntry && (
                        <PropertiesSection entry={displayEntry} pinned={pinnedEntry !== undefined} onTogglePin={handleTogglePin} />
                    )}

                    {viewMode === 'list' ? (
                        <>
                            <OutlineSection
                                title="Volumes"
                                count={volumeRows.length}
                                collapsed={volumesCollapsed}
                                onToggle={() => setVolumesCollapsed(!volumesCollapsed)}
                            >
                                {volumeRows.map((row) => (
                                    <OutlineRow
                                        key={row.key}
                                        row={row}
                                        selected={selectedSolid !== undefined && row.solidIndices.includes(selectedSolid)}
                                        icon="codicon-nuke-cad-cube"
                                        onSelect={props.onSelect}
                                    />
                                ))}
                            </OutlineSection>

                            {surfaceRows.length > 0 && (
                                <OutlineSection
                                    title="Surfaces"
                                    count={surfaceRows.length}
                                    collapsed={surfacesCollapsed}
                                    onToggle={() => setSurfacesCollapsed(!surfacesCollapsed)}
                                >
                                    {surfaceRows.map((row) => (
                                        <OutlineRow
                                            key={row.key}
                                            row={row}
                                            selected={selectedSolid !== undefined && row.solidIndices.includes(selectedSolid)}
                                            icon="codicon-nuke-cad-datum"
                                            onSelect={props.onSelect}
                                        />
                                    ))}
                                </OutlineSection>
                            )}
                        </>
                    ) : (
                        <SolidTable
                            rows={tableRows}
                            sort={sort}
                            onSort={handleSort}
                            selectedSolid={selectedSolid}
                            onSelect={props.onSelect}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

interface PropertiesSectionProps {
    readonly entry: SolidPropertiesEntry;
    readonly pinned: boolean;
    readonly onTogglePin: () => void;
}

function PropertiesSection(props: PropertiesSectionProps): React.ReactElement {
    const summary = props.entry.summary;
    const properties = summary.properties;
    const size = bboxSize(properties);

    return (
        <div className="outline-section properties-section">
            <div className="category-header properties-header">
                <i className="codicon codicon-info" />
                <span>Properties</span>
                <Tooltip
                    content={
                        props.pinned
                            ? 'Unpin — follow the current selection again'
                            : 'Pin — keep these properties visible when the selection clears'
                    }
                    position="left"
                >
                    <button className={`pin-button${props.pinned ? ' pinned' : ''}`} onClick={props.onTogglePin}>
                        <i className={`codicon ${props.pinned ? 'codicon-pinned' : 'codicon-pin'}`} />
                    </button>
                </Tooltip>
            </div>
            <div className="properties-grid">
                <span className="prop-label">Body</span>
                <span className="prop-value" title={props.entry.label}>
                    {props.entry.label}
                </span>
                <span className="prop-label">Solid</span>
                <span className="prop-value">{summary.solidId}</span>
                <span className="prop-label">Volume</span>
                <span className="prop-value">{formatQuantity(properties?.volume, 'u³')}</span>
                <span className="prop-label">Area</span>
                <span className="prop-value">{formatQuantity(properties?.area, 'u²')}</span>
                <span className="prop-label">Size dx × dy × dz</span>
                <span className="prop-value">
                    {size ? `${formatSi(size[0])} × ${formatSi(size[1])} × ${formatSi(size[2])} u` : MISSING_VALUE}
                </span>
                <span className="prop-label">Center of mass</span>
                <span className="prop-value">{formatVec3(properties?.centerOfMass, 'u')}</span>
                <span className="prop-label">Faces</span>
                <span className="prop-value">{summary.faceCount}</span>
                <span className="prop-label">Edges</span>
                <span className="prop-value">{summary.edgeCount}</span>
                <span className="prop-label">Triangles</span>
                <span className="prop-value">{summary.triangleCount}</span>
            </div>
            <p className="properties-units-hint">Quantities use SI prefixes in model units.</p>
        </div>
    );
}

const TABLE_COLUMNS: ReadonlyArray<{ readonly key: SolidSortKey; readonly label: string }> = [
    { key: 'solidId', label: 'Solid' },
    { key: 'label', label: 'Body label' },
    { key: 'volume', label: 'Volume' },
    { key: 'area', label: 'Area' },
    { key: 'faceCount', label: 'Faces' },
    { key: 'triangleCount', label: 'Tris' }
];

interface SolidTableProps {
    readonly rows: readonly SolidTableRow[];
    readonly sort: { readonly key: SolidSortKey; readonly descending: boolean };
    readonly onSort: (key: SolidSortKey) => void;
    readonly selectedSolid?: number;
    readonly onSelect: (solidId: number) => void;
}

function SolidTable(props: SolidTableProps): React.ReactElement {
    return (
        <div className="outline-table">
            <div className="outline-table-head">
                {TABLE_COLUMNS.map((column) => (
                    <button key={column.key} className="outline-table-th" onClick={() => props.onSort(column.key)}>
                        <span className="outline-table-th-label">{column.label}</span>
                        {props.sort.key === column.key && (
                            <i className={`codicon codicon-chevron-${props.sort.descending ? 'down' : 'up'}`} />
                        )}
                    </button>
                ))}
            </div>
            {props.rows.map((row) => (
                <div
                    key={row.solidId}
                    className={`outline-table-tr${props.selectedSolid === row.solidId ? ' selected' : ''}`}
                    onClick={() => props.onSelect(row.solidId)}
                >
                    <span className="outline-table-cell num">{row.solidId}</span>
                    <span className="outline-table-cell label" title={row.label}>
                        {row.label}
                    </span>
                    <span className="outline-table-cell num">{formatQuantity(row.summary?.properties?.volume, 'u³')}</span>
                    <span className="outline-table-cell num">{formatQuantity(row.summary?.properties?.area, 'u²')}</span>
                    <span className="outline-table-cell num">{row.summary ? row.summary.faceCount : MISSING_VALUE}</span>
                    <span className="outline-table-cell num">{row.summary ? row.summary.triangleCount : MISSING_VALUE}</span>
                </div>
            ))}
            {props.rows.length === 0 && <div className="outline-table-empty">No mesh data loaded for this model yet.</div>}
        </div>
    );
}

interface OutlineSectionProps {
    readonly title: string;
    readonly count: number;
    readonly collapsed: boolean;
    readonly onToggle: () => void;
    readonly children: React.ReactNode;
}

function OutlineSection(props: OutlineSectionProps): React.ReactElement {
    return (
        <div className="outline-section">
            <div className="category-header" onClick={props.onToggle}>
                <i className={`codicon codicon-chevron-${props.collapsed ? 'right' : 'down'}`} />
                <span>{props.title}</span>
                <span className="count-badge">{props.count}</span>
            </div>
            {!props.collapsed && <div className="outline-rows">{props.children}</div>}
        </div>
    );
}

interface OutlineRowProps {
    readonly row: OutlineRowData;
    readonly selected: boolean;
    readonly icon: string;
    readonly onSelect: (solidId: number) => void;
}

function OutlineRow(props: OutlineRowProps): React.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    const mapped = props.row.solidIndices.length > 0;

    // Keep the row in view when a viewport pick selects it.
    React.useEffect(() => {
        if (props.selected) {
            ref.current?.scrollIntoView({ block: 'nearest' });
        }
    }, [props.selected]);

    const className = `outline-row${props.selected ? ' selected' : ''}${mapped ? '' : ' unmapped'}`;
    const tooltipText = mapped
        ? `Solid${props.row.solidIndices.length > 1 ? 's' : ''} ${props.row.solidIndices.join(', ')}`
        : 'Selector not found in the built model';
    const tooltip = useTooltip(tooltipText, 'top');

    return (
        <>
            <div ref={ref} className={className} onClick={mapped ? () => props.onSelect(props.row.solidIndices[0]) : undefined}>
                <span className="outline-row-label">
                    <i className={`codicon ${props.icon} outline-row-icon`} />
                    <span className="outline-row-label-text" onMouseEnter={tooltip.onMouseEnter} onMouseLeave={tooltip.onMouseLeave}>
                        {props.row.label}
                    </span>
                </span>
                {props.row.tags?.map((tag) => (
                    <span key={tag} className="outline-tag">
                        {tag}
                    </span>
                ))}
                {props.row.detail && <span className="outline-row-detail">{props.row.detail}</span>}
                {!mapped && <span className="codicon codicon-warning outline-row-warning" />}
            </div>
            {tooltip.tooltipElement}
        </>
    );
}
