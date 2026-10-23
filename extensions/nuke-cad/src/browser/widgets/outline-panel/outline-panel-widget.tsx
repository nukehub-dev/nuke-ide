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
 * the matching row here. The manifest list itself is read-only; the only
 * action on it is opening the manifest sidecar in the editor.
 *
 * Choice note (parameter spreadsheet): the document-parameter table lives
 * here as a Parameters section rather than a new right-shell view. The
 * outline already binds to the active model, closes with the viewport, and
 * reads the open `.nuke-cad` document for the fuse auto-fix — a section
 * reuses that lifecycle with no new command, view registration, or icon,
 * and keeps the spreadsheet next to the summaries it annotates.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { PreferenceScope } from '@theia/core';

import { RegionManifestData } from '../../../common/nuke-cad-protocol';
import { type DocumentUnits, type NukeCadDocument, type SavedNamedView } from '../../../common/cad-document';
import { clampDecimals, MAX_DECIMALS } from '../../../common/number-format';
import { NukeCadStateManager, CadModel, CadSelection, SolidSummary } from '../../state/nuke-cad-state-manager';
import {
    CadDocumentStore,
    uniqueFeatureId,
    collectParameterUsages,
    evaluateParameterInput,
    getAssemblySection,
    type AssemblySection,
    type ParameterUsage
} from '../../document/cad-document-store';
import { instanceSolidIds } from '../cad-viewport/assembly-view';
import { NukeCadCommands } from '../../commands';
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
import { buildFuseFeature, groupDiagnostics, selectionSolidIds, toggleSolidSelection } from './outline-interactions';
import { buildBomCsvRows, compareParamRows, describeParamUsage, formatBomCsv, type ParamSortKey } from './param-table';
import { NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './outline-panel.css';

/** World-origin axes with user-scoped display preferences. */
type OriginAxis = 'x' | 'y' | 'z';
const ORIGIN_AXIS_PREFERENCE_NAMES: Record<OriginAxis, 'nukeCad.showOriginX' | 'nukeCad.showOriginY' | 'nukeCad.showOriginZ'> = {
    x: 'nukeCad.showOriginX',
    y: 'nukeCad.showOriginY',
    z: 'nukeCad.showOriginZ'
};

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

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    private selection: CadSelection = {};
    private summaries: readonly SolidSummary[] = [];
    private hiddenSolidIds: readonly number[] = [];
    private manifestExists = false;
    /** Monotonically increasing token; stale manifest-existence probes are dropped. */
    private manifestCheckToken = 0;

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = CadOutlinePanelWidget.ID;
        this.title.label = CadOutlinePanelWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-nuke-cad-outline';

        this.selection = this.stateManager.selection;
        this.summaries = this.stateManager.solidSummaries;
        this.hiddenSolidIds = this.stateManager.hiddenSolidIds;
        this.toDispose.push(this.stateManager.onModelChange(() => this.handleModelChange()));
        // Parameter edits commit through the document store (validation + undo
        // + dirty effects unchanged); re-render so the table and used-by column
        // follow. Rebuild scheduling itself is untouched — the viewport observes
        // the same store-change signal and rebuilds per `nukeCad.rebuildOnEdit`.
        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.update())));
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
        this.toDispose.push(
            this.stateManager.onHiddenSolidsChange((ids) => {
                this.hiddenSolidIds = ids;
                this.update();
            })
        );
        // Display precision only changes rendered text: re-render the outline,
        // no document mutation or rebuild is involved. Origin-axis visibility
        // is the same kind of rendering-only user preference.
        this.toDispose.push(
            this.preferenceService.onPreferenceChanged((event) => {
                if (
                    event.preferenceName === 'nukeCad.lengthDecimals' ||
                    event.preferenceName === 'nukeCad.angleDecimals' ||
                    event.preferenceName === 'nukeCad.showOriginX' ||
                    event.preferenceName === 'nukeCad.showOriginY' ||
                    event.preferenceName === 'nukeCad.showOriginZ'
                ) {
                    this.update();
                }
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

    /**
     * Row/pick selection sync. A plain click selects one solid; Ctrl/Cmd-click
     * adds to (or removes from) the multi-selection.
     */
    private handleSelect(solidId: number, additive: boolean): void {
        this.selection = additive ? toggleSolidSelection(this.stateManager.selection, solidId, true) : { solidId };
        this.stateManager.setSelection(this.selection);
    }

    /**
     * Auto-fix one cross-body overlap warning: append a ``booleanFuse`` feature
     * merging ``bodyB`` into ``bodyA`` and rebuild the document.
     */
    protected async handleFuseBodies(bodyA: string, bodyB: string): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const feature = buildFuseFeature(doc, bodyA, bodyB, uniqueFeatureId(doc));
        if (feature === undefined) {
            this.messageService.error(`Cannot fuse '${bodyA}' and '${bodyB}': not both bodies of the open document.`);
            return;
        }
        const result = this.documentStore.addFeature(feature);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to add fuse feature.');
            return;
        }
        await this.commandService.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id);
    }

    protected render(): React.ReactNode {
        return (
            <CadOutlinePanelComponent
                model={this.stateManager.model}
                selection={this.selection}
                summaries={this.summaries}
                hiddenSolidIds={this.hiddenSolidIds}
                document={this.documentStore.document}
                assembly={this.documentStore.document !== undefined ? getAssemblySection(this.documentStore.document) : undefined}
                namedViews={this.documentStore.document?.views ?? []}
                manifestExists={this.manifestExists}
                manifestFileName={this.manifestFileName}
                onSelect={(solidId, additive) => this.handleSelect(solidId, additive)}
                onSelectInstance={(instanceId) => this.handleSelectInstance(instanceId)}
                onSetHiddenSolids={(ids) => this.stateManager.setHiddenSolidIds(ids)}
                onFuseBodies={(bodyA, bodyB) => void this.handleFuseBodies(bodyA, bodyB)}
                onOpenManifest={() => this.openManifest()}
                onAddParameter={(name, text) => this.handleAddParameter(name, text)}
                onSetParameter={(name, text) => this.handleSetParameter(name, text)}
                onRemoveParameter={(name) => this.handleRemoveParameter(name)}
                onSetUnits={(units) => this.handleSetUnits(units)}
                lengthDecimals={this.readDisplayDecimals('nukeCad.lengthDecimals', 2)}
                angleDecimals={this.readDisplayDecimals('nukeCad.angleDecimals', 1)}
                showOriginX={this.readOriginAxisVisible('x')}
                showOriginY={this.readOriginAxisVisible('y')}
                showOriginZ={this.readOriginAxisVisible('z')}
                onSetLengthDecimals={(decimals) => this.handleSetLengthDecimals(decimals)}
                onSetAngleDecimals={(decimals) => this.handleSetAngleDecimals(decimals)}
                onToggleOriginAxis={(axis) => this.handleToggleOriginAxis(axis)}
                onExportBomCsv={() => void this.handleExportBomCsv()}
                onSaveNamedView={() => void this.commandService.executeCommand(NukeCadCommands.SAVE_NAMED_VIEW.id)}
                onRestoreNamedView={(id) => void this.commandService.executeCommand(NukeCadCommands.RESTORE_NAMED_VIEW.id, id)}
                onDeleteNamedView={(id) => void this.commandService.executeCommand(NukeCadCommands.DELETE_NAMED_VIEW.id, id)}
            />
        );
    }

    /**
     * Spreadsheet edit path: evaluate the input text through `expression.ts`
     * (validator reasons surface inline, never commit), then write the number
     * through the normal store mutation. Shared by add and edit.
     */
    protected evaluateParamInput(name: string, text: string): { value?: number; error?: string } {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return { error: 'No CAD document is open.' };
        }
        const evaluated = evaluateParameterInput(text, doc.parameters, doc.units);
        if (!evaluated.ok) {
            return { error: evaluated.error };
        }
        return { value: evaluated.value };
    }

    protected handleAddParameter(name: string, text: string): { success: boolean; error?: string } {
        const evaluated = this.evaluateParamInput(name, text);
        if (evaluated.error !== undefined || evaluated.value === undefined) {
            return { success: false, error: evaluated.error ?? 'Invalid value.' };
        }
        const result = this.documentStore.addParameter(name.trim(), evaluated.value);
        return result.success ? { success: true } : { success: false, error: result.error };
    }

    protected handleSetParameter(name: string, text: string): { success: boolean; error?: string } {
        const evaluated = this.evaluateParamInput(name, text);
        if (evaluated.error !== undefined || evaluated.value === undefined) {
            return { success: false, error: evaluated.error ?? 'Invalid value.' };
        }
        const result = this.documentStore.setParameter(name, evaluated.value);
        return result.success ? { success: true } : { success: false, error: result.error };
    }

    protected handleRemoveParameter(name: string): { success: boolean; error?: string } {
        const result = this.documentStore.removeParameter(name);
        return result.success ? { success: true } : { success: false, error: result.error };
    }

    /**
     * Declared document units from the outline's Document Settings section.
     * The store owns the mutation semantics (tagging only, never rescaling)
     * and rebuild scheduling; the outline only surfaces failures.
     */
    protected handleSetUnits(units: DocumentUnits | undefined): void {
        const result = this.documentStore.setUnits(units);
        if (!result.success) {
            this.messageService.error(result.error || 'Could not set document units.');
        }
    }

    /**
     * Display precision is a user preference, not document state: the outline
     * writes through `PreferenceService` so the viewport measure labels react
     * to the same setting.
     */
    protected handleSetLengthDecimals(decimals: number): void {
        this.setDisplayDecimals('nukeCad.lengthDecimals', decimals);
    }

    protected handleSetAngleDecimals(decimals: number): void {
        this.setDisplayDecimals('nukeCad.angleDecimals', decimals);
    }

    private setDisplayDecimals(name: 'nukeCad.lengthDecimals' | 'nukeCad.angleDecimals', decimals: number): void {
        void this.preferenceService.set(name, clampDecimals(decimals), PreferenceScope.User);
    }

    private readDisplayDecimals(name: 'nukeCad.lengthDecimals' | 'nukeCad.angleDecimals', fallback: number): number {
        return clampDecimals(this.preferenceService.get<number>(name, fallback));
    }

    /**
     * Origin-axis toggles are user preferences, not document state: the
     * viewport observes the same keys and updates axis visibility in place.
     */
    protected handleToggleOriginAxis(axis: OriginAxis): void {
        const name = ORIGIN_AXIS_PREFERENCE_NAMES[axis];
        const visible = this.readOriginAxisVisible(axis);
        void this.preferenceService.set(name, !visible, PreferenceScope.User);
    }

    private readOriginAxisVisible(axis: OriginAxis): boolean {
        return this.preferenceService.get<boolean>(ORIGIN_AXIS_PREFERENCE_NAMES[axis], true);
    }

    /**
     * BOM CSV export (spreadsheet export, not a spreadsheet object): one
     * `{instance/body, label, material, volume}` row per built solid from the
     * `SolidSummary` data already in the state manager, joined with manifest
     * labels/materials. Saved through the file dialog like Export Python.
     */
    protected async handleExportBomCsv(): Promise<void> {
        const model = this.stateManager.model;
        if (model === undefined) {
            this.messageService.warn('No CAD model is open.');
            return;
        }
        const docMaterials = new Map<string, string>();
        for (const body of this.documentStore.document?.bodies ?? []) {
            if (body.label !== undefined && body.material !== undefined) {
                docMaterials.set(body.label, body.material);
            }
        }
        const source =
            model.manifest !== undefined ? { volumes: model.manifest.volumes, selectorMap: model.result.selectorMap ?? {} } : undefined;
        const csv = formatBomCsv(buildBomCsvRows(source, this.stateManager.solidSummaries, docMaterials));
        const uri = await this.fileDialogService.showSaveDialog({ title: 'Export BOM as CSV', filters: { 'CSV File': ['csv'] } });
        if (uri === undefined) {
            return;
        }
        try {
            await this.fileService.write(uri, csv);
            this.messageService.info(`Exported BOM to ${uri.path.base}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Could not export BOM: ${message}`);
        }
    }

    /**
     * ASSEMBLIES row click: select the instance's solids in the viewport via
     * the shared state manager (B1 `<instanceId>/…` selector keys; a no-op
     * until those land).
     */
    private handleSelectInstance(instanceId: string): void {
        const solids = instanceSolidIds(this.stateManager.model?.result.selectorMap, instanceId);
        if (solids.length === 0) {
            return;
        }
        this.selection = { solidId: solids[0], solidIds: solids };
        this.stateManager.setSelection(this.selection);
    }
}

