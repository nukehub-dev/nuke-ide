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
 * Single-sheet orthographic drawing widget (Wave D2, brief §4).
 *
 * 2D SVG rendering of a `.nuke-cad` document's drawing sheets (not three.js
 * — linework, not meshes): drag views on the sheet (5 mm snap,
 * alignment-locked projected views), create section/detail views from a
 * selected parent view, and place associative dimensions with "Pick in
 * viewport" (one/two model edges clicked in the 3D viewport, whose
 * fingerprint edge picker supplies the TopologyRef targets; the
 * backend-returned projected-edge → TopologyRef map stays a forward-compat
 * path only — HLR output carries no source identity by design). Dimension labels reuse the sketch dimension-label
 * patterns: a dragged label pins a session-scoped offset, otherwise labels
 * auto-deconflict.
 *
 * Dirty drawing state triggers `buildDrawing` (shared `NukeCadBackendService`
 * RPC → `python/geometry_service.py --from-drawing`), never a full geometry
 * rebuild.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import { NukeCadBackendService } from '../../../common/nuke-cad-protocol';
import { validateTopologyRef, type TopologyRef } from '../../../common/topology-refs';
import {
    appendDrawingDimensionTarget,
    cancelDrawingDimensionPick,
    drawingDimensionTargetsNeeded,
    getDrawingDimensionPickRequest,
    onDrawingDimensionEdgeHit,
    onDrawingDimensionPickRequest,
    requestDrawingDimensionPick
} from '../cad-viewport/edge-picker';
import {
    DRAWING_DEFAULT_LABEL_OFFSET,
    clampSheetPosition,
    layoutDrawingLabels,
    lockProjectedViewPosition,
    pointerToSheetMm,
    sectionLineEndpoints,
    sheetDimensions,
    sheetMmToSvg,
    snapDrawingPosition,
    type DrawingBuildResult,
    type DrawingDimensionKind,
    type DrawingSheet,
    type DrawingSheetSize,
    type DrawingViewOrientation,
    type DrawingViewOutput
} from '../../../common/cad-drawing';
import { CadDocumentStore } from '../../document/cad-document-store';
import { NukeEmptyState, NukeSelect, NukeToolbar, NukeToolbarGroup } from 'nuke-essentials/lib/theme/browser/components';
import './drawing-sheet.css';

type DrawingTool = 'select' | 'dimension';

const BASE_ORIENTATIONS: DrawingViewOrientation[] = ['front', 'top', 'right'];

