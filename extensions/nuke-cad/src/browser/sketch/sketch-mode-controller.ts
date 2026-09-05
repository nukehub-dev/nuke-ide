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
 * Framework-light controller that wires a {@link SketchSession} into a three.js
 * viewport as an interactive sketch mode.
 *
 * Owns the sketch layer, orthographic camera, pointer-to-plane mapping, drag
 * solving, and rendering. The CAD viewport widget delegates to this controller
 * when sketch mode is active.
 *
 * @module nuke-cad/browser/sketch
 */

import * as THREE from 'three';
import { MessageService } from '@theia/core/lib/common/message-service';
import { SketchSession, type SketchTool, type ConstraintKind, type SketchStatus, type ConstraintRecord } from './sketch-session';
import { PlanegcsSketchSolver, type SketchPrimitive, type SketchPoint } from '../../common/sketch-solver';
import { getPlanegcsWasmUrl } from './planegcs-wasm-url';
import { sharedEllipsePolyline, sharedBSplinePolyline } from '../../common/sketch-curves';
import {
    buildDatumPlane,
    buildDatumPlaneFromFace,
    buildDatumPlaneFromMidplane,
    buildDatumPlaneFromPoints,
    type DatumKind,
    type DatumPlane,
    type Point2,
    type Vec3,
    intersectRayPlane,
    worldToSketch,
    sketchToWorld,
    pixelRadiusToModelUnits,
    defaultSketchViewSize
} from './sketch-math';
import { snap, createSnapConfig, type SnapResult } from './snap';
import { type SketchDef, type SketchDimension } from '../../common/cad-document';
import { type TopologyRef } from '../../common/topology-refs';
import { CadDocumentStore } from '../document/cad-document-store';

/** Listener invoked after any mutation that changes the sketch UI state. */
export type SketchControllerChangeListener = () => void;

/** A dimension label projected to screen coordinates for the HTML overlay. */
export interface DimensionLabel {
    id: string;
    text: string;
    x: number;
    y: number;
    selected: boolean;

    /** True when the user dragged the label to a persistent screen-space spot. */
    pinned: boolean;
}

/** Distance threshold in pixels for clicking a dimension label. */
const LABEL_HIT_RADIUS_PX = 12;

/** Constraint kinds that require a numeric value from the user. */
const VALUE_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set(['distance', 'radius', 'angle']);

/** Arity for each constraint kind. */
const CONSTRAINT_ARITY: Readonly<Record<ConstraintKind, number>> = {
    coincident: 2,
    fix: 1,
    horizontal: 1,
    vertical: 1,
    parallel: 2,
    perpendicular: 2,
    tangent: 2,
    equal: 2,
    concentric: 2,
    distance: 2,
    angle: 2,
    radius: 1,
    symmetry: 3,
    pointOnObject: 2
};

interface ConstraintInputState {
    kind: ConstraintKind;
    targetIds: string[];
    error?: string;
}

interface DragState {
    pointIds: string[];
}

interface ThemeColors {
    normal: THREE.Color;
    construction: THREE.Color;
    selected: THREE.Color;
    constrained: THREE.Color;
    underConstrained: THREE.Color;
    conflict: THREE.Color;
    preview: THREE.Color;
    snap: THREE.Color;
    grid: THREE.Color;
}

/**
 * Controller for interactive sketch mode inside the CAD viewport.
 *
 * The caller creates the controller, calls {@link enterSketch} to start a
 * session, and routes pointer events from the viewport canvas. The controller
 * mutates the shared three.js scene and camera owned by the viewport.
 */
export class SketchModeController {
    private readonly container: HTMLElement;
    private readonly scene: THREE.Scene;
    private readonly renderer: THREE.WebGLRenderer;
    private readonly controls: {
        enabled: boolean;
        target: THREE.Vector3;
        update: () => void;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
    };

    private session?: SketchSession;
    private datumPlane: DatumPlane = buildDatumPlane('XY', 0);
    private construction = false;
    private readonly selectedIds = new Set<string>();
    private constraintInput?: ConstraintInputState;
    private drag?: DragState;
    private dragFramePending = false;
    private lastPointer?: Point2;
    private lastSnap?: SnapResult;
    private selectedDimensionId?: string;
    /** Pending auto-dimension state after creating a line/circle/arc. */
    private autoDimensionState?: { primitiveId: string; kind: 'line' | 'circle' | 'arc'; screenX: number; screenY: number };
    private autoDimensionEnabled = false;
    /** Pending two-entity constraint popover state. */
    private constraintPopover?: { idA: string; idB: string; screenX: number; screenY: number };
    /** Last pointer position in screen coordinates, used to anchor transient popovers. */
    private lastClientPosition?: { x: number; y: number };
    /** Primitive id currently shown with the subtle hover highlight (Select tool only). */
    private hoverPrimitiveId?: string;
    private labelDrag?: { dimensionId: string; startOffset: [number, number]; startClient: Point2 };
    /** User label offsets in screen pixels, keyed by dimension id; session state, never stored in the document. */
    private readonly labelUserOffsets = new Map<string, [number, number]>();
    private panState?: { startCamera: THREE.OrthographicCamera; startPointer: Point2 };
    private status: SketchStatus = {
        dof: 0,
        conflicting: [],
        redundant: [],
        fullyConstrained: false,
        lastAutoConstraints: []
    };

    private readonly sketchGroup: THREE.Group;
    private readonly grid: THREE.GridHelper;
    private readonly previewObject: THREE.Group;
    private readonly snapMarker: THREE.Points;
    private readonly selectionMarker: THREE.Group;
    private readonly hoverMarker: THREE.Group;
    private readonly committedGroup: THREE.Group;
    private readonly projectedGroup: THREE.Group;
    private readonly dimensionGroup: THREE.Group;

    private mainCamera?: THREE.PerspectiveCamera;
    private orthoCamera?: THREE.OrthographicCamera;
    private activeSketchName = 'Sketch';
    private modelGroup?: THREE.Group;
    private readonly originalModelVisibility = new Map<THREE.Object3D, boolean>();

    private readonly listeners = new Set<SketchControllerChangeListener>();
    private readonly disposeSessionOnExit: boolean;
    private readonly renderCallback: () => void;
    private readonly messageService?: MessageService;
    private readonly documentStore?: CadDocumentStore;
    private storeUnsubscribe?: () => void;
    private themeColors: ThemeColors;
    private readonly onChangeBound: () => void;
    private sessionChangeUnsubscribe?: () => void;
    private savedControlsEnabled = true;

    /**
     * @param container The viewport container element (used for CSS var reads).
     * @param scene The shared three.js scene.
     * @param renderer The viewport renderer.
     * @param controls The orbit controls instance.
     * @param renderCallback Called whenever the controller needs a redraw.
     * @param options.modelGroup Optional 3D model group to dim/hide in sketch mode.
     * @param options.existingSession Optional existing session (debug/advanced).
     * @param options.messageService Optional Theia message service for surfacing user errors.
     * @param options.documentStore Optional document store; when supplied the controller renders projected external geometry.
     */
    constructor(
        container: HTMLElement,
        scene: THREE.Scene,
        renderer: THREE.WebGLRenderer,
        controls: {
            enabled: boolean;
            target: THREE.Vector3;
            update: () => void;
            addEventListener(type: string, listener: () => void): void;
            removeEventListener(type: string, listener: () => void): void;
        },
        renderCallback: () => void,
        options: {
            modelGroup?: THREE.Group;
            existingSession?: SketchSession;
            messageService?: MessageService;
            documentStore?: CadDocumentStore;
            mainCamera?: THREE.PerspectiveCamera;
        } = {}
    ) {
        this.container = container;
        this.scene = scene;
        this.renderer = renderer;
        this.controls = controls;
        this.renderCallback = renderCallback;
        this.modelGroup = options.modelGroup;
        this.session = options.existingSession;
        this.disposeSessionOnExit = options.existingSession === undefined;
        this.messageService = options.messageService;
        this.mainCamera = options.mainCamera;

        this.themeColors = this.readThemeColors();

        this.sketchGroup = new THREE.Group();
        this.sketchGroup.name = 'sketch-layer';
        this.committedGroup = new THREE.Group();
        this.committedGroup.name = 'sketch-committed';
        this.projectedGroup = new THREE.Group();
        this.projectedGroup.name = 'sketch-projected';
        this.dimensionGroup = new THREE.Group();
        this.dimensionGroup.name = 'sketch-dimensions';
        this.previewObject = new THREE.Group();
        this.previewObject.name = 'sketch-preview';
        this.selectionMarker = new THREE.Group();
        this.selectionMarker.name = 'sketch-selection';
        this.hoverMarker = new THREE.Group();
        this.hoverMarker.name = 'sketch-hover';

        this.grid = this.buildGrid();
        this.grid.visible = false;
        this.sketchGroup.add(this.grid);
        this.sketchGroup.add(this.committedGroup);
        this.sketchGroup.add(this.projectedGroup);
        this.sketchGroup.add(this.dimensionGroup);
        this.sketchGroup.add(this.previewObject);
        this.sketchGroup.add(this.selectionMarker);
        this.sketchGroup.add(this.hoverMarker);

        const snapGeometry = new THREE.BufferGeometry();
        snapGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        this.snapMarker = new THREE.Points(
            snapGeometry,
            new THREE.PointsMaterial({ color: this.themeColors.snap, size: 8, sizeAttenuation: false })
        );
        this.snapMarker.name = 'sketch-snap';
        this.snapMarker.visible = false;
        this.sketchGroup.add(this.snapMarker);

        this.onChangeBound = this.handleSessionChange.bind(this);
        this.documentStore = options.documentStore;
        this.storeUnsubscribe = this.documentStore?.onChange(() => this.handleStoreChange());

        if (this.session !== undefined) {
            this.bindSession(this.session);
        }
    }

