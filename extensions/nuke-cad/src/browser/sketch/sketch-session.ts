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
 * Pure TypeScript sketch session controller.
 *
 * Owns one sketch on a datum plane: tool state machine, snap, auto-constraints,
 * constraint tools, drag solving, and serialization to/from SketchDef. No UI,
 * DOM, or three.js dependencies; the CAD viewport layer injects this controller.
 *
 * @module nuke-cad/browser/sketch
 */

import {
    type SketchSolver,
    type SketchPrimitive,
    type SketchPoint,
    type SketchLine,
    type SketchCircle,
    type SketchArc,
    type TemporaryConstraint,
    type SolverResult
} from '../../common/sketch-solver';
import { NUKE_CAD_SCHEMA_VERSION, type SketchDef, type NukeCadDocument, validateNukeCadDocument } from '../../common/cad-document';
import { snap, createSnapConfig, type Point2, type SnapConfig, type SnapResult } from './snap';

/** Tools supported by the sketch session. */
export type SketchTool = 'select' | 'point' | 'line' | 'circle' | 'arc3' | 'rectangle';

/** Constraint kinds exposed by the UI-facing constraint API. */
export type ConstraintKind =
    | 'coincident'
    | 'fix'
    | 'horizontal'
    | 'vertical'
    | 'parallel'
    | 'perpendicular'
    | 'tangent'
    | 'equal'
    | 'concentric'
    | 'distance'
    | 'angle'
    | 'radius'
    | 'symmetry'
    | 'pointOnObject';

/** Options for {@link SketchSession.addConstraint}. */
export interface AddConstraintOptions {
    /** When false the constraint is reference/measurement (default true). */
    driving?: boolean;
    /** Distance direction, only used by distance constraints. */
    direction?: 'point-point' | 'horizontal' | 'vertical';
}

/** Feedback for one auto-constraint applied by the last action. */
export interface AutoConstraintFeedback {
    kind: ConstraintKind;
    ids: string[];
}

/** Solver/constraint status exposed to the UI after every mutation. */
export interface SketchStatus {
    /** Remaining degrees of freedom (0 = fully constrained). */
    dof: number;
    /** Caller-assigned ids of conflicting constraints. */
    conflicting: string[];
    /** Caller-assigned ids of redundant constraints. */
    redundant: string[];
    /** True when the sketch has zero remaining DOF. */
    fullyConstrained: boolean;
    /** Auto-constraints produced by the last user action. */
    lastAutoConstraints: AutoConstraintFeedback[];
}

/** A committed constraint record tracked by the session. */
export interface ConstraintRecord {
    id: string;
    kind: ConstraintKind;
    /** Primitive ids selected by the user for this constraint. */
    targetIds: string[];
    /** Scalar value or parameter name, when the kind requires one. */
    value?: number | string;
    /** Whether the constraint drives geometry (false = reference/measurement). */
    driving: boolean;
    /** Distance direction, only present for distance constraints. */
    direction?: 'point-point' | 'horizontal' | 'vertical';
}

/** Preview geometry returned by hover() for the current tool and in-progress state. */
export type SketchPreview =
    | { type: 'none' }
    | { type: 'point'; point: Point2 }
    | { type: 'line'; p1: Point2; p2: Point2 }
    | { type: 'circle'; center: Point2; radius: number }
    | { type: 'arc'; center: Point2; radius: number; startAngle: number; endAngle: number }
    | { type: 'rectangle'; p1: Point2; p2: Point2 };

/** Options for creating or restoring a session. */
export interface SketchSessionOptions {
    /** Sketch id; defaults to a generated id. */
    id?: string;
    /** Human-readable sketch name. */
    name?: string;
    /** Datum plane id the sketch lives on. */
    datumId?: string;
    /** Snap engine overrides. */
    snap?: Partial<SnapConfig>;
    /** Auto horizontal/vertical angle threshold in degrees. */
    autoConstraintAngleThresholdDeg?: number;
}

/** Listener invoked after any mutation that changes the sketch state. */
export type ChangeListener = () => void;

/** Result of {@link SketchSession.addConstraint}. */
export interface AddConstraintResult {
    success: boolean;
    constraintId?: string;
    error?: string;
}

interface InProgressLine {
    tool: 'line';
    stage: 1 | 2;
    p1Id: string;
    p1: Point2;
}

interface InProgressCircle {
    tool: 'circle';
    stage: 1 | 2;
    centerId: string;
    center: Point2;
}

interface InProgressArc3 {
    tool: 'arc3';
    stage: 1 | 2 | 3;
    startId: string;
    start: Point2;
    midId?: string;
    mid?: Point2;
}

interface InProgressRectangle {
    tool: 'rectangle';
    stage: 1 | 2;
    p1Id: string;
    p1: Point2;
}

type InProgressState = InProgressLine | InProgressCircle | InProgressArc3 | InProgressRectangle;

interface DragState {
    pointIds: string[];
    oldFixes: Map<string, { constraintId: string }>;
    lastSolvedPositions?: Map<string, Point2>;
    lastSolveSucceeded: boolean;
}

interface PrimitiveMeta {
    construction: boolean;
}