@injectable()
export class DrawingSheetWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-drawing-widget';
    static readonly LABEL = 'Drawing Sheet';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    @inject(NukeCadBackendService)
    protected readonly backendService: NukeCadBackendService;

    private tool: DrawingTool = 'select';
    private dimensionKind: DrawingDimensionKind = 'distance';
    private activeSheetId: string | undefined;
    private selectedViewId: string | undefined;
    private buildResult: DrawingBuildResult | undefined;
    private building = false;
    private lastDrawingVersion = -1;
    /** Session-scoped pinned label offsets (sketch pattern: die with the session, opt out of auto-shift). */
    private readonly pinnedLabels = new Map<string, [number, number]>();
    private pendingTargets: TopologyRef[] = [];
    private pendingViewId: string | undefined;
    /** Live drag positions (committed to the store on pointer-up). */
    private readonly livePositions = new Map<string, [number, number]>();
    private dragViewId: string | undefined;
    private newSheetSize: DrawingSheetSize = 'A4';
    private svgRef: SVGSVGElement | null = null;
    /**
     * Tracks the first build: unknown until a Refresh succeeds (true) or
     * fails loudly (false). Auto-refresh on drawing edits fires only once
     * the backend has answered.
     */
    private drawingBackendReady: boolean | undefined;

    @postConstruct()
    protected init(): void {
        this.id = DrawingSheetWidget.ID;
        this.title.label = DrawingSheetWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-nuke-cad-section';
        this.addClass('nuke-cad-drawing-sheet');
        this.lastDrawingVersion = this.documentStore.drawingVersion;
        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.handleStoreChange())));
        // Viewport edge picks for the dimension tool arrive through the
        // `edge-picker` broker; both subscriptions die with this widget.
        this.toDispose.push(Disposable.create(onDrawingDimensionPickRequest(() => this.handleViewportPickRequestChanged())));
        this.toDispose.push(Disposable.create(onDrawingDimensionEdgeHit((ref) => this.handleViewportEdgeHit(ref))));
        this.handleStoreChange();
    }

    private handleStoreChange(): void {
        const version = this.documentStore.drawingVersion;
        const drawings = this.documentStore.document?.drawings ?? [];
        if (this.activeSheetId === undefined || !drawings.some((s) => s.id === this.activeSheetId)) {
            this.activeSheetId = drawings.length > 0 ? drawings[0].id : undefined;
            this.selectedViewId = undefined;
            this.pendingTargets = [];
            this.pendingViewId = undefined;
            // A sheet switch invalidates the in-progress viewport pick.
            cancelDrawingDimensionPick();
        }
        if (version !== this.lastDrawingVersion) {
            this.lastDrawingVersion = version;
            // Dirty drawing state triggers `buildDrawing`, never a full rebuild.
            // Auto-fire only once the backend has answered a probe (manual
            // Refresh probes it); otherwise Refresh reports on demand.
            if (this.drawingBackendReady === true && this.activeSheetId !== undefined) {
                void this.refreshDrawing();
            }
        }
        this.update();
    }

    private activeSheet(): DrawingSheet | undefined {
        return (this.documentStore.document?.drawings ?? []).find((s) => s.id === this.activeSheetId);
    }

    private async refreshDrawing(): Promise<void> {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        const scriptPath = this.documentStore.uri;
        if (scriptPath === undefined) {
            this.messageService.info('Save the .nuke-cad document before building the drawing sheet.');
            return;
        }
        this.building = true;
        this.update();
        try {
            const result = await this.backendService.buildDrawing({ scriptPath, sheetId: sheet.id });
            this.buildResult = result;
            this.drawingBackendReady = true;
            if (!result.success) {
                this.messageService.error(`Drawing build failed: ${result.error ?? 'unknown error'}`);
            } else if (result.warnings !== undefined && result.warnings.length > 0) {
                this.messageService.warn(`Drawing build warnings: ${result.warnings.join('; ')}`);
            }
        } catch (error) {
            this.drawingBackendReady = false;
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Drawing build failed (${message}). Sheet edits are saved in the document.`);
        } finally {
            this.building = false;
            this.update();
        }
    }

    private viewOutput(viewId: string): DrawingViewOutput | undefined {
        return this.buildResult?.views?.find((v) => v.id === viewId);
    }

    private createBaseSheet(orientation: DrawingViewOrientation): void {
        const sheetResult = this.documentStore.addSheet(this.newSheetSize);
        if (!sheetResult.success || sheetResult.value === undefined) {
            this.messageService.error(`Cannot create drawing sheet: ${sheetResult.error ?? 'unknown error'}`);
            return;
        }
        const sheetId = sheetResult.value;
        const { width, height } = sheetDimensions(this.newSheetSize);
        const viewResult = this.documentStore.addView(sheetId, {
            kind: 'base',
            orientation,
            scale: 1,
            position: [Math.round(width / 2), Math.round(height / 2)]
        });
        if (!viewResult.success) {
            this.messageService.error(`Cannot create base view: ${viewResult.error ?? 'unknown error'}`);
            return;
        }
        this.activeSheetId = sheetId;
        this.selectedViewId = viewResult.value;
        this.update();
    }

    private addDerivedView(kind: 'projected' | 'section' | 'detail'): void {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        const parent = sheet.views.find((v) => v.id === this.selectedViewId);
        if (parent === undefined) {
            this.messageService.info('Select a parent view on the sheet first.');
            return;
        }
        const orientation: DrawingViewOrientation =
            kind === 'projected' ? (parent.orientation === 'front' ? 'top' : 'right') : parent.orientation;
        const candidate: [number, number] = [parent.position[0] + 60, parent.position[1] + 40];
        const position = kind === 'projected' ? lockProjectedViewPosition(orientation, parent.position, candidate) : candidate;
        const result = this.documentStore.addView(sheet.id, {
            kind,
            orientation,
            scale: parent.scale,
            position,
            parentId: parent.id,
            ...(kind === 'section' ? { sectionAxis: 'x' as const, sectionFraction: 0.5 } : {}),
            ...(kind === 'detail' ? { detailCenter: [0, 0] as [number, number], detailRadius: 10 } : {})
        });
        if (!result.success) {
            this.messageService.error(`Cannot create ${kind} view: ${result.error ?? 'unknown error'}`);
        }
    }

    private toSheetMm(event: React.PointerEvent): [number, number] | undefined {
        const sheet = this.activeSheet();
        if (sheet === undefined || this.svgRef === null) {
            return undefined;
        }
        const { width, height } = sheetDimensions(sheet.size);
        const rect = this.svgRef.getBoundingClientRect();
        return pointerToSheetMm(event.clientX, event.clientY, rect, width, height);
    }

    private onViewPointerDown(event: React.PointerEvent, viewId: string): void {
        if (this.tool === 'dimension') {
            return;
        }
        const point = this.toSheetMm(event);
        if (point === undefined) {
            return;
        }
        event.stopPropagation();
        (event.target as Element).setPointerCapture?.(event.pointerId);
        this.selectedViewId = viewId;
        this.dragViewId = viewId;
        this.update();
    }

    private onViewPointerMove(event: React.PointerEvent, viewId: string): void {
        if (this.dragViewId !== viewId || this.tool === 'dimension') {
            return;
        }
        const sheet = this.activeSheet();
        const point = this.toSheetMm(event);
        if (sheet === undefined || point === undefined) {
            return;
        }
        const view = sheet.views.find((v) => v.id === viewId);
        if (view === undefined) {
            return;
        }
        let next: [number, number] = [snapDrawingPosition(point[0]), snapDrawingPosition(point[1])];
        if (view.kind !== 'base' && view.parentId !== undefined) {
            const parent = sheet.views.find((v) => v.id === view.parentId);
            if (parent !== undefined) {
                const parentLive = this.livePositions.get(parent.id) ?? parent.position;
                next = lockProjectedViewPosition(view.orientation, parentLive, next);
            }
        }
        const { width, height } = sheetDimensions(sheet.size);
        this.livePositions.set(viewId, clampSheetPosition(next, width, height));
        this.update();
    }

    private onViewPointerUp(viewId: string): void {
        if (this.dragViewId !== viewId) {
            return;
        }
        this.dragViewId = undefined;
        const live = this.livePositions.get(viewId);
        this.livePositions.delete(viewId);
        const sheet = this.activeSheet();
        if (sheet === undefined || live === undefined) {
            this.update();
            return;
        }
        const result = this.documentStore.updateViewPosition(sheet.id, viewId, live);
        if (!result.success) {
            this.messageService.error(`Cannot move view: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    private onEdgeClick(viewId: string, edgeId: string | undefined): void {
        if (this.tool !== 'dimension' || edgeId === undefined) {
            return;
        }
        const ref = this.buildResult?.edgeRefMap?.[edgeId];
        if (ref === undefined) {
            // Forward-compat path only: HLR output carries no source identity
            // by design, so projected edges normally resolve nothing here.
            // Pick the model edge in the 3D viewport instead ("Pick in
            // viewport" in the dimension toolbar).
            this.messageService.info(
                'This projected edge carries no model reference. Use "Pick in viewport" in the dimension toolbar to pick the model edge in 3D.'
            );
            return;
        }
        if (this.pendingViewId !== undefined && this.pendingViewId !== viewId) {
            this.pendingTargets = [];
        }
        this.pendingViewId = viewId;
        this.pendingTargets = [...this.pendingTargets, ref];
        const needed = this.dimensionKind === 'distance' ? 2 : 1;
        if (this.pendingTargets.length < needed) {
            this.messageService.info(`Edge recorded (${this.pendingTargets.length}/${needed}). Click another edge.`);
            this.update();
            return;
        }
        const sheet = this.activeSheet();
        if (sheet === undefined || this.pendingViewId === undefined) {
            this.pendingTargets = [];
            this.update();
            return;
        }
        const result = this.documentStore.addDimension(sheet.id, {
            kind: this.dimensionKind,
            targets: this.pendingTargets,
            viewId: this.pendingViewId,
            labelOffset: [...DRAWING_DEFAULT_LABEL_OFFSET] as [number, number]
        });
        this.pendingTargets = [];
        this.pendingViewId = undefined;
        if (!result.success) {
            this.messageService.error(`Cannot add dimension: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    /**
     * Dimension tool flow "Pick in viewport".
     *
     * The backend ships no projected-edge → TopologyRef map (HLR output
     * carries no source identity, by design), so the dimension tool reuses
     * the 3D viewport's edge picker instead: each clicked edge yields its
     * geometric fingerprint as a `TopologyRef` target. One edge commits a
     * radius/diameter dimension, two edges a distance; the existing
     * `buildDrawing` recompute supplies value/text/anchors/stale.
     */
    private viewportPickActive(): boolean {
        return getDrawingDimensionPickRequest() !== undefined;
    }

    private startViewportEdgePick(): void {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        if (this.selectedViewId === undefined || !sheet.views.some((v) => v.id === this.selectedViewId)) {
            this.messageService.info('Select a view on the sheet first, then pick its edges in the 3D viewport.');
            return;
        }
        this.tool = 'dimension';
        this.pendingViewId = this.selectedViewId;
        this.pendingTargets = [];
        requestDrawingDimensionPick({ kind: this.dimensionKind });
        const needed = drawingDimensionTargetsNeeded(this.dimensionKind);
        this.messageService.info(`Dimension ${this.dimensionKind}: click ${needed === 2 ? 'two edges' : 'an edge'} in the 3D viewport.`);
        this.update();
    }

    private cancelViewportEdgePick(): void {
        cancelDrawingDimensionPick();
        this.pendingTargets = [];
        this.pendingViewId = undefined;
        this.update();
    }

    /**
     * Broker callback: the viewport left pick mode (banner Cancel,
     * right-click, Escape). A commit cancels after clearing pending state,
     * so unconditionally dropping half-assembled targets is harmless there
     * and required for a real cancel.
     */
    private handleViewportPickRequestChanged(): void {
        if (getDrawingDimensionPickRequest() === undefined) {
            this.pendingTargets = [];
            this.pendingViewId = undefined;
        }
        this.update();
    }

    /**
     * Broker callback: one viewport edge pick. Guarded against invalid refs
     * and a stale owning view (the `resolveCurvePick` analogue for deleted
     * geometry); completion commits through the existing `addDimension`
     * store mutation.
     */
    private handleViewportEdgeHit(ref: TopologyRef): void {
        const request = getDrawingDimensionPickRequest();
        if (request === undefined || this.tool !== 'dimension') {
            return;
        }
        if (ref.kind !== 'edge' || validateTopologyRef(ref).valid !== true) {
            this.messageService.warn('The picked edge reference is invalid; pick another edge in the viewport.');
            return;
        }
        const sheet = this.activeSheet();
        if (sheet === undefined || this.pendingViewId === undefined) {
            this.pendingTargets = [];
            this.pendingViewId = undefined;
            cancelDrawingDimensionPick();
            this.update();
            return;
        }
        if (request.kind !== this.dimensionKind) {
            // The kind changed mid-pick: restart so both sides agree on the target count.
            this.pendingTargets = [];
            requestDrawingDimensionPick({ kind: this.dimensionKind });
            this.update();
            return;
        }
        const next = appendDrawingDimensionTarget(this.pendingTargets, ref, this.dimensionKind);
        this.pendingTargets = [...next.targets];
        if (!next.complete) {
            const needed = drawingDimensionTargetsNeeded(this.dimensionKind);
            this.messageService.info(`Edge recorded (${this.pendingTargets.length}/${needed}). Click another edge in the viewport.`);
            this.update();
            return;
        }
        const result = this.documentStore.addDimension(sheet.id, {
            kind: this.dimensionKind,
            targets: this.pendingTargets,
            viewId: this.pendingViewId,
            labelOffset: [...DRAWING_DEFAULT_LABEL_OFFSET] as [number, number]
        });
        this.pendingTargets = [];
        this.pendingViewId = undefined;
        cancelDrawingDimensionPick();
        if (!result.success) {
            this.messageService.error(`Cannot add dimension: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    private onLabelPointerDown(event: React.PointerEvent, dimensionId: string, fallback: [number, number]): void {
        const sheet = this.activeSheet();
        if (sheet === undefined || this.svgRef === null) {
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        const { width } = sheetDimensions(sheet.size);
        const rect = this.svgRef.getBoundingClientRect();
        const mmPerPx = rect.width > 0 ? width / rect.width : 1;
        const startClient: [number, number] = [event.clientX, event.clientY];
        const startOffset = this.pinnedLabels.get(dimensionId) ?? fallback;
        const move = (moveEvent: PointerEvent): void => {
            const dxMm = (moveEvent.clientX - startClient[0]) * mmPerPx;
            const dyMm = -(moveEvent.clientY - startClient[1]) * mmPerPx;
            this.pinnedLabels.set(dimensionId, [startOffset[0] + dxMm, startOffset[1] + dyMm]);
            this.update();
        };
        const up = (): void => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            this.update();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    protected render(): React.ReactNode {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return <NukeEmptyState title="No CAD document" message="Open a .nuke-cad document to create drawing sheets." />;
        }
        const drawings = doc.drawings ?? [];
        if (drawings.length === 0) {
            return (
                <div className="nuke-cad-drawing-empty">
                    <NukeEmptyState title="No drawing sheets" message="Create a sheet with a base view to start the drawing.">
                        <div className="nuke-cad-drawing-new-row">
                            <div>
                                Size
                                <NukeSelect
                                    ariaLabel="Size"
                                    value={this.newSheetSize}
                                    options={[
                                        { value: 'A4', label: 'A4 landscape' },
                                        { value: 'A3', label: 'A3 landscape' }
                                    ]}
                                    onChange={(value) => {
                                        this.newSheetSize = value as DrawingSheetSize;
                                        this.update();
                                    }}
                                />
                            </div>
                            {BASE_ORIENTATIONS.map((orientation) => (
                                <button
                                    key={orientation}
                                    className="theia-button secondary"
                                    onClick={() => this.createBaseSheet(orientation)}
                                >
                                    Base {orientation}
                                </button>
                            ))}
                        </div>
                    </NukeEmptyState>
                </div>
            );
        }
        const sheet = this.activeSheet() ?? drawings[0];
        return (
            <div className="nuke-cad-drawing-root">
                <NukeToolbar>
                    <NukeToolbarGroup label="Sheet">
                        <NukeSelect
                            ariaLabel="Drawing sheet"
                            value={sheet.id}
                            options={drawings.map((s) => ({ value: s.id, label: `${s.name} (${s.size})` }))}
                            onChange={(value) => {
                                this.activeSheetId = value;
                                this.selectedViewId = undefined;
                                this.pendingTargets = [];
                                this.pendingViewId = undefined;
                                this.buildResult = undefined;
                                // A sheet switch invalidates the in-progress viewport pick.
                                cancelDrawingDimensionPick();
                                this.update();
                            }}
                        />
                        <button
                            className="theia-button secondary"
                            title="Add a new sheet with a front base view"
                            onClick={() => this.createBaseSheet('front')}
                        >
                            New sheet
                        </button>
                    </NukeToolbarGroup>
                    <NukeToolbarGroup label="Tool">
                        <button
                            className={this.tool === 'select' ? 'theia-button' : 'theia-button secondary'}
                            title="Select and drag views"
                            onClick={() => {
                                this.tool = 'select';
                                // Leaving the dimension tool aborts an in-progress viewport pick.
                                cancelDrawingDimensionPick();
                                this.pendingTargets = [];
                                this.pendingViewId = undefined;
                                this.update();
                            }}
                        >
                            Select
                        </button>
                        <button
                            className={this.tool === 'dimension' ? 'theia-button' : 'theia-button secondary'}
                            title="Dimension tool: click one/two model edges in a view"
                            onClick={() => {
                                this.tool = 'dimension';
                                this.update();
                            }}
                        >
                            Dimension
                        </button>
                        <NukeSelect
                            ariaLabel="Dimension kind"
                            value={this.dimensionKind}
                            options={[
                                { value: 'distance', label: 'distance' },
                                { value: 'radius', label: 'radius' },
                                { value: 'diameter', label: 'diameter' }
                            ]}
                            onChange={(value) => {
                                this.dimensionKind = value as DrawingDimensionKind;
                                // A new kind needs a new target count: restart any in-progress viewport pick.
                                cancelDrawingDimensionPick();
                                this.pendingTargets = [];
                                this.update();
                            }}
                        />
                        {this.tool === 'dimension' && (
                            <button
                                className="theia-button secondary"
                                title="Pick model edges in the 3D viewport (fingerprint TopologyRefs: one edge for radius/diameter, two for distance)"
                                onClick={() => {
                                    if (this.viewportPickActive()) {
                                        this.cancelViewportEdgePick();
                                    } else {
                                        this.startViewportEdgePick();
                                    }
                                }}
                            >
                                {this.viewportPickActive() ? 'Cancel pick' : 'Pick in viewport'}
                            </button>
                        )}
                    </NukeToolbarGroup>
                    <NukeToolbarGroup label="View">
                        <button
                            className="theia-button secondary"
                            title="Add a projected view from the selected view"
                            onClick={() => this.addDerivedView('projected')}
                        >
                            Projected
                        </button>
                        <button
                            className="theia-button secondary"
                            title="Add a section view from the selected view"
                            onClick={() => this.addDerivedView('section')}
                        >
                            Section
                        </button>
                        <button
                            className="theia-button secondary"
                            title="Add a detail view from the selected view"
                            onClick={() => this.addDerivedView('detail')}
                        >
                            Detail
                        </button>
                        <button
                            className="theia-button secondary"
                            title="Rebuild drawing linework (buildDrawing, never a full rebuild)"
                            onClick={() => void this.refreshDrawing()}
                        >
                            {this.building ? 'Building…' : 'Refresh'}
                        </button>
                    </NukeToolbarGroup>
                </NukeToolbar>
                {this.drawingBackendReady === false && (
                    <div className="nuke-cad-drawing-notice">
                        Drawing buildDrawing RPC unreachable: sheet edits are saved in the document; the parent must reconcile the RPC
                        contract before linework refreshes.
                    </div>
                )}
                {this.tool === 'dimension' && (this.pendingTargets.length > 0 || this.viewportPickActive()) && (
                    <div className="nuke-cad-drawing-notice">
                        Dimension {this.dimensionKind}: {this.pendingTargets.length}/{drawingDimensionTargetsNeeded(this.dimensionKind)}{' '}
                        edges picked
                        {this.viewportPickActive() ? ' — click edges in the 3D viewport.' : '.'}
                        {this.viewportPickActive() && (
                            <button className="theia-button secondary" onClick={() => this.cancelViewportEdgePick()}>
                                Cancel pick
                            </button>
                        )}
                    </div>
                )}
                {this.renderSheetSvg(sheet)}
            </div>
        );
    }

    private renderSheetSvg(sheet: DrawingSheet): React.ReactNode {
        const { width, height } = sheetDimensions(sheet.size);
        return (
            <svg
                ref={(el) => {
                    this.svgRef = el;
                }}
                className="nuke-cad-drawing-svg"
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`Drawing sheet ${sheet.name}`}
            >
                <rect x={0} y={0} width={width} height={height} className="nuke-cad-drawing-paper" />
                {sheet.views.map((view) => this.renderView(view, height))}
                {this.renderDimensions(sheet, height)}
                <text x={8} y={height - 8} className="nuke-cad-drawing-title">
                    {sheet.name} — {sheet.size} landscape
                </text>
            </svg>
        );
    }

    /**
     * Render one view. D1 linework points are absolute sheet-mm (y-up from
     * bottom-left), so they map straight to SVG units; only the live drag
     * delta rides a group transform until the store commits the move.
     */
    private renderView(view: DrawingSheet['views'][number], sheetHeight: number): React.ReactNode {
        const live = this.livePositions.get(view.id) ?? view.position;
        const dx = live[0] - view.position[0];
        const dySvg = -(live[1] - view.position[1]);
        const output = this.viewOutput(view.id);
        const selected = this.selectedViewId === view.id;
        const polylines = output?.visible ?? [];
        const hidden = output?.hidden ?? [];
        const hatchLoops = output?.hatchLoops ?? [];
        const hasLinework = output !== undefined;
        const [cx, cy] = sheetMmToSvg(live[0], live[1], sheetHeight);
        const toPoints = (points: readonly (readonly [number, number])[]): string =>
            points
                .map(([px, py]) => {
                    const [sx, sy] = sheetMmToSvg(px, py, sheetHeight);
                    return `${sx},${sy}`;
                })
                .join(' ');
        return (
            <g
                key={view.id}
                className={`nuke-cad-drawing-view${selected ? ' selected' : ''}${this.tool === 'dimension' ? ' dimension-mode' : ''}`}
                onPointerDown={(e) => this.onViewPointerDown(e, view.id)}
                onPointerMove={(e) => this.onViewPointerMove(e, view.id)}
                onPointerUp={() => this.onViewPointerUp(view.id)}
            >
                {!hasLinework && (
                    <g>
                        <rect x={cx - 30} y={cy - 20} width={60} height={40} className="nuke-cad-drawing-placeholder" />
                        <text x={cx} y={cy + 4} textAnchor="middle" className="nuke-cad-drawing-placeholder-text">
                            {view.kind} {view.orientation}
                        </text>
                    </g>
                )}
                <g transform={dx !== 0 || dySvg !== 0 ? `translate(${dx} ${dySvg})` : undefined}>
                    {polylines.map((line, i) => (
                        <polyline
                            key={`v-${i}`}
                            points={toPoints(line.points)}
                            className="nuke-cad-drawing-visible"
                            data-edge-id={line.edgeId}
                            data-view-id={view.id}
                            onClick={(e) => {
                                e.stopPropagation();
                                this.onEdgeClick(view.id, line.edgeId);
                            }}
                        />
                    ))}
                    {polylines.map((line, i) =>
                        line.circle !== undefined ? (
                            <circle
                                key={`c-${i}`}
                                cx={sheetMmToSvg(line.circle.center[0], line.circle.center[1], sheetHeight)[0]}
                                cy={sheetMmToSvg(line.circle.center[0], line.circle.center[1], sheetHeight)[1]}
                                r={line.circle.radius}
                                className="nuke-cad-drawing-visible"
                            />
                        ) : null
                    )}
                    {hidden.map((line, i) => (
                        <polyline key={`h-${i}`} points={toPoints(line.points)} className="nuke-cad-drawing-hidden" />
                    ))}
                    {hatchLoops.map((loop, i) => (
                        <polygon key={`s-${i}`} points={toPoints(loop.loop)} className="nuke-cad-drawing-hatch" />
                    ))}
                    {view.kind === 'section' && this.renderSectionMarker(view, live, sheetHeight)}
                    {view.kind === 'detail' && view.detailRadius !== undefined && (
                        <circle cx={cx} cy={cy} r={view.detailRadius * view.scale} className="nuke-cad-drawing-detail" />
                    )}
                </g>
                <text x={cx - 34} y={cy - 24} className="nuke-cad-drawing-view-tag">
                    {view.kind} {view.orientation} {view.scale}:1
                </text>
            </g>
        );
    }

    private renderSectionMarker(
        view: DrawingSheet['views'][number],
        live: readonly [number, number],
        sheetHeight: number
    ): React.ReactNode {
        const axis = view.sectionAxis ?? 'x';
        const flip = view.sectionFlip === true ? -1 : 1;
        const halfLength = 30;
        const [[x1, y1], [x2, y2]] = sectionLineEndpoints(live, halfLength, axis);
        // Mapped to SVG units (y-down) for rendering.
        const [sx1, sy1] = sheetMmToSvg(x1, y1, sheetHeight);
        const [sx2, sy2] = sheetMmToSvg(x2, y2, sheetHeight);
        return (
            <g className="nuke-cad-drawing-section">
                <line x1={sx1} y1={sy1} x2={sx2} y2={sy2} className="nuke-cad-drawing-section-line" />
                <polygon points={arrowHead(sx2, sy2, axis, flip)} className="nuke-cad-drawing-section-arrow" />
                <polygon points={arrowHead(sx1, sy1, axis, -flip)} className="nuke-cad-drawing-section-arrow" />
            </g>
        );
    }

    /**
     * Render dimensions from the D1 build output: `text` is the recomputed
     * value (last-good text when `stale`), `anchors` are the projected 2D
     * extension points in absolute sheet-mm. Without build output the label
     * falls back to the stored value above the owning view.
     */
    private renderDimensions(sheet: DrawingSheet, sheetHeight: number): React.ReactNode {
        const auto: { id: string; x: number; y: number; width: number; height: number }[] = [];
        const bases = new Map<string, [number, number]>();
        for (const dimension of sheet.dimensions) {
            const output = this.buildResult?.dimensions?.find((d) => d.id === dimension.id);
            const anchors = output?.anchors ?? [];
            let base: [number, number] | undefined;
            if (anchors.length > 0 && anchors[0].length === 2) {
                base = [anchors[0][0], anchors[0][1]];
            } else {
                const view = sheet.views.find((v) => v.id === dimension.viewId);
                if (view === undefined) {
                    continue;
                }
                const live = this.livePositions.get(view.id) ?? view.position;
                const offset = dimension.labelOffset ?? DRAWING_DEFAULT_LABEL_OFFSET;
                base = [live[0] + offset[0], live[1] + offset[1]];
            }
            bases.set(dimension.id, base);
            if (!this.pinnedLabels.has(dimension.id)) {
                auto.push({ id: dimension.id, x: base[0], y: base[1], width: 24, height: 8 });
            }
        }
        const { width, height } = sheetDimensions(sheet.size);
        const laidOut = layoutDrawingLabels(auto, width, height);
        return (
            <g className="nuke-cad-drawing-dimensions">
                {sheet.dimensions.map((dimension) => {
                    const base = bases.get(dimension.id);
                    if (base === undefined) {
                        return null;
                    }
                    const autoPos = laidOut.get(dimension.id);
                    const pinned = this.pinnedLabels.get(dimension.id);
                    const label: [number, number] = pinned ?? (autoPos !== undefined ? [autoPos.x, autoPos.y] : base);
                    const [ax, ay] = sheetMmToSvg(label[0], label[1], sheetHeight);
                    const output = this.buildResult?.dimensions?.find((d) => d.id === dimension.id);
                    const anchors = output?.anchors ?? [];
                    const stale = output?.stale ?? dimension.stale ?? false;
                    const stored =
                        dimension.value !== undefined ? `${dimension.kind} ${dimension.value.toFixed(2)}` : `${dimension.kind} ?`;
                    const text = `${output?.text ?? stored}${stale ? ' (stale)' : ''}`;
                    return (
                        <g key={dimension.id} className={`nuke-cad-drawing-dimension${stale ? ' stale' : ''}`}>
                            {anchors.length > 0
                                ? anchors.map((anchor, i) => {
                                      const [ex, ey] = sheetMmToSvg(anchor[0], anchor[1], sheetHeight);
                                      return <line key={i} x1={ex} y1={ey} x2={ax} y2={ay} className="nuke-cad-drawing-leader" />;
                                  })
                                : null}
                            <text
                                x={ax}
                                y={ay}
                                textAnchor="middle"
                                className="nuke-cad-drawing-dimension-text"
                                onPointerDown={(e) =>
                                    this.onLabelPointerDown(
                                        e,
                                        dimension.id,
                                        dimension.labelOffset ?? ([...DRAWING_DEFAULT_LABEL_OFFSET] as [number, number])
                                    )
                                }
                            >
                                {text}
                            </text>
                        </g>
                    );
                })}
            </g>
        );
    }
}

/** Small arrowhead polygon at (x, y) pointing along the section axis. */
function arrowHead(x: number, y: number, axis: 'x' | 'y' | 'z', direction: number): string {
    const size = 4;
    if (axis === 'x') {
        return `${x},${y} ${x - direction * size},${y - size / 2} ${x - direction * size},${y + size / 2}`;
    }
    return `${x},${y} ${x - size / 2},${y - direction * size} ${x + size / 2},${y - direction * size}`;
}