interface OutlineRowData {
    readonly key: string;
    readonly label: string;
    readonly detail?: string;
    readonly tags?: readonly string[];
    /**
     * In-CAD body material tag for the row's selector (read-only display only;
     * the panel never edits it). Shown only while it differs from the exported
     * manifest `detail`, i.e. before the next DAGMC export picks it up.
     */
    readonly docMaterial?: string;
    /** 1-based solid indices the row maps to via the build-time selector map; empty when unmapped. */
    readonly solidIndices: readonly number[];
}

function buildVolumeRows(model: CadModel, docMaterials?: ReadonlyMap<string, string>): OutlineRowData[] {
    const selectorMap = model.result.selectorMap ?? {};
    const manifest = model.manifest;
    if (manifest) {
        return manifest.volumes.map((volume) => ({
            key: `volume:${volume.selector}`,
            label: volume.name ?? volume.selector,
            detail: volume.material,
            tags: volume.tags,
            docMaterial: docMaterials?.get(volume.selector),
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
    readonly hiddenSolidIds: readonly number[];
    /** Open `.nuke-cad` document, when the model was built from one (enables the fuse auto-fix). */
    readonly document?: NukeCadDocument;
    /** Saved named views from the open document (display-only camera poses). */
    readonly namedViews: readonly SavedNamedView[];
    /** Assembly section through the B1-optional channel (absent = single-part). */
    readonly assembly?: AssemblySection;
    readonly manifestExists: boolean;
    readonly manifestFileName: string;
    readonly onSelect: (solidId: number, additive: boolean) => void;
    readonly onSelectInstance: (instanceId: string) => void;
    readonly onSetHiddenSolids: (ids: readonly number[]) => void;
    readonly onFuseBodies: (bodyA: string, bodyB: string) => void;
    readonly onOpenManifest: () => void;
    /** Spreadsheet mutations; each returns the inline reason on failure (never commits invalid input). */
    readonly onAddParameter: (name: string, text: string) => { success: boolean; error?: string };
    readonly onSetParameter: (name: string, text: string) => { success: boolean; error?: string };
    readonly onRemoveParameter: (name: string) => { success: boolean; error?: string };
    /** Declared document units from the Document Settings section (`undefined` clears to unitless). */
    readonly onSetUnits: (units: DocumentUnits | undefined) => void;
    /** Display precision for property readouts (maximum decimal places). */
    readonly lengthDecimals: number;
    readonly angleDecimals: number;
    readonly onSetLengthDecimals: (decimals: number) => void;
    readonly onSetAngleDecimals: (decimals: number) => void;
    /** World-origin axis visibility (display-only user preferences). */
    readonly showOriginX: boolean;
    readonly showOriginY: boolean;
    readonly showOriginZ: boolean;
    readonly onToggleOriginAxis: (axis: OriginAxis) => void;
    readonly onExportBomCsv: () => void;
    /** Named Views: save the current camera, restore a row, or delete it by id. */
    readonly onSaveNamedView: () => void;
    readonly onRestoreNamedView: (id: string) => void;
    readonly onDeleteNamedView: (id: string) => void;
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
    // In-CAD material tags by body label (read-only here; edited in the Feature Tree).
    const docMaterials = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const body of props.document?.bodies ?? []) {
            if (body.label !== undefined && body.material !== undefined) {
                map.set(body.label, body.material);
            }
        }
        return map;
    }, [props.document]);
    const volumeRows = model ? buildVolumeRows(model, docMaterials) : [];
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
    // Prefer authored document bodies; script/STEP models expose only solid count.
    const bodyCount = props.document?.bodies.length ?? model?.result.solidCount ?? 0;
    const bodyCountLabel = `${bodyCount} ${bodyCount === 1 ? 'body' : 'bodies'}`;
    const warnings = model?.result.warnings ?? [];
    // DAGMC failures (e.g. seal fail-fast, sense errors) are non-fatal to the
    // build but must never be silent: surface dagmcError alongside warnings.
    const dagmcError = model?.result.dagmcError;
    const diagnosticWarnings = dagmcError !== undefined && dagmcError !== null ? [...warnings, dagmcError] : warnings;
    const diagnosticGroups = groupDiagnostics(diagnosticWarnings);
    const hiddenIds = props.hiddenSolidIds;

    /** Every solid id the rows map to; the pool the isolate action hides from. */
    const allMappedSolidIds = React.useMemo(() => {
        const ids = new Set<number>();
        for (const row of [...volumeRows, ...surfaceRows]) {
            for (const solidIndex of row.solidIndices) {
                ids.add(solidIndex);
            }
        }
        return [...ids];
    }, [volumeRows, surfaceRows]);

    const setRowHidden = (row: OutlineRowData, hidden: boolean): void => {
        const hiddenSet = new Set(hiddenIds);
        for (const solidIndex of row.solidIndices) {
            if (hidden) {
                hiddenSet.add(solidIndex);
            } else {
                hiddenSet.delete(solidIndex);
            }
        }
        props.onSetHiddenSolids([...hiddenSet]);
    };

    const isolateRow = (row: OutlineRowData): void => {
        const keep = new Set(row.solidIndices);
        props.onSetHiddenSolids(allMappedSolidIds.filter((id) => !keep.has(id)));
    };

    const hideInstanceSolids = (instanceId: string, hidden: boolean): void => {
        const solids = instanceSolidIds(selectorMap, instanceId);
        const hiddenSet = new Set(hiddenIds);
        for (const solid of solids) {
            if (hidden) {
                hiddenSet.add(solid);
            } else {
                hiddenSet.delete(solid);
            }
        }
        props.onSetHiddenSolids([...hiddenSet]);
    };

    const isolateInstance = (instanceId: string): void => {
        const keep = new Set(instanceSolidIds(selectorMap, instanceId));
        props.onSetHiddenSolids(allMappedSolidIds.filter((id) => !keep.has(id)));
    };

    const showAllSolids = (): void => {
        props.onSetHiddenSolids([]);
    };

    const isRowHidden = (row: OutlineRowData): boolean =>
        row.solidIndices.length > 0 && row.solidIndices.every((id) => hiddenIds.includes(id));

    return (
        <div className="cad-outline-panel">
            <div className="cad-outline-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-nuke-cad-outline" />
                        Model Outline
                        <span className="cad-outline-body-count">{bodyCountLabel}</span>
                    </h2>
                    <p className="header-description">{scriptName ?? 'No CAD model open'}</p>
                </div>
                {model && (
                    <div className="header-actions">
                        {hiddenIds.length > 0 && (
                            <Tooltip content={`Show all solids (${hiddenIds.length} hidden)`} position="left">
                                <button className="theia-button secondary view-toggle-button" onClick={showAllSolids}>
                                    <i className="codicon codicon-eye" />
                                </button>
                            </Tooltip>
                        )}
                        <Tooltip content={viewMode === 'list' ? 'Show as spreadsheet table' : 'Show as list'} position="left">
                            <button
                                className="theia-button secondary view-toggle-button"
                                onClick={() => setViewMode(viewMode === 'list' ? 'table' : 'list')}
                            >
                                <i className={`codicon ${viewMode === 'list' ? 'codicon-table' : 'codicon-list-tree'}`} />
                            </button>
                        </Tooltip>
                        <Tooltip content="Export bill of materials as CSV (instance/body, label, material, volume)" position="left">
                            <button className="theia-button secondary manifest-button" onClick={props.onExportBomCsv}>
                                <i className="codicon codicon-export" />
                                BOM
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
                    {diagnosticGroups.length > 0 && (
                        <div className="cad-outline-warning-box">
                            <i className="codicon codicon-warning" />
                            <div className="warning-content">
                                <strong>Build warnings</strong>
                                {diagnosticGroups.map((group) => (
                                    <React.Fragment key={group.code}>
                                        <p className="warning-line">
                                            <strong>{`${group.title} (${group.items.length})`}</strong>
                                        </p>
                                        {group.items.map((item, index) => {
                                            const pair = item.overlap;
                                            const fixable =
                                                pair !== undefined &&
                                                props.document !== undefined &&
                                                buildFuseFeature(props.document, pair.bodyA, pair.bodyB, 'outline-fuse-probe') !==
                                                    undefined;
                                            return (
                                                <p key={index} className="warning-line">
                                                    <span>{item.text}</span>
                                                    {fixable && pair !== undefined && (
                                                        <Tooltip
                                                            content={`Add a booleanFuse feature merging '${pair.bodyB}' into '${pair.bodyA}' and rebuild`}
                                                            position="left"
                                                        >
                                                            <button
                                                                className="theia-button secondary warning-fix-button"
                                                                onClick={() => props.onFuseBodies(pair.bodyA, pair.bodyB)}
                                                            >
                                                                <i className="codicon codicon-nuke-cad-boolean-fuse" />
                                                                Fuse
                                                            </button>
                                                        </Tooltip>
                                                    )}
                                                </p>
                                            );
                                        })}
                                        {group.hint !== '' && (
                                            <p className="warning-line">
                                                <span>{`Hint: ${group.hint}`}</span>
                                            </p>
                                        )}
                                    </React.Fragment>
                                ))}
                            </div>
                        </div>
                    )}

                    {!model.manifest && (
                        <div className="cad-outline-hint">
                            No region manifest (<code>{props.manifestFileName}</code>) for this model; showing positional solids.
                        </div>
                    )}

                    {props.document !== undefined && (
                        <DocumentSettingsSection
                            document={props.document}
                            source={scriptName}
                            onSetUnits={props.onSetUnits}
                            lengthDecimals={props.lengthDecimals}
                            angleDecimals={props.angleDecimals}
                            onSetLengthDecimals={props.onSetLengthDecimals}
                            onSetAngleDecimals={props.onSetAngleDecimals}
                        />
                    )}

                    <OriginSection
                        showX={props.showOriginX}
                        showY={props.showOriginY}
                        showZ={props.showOriginZ}
                        onToggle={props.onToggleOriginAxis}
                    />

                    {props.document !== undefined && (
                        <NamedViewsSection
                            views={props.namedViews}
                            onSave={props.onSaveNamedView}
                            onRestore={props.onRestoreNamedView}
                            onDelete={props.onDeleteNamedView}
                        />
                    )}

                    {props.document !== undefined && (
                        <ParametersSection
                            document={props.document}
                            onAddParameter={props.onAddParameter}
                            onSetParameter={props.onSetParameter}
                            onRemoveParameter={props.onRemoveParameter}
                        />
                    )}

                    {displayEntry && (
                        <PropertiesSection
                            entry={displayEntry}
                            pinned={pinnedEntry !== undefined}
                            onTogglePin={handleTogglePin}
                            lengthDecimals={props.lengthDecimals}
                        />
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
                                        selected={selectionSolidIds(props.selection).some((id) => row.solidIndices.includes(id))}
                                        hidden={isRowHidden(row)}
                                        icon="codicon-nuke-cad-cube"
                                        onSelect={props.onSelect}
                                        onToggleHidden={() => setRowHidden(row, !isRowHidden(row))}
                                        onIsolate={() => isolateRow(row)}
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
                                            selected={selectionSolidIds(props.selection).some((id) => row.solidIndices.includes(id))}
                                            hidden={isRowHidden(row)}
                                            icon="codicon-nuke-cad-datum"
                                            onSelect={props.onSelect}
                                            onToggleHidden={() => setRowHidden(row, !isRowHidden(row))}
                                            onIsolate={() => isolateRow(row)}
                                        />
                                    ))}
                                </OutlineSection>
                            )}

                            {props.assembly !== undefined && props.assembly.instances.length > 0 && (
                                <AssembliesSection
                                    assembly={props.assembly}
                                    selectorMap={selectorMap}
                                    selection={props.selection}
                                    hiddenSolidIds={hiddenIds}
                                    onSelectInstance={props.onSelectInstance}
                                    onToggleHidden={hideInstanceSolids}
                                    onIsolate={isolateInstance}
                                />
                            )}
                        </>
                    ) : (
                        <SolidTable
                            rows={tableRows}
                            sort={sort}
                            onSort={handleSort}
                            selectedSolids={selectionSolidIds(props.selection)}
                            onSelect={props.onSelect}
                            lengthDecimals={props.lengthDecimals}
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
    /** Maximum decimal places for length-derived readouts. */
    readonly lengthDecimals: number;
}

function PropertiesSection(props: PropertiesSectionProps): React.ReactElement {
    const summary = props.entry.summary;
    const properties = summary.properties;
    const size = bboxSize(properties);
    const decimals = props.lengthDecimals;

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
                <span className="prop-value">{formatQuantity(properties?.volume, 'u³', decimals)}</span>
                <span className="prop-label">Area</span>
                <span className="prop-value">{formatQuantity(properties?.area, 'u²', decimals)}</span>
                <span className="prop-label">Size dx × dy × dz</span>
                <span className="prop-value">
                    {size
                        ? `${formatSi(size[0], decimals)} × ${formatSi(size[1], decimals)} × ${formatSi(size[2], decimals)} u`
                        : MISSING_VALUE}
                </span>
                <span className="prop-label">Center of mass</span>
                <span className="prop-value">{formatVec3(properties?.centerOfMass, 'u', decimals)}</span>
                <span className="prop-label">Faces</span>
                <span className="prop-value">{summary.faceCount}</span>
                <span className="prop-label">Edges</span>
                <span className="prop-value">{summary.edgeCount}</span>
                <span className="prop-label">Triangles</span>
                <span className="prop-value">{summary.triangleCount}</span>
            </div>
            <p className="properties-units-hint">Quantities use SI prefixes in model units at the Document Settings precision.</p>
        </div>
    );
}

