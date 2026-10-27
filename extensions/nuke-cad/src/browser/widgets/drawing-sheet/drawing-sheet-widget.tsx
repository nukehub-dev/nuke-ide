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
 * Canvas navigation is cursor-anchored wheel zoom plus middle/Alt/Space-drag
 * panning (grab/grabbing cursors), with per-view and blank-paper context menus
 * (fit, hidden lines, scales, delete; sheet toggles and output) and a status
 * bar that reports the selected view's scale and naked linework extent.
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
import { URI } from '@theia/core/lib/common/uri';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Message } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
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
    formatDrawingScale,
    layoutDrawingLabels,
    lockProjectedViewPosition,
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
import { ensureNukeCadExtension } from '../cad-viewport/cad-save-path';
import { openContextMenu, type ContextMenuItem } from '../cad-viewport/viewport-context-menu';
import {
    buildDrawingSheetMenu,
    buildDrawingViewMenu,
    clampDrawingZoom,
    formatDrawingExtent,
    zoomDrawingAtPoint,
    type DrawingSheetMenuAction,
    type DrawingViewMenuAction
} from './drawing-sheet-interactions';
import {
    NukeCheckbox,
    NukeFormRow,
    NukeSection,
    NukeSelect,
    NukeToolbar,
    NukeToolbarGroup
} from 'nuke-essentials/lib/theme/browser/components';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './drawing-sheet.css';

type DrawingTool = 'select' | 'dimension';