    /** Subscribe to sketch controller change events. */
    onChange(listener: SketchControllerChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emitChange(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    /** True when a sketch session is active. */
    get isActive(): boolean {
        return this.session !== undefined;
    }

    /** Current sketch session, if any. */
    getSession(): SketchSession | undefined {
        return this.session;
    }

    /** Current active tool. */
    getTool(): SketchTool {
        return this.session?.getTool() ?? 'select';
    }

    /** Display name of the active sketch (for the viewport view label). */
    getSketchName(): string {
        return this.activeSketchName;
    }

    /** Current solver status. */
    getStatus(): SketchStatus {
        return this.status;
    }

    /** Selected primitive ids. */
    getSelection(): ReadonlySet<string> {
        return this.selectedIds;
    }

    /** All dimensions in the active sketch. */
    getDimensions(): SketchDimension[] {
        return this.session?.getDimensions() ?? [];
    }

    /** Currently selected dimension id, if any. */
    getSelectedDimension(): string | undefined {
        return this.selectedDimensionId;
    }

    /** Enable or disable the auto-dimension-on-creation preference. */
    setAutoDimensionEnabled(on: boolean): void {
        if (this.autoDimensionEnabled === on) {
            return;
        }
        this.autoDimensionEnabled = on;
        if (!on) {
            this.autoDimensionState = undefined;
        }
        this.emitChange();
    }

    /** Pending auto-dimension input state, if any. */
    getAutoDimensionInput(): { primitiveId: string; kind: 'line' | 'circle' | 'arc'; screenX: number; screenY: number } | undefined {
        return this.autoDimensionState;
    }

    /** Apply the user-entered value to the pending auto-dimension. */
    async applyAutoDimension(value: number | string): Promise<void> {
        const state = this.autoDimensionState;
        if (state === undefined || this.session === undefined) {
            return;
        }
        if (typeof value === 'string' && value.trim() === '') {
            return;
        }
        let targetIds: string[];
        let kind: ConstraintKind;
        if (state.kind === 'line') {
            const line = this.session.getPrimitive(state.primitiveId);
            if (line?.type !== 'line') {
                this.autoDimensionState = undefined;
                this.emitChange();
                return;
            }
            targetIds = [line.p1Id, line.p2Id];
            kind = 'distance';
        } else {
            targetIds = [state.primitiveId];
            kind = 'radius';
        }
        const result = await this.session.addConstraint(kind, targetIds, value, {
            direction: kind === 'distance' ? 'point-point' : undefined
        });
        this.autoDimensionState = undefined;
        if (!result.success) {
            this.messageService?.error(result.error ?? 'Failed to create dimension.');
        }
        this.emitChange();
    }

    /** Dismiss the pending auto-dimension without creating a dimension. */
    cancelAutoDimension(): void {
        if (this.autoDimensionState !== undefined) {
            this.autoDimensionState = undefined;
            this.emitChange();
        }
    }

    /** Active two-entity constraint popover state, if any. */
    getConstraintPopover(): { idA: string; idB: string; screenX: number; screenY: number } | undefined {
        return this.constraintPopover;
    }

    /** Apply a relation from the constraint context popover. */
    async applyConstraintPopover(kind: ConstraintKind): Promise<void> {
        const popover = this.constraintPopover;
        if (popover === undefined || this.session === undefined) {
            return;
        }
        const result = await this.session.addConstraint(kind, [popover.idA, popover.idB]);
        this.constraintPopover = undefined;
        if (!result.success) {
            this.messageService?.error(result.error ?? 'Failed to apply constraint.');
        }
        this.emitChange();
    }

    /** Dismiss the constraint context popover without applying a relation. */
    dismissConstraintPopover(): void {
        if (this.constraintPopover !== undefined) {
            this.constraintPopover = undefined;
            this.emitChange();
        }
    }

    /** Select a dimension (deselects primitives). */
    selectDimension(id: string | undefined): void {
        this.selectedDimensionId = id;
        if (id !== undefined) {
            this.selectedIds.clear();
            this.renderSelection();
        }
        this.renderDimensions();
        this.emitChange();
        this.renderCallback();
    }

    /** Delete the currently selected dimension. */
    async deleteSelectedDimension(): Promise<void> {
        if (this.selectedDimensionId === undefined || this.session === undefined) {
            return;
        }
        await this.session.deleteDimension(this.selectedDimensionId);
        this.selectedDimensionId = undefined;
    }

    /** True when construction geometry toggle is on. */
    getConstruction(): boolean {
        return this.construction;
    }

    /** Active constraint-input state, exposed to the overlay. */
    getConstraintInput(): { kind: ConstraintKind; targetIds: string[]; error?: string } | undefined {
        if (this.constraintInput === undefined) {
            return undefined;
        }
        return { kind: this.constraintInput.kind, targetIds: [...this.constraintInput.targetIds], error: this.constraintInput.error };
    }

    /** Current datum plane. */
    getDatumPlane(): DatumPlane {
        return this.datumPlane;
    }

    /**
     * Project all dimension labels to screen coordinates for the HTML overlay.
     *
     * The overlay calls this on every render so labels stay anchored during
     * pan/zoom. Labels the user dragged carry a persistent screen-space offset
     * and sit exactly where they were dropped (pinned); unpinned labels shift
     * downward until they clear their placed siblings. Offsets of dimensions
     * that no longer exist are pruned.
     */
    getDimensionLabels(): DimensionLabel[] {
        if (this.session === undefined || this.orthoCamera === undefined) {
            return [];
        }
        const labels: DimensionLabel[] = [];
        const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
        const liveIds = new Set<string>();
        for (const dimension of this.session.getDimensions()) {
            liveIds.add(dimension.id);
            const anchor = this.computeDimensionAnchor(dimension);
            if (anchor === undefined) {
                continue;
            }
            const world = sketchToWorld(anchor, this.datumPlane);
            const screen = this.worldToScreen(new THREE.Vector3(world.x, world.y, world.z));
            const text = this.formatDimensionText(dimension);
            const width = text.length * 7 + 20;
            const height = 24;
            const userOffset = this.labelUserOffsets.get(dimension.id);
            let x = screen.x;
            let y = screen.y;
            if (userOffset !== undefined) {
                x += userOffset[0];
                y += userOffset[1];
            } else {
                while (placed.some((p) => Math.abs(x - p.x) < (width + p.w) / 2 && Math.abs(y - p.y) < (height + p.h) / 2)) {
                    y += height + 4;
                }
            }
            placed.push({ x, y, w: width, h: height });
            labels.push({
                id: dimension.id,
                text,
                x,
                y,
                selected: dimension.id === this.selectedDimensionId,
                pinned: userOffset !== undefined
            });
        }
        for (const id of this.labelUserOffsets.keys()) {
            if (!liveIds.has(id)) {
                this.labelUserOffsets.delete(id);
            }
        }
        return labels;
    }

    /**
     * The camera that should be used for rendering.
     *
     * Sketch mode renders through the orthographic camera; every other state
     * renders through the viewport's live perspective camera so orbit/zoom/pan
     * remain connected to what is on screen.
     */
    getActiveCamera(): THREE.Camera {
        return this.orthoCamera ?? this.mainCamera ?? new THREE.PerspectiveCamera();
    }

    /**
     * Enter sketch mode on the given datum plane.
     *
     * Switches to an orthographic camera looking straight down the plane normal,
     * dims/hides the 3D model, and shows a grid. When ``sketchDef`` is supplied
     * the session is restored from the saved sketch; otherwise a fresh sketch is
     * created.
     */
    async enterSketch(
        kind: DatumKind,
        offset = 0,
        camera?: THREE.PerspectiveCamera,
        sketchDef?: SketchDef,
        inheritedParameters?: Record<string, number>,
        reference?: TopologyRef
    ): Promise<void> {
        if (this.session !== undefined) {
            await this.exitSketch();
        }
        if (kind === 'face') {
            if (reference === undefined) {
                throw new Error('face datum requires a TopologyRef reference');
            }
            this.datumPlane = buildDatumPlaneFromFace(reference, offset);
        } else if (kind === 'threePoint' || kind === 'midplane') {
            const datumId = sketchDef?.datumId;
            if (datumId === undefined) {
                throw new Error(`${kind} datum requires a sketch datum id`);
            }
            const datum = this.documentStore?.document?.datums.find((d) => d.id === datumId);
            if (datum === undefined) {
                throw new Error(`Unknown datum '${datumId}'`);
            }
            if (kind === 'threePoint') {
                const points = datum.points;
                if (points === undefined || points.length !== 3) {
                    throw new Error(`Datum '${datumId}' requires exactly 3 points`);
                }
                this.datumPlane = buildDatumPlaneFromPoints(points[0], points[1], points[2], offset);
            } else {
                const faces = datum.faces;
                if (faces === undefined || faces.length !== 2) {
                    throw new Error(`Datum '${datumId}' requires exactly 2 face references`);
                }
                this.datumPlane = buildDatumPlaneFromMidplane(faces[0], faces[1], offset);
            }
        } else if (kind === 'line2Point') {
            throw new Error('line2Point datum is a line and cannot be used as sketch placement');
        } else {
            this.datumPlane = buildDatumPlane(kind, offset);
        }
        this.activeSketchName = sketchDef?.name ?? 'Sketch';
        this.savedControlsEnabled = this.controls.enabled;
        this.controls.enabled = false;
        if (camera !== undefined) {
            this.mainCamera = camera;
        }

        await this.createSession(sketchDef, inheritedParameters);
        this.setupCamera();
        if (sketchDef !== undefined) {
            this.fitSketchView();
        }
        this.dimModel(true);
        this.scene.add(this.sketchGroup);
        this.grid.visible = true;
        this.renderProjectedPrimitives();
        this.renderSketch();
        this.renderCallback();
    }

    /** Exit sketch mode and restore the previous 3D view. */
    async exitSketch(): Promise<void> {
        if (this.session === undefined) {
            return;
        }
        this.unbindSession();
        const session = this.session;
        if (this.disposeSessionOnExit) {
            session.destroy();
        }
        this.session = undefined;
        this.drag = undefined;
        this.dragFramePending = false;
        this.labelUserOffsets.clear();
        this.selectedIds.clear();
        this.hoverPrimitiveId = undefined;
        this.activeSketchName = 'Sketch';
        this.sketchGroup.removeFromParent();
        this.grid.visible = false;
        this.dimModel(false);
        this.controls.enabled = this.savedControlsEnabled;
        this.restoreCamera();
        this.emitChange();
        this.renderCallback();
    }

    /** Re-read theme colors and refresh sketch materials. */
    refreshThemeColors(): void {
        this.themeColors = this.readThemeColors();
        (this.grid.material as THREE.LineBasicMaterial).color.copy(this.themeColors.grid);
        (this.snapMarker.material as THREE.PointsMaterial).color.copy(this.themeColors.snap);
        this.renderSketch();
    }

    /** Replace the model group that is dimmed/hidden while sketching. */
    setModelGroup(group: THREE.Group | undefined): void {
        this.modelGroup = group;
        if (this.isActive) {
            this.dimModel(true);
        }
    }

    /** Notify the controller that the viewport has resized. */
    onResize(): void {
        if (this.orthoCamera === undefined) {
            return;
        }
        const box = this.computeViewBox();
        this.orthoCamera.left = box.left;
        this.orthoCamera.right = box.right;
        this.orthoCamera.top = box.top;
        this.orthoCamera.bottom = box.bottom;
        this.orthoCamera.updateProjectionMatrix();
        this.renderCallback();
    }

    /**
     * Frame the restored sketch's geometry in the orthographic view.
     *
     * The default view size suits a fresh empty sketch; restored sketches can
     * span hundreds of model units and would render out of frame.
     */
    private fitSketchView(padding = 1.2): void {
        const camera = this.orthoCamera;
        const session = this.session;
        if (camera === undefined || session === undefined) {
            return;
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const grow = (x: number, y: number): void => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };
        for (const primitive of session.getPrimitives()) {
            if (primitive.type === 'point') {
                grow(primitive.x, primitive.y);
            } else if (primitive.type === 'line') {
                const p1 = session.getPrimitive(primitive.p1Id) as SketchPoint | undefined;
                const p2 = session.getPrimitive(primitive.p2Id) as SketchPoint | undefined;
                if (p1 !== undefined) {
                    grow(p1.x, p1.y);
                }
                if (p2 !== undefined) {
                    grow(p2.x, p2.y);
                }
            } else if (primitive.type === 'circle' || primitive.type === 'arc') {
                const center = session.getPrimitive(primitive.centerId) as SketchPoint | undefined;
                if (center !== undefined) {
                    grow(center.x - primitive.radius, center.y - primitive.radius);
                    grow(center.x + primitive.radius, center.y + primitive.radius);
                }
            } else if (primitive.type === 'ellipse') {
                for (const point of this.ellipsePolyline(primitive) ?? []) {
                    grow(point.x, point.y);
                }
            } else if (primitive.type === 'bspline') {
                for (const point of this.bsplinePolylines(primitive)?.curve ?? []) {
                    grow(point.x, point.y);
                }
            }
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return;
        }
        let requiredW = (maxX - minX) * padding;
        let requiredH = (maxY - minY) * padding;
        if (requiredW <= 0 || requiredH <= 0) {
            return;
        }
        const aspect = this.getAspect();
        if (requiredW / requiredH < aspect) {
            requiredW = requiredH * aspect;
        } else {
            requiredH = requiredW / aspect;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        camera.left = cx - requiredW / 2;
        camera.right = cx + requiredW / 2;
        camera.top = cy + requiredH / 2;
        camera.bottom = cy - requiredH / 2;
        camera.updateProjectionMatrix();
    }

    private async createSession(sketchDef?: SketchDef, inheritedParameters?: Record<string, number>): Promise<void> {
        const solver = await PlanegcsSketchSolver.create({ locateFile: () => getPlanegcsWasmUrl() });
        const snap = createSnapConfig({ radius: 0.25, gridPitch: 1 });
        const session =
            sketchDef !== undefined
                ? await SketchSession.fromSketchDef(sketchDef, solver, { inheritedParameters, snap })
                : await SketchSession.create(solver, {
                      datumId: this.datumPlane.kind,
                      snap,
                      inheritedParameters
                  });
        this.session = session;
        this.bindSession(session);
    }

    private bindSession(session: SketchSession): void {
        this.status = session.getStatus();
        this.sessionChangeUnsubscribe = session.onChange(this.onChangeBound);
    }

    private unbindSession(): void {
        if (this.sessionChangeUnsubscribe !== undefined) {
            this.sessionChangeUnsubscribe();
            this.sessionChangeUnsubscribe = undefined;
        }
    }

    private handleSessionChange(): void {
        if (this.session === undefined) {
            return;
        }
        this.status = this.session.getStatus();
        this.renderSketch();
        this.emitChange();
        this.renderCallback();
    }

    private handleStoreChange(): void {
        if (!this.isActive) {
            return;
        }
        this.renderProjectedPrimitives();
        this.renderCallback();
    }

    private setupCamera(): void {
        const camera = this.orthoCamera ?? this.buildOrthoCamera();
        this.orthoCamera = camera;
        const box = this.computeViewBox();
        camera.left = box.left;
        camera.right = box.right;
        camera.top = box.top;
        camera.bottom = box.bottom;
        camera.position.copy(this.toThree(this.datumPlane.origin).add(this.toThree(this.datumPlane.normal).multiplyScalar(10)));
        camera.lookAt(this.toThree(this.datumPlane.origin));
        camera.up.copy(this.toThree(this.datumPlane.yAxis));
        camera.updateProjectionMatrix();
        this.controls.target.copy(this.toThree(this.datumPlane.origin));
        this.controls.update();
    }

    private buildOrthoCamera(): THREE.OrthographicCamera {
        const size = defaultSketchViewSize();
        const aspect = this.getAspect();
        const w = size * aspect;
        const h = size;
        const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.01, 1000);
        cam.name = 'sketch-ortho-camera';
        return cam;
    }

    private computeViewBox(): { left: number; right: number; top: number; bottom: number } {
        const size = defaultSketchViewSize();
        const aspect = this.getAspect();
        const w = size * aspect;
        const h = size;
        return { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 };
    }

    private getAspect(): number {
        const w = this.container.clientWidth || 400;
        const h = this.container.clientHeight || 300;
        return h > 0 ? w / h : 1;
    }

    private restoreCamera(): void {
        this.orthoCamera = undefined;
    }
    private dimModel(dim: boolean): void {
        if (this.modelGroup === undefined) {
            return;
        }
        if (dim) {
            this.originalModelVisibility.clear();
            this.modelGroup.traverse((child) => {
                this.originalModelVisibility.set(child, child.visible);
                child.visible = false;
            });
        } else {
            this.modelGroup.traverse((child) => {
                child.visible = this.originalModelVisibility.get(child) ?? true;
            });
            this.originalModelVisibility.clear();
        }
    }

    /** Switch the active sketch tool. */
    setTool(tool: SketchTool): void {
        this.constraintInput = undefined;
        this.clearHoverHighlight();
        this.session?.setTool(tool);
        this.renderPreview();
        this.emitChange();
    }

    /** Toggle construction geometry for new entities. */
    setConstruction(construction: boolean): void {
        this.construction = construction;
        this.emitChange();
    }

    /** Enable or disable snapping for the active session (no-op without one). */
    setSnapEnabled(on: boolean): void {
        this.session?.setSnapEnabled(on);
        this.emitChange();
    }

    /** True when snapping is enabled; defaults to true without a session. */
    isSnapEnabled(): boolean {
        return this.session?.isSnapEnabled() ?? true;
    }

    /** Set the snap search radius in screen pixels (no-op without a session). */
    setSnapRadius(px: number): void {
        this.session?.setSnapRadius(px);
        this.emitChange();
    }

    /** Current snap search radius in screen pixels. */
    getSnapRadiusPx(): number {
        return this.session?.getSnapRadiusPx() ?? SketchSession.DEFAULT_SNAP_RADIUS_PX;
    }

    /** Toggle the construction flag on the current selection. */
    async toggleConstructionForSelection(): Promise<void> {
        if (this.session === undefined || this.selectedIds.size === 0) {
            return;
        }
        const value = !this.construction;
        for (const id of this.selectedIds) {
            await this.session.setConstruction(id, value);
        }
        this.emitChange();
    }

    /** Start adding a constraint; the next primitive clicks become targets. */
    startConstraint(kind: ConstraintKind): void {
        this.constraintInput = { kind, targetIds: [] };
        this.session?.setTool('select');
        this.emitChange();
    }

    /** Apply a constraint with a numeric value or parameter name (for distance/radius/angle). */
    async applyConstraintValue(kind: ConstraintKind, value: number | string, options?: { diameter?: boolean }): Promise<void> {
        if (this.session === undefined || this.constraintInput === undefined || this.constraintInput.kind !== kind) {
            return;
        }
        const targetIds = [...this.constraintInput.targetIds];
        if (targetIds.length !== CONSTRAINT_ARITY[kind]) {
            this.constraintInput = { ...this.constraintInput, error: `Select ${CONSTRAINT_ARITY[kind]} primitives` };
            this.emitChange();
            return;
        }
        const result = await this.session.addConstraint(kind, targetIds, value, { diameter: options?.diameter });
        if (result.success) {
            this.constraintInput = undefined;
        } else {
            this.constraintInput = { ...this.constraintInput, error: result.error };
        }
        this.emitChange();
    }

    /** Delete the selected primitives. */
    async deleteSelection(): Promise<void> {
        if (this.session === undefined) {
            return;
        }
        for (const id of [...this.selectedIds]) {
            await this.session.deletePrimitive(id);
        }
        this.selectedIds.clear();
        this.renderSelection();
        this.emitChange();
    }

    /** Cancel the in-progress entity or active constraint tool. */
    cancel(): void {
        if (this.constraintInput !== undefined) {
            this.constraintInput = undefined;
        } else {
            this.session?.cancel();
        }
        this.renderPreview();
        this.emitChange();
    }

    /**
     * Finish the in-progress entity if the active tool supports an explicit
     * finish gesture (B-spline: Enter / double-click commits the placed poles).
     */
    async finishInProgress(): Promise<void> {
        if (this.session === undefined) {
            return;
        }
        await this.session.finish();
        this.renderPreview();
        this.emitChange();
        this.renderCallback();
    }

    /** Pointer move handler. */
    onPointerMove(clientX: number, clientY: number): void {
        this.lastClientPosition = { x: clientX, y: clientY };
        if (this.session === undefined) {
            return;
        }
        if (this.labelDrag !== undefined) {
            const dx = clientX - this.labelDrag.startClient.x;
            const dy = clientY - this.labelDrag.startClient.y;
            this.labelUserOffsets.set(this.labelDrag.dimensionId, [this.labelDrag.startOffset[0] + dx, this.labelDrag.startOffset[1] + dy]);
            this.emitChange();
            this.renderCallback();
            return;
        }
        const sketchPoint = this.pointerToSketch(clientX, clientY);
        if (sketchPoint === undefined) {
            return;
        }
        this.lastPointer = sketchPoint;
        this.lastSnap = this.computeSnap(sketchPoint);
        const snapped = this.lastSnap.point;

        if (this.panState !== undefined) {
            this.panTo(sketchPoint);
            return;
        }
        if (this.drag !== undefined) {
            if (!this.dragFramePending) {
                this.dragFramePending = true;
                requestAnimationFrame(() => {
                    this.dragFramePending = false;
                    if (this.drag === undefined || this.lastSnap === undefined) {
                        return;
                    }
                    this.session!.dragTo(this.lastSnap.point).catch((err) => {
                        console.error('[SketchMode] dragTo failed:', err);
                    });
                });
            }
        } else {
            this.renderPreview();
            this.updateHoverHighlight();
        }
        this.updateSnapMarker(snapped);
    }

    /** Pointer down handler. */
    onPointerDown(clientX: number, clientY: number, multiSelect: boolean, panModifier: boolean, button = 0): void {
        this.lastClientPosition = { x: clientX, y: clientY };
        if (this.session === undefined) {
            return;
        }
        const sketchPoint = this.pointerToSketch(clientX, clientY);
        if (sketchPoint === undefined) {
            return;
        }
        this.lastPointer = sketchPoint;
        this.lastSnap = this.computeSnap(sketchPoint);
        const snapResult = this.lastSnap;

        // Middle button or shift-left starts a pan; Ctrl/Cmd is reserved for multi-select.
        if (button === 1 || (button === 0 && panModifier)) {
            this.beginPan(sketchPoint);
            return;
        }
        if (button !== 0) {
            return;
        }

        if (this.constraintInput !== undefined) {
            this.handleConstraintClick(snapResult, multiSelect).catch((err) => {
                console.error('[SketchMode] constraint click failed:', err);
            });
            return;
        }

        const tool = this.session.getTool();
        if (tool === 'select') {
            // Check for a dimension label hit before geometry drag.
            const labelId = this.dimensionLabelAt(clientX, clientY);
            if (labelId !== undefined) {
                this.selectedDimensionId = labelId;
                this.selectedIds.clear();
                this.autoDimensionState = undefined;
                this.constraintPopover = undefined;
                this.renderSelection();
                this.labelDrag = {
                    dimensionId: labelId,
                    startOffset: [...(this.labelUserOffsets.get(labelId) ?? [0, 0])],
                    startClient: { x: clientX, y: clientY }
                };
                this.renderDimensions();
                this.emitChange();
                this.renderCallback();
                return;
            }

            const pointId = this.draggablePointAt(snapResult);
            if (pointId !== undefined) {
                // Grabbing an endpoint/center also selects the owning primitive(s)
                // so a press (even without movement) gives visible feedback.
                this.selectOwnedPrimitives(pointId, multiSelect);
                this.clearHoverHighlight();
                this.drag = { pointIds: [pointId] };
                this.session.beginDrag([pointId]);
                this.session.dragTo(snapResult.point).catch((err) => {
                    console.error('[SketchMode] initial dragTo failed:', err);
                });
            } else {
                this.selectedDimensionId = undefined;
                this.handleSelectClick(snapResult, multiSelect);
                this.renderDimensions();
            }
        }
    }

    /** Pointer up handler. */
    async onPointerUp(_clientX: number, _clientY: number): Promise<void> {
        if (this.session === undefined) {
            return;
        }
        if (this.panState !== undefined) {
            this.panState = undefined;
            return;
        }
        if (this.labelDrag !== undefined) {
            this.labelDrag = undefined;
            return;
        }
        if (this.drag !== undefined) {
            try {
                await this.session.endDrag();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[SketchMode] endDrag failed:', err);
                this.messageService?.error(`Sketch drag failed: ${message}`);
            }
            this.drag = undefined;
            this.dragFramePending = false;
            return;
        }

        const tool = this.session.getTool();
        if (tool !== 'select' && this.lastPointer !== undefined) {
            const snapped = this.lastSnap?.point ?? this.lastPointer;
            const beforeIds = new Set(this.session.getPrimitiveIds());
            try {
                await this.session.click(snapped);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[SketchMode] click failed:', err);
                this.messageService?.error(`Sketch click failed: ${message}`);
            }
            this.maybeStartAutoDimension(beforeIds);
        }
    }

    private maybeStartAutoDimension(beforeIds: Set<string>): void {
        if (!this.autoDimensionEnabled || this.session === undefined || this.lastClientPosition === undefined) {
            return;
        }
        const newPrimitive = this.session
            .getPrimitives()
            .find((p) => !beforeIds.has(p.id) && (p.type === 'line' || p.type === 'circle' || p.type === 'arc'));
        if (newPrimitive === undefined) {
            return;
        }
        this.autoDimensionState = {
            primitiveId: newPrimitive.id,
            kind: newPrimitive.type as 'line' | 'circle' | 'arc',
            screenX: this.lastClientPosition.x,
            screenY: this.lastClientPosition.y
        };
        this.constraintPopover = undefined;
        this.emitChange();
    }

    /** Delete key handler. */
    onDeleteKey(): void {
        if (this.selectedDimensionId !== undefined) {
            this.deleteSelectedDimension().catch((err) => {
                console.error('[SketchMode] delete dimension failed:', err);
            });
            return;
        }
        this.deleteSelection().catch((err) => {
            console.error('[SketchMode] delete selection failed:', err);
        });
    }

    /**
     * Escape key handler, in priority order:
     * 1. dismiss transient overlay states (auto-dimension, constraint popover),
     * 2. cancel the in-progress entity or constraint pick,
     * 3. clear the selection,
     * 4. fall back to the Select tool so Esc always leads back to a known state.
     */
    onEscape(): void {
        if (this.autoDimensionState !== undefined) {
            this.cancelAutoDimension();
            return;
        }
        if (this.constraintPopover !== undefined) {
            this.dismissConstraintPopover();
            return;
        }
        if (this.constraintInput !== undefined || this.session?.isInProgress() === true) {
            this.cancel();
            return;
        }
        if (this.selectedIds.size > 0 || this.selectedDimensionId !== undefined) {
            this.selectedIds.clear();
            this.selectedDimensionId = undefined;
            this.constraintPopover = undefined;
            this.renderSelection();
            this.renderDimensions();
            this.emitChange();
            return;
        }
        if (this.session !== undefined && this.session.getTool() !== 'select') {
            this.setTool('select');
        }
    }

    private handleSelectClick(snap: SnapResult, multiSelect: boolean): void {
        const targetId = snap.sourceId;
        if (targetId === undefined) {
            if (!multiSelect) {
                this.selectedIds.clear();
            }
        } else if (multiSelect) {
            if (this.selectedIds.has(targetId)) {
                this.selectedIds.delete(targetId);
            } else {
                this.selectedIds.add(targetId);
            }
        } else {
            this.selectedIds.clear();
            this.selectedIds.add(targetId);
        }
        this.updateConstraintPopover(multiSelect);
        this.renderSelection();
        this.emitChange();
    }

    private updateConstraintPopover(multiSelect: boolean): void {
        if (!multiSelect || this.selectedIds.size !== 2) {
            this.constraintPopover = undefined;
            return;
        }
        const [idA, idB] = [...this.selectedIds];
        this.constraintPopover = {
            idA,
            idB,
            screenX: this.lastClientPosition?.x ?? 0,
            screenY: this.lastClientPosition?.y ?? 0
        };
    }

    private async handleConstraintClick(snap: SnapResult, _shiftKey: boolean): Promise<void> {
        if (this.session === undefined || this.constraintInput === undefined) {
            return;
        }
        const targetId = snap.sourceId;
        if (targetId === undefined) {
            return;
        }
        if (this.constraintInput.targetIds.includes(targetId)) {
            return;
        }
        const arity = CONSTRAINT_ARITY[this.constraintInput.kind];
        const targetIds = [...this.constraintInput.targetIds, targetId];
        if (targetIds.length < arity) {
            this.constraintInput = { kind: this.constraintInput.kind, targetIds };
            this.emitChange();
            return;
        }

        if (VALUE_CONSTRAINTS.has(this.constraintInput.kind)) {
            this.constraintInput = { kind: this.constraintInput.kind, targetIds };
            this.emitChange();
            return;
        }

        const result = await this.session.addConstraint(this.constraintInput.kind, targetIds);
        if (result.success) {
            this.constraintInput = undefined;
        } else {
            this.constraintInput = { kind: this.constraintInput.kind, targetIds, error: result.error };
        }
        this.emitChange();
    }

    private draggablePointAt(snap: SnapResult): string | undefined {
        if (snap.kind === 'endpoint' || snap.kind === 'center') {
            return snap.pointId;
        }
        return undefined;
    }

    /** Primitive ids whose geometry references the given point (the point itself when none). */
    private ownedPrimitiveIds(pointId: string): string[] {
        if (this.session === undefined) {
            return [];
        }
        const owned = this.session
            .getPrimitives()
            .filter(
                (p) =>
                    p.id !== pointId &&
                    ((p.type === 'line' && (p.p1Id === pointId || p.p2Id === pointId)) ||
                        (p.type === 'circle' && p.centerId === pointId) ||
                        (p.type === 'arc' && (p.centerId === pointId || p.startId === pointId || p.endId === pointId)) ||
                        (p.type === 'ellipse' && (p.centerId === pointId || p.focus1Id === pointId)) ||
                        (p.type === 'bspline' && p.poleIds.includes(pointId)))
            )
            .map((p) => p.id);
        return owned.length > 0 ? owned : [pointId];
    }

    private selectOwnedPrimitives(pointId: string, multiSelect: boolean): void {
        const ownedIds = this.ownedPrimitiveIds(pointId);
        this.selectedDimensionId = undefined;
        if (multiSelect) {
            const allSelected = ownedIds.every((id) => this.selectedIds.has(id));
            for (const id of ownedIds) {
                if (allSelected) {
                    this.selectedIds.delete(id);
                } else {
                    this.selectedIds.add(id);
                }
            }
        } else if (!ownedIds.every((id) => this.selectedIds.has(id))) {
            this.selectedIds.clear();
            for (const id of ownedIds) {
                this.selectedIds.add(id);
            }
        }
        this.updateConstraintPopover(multiSelect);
        this.renderSelection();
        this.renderDimensions();
        this.emitChange();
    }

    /** Map a snap result to the primitive a Select-tool hover/click should highlight. */
    private hoveredPrimitiveId(snapResult: SnapResult): string | undefined {
        if (snapResult.sourceId === undefined) {
            return undefined;
        }
        if (snapResult.kind === 'endpoint') {
            // Endpoint snaps report the raw point primitive; prefer the owning shape.
            return this.ownedPrimitiveIds(snapResult.sourceId)[0];
        }
        return snapResult.sourceId;
    }

    private updateHoverHighlight(): void {
        const id =
            this.session !== undefined && this.lastSnap !== undefined && this.session.getTool() === 'select'
                ? this.hoveredPrimitiveId(this.lastSnap)
                : undefined;
        if (id === this.hoverPrimitiveId) {
            return;
        }
        this.hoverPrimitiveId = id;
        this.renderHoverMarker();
    }

    private clearHoverHighlight(): void {
        if (this.hoverPrimitiveId === undefined) {
            return;
        }
        this.hoverPrimitiveId = undefined;
        this.renderHoverMarker();
    }

    /** Subtle translucent outline under the pointer; rides the existing repaint path. */
    private renderHoverMarker(): void {
        while (this.hoverMarker.children.length > 0) {
            const child = this.hoverMarker.children[0];
            this.hoverMarker.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
        if (this.session === undefined || this.hoverPrimitiveId === undefined) {
            return;
        }
        const primitive = this.session.getPrimitive(this.hoverPrimitiveId);
        if (primitive === undefined) {
            return;
        }
        const color = this.themeColors.selected;
        const z = 0.0035;
        if (primitive.type === 'point') {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([primitive.x, primitive.y, z], 3));
            const material = new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false, transparent: true, opacity: 0.45 });
            this.hoverMarker.add(new THREE.Points(geometry, material));
        } else if (primitive.type === 'line') {
            const p1 = this.session.getPrimitive(primitive.p1Id) as SketchPoint | undefined;
            const p2 = this.session.getPrimitive(primitive.p2Id) as SketchPoint | undefined;
            if (p1 === undefined || p2 === undefined) {
                return;
            }
            const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p1.x, p1.y, z), new THREE.Vector3(p2.x, p2.y, z)]);
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 });
            this.hoverMarker.add(new THREE.Line(geometry, material));
        } else if (primitive.type === 'circle' || primitive.type === 'arc') {
            const center = this.session.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return;
            }
            const geometry =
                primitive.type === 'circle'
                    ? this.circleGeometry(center, primitive.radius, z)
                    : this.arcGeometry(center, primitive.radius, primitive.startAngle, primitive.endAngle, z);
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 });
            this.hoverMarker.add(new THREE.Line(geometry, material));
        } else if (primitive.type === 'ellipse' || primitive.type === 'bspline') {
            const curve = primitive.type === 'ellipse' ? this.ellipsePolyline(primitive) : this.bsplinePolylines(primitive)?.curve;
            if (curve === undefined) {
                return;
            }
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 });
            this.hoverMarker.add(new THREE.Line(this.polylineGeometry(curve, z), material));
        }
        this.renderCallback();
    }

    private computeSnap(raw: Point2): SnapResult {
        const radius = pixelRadiusToModelUnits(this.getSnapRadiusPx(), this.getOrthoHeight(), this.container.clientHeight);
        return snap(raw, this.session?.getPrimitives() ?? [], createSnapConfig({ enabled: this.isSnapEnabled(), radius, gridPitch: 1 }));
    }

    private pointerToSketch(clientX: number, clientY: number): Point2 | undefined {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
        const camera = this.getActiveCamera();
        const rayOrigin = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
        const rayTarget = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera);
        const direction = rayTarget.sub(rayOrigin).normalize();
        const ray = { origin: this.fromThree(rayOrigin), direction: this.fromThree(direction) };
        const hit = intersectRayPlane(ray, this.datumPlane);
        if (hit === undefined) {
            return undefined;
        }
        return worldToSketch(hit, this.datumPlane);
    }

    private dimensionLabelAt(clientX: number, clientY: number): string | undefined {
        if (this.session === undefined) {
            return undefined;
        }
        for (const label of this.getDimensionLabels()) {
            const dx = label.x - clientX;
            const dy = label.y - clientY;
            if (dx * dx + dy * dy <= LABEL_HIT_RADIUS_PX * LABEL_HIT_RADIUS_PX) {
                return label.id;
            }
        }
        return undefined;
    }

    private beginPan(sketchPoint: Point2): void {
        if (this.orthoCamera === undefined) {
            return;
        }
        this.panState = { startCamera: this.orthoCamera.clone() as THREE.OrthographicCamera, startPointer: sketchPoint };
    }

    private panTo(sketchPoint: Point2): void {
        if (this.panState === undefined || this.orthoCamera === undefined) {
            return;
        }
        const dx = sketchPoint.x - this.panState.startPointer.x;
        const dy = sketchPoint.y - this.panState.startPointer.y;
        const start = this.panState.startCamera;
        this.orthoCamera.left = start.left - dx;
        this.orthoCamera.right = start.right - dx;
        this.orthoCamera.top = start.top - dy;
        this.orthoCamera.bottom = start.bottom - dy;
        this.orthoCamera.updateProjectionMatrix();
        const target = this.toThree(this.datumPlane.origin).add(this.toThree(this.datumPlane.normal).multiplyScalar(10));
        this.orthoCamera.position.copy(target);
        this.orthoCamera.lookAt(this.toThree(this.datumPlane.origin));
        this.controls.target.copy(this.toThree(this.datumPlane.origin));
        this.controls.update();
        this.renderSketch();
        // renderSketch only rebuilds scene children; pan must also repaint the
        // canvas and reproject the HTML dimension labels.
        this.emitChange();
        this.renderCallback();
    }

    /** Zoom the orthographic camera around the given screen point. */
    onWheel(clientX: number, clientY: number, deltaY: number): void {
        if (this.orthoCamera === undefined) {
            return;
        }
        const zoomFactor = deltaY > 0 ? 1.1 : 1 / 1.1;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const nx = (clientX - rect.left) / rect.width;
        const ny = 1 - (clientY - rect.top) / rect.height;

        const left = this.orthoCamera.left;
        const right = this.orthoCamera.right;
        const top = this.orthoCamera.top;
        const bottom = this.orthoCamera.bottom;
        const width = right - left;
        const height = top - bottom;
        const newWidth = width * zoomFactor;
        const newHeight = height * zoomFactor;

        this.orthoCamera.left = left + (width - newWidth) * nx;
        this.orthoCamera.right = this.orthoCamera.left + newWidth;
        this.orthoCamera.bottom = bottom + (height - newHeight) * ny;
        this.orthoCamera.top = this.orthoCamera.bottom + newHeight;
        this.orthoCamera.updateProjectionMatrix();
        this.renderSketch();
        // renderSketch only rebuilds scene children; zoom must also repaint
        // the canvas and reproject the HTML dimension labels.
        this.emitChange();
        this.renderCallback();
    }

    private getOrthoHeight(): number {
        const cam = this.orthoCamera;
        if (cam === undefined) {
            return defaultSketchViewSize();
        }
        return cam.top - cam.bottom;
    }

    private renderSketch(): void {
        this.clearCommitted();
        this.renderDimensions();
        if (this.session === undefined) {
            return;
        }
        const primitives = this.session.getPrimitives();
        for (const primitive of primitives) {
            this.renderPrimitive(primitive);
        }
        this.renderPreview();
        this.renderSelection();
    }

    private renderProjectedPrimitives(): void {
        while (this.projectedGroup.children.length > 0) {
            const child = this.projectedGroup.children[0];
            this.projectedGroup.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
        if (this.session === undefined || this.documentStore === undefined) {
            return;
        }
        const sketchId = this.session.getId();
        const primitives = this.documentStore.getProjectedPrimitives().get(sketchId) ?? [];
        const color = this.themeColors.construction;
        const z = -0.001;
        for (const raw of primitives) {
            const primitive = raw as Record<string, unknown>;
            const type = String(primitive.type ?? '');
            if (type === 'point') {
                const x = Number(primitive.x ?? 0);
                const y = Number(primitive.y ?? 0);
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, y, z], 3));
                const material = new THREE.PointsMaterial({ color, size: 4, sizeAttenuation: false });
                this.projectedGroup.add(new THREE.Points(geometry, material));
            } else if (type === 'line') {
                const p1Id = String(primitive.p1_id ?? primitive.p1Id ?? '');
                const p2Id = String(primitive.p2_id ?? primitive.p2Id ?? '');
                const p1 = this.findProjectedPoint(primitives, p1Id);
                const p2 = this.findProjectedPoint(primitives, p2Id);
                if (p1 === undefined || p2 === undefined) {
                    continue;
                }
                const geometry = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(p1.x, p1.y, z),
                    new THREE.Vector3(p2.x, p2.y, z)
                ]);
                const material = new THREE.LineDashedMaterial({
                    color,
                    dashSize: 0.15,
                    gapSize: 0.1,
                    linewidth: 1
                });
                const line = new THREE.Line(geometry, material);
                line.computeLineDistances();
                this.projectedGroup.add(line);
            } else if (type === 'circle') {
                const centerId = String(primitive.c_id ?? primitive.centerId ?? '');
                const center = this.findProjectedPoint(primitives, centerId);
                const radius = Number(primitive.radius ?? 0);
                if (center === undefined || radius <= 0) {
                    continue;
                }
                const geometry = this.circleGeometry(center, radius, z);
                const material = new THREE.LineDashedMaterial({
                    color,
                    dashSize: 0.15,
                    gapSize: 0.1,
                    linewidth: 1
                });
                const line = new THREE.Line(geometry, material);
                line.computeLineDistances();
                this.projectedGroup.add(line);
            } else if (type === 'arc') {
                const centerId = String(primitive.c_id ?? primitive.centerId ?? '');
                const center = this.findProjectedPoint(primitives, centerId);
                const radius = Number(primitive.radius ?? 0);
                const startAngle = Number(primitive.start_angle ?? primitive.startAngle ?? 0);
                const endAngle = Number(primitive.end_angle ?? primitive.endAngle ?? 0);
                if (center === undefined || radius <= 0) {
                    continue;
                }
                const geometry = this.arcGeometry(center, radius, startAngle, endAngle, z);
                const material = new THREE.LineDashedMaterial({
                    color,
                    dashSize: 0.15,
                    gapSize: 0.1,
                    linewidth: 1
                });
                const line = new THREE.Line(geometry, material);
                line.computeLineDistances();
                this.projectedGroup.add(line);
            } else if (type === 'ellipse') {
                const center = this.findProjectedPoint(primitives, String(primitive.c_id ?? primitive.centerId ?? ''));
                const focus1 = this.findProjectedPoint(primitives, String(primitive.focus1_id ?? primitive.focus1Id ?? ''));
                const radmin = Number(primitive.radmin ?? 0);
                if (center === undefined || focus1 === undefined || radmin <= 0) {
                    continue;
                }
                const geometry = this.polylineGeometry(sharedEllipsePolyline(center, focus1, radmin), z);
                const material = new THREE.LineDashedMaterial({
                    color,
                    dashSize: 0.15,
                    gapSize: 0.1,
                    linewidth: 1
                });
                const line = new THREE.Line(geometry, material);
                line.computeLineDistances();
                this.projectedGroup.add(line);
            } else if (type === 'bspline') {
                const poleIds = (primitive.pole_ids ?? primitive.poleIds ?? []) as unknown[];
                const knots = (primitive.knots ?? []) as unknown[];
                const mult = (primitive.mult ?? []) as unknown[];
                const degree = Number(primitive.degree ?? 0);
                const poles: Point2[] = [];
                let valid = true;
                for (const poleId of poleIds) {
                    const pole = this.findProjectedPoint(primitives, String(poleId));
                    if (pole === undefined) {
                        valid = false;
                        break;
                    }
                    poles.push(pole);
                }
                if (!valid || poles.length < degree + 1 || degree < 1) {
                    continue;
                }
                const geometry = this.polylineGeometry(sharedBSplinePolyline(poles, knots.map(Number), mult.map(Number), degree), z);
                const material = new THREE.LineDashedMaterial({
                    color,
                    dashSize: 0.15,
                    gapSize: 0.1,
                    linewidth: 1
                });
                const line = new THREE.Line(geometry, material);
                line.computeLineDistances();
                this.projectedGroup.add(line);
            }
        }
    }

    private findProjectedPoint(primitives: readonly Record<string, unknown>[], id: string): { x: number; y: number } | undefined {
        const point = primitives.find((p) => p.type === 'point' && (p.id === id || String(p.id) === id));
        if (point === undefined) {
            return undefined;
        }
        return { x: Number(point.x ?? 0), y: Number(point.y ?? 0) };
    }

    private clearCommitted(): void {
        while (this.committedGroup.children.length > 0) {
            const child = this.committedGroup.children[0];
            this.committedGroup.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
    }

    private renderPrimitive(primitive: SketchPrimitive & { construction: boolean }): void {
        const isSelected = this.selectedIds.has(primitive.id);
        const color = this.primitiveColor(primitive, isSelected);
        const z = 0.001;

        if (primitive.type === 'point') {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([primitive.x, primitive.y, z], 3));
            const material = new THREE.PointsMaterial({
                color,
                size: isSelected ? 8 : 5,
                sizeAttenuation: false
            });
            const points = new THREE.Points(geometry, material);
            points.userData = { id: primitive.id };
            this.committedGroup.add(points);
            return;
        }

        if (primitive.type === 'line') {
            const p1 = this.session!.getPrimitive(primitive.p1Id) as SketchPoint | undefined;
            const p2 = this.session!.getPrimitive(primitive.p2Id) as SketchPoint | undefined;
            if (p1 === undefined || p2 === undefined) {
                return;
            }
            const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p1.x, p1.y, z), new THREE.Vector3(p2.x, p2.y, z)]);
            const material = new THREE.LineBasicMaterial({ color, linewidth: isSelected ? 2 : 1 });
            const line = new THREE.Line(geometry, material);
            line.userData = { id: primitive.id };
            this.committedGroup.add(line);
            return;
        }

        if (primitive.type === 'circle') {
            const center = this.session!.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return;
            }
            const geometry = this.circleGeometry(center, primitive.radius, z);
            const material = new THREE.LineBasicMaterial({ color, linewidth: isSelected ? 2 : 1 });
            const line = new THREE.Line(geometry, material);
            line.userData = { id: primitive.id };
            this.committedGroup.add(line);
            return;
        }

        if (primitive.type === 'arc') {
            const center = this.session!.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return;
            }
            const geometry = this.arcGeometry(center, primitive.radius, primitive.startAngle, primitive.endAngle, z);
            const material = new THREE.LineBasicMaterial({ color, linewidth: isSelected ? 2 : 1 });
            const line = new THREE.Line(geometry, material);
            line.userData = { id: primitive.id };
            this.committedGroup.add(line);
            return;
        }

        if (primitive.type === 'ellipse' || primitive.type === 'bspline') {
            const curve = primitive.type === 'ellipse' ? this.ellipsePolyline(primitive) : this.bsplinePolylines(primitive)?.curve;
            if (curve === undefined) {
                return;
            }
            const polygon = primitive.type === 'bspline' ? this.bsplinePolylines(primitive)?.polygon : undefined;
            const material = new THREE.LineBasicMaterial({ color, linewidth: isSelected ? 2 : 1 });
            const before = this.committedGroup.children.length;
            this.addCurveAndPolygon(this.committedGroup, curve, polygon, z, material);
            for (const child of this.committedGroup.children.slice(before)) {
                child.userData = { id: primitive.id };
            }
        }
    }

    private circleGeometry(center: Point2, radius: number, z: number, segments = 64): THREE.BufferGeometry {
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            points.push(new THREE.Vector3(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle), z));
        }
        return new THREE.BufferGeometry().setFromPoints(points);
    }

    private arcGeometry(
        center: Point2,
        radius: number,
        startAngle: number,
        endAngle: number,
        z: number,
        segments = 64
    ): THREE.BufferGeometry {
        let s = startAngle;
        let e = endAngle;
        if (e < s) {
            e += Math.PI * 2;
        }
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
            const angle = s + (i / segments) * (e - s);
            points.push(new THREE.Vector3(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle), z));
        }
        return new THREE.BufferGeometry().setFromPoints(points);
    }

    /** Sampled ellipse polyline for a committed ellipse primitive, or undefined. */
    private ellipsePolyline(primitive: SketchPrimitive): Point2[] | undefined {
        if (primitive.type !== 'ellipse' || this.session === undefined) {
            return undefined;
        }
        const center = this.session.getPrimitive(primitive.centerId) as SketchPoint | undefined;
        const focus1 = this.session.getPrimitive(primitive.focus1Id) as SketchPoint | undefined;
        if (center === undefined || focus1 === undefined) {
            return undefined;
        }
        return sharedEllipsePolyline(center, focus1, primitive.radmin);
    }

    /** Sampled curve + control polygon for a committed bspline primitive, or undefined. */
    private bsplinePolylines(primitive: SketchPrimitive): { curve: Point2[]; polygon: Point2[] } | undefined {
        if (primitive.type !== 'bspline' || this.session === undefined) {
            return undefined;
        }
        const poles: Point2[] = [];
        for (const poleId of primitive.poleIds) {
            const pole = this.session.getPrimitive(poleId) as SketchPoint | undefined;
            if (pole === undefined) {
                return undefined;
            }
            poles.push(pole);
        }
        return { curve: sharedBSplinePolyline(poles, primitive.knots, primitive.mult, primitive.degree), polygon: poles };
    }

    private polylineGeometry(points: readonly Point2[], z: number): THREE.BufferGeometry {
        return new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, z)));
    }

    /** Add a curve line plus (for bsplines) the dashed control polygon. */
    private addCurveAndPolygon(
        group: THREE.Group,
        curve: readonly Point2[],
        polygon: readonly Point2[] | undefined,
        z: number,
        material: THREE.Material
    ): void {
        const line = new THREE.Line(this.polylineGeometry(curve, z), material);
        group.add(line);
        if (polygon !== undefined && polygon.length > 1) {
            const polygonMaterial = new THREE.LineDashedMaterial({
                color: (material as THREE.LineBasicMaterial).color,
                dashSize: 0.15,
                gapSize: 0.1
            });
            const polygonLine = new THREE.Line(this.polylineGeometry(polygon, z), polygonMaterial);
            polygonLine.computeLineDistances();
            group.add(polygonLine);
        }
    }

    private renderPreview(): void {
        while (this.previewObject.children.length > 0) {
            const child = this.previewObject.children[0];
            this.previewObject.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
        if (this.session === undefined || this.lastPointer === undefined) {
            return;
        }
        const preview = this.session.hover(this.lastPointer);
        const color = this.themeColors.preview;
        const z = 0.002;

        if (preview.type === 'point') {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([preview.point.x, preview.point.y, z], 3));
            const material = new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false });
            this.previewObject.add(new THREE.Points(geometry, material));
        } else if (preview.type === 'line') {
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(preview.p1.x, preview.p1.y, z),
                new THREE.Vector3(preview.p2.x, preview.p2.y, z)
            ]);
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(new THREE.Line(geometry, material));
        } else if (preview.type === 'circle') {
            const geometry = this.circleGeometry(preview.center, preview.radius, z);
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(new THREE.Line(geometry, material));
        } else if (preview.type === 'arc') {
            const geometry = this.arcGeometry(preview.center, preview.radius, preview.startAngle, preview.endAngle, z);
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(new THREE.Line(geometry, material));
        } else if (preview.type === 'rectangle') {
            const p1 = preview.p1;
            const p2 = preview.p2;
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(p1.x, p1.y, z),
                new THREE.Vector3(p2.x, p1.y, z),
                new THREE.Vector3(p2.x, p2.y, z),
                new THREE.Vector3(p1.x, p2.y, z),
                new THREE.Vector3(p1.x, p1.y, z)
            ]);
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(new THREE.Line(geometry, material));
        } else if (preview.type === 'ellipse') {
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(
                new THREE.Line(this.polylineGeometry(sharedEllipsePolyline(preview.center, preview.focus1, preview.radmin), z), material)
            );
        } else if (preview.type === 'bspline') {
            const material = new THREE.LineBasicMaterial({ color });
            this.previewObject.add(new THREE.Line(this.polylineGeometry(preview.poles, z), material));
        }
    }

    private updateSnapMarker(point: Point2): void {
        const positions = this.snapMarker.geometry.attributes.position.array as Float32Array;
        positions[0] = point.x;
        positions[1] = point.y;
        positions[2] = 0.003;
        this.snapMarker.geometry.attributes.position.needsUpdate = true;
        this.snapMarker.visible = true;
        this.renderCallback();
    }

    private renderSelection(): void {
        while (this.selectionMarker.children.length > 0) {
            const child = this.selectionMarker.children[0];
            this.selectionMarker.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
        if (this.session === undefined) {
            return;
        }
        for (const id of this.selectedIds) {
            const primitive = this.session.getPrimitive(id);
            if (primitive === undefined) {
                continue;
            }
            const color = this.themeColors.selected;
            const z = 0.004;
            if (primitive.type === 'point') {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute([primitive.x, primitive.y, z], 3));
                const material = new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false });
                this.selectionMarker.add(new THREE.Points(geometry, material));
            } else if (primitive.type === 'line') {
                const p1 = this.session.getPrimitive(primitive.p1Id) as SketchPoint | undefined;
                const p2 = this.session.getPrimitive(primitive.p2Id) as SketchPoint | undefined;
                if (p1 === undefined || p2 === undefined) {
                    continue;
                }
                const geometry = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(p1.x, p1.y, z),
                    new THREE.Vector3(p2.x, p2.y, z)
                ]);
                const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
                this.selectionMarker.add(new THREE.Line(geometry, material));
            } else if (primitive.type === 'circle') {
                const center = this.session.getPrimitive(primitive.centerId) as SketchPoint | undefined;
                if (center === undefined) {
                    continue;
                }
                const geometry = this.circleGeometry(center, primitive.radius, z);
                const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
                this.selectionMarker.add(new THREE.Line(geometry, material));
            } else if (primitive.type === 'arc') {
                const center = this.session.getPrimitive(primitive.centerId) as SketchPoint | undefined;
                if (center === undefined) {
                    continue;
                }
                const geometry = this.arcGeometry(center, primitive.radius, primitive.startAngle, primitive.endAngle, z);
                const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
                this.selectionMarker.add(new THREE.Line(geometry, material));
            } else if (primitive.type === 'ellipse' || primitive.type === 'bspline') {
                const curve = primitive.type === 'ellipse' ? this.ellipsePolyline(primitive) : this.bsplinePolylines(primitive)?.curve;
                if (curve === undefined) {
                    continue;
                }
                const polygon = primitive.type === 'bspline' ? this.bsplinePolylines(primitive)?.polygon : undefined;
                const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
                this.addCurveAndPolygon(this.selectionMarker, curve, polygon, z, material);
            }
        }
        this.renderCallback();
    }

    private renderDimensions(): void {
        while (this.dimensionGroup.children.length > 0) {
            const child = this.dimensionGroup.children[0];
            this.dimensionGroup.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        }
        if (this.session === undefined) {
            return;
        }
        const color = this.themeColors.normal;
        const z = 0.005;
        for (const dimension of this.session.getDimensions()) {
            const lines = this.buildDimensionLines(dimension, z);
            for (const geometry of lines) {
                const material = new THREE.LineBasicMaterial({
                    color: dimension.id === this.selectedDimensionId ? this.themeColors.selected : color
                });
                this.dimensionGroup.add(new THREE.Line(geometry, material));
            }
        }
    }

    private buildDimensionLines(dimension: SketchDimension, z: number): THREE.BufferGeometry[] {
        const result: THREE.BufferGeometry[] = [];
        if (dimension.kind === 'distance' || dimension.kind === 'distanceH' || dimension.kind === 'distanceV') {
            const a = this.session!.getPrimitive(dimension.targetIds[0]) as SketchPoint | undefined;
            const b = this.session!.getPrimitive(dimension.targetIds[1]) as SketchPoint | undefined;
            if (a === undefined || b === undefined) {
                return result;
            }
            const anchor = this.computeDimensionAnchor(dimension);
            if (anchor === undefined) {
                return result;
            }
            const offset = dimension.labelOffset ?? [0, 0];
            const p1 = new THREE.Vector3(a.x + offset[0], a.y + offset[1], z);
            const p2 = new THREE.Vector3(b.x + offset[0], b.y + offset[1], z);
            result.push(new THREE.BufferGeometry().setFromPoints([p1, p2]));
            return result;
        }
        if (dimension.kind === 'radius') {
            const primitive = this.session!.getPrimitive(dimension.targetIds[0]);
            if (primitive?.type !== 'circle' && primitive?.type !== 'arc') {
                return result;
            }
            const center = this.session!.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return result;
            }
            const anchor = this.computeDimensionAnchor(dimension);
            if (anchor === undefined) {
                return result;
            }
            result.push(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(center.x, center.y, z),
                    new THREE.Vector3(anchor.x, anchor.y, z)
                ])
            );
            return result;
        }
        if (dimension.kind === 'diameter') {
            const primitive = this.session!.getPrimitive(dimension.targetIds[0]);
            if (primitive?.type !== 'circle' && primitive?.type !== 'arc') {
                return result;
            }
            const center = this.session!.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return result;
            }
            const anchor = this.computeDimensionAnchor(dimension);
            if (anchor === undefined) {
                return result;
            }
            const dx = anchor.x - center.x;
            const dy = anchor.y - center.y;
            result.push(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(center.x - dx, center.y - dy, z),
                    new THREE.Vector3(center.x + dx, center.y + dy, z)
                ])
            );
            return result;
        }
        if (dimension.kind === 'angle') {
            const l1 = this.session!.getPrimitive(dimension.targetIds[0]);
            const l2 = this.session!.getPrimitive(dimension.targetIds[1]);
            if (l1?.type !== 'line' || l2?.type !== 'line') {
                return result;
            }
            const a1 = this.session!.getPrimitive(l1.p1Id) as SketchPoint | undefined;
            const a2 = this.session!.getPrimitive(l1.p2Id) as SketchPoint | undefined;
            const b1 = this.session!.getPrimitive(l2.p1Id) as SketchPoint | undefined;
            const b2 = this.session!.getPrimitive(l2.p2Id) as SketchPoint | undefined;
            if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) {
                return result;
            }
            // Find the common vertex of the two lines.
            const common = [a1.id, a2.id].find((id) => id === b1.id || id === b2.id);
            if (common === undefined) {
                return result;
            }
            const vertex = common === a1.id ? a1 : a2;
            const otherA = common === a1.id ? a2 : a1;
            const otherB = common === b1.id ? b2 : b1;
            const dirA = { x: otherA.x - vertex.x, y: otherA.y - vertex.y };
            const dirB = { x: otherB.x - vertex.x, y: otherB.y - vertex.y };
            const lenA = Math.hypot(dirA.x, dirA.y);
            const lenB = Math.hypot(dirB.x, dirB.y);
            if (lenA < 1e-12 || lenB < 1e-12) {
                return result;
            }
            const radius = Math.min(lenA, lenB) * 0.25;
            const start = Math.atan2(dirA.y, dirA.x);
            const end = Math.atan2(dirB.y, dirB.x);
            result.push(this.arcGeometry(vertex, radius, start, end, z, 16));
            return result;
        }
        return result;
    }

    private computeDimensionAnchor(dimension: SketchDimension): Point2 | undefined {
        if (dimension.kind === 'distance' || dimension.kind === 'distanceH' || dimension.kind === 'distanceV') {
            const a = this.session!.getPrimitive(dimension.targetIds[0]) as SketchPoint | undefined;
            const b = this.session!.getPrimitive(dimension.targetIds[1]) as SketchPoint | undefined;
            if (a === undefined || b === undefined) {
                return undefined;
            }
            const offset = dimension.labelOffset ?? [0, 0];
            return { x: (a.x + b.x) / 2 + offset[0], y: (a.y + b.y) / 2 + offset[1] };
        }
        if (dimension.kind === 'radius' || dimension.kind === 'diameter') {
            const primitive = this.session!.getPrimitive(dimension.targetIds[0]);
            if (primitive?.type !== 'circle' && primitive?.type !== 'arc') {
                return undefined;
            }
            const center = this.session!.getPrimitive(primitive.centerId) as SketchPoint | undefined;
            if (center === undefined) {
                return undefined;
            }
            const radius = primitive.type === 'circle' ? primitive.radius : primitive.radius;
            const offset = dimension.labelOffset ?? [0, 0];
            const angle = Math.PI / 4;
            return {
                x: center.x + radius * Math.cos(angle) + offset[0],
                y: center.y + radius * Math.sin(angle) + offset[1]
            };
        }
        if (dimension.kind === 'angle') {
            const l1 = this.session!.getPrimitive(dimension.targetIds[0]);
            const l2 = this.session!.getPrimitive(dimension.targetIds[1]);
            if (l1?.type !== 'line' || l2?.type !== 'line') {
                return undefined;
            }
            const a1 = this.session!.getPrimitive(l1.p1Id) as SketchPoint | undefined;
            const a2 = this.session!.getPrimitive(l1.p2Id) as SketchPoint | undefined;
            const b1 = this.session!.getPrimitive(l2.p1Id) as SketchPoint | undefined;
            const b2 = this.session!.getPrimitive(l2.p2Id) as SketchPoint | undefined;
            if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) {
                return undefined;
            }
            const common = [a1.id, a2.id].find((id) => id === b1.id || id === b2.id);
            if (common === undefined) {
                return undefined;
            }
            const vertex = common === a1.id ? a1 : a2;
            const otherA = common === a1.id ? a2 : a1;
            const otherB = common === b1.id ? b2 : b1;
            const dirA = { x: otherA.x - vertex.x, y: otherA.y - vertex.y };
            const dirB = { x: otherB.x - vertex.x, y: otherB.y - vertex.y };
            const lenA = Math.hypot(dirA.x, dirA.y);
            const lenB = Math.hypot(dirB.x, dirB.y);
            if (lenA < 1e-12 || lenB < 1e-12) {
                return undefined;
            }
            const offset = dimension.labelOffset ?? [0, 0];
            const bisect = { x: dirA.x / lenA + dirB.x / lenB, y: dirA.y / lenA + dirB.y / lenB };
            const bisectLen = Math.hypot(bisect.x, bisect.y);
            const radius = Math.min(lenA, lenB) * 0.3;
            if (bisectLen < 1e-12) {
                return { x: vertex.x + offset[0], y: vertex.y + radius + offset[1] };
            }
            return {
                x: vertex.x + (bisect.x / bisectLen) * radius + offset[0],
                y: vertex.y + (bisect.y / bisectLen) * radius + offset[1]
            };
        }
        return undefined;
    }

    private formatDimensionText(dimension: SketchDimension): string {
        const prefix = dimension.parameter !== undefined ? `${dimension.parameter} = ` : '';
        const valueText = dimension.value.toFixed(2).replace(/\.?0+$/, '');
        const text = dimension.kind === 'diameter' ? `⌀${valueText}` : `${prefix}${valueText}`;
        return dimension.driving ? text : `(${text})`;
    }

    private worldToScreen(world: THREE.Vector3): { x: number; y: number } {
        const camera = this.getActiveCamera();
        const ndc = world.clone().project(camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
            x: ((ndc.x + 1) / 2) * rect.width + rect.left,
            y: ((-ndc.y + 1) / 2) * rect.height + rect.top
        };
    }

    private primitiveColor(primitive: SketchPrimitive & { construction: boolean }, isSelected: boolean): THREE.Color {
        if (isSelected) {
            return this.themeColors.selected;
        }
        if (primitive.construction) {
            return this.themeColors.construction;
        }
        if (this.status.conflicting.length > 0) {
            return this.themeColors.conflict;
        }
        if (this.status.fullyConstrained) {
            return this.themeColors.constrained;
        }
        return this.themeColors.normal;
    }

    private readThemeColors(): ThemeColors {
        return {
            normal: this.readColor('--theia-foreground', '#cccccc'),
            construction: this.readColor('--theia-descriptionForeground', '#858585'),
            selected: this.readColor('--theia-focusBorder', '#007fd4'),
            constrained: this.readColor('--theia-foreground', '#cccccc'),
            underConstrained: this.readColor('--theia-editorInfo-foreground', '#1a85ff'),
            conflict: this.readColor('--theia-editorError-foreground', '#f48771'),
            preview: this.readColor('--theia-editorInfo-foreground', '#1a85ff'),
            snap: this.readColor('--theia-focusBorder', '#007fd4'),
            grid: this.readColor('--theia-panel-border', '#3c3c3c')
        };
    }

    private readColor(variable: string, fallback: string): THREE.Color {
        const value = getComputedStyle(this.container).getPropertyValue(variable).trim();
        return new THREE.Color(value || fallback);
    }

    private buildGrid(): THREE.GridHelper {
        const grid = new THREE.GridHelper(100, 100, this.themeColors.grid.getHex(), this.themeColors.grid.getHex());
        grid.rotation.x = Math.PI / 2;
        return grid;
    }

    /** Highlight conflicting or redundant constraints by selecting their primitives. */
    highlightDiagnostics(kind: 'conflicting' | 'redundant'): void {
        if (this.session === undefined) {
            return;
        }
        const ids = kind === 'conflicting' ? this.status.conflicting : this.status.redundant;
        this.selectedIds.clear();
        for (const constraintId of ids) {
            const record = this.session.getConstraints().find((c) => c.id === constraintId);
            if (record !== undefined) {
                for (const id of record.targetIds) {
                    this.selectedIds.add(id);
                }
            }
        }
        this.renderSelection();
        this.emitChange();
    }

    /** Return constraints whose target ids intersect the current selection. */
    getSelectedConstraints(): ConstraintRecord[] {
        if (this.session === undefined || this.selectedIds.size === 0) {
            return [];
        }
        return this.session.getConstraints().filter((c) => c.targetIds.some((id) => this.selectedIds.has(id)));
    }

    private toThree(v: Vec3): THREE.Vector3 {
        return new THREE.Vector3(v.x, v.y, v.z);
    }

    private fromThree(v: THREE.Vector3): Vec3 {
        return { x: v.x, y: v.y, z: v.z };
    }

    /** Release three.js resources owned by the controller. */
    dispose(): void {
        if (this.session !== undefined) {
            this.dimModel(false);
            this.unbindSession();
            if (this.disposeSessionOnExit) {
                this.session.destroy();
            }
            this.session = undefined;
        } else {
            this.unbindSession();
        }
        this.storeUnsubscribe?.();
        this.storeUnsubscribe = undefined;
        this.scene.remove(this.sketchGroup);
        this.sketchGroup.traverse((child) => {
            if (child instanceof THREE.Line || child instanceof THREE.Points) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    for (const m of child.material) {
                        m.dispose();
                    }
                } else {
                    child.material.dispose();
                }
            }
        });
    }
}