const UNIT_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
    { value: '', label: 'Unitless' },
    { value: 'mm', label: 'mm' },
    { value: 'cm', label: 'cm' },
    { value: 'm', label: 'm' }
];

interface DocumentSettingsSectionProps {
    readonly document: NukeCadDocument;
    /** Active model file name; absent for in-memory documents. */
    readonly source?: string;
    readonly onSetUnits: (units: DocumentUnits | undefined) => void;
    /** Display precision preferences (maximum decimal places). */
    readonly lengthDecimals: number;
    readonly angleDecimals: number;
    readonly onSetLengthDecimals: (decimals: number) => void;
    readonly onSetAngleDecimals: (decimals: number) => void;
}

interface PrecisionInputProps {
    readonly ariaLabel: string;
    readonly value: number;
    readonly onChange: (value: number) => void;
}

/** Compact 0–6 number input that only commits valid integer values. */
function PrecisionInput(props: PrecisionInputProps): React.ReactElement {
    const [text, setText] = React.useState(String(props.value));
    React.useEffect(() => setText(String(props.value)), [props.value]);
    return (
        <input
            className="document-settings-precision-input"
            type="number"
            min={0}
            max={MAX_DECIMALS}
            step={1}
            inputMode="numeric"
            aria-label={props.ariaLabel}
            value={text}
            onChange={(event) => {
                const next = event.target.value;
                setText(next);
                const parsed = Number.parseInt(next, 10);
                if (Number.isFinite(parsed)) {
                    props.onChange(clampDecimals(parsed));
                }
            }}
            onBlur={() => setText(String(props.value))}
        />
    );
}