/** Standard drafting scales (view multiplier; 0.5 = 1:2, 100 = 100:1). */
const DRAWING_SCALE_PRESETS: readonly number[] = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000
];

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

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

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
    /** Newly created base view to fit once its first projection lands. */
    private pendingAutoFitViewId: string | undefined;
    private dragViewId: string | undefined;
    private newSheetSize: DrawingSheetSize = 'A4';
    private newViewOrientation: DrawingViewOrientation = 'front';
    private svgRef: SVGSVGElement | null = null;
    private canvasRef: HTMLDivElement | null = null;
    private zoom = 1;
    private panX = 0;
    private panY = 0;
    private snapEnabled = true;
    private showGrid = true;
    private showFrame = true;
    private inspectorOpen = true;
    private hoveredViewId: string | undefined;
    private panDrag: { startX: number; startY: number; panX: number; panY: number; pointerId: number } | undefined;
    /** Relative view drag: press point and the view position at press time. */
    private viewDragStart: { viewId: string; startPoint: [number, number]; startPosition: [number, number] } | undefined;
    /** The current view press moved; never treat its click tail as a double-click. */
    private viewDragMoved = false;
    /** Space is held: the canvas shows `grab` and left-drag pans. */
    private spaceHeld = false;
    /** Window-level Space handling only applies while the pointer is over the canvas. */
    private pointerOverCanvas = false;
    /** Dismisses the open view context menu (shared renderer close). */
    private closeViewMenu: (() => void) | undefined;
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
        this.title.iconClass = 'codicon codicon-nuke-cad-drawing';
        this.addClass('nuke-cad-drawing-sheet');
        this.lastDrawingVersion = this.documentStore.drawingVersion;
        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.handleStoreChange())));
        // Viewport edge picks for the dimension tool arrive through the
        // `edge-picker` broker; both subscriptions die with this widget.
        this.toDispose.push(Disposable.create(onDrawingDimensionPickRequest(() => this.handleViewportPickRequestChanged())));
        this.toDispose.push(Disposable.create(onDrawingDimensionEdgeHit((ref) => this.handleViewportEdgeHit(ref))));
        this.handleStoreChange();
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        // The widget can be created before the CAD document finishes loading
        // (the tab exists while the viewport build is still running). A hidden
        // ReactWidget's store update can land before the node is attached, so
        // re-read the shared store on every attach instead of leaving the
        // initial "No CAD document" render behind.
        this.lastDrawingVersion = this.documentStore.drawingVersion;
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

    /**
     * Filesystem path of the saved document. The store holds a file URI (for
     * save/restore); the Python service and its working directory need a real
     * path, never `file://...`.
     */
    private documentFilePath(): string | undefined {
        const uri = this.documentStore.uri;
        if (uri === undefined) {
            return undefined;
        }
        try {
            const parsed = new URI(uri);
            return parsed.scheme === 'file' ? parsed.path.fsPath() : undefined;
        } catch {
            return undefined;
        }
    }

    /** Save the shared CAD document, including its drawings block. */
    private async saveDocument(forceDialog = false): Promise<boolean> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            this.messageService.warn('No CAD document is active.');
            return false;
        }
        const existing = this.documentStore.uri !== undefined ? new URI(this.documentStore.uri) : undefined;
        let uri = existing !== undefined && !forceDialog ? existing : undefined;
        if (uri === undefined) {
            uri = await this.fileDialogService.showSaveDialog({
                title: 'Save CAD Document',
                inputValue: existing?.path.base ?? `${doc.name}.nuke-cad`,
                filters: { 'CAD Document': ['nuke-cad'] }
            });
            if (uri === undefined) {
                return false;
            }
            uri = uri.withPath(ensureNukeCadExtension(uri.path.toString()));
        }
        const json = this.documentStore.toJson();
        if (json === undefined) {
            return false;
        }
        try {
            await this.fileService.write(uri, json);
            this.documentStore.setUri(uri.toString());
            this.documentStore.markSaved();
            this.messageService.info(`Saved ${uri.path.base}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to save the CAD document: ${message}`);
            return false;
        }
    }

    private async refreshDrawing(): Promise<void> {
        // A rebuild replaces view linework under the pointer; a menu captured
        // against the old view is no longer meaningful.
        this.closeViewMenu?.();
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        if (this.documentStore.dirty && !(await this.saveDocument())) {
            return;
        }
        const documentPath = this.documentFilePath();
        if (documentPath === undefined) {
            this.messageService.info('Save the .nuke-cad document before building the drawing sheet.');
            return;
        }
        this.building = true;
        this.update();
        try {
            const result = await this.backendService.buildDrawing({ scriptPath: documentPath, sheetId: sheet.id });
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
            // A completion swaps the linework under any menu opened mid-build.
            this.closeViewMenu?.();
            this.update();
            this.maybeAutoFitPendingView();
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
        this.pendingAutoFitViewId = viewResult.value;
        this.update();
        if (this.drawingBackendReady !== true) {
            void this.refreshDrawing();
        }
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
        const { width, height } = sheetDimensions(sheet.size);
        const candidate: [number, number] = [parent.position[0] + 60, parent.position[1] + 40];
        const position = clampSheetPosition(
            kind === 'projected' ? lockProjectedViewPosition(orientation, parent.position, candidate) : candidate,
            width,
            height
        );
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
            return;
        }
        this.selectedViewId = result.value;
        this.update();
        if (this.drawingBackendReady !== true) {
            void this.refreshDrawing();
        }
    }

    private clientToSheetMm(clientX: number, clientY: number): [number, number] | undefined {
        const sheet = this.activeSheet();
        const svg = this.svgRef;
        if (sheet === undefined || svg === null) {
            return undefined;
        }
        const matrix = svg.getScreenCTM();
        if (matrix === null) {
            return undefined;
        }
        const point = svg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        const local = point.matrixTransform(matrix.inverse());
        const { height } = sheetDimensions(sheet.size);
        return [local.x, height - local.y];
    }

    private toSheetMm(event: React.PointerEvent): [number, number] | undefined {
        return this.clientToSheetMm(event.clientX, event.clientY);
    }

    private onViewPointerDown(event: React.PointerEvent, viewId: string): void {
        // The view stops propagation for dragging, so an open menu would miss
        // the shared renderer's window-level outside-pointerdown close.
        this.closeViewMenu?.();
        this.viewDragMoved = false;
        // Space is the pan modifier: let the event bubble to the canvas pan
        // handler instead of starting a view drag.
        if (this.spaceHeld) {
            return;
        }
        if (this.tool === 'dimension' || event.button !== 0 || event.altKey) {
            return;
        }
        const point = this.toSheetMm(event);
        if (point === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.canvasRef?.focus({ preventScroll: true });
        // Capture on the view group, not the painted child: the polyline under
        // the pointer is replaced by the next render, and capture on it would
        // drop the drag as soon as the pointer leaves the 1 px line.
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const sheet = this.activeSheet();
        const view = sheet?.views.find((entry) => entry.id === viewId);
        if (sheet === undefined || view === undefined) {
            return;
        }
        this.viewDragStart = { viewId, startPoint: point, startPosition: [...view.position] };
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
        const start = this.viewDragStart;
        if (view === undefined || start === undefined || start.viewId !== viewId) {
            return;
        }
        // Drag relative to the press point: grabbing a label or any part of a
        // view moves it by the pointer delta instead of teleporting its center
        // to the cursor.
        let next: [number, number] = [
            start.startPosition[0] + (point[0] - start.startPoint[0]),
            start.startPosition[1] + (point[1] - start.startPoint[1])
        ];
        if (this.snapEnabled) {
            next = [snapDrawingPosition(next[0]), snapDrawingPosition(next[1])];
        }
        if (view.kind !== 'base' && view.parentId !== undefined) {
            const parent = sheet.views.find((v) => v.id === view.parentId);
            if (parent !== undefined) {
                const parentLive = this.livePositions.get(parent.id) ?? parent.position;
                next = lockProjectedViewPosition(view.orientation, parentLive, next);
            }
        }
        const { width, height } = sheetDimensions(sheet.size);
        this.livePositions.set(viewId, clampSheetPosition(next, width, height));
        this.viewDragMoved = true;
        this.update();
    }

    private onViewPointerUp(event: React.PointerEvent, viewId: string): void {
        if (this.dragViewId !== viewId) {
            return;
        }
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        this.dragViewId = undefined;
        this.viewDragStart = undefined;
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
        this.closeViewMenu?.();
        if (this.spaceHeld) {
            // Space owns the gesture: let the label drag bubble to the canvas
            // pan handler like a view does.
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        this.canvasRef?.focus({ preventScroll: true });
        const start = this.clientToSheetMm(event.clientX, event.clientY);
        if (start === undefined) {
            return;
        }
        const startOffset = this.pinnedLabels.get(dimensionId) ?? fallback;
        const move = (moveEvent: PointerEvent): void => {
            const current = this.clientToSheetMm(moveEvent.clientX, moveEvent.clientY);
            if (current === undefined) {
                return;
            }
            this.pinnedLabels.set(dimensionId, [startOffset[0] + (current[0] - start[0]), startOffset[1] + (current[1] - start[1])]);
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

    private selectedView(): DrawingSheet['views'][number] | undefined {
        const sheet = this.activeSheet();
        return sheet?.views.find((view) => view.id === this.selectedViewId);
    }

    private addBaseView(orientation: DrawingViewOrientation): void {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        const { width, height } = sheetDimensions(sheet.size);
        const baseCount = sheet.views.filter((view) => view.kind === 'base').length;
        const position = clampSheetPosition(
            [Math.round((width / 2 + baseCount * 30) / 5) * 5, Math.round((height / 2 - baseCount * 20) / 5) * 5],
            width,
            height
        );
        const result = this.documentStore.addView(sheet.id, { kind: 'base', orientation, scale: 1, position });
        if (!result.success || result.value === undefined) {
            this.messageService.error(`Cannot create base view: ${result.error ?? 'unknown error'}`);
            return;
        }
        this.selectedViewId = result.value;
        this.pendingAutoFitViewId = result.value;
        this.update();
        if (this.drawingBackendReady !== true) {
            void this.refreshDrawing();
        }
    }

    /**
     * Fit the selected view's linework inside a comfortable sheet area and
     * snap to the nearest standard drafting scale. The next build uses the
     * new scale, so small parts no longer sit as a dot at 1:1.
     */
    private fitSelectedView(): void {
        const sheet = this.activeSheet();
        const view = this.selectedView();
        if (sheet === undefined || view === undefined) {
            return;
        }
        this.fitView(sheet, view);
    }

    private fitView(sheet: DrawingSheet, view: DrawingSheet['views'][number]): void {
        const output = this.viewOutput(view.id);
        // Fit the naked linework: the padded view bounds add a fixed 6 mm on
        // every side, which dominates the scale factor for a millimetre-scale
        // part and pins it to a much smaller drafting scale than it needs.
        const bounds = this.lineworkBounds(output) ?? this.viewBounds(view, output);
        if (!(bounds.width > 1e-6) || !(bounds.height > 1e-6)) {
            this.messageService.info('Refresh the drawing before fitting this view.');
            return;
        }
        const { width, height } = sheetDimensions(sheet.size);
        const factor = Math.min((width * 0.62) / bounds.width, (height * 0.62) / bounds.height);
        const raw = view.scale * factor;
        const next = DRAWING_SCALE_PRESETS.reduce((best, candidate) =>
            Math.abs(Math.log(candidate / raw)) < Math.abs(Math.log(best / raw)) ? candidate : best
        );
        const result = this.documentStore.updateView(sheet.id, view.id, { scale: next });
        if (!result.success) {
            this.messageService.error(`Cannot fit view: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    /**
     * A new base view on a unitless/millimetre-scale model can project to a dot
     * at 1:1. Fit it once, after its first build, when the naked linework is
     * under 20 mm on both axes. The flag is set only on creation, so a scale
     * the user later picks is never overwritten.
     */
    private maybeAutoFitPendingView(): void {
        const viewId = this.pendingAutoFitViewId;
        if (viewId === undefined) {
            return;
        }
        this.pendingAutoFitViewId = undefined;
        const sheet = this.activeSheet();
        const view = sheet?.views.find((entry) => entry.id === viewId);
        const output = this.viewOutput(viewId);
        if (sheet === undefined || view === undefined || output === undefined || view.kind !== 'base' || view.scale !== 1) {
            return;
        }
        const bounds = this.lineworkBounds(output);
        if (bounds === undefined || Math.max(bounds.width, bounds.height) >= 20) {
            return;
        }
        this.fitView(sheet, view);
    }

    private updateSelectedView(patch: { scale?: number; showHidden?: boolean }): void {
        const sheet = this.activeSheet();
        const view = this.selectedView();
        if (sheet === undefined || view === undefined) {
            return;
        }
        this.updateView(sheet, view, patch);
    }

    private updateView(sheet: DrawingSheet, view: DrawingSheet['views'][number], patch: { scale?: number; showHidden?: boolean }): void {
        const result = this.documentStore.updateView(sheet.id, view.id, patch);
        if (!result.success) {
            this.messageService.error(`Cannot update view: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    private deleteSelectedView(): void {
        const sheet = this.activeSheet();
        const view = this.selectedView();
        if (sheet === undefined || view === undefined) {
            return;
        }
        this.deleteView(sheet, view);
    }

    private deleteView(sheet: DrawingSheet, view: DrawingSheet['views'][number]): void {
        const result = this.documentStore.deleteView(sheet.id, view.id);
        if (!result.success) {
            this.messageService.error(`Cannot delete view: ${result.error ?? 'unknown error'}`);
            return;
        }
        if (this.selectedViewId === view.id) {
            this.selectedViewId = undefined;
        }
        this.update();
    }

    private deleteSelectedSheet(): void {
        this.closeViewMenu?.();
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        const result = this.documentStore.deleteSheet(sheet.id);
        if (!result.success) {
            this.messageService.error(`Cannot delete sheet: ${result.error ?? 'unknown error'}`);
            return;
        }
        this.activeSheetId = undefined;
        this.selectedViewId = undefined;
        this.buildResult = undefined;
        this.update();
    }

    private deleteDimension(dimensionId: string): void {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        const result = this.documentStore.deleteDimension(sheet.id, dimensionId);
        if (!result.success) {
            this.messageService.error(`Cannot delete dimension: ${result.error ?? 'unknown error'}`);
        }
        this.update();
    }

    private setZoom(next: number): void {
        this.zoom = clampDrawingZoom(next);
        this.update();
    }

    private fitSheet(): void {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.update();
    }

    private readonly onCanvasWheel = (event: WheelEvent): void => {
        if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) {
            return;
        }
        // React's `onWheel` is registered passively at the root, so calling
        // preventDefault there is ignored and logs a console error. This native
        // listener is bound with `{ passive: false }` in `bindCanvas`.
        event.preventDefault();
        this.closeViewMenu?.();
        const canvas = this.canvasRef;
        if (canvas === null) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const state = zoomDrawingAtPoint(
            { zoom: this.zoom, panX: this.panX, panY: this.panY },
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
            this.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)
        );
        this.zoom = state.zoom;
        this.panX = state.panX;
        this.panY = state.panY;
        this.update();
    };

    private bindCanvas = (element: HTMLDivElement | null): void => {
        if (this.canvasRef === element) {
            return;
        }
        const previous = this.canvasRef;
        if (previous !== null) {
            this.closeViewMenu?.();
            previous.removeEventListener('wheel', this.onCanvasWheel);
            window.removeEventListener('keydown', this.onWindowKeyDown);
            window.removeEventListener('keyup', this.onWindowKeyUp);
            window.removeEventListener('blur', this.onWindowBlur);
        }
        this.canvasRef = element;
        if (element !== null) {
            element.addEventListener('wheel', this.onCanvasWheel, { passive: false });
            window.addEventListener('keydown', this.onWindowKeyDown);
            window.addEventListener('keyup', this.onWindowKeyUp);
            window.addEventListener('blur', this.onWindowBlur);
        } else {
            // Leaving the document unmounts the canvas mid-gesture; drop the
            // Space/pan state so the next canvas does not open in grab mode.
            this.pointerOverCanvas = false;
            this.spaceHeld = false;
            this.panDrag = undefined;
        }
    };

    dispose(): void {
        this.closeViewMenu?.();
        this.canvasRef?.removeEventListener('wheel', this.onCanvasWheel);
        this.canvasRef = null;
        window.removeEventListener('keydown', this.onWindowKeyDown);
        window.removeEventListener('keyup', this.onWindowKeyUp);
        window.removeEventListener('blur', this.onWindowBlur);
        super.dispose();
    }

    /**
     * Space panning is window-scoped while the pointer is over the canvas, so a
     * page-level focus (no control owns the key) can pan without clicking the
     * canvas first. The canvas key handlers below cover a focused canvas even
     * after the pointer leaves it.
     */
    private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
        if (event.code !== 'Space' || event.defaultPrevented || this.closeViewMenu !== undefined) {
            return;
        }
        if (!this.pointerOverCanvas || isEditableKeyTarget(event.target)) {
            return;
        }
        // The canvas key handler owns a focused canvas; this window fallback
        // only covers a page-level focus (no control owns Space). Leaving
        // toolbar/inspector buttons alone keeps their native Space activation.
        const target = event.target;
        const pageTarget = target === document.body || target === document.documentElement;
        const canvas = this.canvasRef;
        const canvasTarget = canvas !== null && target instanceof Node && (target === canvas || canvas.contains(target));
        if (!pageTarget && !canvasTarget) {
            return;
        }
        // Block the workbench/page scroll and arm the grab cursor.
        event.preventDefault();
        this.setSpaceHeld(true);
    };

    private readonly onWindowKeyUp = (event: KeyboardEvent): void => {
        if (event.code === 'Space') {
            this.setSpaceHeld(false);
        }
    };

    private readonly onWindowBlur = (): void => {
        this.setSpaceHeld(false);
        this.finishPanDrag();
    };

    private setSpaceHeld(next: boolean): void {
        if (this.spaceHeld === next) {
            return;
        }
        this.spaceHeld = next;
        if (!next) {
            // Releasing Space ends an in-flight pan; the gesture is modifier-owned.
            this.finishPanDrag();
        }
        this.update();
    }

    private onCanvasKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
        if (event.code !== 'Space' || event.defaultPrevented || this.closeViewMenu !== undefined || isEditableKeyTarget(event.target)) {
            return;
        }
        event.preventDefault();
        this.setSpaceHeld(true);
    }

    private onCanvasKeyUp(event: React.KeyboardEvent<HTMLDivElement>): void {
        if (event.code === 'Space') {
            event.preventDefault();
            this.setSpaceHeld(false);
        }
    }

    private onCanvasBlur(): void {
        this.setSpaceHeld(false);
        this.finishPanDrag();
    }

    private onCanvasPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
        // Keep the canvas focused so Space reaches its key handlers even when
        // the workbench would otherwise own the keystroke.
        event.currentTarget.focus({ preventScroll: true });
        if (event.button !== 1 && !(event.button === 0 && (event.altKey || this.spaceHeld))) {
            return;
        }
        event.preventDefault();
        this.panDrag = {
            startX: event.clientX,
            startY: event.clientY,
            panX: this.panX,
            panY: this.panY,
            pointerId: event.pointerId
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        this.update();
    }

    private onCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
        if (this.panDrag === undefined || event.pointerId !== this.panDrag.pointerId) {
            return;
        }
        this.panX = this.panDrag.panX + (event.clientX - this.panDrag.startX);
        this.panY = this.panDrag.panY + (event.clientY - this.panDrag.startY);
        this.update();
    }

    private onCanvasPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
        this.finishPanDrag(event.pointerId);
    }

    private onCanvasPointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
        this.finishPanDrag(event.pointerId);
    }

    private finishPanDrag(pointerId?: number): void {
        const drag = this.panDrag;
        if (drag === undefined) {
            return;
        }
        this.panDrag = undefined;
        const id = pointerId ?? drag.pointerId;
        const canvas = this.canvasRef;
        if (canvas?.hasPointerCapture(id) === true) {
            canvas.releasePointerCapture(id);
        }
        this.update();
    }

    private openViewContextMenu(event: React.MouseEvent, view: DrawingSheet['views'][number]): void {
        this.selectedViewId = view.id;
        this.openCanvasContextMenu(
            event,
            buildDrawingViewMenu({ scale: view.scale, showHidden: view.showHidden === true }),
            'nuke-cad-drawing-view-menu',
            (action) => this.handleViewMenuAction(view.id, action)
        );
    }

    private openSheetContextMenu(event: React.MouseEvent): void {
        if (this.activeSheet() === undefined) {
            return;
        }
        // Paper scope: clear the view selection so the menu cannot read as a
        // view action when the user right-clicked empty sheet.
        this.selectedViewId = undefined;
        this.openCanvasContextMenu(
            event,
            buildDrawingSheetMenu({
                showGrid: this.showGrid,
                showFrame: this.showFrame,
                snapEnabled: this.snapEnabled,
                building: this.building,
                baseViewOrientation: this.newViewOrientation
            }),
            'nuke-cad-drawing-sheet-menu',
            (action) => this.handleSheetMenuAction(action)
        );
    }

    private openCanvasContextMenu<T>(
        event: React.MouseEvent,
        items: readonly ContextMenuItem<T>[],
        className: string,
        onAction: (action: T) => void
    ): void {
        const canvas = this.canvasRef;
        if (canvas === null) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.closeViewMenu?.();
        canvas.focus({ preventScroll: true });
        const rect = canvas.getBoundingClientRect();
        let removeScrollListener: (() => void) | undefined;
        let close: (() => void) | undefined;
        const finish = (): void => {
            removeScrollListener?.();
            removeScrollListener = undefined;
            if (this.closeViewMenu === close) {
                this.closeViewMenu = undefined;
            }
        };
        close = openContextMenu(
            canvas,
            items,
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            (action) => {
                finish();
                onAction(action);
            },
            { className, onClose: finish }
        );
        const onScroll = (): void => close?.();
        window.addEventListener('scroll', onScroll, true);
        removeScrollListener = () => window.removeEventListener('scroll', onScroll, true);
        this.closeViewMenu = close;
        this.update();
    }

    private handleSheetMenuAction(action: DrawingSheetMenuAction): void {
        switch (action.kind) {
            case 'fitSheet':
                this.fitSheet();
                break;
            case 'addBaseView':
                this.addBaseView(this.newViewOrientation);
                break;
            case 'toggleGrid':
                this.showGrid = !this.showGrid;
                this.update();
                break;
            case 'toggleFrame':
                this.showFrame = !this.showFrame;
                this.update();
                break;
            case 'toggleSnap':
                this.snapEnabled = !this.snapEnabled;
                this.update();
                break;
            case 'refresh':
                void this.refreshDrawing();
                break;
            case 'export':
                void this.exportDrawing(action.format);
                break;
            case 'deleteSheet':
                this.deleteSelectedSheet();
                break;
        }
    }

    private handleViewMenuAction(viewId: string, action: DrawingViewMenuAction): void {
        const sheet = this.activeSheet();
        const view = sheet?.views.find((entry) => entry.id === viewId);
        if (sheet === undefined || view === undefined) {
            return;
        }
        switch (action.kind) {
            case 'fitView':
                this.fitView(sheet, view);
                break;
            case 'toggleHidden':
                this.updateView(sheet, view, { showHidden: view.showHidden !== true });
                break;
            case 'setScale':
                this.updateView(sheet, view, { scale: action.scale });
                break;
            case 'focusScale':
                this.focusScaleControl(view.id);
                break;
            case 'deleteView':
                this.deleteView(sheet, view);
                break;
        }
    }

    private focusScaleControl(viewId: string): void {
        this.selectedViewId = viewId;
        this.inspectorOpen = true;
        this.update();
        window.requestAnimationFrame(() => {
            if (this.isDisposed) {
                return;
            }
            const trigger = this.node.querySelector<HTMLElement>('.nuke-cad-drawing-scale-row .nuke-select-trigger');
            trigger?.focus({ preventScroll: true });
        });
    }

    private onViewDoubleClick(event: React.MouseEvent, viewId: string): void {
        // A press that dragged ends with a click; browsers can still report a
        // double-click for the preceding click. Fit only on a true double-click.
        if (this.viewDragMoved) {
            this.viewDragMoved = false;
            return;
        }
        if (this.spaceHeld || this.tool === 'dimension') {
            return;
        }
        const sheet = this.activeSheet();
        const view = sheet?.views.find((entry) => entry.id === viewId);
        if (sheet === undefined || view === undefined) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.canvasRef?.focus({ preventScroll: true });
        this.selectedViewId = viewId;
        this.fitView(sheet, view);
    }

    private async exportDrawing(format: 'svg' | 'dxf'): Promise<void> {
        const sheet = this.activeSheet();
        if (sheet === undefined) {
            return;
        }
        if (this.buildResult?.success !== true) {
            await this.refreshDrawing();
        }
        const built = this.buildResult;
        const text = format === 'svg' ? built?.svg : built?.dxf;
        if (built?.success !== true || typeof text !== 'string' || text.length === 0) {
            const reason = format === 'dxf' ? built?.dxfError : undefined;
            this.messageService.warn(reason ?? `No ${format.toUpperCase()} was produced. Refresh the drawing and try again.`);
            return;
        }
        const docName = this.documentStore.document?.name ?? 'drawing';
        const stem = `${docName}-${sheet.name}`.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'drawing';
        const blob = new Blob([text], {
            type: format === 'svg' ? 'image/svg+xml;charset=utf-8' : 'application/dxf;charset=utf-8'
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${stem}.${format}`;
        anchor.click();
        URL.revokeObjectURL(url);
        this.messageService.info(`Exported ${anchor.download}`);
    }

    /** Human-readable single scale when every view shares one, else AS SHOWN. */
    private sheetScaleLabel(sheet: DrawingSheet): string {
        if (sheet.views.length === 0) {
            return '—';
        }
        const scales = new Set(sheet.views.map((view) => formatDrawingScale(view.scale)));
        return scales.size === 1 ? [...scales][0] : 'AS SHOWN';
    }

    private lineworkBounds(output: DrawingViewOutput | undefined): { x: number; y: number; width: number; height: number } | undefined {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        const include = (point: readonly [number, number]): void => {
            minX = Math.min(minX, point[0]);
            minY = Math.min(minY, point[1]);
            maxX = Math.max(maxX, point[0]);
            maxY = Math.max(maxY, point[1]);
        };
        for (const line of output?.visible ?? []) {
            line.points.forEach(include);
        }
        for (const line of output?.hidden ?? []) {
            line.points.forEach(include);
        }
        for (const loop of output?.hatchLoops ?? []) {
            loop.loop.forEach(include);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
            return undefined;
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    private viewBounds(
        view: DrawingSheet['views'][number],
        output: DrawingViewOutput | undefined
    ): { x: number; y: number; width: number; height: number } {
        const raw = this.lineworkBounds(output);
        if (raw !== undefined) {
            const pad = view.kind === 'section' ? 14 : 6;
            return { x: raw.x - pad, y: raw.y - pad, width: raw.width + pad * 2, height: raw.height + pad * 2 };
        }
        // Committed/build origin (the output position when one exists), never
        // the live drag position: `renderView` applies the drag delta once to
        // this frame. Using `livePositions` here too would double-translate the
        // selection frame/chip off the placeholder card while a view is being
        // dragged.
        const position = output?.position ?? view.position;
        const halfW = view.kind === 'detail' ? 28 : 35;
        const halfH = view.kind === 'detail' ? 28 : 22;
        return { x: position[0] - halfW, y: position[1] - halfH, width: halfW * 2, height: halfH * 2 };
    }

    protected render(): React.ReactNode {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return (
                <div className="nuke-cad-drawing-root nuke-cad-drawing-empty-root">
                    <div className="nuke-cad-drawing-empty">
                        <div className="nuke-cad-drawing-start-card nuke-cad-drawing-empty-card">
                            <div className="nuke-cad-drawing-start-header">
                                <span className="nuke-cad-drawing-start-icon" aria-hidden="true">
                                    <span className="codicon codicon-nuke-cad-drawing" />
                                </span>
                                <div className="nuke-cad-drawing-start-heading">
                                    <div className="nuke-cad-drawing-start-eyebrow">Drawing sheet</div>
                                    <div className="nuke-cad-drawing-start-title">No CAD document open</div>
                                </div>
                            </div>
                            <div className="nuke-cad-drawing-start-message">
                                Drawings live inside a <code>.nuke-cad</code> document. Open one to create sheets, views, and dimensions.
                            </div>
                            <ol className="nuke-cad-drawing-empty-steps">
                                <li>Open a .nuke-cad document from the Explorer or a sample project.</li>
                                <li>Add a sheet, then place a base view on it.</li>
                                <li>Pick model edges to add dimensions, then export SVG or DXF.</li>
                            </ol>
                            <div className="nuke-cad-drawing-start-hint">
                                <span className="codicon codicon-info" aria-hidden="true" />
                                <span>This tab picks up the document as soon as it opens.</span>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
        const drawings = doc.drawings ?? [];
        if (drawings.length === 0) {
            return <div className="nuke-cad-drawing-root nuke-cad-drawing-empty-root">{this.renderEmptyState()}</div>;
        }
        const sheet = this.activeSheet() ?? drawings[0];
        return (
            <div className="nuke-cad-drawing-root">
                {this.renderToolbar(sheet, drawings)}
                {this.renderNotices()}
                <div className="nuke-cad-drawing-body">
                    <div
                        ref={this.bindCanvas}
                        className={`nuke-cad-drawing-canvas${this.spaceHeld ? ' is-pan-ready' : ''}${
                            this.panDrag !== undefined ? ' is-panning' : ''
                        }`}
                        tabIndex={0}
                        aria-label="Drawing canvas"
                        onKeyDown={(event) => this.onCanvasKeyDown(event)}
                        onKeyUp={(event) => this.onCanvasKeyUp(event)}
                        onBlur={() => this.onCanvasBlur()}
                        onPointerEnter={() => {
                            this.pointerOverCanvas = true;
                        }}
                        onPointerLeave={() => {
                            this.pointerOverCanvas = false;
                        }}
                        onPointerDown={(event) => this.onCanvasPointerDown(event)}
                        onPointerMove={(event) => this.onCanvasPointerMove(event)}
                        onPointerUp={(event) => this.onCanvasPointerUp(event)}
                        onPointerCancel={(event) => this.onCanvasPointerCancel(event)}
                    >
                        <div
                            className="nuke-cad-drawing-stage"
                            style={{ transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})` }}
                        >
                            {this.renderSheetSvg(sheet)}
                        </div>
                    </div>
                    {this.inspectorOpen && this.renderInspector(sheet)}
                </div>
                {this.renderStatus(sheet)}
            </div>
        );
    }

    private renderEmptyState(): React.ReactNode {
        const sizes: DrawingSheetSize[] = ['A4', 'A3'];
        const orientations: { id: DrawingViewOrientation; title: string; hint: string }[] = [
            { id: 'front', title: 'Front', hint: 'Face-on base view' },
            { id: 'top', title: 'Top', hint: 'Plan view from above' },
            { id: 'right', title: 'Right', hint: 'Side elevation' }
        ];
        return (
            <div className="nuke-cad-drawing-empty">
                <div className="nuke-cad-drawing-start-card">
                    <div className="nuke-cad-drawing-start-header">
                        <span className="nuke-cad-drawing-start-icon" aria-hidden="true">
                            <span className="codicon codicon-nuke-cad-drawing" />
                        </span>
                        <div className="nuke-cad-drawing-start-heading">
                            <div className="nuke-cad-drawing-start-eyebrow">Drawing</div>
                            <div className="nuke-cad-drawing-start-title">Start a drawing</div>
                            <div className="nuke-cad-drawing-start-message">
                                Create a sheet from the current CAD document, then add views and dimensions.
                            </div>
                        </div>
                    </div>
                    <div className="nuke-cad-drawing-start-label">Sheet size</div>
                    <div className="nuke-cad-drawing-size-grid">
                        {sizes.map((size) => {
                            const dimensions = sheetDimensions(size);
                            return (
                                <button
                                    key={size}
                                    className={`nuke-cad-drawing-size-card${this.newSheetSize === size ? ' selected' : ''}`}
                                    aria-pressed={this.newSheetSize === size}
                                    onClick={() => {
                                        this.newSheetSize = size;
                                        this.update();
                                    }}
                                >
                                    <span className="nuke-cad-drawing-size-name">{size}</span>
                                    <span className="nuke-cad-drawing-size-meta">
                                        {dimensions.width} × {dimensions.height} mm
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="nuke-cad-drawing-start-label">Base view</div>
                    <div className="nuke-cad-drawing-orientation-grid">
                        {orientations.map((orientation) => (
                            <button
                                key={orientation.id}
                                className="nuke-cad-drawing-orientation-card"
                                onClick={() => this.createBaseSheet(orientation.id)}
                            >
                                <span className="nuke-cad-drawing-orientation-icon" aria-hidden="true">
                                    <span className="codicon codicon-nuke-cad-cube" />
                                </span>
                                <span className="nuke-cad-drawing-orientation-name">{orientation.title}</span>
                                <span className="nuke-cad-drawing-orientation-hint">{orientation.hint}</span>
                            </button>
                        ))}
                    </div>
                    <div className="nuke-cad-drawing-start-hint">
                        <span className="codicon codicon-info" aria-hidden="true" />
                        <span>A base view is required; projected, section, and detail views are added from it.</span>
                    </div>
                </div>
            </div>
        );
    }

    private renderToolbar(sheet: DrawingSheet, drawings: readonly DrawingSheet[]): React.ReactNode {
        const iconButton = (
            label: string,
            icon: string,
            onClick: () => void,
            options?: { active?: boolean; disabled?: boolean; className?: string }
        ): React.ReactNode => (
            <Tooltip content={label} position="bottom">
                <button
                    className={`theia-button${options?.active === true ? '' : ' secondary'} nuke-cad-drawing-icon-button${
                        options?.active === true ? ' is-active' : ''
                    }${options?.className ? ` ${options.className}` : ''}`}
                    aria-label={label}
                    aria-pressed={options?.active}
                    disabled={options?.disabled}
                    onClick={onClick}
                >
                    <span className={`codicon codicon-${icon}`} />
                </button>
            </Tooltip>
        );
        return (
            <div className="nuke-cad-drawing-toolbar">
                <NukeToolbar className="nuke-cad-drawing-toolbar-groups">
                    <NukeToolbarGroup label="Sheet">
                        <NukeSelect
                            className="nuke-cad-drawing-sheet-select"
                            ariaLabel="Drawing sheet"
                            value={sheet.id}
                            options={drawings.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.size})` }))}
                            onChange={(value) => {
                                this.activeSheetId = value;
                                this.selectedViewId = undefined;
                                this.pendingTargets = [];
                                this.pendingViewId = undefined;
                                this.buildResult = undefined;
                                cancelDrawingDimensionPick();
                                this.update();
                            }}
                        />
                        <NukeSelect
                            className="nuke-cad-drawing-size-select"
                            ariaLabel="New sheet size"
                            value={this.newSheetSize}
                            options={[
                                { value: 'A4', label: 'A4' },
                                { value: 'A3', label: 'A3' }
                            ]}
                            onChange={(value) => {
                                this.newSheetSize = value as DrawingSheetSize;
                                this.update();
                            }}
                        />
                        <Tooltip content={`New ${this.newSheetSize} sheet with a ${this.newViewOrientation} base view`} position="bottom">
                            <button className="theia-button" onClick={() => this.createBaseSheet(this.newViewOrientation)}>
                                <span className="codicon codicon-add" /> New sheet
                            </button>
                        </Tooltip>
                        {iconButton('Delete current sheet', 'trash', () => this.deleteSelectedSheet())}
                    </NukeToolbarGroup>
                    <NukeToolbarGroup label="View">
                        <NukeSelect
                            className="nuke-cad-drawing-orientation-select"
                            ariaLabel="Base view orientation"
                            value={this.newViewOrientation}
                            options={[
                                { value: 'front', label: 'Front' },
                                { value: 'top', label: 'Top' },
                                { value: 'right', label: 'Right' },
                                { value: 'iso', label: 'Iso' }
                            ]}
                            onChange={(value) => {
                                this.newViewOrientation = value as DrawingViewOrientation;
                                this.update();
                            }}
                        />
                        <button className="theia-button secondary" onClick={() => this.addBaseView(this.newViewOrientation)}>
                            <span className="codicon codicon-nuke-cad-cube" /> Base
                        </button>
                        <button className="theia-button secondary" onClick={() => this.addDerivedView('projected')}>
                            <span className="codicon codicon-layers" /> Projected
                        </button>
                        <button className="theia-button secondary" onClick={() => this.addDerivedView('section')}>
                            <span className="codicon codicon-split-horizontal" /> Section
                        </button>
                        <button className="theia-button secondary" onClick={() => this.addDerivedView('detail')}>
                            <span className="codicon codicon-zoom-in" /> Detail
                        </button>
                    </NukeToolbarGroup>
                    <NukeToolbarGroup label="Annotate">
                        {iconButton(
                            'Select and drag views',
                            'nuke-cad-select',
                            () => {
                                this.tool = 'select';
                                cancelDrawingDimensionPick();
                                this.pendingTargets = [];
                                this.pendingViewId = undefined;
                                this.update();
                            },
                            { active: this.tool === 'select' }
                        )}
                        {iconButton(
                            'Dimension tool',
                            'nuke-cad-measure',
                            () => {
                                this.tool = 'dimension';
                                this.update();
                            },
                            { active: this.tool === 'dimension' }
                        )}
                        <NukeSelect
                            className="nuke-cad-drawing-dimension-select"
                            ariaLabel="Dimension kind"
                            value={this.dimensionKind}
                            options={[
                                { value: 'distance', label: 'Distance' },
                                { value: 'radius', label: 'Radius' },
                                { value: 'diameter', label: 'Diameter' }
                            ]}
                            onChange={(value) => {
                                this.dimensionKind = value as DrawingDimensionKind;
                                cancelDrawingDimensionPick();
                                this.pendingTargets = [];
                                this.update();
                            }}
                        />
                        {this.tool === 'dimension' && (
                            <button
                                className="theia-button secondary"
                                onClick={() => {
                                    if (this.viewportPickActive()) {
                                        this.cancelViewportEdgePick();
                                    } else {
                                        this.startViewportEdgePick();
                                    }
                                }}
                            >
                                <span className="codicon codicon-target" /> {this.viewportPickActive() ? 'Cancel pick' : 'Pick in viewport'}
                            </button>
                        )}
                    </NukeToolbarGroup>
                    <NukeToolbarGroup label="Output">
                        <button className="theia-button secondary" onClick={() => void this.saveDocument()}>
                            <span className="codicon codicon-save" /> Save
                        </button>
                        <button className="theia-button secondary" disabled={this.building} onClick={() => void this.refreshDrawing()}>
                            <span className={`codicon ${this.building ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`} />
                            {this.building ? 'Building…' : 'Refresh'}
                        </button>
                        <button className="theia-button secondary" onClick={() => void this.exportDrawing('svg')}>
                            <span className="codicon codicon-download" /> SVG
                        </button>
                        <button className="theia-button secondary" onClick={() => void this.exportDrawing('dxf')}>
                            <span className="codicon codicon-download" /> DXF
                        </button>
                    </NukeToolbarGroup>
                </NukeToolbar>
                <div className="nuke-cad-drawing-view-controls">
                    {iconButton('Zoom out', 'zoom-out', () => this.setZoom(this.zoom / 1.15))}
                    <button className="nuke-cad-drawing-zoom-label" aria-label="Reset zoom" onClick={() => this.fitSheet()}>
                        {Math.round(this.zoom * 100)}%
                    </button>
                    {iconButton('Zoom in', 'zoom-in', () => this.setZoom(this.zoom * 1.15))}
                    {iconButton('Fit sheet', 'screen-full', () => this.fitSheet())}
                    {iconButton(
                        'Toggle grid',
                        'table',
                        () => {
                            this.showGrid = !this.showGrid;
                            this.update();
                        },
                        { active: this.showGrid }
                    )}
                    {iconButton(
                        'Toggle 5 mm snapping',
                        'magnet',
                        () => {
                            this.snapEnabled = !this.snapEnabled;
                            this.update();
                        },
                        { active: this.snapEnabled }
                    )}
                    {iconButton(
                        'Toggle frame and title block',
                        'file',
                        () => {
                            this.showFrame = !this.showFrame;
                            this.update();
                        },
                        { active: this.showFrame }
                    )}
                    {iconButton(
                        'Toggle inspector',
                        'layout-sidebar-right',
                        () => {
                            this.inspectorOpen = !this.inspectorOpen;
                            this.update();
                        },
                        { active: this.inspectorOpen, className: 'nuke-cad-drawing-inspector-toggle' }
                    )}
                </div>
            </div>
        );
    }

    private renderNotices(): React.ReactNode {
        const notices: React.ReactNode[] = [];
        if (this.drawingBackendReady === false) {
            notices.push(
                <div key="backend" className="nuke-cad-drawing-notice warning">
                    <span className="codicon codicon-warning" aria-hidden="true" />
                    <span>Drawing service unavailable. Sheet edits are saved; linework will refresh when the CAD backend answers.</span>
                    <button className="theia-button secondary" onClick={() => void this.refreshDrawing()}>
                        Retry
                    </button>
                </div>
            );
        }
        if (this.buildResult?.success === false) {
            notices.push(
                <div key="build" className="nuke-cad-drawing-notice error">
                    <span className="codicon codicon-error" aria-hidden="true" />
                    <span>Drawing build failed: {this.buildResult.error ?? 'unknown error'}</span>
                    <button className="theia-button secondary" onClick={() => void this.refreshDrawing()}>
                        Retry
                    </button>
                </div>
            );
        }
        if (typeof this.buildResult?.dxfError === 'string' && this.buildResult.dxfError.length > 0) {
            notices.push(
                <div key="dxf" className="nuke-cad-drawing-notice warning">
                    <span className="codicon codicon-warning" aria-hidden="true" />
                    <span>DXF export unavailable: {this.buildResult.dxfError}</span>
                </div>
            );
        }
        if (this.tool === 'dimension' && (this.pendingTargets.length > 0 || this.viewportPickActive())) {
            notices.push(
                <div key="pick" className="nuke-cad-drawing-notice info">
                    <span className="codicon codicon-target" aria-hidden="true" />
                    <span>
                        Dimension {this.dimensionKind}: {this.pendingTargets.length}/{drawingDimensionTargetsNeeded(this.dimensionKind)}{' '}
                        edges picked{this.viewportPickActive() ? ' — click edges in the 3D viewport.' : '.'}
                    </span>
                    {this.viewportPickActive() && (
                        <button className="theia-button secondary" onClick={() => this.cancelViewportEdgePick()}>
                            Cancel pick
                        </button>
                    )}
                </div>
            );
        }
        return notices.length > 0 ? <div className="nuke-cad-drawing-notices">{notices}</div> : undefined;
    }

    private renderInspector(sheet: DrawingSheet): React.ReactNode {
        const selected = this.selectedView();
        return (
            <aside className="nuke-cad-drawing-inspector">
                <NukeSection title="Sheet" icon="nuke-cad-drawing">
                    <div className="nuke-cad-drawing-meta">
                        <span>Name</span>
                        <strong>{sheet.name}</strong>
                        <span>Size</span>
                        <strong>{sheet.size} landscape</strong>
                        <span>Scale</span>
                        <strong>{this.sheetScaleLabel(sheet)}</strong>
                        <span>Views</span>
                        <strong>{sheet.views.length}</strong>
                        <span>Dimensions</span>
                        <strong>{sheet.dimensions.length}</strong>
                    </div>
                    <div className="nuke-cad-drawing-inspector-actions">
                        <button className="theia-button secondary" onClick={() => this.createBaseSheet(this.newViewOrientation)}>
                            <span className="codicon codicon-add" /> New sheet
                        </button>
                        <button className="theia-button secondary" onClick={() => this.deleteSelectedSheet()}>
                            <span className="codicon codicon-trash" /> Delete
                        </button>
                    </div>
                </NukeSection>
                {selected !== undefined && (
                    <NukeSection title="Selected view" icon="selection">
                        <NukeFormRow label="Type">
                            <span className="nuke-cad-drawing-value">
                                {selected.kind} {selected.orientation}
                            </span>
                        </NukeFormRow>
                        <NukeFormRow label="Position">
                            <span className="nuke-cad-drawing-value">
                                {selected.position[0].toFixed(1)}, {selected.position[1].toFixed(1)} mm
                            </span>
                        </NukeFormRow>
                        <NukeFormRow label="Scale" hint="Changes rebuild the drawing linework.">
                            <div className="nuke-cad-drawing-scale-row">
                                <NukeSelect
                                    ariaLabel="View scale"
                                    value={String(selected.scale)}
                                    options={(() => {
                                        const values = [...DRAWING_SCALE_PRESETS];
                                        if (!values.some((value) => Math.abs(value - selected.scale) < 1e-9)) {
                                            values.push(selected.scale);
                                            values.sort((a, b) => a - b);
                                        }
                                        return values.map((value) => ({
                                            value: String(value),
                                            label: formatDrawingScale(value)
                                        }));
                                    })()}
                                    onChange={(value) => this.updateSelectedView({ scale: Number(value) })}
                                />
                                <button className="theia-button secondary" onClick={() => this.fitSelectedView()}>
                                    <span className="codicon codicon-screen-full" /> Fit
                                </button>
                            </div>
                        </NukeFormRow>
                        <NukeCheckbox
                            checked={selected.showHidden === true}
                            onChange={(checked) => this.updateSelectedView({ showHidden: checked })}
                            ariaLabel="Show hidden lines"
                        >
                            Show hidden lines
                        </NukeCheckbox>
                        <div className="nuke-cad-drawing-inspector-actions">
                            <button className="theia-button secondary" onClick={() => this.deleteSelectedView()}>
                                <span className="codicon codicon-trash" /> Delete view
                            </button>
                        </div>
                    </NukeSection>
                )}
                <NukeSection title="Views" icon="layers">
                    {this.renderViewsSection(sheet)}
                </NukeSection>
                <NukeSection title="Dimensions" icon="nuke-cad-measure">
                    {this.renderDimensionsSection(sheet)}
                </NukeSection>
            </aside>
        );
    }

    private renderViewsSection(sheet: DrawingSheet): React.ReactNode {
        if (sheet.views.length === 0) {
            return <div className="nuke-cad-drawing-panel-empty">No views yet. Add a base view above.</div>;
        }
        return (
            <div className="nuke-cad-drawing-view-list">
                {sheet.views.map((view) => (
                    <div key={view.id} className={`nuke-cad-drawing-view-row${this.selectedViewId === view.id ? ' selected' : ''}`}>
                        <button
                            className="nuke-cad-drawing-view-row-main"
                            onClick={() => {
                                this.selectedViewId = view.id;
                                this.update();
                            }}
                        >
                            <span className={`codicon codicon-${this.iconForView(view.kind)} nuke-cad-drawing-view-row-icon`} />
                            <span className="nuke-cad-drawing-view-row-copy">
                                <span className="nuke-cad-drawing-view-row-label">
                                    {view.kind} {view.orientation}
                                </span>
                                <span className="nuke-cad-drawing-view-row-meta">
                                    {formatDrawingScale(view.scale)}
                                    {view.showHidden === true ? ' · hidden' : ''}
                                    {view.parentId !== undefined ? ' · child' : ''}
                                </span>
                            </span>
                        </button>
                        <Tooltip content="Delete view" position="left">
                            <button
                                className="nuke-cad-drawing-row-delete"
                                aria-label={`Delete ${view.kind} ${view.orientation}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    this.selectedViewId = view.id;
                                    this.deleteSelectedView();
                                }}
                            >
                                <span className="codicon codicon-trash" />
                            </button>
                        </Tooltip>
                    </div>
                ))}
            </div>
        );
    }

    private renderDimensionsSection(sheet: DrawingSheet): React.ReactNode {
        if (sheet.dimensions.length === 0) {
            return <div className="nuke-cad-drawing-panel-empty">None yet. Use Dimension, then Pick in viewport.</div>;
        }
        return (
            <div className="nuke-cad-drawing-dimension-list">
                {sheet.dimensions.map((dimension) => {
                    const output = this.buildResult?.dimensions?.find((entry) => entry.id === dimension.id);
                    const value = output?.text ?? (dimension.value !== undefined ? dimension.value.toFixed(2) : 'not built');
                    const stale = output?.stale ?? dimension.stale ?? false;
                    return (
                        <div key={dimension.id} className={`nuke-cad-drawing-dimension-row${stale ? ' stale' : ''}`}>
                            <button
                                className="nuke-cad-drawing-dimension-row-main"
                                onClick={() => {
                                    this.selectedViewId = dimension.viewId;
                                    this.update();
                                }}
                            >
                                <span className="codicon codicon-nuke-cad-measure nuke-cad-drawing-dimension-row-icon" />
                                <span className="nuke-cad-drawing-dimension-row-copy">
                                    <span className="nuke-cad-drawing-dimension-row-label">{dimension.kind}</span>
                                    <span className="nuke-cad-drawing-dimension-row-value">{value}</span>
                                </span>
                                {stale && <span className="nuke-cad-drawing-badge">stale</span>}
                            </button>
                            <Tooltip content="Delete dimension" position="left">
                                <button
                                    className="nuke-cad-drawing-row-delete"
                                    aria-label={`Delete ${dimension.kind} dimension`}
                                    onClick={() => this.deleteDimension(dimension.id)}
                                >
                                    <span className="codicon codicon-trash" />
                                </button>
                            </Tooltip>
                        </div>
                    );
                })}
            </div>
        );
    }

    private renderStatus(sheet: DrawingSheet): React.ReactNode {
        const { width, height } = sheetDimensions(sheet.size);
        const selected = this.selectedView();
        const selectedExtent = selected !== undefined ? this.lineworkBounds(this.viewOutput(selected.id)) : undefined;
        const state = this.building
            ? 'Building…'
            : this.buildResult?.success === true
              ? 'Up to date'
              : this.buildResult?.success === false
                ? 'Build failed'
                : 'Not built';
        const warnings = this.buildResult?.warnings?.length ?? 0;
        return (
            <div className="nuke-cad-drawing-status">
                <span className="nuke-cad-drawing-status-sheet">
                    {sheet.name} · {sheet.size} landscape
                </span>
                <span>
                    {width} × {height} mm
                </span>
                <span>{sheet.views.length} views</span>
                <span>{sheet.dimensions.length} dims</span>
                <span>{this.sheetScaleLabel(sheet)}</span>
                {selected !== undefined && (
                    <span className="nuke-cad-drawing-status-view">
                        {selected.kind} {selected.orientation} · {formatDrawingScale(selected.scale)} ·{' '}
                        {selectedExtent !== undefined ? formatDrawingExtent(selectedExtent) : 'no linework'}
                    </span>
                )}
                <span className="nuke-cad-drawing-status-spacer" />
                {warnings > 0 && <span className="nuke-cad-drawing-status-warning">{warnings} warnings</span>}
                {this.documentStore.dirty && <span className="nuke-cad-drawing-status-warning">Unsaved</span>}
                <span className={`nuke-cad-drawing-status-build${this.buildResult?.success === false ? ' error' : ''}`}>{state}</span>
                <span>Snap {this.snapEnabled ? '5 mm' : 'off'}</span>
                <span>{Math.round(this.zoom * 100)}%</span>
            </div>
        );
    }

    private iconForView(kind: DrawingSheet['views'][number]['kind']): string {
        switch (kind) {
            case 'base':
                return 'nuke-cad-cube';
            case 'projected':
                return 'layers';
            case 'section':
                return 'split-horizontal';
            case 'detail':
                return 'zoom-in';
        }
    }

    private renderSheetSvg(sheet: DrawingSheet): React.ReactNode {
        const { width, height } = sheetDimensions(sheet.size);
        const gridId = `nuke-cad-drawing-grid-${sheet.id}`;
        const majorGridId = `${gridId}-major`;
        const arrowId = `nuke-cad-drawing-arrow-${sheet.id}`;
        const shadowId = `${gridId}-shadow`;
        return (
            <div className="nuke-cad-drawing-paper-stage">
                <svg
                    ref={(el) => {
                        this.svgRef = el;
                    }}
                    className="nuke-cad-drawing-svg"
                    viewBox={`-10 -10 ${width + 20} ${height + 20}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`Drawing sheet ${sheet.name}`}
                    onContextMenu={(event) => this.openSheetContextMenu(event)}
                >
                    <defs>
                        <pattern id={gridId} width="10" height="10" patternUnits="userSpaceOnUse">
                            <path d="M 10 0 L 0 0 0 10" className="nuke-cad-drawing-grid-line" />
                        </pattern>
                        <pattern id={majorGridId} width="50" height="50" patternUnits="userSpaceOnUse">
                            <path d="M 50 0 L 0 0 0 50" className="nuke-cad-drawing-grid-line major" />
                        </pattern>
                        <filter id={shadowId} x="-5%" y="-5%" width="110%" height="110%">
                            <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="#000000" floodOpacity="0.2" />
                        </filter>
                        <marker
                            id={arrowId}
                            viewBox="0 0 6 6"
                            refX="5"
                            refY="3"
                            markerWidth="4"
                            markerHeight="4"
                            orient="auto-start-reverse"
                        >
                            <path d="M 0 0 L 6 3 L 0 6 z" className="nuke-cad-drawing-arrowhead" />
                        </marker>
                    </defs>
                    <rect
                        x={0}
                        y={0}
                        width={width}
                        height={height}
                        className="nuke-cad-drawing-paper"
                        filter={`url(#${shadowId})`}
                        onClick={() => {
                            if (this.tool === 'select') {
                                this.selectedViewId = undefined;
                                this.update();
                            }
                        }}
                    />
                    {this.showGrid && (
                        <>
                            <rect x={10} y={10} width={width - 20} height={height - 20} fill={`url(#${gridId})`} pointerEvents="none" />
                            <rect
                                x={10}
                                y={10}
                                width={width - 20}
                                height={height - 20}
                                fill={`url(#${majorGridId})`}
                                pointerEvents="none"
                            />
                        </>
                    )}
                    {this.showFrame && this.renderSheetFrame(width, height)}
                    {sheet.views.map((view) => this.renderView(view, width, height))}
                    {this.renderDimensions(sheet, height, arrowId)}
                    {this.showFrame && this.renderTitleBlock(sheet, width, height)}
                </svg>
            </div>
        );
    }

    private renderSheetFrame(width: number, height: number): React.ReactNode {
        const margin = 10;
        return (
            <g className="nuke-cad-drawing-frame" pointerEvents="none">
                <rect
                    x={margin}
                    y={margin}
                    width={width - margin * 2}
                    height={height - margin * 2}
                    className="nuke-cad-drawing-frame-border"
                />
                <path
                    d={`M ${margin} ${margin + 7} L ${margin + 7} ${margin} M ${width - margin - 7} ${margin} L ${width - margin} ${margin + 7} M ${width - margin} ${height - margin - 7} L ${width - margin - 7} ${height - margin} M ${margin + 7} ${height - margin} L ${margin} ${height - margin - 7}`}
                    className="nuke-cad-drawing-frame-tick"
                />
            </g>
        );
    }

    private renderTitleBlock(sheet: DrawingSheet, width: number, height: number): React.ReactNode {
        const margin = 10;
        const blockWidth = 92;
        const blockHeight = 30;
        const x = width - margin - blockWidth;
        const y = height - margin - blockHeight;
        const documentName = this.documentStore.document?.name ?? 'Untitled';
        const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
        return (
            <g className="nuke-cad-drawing-title-block" transform={`translate(${x} ${y})`} pointerEvents="none">
                <rect width={blockWidth} height={blockHeight} className="nuke-cad-drawing-title-block-box" />
                <line x1={0} y1={9} x2={blockWidth} y2={9} className="nuke-cad-drawing-title-block-rule" />
                <line x1={0} y1={18} x2={blockWidth} y2={18} className="nuke-cad-drawing-title-block-rule" />
                <line x1={0} y1={24} x2={blockWidth} y2={24} className="nuke-cad-drawing-title-block-rule" />
                <line x1={58} y1={0} x2={58} y2={blockHeight} className="nuke-cad-drawing-title-block-rule" />
                <text x={3} y={6} className="nuke-cad-drawing-title-block-brand">
                    NUKE CAD
                </text>
                <text x={61} y={6} className="nuke-cad-drawing-title-block-caption">
                    DRAWING
                </text>
                <text x={3} y={15} className="nuke-cad-drawing-title-block-value">
                    {truncate(documentName, 28)}
                </text>
                <text x={61} y={15} className="nuke-cad-drawing-title-block-caption">
                    {truncate(sheet.name, 14)}
                </text>
                <text x={3} y={22} className="nuke-cad-drawing-title-block-caption">
                    {sheet.size} landscape
                </text>
                <text x={61} y={22} className="nuke-cad-drawing-title-block-value">
                    {this.sheetScaleLabel(sheet)}
                </text>
                <text x={3} y={28} className="nuke-cad-drawing-title-block-caption">
                    NukeIDE
                </text>
                <text x={61} y={28} className="nuke-cad-drawing-title-block-caption">
                    SHEET
                </text>
            </g>
        );
    }

    /**
     * Render one view. The linework is stored in sheet-mm at the view's
     * committed position; a live drag shifts only the linework group while
     * the frame, chip, section marker, and detail circle follow the live
     * position directly (never double-translated).
     */
    private renderView(view: DrawingSheet['views'][number], sheetWidth: number, sheetHeight: number): React.ReactNode {
        const live = this.livePositions.get(view.id) ?? view.position;
        const output = this.viewOutput(view.id);
        // The built linework is absolute sheet-mm at the *build-time* position.
        // Translate by the delta from that origin, not from the committed
        // position, so a drag that commits before the next HLR build keeps its
        // on-screen offset instead of snapping back to the stale coordinates.
        const origin = output?.position ?? view.position;
        const dx = live[0] - origin[0];
        const dySvg = -(live[1] - origin[1]);
        const selected = this.selectedViewId === view.id;
        const hovered = this.hoveredViewId === view.id;
        const polylines = output?.visible ?? [];
        const hidden = output?.hidden ?? [];
        const hatchLoops = output?.hatchLoops ?? [];
        const hasLinework = output !== undefined;
        const bounds = this.viewBounds(view, output);
        // Convert the committed bounds to SVG, then apply the same
        // screen-space delta as the linework group. Adding the sheet-space
        // delta before `sheetMmToSvg` would move the frame in the opposite
        // vertical direction (the sheet y-axis is flipped).
        const [boundsLeft, boundsTop] = sheetMmToSvg(bounds.x, bounds.y + bounds.height, sheetHeight);
        const bx = boundsLeft + dx;
        const by = boundsTop + dySvg;
        const [cx, cy] = sheetMmToSvg(live[0], live[1], sheetHeight);
        const chipLabel = `${view.kind} ${view.orientation} · ${formatDrawingScale(view.scale)}`;
        const chipWidth = Math.min(86, Math.max(26, chipLabel.length * 1.9 + 6));
        const chipX = Math.max(2, Math.min(bx, sheetWidth - chipWidth - 2));
        const chipY = Math.max(2, by - 7);
        // Invisible grab area: the linework can be millimetres wide at 1:1, so
        // a 1 px polyline is not a usable mouse target. Keep a minimum
        // 36 × 28 mm frame around small views; larger views get 6 mm padding.
        const hitWidth = Math.max(bounds.width + 12, 36);
        const hitHeight = Math.max(bounds.height + 12, 28);
        const hitX = bx - (hitWidth - bounds.width) / 2;
        const hitY = by - (hitHeight - bounds.height) / 2;
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
                className={`nuke-cad-drawing-view${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}${
                    this.tool === 'dimension' ? ' dimension-mode' : ''
                }`}
                onPointerDown={(e) => this.onViewPointerDown(e, view.id)}
                onPointerMove={(e) => this.onViewPointerMove(e, view.id)}
                onPointerUp={(e) => this.onViewPointerUp(e, view.id)}
                onContextMenu={(e) => this.openViewContextMenu(e, view)}
                onDoubleClick={(e) => this.onViewDoubleClick(e, view.id)}
                onPointerEnter={() => {
                    this.hoveredViewId = view.id;
                    this.update();
                }}
                onPointerLeave={() => {
                    if (this.hoveredViewId === view.id) {
                        this.hoveredViewId = undefined;
                        this.update();
                    }
                }}
            >
                <rect x={hitX} y={hitY} width={hitWidth} height={hitHeight} className="nuke-cad-drawing-view-hit" />
                {(selected || hovered) && (
                    <rect
                        x={bx - 3}
                        y={by - 3}
                        width={bounds.width + 6}
                        height={bounds.height + 6}
                        rx={2}
                        className={`nuke-cad-drawing-view-frame${selected ? ' selected' : ''}`}
                        pointerEvents="none"
                    />
                )}
                {!hasLinework && (
                    <g transform={`translate(${cx} ${cy})`} pointerEvents="none">
                        <rect x={-35} y={-22} width={70} height={44} rx={2} className="nuke-cad-drawing-placeholder-card" />
                        <text x={0} y={-9} textAnchor="middle" className="nuke-cad-drawing-placeholder-kicker">
                            {view.kind.toUpperCase()}
                        </text>
                        <text x={0} y={1} textAnchor="middle" className="nuke-cad-drawing-placeholder-title">
                            {view.orientation}
                        </text>
                        <text x={0} y={12} textAnchor="middle" className="nuke-cad-drawing-placeholder-hint">
                            {this.buildResult === undefined ? 'Refresh to generate' : 'No linework returned'}
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
                </g>
                {view.kind === 'section' && this.renderSectionMarker(view, live, sheetHeight)}
                {view.kind === 'detail' && view.detailRadius !== undefined && (
                    <circle cx={cx} cy={cy} r={view.detailRadius * view.scale} className="nuke-cad-drawing-detail" />
                )}
                <g className="nuke-cad-drawing-view-chip" transform={`translate(${chipX} ${chipY})`}>
                    <rect width={chipWidth} height={5.6} rx={1.2} className="nuke-cad-drawing-view-chip-bg" />
                    <text x={3} y={3.9} className="nuke-cad-drawing-view-chip-text">
                        {chipLabel}
                    </text>
                </g>
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
            <g className="nuke-cad-drawing-section" pointerEvents="none">
                <line x1={sx1} y1={sy1} x2={sx2} y2={sy2} className="nuke-cad-drawing-section-line" />
                <polygon points={arrowHead(sx2, sy2, axis, flip)} className="nuke-cad-drawing-section-arrow" />
                <polygon points={arrowHead(sx1, sy1, axis, -flip)} className="nuke-cad-drawing-section-arrow" />
                <text x={(sx1 + sx2) / 2} y={Math.min(sy1, sy2) - 3} textAnchor="middle" className="nuke-cad-drawing-section-label">
                    SECTION
                </text>
            </g>
        );
    }

    /**
     * Render dimensions from the D1 build output: `text` is the recomputed
     * value (last-good text when `stale`), `anchors` are the projected 2D
     * extension points in absolute sheet-mm. Without build output the label
     * falls back to the stored value above the owning view.
     */
    private renderDimensions(sheet: DrawingSheet, sheetHeight: number, arrowId: string): React.ReactNode {
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
                                      return (
                                          <line
                                              key={i}
                                              x1={ax}
                                              y1={ay}
                                              x2={ex}
                                              y2={ey}
                                              className="nuke-cad-drawing-leader"
                                              markerEnd={`url(#${arrowId})`}
                                          />
                                      );
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

/** Space is a pan modifier over the canvas unless a text field owns the key. */
function isEditableKeyTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