function finite(value: number, name: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number, got ${value}`);
    }
}

function circleCenterFromThreePoints(a: Point2, b: Point2, c: Point2): Point2 {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) {
        throw new Error('Three points are collinear; cannot define an arc');
    }
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x: ux, y: uy };
}

function normalizeAngle(angle: number): number {
    let a = angle % (2 * Math.PI);
    if (a < 0) {
        a += 2 * Math.PI;
    }
    return a;
}

function signedTriangleArea(a: Point2, b: Point2, c: Point2): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function arcAnglesFromThreePoints(center: Point2, start: Point2, mid: Point2, end: Point2): { startAngle: number; endAngle: number } {
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    const midAngle = Math.atan2(mid.y - center.y, mid.x - center.x);

    const ccw = signedTriangleArea(start, mid, end) > 0;
    let s = normalizeAngle(startAngle);
    let e = normalizeAngle(endAngle);
    const m = normalizeAngle(midAngle);

    if (ccw) {
        if (e <= s) {
            e += 2 * Math.PI;
        }
        const mWrap = m <= s ? m + 2 * Math.PI : m;
        if (mWrap < s || mWrap > e) {
            const temp = s;
            s = e;
            e = temp + 2 * Math.PI;
        }
    } else {
        if (s <= e) {
            s += 2 * Math.PI;
        }
        const mWrap = m <= e ? m + 2 * Math.PI : m;
        if (mWrap < e || mWrap > s) {
            const temp = s;
            s = e + 2 * Math.PI;
            e = temp;
        }
    }

    return { startAngle: s, endAngle: e };
}

/**
 * Sketch session controller.
 *
 * Create with {@link SketchSession.create} or restore with {@link SketchSession.fromSketchDef}.
 */
export class SketchSession {
    private readonly solver: SketchSolver;
    private readonly id: string;
    private name: string;
    private datumId: string;
    private readonly snapConfig: SnapConfig;
    private readonly autoConstraintAngleThresholdDeg: number;

    private readonly primitives = new Map<string, SketchPrimitive & PrimitiveMeta>();
    private readonly constraints = new Map<string, ConstraintRecord>();
    private readonly fixConstraintIds = new Map<string, string>(); // pointId -> constraintId
    private readonly parameters = new Map<string, number>();

    private tool: SketchTool = 'select';
    private inProgress: InProgressState | undefined;
    private drag: DragState | undefined;
    private status: SketchStatus;
    private readonly listeners = new Set<ChangeListener>();
    private idCounter = 0;

    private constructor(solver: SketchSolver, options: SketchSessionOptions = {}) {
        this.solver = solver;
        this.id = options.id ?? this.nextId('sketch');
        this.name = options.name ?? 'Sketch';
        this.datumId = options.datumId ?? 'xy';
        this.snapConfig = createSnapConfig(options.snap);
        this.autoConstraintAngleThresholdDeg = options.autoConstraintAngleThresholdDeg ?? 5;
        this.status = {
            dof: 0,
            conflicting: [],
            redundant: [],
            fullyConstrained: false,
            lastAutoConstraints: []
        };
    }

    /**
     * Create a fresh sketch session.
     *
     * The caller owns the solver and must invoke its destroy() method when the
     * session is no longer needed.
     */
    static async create(solver: SketchSolver, options?: SketchSessionOptions): Promise<SketchSession> {
        const session = new SketchSession(solver, options);
        await session.solve();
        return session;
    }

    /**
     * Restore a session from a saved SketchDef.
     *
     * Primitives, constraints, and sketch-local parameters are replayed into the
     * solver and solved. Fixed points are restored as fix constraints.
     */
    static async fromSketchDef(def: SketchDef, solver: SketchSolver): Promise<SketchSession> {
        const session = new SketchSession(solver, {
            id: def.id,
            name: def.name,
            datumId: def.datumId
        });

        // Register parameters first so constraints can reference them.
        for (const [name, value] of Object.entries(def.parameters ?? {})) {
            session.addParameterInternal(name, value);
        }

        // Add points first because higher geometry references them.
        const fixedPointIds = new Set<string>();
        for (const raw of def.primitives) {
            if (typeof raw.type === 'string' && raw.type === 'point') {
                const id = String(raw.id);
                const x = Number(raw.x);
                const y = Number(raw.y);
                const construction = Boolean(raw.construction);
                const fixed = Boolean(raw.fixed);
                session.addPointInternal(id, x, y, construction);
                if (fixed) {
                    fixedPointIds.add(id);
                }
            }
        }

        // Add remaining geometry.
        for (const raw of def.primitives) {
            if (typeof raw.type !== 'string') {
                continue;
            }
            const id = String(raw.id);
            if (session.primitives.has(id)) {
                continue;
            }
            if (raw.type === 'line') {
                session.addLineInternal(id, String(raw.p1_id ?? raw.p1Id), String(raw.p2_id ?? raw.p2Id), Boolean(raw.construction));
            } else if (raw.type === 'circle') {
                session.addCircleInternal(id, String(raw.c_id ?? raw.centerId), Number(raw.radius), Boolean(raw.construction));
            } else if (raw.type === 'arc') {
                session.addArcInternal(
                    id,
                    String(raw.c_id ?? raw.centerId),
                    Number(raw.radius),
                    Number(raw.start_angle ?? raw.startAngle),
                    Number(raw.end_angle ?? raw.endAngle),
                    String(raw.start_id ?? raw.startId),
                    String(raw.end_id ?? raw.endId),
                    Boolean(raw.construction)
                );
            }
        }

        // Add constraints (except fix, which is represented by point.fixed).
        for (const raw of def.constraints) {
            await session.loadConstraintFromPg(raw as Record<string, unknown>);
        }

        // Restore fix constraints for fixed points.
        for (const pointId of fixedPointIds) {
            const constraintId = session.nextId('fix');
            session.solver.addConstraintFix(constraintId, pointId);
            session.constraints.set(constraintId, { id: constraintId, kind: 'fix', targetIds: [pointId], driving: true });
            session.fixConstraintIds.set(pointId, constraintId);
        }

        await session.solve();
        return session;
    }

    /** Sketch id. */
    getId(): string {
        return this.id;
    }

    /** Sketch name. */
    getName(): string {
        return this.name;
    }

    /** Set the sketch name. */
    setName(name: string): void {
        this.name = name;
    }

    /** Datum plane id the sketch lives on. */
    getDatumId(): string {
        return this.datumId;
    }

    /** Current tool. */
    getTool(): SketchTool {
        return this.tool;
    }

    /** Subscribe to sketch change events. Returns an unsubscribe function. */
    onChange(listener: ChangeListener): () => void {
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

    /** Current solver status including DOF and diagnostics. */
    getStatus(): SketchStatus {
        return this.status;
    }

    /** All committed primitive ids. */
    getPrimitiveIds(): string[] {
        return [...this.primitives.keys()];
    }

    /** Read a committed primitive with its current solved coordinates. */
    getPrimitive(id: string): (SketchPrimitive & { construction: boolean }) | undefined {
        const meta = this.primitives.get(id);
        if (meta === undefined) {
            return undefined;
        }
        const solved = this.solver.getPrimitive(id);
        if (solved === undefined) {
            return { ...meta, construction: meta.construction };
        }
        return { ...solved, construction: meta.construction };
    }

    /** All committed primitives with solved coordinates. */
    getPrimitives(): (SketchPrimitive & { construction: boolean })[] {
        return this.getPrimitiveIds()
            .map((id) => this.getPrimitive(id))
            .filter((p): p is SketchPrimitive & { construction: boolean } => p !== undefined);
    }

    /** All committed constraints. */
    getConstraints(): ConstraintRecord[] {
        return [...this.constraints.values()];
    }

    /** Sketch-local parameter values. */
    getParameters(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [name, value] of this.parameters) {
            result[name] = value;
        }
        return result;
    }

    /** Define or update a sketch-local parameter. */
    addParameter(name: string, value: number): void {
        finite(value, `Parameter '${name}'`);
        this.addParameterInternal(name, value);
        this.solveAndNotify();
    }

    private addParameterInternal(name: string, value: number): void {
        this.parameters.set(name, value);
        this.solver.addParameter(name, value);
    }

    /** Remove a sketch-local parameter. */
    removeParameter(name: string): void {
        this.parameters.delete(name);
        this.solver.removeParameter(name);
        this.solveAndNotify();
    }

    /** Switch the active tool. Any in-progress entity is cancelled. */
    setTool(tool: SketchTool): void {
        this.cancel();
        this.tool = tool;
        this.status = { ...this.status, lastAutoConstraints: [] };
        this.emitChange();
    }

    /** Cancel the in-progress entity (Esc semantics). */
    cancel(): void {
        if (this.inProgress === undefined) {
            this.status = { ...this.status, lastAutoConstraints: [] };
            return;
        }
        this.clearInProgressPoints();
        this.inProgress = undefined;
        this.status = { ...this.status, lastAutoConstraints: [] };
        this.emitChange();
    }

    private clearInProgressPoints(): void {
        if (this.inProgress === undefined) {
            return;
        }
        const ids: string[] = [];
        if (this.inProgress.tool === 'line') {
            ids.push(this.inProgress.p1Id);
        } else if (this.inProgress.tool === 'circle') {
            ids.push(this.inProgress.centerId);
        } else if (this.inProgress.tool === 'arc3') {
            ids.push(this.inProgress.startId);
            if (this.inProgress.midId !== undefined) {
                ids.push(this.inProgress.midId);
            }
        } else if (this.inProgress.tool === 'rectangle') {
            ids.push(this.inProgress.p1Id);
        }
        for (const id of ids) {
            this.removePrimitiveAndConstraints(id);
        }
    }

    /**
     * Commit the current in-progress entity if applicable.
     *
     * All current tools finish automatically on their final click; this method
     * resets the last-action auto-constraint feedback for callers that want an
     * explicit finish gesture.
     */
    finish(): void {
        this.status = { ...this.status, lastAutoConstraints: [] };
    }

    /** Process a pointer click for the current tool. */
    async click(raw: Point2, modifiers?: { disableSnap?: boolean }): Promise<void> {
        const snapped = this.applySnap(raw, modifiers?.disableSnap);
        const auto: AutoConstraintFeedback[] = [];

        switch (this.tool) {
            case 'select':
                // Selection is handled by the UI; the session has no in-progress state.
                this.status = { ...this.status, lastAutoConstraints: [] };
                break;
            case 'point': {
                this.addPointForTool(snapped, auto);
                await this.commit(auto);
                this.emitChange();
                break;
            }
            case 'line': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'line') {
                    const p1Id = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'line', stage: 1, p1Id, p1: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const p1 = this.inProgress.p1;
                    const p2 = snapped.point;
                    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const p1Id = this.inProgress.p1Id;
                    const p2Id = this.addPointForTool(snapped, auto);
                    const lineId = this.nextId('line');
                    this.addLineInternal(lineId, p1Id, p2Id, false);
                    this.addAxisAutoConstraint(lineId, p1, p2, auto);
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.emitChange();
                }
                break;
            }
            case 'circle': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'circle') {
                    const centerId = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'circle', stage: 1, centerId, center: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const radius = Math.hypot(snapped.point.x - this.inProgress.center.x, snapped.point.y - this.inProgress.center.y);
                    if (radius < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const circleId = this.nextId('circle');
                    this.addCircleInternal(circleId, this.inProgress.centerId, radius, false);
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.emitChange();
                }
                break;
            }
            case 'arc3': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'arc3') {
                    const startId = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'arc3', stage: 1, startId, start: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else if (this.inProgress.stage === 1) {
                    const midId = this.addPointForTool(snapped, auto);
                    this.inProgress = {
                        tool: 'arc3',
                        stage: 2,
                        startId: this.inProgress.startId,
                        start: this.inProgress.start,
                        midId,
                        mid: snapped.point
                    };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const { start, mid } = this.inProgress;
                    if (mid === undefined) {
                        return;
                    }
                    const end = snapped.point;
                    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-12 || Math.hypot(end.x - mid.x, end.y - mid.y) < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const center = circleCenterFromThreePoints(start, mid, end);
                    const radius = Math.hypot(start.x - center.x, start.y - center.y);
                    const angles = arcAnglesFromThreePoints(center, start, mid, end);
                    const centerId = this.nextId('point');
                    this.addPointInternal(centerId, center.x, center.y, false);
                    const arcId = this.nextId('arc');
                    this.addArcInternal(
                        arcId,
                        centerId,
                        radius,
                        angles.startAngle,
                        angles.endAngle,
                        this.inProgress.startId,
                        this.addPointForTool(snapped, auto),
                        false
                    );
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.emitChange();
                }
                break;
            }
            case 'rectangle': {
                if (this.inProgress === undefined || this.inProgress.tool !== 'rectangle') {
                    const p1Id = this.addPointForTool(snapped, auto);
                    this.inProgress = { tool: 'rectangle', stage: 1, p1Id, p1: snapped.point };
                    this.status = { ...this.status, lastAutoConstraints: auto };
                    this.emitChange();
                } else {
                    const p1 = this.inProgress.p1;
                    const p2 = snapped.point;
                    if (Math.abs(p1.x - p2.x) < 1e-12 || Math.abs(p1.y - p2.y) < 1e-12) {
                        this.status = { ...this.status, lastAutoConstraints: [] };
                        this.emitChange();
                        return;
                    }
                    const p1Id = this.inProgress.p1Id;
                    const p2Id = this.addPointForTool(snapped, auto);
                    const lineIds = this.createRectangle(p1, p2, p1Id, p2Id, auto);
                    for (const lineId of lineIds) {
                        const line = this.primitives.get(lineId) as SketchLine & PrimitiveMeta;
                        const a = this.getPointPosition(line.p1Id);
                        const b = this.getPointPosition(line.p2Id);
                        if (a !== undefined && b !== undefined) {
                            this.addAxisAutoConstraint(lineId, a, b, auto);
                        }
                    }
                    this.inProgress = undefined;
                    await this.commit(auto);
                    this.emitChange();
                }
                break;
            }
        }
    }

    private createRectangle(p1: Point2, p2: Point2, p1Id: string, p2Id: string, _auto: AutoConstraintFeedback[]): string[] {
        const p3Id = this.nextId('point');
        const p4Id = this.nextId('point');
        this.addPointInternal(p3Id, p2.x, p1.y, false);
        this.addPointInternal(p4Id, p1.x, p2.y, false);

        const l1 = this.nextId('line');
        const l2 = this.nextId('line');
        const l3 = this.nextId('line');
        const l4 = this.nextId('line');
        this.addLineInternal(l1, p1Id, p3Id, false);
        this.addLineInternal(l2, p3Id, p2Id, false);
        this.addLineInternal(l3, p2Id, p4Id, false);
        this.addLineInternal(l4, p4Id, p1Id, false);
        return [l1, l2, l3, l4];
    }

    private addPointForTool(snapped: SnapResult, auto: AutoConstraintFeedback[]): string {
        const id = this.nextId('point');
        this.addPointInternal(id, snapped.point.x, snapped.point.y, false);
        this.tryAutoCoincident(id, snapped, auto);
        this.tryAutoPointOnObject(id, snapped, auto);
        return id;
    }

    private tryAutoCoincident(pointId: string, snapped: SnapResult, auto: AutoConstraintFeedback[]): void {
        if (snapped.kind !== 'endpoint' && snapped.kind !== 'center') {
            return;
        }
        if (snapped.pointId === undefined || snapped.pointId === pointId) {
            return;
        }
        const constraintId = this.nextId('coincident');
        this.solver.addConstraintCoincident(constraintId, pointId, snapped.pointId);
        this.constraints.set(constraintId, { id: constraintId, kind: 'coincident', targetIds: [pointId, snapped.pointId], driving: true });
        auto.push({ kind: 'coincident', ids: [constraintId] });
    }

    private tryAutoPointOnObject(pointId: string, snapped: SnapResult, auto: AutoConstraintFeedback[]): void {
        if (snapped.kind !== 'on_curve' || snapped.sourceId === undefined) {
            return;
        }
        const targetType = this.primitives.get(snapped.sourceId)?.type;
        if (targetType !== 'line' && targetType !== 'circle' && targetType !== 'arc') {
            return;
        }
        const constraintId = this.nextId('point-on-object');
        this.solver.addConstraintPointOnObject(constraintId, pointId, snapped.sourceId);
        this.constraints.set(constraintId, {
            id: constraintId,
            kind: 'pointOnObject',
            targetIds: [pointId, snapped.sourceId],
            driving: true
        });
        auto.push({ kind: 'pointOnObject', ids: [constraintId] });
    }

    private addAxisAutoConstraint(lineId: string, a: Point2, b: Point2, auto: AutoConstraintFeedback[]): void {
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const thresholdRad = (this.autoConstraintAngleThresholdDeg * Math.PI) / 180;
        const angle = Math.atan2(dy, dx);
        if (angle < thresholdRad) {
            const id = this.nextId('horizontal');
            this.solver.addConstraintHorizontal(id, lineId);
            this.constraints.set(id, { id, kind: 'horizontal', targetIds: [lineId], driving: true });
            auto.push({ kind: 'horizontal', ids: [id] });
        } else if (Math.PI / 2 - angle < thresholdRad) {
            const id = this.nextId('vertical');
            this.solver.addConstraintVertical(id, lineId);
            this.constraints.set(id, { id, kind: 'vertical', targetIds: [lineId], driving: true });
            auto.push({ kind: 'vertical', ids: [id] });
        }
    }

    private getPointPosition(id: string): Point2 | undefined {
        const solved = this.solver.getPrimitive(id);
        if (solved !== undefined && solved.type === 'point') {
            return solved;
        }
        const meta = this.primitives.get(id);
        if (meta?.type === 'point') {
            return meta;
        }
        return undefined;
    }

    /** Compute a preview for the current tool at the given pointer position. */
    hover(raw: Point2, modifiers?: { disableSnap?: boolean }): SketchPreview {
        const snapped = this.applySnap(raw, modifiers?.disableSnap);

        if (this.inProgress === undefined) {
            if (this.tool === 'point' || this.tool === 'line' || this.tool === 'arc3' || this.tool === 'rectangle') {
                return { type: 'point', point: snapped.point };
            }
            return { type: 'none' };
        }

        if (this.inProgress.tool === 'line') {
            return { type: 'line', p1: this.inProgress.p1, p2: snapped.point };
        }

        if (this.inProgress.tool === 'circle') {
            const radius = Math.hypot(snapped.point.x - this.inProgress.center.x, snapped.point.y - this.inProgress.center.y);
            return { type: 'circle', center: this.inProgress.center, radius };
        }

        if (this.inProgress.tool === 'arc3') {
            if (this.inProgress.stage === 1) {
                return { type: 'line', p1: this.inProgress.start, p2: snapped.point };
            }
            if (this.inProgress.mid === undefined) {
                return { type: 'point', point: snapped.point };
            }
            try {
                const center = circleCenterFromThreePoints(this.inProgress.start, this.inProgress.mid, snapped.point);
                const radius = Math.hypot(this.inProgress.start.x - center.x, this.inProgress.start.y - center.y);
                const angles = arcAnglesFromThreePoints(center, this.inProgress.start, this.inProgress.mid, snapped.point);
                return { type: 'arc', center, radius, startAngle: angles.startAngle, endAngle: angles.endAngle };
            } catch {
                return { type: 'point', point: snapped.point };
            }
        }

        if (this.inProgress.tool === 'rectangle') {
            return { type: 'rectangle', p1: this.inProgress.p1, p2: snapped.point };
        }

        return { type: 'none' };
    }

    private applySnap(raw: Point2, disableSnap?: boolean): SnapResult {
        const config = disableSnap ? { ...this.snapConfig, enabled: false } : this.snapConfig;
        return snap(raw, this.getPrimitives(), config);
    }

    private async commit(auto: AutoConstraintFeedback[]): Promise<void> {
        await this.solve();
        this.status = { ...this.status, lastAutoConstraints: auto };
    }

    private async solve(): Promise<void> {
        const result = await this.solver.solve();
        this.status = {
            dof: result.dof,
            conflicting: result.conflicting,
            redundant: result.redundant,
            fullyConstrained: result.dof === 0,
            lastAutoConstraints: this.status.lastAutoConstraints
        };
    }

    private solveAndNotify(): void {
        this.solve()
            .then(() => this.emitChange())
            .catch(() => this.emitChange());
    }

    private nextId(prefix: string): string {
        let candidate: string;
        do {
            candidate = `${prefix}-${++this.idCounter}`;
        } while (this.primitives.has(candidate) || this.constraints.has(candidate) || this.parameters.has(candidate));
        return candidate;
    }

    private addPointInternal(id: string, x: number, y: number, construction: boolean): void {
        finite(x, `Point '${id}' x`);
        finite(y, `Point '${id}' y`);
        this.solver.addPoint(id, x, y, { construction });
        this.primitives.set(id, { type: 'point', id, x, y, construction });
    }

    private addLineInternal(id: string, p1Id: string, p2Id: string, construction: boolean): void {
        this.solver.addLine(id, p1Id, p2Id, { construction });
        this.primitives.set(id, { type: 'line', id, p1Id, p2Id, construction });
    }

    private addCircleInternal(id: string, centerId: string, radius: number, construction: boolean): void {
        finite(radius, `Circle '${id}' radius`);
        this.solver.addCircle(id, centerId, radius, { construction });
        this.primitives.set(id, { type: 'circle', id, centerId, radius, construction });
    }

    private addArcInternal(
        id: string,
        centerId: string,
        radius: number,
        startAngle: number,
        endAngle: number,
        startId: string,
        endId: string,
        construction: boolean
    ): void {
        finite(radius, `Arc '${id}' radius`);
        finite(startAngle, `Arc '${id}' startAngle`);
        finite(endAngle, `Arc '${id}' endAngle`);
        this.solver.addArc(id, centerId, radius, startAngle, endAngle, startId, endId, { construction });
        this.primitives.set(id, { type: 'arc', id, centerId, radius, startAngle, endAngle, startId, endId, construction });
    }

    /**
     * Add a constraint from the UI-facing constraint tool set.
     *
     * Returns a structured result so the UI can flash an error without catching
     * exceptions.
     */
    async addConstraint(
        kind: ConstraintKind,
        targetIds: string[],
        value?: number | string,
        options?: AddConstraintOptions
    ): Promise<AddConstraintResult> {
        const error = this.validateConstraint(kind, targetIds, value);
        if (error !== undefined) {
            return { success: false, error };
        }

        if (typeof value === 'string' && !this.parameters.has(value)) {
            return { success: false, error: `Unknown parameter '${value}'` };
        }

        const driving = options?.driving ?? true;
        const id = this.nextId(kind);

        try {
            switch (kind) {
                case 'coincident':
                    this.solver.addConstraintCoincident(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'fix':
                    this.solver.addConstraintFix(id, targetIds[0]);
                    break;
                case 'horizontal':
                    this.solver.addConstraintHorizontal(id, targetIds[0], { driving });
                    break;
                case 'vertical':
                    this.solver.addConstraintVertical(id, targetIds[0], { driving });
                    break;
                case 'parallel':
                    this.solver.addConstraintParallel(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'perpendicular':
                    this.solver.addConstraintPerpendicular(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'tangent':
                    this.solver.addConstraintTangent(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'equal':
                    this.solver.addConstraintEqual(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'concentric':
                    this.solver.addConstraintConcentric(id, targetIds[0], targetIds[1], { driving });
                    break;
                case 'distance':
                    this.solver.addConstraintDistance(id, targetIds[0], targetIds[1], value as number | string, {
                        driving,
                        direction: options?.direction ?? 'point-point'
                    });
                    break;
                case 'angle':
                    this.solver.addConstraintAngle(id, targetIds[0], targetIds[1], value as number | string, { driving });
                    break;
                case 'radius':
                    this.solver.addConstraintRadius(id, targetIds[0], value as number | string, { driving });
                    break;
                case 'symmetry':
                    this.solver.addConstraintSymmetry(id, targetIds[0], targetIds[1], targetIds[2], { driving });
                    break;
                case 'pointOnObject':
                    this.solver.addConstraintPointOnObject(id, targetIds[0], targetIds[1], { driving });
                    break;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, error: message };
        }

        const record: ConstraintRecord = { id, kind, targetIds, driving };
        if (value !== undefined) {
            record.value = value;
        }
        if (kind === 'distance') {
            record.direction = options?.direction ?? 'point-point';
        }
        this.constraints.set(id, record);
        if (kind === 'fix') {
            this.fixConstraintIds.set(targetIds[0], id);
        }

        await this.commit([]);
        this.emitChange();
        return { success: true, constraintId: id };
    }

    private validateConstraint(kind: ConstraintKind, targetIds: string[], value?: number | string): string | undefined {
        const arity = (expected: number): string | undefined =>
            targetIds.length === expected ? undefined : `${kind} requires exactly ${expected} primitive(s), got ${targetIds.length}`;

        const typeOf = (id: string): 'point' | 'line' | 'circle' | 'arc' | undefined => this.primitives.get(id)?.type;
        const requireType = (ids: string[], types: Array<'point' | 'line' | 'circle' | 'arc'>): string | undefined => {
            for (const id of ids) {
                const t = typeOf(id);
                if (t === undefined) {
                    return `Unknown primitive '${id}'`;
                }
                if (!types.includes(t)) {
                    return `${kind} requires ${types.join('/')} but '${id}' is ${t}`;
                }
            }
            return undefined;
        };

        switch (kind) {
            case 'coincident':
                return arity(2) ?? requireType(targetIds, ['point']);
            case 'fix':
                return arity(1) ?? requireType(targetIds, ['point']);
            case 'horizontal':
            case 'vertical':
                return arity(1) ?? requireType(targetIds, ['line']);
            case 'parallel':
            case 'perpendicular':
            case 'angle':
                return arity(2) ?? requireType(targetIds, ['line']);
            case 'distance':
                if (value === undefined) {
                    return 'distance requires a value';
                }
                return arity(2) ?? requireType(targetIds, ['point']);
            case 'radius':
                if (value === undefined) {
                    return 'radius requires a value';
                }
                return arity(1) ?? requireType(targetIds, ['circle', 'arc']);
            case 'concentric':
                return arity(2) ?? requireType(targetIds, ['circle', 'arc']);
            case 'symmetry':
                return arity(3) ?? requireType(targetIds, ['point']);
            case 'pointOnObject': {
                const err = arity(2);
                if (err !== undefined) {
                    return err;
                }
                const t1 = typeOf(targetIds[0]);
                const t2 = typeOf(targetIds[1]);
                if (t1 !== 'point') {
                    return `pointOnObject requires a point as the first target, got ${t1}`;
                }
                if (t2 !== 'line' && t2 !== 'circle' && t2 !== 'arc') {
                    return `pointOnObject requires a line/circle/arc as the second target, got ${t2}`;
                }
                return undefined;
            }
            case 'tangent': {
                const err = arity(2);
                if (err !== undefined) {
                    return err;
                }
                const t1 = typeOf(targetIds[0]);
                const t2 = typeOf(targetIds[1]);
                if (t1 === undefined || t2 === undefined) {
                    return `Unknown primitive in ${kind}`;
                }
                const valid =
                    (t1 === 'line' && (t2 === 'circle' || t2 === 'arc')) ||
                    (t2 === 'line' && (t1 === 'circle' || t1 === 'arc')) ||
                    (t1 === 'circle' && t2 === 'circle') ||
                    (t1 === 'arc' && t2 === 'arc') ||
                    (t1 === 'circle' && t2 === 'arc') ||
                    (t1 === 'arc' && t2 === 'circle');
                if (!valid) {
                    return `tangent unsupported primitive combination ${t1}/${t2}`;
                }
                return undefined;
            }
            case 'equal': {
                const err = arity(2);
                if (err !== undefined) {
                    return err;
                }
                const t1 = typeOf(targetIds[0]);
                const t2 = typeOf(targetIds[1]);
                if (t1 === undefined || t2 === undefined) {
                    return `Unknown primitive in ${kind}`;
                }
                if (t1 !== t2 && !((t1 === 'circle' && t2 === 'arc') || (t1 === 'arc' && t2 === 'circle'))) {
                    return `equal requires primitives of the same type, got ${t1}/${t2}`;
                }
                if (t1 === 'point') {
                    return 'equal does not support points';
                }
                return undefined;
            }
            default:
                return undefined;
        }
    }

    /** Remove a primitive and any constraints that reference it. */
    async deletePrimitive(id: string): Promise<void> {
        if (!this.primitives.has(id)) {
            throw new Error(`Unknown primitive '${id}'`);
        }
        this.removePrimitiveAndConstraints(id);
        await this.commit([]);
        this.emitChange();
    }

    /** Remove a constraint by id. */
    async deleteConstraint(id: string): Promise<void> {
        if (!this.constraints.has(id)) {
            throw new Error(`Unknown constraint '${id}'`);
        }
        this.removeConstraintInternal(id);
        await this.commit([]);
        this.emitChange();
    }

    private removePrimitiveAndConstraints(id: string): void {
        const idsToRemove = this.collectDependentPrimitives(id);

        // Remove any constraints that reference any of these primitives from session records.
        for (const constraintId of [...this.constraints.keys()]) {
            const record = this.constraints.get(constraintId)!;
            if (idsToRemove.some((removedId) => record.targetIds.includes(removedId))) {
                this.removeConstraintInternal(constraintId);
            }
        }

        for (const primitiveId of idsToRemove) {
            this.solver.removePrimitive(primitiveId);
            this.primitives.delete(primitiveId);
        }
    }

    private collectDependentPrimitives(id: string): string[] {
        const result = new Set<string>([id]);
        const primitive = this.primitives.get(id);
        if (primitive?.type === 'point') {
            for (const [otherId, other] of this.primitives.entries()) {
                if (other.type === 'line' && (other.p1Id === id || other.p2Id === id)) {
                    result.add(otherId);
                } else if (other.type === 'circle' && other.centerId === id) {
                    result.add(otherId);
                } else if (other.type === 'arc' && (other.centerId === id || other.startId === id || other.endId === id)) {
                    result.add(otherId);
                }
            }
        }
        return [...result];
    }

    private removeConstraintInternal(id: string): void {
        const record = this.constraints.get(id);
        if (record?.kind === 'fix') {
            this.fixConstraintIds.delete(record.targetIds[0]);
        }
        this.solver.removeConstraint(id);
        this.constraints.delete(id);
    }

    /** Toggle or set the construction flag on a primitive. */
    async setConstruction(id: string, construction: boolean): Promise<void> {
        const primitive = this.primitives.get(id);
        if (primitive === undefined) {
            throw new Error(`Unknown primitive '${id}'`);
        }
        if (primitive.construction === construction) {
            return;
        }
        // The construction flag does not affect solving, so update session
        // metadata only rather than rebuilding the primitive in the solver.
        this.primitives.set(id, { ...primitive, construction });
        await this.commit([]);
        this.emitChange();
    }

    /** Begin dragging one or more points. */
    beginDrag(pointIds: string[]): void {
        const oldFixes = new Map<string, { constraintId: string }>();
        for (const pointId of pointIds) {
            const fixId = this.fixConstraintIds.get(pointId);
            if (fixId !== undefined) {
                oldFixes.set(pointId, { constraintId: fixId });
                this.removeConstraintInternal(fixId);
            }
        }
        this.drag = { pointIds: [...pointIds], oldFixes, lastSolveSucceeded: false };
    }

    /** Update the drag position and run a temporary-constraint solve. */
    async dragTo(point2: Point2): Promise<void> {
        if (this.drag === undefined) {
            return;
        }
        // Pop any previous temporary constraints so we do not accumulate fixes.
        await this.solver.popTemporaryConstraints();
        const temps: TemporaryConstraint[] = this.drag.pointIds.map((pointId) => ({
            type: 'fix',
            id: `drag-fix-${pointId}`,
            pointId,
            x: point2.x,
            y: point2.y
        }));
        const result = await this.solver.pushTemporaryConstraints(temps);
        this.drag.lastSolveSucceeded = result.status === 'converged';
        if (this.drag.lastSolveSucceeded) {
            this.drag.lastSolvedPositions = new Map<string, Point2>();
            for (const pointId of this.drag.pointIds) {
                const p = this.solver.getPrimitive(pointId);
                if (p !== undefined && p.type === 'point') {
                    this.drag.lastSolvedPositions.set(pointId, { x: p.x, y: p.y });
                }
            }
        }
        this.status = {
            dof: result.dof,
            conflicting: result.conflicting,
            redundant: result.redundant,
            fullyConstrained: result.dof === 0,
            lastAutoConstraints: []
        };
        this.emitChange();
    }

    /** End the drag and commit the solved coordinates. */
    async endDrag(): Promise<void> {
        if (this.drag === undefined) {
            return;
        }
        const { pointIds, oldFixes, lastSolvedPositions, lastSolveSucceeded } = this.drag;
        this.drag = undefined;
        await this.solver.popTemporaryConstraints();

        let result: SolverResult;
        if (lastSolveSucceeded && lastSolvedPositions !== undefined) {
            const addedCoords: Array<{ xId: string; yId: string }> = [];
            for (const pointId of pointIds) {
                if (this.fixConstraintIds.has(pointId)) {
                    continue;
                }
                const pos = lastSolvedPositions.get(pointId);
                if (pos === undefined) {
                    continue;
                }
                const ids = this.solver.setPointCoordinates(pointId, pos.x, pos.y);
                addedCoords.push({ xId: ids.xConstraintId, yId: ids.yConstraintId });
            }

            result = await this.solver.solve();
            if (result.status !== 'converged') {
                for (const { xId, yId } of addedCoords) {
                    this.solver.removeConstraint(xId);
                    this.solver.removeConstraint(yId);
                }
                result = await this.restoreOldFixesAndSolve(oldFixes);
            }
        } else {
            result = await this.restoreOldFixesAndSolve(oldFixes);
        }

        this.status = {
            dof: result.dof,
            conflicting: result.conflicting,
            redundant: result.redundant,
            fullyConstrained: result.dof === 0,
            lastAutoConstraints: []
        };
        this.emitChange();
    }

    private async restoreOldFixesAndSolve(oldFixes: Map<string, { constraintId: string }>): Promise<SolverResult> {
        for (const [pointId, { constraintId }] of oldFixes) {
            this.solver.addConstraintFix(constraintId, pointId);
            this.constraints.set(constraintId, { id: constraintId, kind: 'fix', targetIds: [pointId], driving: true });
            this.fixConstraintIds.set(pointId, constraintId);
        }
        return this.solver.solve();
    }

    /** Serialize the current sketch to a SketchDef. */
    toSketchDef(): SketchDef {
        const primitives: Record<string, unknown>[] = [];
        for (const p of this.primitives.values()) {
            const solved = this.solver.getPrimitive(p.id);
            const obj: Record<string, unknown> = { id: p.id, type: p.type, construction: p.construction };
            if (p.type === 'point') {
                const point = (solved as SketchPoint | undefined) ?? p;
                obj.x = point.x;
                obj.y = point.y;
                if (this.fixConstraintIds.has(p.id)) {
                    obj.fixed = true;
                }
            } else if (p.type === 'line') {
                obj.p1_id = p.p1Id;
                obj.p2_id = p.p2Id;
            } else if (p.type === 'circle') {
                const circle = (solved as SketchCircle | undefined) ?? p;
                obj.c_id = p.centerId;
                obj.radius = circle.radius;
            } else if (p.type === 'arc') {
                const arc = (solved as SketchArc | undefined) ?? p;
                obj.c_id = p.centerId;
                obj.radius = arc.radius;
                obj.start_angle = arc.startAngle;
                obj.end_angle = arc.endAngle;
                obj.start_id = p.startId;
                obj.end_id = p.endId;
            }
            primitives.push(obj);
        }

        const constraints: Record<string, unknown>[] = [];
        for (const record of this.constraints.values()) {
            if (record.kind === 'fix') {
                continue;
            }
            const pg = this.constraintToPg(record);
            if (Array.isArray(pg)) {
                for (const item of pg) {
                    constraints.push(item);
                }
            } else {
                constraints.push(pg);
            }
        }

        const parameters: Record<string, number> = {};
        for (const [name, value] of this.parameters) {
            parameters[name] = value;
        }

        return {
            id: this.id,
            name: this.name,
            datumId: this.datumId,
            primitives,
            constraints,
            parameters
        };
    }

    private constraintToPg(record: ConstraintRecord): Record<string, unknown> | Record<string, unknown>[] {
        const driving = record.driving;
        const ids = record.targetIds;
        const value = record.value;
        switch (record.kind) {
            case 'coincident':
            case 'symmetry':
                return { id: record.id, type: 'p2p_coincident', p1_id: ids[0], p2_id: ids[1], driving };
            case 'horizontal':
                return { id: record.id, type: 'horizontal_l', l_id: ids[0], driving };
            case 'vertical':
                return { id: record.id, type: 'vertical_l', l_id: ids[0], driving };
            case 'parallel':
                return { id: record.id, type: 'parallel', l1_id: ids[0], l2_id: ids[1], driving };
            case 'perpendicular':
                return { id: record.id, type: 'perpendicular_ll', l1_id: ids[0], l2_id: ids[1], driving };
            case 'angle':
                return { id: record.id, type: 'l2l_angle_ll', l1_id: ids[0], l2_id: ids[1], angle: value, driving };
            case 'distance':
                if (record.direction === 'horizontal' || record.direction === 'vertical') {
                    const prop = record.direction === 'horizontal' ? 'x' : 'y';
                    return {
                        id: record.id,
                        type: 'difference',
                        param1: { o_id: ids[1], prop },
                        param2: { o_id: ids[0], prop },
                        difference: value,
                        driving
                    };
                }
                return { id: record.id, type: 'p2p_distance', p1_id: ids[0], p2_id: ids[1], distance: value, driving };
            case 'concentric': {
                const p1 = this.primitives.get(ids[0])!;
                const p2 = this.primitives.get(ids[1])!;
                const c1 = p1.type === 'circle' ? (p1 as SketchCircle).centerId : (p1 as SketchArc).centerId;
                const c2 = p2.type === 'circle' ? (p2 as SketchCircle).centerId : (p2 as SketchArc).centerId;
                return { id: record.id, type: 'p2p_coincident', p1_id: c1, p2_id: c2, driving };
            }
            case 'radius': {
                const p = this.primitives.get(ids[0])!;
                if (p.type === 'circle') {
                    return { id: record.id, type: 'circle_radius', c_id: ids[0], radius: value, driving };
                }
                return { id: record.id, type: 'arc_radius', a_id: ids[0], radius: value, driving };
            }
            case 'tangent':
                return this.tangentConstraintToPg(record);
            case 'equal':
                return this.equalConstraintToPg(record);
            case 'pointOnObject': {
                const target = this.primitives.get(ids[1])!;
                if (target.type === 'line') {
                    return { id: record.id, type: 'point_on_line_pl', p_id: ids[0], l_id: ids[1], driving };
                }
                if (target.type === 'circle') {
                    return { id: record.id, type: 'point_on_circle', p_id: ids[0], c_id: ids[1], driving };
                }
                return { id: record.id, type: 'point_on_arc', p_id: ids[0], a_id: ids[1], driving };
            }
            default:
                return [];
        }
    }

    private tangentConstraintToPg(record: ConstraintRecord): Record<string, unknown> {
        const [id1, id2] = record.targetIds;
        const p1 = this.primitives.get(id1)!;
        const p2 = this.primitives.get(id2)!;
        const driving = record.driving;
        if (p1.type === 'line' && p2.type === 'circle') {
            return { id: record.id, type: 'tangent_lc', l_id: id1, c_id: id2, driving };
        }
        if (p1.type === 'circle' && p2.type === 'line') {
            return { id: record.id, type: 'tangent_lc', l_id: id2, c_id: id1, driving };
        }
        if (p1.type === 'line' && p2.type === 'arc') {
            return { id: record.id, type: 'tangent_la', l_id: id1, a_id: id2, driving };
        }
        if (p1.type === 'arc' && p2.type === 'line') {
            return { id: record.id, type: 'tangent_la', l_id: id2, a_id: id1, driving };
        }
        if (p1.type === 'circle' && p2.type === 'circle') {
            return { id: record.id, type: 'tangent_cc', c1_id: id1, c2_id: id2, driving };
        }
        if (p1.type === 'arc' && p2.type === 'arc') {
            return { id: record.id, type: 'tangent_aa', a1_id: id1, a2_id: id2, driving };
        }
        if (p1.type === 'circle' && p2.type === 'arc') {
            return { id: record.id, type: 'tangent_ca', c_id: id1, a_id: id2, driving };
        }
        return { id: record.id, type: 'tangent_ca', c_id: id2, a_id: id1, driving };
    }

    private equalConstraintToPg(record: ConstraintRecord): Record<string, unknown> {
        const [id1, id2] = record.targetIds;
        const p1 = this.primitives.get(id1)!;
        const p2 = this.primitives.get(id2)!;
        const driving = record.driving;
        if (p1.type === 'line' && p2.type === 'line') {
            return { id: record.id, type: 'equal_length', l1_id: id1, l2_id: id2, driving };
        }
        if (p1.type === 'circle' && p2.type === 'circle') {
            return { id: record.id, type: 'equal_radius_cc', c1_id: id1, c2_id: id2, driving };
        }
        if (p1.type === 'arc' && p2.type === 'arc') {
            return { id: record.id, type: 'equal_radius_aa', a1_id: id1, a2_id: id2, driving };
        }
        if (p1.type === 'circle' && p2.type === 'arc') {
            return { id: record.id, type: 'equal_radius_ca', c1_id: id1, a2_id: id2, driving };
        }
        return { id: record.id, type: 'equal_radius_ca', c1_id: id2, a2_id: id1, driving };
    }

    private async loadConstraintFromPg(pg: Record<string, unknown>): Promise<void> {
        const type = pg.type;
        const id = String(pg.id);
        const driving = pg.driving !== false;
        if (type === 'p2p_coincident') {
            const p1 = String(pg.p1_id ?? pg.p1Id);
            const p2 = String(pg.p2_id ?? pg.p2Id);
            this.solver.addConstraintCoincident(id, p1, p2, { driving });
            this.constraints.set(id, { id, kind: 'coincident', targetIds: [p1, p2], driving });
        } else if (type === 'horizontal_l') {
            const lineId = String(pg.l_id ?? pg.lId);
            this.solver.addConstraintHorizontal(id, lineId, { driving });
            this.constraints.set(id, { id, kind: 'horizontal', targetIds: [lineId], driving });
        } else if (type === 'vertical_l') {
            const lineId = String(pg.l_id ?? pg.lId);
            this.solver.addConstraintVertical(id, lineId, { driving });
            this.constraints.set(id, { id, kind: 'vertical', targetIds: [lineId], driving });
        } else if (type === 'parallel') {
            const l1 = String(pg.l1_id ?? pg.l1Id);
            const l2 = String(pg.l2_id ?? pg.l2Id);
            this.solver.addConstraintParallel(id, l1, l2, { driving });
            this.constraints.set(id, { id, kind: 'parallel', targetIds: [l1, l2], driving });
        } else if (type === 'perpendicular_ll') {
            const l1 = String(pg.l1_id ?? pg.l1Id);
            const l2 = String(pg.l2_id ?? pg.l2Id);
            this.solver.addConstraintPerpendicular(id, l1, l2, { driving });
            this.constraints.set(id, { id, kind: 'perpendicular', targetIds: [l1, l2], driving });
        } else if (type === 'l2l_angle_ll') {
            const l1 = String(pg.l1_id ?? pg.l1Id);
            const l2 = String(pg.l2_id ?? pg.l2Id);
            const angle = pg.angle as number | string;
            this.solver.addConstraintAngle(id, l1, l2, angle, { driving });
            this.constraints.set(id, { id, kind: 'angle', targetIds: [l1, l2], value: angle, driving });
        } else if (type === 'p2p_distance') {
            const p1 = String(pg.p1_id ?? pg.p1Id);
            const p2 = String(pg.p2_id ?? pg.p2Id);
            const distance = pg.distance as number | string;
            this.solver.addConstraintDistance(id, p1, p2, distance, { driving, direction: 'point-point' });
            this.constraints.set(id, { id, kind: 'distance', targetIds: [p1, p2], value: distance, driving, direction: 'point-point' });
        } else if (type === 'difference') {
            const param1 = pg.param1 as Record<string, string> | undefined;
            const param2 = pg.param2 as Record<string, string> | undefined;
            const direction = param1?.prop === 'x' ? 'horizontal' : 'vertical';
            const p1Id = param2?.o_id ?? param2?.oId;
            const p2Id = param1?.o_id ?? param1?.oId;
            if (p1Id === undefined || p2Id === undefined) {
                throw new Error(`Malformed difference constraint '${id}'`);
            }
            this.solver.addConstraintDistance(id, p1Id, p2Id, pg.difference as number | string, { driving, direction });
            this.constraints.set(id, {
                id,
                kind: 'distance',
                targetIds: [p1Id, p2Id],
                value: pg.difference as number | string,
                driving,
                direction
            });
        } else if (type === 'circle_radius') {
            const cId = String(pg.c_id ?? pg.cId);
            const radius = pg.radius as number | string;
            this.solver.addConstraintRadius(id, cId, radius, { driving });
            this.constraints.set(id, { id, kind: 'radius', targetIds: [cId], value: radius, driving });
        } else if (type === 'arc_radius') {
            const aId = String(pg.a_id ?? pg.aId);
            const radius = pg.radius as number | string;
            this.solver.addConstraintRadius(id, aId, radius, { driving });
            this.constraints.set(id, { id, kind: 'radius', targetIds: [aId], value: radius, driving });
        } else if (type === 'circle_diameter') {
            const cId = String(pg.c_id ?? pg.cId);
            const diameter = pg.diameter as number | string;
            this.solver.addConstraintDiameter(id, cId, diameter, { driving });
            this.constraints.set(id, { id, kind: 'radius', targetIds: [cId], value: diameter, driving });
        } else if (type === 'arc_diameter') {
            const aId = String(pg.a_id ?? pg.aId);
            const diameter = pg.diameter as number | string;
            this.solver.addConstraintDiameter(id, aId, diameter, { driving });
            this.constraints.set(id, { id, kind: 'radius', targetIds: [aId], value: diameter, driving });
        } else if (type === 'tangent_lc') {
            const lId = String(pg.l_id ?? pg.lId);
            const cId = String(pg.c_id ?? pg.cId);
            this.solver.addConstraintTangent(id, lId, cId, { driving });
            this.constraints.set(id, { id, kind: 'tangent', targetIds: [lId, cId], driving });
        } else if (type === 'tangent_la') {
            const lId = String(pg.l_id ?? pg.lId);
            const aId = String(pg.a_id ?? pg.aId);
            this.solver.addConstraintTangent(id, lId, aId, { driving });
            this.constraints.set(id, { id, kind: 'tangent', targetIds: [lId, aId], driving });
        } else if (type === 'tangent_cc') {
            const c1 = String(pg.c1_id ?? pg.c1Id);
            const c2 = String(pg.c2_id ?? pg.c2Id);
            this.solver.addConstraintTangent(id, c1, c2, { driving });
            this.constraints.set(id, { id, kind: 'tangent', targetIds: [c1, c2], driving });
        } else if (type === 'tangent_aa') {
            const a1 = String(pg.a1_id ?? pg.a1Id);
            const a2 = String(pg.a2_id ?? pg.a2Id);
            this.solver.addConstraintTangent(id, a1, a2, { driving });
            this.constraints.set(id, { id, kind: 'tangent', targetIds: [a1, a2], driving });
        } else if (type === 'tangent_ca') {
            const cId = String(pg.c_id ?? pg.cId);
            const aId = String(pg.a_id ?? pg.aId);
            this.solver.addConstraintTangent(id, cId, aId, { driving });
            this.constraints.set(id, { id, kind: 'tangent', targetIds: [cId, aId], driving });
        } else if (type === 'equal_length') {
            const l1 = String(pg.l1_id ?? pg.l1Id);
            const l2 = String(pg.l2_id ?? pg.l2Id);
            this.solver.addConstraintEqual(id, l1, l2, { driving });
            this.constraints.set(id, { id, kind: 'equal', targetIds: [l1, l2], driving });
        } else if (type === 'equal_radius_cc') {
            const c1 = String(pg.c1_id ?? pg.c1Id);
            const c2 = String(pg.c2_id ?? pg.c2Id);
            this.solver.addConstraintEqual(id, c1, c2, { driving });
            this.constraints.set(id, { id, kind: 'equal', targetIds: [c1, c2], driving });
        } else if (type === 'equal_radius_aa') {
            const a1 = String(pg.a1_id ?? pg.a1Id);
            const a2 = String(pg.a2_id ?? pg.a2Id);
            this.solver.addConstraintEqual(id, a1, a2, { driving });
            this.constraints.set(id, { id, kind: 'equal', targetIds: [a1, a2], driving });
        } else if (type === 'equal_radius_ca') {
            const c1 = String(pg.c1_id ?? pg.c1Id);
            const a2 = String(pg.a2_id ?? pg.a2Id);
            this.solver.addConstraintEqual(id, c1, a2, { driving });
            this.constraints.set(id, { id, kind: 'equal', targetIds: [c1, a2], driving });
        } else if (type === 'equal') {
            const param1 = pg.param1 as Record<string, string> | undefined;
            const param2 = pg.param2 as Record<string, string> | undefined;
            if (param1?.o_id && param2?.o_id) {
                this.solver.addConstraintEqual(id, param1.o_id, param2.o_id, { driving });
                this.constraints.set(id, { id, kind: 'equal', targetIds: [param1.o_id, param2.o_id], driving });
            }
        } else if (type === 'p2p_symmetric_ppl') {
            const p1 = String(pg.p1_id ?? pg.p1Id);
            const p2 = String(pg.p2_id ?? pg.p2Id);
            const lineId = String(pg.l_id ?? pg.lId);
            this.solver.addConstraintSymmetry(id, p1, p2, lineId, { driving });
            this.constraints.set(id, { id, kind: 'symmetry', targetIds: [p1, p2, lineId], driving });
        } else if (type === 'p2p_symmetric_ppp') {
            const p1 = String(pg.p1_id ?? pg.p1Id);
            const p2 = String(pg.p2_id ?? pg.p2Id);
            const pId = String(pg.p_id ?? pg.pId);
            this.solver.addConstraintSymmetry(id, p1, p2, pId, { driving });
            this.constraints.set(id, { id, kind: 'symmetry', targetIds: [p1, p2, pId], driving });
        } else if (type === 'point_on_line_pl') {
            const pId = String(pg.p_id ?? pg.pId);
            const lId = String(pg.l_id ?? pg.lId);
            this.solver.addConstraintPointOnObject(id, pId, lId, { driving });
            this.constraints.set(id, { id, kind: 'pointOnObject', targetIds: [pId, lId], driving });
        } else if (type === 'point_on_circle') {
            const pId = String(pg.p_id ?? pg.pId);
            const cId = String(pg.c_id ?? pg.cId);
            this.solver.addConstraintPointOnObject(id, pId, cId, { driving });
            this.constraints.set(id, { id, kind: 'pointOnObject', targetIds: [pId, cId], driving });
        } else if (type === 'point_on_arc') {
            const pId = String(pg.p_id ?? pg.pId);
            const aId = String(pg.a_id ?? pg.aId);
            this.solver.addConstraintPointOnObject(id, pId, aId, { driving });
            this.constraints.set(id, { id, kind: 'pointOnObject', targetIds: [pId, aId], driving });
        }
    }

    /**
     * Validate a minimal document embedding this sketch.
     *
     * Useful for tests and serialization round-trips.
     */
    validateDocument(): { valid: boolean; issues: string[] } {
        const doc: NukeCadDocument = {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'validation',
            parameters: {},
            datums: [{ id: this.datumId, kind: 'XY', name: this.datumId }],
            sketches: [this.toSketchDef()],
            features: []
        };
        const result = validateNukeCadDocument(doc);
        return { valid: result.valid, issues: result.issues.map((i) => `${i.path}: ${i.message}`) };
    }
}