/**
 * Compact, collapsible document summary above Named Views: declared units
 * (through the same `CadDocumentStore.setUnits` path as the toolbar), display
 * precision preferences, the parameter count, and read-only design properties.
 * Editing parameters/name/source stays in their dedicated sections.
 */
function DocumentSettingsSection(props: DocumentSettingsSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    const document = props.document;
    const source = props.source ?? 'In-memory document';

    return (
        <div className="outline-section document-settings-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <i className="codicon codicon-settings-gear" />
                <span>Document Settings</span>
            </div>
            {!collapsed && (
                <div className="document-settings-grid">
                    <div className="document-settings-row">
                        <span className="document-settings-label">Units</span>
                        <NukeSelect
                            className="document-settings-units"
                            ariaLabel="Document units"
                            value={document.units ?? ''}
                            options={UNIT_OPTIONS}
                            onChange={(value) => props.onSetUnits(value === '' ? undefined : (value as DocumentUnits))}
                        />
                    </div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Precision</span>
                        <div className="document-settings-precision" title="Maximum decimal places for length and angle readouts">
                            <label className="document-settings-precision-field">
                                <span title="Length readout decimal places">L</span>
                                <PrecisionInput
                                    ariaLabel="Length decimal places"
                                    value={props.lengthDecimals}
                                    onChange={props.onSetLengthDecimals}
                                />
                            </label>
                            <label className="document-settings-precision-field">
                                <span title="Angle readout decimal places">A</span>
                                <PrecisionInput
                                    ariaLabel="Angle decimal places"
                                    value={props.angleDecimals}
                                    onChange={props.onSetAngleDecimals}
                                />
                                <span>°</span>
                            </label>
                        </div>
                    </div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Parameters</span>
                        <span className="document-settings-value">{Object.keys(document.parameters).length}</span>
                    </div>
                    <div className="document-settings-subhead">Design Properties</div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Name</span>
                        <span className="document-settings-value" title={document.name}>
                            {document.name}
                        </span>
                    </div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Source</span>
                        <span className="document-settings-value" title={source}>
                            {source}
                        </span>
                    </div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Bodies</span>
                        <span className="document-settings-value">{document.bodies.length}</span>
                    </div>
                    <div className="document-settings-row">
                        <span className="document-settings-label">Schema</span>
                        <span className="document-settings-value">{`v${document.version}`}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

const ORIGIN_AXIS_ROWS: ReadonlyArray<{ readonly axis: OriginAxis; readonly label: string }> = [
    { axis: 'x', label: 'X' },
    { axis: 'y', label: 'Y' },
    { axis: 'z', label: 'Z' }
];

interface OriginSectionProps {
    readonly showX: boolean;
    readonly showY: boolean;
    readonly showZ: boolean;
    readonly onToggle: (axis: OriginAxis) => void;
}

/**
 * Origin section: per-axis world-origin visibility toggles. The viewport draws
 * the colored triad; these switches only hide/show individual axes and write
 * user-scoped preferences, so they never touch the document or rebuild geometry.
 */
function OriginSection(props: OriginSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    const visible: Record<OriginAxis, boolean> = { x: props.showX, y: props.showY, z: props.showZ };

    return (
        <div className="outline-section origin-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <i className="codicon codicon-nuke-cad-datum" />
                <span>Origin</span>
            </div>
            {!collapsed && (
                <div className="origin-axis-rows">
                    {ORIGIN_AXIS_ROWS.map(({ axis, label }) => {
                        const shown = visible[axis];
                        const action = shown ? 'Hide' : 'Show';
                        return (
                            <div key={axis} className={`origin-axis-row${shown ? '' : ' hidden'}`}>
                                <span className={`origin-axis-dot origin-axis-dot-${axis}`} />
                                <span className="origin-axis-label">{label}</span>
                                <Tooltip content={`${action} ${label} axis`} position="left">
                                    <button
                                        className="theia-button secondary origin-axis-toggle"
                                        aria-pressed={shown}
                                        aria-label={`${action} ${label} axis`}
                                        onClick={() => props.onToggle(axis)}
                                    >
                                        <i className={`codicon ${shown ? 'codicon-eye' : 'codicon-eye-closed'}`} />
                                    </button>
                                </Tooltip>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface NamedViewsSectionProps {
    readonly views: readonly SavedNamedView[];
    readonly onSave: () => void;
    readonly onRestore: (id: string) => void;
    readonly onDelete: (id: string) => void;
}

/**
 * Saved camera poses from the document's additive `views` block. The header's
 * add button runs `nuke.cad.saveNamedView` (quick-input prompt); row clicks
 * restore through the viewport widget and the trash button deletes through the
 * store. Display-only state: restoring never rebuilds geometry.
 */
function NamedViewsSection(props: NamedViewsSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);

    return (
        <div className="outline-section named-views-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <i className="codicon codicon-device-camera" />
                <span>Named Views</span>
                <Tooltip content="Save the current camera as a named view" position="left">
                    <button
                        className="theia-button secondary named-view-add"
                        aria-label="Save current view"
                        onClick={(event) => {
                            event.stopPropagation();
                            props.onSave();
                        }}
                    >
                        <i className="codicon codicon-add" />
                    </button>
                </Tooltip>
            </div>
            {!collapsed &&
                (props.views.length === 0 ? (
                    <p className="named-view-empty">No saved views yet — orbit, then Save current view.</p>
                ) : (
                    <div className="named-view-rows">
                        {props.views.map((view) => (
                            <div key={view.id} className="named-view-row">
                                <button
                                    className="named-view-restore"
                                    title={`Restore '${view.name}'`}
                                    onClick={() => props.onRestore(view.id)}
                                >
                                    <i className="codicon codicon-device-camera named-view-icon" />
                                    <span className="named-view-name">{view.name}</span>
                                </button>
                                <Tooltip content="Delete named view" position="left">
                                    <button
                                        className="theia-button secondary named-view-delete"
                                        aria-label={`Delete named view '${view.name}'`}
                                        onClick={() => props.onDelete(view.id)}
                                    >
                                        <i className="codicon codicon-trash" />
                                    </button>
                                </Tooltip>
                            </div>
                        ))}
                    </div>
                ))}
        </div>
    );
}

interface ParametersSectionProps {
    readonly document: NukeCadDocument;
    readonly onAddParameter: (name: string, text: string) => { success: boolean; error?: string };
    readonly onSetParameter: (name: string, text: string) => { success: boolean; error?: string };
    readonly onRemoveParameter: (name: string) => { success: boolean; error?: string };
}

const PARAM_COLUMNS: ReadonlyArray<{ readonly key: ParamSortKey; readonly label: string }> = [
    { key: 'name', label: 'Name' },
    { key: 'value', label: 'Value' },
    { key: 'usedBy', label: 'Used by' }
];

/**
 * Parameters spreadsheet section: sortable `{name, value, unit, used-by}`
 * rows over the open document, with edit-in-place through the store mutation
 * path and an add row. Values accept plain numbers or `expression.ts`
 * expressions over the other parameters; the validator reason renders inline
 * and invalid input never commits.
 */
function ParametersSection(props: ParametersSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    const [sort, setSort] = React.useState<{ key: ParamSortKey; descending: boolean }>({ key: 'name', descending: false });
    const [editingName, setEditingName] = React.useState<string | undefined>(undefined);
    const [editText, setEditText] = React.useState('');
    const [editError, setEditError] = React.useState<string | undefined>(undefined);
    const [newName, setNewName] = React.useState('');
    const [newText, setNewText] = React.useState('');
    const [formError, setFormError] = React.useState<string | undefined>(undefined);

    const usages: readonly ParameterUsage[] = React.useMemo(() => collectParameterUsages(props.document), [props.document]);
    const unit = props.document.units ?? '—';
    const rows = React.useMemo(() => [...usages].sort((a, b) => compareParamRows(a, b, sort.key, sort.descending)), [usages, sort]);

    const handleSort = (key: ParamSortKey): void => {
        setSort((previous) => ({ key, descending: previous.key === key ? !previous.descending : false }));
    };

    const beginEdit = (usage: ParameterUsage): void => {
        setEditingName(usage.name);
        setEditText(String(usage.value));
        setEditError(undefined);
        setFormError(undefined);
    };

    const cancelEdit = (): void => {
        setEditingName(undefined);
        setEditError(undefined);
    };

    // Theia's KeybindingRegistry handles keys in a document-capture listener and
    // calls stopPropagation() when a binding matches (Escape often has one), so
    // the editor's own onKeyDown never sees the key. Cancel one phase earlier,
    // the same way the CAD viewport handles Escape.
    React.useEffect(() => {
        if (editingName === undefined) {
            return undefined;
        }
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setEditingName(undefined);
            setEditError(undefined);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [editingName]);

    const commitEdit = (name: string): void => {
        const result = props.onSetParameter(name, editText);
        if (!result.success) {
            setEditError(result.error ?? 'Invalid value.');
            return;
        }
        setEditingName(undefined);
        setEditError(undefined);
    };

    const handleAdd = (): void => {
        const result = props.onAddParameter(newName, newText);
        if (!result.success) {
            setFormError(result.error ?? 'Invalid parameter.');
            return;
        }
        setNewName('');
        setNewText('');
        setFormError(undefined);
    };

    const handleRemove = (name: string): void => {
        const result = props.onRemoveParameter(name);
        if (!result.success) {
            setFormError(result.error ?? `Could not remove '${name}'.`);
            return;
        }
        setFormError(undefined);
        if (editingName === name) {
            cancelEdit();
        }
    };

    return (
        <div className="outline-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <i className="codicon codicon-symbol-variable" />
                <span>Parameters</span>
                <span className="count-badge">{usages.length}</span>
            </div>
            {!collapsed && (
                <div className="param-table">
                    <div className="param-table-head">
                        {PARAM_COLUMNS.map((column) => (
                            <button key={column.key} className="param-table-th" onClick={() => handleSort(column.key)}>
                                <span className="param-table-th-label">{column.label}</span>
                                {sort.key === column.key && <i className={`codicon codicon-chevron-${sort.descending ? 'down' : 'up'}`} />}
                            </button>
                        ))}
                        <span className="param-table-th unit">Unit</span>
                        <span className="param-table-th actions" />
                    </div>
                    {rows.map((row) => (
                        <div key={row.name} className="param-table-tr">
                            <span className="param-table-cell name" title={row.name}>
                                {row.name}
                            </span>
                            {editingName === row.name ? (
                                <span className="param-table-cell value editing">
                                    <input
                                        className="param-input"
                                        // eslint-disable-next-line jsx-a11y/no-autofocus
                                        autoFocus
                                        value={editText}
                                        onChange={(e) => setEditText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                commitEdit(row.name);
                                            } else if (e.key === 'Escape') {
                                                cancelEdit();
                                            }
                                        }}
                                    />
                                </span>
                            ) : (
                                <span
                                    className="param-table-cell value editable"
                                    title="Click to edit (numbers or expressions over the other parameters)"
                                    onClick={() => beginEdit(row)}
                                >
                                    {String(row.value)}
                                </span>
                            )}
                            <span className="param-table-cell used-by" title={describeParamUsage(row)}>
                                {row.usedBy.length === 0 ? '—' : `${row.usedBy.length} use${row.usedBy.length === 1 ? '' : 's'}`}
                            </span>
                            <span className="param-table-cell unit">{unit}</span>
                            <span className="param-table-cell actions">
                                <Tooltip content={`Delete parameter '${row.name}'`} position="left">
                                    <button
                                        className="theia-button secondary outline-row-action"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleRemove(row.name);
                                        }}
                                    >
                                        <span className="codicon codicon-close" />
                                    </button>
                                </Tooltip>
                            </span>
                        </div>
                    ))}
                    {rows.length === 0 && <div className="param-table-empty">No document parameters yet — add one below.</div>}
                    {editingName !== undefined && editError !== undefined && (
                        <div className="param-error" role="alert">
                            {editError}
                        </div>
                    )}
                    <div className="param-add-row">
                        <input
                            className="param-input"
                            placeholder="name"
                            aria-label="New parameter name"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                        />
                        <input
                            className="param-input"
                            placeholder="value or expression"
                            aria-label="New parameter value or expression"
                            value={newText}
                            onChange={(e) => setNewText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    handleAdd();
                                }
                            }}
                        />
                        <button className="theia-button secondary param-add-button" onClick={handleAdd}>
                            Add
                        </button>
                    </div>
                    {formError !== undefined && (
                        <div className="param-error" role="alert">
                            {formError}
                        </div>
                    )}
                    <p className="param-hint">Values rebuild per nukeCad.rebuildOnEdit; every edit is undo-covered.</p>
                </div>
            )}
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
    readonly selectedSolids: readonly number[];
    readonly onSelect: (solidId: number, additive: boolean) => void;
    /** Maximum decimal places for volume/area readouts. */
    readonly lengthDecimals: number;
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
                    className={`outline-table-tr${props.selectedSolids.includes(row.solidId) ? ' selected' : ''}`}
                    onClick={(e) => props.onSelect(row.solidId, e.ctrlKey || e.metaKey)}
                >
                    <span className="outline-table-cell num">{row.solidId}</span>
                    <span className="outline-table-cell label" title={row.label}>
                        {row.label}
                    </span>
                    <span className="outline-table-cell num">
                        {formatQuantity(row.summary?.properties?.volume, 'u³', props.lengthDecimals)}
                    </span>
                    <span className="outline-table-cell num">
                        {formatQuantity(row.summary?.properties?.area, 'u²', props.lengthDecimals)}
                    </span>
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

interface AssembliesSectionProps {
    readonly assembly: AssemblySection;
    readonly selectorMap: Record<string, number[]>;
    readonly selection: CadSelection;
    readonly hiddenSolidIds: readonly number[];
    readonly onSelectInstance: (instanceId: string) => void;
    readonly onToggleHidden: (instanceId: string, hidden: boolean) => void;
    readonly onIsolate: (instanceId: string) => void;
}

/**
 * ASSEMBLIES section: per-instance rows with the same hide/isolate/selection
 * sync as volume rows, keyed by instanceId (solids resolve through B1's
 * `<instanceId>/…` selector keys).
 */
function AssembliesSection(props: AssembliesSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    const selected = selectionSolidIds(props.selection);
    return (
        <div className="outline-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <span>Assemblies</span>
                <span className="count-badge">{props.assembly.instances.length}</span>
            </div>
            {!collapsed && (
                <div className="outline-rows">
                    {props.assembly.instances.map((instance) => {
                        const solids = instanceSolidIds(props.selectorMap, instance.id);
                        const mapped = solids.length > 0;
                        const grounded = props.assembly.groundedInstanceId === instance.id;
                        const isHidden = mapped && solids.every((id) => props.hiddenSolidIds.includes(id));
                        const isSelected = solids.some((id) => selected.includes(id));
                        const row: OutlineRowData = {
                            key: `instance:${instance.id}`,
                            label: grounded ? `${instance.id} (grounded)` : instance.id,
                            detail: instance.part,
                            solidIndices: solids
                        };
                        return (
                            <OutlineRow
                                key={row.key}
                                row={row}
                                selected={isSelected}
                                hidden={isHidden}
                                icon="codicon-nuke-cad-assembly"
                                onSelect={() => props.onSelectInstance(instance.id)}
                                onToggleHidden={() => props.onToggleHidden(instance.id, !isHidden)}
                                onIsolate={() => props.onIsolate(instance.id)}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface OutlineRowProps {
    readonly row: OutlineRowData;
    readonly selected: boolean;
    readonly hidden: boolean;
    readonly icon: string;
    readonly onSelect: (solidId: number, additive: boolean) => void;
    readonly onToggleHidden: () => void;
    readonly onIsolate: () => void;
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

    const className = `outline-row${props.selected ? ' selected' : ''}${props.hidden ? ' hidden' : ''}${mapped ? '' : ' unmapped'}`;
    const tooltipText = mapped
        ? `Solid${props.row.solidIndices.length > 1 ? 's' : ''} ${props.row.solidIndices.join(', ')} — click to select, Ctrl/Cmd-click to multi-select`
        : 'Selector not found in the built model';
    const tooltip = useTooltip(tooltipText, 'top');

    return (
        <>
            <div
                ref={ref}
                className={className}
                onClick={mapped ? (e) => props.onSelect(props.row.solidIndices[0], e.ctrlKey || e.metaKey) : undefined}
            >
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
                {props.row.docMaterial !== undefined && props.row.docMaterial !== props.row.detail && (
                    <span className="outline-tag" title="In-CAD material tag — exported on the next DAGMC build">
                        {props.row.docMaterial}
                    </span>
                )}
                {props.hidden && <span className="codicon codicon-eye-closed outline-row-hidden-indicator" />}
                {mapped && (
                    <span className="outline-row-actions">
                        <Tooltip content={props.hidden ? 'Show' : 'Hide'} position="left">
                            <button
                                className="theia-button secondary outline-row-action"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onToggleHidden();
                                }}
                            >
                                <span className={`codicon codicon-${props.hidden ? 'eye' : 'eye-closed'}`} />
                            </button>
                        </Tooltip>
                        <Tooltip content="Hide others (isolate)" position="left">
                            <button
                                className="theia-button secondary outline-row-action"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onIsolate();
                                }}
                            >
                                <span className="codicon codicon-filter" />
                            </button>
                        </Tooltip>
                    </span>
                )}
                {!mapped && <span className="codicon codicon-warning outline-row-warning" />}
            </div>
            {tooltip.tooltipElement}
        </>
    );
}
